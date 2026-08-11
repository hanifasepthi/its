import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const dataDir = path.resolve(arg("--data", "public/data/cctv-national"));
const catalogPath = path.resolve(arg("--catalog", "public/data/public-cctv.geojson"));
const dryRun = process.argv.includes("--dry-run");

const text = (value) => String(value || "").trim();
const normalizedUrl = (value) => text(value).replace(/[?&](?:t|s|cache|refresh)=[^&]*/gi, "").toLowerCase();
const coordinatePair = (row) => {
  const longitude = Number(row?.coordinates?.longitude ?? row?.coordinates?.lng);
  const latitude = Number(row?.coordinates?.latitude ?? row?.coordinates?.lat);
  return Number.isFinite(longitude) && Number.isFinite(latitude)
    && longitude >= 95 && longitude <= 141 && latitude >= -11 && latitude <= 6
    ? [longitude, latitude]
    : null;
};

function featureId(row) {
  const supplied = text(row.id).replace(/^cctv:/i, "cctv-national-");
  if (/^[a-z0-9][a-z0-9:_-]{7,120}$/i.test(supplied)) return supplied;
  return `cctv-national-${createHash("sha256").update(`${row.sourceUrl || ""}\n${row.streamUrl || ""}`).digest("hex").slice(0, 24)}`;
}

function mediaFormat(type) {
  if (type === "html-page") return "iframe";
  return type === "jpeg" ? "image" : type;
}

const manifest = JSON.parse(await readFile(path.join(dataDir, "manifest.json"), "utf8"));
const current = JSON.parse(await readFile(catalogPath, "utf8"));
const existingByUrl = new Map();
for (const feature of current.features || []) {
  const properties = feature?.properties || {};
  for (const url of [properties.streamUrl, properties.publicUrl, properties.sourceUrl]) {
    const key = normalizedUrl(url);
    if (key && !existingByUrl.has(key)) existingByUrl.set(key, feature);
  }
}

const promoted = [];
const ids = new Set();
let skippedWithoutCoordinates = 0;
for (const region of manifest.regions || []) {
  for (let page = 1; page <= Number(region.pageCount || 0); page += 1) {
    const filename = `page-${String(page).padStart(4, "0")}.json`;
    const document = JSON.parse(await readFile(path.join(dataDir, "regions", region.slug, filename), "utf8"));
    for (const row of document.records || []) {
      const existing = existingByUrl.get(normalizedUrl(row.streamUrl));
      const coordinates = coordinatePair(row) || existing?.geometry?.coordinates;
      if (!Array.isArray(coordinates) || coordinates.length < 2) {
        skippedWithoutCoordinates += 1;
        continue;
      }
      let id = existing?.id || featureId(row);
      if (ids.has(id)) id = `${id}-${createHash("sha256").update(text(row.streamUrl)).digest("hex").slice(0, 8)}`;
      ids.add(id);
      const prior = existing?.properties || {};
      const directMedia = text(row.streamType).toLowerCase() !== "html-page";
      const live = directMedia && /^(?:live|reachable)$/i.test(text(row.streamStatus));
      promoted.push({
        type: "Feature",
        id,
        geometry: { type: "Point", coordinates: [Number(coordinates[0]), Number(coordinates[1])] },
        properties: {
          ...prior,
          kind: "cctv",
          name: text(row.name) || text(prior.name) || "CCTV publik",
          address: text(prior.address) || text(row.subregion) || text(row.region),
          operator: text(row.operator) || text(prior.operator) || "Pengelola sumber publik",
          source: text(prior.source) || text(row.operator) || "Direktori CCTV publik",
          attribution: text(row.attribution) || text(prior.attribution) || `Sumber publik: ${text(row.operator) || text(row.sourceUrl)}`,
          catalogSourceKey: text(prior.catalogSourceKey) || `national-${text(row.verification) || "public"}`,
          sourceId: text(prior.sourceId) || text(row.officialRecordId) || text(row.id),
          sourceUrl: text(row.sourceUrl) || text(prior.sourceUrl) || text(row.streamUrl),
          publicUrl: text(row.pageUrl) || text(prior.publicUrl) || text(row.streamUrl),
          streamUrl: text(row.streamUrl),
          mediaFormat: mediaFormat(text(row.streamType).toLowerCase()),
          mimeType: text(row.contentType) || text(prior.mimeType),
          streamStatus: live ? "verified-live" : "public-page",
          verification: text(row.verification) || text(prior.verification) || "public-catalog",
          updatedAt: text(row.lastCheckedAt) || text(row.discoveredAt) || text(prior.updatedAt) || manifest.generatedAt,
          region: text(row.region) || text(prior.region),
          province: text(row.region) || text(prior.province),
          city: text(row.subregion) || text(prior.city),
        },
      });
    }
  }
}

promoted.sort((left, right) => String(left.id).localeCompare(String(right.id), "en"));
const output = {
  ...current,
  features: promoted,
  updatedAt: manifest.generatedAt || new Date().toISOString(),
  metadata: {
    ...(current.metadata || {}),
    nationalCatalogFeatureCount: Number(manifest.featureCount || 0),
    promotedFeatureCount: promoted.length,
    skippedWithoutCoordinates,
    promotionSource: "public/data/cctv-national",
  },
};

if (!dryRun) await writeFile(catalogPath, `${JSON.stringify(output)}\n`, "utf8");
console.log(JSON.stringify({
  ok: true,
  dryRun,
  sourceFeatureCount: Number(manifest.featureCount || 0),
  promotedFeatureCount: promoted.length,
  skippedWithoutCoordinates,
  catalogPath,
}, null, 2));
