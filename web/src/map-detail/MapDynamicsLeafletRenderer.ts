import L from "leaflet";
import { MapDynamicsLoader, type MapDynamicsBounds, type MapDynamicsLoadResult } from "./MapDynamicsLoader";
import {
  selectVerifiedMapDynamics,
  type MapDynamicsSelectionStats,
} from "./MapDynamicsPolicy";
import type { MapDetailFeatureCollection } from "./MapDetailStyle";

type MapDynamicsFeature = MapDetailFeatureCollection["features"][number];
type MapDynamicsLoaderLike = Pick<MapDynamicsLoader, "load">;

export type MapDynamicsRendererStatus = "idle" | "loading" | "ready" | "error" | "out-of-range" | "disposed";

export type MapDynamicsRendererStats = MapDynamicsSelectionStats & {
  status: MapDynamicsRendererStatus;
  requestId: number;
  viewportKey: string;
  zoom: number;
  manifestVersion: string;
  selectedShards: number;
  loadedShards: number;
  remoteDeltas: number;
  renderedFeatures: number;
  renderedLayers: number;
  collisionSkipped: number;
  clusterMarkers: number;
  clusteredPoints: number;
  generalizedPoints: number;
  unsupported: number;
  source: MapDynamicsLoadResult["source"];
  byKind: Record<string, number>;
  startedAt: number;
  finishedAt: number;
  error: string;
};

export type MapDynamicsRendererOptions = {
  manifestUrl?: string;
  loader?: MapDynamicsLoaderLike;
  paneName?: string;
  paneZIndex?: number;
  pointPaneName?: string;
  pointPaneZIndex?: number;
  minimumZoom?: number;
  maximumZoom?: number;
  pointMinimumZoom?: number;
  maximumFeatures?: number;
  moveDebounceMs?: number;
  refreshIntervalMs?: number;
  minimumSameViewportAgeMs?: number;
  autoStart?: boolean;
  onPublish?: (collection: MapDetailFeatureCollection, stats: Readonly<MapDynamicsRendererStats>) => void;
  onPointClick?: (feature: MapDynamicsFeature, point: L.LatLng) => void;
};

const EMPTY_COLLECTION: MapDetailFeatureCollection = { type: "FeatureCollection", features: [] };

const EMPTY_SELECTION_STATS: MapDynamicsSelectionStats = {
  received: 0,
  verified: 0,
  rejectedUnverified: 0,
  rejectedInvalid: 0,
  outsideViewport: 0,
  duplicates: 0,
  truncated: 0,
};

const DEFAULT_STATS: MapDynamicsRendererStats = {
  ...EMPTY_SELECTION_STATS,
  status: "idle",
  requestId: 0,
  viewportKey: "",
  zoom: 0,
  manifestVersion: "",
  selectedShards: 0,
  loadedShards: 0,
  remoteDeltas: 0,
  renderedFeatures: 0,
  renderedLayers: 0,
  collisionSkipped: 0,
  clusterMarkers: 0,
  clusteredPoints: 0,
  generalizedPoints: 0,
  unsupported: 0,
  source: "empty",
  byKind: {},
  startedAt: 0,
  finishedAt: 0,
  error: "",
};

const TRANSIT_COLORS: Record<string, string> = {
  busway: "#e53935",
  bus: "#2563eb",
  mrt: "#1677ff",
  subway: "#1677ff",
  lrt: "#00a88f",
  light_rail: "#00a88f",
  tram: "#7c3aed",
  monorail: "#d97706",
  commuter: "#dc2626",
  high_speed: "#e11d48",
  train: "#475569",
  rail: "#475569",
};

const POINT_PRIORITY: Record<string, number> = {
  traffic_signal: 0,
  crossing: 1,
  toll_gate: 2,
  traffic_camera: 3,
  speed_camera: 3,
  cctv: 4,
  transport: 5,
  healthcare: 6,
  education: 7,
  public_service: 8,
  attraction: 9,
  food: 10,
  shopping: 11,
  lodging: 12,
  worship: 13,
  fire_hydrant: 5,
  school_zone: 14,
  gate: 40,
  barrier: 41,
  toilets: 20,
  elevator: 21,
  emergency_shelter: 15,
  drinking_water: 22,
  entrance: 42,
  bench: 45,
  waste_basket: 46,
  street_lamp: 47,
  tree: 48,
};

const POINT_MINIMUM_ZOOM: Record<string, number> = {
  traffic_signal: 15,
  crossing: 15,
  traffic_camera: 16,
  speed_camera: 16,
  cctv: 16,
  toll_gate: 16,
  school_zone: 16,
  platform: 16,
  fire_hydrant: 17,
  gate: 19,
  barrier: 19,
  toilets: 17,
  emergency_shelter: 17,
  drinking_water: 17,
  elevator: 17,
  escalator: 17,
  taxi_stand: 17,
  park_ride: 17,
  speed_bump: 17,
  speed_table: 17,
  rumble_strip: 17,
  street_lamp: 18,
  bench: 18,
  waste_basket: 18,
  entrance: 19,
  bollard: 19,
  delineator: 19,
  manhole: 18,
  drain_grate: 18,
  healthcare: 15,
  education: 15,
  transport: 14,
  food: 16,
  lodging: 16,
  public_service: 15,
  attraction: 15,
  worship: 16,
  shopping: 16,
  tree: 18,
  poi: 16,
};

type PointPictogram = {
  accent: string;
  markup: string;
  wide?: boolean;
  light?: boolean;
};

const POINT_PICTOGRAMS: Record<string, PointPictogram> = {
  traffic_signal: {
    accent: "#1f2937",
    markup: '<rect x="7" y="2" width="10" height="20" rx="3" fill="#111827"/><circle cx="12" cy="7" r="2" fill="#ef4444"/><circle cx="12" cy="12" r="2" fill="#facc15"/><circle cx="12" cy="17" r="2" fill="#22c55e"/>',
  },
  crossing: {
    accent: "#2563eb",
    // A point only confirms a crossing location. It must not imply zebra
    // markings that require mapped line/polygon geometry and crossing tags.
    markup: '<circle cx="12" cy="6" r="2"/><path d="m12 8-3 5 3 2 2 6m-5-8-4 3m7-6 4 3 3-1"/>',
  },
  street_lamp: {
    accent: "#ca8a04",
    markup: '<path d="M7 21h10M12 21V9c0-3 2-5 5-5h2v5h-7"/><path d="M16 9h4"/>',
  },
  cctv: {
    accent: "#6d28d9",
    markup: '<path d="M3 7h13l4 4-4 4H3z"/><circle cx="8" cy="11" r="2"/><path d="M10 15v4m-4 0h8"/>',
  },
  traffic_camera: {
    accent: "#6d28d9",
    markup: '<path d="M3 7h13l4 4-4 4H3z"/><circle cx="8" cy="11" r="2"/><path d="M10 15v4m-4 0h8M19 5l2-2M20 8h3"/>',
  },
  speed_camera: {
    accent: "#7c3aed",
    markup: '<path d="M3 7h13l4 4-4 4H3z"/><circle cx="8" cy="11" r="2"/><path d="M10 15v4m-4 0h8M18 3l-3 5h4l-3 5"/>',
  },
  fire_hydrant: {
    accent: "#dc2626",
    markup: '<path d="M8 21V9a4 4 0 0 1 8 0v12M6 12h12M5 9h3m8 0h3M6 21h12"/>',
  },
  bench: {
    accent: "#64748b",
    markup: '<path d="M4 9h16v7H4zM6 16v5m12-5v5M5 6h14v3"/>',
  },
  waste_basket: {
    accent: "#475569",
    markup: '<path d="M7 7h10l-1 14H8L7 7Zm-2 0h14M9 4h6m-5 6v8m4-8v8"/>',
  },
  toilets: {
    accent: "#2563eb", wide: true,
    markup: '<text x="12" y="15" text-anchor="middle" fill="currentColor" stroke="none" font-size="9" font-weight="800" font-family="system-ui,sans-serif">WC</text>',
  },
  gate: {
    accent: "#c2410c", wide: true,
    markup: '<path d="M4 21V5h16v16M4 9h16M8 9v12m8-12v12M8 15h8"/>',
  },
  toll_gate: {
    accent: "#b91c1c", wide: true,
    markup: '<path d="M3 21V7h12v14M3 10h12M15 12h6M18 9v6"/><path d="M6 15h6"/>',
  },
  barrier: {
    accent: "#c2410c", wide: true,
    markup: '<path d="M3 9h18v7H3zM6 16v5m12-5v5M5 9l4 7m3-7 4 7"/>',
  },
  bollard: {
    accent: "#c2410c",
    markup: '<path d="M9 21h6l-1-15h-4L9 21Zm0-4h6M9.5 10h5"/>',
  },
  entrance: {
    accent: "#2563eb",
    markup: '<path d="M5 21V3h12v18M9 12h12m-4-4 4 4-4 4"/>',
  },
  elevator: {
    accent: "#0891b2",
    markup: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m9 9 3-3 3 3m-6 6 3 3 3-3"/>',
  },
  escalator: {
    accent: "#0891b2",
    markup: '<circle cx="7" cy="6" r="2"/><path d="M4 20h4l8-10h4M8 9l3 4M10 17h10"/>',
  },
  tree: {
    accent: "#15803d",
    markup: '<path d="M12 21v-6M8 21h8"/><path d="M12 3 6 13h4l-3 4h10l-3-4h4L12 3Z"/>',
  },
  traffic_sign: {
    accent: "#dc2626",
    markup: '<path d="m12 3 9 16H3L12 3Z"/><path d="M12 9v5m0 2v1"/>',
  },
  school_zone: {
    accent: "#d97706",
    markup: '<path d="m12 3 9 16H3L12 3Z"/><circle cx="10" cy="10" r="1.5"/><circle cx="14" cy="10" r="1.5"/><path d="m8 16 2-3 2 2 2-2 2 3"/>',
  },
  platform: {
    accent: "#1d4ed8",
    markup: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h8M9 17h.01M15 17h.01"/>',
  },
  drinking_water: {
    accent: "#0284c7",
    markup: '<path d="M12 3s-6 7-6 12a6 6 0 0 0 12 0c0-5-6-12-6-12Z"/><path d="M9 16c1 2 3 2 4 1"/>',
  },
  emergency_shelter: {
    accent: "#059669",
    markup: '<path d="m3 11 9-7 9 7M5 10v11h14V10M9 21v-7h6v7"/>',
  },
  taxi_stand: {
    accent: "#2563eb", wide: true,
    markup: '<text x="12" y="15" text-anchor="middle" fill="currentColor" stroke="none" font-size="8" font-weight="800" font-family="system-ui,sans-serif">TX</text>',
  },
  motorcycle_taxi: {
    accent: "#2563eb",
    markup: '<circle cx="7" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="m7 17 4-7h4l3 7m-7-7-2-3H6"/>',
  },
  park_ride: {
    accent: "#2563eb", wide: true,
    markup: '<text x="12" y="15" text-anchor="middle" fill="currentColor" stroke="none" font-size="8" font-weight="800" font-family="system-ui,sans-serif">P+R</text>',
  },
  manhole: {
    accent: "#475569",
    markup: '<circle cx="12" cy="12" r="8"/><path d="M6 12h12M12 6v12M8 8l8 8m0-8-8 8"/>',
  },
  drain_grate: {
    accent: "#475569",
    markup: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 6v12m4-12v12m4-12v12"/>',
  },
  speed_bump: {
    accent: "#d97706", wide: true,
    markup: '<path d="M3 17h18M5 17c2-7 4-7 7-7s5 0 7 7"/>',
  },
  speed_table: {
    accent: "#d97706", wide: true,
    markup: '<path d="M3 17h18M5 17l3-6h8l3 6"/>',
  },
  rumble_strip: {
    accent: "#d97706", wide: true,
    markup: '<path d="M3 8h18M3 12h18M3 16h18"/>',
  },
  traffic_island: {
    accent: "#0f766e",
    markup: '<path d="M12 3c5 5 7 11 0 18C5 14 7 8 12 3Z"/><path d="M12 7v10"/>',
  },
  delineator: {
    accent: "#ea580c",
    markup: '<path d="M9 21h6L14 4h-4L9 21Z"/><path d="M10 9h4"/>',
  },
  healthcare: {
    accent: "#dc2626",
    markup: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6V3Z"/>',
  },
  education: {
    accent: "#2563eb",
    markup: '<path d="m3 9 9-5 9 5-9 5-9-5Z"/><path d="M6 11v5c3 3 9 3 12 0v-5M21 9v7"/>',
  },
  transport: {
    accent: "#0f766e",
    markup: '<rect x="5" y="3" width="14" height="17" rx="3"/><path d="M8 7h8M8 12h8M8 17h.01M16 17h.01M7 20l-2 2m12-2 2 2"/>',
  },
  food: {
    accent: "#ea580c",
    markup: '<path d="M7 3v8m-3-8v5c0 2 1 3 3 3s3-1 3-3V3M7 11v10M15 3v18m0-18c4 2 5 7 0 10"/>',
  },
  lodging: {
    accent: "#7c3aed",
    markup: '<path d="M3 20V7m0 8h18v5M7 15v-4h5c3 0 5 2 5 4M5 7h4v4H5z"/>',
  },
  public_service: {
    accent: "#475569",
    markup: '<path d="m3 9 9-6 9 6M5 9h14M6 9v9m4-9v9m4-9v9m4-9v9M3 21h18M5 18h14"/>',
  },
  attraction: {
    accent: "#16a34a",
    markup: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
  },
  worship: {
    accent: "#0891b2",
    markup: '<path d="M5 21V10l7-6 7 6v11M3 21h18M9 21v-6h6v6M12 4V1"/>',
  },
  shopping: {
    accent: "#db2777",
    markup: '<path d="M5 8h14l-1 13H6L5 8Zm3 0a4 4 0 0 1 8 0"/>',
  },
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function cleanText(value: unknown, maximum = 160): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maximum);
}

function escapeHtml(value: unknown): string {
  return cleanText(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function normalizedToken(value: unknown): string {
  return cleanText(value, 80).toLowerCase();
}

function verifiedHexColor(value: unknown): string {
  const color = cleanText(value, 16);
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "";
}

function featureKind(feature: MapDynamicsFeature): string {
  return normalizedToken(feature.properties.kind);
}

function featurePriority(feature: MapDynamicsFeature): number {
  const kind = featureKind(feature);
  if (kind === "waterway" || kind === "drain") return 0;
  if (kind === "road" || kind === "median") return 1;
  if (["sidewalk", "cycleway", "pedestrian"].includes(kind)) return 2;
  if (kind === "railway") return 3;
  if (kind === "transit") return 4;
  if (feature.geometry.type === "Point") return 5;
  return 6;
}

function viewportBounds(map: L.Map): MapDynamicsBounds {
  const bounds = map.getBounds();
  const west = clamp(bounds.getWest(), -180, 180);
  const east = clamp(bounds.getEast(), -180, 180);
  return {
    west: west <= east ? west : -180,
    south: clamp(bounds.getSouth(), -90, 90),
    east: west <= east ? east : 180,
    north: clamp(bounds.getNorth(), -90, 90),
  };
}

function viewportKey(bounds: MapDynamicsBounds, zoom: number): string {
  return [zoom.toFixed(2), bounds.west, bounds.south, bounds.east, bounds.north]
    .map((value) => typeof value === "number" ? value.toFixed(5) : value)
    .join(":");
}

function lineCoordinates(feature: MapDynamicsFeature): L.LatLngExpression[] | null {
  if (feature.geometry.type !== "LineString" || !Array.isArray(feature.geometry.coordinates)) return null;
  const points = feature.geometry.coordinates.map((coordinate) => {
    if (!Array.isArray(coordinate) || coordinate.length < 2) return null;
    const lng = Number(coordinate[0]);
    const lat = Number(coordinate[1]);
    return Number.isFinite(lat) && Number.isFinite(lng) ? L.latLng(lat, lng) : null;
  });
  return points.every((point): point is L.LatLng => Boolean(point)) && points.length >= 2 ? points : null;
}

function polygonCoordinates(feature: MapDynamicsFeature): L.LatLngExpression[][] | null {
  if (feature.geometry.type !== "Polygon" || !Array.isArray(feature.geometry.coordinates)) return null;
  const rings = feature.geometry.coordinates.map((ring) => {
    if (!Array.isArray(ring)) return [];
    return ring.flatMap((coordinate) => {
      if (!Array.isArray(coordinate) || coordinate.length < 2) return [];
      const lng = Number(coordinate[0]);
      const lat = Number(coordinate[1]);
      return Number.isFinite(lat) && Number.isFinite(lng) ? [L.latLng(lat, lng)] : [];
    });
  });
  return rings.length && rings.every((ring) => ring.length >= 3) ? rings : null;
}

function pointCoordinate(feature: MapDynamicsFeature): L.LatLng | null {
  if (feature.geometry.type !== "Point" || !Array.isArray(feature.geometry.coordinates)) return null;
  const lng = Number(feature.geometry.coordinates[0]);
  const lat = Number(feature.geometry.coordinates[1]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? L.latLng(lat, lng) : null;
}

function mappedDimension(feature: MapDynamicsFeature, keys: string[], fallback = 0): number {
  for (const key of keys) {
    const value = Number(feature.properties[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return fallback;
}

function featureTitle(feature: MapDynamicsFeature): string {
  const properties = feature.properties;
  const kind = featureKind(feature);
  const name = cleanText(properties.name || properties.officialName || properties.ref, 120);
  const subtype = cleanText(
    properties.crossingType || properties.crossingMarking || properties.crossing
    || properties.highway || properties.railway || properties.waterway
    || properties.transitMode || properties.route || kind.replaceAll("_", " "),
    100,
  );
  return [name, subtype].filter(Boolean).filter((value, index, values) => (
    values.findIndex((candidate) => candidate.toLocaleLowerCase("id-ID") === value.toLocaleLowerCase("id-ID")) === index
  )).join(" · ");
}

function bindFeatureTooltip<T extends L.Layer>(layer: T, feature: MapDynamicsFeature): T {
  const title = featureTitle(feature);
  if (title) layer.bindTooltip(escapeHtml(title), { direction: "top", sticky: true, opacity: 0.94 });
  return layer;
}

function networkSmoothFactor(zoom: number): number {
  if (zoom <= 8) return 2.8;
  if (zoom <= 11) return 2.1;
  if (zoom <= 14) return 1.45;
  return 0.75;
}

function markedCrossing(feature: MapDynamicsFeature): boolean {
  const identity = [
    feature.properties.crossingType,
    feature.properties.crossingMarking,
    feature.properties.crossing,
    feature.properties.marking,
    feature.properties.roadMarking,
  ].map(normalizedToken).join(" ");
  return /(?:^|\s)(?:zebra|marked|ladder|lines)(?:\s|$)/.test(identity);
}

function crossingLineStyles(feature: MapDynamicsFeature, zoom: number): L.PolylineOptions[] {
  const physicalWidth = mappedDimension(feature, ["width", "crossingWidth"], 3);
  const width = clamp(2.8 + physicalWidth * 0.48 + (zoom - 15) * 0.35, 3.2, 13);
  if (!markedCrossing(feature)) {
    return [{
      color: "#334155",
      weight: width,
      opacity: 0.82,
      dashArray: "3 4",
      lineCap: "butt",
      lineJoin: "round",
      className: "map-dynamics-crossing-line map-dynamics-crossing-unmarked",
      interactive: true,
    }];
  }
  return [
    {
      color: "#334155",
      weight: width + 2.4,
      opacity: 0.76,
      lineCap: "butt",
      lineJoin: "round",
      className: "map-dynamics-crossing-line map-dynamics-crossing-zebra-casing",
      interactive: true,
    },
    {
      color: "#ffffff",
      weight: width,
      opacity: 0.98,
      dashArray: "1 2.3",
      lineCap: "butt",
      lineJoin: "round",
      className: "map-dynamics-crossing-line map-dynamics-crossing-zebra-marking",
      interactive: true,
    },
  ];
}

function polygonStyle(kind: string, feature: MapDynamicsFeature, zoom: number): L.PathOptions | null {
  const common: L.PathOptions = { interactive: true, lineJoin: "round" };
  if (kind === "crossing") {
    const zebra = markedCrossing(feature);
    return {
      ...common,
      color: zebra ? "#334155" : "#64748b",
      weight: clamp(1 + (zoom - 15) * 0.25, 1, 2.4),
      opacity: 0.86,
      fillColor: zebra ? "#ffffff" : "#dbeafe",
      fillOpacity: zebra ? 0.82 : 0.5,
      dashArray: zebra ? "2 2" : "4 3",
      className: `map-dynamics-crossing-area ${zebra ? "map-dynamics-crossing-zebra" : "map-dynamics-crossing-unmarked"}`,
    };
  }
  if (kind === "sidewalk") {
    return {
      ...common,
      color: "#7f94aa",
      weight: clamp(1 + (zoom - 14) * 0.18, 1, 2.2),
      opacity: 0.72,
      fillColor: "#dce8f3",
      fillOpacity: 0.48,
      className: "map-dynamics-sidewalk-area",
    };
  }
  const colors: Record<string, string> = { road: "#d1b26f", pedestrian: "#9a8267", green: "#4aa96c", waterway: "#49aeca" };
  const color = colors[kind];
  return color ? { ...common, color, weight: 1, opacity: 0.55, fillColor: color, fillOpacity: 0.09 } : null;
}

function roadStyle(feature: MapDynamicsFeature, zoom: number): L.PathOptions | null {
  const highway = normalizedToken(feature.properties.highway);
  const hierarchy: Record<string, { color: string; width: number; minimumZoom: number }> = {
    motorway: { color: "#ef9f51", width: 4.4, minimumZoom: 5 },
    motorway_link: { color: "#f4b878", width: 2.8, minimumZoom: 7 },
    trunk: { color: "#eab94d", width: 4, minimumZoom: 7 },
    trunk_link: { color: "#f0cb77", width: 2.6, minimumZoom: 8 },
    primary: { color: "#e7c656", width: 3.5, minimumZoom: 9 },
    primary_link: { color: "#efda8e", width: 2.4, minimumZoom: 10 },
    secondary: { color: "#decf8a", width: 3, minimumZoom: 11 },
    secondary_link: { color: "#e8dfb4", width: 2.1, minimumZoom: 12 },
    tertiary: { color: "#c9c2a1", width: 2.5, minimumZoom: 12 },
    tertiary_link: { color: "#d8d2b8", width: 1.9, minimumZoom: 13 },
    residential: { color: "#94a3b8", width: 1.7, minimumZoom: 14 },
    unclassified: { color: "#94a3b8", width: 1.6, minimumZoom: 14 },
    living_street: { color: "#9aaec1", width: 1.55, minimumZoom: 15 },
    service: { color: "#a8b4c3", width: 1.2, minimumZoom: 15 },
    road: { color: "#9aa7b5", width: 1.35, minimumZoom: 15 },
    bus_guideway: { color: "#e76f6f", width: 2.3, minimumZoom: 12 },
    cycleway: { color: "#0d9488", width: 1.8, minimumZoom: 14 },
    pedestrian: { color: "#a98c6e", width: 1.6, minimumZoom: 15 },
    footway: { color: "#8fa7bd", width: 1.25, minimumZoom: 16 },
    path: { color: "#8fa7bd", width: 1.15, minimumZoom: 16 },
    steps: { color: "#8b735a", width: 1.35, minimumZoom: 16 },
    track: { color: "#aa8f6d", width: 1.25, minimumZoom: 15 },
    construction: { color: "#e39445", width: 1.8, minimumZoom: 13 },
    proposed: { color: "#aeb6c2", width: 1.35, minimumZoom: 14 },
  };
  const profile = hierarchy[highway] || { color: "#94a3b8", width: 1.35, minimumZoom: 15 };
  if (zoom < profile.minimumZoom) return null;
  const surface = normalizedToken(feature.properties.surface);
  const tunnel = normalizedToken(feature.properties.tunnel);
  const isTunnel = tunnel && !["no", "false", "0"].includes(tunnel);
  const dashed = highway === "construction" || highway === "proposed"
    || ["unpaved", "gravel", "dirt", "ground", "sand", "fine_gravel"].includes(surface);
  const dashArray = isTunnel ? "3 5" : highway === "steps" ? "2 3" : dashed ? "7 5" : undefined;
  return {
    color: profile.color,
    weight: profile.width * clamp(0.72 + (zoom - 10) * 0.055, 0.72, 1.35),
    opacity: isTunnel ? 0.58 : 0.8,
    dashArray,
    lineCap: "round",
    lineJoin: "round",
    className: `map-dynamics-network map-dynamics-road-network map-dynamics-road-${highway || "road"}`,
    interactive: true,
  };
}

function pedestrianStyle(kind: string, feature: MapDynamicsFeature, zoom: number): L.PathOptions | null {
  if (zoom < 14) return null;
  const mappedWidth = mappedDimension(feature, ["width", "sidewalkWidth"], 0);
  const width = clamp(1.5 + mappedWidth * 0.32 + (zoom - 14) * 0.1, 1.5, 5.5);
  if (kind === "cycleway") return { color: "#0d9488", weight: Math.max(2.2, width), opacity: 0.86, dashArray: "7 5", className: "map-dynamics-cycleway-line", interactive: true };
  if (kind === "median") return { color: "#4fbf83", weight: Math.max(2.4, width), opacity: 0.78, dashArray: "2 7", className: "map-dynamics-median-line", interactive: true };
  const structure = normalizedToken(feature.properties.pedestrianStructure || feature.properties.bridge);
  if (/jpo|footbridge|yes/.test(structure)) {
    return { color: "#715b43", weight: Math.max(3, width), opacity: 0.9, dashArray: "10 4", className: "map-dynamics-pedestrian-bridge-line", interactive: true };
  }
  return {
    color: kind === "sidewalk" ? "#8fa7bd" : "#9a8267",
    weight: Math.max(1.8, width),
    opacity: 0.8,
    dashArray: "4 5",
    className: kind === "sidewalk" ? "map-dynamics-sidewalk-line" : "map-dynamics-pedestrian-line",
    interactive: true,
  };
}

function transitStyle(feature: MapDynamicsFeature, zoom: number): L.PathOptions | null {
  if (zoom < 8) return null;
  const mode = normalizedToken(feature.properties.transitMode || feature.properties.mode || feature.properties.route || feature.properties.railway);
  const color = verifiedHexColor(feature.properties.colour || feature.properties.color) || TRANSIT_COLORS[mode] || "#2563eb";
  return { color, weight: clamp(2.3 + (zoom - 10) * 0.16, 2.3, 4.5), opacity: 0.9, lineCap: "round", className: "map-dynamics-network map-dynamics-transit-network", interactive: true };
}

function pointPictogram(kind: string): { definition: PointPictogram; fallback: boolean } {
  const aliases: Record<string, string> = {
    hydrant: "fire_hydrant",
    surveillance: "cctv",
    taxi: "taxi_stand",
    traffic_calming: "speed_bump",
  };
  const definition = POINT_PICTOGRAMS[kind] || POINT_PICTOGRAMS[aliases[kind]];
  if (definition) return { definition, fallback: false };
  return {
    fallback: true,
    definition: {
      accent: "#475569",
      markup: '<path d="M12 21s7-6 7-12A7 7 0 1 0 5 9c0 6 7 12 7 12Z"/><circle cx="12" cy="9" r="2"/>',
    },
  };
}

function pointSymbol(feature: MapDynamicsFeature, size: number, zoom: number): L.DivIcon {
  const kind = featureKind(feature);
  const kindToken = kind.replace(/[^a-z0-9_-]/g, "-").slice(0, 80) || "unknown";
  const label = escapeHtml(featureTitle(feature) || kind.replaceAll("_", " "));
  const { definition, fallback } = pointPictogram(kind);
  const width = Math.round(size * (definition.wide ? 1.2 : 1));
  const radius = definition.wide ? Math.max(4, Math.round(size * 0.3)) : Math.round(size * 0.32);
  const foreground = definition.light ? "#334155" : "#fff";
  const density = zoom >= 19 ? "detail" : zoom >= 17 ? "standard" : "compact";
  const symbol = `<span class="map-dynamics-point-symbol map-dynamics-point-symbol-${kindToken}${definition.light ? " is-light" : ""}${fallback ? " is-fallback" : ""}" data-map-dynamics-symbol="${kindToken}" data-map-dynamics-density="${density}" role="img" title="${label}" aria-label="${label}" style="--map-dynamics-accent:${definition.accent};width:${width}px;height:${size}px;border-radius:${radius}px;background:${definition.accent};color:${foreground};"><svg viewBox="0 0 24 24" width="${Math.max(10, width - 4)}" height="${Math.max(10, size - 4)}" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${definition.markup}</svg></span>`;
  return L.divIcon({
    className: `map-dynamics-point-icon map-dynamics-point-${kindToken} map-dynamics-point-${density}`,
    html: symbol,
    iconSize: [48, 48],
    iconAnchor: [24, 24],
  });
}

type PointRenderCandidate = {
  feature: MapDynamicsFeature;
  kind: string;
  point: L.LatLng;
  screen: L.Point;
  minimumZoom: number;
};

function stableFeatureKey(feature: MapDynamicsFeature): string {
  return cleanText(feature.id ?? feature.properties.sourceId ?? feature.properties.name, 240);
}

function pointClusterCellSize(zoom: number): number {
  if (zoom <= 9) return 72;
  if (zoom <= 12) return 62;
  if (zoom <= 15) return 50;
  if (zoom <= 17) return 38;
  if (zoom <= 18) return 27;
  return 14;
}

function pointClusterTitle(candidates: readonly PointRenderCandidate[]): string {
  const dominant = dominantPointCandidate(candidates);
  const dominantName = dominant
    ? featureTitle(dominant.feature) || dominant.kind.replaceAll("_", " ")
    : "Fitur peta";
  const names = candidates.map(({ feature }) => featureTitle(feature)).filter(Boolean);
  const details = [...new Set(names)].slice(0, 4);
  const more = names.length > details.length ? ` +${names.length - details.length}` : "";
  return [`${dominantName} mewakili ${candidates.length} fitur berdekatan`, `${details.join("; ")}${more}`]
    .filter(Boolean).join(" · ");
}

function dominantPointCandidate(candidates: readonly PointRenderCandidate[]): PointRenderCandidate | undefined {
  const counts = new Map<string, number>();
  candidates.forEach(({ kind }) => counts.set(kind, (counts.get(kind) || 0) + 1));
  return [...candidates].sort((left, right) => {
    const kindPriority = (POINT_PRIORITY[left.kind] ?? 50) - (POINT_PRIORITY[right.kind] ?? 50);
    if (kindPriority) return kindPriority;
    const countPriority = (counts.get(right.kind) || 0) - (counts.get(left.kind) || 0);
    return countPriority || stableFeatureKey(left.feature).localeCompare(stableFeatureKey(right.feature));
  })[0];
}

function pointClusterSymbol(candidates: readonly PointRenderCandidate[], zoom: number): L.DivIcon {
  const dominant = dominantPointCandidate(candidates);
  const dominantKind = dominant?.kind || "feature";
  const kindToken = dominantKind.replace(/[^a-z0-9_-]/g, "-").slice(0, 80) || "feature";
  const { definition, fallback } = pointPictogram(dominantKind);
  const title = escapeHtml(pointClusterTitle(candidates));
  const size = Math.round(clamp(18 + Math.log2(candidates.length) * 1.4 + (zoom - 10) * 0.2, 18, 27));
  const width = Math.round(size * (definition.wide ? 1.2 : 1));
  const radius = definition.wide ? Math.max(5, Math.round(size * 0.3)) : Math.round(size * 0.32);
  const foreground = definition.light ? "#334155" : "#fff";
  const html = `<span class="map-dynamics-cluster-badge map-dynamics-point-symbol-${kindToken}${fallback ? " is-fallback" : ""}" data-map-dynamics-cluster="${candidates.length}" data-map-dynamics-cluster-kind="${escapeHtml(dominantKind)}" data-map-dynamics-dominant-source="${escapeHtml(stableFeatureKey(dominant?.feature || candidates[0].feature))}" role="img" title="${title}" aria-label="${title}" style="--map-dynamics-accent:${definition.accent};width:${width}px;height:${size}px;border-radius:${radius}px;background:${definition.accent};color:${foreground};pointer-events:none"><svg viewBox="0 0 24 24" width="${Math.max(10, width - 4)}" height="${Math.max(10, size - 4)}" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${definition.markup}</svg></span>`;
  return L.divIcon({ className: "map-dynamics-cluster-icon", html, iconSize: [48, 48], iconAnchor: [24, 24] });
}

export class MapDynamicsLeafletRenderer {
  private readonly map: L.Map;
  private readonly loader: MapDynamicsLoaderLike;
  private readonly paneName: string;
  private readonly pointPaneName: string;
  private readonly rootLayer = L.layerGroup();
  private readonly vectorRenderer: L.SVG;
  private readonly options: Required<Omit<MapDynamicsRendererOptions, "manifestUrl" | "loader" | "onPublish" | "onPointClick">>
    & Pick<MapDynamicsRendererOptions, "onPublish" | "onPointClick">;
  private readonly ownsPane: boolean;
  private readonly ownsPointPane: boolean;
  private active = false;
  private disposed = false;
  private requestSequence = 0;
  private abortController: AbortController | null = null;
  private moveTimer = 0;
  private refreshTimer = 0;
  private inFlight: { key: string; promise: Promise<Readonly<MapDynamicsRendererStats>> } | null = null;
  private lastReadyAt = 0;
  private collection: MapDetailFeatureCollection = EMPTY_COLLECTION;
  private rendererStats: MapDynamicsRendererStats = { ...DEFAULT_STATS };

  constructor(map: L.Map, options: MapDynamicsRendererOptions = {}) {
    this.map = map;
    this.loader = options.loader || new MapDynamicsLoader(options.manifestUrl);
    this.paneName = options.paneName || "its-map-dynamics";
    this.pointPaneName = options.pointPaneName || `${this.paneName}-points`;
    const existingPane = map.getPane(this.paneName);
    this.ownsPane = !existingPane;
    const pane = existingPane || map.createPane(this.paneName);
    pane.style.zIndex = String(options.paneZIndex ?? 425);
    pane.style.pointerEvents = "none";
    pane.dataset.mapDynamicsPane = "verified-only";
    pane.setAttribute("aria-hidden", "true");
    const existingPointPane = map.getPane(this.pointPaneName);
    this.ownsPointPane = !existingPointPane;
    const pointPane = existingPointPane || map.createPane(this.pointPaneName);
    pointPane.style.zIndex = String(options.pointPaneZIndex ?? 620);
    pointPane.style.pointerEvents = "none";
    pointPane.dataset.mapDynamicsPointPane = "dominant-symbols";
    this.vectorRenderer = L.svg({ pane: this.paneName, padding: 0.22 });
    this.options = {
      paneName: this.paneName,
      paneZIndex: options.paneZIndex ?? 425,
      pointPaneName: this.pointPaneName,
      pointPaneZIndex: options.pointPaneZIndex ?? 620,
      minimumZoom: options.minimumZoom ?? 5,
      maximumZoom: options.maximumZoom ?? 22,
      pointMinimumZoom: options.pointMinimumZoom ?? 15,
      maximumFeatures: options.maximumFeatures ?? 8_000,
      moveDebounceMs: options.moveDebounceMs ?? 180,
      // View changes still refresh immediately; the idle poll is deliberately
      // conservative so public visitors do not exhaust the Workers Free daily
      // request allowance simply by leaving the map open.
      refreshIntervalMs: options.refreshIntervalMs ?? 5 * 60_000,
      minimumSameViewportAgeMs: options.minimumSameViewportAgeMs ?? 8_000,
      autoStart: options.autoStart ?? true,
      onPublish: options.onPublish,
      onPointClick: options.onPointClick,
    };
    if (this.options.autoStart) this.start();
  }

  get currentCollection(): MapDetailFeatureCollection {
    return { type: "FeatureCollection", features: [...this.collection.features] };
  }

  get currentStats(): Readonly<MapDynamicsRendererStats> {
    return { ...this.rendererStats, byKind: { ...this.rendererStats.byKind } };
  }

  start(): void {
    if (this.disposed || this.active) return;
    this.active = true;
    if (!this.map.hasLayer(this.rootLayer)) this.rootLayer.addTo(this.map);
    this.map.on("moveend zoomend resize", this.scheduleViewportRefresh, this);
    void this.refresh();
  }

  private scheduleViewportRefresh(): void {
    if (!this.active || this.disposed) return;
    window.clearTimeout(this.moveTimer);
    this.moveTimer = window.setTimeout(() => void this.refresh(), this.options.moveDebounceMs);
  }

  private schedulePeriodicRefresh(): void {
    window.clearTimeout(this.refreshTimer);
    if (!this.active || this.options.refreshIntervalMs <= 0) return;
    this.refreshTimer = window.setTimeout(() => void this.refresh(true), this.options.refreshIntervalMs);
  }

  async refresh(force = false): Promise<Readonly<MapDynamicsRendererStats>> {
    if (this.disposed) return this.currentStats;
    const zoom = this.map.getZoom();
    const bounds = viewportBounds(this.map);
    const key = viewportKey(bounds, zoom);
    if (zoom < this.options.minimumZoom || zoom > this.options.maximumZoom) {
      this.abortController?.abort();
      this.rootLayer.clearLayers();
      this.collection = EMPTY_COLLECTION;
      this.rendererStats = { ...DEFAULT_STATS, status: "out-of-range", viewportKey: key, zoom, finishedAt: Date.now() };
      return this.currentStats;
    }
    if (!force && this.inFlight?.key === key) return this.inFlight.promise;
    if (!force && this.rendererStats.status === "ready" && this.rendererStats.viewportKey === key
      && Date.now() - this.lastReadyAt < this.options.minimumSameViewportAgeMs) return this.currentStats;

    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    const requestId = ++this.requestSequence;
    const startedAt = Date.now();
    this.rendererStats = { ...this.rendererStats, status: "loading", requestId, viewportKey: key, zoom, startedAt, error: "" };

    const promise = this.performRefresh(bounds, zoom, key, requestId, startedAt, controller.signal);
    this.inFlight = { key, promise };
    try {
      return await promise;
    } finally {
      if (this.inFlight?.promise === promise) this.inFlight = null;
    }
  }

  private async performRefresh(
    bounds: MapDynamicsBounds,
    zoom: number,
    key: string,
    requestId: number,
    startedAt: number,
    signal: AbortSignal,
  ): Promise<Readonly<MapDynamicsRendererStats>> {
    try {
      const result = await this.loader.load(bounds, zoom, signal);
      if (signal.aborted || this.disposed || requestId !== this.requestSequence) return this.currentStats;
      const selection = selectVerifiedMapDynamics(result.collection, bounds, this.options.maximumFeatures);
      const rendered = this.renderCollection(selection.collection, zoom);
      if (signal.aborted || this.disposed || requestId !== this.requestSequence) return this.currentStats;

      this.rootLayer.clearLayers();
      rendered.group.getLayers().forEach((layer) => this.rootLayer.addLayer(layer));
      this.collection = rendered.collection;
      this.lastReadyAt = Date.now();
      this.rendererStats = {
        ...selection.stats,
        status: "ready",
        requestId,
        viewportKey: key,
        zoom,
        manifestVersion: result.manifestVersion,
        selectedShards: result.selectedShards,
        loadedShards: result.loadedShards,
        remoteDeltas: result.remoteDeltas,
        renderedFeatures: rendered.collection.features.length,
        renderedLayers: rendered.layers,
        collisionSkipped: rendered.collisionSkipped,
        clusterMarkers: rendered.clusterMarkers,
        clusteredPoints: rendered.clusteredPoints,
        generalizedPoints: rendered.generalizedPoints,
        unsupported: rendered.unsupported,
        source: result.source,
        byKind: rendered.byKind,
        startedAt,
        finishedAt: this.lastReadyAt,
        error: "",
      };
      const container = this.map.getContainer();
      container.dataset.mapDynamicsFeatures = String(this.rendererStats.renderedFeatures);
      container.dataset.mapDynamicsVersion = result.manifestVersion;
      container.dataset.mapDynamicsClusters = String(this.rendererStats.clusterMarkers);
      container.dataset.mapDynamicsClusteredPoints = String(this.rendererStats.clusteredPoints);
      container.dataset.mapDynamicsGeneralizedPoints = String(this.rendererStats.generalizedPoints);
      this.options.onPublish?.(this.currentCollection, this.currentStats);
      container.dispatchEvent(new CustomEvent("its:map-dynamics-published", {
        detail: { collection: this.currentCollection, stats: this.currentStats },
      }));
      this.schedulePeriodicRefresh();
      return this.currentStats;
    } catch (error) {
      if (signal.aborted || this.disposed || requestId !== this.requestSequence) return this.currentStats;
      this.rendererStats = {
        ...this.rendererStats,
        status: "error",
        requestId,
        viewportKey: key,
        zoom,
        startedAt,
        finishedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
      this.schedulePeriodicRefresh();
      return this.currentStats;
    }
  }

  private renderCollection(collection: MapDetailFeatureCollection, zoom: number): {
    group: L.LayerGroup;
    collection: MapDetailFeatureCollection;
    layers: number;
    collisionSkipped: number;
    clusterMarkers: number;
    clusteredPoints: number;
    generalizedPoints: number;
    unsupported: number;
    byKind: Record<string, number>;
  } {
    const group = L.layerGroup();
    const published: MapDynamicsFeature[] = [];
    const byKind: Record<string, number> = {};
    const pointCandidates: PointRenderCandidate[] = [];
    let layers = 0;
    let collisionSkipped = 0;
    let clusterMarkers = 0;
    let clusteredPoints = 0;
    let generalizedPoints = 0;
    let unsupported = 0;
    const publishFeature = (feature: MapDynamicsFeature) => {
      const kind = featureKind(feature);
      published.push(feature);
      byKind[kind] = (byKind[kind] || 0) + 1;
    };
    const sorted = [...collection.features].sort((left, right) => {
      const priority = featurePriority(left) - featurePriority(right);
      if (priority) return priority;
      const pointPriority = (POINT_PRIORITY[featureKind(left)] ?? 50) - (POINT_PRIORITY[featureKind(right)] ?? 50);
      return pointPriority || stableFeatureKey(left).localeCompare(stableFeatureKey(right));
    });

    sorted.forEach((feature) => {
      const kind = featureKind(feature);
      if (feature.geometry.type === "Point") {
        const point = pointCoordinate(feature);
        if (!point) { unsupported += 1; return; }
        pointCandidates.push({
          feature,
          kind,
          point,
          screen: this.map.latLngToContainerPoint(point),
          minimumZoom: Math.max(this.options.pointMinimumZoom, POINT_MINIMUM_ZOOM[kind] ?? 17),
        });
        return;
      }
      let added = 0;
      if (feature.geometry.type === "LineString") {
        const points = lineCoordinates(feature);
        if (!points) { unsupported += 1; return; }
        if (kind === "crossing") {
          crossingLineStyles(feature, zoom).forEach((style) => {
            const layer = L.polyline(points, {
              ...style,
              pane: this.paneName,
              renderer: this.vectorRenderer,
              smoothFactor: 0.35,
            });
            bindFeatureTooltip(layer, feature).addTo(group);
            added += 1;
          });
        }
        let style: L.PathOptions | null = null;
        if (kind === "road") style = roadStyle(feature, zoom);
        else if (["sidewalk", "median", "cycleway", "pedestrian"].includes(kind)) style = pedestrianStyle(kind, feature, zoom);
        else if (kind === "waterway" || kind === "drain") {
          style = { color: "#49aeca", weight: clamp(1.7 + (zoom - 10) * 0.14, 1.2, 4.2), opacity: 0.82, lineCap: "round", className: "map-dynamics-network map-dynamics-waterway-network", interactive: true };
        } else if (kind === "railway") {
          style = { color: "#475569", weight: clamp(1.5 + (zoom - 10) * 0.11, 1.1, 3.4), opacity: 0.84, dashArray: "7 5", className: "map-dynamics-network map-dynamics-railway-network", interactive: true };
        } else if (kind === "transit") style = transitStyle(feature, zoom);
        else if (["guardrail", "barrier", "retaining_wall", "seawall", "stop_line", "yield_line", "lane_arrow", "tree_row"].includes(kind)) {
          const colors: Record<string, string> = {
            guardrail: "#64748b", barrier: "#6b7280", retaining_wall: "#8b6f55", seawall: "#477d95",
            stop_line: "#ffffff", yield_line: "#f8fafc", lane_arrow: "#f8fafc", tree_row: "#239b58",
          };
          style = {
            color: colors[kind] || "#64748b",
            weight: clamp(1.4 + (zoom - 14) * 0.18, 1.2, 3.5),
            opacity: 0.8,
            dashArray: kind === "guardrail" ? "2 3" : kind === "barrier" ? "5 3" : kind === "tree_row" ? "1 4" : undefined,
            className: `map-dynamics-linear-detail map-dynamics-${kind}-line`,
            interactive: true,
          };
        }
        if (style) {
          const network = ["road", "waterway", "drain", "railway", "transit"].includes(kind);
          const layer = L.polyline(points, {
            ...style,
            pane: this.paneName,
            renderer: this.vectorRenderer,
            smoothFactor: network ? networkSmoothFactor(zoom) : 0.55,
          });
          bindFeatureTooltip(layer, feature).addTo(group);
          added += 1;
        }
      } else if (feature.geometry.type === "Polygon") {
        const rings = polygonCoordinates(feature);
        if (!rings) { unsupported += 1; return; }
        const style = polygonStyle(kind, feature, zoom);
        if (style) {
          const layer = L.polygon(rings, { ...style, pane: this.paneName, renderer: this.vectorRenderer, smoothFactor: networkSmoothFactor(zoom) });
          bindFeatureTooltip(layer, feature).addTo(group);
          added = 1;
        }
      }
      if (!added) {
        unsupported += 1;
        return;
      }
      publishFeature(feature);
      layers += added;
    });

    const cellSize = pointClusterCellSize(zoom);
    const pointBuckets = new Map<string, PointRenderCandidate[]>();
    pointCandidates
      .sort((left, right) => stableFeatureKey(left.feature).localeCompare(stableFeatureKey(right.feature)))
      .forEach((candidate) => {
        if (zoom < candidate.minimumZoom) {
          generalizedPoints += 1;
          collisionSkipped += 1;
          return;
        }
        const key = `${Math.floor(candidate.screen.x / cellSize)}:${Math.floor(candidate.screen.y / cellSize)}`;
        const bucket = pointBuckets.get(key) || [];
        bucket.push(candidate);
        pointBuckets.set(key, bucket);
      });

    [...pointBuckets.entries()].sort(([left], [right]) => left.localeCompare(right)).forEach(([, candidates]) => {
      if (candidates.length >= 2) {
        // Anchor the representative at the actual dominant source instead of
        // an invented centroid. The count remains available to assistive text
        // and diagnostics, but the map displays one meaningful pictogram.
        const dominant = dominantPointCandidate(candidates) || candidates[0];
        const latlng = dominant.point;
        const title = pointClusterTitle(candidates);
        const marker = L.marker(latlng, {
          pane: this.pointPaneName,
          icon: pointClusterSymbol(candidates, zoom),
          interactive: true,
          keyboard: false,
          riseOnHover: true,
          title,
          alt: title,
        });
        marker.bindTooltip(escapeHtml(title), { direction: "top", sticky: true, opacity: 0.94 }).addTo(group);
        marker.on("click", () => this.options.onPointClick?.(dominant.feature, dominant.point));
        candidates.forEach(({ feature }) => publishFeature(feature));
        clusterMarkers += 1;
        clusteredPoints += candidates.length;
        layers += 1;
        return;
      }

      const candidate = candidates[0];
      if (!candidate) return;
      const size = Math.round(clamp(14 + (zoom - 15) * 1.05, 14, 21));
      const title = featureTitle(candidate.feature) || candidate.kind.replaceAll("_", " ");
      const marker = L.marker(candidate.point, {
        pane: this.pointPaneName,
        icon: pointSymbol(candidate.feature, size, zoom),
        interactive: true,
        keyboard: false,
        riseOnHover: true,
        title,
        alt: title,
      });
      bindFeatureTooltip(marker, candidate.feature).addTo(group);
      marker.on("click", () => this.options.onPointClick?.(candidate.feature, candidate.point));
      publishFeature(candidate.feature);
      layers += 1;
    });
    return {
      group,
      collection: { type: "FeatureCollection", features: published },
      layers,
      collisionSkipped,
      clusterMarkers,
      clusteredPoints,
      generalizedPoints,
      unsupported,
      byKind,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.requestSequence += 1;
    this.abortController?.abort();
    this.abortController = null;
    window.clearTimeout(this.moveTimer);
    window.clearTimeout(this.refreshTimer);
    this.map.off("moveend zoomend resize", this.scheduleViewportRefresh, this);
    this.rootLayer.clearLayers();
    if (this.map.hasLayer(this.rootLayer)) this.map.removeLayer(this.rootLayer);
    if (this.map.hasLayer(this.vectorRenderer)) this.map.removeLayer(this.vectorRenderer);
    const container = this.map.getContainer();
    delete container.dataset.mapDynamicsFeatures;
    delete container.dataset.mapDynamicsVersion;
    delete container.dataset.mapDynamicsClusters;
    delete container.dataset.mapDynamicsClusteredPoints;
    delete container.dataset.mapDynamicsGeneralizedPoints;
    if (this.ownsPane) this.map.getPane(this.paneName)?.remove();
    if (this.ownsPointPane) this.map.getPane(this.pointPaneName)?.remove();
    this.collection = EMPTY_COLLECTION;
    this.rendererStats = { ...DEFAULT_STATS, status: "disposed", requestId: this.requestSequence, finishedAt: Date.now() };
  }
}
