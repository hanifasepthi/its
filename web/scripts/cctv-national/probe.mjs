import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { browserPlayable, classifyStream } from "./classify.mjs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const input = path.resolve(arg("--in", ".cctv-ingest/merged.ndjson"));
const output = path.resolve(arg("--out", input));
const concurrency = Math.max(1, Math.min(24, Number(arg("--concurrency", "12")) || 12));
const rows = (await readFile(input, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
let cursor = 0;

async function inspect(row) {
  if (!/^https?:/i.test(row.streamUrl) || row.streamType === "youtube" || row.verification === "public-directory-live") return row;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(row.streamUrl, {
      redirect: "follow", signal: controller.signal,
      headers: { "User-Agent": "ITS-Maps-CCTV-Availability-Probe/1.0", Range: "bytes=0-65535", Accept: "*/*" },
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const sample = new TextDecoder().decode(bytes.slice(0, 65_536));
    const contentType = response.headers.get("content-type") || "";
    const detected = classifyStream(response.url || row.streamUrl, contentType, sample);
    const streamType = detected === "unknown" ? row.streamType : detected;
    return {
      ...row, httpStatus: response.status, contentType, streamType,
      browserPlayable: browserPlayable(streamType),
      streamStatus: response.ok ? "reachable" : `http-${response.status}`,
      lastCheckedAt: new Date().toISOString(),
    };
  } catch (error) {
    return { ...row, streamStatus: "probe-error", lastCheckedAt: new Date().toISOString(), probeError: error instanceof Error ? error.message : String(error) };
  } finally { clearTimeout(timer); }
}

const results = new Array(rows.length);
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (cursor < rows.length) {
    const index = cursor++;
    results[index] = await inspect(rows[index]);
  }
}));
await writeFile(output, `${results.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
const statuses = {};
results.forEach((row) => { statuses[row.streamStatus || "unknown"] = (statuses[row.streamStatus || "unknown"] || 0) + 1; });
console.log(JSON.stringify({ records: results.length, statuses }, null, 2));
