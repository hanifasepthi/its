import type {
  ModelGenerationOptions,
  ModelMessage,
  ModelSelection,
} from "./ModelTaskTypes";

type WorkerResponse = {
  id: string;
  type: "progress" | "token" | "result" | "error" | "disposed";
  message?: string;
  progress?: number;
  text?: string;
  output?: unknown;
  loadMilliseconds?: number;
  generationMilliseconds?: number;
};

type Pending = {
  resolve: (value: LocalModelResult) => void;
  reject: (error: Error) => void;
  onProgress?: (message: string, progress?: number) => void;
  onToken?: (token: string) => void;
  timer: number;
  abortCleanup: () => void;
};

export type LocalModelResult = {
  text: string;
  output: unknown;
  loadMilliseconds: number;
  generationMilliseconds: number;
};

export type LocalInferenceOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (message: string, progress?: number) => void;
  pipelineOptions?: Record<string, unknown>;
};

let requestSequence = 0;

export class LocalModelClient {
  private worker: Worker | null = null;
  private pending = new Map<string, Pending>();

  async generate(
    selection: ModelSelection,
    messages: ModelMessage[],
    options: ModelGenerationOptions = {},
  ): Promise<LocalModelResult> {
    const id = `local-model-${Date.now()}-${requestSequence += 1}`;
    const worker = this.ensureWorker();
    const timeoutMs = Math.max(15_000, options.timeoutMs ?? 180_000);
    return new Promise<LocalModelResult>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        this.resetWorker();
        reject(new DOMException("Permintaan model dibatalkan.", "AbortError"));
      };
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        options.signal?.removeEventListener("abort", abort);
        this.resetWorker();
        reject(new Error("Model lokal melewati batas waktu dan worker dihentikan agar peta tetap responsif."));
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        onProgress: options.onProgress,
        onToken: options.onToken,
        timer,
        abortCleanup: () => options.signal?.removeEventListener("abort", abort),
      });
      worker.postMessage({
        id,
        type: "generate",
        modelId: selection.candidate.id,
        pipeline: selection.candidate.pipeline,
        dtype: selection.dtype,
        device: selection.device,
        messages,
        options: {
          max_new_tokens: options.maxNewTokens ?? 900,
          temperature: options.temperature ?? 0.1,
          do_sample: options.doSample ?? false,
          repetition_penalty: options.repetitionPenalty ?? 1.06,
        },
      });
    });
  }

  async infer(
    selection: ModelSelection,
    input: unknown,
    options: LocalInferenceOptions = {},
  ): Promise<LocalModelResult> {
    const id = `local-inference-${Date.now()}-${requestSequence += 1}`;
    const worker = this.ensureWorker();
    const timeoutMs = Math.max(15_000, options.timeoutMs ?? 180_000);
    return new Promise<LocalModelResult>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        this.resetWorker();
        reject(new DOMException("Permintaan model dibatalkan.", "AbortError"));
      };
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        options.signal?.removeEventListener("abort", abort);
        this.resetWorker();
        reject(new Error("Model embedding melewati batas waktu dan worker dihentikan."));
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        onProgress: options.onProgress,
        timer,
        abortCleanup: () => options.signal?.removeEventListener("abort", abort),
      });
      worker.postMessage({
        id,
        type: "generate",
        modelId: selection.candidate.id,
        pipeline: selection.candidate.pipeline,
        dtype: selection.dtype,
        device: selection.device,
        input,
        options: options.pipelineOptions || {},
      });
    });
  }

  dispose(): void {
    this.rejectAll(new Error("Worker model dihentikan."));
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./LocalModelWorker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      if (response.type === "progress") {
        pending.onProgress?.(response.message || "Model lokal sedang bekerja", response.progress);
        return;
      }
      if (response.type === "token") {
        if (response.text) pending.onToken?.(response.text);
        return;
      }
      this.finish(response.id);
      if (response.type === "result") {
        pending.resolve({
          text: response.text || "",
          output: response.output,
          loadMilliseconds: response.loadMilliseconds || 0,
          generationMilliseconds: response.generationMilliseconds || 0,
        });
      } else if (response.type === "error") {
        pending.reject(new Error(response.message || "Model lokal gagal."));
      } else {
        pending.resolve({ text: "", output: null, loadMilliseconds: 0, generationMilliseconds: 0 });
      }
    });
    worker.addEventListener("error", (event) => {
      this.rejectAll(new Error(event.message || "Worker model berhenti."));
      this.resetWorker();
    });
    worker.addEventListener("messageerror", () => {
      this.rejectAll(new Error("Worker model mengirim data yang tidak valid."));
      this.resetWorker();
    });
    this.worker = worker;
    return worker;
  }

  private finish(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pending.abortCleanup();
    this.pending.delete(id);
  }

  private rejectAll(error: Error): void {
    this.pending.forEach((pending) => {
      window.clearTimeout(pending.timer);
      pending.abortCleanup();
      pending.reject(error);
    });
    this.pending.clear();
  }

  private resetWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

export const localModelClient = new LocalModelClient();
