import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  loadCheckpoint,
  loadRegions,
  selectCoverageGridRegion,
} from "./ingest-map-dynamics-overpass.mjs";

const ROOT = process.cwd();
const MANIFEST_PATH = path.join(ROOT, "public", "data", "map-dynamics", "manifest.json");
const REGIONS_PATH = path.join(ROOT, "scripts", "map-dynamics-ingest", "regions.json");
const CHECKPOINT_PATH = path.join(ROOT, ".map-dynamics-ingest", "checkpoint.json");

function coversPoint(bbox, [longitude, latitude]) {
  return longitude >= bbox[0] && longitude <= bbox[2]
    && latitude >= bbox[1] && latitude <= bbox[3];
}

// Exact for a union of axis-aligned rectangles: partition edges divide the
// target into atomic rectangles, so one midpoint per atom proves coverage.
function bboxCoveredByUnion(target, partitions) {
  const boundaries = (axis) => [...new Set([
    target[axis], target[axis + 2],
    ...partitions.flatMap((partition) => [partition.bbox[axis], partition.bbox[axis + 2]])
      .filter((coordinate) => coordinate > target[axis] && coordinate < target[axis + 2]),
  ])].sort((left, right) => left - right);
  const longitudes = boundaries(0);
  const latitudes = boundaries(1);
  for (let x = 0; x < longitudes.length - 1; x += 1) {
    for (let y = 0; y < latitudes.length - 1; y += 1) {
      const midpoint = [
        (longitudes[x] + longitudes[x + 1]) / 2,
        (latitudes[y] + latitudes[y + 1]) / 2,
      ];
      if (!partitions.some((partition) => coversPoint(partition.bbox, midpoint))) return false;
    }
  }
  return true;
}

const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
const regionConfig = await loadRegions(REGIONS_PATH);
const checkpoint = await loadCheckpoint(CHECKPOINT_PATH);
const enabledPartitions = regionConfig.coverageGrid.partitions.filter((partition) => partition.enabled);
const queue = selectCoverageGridRegion(regionConfig.regions, regionConfig.coverageGrid, checkpoint, 25);

const intendedEnvelopeBlocks = [
  { id: "sumatra-riau", bbox: [94.5, -6.5, 105.0, 6.5] },
  { id: "java-kalimantan", bbox: [105.0, -9.5, 115.0, 6.5] },
  { id: "kangean-kalimantan", bbox: [115.0, -11.5, 119.0, 6.5] },
  { id: "nusa-tenggara-east", bbox: [119.0, -11.5, 125.5, -7.5] },
  { id: "sulawesi", bbox: [119.0, -7.5, 126.0, 6.5] },
  { id: "maluku-papua", bbox: [126.0, -11.5, 141.1, 6.5] },
];
const envelopeChecks = intendedEnvelopeBlocks.map((block) => ({
  id: block.id,
  bbox: block.bbox,
  covered: bboxCoveredByUnion(block.bbox, enabledPartitions),
}));
if (envelopeChecks.some((check) => !check.covered)) {
  throw new Error(`Coverage partition mempunyai gap: ${envelopeChecks.filter((check) => !check.covered).map((check) => check.id).join(", ")}`);
}

const anchors = [
  { id: "Sabang", coordinate: [95.32, 5.89] },
  { id: "Natuna", coordinate: [108.0, 3.9] },
  { id: "Kangean", coordinate: [115.3, -6.9] },
  { id: "Sapeken", coordinate: [115.7, -7.0] },
  { id: "Rote", coordinate: [123.1, -10.8] },
  { id: "Miangas", coordinate: [126.58, 5.56] },
  { id: "Merauke", coordinate: [140.4, -8.5] },
].map((anchor) => ({
  ...anchor,
  covered: enabledPartitions.some((partition) => coversPoint(partition.bbox, anchor.coordinate)),
}));
if (anchors.some((anchor) => !anchor.covered)) {
  throw new Error(`Coverage partition kehilangan anchor: ${anchors.filter((anchor) => !anchor.covered).map((anchor) => anchor.id).join(", ")}`);
}

const kindCounts = {};
let publishedBytes = 0;
let publishedFeatures = 0;
for (const shard of manifest.shards) {
  const shardPath = path.resolve(path.dirname(MANIFEST_PATH), shard.url);
  const [document, details] = await Promise.all([
    readFile(shardPath, "utf8").then(JSON.parse),
    stat(shardPath),
  ]);
  publishedBytes += details.size;
  publishedFeatures += document.features.length;
  for (const feature of document.features) {
    const kind = String(feature.properties?.kind || "unknown");
    kindCounts[kind] = (kindCounts[kind] || 0) + 1;
  }
}

const tracked = manifest.coverage?.progressStatus === "tracked";
if (!tracked && (manifest.coverage?.completedCells !== null
  || manifest.coverage?.totalCells !== null || manifest.coverage?.coveragePercent !== null)) {
  throw new Error("Manifest not-linked harus memakai null untuk completedCells, totalCells, dan coveragePercent.");
}
const completedCells = Number.isInteger(checkpoint.coverageGrid?.completedCells)
  ? checkpoint.coverageGrid.completedCells : 0;
const nationwideComplete = tracked
  && manifest.coverage.completedCells === manifest.coverage.totalCells
  && manifest.coverage.coveragePercent === 100;

console.log(JSON.stringify({
  ok: true,
  nationwideComplete,
  completionClaim: nationwideComplete ? "tracked-complete" : "not-complete",
  published: {
    shards: manifest.shards.length,
    features: publishedFeatures,
    bytes: publishedBytes,
    actualBbox: manifest.coverage.actualBbox,
    kinds: Object.fromEntries(Object.entries(kindCounts).sort(([left], [right]) => left.localeCompare(right))),
  },
  progress: {
    manifestStatus: manifest.coverage.progressStatus,
    completedCells: tracked ? manifest.coverage.completedCells : null,
    totalCells: tracked ? manifest.coverage.totalCells : null,
    coveragePercent: tracked ? manifest.coverage.coveragePercent : null,
    checkpointCompletedCells: completedCells,
    checkpointCursor: checkpoint.coverageGridCursor,
  },
  queue: {
    priorityCells: queue.coverage.priorityCells,
    virtualCells: queue.coverage.virtualCells,
    totalCells: queue.coverage.totalCells,
    nextCell: queue.region.id,
    nextCellNumber: queue.coverage.currentCell,
  },
  partitionIntegrity: {
    enabledPartitions: enabledPartitions.length,
    intendedEnvelopeBlocks: envelopeChecks,
    representativeAnchors: anchors,
    note: "Envelope/anchor checks audit queue geometry; they do not claim that every cell has been fetched or field-verified.",
  },
}, null, 2));
