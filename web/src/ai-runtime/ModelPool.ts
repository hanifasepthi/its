import { modelWorker } from "./ModelWorker";
import type { ModelGenerationOptions, ModelMessage, ModelSelection } from "./ModelTaskTypes";

const GENERATIVE_PIPELINES = new Set(["text-generation", "summarization", "image-to-text", "image-text-to-text"]);

/** Keeps a single active generative model and serializes heavy model work in the worker. */
export class ModelPool {
  private activeGenerativeKey = "";

  async generate(selection: ModelSelection, messages: ModelMessage[], options: ModelGenerationOptions = {}) {
    const key = `${selection.candidate.id}:${selection.dtype}:${selection.device}`;
    if (GENERATIVE_PIPELINES.has(selection.candidate.pipeline) && this.activeGenerativeKey && this.activeGenerativeKey !== key) {
      modelWorker.dispose();
    }
    if (GENERATIVE_PIPELINES.has(selection.candidate.pipeline)) this.activeGenerativeKey = key;
    return modelWorker.generate(selection, messages, options);
  }

  dispose(): void {
    this.activeGenerativeKey = "";
    modelWorker.dispose();
  }
}

export const modelPool = new ModelPool();
