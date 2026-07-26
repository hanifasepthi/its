export type PublicMapGeometry = {
  type: "Point" | "MultiPoint" | "LineString" | "MultiLineString" | "Polygon" | "MultiPolygon";
  coordinates: unknown;
};

export type PublicMapFeatureInput = {
  type: "Feature";
  id: string;
  properties: Record<string, unknown>;
  geometry: PublicMapGeometry | null;
};

export type PublicMapRecordInput = {
  kind: "shard" | "delta";
  id: string;
  dataset: string;
  revision: number;
  generatedAt: string;
  storedAt: string;
  checksum: string;
  provenance: {
    source: string;
    sourceUrl?: string;
    license: string;
    capturedAt: string;
    verifiedAt: string;
    verifiedBy: string;
    method: string;
    sourceChecksum?: string;
    observationBatchIds: string[];
  };
  features: PublicMapFeatureInput[];
};

export type PublishedMapFeature = {
  type: "Feature";
  id: string;
  properties: Record<string, unknown>;
  geometry: {
    type: "Point" | "LineString" | "Polygon";
    coordinates: unknown;
  };
};

export type PublishedFeatureResult = {
  features: PublishedMapFeature[];
  sourceFeatureCount: number;
  omittedDeletes: number;
  truncated: boolean;
};

const PUBLIC_SOURCE = "its-map-data";

function operationOf(feature: PublicMapFeatureInput): string {
  return String(feature.properties.operation || "upsert").trim().toLowerCase();
}

function elementaryGeometries(geometry: PublicMapGeometry): PublishedMapFeature["geometry"][] {
  if (geometry.type === "Point" || geometry.type === "LineString" || geometry.type === "Polygon") {
    return [{ type: geometry.type, coordinates: geometry.coordinates }];
  }
  if (!Array.isArray(geometry.coordinates)) return [];
  if (geometry.type === "MultiPoint") {
    return geometry.coordinates.map((coordinates) => ({ type: "Point", coordinates }));
  }
  if (geometry.type === "MultiLineString") {
    return geometry.coordinates.map((coordinates) => ({ type: "LineString", coordinates }));
  }
  return geometry.coordinates.map((coordinates) => ({ type: "Polygon", coordinates }));
}

function publicSourceId(record: PublicMapRecordInput, feature: PublicMapFeatureInput, partIndex: number, multipart: boolean): string {
  const base = `${record.dataset}:${feature.id}`;
  return multipart ? `${base}:part:${partIndex}` : base;
}

function publicProperties(
  record: PublicMapRecordInput,
  feature: PublicMapFeatureInput,
  sourceId: string,
): Record<string, unknown> {
  const provenance = {
    recordId: record.id,
    source: record.provenance.source,
    license: record.provenance.license,
    capturedAt: record.provenance.capturedAt,
    verifiedAt: record.provenance.verifiedAt,
    method: record.provenance.method,
  };
  return {
    ...feature.properties,
    operation: "upsert",
    verification: "verified",
    source: PUBLIC_SOURCE,
    sourceId,
    sourceName: record.provenance.source,
    revision: record.revision,
    updatedAt: record.storedAt,
    generatedAt: record.generatedAt,
    dataset: record.dataset,
    recordId: record.id,
    recordKind: record.kind,
    recordChecksum: record.checksum,
    provenance,
  };
}

/**
 * Converts authenticated records into the exact, verified-only GeoJSON contract
 * consumed by MapDynamicsLoader. Security fields are always derived from the
 * record envelope and deliberately overwrite conflicting feature properties.
 */
export function publishedFeaturesFromRecord(
  record: PublicMapRecordInput,
  maximumFeatures = Number.MAX_SAFE_INTEGER,
): PublishedFeatureResult {
  const limit = Math.max(0, Math.floor(maximumFeatures));
  const features: PublishedMapFeature[] = [];
  let omittedDeletes = 0;
  let truncated = false;

  for (const feature of record.features) {
    if (!feature.geometry || operationOf(feature) === "delete") {
      omittedDeletes += 1;
      continue;
    }
    const geometries = elementaryGeometries(feature.geometry);
    const multipart = feature.geometry.type.startsWith("Multi");
    for (let partIndex = 0; partIndex < geometries.length; partIndex += 1) {
      if (features.length >= limit) {
        truncated = true;
        break;
      }
      const sourceId = publicSourceId(record, feature, partIndex, multipart);
      features.push({
        type: "Feature",
        id: `${PUBLIC_SOURCE}:${sourceId}`,
        properties: publicProperties(record, feature, sourceId),
        geometry: geometries[partIndex],
      });
    }
    if (truncated) break;
  }

  return {
    features,
    sourceFeatureCount: record.features.length,
    omittedDeletes,
    truncated,
  };
}
