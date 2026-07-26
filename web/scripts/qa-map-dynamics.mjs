import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const manifestPath = path.join(root, "public", "data", "map-dynamics", "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const requiredKinds = ["roads", "railways", "transit", "waterways"];

if (manifest.schemaVersion !== "1.0") throw new Error("schemaVersion map dynamics harus 1.0");
if (manifest.dataset !== "its-map-dynamics-indonesia") throw new Error("dataset map dynamics salah");
if (manifest.coverage?.country !== "ID") throw new Error("cakupan negara harus ID");
if (!Array.isArray(manifest.coverage?.actualBbox) || manifest.coverage.actualBbox.length !== 4) {
  throw new Error("actualBbox dataset harus membatasi fitur yang benar-benar dipublikasikan");
}
if (manifest.coverage.progressStatus === "tracked") {
  const { completedCells, totalCells, coveragePercent } = manifest.coverage;
  if (!Number.isInteger(totalCells) || totalCells < 1
    || !Number.isInteger(completedCells) || completedCells < 0 || completedCells > totalCells
    || Math.abs(coveragePercent - Number(((completedCells / totalCells) * 100).toFixed(8))) > 1e-8) {
    throw new Error("completedCells/totalCells/coveragePercent tidak konsisten");
  }
} else if (manifest.coverage.progressStatus !== "not-linked"
  || manifest.coverage.completedCells !== null || manifest.coverage.totalCells !== null
  || manifest.coverage.coveragePercent !== null) {
  throw new Error("Progress tanpa checkpoint harus eksplisit null; tidak boleh direkayasa");
}
if (manifest.featureSchema !== "./feature.schema.json") throw new Error("feature schema belum ditautkan");
if (manifest.policy?.publish !== "verified-only") throw new Error("hanya data verified yang boleh dipublikasikan");
if (manifest.policy?.vision !== "observation-before-verification") throw new Error("hasil vision harus masuk tahap observation");
if (!Array.isArray(manifest.shards)) throw new Error("shards harus array");
if (!String(manifest.deltaFeed || "").startsWith("https://its.hanifahseptiani45.workers.dev/")) throw new Error("delta feed Cloudflare belum terhubung");

for (const shard of manifest.shards) {
  if (!Array.isArray(shard.bbox) || shard.bbox.length !== 4) throw new Error(`bbox ${shard.id} tidak valid`);
  if (shard.bytes > manifest.policy.maxShardBytes) throw new Error(`shard ${shard.id} terlalu besar`);
  const file = path.resolve(path.dirname(manifestPath), shard.url);
  const collection = JSON.parse(await readFile(file, "utf8"));
  if (collection.type !== "FeatureCollection") throw new Error(`shard ${shard.id} bukan FeatureCollection`);
  if (collection.features.some((feature) => feature.properties?.verification !== "verified")) {
    throw new Error(`shard ${shard.id} memuat observation yang belum diverifikasi`);
  }
}

const allShardBounds = manifest.shards.reduce((bbox, shard) => [
  Math.min(bbox[0], shard.bbox[0]), Math.min(bbox[1], shard.bbox[1]),
  Math.max(bbox[2], shard.bbox[2]), Math.max(bbox[3], shard.bbox[3]),
], [180, 90, -180, -90]);
if (manifest.shards.length && allShardBounds.some((coordinate, index) => coordinate !== manifest.coverage.actualBbox[index])) {
  throw new Error("actualBbox harus sama dengan union bbox shard yang terbit");
}

const featureSchema = JSON.parse(await readFile(path.join(path.dirname(manifestPath), "feature.schema.json"), "utf8"));
const kindEnum = featureSchema?.$defs?.properties?.properties?.kind?.enum || [];
if (!kindEnum.includes("poi")) throw new Error("Feature schema belum mendukung POI icon-ready");

console.log(JSON.stringify({
  ok: true,
  datasetVersion: manifest.datasetVersion,
  shards: manifest.shards.length,
  features: manifest.shards.reduce((sum, shard) => sum + shard.featureCount, 0),
  baselineGroups: requiredKinds,
}, null, 2));
