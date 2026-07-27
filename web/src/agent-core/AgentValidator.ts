import type { DynamicAgentPlan } from "./AgentPlanSchema";
import type { AgentObservation } from "./AgentState";

export type AgentValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export class AgentValidator {
  validate(plan: DynamicAgentPlan, observations: AgentObservation[], selectedCapabilities: string[]): AgentValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const selected = new Set(selectedCapabilities);
    plan.requiredCapabilities.forEach((capability) => {
      if (!selected.has(capability)) errors.push(`Capability '${capability}' tidak mempunyai skill kompatibel.`);
    });
    const realtimeRuns = observations.filter((item) => item.capability === "query_realtime_state" && item.status === "completed");
    if (!plan.needsRealtimeData && realtimeRuns.length) {
      errors.push("RTDB dijalankan walaupun plan tidak meminta data realtime.");
    }
    observations.filter((item) => item.status === "failed").forEach((item) => {
      warnings.push(`Skill '${item.skillId}' gagal: ${item.limitations.join(" ") || "tanpa rincian"}`);
    });
    return { valid: errors.length === 0, errors, warnings };
  }
}

export const agentValidator = new AgentValidator();
