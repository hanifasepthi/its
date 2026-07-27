import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "public", "data", "map-dynamics", "manifest.json");
const shardRoot = path.join(root, "public", "data", "map-dynamics", "shards");
const outputRoot = path.join(root, "public", "data", "map-hotspots");

const hotspots = [
  ["jakarta-pusat-monas", 106.815, -6.19, 106.84, -6.17],
  ["bandung-telkom", 107.615, -6.988, 107.647, -6.963],
  ["surabaya-pusat", 112.70, -7.30, 112.78, -7.22],
  ["semarang-pusat", 110.38, -7.02, 110.46, -6.94],
  ["yogyakarta-pusat", 110.33, -7.83, 110.40, -7.75],
  ["medan-pusat", 98.64, 3.55, 98.72, 3.63],
  ["palembang-pusat", 104.72, -3.02, 104.80, -2.94],
  ["bandar-lampung", 105.22, -5.43, 105.30, -5.35],
  ["pontianak-pusat", 109.30, -0.07, 109.38, 0.01],
  ["banjarmasin-pusat", 114.55, -3.36, 114.65, -3.26],
  ["samarinda-pusat", 117.10, -0.55, 117.20, -0.45],
  ["makassar-pusat", 119.38, -5.19, 119.47, -5.10],
  ["manado-pusat", 124.81, 1.44, 124.89, 1.52],
  ["denpasar-pusat", 115.18, -8.70, 115.26, -8.62],
  ["mataram-pusat", 116.07, -8.62, 116.15, -8.54],
  ["kupang-pusat", 123.56, -10.22, 123.66, -10.12],
  ["jayapura-pusat", 140.66, -2.59, 140.75, -2.51],
  ["sorong-pusat", 131.23, -0.92, 131.33, -0.82],
].map(([name, west, south, east, north]) => ({
  id: `hotspot-${name}-v1`,
  file: `${name}.geojson`,
  bbox: [west, south, east, north],
  minZoom: 15,
  maxZoom: 22,
  priority: 100,
}));

function geometryTouchesBbox(geometry, bbox) {
  let matches = false;
  const walk = (coordinates) => {
    if (matches || !Array.isArray(coordinates)) return;
    if (typeof coordinates[0] === "number") {
      const [lng, lat] = coordinates;
      matches = lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
      return;
    }
    coordinates.forEach(walk);
  };
  walk(geometry?.coordinates);
  return matches;
}

function stableFeatureKey(feature) {
  return String(feature.id || feature.properties?.id
    || crypto.createHash("sha1").update(JSON.stringify(feature.geometry)).digest("hex"));
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
fs.mkdirSync(outputRoot, { recursive: true });
const featureMaps = new Map(hotspots.map((hotspot) => [hotspot.id, new Map()]));
const sourceCounts = new Map(hotspots.map((hotspot) => [hotspot.id, 0]));

for (const shard of manifest.shards.filter((item) => item.url.startsWith("./shards/"))) {
  const relevant = hotspots.filter((hotspot) =>
    shard.bbox[0] <= hotspot.bbox[2] && shard.bbox[2] >= hotspot.bbox[0]
    && shard.bbox[1] <= hotspot.bbox[3] && shard.bbox[3] >= hotspot.bbox[1]);
  if (!relevant.length) continue;
  const shardPath = path.join(shardRoot, path.basename(shard.url));
  if (!fs.existsSync(shardPath)) continue;
  const collection = JSON.parse(fs.readFileSync(shardPath, "utf8"));
  for (const hotspot of relevant) {
    sourceCounts.set(hotspot.id, (sourceCounts.get(hotspot.id) || 0) + 1);
    const features = featureMaps.get(hotspot.id);
    for (const feature of collection.features || []) {
      if (geometryTouchesBbox(feature.geometry, hotspot.bbox)) {
        features.set(stableFeatureKey(feature), feature);
      }
    }
  }
}

for (const hotspot of hotspots) {
  const features = featureMaps.get(hotspot.id);
  const collection = {
    type: "FeatureCollection",
    name: hotspot.id,
    bbox: hotspot.bbox,
    features: [...features.values()],
  };
  const body = `${JSON.stringify(collection)}\n`;
  const outputPath = path.join(outputRoot, hotspot.file);
  fs.writeFileSync(outputPath, body);
  const groups = [...new Set(collection.features.map((feature) => String(feature.properties?.kind || "poi")))].sort();
  const entry = {
    id: hotspot.id,
    url: `../map-hotspots/${hotspot.file}`,
    bbox: hotspot.bbox,
    minZoom: hotspot.minZoom,
    maxZoom: hotspot.maxZoom,
    groups,
    featureCount: collection.features.length,
    bytes: Buffer.byteLength(body),
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
    updatedAt: new Date().toISOString(),
    priority: hotspot.priority,
  };
  manifest.shards = manifest.shards.filter((shard) => shard.id !== hotspot.id);
  manifest.shards.unshift(entry);
  console.log(`${hotspot.id}: ${entry.featureCount} features, ${entry.bytes} bytes from ${sourceCounts.get(hotspot.id)} source shards`);
}

manifest.generatedAt = new Date().toISOString();
manifest.datasetVersion = `${manifest.datasetVersion.replace(/\.hotspot\d+$/, "")}.hotspot18`;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
