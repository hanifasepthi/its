import type { ModelTask } from "../ai-runtime/ModelTaskTypes";
import {
  isDynamicAgentPlan,
  type DynamicAgentPlan,
} from "../agent-core/AgentPlanSchema";

export type ResearchIntent = string;

export type ResearchFollowUpType = string;

export type ResearchQueryKind =
  | "broad"
  | "exact"
  | "official"
  | "open-access"
  | "document"
  | "image"
  | "comparison";

export type ResearchQuerySpec = {
  id: string;
  kind: ResearchQueryKind;
  text: string;
  sourceTypes: string[];
};

export type ResearchPlan = DynamicAgentPlan & {
  needsRealtime: boolean;
  needsResearch: boolean;
  needsPdf: boolean;
  needsImages: boolean;
  needsFormulaDerivation: boolean;
  needsFreshSearch: boolean;
  followUpType: ResearchFollowUpType;
  topic: string;
  queries: string[];
  querySpecs: ResearchQuerySpec[];
  requiredTools: ModelTask[];
  confidence: number;
};

export function researchPlanFromAgentPlan(plan: DynamicAgentPlan, question: string): ResearchPlan {
  const capabilities = new Set(plan.requiredCapabilities);
  const needsResearch = [
    "search_public_sources",
    "search_scientific_sources",
    "discover_official_source",
    "read_public_html",
    "read_open_pdf",
    "extract_document_blocks",
    "fetch_open_media",
    "analyse_image",
    "perform_document_qa",
    "create_embeddings",
    "rerank_results",
    "compare_evidence",
    "detect_contradictions",
    "audit_citations",
  ].some((capability) => capabilities.has(capability));
  const topic = plan.goals[0]?.description || plan.entities.map((entity) => entity.text).join(" ") || question.trim();
  return {
    ...plan,
    needsRealtime: plan.needsRealtimeData,
    needsResearch,
    needsPdf: capabilities.has("read_open_pdf") || capabilities.has("perform_document_qa"),
    needsImages: capabilities.has("fetch_open_media") || capabilities.has("analyse_image") || capabilities.has("perform_ocr"),
    needsFormulaDerivation: plan.domainProfile?.requiredCapabilities.some((capability) => /equation|formula|deriv/i.test(capability)) || false,
    followUpType: capabilities.has("resolve_conversation_reference") ? "runtime-reference-resolution" : "none",
    topic,
    queries: [],
    querySpecs: [],
    requiredTools: plan.preferredModelTasks,
  };
}

export type ResearchSourceStatus =
  | "metadata-only"
  | "abstract"
  | "full-text"
  | "pdf"
  | "blocked"
  | "failed";

export type ResearchContentBlock = {
  id: string;
  type:
    | "heading"
    | "paragraph"
    | "list"
    | "code"
    | "equation"
    | "table"
    | "image";
  text: string;
  html?: string;
  imageUrl?: string;
  alt?: string;
  page?: number;
  order: number;
  boundingBox?: [number, number, number, number];
};

export type ResearchSource = {
  id: string;
  provider: string;
  title: string;
  authors: string[];
  year: string;
  venue: string;
  doi: string;
  url: string;
  pdfUrl: string;
  abstract: string;
  citationCount: number;
  license: string;
  imageUrl: string;
  imageSourceUrl: string;
  status: ResearchSourceStatus;
  accessNote: string;
  score: number;
  retrievedAt: number;
};

export type PdfReadCoverage = {
  totalPages: number;
  renderedPages: number[];
  textReadPages: number[];
  visuallyAnalysedPages: number[];
  skippedPages: number[];
  failedPages: number[];
};

export type ResearchDocument = {
  sourceId: string;
  title: string;
  url: string;
  status: ResearchSourceStatus;
  blocks: ResearchContentBlock[];
  coverage?: PdfReadCoverage;
  limitation: string;
};

export type ResearchEvidence = {
  id: string;
  sourceId: string;
  blockId: string;
  type: ResearchContentBlock["type"];
  text: string;
  page?: number;
  imageUrl?: string;
  score: number;
  savedAt: number;
};

export type GroundedParagraph = {
  text: string;
  evidenceIds: string[];
};

export type GroundedSection = {
  heading: string;
  paragraphs: GroundedParagraph[];
};

export type GroundedFormulaStep = {
  title: string;
  latex: string;
  explanation: string;
  evidenceIds: string[];
  sourcePage?: number;
};

export type GroundedAnswer = {
  summary: string;
  sections: GroundedSection[];
  formulaSteps: GroundedFormulaStep[];
  limitations: string[];
  usedEvidenceIds: string[];
};

export type ValidatedGroundedAnswer = GroundedAnswer & {
  supportRatio: number;
  citedSourceIds: string[];
};

export type ResearchTurn = {
  role: "user" | "assistant";
  content: string;
};

export type ResearchMemoryState = {
  topic: string;
  plan: ResearchPlan;
  evidence: ResearchEvidence[];
  usedEvidenceIds: string[];
  formulaSymbols: string[];
  figures: ResearchContentBlock[];
  sources: ResearchSource[];
  answer: ValidatedGroundedAnswer;
  updatedAt: number;
};

export type ResearchProgress = {
  message: string;
  progress?: number;
};

export type ResearchRunOptions = {
  question: string;
  history?: ResearchTurn[];
  plan?: ResearchPlan;
  signal?: AbortSignal;
  onProgress?: (message: string, progress?: number) => void;
  activitySessionId?: string;
  manageActivitySession?: boolean;
};

export type ResearchResult = {
  text: string;
  html: string;
  plan: ResearchPlan;
  answer: ValidatedGroundedAnswer;
  sources: ResearchSource[];
  bibliography: ResearchSource[];
  otherSources: ResearchSource[];
  evidence: ResearchEvidence[];
  documents: ResearchDocument[];
};

export function isResearchPlan(value: unknown): value is ResearchPlan {
  if (!isDynamicAgentPlan(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.needsRealtime === "boolean"
    && typeof item.needsResearch === "boolean"
    && typeof item.needsPdf === "boolean"
    && typeof item.needsImages === "boolean"
    && typeof item.needsFormulaDerivation === "boolean"
    && typeof item.needsFreshSearch === "boolean"
    && typeof item.followUpType === "string"
    && typeof item.topic === "string"
    && Array.isArray(item.queries) && item.queries.every((entry) => typeof entry === "string")
    && Array.isArray(item.querySpecs)
    && Array.isArray(item.requiredTools) && item.requiredTools.every((entry) => typeof entry === "string")
    && Number.isFinite(Number(item.confidence));
}

export function isGroundedAnswer(value: unknown): value is GroundedAnswer {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (typeof item.summary !== "string" || !Array.isArray(item.sections) || !Array.isArray(item.formulaSteps)
    || !Array.isArray(item.limitations) || !Array.isArray(item.usedEvidenceIds)) return false;
  const sectionsValid = item.sections.every((section) => {
    if (!section || typeof section !== "object") return false;
    const valueSection = section as Record<string, unknown>;
    return typeof valueSection.heading === "string" && Array.isArray(valueSection.paragraphs)
      && valueSection.paragraphs.every((paragraph) => {
        if (!paragraph || typeof paragraph !== "object") return false;
        const valueParagraph = paragraph as Record<string, unknown>;
        return typeof valueParagraph.text === "string" && Array.isArray(valueParagraph.evidenceIds)
          && valueParagraph.evidenceIds.every((id) => typeof id === "string");
      });
  });
  const formulaValid = item.formulaSteps.every((step) => {
    if (!step || typeof step !== "object") return false;
    const valueStep = step as Record<string, unknown>;
    return typeof valueStep.title === "string" && typeof valueStep.latex === "string"
      && typeof valueStep.explanation === "string" && Array.isArray(valueStep.evidenceIds)
      && valueStep.evidenceIds.every((id) => typeof id === "string");
  });
  return sectionsValid && formulaValid
    && item.limitations.every((entry) => typeof entry === "string")
    && item.usedEvidenceIds.every((entry) => typeof entry === "string");
}
