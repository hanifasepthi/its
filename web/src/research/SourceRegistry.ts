import type { ResearchQuery } from "./QueryGenerator";
import type { ResearchPlan, ResearchSource } from "./ResearchTypes";

export type SourceProviderContext = {
  question: string;
  plan: ResearchPlan;
  query: ResearchQuery;
  signal?: AbortSignal;
};

export type SourceProviderManifest = {
  id: string;
  label: string;
  capabilities: string[];
  sourceTypes: string[];
  openAccess: boolean;
  priority: number;
  available?: () => boolean;
  search: (context: SourceProviderContext) => Promise<ResearchSource[]>;
};

function normalizedTokens(values: string[]): Set<string> {
  return new Set(values.flatMap((value) => value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u)).filter(Boolean));
}

function overlapScore(provider: SourceProviderManifest, plan: ResearchPlan, query: ResearchQuery): number {
  const requestedCapabilities = new Set(plan.requiredCapabilities);
  const capabilityMatches = provider.capabilities.filter((capability) => requestedCapabilities.has(capability)).length;
  const wantedTypes = normalizedTokens([...(plan.domainProfile?.requiredSourceTypes || []), ...query.sourceTypes]);
  const offeredTypes = normalizedTokens(provider.sourceTypes);
  let typeMatches = 0;
  wantedTypes.forEach((token) => { if (offeredTypes.has(token)) typeMatches += 1; });
  const kindMatches = provider.capabilities.includes(`query:${query.kind}`) ? 2 : 0;
  return provider.priority + capabilityMatches * 5 + typeMatches * 2 + kindMatches;
}

export class SourceRegistry {
  private providers = new Map<string, SourceProviderManifest>();

  register(provider: SourceProviderManifest): void {
    if (!provider.id.trim()) throw new Error("Source provider id tidak boleh kosong.");
    this.providers.set(provider.id, provider);
  }

  get(id: string): SourceProviderManifest | undefined {
    return this.providers.get(id);
  }

  list(): SourceProviderManifest[] {
    return [...this.providers.values()];
  }

  select(plan: ResearchPlan, query: ResearchQuery, maximum = 5): SourceProviderManifest[] {
    return this.list()
      .filter((provider) => provider.available?.() !== false)
      .filter((provider) => !plan.requiredCapabilities.includes("fetch_open_media") || provider.openAccess)
      .map((provider) => ({ provider, score: overlapScore(provider, plan, query) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, maximum)
      .map((entry) => entry.provider);
  }
}

export const sourceRegistry = new SourceRegistry();
