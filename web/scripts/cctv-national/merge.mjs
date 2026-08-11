import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const inputs = arg("--in", ".cctv-ingest/candidates.ndjson,.cctv-ingest/opencctv.ndjson")
  .split(",").map((value) => path.resolve(value.trim())).filter(Boolean);
const output = path.resolve(arg("--out", ".cctv-ingest/merged.ndjson"));
const mediaTypes = new Set(["hls", "dash", "mp4", "webm", "mpegts", "mjpeg", "jpeg", "youtube", "html-page"]);
const junk = /(?:\.css|\.js|\.woff2?|\.ttf|\.png|\.svg|logo|favicon|twitter\.com|facebook\.com|instagram\.com)(?:$|[?#/])/i;
const REGION_ALIASES = new Map(Object.entries({
  "central java": "Jawa Tengah", "east java": "Jawa Timur", "west java": "Jawa Barat",
  "special region of yogyakarta": "DI Yogyakarta", "jakarta special capital region": "DKI Jakarta",
  "north sumatra": "Sumatera Utara", "south sumatra": "Sumatera Selatan",
  "riau islands": "Kepulauan Riau", "south kalimantan": "Kalimantan Selatan",
  "central kalimantan": "Kalimantan Tengah", "west nusa tenggara": "Nusa Tenggara Barat",
  "tulang bawang": "Lampung", "tulang bawang barat": "Lampung", "jembrana": "Bali",
  "kabupaten tangerang": "Banten", "kota bandung": "Jawa Barat", "kota banjarmasin": "Kalimantan Selatan",
  "kota denpasar": "Bali", "kota pontianak": "Kalimantan Barat", "kota yogyakarta": "DI Yogyakarta",
  "jalan tol manado-bitung, sulawesi utara": "Sulawesi Utara", "kabupaten asahan": "Sumatera Utara",
  "kabupaten bandung barat": "Jawa Barat", "kabupaten banyumas": "Jawa Tengah",
  "kabupaten buleleng": "Bali", "kabupaten cianjur": "Jawa Barat", "kabupaten grobogan": "Jawa Tengah",
  "kabupaten kuningan": "Jawa Barat", "kabupaten sukoharjo": "Jawa Tengah",
  "kota banjarbaru": "Kalimantan Selatan", "kota kediri": "Jawa Timur", "kota magelang": "Jawa Tengah",
  "kota surakarta": "Jawa Tengah", "kota tasikmalaya": "Jawa Barat",
}));
const CANONICAL_PROVINCES = new Set([
  "Aceh", "Sumatera Utara", "Sumatera Barat", "Riau", "Kepulauan Riau", "Jambi",
  "Sumatera Selatan", "Kepulauan Bangka Belitung", "Bengkulu", "Lampung", "Banten",
  "DKI Jakarta", "Jawa Barat", "Jawa Tengah", "DI Yogyakarta", "Jawa Timur", "Bali",
  "Nusa Tenggara Barat", "Nusa Tenggara Timur", "Kalimantan Barat", "Kalimantan Tengah",
  "Kalimantan Selatan", "Kalimantan Timur", "Kalimantan Utara", "Sulawesi Utara",
  "Gorontalo", "Sulawesi Tengah", "Sulawesi Barat", "Sulawesi Selatan", "Sulawesi Tenggara",
  "Maluku", "Maluku Utara", "Papua", "Papua Barat", "Papua Barat Daya", "Papua Selatan",
  "Papua Tengah", "Papua Pegunungan",
]);

function normalizeRegion(row) {
  const original = String(row.region || "Indonesia").trim();
  const canonical = REGION_ALIASES.get(original.toLowerCase()) || original;
  return canonical === original ? row : { ...row, region: canonical, subregion: original };
}

function accepted(row) {
  if (!row?.streamUrl || !mediaTypes.has(row.streamType) || junk.test(row.streamUrl)) return false;
  if (row.streamType === "youtube" && !/(?:youtube\.com\/(?:watch\?v=|live\/|embed\/)|youtu\.be\/)[\w-]{6,}/i.test(row.streamUrl)) return false;
  if (row.streamType === "html-page" && !/(?:cctv|camera|stream|atcs|pantau|monitor|opencctv|play-hls|player)/i.test(row.streamUrl)) return false;
  return row.browserPlayable !== false;
}

function key(row) {
  const stream = String(row.streamUrl).replace(/[?&](?:t|s|cache|refresh)=[^&]*/gi, "");
  return createHash("sha256").update(stream.toLowerCase()).digest("hex");
}

const records = new Map();
let rejected = 0;
for (const input of inputs) {
  const text = await readFile(input, "utf8");
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const row = normalizeRegion(JSON.parse(line));
    if (!accepted(row)) { rejected += 1; continue; }
    const id = key(row);
    const prior = records.get(id);
    if (!prior) {
      records.set(id, row);
      continue;
    }
    const rowHasBetterRegion = CANONICAL_PROVINCES.has(row.region) && !CANONICAL_PROVINCES.has(prior.region);
    const rowHasBetterCoordinates = row.coordinates && !prior.coordinates;
    if (rowHasBetterRegion || rowHasBetterCoordinates || row.streamStatus === "live") {
      const priorIsLive = ["live", "reachable"].includes(prior.streamStatus);
      records.set(id, {
        ...prior,
        ...row,
        streamStatus: priorIsLive ? prior.streamStatus : row.streamStatus,
        lastCheckedAt: prior.lastCheckedAt || row.lastCheckedAt,
      });
    }
  }
}
await writeFile(output, `${[...records.values()].map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
console.log(JSON.stringify({ inputs, accepted: records.size, rejected }, null, 2));
