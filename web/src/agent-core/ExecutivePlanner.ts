import { modelResolver } from "../ai-runtime/ModelResolver";
import type { ModelTask } from "../ai-runtime/ModelTaskTypes";
import {
  isDynamicAgentPlan,
  sanitizeDynamicAgentPlan,
  type DynamicAgentPlan,
} from "./AgentPlanSchema";
import type { AgentConversationMemoryState } from "./ConversationMemory";

const MODEL_TASKS = new Set<ModelTask>([
  "planner",
  "intent-classification",
  "query-generation",
  "research-synthesis",
  "follow-up-reasoning",
  "summarization",
  "embeddings",
  "document-question-answering",
  "image-text-understanding",
  "OCR",
  "object-detection",
]);

export type ExecutivePlannerInput = {
  question: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  availableCapabilities: string[];
  applicationState?: Record<string, unknown>;
  memory?: AgentConversationMemoryState | null;
  signal?: AbortSignal;
  onProgress?: (message: string, progress?: number) => void;
};

function plannerMessages(input: ExecutivePlannerInput): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "You are the executive planner for a dynamic multi-skill application agent.",
        "Return a plan only. Never answer the user's question in this stage.",
        "Infer domains, entities, goals, capabilities, dependencies, actions, realtime needs, location needs, and search freshness at runtime.",
        "Use only capabilities exposed in availableCapabilities. Do not invent domain-specific skill names.",
        "Set needsRealtimeData only for current application telemetry or device state.",
        "Set needsLocation only when the requested result or action genuinely depends on the user's position.",
        "Each requested action must be explicit and limited to this application.",
        "Return exactly one JSON object without markdown.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        question: input.question,
        recentHistory: input.history.slice(-12),
        previousPlan: input.memory?.plan || null,
        previousEntities: input.memory?.entities || [],
        applicationState: input.applicationState || {},
        availableCapabilities: input.availableCapabilities,
        schema: {
          intent: "runtime-generated string",
          domains: ["runtime-generated string"],
          entities: [{ text: "string", type: "string", resolvedId: "optional string", attributes: {} }],
          goals: [{ id: "string", description: "string", successCriteria: ["string"] }],
          requiredCapabilities: ["one value from availableCapabilities"],
          steps: [{ id: "string", capability: "one value from availableCapabilities", dependsOn: ["step id"], inputFrom: ["step id"], canRunInParallel: false }],
          requestedActions: [{ type: "string", target: "optional string", parameters: {} }],
          needsRealtimeData: false,
          needsLocation: false,
          needsFreshSearch: false,
          confidence: 0,
          domainProfile: { domain: "string", subdomains: ["string"], requiredSourceTypes: ["string"], requiredCapabilities: ["string"] },
          preferredModelTasks: ["planner"],
        },
      }),
    },
  ];
}

function isBriefGreeting(question: string): boolean {
  const normalized = question.trim().toLocaleLowerCase().replace(/[!.,?]+$/g, "").trim();
  if (!normalized || normalized.length > 48) return false;
  return /^(?:hai|halo|hello|hi|hey|selamat (?:pagi|siang|sore|malam)|ass?alamualaikum|apa kabar|terima kasih|makasih|thanks)$/.test(normalized);
}

function needsPublicEvidence(question: string): boolean {
  // A factual answer can become stale or be recalled incorrectly even when the
  // user does not explicitly type "search". Research is therefore the default;
  // only short social greetings remain local conversational turns.
  return !isBriefGreeting(question);
}

function publicResearchFallbackPlan(question: string): DynamicAgentPlan {
  const capabilities = [
    "understand_user_input",
    "resolve_conversation_reference",
    "search_public_sources",
    "search_scientific_sources",
    "read_public_html",
    "read_open_pdf",
    "extract_document_blocks",
    "create_embeddings",
    "rerank_results",
    "compare_evidence",
    "detect_contradictions",
    "synthesize_grounded_answer",
    "audit_citations",
  ];
  return {
    intent: "research-public-evidence",
    domains: [],
    entities: [],
    goals: [{
      id: "answer-from-public-evidence",
      description: question.trim(),
      successCriteria: ["Sources are discovered at runtime", "Claims cite evidence that was actually read"],
    }],
    requiredCapabilities: capabilities,
    steps: [],
    requestedActions: [],
    needsRealtimeData: false,
    needsLocation: false,
    needsFreshSearch: true,
    confidence: 0.55,
    domainProfile: {
      domain: "runtime public research",
      subdomains: [],
      requiredSourceTypes: ["peer-reviewed paper", "open access", "scientific work"],
      requiredCapabilities: capabilities,
    },
    preferredModelTasks: ["planner", "query-generation", "embeddings", "research-synthesis"],
  };
}

function genericFallbackPlan(question: string): DynamicAgentPlan {
  if (needsPublicEvidence(question)) return publicResearchFallbackPlan(question);
  return {
    intent: "clarify-or-respond-from-available-context",
    domains: [],
    entities: [],
    goals: [{
      id: "understand-request",
      description: `Understand the current request without inventing unavailable facts: ${question.trim()}`,
      successCriteria: ["User intent is represented", "No unavailable source is claimed"],
    }],
    requiredCapabilities: ["understand_user_input", "resolve_conversation_reference", "synthesize_grounded_answer"],
    steps: [
      { id: "understand", capability: "understand_user_input", dependsOn: [], inputFrom: [], canRunInParallel: false },
      { id: "resolve-context", capability: "resolve_conversation_reference", dependsOn: ["understand"], inputFrom: ["understand"], canRunInParallel: false },
      { id: "respond", capability: "synthesize_grounded_answer", dependsOn: ["resolve-context"], inputFrom: ["resolve-context"], canRunInParallel: false },
    ],
    requestedActions: [],
    needsRealtimeData: false,
    needsLocation: false,
    needsFreshSearch: false,
    confidence: 0,
    preferredModelTasks: ["planner", "follow-up-reasoning"],
  };
}

function explicitPublicSourcePlan(question: string): DynamicAgentPlan | null {
  const urls = [...new Set(question.match(/https?:\/\/[^\s<>"')\]]+/gi) || [])]
    .map((value) => value.replace(/[.,;:!?]+$/, ""));
  if (!urls.length) return null;
  return {
    intent: "read-user-selected-public-source",
    domains: [],
    entities: urls.map((url) => ({ text: url, type: "public-url", resolvedId: url, attributes: { userSelected: true } })),
    goals: [{
      id: "verify-selected-source",
      description: "Read only the public source explicitly selected by the user and report access limitations honestly.",
      successCriteria: ["No unrelated search result is blended in", "Every factual claim is supported by content actually read"],
    }],
    requiredCapabilities: [
      "understand_user_input",
      "resolve_conversation_reference",
      "discover_official_source",
      "read_public_html",
      "extract_document_blocks",
      "synthesize_grounded_answer",
      "audit_citations",
    ],
    steps: [
      { id: "understand", capability: "understand_user_input", dependsOn: [], inputFrom: [], canRunInParallel: false },
      { id: "resolve-context", capability: "resolve_conversation_reference", dependsOn: ["understand"], inputFrom: ["understand"], canRunInParallel: false },
      { id: "discover-selected-source", capability: "discover_official_source", dependsOn: ["resolve-context"], inputFrom: ["resolve-context"], canRunInParallel: false },
      { id: "read-selected-source", capability: "read_public_html", dependsOn: ["discover-selected-source"], inputFrom: ["discover-selected-source"], canRunInParallel: false },
      { id: "extract-selected-source", capability: "extract_document_blocks", dependsOn: ["read-selected-source"], inputFrom: ["read-selected-source"], canRunInParallel: false },
      { id: "synthesize", capability: "synthesize_grounded_answer", dependsOn: ["extract-selected-source"], inputFrom: ["extract-selected-source"], canRunInParallel: false },
      { id: "audit", capability: "audit_citations", dependsOn: ["synthesize"], inputFrom: ["synthesize"], canRunInParallel: false },
    ],
    requestedActions: [],
    needsRealtimeData: false,
    needsLocation: false,
    needsFreshSearch: false,
    confidence: 1,
    domainProfile: {
      domain: "user-selected public source",
      subdomains: [],
      requiredSourceTypes: ["public website"],
      requiredCapabilities: ["read_public_html", "extract_document_blocks", "audit_citations"],
    },
    preferredModelTasks: ["planner", "research-synthesis", "summarization"],
  };
}

function sanitizeModelTasks(plan: DynamicAgentPlan): DynamicAgentPlan {
  return {
    ...plan,
    preferredModelTasks: plan.preferredModelTasks.filter((task): task is ModelTask => MODEL_TASKS.has(task as ModelTask)),
  };
}

export class ExecutivePlanner {
  async createPlan(input: ExecutivePlannerInput): Promise<DynamicAgentPlan> {
    const selectedSourcePlan = explicitPublicSourcePlan(input.question);
    if (selectedSourcePlan) {
      input.onProgress?.("URL publik pilihan pengguna dikenali; memulai pembacaan terverifikasi", 4);
      return selectedSourcePlan;
    }
    if (needsPublicEvidence(input.question)) {
      input.onProgress?.("Permintaan riset publik dikenali; menyiapkan retrieval dinamis", 8);
      return publicResearchFallbackPlan(input.question);
    }
    try {
      input.onProgress?.("Executive planner menyusun tujuan dan capability", 4);
      const model = await modelResolver.resolve("planner");
      const plan = await model.generateStructured(
        plannerMessages(input),
        isDynamicAgentPlan,
        {
          maxNewTokens: 900,
          temperature: 0.1,
          doSample: false,
          timeoutMs: 120_000,
          signal: input.signal,
          onProgress: input.onProgress,
        },
      );
      const allowed = new Set(input.availableCapabilities);
      const sanitized = sanitizeModelTasks(sanitizeDynamicAgentPlan(plan));
      return {
        ...sanitized,
        requiredCapabilities: sanitized.requiredCapabilities.filter((capability) => allowed.has(capability)),
        steps: sanitized.steps.filter((step) => allowed.has(step.capability)),
      };
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason;
      console.warn("[ITS Agent] Executive planner unavailable; generic fallback used", error);
      input.onProgress?.("Planner lokal belum tersedia; memakai fallback netral-domain", 8);
      return genericFallbackPlan(input.question);
    }
  }
}

export const executivePlanner = new ExecutivePlanner();
