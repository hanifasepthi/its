import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const input = path.resolve(arg("--in", ".cctv-ingest/candidates.ndjson"));
const outDir = path.resolve(arg("--out", ".cctv-dist"));
const pageSize = Math.max(50, Math.min(1000, Number(arg("--page-size", "250")) || 250));

const slug = (v) => String(v || "unknown").normalize("NFKD").toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";

async function main() {
  const text = await readFile(input, "utf8");
  const rows = text.split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const regions = new Map();
  for (const row of rows) {
    const key = row.region || "Indonesia";
    const list = regions.get(key) || [];
    list.push(row);
    regions.set(key, list);
  }

  await mkdir(outDir, { recursive: true });
  const manifestRegions = [];

  for (const [region, list] of [...regions].sort(([a],[b]) => a.localeCompare(b,"id"))) {
    const dir = path.join(outDir, "regions", slug(region));
    await mkdir(dir, { recursive: true });
    list.sort((a,b) => (a.name || "").localeCompare(b.name || "", "id"));

    let pageCount = 0;
    for (let i = 0; i < list.length; i += pageSize) {
      pageCount += 1;
      const filename = `page-${String(pageCount).padStart(4,"0")}.json`;
      await writeFile(path.join(dir, filename), JSON.stringify({
        schemaVersion: "1.0",
        region,
        page: pageCount,
        records: list.slice(i, i + pageSize),
      }) + "\n");
    }

    manifestRegions.push({
      region,
      slug: slug(region),
      featureCount: list.length,
      verifiedLiveCount: list.filter(x => ["live","reachable"].includes(x.streamStatus)).length,
      pageCount,
    });
  }

  const byType = {};
  for (const row of rows) byType[row.streamType || "unknown"] = (byType[row.streamType || "unknown"] || 0) + 1;

  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify({
    schemaVersion: "1.0",
    dataset: "its-cctv-indonesia",
    generatedAt: new Date().toISOString(),
    featureCount: rows.length,
    pageSize,
    byType,
    regions: manifestRegions,
  }, null, 2) + "\n");

  console.log(JSON.stringify({ ok: true, featureCount: rows.length, regions: manifestRegions.length }, null, 2));
}

await main();
