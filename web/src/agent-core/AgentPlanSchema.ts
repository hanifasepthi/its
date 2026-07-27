import type { ModelTask } from "../ai-runtime/ModelTaskTypes";

export type AgentEntity = {
  text: string;
  type: string;
  resolvedId?: string;
  attributes?: Record<string, unknown>;
};

export type AgentGoal = {
  id: string;
  description: string;
  successCriteria: string[];
};

export type AgentPlanStep = {
  id: string;
  capability: string;
  dependsOn: string[];
  inputFrom: string[];
  canRunInParallel: boolean;
};

export type AgentRequestedAction = {
  type: string;
  target?: string;
  parameters?: Record<string, unknown>;
};

export type AgentDomainProfile = {
  domain: string;
  subdomains: string[];
  requiredSourceTypes: string[];
  requiredCapabilities: string[];
};

export type DynamicAgentPlan = {
  intent: string;
  domains: string[];
  entities: AgentEntity[];
  goals: AgentGoal[];
  requiredCapabilities: string[];
  steps: AgentPlanStep[];
  requestedActions: AgentRequestedAction[];
  needsRealtimeData: boolean;
  needsLocation: boolean;
  needsFreshSearch: boolean;
  confidence: number;
  domainProfile?: AgentDomainProfile;
  preferredModelTasks: ModelTask[];
};

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isEntity(value: unknown): value is AgentEntity {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.text === "string" && typeof item.type === "string";
}

function isGoal(value: unknown): value is AgentGoal {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string"
    && typeof item.description === "string"
    && stringArray(item.successCriteria);
}

function isStep(value: unknown): value is AgentPlanStep {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string"
    && typeof item.capability === "string"
    && stringArray(item.dependsOn)
    && stringArray(item.inputFrom)
    && typeof item.canRunInParallel === "boolean";
}

function isAction(value: unknown): value is AgentRequestedAction {
  if (!value || typeof value !== "object") return false;
  return typeof (value as Record<string, unknown>).type === "string";
}

export function isDynamicAgentPlan(value: unknown): value is DynamicAgentPlan {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.intent === "string"
    && stringArray(item.domains)
    && Array.isArray(item.entities) && item.entities.every(isEntity)
    && Array.isArray(item.goals) && item.goals.every(isGoal)
    && stringArray(item.requiredCapabilities)
    && Array.isArray(item.steps) && item.steps.every(isStep)
    && Array.isArray(item.requestedActions) && item.requestedActions.every(isAction)
    && typeof item.needsRealtimeData === "boolean"
    && typeof item.needsLocation === "boolean"
    && typeof item.needsFreshSearch === "boolean"
    && Number.isFinite(Number(item.confidence))
    && stringArray(item.preferredModelTasks);
}

function uniqueStrings(values: string[], maximum: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, maximum);
}

export function sanitizeDynamicAgentPlan(value: DynamicAgentPlan): DynamicAgentPlan {
  const capabilities = uniqueStrings(value.requiredCapabilities, 32);
  const steps = value.steps
    .filter((step) => step.id.trim() && step.capability.trim())
    .map((step) => ({
      ...step,
      id: step.id.trim(),
      capability: step.capability.trim(),
      dependsOn: uniqueStrings(step.dependsOn, 16),
      inputFrom: uniqueStrings(step.inputFrom, 16),
    }))
    .slice(0, 48);
  return {
    ...value,
    intent: value.intent.trim() || "understand-and-respond",
    domains: uniqueStrings(value.domains, 16),
    entities: value.entities.slice(0, 32).map((entity) => ({
      ...entity,
      text: entity.text.trim(),
      type: entity.type.trim() || "unresolved",
    })).filter((entity) => entity.text),
    goals: value.goals.slice(0, 16).map((goal) => ({
      ...goal,
      id: goal.id.trim(),
      description: goal.description.trim(),
      successCriteria: uniqueStrings(goal.successCriteria, 12),
    })).filter((goal) => goal.id && goal.description),
    requiredCapabilities: capabilities,
    steps,
    requestedActions: value.requestedActions.slice(0, 16).map((action) => ({
      ...action,
      type: action.type.trim(),
      target: action.target?.trim() || undefined,
    })).filter((action) => action.type),
    confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
    preferredModelTasks: [...new Set(value.preferredModelTasks)].slice(0, 16),
  };
}
