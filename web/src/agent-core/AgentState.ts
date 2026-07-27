import type { AgentActivityEvent } from "../agentLiveActivity";
import type { DynamicAgentPlan } from "./AgentPlanSchema";

export type AgentStepStatus = "pending" | "running" | "completed" | "skipped" | "failed";

export type AgentObservation = {
  id: string;
  skillId: string;
  capability: string;
  status: Exclude<AgentStepStatus, "pending" | "running">;
  output?: unknown;
  limitations: string[];
  startedAt: number;
  completedAt: number;
};

export type AgentExecutionState = {
  sessionId: string;
  question: string;
  plan: DynamicAgentPlan;
  iteration: number;
  stepStatus: Record<string, AgentStepStatus>;
  observations: AgentObservation[];
  events: AgentActivityEvent[];
  responseText: string;
  responseHtml?: string;
  completed: boolean;
};

export type AgentExecutionResult = AgentExecutionState & {
  outputs: Record<string, unknown>;
  validation: {
    valid: boolean;
    errors: string[];
    warnings: string[];
  };
};
