import {
  bearingDegrees,
  lngLatToMeters,
  metersToLngLat,
  offsetLine,
  polygonAroundLine,
  sampleLine,
} from "./services";

import type {
  LngLat,
  Ornament3D,
  OverpassNode,
  OverpassPayload,
  OverpassWay,
  SceneCollections,
} from "./types";

type Tags = Record<string, string>;

type RoadGeometry = {
  id: number;
  points: LngLat[];
  tags: Tags;
  widthM: number;
};

type NearestRoad = {
  bearing: number;
  distanceM: number;
  widthM: number;
  roadId: number;
};

export type NavigationSceneBuildOptions = {
  maximumOrnaments?: number;
  /**
   * The snapped routing geometry currently being navigated. It is used only as
   * a safety corridor: an invalid/corrupt building footprint must never be
   * extruded through the carriageway followed by the vehicle.
   */
  focusRoute?: LngLat[];
  routeClearanceM?: number;
};

type MetricPoint = [x: number, y: number];

const EMPTY_COLLECTION = (): GeoJSON.FeatureCollection => ({
  type: "FeatureCollection",
  features: [],
});

function featureCollection(
  features: GeoJSON.Feature[] = [],
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features,
  };
}

function feature(
  geometry: GeoJSON.Geometry,
  properties: Record<string, unknown>,
  id?: string | number,
): GeoJSON.Feature {
  return {
    type: "Feature",
    id,
    geometry,
    properties,
  };
}

function parseNumber(tags: Tags, key: string, fallback: number): number {
  const raw = tags[key]?.trim();
  if (!raw) return fallback;

  const match = raw.replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  if (!match) return fallback;

  const parsed = Number.parseFloat(match[0]);
  if (!Number.isFinite(parsed)) return fallback;

  // OSM values are metric by default. Preserve explicitly tagged imperial data.
  if (/\b(?:ft|feet|foot)\b|'/i.test(raw)) return parsed * 0.3048;
  return parsed;
}

function isTruthy(value: string | undefined): boolean {
  return ["yes", "true", "1", "designated"].includes(
    String(value || "").toLowerCase(),
  );
}

function isClosedWay(way: OverpassWay): boolean {
  return way.nodes.length >= 4 && way.nodes[0] === way.nodes[way.nodes.length - 1];
}

function closeRing(points: LngLat[]): LngLat[] {
  if (points.length < 3) return points.slice();
  const first = points[0];
  const last = points[points.length - 1];
  return first[0] === last[0] && first[1] === last[1]
    ? points.slice()
    : [...points, first];
}

function pointToSegmentDistanceM(
  point: MetricPoint,
  first: MetricPoint,
  second: MetricPoint,
): number {
  const dx = second[0] - first[0];
  const dy = second[1] - first[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0.000001) return Math.hypot(point[0] - first[0], point[1] - first[1]);
  const ratio = Math.max(
    0,
    Math.min(
      1,
      ((point[0] - first[0]) * dx + (point[1] - first[1]) * dy) / lengthSquared,
    ),
  );
  return Math.hypot(
    point[0] - (first[0] + dx * ratio),
    point[1] - (first[1] + dy * ratio),
  );
}

function orientation(first: MetricPoint, second: MetricPoint, third: MetricPoint): number {
  return (
    (second[0] - first[0]) * (third[1] - first[1]) -
    (second[1] - first[1]) * (third[0] - first[0])
  );
}

function pointOnSegment(point: MetricPoint, first: MetricPoint, second: MetricPoint): boolean {
  const epsilon = 0.001;
  return (
    Math.abs(orientation(first, second, point)) <= epsilon &&
    point[0] >= Math.min(first[0], second[0]) - epsilon &&
    point[0] <= Math.max(first[0], second[0]) + epsilon &&
    point[1] >= Math.min(first[1], second[1]) - epsilon &&
    point[1] <= Math.max(first[1], second[1]) + epsilon
  );
}

function segmentsIntersect(
  firstStart: MetricPoint,
  firstEnd: MetricPoint,
  secondStart: MetricPoint,
  secondEnd: MetricPoint,
): boolean {
  const firstSecond = orientation(firstStart, firstEnd, secondStart);
  const firstThird = orientation(firstStart, firstEnd, secondEnd);
  const secondFirst = orientation(secondStart, secondEnd, firstStart);
  const secondSecond = orientation(secondStart, secondEnd, firstEnd);
  if (
    ((firstSecond > 0 && firstThird < 0) || (firstSecond < 0 && firstThird > 0)) &&
    ((secondFirst > 0 && secondSecond < 0) || (secondFirst < 0 && secondSecond > 0))
  ) {
    return true;
  }
  return (
    pointOnSegment(secondStart, firstStart, firstEnd) ||
    pointOnSegment(secondEnd, firstStart, firstEnd) ||
    pointOnSegment(firstStart, secondStart, secondEnd) ||
    pointOnSegment(firstEnd, secondStart, secondEnd)
  );
}

function pointInRing(point: MetricPoint, ring: MetricPoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const first = ring[index];
    const second = ring[previous];
    if (pointOnSegment(point, first, second)) return true;
    const crosses =
      (first[1] > point[1]) !== (second[1] > point[1]) &&
      point[0] <
        ((second[0] - first[0]) * (point[1] - first[1])) /
          (second[1] - first[1] || Number.EPSILON) +
          first[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

function buildingConflictsWithRoute(
  buildingRing: LngLat[],
  route: LngLat[],
  clearanceM: number,
): boolean {
  if (buildingRing.length < 4 || route.length < 2) return false;
  const ring = buildingRing.map(lngLatToMeters);
  const routePoints = route.map(lngLatToMeters);
  const safeClearance = Math.max(0, Math.min(4, clearanceM));

  for (let routeIndex = 1; routeIndex < routePoints.length; routeIndex += 1) {
    const routeStart = routePoints[routeIndex - 1];
    const routeEnd = routePoints[routeIndex];
    if (pointInRing(routeStart, ring) || pointInRing(routeEnd, ring)) return true;

    for (let ringIndex = 1; ringIndex < ring.length; ringIndex += 1) {
      const ringStart = ring[ringIndex - 1];
      const ringEnd = ring[ringIndex];
      if (segmentsIntersect(routeStart, routeEnd, ringStart, ringEnd)) return true;
      if (
        safeClearance > 0 &&
        (pointToSegmentDistanceM(ringStart, routeStart, routeEnd) <= safeClearance ||
          pointToSegmentDistanceM(routeStart, ringStart, ringEnd) <= safeClearance)
      ) {
        return true;
      }
    }
  }
  return false;
}

function laneCount(tags: Tags): number {
  const explicit = parseNumber(tags, "lanes", 0);
  if (explicit > 0) return Math.max(1, Math.min(12, Math.round(explicit)));

  if (isTruthy(tags.oneway) || tags.junction === "roundabout") {
    return ["motorway", "trunk", "primary"].includes(tags.highway) ? 2 : 1;
  }

  switch (tags.highway) {
    case "motorway":
    case "trunk":
      return 4;
    case "primary":
    case "secondary":
    case "tertiary":
    case "residential":
      return 2;
    default:
      return 1;
  }
}

function roadWidthM(tags: Tags): number {
  const explicit = parseNumber(tags, "width", 0);
  if (explicit > 0) return Math.max(1, Math.min(60, explicit));

  if (["footway", "path", "steps"].includes(tags.highway)) {
    return tags.highway === "steps" ? 1.8 : 2.2;
  }
  if (tags.highway === "cycleway") return 2.4;
  if (tags.highway === "pedestrian") return 4.5;
  if (tags.highway === "service") return Math.max(3.2, laneCount(tags) * 2.8);

  const laneWidth = ["motorway", "trunk"].includes(tags.highway) ? 3.55 : 3.25;
  return Math.max(3.2, laneCount(tags) * laneWidth);
}

function roadRole(tags: Tags): string {
  if (
    tags.busway ||
    tags["bus:lanes"] ||
    tags["lanes:bus"] ||
    tags["access:lanes"]?.includes("bus")
  ) {
    return "bus";
  }
  if (tags.highway === "cycleway" || tags.cycleway || tags["cycleway:left"] || tags["cycleway:right"]) {
    return "cycle";
  }
  if (["footway", "path", "steps", "pedestrian"].includes(tags.highway)) {
    return "pedestrian";
  }
  return "normal";
}

function pointsForWay(way: OverpassWay, nodes: Map<number, OverpassNode>): LngLat[] {
  const output: LngLat[] = [];
  for (const nodeId of way.nodes) {
    const node = nodes.get(nodeId);
    if (!node || !Number.isFinite(node.lon) || !Number.isFinite(node.lat)) continue;
    const coordinate: LngLat = [node.lon, node.lat];
    const previous = output[output.length - 1];
    if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) {
      output.push(coordinate);
    }
  }
  return output;
}

function addLaneMarkings(
  output: GeoJSON.Feature[],
  points: LngLat[],
  tags: Tags,
  widthM: number,
  wayId: number,
): void {
  const lanes = laneCount(tags);
  if (lanes <= 1 || ["footway", "path", "steps"].includes(tags.highway)) return;

  const laneWidth = widthM / lanes;
  for (let index = 1; index < lanes; index += 1) {
    const offset = -widthM / 2 + laneWidth * index;
    output.push(
      feature(
        { type: "LineString", coordinates: offsetLine(points, offset) },
        {
          markingType: "divider",
          color:
            ["motorway", "trunk"].includes(tags.highway) &&
            index === Math.ceil(lanes / 2) &&
            !isTruthy(tags.oneway)
              ? "yellow"
              : "white",
          pattern: "dashed",
          roadId: wayId,
          source: "osm-tag-derived",
        },
        `lane-${wayId}-${index}`,
      ),
    );
  }

  for (const [side, offset] of [
    ["left", widthM / 2 - 0.18],
    ["right", -widthM / 2 + 0.18],
  ] as const) {
    output.push(
      feature(
        { type: "LineString", coordinates: offsetLine(points, offset) },
        {
          markingType: "edge",
          color: side === "right" && tags.ref ? "yellow" : "white",
          pattern: "solid",
          roadId: wayId,
          source: "osm-tag-derived",
        },
        `edge-${wayId}-${side}`,
      ),
    );
  }
}

function addSidewalks(
  output: GeoJSON.Feature[],
  points: LngLat[],
  tags: Tags,
  widthM: number,
  wayId: number,
): void {
  const sidewalk = String(tags.sidewalk || "").toLowerCase();
  const left = sidewalk === "both" || sidewalk === "left" || isTruthy(tags["sidewalk:left"]);
  const right = sidewalk === "both" || sidewalk === "right" || isTruthy(tags["sidewalk:right"]);
  const sidewalkWidth = Math.max(0.8, Math.min(5, parseNumber(tags, "sidewalk:width", 1.8)));
  const surface = tags["sidewalk:surface"] || "paving_stones";

  for (const [side, sign] of [
    ["left", 1],
    ["right", -1],
  ] as const) {
    if ((side === "left" && !left) || (side === "right" && !right)) continue;
    const centerOffset = sign * (widthM / 2 + sidewalkWidth / 2 + 0.25);
    output.push(
      feature(
        polygonAroundLine(offsetLine(points, centerOffset), sidewalkWidth),
        {
          side,
          widthM: sidewalkWidth,
          surface,
          roadId: wayId,
          source: "osm-tag-derived",
        },
        `sidewalk-${wayId}-${side}`,
      ),
    );
  }
}

function addMedian(
  output: GeoJSON.Feature[],
  points: LngLat[],
  tags: Tags,
  wayId: number,
): void {
  const hasMedian = Boolean(tags.median || tags.divider) || isTruthy(tags.divided);
  if (!hasMedian) return;

  const medianWidth = Math.max(0.5, Math.min(12, parseNumber(tags, "median:width", 1.6)));
  const medianType =
    tags["median:surface"] === "grass" || tags.median === "grass"
      ? "garden"
      : tags.median === "water"
        ? "water"
        : "concrete";
  output.push(
    feature(
      polygonAroundLine(points, medianWidth),
      { medianType, widthM: medianWidth, roadId: wayId, source: "osm-tag-derived" },
      `median-${wayId}`,
    ),
  );
}

function nodeOrnamentKind(tags: Tags): Ornament3D["kind"] | null {
  if (tags.highway === "traffic_signals") return "traffic-signal";
  if (tags.highway === "crossing") return "crossing";
  if (tags.highway === "speed_camera") return "speed-camera";
  if (tags.man_made === "surveillance" || tags.surveillance) {
    return String(tags["surveillance:type"] || "").toUpperCase() === "ANPR" ? "etle" : "cctv";
  }
  if (tags.highway === "street_lamp") return "street-light";
  if (tags.natural === "tree") {
    const species = `${tags.species || ""} ${tags.genus || ""}`.toLowerCase();
    return species.includes("palm") || species.includes("cocos") ? "palm" : "tree";
  }
  if (tags.highway === "bus_stop" || tags.public_transport === "platform") return "bus-stop";
  if (tags.emergency === "fire_hydrant") return "hydrant";
  if (tags.barrier === "bollard") return "bollard";
  if (["gate", "lift_gate", "swing_gate"].includes(tags.barrier)) return "barrier";
  return null;
}

function ornamentPriority(kind: Ornament3D["kind"]): number {
  switch (kind) {
    case "traffic-signal": return 100;
    case "etle":
    case "cctv": return 95;
    case "speed-camera": return 92;
    case "crossing": return 88;
    case "bus-stop": return 70;
    case "hydrant": return 58;
    case "barrier": return 55;
    case "bridge-pier": return 45;
    case "street-light": return 30;
    case "tree":
    case "palm": return 20;
    default: return 35;
  }
}

function nearestRoadAt(coordinate: LngLat, roads: RoadGeometry[]): NearestRoad | null {
  const target = lngLatToMeters(coordinate);
  let nearest: NearestRoad | null = null;

  for (const road of roads) {
    for (let index = 1; index < road.points.length; index += 1) {
      const firstCoordinate = road.points[index - 1];
      const secondCoordinate = road.points[index];
      const first = lngLatToMeters(firstCoordinate);
      const second = lngLatToMeters(secondCoordinate);
      const dx = second[0] - first[0];
      const dy = second[1] - first[1];
      const lengthSquared = dx * dx + dy * dy;
      if (lengthSquared <= 0.0001) continue;
      const ratio = Math.max(
        0,
        Math.min(1, ((target[0] - first[0]) * dx + (target[1] - first[1]) * dy) / lengthSquared),
      );
      const closestX = first[0] + dx * ratio;
      const closestY = first[1] + dy * ratio;
      const distance = Math.hypot(target[0] - closestX, target[1] - closestY);
      if (!nearest || distance < nearest.distanceM) {
        nearest = {
          bearing: bearingDegrees(firstCoordinate, secondCoordinate),
          distanceM: distance,
          widthM: road.widthM,
          roadId: road.id,
        };
      }
    }
  }

  return nearest && nearest.distanceM <= Math.max(18, nearest.widthM * 1.5) ? nearest : null;
}

function coordinateOffset(
  coordinate: LngLat,
  eastM: number,
  northM: number,
): LngLat {
  const point = lngLatToMeters(coordinate);
  return metersToLngLat([point[0] + eastM, point[1] + northM]);
}

function addCrosswalkMarkings(
  output: GeoJSON.Feature[],
  node: OverpassNode,
  road: NearestRoad,
): void {
  const center: LngLat = [node.lon, node.lat];
  const roadRadians = (road.bearing * Math.PI) / 180;
  const acrossEast = Math.cos(roadRadians);
  const acrossNorth = -Math.sin(roadRadians);
  const alongEast = Math.sin(roadRadians);
  const alongNorth = Math.cos(roadRadians);
  const halfWidth = Math.max(1.6, road.widthM / 2 - 0.25);
  const stripeCount = Math.max(3, Math.min(9, Math.round(road.widthM / 1.15)));
  const spacing = 0.7;

  for (let index = 0; index < stripeCount; index += 1) {
    const alongOffset = (index - (stripeCount - 1) / 2) * spacing;
    const stripeCenter = coordinateOffset(
      center,
      alongEast * alongOffset,
      alongNorth * alongOffset,
    );
    output.push(
      feature(
        {
          type: "LineString",
          coordinates: [
            coordinateOffset(stripeCenter, -acrossEast * halfWidth, -acrossNorth * halfWidth),
            coordinateOffset(stripeCenter, acrossEast * halfWidth, acrossNorth * halfWidth),
          ],
        },
        {
          markingType: "crossing",
          color: "white",
          pattern: "solid",
          roadId: road.roadId,
          bearing: road.bearing,
          widthM: road.widthM,
          source: "osm-crossing-derived",
        },
        `crossing-${node.id}-${index}`,
      ),
    );
  }
}

/**
 * Turns the returned Overpass nodes and ways into a local, lane-level scene.
 * Every placed object is based on an OSM element or an explicit OSM tag. Missing
 * network data therefore produces an empty scene instead of invented geography.
 */
export function buildScene(
  payload: OverpassPayload,
  maximumOrOptions: number | NavigationSceneBuildOptions = 500,
  legacyFocusRoute: LngLat[] = [],
): SceneCollections {
  const options: NavigationSceneBuildOptions =
    typeof maximumOrOptions === "number"
      ? { maximumOrnaments: maximumOrOptions, focusRoute: legacyFocusRoute }
      : maximumOrOptions;
  const maximumOrnaments = options.maximumOrnaments ?? 500;
  const focusRoute = (options.focusRoute || []).filter(
    (coordinate): coordinate is LngLat =>
      Array.isArray(coordinate) &&
      Number.isFinite(coordinate[0]) &&
      Number.isFinite(coordinate[1]),
  );
  const ornamentLimit = Math.max(0, Math.min(2_000, Math.floor(maximumOrnaments)));
  const nodes = new Map<number, OverpassNode>();
  const ways: OverpassWay[] = [];

  for (const element of payload?.elements || []) {
    if (element.type === "node") {
      // Overpass commonly emits a tagged node in `out body` and emits the same
      // node again without tags in the later `out skel` recursion. Merge the
      // records so traffic lights, crossings and other real ornaments survive.
      const existing = nodes.get(element.id);
      nodes.set(
        element.id,
        existing
          ? {
              ...existing,
              ...element,
              tags:
                existing.tags || element.tags
                  ? { ...(existing.tags || {}), ...(element.tags || {}) }
                  : undefined,
            }
          : element,
      );
    }
    else if (element.type === "way") ways.push(element);
  }

  const roads: GeoJSON.Feature[] = [];
  const sidewalks: GeoJSON.Feature[] = [];
  const medians: GeoJSON.Feature[] = [];
  const bridges: GeoJSON.Feature[] = [];
  const footbridges: GeoJSON.Feature[] = [];
  const tunnels: GeoJSON.Feature[] = [];
  const markings: GeoJSON.Feature[] = [];
  const waterways: GeoJSON.Feature[] = [];
  const greens: GeoJSON.Feature[] = [];
  const buildings: GeoJSON.Feature[] = [];
  const pointSymbols: GeoJSON.Feature[] = [];
  const ornaments: Ornament3D[] = [];
  const roadGeometries: RoadGeometry[] = [];

  for (const way of ways) {
    const tags = way.tags || {};
    if (!tags.highway) continue;
    const points = pointsForWay(way, nodes);
    if (points.length < 2) continue;
    roadGeometries.push({ id: way.id, points, tags, widthM: roadWidthM(tags) });
  }

  for (const way of ways) {
    const tags = way.tags || {};
    const points = pointsForWay(way, nodes);
    if (points.length < 2) continue;
    const closed = isClosedWay(way) && points.length >= 4;

    if (tags.building && closed) {
      const ring = closeRing(points);
      if (
        buildingConflictsWithRoute(
          ring,
          focusRoute,
          options.routeClearanceM ?? 1.35,
        )
      ) {
        // A route returned by the router is already snapped to a real road.
        // Dropping only a footprint that intersects that narrow centreline
        // avoids the much worse failure mode of a solid extrusion blocking the
        // guidance lane. Adjacent buildings remain untouched.
        continue;
      }
      const levels = parseNumber(tags, "building:levels", 0);
      const height = parseNumber(tags, "height", levels > 0 ? levels * 3.2 : 9);
      const baseHeight = parseNumber(tags, "min_height", 0);
      buildings.push(
        feature(
          { type: "Polygon", coordinates: [ring] },
          {
            name: tags.name || "",
            building: tags.building,
            height: Math.max(2.8, Math.min(500, height)),
            baseHeight: Math.max(0, Math.min(450, baseHeight)),
            source: "osm",
          },
          way.id,
        ),
      );
      if (!tags.highway) continue;
    }

    if (tags.natural === "water" || tags.water || tags.waterway) {
      waterways.push(
        feature(
          closed
            ? { type: "Polygon", coordinates: [closeRing(points)] }
            : { type: "LineString", coordinates: points },
          { waterType: tags.waterway || tags.water || "water", name: tags.name || "", source: "osm" },
          way.id,
        ),
      );
      if (!tags.highway) continue;
    }

    if ((tags.leisure === "park" || tags.leisure === "garden" || tags.landuse) && closed) {
      greens.push(
        feature(
          { type: "Polygon", coordinates: [closeRing(points)] },
          {
            greenType: tags.leisure || tags.landuse || "green",
            name: tags.name || "",
            source: "osm",
          },
          way.id,
        ),
      );
      if (!tags.highway) continue;
    }

    if (!tags.highway) continue;

    const widthM = roadWidthM(tags);
    const layer = parseNumber(tags, "layer", 0);
    const isBridge = isTruthy(tags.bridge) || tags.bridge === "viaduct";
    const isTunnel = isTruthy(tags.tunnel) || tags.tunnel === "building_passage" || layer < 0;
    const isFootbridge =
      isBridge && ["footway", "pedestrian", "steps", "path"].includes(tags.highway);
    // OSM commonly marks only the bridge deck, without approach elevation
    // geometry. Raising the whole polygon by 5 m created disconnected,
    // floating ramps. Keep the deck continuous with its approach until a
    // measured elevation profile is available.
    const baseHeight = 0;
    const surface = feature(
      polygonAroundLine(points, widthM),
      {
        roadClass: tags.highway,
        roadName: tags.name || "",
        ref: tags.ref || "",
        lanes: laneCount(tags),
        widthM,
        surface: tags.surface || "asphalt",
        surfaceRole: roadRole(tags),
        layer,
        baseHeight,
        deckHeight: baseHeight + (isFootbridge ? 0.28 : 0.42),
        source: "osm-tag-derived",
      },
      way.id,
    );

    if (isFootbridge) footbridges.push(surface);
    else if (isBridge) bridges.push(surface);
    else if (isTunnel) {
      tunnels.push(
        feature(
          { type: "LineString", coordinates: points },
          { ...(surface.properties || {}), source: "osm" },
          way.id,
        ),
      );
    } else roads.push(surface);

    addLaneMarkings(markings, points, tags, widthM, way.id);
    addSidewalks(sidewalks, points, tags, widthM, way.id);
    addMedian(medians, points, tags, way.id);

    if (isTruthy(tags.lit) && ornaments.length < ornamentLimit * 2) {
      for (const side of [-1, 1]) {
        const lampLine = offsetLine(points, side * (widthM / 2 + 1.5));
        for (const sample of sampleLine(lampLine, 42)) {
          ornaments.push({
            id: `lamp-${way.id}-${side}-${ornaments.length}`,
            kind: "street-light",
            coordinate: sample.coordinate,
            bearing: sample.bearing + (side > 0 ? 90 : -90),
            priority: 30,
            metadata: { source: "osm-lit-derived", roadId: way.id },
          });
          if (ornaments.length >= ornamentLimit * 2) break;
        }
      }
    }

    if (isTruthy(tags.tree_lined) && ornaments.length < ornamentLimit * 2) {
      for (const side of [-1, 1]) {
        const treeLine = offsetLine(points, side * (widthM / 2 + 3.2));
        for (const sample of sampleLine(treeLine, 25)) {
          ornaments.push({
            id: `tree-${way.id}-${side}-${ornaments.length}`,
            kind: "tree",
            coordinate: sample.coordinate,
            bearing: sample.bearing,
            scale: 0.9,
            priority: 20,
            metadata: { source: "osm-tree-lined-derived", roadId: way.id },
          });
          if (ornaments.length >= ornamentLimit * 2) break;
        }
      }
    }

    if (isBridge && ornaments.length < ornamentLimit * 2) {
      for (const sample of sampleLine(points, 32)) {
        ornaments.push({
          id: `pier-${way.id}-${ornaments.length}`,
          kind: "bridge-pier",
          coordinate: sample.coordinate,
          altitudeM: 0,
          bearing: sample.bearing,
          priority: 45,
          metadata: { source: "osm-bridge-derived", roadId: way.id, heightM: Math.max(3, baseHeight) },
        });
        if (ornaments.length >= ornamentLimit * 2) break;
      }
    }
  }

  for (const node of nodes.values()) {
    const tags = node.tags || {};
    const kind = nodeOrnamentKind(tags);
    if (!kind) continue;

    const coordinate: LngLat = [node.lon, node.lat];
    const nearestRoad = nearestRoadAt(coordinate, roadGeometries);
    const explicitDirection = parseNumber(tags, "direction", Number.NaN);
    const bearing = Number.isFinite(explicitDirection)
      ? ((explicitDirection % 360) + 360) % 360
      : nearestRoad?.bearing || 0;
    const priority = ornamentPriority(kind);

    pointSymbols.push(
      feature(
        { type: "Point", coordinates: coordinate },
        {
          kind,
          priority,
          name: tags.name || "",
          bearing,
          roadWidthM: nearestRoad?.widthM || 0,
          source: "osm",
        },
        node.id,
      ),
    );

    ornaments.push({
      id: `${kind}-${node.id}`,
      kind,
      coordinate,
      priority,
      bearing,
      scale: kind === "tree" || kind === "palm" ? 0.9 : 1,
      metadata: { ...tags, source: "osm", roadWidthM: nearestRoad?.widthM || 0 },
    });

    if (kind === "crossing" && nearestRoad) {
      addCrosswalkMarkings(markings, node, nearestRoad);
    }
  }

  ornaments.sort(
    (first, second) =>
      (second.priority || 0) - (first.priority || 0) || first.id.localeCompare(second.id),
  );

  return {
    roads: featureCollection(roads),
    sidewalks: featureCollection(sidewalks),
    medians: featureCollection(medians),
    bridges: featureCollection(bridges),
    footbridges: featureCollection(footbridges),
    tunnels: featureCollection(tunnels),
    markings: featureCollection(markings),
    waterways: featureCollection(waterways),
    greens: featureCollection(greens),
    buildings: featureCollection(buildings),
    pointSymbols: featureCollection(pointSymbols),
    ornaments: ornaments.slice(0, ornamentLimit),
  };
}

export const buildNavigationScene = buildScene;

export function emptyNavigationScene(): SceneCollections {
  return {
    roads: EMPTY_COLLECTION(),
    sidewalks: EMPTY_COLLECTION(),
    medians: EMPTY_COLLECTION(),
    bridges: EMPTY_COLLECTION(),
    footbridges: EMPTY_COLLECTION(),
    tunnels: EMPTY_COLLECTION(),
    markings: EMPTY_COLLECTION(),
    waterways: EMPTY_COLLECTION(),
    greens: EMPTY_COLLECTION(),
    buildings: EMPTY_COLLECTION(),
    pointSymbols: EMPTY_COLLECTION(),
    ornaments: [],
  };
}
