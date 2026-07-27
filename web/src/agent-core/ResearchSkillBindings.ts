import { researchOrchestrator } from "../research/ResearchOrchestrator";
import { researchPlanFromAgentPlan, type ResearchResult } from "../research/ResearchTypes";
import { agentOrchestrator } from "./AgentOrchestrator";
import type { SkillExecutionContext, SkillResult } from "./SkillRegistry";

const RESEARCH_CAPABILITIES = [
  "search_public_sources",
  "search_scientific_sources",
  "discover_official_source",
  "read_public_html",
  "read_open_pdf",
  "extract_document_blocks",
  "fetch_open_media",
  "perform_document_qa",
  "create_embeddings",
  "rerank_results",
  "compare_evidence",
  "detect_contradictions",
  "audit_citations",
] as const;

const RESULT_KEY = "research-result";
const PROMISE_KEY = "research-result-promise";
let installed = false;

async function executeResearch(context: SkillExecutionContext): Promise<SkillResult> {
  let result = context.blackboard.get<ResearchResult>(RESULT_KEY);
  if (!result) {
    let pending = context.blackboard.get<Promise<ResearchResult>>(PROMISE_KEY);
    if (!pending) {
      const plan = researchPlanFromAgentPlan(context.plan, context.question);
      pending = researchOrchestrator.run({
        question: context.question,
        history: context.history,
        plan,
        signal: context.signal,
        activitySessionId: context.state.sessionId,
        manageActivitySession: false,
      });
      context.blackboard.set(PROMISE_KEY, pending);
    }
    result = await pending;
    context.blackboard.set(RESULT_KEY, result);
    context.blackboard.set(PROMISE_KEY, null);
    context.blackboard.set("response-text", result.text);
    context.blackboard.set("response-html", result.html);
    result.evidence.forEach((item) => context.blackboard.addEvidence({
      id: item.id,
      sourceId: item.sourceId,
      kind: item.type,
      value: item,
      confidence: item.score,
      createdAt: item.savedAt,
    }));
    result.answer.sections.flatMap((section) => section.paragraphs).forEach((paragraph, index) => {
      context.blackboard.addClaim({
        id: `research-claim-${index + 1}`,
        text: paragraph.text,
        evidenceIds: paragraph.evidenceIds,
        state: paragraph.evidenceIds.length ? "supported" : "rejected",
      });
    });
  }
  return {
    status: "completed",
    output: {
      capability: context.step.capability,
      sourceCount: result.sources.length,
      evidenceCount: result.evidence.length,
      citedSourceCount: result.bibliography.length,
      supportRatio: result.answer.supportRatio,
    },
    limitations: result.answer.limitations,
  };
}

export function installResearchSkillBindings(): void {
  if (installed) return;
  installed = true;
  RESEARCH_CAPABILITIES.forEach((capability) => {
    agentOrchestrator.registerCapabilityAdapter(capability, executeResearch);
  });
}
