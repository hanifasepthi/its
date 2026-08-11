import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const appUpdatePath = path.join(webRoot, "public", "app-update.json");
const appsDir = path.join(webRoot, "dist", "artifacts", "apps");
const distDir = path.join(webRoot, "dist");
const analyticsConfig = readJson(path.join(webRoot, "analytics.config.json"));
const SITE_ORIGIN = "https://itstelkom.web.app";
const CLOUDFLARE_WEB_ANALYTICS_TOKEN = String(
  process.env.CLOUDFLARE_WEB_ANALYTICS_TOKEN || analyticsConfig.cloudflareWebAnalyticsToken || "",
).trim();
const GOOGLE_MEASUREMENT_ID = String(
  process.env.GOOGLE_MEASUREMENT_ID || analyticsConfig.googleMeasurementId || "",
).trim();
const MICROSOFT_CLARITY_PROJECT_ID = String(
  process.env.MICROSOFT_CLARITY_PROJECT_ID || analyticsConfig.microsoftClarityProjectId || "",
).trim();
const GOOGLE_SITE_VERIFICATION = "c8bcvZrCDvCbFQbw1nvSf4Dvemq6qb35bh1J64DJ_2g";
const BING_SITE_VERIFICATION = "C6357AD329BE82ECD8276C53EB8CDFA7";
const DEFAULT_SOCIAL_IMAGE = `${SITE_ORIGIN}/screenshots/desktop-home.png`;
// Pin map data to the immutable revision that introduced the classified
// national shards. The former moving branch later replaced these filenames,
// producing a 404 whenever users panned into affected tiles.
const MAP_DATA_REVISION = "3c949a81c73badc44fde9c66ef193ce0464c7161";
const MAP_DATA_GITHUB_BASE =
  `https://raw.githubusercontent.com/hanifasepthi/its/${MAP_DATA_REVISION}/web/public/data/map-dynamics`;
const cloudflareAnalyticsConfigured = /^[a-f0-9]{32}$/i.test(CLOUDFLARE_WEB_ANALYTICS_TOKEN);
const googleAnalyticsConfigured = /^G-[A-Z0-9]+$/i.test(GOOGLE_MEASUREMENT_ID);
const clarityConfigured = /^[a-z0-9-]{4,64}$/i.test(MICROSOFT_CLARITY_PROJECT_ID);
const clientAnalyticsConfigured = googleAnalyticsConfigured || clarityConfigured || cloudflareAnalyticsConfigured;
const analyticsLoaderTag = '\n  <!-- Privacy-minimal automatic analytics loader -->\n  <script defer src="/analytics.js"></script>\n';

const seoRoutes = new Map([
  ["index.html", { path: "/", type: "WebPage", image: DEFAULT_SOCIAL_IMAGE }],
  ["presentation/index.html", { path: "/presentation", type: "WebApplication", image: `${SITE_ORIGIN}/screenshots/presentation/og-default.png` }],
  ["documentation/index.html", { path: "/documentation", type: "TechArticle" }],
  ["method/index.html", { path: "/method", type: "TechArticle" }],
  ["method/webapp/index.html", { path: "/method/webapp", type: "TechArticle" }],
  ["method/android/index.html", { path: "/method/android", type: "TechArticle" }],
  ["method/windows/index.html", { path: "/method/windows", type: "TechArticle" }],
  ["privacy/index.html", { path: "/privacy", type: "WebPage" }],
  ["licence/index.html", { path: "/licence", type: "WebPage" }],
  ["license/index.html", { path: "/license", type: "WebPage" }],
  ["roadmap/index.html", { path: "/roadmap", type: "Article", image: `${SITE_ORIGIN}/roadmap/assets/story1.png` }],
  ["pdf-preview/index.html", { path: "/pdf-preview/documentation", type: "WebPage" }],
  ["pdf-preview/documentation/index.html", { path: "/pdf-preview/documentation", type: "WebPage" }],
  ["pdf-preview/method/index.html", { path: "/pdf-preview/method", type: "WebPage" }],
  ["pdf-preview/android/index.html", { path: "/pdf-preview/android", type: "WebPage" }],
  ["pdf-preview/windows/index.html", { path: "/pdf-preview/windows", type: "WebPage" }],
  ["pdf-preview/webapp/index.html", { path: "/pdf-preview/webapp", type: "WebPage" }],
  ["pdf-preview/licence/index.html", { path: "/pdf-preview/licence", type: "WebPage" }],
  ["pdf-preview/license/index.html", { path: "/pdf-preview/license", type: "WebPage" }],
  ["pdf-preview/fte-cd-6/index.html", { path: "/pdf-preview/fte-cd-6", type: "WebPage" }],
]);

const noIndexHtml = new Set([
  "desktop/renderer.html",
  "lockscreen-detector.html",
]);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function keepHostingArtifacts() {
  if (!fs.existsSync(appsDir)) return;
  const update = readJson(appUpdatePath);
  const fileName = typeof update.fileName === "string" ? update.fileName : "ITS-Maps-Android-latest.apk";
  const keep = new Set([
    `${fileName}.b64`,
    "ITS-Maps-Android-latest.apk.b64",
  ]);

  let removed = 0;
  for (const entry of fs.readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (keep.has(entry.name)) continue;
    fs.rmSync(path.join(appsDir, entry.name), { force: true });
    removed += 1;
  }
  console.log(`prepare-hosting-artifacts: kept ${Array.from(keep).join(", ")}; removed ${removed} old app artifact(s).`);
}

function externalizeMapDynamicsShards() {
  const manifestPath = path.join(distDir, "data", "map-dynamics", "manifest.json");
  if (!fs.existsSync(manifestPath)) return;
  const manifest = readJson(manifestPath);
  if (!Array.isArray(manifest.shards)) return;
  manifest.shards = manifest.shards.map((shard) => {
    if (!shard || typeof shard !== "object" || typeof shard.url !== "string") return shard;
    if (/^\.\.\/map-hotspots\//.test(shard.url.replaceAll("\\", "/"))) {
      const fileName = path.posix.basename(shard.url.replaceAll("\\", "/"));
      return {
        ...shard,
        url: `${MAP_DATA_GITHUB_BASE.replace(/\/map-dynamics$/, "")}/map-hotspots/${encodeURIComponent(fileName)}`,
      };
    }
    if (!/^\.\/shards\//.test(shard.url.replaceAll("\\", "/"))) return shard;
    const fileName = path.posix.basename(shard.url.replaceAll("\\", "/"));
    return {
      ...shard,
      url: `${MAP_DATA_GITHUB_BASE}/shards/${encodeURIComponent(fileName)}`,
    };
  });
  manifest.hosting = {
    ...(manifest.hosting && typeof manifest.hosting === "object" ? manifest.hosting : {}),
    strategy: "github-external-shards",
    baseUrl: MAP_DATA_GITHUB_BASE,
    revision: MAP_DATA_REVISION,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`prepare-hosting-artifacts: externalized ${manifest.shards.length} map shard URL(s) to GitHub.`);
}

function analyticsScript() {
  const config = JSON.stringify({
    cloudflareWebAnalyticsToken: cloudflareAnalyticsConfigured ? CLOUDFLARE_WEB_ANALYTICS_TOKEN : "",
    googleMeasurementId: GOOGLE_MEASUREMENT_ID,
    microsoftClarityProjectId: clarityConfigured ? MICROSOFT_CLARITY_PROJECT_ID : "",
  }).replaceAll("<", "\\u003c");
  return `(() => {
  "use strict";
  const config = ${config};
  const acceptedConsent = Object.freeze({ analytics: true, advertising: false });
  const providerStatus = {
    google: config.googleMeasurementId ? "pending" : "not-configured",
    clarity: config.microsoftClarityProjectId ? "pending" : "not-configured",
    cloudflare: config.cloudflareWebAnalyticsToken ? "pending" : "not-configured"
  };
  const publishStatus = (provider, status) => {
    providerStatus[provider] = status;
    document.documentElement.dataset["analytics" + provider[0].toUpperCase() + provider.slice(1)] = status;
    document.dispatchEvent(new CustomEvent("its:analytics-status", {
      detail: { provider, status, providers: { ...providerStatus } }
    }));
  };
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function(){ window.dataLayer.push(arguments); };
  window.gtag("consent", "default", {
    analytics_storage: "granted",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied"
  });
  window.gtag("set", "ads_data_redaction", true);

  const sanitizedUrl = (value) => {
    try {
      const url = new URL(String(value || ""), location.origin);
      return url.origin + url.pathname;
    } catch {
      return location.origin + location.pathname;
    }
  };

  const loadGoogle = () => {
    const id = String(config.googleMeasurementId || "");
    if (!/^(?:G|GT|AW)-[A-Z0-9-]+$/i.test(id) || document.querySelector("script[data-its-google-tag]")) return;
    const script = document.createElement("script");
    script.async = true;
    script.dataset.itsGoogleTag = "true";
    script.addEventListener("load", () => publishStatus("google", "active"), { once: true });
    script.addEventListener("error", () => publishStatus("google", "blocked"), { once: true });
    script.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(id);
    document.head.appendChild(script);
    window.gtag("js", new Date());
    window.gtag("config", id, {
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      page_location: sanitizedUrl(location.href),
      page_referrer: document.referrer ? sanitizedUrl(document.referrer) : ""
    });
    window.gtag("event", "page_view", {
      page_location: sanitizedUrl(location.href),
      page_referrer: document.referrer ? sanitizedUrl(document.referrer) : ""
    });
  };

  const loadCloudflare = () => {
    const token = String(config.cloudflareWebAnalyticsToken || "");
    if (!/^[a-f0-9]{32}$/i.test(token) || document.querySelector("script[data-cf-beacon]")) return;
    const script = document.createElement("script");
    script.defer = true;
    script.dataset.cfBeacon = JSON.stringify({ token, spa: false });
    script.addEventListener("load", () => publishStatus("cloudflare", "active"), { once: true });
    script.addEventListener("error", () => publishStatus("cloudflare", "blocked"), { once: true });
    script.src = "https://static.cloudflareinsights.com/beacon.min.js";
    document.head.appendChild(script);
  };

  const sensitiveSelector = "#map,video,canvas,input,textarea,[contenteditable=true],[data-camera],[data-video],[data-device-id],[data-user-location],[data-its-ai-chat],[data-ai-chat-form],[data-ai-chat-log],#its-ai-chat-modal,#its-ai-chat-detection-detail-modal,.leaflet-container,.maplibregl-map";
  const maskSensitiveContent = (root) => {
    if (root instanceof Element && root.matches(sensitiveSelector)) root.setAttribute("data-clarity-mask", "true");
    if (root && typeof root.querySelectorAll === "function") {
      root.querySelectorAll(sensitiveSelector).forEach((element) => element.setAttribute("data-clarity-mask", "true"));
    }
  };

  const loadClarity = () => {
    const id = String(config.microsoftClarityProjectId || "");
    if (!/^[a-z0-9-]{4,64}$/i.test(id) || document.querySelector("script[data-its-clarity]")) return;
    const measuredPath = /^(?:\\/|\\/documentation|\\/method(?:\\/[^/]*)?|\\/privacy|\\/roadmap|\\/licence|\\/license|\\/pdf-preview(?:\\/[^/]*)?)\\/?$/i.test(location.pathname);
    if (!measuredPath) return;
    maskSensitiveContent(document);
    window.clarity = window.clarity || function(){ (window.clarity.q = window.clarity.q || []).push(arguments); };
    window.clarity("consentv2", { ad_Storage: "denied", analytics_Storage: "granted" });
    const script = document.createElement("script");
    script.async = true;
    script.dataset.itsClarity = "true";
    script.addEventListener("load", () => publishStatus("clarity", "active"), { once: true });
    script.addEventListener("error", () => publishStatus("clarity", "blocked"), { once: true });
    script.src = "https://www.clarity.ms/tag/" + encodeURIComponent(id);
    document.head.appendChild(script);
  };

  const track = (name, parameters = {}) => {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(String(name))) return false;
    const allowedParameters = new Set(["action", "category", "mode", "platform", "status", "surface"]);
    const safe = {};
    Object.entries(parameters).slice(0, 12).forEach(([key, value]) => {
      if (!allowedParameters.has(key)) return;
      if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
      else if (typeof value === "boolean") safe[key] = value;
      else if (typeof value === "string") safe[key] = value.slice(0, 80);
    });
    window.gtag("event", name, {
      ...safe,
      page_location: sanitizedUrl(location.href),
      page_referrer: document.referrer ? sanitizedUrl(document.referrer) : ""
    });
    return true;
  };

  const installPrivacyGuards = () => {
    maskSensitiveContent(document);
    const observer = new MutationObserver((records) => {
      records.forEach((record) => record.addedNodes.forEach((node) => maskSensitiveContent(node)));
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("button,a") : null;
      if (!target) return;
      if (target.matches("[data-enable-notifications]")) track("notification_preference_click");
      else if (target.matches("[data-mode]")) track("map_mode_select", { mode: target.getAttribute("data-mode") || "unknown" });
      else if (target.matches("[data-windows-download]")) track("app_download_click", { platform: "windows" });
    }, { passive: true });
    document.addEventListener("submit", (event) => {
      const form = event.target instanceof Element ? event.target : null;
      if (form && form.matches("[data-ai-chat-form]")) track("ai_request", { surface: "chat" });
    }, { passive: true });
  };

  const updateConsent = (choice) => {
    const analytics = choice?.analytics === true;
    const advertising = choice?.advertising === true;
    window.gtag("consent", "update", {
      analytics_storage: analytics ? "granted" : "denied",
      ad_storage: advertising ? "granted" : "denied",
      ad_user_data: advertising ? "granted" : "denied",
      ad_personalization: advertising ? "granted" : "denied"
    });
    if (analytics) {
      loadCloudflare();
      loadGoogle();
      loadClarity();
      window.clarity?.("consentv2", { ad_Storage: advertising ? "granted" : "denied", analytics_Storage: "granted" });
    }
  };

  window.ITSAnalytics = {
    track,
    updateConsent,
    status: () => ({ ...providerStatus })
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      installPrivacyGuards();
      updateConsent(acceptedConsent);
    }, { once: true });
  } else {
    installPrivacyGuards();
    updateConsent(acceptedConsent);
  }
})();\n`;
}

function writeAnalyticsAsset() {
  if (!fs.existsSync(distDir) || !clientAnalyticsConfigured) return;
  fs.writeFileSync(path.join(distDir, "analytics.js"), analyticsScript(), "utf8");
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasNamedMeta(html, name) {
  return new RegExp(`<meta\\b(?=[^>]*\\bname\\s*=\\s*["']${escapeRegExp(name)}["'])[^>]*>`, "i").test(html);
}

function hasPropertyMeta(html, property) {
  return new RegExp(`<meta\\b(?=[^>]*\\bproperty\\s*=\\s*["']${escapeRegExp(property)}["'])[^>]*>`, "i").test(html);
}

function metaContent(html, attribute, value) {
  const tag = html.match(new RegExp(`<meta\\b(?=[^>]*\\b${attribute}\\s*=\\s*["']${escapeRegExp(value)}["'])[^>]*>`, "i"))?.[0] || "";
  return tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1]?.trim() || "";
}

function titleText(html) {
  return (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "ITS Maps")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .trim();
}

function normalizeSocialImages(html) {
  return html.replace(
    /(<meta\b(?=[^>]*(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'])[^>]*\bcontent\s*=\s*["'])(\/[^"']+)(["'][^>]*>)/gi,
    (_match, before, assetPath, after) => `${before}${SITE_ORIGIN}${assetPath}${after}`,
  );
}

function seoTags(html, route) {
  const canonical = `${SITE_ORIGIN}${route.path}`;
  const title = titleText(html);
  const description = metaContent(html, "name", "description")
    || "ITS Maps adalah peta lalu lintas realtime dengan kamera, AI RF-DETR, Raspberry Pi, Firebase, Android, dan Windows.";
  const image = metaContent(html, "property", "og:image") || route.image || DEFAULT_SOCIAL_IMAGE;
  const absoluteImage = image.startsWith("/") ? `${SITE_ORIGIN}${image}` : image;
  const tags = [];

  if (!hasNamedMeta(html, "google-site-verification")) tags.push(`<meta name="google-site-verification" content="${GOOGLE_SITE_VERIFICATION}" />`);
  if (!hasNamedMeta(html, "msvalidate.01")) tags.push(`<meta name="msvalidate.01" content="${BING_SITE_VERIFICATION}" />`);
  if (!hasNamedMeta(html, "robots")) tags.push('<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />');
  if (!/<link\b(?=[^>]*\brel\s*=\s*["']canonical["'])[^>]*>/i.test(html)) tags.push(`<link rel="canonical" href="${escapeHtmlAttribute(canonical)}" />`);
  if (!hasPropertyMeta(html, "og:locale")) tags.push('<meta property="og:locale" content="id_ID" />');
  if (!hasPropertyMeta(html, "og:site_name")) tags.push('<meta property="og:site_name" content="ITS Maps" />');
  if (!hasPropertyMeta(html, "og:type")) tags.push(`<meta property="og:type" content="${route.type === "Article" || route.type === "TechArticle" ? "article" : "website"}" />`);
  if (!hasPropertyMeta(html, "og:title")) tags.push(`<meta property="og:title" content="${escapeHtmlAttribute(title)}" />`);
  if (!hasPropertyMeta(html, "og:description")) tags.push(`<meta property="og:description" content="${escapeHtmlAttribute(description)}" />`);
  if (!hasPropertyMeta(html, "og:url")) tags.push(`<meta property="og:url" content="${escapeHtmlAttribute(canonical)}" />`);
  if (!hasPropertyMeta(html, "og:image")) tags.push(`<meta property="og:image" content="${escapeHtmlAttribute(absoluteImage)}" />`);
  if (!hasPropertyMeta(html, "og:image:alt")) tags.push('<meta property="og:image:alt" content="Pratinjau ITS Maps" />');
  if (!hasNamedMeta(html, "twitter:card")) tags.push('<meta name="twitter:card" content="summary_large_image" />');
  if (!hasNamedMeta(html, "twitter:title")) tags.push(`<meta name="twitter:title" content="${escapeHtmlAttribute(title)}" />`);
  if (!hasNamedMeta(html, "twitter:description")) tags.push(`<meta name="twitter:description" content="${escapeHtmlAttribute(description)}" />`);
  if (!hasNamedMeta(html, "twitter:image")) tags.push(`<meta name="twitter:image" content="${escapeHtmlAttribute(absoluteImage)}" />`);
  if (!hasNamedMeta(html, "twitter:image:alt")) tags.push('<meta name="twitter:image:alt" content="Pratinjau ITS Maps" />');

  if (!/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>/i.test(html)) {
    const structuredData = {
      "@context": "https://schema.org",
      "@type": route.type,
      "@id": `${canonical}#webpage`,
      url: canonical,
      name: title,
      description,
      inLanguage: "id-ID",
      isPartOf: { "@id": `${SITE_ORIGIN}/#website` },
      publisher: { "@id": `${SITE_ORIGIN}/#organization` },
    };
    tags.push(`<script type="application/ld+json">${JSON.stringify(structuredData).replaceAll("<", "\\u003c")}</script>`);
  }

  return tags.length ? `\n  <!-- ITS Maps technical SEO -->\n  ${tags.join("\n  ")}\n` : "";
}

function noIndexTags(html) {
  if (hasNamedMeta(html, "robots")) return "";
  return '\n  <meta name="robots" content="noindex, nofollow, noarchive" />\n';
}

function enhanceHtmlFiles(directory) {
  if (!fs.existsSync(directory)) return 0;
  let updated = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      updated += enhanceHtmlFiles(fullPath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
    const originalHtml = fs.readFileSync(fullPath, "utf8");
    const headEnd = originalHtml.indexOf("</head>");
    if (headEnd < 0) continue;
    const relativePath = path.relative(distDir, fullPath).replaceAll("\\", "/");
    const route = seoRoutes.get(relativePath);
    let html = normalizeSocialImages(originalHtml);
    let additions = "";
    const isAmp = /<html\b[^>]*\bamp\b/i.test(html);
    if (route && !isAmp && clientAnalyticsConfigured && !html.includes('/analytics.js')) additions += analyticsLoaderTag;
    if (route) additions += seoTags(html, route);
    if (noIndexHtml.has(relativePath)) additions += noIndexTags(html);
    if (additions) html = html.replace("</head>", `${additions}</head>`);
    if (html !== originalHtml) {
      fs.writeFileSync(fullPath, html, "utf8");
      updated += 1;
    }
  }
  return updated;
}

keepHostingArtifacts();
externalizeMapDynamicsShards();
writeAnalyticsAsset();
const enhanced = enhanceHtmlFiles(distDir);
console.log(`prepare-hosting-artifacts: enhanced analytics/SEO in ${enhanced} generated HTML file(s).`);
if (!clarityConfigured) {
  console.log("prepare-hosting-artifacts: Microsoft Clarity menunggu microsoftClarityProjectId di analytics.config.json.");
}
if (!cloudflareAnalyticsConfigured) {
  console.log("prepare-hosting-artifacts: Cloudflare Web Analytics menunggu token 32-hex yang valid.");
}
