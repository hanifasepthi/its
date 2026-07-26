import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, "public", "data", "map-dynamics");
const SHARD_DIR = path.join(OUTPUT_DIR, "shards");
const INDONESIA_BBOX = [94.5, -11.5, 141.1, 6.5];
const TILE_ZOOM = 10;
const MAX_SHARD_BYTES = 8_000_000;
const MAX_SHARD_FEATURES = 10_000;
const ALLOWED_KINDS = new Set([
  "road", "sidewalk", "median", "cycleway", "pedestrian", "railway", "transit",
  "waterway", "green", "tree_row", "tree", "crossing", "traffic_signal", "school_zone",
  "street_lamp", "traffic_sign", "traffic_camera", "cctv", "speed_camera", "guardrail",
  "barrier", "bollard", "delineator", "speed_bump", "speed_table", "rumble_strip",
  "toll_gate", "traffic_island", "stop_line", "yield_line", "lane_arrow", "bench",
  "waste_basket", "fire_hydrant", "drinking_water", "toilets", "emergency_shelter",
  "entrance", "gate", "elevator", "escalator", "drain", "drain_grate", "manhole",
  "retaining_wall", "seawall", "platform", "taxi_stand", "motorcycle_taxi", "park_ride", "poi",
  "healthcare", "education", "transport", "food", "lodging", "public_service", "attraction",
  "worship", "shopping",
]);

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: npm run map:data:build -- --input verified.geojson [--input verified.ndjson] [--coverage-checkpoint .map-dynamics-ingest/checkpoint.json] [--version 2026-07-21.2]");
  process.exitCode = 1;
}

function argumentsFrom(argv) {
  const inputs = [];
  const inputDirs = [];
  let coverageCheckpoint = "";
  let version = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--input" && argv[index + 1]) inputs.push(path.resolve(ROOT, argv[++index]));
    else if (argv[index] === "--input-dir" && argv[index + 1]) inputDirs.push(path.resolve(ROOT, argv[++index]));
    else if (argv[index] === "--coverage-checkpoint" && argv[index + 1]) coverageCheckpoint = path.resolve(ROOT, argv[++index]);
    else if (argv[index] === "--version" && argv[index + 1]) version = argv[++index];
    else throw new Error(`Argumen tidak dikenal: ${argv[index]}`);
  }
  if (!inputs.length && !inputDirs.length) throw new Error("Minimal satu --input atau --input-dir diperlukan.");
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(version)) throw new Error("Versi dataset tidak valid.");
  return { inputs, inputDirs, version, coverageCheckpoint };
}

function parseInput(text, filename) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (filename.toLowerCase().endsWith(".ndjson")) {
    return trimmed.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try { return JSON.parse(line); }
      catch { throw new Error(`${filename}:${index + 1} bukan JSON valid.`); }
    });
  }
  const parsed = JSON.parse(trimmed);
  if (parsed?.type === "FeatureCollection" && Array.isArray(parsed.features)) return parsed.features;
  if (parsed?.type === "Feature") return [parsed];
  if (Array.isArray(parsed)) return parsed;
  throw new Error(`${filename} harus GeoJSON FeatureCollection, Feature, array, atau NDJSON.`);
}

function coordinatePairs(value, pairs = []) {
  if (!Array.isArray(value)) return pairs;
  if (value.length >= 2 && value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    pairs.push([value[0], value[1]]);
    return pairs;
  }
  value.forEach((child) => coordinatePairs(child, pairs));
  return pairs;
}

function featureBounds(feature) {
  const pairs = coordinatePairs(feature?.geometry?.coordinates);
  if (!pairs.length) throw new Error(`Feature ${feature?.id || "tanpa-id"} tidak mempunyai koordinat valid.`);
  const lngs = pairs.map(([lng]) => lng);
  const lats = pairs.map(([, lat]) => lat);
  const bbox = [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
  if (bbox[0] < -180 || bbox[2] > 180 || bbox[1] < -90 || bbox[3] > 90) {
    throw new Error(`Feature ${feature?.id || "tanpa-id"} mempunyai koordinat di luar bumi.`);
  }
  return bbox;
}

function intersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function tileFor(lng, lat, zoom = TILE_ZOOM) {
  const scale = 2 ** zoom;
  const safeLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const x = Math.floor(((lng + 180) / 360) * scale);
  const radians = safeLat * Math.PI / 180;
  const y = Math.floor((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * scale);
  return { z: zoom, x, y };
}

function verifiedFeature(feature, inputName, index) {
  if (!feature || feature.type !== "Feature" || !feature.geometry || !feature.properties) {
    throw new Error(`${inputName} feature ${index + 1} bukan GeoJSON Feature valid.`);
  }
  if (!["Point", "LineString", "Polygon"].includes(feature.geometry.type)) {
    throw new Error(`${inputName} feature ${index + 1}: geometry ${feature.geometry.type} belum didukung.`);
  }
  const properties = { ...feature.properties };
  const verification = String(properties.verification || properties.confidence || "").toLowerCase();
  if (verification !== "verified") {
    throw new Error(`${inputName} feature ${index + 1} masih observation/candidate; verifikasi sebelum publikasi.`);
  }
  const kind = String(properties.kind || "").trim();
  if (!ALLOWED_KINDS.has(kind)) throw new Error(`${inputName} feature ${index + 1}: kind '${kind}' tidak didukung.`);
  if (kind === "transit") {
    const assembly = String(properties.geometryAssembly || "");
    const unsafeGapAssembly = assembly === "ordered-member-endpoints<=45m"
      || Number(properties.stitchToleranceMeters || 0) > 0
      || Number(properties.stitchGapCount || 0) > 0
      || Number(properties.maxStitchGapMeters || 0) > 0;
    if (unsafeGapAssembly) {
      throw new Error(`${inputName} feature ${index + 1}: geometri transit memakai konektor gap lama; re-ingest dengan shared-node assembly sebelum rebuild.`);
    }
  }
  const source = String(properties.source || properties.sourceName || "").trim();
  const sourceId = String(properties.sourceId || feature.id || "").trim();
  if (!source || !sourceId) throw new Error(`${inputName} feature ${index + 1} wajib mempunyai source dan sourceId/id.`);
  const bbox = featureBounds(feature);
  if (!intersects(bbox, INDONESIA_BBOX)) throw new Error(`${inputName} feature ${index + 1} berada di luar cakupan Indonesia.`);
  properties.verification = "verified";
  properties.source = source.slice(0, 120);
  properties.sourceId = sourceId.slice(0, 180);
  properties.updatedAt = String(properties.updatedAt || new Date().toISOString());
  return { ...feature, id: String(feature.id || `${source}:${sourceId}`), properties, bbox };
}

function unionBounds(features) {
  return features.reduce((bbox, feature) => [
    Math.min(bbox[0], feature.bbox[0]),
    Math.min(bbox[1], feature.bbox[1]),
    Math.max(bbox[2], feature.bbox[2]),
    Math.max(bbox[3], feature.bbox[3]),
  ], [180, 90, -180, -90]);
}

function isBbox(value) {
  return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)
    && value[0] <= value[2] && value[1] <= value[3];
}

function coverageCandidate(value, source) {
  if (!value || value.nationwideProgress !== true) return null;
  const completedCells = Number(value.completedCells);
  const totalCells = Number(value.totalCells);
  if (!Number.isInteger(completedCells) || !Number.isInteger(totalCells)
    || completedCells < 0 || totalCells < 1 || completedCells > totalCells || !isBbox(value.actualBbox)) return null;
  return {
    completedCells,
    totalCells,
    coveragePercent: Number(((completedCells / totalCells) * 100).toFixed(8)),
    ingestedCellBbox: value.actualBbox,
    coverageBasis: "successful-overpass-query-cells",
    progressSource: source,
  };
}

function bestCoverageCandidate(candidates) {
  return candidates.filter(Boolean).sort((left, right) => {
    const leftRatio = left.completedCells / left.totalCells;
    const rightRatio = right.completedCells / right.totalCells;
    return rightRatio - leftRatio || right.completedCells - left.completedCells;
  })[0] || null;
}

function withoutInternalBounds(feature) {
  const { bbox: _bbox, ...clean } = feature;
  return clean;
}

function encodedCollection(features) {
  return JSON.stringify({ type: "FeatureCollection", features: features.map(withoutInternalBounds) });
}

function chunksFor(features) {
  const chunks = [];
  let current = [];
  const envelopeBytes = Buffer.byteLength('{"type":"FeatureCollection","features":[]}');
  let currentBytes = envelopeBytes;
  for (const feature of features) {
    const featureBytes = Buffer.byteLength(JSON.stringify(withoutInternalBounds(feature)));
    if (envelopeBytes + featureBytes > MAX_SHARD_BYTES) {
      throw new Error(`Feature ${feature.id} sendiri melebihi ${MAX_SHARD_BYTES} byte; pecah geometri terlebih dahulu.`);
    }
    const separatorBytes = current.length ? 1 : 0;
    if (current.length && (
      current.length >= MAX_SHARD_FEATURES
      || currentBytes + separatorBytes + featureBytes > MAX_SHARD_BYTES
    )) {
      chunks.push(current);
      current = [feature];
      currentBytes = envelopeBytes + featureBytes;
    } else {
      current.push(feature);
      currentBytes += separatorBytes + featureBytes;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function main() {
  let options;
  try { options = argumentsFrom(process.argv.slice(2)); }
  catch (error) { usage(error.message); return; }

  const verified = [];
  const coverageCandidates = [];
  for (const inputDir of options.inputDirs) {
    const filenames = (await readdir(inputDir))
      .filter((filename) => /\.(?:geo)?json$/i.test(filename))
      .sort();
    options.inputs.push(...filenames.map((filename) => path.join(inputDir, filename)));
  }
  for (const input of options.inputs) {
    const text = await readFile(input, "utf8");
    const features = parseInput(text, input);
    features.forEach((feature, index) => verified.push(verifiedFeature(feature, input, index)));
    if (!input.toLowerCase().endsWith(".ndjson")) {
      const document = JSON.parse(text.trim());
      coverageCandidates.push(coverageCandidate(document?.metadata?.coverage, path.relative(ROOT, input).replaceAll("\\", "/")));
    }
  }
  if (options.coverageCheckpoint) {
    const checkpoint = JSON.parse(await readFile(options.coverageCheckpoint, "utf8"));
    const fromCheckpoint = coverageCandidate(
      { ...(checkpoint?.coverageGrid || {}), nationwideProgress: true },
      path.relative(ROOT, options.coverageCheckpoint).replaceAll("\\", "/"),
    );
    if (!fromCheckpoint) throw new Error("Coverage checkpoint tidak mempunyai completedCells/totalCells/actualBbox yang valid.");
    coverageCandidates.push(fromCheckpoint);
  }
  const unique = new Map();
  verified.forEach((feature) => unique.set(String(feature.id), feature));
  const buckets = new Map();
  [...unique.values()].forEach((feature) => {
    const bbox = feature.bbox;
    const tile = tileFor((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2);
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const bucket = buckets.get(key) || [];
    bucket.push(feature);
    buckets.set(key, bucket);
  });

  await mkdir(SHARD_DIR, { recursive: true });
  const shards = [];
  for (const [tile, features] of [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const parts = chunksFor(features);
    for (let part = 0; part < parts.length; part += 1) {
      const collectionText = encodedCollection(parts[part]);
      const sha256 = createHash("sha256").update(collectionText).digest("hex");
      const relativeStem = `${tile.replaceAll("/", "-")}.${part + 1}.${sha256.slice(0, 12)}`;
      const filename = `${relativeStem}.geojson`;
      await writeFile(path.join(SHARD_DIR, filename), collectionText, "utf8");
      shards.push({
        id: relativeStem,
        url: `./shards/${filename}`,
        bbox: unionBounds(parts[part]),
        minZoom: 5,
        maxZoom: 22,
        groups: [...new Set(parts[part].map((feature) => String(feature.properties.kind)))].sort(),
        featureCount: parts[part].length,
        bytes: Buffer.byteLength(collectionText),
        sha256,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  const trackedCoverage = bestCoverageCandidate(coverageCandidates);
  const manifest = {
    $schema: "./manifest.schema.json",
    schemaVersion: "1.0",
    dataset: "its-map-dynamics-indonesia",
    datasetVersion: options.version,
    generatedAt: new Date().toISOString(),
    featureSchema: "./feature.schema.json",
    tileZoom: TILE_ZOOM,
    coverage: {
      country: "ID",
      bbox: INDONESIA_BBOX,
      mode: "incremental",
      actualBbox: unique.size ? unionBounds([...unique.values()]) : null,
      completedCells: trackedCoverage?.completedCells ?? null,
      totalCells: trackedCoverage?.totalCells ?? null,
      coveragePercent: trackedCoverage?.coveragePercent ?? null,
      ingestedCellBbox: trackedCoverage?.ingestedCellBbox ?? null,
      progressStatus: trackedCoverage ? "tracked" : "not-linked",
      coverageBasis: trackedCoverage?.coverageBasis || "published-feature-bounds-only",
      progressSource: trackedCoverage?.progressSource || null,
    },
    policy: { publish: "verified-only", vision: "observation-before-verification", maxShardBytes: MAX_SHARD_BYTES },
    shards,
    deltaFeed: "https://its.hanifahseptiani45.workers.dev/v1/map/deltas",
  };
  await writeFile(path.join(OUTPUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const referencedShardFiles = new Set(shards.map((shard) => path.basename(shard.url)));
  const shardEntries = await readdir(SHARD_DIR, { withFileTypes: true });
  await Promise.all(shardEntries
    .filter((entry) => entry.isFile()
      && /^\d+-\d+-\d+\.\d+\.[a-f0-9]{12}\.geojson$/i.test(entry.name)
      && !referencedShardFiles.has(entry.name))
    .map((entry) => unlink(path.join(SHARD_DIR, entry.name))));
  console.log(JSON.stringify({ ok: true, inputs: options.inputs.length, features: unique.size, shards: shards.length, version: options.version }, null, 2));
}

await main();
