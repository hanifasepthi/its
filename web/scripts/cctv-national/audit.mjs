import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const manifestPath = path.resolve(arg("--manifest", "public/data/cctv-national/manifest.json"));
const output = path.resolve(arg("--out", "public/data/cctv-national/coverage.json"));
const targetPerProvince = Math.max(1, Number(arg("--target-per-province", "100")) || 100);
const provinces = [
  "Aceh", "Sumatera Utara", "Sumatera Barat", "Riau", "Kepulauan Riau", "Jambi", "Sumatera Selatan", "Kepulauan Bangka Belitung", "Bengkulu", "Lampung",
  "DKI Jakarta", "Banten", "Jawa Barat", "Jawa Tengah", "DI Yogyakarta", "Jawa Timur", "Bali", "Nusa Tenggara Barat", "Nusa Tenggara Timur",
  "Kalimantan Barat", "Kalimantan Tengah", "Kalimantan Selatan", "Kalimantan Timur", "Kalimantan Utara",
  "Sulawesi Utara", "Gorontalo", "Sulawesi Tengah", "Sulawesi Barat", "Sulawesi Selatan", "Sulawesi Tenggara",
  "Maluku", "Maluku Utara", "Papua", "Papua Barat", "Papua Barat Daya", "Papua Selatan", "Papua Tengah", "Papua Pegunungan",
];

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const counts = new Map((manifest.regions || []).map((row) => [row.region, row]));
const coverage = provinces.map((province) => {
  const row = counts.get(province);
  const count = Number(row?.featureCount || 0);
  return {
    province, count, verifiedLiveCount: Number(row?.verifiedLiveCount || 0),
    status: count === 0 ? "missing" : count < targetPerProvince ? "low" : "covered",
    target: targetPerProvince, gap: Math.max(0, targetPerProvince - count),
  };
});
const summary = {
  generatedAt: new Date().toISOString(), featureCount: manifest.featureCount,
  provinceCount: provinces.length, coveredProvinceCount: coverage.filter((row) => row.count > 0).length,
  sufficientlyCoveredCount: coverage.filter((row) => row.status === "covered").length,
  missingProvinceCount: coverage.filter((row) => row.status === "missing").length,
  lowProvinceCount: coverage.filter((row) => row.status === "low").length,
  targetPerProvince, nonProvinceBuckets: (manifest.regions || []).filter((row) => !provinces.includes(row.region)),
  provinces: coverage,
};
await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));
