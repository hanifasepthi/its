import type { DynamicAgentPlan } from "./AgentPlanSchema";

const STORAGE_KEY = "its-dynamic-agent-memory:v1";

export type AgentConversationMemoryState = {
  plan: DynamicAgentPlan;
  entities: DynamicAgentPlan["entities"];
  observations: Array<{ capability: string; output: unknown }>;
  turns: Array<{ role: "user" | "assistant"; content: string }>;
  updatedAt: number;
};

export class AgentConversationMemory {
  load(): AgentConversationMemoryState | null {
    try {
      const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null") as AgentConversationMemoryState | null;
      if (!value?.updatedAt || Date.now() - value.updatedAt > 24 * 60 * 60 * 1_000) return null;
      return value;
    } catch {
      return null;
    }
  }

  save(value: AgentConversationMemoryState): void {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        ...value,
        observations: value.observations.slice(-24),
        turns: value.turns.slice(-16),
        updatedAt: Date.now(),
      }));
    } catch {
      // Memory is optional when storage is unavailable.
    }
  }

  clear(): void {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* Storage may be blocked. */ }
  }
}

export const agentConversationMemory = new AgentConversationMemory();
