import type { Env } from "./types";

const DEFAULT_ORIGINS = [
  "https://itstelkom.web.app",
  "https://itstelkom.firebaseapp.com",
  "https://its.hanifahseptiani45.workers.dev",
  "http://localhost:4173",
  "http://localhost:5173",
];

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function allowedOrigins(env: Env): Set<string> {
  const configured = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set(configured.length ? configured : DEFAULT_ORIGINS);
}

export function requestOriginAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  return !origin || allowedOrigins(env).has(origin);
}

export function requireBrowserOrigin(request: Request, env: Env): void {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins(env).has(origin)) {
    throw new HttpError(403, "browser_origin_required", "Endpoint ini hanya menerima origin aplikasi ITS Maps yang diizinkan.");
  }
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET,HEAD,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,X-ITS-Signature,X-ITS-Timestamp,X-ITS-Nonce,X-Requested-With",
    "Access-Control-Expose-Headers": "Accept-Ranges,Content-Length,Content-Range,ETag,Last-Modified",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  });
  const origin = request.headers.get("Origin");
  if (origin && allowedOrigins(env).has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

export function withCors(response: Response, request: Request, env: Env): Response {
  const headers = new Headers(response.headers);
  corsHeaders(request, env).forEach((value, key) => headers.set(key, value));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  return Response.json(data, {
    status,
    headers: responseHeaders,
  });
}

export async function readJson<T extends Record<string, unknown>>(request: Request, maxBytes = 32_768): Promise<T> {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Gunakan Content-Type application/json.");
  }
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maxBytes) throw new HttpError(413, "payload_too_large", "Payload terlalu besar.");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new HttpError(413, "payload_too_large", "Payload terlalu besar.");
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value as T;
  } catch {
    throw new HttpError(400, "invalid_json", "JSON tidak valid.");
  }
}

export function cleanText(value: unknown, maximum: number): string {
  return String(value || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, maximum);
}

export function bearerToken(request: Request): string {
  const match = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

export function requireAdmin(request: Request, env: Env): void {
  const expected = String(env.PUSH_ADMIN_TOKEN || "");
  if (!expected || !constantTimeTextEqual(bearerToken(request), expected)) {
    throw new HttpError(401, "unauthorized", "Token admin tidak valid.");
  }
}

export function constantTimeTextEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) mismatch |= (a[index] || 0) ^ (b[index] || 0);
  return mismatch === 0;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function enforceRateLimit(request: Request, env: Env, scope: string): Promise<void> {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = (await sha256Hex(ip)).slice(0, 20);
  if (env.EDGE_RATE_LIMITER) {
    const nativeResult = await env.EDGE_RATE_LIMITER.limit({ key: `${scope}:${ipHash}` });
    if (!nativeResult.success) throw new HttpError(429, "rate_limited", "Batas permintaan per menit terlampaui.");
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ ok: false, error: error.code, message: error.message }, error.status);
  console.error("Unhandled worker error", error);
  return json({ ok: false, error: "internal_error", message: "Layanan ITS Maps sementara gagal memproses permintaan." }, 500);
}

export function optionsResponse(request: Request, env: Env): Response {
  if (!requestOriginAllowed(request, env)) return json({ ok: false, error: "origin_not_allowed" }, 403);
  return withCors(new Response(null, { status: 204 }), request, env);
}
