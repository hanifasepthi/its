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
  if (!isApi) return proxyFrontend(request, env);
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
