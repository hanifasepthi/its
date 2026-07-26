import { aiHealth, retrieveKnowledge } from "./ai";
import { cleanText, enforceRateLimit, HttpError, json, readJson } from "./http";
import type { Env } from "./types";

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
};

const MCP_PROTOCOL_VERSION = "2025-06-18";

const TOOLS: McpTool[] = [
  {
    name: "search_its_knowledge",
    description: "Search public ITS Maps documentation through Cloudflare AI Search and Vectorize. Returns grounded chunks and source URLs without private Firebase data.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 2000 },
        limit: { type: "integer", minimum: 1, maximum: 8, default: 5 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
  {
    name: "get_its_public_device_status",
    description: "Read a sanitized public ITS device status from Firebase RTDB. Precise location, snapshots, tokens, WebRTC data, and private fields are excluded.",
    inputSchema: {
      type: "object",
      properties: { deviceId: { type: "string", minLength: 1, maxLength: 80 } },
      required: ["deviceId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  },
  {
    name: "get_its_cloudflare_capabilities",
    description: "Return non-secret capability status for Workers AI, AI Gateway, Vectorize, AI Search, MCP, and push delivery.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
  {
    name: "read_its_public_context",
    description: "Read the concise or full public llms.txt context published by ITS Maps.",
    inputSchema: {
      type: "object",
      properties: { format: { type: "string", enum: ["summary", "full"], default: "summary" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  },
];

function rpcResult(id: unknown, result: unknown): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function argumentsRecord(params: unknown): { name: string; arguments: Record<string, unknown> } {
  if (!params || typeof params !== "object") return { name: "", arguments: {} };
  const record = params as Record<string, unknown>;
  return {
    name: cleanText(record.name, 120),
    arguments: record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments)
      ? record.arguments as Record<string, unknown>
      : {},
  };
}

async function publicContext(format: string): Promise<{ uri: string; text: string }> {
  const uri = format === "full"
    ? "https://itstelkom.web.app/llms-full.txt"
    : "https://itstelkom.web.app/llms.txt";
  const response = await fetch(uri, { headers: { Accept: "text/plain" } });
  if (!response.ok) throw new HttpError(502, "context_fetch_failed", `Konteks ITS Maps gagal dimuat (HTTP ${response.status}).`);
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
    source: "Firebase RTDB public sanitized view; legacy public writes mean values must be treated as unverified",
  };
}

async function callTool(name: string, args: Record<string, unknown>, env: Env): Promise<Record<string, unknown>> {
  if (name === "search_its_knowledge") {
    const query = cleanText(args.query, 2_000);
    if (!query) throw new HttpError(400, "query_required", "query wajib diisi.");
    const limit = Math.max(1, Math.min(8, Number(args.limit) || 5));
    const results = (await retrieveKnowledge(env, query)).slice(0, limit);
    return {
      content: [{ type: "text", text: results.length ? results.map((item, index) => `[${index + 1}] ${item.title}\n${item.text}\n${item.url}`).join("\n\n") : "Belum ada hasil knowledge terindeks." }],
      structuredContent: { query, results },
    };
  }
  if (name === "get_its_public_device_status") {
    const deviceId = cleanText(args.deviceId, 80);
    if (!deviceId || !/^[A-Za-z0-9_.-]+$/.test(deviceId)) throw new HttpError(400, "invalid_device_id", "deviceId tidak valid.");
    const url = `https://itstelkom-default-rtdb.asia-southeast1.firebasedatabase.app/devices/${encodeURIComponent(deviceId)}.json`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new HttpError(502, "firebase_read_failed", `Firebase RTDB gagal dibaca (HTTP ${response.status}).`);
    const status = sanitizedDevice(await response.json(), deviceId);
    return {
      content: [{ type: "text", text: status ? JSON.stringify(status, null, 2) : `Perangkat ${deviceId} tidak ditemukan.` }],
      structuredContent: { status },
    };
  }
  if (name === "get_its_cloudflare_capabilities") {
    const capabilities = await aiHealth(env);
    return {
      content: [{ type: "text", text: JSON.stringify(capabilities, null, 2) }],
      structuredContent: capabilities,
    };
  }
  if (name === "read_its_public_context") {
    const context = await publicContext(cleanText(args.format, 20));
    return {
      content: [{ type: "text", text: context.text }],
      structuredContent: { uri: context.uri, characters: context.text.length },
    };
  }
  throw new HttpError(404, "tool_not_found", `Tool MCP ${name || "(kosong)"} tidak ditemukan.`);
}

async function readResource(uri: string): Promise<Record<string, unknown>> {
  if (uri === "itsmaps://public/summary") {
    const context = await publicContext("summary");
    return { contents: [{ uri, mimeType: "text/plain", text: context.text }] };
  }
  if (uri === "itsmaps://public/full") {
    const context = await publicContext("full");
    return { contents: [{ uri, mimeType: "text/plain", text: context.text }] };
  }
  throw new HttpError(404, "resource_not_found", `Resource MCP ${uri} tidak ditemukan.`);
}

export function mcpServerCard(): Response {
  return json({
    name: "its-maps-cloudflare-mcp",
    version: "1.0.0",
    transport: "streamable-http-stateless",
    endpoint: "https://its.hanifahseptiani45.workers.dev/mcp",
    protocolVersion: MCP_PROTOCOL_VERSION,
    tools: TOOLS.map(({ name, description }) => ({ name, description })),
  });
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  await enforceRateLimit(request, env, "mcp");
  if (request.method === "GET") return mcpServerCard();
  const body = await readJson<JsonRpcRequest & Record<string, unknown>>(request, 48_000);
  const id = body.id;
  const method = cleanText(body.method, 120);
  if (body.jsonrpc !== "2.0" || !method) return rpcError(id, -32600, "Invalid Request");
  try {
    if (method === "initialize") {
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
        serverInfo: { name: "its-maps-cloudflare-mcp", title: "ITS Maps Cloudflare MCP", version: "1.0.0" },
        instructions: "Use these read-only tools for public ITS Maps documentation and sanitized device status. Never infer private locations or credentials.",
      });
    }
    if (method === "notifications/initialized" || method.startsWith("notifications/")) return new Response(null, { status: 202 });
    if (method === "ping") return rpcResult(id, {});
    if (method === "tools/list") return rpcResult(id, { tools: TOOLS });
    if (method === "tools/call") {
      const call = argumentsRecord(body.params);
      return rpcResult(id, await callTool(call.name, call.arguments, env));
    }
    if (method === "resources/list") {
      return rpcResult(id, {
        resources: [
          { uri: "itsmaps://public/summary", name: "ITS Maps public summary", mimeType: "text/plain" },
          { uri: "itsmaps://public/full", name: "ITS Maps full public context", mimeType: "text/plain" },
        ],
      });
    }
    if (method === "resources/read") {
      const params = body.params && typeof body.params === "object" ? body.params as Record<string, unknown> : {};
      return rpcResult(id, await readResource(cleanText(params.uri, 500)));
    }
    return rpcError(id, -32601, "Method not found");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return rpcError(id, -32000, message);
  }
}
