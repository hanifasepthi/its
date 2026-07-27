import { mapDetailCache } from "./MapDetailCache";
import type { MapDetailFeatureCollection } from "./MapDetailStyle";

export type MapDynamicsBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

type MapDynamicsShard = {
  id: string;
  url: string;
  bbox: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  groups: string[];
  featureCount: number;
  bytes: number;
  sha256?: string;
  updatedAt?: string;
  priority?: number;
};

type MapDynamicsManifest = {
  schemaVersion: string;
  dataset: string;
  datasetVersion: string;
  generatedAt: string;
  featureSchema: string;
  tileZoom: number;
  coverage: {
    country: "ID";
    bbox: [number, number, number, number];
    mode: "incremental";
  };
  policy: {
    publish: "verified-only";
    vision: "observation-before-verification";
    maxShardBytes: number;
  };
  shards: MapDynamicsShard[];
  deltaFeed?: string;
};

export type MapDynamicsLoadResult = {
  collection: MapDetailFeatureCollection;
  manifestVersion: string;
  selectedShards: number;
  loadedShards: number;
  remoteDeltas: number;
  source: "manifest" | "cache" | "empty";
};

const EMPTY_COLLECTION: MapDetailFeatureCollection = { type: "FeatureCollection", features: [] };
// v2 invalidates the old relative-shard manifest that was cached before map
// payloads moved to an immutable GitHub revision.
const MANIFEST_CACHE_KEY = "map-dynamics:manifest:v2";
const MANIFEST_MAX_AGE_MS = 15 * 60 * 1000;
const SHARD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DELTA_MAX_AGE_MS = 10 * 60 * 1000;
// National ingest shards can overlap after record-count splitting. Loading 16
// multi-megabyte shards blocked the small CCTV supplement and made detailed
// layers appear empty. Four is the safe fallback; spatial hotspot shards take
// exclusive precedence when present.
const MAX_ACTIVE_SHARDS = 4;
const MAX_FEATURES_PER_RESPONSE = 12_000;
const DEFAULT_MANIFEST_URL = "/data/map-dynamics/manifest.json";
const DEFAULT_DELTA_FEED = "https://its.hanifahseptiani45.workers.dev/v1/map/deltas";
const SUPPLEMENTAL_PUBLIC_CCTV_URL = "/data/public-cctv.geojson";

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validBbox(value: unknown): value is [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(finiteNumber)) return false;
  const [west, south, east, north] = value;
  return west >= -180 && east <= 180 && south >= -90 && north <= 90 && west <= east && south <= north;
}

function intersects(left: MapDynamicsBounds | [number, number, number, number], right: MapDynamicsBounds | [number, number, number, number]): boolean {
  const a = Array.isArray(left) ? { west: left[0], south: left[1], east: left[2], north: left[3] } : left;
  const b = Array.isArray(right) ? { west: right[0], south: right[1], east: right[2], north: right[3] } : right;
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
}

function coordinateTreeValid(value: unknown, depth = 0): boolean {
  if (depth > 5 || !Array.isArray(value) || value.length === 0) return false;
  if (value.every(finiteNumber)) {
    if (value.length < 2) return false;
    const [lng, lat] = value;
    return lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90;
  }
  return value.every((child) => coordinateTreeValid(child, depth + 1));
}

function validCollection(value: unknown): value is MapDetailFeatureCollection {
  if (!value || typeof value !== "object") return false;
  const collection = value as MapDetailFeatureCollection;
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) return false;
  if (collection.features.length > MAX_FEATURES_PER_RESPONSE) return false;
  return collection.features.every((feature) => {
    if (!feature || feature.type !== "Feature" || !feature.geometry || !feature.properties) return false;
    if (!(["Point", "LineString", "Polygon"] as string[]).includes(feature.geometry.type)) return false;
    return coordinateTreeValid(feature.geometry.coordinates);
  });
}

function collectionFromDeltaPayload(payload: unknown): MapDetailFeatureCollection {
  if (validCollection(payload)) return payload;
  if (!payload || typeof payload !== "object") return EMPTY_COLLECTION;
  const envelope = payload as Record<string, unknown>;
  if (validCollection(envelope.collection)) return envelope.collection;

  // Compatibility with the first verified Worker envelope.  Record-level
  // provenance is promoted onto every feature before the verified-only policy
  // sees it; arbitrary feature properties cannot downgrade or replace it.
  if (envelope.schemaVersion !== "its-map-data-v1" || !Array.isArray(envelope.records)) return EMPTY_COLLECTION;
  const features: MapDetailFeatureCollection["features"] = [];
  for (const rawRecord of envelope.records) {
    if (!rawRecord || typeof rawRecord !== "object") continue;
    const record = rawRecord as Record<string, unknown>;
    if (!Array.isArray(record.features) || !record.provenance || typeof record.provenance !== "object") continue;
    const provenance = record.provenance as Record<string, unknown>;
    const source = String(provenance.source || "").trim();
    const updatedAt = String(record.storedAt || record.generatedAt || provenance.verifiedAt || "").trim();
    const revision = Number(record.revision || 0);
    if (!source || !updatedAt || !Number.isFinite(revision)) continue;
    for (const rawFeature of record.features) {
      if (!rawFeature || typeof rawFeature !== "object") continue;
      const feature = rawFeature as Record<string, unknown>;
      const featureProperties = feature.properties && typeof feature.properties === "object"
        ? feature.properties as Record<string, unknown>
        : {};
      const sourceId = String(feature.id ?? featureProperties.sourceId ?? "").trim();
      if (!sourceId) continue;
      features.push({
        ...(feature as unknown as MapDetailFeatureCollection["features"][number]),
        properties: {
          ...featureProperties,
          dataset: String(record.dataset || featureProperties.dataset || ""),
          source,
          sourceId,
          sourceUrl: String(provenance.sourceUrl || featureProperties.sourceUrl || ""),
          verification: "verified",
          verifiedBy: String(provenance.verifiedBy || "map-data-worker"),
          verificationMethod: String(provenance.method || ""),
          revision,
          updatedAt,
        },
      });
      if (features.length >= MAX_FEATURES_PER_RESPONSE) break;
    }
    if (features.length >= MAX_FEATURES_PER_RESPONSE) break;
  }
  const collection: MapDetailFeatureCollection = { type: "FeatureCollection", features };
  return validCollection(collection) ? collection : EMPTY_COLLECTION;
}

function validManifest(value: unknown): value is MapDynamicsManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as MapDynamicsManifest;
  if (manifest.schemaVersion !== "1.0"
    || !manifest.dataset
    || !manifest.datasetVersion
    || manifest.featureSchema !== "./feature.schema.json") return false;
  if (!validBbox(manifest.coverage?.bbox) || manifest.coverage?.country !== "ID") return false;
  const maxShardBytes = Number(manifest.policy?.maxShardBytes);
  if (manifest.policy?.publish !== "verified-only"
    || manifest.policy?.vision !== "observation-before-verification"
    || !Number.isFinite(maxShardBytes)
    || maxShardBytes < 1_024
    || maxShardBytes > 25_000_000) return false;
  if (!Array.isArray(manifest.shards) || manifest.shards.length > 50_000) return false;
  return manifest.shards.every((shard) => Boolean(
    shard
    && typeof shard.id === "string"
    && typeof shard.url === "string"
    && validBbox(shard.bbox)
    && finiteNumber(shard.minZoom)
    && finiteNumber(shard.maxZoom)
    && shard.minZoom <= shard.maxZoom
    && Array.isArray(shard.groups)
    && finiteNumber(shard.featureCount)
    && finiteNumber(shard.bytes)
    && shard.bytes <= maxShardBytes
  ));
}

function normalizedFeatureId(feature: MapDetailFeatureCollection["features"][number], index: number): string {
  const explicit = String(feature.id ?? "").trim();
  if (explicit) return explicit;
  const properties = feature.properties || {};
  return [properties.source, properties.sourceId, properties.kind, properties.name, index]
    .map((value) => String(value ?? ""))
    .join(":");
}

function mergedCollections(collections: MapDetailFeatureCollection[]): MapDetailFeatureCollection {
  const byId = new Map<string, MapDetailFeatureCollection["features"][number]>();
  collections.forEach((collection) => collection.features.forEach((feature, index) => {
    const id = normalizedFeatureId(feature, index);
    const previous = byId.get(id);
    const previousRevision = Number(previous?.properties?.revision || 0);
    const nextRevision = Number(feature.properties?.revision || 0);
    if (!previous || nextRevision >= previousRevision) byId.set(id, feature);
  }));
  return { type: "FeatureCollection", features: [...byId.values()].slice(0, MAX_FEATURES_PER_RESPONSE) };
}

function centerDistance(bounds: MapDynamicsBounds, shard: MapDynamicsShard): number {
  const centerLng = (bounds.west + bounds.east) / 2;
  const centerLat = (bounds.south + bounds.north) / 2;
  const shardLng = (shard.bbox[0] + shard.bbox[2]) / 2;
  const shardLat = (shard.bbox[1] + shard.bbox[3]) / 2;
  return Math.hypot(centerLng - shardLng, centerLat - shardLat);
}

async function fetchJson(url: string, signal: AbortSignal | undefined, cache: RequestCache): Promise<unknown> {
  const response = await fetch(url, {
    signal,
    cache,
    headers: { Accept: "application/geo+json, application/json" },
  });
  if (!response.ok) throw new MapDynamicsHttpError(response.status, url);
  return response.json();
}

class MapDynamicsHttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string) {
    super(`Map dynamics HTTP ${status}`);
    this.name = "MapDynamicsHttpError";
    this.status = status;
    this.url = url;
  }
}

export class MapDynamicsLoader {
  private readonly manifestUrl: string;
  private manifestPromise: Promise<{ manifest: MapDynamicsManifest; source: "manifest" | "cache" }> | null = null;
  private manifestLoadedAt = 0;
  private supplementalCctvPromise: Promise<MapDetailFeatureCollection> | null = null;

  constructor(manifestUrl = DEFAULT_MANIFEST_URL) {
    this.manifestUrl = manifestUrl;
  }

  private async manifest(signal?: AbortSignal, forceRefresh = false): Promise<{ manifest: MapDynamicsManifest; source: "manifest" | "cache" }> {
    if (!forceRefresh && this.manifestPromise && Date.now() - this.manifestLoadedAt < MANIFEST_MAX_AGE_MS) return this.manifestPromise;
    this.manifestPromise = null;
    this.manifestPromise = (async () => {
      const cached = forceRefresh
        ? null
        : await mapDetailCache.get<MapDynamicsManifest>(MANIFEST_CACHE_KEY, MANIFEST_MAX_AGE_MS);
      try {
        const manifestUrl = new URL(this.manifestUrl, window.location.href);
        if (forceRefresh) manifestUrl.searchParams.set("manifestRefresh", String(Date.now()));
        const value = await fetchJson(manifestUrl.toString(), signal, "no-store");
        if (!validManifest(value)) throw new Error("Manifest map dynamics tidak valid");
        await mapDetailCache.set(MANIFEST_CACHE_KEY, value);
        this.manifestLoadedAt = Date.now();
        return { manifest: value, source: "manifest" as const };
      } catch (error) {
        if (cached && validManifest(cached)) {
          this.manifestLoadedAt = Date.now();
          return { manifest: cached, source: "cache" as const };
        }
        this.manifestPromise = null;
        throw error;
      }
    })();
    return this.manifestPromise;
  }

  private async shard(manifest: MapDynamicsManifest, shard: MapDynamicsShard, signal?: AbortSignal): Promise<MapDetailFeatureCollection | null> {
    const cacheKey = `map-dynamics:shard:${manifest.datasetVersion}:${shard.id}`;
    const cached = await mapDetailCache.get<MapDetailFeatureCollection>(cacheKey, SHARD_MAX_AGE_MS);
    if (cached && validCollection(cached)) return cached;
    try {
      const url = new URL(shard.url, new URL(this.manifestUrl, window.location.href)).toString();
      const value = await fetchJson(url, signal, "force-cache");
      if (!validCollection(value)) throw new Error(`Shard ${shard.id} tidak valid`);
      void mapDetailCache.set(cacheKey, value);
      return value;
    } catch (error) {
      if (error instanceof MapDynamicsHttpError && error.status === 404) throw error;
      const stored = await mapDetailCache.peek<MapDetailFeatureCollection>(cacheKey);
      return stored && validCollection(stored) ? stored : null;
    }
  }

  private async deltas(manifest: MapDynamicsManifest, bounds: MapDynamicsBounds, zoom: number, signal?: AbortSignal): Promise<MapDetailFeatureCollection> {
    const endpoint = manifest.deltaFeed || DEFAULT_DELTA_FEED;
    if (!endpoint || !window.location.protocol.startsWith("http")) return EMPTY_COLLECTION;
    // Quantize requests so repeated pan/zoom gestures share one durable cache
    // entry instead of generating a new Worker request for every pixel-sized
    // viewport change.
    const bucketZoom = Math.max(5, Math.min(14, Math.floor(zoom)));
    const bucketScale = 2 ** bucketZoom;
    const centerLng = (bounds.west + bounds.east) / 2;
    const centerLat = (bounds.south + bounds.north) / 2;
    const bucketX = Math.floor(((centerLng + 180) / 360) * bucketScale);
    const latitudeRad = centerLat * Math.PI / 180;
    const bucketY = Math.floor((1 - Math.asinh(Math.tan(latitudeRad)) / Math.PI) / 2 * bucketScale);
    const cacheKey = `map-dynamics:delta:${manifest.datasetVersion}:${bucketZoom}:${bucketX}:${bucketY}`;
    const cached = await mapDetailCache.get<MapDetailFeatureCollection>(cacheKey, DELTA_MAX_AGE_MS);
    if (cached && validCollection(cached)) return cached;
    try {
      const url = new URL(endpoint, window.location.href);
      url.searchParams.set("bbox", [bounds.west, bounds.south, bounds.east, bounds.north].map((value) => value.toFixed(6)).join(","));
      url.searchParams.set("zoom", String(Math.max(5, Math.min(22, Math.floor(zoom)))));
      url.searchParams.set("datasetVersion", manifest.datasetVersion);
      const payload = await fetchJson(url.toString(), signal, "no-store");
      const collection = collectionFromDeltaPayload(payload);
      void mapDetailCache.set(cacheKey, collection);
      return collection;
    } catch {
      const stored = await mapDetailCache.peek<MapDetailFeatureCollection>(cacheKey);
      return stored && validCollection(stored) ? stored : EMPTY_COLLECTION;
    }
  }

  private async supplementalCctv(signal?: AbortSignal): Promise<MapDetailFeatureCollection> {
    if (this.supplementalCctvPromise) return this.supplementalCctvPromise;
    this.supplementalCctvPromise = (async () => {
      try {
        const value = await fetchJson(SUPPLEMENTAL_PUBLIC_CCTV_URL, signal, "force-cache");
        return validCollection(value) ? value : EMPTY_COLLECTION;
      } catch {
        return EMPTY_COLLECTION;
      }
    })();
    return this.supplementalCctvPromise;
  }

  private async loadInternal(
    bounds: MapDynamicsBounds,
    zoom: number,
    signal: AbortSignal | undefined,
    manifestRefreshAvailable: boolean,
  ): Promise<MapDynamicsLoadResult> {
    if (![bounds.west, bounds.south, bounds.east, bounds.north, zoom].every(finiteNumber)) {
      return { collection: EMPTY_COLLECTION, manifestVersion: "", selectedShards: 0, loadedShards: 0, remoteDeltas: 0, source: "empty" };
    }
    const { manifest, source } = await this.manifest(signal);
    const candidates = manifest.shards
      .filter((shard) => zoom >= shard.minZoom && zoom <= shard.maxZoom && intersects(bounds, shard.bbox))
      .sort((left, right) =>
        (right.priority || 0) - (left.priority || 0)
        || centerDistance(bounds, left) - centerDistance(bounds, right)
        || left.bytes - right.bytes);
    const preferred = candidates.filter((shard) => (shard.priority || 0) > 0);
    const selected = (preferred.length ? preferred : candidates)
      .slice(0, MAX_ACTIVE_SHARDS);
    let shards: Array<MapDetailFeatureCollection | null>;
    let deltaCollection: MapDetailFeatureCollection;
    let supplementalCctv: MapDetailFeatureCollection;
    try {
      [shards, deltaCollection, supplementalCctv] = await Promise.all([
        Promise.all(selected.map((shard) => this.shard(manifest, shard, signal))),
        this.deltas(manifest, bounds, zoom, signal),
        this.supplementalCctv(signal),
      ]);
    } catch (error) {
      if (manifestRefreshAvailable && error instanceof MapDynamicsHttpError && error.status === 404) {
        await this.manifest(signal, true);
        return this.loadInternal(bounds, zoom, signal, false);
      }
      throw error;
    }
    const available = shards.filter((collection): collection is MapDetailFeatureCollection => Boolean(collection));
    const visibleSupplementalCctv: MapDetailFeatureCollection = {
      type: "FeatureCollection",
      features: zoom >= 14
        ? supplementalCctv.features.filter((feature) => {
          if (feature.geometry.type !== "Point") return false;
          const [lng, lat] = feature.geometry.coordinates as number[];
          return lng >= bounds.west && lng <= bounds.east && lat >= bounds.south && lat <= bounds.north;
        })
        : [],
    };
    const collection = mergedCollections([...available, deltaCollection, visibleSupplementalCctv]);
    return {
      collection,
      manifestVersion: manifest.datasetVersion,
      selectedShards: selected.length,
      loadedShards: available.length,
      remoteDeltas: deltaCollection.features.length,
      source,
    };
  }

  async load(bounds: MapDynamicsBounds, zoom: number, signal?: AbortSignal): Promise<MapDynamicsLoadResult> {
    return this.loadInternal(bounds, zoom, signal, true);
  }
}
