import {
  cleanText,
  constantTimeTextEqual,
  enforceRateLimit,
  HttpError,
  json,
  readJson,
  requireAdmin,
  requireBrowserOrigin,
  sha256Hex,
} from "./http";
import type { Env, PushDeliveryJob, PushPayload, PushSubscriptionRecord } from "./types";

const SUBSCRIPTION_PREFIX = "push:subscription:";
const EVENT_PREFIX = "push:event:";
const UPDATE_STATE_KEY = "push:public-update:last";
const SUBSCRIPTION_RETENTION_SECONDS = 60 * 60 * 24 * 180;

type FirebaseServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type AccessTokenCache = {
  value: string;
  expiresAt: number;
};

let accessTokenCache: AccessTokenCache | null = null;
let accessTokenPromise: Promise<string> | null = null;

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const values = value.map((item) => cleanText(item, 40).toLocaleLowerCase())
    .filter((item) => /^[a-z0-9][a-z0-9_-]{0,39}$/.test(item));
  return [...new Set(values)].slice(0, 5).length ? [...new Set(values)].slice(0, 5) : fallback;
}

function validFcmToken(value: unknown): string {
  const token = cleanText(value, 4_096);
  if (token.length < 40 || !/^[A-Za-z0-9_:\-.]+$/.test(token)) {
    throw new HttpError(400, "invalid_fcm_token", "Token FCM tidak valid.");
  }
  return token;
}

async function subscriptionKey(token: string): Promise<string> {
  return `${SUBSCRIPTION_PREFIX}${await sha256Hex(token)}`;
}

function safeTargetUrl(value: unknown): string {
  const raw = cleanText(value, 2_000) || "/new";
  try {
    const url = new URL(raw, "https://itstelkom.web.app");
    const allowedHosts = new Set(["itstelkom.web.app", "itstelkom.firebaseapp.com", "its.hanifahseptiani45.workers.dev"]);
    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) return "https://itstelkom.web.app/new";
    return url.href;
  } catch {
    return "https://itstelkom.web.app/new";
  }
}

function payloadFrom(value: Record<string, unknown>): PushPayload {
  const eventId = cleanText(value.eventId, 120) || crypto.randomUUID();
  return {
    eventId,
    title: cleanText(value.title, 100) || "ITS Maps",
    body: cleanText(value.body || value.message, 420) || "Ada pembaruan publik ITS Maps.",
    url: safeTargetUrl(value.url || value.link),
    tag: cleanText(value.tag, 100) || `its-public-${eventId.slice(0, 24)}`,
    image: cleanText(value.image, 2_000) || undefined,
    topic: cleanText(value.topic, 40).toLocaleLowerCase() || "public",
    ttlSeconds: Math.max(60, Math.min(604_800, Number(value.ttlSeconds) || 86_400)),
  };
}

export async function handlePushConfig(env: Env): Promise<Response> {
  return json({
    ok: true,
    provider: "firebase-cloud-messaging",
    enabled: Boolean(env.FIREBASE_PROJECT_ID),
    senderReady: Boolean(env.FIREBASE_SERVICE_ACCOUNT_JSON),
    vapidPublicKey: String(env.FIREBASE_VAPID_PUBLIC_KEY || ""),
    worker: "https://its.hanifahseptiani45.workers.dev",
    topics: ["public", "release", "traffic"],
  });
}

export async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  requireBrowserOrigin(request, env);
  await enforceRateLimit(request, env, "push-subscribe");
  const body = await readJson<Record<string, unknown>>(request, 12_000);
  const token = validFcmToken(body.token);
  const key = await subscriptionKey(token);
  const existing = await env.EDGE_STATE.get<PushSubscriptionRecord>(key, "json");
  const now = new Date().toISOString();
  const origin = request.headers.get("Origin") || cleanText(body.origin, 300);
  const record: PushSubscriptionRecord = {
    token,
    topics: stringArray(body.topics, ["public", "release"]),
    origin,
    language: cleanText(body.language, 24),
    timezone: cleanText(body.timezone, 80),
    userAgent: cleanText(body.userAgent || request.headers.get("User-Agent"), 300),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await env.EDGE_STATE.put(key, JSON.stringify(record), { expirationTtl: SUBSCRIPTION_RETENTION_SECONDS });
  return json({
    ok: true,
    subscriptionId: key.slice(SUBSCRIPTION_PREFIX.length, SUBSCRIPTION_PREFIX.length + 20),
    topics: record.topics,
    senderReady: Boolean(env.FIREBASE_SERVICE_ACCOUNT_JSON),
    created: !existing,
  }, existing ? 200 : 201);
}

export async function handleUnsubscribe(request: Request, env: Env): Promise<Response> {
  requireBrowserOrigin(request, env);
  const body = await readJson<Record<string, unknown>>(request, 8_192);
  const token = validFcmToken(body.token);
  await env.EDGE_STATE.delete(await subscriptionKey(token));
  return json({ ok: true });
}

async function allSubscriptions(env: Env): Promise<Array<{ key: string; record: PushSubscriptionRecord }>> {
  const subscriptions: Array<{ key: string; record: PushSubscriptionRecord }> = [];
  let cursor: string | undefined;
  do {
    const page = await env.EDGE_STATE.list({ prefix: SUBSCRIPTION_PREFIX, limit: 1_000, cursor });
    const records = await Promise.all(page.keys.map(async ({ name }) => ({
      key: name,
      record: await env.EDGE_STATE.get<PushSubscriptionRecord>(name, "json"),
    })));
    records.forEach(({ key, record }) => { if (record?.token) subscriptions.push({ key, record }); });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return subscriptions;
}

async function queuePayload(env: Env, payload: PushPayload): Promise<{ accepted: number; duplicate: boolean }> {
  const eventKey = `${EVENT_PREFIX}${payload.eventId}`;
  if (await env.EDGE_STATE.get(eventKey)) return { accepted: 0, duplicate: true };
  const subscriptions = (await allSubscriptions(env)).filter(({ record }) => record.topics.includes(payload.topic) || record.topics.includes("public"));
  for (let offset = 0; offset < subscriptions.length; offset += 100) {
    const jobs = subscriptions.slice(offset, offset + 100).map(({ key, record }) => ({
      body: { subscriptionKey: key, token: record.token, payload, attempt: 0 } satisfies PushDeliveryJob,
    }));
    if (jobs.length) await env.PUSH_QUEUE.sendBatch(jobs);
  }
  await env.EDGE_STATE.put(eventKey, JSON.stringify({ queuedAt: new Date().toISOString(), accepted: subscriptions.length }), {
    expirationTtl: Math.max(86_400, payload.ttlSeconds),
  });
  return { accepted: subscriptions.length, duplicate: false };
}

export async function handleBroadcast(request: Request, env: Env): Promise<Response> {
  requireAdmin(request, env);
  const body = await readJson<Record<string, unknown>>(request, 16_384);
  const payload = payloadFrom(body);
  const result = await queuePayload(env, payload);
  return json({ ok: true, queued: result.accepted, duplicate: result.duplicate, eventId: payload.eventId }, result.duplicate ? 200 : 202);
}

function base64Url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemBytes(pem: string): Uint8Array {
  const normalized = pem.replace(/\\n/g, "\n");
  const base64 = normalized.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  if (!base64) throw new HttpError(503, "firebase_credentials_invalid", "Private key Firebase tidak valid.");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function serviceAccount(env: Env): FirebaseServiceAccount {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new HttpError(503, "firebase_credentials_missing", "Secret Firebase service account belum disetel di Worker.");
  }
  try {
    const value = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON) as Partial<FirebaseServiceAccount>;
    if (!value.project_id || !value.client_email || !value.private_key) throw new Error("required field missing");
    return value as FirebaseServiceAccount;
  } catch {
    throw new HttpError(503, "firebase_credentials_invalid", "Secret Firebase service account tidak valid.");
  }
}

async function mintFirebaseAccessToken(env: Env): Promise<string> {
  const account = serviceAccount(env);
  const now = Math.floor(Date.now() / 1_000);
  const tokenUri = account.token_uri || "https://oauth2.googleapis.com/token";
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: account.client_email,
    sub: account.client_email,
    aud: tokenUri,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    iat: now,
    exp: now + 3_600,
  }));
  const unsigned = `${header}.${claims}`;
  const privateKeyBytes = pemBytes(account.private_key);
  const privateKeyBuffer = privateKeyBytes.buffer.slice(
    privateKeyBytes.byteOffset,
    privateKeyBytes.byteOffset + privateKeyBytes.byteLength,
  ) as ArrayBuffer;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${base64Url(new Uint8Array(signature))}`;
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const payload = await response.json() as Record<string, unknown>;
  const value = cleanText(payload.access_token, 4_096);
  if (!response.ok || !value) throw new HttpError(502, "firebase_oauth_failed", `OAuth Firebase gagal (HTTP ${response.status}).`);
  accessTokenCache = { value, expiresAt: Date.now() + Math.max(300, Number(payload.expires_in) || 3_600) * 1_000 };
  return value;
}

async function firebaseAccessToken(env: Env): Promise<string> {
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now() + 60_000) return accessTokenCache.value;
  if (!accessTokenPromise) accessTokenPromise = mintFirebaseAccessToken(env);
  const pending = accessTokenPromise;
  try {
    return await pending;
  } finally {
    if (accessTokenPromise === pending) accessTokenPromise = null;
  }
}

function fcmErrorCode(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const error = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
  const details = Array.isArray(error.details) ? error.details as Array<Record<string, unknown>> : [];
  return cleanText(details.map((item) => item.errorCode).find(Boolean) || error.status, 100);
}

function retryAfterSeconds(response: Response): number {
  const raw = response.headers.get("Retry-After") || "";
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(3_600, Math.ceil(seconds));
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(15, Math.min(3_600, Math.ceil((date - Date.now()) / 1_000))) : 0;
}

async function deliverJob(env: Env, job: PushDeliveryJob): Promise<{ delivered: boolean; removeToken: boolean; status: number; retryAfterSeconds: number }> {
  const accessToken = await firebaseAccessToken(env);
  const account = serviceAccount(env);
  const projectId = env.FIREBASE_PROJECT_ID || account.project_id;
  const payload = job.payload;
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        token: job.token,
        data: {
          eventId: payload.eventId,
          title: payload.title,
          body: payload.body,
          url: payload.url,
          tag: payload.tag,
          image: payload.image || "",
          topic: payload.topic,
        },
        webpush: {
          headers: {
            TTL: String(payload.ttlSeconds),
            Urgency: payload.topic === "traffic" ? "high" : "normal",
          },
          fcm_options: { link: payload.url },
        },
      },
    }),
  });
  if (response.ok) return { delivered: true, removeToken: false, status: response.status, retryAfterSeconds: 0 };
  const error = await response.json().catch(() => ({}));
  const code = fcmErrorCode(error);
  if (response.status === 401) accessTokenCache = null;
  const removeToken = response.status === 404 || code === "UNREGISTERED";
  console.warn("FCM delivery failed", { status: response.status, code, subscriptionKey: job.subscriptionKey });
  return { delivered: false, removeToken, status: response.status, retryAfterSeconds: retryAfterSeconds(response) };
}

export async function consumePushQueue(batch: MessageBatch<PushDeliveryJob>, env: Env): Promise<void> {
  await Promise.all(batch.messages.map(async (message) => {
    try {
      const result = await deliverJob(env, message.body);
      if (result.removeToken) {
        await env.EDGE_STATE.delete(message.body.subscriptionKey);
        message.ack();
      } else if (result.delivered) {
        message.ack();
      } else {
        message.retry({ delaySeconds: result.retryAfterSeconds || Math.min(900, 15 * (message.attempts + 1)) });
      }
    } catch (error) {
      console.error("Push queue consumer failed", error);
      message.retry({ delaySeconds: Math.min(300, 15 * (message.attempts + 1)) });
    }
  }));
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function handleControllerEvent(request: Request, env: Env): Promise<Response> {
  const secret = String(env.CONTROLLER_WEBHOOK_SECRET || "");
  if (!secret) throw new HttpError(503, "controller_secret_missing", "Secret controller belum disetel.");
  const raw = await request.text();
  if (raw.length > 16_384) throw new HttpError(413, "payload_too_large", "Payload controller terlalu besar.");
  const expected = await hmacHex(secret, raw);
  const supplied = (request.headers.get("X-ITS-Signature") || "").replace(/^sha256=/i, "").toLocaleLowerCase();
  if (!constantTimeTextEqual(supplied, expected)) throw new HttpError(401, "invalid_signature", "Tanda tangan controller tidak valid.");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json", "JSON controller tidak valid.");
  }
  const eventType = cleanText(body.type, 60);
  const allowed = new Set(["device-offline", "device-online", "traffic-alert", "camera-alert"]);
  if (!allowed.has(eventType)) throw new HttpError(400, "unsupported_event", "Jenis event controller tidak didukung.");
  const eventId = cleanText(body.eventId, 120) || `${eventType}:${cleanText(body.deviceId, 80)}:${cleanText(body.timestamp, 80)}`;
  const payload = payloadFrom({
    eventId,
    title: body.title || (eventType === "device-offline" ? "Perangkat ITS offline" : "Pembaruan ITS Maps"),
    body: body.message || body.body,
    url: body.url || "/",
    topic: eventType === "traffic-alert" ? "traffic" : "public",
    tag: `its-${eventType}-${cleanText(body.deviceId, 40)}`,
    ttlSeconds: 3_600,
  });
  const result = await queuePayload(env, payload);
  return json({ ok: true, queued: result.accepted, duplicate: result.duplicate, eventId: payload.eventId }, 202);
}

export async function pollPublicUpdate(env: Env): Promise<void> {
  const url = env.PUBLIC_UPDATE_URL || "https://itstelkom.web.app/app-update.json";
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Public update HTTP ${response.status}`);
  const update = await response.json() as Record<string, unknown>;
  const version = cleanText(update.versionName || update.version, 80);
  if (!version) return;
  const fingerprint = await sha256Hex(JSON.stringify({ version, updatedAt: update.updatedAt, releaseNotes: update.releaseNotes }));
  const previous = await env.EDGE_STATE.get(UPDATE_STATE_KEY);
  if (!previous) {
    await env.EDGE_STATE.put(UPDATE_STATE_KEY, fingerprint);
    return;
  }
  if (previous === fingerprint) return;
  const notes = Array.isArray(update.releaseNotes) ? update.releaseNotes : [];
  await queuePayload(env, payloadFrom({
    eventId: `release:${fingerprint.slice(0, 32)}`,
    title: `ITS Maps ${version}`,
    body: notes[0] || "Pembaruan ITS Maps tersedia.",
    url: "/new",
    topic: "release",
    tag: "its-public-app-update",
    ttlSeconds: 604_800,
  }));
  await env.EDGE_STATE.put(UPDATE_STATE_KEY, fingerprint);
}

export async function pushHealth(env: Env): Promise<Record<string, unknown>> {
  let subscriptions: number | null = null;
  try {
    const page = await env.EDGE_STATE.list({ prefix: SUBSCRIPTION_PREFIX, limit: 1_000 });
    subscriptions = page.keys.length;
  } catch {
    // Binding health is best-effort.
  }
  return {
    provider: "firebase-cloud-messaging-http-v1",
    subscriptionStore: Boolean(env.EDGE_STATE),
    deliveryQueue: Boolean(env.PUSH_QUEUE),
    senderReady: Boolean(env.FIREBASE_SERVICE_ACCOUNT_JSON),
    vapidConfigured: Boolean(env.FIREBASE_VAPID_PUBLIC_KEY),
    tokenRetentionDays: SUBSCRIPTION_RETENTION_SECONDS / 86_400,
    subscriptionsOnFirstPage: subscriptions,
  };
}
