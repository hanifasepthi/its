import type { ModelGenerationOptions, ModelMessage, ModelTask } from "./ModelTaskTypes";

export const ITS_CLOUDFLARE_WORKER_URL = String(
  import.meta.env.VITE_CLOUDFLARE_WORKER_URL || "https://its.hanifahseptiani45.workers.dev",
).replace(/\/+$/, "");

export type CloudflareGenerationResult = {
  text: string;
  model: string;
  gateway: string;
  gatewayFallback: boolean;
};

export type CloudflareCapabilityStatus = {
  ok: boolean;
  checkedAt: number;
  endpoint: string;
  capabilities?: Record<string, unknown>;
  error?: string;
};

const REMOTE_TASKS = new Set<ModelTask>([
  "planner",
  "intent-classification",
  "query-generation",
  "research-synthesis",
  "follow-up-reasoning",
  "summarization",
]);

const PRIVATE_CONTEXT_PATTERNS = [
  /(?:\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|private[_-]?key|webrtc|snapshot|base64|cameraurl|password|secret)\b|"(?:lat|latitude|lng|lon|longitude|deviceId)"\s*:)/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:^|\D)(?:\+?62|0)8\d{7,12}(?:\D|$)/,
  /(?:^|\s)-?\d{1,2}\.\d{4,}\s*[,;]\s*-?\d{2,3}\.\d{4,}(?:\s|$)/,
  /[?&](?:token|key|secret|signature|auth)=[^\s&]+/i,
];

function combinedSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(new DOMException("Cloudflare AI melewati batas waktu.", "TimeoutError")), timeoutMs);
  const abort = () => controller.abort(parent?.reason || new DOMException("Permintaan dibatalkan.", "AbortError"));
  parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      window.clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function safeForCloud(messages: ModelMessage[]): boolean {
  return !messages.some((message) => PRIVATE_CONTEXT_PATTERNS.some((pattern) => pattern.test(message.content)));
}

function responseMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  return typeof record.message === "string" ? record.message : fallback;
}

class CloudflareAiClient {
  private unavailableUntil = 0;
  private lastStatus: CloudflareCapabilityStatus | null = null;
  private healthPromise: Promise<CloudflareCapabilityStatus> | null = null;

  canUse(task: ModelTask, messages: ModelMessage[]): boolean {
    return REMOTE_TASKS.has(task) && safeForCloud(messages) && Date.now() >= this.unavailableUntil;
  }

  async generate(
    task: ModelTask,
    messages: ModelMessage[],
    options: ModelGenerationOptions = {},
  ): Promise<CloudflareGenerationResult> {
    if (!this.canUse(task, messages)) throw new Error("Cloudflare AI dilewati untuk konteks privat atau saat endpoint cooldown.");
    const linked = combinedSignal(options.signal, Math.min(45_000, Math.max(8_000, options.timeoutMs || 30_000)));
    try {
      const response = await fetch(`${ITS_CLOUDFLARE_WORKER_URL}/v1/ai/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          task,
          messages,
          maxNewTokens: options.maxNewTokens,
          temperature: options.temperature,
        }),
        signal: linked.signal,
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok || payload.ok !== true || typeof payload.text !== "string" || !payload.text.trim()) {
        const error = new Error(responseMessage(payload, `Cloudflare AI HTTP ${response.status}.`));
        if (response.status === 429) this.unavailableUntil = Date.now() + 60_000;
        else if (response.status >= 500 || response.status === 404) this.unavailableUntil = Date.now() + 180_000;
        throw error;
      }
      this.unavailableUntil = 0;
      return {
        text: payload.text.trim(),
        model: String(payload.model || "Workers AI"),
        gateway: String(payload.gateway || ""),
        gatewayFallback: payload.gatewayFallback === true,
      };
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason || error;
      if (this.unavailableUntil <= Date.now()) this.unavailableUntil = Date.now() + 60_000;
      throw error;
    } finally {
      linked.dispose();
    }
  }

  async status(force = false): Promise<CloudflareCapabilityStatus> {
    if (!force && this.lastStatus && Date.now() - this.lastStatus.checkedAt < 60_000) return this.lastStatus;
    if (!force && this.healthPromise) return this.healthPromise;
    const task = (async (): Promise<CloudflareCapabilityStatus> => {
      const linked = combinedSignal(undefined, 8_000);
      try {
        const response = await fetch(`${ITS_CLOUDFLARE_WORKER_URL}/v1/health`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: linked.signal,
        });
        const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
        const status: CloudflareCapabilityStatus = response.ok && payload.ok === true
          ? { ok: true, checkedAt: Date.now(), endpoint: ITS_CLOUDFLARE_WORKER_URL, capabilities: payload.capabilities as Record<string, unknown> }
          : { ok: false, checkedAt: Date.now(), endpoint: ITS_CLOUDFLARE_WORKER_URL, error: `HTTP ${response.status}` };
        this.lastStatus = status;
        return status;
      } catch (error) {
        const status = {
          ok: false,
          checkedAt: Date.now(),
          endpoint: ITS_CLOUDFLARE_WORKER_URL,
          error: error instanceof Error ? error.message : String(error),
        };
        this.lastStatus = status;
        return status;
      } finally {
        linked.dispose();
        this.healthPromise = null;
      }
    })();
    this.healthPromise = task;
    return task;
  }

  cooldownRemaining(): number {
    return Math.max(0, this.unavailableUntil - Date.now());
  }
}

export const cloudflareAiClient = new CloudflareAiClient();
