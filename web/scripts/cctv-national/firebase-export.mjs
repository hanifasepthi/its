import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const dataDir = path.resolve(arg("--data", "public/data/cctv-national"));
const output = path.resolve(arg("--out", ".cctv-ingest/firebase-cctv-national.json"));
const manifest = JSON.parse(await readFile(path.join(dataDir, "manifest.json"), "utf8"));
const coverage = JSON.parse(await readFile(path.join(dataDir, "coverage.json"), "utf8"));
const pages = {};
for (const region of manifest.regions || []) {
  pages[region.slug] = {};
  for (let page = 1; page <= region.pageCount; page += 1) {
    const key = `page-${String(page).padStart(4, "0")}`;
    const value = JSON.parse(await readFile(path.join(dataDir, "regions", region.slug, `${key}.json`), "utf8"));
    pages[region.slug][key] = value.records;
  }
}
await writeFile(output, `${JSON.stringify({ manifest, coverage, pages })}\n`, "utf8");
console.log(JSON.stringify({ output, featureCount: manifest.featureCount, regions: manifest.regions.length }, null, 2));
