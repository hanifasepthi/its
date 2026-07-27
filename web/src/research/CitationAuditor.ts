import type {
  GroundedAnswer,
  GroundedFormulaStep,
  GroundedParagraph,
  ResearchEvidence,
  ResearchSource,
  ValidatedGroundedAnswer,
} from "./ResearchTypes";

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/).filter((token) => token.length > 3));
}

function supportScore(claim: string, evidence: ResearchEvidence[]): number {
  const claimWords = words(claim);
  if (!claimWords.size) return 1;
  const evidenceWords = words(evidence.map((item) => item.text).join(" "));
  let overlap = 0;
  claimWords.forEach((word) => { if (evidenceWords.has(word)) overlap += 1; });
  return overlap / claimWords.size;
}

function validParagraph(
  paragraph: GroundedParagraph,
  evidenceById: Map<string, ResearchEvidence>,
): GroundedParagraph | null {
  const evidenceIds = [...new Set(paragraph.evidenceIds)].filter((id) => evidenceById.has(id));
  if (!paragraph.text.trim() || !evidenceIds.length) return null;
  const supporting = evidenceIds.map((id) => evidenceById.get(id)!).filter(Boolean);
  if (supportScore(paragraph.text, supporting) < 0.08) return null;
  return { text: paragraph.text.trim(), evidenceIds };
}

function validFormula(
  step: GroundedFormulaStep,
  evidenceById: Map<string, ResearchEvidence>,
): GroundedFormulaStep | null {
  const evidenceIds = [...new Set(step.evidenceIds)].filter((id) => evidenceById.has(id));
  if (!step.title.trim() || !step.latex.trim() || !step.explanation.trim() || !evidenceIds.length) return null;
  const supporting = evidenceIds.map((id) => evidenceById.get(id)!).filter(Boolean);
  const hasEquationEvidence = supporting.some((item) => item.type === "equation" || item.type === "code");
  if (!hasEquationEvidence && supportScore(`${step.title} ${step.explanation}`, supporting) < 0.1) return null;
  const page = step.sourcePage || supporting.find((item) => item.page != null)?.page;
  return {
    title: step.title.trim(),
    latex: step.latex.trim(),
    explanation: step.explanation.trim(),
    evidenceIds,
    sourcePage: page,
  };
}

export function assertCitationInvariant(
  citationSourceIds: Set<string>,
  bibliographySourceIds: Set<string>,
): void {
  const cited = [...citationSourceIds].sort();
  const listed = [...bibliographySourceIds].sort();
  if (JSON.stringify(cited) !== JSON.stringify(listed)) {
    throw new Error("Citation and bibliography sources do not match.");
  }
}

export function bibliographyForAnswer(
  answer: ValidatedGroundedAnswer,
  evidence: ResearchEvidence[],
  sources: ResearchSource[],
): ResearchSource[] {
  const usedEvidenceIds = new Set(answer.usedEvidenceIds);
  const citedSourceIds = new Set(
    evidence.filter((item) => usedEvidenceIds.has(item.id)).map((item) => item.sourceId),
  );
  const bibliography = sources.filter((source) => citedSourceIds.has(source.id));
  assertCitationInvariant(citedSourceIds, new Set(bibliography.map((source) => source.id)));
  return bibliography;
}

export class CitationAuditor {
  validateAndRepair(draft: GroundedAnswer, evidence: ResearchEvidence[]): ValidatedGroundedAnswer {
    const evidenceById = new Map(evidence.map((item) => [item.id, item]));
    const sections = draft.sections.map((section) => ({
      heading: section.heading.trim(),
      paragraphs: section.paragraphs
        .map((paragraph) => validParagraph(paragraph, evidenceById))
        .filter((paragraph): paragraph is GroundedParagraph => Boolean(paragraph)),
    })).filter((section) => section.heading && section.paragraphs.length);
    const formulaSteps = draft.formulaSteps
      .map((step) => validFormula(step, evidenceById))
      .filter((step): step is GroundedFormulaStep => Boolean(step));
    const usedEvidenceIds = [...new Set([
      ...sections.flatMap((section) => section.paragraphs.flatMap((paragraph) => paragraph.evidenceIds)),
      ...formulaSteps.flatMap((step) => step.evidenceIds),
    ])];
    const usedEvidence = usedEvidenceIds.map((id) => evidenceById.get(id)!).filter(Boolean);
    const draftSummary = draft.summary.trim();
    const summary = !usedEvidence.length
      ? (draftSummary && !sections.length && !formulaSteps.length
        ? "Tidak ada klaim model yang lolos audit bukti."
        : draftSummary)
      : supportScore(draftSummary, usedEvidence) >= 0.08
        ? draftSummary
        : sections[0]?.paragraphs[0]?.text || formulaSteps[0]?.explanation || "Ringkasan dibatasi pada bukti yang lolos audit.";
    const citedSourceIds = [...new Set(usedEvidenceIds.map((id) => evidenceById.get(id)?.sourceId).filter((id): id is string => Boolean(id)))];
    const originalClaims = draft.sections.reduce((total, section) => total + section.paragraphs.length, 0) + draft.formulaSteps.length;
    const retainedClaims = sections.reduce((total, section) => total + section.paragraphs.length, 0) + formulaSteps.length;
    return {
      summary,
      sections,
      formulaSteps,
      limitations: [...new Set(draft.limitations.map((item) => item.trim()).filter(Boolean))],
      usedEvidenceIds,
      supportRatio: originalClaims ? retainedClaims / originalClaims : 0,
      citedSourceIds,
    };
  }
}

export const citationAuditor = new CitationAuditor();
