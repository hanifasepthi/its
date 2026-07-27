export type BlackboardEvidence = {
  id: string;
  sourceId: string;
  kind: string;
  value: unknown;
  confidence: number;
  createdAt: number;
};

export type BlackboardClaim = {
  id: string;
  text: string;
  evidenceIds: string[];
  state: "draft" | "supported" | "conflicted" | "rejected";
};

export class EvidenceBlackboard {
  private values = new Map<string, unknown>();
  private evidence = new Map<string, BlackboardEvidence>();
  private claims = new Map<string, BlackboardClaim>();
  private revision = 0;

  set(key: string, value: unknown): void {
    this.values.set(key, value);
    this.revision += 1;
  }

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  addEvidence(value: BlackboardEvidence): void {
    this.evidence.set(value.id, value);
    this.revision += 1;
  }

  addClaim(value: BlackboardClaim): void {
    this.claims.set(value.id, value);
    this.revision += 1;
  }

  snapshot(): { revision: number; values: Record<string, unknown>; evidence: BlackboardEvidence[]; claims: BlackboardClaim[] } {
    return {
      revision: this.revision,
      values: Object.fromEntries(this.values),
      evidence: [...this.evidence.values()],
      claims: [...this.claims.values()],
    };
  }
}
