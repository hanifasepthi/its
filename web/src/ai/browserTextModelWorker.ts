import { env, pipeline } from "@huggingface/transformers";

type BrowserTextSkill = "chat" | "research";

type WorkerRequest = {
  id: string;
  type: "generate" | "warm" | "dispose";
  skill?: BrowserTextSkill;
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  options?: Record<string, unknown>;
};

type WorkerResponse = {
  id: string;
  type: "progress" | "result" | "error" | "disposed";
  message?: string;
  progress?: number;
  text?: string;
};

const MODEL_BY_SKILL: Record<BrowserTextSkill, string> = {
  chat: "onnx-community/SmolLM2-135M-Instruct-ONNX",
  research: "onnx-community/Qwen2.5-0.5B-Instruct",
};

const workerScope = self as unknown as {
  postMessage: (message: WorkerResponse) => void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;

let activeSkill: BrowserTextSkill | null = null;
let activeGenerator: any = null;
let activeGeneratorPromise: Promise<any> | null = null;
let queue: Promise<void> = Promise.resolve();

function send(message: WorkerResponse): void {
  workerScope.postMessage(message);
}

function generatedText(output: unknown): string {
  const first = Array.isArray(output) ? output[0] : output;
  const generated = (first as { generated_text?: unknown } | null)?.generated_text;
  if (Array.isArray(generated)) {
    const last = generated.at(-1) as { content?: unknown } | undefined;
    return typeof last?.content === "string" ? last.content.trim() : "";
  }
  if (typeof generated === "string") return generated.trim();
  if (typeof first === "string") return first.trim();
  return "";
}

async function disposeActiveGenerator(): Promise<void> {
  const generator = activeGenerator as { dispose?: () => Promise<void> | void } | null;
  activeGenerator = null;
  activeGeneratorPromise = null;
  activeSkill = null;
  if (generator?.dispose) await Promise.resolve(generator.dispose());
}

async function createGenerator(skill: BrowserTextSkill, requestId: string): Promise<any> {
  const modelId = MODEL_BY_SKILL[skill];
  const progressCallback = (info: Record<string, unknown>) => {
    if (info.status === "progress" && Number.isFinite(Number(info.progress))) {
      const progress = Math.max(0, Math.min(100, Math.round(Number(info.progress))));
      send({
        id: requestId,
        type: "progress",
        progress,
        message: `Skill model ${skill === "research" ? "riset" : "bahasa"}: memuat ${progress}%`,
      });
    }
  };
  const options = { dtype: "q4" as const, progress_callback: progressCallback };

  if ("gpu" in navigator) {
    try {
      return await pipeline("text-generation", modelId, { ...options, device: "webgpu" });
    } catch {
      send({ id: requestId, type: "progress", message: "WebGPU tidak tersedia; skill model beralih ke WASM" });
    }
  }
  return pipeline("text-generation", modelId, { ...options, device: "wasm" });
}

async function ensureGenerator(skill: BrowserTextSkill, requestId: string): Promise<any> {
  if (activeSkill === skill && activeGenerator) return activeGenerator;
  if (activeSkill === skill && activeGeneratorPromise) return activeGeneratorPromise;
  await disposeActiveGenerator();
  activeSkill = skill;
  activeGeneratorPromise = createGenerator(skill, requestId);
  try {
    activeGenerator = await activeGeneratorPromise;
    send({ id: requestId, type: "progress", progress: 100, message: `Skill model ${skill} siap` });
    return activeGenerator;
  } catch (error) {
    activeSkill = null;
    activeGeneratorPromise = null;
    throw error;
  }
}

async function handleRequest(request: WorkerRequest): Promise<void> {
  if (request.type === "dispose") {
    await disposeActiveGenerator();
    send({ id: request.id, type: "disposed" });
    return;
  }
  if (!request.skill) throw new Error("Skill model tidak tersedia.");
  if (request.type === "warm") {
    await ensureGenerator(request.skill, request.id);
    send({ id: request.id, type: "result", text: "ready" });
    return;
  }
  if (!request.messages?.length) throw new Error("Permintaan model tidak lengkap.");
  const generator = await ensureGenerator(request.skill, request.id);
  send({ id: request.id, type: "progress", message: `Skill model ${request.skill}: menyusun jawaban` });
  const output = await generator(request.messages, request.options || {});
  const text = generatedText(output);
  if (!text) throw new Error("Model lokal tidak menghasilkan teks.");
  send({ id: request.id, type: "result", text });
}

workerScope.onmessage = (event) => {
  const request = event.data;
  queue = queue.then(async () => {
    try {
      await handleRequest(request);
    } catch (error) {
      send({
        id: request.id,
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
