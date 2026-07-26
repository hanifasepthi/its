import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const SOURCE_PAGE = "https://dashboard-signature.bmkg.go.id/server/rest/services/MEWS/Jakarta_Satu/MapServer/0";
const QUERY_URL = `${SOURCE_PAGE}/query?where=1%3D1&outFields=objectid%2Clokasi%2Cx%2Cy%2Clink_live&returnGeometry=true&f=geojson`;
const output = path.resolve(process.cwd(), ".map-dynamics-ingest", "official", "bmkg-jakarta-cctv.geojson");

function safePublicStream(value) {
  if (typeof value !== "string" || !/^https:\/\//i.test(value)) return "";
  try {
    const url = new URL(value);
    // Never republish embedded credentials even when an upstream public service
    // accidentally includes them. A credential-free HTTPS URL may be linked.
    if (url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

const response = await fetch(QUERY_URL, { headers: { Accept: "application/geo+json, application/json" } });
if (!response.ok) throw new Error(`CCTV ArcGIS HTTP ${response.status}`);
const collection = await response.json();
const now = new Date().toISOString();
const features = (Array.isArray(collection.features) ? collection.features : []).flatMap((feature) => {
  const coordinates = feature?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || !coordinates.slice(0, 2).every(Number.isFinite)) return [];
  const objectId = String(feature?.properties?.objectid ?? feature?.id ?? "").trim();
  if (!objectId) return [];
  const streamUrl = safePublicStream(feature?.properties?.link_live);
  return [{
    type: "Feature",
    id: `bmkg-jakarta-cctv:${objectId}`,
    geometry: { type: "Point", coordinates: coordinates.slice(0, 2) },
    properties: {
      kind: "cctv",
      name: String(feature?.properties?.lokasi || `CCTV ${objectId}`).trim(),
      poiType: "public_cctv",
      iconKey: "poi-cctv",
      source: "BMKG Jakarta Satu ArcGIS CCTV",
      sourceId: objectId,
      sourceUrl: SOURCE_PAGE,
      ...(streamUrl ? { website: streamUrl, streamStatus: "public-link" } : { streamStatus: "metadata-only-credential-redacted" }),
      verification: "verified",
      verifiedBy: "official ArcGIS feature service",
      updatedAt: now,
    },
  }];
});

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({ type: "FeatureCollection", features }, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ok: true, features: features.length, output, source: SOURCE_PAGE }, null, 2)}\n`);
