import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const root = process.cwd();

async function importTypeScriptModule(filePath) {
  const source = await readFile(filePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
    },
    fileName: filePath,
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`;
  return import(moduleUrl);
}

const helperPath = path.join(root, "src", "mapDataPublic.ts");
const policyPath = path.resolve(root, "..", "src", "map-detail", "MapDynamicsPolicy.ts");
const [{ publishedFeaturesFromRecord }, { selectVerifiedMapDynamics }] = await Promise.all([
  importTypeScriptModule(helperPath),
  importTypeScriptModule(policyPath),
]);

const record = {
  kind: "delta",
  id: "jakarta-roads-14-13053-8475",
  dataset: "roads",
  revision: 7,
  generatedAt: "2026-07-20T12:00:00.000Z",
  storedAt: "2026-07-21T03:00:00.000Z",
  checksum: "server-checksum",
  provenance: {
    source: "Dinas Bina Marga DKI Jakarta",
    sourceUrl: "https://example.go.id/data-jalan",
    license: "Open government data",
    capturedAt: "2026-07-20T10:00:00.000Z",
    verifiedAt: "2026-07-21T03:00:00.000Z",
    verifiedBy: "reviewer-1",
    method: "manual-review",
    observationBatchIds: [],
  },
  features: [
    {
      type: "Feature",
      id: "segment-42",
      properties: {
        kind: "road",
        name: "Jalan QA",
        operation: "upsert",
        verification: "observation",
        source: "client-forged-source",
        sourceId: "client-forged-id",
        revision: 999,
        updatedAt: "2099-01-01T00:00:00.000Z",
        dataset: "forged",
        provenance: { source: "forged" },
      },
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [[106.8, -6.2], [106.81, -6.21]],
          [[106.81, -6.21], [106.82, -6.22]],
        ],
      },
    },
    {
      type: "Feature",
      id: "removed-segment",
      properties: { kind: "road", operation: "delete" },
      geometry: null,
    },
  ],
};

const first = publishedFeaturesFromRecord(record, 10);
const second = publishedFeaturesFromRecord(record, 10);
assert.deepEqual(first, second, "normalisasi publik harus deterministik");
assert.equal(first.features.length, 2, "MultiLineString harus menjadi dua LineString yang dapat dimuat frontend");
assert.equal(first.omittedDeletes, 1, "tombstone delete tidak boleh menjadi feature GeoJSON renderable");
assert.equal(first.truncated, false);

for (const [index, feature] of first.features.entries()) {
  assert.equal(feature.geometry.type, "LineString");
  assert.equal(feature.id, `its-map-data:roads:segment-42:part:${index}`);
  assert.equal(feature.properties.verification, "verified");
  assert.equal(feature.properties.source, "its-map-data");
  assert.equal(feature.properties.sourceId, `roads:segment-42:part:${index}`);
  assert.equal(feature.properties.revision, 7);
  assert.equal(feature.properties.updatedAt, record.storedAt);
  assert.equal(feature.properties.dataset, "roads");
  assert.deepEqual(feature.properties.provenance, {
    recordId: record.id,
    source: record.provenance.source,
    license: record.provenance.license,
    capturedAt: record.provenance.capturedAt,
    verifiedAt: record.provenance.verifiedAt,
    method: record.provenance.method,
  });
}

const limited = publishedFeaturesFromRecord(record, 1);
assert.equal(limited.features.length, 1);
assert.equal(limited.truncated, true, "guardrail feature harus terdeteksi setelah ekspansi multipart");

const policySelection = selectVerifiedMapDynamics(
  { type: "FeatureCollection", features: first.features },
  { west: 106.7, south: -6.3, east: 106.9, north: -6.1 },
  10,
);
assert.equal(policySelection.stats.verified, 2, "FeatureCollection Worker harus diterima MapDynamicsPolicy frontend");
assert.equal(policySelection.stats.rejectedInvalid, 0);
assert.equal(policySelection.stats.rejectedUnverified, 0);

process.stdout.write(`Map data public contract QA passed: features=${first.features.length}, deletes=${first.omittedDeletes}\n`);
