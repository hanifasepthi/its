import manifestJson from "./manifest.json";

export type PoiIconDefinition = {
  id: string;
  category: string;
  micro: string;
  hero: string;
  tags: Record<string, string[]>;
  taxonomy: string[];
  aliases: string[];
  priority: number;
  minZoom: number;
  labelZoom: number;
  baseSize: number;
  color: string;
  glyph: string;
};

type PoiIconManifest = {
  version: number;
  generatedAt: string;
  requiredFallbacks: string[];
  icons: PoiIconDefinition[];
};

const assetModules = import.meta.glob([
  "./micro/**/*.{png,webp,avif,svg}",
  "./hero/**/*.{png,webp,avif,svg}",
], {
  eager: true,
  import: "default",
}) as Record<string, string>;

const manifest = manifestJson as unknown as PoiIconManifest;
const definitionsById = new Map(manifest.icons.map((definition) => [definition.id, definition]));

function normalized(value: unknown): string {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase();
}

function pathKey(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function poiIconAssetUrl(definition: PoiIconDefinition, variant: "micro" | "hero"): string {
  const wanted = pathKey(definition[variant]);
  return Object.entries(assetModules).find(([modulePath]) => {
    const candidate = pathKey(modulePath);
    return candidate === wanted || candidate.endsWith(`/${wanted}`);
  })?.[1] || "";
}

function tagMatchScore(tags: Record<string, string>, definition: PoiIconDefinition): number {
  let score = 0;
  for (const [key, acceptedValues] of Object.entries(definition.tags)) {
    const actual = normalized(tags[key]);
    if (!actual) continue;
    if (acceptedValues.some((candidate) => candidate === "*")) score += 24;
    if (acceptedValues.some((candidate) => normalized(candidate) === actual)) score += 180;
  }
  return score;
}

function semanticMatchScore(terms: string[], definition: PoiIconDefinition): number {
  const haystack = new Set([
    ...definition.taxonomy,
    ...definition.aliases,
    definition.category,
    definition.id,
  ].map(normalized));
  return terms.reduce((score, term) => {
    const clean = normalized(term);
    if (!clean) return score;
    if (haystack.has(clean)) return score + 42;
    if ([...haystack].some((candidate) => candidate.includes(clean) || clean.includes(candidate))) return score + 14;
    return score;
  }, 0);
}

function fallbackId(tags: Record<string, string>): string {
  if (tags.shop) return "generic.shop";
  if (tags.public_transport || tags.railway || tags.highway === "bus_stop") return "generic.transport";
  if (tags.office) return "generic.business";
  if (tags.craft) return "generic.service";
  if (tags.natural || tags.leisure || tags.landuse === "forest") return "generic.nature";
  if (tags.building) return "generic.building";
  return "generic.place";
}

export function resolvePoiIcon(
  tags: Record<string, string>,
  taxonomyCandidates: string[] = [],
): PoiIconDefinition {
  const sourceTerms = [
    ...taxonomyCandidates,
    tags.name,
    tags["name:id"],
    tags.amenity,
    tags.shop,
    tags.tourism,
    tags.office,
    tags.healthcare,
    tags.sport,
  ].filter((value): value is string => Boolean(value));
  const ranked = manifest.icons
    .filter((definition) => !definition.id.startsWith("generic."))
    .map((definition) => ({
      definition,
      score: tagMatchScore(tags, definition) + semanticMatchScore(sourceTerms, definition),
    }))
    .sort((left, right) => right.score - left.score || left.definition.priority - right.definition.priority);
  if (ranked[0] && ranked[0].score > 0) return ranked[0].definition;
  return definitionsById.get(fallbackId(tags)) || definitionsById.get("generic.place")!;
}

export function poiIconById(iconId: string): PoiIconDefinition {
  return definitionsById.get(iconId) || definitionsById.get("generic.place")!;
}

export function poiIconManifest(): Readonly<PoiIconManifest> {
  return manifest;
}
