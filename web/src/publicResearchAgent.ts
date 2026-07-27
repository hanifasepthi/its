import { agentLiveActivity } from "./agentLiveActivity";
import { installResearchSkillBindings } from "./agent-core/ResearchSkillBindings";
import { modelResolver } from "./ai-runtime/ModelResolver";
import { researchOrchestrator } from "./research/ResearchOrchestrator";
import type {
  ResearchPlan,
  ResearchResult,
  ResearchSource,
  ResearchTurn,
} from "./research/ResearchTypes";

export type PublicResearchMode = string;
export type PublicResearchTurn = ResearchTurn;
export type PublicResearchSource = ResearchSource;

export type PublicResearchImage = {
  title: string;
  imageUrl: string;
  thumbUrl: string;
  pageUrl: string;
  author: string;
  license: string;
  description: string;
};

export type PublicResearchPlan = ResearchPlan;

export type PublicResearchAnswer = {
  text: string;
  html: string;
  mode: PublicResearchMode;
  sources: PublicResearchSource[];
  images: PublicResearchImage[];
  plan: PublicResearchPlan;
  result: ResearchResult;
};

type PublicResearchOptions = {
  question: string;
  history?: PublicResearchTurn[];
  plan?: PublicResearchPlan;
  signal?: AbortSignal;
  onProgress?: (message: string, progress?: number) => void;
};

export type PublicResearchWebMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  execute: (input: Record<string, unknown>) => unknown | Promise<unknown>;
};

function imagesForResult(result: ResearchResult): PublicResearchImage[] {
  const sourceById = new Map(result.sources.map((source) => [source.id, source]));
  return result.evidence.filter((item) => item.imageUrl && result.answer.usedEvidenceIds.includes(item.id)).map((item) => {
    const source = sourceById.get(item.sourceId);
    return {
      title: item.text,
      imageUrl: item.imageUrl || "",
      thumbUrl: item.imageUrl || "",
      pageUrl: source?.imageSourceUrl || source?.url || "",
      author: source?.authors.join(", ") || source?.provider || "",
      license: source?.license || "",
      description: item.text,
    };
  });
}

function historyFromInput(value: unknown): PublicResearchTurn[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => item as Record<string, unknown>).filter((item) =>
    (item.role === "user" || item.role === "assistant") && typeof item.content === "string",
  ).map((item) => ({ role: item.role as "user" | "assistant", content: String(item.content) }));
}

class ClientPublicResearchAgent {
  planQuestion(
    question: string,
    history: PublicResearchTurn[] = [],
    signal?: AbortSignal,
    onProgress?: (message: string, progress?: number) => void,
    applicationState?: Record<string, unknown>,
  ): Promise<ResearchPlan> {
    return researchOrchestrator.planQuestion(question, history, signal, onProgress, applicationState);
  }

  async answer(options: PublicResearchOptions): Promise<PublicResearchAnswer> {
    const result = await researchOrchestrator.run(options);
    return {
      text: result.text,
      html: result.html,
      mode: result.plan.intent,
      sources: result.sources,
      images: imagesForResult(result),
      plan: result.plan,
      result,
    };
  }

  getLastState(): ReturnType<typeof researchOrchestrator.getMemory> {
    return researchOrchestrator.getMemory();
  }

  clear(): void {
    researchOrchestrator.clearMemory();
  }

  cancel(): void {
    researchOrchestrator.cancel();
  }

  createWebMcpTools(): PublicResearchWebMcpTool[] {
    return [
      {
        name: "research_its_public_knowledge",
        description: "Plan and run one evidence-grounded ITS Maps research pipeline. It searches public metadata, reads only accessible HTML/PDF blocks, synthesizes with a local model, validates citations, and lists only sources actually cited.",
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string", description: "Complete user question or follow-up." },
            history: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["user", "assistant"] },
                  content: { type: "string" },
                },
                required: ["role", "content"],
              },
            },
          },
          required: ["question"],
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: async (input) => {
          const result = await this.answer({
            question: String(input.question || ""),
            history: historyFromInput(input.history),
          });
          return {
            content: [{ type: "text", text: result.text }],
            structuredContent: {
              plan: result.plan,
              answer: result.result.answer,
              bibliography: result.result.bibliography,
              otherSources: result.result.otherSources,
              documents: result.result.documents.map((documentNode) => ({
                sourceId: documentNode.sourceId,
                status: documentNode.status,
                blockCount: documentNode.blocks.length,
                coverage: documentNode.coverage || null,
                limitation: documentNode.limitation,
              })),
            },
          };
        },
      },
      {
        name: "plan_its_public_research",
        description: "Use the same local planner as ITS chat and return its validated research/realtime/tool plan without starting retrieval.",
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string" },
            history: { type: "array", items: { type: "object" } },
          },
          required: ["question"],
        },
        annotations: { readOnlyHint: true },
        execute: async (input) => {
          const plan = await this.planQuestion(String(input.question || ""), historyFromInput(input.history));
          return {
            content: [{ type: "text", text: JSON.stringify(plan, null, 2) }],
            structuredContent: plan,
          };
        },
      },
      {
        name: "read_its_public_url",
        description: "Read and explain one public URL through the single ITS ResearchOrchestrator. CORS, authentication, robots, or paywall restrictions are reported as blocked; page content is never invented.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "Public HTTP or HTTPS URL." },
            question: { type: "string", description: "Optional question about the page." },
          },
          required: ["url"],
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: async (input) => {
          const url = String(input.url || "").trim();
          const question = String(input.question || "").trim() || "Jelaskan isi halaman ini berdasarkan blok yang benar-benar dapat dibaca.";
          const result = await this.answer({ question: `${question}\n${url}` });
          return {
            content: [{ type: "text", text: result.text }],
            structuredContent: {
              documents: result.result.documents,
              bibliography: result.result.bibliography,
            },
          };
        },
      },
      {
        name: "get_its_live_research_activity",
        description: "Return the current event-sourced research playback with actual search, source, block, PDF, evidence, writing, and validation events.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: async () => ({
          content: [{ type: "text", text: JSON.stringify(agentLiveActivity.snapshot(), null, 2) }],
          structuredContent: {
            sessionId: agentLiveActivity.activeSession(),
            events: agentLiveActivity.snapshot(),
          },
        }),
      },
      {
        name: "get_its_research_diagnostics",
        description: "Return local model selections and timing diagnostics. Model details are exposed here rather than inserted into user answers.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        execute: async () => {
          const diagnostics = modelResolver.getDiagnostics();
          return {
            content: [{ type: "text", text: JSON.stringify(diagnostics, null, 2) }],
            structuredContent: { diagnostics },
          };
        },
      },
      {
        name: "get_its_last_research_context",
        description: "Return the latest client-side research memory for grounded follow-up questions.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        execute: async () => {
          const state = this.getLastState();
          return {
            content: [{ type: "text", text: state ? state.answer.summary : "Belum ada konteks riset." }],
            structuredContent: state,
          };
        },
      },
      {
        name: "clear_its_research_context",
        description: "Clear current client-side research memory and cancel the active research worker.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: false },
        execute: async () => {
          this.cancel();
          this.clear();
          return { content: [{ type: "text", text: "Konteks riset ITS telah dibersihkan." }] };
        },
      },
    ];
  }
}

installResearchSkillBindings();
export const publicResearchAgent = new ClientPublicResearchAgent();
