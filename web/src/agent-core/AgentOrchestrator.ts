import { agentLiveActivity } from "../agentLiveActivity";
import { modelResolver } from "../ai-runtime/ModelResolver";
import { agentConversationMemory } from "./ConversationMemory";
import { capabilityGraph } from "./CapabilityGraph";
import { EvidenceBlackboard } from "./EvidenceBlackboard";
import { executivePlanner, type ExecutivePlannerInput } from "./ExecutivePlanner";
import type { DynamicAgentPlan } from "./AgentPlanSchema";
import type { AgentExecutionResult, AgentExecutionState, AgentObservation } from "./AgentState";
import { agentReplanner } from "./AgentReplanner";
import { agentValidator } from "./AgentValidator";
import { SkillSelector } from "./SkillSelector";
import {
  skillRegistry,
  type SkillExecutionContext,
  type SkillManifest,
  type SkillResult,
} from "./SkillRegistry";

export type AgentCapabilityAdapter = (context: SkillExecutionContext) => Promise<SkillResult>;

export type AgentRunOptions = {
  question: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  plan?: DynamicAgentPlan;
  applicationState?: Record<string, unknown>;
  signal?: AbortSignal;
  onProgress?: (message: string, progress?: number) => void;
};

const GENERIC_CAPABILITIES = [
  "understand_user_input",
  "resolve_conversation_reference",
  "query_realtime_state",
  "resolve_location",
  "search_open_places",
  "query_map_geometry",
  "search_public_sources",
  "search_scientific_sources",
  "discover_official_source",
  "read_public_html",
  "read_open_pdf",
  "extract_document_blocks",
  "fetch_open_media",
  "analyse_image",
  "perform_ocr",
  "perform_document_qa",
  "create_embeddings",
  "rerank_results",
  "resolve_entities",
  "compare_evidence",
  "detect_contradictions",
  "synthesize_grounded_answer",
  "audit_citations",
  "focus_map",
  "open_place",
  "create_route",
] as const;

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function taskFor(capability: string): SkillManifest["preferredModelTasks"] {
  if (capability === "create_embeddings" || capability === "rerank_results") return ["embeddings"];
  if (capability === "perform_ocr") return ["OCR"];
  if (capability === "perform_document_qa") return ["document-question-answering"];
  if (capability === "analyse_image" || capability === "fetch_open_media") return ["image-text-understanding"];
  if (capability === "synthesize_grounded_answer" || capability === "compare_evidence") return ["research-synthesis"];
  return ["planner"];
}

function constraintFor(capability: string): SkillManifest["constraints"] {
  if (capability === "query_realtime_state") return { requiresRealtimeData: true };
  if (capability === "resolve_location" || capability === "search_open_places" || capability === "create_route") {
    return { requiresUserLocation: true };
  }
  if (capability.includes("public") || capability.includes("open_") || capability === "fetch_open_media") {
    return { requiresOpenAccess: true };
  }
  return {};
}

function dependencies(): Array<[string, string[]]> {
  return [
    ["resolve_conversation_reference", ["understand_user_input"]],
    ["query_realtime_state", ["understand_user_input"]],
    ["resolve_location", ["understand_user_input"]],
    ["resolve_entities", ["understand_user_input"]],
    ["search_open_places", ["resolve_entities", "resolve_location"]],
    ["query_map_geometry", ["resolve_entities"]],
    ["search_public_sources", ["resolve_conversation_reference"]],
    ["search_scientific_sources", ["resolve_conversation_reference"]],
    ["discover_official_source", ["resolve_entities"]],
    ["read_public_html", ["search_public_sources"]],
    ["read_open_pdf", ["search_scientific_sources"]],
    ["fetch_open_media", ["search_public_sources"]],
    ["extract_document_blocks", ["read_public_html", "read_open_pdf"]],
    ["analyse_image", ["fetch_open_media"]],
    ["perform_ocr", ["fetch_open_media"]],
    ["perform_document_qa", ["extract_document_blocks"]],
    ["create_embeddings", ["extract_document_blocks"]],
    ["rerank_results", ["create_embeddings"]],
    ["compare_evidence", ["rerank_results"]],
    ["detect_contradictions", ["compare_evidence"]],
    ["synthesize_grounded_answer", ["detect_contradictions"]],
    ["audit_citations", ["synthesize_grounded_answer"]],
    ["focus_map", ["query_map_geometry"]],
    ["open_place", ["search_open_places"]],
    ["create_route", ["search_open_places", "query_map_geometry"]],
  ];
}

function fallbackModelMessages(context: SkillExecutionContext): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "Answer the user naturally in Indonesian.",
        "Use only the supplied observations and application state.",
        "Do not invent facts, sources, measurements, people, places, or citations.",
        "If evidence is insufficient, state the exact limitation and ask one useful clarification.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        question: context.question,
        recentHistory: context.history.slice(-10),
        plan: context.plan,
        blackboard: context.blackboard.snapshot(),
      }),
    },
  ];
}

export class AgentOrchestrator {
  private adapters = new Map<string, AgentCapabilityAdapter>();
  private activeController: AbortController | null = null;
  private readonly selector = new SkillSelector(skillRegistry);

  constructor() {
    this.installGenericSkills();
  }

  registerCapabilityAdapter(capability: string, adapter: AgentCapabilityAdapter): void {
    this.adapters.set(capability, adapter);
  }

  removeCapabilityAdapter(capability: string): void {
    this.adapters.delete(capability);
  }

  availableCapabilities(): string[] {
    return skillRegistry.list().flatMap((manifest) => manifest.capabilities).filter((value, index, values) => values.indexOf(value) === index);
  }

  planQuestion(
    question: string,
    history: AgentRunOptions["history"] = [],
    signal?: AbortSignal,
    onProgress?: AgentRunOptions["onProgress"],
    applicationState?: Record<string, unknown>,
  ): Promise<DynamicAgentPlan> {
    const input: ExecutivePlannerInput = {
      question,
      history,
      availableCapabilities: this.availableCapabilities(),
      applicationState,
      memory: agentConversationMemory.load(),
      signal,
      onProgress,
    };
    return executivePlanner.createPlan(input);
  }

  cancel(): void {
    this.activeController?.abort(new DOMException("Pekerjaan agent dibatalkan pengguna.", "AbortError"));
    this.activeController = null;
  }

  async run(options: AgentRunOptions): Promise<AgentExecutionResult> {
    const question = options.question.trim();
    if (!question) throw new Error("Pertanyaan agent tidak boleh kosong.");
    this.cancel();
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    this.activeController = controller;
    const history = options.history || [];
    const sessionId = agentLiveActivity.start(question);
    const emit: SkillExecutionContext["emit"] = (event) => {
      agentLiveActivity.emit(sessionId, event);
    };
    try {
      let plan = options.plan || await this.planQuestion(question, history, controller.signal, options.onProgress, options.applicationState);
      emit({ type: "question-understood", title: "Pertanyaan dipetakan menjadi tujuan runtime", payload: { detail: plan.intent, progress: 8 } });
      emit({ type: "plan-created", title: "Rencana eksekusi dinamis siap", payload: { detail: JSON.stringify(plan), capabilities: plan.requiredCapabilities, progress: 10 } });
      const blackboard = new EvidenceBlackboard();
      blackboard.set("application-state", options.applicationState || {});
      blackboard.set("question", question);
      const state: AgentExecutionState = {
        sessionId,
        question,
        plan,
        iteration: 0,
        stepStatus: {},
        observations: [],
        events: [],
        responseText: "",
        completed: false,
      };

      let selectedCapabilities: string[] = [];
      for (let iteration = 0; iteration < 3; iteration += 1) {
        state.iteration = iteration;
        state.plan = plan;
        const steps = capabilityGraph.stepsFor(plan);
        const selection = this.selector.select(plan, steps);
        selectedCapabilities = selection.selected.map((item) => item.step.capability);
        selection.selected.forEach((entry) => {
          if (!state.stepStatus[entry.step.id]) state.stepStatus[entry.step.id] = "pending";
          emit({
            type: "skill-selected",
            title: `Skill ${entry.manifest.id} dipilih`,
            payload: { skillId: entry.manifest.id, capability: entry.step.capability, iteration, progress: 12 },
          });
        });
        selection.missing.forEach((capability) => {
          state.observations.push({
            id: uniqueId("observation"),
            skillId: "unavailable",
            capability,
            status: "failed",
            limitations: [`Tidak ada skill yang menyediakan capability '${capability}'.`],
            startedAt: Date.now(),
            completedAt: Date.now(),
          });
        });

        const pending = new Map(selection.selected.map((entry) => [entry.step.id, entry]));
        while (pending.size) {
          if (controller.signal.aborted) throw controller.signal.reason;
          const completedIds = new Set(Object.entries(state.stepStatus).filter(([, status]) => status === "completed" || status === "skipped").map(([id]) => id));
          const completedCapabilities = new Set(state.observations.filter((item) => item.status !== "failed").map((item) => item.capability));
          const ready = [...pending.values()].filter(({ step }) => step.dependsOn.every((dependency) => completedIds.has(dependency) || completedCapabilities.has(dependency)));
          if (!ready.length) {
            pending.forEach(({ step, manifest }) => {
              state.stepStatus[step.id] = "failed";
              state.observations.push({
                id: uniqueId("observation"),
                skillId: manifest.id,
                capability: step.capability,
                status: "failed",
                limitations: ["Dependency skill tidak dapat dipenuhi."],
                startedAt: Date.now(),
                completedAt: Date.now(),
              });
            });
            pending.clear();
            break;
          }
          const parallel = ready.filter((entry) => entry.step.canRunInParallel);
          const batch = parallel.length ? parallel : [ready[0]];
          await Promise.all(batch.map(async ({ step, manifest }) => {
            pending.delete(step.id);
            state.stepStatus[step.id] = "running";
            const startedAt = Date.now();
            emit({ type: "skill-start", title: `Menjalankan ${manifest.id}`, payload: { skillId: manifest.id, capability: step.capability, iteration, progress: 18 } });
            let result: SkillResult;
            try {
              result = await manifest.execute({ question, history, plan, step, state, blackboard, signal: controller.signal, emit });
            } catch (error) {
              result = { status: "failed", limitations: [error instanceof Error ? error.message : String(error)], needsReplan: true };
            }
            state.stepStatus[step.id] = result.status;
            if (result.output !== undefined) blackboard.set(`capability:${step.capability}`, result.output);
            const observation: AgentObservation = {
              id: uniqueId("observation"),
              skillId: manifest.id,
              capability: step.capability,
              status: result.status,
              output: result.output,
              limitations: result.limitations || [],
              startedAt,
              completedAt: Date.now(),
            };
            state.observations.push(observation);
            emit({ type: "skill-complete", title: `${manifest.id}: ${result.status}`, payload: { skillId: manifest.id, capability: step.capability, detail: observation.limitations.join(" "), iteration, progress: 68 } });
          }));
        }

        const needsReplan = state.observations.some((item) => item.status === "failed") && iteration < 2;
        if (!needsReplan) break;
        const revised = await agentReplanner.replan(question, plan, state.observations, this.availableCapabilities(), controller.signal);
        if (JSON.stringify(revised) === JSON.stringify(plan)) break;
        plan = revised;
        emit({ type: "replan-created", title: "Rencana direvisi dari observasi aktual", payload: { detail: JSON.stringify(plan), iteration: iteration + 1, progress: 70 } });
      }

      const validation = agentValidator.validate(plan, state.observations, selectedCapabilities);
      emit({ type: "validation-complete", title: validation.valid ? "Eksekusi tervalidasi" : "Eksekusi memiliki batasan", payload: { validationErrors: validation.errors, detail: validation.warnings.join(" "), progress: 96 } });
      state.responseText = blackboard.get<string>("response-text") || "";
      state.responseHtml = blackboard.get<string>("response-html");
      state.completed = true;
      state.events = agentLiveActivity.snapshot();
      const outputs = blackboard.snapshot().values;
      agentConversationMemory.save({
        plan,
        entities: plan.entities,
        observations: state.observations.map((item) => ({ capability: item.capability, output: item.output })),
        turns: [...history, { role: "user", content: question }, ...(state.responseText ? [{ role: "assistant" as const, content: state.responseText }] : [])],
        updatedAt: Date.now(),
      });
      agentLiveActivity.complete(sessionId, `${state.observations.length} observasi skill; valid=${validation.valid}.`);
      return { ...state, plan, outputs, validation };
    } catch (error) {
      agentLiveActivity.fail(sessionId, error);
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", forwardAbort);
      if (this.activeController === controller) this.activeController = null;
    }
  }

  private installGenericSkills(): void {
    dependencies().forEach(([capability, required]) => capabilityGraph.require(capability, required));
    GENERIC_CAPABILITIES.forEach((capability) => {
      const manifest: SkillManifest = {
        id: capability,
        version: "1.0.0",
        capabilities: [capability],
        modalities: ["text"],
        inputSchema: { type: "object", additionalProperties: true },
        outputSchema: { type: "object", additionalProperties: true },
        requiredTools: [],
        preferredModelTasks: taskFor(capability),
        cost: { memoryMb: 0, expectedLatencyMs: 100, networkRequired: capability.includes("search") || capability.includes("read_") || capability.includes("fetch_") },
        constraints: constraintFor(capability),
        execute: async (context) => {
          if (capability === "understand_user_input") {
            return { status: "completed", output: { question: context.question, intent: context.plan.intent, entities: context.plan.entities } };
          }
          if (capability === "resolve_conversation_reference") {
            return { status: "completed", output: { history: context.history.slice(-12), entities: context.plan.entities } };
          }
          const adapter = this.adapters.get(capability);
          if (adapter) return adapter(context);
          if (capability === "synthesize_grounded_answer") {
            const existing = context.blackboard.get<string>("response-text");
            if (existing) return { status: "completed", output: existing };
            const model = await modelResolver.resolve("follow-up-reasoning");
            context.emit({ type: "model-selected", title: "Model respons lokal dipilih", payload: { modelId: model.selection.candidate.id, capability } });
            const text = await model.generateText(fallbackModelMessages(context), {
              maxNewTokens: 360,
              temperature: 0.25,
              doSample: true,
              timeoutMs: 120_000,
              signal: context.signal,
            });
            context.blackboard.set("response-text", text.trim());
            return { status: "completed", output: text.trim() };
          }
          return { status: "skipped", limitations: [`Adapter capability '${capability}' belum tersedia pada runtime ini.`] };
        },
      };
      skillRegistry.replace(manifest);
    });
  }
}

export const agentOrchestrator = new AgentOrchestrator();
