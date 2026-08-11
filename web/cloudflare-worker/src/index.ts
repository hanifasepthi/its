import {
  aiHealth,
  handleChat,
  handleGenerate,
  handleKnowledgeSetup,
  handleModels,
  handleSearch,
} from "./ai";
import { errorResponse, HttpError, json, optionsResponse, requestOriginAllowed, withCors } from "./http";
import { handleMcp, mcpServerCard } from "./mcp";
import {
  handleMapDeltas,
  handleMapManifest,
  handleMapObservationBatch,
  handleVerifiedMapUpload,
  mapDataHealth,
} from "./mapData";
import {
  consumePushQueue,
  handleBroadcast,
  handleControllerEvent,
  handlePushConfig,
  handleSubscribe,
  handleUnsubscribe,
  pollPublicUpdate,
  pushHealth,
} from "./push";
import type { ApiContext, Env, PushDeliveryJob } from "./types";

export { AiBudget } from "./budget";

const API_PREFIXES = ["/api/", "/v1/"];
const FIREBASE_DATABASE_ORIGIN = "https://itstelkom-default-rtdb.asia-southeast1.firebasedatabase.app";

type PublicPresentationDeck = { title?: string; slides?: Array<{ elements?: Array<{ type?: string; src?: string; alt?: string }> }> };

function safePresentationId(value: string | null): string {
  const id = (value || "").trim();
  return /^[A-Za-z0-9_-]{4,128}$/.test(id) ? id : "";
}

async function publicPresentationDeck(projectId: string): Promise<PublicPresentationDeck | null> {
  if (!projectId) return null;
  const response = await fetch(`${FIREBASE_DATABASE_ORIGIN}/presentations/${encodeURIComponent(projectId)}/deck.json`, {
    headers: { Accept: "application/json" }, cf: { cacheTtl: 30, cacheEverything: true },
  });
  if (!response.ok) return null;
  const value = await response.json<unknown>();
  return value && typeof value === "object" ? value as PublicPresentationDeck : null;
}

function presentationImageSource(deck: PublicPresentationDeck | null): string {
  const elements = deck?.slides?.[0]?.elements || [];
  return elements.find((item) => item?.type === "image" && typeof item.src === "string")?.src || "";
}

function decodeDataImage(source: string): { bytes: Uint8Array; type: string } | null {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(source);
  if (!match) return null;
  const binary = atob(match[2]); const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { bytes, type: match[1].toLowerCase() };
}

async function presentationOgImage(request: Request): Promise<Response> {
  const url = new URL(request.url); const projectId = safePresentationId(url.searchParams.get("p"));
  const deck = await publicPresentationDeck(projectId); const source = presentationImageSource(deck);
  const decoded = decodeDataImage(source);
  if (decoded) {
    const body = decoded.bytes.buffer.slice(decoded.bytes.byteOffset, decoded.bytes.byteOffset + decoded.bytes.byteLength) as ArrayBuffer;
    return new Response(body, { headers: { "Content-Type": decoded.type, "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" } });
  }
  if (/^https:\/\//i.test(source)) {
    const image = await fetch(source, { redirect: "follow" });
    if (image.ok && (image.headers.get("Content-Type") || "").startsWith("image/")) return new Response(image.body, { headers: { "Content-Type": image.headers.get("Content-Type")!, "Cache-Control": "public, max-age=60" } });
  }
  const title = (deck?.title || "ITS Presentasi").slice(0, 90).replace(/[<>&]/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#111827"/><stop offset="1" stop-color="#be123c"/></linearGradient></defs><rect width="1200" height="630" fill="url(#g)"/><rect x="70" y="70" width="1060" height="490" rx="22" fill="#fff"/><text x="120" y="175" font-family="Arial,sans-serif" font-size="30" fill="#be123c">ITS PRESENTASI</text><text x="120" y="300" font-family="Arial,sans-serif" font-size="58" font-weight="700" fill="#111827">${title}</text><text x="120" y="470" font-family="Arial,sans-serif" font-size="28" fill="#475569">Buka slide, komentar, dan presentasi realtime</text></svg>`;
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=60" } });
}

async function injectPresentationMetadata(request: Request, response: Response): Promise<Response> {
  const url = new URL(request.url); const projectId = safePresentationId(url.searchParams.get("p"));
  if (!projectId || !response.ok || !(response.headers.get("Content-Type") || "").includes("text/html")) return response;
  const deck = await publicPresentationDeck(projectId); if (!deck) return response;
  const title = (deck.title || "ITS Presentasi").trim().slice(0, 120);
  const description = `Buka ${title} di ITS Presentasi — slide realtime, komentar, dan mode pemirsa.`;
  const image = `${url.origin}/presentation/og-image?p=${encodeURIComponent(projectId)}`;
  const escaped = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  let html = await response.text();
  const replacements: Record<string, string> = { "og:title": title, "og:description": description, "og:url": url.href, "og:image": image, "twitter:title": title, "twitter:description": description, "twitter:image": image };
  for (const [name, value] of Object.entries(replacements)) {
    const attribute = name.startsWith("og:") ? "property" : "name";
    const pattern = new RegExp(`(<meta\\s+${attribute}=["']${name.replace(":", "\\:")}["']\\s+content=["'])[^"']*(["'])`, "i");
    html = html.replace(pattern, `$1${escaped(value)}$2`);
  }
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${escaped(title)} | ITS Presentasi</title>`);
  const headers = new Headers(response.headers); headers.delete("Content-Length"); headers.set("Cache-Control", "no-cache, no-store, must-revalidate"); headers.set("X-ITS-Presentation-OG", "dynamic");
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

function noIndexResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function routeMatches(pathname: string, ...paths: string[]): boolean {
  return paths.includes(pathname);
}

async function nationalArchive(request: Request, env: Env): Promise<Response> {
  const key = "map/v1/national/indonesia.pmtiles";
  if (request.method === "HEAD" && env.MAP_ARCHIVE) {
    const head = await env.MAP_ARCHIVE.head(key);
    if (head) {
      const headers = new Headers({
        "Content-Type": "application/vnd.pmtiles",
        "Content-Length": String(head.size),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=86400",
        ETag: head.httpEtag,
      });
      return new Response(null, { status: 200, headers });
    }
  }
  if (request.method === "GET" && env.MAP_ARCHIVE) {
    const object = await env.MAP_ARCHIVE.get(key, { range: request.headers });
    if (object) {
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("Content-Type", "application/vnd.pmtiles");
      headers.set("Accept-Ranges", "bytes");
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      headers.set("ETag", object.httpEtag);
      if (object.range) {
        const range = object.range as { offset: number; length: number };
        headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
        headers.set("Content-Length", String(range.length));
        return new Response(object.body, { status: 206, headers });
      }
      headers.set("Content-Length", String(object.size));
      return new Response(object.body, { status: 200, headers });
    }
  }

  const upstream = "https://github.com/hanifasepthi/its/releases/download/map-data-2026-07-21/indonesia.pmtiles";
  const upstreamHeaders = new Headers();
  const range = request.headers.get("Range");
  if (range) upstreamHeaders.set("Range", range);
  let response = await fetch(upstream, {
    method: request.method,
    headers: upstreamHeaders,
    // GitHub release assets redirect to blob storage. Following automatically can
    // discard Range, which would make a PMTiles client download the entire archive.
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location");
    if (!location) throw new HttpError(502, "map_archive_redirect_failed", "Redirect arsip peta nasional tidak valid.");
    response = await fetch(new URL(location, upstream).toString(), {
      method: request.method,
      headers: upstreamHeaders,
      redirect: "follow",
      // Signed GitHub release-asset URLs are short-lived and range-specific.
      // Caching that URL at Cloudflare can replay an expired signature and
      // produce a 502 even while the release asset itself remains healthy.
    });
  }
  if (!response.ok) throw new HttpError(502, "map_archive_upstream_failed", "Arsip peta nasional gagal dibaca dari GitHub.");
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/vnd.pmtiles");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.delete("Content-Disposition");
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function publicGitHubArchive(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const owner = (url.searchParams.get("owner") || "").trim();
  const repo = (url.searchParams.get("repo") || "").trim().replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)
    || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) {
    throw new HttpError(400, "invalid_github_repository", "Owner atau nama repositori GitHub tidak valid.");
  }
  // This deliberately cannot proxy an arbitrary URL: only GitHub's public
  // codeload archive for validated owner/repository coordinates is reachable.
  const upstream = `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zip/HEAD`;
  const response = await fetch(upstream, {
    headers: { Accept: "application/zip", "User-Agent": "ITS-Maps-public-research/1.0" },
    redirect: "follow",
  });
  if (!response.ok) throw new HttpError(502, "github_archive_failed", `GitHub archive merespons HTTP ${response.status}.`);
  const declared = Number(response.headers.get("Content-Length") || 0);
  if (declared > 25_000_000) throw new HttpError(413, "github_archive_too_large", "ZIP repositori melebihi batas pembaca lokal 25 MB.");
  const headers = new Headers({
    "Content-Type": "application/zip",
    "Cache-Control": "public, max-age=900",
    "Content-Disposition": `attachment; filename="${repo}-HEAD.zip"`,
  });
  if (declared) headers.set("Content-Length", String(declared));
  return new Response(response.body, { status: 200, headers });
}

async function health(env: Env): Promise<Response> {
  const [ai, push] = await Promise.all([aiHealth(env), pushHealth(env)]);
  return json({
    ok: true,
    service: "its-maps-cloudflare-edge",
    version: "1.1.0",
    now: new Date().toISOString(),
    account: "9d6c1075d9960e3ff376f31d1b8bc590",
    endpoints: {
      frontend: env.UPSTREAM_ORIGIN || "https://itstelkom.web.app",
      worker: "https://its.hanifahseptiani45.workers.dev",
      mcp: "/mcp",
      models: "/v1/ai/models",
      chat: "/v1/ai/chat",
      search: "/v1/ai/search",
      push: "/v1/push/config",
      mapManifest: "/v1/map/manifest",
      mapViewport: "/v1/map/deltas?bbox=minLng,minLat,maxLng,maxLat",
      mapObservations: "/v1/map/observations",
      mapArchive: "/v1/map/archive/indonesia.pmtiles",
      githubArchive: "/v1/research/github/archive?owner=OWNER&repo=REPOSITORY",
    },
    capabilities: { ai, push, mapData: mapDataHealth(env), mcp: { protocol: "2025-06-18", stateless: true } },
    freeTierMode: true,
  });
}

async function apiRouter(context: ApiContext): Promise<Response> {
  const { request, env, execution } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (request.method === "OPTIONS") return optionsResponse(request, env);
  if (!requestOriginAllowed(request, env)) throw new HttpError(403, "origin_not_allowed", "Origin tidak diizinkan.");

  if (routeMatches(path, "/health", "/api/health", "/v1/health") && request.method === "GET") return health(env);
  if (routeMatches(path, "/api/ai/models", "/v1/ai/models") && request.method === "GET") return handleModels(env);
  if (routeMatches(path, "/api/ai/generate", "/v1/ai/generate") && request.method === "POST") return handleGenerate(request, env);
  if (routeMatches(path, "/api/ai/chat", "/v1/ai/chat") && request.method === "POST") return handleChat(request, env);
  if (routeMatches(path, "/api/ai/search", "/api/ai/retrieve", "/v1/ai/search", "/v1/ai/retrieve")
    && (request.method === "GET" || request.method === "POST")) return handleSearch(request, env);
  if (routeMatches(path, "/api/admin/knowledge/setup", "/v1/admin/knowledge/setup") && request.method === "POST") {
    return handleKnowledgeSetup(request, env);
  }

  if (routeMatches(path, "/api/map/manifest", "/v1/map/manifest") && request.method === "GET") {
    return handleMapManifest(request, env);
  }
  if (routeMatches(path, "/api/map/archive/indonesia.pmtiles", "/v1/map/archive/indonesia.pmtiles")
    && (request.method === "GET" || request.method === "HEAD")) {
    return nationalArchive(request, env);
  }
  if (routeMatches(path, "/api/research/github/archive", "/v1/research/github/archive")
    && request.method === "GET") {
    return publicGitHubArchive(request);
  }
  if (routeMatches(path, "/api/map/deltas", "/v1/map/deltas") && request.method === "GET") {
    return handleMapDeltas(request, env);
  }
  if (routeMatches(path, "/api/map/observations", "/v1/map/observations") && request.method === "POST") {
    return handleMapObservationBatch(request, env);
  }
  if (routeMatches(path, "/api/admin/map/verified", "/v1/admin/map/verified") && request.method === "POST") {
    return handleVerifiedMapUpload(request, env);
  }

  if (routeMatches(path, "/api/push/config", "/v1/push/config") && request.method === "GET") return handlePushConfig(env);
  if (routeMatches(path, "/api/push/subscriptions", "/v1/push/subscriptions") && request.method === "POST") {
    return handleSubscribe(request, env);
  }
  if (routeMatches(path, "/api/push/subscriptions", "/v1/push/subscriptions") && request.method === "DELETE") {
    return handleUnsubscribe(request, env);
  }
  if (routeMatches(path, "/api/push/broadcast", "/v1/push/broadcast") && request.method === "POST") {
    return handleBroadcast(request, env);
  }
  if (routeMatches(path, "/api/events/controller", "/v1/events/controller") && request.method === "POST") {
    return handleControllerEvent(request, env);
  }

  if (path === "/mcp" || path.startsWith("/mcp/")) {
    if (request.method === "GET" || request.method === "POST" || request.method === "DELETE" || request.method === "OPTIONS") {
      return handleMcp(request, env, execution);
    }
    throw new HttpError(405, "method_not_allowed", "Gunakan GET atau POST untuk MCP.");
  }
  if (path === "/.well-known/mcp.json" && request.method === "GET") return mcpServerCard();

  throw new HttpError(404, "not_found", "Endpoint ITS Maps Cloudflare tidak ditemukan.");
}

async function proxyFrontend(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ ok: false, error: "method_not_allowed", message: "Route frontend hanya menerima GET atau HEAD." }, 405);
  }
  const upstream = new URL(env.UPSTREAM_ORIGIN || "https://itstelkom.web.app");
  const incoming = new URL(request.url);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  const headers = new Headers();
  for (const name of ["Accept", "Accept-Encoding", "Accept-Language", "Cache-Control", "If-Modified-Since", "If-None-Match", "Range", "User-Agent"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("X-ITS-Edge-Proxy", "cloudflare-worker");
  const response = await fetch(new Request(upstream, { method: request.method, headers, redirect: "follow" }));
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("Set-Cookie");
  responseHeaders.delete("Set-Cookie2");
  responseHeaders.set("X-ITS-Cloudflare-Edge", "its-maps");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  responseHeaders.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

async function handleFetch(request: Request, env: Env, execution: ExecutionContext): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/presentation/og-image" && (request.method === "GET" || request.method === "HEAD")) return presentationOgImage(request);
  if (pathname === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=3600",
        "x-robots-tag": "noindex, nofollow, noarchive",
      },
    });
  }
  const isApi = pathname === "/health"
    || pathname === "/mcp"
    || pathname.startsWith("/mcp/")
    || pathname === "/.well-known/mcp.json"
    || API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  if (!isApi) {
    const response = await proxyFrontend(request, env);
    return pathname === "/presentation" || pathname === "/presentation/" ? injectPresentationMetadata(request, response) : response;
  }
  try {
    const response = await apiRouter({ request, env, execution });
    return noIndexResponse(withCors(response, request, env));
  } catch (error) {
    return noIndexResponse(withCors(errorResponse(error), request, env));
  }
}

export default {
  fetch: handleFetch,
  async scheduled(_controller: ScheduledController, env: Env, execution: ExecutionContext): Promise<void> {
    execution.waitUntil(pollPublicUpdate(env).catch((error) => console.error("Scheduled public update check failed", error)));
  },
  async queue(batch: MessageBatch<PushDeliveryJob>, env: Env): Promise<void> {
    await consumePushQueue(batch, env);
  },
} satisfies ExportedHandler<Env, PushDeliveryJob>;
