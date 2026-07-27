import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { aiHealth, retrieveKnowledge } from "./ai";
import { cleanText, enforceRateLimit, HttpError, json } from "./http";
import type { Env } from "./types";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const PUBLIC_ORIGIN = "https://itstelkom.web.app";

function textResult(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

async function publicContext(format: "summary" | "full") {
  const uri = `${PUBLIC_ORIGIN}/${format === "full" ? "llms-full.txt" : "llms.txt"}`;
  const response = await fetch(uri, {
    headers: { Accept: "text/plain" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new HttpError(502, "context_fetch_failed", `Konteks publik gagal dimuat (HTTP ${response.status}).`);
  return { uri, text: (await response.text()).slice(0, format === "full" ? 100_000 : 20_000) };
}

function sanitizedDevice(value: unknown, deviceId: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const traffic = record.traffic && typeof record.traffic === "object" ? record.traffic as Record<string, unknown> : {};
  const vehicle = record.vehicleBreakdown && typeof record.vehicleBreakdown === "object"
    ? record.vehicleBreakdown as Record<string, unknown>
    : {};
  return {
    deviceId,
    status: cleanText(record.status || record.connectionStatus, 40),
    lastSeen: cleanText(record.lastSeen || record.updatedAt || record.timestamp, 80),
    trafficColor: cleanText(record.trafficColor || traffic.color, 30),
    trafficDurationSec: Number(record.trafficDurationSec || traffic.durationSec || 0) || 0,
    totalVehicles: Number(record.totalVehicles || vehicle.total || 0) || 0,
    detectorStatus: cleanText(record.detectorStatus, 60),
    verified: false,
    source: "Firebase RTDB public sanitized view",
  };
}

function publicPageUrl(pathname: string) {
  const url = new URL(pathname || "/", PUBLIC_ORIGIN);
  if (url.origin !== PUBLIC_ORIGIN) throw new HttpError(400, "invalid_public_url", "Hanya halaman publik ITS Maps yang dapat diperiksa.");
  url.search = "";
  url.hash = "";
  return url;
}

async function inspectPublicPage(pathname: string) {
  const url = publicPageUrl(pathname);
  const response = await fetch(url, {
    headers: { Accept: "text/html" },
    signal: AbortSignal.timeout(12_000),
  });
  const html = (await response.text()).slice(0, 300_000);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() || "";
  return {
    url: url.href,
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    title,
    characters: html.length,
    hasMain: /<main[\s>]/i.test(html),
    hasDescription: /<meta[^>]+name=["']description["']/i.test(html),
  };
}

async function validatePublicManifest() {
  const url = `${PUBLIC_ORIGIN}/data/map-dynamics/manifest.json`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new HttpError(502, "manifest_fetch_failed", `Manifest merespons HTTP ${response.status}.`);
  const manifest = await response.json<Record<string, unknown>>();
  const shards = Array.isArray(manifest.shards) ? manifest.shards as Array<Record<string, unknown>> : [];
  const sample = shards.slice(0, 4);
  const checks = await Promise.all(sample.map(async (shard) => {
    const shardUrl = new URL(String(shard.url || ""), url);
    const shardResponse = await fetch(shardUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(15_000),
    });
    return { id: cleanText(shard.id, 160), url: shardUrl.href, status: shardResponse.status };
  }));
  return {
    url,
    schemaVersion: cleanText(manifest.schemaVersion, 40),
    datasetVersion: cleanText(manifest.datasetVersion, 100),
    shardCount: shards.length,
    sample: checks,
    valid: manifest.schemaVersion === "1.0" && shards.length > 0 && checks.every((check) => check.status === 200),
  };
}

function createItsMcpServer(env: Env) {
  const server = new McpServer(
    { name: "its-maps-cloudflare-mcp", version: "2.0.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: "Gunakan tool baca-saja ini untuk konteks publik ITS Maps. Jangan menyimpulkan lokasi privat atau kredensial.",
    },
  );

  server.registerTool("search_its_knowledge", {
    description: "Cari dokumentasi publik ITS Maps melalui AI Search dan Vectorize dengan URL sumber.",
    inputSchema: {
      query: z.string().min(1).max(2_000).describe("Pertanyaan atau istilah yang dicari."),
      limit: z.number().int().min(1).max(8).default(5).describe("Jumlah hasil maksimum."),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ query, limit }) => {
    const results = (await retrieveKnowledge(env, query)).slice(0, limit);
    return textResult({ query, results });
  });

  server.registerTool("get_its_public_device_status", {
    description: "Baca status perangkat publik yang sudah disanitasi tanpa lokasi, snapshot, token, atau URL kamera privat.",
    inputSchema: { deviceId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_.-]+$/).describe("ID perangkat publik.") },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ deviceId }) => {
    const response = await fetch(
      `https://itstelkom-default-rtdb.asia-southeast1.firebasedatabase.app/devices/${encodeURIComponent(deviceId)}.json`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) throw new HttpError(502, "firebase_read_failed", `Firebase merespons HTTP ${response.status}.`);
    return textResult({ status: sanitizedDevice(await response.json(), deviceId) });
  });

  server.registerTool("get_its_cloudflare_capabilities", {
    description: "Tampilkan status kapabilitas Cloudflare tanpa secret.",
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => textResult(await aiHealth(env)));

  server.registerTool("read_its_public_context", {
    description: "Baca llms.txt publik ITS Maps.",
    inputSchema: { format: z.enum(["summary", "full"]).default("summary").describe("Panjang konteks.") },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ format }) => {
    const context = await publicContext(format);
    return textResult({ uri: context.uri, characters: context.text.length, text: context.text });
  });

  server.registerTool("inspect_public_page", {
    description: "Periksa status, judul, content-type, dan struktur dasar halaman publik ITS Maps.",
    inputSchema: { path: z.string().max(500).default("/").describe("Path pada itstelkom.web.app.") },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ path }) => textResult(await inspectPublicPage(path)));

  server.registerTool("report_public_console_errors", {
    description: "Kelompokkan pesan error console publik yang dikirim client; tidak mengambil data browser privat.",
    inputSchema: { errors: z.array(z.string().max(2_000)).max(100).describe("Pesan error console yang sudah disanitasi.") },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ errors }) => {
    const grouped = Object.entries(errors.reduce<Record<string, number>>((accumulator, error) => {
      const key = cleanText(error, 500);
      accumulator[key] = (accumulator[key] || 0) + 1;
      return accumulator;
    }, {})).map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count);
    return textResult({ total: errors.length, grouped });
  });

  server.registerTool("report_public_network_failures", {
    description: "Kelompokkan kegagalan network publik yang dikirim client.",
    inputSchema: {
      failures: z.array(z.object({
        url: z.string().url().max(2_000),
        status: z.number().int().min(0).max(599),
      })).max(100),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ failures }) => textResult({ total: failures.length, failures }));

  server.registerTool("analyze_public_ui", {
    description: "Analisis metadata UI publik tanpa screenshot atau data pengguna.",
    inputSchema: { path: z.string().max(500).default("/").describe("Path halaman publik.") },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ path }) => textResult(await inspectPublicPage(path)));

  server.registerTool("list_public_map_layers", {
    description: "Daftar lapisan peta publik yang didokumentasikan ITS Maps.",
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => textResult({
    layers: ["Carto 2D", "bangunan 3D", "jalan detail", "rel dan transit", "air", "ruang hijau", "POI", "CCTV publik terverifikasi", "perangkat ITS"],
  }));

  server.registerTool("validate_public_map_manifest", {
    description: "Validasi manifest map-dynamics publik dan sampel pointer shard.",
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async () => textResult(await validatePublicManifest()));

  for (const format of ["summary", "full"] as const) {
    const uri = `itsmaps://public/${format}`;
    server.registerResource(`ITS Maps public ${format}`, uri, {
      title: `ITS Maps public ${format}`,
      description: "Konteks publik ITS Maps tanpa data privat.",
      mimeType: "text/plain",
    }, async () => {
      const context = await publicContext(format);
      return { contents: [{ uri, mimeType: "text/plain", text: context.text }] };
    });
  }
  return server;
}

export function mcpServerCard(): Response {
  return json({
    name: "its-maps-cloudflare-mcp",
    version: "2.0.0",
    implementation: "Cloudflare Agents SDK createMcpHandler + Model Context Protocol SDK",
    transport: "streamable-http-stateless",
    endpoint: "https://its.hanifahseptiani45.workers.dev/mcp",
    protocolVersion: MCP_PROTOCOL_VERSION,
  });
}

export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await enforceRateLimit(request, env, "mcp");
  if (request.method === "GET" && !request.headers.get("accept")?.includes("text/event-stream")) return mcpServerCard();
  const server = createItsMcpServer(env);
  return createMcpHandler(server, {
    route: "/mcp",
    enableJsonResponse: true,
    corsOptions: {
      origin: "*",
      methods: "GET, POST, DELETE, OPTIONS",
      headers: "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version",
      exposeHeaders: "Mcp-Session-Id",
    },
  })(request, env, ctx);
}
