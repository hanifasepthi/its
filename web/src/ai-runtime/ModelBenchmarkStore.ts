import type { ModelSelection, ModelTask } from "./ModelTaskTypes";

const KEY = "its-ai-model-benchmarks:v1";

export type ModelBenchmark = {
  modelId: string;
  task: ModelTask;
  samples: number;
  successes: number;
  averageLoadMs: number;
  averageGenerationMs: number;
  updatedAt: number;
};

function readAll(): Record<string, ModelBenchmark> {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, ModelBenchmark>; } catch { return {}; }
}

function benchmarkKey(modelId: string, task: ModelTask): string {
  return `${task}:${modelId}`;
}

export class ModelBenchmarkStore {
  get(modelId: string, task: ModelTask): ModelBenchmark | null {
    return readAll()[benchmarkKey(modelId, task)] || null;
  }

  score(modelId: string, task: ModelTask): number {
    const value = this.get(modelId, task);
    if (!value?.samples) return 0;
    const reliability = value.successes / value.samples;
    const latencyPenalty = Math.min(12, value.averageGenerationMs / 10_000);
    return reliability * 18 - latencyPenalty;
  }

  record(selection: ModelSelection, success: boolean, loadMs = 0, generationMs = 0): void {
    const records = readAll();
    const key = benchmarkKey(selection.candidate.id, selection.task);
    const prior = records[key] || {
      modelId: selection.candidate.id,
      task: selection.task,
      samples: 0,
      successes: 0,
      averageLoadMs: 0,
      averageGenerationMs: 0,
      updatedAt: 0,
    };
    const samples = prior.samples + 1;
    records[key] = {
      ...prior,
      samples,
      successes: prior.successes + (success ? 1 : 0),
      averageLoadMs: prior.averageLoadMs + (loadMs - prior.averageLoadMs) / samples,
      averageGenerationMs: prior.averageGenerationMs + (generationMs - prior.averageGenerationMs) / samples,
      updatedAt: Date.now(),
    };
    try { localStorage.setItem(KEY, JSON.stringify(records)); } catch { /* Benchmarking is optional. */ }
  }
}

export const modelBenchmarkStore = new ModelBenchmarkStore();
