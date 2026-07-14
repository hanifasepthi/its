export type BrowserTextSkill = "chat" | "research";

export type BrowserTextMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type WorkerResponse = {
  id: string;
  type: "progress" | "result" | "error" | "disposed";
  message?: string;
  progress?: number;
  text?: string;
};

type PendingRequest = {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  onProgress?: (message: string, progress?: number) => void;
  timer: number;
};

let worker: Worker | null = null;
let requestSequence = 0;
const pending = new Map<string, PendingRequest>();
const warmPromises = new Map<BrowserTextSkill, Promise<void>>();
const READY_PREFIX = "its-browser-model-ready:v1:";
const COOLDOWN_PREFIX = "its-browser-model-cooldown:v1:";

function readyKey(skill: BrowserTextSkill): string {
  return `${READY_PREFIX}${skill}`;
}

function markModelReady(skill: BrowserTextSkill): void {
  try {
    localStorage.setItem(readyKey(skill), "1");
    localStorage.removeItem(`${COOLDOWN_PREFIX}${skill}`);
  } catch {
    // Cache readiness is only an optimization.
  }
}

export function isBrowserTextModelReady(skill: BrowserTextSkill): boolean {
  try {
    const cooldownUntil = Number(localStorage.getItem(`${COOLDOWN_PREFIX}${skill}`) || "0");
    return localStorage.getItem(readyKey(skill)) === "1" && cooldownUntil <= Date.now();
  } catch {
    return false;
  }
}

function rejectAll(message: string): void {
  pending.forEach((request) => {
    window.clearTimeout(request.timer);
    request.reject(new Error(message));
  });
  pending.clear();
}

function resetWorker(message?: string): void {
  worker?.terminate();
  worker = null;
  if (message) rejectAll(message);
}

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./browserTextModelWorker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const request = pending.get(response.id);
    if (!request) return;
    if (response.type === "progress") {
      request.onProgress?.(response.message || "Model lokal sedang bekerja", response.progress);
      return;
    }
    window.clearTimeout(request.timer);
    pending.delete(response.id);
    if (response.type === "result") request.resolve(response.text || "");
    else if (response.type === "error") request.reject(new Error(response.message || "Worker model gagal."));
    else request.resolve("");
  });
  worker.addEventListener("error", (event) => {
    resetWorker(event.message || "Worker model berhenti.");
  });
  worker.addEventListener("messageerror", () => {
    resetWorker("Worker model mengirim data yang tidak valid.");
  });
  return worker;
}

export function generateBrowserText(
  skill: BrowserTextSkill,
  messages: BrowserTextMessage[],
  options: Record<string, unknown>,
  onProgress?: (message: string, progress?: number) => void,
  timeoutMs = 120_000,
): Promise<string> {
  const id = `its-model-${Date.now()}-${requestSequence += 1}`;
  const activeWorker = ensureWorker();
  return new Promise<string>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      try {
        localStorage.setItem(`${COOLDOWN_PREFIX}${skill}`, String(Date.now() + 30 * 60_000));
      } catch {
        // A performance cooldown is optional when storage is unavailable.
      }
      resetWorker();
      reject(new Error("Model lokal melewati batas waktu dan dihentikan agar aplikasi tetap responsif."));
    }, timeoutMs);
    pending.set(id, { resolve, reject, onProgress, timer });
    activeWorker.postMessage({ id, type: "generate", skill, messages, options });
  }).then((text) => {
    markModelReady(skill);
    return text;
  });
}

export function warmBrowserTextModel(
  skill: BrowserTextSkill,
  onProgress?: (message: string, progress?: number) => void,
): Promise<void> {
  try {
    if (localStorage.getItem(readyKey(skill)) === "1") return Promise.resolve();
  } catch {
    // Continue with a normal warm-up when storage is unavailable.
  }
  const existing = warmPromises.get(skill);
  if (existing) return existing;

  const id = `its-model-warm-${skill}-${Date.now()}-${requestSequence += 1}`;
  const activeWorker = ensureWorker();
  const promise = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error("Persiapan model lokal belum selesai; aplikasi tetap memakai jawaban berbasis sumber."));
    }, 10 * 60_000);
    pending.set(id, {
      resolve: () => {
        markModelReady(skill);
        resolve();
      },
      reject,
      onProgress,
      timer,
    });
    activeWorker.postMessage({ id, type: "warm", skill });
  }).finally(() => warmPromises.delete(skill));
  warmPromises.set(skill, promise);
  return promise;
}

export function disposeBrowserTextWorker(): void {
  if (!worker) return;
  const id = `its-model-dispose-${Date.now()}`;
  worker.postMessage({ id, type: "dispose" });
  window.setTimeout(() => resetWorker(), 250);
}
