export type ModelTask =
  | "planner"
  | "intent-classification"
  | "query-generation"
  | "research-synthesis"
  | "follow-up-reasoning"
  | "summarization"
  | "embeddings"
  | "document-question-answering"
  | "image-text-understanding"
  | "OCR"
  | "object-detection";

export type ModelPipeline =
  | "text-generation"
  | "text-classification"
  | "feature-extraction"
  | "summarization"
  | "document-question-answering"
  | "image-to-text"
  | "image-text-to-text"
  | "image-classification"
  | "object-detection";

export type DeviceTier = "LOW" | "MEDIUM" | "HIGH";

export type ModelCandidate = {
  id: string;
  tasks: ModelTask[];
  pipeline: ModelPipeline;
  parameterBillions: number;
  quantizations: Array<"q4" | "q4f16" | "q8" | "fp16" | "fp32">;
  estimatedBytes: number;
  license: string;
  public: boolean;
  gated: boolean;
  hasOnnx: boolean;
  transformersJs: boolean;
  requiresRemoteCode: boolean;
  files: string[];
  downloads: number;
  source: "hub" | "fallback";
};

export type ModelSelection = {
  task: ModelTask;
  candidate: ModelCandidate;
  dtype: "q4" | "q4f16" | "q8" | "fp16" | "fp32";
  device: "webgpu" | "wasm";
  score: number;
  reason: string[];
  selectedAt: number;
};

export type ModelGenerationOptions = {
  maxNewTokens?: number;
  temperature?: number;
  doSample?: boolean;
  repetitionPenalty?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (message: string, progress?: number) => void;
  onToken?: (token: string) => void;
};

export type ModelMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ModelDiagnostics = {
  selection: ModelSelection;
  loadMilliseconds: number | null;
  generationMilliseconds: number | null;
  cacheHit: boolean;
  lastError: string;
  provider?: "cloudflare" | "local" | "local-fallback";
  remoteModel?: string;
  gateway?: string;
  fallbackReason?: string;
};

const TEXT_TASKS: ModelTask[] = [
  "planner",
  "intent-classification",
  "query-generation",
  "research-synthesis",
  "follow-up-reasoning",
];

export const FALLBACK_MODEL_MANIFEST: ModelCandidate[] = [
  {
    id: "onnx-community/Qwen3-4B-ONNX",
    tasks: TEXT_TASKS,
    pipeline: "text-generation",
    parameterBillions: 4,
    quantizations: ["q4f16", "fp16"],
    estimatedBytes: 2_700_000_000,
    license: "apache-2.0",
    public: true,
    gated: false,
    hasOnnx: true,
    transformersJs: true,
    requiresRemoteCode: false,
    files: ["config.json", "tokenizer.json", "onnx/model_q4f16.onnx"],
    downloads: 0,
    source: "fallback",
  },
  {
    id: "onnx-community/Qwen3-1.7B-ONNX",
    tasks: TEXT_TASKS,
    pipeline: "text-generation",
    parameterBillions: 1.7,
    quantizations: ["q4f16", "fp16"],
    estimatedBytes: 1_150_000_000,
    license: "apache-2.0",
    public: true,
    gated: false,
    hasOnnx: true,
    transformersJs: true,
    requiresRemoteCode: false,
    files: ["config.json", "tokenizer.json", "onnx/model_q4f16.onnx"],
    downloads: 0,
    source: "fallback",
  },
  {
    id: "onnx-community/Qwen3-0.6B-ONNX",
    tasks: TEXT_TASKS,
    pipeline: "text-generation",
    parameterBillions: 0.6,
    quantizations: ["q4f16", "fp16"],
    estimatedBytes: 430_000_000,
    license: "apache-2.0",
    public: true,
    gated: false,
    hasOnnx: true,
    transformersJs: true,
    requiresRemoteCode: false,
    files: ["config.json", "tokenizer.json", "onnx/model_q4f16.onnx"],
    downloads: 0,
    source: "fallback",
  },
  {
    id: "Xenova/distilbart-cnn-6-6",
    tasks: ["summarization"],
    pipeline: "summarization",
    parameterBillions: 0.23,
    quantizations: ["q8", "fp32"],
    estimatedBytes: 320_000_000,
    license: "apache-2.0",
    public: true,
    gated: false,
    hasOnnx: true,
    transformersJs: true,
    requiresRemoteCode: false,
    files: ["config.json", "tokenizer.json", "onnx/encoder_model_quantized.onnx"],
    downloads: 0,
    source: "fallback",
  },
  {
    id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    tasks: ["embeddings"],
    pipeline: "feature-extraction",
    parameterBillions: 0.118,
    quantizations: ["q8", "fp32"],
    estimatedBytes: 160_000_000,
    license: "apache-2.0",
    public: true,
    gated: false,
    hasOnnx: true,
    transformersJs: true,
    requiresRemoteCode: false,
    files: ["config.json", "tokenizer.json", "onnx/model_quantized.onnx"],
    downloads: 0,
    source: "fallback",
  },
  {
    id: "Xenova/all-MiniLM-L6-v2",
    tasks: ["embeddings"],
    pipeline: "feature-extraction",
    parameterBillions: 0.023,
    quantizations: ["q8", "fp32"],
    estimatedBytes: 95_000_000,
    license: "apache-2.0",
    public: true,
    gated: false,
    hasOnnx: true,
    transformersJs: true,
    requiresRemoteCode: false,
    files: ["config.json", "tokenizer.json", "onnx/model_quantized.onnx"],
    downloads: 0,
    source: "fallback",
  },
  {
    id: "Xenova/donut-base-finetuned-docvqa",
    tasks: ["document-question-answering"],
    pipeline: "document-question-answering",
    parameterBillions: 0.2,
    quantizations: ["q8", "fp32"],
    estimatedBytes: 430_000_000,
    license: "apache-2.0",
    public: true,
    gated: false,
    hasOnnx: true,
    transformersJs: true,
    requiresRemoteCode: false,
    files: ["config.json", "preprocessor_config.json", "onnx/encoder_model_quantized.onnx"],
    downloads: 0,
    source: "fallback",
  },
  {
    id: "Xenova/vit-gpt2-image-captioning",
    tasks: ["image-text-understanding"],
    pipeline: "image-to-text",
    parameterBillions: 0.24,
    quantizations: ["q8", "fp32"],
    estimatedBytes: 470_000_000,
    license: "apache-2.0",
    public: true,
    gated: false,
    hasOnnx: true,
    transformersJs: true,
    requiresRemoteCode: false,
    files: ["config.json", "preprocessor_config.json", "onnx/encoder_model_quantized.onnx"],
    downloads: 0,
    source: "fallback",
  },
  {
    id: "Xenova/trocr-small-printed",
    tasks: ["OCR"],
    pipeline: "image-to-text",
    parameterBillions: 0.06,
    quantizations: ["q8", "fp32"],
    estimatedBytes: 170_000_000,
    license: "apache-2.0",
    public: true,
    gated: false,
    hasOnnx: true,
    transformersJs: true,
    requiresRemoteCode: false,
    files: ["config.json", "preprocessor_config.json", "onnx/encoder_model_quantized.onnx"],
    downloads: 0,
    source: "fallback",
  },
  {
    id: "onnx-community/rfdetr_nano-ONNX",
    tasks: ["object-detection"],
    pipeline: "object-detection",
    parameterBillions: 0.03,
    quantizations: ["fp32"],
    estimatedBytes: 120_000_000,
    license: "apache-2.0",
    public: true,
    gated: false,
    hasOnnx: true,
    transformersJs: true,
    requiresRemoteCode: false,
    files: ["config.json", "preprocessor_config.json", "onnx/model.onnx"],
    downloads: 0,
    source: "fallback",
  },
];

export function pipelineForTask(task: ModelTask): ModelPipeline {
  if (task === "embeddings") return "feature-extraction";
  if (task === "summarization") return "summarization";
  if (task === "document-question-answering") return "document-question-answering";
  if (task === "image-text-understanding" || task === "OCR") return "image-to-text";
  if (task === "object-detection") return "object-detection";
  return "text-generation";
}
