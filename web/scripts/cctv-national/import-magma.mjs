import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const sourceUrl = arg("--url", "https://magma.esdm.go.id/v1/gunung-api/cctv");
const output = path.resolve(arg("--out", ".cctv-ingest/magma.ndjson"));

// Province and coordinates are fixed metadata for the volcano, while the
// available camera count is discovered from MAGMA's current public page.
const VOLCANOES = new Map(Object.entries({
  BRO: { name: "Bromo", region: "Jawa Timur", latitude: -7.9425, longitude: 112.9530 },
  DEM: { name: "Dempo", region: "Sumatera Selatan", latitude: -4.0300, longitude: 103.1300 },
  GUN: { name: "Guntur", region: "Jawa Barat", latitude: -7.1430, longitude: 107.8400 },
  IBU: { name: "Ibu", region: "Maluku Utara", latitude: 1.4880, longitude: 127.6300 },
  IJE: { name: "Ijen", region: "Jawa Timur", latitude: -8.0580, longitude: 114.2420 },
  KER: { name: "Kerinci", region: "Jambi", latitude: -1.6970, longitude: 101.2640 },
  KRA: { name: "Anak Krakatau", region: "Lampung", latitude: -6.1020, longitude: 105.4230 },
  PAP: { name: "Papandayan", region: "Jawa Barat", latitude: -7.3200, longitude: 107.7300 },
  SIN: { name: "Sinabung", region: "Sumatera Utara", latitude: 3.1700, longitude: 98.3920 },
  SMR: { name: "Semeru", region: "Jawa Timur", latitude: -8.1080, longitude: 112.9220 },
}));

const response = await fetch(sourceUrl, {
  headers: { "User-Agent": "ITS-Maps-CCTV-Public-Indexer/1.0", Accept: "text/html" },
});
if (!response.ok) throw new Error(`MAGMA returned HTTP ${response.status}`);
const html = await response.text();

const discovered = new Map();
const linkPattern = /href=["']https:\/\/magma\.esdm\.go\.id\/v1\/gunung-api\/cctv\/([A-Z]+)["'][^>]*>([^<]+)<\/a>/gi;
for (const match of html.matchAll(linkPattern)) {
  const code = match[1];
  const label = match[2].replace(/\s+/g, " ").trim();
  const count = Number(label.match(/\((\d+)\)\s*$/)?.[1] || 0);
  if (VOLCANOES.has(code) && count > 0) discovered.set(code, count);
}

const checkedAt = new Date().toISOString();
const rows = [...discovered].map(([code, cameraCount]) => {
  const volcano = VOLCANOES.get(code);
  const pageUrl = `${sourceUrl}/${code}`;
  return {
    id: `cctv:${createHash("sha256").update(`magma\n${code}\n${pageUrl}`).digest("hex").slice(0, 24)}`,
    name: `Kamera Gunung ${volcano.name} (${cameraCount} tampilan)`,
    region: volcano.region,
    subregion: `Gunung ${volcano.name}`,
    operator: "PVMBG / Badan Geologi / Kementerian ESDM",
    sourceUrl,
    pageUrl,
    streamUrl: pageUrl,
    streamType: "html-page",
    browserPlayable: true,
    streamStatus: "reachable",
    verification: "official-magma-public-camera-directory",
    coordinates: { latitude: volcano.latitude, longitude: volcano.longitude },
    officialRecordId: code,
    cameraCount,
    lastCheckedAt: checkedAt,
    discoveredAt: checkedAt,
  };
});

if (!rows.length) throw new Error("No active MAGMA public camera pages were discovered");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
console.log(JSON.stringify({ sourceUrl, output, importedPortals: rows.length, representedViews: rows.reduce((sum, row) => sum + row.cameraCount, 0), regions: [...new Set(rows.map((row) => row.region))] }, null, 2));
