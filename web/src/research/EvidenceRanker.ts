import type { ResearchContentBlock, ResearchEvidence, ResearchPlan } from "./ResearchTypes";
import { embeddingClient } from "../ai-runtime/EmbeddingClient";
import { entityText, retrievalTokens } from "./ResearchText";

function normalizedTokens(value: string): string[] {
  return retrievalTokens(value);
}

export function lexicalEvidenceScore(query: string, block: ResearchContentBlock): number {
  const requested = new Set(normalizedTokens(query));
  const actual = new Set(normalizedTokens(block.text));
  if (!requested.size || !actual.size) return 0;
  let overlap = 0;
  requested.forEach((token) => { if (actual.has(token)) overlap += 1; });
  let score = overlap / requested.size;
  if (block.type === "heading") score += 0.12;
  if (block.type === "equation" || block.type === "code") score += 0.08;
  if (block.type === "image" && block.imageUrl) score += 0.05;
  if (block.text.length >= 80 && block.text.length <= 2_500) score += 0.08;
  return score;
}

export class EvidenceRanker {
  async rank(
    plan: ResearchPlan,
    evidence: ResearchEvidence[],
    limit = 24,
    onProgress?: (message: string, progress?: number) => void,
    signal?: AbortSignal,
  ): Promise<ResearchEvidence[]> {
    const query = `${plan.topic} ${(plan.queries || []).join(" ")} ${(plan.entities || []).map(entityText).join(" ")}`;
    const queryTokens = new Set(normalizedTokens(query));
    const lexical = evidence
      .map((item) => {
        const actual = new Set(normalizedTokens(item.text));
        let overlap = 0;
        queryTokens.forEach((token) => { if (actual.has(token)) overlap += 1; });
        return {
          ...item,
          score: item.score + overlap / Math.max(1, queryTokens.size),
        };
      })
      .sort((left, right) => right.score - left.score || left.savedAt - right.savedAt)
      .slice(0, Math.max(limit, 28));
    if (!lexical.length) return [];

    try {
      onProgress?.("Menyiapkan ranking semantik multilingual", 0);
      const excerpts = lexical.map((item) => item.text.replace(/\s+/g, " ").trim().slice(0, 2_400));
      const vectors = await embeddingClient.embed([query.slice(0, 2_400), ...excerpts], {
        signal,
        onProgress,
      });
      const queryVector = vectors[0];
      if (!queryVector) throw new Error("Embedding query kosong.");
      const maxLexical = Math.max(...lexical.map((item) => item.score), 0.0001);
      return lexical
        .map((item, index) => {
          const actual = vectors[index + 1] || [];
          const semantic = actual.reduce((sum, value, vectorIndex) => sum + value * (queryVector[vectorIndex] || 0), 0);
          const semanticNormalized = Math.max(0, Math.min(1, (semantic + 1) / 2));
          const lexicalNormalized = Math.max(0, Math.min(1, item.score / maxLexical));
          return { ...item, score: semanticNormalized * 0.72 + lexicalNormalized * 0.28 };
        })
        .sort((left, right) => right.score - left.score || left.savedAt - right.savedAt)
        .slice(0, limit);
    } catch (error) {
      if (signal?.aborted) throw error;
      onProgress?.("Embedding tidak tersedia; ranking lexical terverifikasi tetap digunakan", 100);
      console.warn("Semantic evidence ranking unavailable:", error);
      return lexical.slice(0, limit);
    }
  }
}

export const evidenceRanker = new EvidenceRanker();
