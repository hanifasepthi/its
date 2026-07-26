import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { PMTiles } from "pmtiles";

const ROOT = process.cwd();
const ARCHIVE = process.env.ITS_PM_TILES_URL
  || "https://its.hanifahseptiani45.workers.dev/v1/map/archive/indonesia.pmtiles";
const OUTPUT_DIR = path.join(ROOT, ".map-dynamics-ingest", "pmtiles-national");
const DEFAULT_BBOX = [94.5, -11.5, 141.1, 6.5];
const SUPPORTED_LAYERS = new Set([
  "transportation", "transportation_name", "water", "waterway", "landcover",
  "landuse", "park", "poi", "mountain_peak", "building",
]);

class StableRangeSource {
  constructor(url) { this.url = url; }
  getKey() { return this.url; }
  async getBytes(offset, length, signal) {
    let lastStatus = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(this.url, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
        signal,
      });
      lastStatus = response.status;
      if (response.status === 206) {
        const data = await response.arrayBuffer();
        if (data.byteLength !== length) throw new Error(`PMTiles range pendek: ${data.byteLength}/${length}`);
        return {
          data,
          etag: response.headers.get("etag") || undefined,
          expires: response.headers.get("expires") || undefined,
          cacheControl: response.headers.get("cache-control") || undefined,
        };
      }
      if (response.status !== 429 && response.status < 500) break;
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
    }
    throw new Error(`PMTiles range ${offset}+${length} mendapat HTTP ${lastStatus} setelah retry`);
  }
}

function optionsFrom(argv) {
  const options = { bbox: DEFAULT_BBOX, zoom: 14, maxTiles: 1, reset: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--bbox") options.bbox = String(argv[++index]).split(",").map(Number);
    else if (arg === "--zoom") options.zoom = Number(argv[++index]);
    else if (arg === "--max-tiles") options.maxTiles = Number(argv[++index]);
    else if (arg === "--reset") options.reset = true;
    else throw new Error(`Argumen tidak dikenal: ${arg}`);
  }
  if (options.bbox.length !== 4 || !options.bbox.every(Number.isFinite)) throw new Error("--bbox harus west,south,east,north");
  if (!Number.isInteger(options.zoom) || options.zoom < 0 || options.zoom > 16) throw new Error("--zoom harus 0-16");
  if (!Number.isInteger(options.maxTiles) || options.maxTiles < 1 || options.maxTiles > 10000) throw new Error("--max-tiles harus 1-10000");
  return options;
}

function lngToX(lng, z) {
  return Math.max(0, Math.min(2 ** z - 1, Math.floor(((lng + 180) / 360) * 2 ** z)));
}

function latToY(lat, z) {
  const safe = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
  return Math.max(0, Math.min(2 ** z - 1, Math.floor((1 - Math.asinh(Math.tan(safe)) / Math.PI) / 2 * 2 ** z)));
}

function tileRange(bbox, z) {
  return {
    minX: lngToX(bbox[0], z),
    maxX: lngToX(bbox[2], z),
    minY: latToY(bbox[3], z),
    maxY: latToY(bbox[1], z),
  };
}

function classifiedKind(layer, properties, geometryType) {
  const cls = String(properties.class || properties.subclass || "").toLowerCase();
  const subclass = String(properties.subclass || "").toLowerCase();
  if (layer === "transportation" || layer === "transportation_name") {
    if (/rail|tram|subway|light_rail|monorail/.test(cls)) return "railway";
    if (/cycleway/.test(cls)) return "cycleway";
    if (/footway|pedestrian|path|steps/.test(cls)) return "pedestrian";
    return "road";
  }
  if (layer === "water" || layer === "waterway") return "waterway";
  if (layer === "park") return "green";
  if (layer === "landcover" && /^(wood|forest|grass|grassland|meadow|scrub|wetland|farmland|orchard|vineyard)$/.test(cls || subclass)) {
    return "green";
  }
  if (layer === "landuse" && /^(forest|grass|meadow|recreation_ground|village_green|allotments|orchard|vineyard|cemetery)$/.test(cls || subclass)) {
    return "green";
  }
  if (layer === "poi" || layer === "mountain_peak") return "poi";
  // Residential houses are deliberately excluded. Only named/public,
  // commercial or transport buildings become custom POIs.
  if (layer === "building" && (
    properties.name || properties.name_en
    || /commercial|industrial|retail|public|school|hospital|train_station|transportation/.test(cls)
  )) return "poi";
  if (geometryType === "Point") return "poi";
  return "";
}

function normalizedBoolean(value) {
  const token = String(value ?? "").toLowerCase();
  return ["1", "true", "yes"].includes(token) ? true
    : ["0", "false", "no"].includes(token) ? false
      : value;
}

function poiKind(properties) {
  const cls = String(properties.class || "").toLowerCase();
  const subclass = String(properties.subclass || "").toLowerCase();
  const token = `${cls} ${subclass}`;
  const exact = [
    ["traffic_signals", "traffic_signal"], ["crossing", "crossing"],
    ["toll_booth", "toll_gate"], ["toll_gantry", "toll_gate"],
    ["speed_camera", "speed_camera"], ["surveillance", "cctv"],
    ["fire_hydrant", "fire_hydrant"], ["street_lamp", "street_lamp"],
    ["gate", "gate"], ["lift_gate", "barrier"], ["bollard", "bollard"],
    ["elevator", "elevator"], ["escalator", "escalator"],
    ["toilets", "toilets"], ["drinking_water", "drinking_water"],
    ["bench", "bench"], ["waste_basket", "waste_basket"],
    ["taxi", "taxi_stand"], ["bus_stop", "platform"],
    ["platform", "platform"], ["entrance", "entrance"],
  ];
  for (const [needle, kind] of exact) {
    if (cls === needle || subclass === needle) return kind;
  }
  if (/hospital|clinic|doctors|pharmacy/.test(token)) return "healthcare";
  if (/school|college|university|kindergarten|library/.test(token)) return "education";
  if (/station|halt|subway|tram_stop|ferry_terminal|airport/.test(token)) return "transport";
  if (/restaurant|cafe|fast_food|food_court/.test(token)) return "food";
  if (/hotel|motel|hostel|guest_house/.test(token)) return "lodging";
  if (/police|fire_station|townhall|government|courthouse|post_office/.test(token)) return "public_service";
  if (/park|garden|playground|attraction|museum|viewpoint/.test(token)) return "attraction";
  if (/place_of_worship|mosque|church|temple|synagogue/.test(token)) return "worship";
  if (/shop|mall|marketplace|supermarket/.test(token)) return "shopping";
  return "poi";
}

function enrichedProperties(layer, properties, kind) {
  const result = { ...properties };
  const cls = String(properties.class || "").toLowerCase();
  const subclass = String(properties.subclass || "").toLowerCase();
  const brunnel = String(properties.brunnel || "").toLowerCase();
  if (layer === "transportation" || layer === "transportation_name") {
    if (kind === "road" || kind === "cycleway" || kind === "pedestrian") {
      result.highway = cls || subclass || "road";
      if (kind === "cycleway") result.highway = "cycleway";
      if (kind === "pedestrian" && !/footway|pedestrian|path|steps/.test(result.highway)) result.highway = "footway";
    } else if (kind === "railway") {
      result.railway = cls || subclass || "rail";
    }
    if (brunnel === "bridge") result.bridge = true;
    if (brunnel === "tunnel") result.tunnel = true;
    if (Number.isFinite(Number(properties.layer))) result.layer = Number(properties.layer);
    if ("oneway" in properties) result.oneway = normalizedBoolean(properties.oneway);
  }
  if (layer === "waterway") result.waterway = cls || subclass || "stream";
  if (layer === "water") result.water = cls || subclass || "water";
  return result;
}

function explodeGeometry(geometry) {
  if (!geometry) return [];
  if (geometry.type === "MultiPoint") return geometry.coordinates.map((coordinates) => ({ type: "Point", coordinates }));
  if (geometry.type === "MultiLineString") return geometry.coordinates.map((coordinates) => ({ type: "LineString", coordinates }));
  if (geometry.type === "MultiPolygon") return geometry.coordinates.map((coordinates) => ({ type: "Polygon", coordinates }));
  return ["Point", "LineString", "Polygon"].includes(geometry.type) ? [geometry] : [];
}

function geometryIntersectsBbox(geometry, bbox) {
  const pairs = [];
  const visit = (value) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      pairs.push(value);
      return;
    }
    value.forEach(visit);
  };
  visit(geometry?.coordinates);
  if (!pairs.length) return false;
  const lngs = pairs.map((pair) => pair[0]);
  const lats = pairs.map((pair) => pair[1]);
  return Math.min(...lngs) <= bbox[2] && Math.max(...lngs) >= bbox[0]
    && Math.min(...lats) <= bbox[3] && Math.max(...lats) >= bbox[1];
}

async function readCheckpoint(filename, reset) {
  if (reset) return { completed: {}, tiles: 0, features: 0 };
  try { return JSON.parse(await readFile(filename, "utf8")); }
  catch { return { completed: {}, tiles: 0, features: 0 }; }
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  await mkdir(OUTPUT_DIR, { recursive: true });
  const checkpointFile = path.join(OUTPUT_DIR, `checkpoint-z${options.zoom}.json`);
  const outputFile = path.join(OUTPUT_DIR, `verified-z${options.zoom}.ndjson`);
  const checkpoint = await readCheckpoint(checkpointFile, options.reset);
  if (options.reset) await writeFile(outputFile, "", "utf8");
  const range = tileRange(options.bbox, options.zoom);
  const archive = new PMTiles(new StableRangeSource(ARCHIVE));
  const metadata = await archive.getMetadata();
  let processed = 0;
  for (let y = range.minY; y <= range.maxY && processed < options.maxTiles; y += 1) {
    for (let x = range.minX; x <= range.maxX && processed < options.maxTiles; x += 1) {
      const tileKey = `${options.zoom}/${x}/${y}`;
      if (checkpoint.completed[tileKey]) continue;
      const response = await archive.getZxy(options.zoom, x, y);
      let featureCount = 0;
      if (response?.data?.byteLength) {
        const tile = new VectorTile(new Pbf(response.data));
        const lines = [];
        for (const [layerName, layer] of Object.entries(tile.layers)) {
          if (!SUPPORTED_LAYERS.has(layerName)) continue;
          for (let index = 0; index < layer.length; index += 1) {
            const raw = layer.feature(index);
            const geo = raw.toGeoJSON(x, y, options.zoom);
            const baseKind = classifiedKind(layerName, geo.properties || {}, geo.geometry?.type);
            if (!baseKind) continue;
            const kind = baseKind === "poi" ? poiKind(geo.properties || {}) : baseKind;
            const properties = enrichedProperties(layerName, geo.properties || {}, kind);
            for (const [part, geometry] of explodeGeometry(geo.geometry).entries()) {
              if (!geometryIntersectsBbox(geometry, options.bbox)) continue;
              const sourceId = `${tileKey}:${layerName}:${raw.id ?? index}:${part}`;
              lines.push(JSON.stringify({
                type: "Feature",
                id: `pmtiles:${sourceId}`,
                properties: {
                  ...properties,
                  kind,
                  verification: "verified",
                  source: "OpenMapTiles/OpenStreetMap national PMTiles",
                  sourceId,
                  sourceLayer: layerName,
                  archive: ARCHIVE,
                  updatedAt: new Date().toISOString(),
                },
                geometry,
              }));
              featureCount += 1;
            }
          }
        }
        if (lines.length) await appendFile(outputFile, `${lines.join("\n")}\n`, "utf8");
      }
      checkpoint.completed[tileKey] = { featureCount, completedAt: new Date().toISOString() };
      checkpoint.tiles += 1;
      checkpoint.features += featureCount;
      checkpoint.zoom = options.zoom;
      checkpoint.bbox = options.bbox;
      checkpoint.archive = ARCHIVE;
      checkpoint.archiveMetadata = metadata;
      await writeFile(checkpointFile, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
      processed += 1;
      process.stdout.write(`${tileKey}: ${featureCount} fitur; total ${checkpoint.features}\n`);
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: true, processed, totalTiles: checkpoint.tiles, totalFeatures: checkpoint.features, outputFile, checkpointFile }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
