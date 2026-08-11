import { readFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const catalogPath = path.join(root, "public", "data", "public-cctv.geojson");
const outputRoot = path.join(root, "public", "cctv");
const sitemapPath = path.join(root, "public", "sitemap.xml");
const siteOrigin = "https://itstelkom.web.app";
const socialImage = `${siteOrigin}/screenshots/desktop-home.png`;

function clean(value) {
  return String(value ?? "")
    .replaceAll("Â·", "·")
    .replaceAll("â€¦", "…")
    .trim();
}

function escapeHtml(value) {
  return clean(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function slugOf(feature) {
  return clean(feature.id)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 180);
}

function regionOf(properties) {
  const addressParts = clean(properties.address).split(",").map((part) => part.trim()).filter(Boolean);
  const administrative = addressParts.find((part) =>
    /^(?:Kota|Kabupaten|Provinsi|DKI|DI)\b/i.test(part));
  if (administrative) return administrative;
  const text = [properties.region, properties.address, properties.operator, properties.source, properties.catalogSourceKey]
    .map(clean).join(" ").toLowerCase();
  if (/bandung/.test(text)) return "Bandung";
  if (/yogyakarta|jogja/.test(text)) return "DI Yogyakarta";
  if (/tangerang/.test(text)) return "Kabupaten Tangerang";
  if (/jakarta/.test(text)) return "DKI Jakarta";
  if (/bina marga|binamarga/.test(text)) return "Jaringan Jalan Nasional";
  const generic = text.match(/\b(kota|kabupaten)\s+([a-z][a-z -]{2,40})/i);
  if (generic) return `${generic[1][0].toUpperCase()}${generic[1].slice(1)} ${generic[2].trim()}`;
  return clean(properties.region) || "Indonesia";
}

const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const features = (catalog.features || []).filter((feature) =>
  feature?.geometry?.type === "Point"
  && /cctv|camera/i.test(clean(feature?.properties?.kind))
  && slugOf(feature));

await mkdir(outputRoot, { recursive: true });
const currentSlugs = new Set(features.map(slugOf));
let removedStale = 0;
for (const entry of await readdir(outputRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || currentSlugs.has(entry.name)) continue;
  const directory = path.resolve(outputRoot, entry.name);
  if (!directory.startsWith(`${path.resolve(outputRoot)}${path.sep}`)) continue;
  try {
    const index = await readFile(path.join(directory, "index.html"), "utf8");
    const generated = index.includes('href="https://itstelkom.web.app/cctv/')
      && index.includes("Buka video dan analisis realtime");
    if (!generated) continue;
    await rm(directory, { recursive: true, force: true });
    removedStale += 1;
  } catch {
    // Non-generated directories are preserved.
  }
}
const links = [];
const sitemapEntries = [];
for (const feature of features) {
  const properties = feature.properties || {};
  const slug = slugOf(feature);
  const name = clean(properties.name) || "Kamera CCTV";
  const region = regionOf(properties);
  const [lng, lat] = feature.geometry.coordinates;
  // Firebase Hosting is configured with trailingSlash:false. Keep the
  // canonical, sitemap, and internal link on the final no-slash URL so search
  // crawlers do not index a redirect variant of each camera page.
  const canonical = `${siteOrigin}/cctv/${encodeURIComponent(slug)}`;
  const mapUrl = `${siteOrigin}/?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&z=18&cctv=${encodeURIComponent(feature.id)}`;
  const description = `Pantau CCTV ${name}, ${region}: video publik, analisis kendaraan, prediksi kepadatan, dan informasi ruas jalan di ITS Maps.`;
  const structured = {
    "@context": "https://schema.org",
    "@type": "Place",
    name: `CCTV ${name}`,
    description,
    geo: { "@type": "GeoCoordinates", latitude: lat, longitude: lng },
    url: canonical,
    isAccessibleForFree: true,
    provider: {
      "@type": "GovernmentOrganization",
      name: clean(properties.operator) || clean(properties.source) || "Penyedia CCTV publik",
      url: clean(properties.sourceUrl) || undefined,
    },
  };
  const html = `<!doctype html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="generator" content="ITS Maps CCTV index">
  <title>CCTV ${escapeHtml(name)} · ${escapeHtml(region)} · ITS Maps</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <meta property="og:site_name" content="ITS Maps">
  <meta property="og:locale" content="id_ID">
  <meta property="og:type" content="website">
  <meta property="og:title" content="CCTV ${escapeHtml(name)} · ITS Maps">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonical)}">
  <meta property="og:image" content="${socialImage}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1280">
  <meta property="og:image:height" content="720">
  <meta property="og:image:alt" content="Peta CCTV dan lalu lintas realtime ITS Maps">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="CCTV ${escapeHtml(name)} · ITS Maps">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${socialImage}">
  <meta name="twitter:image:alt" content="Peta CCTV dan lalu lintas realtime ITS Maps">
  <script type="application/ld+json">${JSON.stringify(structured).replaceAll("<", "\\u003c")}</script>
  <style>body{margin:0;font:16px/1.55 system-ui;color:#172033;background:#f6f8fb}main{max-width:760px;margin:10vh auto;padding:28px;border:1px solid #dce3ee;border-radius:18px;background:#fff}h1{margin:.2em 0}.badge{display:inline-block;padding:5px 9px;border-radius:8px;background:#eaf2ff;color:#1d4ed8;font-size:12px;font-weight:800}a{display:inline-block;margin-top:18px;padding:12px 16px;border-radius:10px;background:#1268d8;color:white;text-decoration:none;font-weight:800}dl{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}dl div{padding:10px;border-radius:10px;background:#f3f6fa}dt{font-size:12px;color:#63708a}dd{margin:2px 0;font-weight:700}@media(max-width:600px){main{margin:0;min-height:100vh;border:0;border-radius:0}dl{grid-template-columns:1fr}}</style>
</head>
<body><main>
  <span class="badge">${properties.streamStatus === "verified-live" ? "LIVE terverifikasi" : "Direktori resmi"}</span>
  <h1>CCTV ${escapeHtml(name)}</h1>
  <p>${escapeHtml(description)}</p>
  <dl>
    <div><dt>Wilayah</dt><dd>${escapeHtml(region)}</dd></div>
    <div><dt>Koordinat</dt><dd>${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}</dd></div>
    <div><dt>Pengelola</dt><dd>${escapeHtml(properties.operator || "-")}</dd></div>
    <div><dt>Sumber</dt><dd>${escapeHtml(properties.source || "-")}</dd></div>
  </dl>
  <a href="${escapeHtml(mapUrl)}">Buka video dan analisis realtime</a>
  <p><small>Atribusi: ${escapeHtml(properties.attribution || properties.source || "penyedia data publik terkait")}.</small></p>
</main></body></html>`;
  const directory = path.join(outputRoot, slug);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "index.html"), html);
  links.push(`<li><a href="/cctv/${escapeHtml(slug)}">${escapeHtml(name)}</a><span>${escapeHtml(region)}</span></li>`);
  sitemapEntries.push(`  <url><loc>${canonical}</loc><changefreq>hourly</changefreq><priority>0.7</priority></url>`);
}

const collectionCanonical = `${siteOrigin}/cctv`;
const collectionStructured = {
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  "@id": `${collectionCanonical}#webpage`,
  name: "Daftar CCTV Lalu Lintas Indonesia | ITS Maps",
  description: "Daftar CCTV publik Indonesia dengan video realtime, analisis kendaraan, dan prediksi kepadatan ITS Maps.",
  url: collectionCanonical,
  inLanguage: "id-ID",
  mainEntity: {
    "@type": "ItemList",
    numberOfItems: features.length,
  },
};
await writeFile(path.join(outputRoot, "index.html"), `<!doctype html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="0;url=/?open=cctv">
  <title>Daftar CCTV Lalu Lintas Indonesia · ITS Maps</title>
  <meta name="description" content="Daftar CCTV publik Indonesia dengan video realtime, analisis kendaraan, dan prediksi kepadatan ITS Maps.">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
  <link rel="canonical" href="${collectionCanonical}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="ITS Maps">
  <meta property="og:locale" content="id_ID">
  <meta property="og:title" content="Daftar CCTV Lalu Lintas Indonesia · ITS Maps">
  <meta property="og:description" content="Daftar CCTV publik Indonesia dengan video realtime, analisis kendaraan, dan prediksi kepadatan ITS Maps.">
  <meta property="og:url" content="${collectionCanonical}">
  <meta property="og:image" content="${socialImage}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1280">
  <meta property="og:image:height" content="720">
  <meta property="og:image:alt" content="Peta CCTV dan lalu lintas realtime ITS Maps">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Daftar CCTV Lalu Lintas Indonesia · ITS Maps">
  <meta name="twitter:description" content="Daftar CCTV publik Indonesia dengan video realtime, analisis kendaraan, dan prediksi kepadatan ITS Maps.">
  <meta name="twitter:image" content="${socialImage}">
  <meta name="twitter:image:alt" content="Peta CCTV dan lalu lintas realtime ITS Maps">
  <script type="application/ld+json">${JSON.stringify(collectionStructured).replaceAll("<", "\\u003c")}</script>
  <style>body{font:15px/1.5 system-ui;color:#172033;max-width:920px;margin:auto;padding:28px}ul{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:9px;padding:0}li{display:grid;padding:12px;border:1px solid #dce3ee;border-radius:10px}a{font-weight:750;color:#1d4ed8;text-decoration:none}span{font-size:12px;color:#63708a}</style>
</head>
<body><h1>Daftar CCTV Lalu Lintas Indonesia</h1><p>${features.length} lokasi publik dari katalog ITS Maps. Status stream mengikuti penyedia resmi.</p><ul>${links.join("")}</ul></body>
</html>`);
const sitemap = await readFile(sitemapPath, "utf8");
const withoutGenerated = sitemap.replace(/\s*<url><loc>https:\/\/itstelkom\.web\.app\/cctv(?:\/[^<]*)?<\/loc>.*?<\/url>/gs, "");
const sitemapBlock = [
  "  <url><loc>https://itstelkom.web.app/cctv</loc><changefreq>hourly</changefreq><priority>0.8</priority></url>",
  ...sitemapEntries,
].join("\n");
await writeFile(sitemapPath, withoutGenerated.replace("</urlset>", `${sitemapBlock}\n</urlset>`));
console.log(`generate-cctv-index-pages: wrote ${features.length} CCTV page(s); removed ${removedStale} stale generated director${removedStale === 1 ? "y" : "ies"}.`);
