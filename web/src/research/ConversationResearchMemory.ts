import type { ResearchMemoryState } from "./ResearchTypes";

const MEMORY_KEY = "its-research-memory:v2";
const MEMORY_MAX_AGE = 24 * 60 * 60 * 1000;

export class ConversationResearchMemory {
  load(): ResearchMemoryState | null {
    try {
      const value = JSON.parse(sessionStorage.getItem(MEMORY_KEY) || "null") as ResearchMemoryState | null;
      if (!value || Date.now() - value.updatedAt > MEMORY_MAX_AGE) return null;
      return value;
    } catch {
      return null;
    }
  }

  save(value: ResearchMemoryState): void {
    try {
      const compact: ResearchMemoryState = {
        ...value,
        evidence: value.evidence.slice(-60),
        sources: value.sources.slice(-24),
        figures: value.figures.slice(-12),
      };
      sessionStorage.setItem(MEMORY_KEY, JSON.stringify(compact));
    } catch {
      // The current answer still works when private browsing blocks storage.
    }
  }

  clear(): void {
    try {
      sessionStorage.removeItem(MEMORY_KEY);
    } catch {
      // Nothing else is required.
    }
  }
}

export const conversationResearchMemory = new ConversationResearchMemory();
