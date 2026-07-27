import { LocalModelClient } from "./LocalModelClient";
import { modelResolver } from "./ModelResolver";

type EmbeddingTensor = {
  data: number[];
  dims: number[];
};

export type EmbedOptions = {
  signal?: AbortSignal;
  onProgress?: (message: string, progress?: number) => void;
};

function isEmbeddingTensor(value: unknown): value is EmbeddingTensor {
  if (!value || typeof value !== "object") return false;
  const tensor = value as Record<string, unknown>;
  return Array.isArray(tensor.data)
    && tensor.data.every((entry) => Number.isFinite(Number(entry)))
    && Array.isArray(tensor.dims)
    && tensor.dims.every((entry) => Number.isInteger(Number(entry)) && Number(entry) > 0);
}

/** Dedicated worker so semantic ranking never unloads or blocks the answer model. */
export class EmbeddingClient {
  private readonly client = new LocalModelClient();

  async embed(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
    if (!texts.length) return [];
    const model = await modelResolver.resolve("embeddings");
    options.onProgress?.(`Memakai ${model.selection.candidate.id}`, 4);
    const result = await this.client.infer(model.selection, texts, {
      signal: options.signal,
      timeoutMs: model.selection.device === "webgpu" ? 120_000 : 45_000,
      onProgress: options.onProgress,
      pipelineOptions: {
        pooling: "mean",
        normalize: true,
      },
    });
    if (!isEmbeddingTensor(result.output)) {
      throw new Error("Tensor embedding tidak dapat dibaca.");
    }
    const rows = result.output.dims.length > 1 ? result.output.dims[0] : 1;
    const width = result.output.dims.at(-1) || 0;
    if (!width || rows !== texts.length || result.output.data.length !== rows * width) {
      throw new Error("Dimensi embedding tidak sesuai jumlah teks.");
    }
    const vectors: number[][] = [];
    for (let row = 0; row < rows; row += 1) {
      vectors.push(result.output.data.slice(row * width, (row + 1) * width));
    }
    options.onProgress?.(`${rows} embedding selesai dihitung`, 100);
    return vectors;
  }

  dispose(): void {
    this.client.dispose();
  }
}

export const embeddingClient = new EmbeddingClient();
