import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const sourceUrl = arg("--url", "https://bpjt.pu.go.id/cctv/");
const output = path.resolve(arg("--out", ".cctv-ingest/bpjt.ndjson"));

// Cross-province routes are intentionally omitted until each camera can be
// assigned using an authoritative administrative boundary.
const ROUTE_PROVINCES = new Map(Object.entries({
  kemo: "Jawa Timur", paspro: "Jawa Timur", sbygsk: "Jawa Timur",
  cisumdawu: "Jawa Barat", tanmer: "Banten", klbm: "Jawa Timur",
  bakter: "Lampung", semarangdemak: "Jawa Tengah", desari: "Jawa Barat",
  pdkaser: "Banten", cijago: "Jawa Barat", cct: "Jawa Barat", mebi: "Sumatera Utara",
  pbtr: "Jawa Tengah", pptr: "Jawa Tengah", atp: "DKI Jakarta", jorrs: "DKI Jakarta",
  soroja: "Jawa Barat", jiut: "DKI Jakarta", kp: "Jawa Barat", palindra: "Sumatera Selatan",
  permai: "Riau", bocimi: "Jawa Barat", jorrw1: "DKI Jakarta", sibanceh: "Aceh",
  inprabu: "Sumatera Selatan", pacin: "Sumatera Barat", inkis: "Sumatera Utara",
  cipali: "Jawa Barat", serba: "Banten", bengtab: "Bengkulu", "6td": "DKI Jakarta",
  pekbang: "Riau", ups13: "Sulawesi Selatan", kttp: "Sumatera Utara",
  kapalbetung: "Sumatera Selatan", cibici: "Jawa Barat", SI: "Jawa Barat",
  sswaru: "Jawa Timur", jorrw2utara: "DKI Jakarta", serpongkunciran: "Banten",
  ms4: "Sulawesi Selatan", serpan: "Banten",
}));

const response = await fetch(sourceUrl, {
  headers: { "User-Agent": "ITS-Maps-CCTV-Public-Indexer/1.0", Accept: "text/html" },
});
if (!response.ok) throw new Error(`BPJT returned HTTP ${response.status}`);
const html = await response.text();
const marker = "const allStreams = ";
const start = html.indexOf(marker);
if (start < 0) throw new Error("BPJT allStreams payload was not found");
const jsonStart = start + marker.length;
const jsonEnd = html.indexOf(";", jsonStart);
if (jsonEnd < 0) throw new Error("BPJT allStreams payload was not terminated");
const groups = JSON.parse(html.slice(jsonStart, jsonEnd));

const rows = [];
const skippedRoutes = [];
for (const [routeId, cameras] of Object.entries(groups)) {
  const province = ROUTE_PROVINCES.get(routeId);
  if (!province) {
    skippedRoutes.push({ routeId, name: cameras?.[0]?.nama_ruas || "", count: cameras?.length || 0 });
    continue;
  }
  for (const camera of cameras || []) {
    const streamUrl = String(camera.streamhls || camera.stream || "").trim();
    if (camera.status !== "online" || !/^https?:\/\//i.test(streamUrl)) continue;
    const latitude = Number(camera.lat);
    const longitude = Number(camera.lon);
    rows.push({
      id: `cctv:${createHash("sha256").update(`bpjt\n${routeId}\n${camera.unique_id || camera.id}\n${streamUrl}`).digest("hex").slice(0, 24)}`,
      name: camera.nama_segment || camera.nama_km || `${camera.nama_ruas} CCTV`,
      region: province,
      subregion: camera.nama_ruas || routeId,
      operator: `BPJT / ${String(camera.bujt || "BUJT").toUpperCase()}`,
      sourceUrl,
      pageUrl: sourceUrl,
      streamUrl,
      streamType: /\.m3u8(?:$|[?#])/i.test(streamUrl) ? "hls" : "html-page",
      browserPlayable: true,
      streamStatus: "reachable",
      verification: "official-bpjt-online-directory",
      coordinates: Number.isFinite(latitude) && Number.isFinite(longitude)
        ? { latitude, longitude }
        : null,
      officialRecordId: String(camera.unique_id || camera.id || ""),
      routeId,
      discoveredAt: new Date().toISOString(),
    });
  }
}

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
console.log(JSON.stringify({
  sourceUrl,
  output,
  sourceRecords: Object.values(groups).reduce((sum, cameras) => sum + cameras.length, 0),
  importedOnline: rows.length,
  mappedRoutes: ROUTE_PROVINCES.size,
  skippedRoutes,
}, null, 2));
