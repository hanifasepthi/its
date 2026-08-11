import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { browserPlayable, classifyStream } from "./classify.mjs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const origin = "https://opencctv.org";
const countryUrl = `${origin}/cameras/indonesia`;
const output = path.resolve(arg("--out", ".cctv-ingest/opencctv.ndjson"));
const concurrency = Math.max(1, Math.min(16, Number(arg("--concurrency", "8")) || 8));
const pageLimit = Math.max(1, Number(arg("--page-limit", "999")) || 999);
const includeDetails = process.argv.includes("--details");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const decode = (value) => String(value || "")
  .replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'");

async function fetchText(url, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "ITS-Maps-Public-CCTV-Indexer/1.1", Accept: "text/html" },
      signal: controller.signal,
    });
    if (response.status === 429 && attempt < 4) {
      await sleep(1_000 * (attempt + 1));
      return fetchText(url, attempt + 1);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally { clearTimeout(timer); }
}

function jsonLd(html) {
  const blocks = [];
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { blocks.push(JSON.parse(match[1])); } catch {}
  }
  return blocks;
}

function cameraItems(html) {
  const list = jsonLd(html).find((item) => item?.["@type"] === "ItemList");
  return (list?.itemListElement || [])
    .map((entry) => entry?.item)
    .filter((item) => typeof item?.url === "string" && item.url.startsWith(`${origin}/cameras/indonesia/`));
}

function pageCount(html) {
  const titleCount = Number((html.match(/<title>([\d,]+) Live Cameras in Indonesia/i)?.[1] || "").replaceAll(",", ""));
  if (titleCount > 0) return Math.ceil(titleCount / 16);
  const pages = [...html.matchAll(/[?&]page=(\d+)/g)].map((match) => Number(match[1]));
  return Math.max(1, ...pages);
}

function stableId(url) {
  return `cctv:${createHash("sha256").update(`opencctv\n${url}`).digest("hex").slice(0, 24)}`;
}

function listingRecord(item) {
  const pageUrl = item.url;
  const place = item.contentLocation || {};
  const geo = place.geo || {};
  const parts = String(place.name || "Indonesia").split(",").map((part) => part.trim());
  const region = parts.length > 1 ? parts.at(-2) : parts[0];
  const latitude = Number(geo.latitude);
  const longitude = Number(geo.longitude);
  return {
    id: stableId(pageUrl), name: String(item.name || "CCTV publik Indonesia").trim(),
    region: region || "Indonesia", operator: "Sumber publik terindeks OpenCCTV",
    sourceUrl: pageUrl, directoryUrl: pageUrl, pageUrl, streamUrl: pageUrl,
    streamType: "html-page", browserPlayable: true, streamStatus: "live",
    verification: "public-directory-live",
    coordinates: Number.isFinite(latitude) && Number.isFinite(longitude) ? { lat: latitude, lng: longitude } : null,
    discoveredAt: new Date().toISOString(),
  };
}

function detailRecord(pageUrl, html) {
  const video = jsonLd(html).find((item) => item?.["@type"] === "VideoObject");
  if (!video) return null;
  const container = html.match(/<div\b[^>]*id=["']feed-container["'][^>]*>/i)?.[0] || "";
  const declaredType = decode(container.match(/\bdata-type=["']([^"']+)/i)?.[1] || "");
  const dataSrc = decode(container.match(/\bdata-src=["']([^"']+)/i)?.[1] || "");
  let direct = "";
  for (const anchor of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = anchor[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (/^(?:Try direct link|Open feed URL)$/i.test(text)) {
      direct = decode(anchor[1]);
      break;
    }
  }
  const proxy = decode(container.match(/\bdata-proxy=["']([^"']+)/i)?.[1] || "");
  const streamUrl = direct || (dataSrc ? new URL(dataSrc, origin).href : "") || (proxy ? new URL(proxy, origin).href : "") || pageUrl;
  const inferredType = classifyStream(streamUrl, "", declaredType);
  const streamType = declaredType === "m3u8" ? "hls" : (inferredType === "unknown" ? "html-page" : inferredType);
  const place = video.contentLocation || {};
  const geo = place.geo || {};
  const address = place.address || {};
  const region = address.addressRegion || String(place.name || "Indonesia").split(",").at(-2)?.trim() || "Indonesia";
  const latitude = Number(geo.latitude);
  const longitude = Number(geo.longitude);
  return {
    id: stableId(pageUrl),
    name: String(video.name || "CCTV publik Indonesia").trim(),
    region,
    operator: "Sumber publik terindeks OpenCCTV",
    sourceUrl: direct || pageUrl,
    directoryUrl: pageUrl,
    pageUrl,
    streamUrl,
    streamType,
    browserPlayable: browserPlayable(streamType),
    streamStatus: video.publication?.isLiveBroadcast ? "live" : "discovered",
    verification: "public-directory-live",
    coordinates: Number.isFinite(latitude) && Number.isFinite(longitude) ? { lat: latitude, lng: longitude } : null,
    discoveredAt: new Date().toISOString(),
  };
}

async function mapConcurrent(values, worker) {
  const results = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      try { results[index] = await worker(values[index], index); }
      catch (error) { results[index] = { error: error instanceof Error ? error.message : String(error), value: values[index] }; }
    }
  }));
  return results;
}

const first = await fetchText(countryUrl);
const totalPages = Math.min(pageLimit, pageCount(first));
const listingHtml = [first];
for (let page = 2; page <= totalPages; page += 1) {
  await sleep(180);
  try { listingHtml.push(await fetchText(`${countryUrl}?page=${page}`)); }
  catch (error) { listingHtml.push({ error: error instanceof Error ? error.message : String(error), page }); }
}
const itemMap = new Map();
listingHtml.forEach((html) => {
  if (typeof html !== "string") return;
  cameraItems(html).forEach((item) => itemMap.set(item.url, item));
});
const baseRecords = [...itemMap.values()].map(listingRecord);
const details = includeDetails
  ? await mapConcurrent(baseRecords, async (row) => detailRecord(row.pageUrl, await fetchText(row.pageUrl)) || row)
  : baseRecords;
const records = details.filter((row) => row && !row.error && row.streamUrl);
const errors = [
  ...listingHtml.filter((row) => typeof row !== "string"),
  ...details.filter((row) => row?.error),
];

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${records.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
await writeFile(output.replace(/\.ndjson$/i, ".report.json"), `${JSON.stringify({
  generatedAt: new Date().toISOString(), source: countryUrl, totalPages, links: itemMap.size,
  records: records.length, errors: errors.length, errorSamples: errors.slice(0, 20),
}, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ totalPages, links: itemMap.size, records: records.length, errors: errors.length }, null, 2));
