import { deviceProfiler, type DeviceProfile } from "./DeviceProfiler";
import { modelCatalog } from "./ModelCatalog";
import { modelBenchmarkStore } from "./ModelBenchmarkStore";
import { modelCompatibilityChecker } from "./ModelCompatibilityChecker";
import { modelPool } from "./ModelPool";
import type {
  ModelCandidate,
  ModelDiagnostics,
  ModelGenerationOptions,
  ModelMessage,
  ModelSelection,
  ModelTask,
} from "./ModelTaskTypes";

const SELECTION_CACHE_PREFIX = "its-ai-model-selection:v4:";

function candidateScore(candidate: ModelCandidate, profile: DeviceProfile, task: ModelTask): number {
  if (task === "embeddings" && !profile.webGpu && candidate.parameterBillions > 0.05) {
    // Large multilingual retrievers can lock the UI for minutes when ONNX is
    // forced through WASM. The 23M MiniLM fallback runs in a worker; lexical
    // retrieval still preserves Indonesian entities before semantic ranking.
    return Number.NEGATIVE_INFINITY;
  }
  const compatibility = modelCompatibilityChecker.check(candidate, profile);
  if (!compatibility.compatible) return Number.NEGATIVE_INFINITY;
  let score = candidate.source === "fallback" ? 35 : 50;
  if (candidate.quantizations.includes("q4")) score += 16;
  if (candidate.id.startsWith("onnx-community/") || candidate.id.startsWith("Xenova/")) score += 12;
  score -= candidate.parameterBillions * (profile.tier === "LOW" ? 25 : 8);
  score -= candidate.estimatedBytes / Math.max(1, profile.cacheQuotaBytes || 8_000_000_000) * 20;
  score += Math.min(8, Math.log10(candidate.downloads + 1));
  if (task === "embeddings" && /(?:bge-m3|multilingual)/i.test(candidate.id)) {
    // Evidence commonly mixes Indonesian and English. Prefer a multilingual
    // retriever when the device can run it, while compatibility checks still
    // protect low-memory devices.
    score += profile.tier === "LOW" ? 8 : 18;
  }
  if (task === "research-synthesis") {
    // A 135M planner is responsive but is not reliable enough for grounded
    // scientific prose. Research synthesis deliberately favors the larger
    // local instruct model on both WebGPU and WASM; inference still runs in a
    // worker so the map and chat controls remain responsive.
    if (candidate.parameterBillions >= 0.4) score += profile.webGpu ? 28 : 8;
    if (/gemma-3-270m-it/i.test(candidate.id)) {
      // Gemma q4/q8 currently needs GatherBlockQuantized, which the WASM
      // execution provider does not implement. Its fp16 graph loads but is too
      // slow to produce an interactive first token, so never prefer it on WASM.
      score += profile.webGpu ? 24 : -80;
    }
  }
  if (candidate.id.startsWith("onnx-community/Qwen3-") && candidate.tasks.includes(task)) {
    // Use the strongest profile that fits the measured device. This gives
    // high-tier WebGPU devices Qwen3 4B, medium devices 1.7B, and constrained
    // devices the 0.6B fallback instead of always favouring the smallest file.
    const target = profile.tier === "HIGH" ? 4 : profile.tier === "MEDIUM" ? 1.7 : 0.6;
    score += Math.abs(candidate.parameterBillions - target) < 0.05 ? 120 : -35;
  }
  return score + modelBenchmarkStore.score(candidate.id, task);
}

function dtypeFor(candidate: ModelCandidate, profile: DeviceProfile): ModelSelection["dtype"] {
  if (!profile.webGpu && /gemma-3-270m-it/i.test(candidate.id) && candidate.quantizations.includes("fp16")) {
    // Gemma's q4/q8 exports use GatherBlockQuantized, which is currently not
    // implemented by the WASM execution provider. The fp16 graph uses regular
    // ONNX operators and remains isolated in LocalModelWorker.
    return "fp16";
  }
  if (profile.webGpu && candidate.quantizations.includes("q4f16")) return "q4f16";
  if (candidate.quantizations.includes("q4")) return "q4";
  if (profile.webGpu && profile.tier !== "LOW" && candidate.quantizations.includes("fp16")) return "fp16";
  if (candidate.quantizations.includes("q8")) return "q8";
  return candidate.quantizations.includes("fp32") ? "fp32" : candidate.quantizations[0];
}

function wasmDtypeFor(candidate: ModelCandidate): ModelSelection["dtype"] {
  if (/gemma-3-270m-it/i.test(candidate.id) && candidate.quantizations.includes("fp16")) return "fp16";
  if (candidate.quantizations.includes("q4")) return "q4";
  if (candidate.quantizations.includes("q4f16")) return "q4f16";
  if (candidate.quantizations.includes("q8")) return "q8";
  return candidate.quantizations.includes("fp32") ? "fp32" : candidate.quantizations[0];
}

function extractJsonObject(text: string): unknown {
  const withoutFence = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = withoutFence.indexOf("{");
  if (start < 0) throw new Error("Model tidak menghasilkan objek JSON.");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < withoutFence.length; index += 1) {
    const character = withoutFence[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (character === '"') inString = !inString;
    if (inString) continue;
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth === 0) return JSON.parse(withoutFence.slice(start, index + 1));
  }
  throw new Error("Objek JSON model tidak lengkap.");
}

export type ResolvedLocalModel = {
  selection: ModelSelection;
  diagnostics: () => ModelDiagnostics;
  generateText: (messages: ModelMessage[], options?: ModelGenerationOptions) => Promise<string>;
  generateStructured: <T>(
    messages: ModelMessage[],
    validate: (value: unknown) => value is T,
    options?: ModelGenerationOptions,
  ) => Promise<T>;
};

export class ModelResolver {
  private selections = new Map<ModelTask, Promise<ModelSelection>>();
  private diagnosticsState = new Map<ModelTask, ModelDiagnostics>();

  async resolve(task: ModelTask): Promise<ResolvedLocalModel> {
    let activeSelection = await this.selection(task);
    const generateText = async (messages: ModelMessage[], options: ModelGenerationOptions = {}): Promise<string> => {
      const diagnostics = this.diagnosticsState.get(task);
      // The research chat is local-first by contract. Network calls are used
      // only for retrieving public evidence, never for hosted-model inference.
      options.onProgress?.("Menjalankan model ONNX lokal di perangkat", 1);
      const execute = async (selection: ModelSelection) => {
        const result = await modelPool.generate(selection, messages, options);
        modelBenchmarkStore.record(selection, true, result.loadMilliseconds, result.generationMilliseconds);
        if (diagnostics) {
          diagnostics.selection = selection;
          diagnostics.loadMilliseconds = result.loadMilliseconds;
          diagnostics.generationMilliseconds = result.generationMilliseconds;
          diagnostics.provider = diagnostics.fallbackReason ? "local-fallback" : "local";
          diagnostics.lastError = "";
        }
        if (!result.text) throw new Error("Model lokal tidak mengembalikan teks.");
        return result.text;
      };
      try {
        return await execute(activeSelection);
      } catch (error) {
        modelBenchmarkStore.record(activeSelection, false);
        if (options.signal?.aborted) throw error;
        if (activeSelection.device === "webgpu") {
          options.onProgress?.("WebGPU tidak tersedia; model dilanjutkan melalui WASM", 1);
          modelPool.dispose();
          activeSelection = {
            ...activeSelection,
            device: "wasm",
            dtype: wasmDtypeFor(activeSelection.candidate),
            reason: [...activeSelection.reason, "webgpu-runtime-fallback=wasm"],
            selectedAt: Date.now(),
          };
          this.selections.set(task, Promise.resolve(activeSelection));
          const diagnostics = this.diagnosticsState.get(task);
          if (diagnostics) diagnostics.selection = activeSelection;
          try {
            localStorage.setItem(`${SELECTION_CACHE_PREFIX}${task}`, JSON.stringify(activeSelection));
          } catch {
            // Diagnostics storage is optional.
          }
          return await execute(activeSelection);
        }
        if (diagnostics) diagnostics.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    };
    return {
      get selection() { return activeSelection; },
      diagnostics: () => ({ ...this.diagnosticsState.get(task)! }),
      generateText,
      generateStructured: async <T>(
        messages: ModelMessage[],
        validate: (value: unknown) => value is T,
        options: ModelGenerationOptions = {},
      ): Promise<T> => {
        const text = await generateText(messages, options);
        const parsed = extractJsonObject(text);
        if (!validate(parsed)) throw new Error("JSON model tidak sesuai schema yang diwajibkan.");
        return parsed;
      },
    };
  }

  getDiagnostics(): ModelDiagnostics[] {
    return [...this.diagnosticsState.values()].map((item) => ({ ...item }));
  }

  clear(): void {
    this.selections.clear();
    this.diagnosticsState.clear();
    modelPool.dispose();
  }

  private selection(task: ModelTask): Promise<ModelSelection> {
    const current = this.selections.get(task);
    if (current) return current;
    const next = this.select(task);
    this.selections.set(task, next);
    return next;
  }

  private async select(task: ModelTask): Promise<ModelSelection> {
    const profile = await deviceProfiler.profile();
    const candidates = await modelCatalog.discover(task);
    const ranked = candidates
      .map((candidate) => ({ candidate, score: candidateScore(candidate, profile, task) }))
      .filter((item) => Number.isFinite(item.score))
      .sort((left, right) => right.score - left.score);
    const best = ranked[0];
    if (!best) throw new Error(`Tidak ada model lokal kompatibel untuk task ${task}.`);
    const selection: ModelSelection = {
      task,
      candidate: best.candidate,
      dtype: dtypeFor(best.candidate, profile),
      device: profile.webGpu ? "webgpu" : "wasm",
      score: best.score,
      reason: [
        `tier=${profile.tier}`,
        `pipeline=${best.candidate.pipeline}`,
        `parameters=${best.candidate.parameterBillions}B`,
        `source=${best.candidate.source}`,
      ],
      selectedAt: Date.now(),
    };
    try {
      localStorage.setItem(`${SELECTION_CACHE_PREFIX}${task}`, JSON.stringify(selection));
    } catch {
      // Diagnostics storage is optional.
    }
    this.diagnosticsState.set(task, {
      selection,
      loadMilliseconds: null,
      generationMilliseconds: null,
      cacheHit: false,
      lastError: "",
      provider: "local",
    });
    return selection;
  }
}

export const modelResolver = new ModelResolver();
