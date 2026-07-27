import { modelResolver } from "../ai-runtime/ModelResolver";
import { isDynamicAgentPlan, sanitizeDynamicAgentPlan, type DynamicAgentPlan } from "./AgentPlanSchema";
import type { AgentObservation } from "./AgentState";

export class AgentReplanner {
  async replan(
    question: string,
    plan: DynamicAgentPlan,
    observations: AgentObservation[],
    availableCapabilities: string[],
    signal?: AbortSignal,
  ): Promise<DynamicAgentPlan> {
    try {
      const model = await modelResolver.resolve("planner");
      const revised = await model.generateStructured(
        [
          {
            role: "system",
            content: "Revise the execution plan from observations. Return a plan only, never the answer. Preserve completed useful work, replace failed capability paths, and use only availableCapabilities. Return JSON only.",
          },
          {
            role: "user",
            content: JSON.stringify({ question, plan, observations, availableCapabilities }),
          },
        ],
        isDynamicAgentPlan,
        { maxNewTokens: 900, temperature: 0, doSample: false, timeoutMs: 120_000, signal },
      );
      const allowed = new Set(availableCapabilities);
      const clean = sanitizeDynamicAgentPlan(revised);
      return {
        ...clean,
        requiredCapabilities: clean.requiredCapabilities.filter((capability) => allowed.has(capability)),
        steps: clean.steps.filter((step) => allowed.has(step.capability)),
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      console.warn("[ITS Agent] Replanner unavailable; current plan retained", error);
      return plan;
    }
  }
}

export const agentReplanner = new AgentReplanner();
