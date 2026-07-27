import { lexicalEvidenceScore } from "./EvidenceRanker";
import type {
  ResearchContentBlock,
  ResearchEvidence,
  ResearchPlan,
  ResearchSource,
} from "./ResearchTypes";

function evidenceId(sourceId: string, blockId: string): string {
  return `evidence-${sourceId}-${blockId}`.replace(/[^a-z0-9-]/gi, "-").slice(0, 180);
}

export class EvidenceStore {
  private items = new Map<string, ResearchEvidence>();

  readBlock(plan: ResearchPlan, source: ResearchSource, block: ResearchContentBlock): ResearchEvidence | null {
    const query = `${plan.topic} ${plan.queries.join(" ")} ${plan.entities.join(" ")}`;
    const score = lexicalEvidenceScore(query, block);
    const structuralEvidence = block.type === "heading" || block.type === "equation" || block.type === "table" || block.type === "image";
    if (!structuralEvidence && score < 0.035) return null;
    const item: ResearchEvidence = {
      id: evidenceId(source.id, block.id),
      sourceId: source.id,
      blockId: block.id,
      type: block.type,
      text: block.text.slice(0, 5_000),
      page: block.page,
      imageUrl: block.imageUrl,
      score,
      savedAt: Date.now(),
    };
    this.items.set(item.id, item);
    return item;
  }

  addAbstract(plan: ResearchPlan, source: ResearchSource): ResearchEvidence | null {
    if (!source.abstract) return null;
    return this.readBlock(plan, source, {
      id: `abstract-${source.id}`,
      type: "paragraph",
      text: source.abstract,
      order: 0,
    });
  }

  list(): ResearchEvidence[] {
    return [...this.items.values()];
  }

  hydrate(items: ResearchEvidence[]): void {
    items.forEach((item) => this.items.set(item.id, item));
  }

  clear(): void {
    this.items.clear();
  }
}
