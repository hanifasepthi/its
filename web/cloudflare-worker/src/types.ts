export type AiRole = "system" | "user" | "assistant";

export type AiMessage = {
  role: AiRole;
  content: string;
};

export type AiBinding = {
  run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
};

export type VectorizeMatch = {
  id: string;
  score?: number;
  metadata?: Record<string, unknown>;
};

export type VectorizeBinding = {
  query(vector: number[], options: Record<string, unknown>): Promise<{ matches?: VectorizeMatch[] }>;
  upsert(vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
};

export type RateLimiterBinding = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

export type AiSearchInstance = {
  info(): Promise<Record<string, unknown>>;
  search(input: Record<string, unknown>): Promise<unknown>;
  items: {
    upload(name: string, content: string | ArrayBuffer): Promise<unknown>;
    uploadAndPoll(name: string, content: string | ArrayBuffer): Promise<unknown>;
  };
};

export type AiSearchNamespace = {
  get(name: string): AiSearchInstance;
  list(): Promise<unknown>;
  create(input: Record<string, unknown>): Promise<AiSearchInstance>;
};

export type QueueBinding<T> = {
  send(message: T): Promise<void>;
  sendBatch(messages: Array<{ body: T }>): Promise<void>;
};

export type PushPayload = {
  eventId: string;
  title: string;
  body: string;
  url: string;
  tag: string;
  image?: string;
  topic: string;
  ttlSeconds: number;
};

export type PushDeliveryJob = {
  subscriptionKey: string;
  token: string;
  payload: PushPayload;
  attempt: number;
};

export type PushSubscriptionRecord = {
  token: string;
  topics: string[];
  origin: string;
  language: string;
  timezone: string;
  userAgent: string;
  createdAt: string;
  updatedAt: string;
};

export interface Env {
  AI: AiBinding;
  AI_SEARCH: AiSearchNamespace;
  VECTORIZE: VectorizeBinding;
  EDGE_STATE: KVNamespace;
  MAP_ARCHIVE?: R2Bucket;
  EDGE_RATE_LIMITER: RateLimiterBinding;
  AI_BUDGET: DurableObjectNamespace;
  PUSH_QUEUE: QueueBinding<PushDeliveryJob>;
  ALLOWED_ORIGINS?: string;
  UPSTREAM_ORIGIN?: string;
  PUBLIC_UPDATE_URL?: string;
  AI_GATEWAY_ID?: string;
  AI_SEARCH_INSTANCE?: string;
  AI_TEXT_MODEL?: string;
  AI_EMBEDDING_MODEL?: string;
  AI_REQUESTS_PER_MINUTE?: string;
  AI_DAILY_EXECUTION_LIMIT?: string;
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_SERVICE_ACCOUNT_JSON?: string;
  FIREBASE_VAPID_PUBLIC_KEY?: string;
  PUSH_ADMIN_TOKEN?: string;
  CONTROLLER_WEBHOOK_SECRET?: string;
  MAP_ADMIN_TOKEN?: string;
  MAP_OBSERVATION_HMAC_SECRET?: string;
  MAP_DATA_INDEX_ZOOM?: string;
  MAP_PUBLIC_CACHE_SECONDS?: string;
  MAP_OBSERVATION_RETENTION_DAYS?: string;
}

export type ApiContext = {
  request: Request;
  env: Env;
  execution: ExecutionContext;
};

export type SearchSource = {
  title: string;
  text: string;
  url: string;
  score: number;
  provider: "ai-search" | "vectorize";
};
