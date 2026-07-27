import type { AgentPlanStep, DynamicAgentPlan } from "./AgentPlanSchema";
import type { SkillManifest } from "./SkillRegistry";
import { SkillRegistry } from "./SkillRegistry";

export type SelectedSkill = {
  step: AgentPlanStep;
  manifest: SkillManifest;
  score: number;
};

function score(manifest: SkillManifest, step: AgentPlanStep, plan: DynamicAgentPlan): number {
  if (!manifest.capabilities.includes(step.capability)) return Number.NEGATIVE_INFINITY;
  if (manifest.constraints.requiresRealtimeData && !plan.needsRealtimeData) return Number.NEGATIVE_INFINITY;
  if (manifest.constraints.requiresUserLocation && !plan.needsLocation) return Number.NEGATIVE_INFINITY;
  let value = 100;
  value -= manifest.cost.expectedLatencyMs / 1_000;
  value -= manifest.cost.memoryMb / 256;
  if (manifest.preferredModelTasks.some((task) => plan.preferredModelTasks.includes(task))) value += 8;
  return value;
}

export class SkillSelector {
  private readonly registry: SkillRegistry;

  constructor(registry: SkillRegistry) {
    this.registry = registry;
  }

  select(plan: DynamicAgentPlan, steps: AgentPlanStep[]): { selected: SelectedSkill[]; missing: string[] } {
    const selected: SelectedSkill[] = [];
    const missing: string[] = [];
    steps.forEach((step) => {
      const ranked = this.registry.supporting(step.capability)
        .map((manifest) => ({ step, manifest, score: score(manifest, step, plan) }))
        .filter((entry) => Number.isFinite(entry.score))
        .sort((left, right) => right.score - left.score);
      if (ranked[0]) selected.push(ranked[0]);
      else missing.push(step.capability);
    });
    return { selected, missing };
  }
}
