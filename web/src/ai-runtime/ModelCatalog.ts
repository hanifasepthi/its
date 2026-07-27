import {
  FALLBACK_MODEL_MANIFEST,
  pipelineForTask,
  type ModelCandidate,
  type ModelPipeline,
  type ModelTask,
} from "./ModelTaskTypes";

type HubModel = {
  id?: unknown;
  private?: unknown;
  gated?: unknown;
  pipeline_tag?: unknown;
  tags?: unknown;
  downloads?: unknown;
  siblings?: unknown;
  cardData?: unknown;
  config?: unknown;
};

const CATALOG_CACHE_PREFIX = "its-ai-model-catalog:v3:";
const CATALOG_TTL = 12 * 60 * 60 * 1000;

function timeoutSignal(milliseconds: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(milliseconds);
  const controller = new AbortController();
  window.setTimeout(() => controller.abort(), milliseconds);
  return controller.signal;
}

function hubPipeline(task: ModelTask): string {
  const pipeline = pipelineForTask(task);
  if (pipeline === "image-text-to-text") return "image-to-text";
  return pipeline;
}

function modelFiles(value: HubModel): string[] {
  if (!Array.isArray(value.siblings)) return [];
  return value.siblings
    .map((item) => typeof (item as { rfilename?: unknown })?.rfilename === "string" ? String((item as { rfilename: string }).rfilename) : "")
    .filter(Boolean);
}

function licenseOf(value: HubModel): string {
  const cardData = value.cardData as { license?: unknown } | null;
  if (typeof cardData?.license === "string") return cardData.license;
  const tags = Array.isArray(value.tags) ? value.tags.map(String) : [];
  return tags.find((tag) => tag.startsWith("license:"))?.slice(8) || "unknown";
}

function parameterEstimate(id: string, files: string[]): number {
  const normalized = id.toLowerCase();
  const match = normalized.match(/(?:^|[-_/])(\d+(?:\.\d+)?)b(?:[-_/]|$)/);
  if (match) return Number(match[1]);
  const onnxCount = files.filter((file) => file.endsWith(".onnx")).length;
  return onnxCount > 4 ? 1 : 0.5;
}

function compatibleFiles(files: string[], pipeline: ModelPipeline): boolean {
  const hasOnnx = files.some((file) => /(?:^|\/)onnx\/.*\.onnx$/i.test(file) || /model.*\.onnx$/i.test(file));
  const hasConfig = files.includes("config.json");
  const needsTokenizer = ["text-generation", "text-classification", "feature-extraction", "summarization"].includes(pipeline);
  const hasTokenizer = files.some((file) => /tokenizer(?:_config)?\.json$/i.test(file) || /sentencepiece.*\.model$/i.test(file));
  const needsProcessor = ["document-question-answering", "image-to-text", "image-text-to-text", "image-classification", "object-detection"].includes(pipeline);
  const hasProcessor = files.some((file) => /(?:preprocessor|processor)_config\.json$/i.test(file));
  return hasOnnx && hasConfig && (!needsTokenizer || hasTokenizer) && (!needsProcessor || hasProcessor);
}

function parseHubModel(value: HubModel, task: ModelTask): ModelCandidate | null {
  const id = typeof value.id === "string" ? value.id : "";
  if (!id || value.private === true || value.gated === true) return null;
  const tags = Array.isArray(value.tags) ? value.tags.map(String) : [];
  const files = modelFiles(value);
  const pipeline = pipelineForTask(task);
  const requiresRemoteCode = tags.includes("custom_code") || tags.includes("trust_remote_code");
  const transformersJs = tags.some((tag) => /transformers\.js|transformersjs/i.test(tag)) || id.startsWith("Xenova/") || id.startsWith("onnx-community/");
  if (requiresRemoteCode || !transformersJs || !compatibleFiles(files, pipeline)) return null;
  const parameterBillions = parameterEstimate(id, files);
  return {
    id,
    tasks: [task],
    pipeline,
    parameterBillions,
    quantizations: files.some((file) => /q4|4bit/i.test(file)) ? ["q4", "q8", "fp16"] : ["q8", "fp16", "fp32"],
    estimatedBytes: Math.max(80_000_000, Math.round(parameterBillions * 1_100_000_000)),
    license: licenseOf(value),
    public: true,
    gated: false,
    hasOnnx: true,
    transformersJs: true,
    requiresRemoteCode: false,
    files,
    downloads: Number.isFinite(Number(value.downloads)) ? Number(value.downloads) : 0,
    source: "hub",
  };
}

function cached(task: ModelTask): ModelCandidate[] | null {
  try {
    const record = JSON.parse(localStorage.getItem(`${CATALOG_CACHE_PREFIX}${task}`) || "null") as { at?: number; items?: ModelCandidate[] } | null;
    if (!record?.at || !Array.isArray(record.items) || Date.now() - record.at > CATALOG_TTL) return null;
    return record.items;
  } catch {
    return null;
  }
}

export class ModelCatalog {
  async discover(task: ModelTask, force = false): Promise<ModelCandidate[]> {
    const fromCache = !force ? cached(task) : null;
    if (fromCache?.length) return this.mergeFallback(task, fromCache);
    const url = new URL("https://huggingface.co/api/models");
    url.searchParams.set("pipeline_tag", hubPipeline(task));
    url.searchParams.set("library", "transformers.js");
    url.searchParams.set("limit", "24");
    url.searchParams.set("full", "true");
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: timeoutSignal(9_000),
      });
      if (!response.ok) throw new Error(`Hub metadata HTTP ${response.status}`);
      const payload = await response.json() as HubModel[];
      const items = Array.isArray(payload)
        ? payload.map((item) => parseHubModel(item, task)).filter((item): item is ModelCandidate => Boolean(item))
        : [];
      try {
        localStorage.setItem(`${CATALOG_CACHE_PREFIX}${task}`, JSON.stringify({ at: Date.now(), items }));
      } catch {
        // The fallback manifest is still available when storage is blocked.
      }
      return this.mergeFallback(task, items);
    } catch {
      return this.mergeFallback(task, []);
    }
  }

  private mergeFallback(task: ModelTask, discovered: ModelCandidate[]): ModelCandidate[] {
    const merged = new Map<string, ModelCandidate>();
    discovered.forEach((item) => merged.set(item.id, item));
    FALLBACK_MODEL_MANIFEST.filter((item) => item.tasks.includes(task)).forEach((item) => {
      const live = merged.get(item.id);
      // Hub metadata cannot reliably infer parameter counts from model IDs
      // such as MiniLM-L6-v2 and otherwise reports them as 500M. Keep the
      // curated compatibility metadata while retaining current popularity.
      merged.set(item.id, live
        ? { ...item, downloads: live.downloads, source: "hub" }
        : item);
    });
    return [...merged.values()];
  }
}

export const modelCatalog = new ModelCatalog();
