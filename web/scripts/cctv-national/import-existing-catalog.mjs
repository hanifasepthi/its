import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { browserPlayable, classifyStream } from "./classify.mjs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const input = path.resolve(arg("--in", "public/data/public-cctv.geojson"));
const output = path.resolve(arg("--out", ".cctv-ingest/existing-catalog.ndjson"));

const PROVINCES = [
  "Aceh", "Sumatera Utara", "Sumatera Barat", "Riau", "Kepulauan Riau", "Jambi",
  "Sumatera Selatan", "Kepulauan Bangka Belitung", "Bengkulu", "Lampung", "Banten",
  "DKI Jakarta", "Jawa Barat", "Jawa Tengah", "DI Yogyakarta", "Jawa Timur", "Bali",
  "Nusa Tenggara Barat", "Nusa Tenggara Timur", "Kalimantan Barat", "Kalimantan Tengah",
  "Kalimantan Selatan", "Kalimantan Timur", "Kalimantan Utara", "Sulawesi Utara",
  "Gorontalo", "Sulawesi Tengah", "Sulawesi Barat", "Sulawesi Selatan", "Sulawesi Tenggara",
  "Maluku", "Maluku Utara", "Papua", "Papua Barat", "Papua Barat Daya", "Papua Selatan",
  "Papua Tengah", "Papua Pegunungan",
];

const PLACE_PROVINCES = new Map(Object.entries({
  lampung: "Lampung", banten: "Banten", bekasi: "Jawa Barat", bandung: "Jawa Barat",
  ciamis: "Jawa Barat", cirebon: "Jawa Barat", karawang: "Jawa Barat", purwakarta: "Jawa Barat",
  subang: "Jawa Barat", sumedang: "Jawa Barat", banyumas: "Jawa Tengah", banjarnegara: "Jawa Tengah",
  brebes: "Jawa Tengah", demak: "Jawa Tengah", magelang: "Jawa Tengah", pati: "Jawa Tengah",
  pekalongan: "Jawa Tengah", purworejo: "Jawa Tengah", rembang: "Jawa Tengah", semarang: "Jawa Tengah",
  surakarta: "Jawa Tengah", sleman: "DI Yogyakarta", yogyakarta: "DI Yogyakarta",
  banyuwangi: "Jawa Timur", bojonegoro: "Jawa Timur", jember: "Jawa Timur", jombang: "Jawa Timur",
  kediri: "Jawa Timur", lamongan: "Jawa Timur", pacitan: "Jawa Timur", pasuruan: "Jawa Timur",
  ponorogo: "Jawa Timur", sidoarjo: "Jawa Timur", trenggalek: "Jawa Timur", tulungagung: "Jawa Timur",
  jembrana: "Bali", palembang: "Sumatera Selatan", "kubu raya": "Kalimantan Barat",
  poso: "Sulawesi Tengah", banggai: "Sulawesi Tengah", kolaka: "Sulawesi Tenggara",
}));

function inferProvince(properties) {
  if (PROVINCES.includes(properties.province)) return properties.province;
  const haystack = [properties.name, properties.address, properties.region, properties.city]
    .filter(Boolean).join(" ").toLowerCase();
  for (const province of [...PROVINCES].sort((a, b) => b.length - a.length)) {
    if (haystack.includes(province.toLowerCase())) return province;
  }
  for (const [place, province] of PLACE_PROVINCES) {
    if (haystack.includes(place)) return province;
  }
  return "Indonesia";
}

function streamType(properties, url) {
  const declared = String(properties.mediaFormat || "").toLowerCase();
  if (declared === "mjpeg" || declared === "mjpg") return "mjpeg";
  if (["hls", "dash", "mp4", "webm", "jpeg", "youtube"].includes(declared)) return declared;
  const classified = classifyStream(url, properties.mimeType || "", "");
  return classified === "unknown" && /^https?:/i.test(url) ? "html-page" : classified;
}

const document = JSON.parse(await readFile(input, "utf8"));
const rows = [];
for (const feature of document.features || []) {
  const properties = feature?.properties || {};
  const url = String(properties.streamUrl || properties.publicUrl || "").trim();
  if (!url) continue;
  const type = streamType(properties, url);
  if (!browserPlayable(type)) continue;
  const coordinates = Array.isArray(feature?.geometry?.coordinates)
    ? { longitude: Number(feature.geometry.coordinates[0]), latitude: Number(feature.geometry.coordinates[1]) }
    : null;
  rows.push({
    id: `cctv:${createHash("sha256").update(`${properties.catalogSourceKey || properties.operator || "catalog"}\n${url}`).digest("hex").slice(0, 24)}`,
    name: properties.name || "CCTV publik",
    region: inferProvince(properties),
    subregion: properties.city || properties.region || "",
    operator: properties.operator || properties.source || "",
    sourceUrl: properties.sourceUrl || properties.sourceEvidenceUrl || url,
    pageUrl: properties.publicUrl || properties.sourceUrl || url,
    streamUrl: url,
    streamType: type,
    browserPlayable: true,
    streamStatus: /verified-live/i.test(properties.streamStatus || "") ? "live" : "discovered",
    verification: properties.verification || "catalog-import",
    coordinates,
    attribution: properties.attribution || "",
    discoveredAt: properties.updatedAt || new Date().toISOString(),
  });
}

await writeFile(output, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
const regions = Object.entries(rows.reduce((result, row) => {
  result[row.region] = (result[row.region] || 0) + 1;
  return result;
}, {})).sort(([a], [b]) => a.localeCompare(b, "id"));
console.log(JSON.stringify({ input, output, imported: rows.length, regions }, null, 2));
