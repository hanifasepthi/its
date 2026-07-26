import {
  bearerToken,
  cleanText,
  constantTimeTextEqual,
  enforceRateLimit,
  HttpError,
  json,
  readJson,
  sha256Hex,
} from "./http";
import { publishedFeaturesFromRecord, type PublishedMapFeature } from "./mapDataPublic";
import type { Env } from "./types";

const MAP_SCHEMA_VERSION = "its-map-data-v1";
const MANIFEST_KEY = "map:v1:verified:manifest";
const VERIFIED_PREFIX = "map:v1:verified:record:";
const INDEX_PREFIX = "map:v1:verified:index:";
const OBSERVATION_PREFIX = "map:v1:quarantine:observation:";
const OBSERVATION_NONCE_PREFIX = "map:v1:quarantine:nonce:";

const DEFAULT_INDEX_ZOOM = 8;
const MIN_DATA_TILE_ZOOM = 8;
const MAX_DATA_TILE_ZOOM = 18;
const MAX_VERIFIED_BODY_BYTES = 786_432;
const MAX_KV_DELTA_BYTES = 131_072;
const MAX_OBSERVATION_BODY_BYTES = 131_072;
const MAX_DELTA_FEATURES = 320;
const MAX_SHARD_FEATURES = 1_200;
const MAX_OBSERVATIONS = 160;
const MAX_VERTICES_PER_DELTA = 20_000;
const MAX_VERTICES_PER_SHARD = 80_000;
const MAX_VERTICES_PER_OBSERVATION_BATCH = 6_000;
const MAX_FEATURE_BYTES = 40_960;
const MAX_PUBLIC_RECORDS = 12;
const MAX_PUBLIC_FEATURES = 3_200;
const MAX_PUBLIC_RESPONSE_BYTES = 1_048_576;
const MAX_INDEX_BUCKETS_PER_RECORD = 4;
const MAX_INDEX_BUCKETS_PER_VIEWPORT = 24;
const MAX_INDEX_ENTRIES_PER_BUCKET = 480;
const MAX_VIEWPORT_LONGITUDE_SPAN = 4;
const MAX_VIEWPORT_LATITUDE_SPAN = 4;
const INDONESIA_DATA_BOUNDS: Bbox = [92, -15, 145, 10];

const MAP_DATASETS = new Set([
  "roads",
  "railways",
  "transit",
  "waterways",
  "pedestrian",
  "ornaments",
  "poi",
  "landcover",
]);

const PROVENANCE_METHODS = new Set([
  "official-import",
  "manual-review",
  "reviewed-cv",
  "community-reviewed",
]);

const OBSERVATION_KINDS = new Set([
  "road_candidate",
  "sidewalk_candidate",
  "vegetation_candidate",
  "water_candidate",
  "building_candidate",
  "crossing_candidate",
  "ornament_candidate",
  "poi_candidate",
]);

type Bbox = [number, number, number, number];

type TileAddress = {
  z: number;
  x: number;
  y: number;
};

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type GeometryType = "Point" | "MultiPoint" | "LineString" | "MultiLineString" | "Polygon" | "MultiPolygon";

type MapGeometry = {
  type: GeometryType;
  coordinates: JsonValue;
};

type MapFeature = {
  type: "Feature";
  id: string;
  properties: JsonObject;
  geometry: MapGeometry | null;
};

type MapRecordKind = "shard" | "delta";

type MapProvenance = {
  source: string;
  sourceUrl?: string;
  license: string;
  capturedAt: string;
  verifiedAt: string;
  verifiedBy: string;
  method: "official-import" | "manual-review" | "reviewed-cv" | "community-reviewed";
  sourceChecksum?: string;
  observationBatchIds: string[];
};

type VerifiedMapRecord = {
  schemaVersion: typeof MAP_SCHEMA_VERSION;
  kind: MapRecordKind;
  id: string;
  dataset: string;
  revision: number;
  tile: TileAddress;
  bbox: Bbox;
  generatedAt: string;
  storedAt: string;
  provenance: MapProvenance;
  features: MapFeature[];
  featureCount: number;
  vertexCount: number;
  checksum: string;
  bytes: number;
  storageKey: string;
  indexBuckets: string[];
  storage: "kv" | "r2";
  objectKey?: string;
};

type MapIndexEntry = {
  storageKey: string;
  id: string;
  kind: MapRecordKind;
  dataset: string;
  revision: number;
  bbox: Bbox;
  tile: TileAddress;
  featureCount: number;
  bytes: number;
  checksum: string;
  updatedAt: string;
  storage: "kv" | "r2";
  objectKey?: string;
};

type MapIndexBucket = {
  schemaVersion: typeof MAP_SCHEMA_VERSION;
  indexZoom: number;
  updatedAt: string;
  entries: MapIndexEntry[];
};

type DatasetManifestStats = {
  records: number;
  features: number;
  bytes: number;
};

type PublicMapManifest = {
  schemaVersion: typeof MAP_SCHEMA_VERSION;
  indexZoom: number;
  revision: number;
  updatedAt: string | null;
  verifiedRecords: number;
  verifiedShards: number;
  verifiedDeltas: number;
  verifiedFeatures: number;
  verifiedBytes: number;
  datasets: Record<string, DatasetManifestStats>;
  latest: Array<{
    storageKey: string;
    id: string;
    kind: MapRecordKind;
    dataset: string;
    revision: number;
    bbox: Bbox;
    tile: TileAddress;
    featureCount: number;
    checksum: string;
    updatedAt: string;
  }>;
};

type GeometryStats = {
  vertices: number;
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
};

type ObservationBatchRecord = {
  schemaVersion: typeof MAP_SCHEMA_VERSION;
  batchId: string;
  tile: TileAddress;
  bbox: Bbox;
  capturedAt: string;
  receivedAt: string;
  expiresAt: string;
  reviewState: "quarantined";
  published: false;
  source: {
    producer: string;
    model: string;
    modelVersion: string;
    imagery: string;
    imageryLicense: string;
    sourceUrl?: string;
    deviceIdHash?: string;
  };
  observations: Array<{
    id: string;
    kind: string;
    score: number;
    geometry: MapGeometry;
    attributes: JsonObject;
  }>;
  observationCount: number;
  vertexCount: number;
  checksum: string;
};

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_map_schema", `${label} harus berupa object.`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new HttpError(400, "invalid_map_schema", `${label} harus berupa array.`);
  return value;
}

function strictText(value: unknown, label: string, maximum: number, minimum = 1): string {
  const text = cleanText(value, maximum + 1);
  if (text.length < minimum || text.length > maximum) {
    throw new HttpError(400, "invalid_map_schema", `${label} harus ${minimum}-${maximum} karakter.`);
  }
  return text;
}

function safeId(value: unknown, label: string): string {
  const id = strictText(value, label, 96, 3);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw new HttpError(400, "invalid_map_id", `${label} hanya boleh berisi huruf, angka, titik, garis bawah, titik dua, dan tanda hubung.`);
  }
  return id;
}

function finiteNumber(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new HttpError(400, "invalid_map_schema", `${label} harus berupa angka hingga.`);
  return parsed;
}

function integerInRange(value: unknown, label: string, minimum: number, maximum: number): number {
  const parsed = finiteNumber(value, label);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, "invalid_map_schema", `${label} harus bilangan bulat ${minimum}-${maximum}.`);
  }
  return parsed;
}

function isoTimestamp(value: unknown, label: string, allowFutureMinutes = 10): string {
  const raw = strictText(value, label, 48, 10);
  const timestamp = Date.parse(raw);
  const earliest = Date.UTC(2000, 0, 1);
  if (!Number.isFinite(timestamp) || timestamp < earliest || timestamp > Date.now() + allowFutureMinutes * 60_000) {
    throw new HttpError(400, "invalid_map_timestamp", `${label} bukan timestamp ISO yang valid.`);
  }
  return new Date(timestamp).toISOString();
}

function optionalHttpsUrl(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = strictText(value, label, 512, 8);
  try {
    const url = new URL(text);
    if (url.protocol !== "https:") throw new Error("https required");
    return url.toString();
  } catch {
    throw new HttpError(400, "invalid_map_url", `${label} harus URL HTTPS yang valid.`);
  }
}

function parseTile(value: unknown, label = "tile"): TileAddress {
  const input = objectValue(value, label);
  const z = integerInRange(input.z, `${label}.z`, MIN_DATA_TILE_ZOOM, MAX_DATA_TILE_ZOOM);
  const maximum = 2 ** z - 1;
  return {
    z,
    x: integerInRange(input.x, `${label}.x`, 0, maximum),
    y: integerInRange(input.y, `${label}.y`, 0, maximum),
  };
}

function parseTileQuery(raw: string): TileAddress {
  const match = raw.match(/^(\d{1,2})\/(\d{1,8})\/(\d{1,8})$/);
  if (!match) throw new HttpError(400, "invalid_tile", "Parameter tile harus berbentuk z/x/y.");
  return parseTile({ z: Number(match[1]), x: Number(match[2]), y: Number(match[3]) });
}

function parseBbox(value: unknown, label = "bbox"): Bbox {
  const input = arrayValue(value, label);
  if (input.length !== 4) throw new HttpError(400, "invalid_bbox", `${label} harus [minLng,minLat,maxLng,maxLat].`);
  const bbox: Bbox = [
    finiteNumber(input[0], `${label}[0]`),
    finiteNumber(input[1], `${label}[1]`),
    finiteNumber(input[2], `${label}[2]`),
    finiteNumber(input[3], `${label}[3]`),
  ];
  if (bbox[0] < -180 || bbox[2] > 180 || bbox[1] < -85.051129 || bbox[3] > 85.051129 || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
    throw new HttpError(400, "invalid_bbox", `${label} berada di luar rentang Web Mercator atau urutannya salah.`);
  }
  return bbox;
}

function bboxIntersects(left: Bbox, right: Bbox): boolean {
  return left[0] <= right[2] && left[2] >= right[0] && left[1] <= right[3] && left[3] >= right[1];
}

function bboxContained(inner: Bbox, outer: Bbox, tolerance = 0): boolean {
  return inner[0] >= outer[0] - tolerance
    && inner[1] >= outer[1] - tolerance
    && inner[2] <= outer[2] + tolerance
    && inner[3] <= outer[3] + tolerance;
}

function latitudeForTileY(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / (2 ** zoom);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

function tileBbox(tile: TileAddress): Bbox {
  const scale = 2 ** tile.z;
  return [
    (tile.x / scale) * 360 - 180,
    latitudeForTileY(tile.y + 1, tile.z),
    ((tile.x + 1) / scale) * 360 - 180,
    latitudeForTileY(tile.y, tile.z),
  ];
}

function tileXForLongitude(longitude: number, zoom: number): number {
  const scale = 2 ** zoom;
  return Math.max(0, Math.min(scale - 1, Math.floor(((longitude + 180) / 360) * scale)));
}

function tileYForLatitude(latitude: number, zoom: number): number {
  const scale = 2 ** zoom;
  const radians = Math.max(-85.05112878, Math.min(85.05112878, latitude)) * Math.PI / 180;
  const value = (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * scale;
  return Math.max(0, Math.min(scale - 1, Math.floor(value)));
}

function spatialIndexKeys(bbox: Bbox, indexZoom: number): string[] {
  const minX = tileXForLongitude(bbox[0], indexZoom);
  const maxX = tileXForLongitude(bbox[2] - 1e-10, indexZoom);
  const minY = tileYForLatitude(bbox[3], indexZoom);
  const maxY = tileYForLatitude(bbox[1] + 1e-10, indexZoom);
  const keys: string[] = [];
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) keys.push(`${INDEX_PREFIX}${indexZoom}/${x}/${y}`);
  }
  return keys;
}

function emptyGeometryStats(): GeometryStats {
  return {
    vertices: 0,
    minLng: Number.POSITIVE_INFINITY,
    minLat: Number.POSITIVE_INFINITY,
    maxLng: Number.NEGATIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY,
  };
}

function normalizePosition(value: unknown, label: string, stats: GeometryStats): JsonValue {
  const position = arrayValue(value, label);
  if (position.length < 2 || position.length > 3) {
    throw new HttpError(400, "invalid_geometry", `${label} harus [lng,lat] atau [lng,lat,elevasi].`);
  }
  const lng = finiteNumber(position[0], `${label}[0]`);
  const lat = finiteNumber(position[1], `${label}[1]`);
  if (lng < -180 || lng > 180 || lat < -85.051129 || lat > 85.051129) {
    throw new HttpError(400, "invalid_geometry", `${label} berada di luar Web Mercator.`);
  }
  stats.vertices += 1;
  stats.minLng = Math.min(stats.minLng, lng);
  stats.minLat = Math.min(stats.minLat, lat);
  stats.maxLng = Math.max(stats.maxLng, lng);
  stats.maxLat = Math.max(stats.maxLat, lat);
  if (position.length === 3) return [lng, lat, finiteNumber(position[2], `${label}[2]`)];
  return [lng, lat];
}

function normalizeLine(value: unknown, label: string, stats: GeometryStats, minimum = 2): JsonValue[] {
  const line = arrayValue(value, label);
  if (line.length < minimum) throw new HttpError(400, "invalid_geometry", `${label} membutuhkan minimal ${minimum} posisi.`);
  return line.map((position, index) => normalizePosition(position, `${label}[${index}]`, stats));
}

function positionsEqual(left: JsonValue, right: JsonValue): boolean {
  return Array.isArray(left) && Array.isArray(right) && left[0] === right[0] && left[1] === right[1];
}

function normalizeRing(value: unknown, label: string, stats: GeometryStats): JsonValue[] {
  const ring = normalizeLine(value, label, stats, 4);
  if (!positionsEqual(ring[0], ring[ring.length - 1])) {
    throw new HttpError(400, "invalid_geometry", `${label} harus tertutup.`);
  }
  return ring;
}

function normalizeGeometry(value: unknown, label: string, stats: GeometryStats): MapGeometry {
  const input = objectValue(value, label);
  const type = strictText(input.type, `${label}.type`, 24) as GeometryType;
  const coordinates = input.coordinates;
  if (type === "Point") return { type, coordinates: normalizePosition(coordinates, `${label}.coordinates`, stats) };
  if (type === "MultiPoint") {
    const points = arrayValue(coordinates, `${label}.coordinates`);
    if (!points.length) throw new HttpError(400, "invalid_geometry", `${label} tidak boleh kosong.`);
    return { type, coordinates: points.map((point, index) => normalizePosition(point, `${label}.coordinates[${index}]`, stats)) };
  }
  if (type === "LineString") return { type, coordinates: normalizeLine(coordinates, `${label}.coordinates`, stats) };
  if (type === "MultiLineString") {
    const lines = arrayValue(coordinates, `${label}.coordinates`);
    if (!lines.length) throw new HttpError(400, "invalid_geometry", `${label} tidak boleh kosong.`);
    return { type, coordinates: lines.map((line, index) => normalizeLine(line, `${label}.coordinates[${index}]`, stats)) };
  }
  if (type === "Polygon") {
    const rings = arrayValue(coordinates, `${label}.coordinates`);
    if (!rings.length) throw new HttpError(400, "invalid_geometry", `${label} tidak boleh kosong.`);
    return { type, coordinates: rings.map((ring, index) => normalizeRing(ring, `${label}.coordinates[${index}]`, stats)) };
  }
  if (type === "MultiPolygon") {
    const polygons = arrayValue(coordinates, `${label}.coordinates`);
    if (!polygons.length) throw new HttpError(400, "invalid_geometry", `${label} tidak boleh kosong.`);
    return {
      type,
      coordinates: polygons.map((polygon, polygonIndex) => {
        const rings = arrayValue(polygon, `${label}.coordinates[${polygonIndex}]`);
        if (!rings.length) throw new HttpError(400, "invalid_geometry", `${label}.coordinates[${polygonIndex}] tidak boleh kosong.`);
        return rings.map((ring, ringIndex) => normalizeRing(ring, `${label}.coordinates[${polygonIndex}][${ringIndex}]`, stats));
      }),
    };
  }
  throw new HttpError(400, "unsupported_geometry", `${label}.type tidak didukung.`);
}

function normalizeJsonValue(value: unknown, label: string, depth = 0): JsonValue {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new HttpError(400, "invalid_map_properties", `${label} berisi angka tidak hingga.`);
    return value;
  }
  if (typeof value === "string") return strictText(value, label, 512, 0);
  if (depth >= 4) throw new HttpError(400, "invalid_map_properties", `${label} terlalu dalam.`);
  if (Array.isArray(value)) {
    if (value.length > 32) throw new HttpError(400, "invalid_map_properties", `${label} memiliki terlalu banyak elemen.`);
    return value.map((item, index) => normalizeJsonValue(item, `${label}[${index}]`, depth + 1));
  }
  const input = objectValue(value, label);
  const entries = Object.entries(input);
  if (entries.length > 64) throw new HttpError(400, "invalid_map_properties", `${label} memiliki terlalu banyak properti.`);
  const output: JsonObject = {};
  entries.forEach(([rawKey, item]) => {
    const key = strictText(rawKey, `${label}.key`, 80);
    if (/^(?:__proto__|prototype|constructor)$/i.test(key)) {
      throw new HttpError(400, "invalid_map_properties", `${label} memakai nama properti terlarang.`);
    }
    output[key] = normalizeJsonValue(item, `${label}.${key}`, depth + 1);
  });
  return output;
}

function geometryBbox(stats: GeometryStats): Bbox {
  return [stats.minLng, stats.minLat, stats.maxLng, stats.maxLat];
}

function normalizeFeature(
  value: unknown,
  index: number,
  kind: MapRecordKind,
  recordBbox: Bbox,
  totalStats: GeometryStats,
): MapFeature {
  const input = objectValue(value, `features[${index}]`);
  if (input.type !== "Feature") throw new HttpError(400, "invalid_feature", `features[${index}].type harus Feature.`);
  const id = safeId(input.id, `features[${index}].id`);
  const propertiesValue = normalizeJsonValue(input.properties || {}, `features[${index}].properties`);
  if (!propertiesValue || Array.isArray(propertiesValue) || typeof propertiesValue !== "object") {
    throw new HttpError(400, "invalid_feature", `features[${index}].properties harus object.`);
  }
  const properties = propertiesValue as JsonObject;
  const operation = String(properties.operation || "upsert").toLowerCase();
  if (kind === "shard" && operation !== "upsert") {
    throw new HttpError(400, "invalid_feature_operation", "Shard hanya menerima feature upsert.");
  }
  if (kind === "delta" && operation !== "upsert" && operation !== "delete") {
    throw new HttpError(400, "invalid_feature_operation", "Delta hanya menerima operation upsert atau delete.");
  }
  properties.operation = operation;

  let geometry: MapGeometry | null = null;
  if (input.geometry !== null && input.geometry !== undefined) {
    const featureStats = emptyGeometryStats();
    geometry = normalizeGeometry(input.geometry, `features[${index}].geometry`, featureStats);
    if (!bboxContained(geometryBbox(featureStats), recordBbox, 1e-7)) {
      throw new HttpError(400, "geometry_outside_bbox", `features[${index}] berada di luar bbox record.`);
    }
    totalStats.vertices += featureStats.vertices;
    totalStats.minLng = Math.min(totalStats.minLng, featureStats.minLng);
    totalStats.minLat = Math.min(totalStats.minLat, featureStats.minLat);
    totalStats.maxLng = Math.max(totalStats.maxLng, featureStats.maxLng);
    totalStats.maxLat = Math.max(totalStats.maxLat, featureStats.maxLat);
  } else if (operation !== "delete") {
    throw new HttpError(400, "geometry_required", `features[${index}].geometry wajib untuk upsert.`);
  }

  const feature: MapFeature = { type: "Feature", id, properties, geometry };
  if (byteLength(JSON.stringify(feature)) > MAX_FEATURE_BYTES) {
    throw new HttpError(413, "feature_too_large", `features[${index}] terlalu besar.`);
  }
  return feature;
}

function indexZoom(env: Env): number {
  const parsed = Number(env.MAP_DATA_INDEX_ZOOM || DEFAULT_INDEX_ZOOM);
  return Number.isInteger(parsed) && parsed >= 6 && parsed <= 10 ? parsed : DEFAULT_INDEX_ZOOM;
}

function publicCacheSeconds(env: Env): number {
  const parsed = Number(env.MAP_PUBLIC_CACHE_SECONDS || 60);
  return Number.isFinite(parsed) ? Math.max(15, Math.min(300, Math.floor(parsed))) : 60;
}

function observationRetentionDays(env: Env): number {
  const parsed = Number(env.MAP_OBSERVATION_RETENTION_DAYS || 30);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(90, Math.floor(parsed))) : 30;
}

function emptyManifest(env: Env): PublicMapManifest {
  return {
    schemaVersion: MAP_SCHEMA_VERSION,
    indexZoom: indexZoom(env),
    revision: 0,
    updatedAt: null,
    verifiedRecords: 0,
    verifiedShards: 0,
    verifiedDeltas: 0,
    verifiedFeatures: 0,
    verifiedBytes: 0,
    datasets: {},
    latest: [],
  };
}

async function kvJson<T>(env: Env, key: string): Promise<T | null> {
  const raw = await env.EDGE_STATE.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(503, "map_index_corrupt", "Indeks peta tersimpan tidak dapat dibaca.");
  }
}

async function putKvJson(env: Env, key: string, value: unknown, options?: KVNamespacePutOptions): Promise<void> {
  await env.EDGE_STATE.put(key, JSON.stringify(value), options);
}

function requireMapAdmin(request: Request, env: Env): void {
  const expected = String(env.MAP_ADMIN_TOKEN || env.PUSH_ADMIN_TOKEN || "");
  if (!expected || !constantTimeTextEqual(bearerToken(request), expected)) {
    throw new HttpError(401, "unauthorized", "Token admin data peta tidak valid.");
  }
}

function verifiedStorageKey(kind: MapRecordKind, dataset: string, id: string): string {
  return `${VERIFIED_PREFIX}${kind}:${dataset}:${id}`;
}

function observationStorageKey(batchId: string): string {
  return `${OBSERVATION_PREFIX}${batchId}`;
}

function normalizeProvenance(value: unknown, verifiedAt: string): MapProvenance {
  const input = objectValue(value, "provenance");
  const method = strictText(input.method, "provenance.method", 32) as MapProvenance["method"];
  if (!PROVENANCE_METHODS.has(method)) {
    throw new HttpError(400, "invalid_provenance", "provenance.method tidak didukung.");
  }
  const observationBatchIds = input.observationBatchIds === undefined
    ? []
    : arrayValue(input.observationBatchIds, "provenance.observationBatchIds").map((id, index) => safeId(id, `provenance.observationBatchIds[${index}]`));
  if (observationBatchIds.length > 16) throw new HttpError(400, "invalid_provenance", "Terlalu banyak observationBatchIds.");
  if (method === "reviewed-cv" && !observationBatchIds.length) {
    throw new HttpError(400, "observation_reference_required", "reviewed-cv wajib merujuk batch observasi karantina.");
  }
  const sourceChecksum = input.sourceChecksum === undefined
    ? undefined
    : strictText(input.sourceChecksum, "provenance.sourceChecksum", 128, 16).toLowerCase();
  if (sourceChecksum && !/^[a-z0-9:_-]+$/.test(sourceChecksum)) {
    throw new HttpError(400, "invalid_provenance", "provenance.sourceChecksum tidak valid.");
  }
  return {
    source: strictText(input.source, "provenance.source", 120),
    sourceUrl: optionalHttpsUrl(input.sourceUrl, "provenance.sourceUrl"),
    license: strictText(input.license, "provenance.license", 120),
    capturedAt: isoTimestamp(input.capturedAt, "provenance.capturedAt"),
    verifiedAt,
    verifiedBy: strictText(input.verifiedBy, "provenance.verifiedBy", 80),
    method,
    sourceChecksum,
    observationBatchIds: [...new Set(observationBatchIds)],
  };
}

async function ensureObservationReferences(env: Env, provenance: MapProvenance): Promise<void> {
  if (!provenance.observationBatchIds.length) return;
  const records = await Promise.all(provenance.observationBatchIds.map((id) => kvJson<ObservationBatchRecord>(env, observationStorageKey(id))));
  if (records.some((record) => !record || record.reviewState !== "quarantined" || record.published !== false)) {
    throw new HttpError(400, "observation_reference_missing", "Satu atau lebih batch observasi karantina tidak ditemukan atau tidak valid.");
  }
}

function manifestStats(value?: DatasetManifestStats): DatasetManifestStats {
  return value ? { ...value } : { records: 0, features: 0, bytes: 0 };
}

function updateManifest(
  env: Env,
  current: PublicMapManifest | null,
  record: VerifiedMapRecord,
  previous: VerifiedMapRecord | null,
): PublicMapManifest {
  const manifest = current || emptyManifest(env);
  if (manifest.indexZoom !== indexZoom(env)) {
    throw new HttpError(503, "map_index_zoom_mismatch", "MAP_DATA_INDEX_ZOOM berbeda dari manifest tersimpan.");
  }
  const datasets = { ...manifest.datasets };
  const stats = manifestStats(datasets[record.dataset]);
  if (previous) {
    stats.features -= previous.featureCount;
    stats.bytes -= previous.bytes;
  } else {
    stats.records += 1;
  }
  stats.features += record.featureCount;
  stats.bytes += record.bytes;
  datasets[record.dataset] = {
    records: Math.max(0, stats.records),
    features: Math.max(0, stats.features),
    bytes: Math.max(0, stats.bytes),
  };
  const latestEntry = {
    storageKey: record.storageKey,
    id: record.id,
    kind: record.kind,
    dataset: record.dataset,
    revision: record.revision,
    bbox: record.bbox,
    tile: record.tile,
    featureCount: record.featureCount,
    checksum: record.checksum,
    updatedAt: record.storedAt,
  };
  return {
    ...manifest,
    revision: manifest.revision + 1,
    updatedAt: record.storedAt,
    verifiedRecords: Math.max(0, manifest.verifiedRecords + (previous ? 0 : 1)),
    verifiedShards: Math.max(0, manifest.verifiedShards + (!previous && record.kind === "shard" ? 1 : 0)),
    verifiedDeltas: Math.max(0, manifest.verifiedDeltas + (!previous && record.kind === "delta" ? 1 : 0)),
    verifiedFeatures: Math.max(0, manifest.verifiedFeatures - (previous?.featureCount || 0) + record.featureCount),
    verifiedBytes: Math.max(0, manifest.verifiedBytes - (previous?.bytes || 0) + record.bytes),
    datasets,
    latest: [latestEntry, ...manifest.latest.filter((entry) => entry.storageKey !== record.storageKey)].slice(0, 24),
  };
}

async function publicJson(request: Request, env: Env, payload: unknown, updatedAt?: string | null): Promise<Response> {
  const raw = JSON.stringify(payload);
  const etag = `"${(await sha256Hex(raw)).slice(0, 32)}"`;
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": `public, max-age=${publicCacheSeconds(env)}, stale-while-revalidate=300`,
    ETag: etag,
    "X-ITS-Map-Schema": MAP_SCHEMA_VERSION,
  });
  if (updatedAt) headers.set("Last-Modified", new Date(updatedAt).toUTCString());
  if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  return new Response(raw, { status: 200, headers });
}

export async function handleMapManifest(request: Request, env: Env): Promise<Response> {
  const stored = await kvJson<PublicMapManifest>(env, MANIFEST_KEY);
  const manifest = stored || emptyManifest(env);
  return publicJson(request, env, {
    ok: true,
    ...manifest,
    publicData: "verified-only",
    observationState: "quarantined-not-public",
    endpoints: {
      viewport: "/v1/map/deltas?bbox=minLng,minLat,maxLng,maxLat",
      observationIngest: "/v1/map/observations",
      verifiedAdmin: "/v1/admin/map/verified",
    },
    limits: {
      viewportLongitudeSpan: MAX_VIEWPORT_LONGITUDE_SPAN,
      viewportLatitudeSpan: MAX_VIEWPORT_LATITUDE_SPAN,
      recordsPerResponse: MAX_PUBLIC_RECORDS,
      featuresPerResponse: MAX_PUBLIC_FEATURES,
      responseBytes: MAX_PUBLIC_RESPONSE_BYTES,
      deltaFeaturesPerRecord: MAX_DELTA_FEATURES,
      shardFeaturesPerRecord: MAX_SHARD_FEATURES,
      kvDeltaPayloadBytes: MAX_KV_DELTA_BYTES,
      r2ShardPayloadBytes: MAX_VERIFIED_BODY_BYTES,
      observationsPerBatch: MAX_OBSERVATIONS,
      observationPayloadBytes: MAX_OBSERVATION_BODY_BYTES,
    },
    quotaPolicy: "free-tier-guardrails; no unlimited-capacity claim",
  }, manifest.updatedAt);
}

function viewportBbox(url: URL): Bbox {
  const bboxRaw = url.searchParams.get("bbox");
  const tileRaw = url.searchParams.get("tile");
  if (!bboxRaw && !tileRaw) throw new HttpError(400, "viewport_required", "Gunakan parameter bbox atau tile.");
  const bbox = tileRaw
    ? tileBbox(parseTileQuery(tileRaw))
    : parseBbox(String(bboxRaw).split(","), "bbox");
  if (!bboxIntersects(bbox, INDONESIA_DATA_BOUNDS)) {
    throw new HttpError(400, "viewport_outside_indonesia", "Viewport tidak beririsan dengan cakupan data Indonesia.");
  }
  if (bbox[2] - bbox[0] > MAX_VIEWPORT_LONGITUDE_SPAN || bbox[3] - bbox[1] > MAX_VIEWPORT_LATITUDE_SPAN) {
    throw new HttpError(400, "viewport_too_large", "Viewport terlalu besar; pecah permintaan menjadi tile yang lebih kecil.");
  }
  return bbox;
}

function requestedDatasets(url: URL): Set<string> | null {
  const raw = cleanText(url.searchParams.get("datasets"), 240);
  if (!raw) return null;
  const datasets = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  if (!datasets.length || datasets.length > MAP_DATASETS.size || datasets.some((dataset) => !MAP_DATASETS.has(dataset))) {
    throw new HttpError(400, "invalid_datasets", "Parameter datasets berisi kategori yang tidak didukung.");
  }
  return new Set(datasets);
}

function requestedKind(url: URL): MapRecordKind | "all" {
  const kind = cleanText(url.searchParams.get("kind") || "all", 12).toLowerCase();
  if (kind !== "all" && kind !== "shard" && kind !== "delta") {
    throw new HttpError(400, "invalid_kind", "Parameter kind harus all, shard, atau delta.");
  }
  return kind;
}

export async function handleMapDeltas(request: Request, env: Env): Promise<Response> {
  // Public map reads are naturally bounded by viewport/index/response limits
  // below. A per-IP 20/minute limiter breaks normal pan and zoom interaction
  // and produces visible 429 console errors; retain rate limiting for mutation
  // and admin endpoints only.
  const url = new URL(request.url);
  const bbox = viewportBbox(url);
  const datasets = requestedDatasets(url);
  const kind = requestedKind(url);
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw ? Date.parse(strictText(sinceRaw, "since", 48, 10)) : Number.NEGATIVE_INFINITY;
  if (sinceRaw && !Number.isFinite(since)) throw new HttpError(400, "invalid_since", "Parameter since harus timestamp ISO.");
  const limit = url.searchParams.has("limit")
    ? integerInRange(url.searchParams.get("limit"), "limit", 1, MAX_PUBLIC_RECORDS)
    : MAX_PUBLIC_RECORDS;
  const manifest = await kvJson<PublicMapManifest>(env, MANIFEST_KEY) || emptyManifest(env);
  const bucketKeys = spatialIndexKeys(bbox, manifest.indexZoom);
  if (bucketKeys.length > MAX_INDEX_BUCKETS_PER_VIEWPORT) {
    throw new HttpError(400, "viewport_too_large", "Viewport menyentuh terlalu banyak bucket indeks.");
  }
  const buckets = await Promise.all(bucketKeys.map((key) => kvJson<MapIndexBucket>(env, key)));
  const candidateMap = new Map<string, MapIndexEntry>();
  buckets.forEach((bucket) => bucket?.entries.forEach((entry) => {
    if (!bboxIntersects(entry.bbox, bbox)) return;
    if (datasets && !datasets.has(entry.dataset)) return;
    if (kind !== "all" && entry.kind !== kind) return;
    if (Date.parse(entry.updatedAt) <= since) return;
    candidateMap.set(entry.storageKey, entry);
  }));
  const candidates = [...candidateMap.values()].sort((left, right) => (
    Date.parse(left.updatedAt) - Date.parse(right.updatedAt) || left.storageKey.localeCompare(right.storageKey)
  ));
  const selected = candidates.slice(0, limit);
  const records = await Promise.all(selected.map((entry) => readVerifiedRecord(env, entry)));
  const query = {
    bbox,
    indexZoom: manifest.indexZoom,
    datasets: datasets ? [...datasets] : "all",
    kind,
    since: sinceRaw || null,
    limit,
  };
  const generatedAt = manifest.updatedAt || new Date(0).toISOString();
  const publicRecords: Array<Record<string, unknown>> = [];
  const collectionFeatures: PublishedMapFeature[] = [];
  let sourceFeatureCount = 0;
  let omittedDeletes = 0;
  let truncationReason: "feature-limit" | "byte-limit" | null = null;
  const continuationHint = "Perkecil bbox atau bagi viewport menjadi tile; jangan menaikkan limit melampaui guardrail.";
  for (const record of records) {
    if (!record) continue;
    const remainingFeatures = MAX_PUBLIC_FEATURES - collectionFeatures.length;
    const published = publishedFeaturesFromRecord(record, remainingFeatures + 1);
    if (published.truncated || published.features.length > remainingFeatures) {
      truncationReason = "feature-limit";
      break;
    }
    const nextRecords = [...publicRecords, publicRecordMetadata(record)];
    const nextFeatures = [...collectionFeatures, ...published.features];
    const prospectivePayload = {
      ok: true,
      schemaVersion: MAP_SCHEMA_VERSION,
      manifestRevision: manifest.revision,
      generatedAt,
      query,
      records: nextRecords,
      collection: { type: "FeatureCollection", features: nextFeatures },
      recordCount: nextRecords.length,
      sourceFeatureCount: sourceFeatureCount + published.sourceFeatureCount,
      featureCount: nextFeatures.length,
      omittedDeletes: omittedDeletes + published.omittedDeletes,
      availableRecords: candidates.length,
      truncated: true,
      truncationReason: "byte-limit",
      continuationHint,
      verification: "Only normalized features derived from authenticated verified records are returned.",
    };
    if (byteLength(JSON.stringify(prospectivePayload)) > MAX_PUBLIC_RESPONSE_BYTES) {
      truncationReason = "byte-limit";
      break;
    }
    publicRecords.push(publicRecordMetadata(record));
    collectionFeatures.push(...published.features);
    sourceFeatureCount += published.sourceFeatureCount;
    omittedDeletes += published.omittedDeletes;
  }
  const truncated = publicRecords.length < candidates.length;
  const resolvedTruncationReason = truncationReason
    || (candidates.length > selected.length ? "record-limit" : null)
    || (publicRecords.length < selected.length ? "unavailable-record" : null);
  const payload = {
    ok: true,
    schemaVersion: MAP_SCHEMA_VERSION,
    manifestRevision: manifest.revision,
    generatedAt,
    query,
    records: publicRecords,
    collection: {
      type: "FeatureCollection",
      features: collectionFeatures,
    },
    recordCount: publicRecords.length,
    sourceFeatureCount,
    featureCount: collectionFeatures.length,
    omittedDeletes,
    availableRecords: candidates.length,
    truncated,
    truncationReason: resolvedTruncationReason,
    continuationHint: truncated ? continuationHint : null,
    verification: "Only normalized features derived from authenticated verified records are returned.",
  };
  if (byteLength(JSON.stringify(payload)) > MAX_PUBLIC_RESPONSE_BYTES) {
    throw new HttpError(503, "map_response_limit", "Respons peta melebihi guardrail byte setelah normalisasi.");
  }
  return publicJson(request, env, payload, manifest.updatedAt);
}

function indexEntry(record: VerifiedMapRecord): MapIndexEntry {
  return {
    storageKey: record.storageKey,
    id: record.id,
    kind: record.kind,
    dataset: record.dataset,
    revision: record.revision,
    bbox: record.bbox,
    tile: record.tile,
    featureCount: record.featureCount,
    bytes: record.bytes,
    checksum: record.checksum,
    updatedAt: record.storedAt,
    storage: record.storage,
    objectKey: record.objectKey,
  };
}

function publicRecordMetadata(record: VerifiedMapRecord): Record<string, unknown> {
  return {
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    id: record.id,
    dataset: record.dataset,
    revision: record.revision,
    tile: record.tile,
    bbox: record.bbox,
    generatedAt: record.generatedAt,
    updatedAt: record.storedAt,
    provenance: record.provenance,
    featureCount: record.featureCount,
    vertexCount: record.vertexCount,
    checksum: record.checksum,
    bytes: record.bytes,
  };
}

async function readVerifiedRecord(env: Env, entry: MapIndexEntry): Promise<VerifiedMapRecord | null> {
  const reference = await kvJson<VerifiedMapRecord>(env, entry.storageKey);
  if (!reference) return null;
  const storage = entry.storage || reference.storage || "kv";
  if (storage === "kv") return reference;
  const objectKey = entry.objectKey || reference.objectKey;
  if (!objectKey || !env.MAP_ARCHIVE) return null;
  const object = await env.MAP_ARCHIVE.get(objectKey);
  if (!object) return null;
  try {
    const record = JSON.parse(await object.text()) as VerifiedMapRecord;
    if (record.checksum !== entry.checksum || record.storageKey !== entry.storageKey) return null;
    return record;
  } catch {
    return null;
  }
}

async function writeVerifiedRecord(
  env: Env,
  record: VerifiedMapRecord,
  previous: VerifiedMapRecord | null,
): Promise<PublicMapManifest> {
  const allBucketKeys = [...new Set([...(previous?.indexBuckets || []), ...record.indexBuckets])];
  const buckets = await Promise.all(allBucketKeys.map(async (key) => ({
    key,
    value: await kvJson<MapIndexBucket>(env, key),
  })));
  const updatedBuckets = buckets.map(({ key, value }) => {
    const entries = (value?.entries || []).filter((entry) => entry.storageKey !== record.storageKey);
    if (record.indexBuckets.includes(key)) entries.push(indexEntry(record));
    if (entries.length > MAX_INDEX_ENTRIES_PER_BUCKET) {
      throw new HttpError(409, "map_index_bucket_full", "Bucket indeks penuh; gunakan tile yang lebih kecil atau lakukan kompaksi admin.");
    }
    return {
      key,
      value: {
        schemaVersion: MAP_SCHEMA_VERSION,
        indexZoom: indexZoom(env),
        updatedAt: record.storedAt,
        entries: entries.sort((left, right) => left.storageKey.localeCompare(right.storageKey)),
      } satisfies MapIndexBucket,
    };
  });
  const currentManifest = await kvJson<PublicMapManifest>(env, MANIFEST_KEY);
  const nextManifest = updateManifest(env, currentManifest, record, previous);
  if (record.storage === "r2") {
    if (!env.MAP_ARCHIVE || !record.objectKey) {
      throw new HttpError(503, "map_archive_not_configured", "Upload shard memerlukan binding R2 MAP_ARCHIVE yang sudah dibootstrap.");
    }
    const serialized = JSON.stringify(record);
    const existingObject = await env.MAP_ARCHIVE.head(record.objectKey);
    if (!existingObject) {
      await env.MAP_ARCHIVE.put(record.objectKey, serialized, {
        httpMetadata: {
          contentType: "application/json; charset=utf-8",
          cacheControl: "public, max-age=31536000, immutable",
        },
        customMetadata: {
          schema: MAP_SCHEMA_VERSION,
          dataset: record.dataset,
          checksum: record.checksum,
          revision: String(record.revision),
        },
      });
    }
    const pointer: VerifiedMapRecord = { ...record, features: [] };
    await env.EDGE_STATE.put(record.storageKey, JSON.stringify(pointer));
  } else {
    await env.EDGE_STATE.put(record.storageKey, JSON.stringify(record));
  }
  await Promise.all(updatedBuckets.map(({ key, value }) => (
    value.entries.length ? putKvJson(env, key, value) : env.EDGE_STATE.delete(key)
  )));
  await putKvJson(env, MANIFEST_KEY, nextManifest);
  return nextManifest;
}

export async function handleVerifiedMapUpload(request: Request, env: Env): Promise<Response> {
  requireMapAdmin(request, env);
  await enforceRateLimit(request, env, "map-admin");
  const body = await readJson<Record<string, unknown>>(request, MAX_VERIFIED_BODY_BYTES);
  if (body.schemaVersion !== MAP_SCHEMA_VERSION) {
    throw new HttpError(400, "unsupported_map_schema", `schemaVersion harus ${MAP_SCHEMA_VERSION}.`);
  }
  const kind = strictText(body.kind, "kind", 12) as MapRecordKind;
  if (kind !== "shard" && kind !== "delta") throw new HttpError(400, "invalid_kind", "kind harus shard atau delta.");
  const dataset = strictText(body.dataset, "dataset", 32).toLowerCase();
  if (!MAP_DATASETS.has(dataset)) throw new HttpError(400, "invalid_dataset", "dataset tidak didukung.");
  const id = safeId(body.id, "id");
  const revision = integerInRange(body.revision, "revision", 1, Number.MAX_SAFE_INTEGER);
  const tile = parseTile(body.tile);
  const bbox = parseBbox(body.bbox);
  if (!bboxContained(bbox, INDONESIA_DATA_BOUNDS)) {
    throw new HttpError(400, "bbox_outside_indonesia", "bbox record berada di luar cakupan Indonesia.");
  }
  if (!bboxContained(bbox, tileBbox(tile), 1e-6)) {
    throw new HttpError(400, "bbox_outside_tile", "bbox record harus berada di dalam tile yang dinyatakan.");
  }
  const generatedAt = isoTimestamp(body.generatedAt, "generatedAt");
  const storedAt = new Date().toISOString();
  const provenance = normalizeProvenance(body.provenance, storedAt);
  await ensureObservationReferences(env, provenance);
  const inputFeatures = arrayValue(body.features, "features");
  const featureLimit = kind === "shard" ? MAX_SHARD_FEATURES : MAX_DELTA_FEATURES;
  if (!inputFeatures.length || inputFeatures.length > featureLimit) {
    throw new HttpError(400, "feature_limit", `features harus berisi 1-${featureLimit} item untuk ${kind}.`);
  }
  const geometryStats = emptyGeometryStats();
  const features = inputFeatures.map((feature, index) => normalizeFeature(feature, index, kind, bbox, geometryStats));
  if (new Set(features.map((feature) => feature.id)).size !== features.length) {
    throw new HttpError(400, "duplicate_feature_id", "Setiap feature dalam satu record wajib memiliki id unik.");
  }
  const vertexLimit = kind === "shard" ? MAX_VERTICES_PER_SHARD : MAX_VERTICES_PER_DELTA;
  if (geometryStats.vertices > vertexLimit) {
    throw new HttpError(413, "vertex_limit", `Record melebihi ${vertexLimit} vertex untuk ${kind}.`);
  }
  const storageKey = verifiedStorageKey(kind, dataset, id);
  const buckets = spatialIndexKeys(bbox, indexZoom(env));
  if (!buckets.length || buckets.length > MAX_INDEX_BUCKETS_PER_RECORD) {
    throw new HttpError(400, "record_spans_too_many_buckets", "Record harus dipotong menjadi tile yang lebih kecil sebelum diunggah.");
  }
  const checksumPayload = {
    schemaVersion: MAP_SCHEMA_VERSION,
    kind,
    id,
    dataset,
    revision,
    tile,
    bbox,
    generatedAt,
    provenance: { ...provenance, verifiedAt: undefined },
    features,
  };
  const checksum = await sha256Hex(JSON.stringify(checksumPayload));
  const previous = await kvJson<VerifiedMapRecord>(env, storageKey);
  if (previous && revision < previous.revision) {
    throw new HttpError(409, "stale_revision", `Revision terbaru adalah ${previous.revision}.`);
  }
  if (previous && revision === previous.revision) {
    if (previous.checksum !== checksum) throw new HttpError(409, "revision_conflict", "Revision sama memiliki isi berbeda.");
    return json({ ok: true, idempotent: true, record: indexEntry(previous) });
  }
  const storage = kind === "shard" ? "r2" : "kv";
  if (storage === "r2" && !env.MAP_ARCHIVE) {
    throw new HttpError(503, "map_archive_not_configured", "Shard immutable tidak disimpan di KV; bootstrap R2 lalu tambahkan binding MAP_ARCHIVE.");
  }
  const objectKey = storage === "r2"
    ? `map/v1/verified/shards/${dataset}/${tile.z}/${tile.x}/${tile.y}/${id}/r${revision}-${checksum}.json`
    : undefined;
  const baseRecord: VerifiedMapRecord = {
    schemaVersion: MAP_SCHEMA_VERSION,
    kind,
    id,
    dataset,
    revision,
    tile,
    bbox,
    generatedAt,
    storedAt,
    provenance,
    features,
    featureCount: features.length,
    vertexCount: geometryStats.vertices,
    checksum,
    bytes: 0,
    storageKey,
    indexBuckets: buckets,
    storage,
    objectKey,
  };
  const publicProjection = publishedFeaturesFromRecord(baseRecord, MAX_PUBLIC_FEATURES + 1);
  if (publicProjection.truncated || publicProjection.features.length > MAX_PUBLIC_FEATURES) {
    throw new HttpError(
      413,
      "public_feature_limit",
      `Record menghasilkan lebih dari ${MAX_PUBLIC_FEATURES} feature publik setelah normalisasi geometri multipart.`,
    );
  }
  baseRecord.bytes = byteLength(JSON.stringify(baseRecord));
  const serialized = JSON.stringify(baseRecord);
  baseRecord.bytes = byteLength(serialized);
  const storageLimit = storage === "r2" ? MAX_VERIFIED_BODY_BYTES : MAX_KV_DELTA_BYTES;
  if (baseRecord.bytes > storageLimit) {
    throw new HttpError(413, "verified_record_too_large", `Record hasil normalisasi melebihi guardrail ${storage === "r2" ? "R2 shard" : "KV delta"}.`);
  }
  const manifest = await writeVerifiedRecord(env, baseRecord, previous);
  return json({
    ok: true,
    idempotent: false,
    published: true,
    record: indexEntry(baseRecord),
    manifestRevision: manifest.revision,
  }, previous ? 200 : 201);
}

async function readRawJson(request: Request, maximumBytes: number): Promise<{ raw: string; value: Record<string, unknown> }> {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Gunakan Content-Type application/json.");
  }
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maximumBytes) throw new HttpError(413, "payload_too_large", "Payload terlalu besar.");
  const raw = await request.text();
  if (byteLength(raw) > maximumBytes) throw new HttpError(413, "payload_too_large", "Payload terlalu besar.");
  try {
    return { raw, value: objectValue(JSON.parse(raw) as unknown, "body") };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json", "JSON tidak valid.");
  }
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyObservationSignature(request: Request, env: Env, raw: string): Promise<string> {
  const secret = String(env.MAP_OBSERVATION_HMAC_SECRET || "");
  if (secret.length < 24) {
    throw new HttpError(503, "observation_ingest_not_configured", "Secret HMAC observasi peta belum dikonfigurasi.");
  }
  const timestamp = strictText(request.headers.get("X-ITS-Timestamp"), "X-ITS-Timestamp", 20, 10);
  const timestampSeconds = Number(timestamp);
  if (!Number.isInteger(timestampSeconds) || Math.abs(Date.now() - timestampSeconds * 1000) > 5 * 60_000) {
    throw new HttpError(401, "stale_observation_signature", "Timestamp signature observasi kedaluwarsa.");
  }
  const nonce = strictText(request.headers.get("X-ITS-Nonce"), "X-ITS-Nonce", 80, 16);
  if (!/^[A-Za-z0-9_-]+$/.test(nonce)) throw new HttpError(401, "invalid_observation_nonce", "Nonce observasi tidak valid.");
  const supplied = String(request.headers.get("X-ITS-Signature") || "").replace(/^sha256=/i, "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(supplied)) throw new HttpError(401, "invalid_observation_signature", "Signature observasi tidak valid.");
  const expected = await hmacSha256Hex(secret, `${timestamp}.${nonce}.${raw}`);
  if (!constantTimeTextEqual(supplied, expected)) throw new HttpError(401, "invalid_observation_signature", "Signature observasi tidak valid.");
  const nonceKey = `${OBSERVATION_NONCE_PREFIX}${nonce}`;
  if (await env.EDGE_STATE.get(nonceKey)) throw new HttpError(409, "observation_replay", "Nonce observasi sudah pernah digunakan.");
  await env.EDGE_STATE.put(nonceKey, "1", { expirationTtl: 600 });
  return nonce;
}

function normalizeObservationSource(value: unknown): ObservationBatchRecord["source"] {
  const input = objectValue(value, "source");
  const deviceIdHash = input.deviceIdHash === undefined
    ? undefined
    : strictText(input.deviceIdHash, "source.deviceIdHash", 128, 16);
  if (deviceIdHash && !/^[A-Za-z0-9_-]+$/.test(deviceIdHash)) {
    throw new HttpError(400, "invalid_device_hash", "source.deviceIdHash harus hash/pseudonym, bukan ID mentah.");
  }
  return {
    producer: strictText(input.producer, "source.producer", 100),
    model: strictText(input.model, "source.model", 120),
    modelVersion: strictText(input.modelVersion, "source.modelVersion", 80),
    imagery: strictText(input.imagery, "source.imagery", 120),
    imageryLicense: strictText(input.imageryLicense, "source.imageryLicense", 120),
    sourceUrl: optionalHttpsUrl(input.sourceUrl, "source.sourceUrl"),
    deviceIdHash,
  };
}

export async function handleMapObservationBatch(request: Request, env: Env): Promise<Response> {
  await enforceRateLimit(request, env, "map-observation");
  const { raw, value: body } = await readRawJson(request, MAX_OBSERVATION_BODY_BYTES);
  await verifyObservationSignature(request, env, raw);
  if (body.schemaVersion !== MAP_SCHEMA_VERSION) {
    throw new HttpError(400, "unsupported_map_schema", `schemaVersion harus ${MAP_SCHEMA_VERSION}.`);
  }
  const batchId = safeId(body.batchId, "batchId");
  const key = observationStorageKey(batchId);
  if (await env.EDGE_STATE.get(key)) throw new HttpError(409, "duplicate_observation_batch", "batchId observasi sudah tersimpan.");
  const tile = parseTile(body.tile);
  const bbox = parseBbox(body.bbox);
  if (!bboxContained(bbox, INDONESIA_DATA_BOUNDS) || !bboxContained(bbox, tileBbox(tile), 1e-6)) {
    throw new HttpError(400, "invalid_observation_bbox", "bbox observasi harus berada di Indonesia dan di dalam tile.");
  }
  const capturedAt = isoTimestamp(body.capturedAt, "capturedAt");
  const source = normalizeObservationSource(body.source);
  const inputObservations = arrayValue(body.observations, "observations");
  if (!inputObservations.length || inputObservations.length > MAX_OBSERVATIONS) {
    throw new HttpError(400, "observation_limit", `observations harus berisi 1-${MAX_OBSERVATIONS} item.`);
  }
  const totalStats = emptyGeometryStats();
  const observations = inputObservations.map((value, index) => {
    const input = objectValue(value, `observations[${index}]`);
    const kind = strictText(input.kind, `observations[${index}].kind`, 40).toLowerCase();
    if (!OBSERVATION_KINDS.has(kind)) throw new HttpError(400, "invalid_observation_kind", `observations[${index}].kind tidak didukung.`);
    const score = finiteNumber(input.score, `observations[${index}].score`);
    if (score < 0 || score > 1) throw new HttpError(400, "invalid_observation_score", "Skor observasi harus 0-1.");
    const featureStats = emptyGeometryStats();
    const geometry = normalizeGeometry(input.geometry, `observations[${index}].geometry`, featureStats);
    if (!bboxContained(geometryBbox(featureStats), bbox, 1e-7)) {
      throw new HttpError(400, "geometry_outside_bbox", `observations[${index}] berada di luar bbox batch.`);
    }
    totalStats.vertices += featureStats.vertices;
    const attributesValue = normalizeJsonValue(input.attributes || {}, `observations[${index}].attributes`);
    if (!attributesValue || Array.isArray(attributesValue) || typeof attributesValue !== "object") {
      throw new HttpError(400, "invalid_observation_attributes", "attributes observasi harus object.");
    }
    return {
      id: safeId(input.id, `observations[${index}].id`),
      kind,
      score: Number(score.toFixed(5)),
      geometry,
      attributes: attributesValue as JsonObject,
    };
  });
  if (totalStats.vertices > MAX_VERTICES_PER_OBSERVATION_BATCH) {
    throw new HttpError(413, "observation_vertex_limit", `Batch observasi melebihi ${MAX_VERTICES_PER_OBSERVATION_BATCH} vertex.`);
  }
  const receivedAt = new Date().toISOString();
  const retentionSeconds = observationRetentionDays(env) * 86_400;
  const expiresAt = new Date(Date.now() + retentionSeconds * 1000).toISOString();
  const checksum = await sha256Hex(raw);
  const record: ObservationBatchRecord = {
    schemaVersion: MAP_SCHEMA_VERSION,
    batchId,
    tile,
    bbox,
    capturedAt,
    receivedAt,
    expiresAt,
    reviewState: "quarantined",
    published: false,
    source,
    observations,
    observationCount: observations.length,
    vertexCount: totalStats.vertices,
    checksum,
  };
  await putKvJson(env, key, record, { expirationTtl: retentionSeconds });
  return json({
    ok: true,
    accepted: true,
    batchId,
    observationCount: observations.length,
    reviewState: record.reviewState,
    published: false,
    expiresAt,
    checksum,
    message: "Observasi CV disimpan terpisah dan tidak muncul pada endpoint publik sebelum ditinjau serta diunggah ulang oleh admin sebagai data verified.",
  }, 202);
}

export function mapDataHealth(env: Env): Record<string, unknown> {
  return {
    schemaVersion: MAP_SCHEMA_VERSION,
    storage: "EDGE_STATE KV for indexes, small deltas, pointers, and quarantined observations",
    archive: "optional MAP_ARCHIVE R2 for immutable verified shards",
    archiveConfigured: Boolean(env.MAP_ARCHIVE),
    publicReads: true,
    verifiedAdminConfigured: Boolean(env.MAP_ADMIN_TOKEN || env.PUSH_ADMIN_TOKEN),
    observationHmacConfigured: String(env.MAP_OBSERVATION_HMAC_SECRET || "").length >= 24,
    indexZoom: indexZoom(env),
    observationRetentionDays: observationRetentionDays(env),
    publicPolicy: "verified-only",
    freeTierGuardrails: true,
    unlimited: false,
  };
}
