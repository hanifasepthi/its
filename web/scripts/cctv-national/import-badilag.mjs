import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const sourceUrl = arg("--url", "https://cctv.badilag.net/");
const output = path.resolve(arg("--out", ".cctv-ingest/badilag.ndjson"));

// These courts intentionally publish their monitoring players through ACO
// Badilag. The city coordinates locate the public institution, not a person.
const TARGETS = [
  ["Nusa Tenggara Timur", "Pengadilan Tinggi Agama Kupang", "e665a592589d17fd141b112eaabd32ab", -10.1772, 123.6070],
  ["Kalimantan Utara", "Pengadilan Tinggi Agama Kalimantan Utara", "aed5df2dad0df112de2c98afb2c642c8", 2.8370, 117.3650],
  ["Gorontalo", "Pengadilan Tinggi Agama Gorontalo", "34c4b19787f698dc757e78910a8bb43d", 0.5435, 123.0595],
  ["Sulawesi Barat", "Pengadilan Tinggi Agama Sulawesi Barat", "693330f8075a174c5df179892b692893", -2.6806, 118.8867],
  ["Maluku", "Pengadilan Tinggi Agama Ambon", "4e17af56b8af2572fd712a785d2f8ac9", -3.6954, 128.1814],
  ["Papua", "Pengadilan Tinggi Agama Jayapura", "2b1786015af3fb963658c0dd1639a45c", -2.5337, 140.7181],
  ["Papua Barat", "Pengadilan Tinggi Agama Papua Barat", "86a6f4a5d2011e7377a09309ed4f605d", -0.8615, 134.0620],
  ["Papua Barat Daya", "Pengadilan Agama Sorong", "476c1dce34182b048f28aefa96c96881", -0.8762, 131.2558],
  ["Papua Selatan", "Pengadilan Agama Merauke", "c7a4af917d14edcd6ad5686761397623", -8.4932, 140.4018],
  ["Papua Tengah", "Pengadilan Agama Nabire", "49deb7305c22c4e6bc4383b6e0198c93", -3.3667, 135.4833],
  ["Papua Pegunungan", "Pengadilan Agama Wamena", "889731ba2aad3e48a473acb46d864aeb", -4.0958, 138.9461],
];

const cleanText = (value) => String(value || "")
  .replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&")
  .replace(/&#039;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/\s+/g, " ").trim();

const checkedAt = new Date().toISOString();
const rows = [];
const report = [];

for (const [region, court, satkerId, latitude, longitude] of TARGETS) {
  const pageUrl = `${sourceUrl.replace(/\/$/, "")}/display/satker/${satkerId}`;
  const response = await fetch(pageUrl, {
    headers: { "User-Agent": "ITS-Maps-CCTV-Public-Indexer/1.0", Accept: "text/html" },
  });
  if (!response.ok) {
    report.push({ region, court, status: response.status, imported: 0 });
    continue;
  }
  const html = await response.text();
  let imported = 0;
  const cardPattern = /<h6[^>]*>([\s\S]*?)<\/h6>[\s\S]*?<iframe[^>]+src=["']([^"']+)["']/gi;
  for (const match of html.matchAll(cardPattern)) {
    const cameraName = cleanText(match[1]);
    const streamUrl = match[2].replace(/&amp;/g, "&").trim();
    if (!/^https:\/\//i.test(streamUrl) || /google\.com\/maps/i.test(streamUrl)) continue;
    const id = createHash("sha256").update(`badilag\n${satkerId}\n${streamUrl}`).digest("hex").slice(0, 24);
    rows.push({
      id: `cctv:${id}`,
      name: `${court} - ${cameraName || `Kamera ${imported + 1}`}`,
      region,
      subregion: court,
      operator: "Direktorat Jenderal Badan Peradilan Agama / Mahkamah Agung RI",
      sourceUrl,
      pageUrl,
      streamUrl,
      streamType: "html-page",
      browserPlayable: true,
      streamStatus: "discovered",
      verification: "official-badilag-public-player",
      coordinates: { latitude, longitude },
      officialRecordId: `${satkerId}:${imported + 1}`,
      discoveredAt: checkedAt,
    });
    imported += 1;
  }
  report.push({ region, court, status: response.status, imported });
}

if (!rows.length) throw new Error("No configured ACO Badilag public players were discovered");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
console.log(JSON.stringify({ sourceUrl, output, importedPlayers: rows.length, coveredRegions: new Set(rows.map((row) => row.region)).size, report }, null, 2));
