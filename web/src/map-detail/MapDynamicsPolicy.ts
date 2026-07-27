import type { MapDetailFeatureCollection } from "./MapDetailStyle";
import type { MapDynamicsBounds } from "./MapDynamicsLoader";

export const MAP_DYNAMICS_ALLOWED_KINDS = new Set([
  "road", "sidewalk", "median", "cycleway", "pedestrian", "railway", "transit",
  "waterway", "green", "tree_row", "tree", "crossing", "traffic_signal", "school_zone",
  "street_lamp", "traffic_sign", "traffic_camera", "cctv", "speed_camera", "guardrail",
  "barrier", "bollard", "delineator", "speed_bump", "speed_table", "rumble_strip",
  "toll_gate", "traffic_island", "stop_line", "yield_line", "lane_arrow", "bench",
  "waste_basket", "fire_hydrant", "drinking_water", "toilets", "emergency_shelter",
  "entrance", "gate", "elevator", "escalator", "drain", "drain_grate", "manhole",
  "retaining_wall", "seawall", "platform", "taxi_stand", "motorcycle_taxi", "park_ride",
]);

type MapDynamicsFeature = MapDetailFeatureCollection["features"][number];

export type MapDynamicsSelectionStats = {
  received: number;
  verified: number;
  rejectedUnverified: number;
  rejectedInvalid: number;
  outsideViewport: number;
  duplicates: number;
  truncated: number;
};

export type MapDynamicsSelection = {
  collection: MapDetailFeatureCollection;
  stats: MapDynamicsSelectionStats;
};

type FeatureBounds = [west: number, south: number, east: number, north: number];

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function validViewport(bounds: MapDynamicsBounds): boolean {
  return [bounds.west, bounds.south, bounds.east, bounds.north].every(finiteNumber)
    && bounds.west >= -180
    && bounds.east <= 180
    && bounds.south >= -90
    && bounds.north <= 90
    && bounds.west <= bounds.east
    && bounds.south <= bounds.north;
}

function coordinatePairs(value: unknown, pairs: Array<[number, number]>, depth = 0): boolean {
  if (!Array.isArray(value) || !value.length || depth > 5) return false;
  if (value.every(finiteNumber)) {
    if (value.length < 2) return false;
    const [lng, lat] = value;
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return false;
    pairs.push([lng, lat]);
    return true;
  }
  return value.every((child) => coordinatePairs(child, pairs, depth + 1));
}

function geometryBounds(feature: MapDynamicsFeature): FeatureBounds | null {
  if (!["Point", "LineString", "Polygon"].includes(feature.geometry?.type)) return null;
  const pairs: Array<[number, number]> = [];
  if (!coordinatePairs(feature.geometry.coordinates, pairs) || !pairs.length) return null;
  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  pairs.forEach(([lng, lat]) => {
    west = Math.min(west, lng);
    south = Math.min(south, lat);
    east = Math.max(east, lng);
    north = Math.max(north, lat);
  });
  return [west, south, east, north];
}

function intersectsViewport(feature: FeatureBounds, viewport: MapDynamicsBounds): boolean {
  return feature[0] <= viewport.east
    && feature[2] >= viewport.west
    && feature[1] <= viewport.north
    && feature[3] >= viewport.south;
}

function verificationIsPublished(properties: Record<string, unknown>): boolean {
  return String(properties.verification ?? properties.confidence ?? "").trim().toLowerCase() === "verified";
}

function stableFeatureId(feature: MapDynamicsFeature): string {
  const properties = feature.properties;
  const source = String(properties.source || properties.sourceName || "").trim();
  const sourceId = String(properties.sourceId || feature.id || "").trim();
  return source && sourceId ? `${source}:${sourceId}` : "";
}

function revisionOf(feature: MapDynamicsFeature): number {
  const revision = Number(feature.properties.revision ?? 0);
  return Number.isFinite(revision) ? revision : 0;
}

function validPublishedFeature(feature: MapDynamicsFeature): boolean {
  if (!feature || feature.type !== "Feature" || !feature.properties || !feature.geometry) return false;
  const kind = String(feature.properties.kind || "").trim();
  return Boolean(kind && MAP_DYNAMICS_ALLOWED_KINDS.has(kind) && stableFeatureId(feature));
}

export function selectVerifiedMapDynamics(
  collection: MapDetailFeatureCollection,
  viewport: MapDynamicsBounds,
  maximumFeatures = 8_000,
): MapDynamicsSelection {
  const stats: MapDynamicsSelectionStats = {
    received: Array.isArray(collection?.features) ? collection.features.length : 0,
    verified: 0,
    rejectedUnverified: 0,
    rejectedInvalid: 0,
    outsideViewport: 0,
    duplicates: 0,
    truncated: 0,
  };
  if (!validViewport(viewport) || collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    stats.rejectedInvalid = stats.received;
    return { collection: { type: "FeatureCollection", features: [] }, stats };
  }

  const deduplicated = new Map<string, MapDynamicsFeature>();
  collection.features.forEach((feature) => {
    if (!verificationIsPublished(feature?.properties || {})) {
      stats.rejectedUnverified += 1;
      return;
    }
    if (!validPublishedFeature(feature)) {
      stats.rejectedInvalid += 1;
      return;
    }
    const bounds = geometryBounds(feature);
    if (!bounds) {
      stats.rejectedInvalid += 1;
      return;
    }
    if (!intersectsViewport(bounds, viewport)) {
      stats.outsideViewport += 1;
      return;
    }
    const id = stableFeatureId(feature);
    const previous = deduplicated.get(id);
    if (previous) {
      stats.duplicates += 1;
      if (revisionOf(previous) > revisionOf(feature)) return;
    }
    deduplicated.set(id, feature);
  });

  const limit = Math.max(0, Math.min(12_000, Math.floor(maximumFeatures)));
  const selected = [...deduplicated.values()];
  stats.truncated = Math.max(0, selected.length - limit);
  const features = selected.slice(0, limit);
  stats.verified = features.length;
  return { collection: { type: "FeatureCollection", features }, stats };
}
