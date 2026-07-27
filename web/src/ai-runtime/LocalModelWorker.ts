import { env, pipeline, TextStreamer } from "@huggingface/transformers";
import type { ModelMessage, ModelPipeline } from "./ModelTaskTypes";

type WorkerRequest = {
  id: string;
  type: "generate" | "warm" | "dispose";
  modelId?: string;
  pipeline?: ModelPipeline;
  dtype?: "q4" | "q8" | "fp16" | "fp32";
  device?: "webgpu" | "wasm";
  messages?: ModelMessage[];
  input?: unknown;
  options?: Record<string, unknown>;
};

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

const scope = self as unknown as {
  postMessage: (value: WorkerResponse) => void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;

let activeKey = "";
let activePipeline: any = null;
let activePromise: Promise<any> | null = null;
let queue: Promise<void> = Promise.resolve();

function send(value: WorkerResponse): void {
  scope.postMessage(value);
}

function outputText(output: unknown): string {
  const first = Array.isArray(output) ? output[0] : output;
  if (typeof first === "string") return first.trim();
  const generated = (first as { generated_text?: unknown; summary_text?: unknown; answer?: unknown } | null)?.generated_text;
  if (Array.isArray(generated)) {
    const last = generated.at(-1) as { content?: unknown } | undefined;
    if (typeof last?.content === "string") return last.content.trim();
  }
  if (typeof generated === "string") return generated.trim();
  const summary = (first as { summary_text?: unknown } | null)?.summary_text;
  if (typeof summary === "string") return summary.trim();
  const answer = (first as { answer?: unknown } | null)?.answer;
  return typeof answer === "string" ? answer.trim() : "";
}

function serializableOutput(output: unknown, pipelineName?: ModelPipeline): unknown {
  if (pipelineName !== "feature-extraction") return output;
  const tensor = output as { data?: ArrayLike<number>; dims?: number[] } | null;
  if (!tensor?.data || !Array.isArray(tensor.dims)) {
    throw new Error("Model embedding tidak mengembalikan tensor yang valid.");
  }
  return {
    data: Array.from(tensor.data),
    dims: [...tensor.dims],
  };
}

async function disposeActive(): Promise<void> {
  const current = activePipeline as { dispose?: () => void | Promise<void> } | null;
  activePipeline = null;
  activePromise = null;
  activeKey = "";
  if (current?.dispose) await Promise.resolve(current.dispose());
}

async function load(request: WorkerRequest): Promise<{ pipe: any; milliseconds: number }> {
  if (!request.modelId || !request.pipeline || !request.dtype || !request.device) {
    throw new Error("Konfigurasi model lokal tidak lengkap.");
  }
  const key = `${request.pipeline}:${request.modelId}:${request.dtype}:${request.device}`;
  if (activePipeline && activeKey === key) return { pipe: activePipeline, milliseconds: 0 };
  if (activePromise && activeKey === key) return { pipe: await activePromise, milliseconds: 0 };
  await disposeActive();
  activeKey = key;
  const started = performance.now();
  const options = {
    dtype: request.dtype,
    device: request.device,
    progress_callback: (info: Record<string, unknown>) => {
      const numeric = Number(info.progress);
      if (info.status === "progress" && Number.isFinite(numeric)) {
        send({
          id: request.id,
          type: "progress",
          progress: Math.max(0, Math.min(100, Math.round(numeric))),
          message: `Memuat ${request.modelId}`,
        });
      }
    },
  };
  activePromise = pipeline(request.pipeline as any, request.modelId, options as any);
  try {
    activePipeline = await activePromise;
    const milliseconds = performance.now() - started;
    send({ id: request.id, type: "progress", progress: 100, message: "Model lokal siap", loadMilliseconds: milliseconds });
    return { pipe: activePipeline, milliseconds };
  } catch (error) {
    await disposeActive();
    throw error;
  }
}

async function handle(request: WorkerRequest): Promise<void> {
  if (request.type === "dispose") {
    await disposeActive();
    send({ id: request.id, type: "disposed" });
    return;
  }
  const loaded = await load(request);
  if (request.type === "warm") {
    send({ id: request.id, type: "result", text: "ready", loadMilliseconds: loaded.milliseconds });
    return;
  }
  const started = performance.now();
  const options = { ...(request.options || {}) } as Record<string, unknown>;
  if (request.pipeline === "text-generation") {
    const tokenizer = (loaded.pipe as { tokenizer?: unknown }).tokenizer;
    if (tokenizer) {
      options.streamer = new TextStreamer(tokenizer as any, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (token: string) => {
          if (token) send({ id: request.id, type: "token", text: token });
        },
      });
    }
  }
  const input = request.messages?.length ? request.messages : request.input;
  if (input == null) throw new Error("Input model lokal kosong.");
  const output = await loaded.pipe(input, options);
  const milliseconds = performance.now() - started;
  send({
    id: request.id,
    type: "result",
    text: outputText(output),
    output: serializableOutput(output, request.pipeline),
    loadMilliseconds: loaded.milliseconds,
    generationMilliseconds: milliseconds,
  });
}

scope.onmessage = (event) => {
  const request = event.data;
  queue = queue.then(async () => {
    try {
      await handle(request);
    } catch (error) {
      send({ id: request.id, type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  });
};
