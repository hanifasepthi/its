import type { AgentPlanStep, DynamicAgentPlan } from "./AgentPlanSchema";

export class CapabilityGraph {
  private dependencies = new Map<string, Set<string>>();

  require(capability: string, dependencies: string[]): void {
    const current = this.dependencies.get(capability) || new Set<string>();
    dependencies.filter(Boolean).forEach((dependency) => current.add(dependency));
    this.dependencies.set(capability, current);
  }

  expand(capabilities: string[]): string[] {
    const expanded = new Set<string>();
    const visit = (capability: string, stack: Set<string>) => {
      if (expanded.has(capability) || stack.has(capability)) return;
      const nextStack = new Set(stack).add(capability);
      (this.dependencies.get(capability) || []).forEach((dependency) => visit(dependency, nextStack));
      expanded.add(capability);
    };
    capabilities.forEach((capability) => visit(capability, new Set()));
    return [...expanded];
  }

  stepsFor(plan: DynamicAgentPlan): AgentPlanStep[] {
    const supplied = new Map(plan.steps.map((step) => [step.capability, step]));
    const requested = [
      ...plan.requiredCapabilities,
      ...plan.steps.map((step) => step.capability),
      ...plan.steps.flatMap((step) => step.dependsOn.filter((dependency) => this.dependencies.has(dependency))),
    ];
    return this.expand(requested).map((capability, index) => supplied.get(capability) || {
      id: `step-${index + 1}-${capability}`,
      capability,
      dependsOn: [...(this.dependencies.get(capability) || [])],
      inputFrom: [],
      canRunInParallel: false,
    });
  }
}

export const capabilityGraph = new CapabilityGraph();
