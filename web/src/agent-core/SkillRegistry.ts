import type { ModelTask } from "../ai-runtime/ModelTaskTypes";
import type { ResearchActivityPayload, ResearchActivityType } from "../agentLiveActivity";
import type { DynamicAgentPlan, AgentPlanStep } from "./AgentPlanSchema";
import type { AgentExecutionState } from "./AgentState";
import type { EvidenceBlackboard } from "./EvidenceBlackboard";

export type SkillResult = {
  status: "completed" | "skipped" | "failed";
  output?: unknown;
  limitations?: string[];
  needsReplan?: boolean;
};

export type SkillExecutionContext = {
  question: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  plan: DynamicAgentPlan;
  step: AgentPlanStep;
  state: AgentExecutionState;
  blackboard: EvidenceBlackboard;
  signal: AbortSignal;
  emit: (event: { type: ResearchActivityType; title: string; payload?: ResearchActivityPayload }) => void;
};

export type SkillManifest = {
  id: string;
  version: string;
  capabilities: string[];
  modalities: string[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  requiredTools: string[];
  preferredModelTasks: ModelTask[];
  cost: {
    memoryMb: number;
    expectedLatencyMs: number;
    networkRequired: boolean;
  };
  constraints: {
    requiresUserLocation?: boolean;
    requiresRealtimeData?: boolean;
    requiresOpenAccess?: boolean;
  };
  execute: (context: SkillExecutionContext) => Promise<SkillResult>;
};

export class SkillRegistry {
  private manifests = new Map<string, SkillManifest>();

  register(manifest: SkillManifest): void {
    if (!manifest.id.trim()) throw new Error("Skill id tidak boleh kosong.");
    if (this.manifests.has(manifest.id)) throw new Error(`Skill '${manifest.id}' sudah terdaftar.`);
    this.manifests.set(manifest.id, manifest);
  }

  replace(manifest: SkillManifest): void {
    this.manifests.set(manifest.id, manifest);
  }

  get(id: string): SkillManifest | undefined {
    return this.manifests.get(id);
  }

  list(): SkillManifest[] {
    return [...this.manifests.values()];
  }

  supporting(capability: string): SkillManifest[] {
    return this.list().filter((manifest) => manifest.capabilities.includes(capability));
  }
}

export const skillRegistry = new SkillRegistry();
