export type TransitCoordinate = {
  lat: number;
  lng: number;
};

export type StitchedTransitComponent<T extends TransitCoordinate> = {
  points: T[];
  memberCount: number;
};

export type TransitEndpointMemberCandidate = {
  memberIndex: number;
  memberType: string;
  memberRef: string;
  memberRole: string;
  tags: Record<string, string>;
  point: TransitCoordinate;
};

export type VerifiedTransitEndpoint = {
  label: string;
  point: TransitCoordinate;
  memberIndex: number;
  memberType: string;
  memberRef: string;
  memberRole: string;
  verification: "relation-stop-name-match";
};

function sameCoordinate(left: TransitCoordinate, right: TransitCoordinate): boolean {
  return left.lat === right.lat && left.lng === right.lng;
}

function compactPath<T extends TransitCoordinate>(points: readonly T[]): T[] {
  return points.filter((point, index) => index === 0 || !sameCoordinate(point, points[index - 1]));
}

/**
 * Joins relation members only when both source geometries share the exact same
 * endpoint coordinate. A nearby endpoint remains a separate component so a
 * renderer can never draw an inferred connector across an unmapped gap.
 */
export function stitchTransitMemberPaths<T extends TransitCoordinate>(paths: readonly (readonly T[])[]): StitchedTransitComponent<T>[] {
  const remaining = paths
    .map((points, sourceIndex) => ({ sourceIndex, points: compactPath(points) }))
    .filter((candidate) => candidate.points.length >= 2);
  const components: StitchedTransitComponent<T>[] = [];

  while (remaining.length) {
    const seed = remaining.shift();
    if (!seed) break;
    let stitched = [...seed.points];
    let memberCount = 1;

    while (remaining.length) {
      const start = stitched[0];
      const end = stitched[stitched.length - 1];
      type TransitJoin = "append" | "append-reverse" | "prepend" | "prepend-reverse";
      let best: { index: number; sourceIndex: number; join: TransitJoin } | null = null;
      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        const candidateStart = candidate.points[0];
        const candidateEnd = candidate.points[candidate.points.length - 1];
        const joins: TransitJoin[] = [];
        if (sameCoordinate(end, candidateStart)) joins.push("append");
        if (sameCoordinate(end, candidateEnd)) joins.push("append-reverse");
        if (sameCoordinate(start, candidateEnd)) joins.push("prepend");
        if (sameCoordinate(start, candidateStart)) joins.push("prepend-reverse");
        if (!joins.length) continue;
        if (!best || candidate.sourceIndex < best.sourceIndex) {
          best = { index, sourceIndex: candidate.sourceIndex, join: joins[0] };
        }
      }
      if (!best) break;

      const candidate = remaining.splice(best.index, 1)[0];
      const oriented = best.join === "append-reverse" || best.join === "prepend-reverse"
        ? [...candidate.points].reverse()
        : [...candidate.points];
      if (best.join === "append" || best.join === "append-reverse") {
        oriented.shift();
        stitched.push(...oriented);
      } else {
        oriented.pop();
        stitched = [...oriented, ...stitched];
      }
      memberCount += 1;
    }

    components.push({ points: stitched, memberCount });
  }
  return components;
}

function normalizedEndpointName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("id-ID")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function stopOrPlatformCandidate(candidate: TransitEndpointMemberCandidate): boolean {
  const memberRole = candidate.memberRole.toLowerCase();
  const publicTransport = String(candidate.tags.public_transport || "").toLowerCase();
  const highway = String(candidate.tags.highway || "").toLowerCase();
  const railway = String(candidate.tags.railway || "").toLowerCase();
  return /(?:^|_)(?:stop|platform)(?:_|$)/.test(memberRole)
    || /^(?:stop_position|platform)$/.test(publicTransport)
    || /^(?:bus_stop|platform)$/.test(highway)
    || /^(?:station|halt|tram_stop|subway_entrance|platform)$/.test(railway);
}

function candidateNames(tags: Record<string, string>): string[] {
  return [
    tags["name:id"], tags.name, tags["official_name:id"], tags.official_name,
    tags.short_name, tags.local_name, tags.alt_name, tags.ref,
  ].flatMap((value) => String(value || "").split(";")).map(normalizedEndpointName).filter(Boolean);
}

/**
 * A route endpoint is publishable only when its from/to text matches the name
 * of an actual stop/platform member. The marker uses that member's coordinate,
 * never a guessed endpoint of the stitched route geometry.
 */
export function verifyTransitEndpoint(
  label: string,
  endpointRole: "from" | "to",
  candidates: readonly TransitEndpointMemberCandidate[],
): VerifiedTransitEndpoint | null {
  const normalizedLabel = normalizedEndpointName(label);
  if (!normalizedLabel) return null;
  const matches = candidates
    .filter(stopOrPlatformCandidate)
    .filter((candidate) => Number.isFinite(candidate.point.lat) && Number.isFinite(candidate.point.lng))
    .filter((candidate) => candidateNames(candidate.tags).includes(normalizedLabel))
    .sort((left, right) => left.memberIndex - right.memberIndex);
  const selected = endpointRole === "from" ? matches[0] : matches[matches.length - 1];
  if (!selected) return null;
  return {
    label,
    point: { ...selected.point },
    memberIndex: selected.memberIndex,
    memberType: selected.memberType,
    memberRef: selected.memberRef,
    memberRole: selected.memberRole,
    verification: "relation-stop-name-match",
  };
}
