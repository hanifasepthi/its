import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { classifyStream, browserPlayable } from "./classify.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(name);

const sourceFile = path.resolve(arg("--sources", "public/data/cctv-sources.json"));
const outDir = path.resolve(arg("--out", ".cctv-ingest"));
const maxPages = Math.max(1, Number(arg("--max-pages", "40")) || 40);
const delayMs = Math.max(0, Number(arg("--delay-ms", "500")) || 500);
const doProbe = has("--probe");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SENSITIVE = /^(?:token|access_token|auth|authorization|sig|signature|key|apikey|api_key|secret|jwt|session|credential|policy|expires|exp)$/i;
const MEDIA_ATTR = /\b(?:src|href|data-src|data-url|data-hls|data-stream|file)\s*=\s*["']([^"']+)["']/gi;
const ABS_URL = /(?:https?|rtsp|rtmps?):\/\/[^\s"'<>\\)]+/gi;
const INTERESTING = /\b(?:cctv|camera|stream|streaming|live|atcs|traffic|lalu[-\s]?lintas|pantau|monitor)\b/i;

function cleanUrl(raw, base) {
  try {
    const url = new URL(String(raw || "").trim().replace(/&amp;/g, "&"), base);
    if (!["http:","https:","rtsp:","rtmp:","rtmps:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    const ephemeral = [...url.searchParams.keys()].some(k => SENSITIVE.test(k));
    const publicUrl = new URL(url.href);
    if (ephemeral) publicUrl.search = "";
    return { url: url.href, publicUrl: publicUrl.href, ephemeral };
  } catch { return null; }
}

function idFor(source, url) {
  return "cctv:" + createHash("sha256")
    .update(`${source.operator || source.region || "source"}\n${url}`)
    .digest("hex").slice(0, 24);
}

async function fetchLimited(url, bytes = 500000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "ITS-Maps-CCTV-Public-Indexer/1.0", "Accept": "*/*" },
      signal: controller.signal,
    });
    const buf = new Uint8Array(await response.arrayBuffer());
    const slice = buf.slice(0, Math.min(bytes, buf.length));
    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url,
      contentType: response.headers.get("content-type") || "",
      text: new TextDecoder().decode(slice),
    };
  } finally { clearTimeout(timer); }
}

async function probe(url) {
  try {
    const result = await fetchLimited(url, 65536);
    return {
      streamStatus: result.ok ? "reachable" : `http-${result.status}`,
      httpStatus: result.status,
      contentType: result.contentType,
      streamType: classifyStream(result.url, result.contentType, result.text),
      lastCheckedAt: new Date().toISOString(),
    };
  } catch {
    return { streamStatus: "probe-error", lastCheckedAt: new Date().toISOString() };
  }
}

function extractCandidates(html, base) {
  const raw = new Set();
  for (const m of html.matchAll(MEDIA_ATTR)) raw.add(m[1]);
  for (const m of html.matchAll(ABS_URL)) raw.add(m[0]);
  return [...raw].map(v => cleanUrl(v, base)).filter(Boolean);
}

function crawlLinks(html, base, host) {
  const out = new Set();
  const rx = /\bhref\s*=\s*["']([^"']+)["']/gi;
  for (const m of html.matchAll(rx)) {
    const c = cleanUrl(m[1], base);
    if (!c) continue;
    try {
      const u = new URL(c.url);
      if (u.hostname === host && INTERESTING.test(u.pathname + " " + u.search)) {
        u.hash = "";
        out.add(u.href);
      }
    } catch {}
  }
  return [...out];
}

async function main() {
  const doc = JSON.parse(await readFile(sourceFile, "utf8"));
  const sources = Array.isArray(doc.sources) ? doc.sources : [];
  const rows = new Map();
  const report = { generatedAt: new Date().toISOString(), sources: sources.length, pages: 0, errors: [] };

  for (const source of sources) {
    if (!source?.url) continue;

    if (Array.isArray(source.players)) {
      for (const p of source.players) {
        if (!p?.youtubeId) continue;
        const url = `https://www.youtube.com/watch?v=${p.youtubeId}`;
        rows.set(url, {
          id: idFor(source, url),
          name: p.name || source.operator || "CCTV publik",
          region: source.region || "Indonesia",
          operator: source.operator || "",
          sourceUrl: source.url,
          pageUrl: p.pageUrl || source.url,
          streamUrl: url,
          streamType: "youtube",
          browserPlayable: true,
          streamStatus: "discovered",
          verification: "candidate",
          coordinates: null,
          discoveredAt: new Date().toISOString(),
        });
      }
    }

    const seed = new URL(source.url);
    const queue = [{ url: seed.href, depth: 0 }];
    const seen = new Set();

    while (queue.length && seen.size < Math.min(maxPages, Number(source.maxPages || maxPages))) {
      const item = queue.shift();
      if (!item || seen.has(item.url)) continue;
      seen.add(item.url);
      await sleep(delayMs);

      try {
        const page = await fetchLimited(item.url);
        report.pages += 1;
        if (!page.ok) continue;

        for (const c of extractCandidates(page.text, page.url)) {
          const type = classifyStream(c.url, "", "");
          const key = c.publicUrl;
          let row = {
            id: idFor(source, key),
            name: source.operator || source.region || "CCTV publik",
            region: source.region || "Indonesia",
            operator: source.operator || "",
            sourceUrl: source.url,
            pageUrl: page.url,
            streamUrl: c.ephemeral ? "" : c.publicUrl,
            streamType: type,
            browserPlayable: browserPlayable(type),
            streamStatus: c.ephemeral ? "session-required" : "discovered",
            verification: "candidate",
            coordinates: null,
            discoveredAt: new Date().toISOString(),
          };
          if (doProbe && !c.ephemeral && /^https?:/i.test(c.url)) {
            const p = await probe(c.url);
            row = { ...row, ...p, browserPlayable: browserPlayable(p.streamType || type) };
          }
          rows.set(key, row);
        }

        const depth = Math.max(0, Math.min(2, Number(source.crawlDepth ?? 1)));
        if (item.depth < depth) {
          for (const link of crawlLinks(page.text, page.url, seed.hostname)) {
            if (!seen.has(link)) queue.push({ url: link, depth: item.depth + 1 });
          }
        }
      } catch (e) {
        report.errors.push({ url: item.url, error: e instanceof Error ? e.message : "fetch error" });
      }
    }
  }

  await mkdir(outDir, { recursive: true });
  const data = [...rows.values()];
  await writeFile(path.join(outDir, "candidates.ndjson"), data.map(x => JSON.stringify(x)).join("\n") + "\n");
  report.candidates = data.length;
  await writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}

await main();
