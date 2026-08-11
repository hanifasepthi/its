import { ITS_CLOUDFLARE_WORKER_URL } from "./ai-runtime/CloudflareAiClient";

const OPT_IN_KEY = "its-public-push-opt-in:v1";
const TOKEN_KEY = "its-public-push-token:v1";
const PUSH_OUTBOX_DB = "its-push-outbox-v1";
const PUSH_OUTBOX_STORE = "outbox";
const TRAVEL_CONTEXT_OUTBOX_KEY = "travel-context-latest";
const TRAVEL_CONTEXT_SYNC_TAG = "its-destination-sync";

export type PublicPushState = {
  supported: boolean;
  subscribed: boolean;
  permission: NotificationPermission | "unsupported";
  senderReady: boolean;
  vapidConfigured: boolean;
  message: string;
};

type PushConfig = {
  ok: boolean;
  provider: string;
  enabled: boolean;
  senderReady: boolean;
  vapidPublicKey: string;
};

export type TravelContextUpdate = {
  observedAt?: number;
  lat: number;
  lng: number;
  speedKmh: number;
  mode: "walk" | "bicycle" | "motorcycle" | "car" | "truck" | "transit" | "unknown";
  modeSource: "gps-heuristic" | "navigation-explicit" | "manual-explicit" | "unknown";
  modeConfidence: number;
  dwellMinutes: number;
  destinationKnown: boolean;
  visibility: "visible" | "hidden";
  candidate: {
    id: string;
    name: string;
    lat: number;
    lng: number;
    vehicleCount: number;
    snapshotCapturedAt?: number;
    snapshotImageUrl?: string;
    enforcementType?: string;
    enforcementVerified?: boolean;
  };
};

type TravelContextEnvelope = {
  endpoint: string;
  context: TravelContextUpdate & { observedAt: number };
  expiresAt: number;
};

let serviceWorkerMessagesBound = false;
let travelContextOnlineBound = false;

function openPushOutbox(): Promise<IDBDatabase> {
  if (!("indexedDB" in window)) return Promise.reject(new Error("IndexedDB tidak didukung browser ini."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PUSH_OUTBOX_DB, 1);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PUSH_OUTBOX_STORE)) database.createObjectStore(PUSH_OUTBOX_STORE);
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error || new Error("Outbox push gagal dibuka.")));
  });
}

async function writeTravelContextOutbox(value: TravelContextEnvelope | null): Promise<void> {
  const database = await openPushOutbox();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(PUSH_OUTBOX_STORE, "readwrite");
      const store = transaction.objectStore(PUSH_OUTBOX_STORE);
      if (value) store.put(value, TRAVEL_CONTEXT_OUTBOX_KEY);
      else store.delete(TRAVEL_CONTEXT_OUTBOX_KEY);
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("abort", () => reject(transaction.error || new Error("Outbox push dibatalkan.")));
      transaction.addEventListener("error", () => reject(transaction.error || new Error("Outbox push gagal ditulis.")));
    });
  } finally {
    database.close();
  }
}

export function publicPushOptedIn(): boolean {
  return localStorage.getItem(OPT_IN_KEY) === "true";
}

async function pushConfig(): Promise<PushConfig> {
  const response = await fetch(`${ITS_CLOUDFLARE_WORKER_URL}/v1/push/config`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const value = await response.json().catch(() => ({})) as Partial<PushConfig> & { message?: string };
  if (!response.ok || value.ok !== true) throw new Error(value.message || `Konfigurasi push HTTP ${response.status}.`);
  return {
    ok: true,
    provider: String(value.provider || ""),
    enabled: value.enabled === true,
    senderReady: value.senderReady === true,
    vapidPublicKey: String(value.vapidPublicKey || ""),
  };
}

function bindServiceWorkerMessages(): void {
  if (serviceWorkerMessagesBound || !("serviceWorker" in navigator)) return;
  serviceWorkerMessagesBound = true;
  navigator.serviceWorker.addEventListener("message", (event) => {
    const value = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
    if (value.type === "its-public-push") {
      window.dispatchEvent(new CustomEvent("its:public-push", { detail: value.notification }));
      return;
    }
    if (value.type === "its-push-subscription-changed" && publicPushOptedIn()) {
      void navigator.serviceWorker.ready.then((registration) => restorePublicPush(registration));
      return;
    }
    if (value.type === "its-periodic-congestion-check") {
      window.dispatchEvent(new CustomEvent("its:periodic-congestion-check"));
      return;
    }
    if (value.type === "its-destination-sync") {
      window.dispatchEvent(new CustomEvent("its:destination-sync"));
    }
  });
  if (!travelContextOnlineBound) {
    travelContextOnlineBound = true;
    window.addEventListener("online", () => {
      void navigator.serviceWorker.ready.then((registration) => {
        registration.active?.postMessage({ type: "ITS_FLUSH_TRAVEL_CONTEXT" });
      }).catch(() => undefined);
    });
  }
}

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function registerSubscription(subscription: PushSubscription): Promise<{ senderReady: boolean }> {
  const response = await fetch(`${ITS_CLOUDFLARE_WORKER_URL}/v1/push/subscriptions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      // Travel alerts are delivered directly to this subscription.  Avoid a
      // national traffic broadcast: the generic public topic is not a wildcard.
      topics: ["public", "release"],
      origin: window.location.origin,
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      userAgent: navigator.userAgent,
    }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || payload.ok !== true) throw new Error(typeof payload.message === "string" ? payload.message : `Registrasi push HTTP ${response.status}.`);
  return { senderReady: payload.senderReady === true };
}

async function subscribeWithRegistration(registration: ServiceWorkerRegistration, requestPermission: boolean): Promise<PublicPushState> {
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    return { supported: false, subscribed: false, permission: "unsupported", senderReady: false, vapidConfigured: false, message: "Browser ini belum mendukung Web Push." };
  }
  if (!("PushManager" in window)) {
    return { supported: false, subscribed: false, permission: Notification.permission, senderReady: false, vapidConfigured: false, message: "PushManager tidak didukung browser ini." };
  }
  if (!registration.pushManager) {
    return { supported: false, subscribed: false, permission: Notification.permission, senderReady: false, vapidConfigured: false, message: "Service worker browser ini tidak menyediakan PushManager." };
  }
  const permission = Notification.permission === "default" && requestPermission
    ? await Notification.requestPermission()
    : Notification.permission;
  if (permission !== "granted") {
    return { supported: true, subscribed: false, permission, senderReady: false, vapidConfigured: false, message: permission === "denied" ? "Izin notifikasi diblokir di pengaturan browser." : "Izin notifikasi belum diberikan." };
  }
  const config = await pushConfig();
  if (!config.vapidPublicKey) throw new Error("Public key Web Push belum tersedia.");
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && subscription.options.applicationServerKey) {
    const currentKey = btoa(String.fromCharCode(...new Uint8Array(subscription.options.applicationServerKey)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    if (currentKey !== config.vapidPublicKey) {
      await subscription.unsubscribe();
      subscription = null;
    }
  }
  subscription ||= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(config.vapidPublicKey),
  });
  const registrationResult = await registerSubscription(subscription);
  localStorage.setItem(OPT_IN_KEY, "true");
  localStorage.setItem(TOKEN_KEY, subscription.endpoint);
  bindServiceWorkerMessages();
  return {
    supported: true,
    subscribed: true,
    permission,
    senderReady: registrationResult.senderReady,
    vapidConfigured: Boolean(config.vapidPublicKey),
    message: registrationResult.senderReady
      ? "Web Push publik aktif dan dapat diterima saat halaman ditutup."
      : "Perangkat sudah terdaftar; secret pengirim Web Push masih perlu disetel di Cloudflare.",
  };
}

export async function enablePublicPush(registration?: ServiceWorkerRegistration): Promise<PublicPushState> {
  const state = !("serviceWorker" in navigator)
    ? {
      supported: false,
      subscribed: false,
      permission: "Notification" in window ? Notification.permission : "unsupported" as const,
      senderReady: false,
      vapidConfigured: false,
      message: "Service worker tidak didukung browser ini; peringatan aktif-tab tetap dapat digunakan.",
    }
    : await subscribeWithRegistration(registration || await navigator.serviceWorker.ready, true);
  window.dispatchEvent(new CustomEvent("its:push-state", { detail: state }));
  return state;
}

export async function restorePublicPush(registration: ServiceWorkerRegistration): Promise<PublicPushState | null> {
  if (localStorage.getItem(OPT_IN_KEY) !== "true" || !("Notification" in window) || Notification.permission !== "granted") return null;
  try {
    const state = await subscribeWithRegistration(registration, false);
    window.dispatchEvent(new CustomEvent("its:push-state", { detail: state }));
    return state;
  } catch (error) {
    console.warn("[PWA] Public push refresh failed", error);
    return null;
  }
}

export async function queueTravelContextUpdate(
  context: TravelContextUpdate,
  registration?: ServiceWorkerRegistration,
): Promise<{ delivered: boolean; queued: boolean; message: string }> {
  if (!publicPushOptedIn() || !("serviceWorker" in navigator)) {
    return { delivered: false, queued: false, message: "Web Push perjalanan belum diaktifkan." };
  }
  if (!("PushManager" in window)) {
    return { delivered: false, queued: false, message: "PushManager tidak tersedia; peringatan aktif-tab tetap berjalan." };
  }
  const activeRegistration = registration || await navigator.serviceWorker.ready;
  if (!activeRegistration.pushManager) {
    return { delivered: false, queued: false, message: "PushManager service worker tidak tersedia." };
  }
  const subscription = await activeRegistration.pushManager.getSubscription();
  if (!subscription) {
    return { delivered: false, queued: false, message: "Langganan Web Push belum tersedia." };
  }
  const envelope: TravelContextEnvelope = {
    endpoint: subscription.endpoint,
    context: { ...context, observedAt: Number(context.observedAt) || Date.now() },
    expiresAt: Date.now() + 2 * 60_000,
  };
  try {
    const response = await fetch(`${ITS_CLOUDFLARE_WORKER_URL}/v1/push/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(envelope),
      cache: "no-store",
      keepalive: true,
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || payload.ok !== true) {
      throw new Error(typeof payload.message === "string" ? payload.message : `Sinkronisasi konteks HTTP ${response.status}.`);
    }
    await writeTravelContextOutbox(null).catch(() => undefined);
    return {
      delivered: true,
      queued: Number(payload.queued || 0) > 0,
      message: Number(payload.queued || 0) > 0 ? "Notifikasi konteks masuk antrean." : "Konteks perjalanan tersinkron.",
    };
  } catch (error) {
    let stored = false;
    try {
      await writeTravelContextOutbox(envelope);
      stored = true;
    } catch {
      // IndexedDB and Background Sync are progressive enhancements.  The
      // foreground evaluator will try again on the next fresh GPS sample.
    }
    const syncManager = (activeRegistration as ServiceWorkerRegistration & {
      sync?: { register(tag: string): Promise<void> };
    }).sync;
    if (stored && syncManager) await syncManager.register(TRAVEL_CONTEXT_SYNC_TAG).catch(() => undefined);
    return {
      delivered: false,
      queued: stored,
      message: stored
        ? "Konteks disimpan untuk dikirim saat koneksi kembali."
        : error instanceof Error ? error.message : "Konteks perjalanan belum dapat dikirim.",
    };
  }
}

export async function disableTravelContextSync(registration?: ServiceWorkerRegistration): Promise<void> {
  const activeRegistration = registration || ("serviceWorker" in navigator
    ? await navigator.serviceWorker.ready.catch(() => null)
    : null);
  if (activeRegistration) {
    const periodicSync = (activeRegistration as ServiceWorkerRegistration & {
      periodicSync?: { unregister(tag: string): Promise<void> };
    }).periodicSync;
    if (periodicSync) await periodicSync.unregister("its-congestion-check").catch(() => undefined);
  }
  await writeTravelContextOutbox(null).catch(() => undefined);
}

export async function disablePublicPush(): Promise<PublicPushState> {
  const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.ready : null;
  const subscription = registration?.pushManager
    ? await registration.pushManager.getSubscription()
    : null;
  const endpoint = subscription?.endpoint || localStorage.getItem(TOKEN_KEY) || "";
  if (endpoint) {
    const response = await fetch(`${ITS_CLOUDFLARE_WORKER_URL}/v1/push/subscriptions`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || payload.ok !== true) {
      throw new Error(typeof payload.message === "string" ? payload.message : `Penghapusan langganan HTTP ${response.status}.`);
    }
  }
  if (subscription) await subscription.unsubscribe().catch(() => false);
  if (registration) {
    await disableTravelContextSync(registration);
  }
  localStorage.removeItem(OPT_IN_KEY);
  localStorage.removeItem(TOKEN_KEY);
  const state: PublicPushState = {
    supported: Boolean(registration && "PushManager" in window),
    subscribed: false,
    permission: "Notification" in window ? Notification.permission : "unsupported",
    senderReady: false,
    vapidConfigured: false,
    message: "Langganan notifikasi publik dinonaktifkan.",
  };
  window.dispatchEvent(new CustomEvent("its:push-state", { detail: state }));
  return state;
}
