import { modelResolver } from "../ai-runtime/ModelResolver";
import { citationAuditor } from "./CitationAuditor";
import { retrievalTokens, technicalAnchors } from "./ResearchText";
import type {
  GroundedAnswer,
  ResearchEvidence,
  ResearchPlan,
  ResearchSource,
  ResearchTurn,
  ValidatedGroundedAnswer,
} from "./ResearchTypes";

type CompactFormula = {
  title: string;
  latex: string;
  explanation: string;
  evidenceIds: string[];
  sourcePage?: number;
};

type CompactSynthesis = {
  answer: string;
  evidenceIds: string[];
  formula: CompactFormula | null;
  limitation: string;
};

type SynthesisEvidencePayload = {
  id: string;
  source: string;
  status: string;
  page: number | null;
  text: string;
};

type SynthesisContext = {
  items: ResearchEvidence[];
  aliases: Map<string, string>;
  payload: SynthesisEvidencePayload[];
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCompactFormula(value: unknown): value is CompactFormula {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.title === "string"
    && typeof item.latex === "string"
    && typeof item.explanation === "string"
    && isStringArray(item.evidenceIds)
    && (item.sourcePage == null || Number.isFinite(Number(item.sourcePage)));
}

function isCompactSynthesis(value: unknown): value is CompactSynthesis {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.answer === "string"
    && isStringArray(item.evidenceIds)
    && (item.formula === null || isCompactFormula(item.formula))
    && typeof item.limitation === "string";
}

function containsAnchor(value: string, anchor: string): boolean {
  const normalizedValue = value.toLocaleLowerCase();
  const normalizedAnchor = anchor.toLocaleLowerCase();
  return normalizedValue.includes(normalizedAnchor)
    || normalizedValue.replace(/[-_.\s]/g, "").includes(normalizedAnchor.replace(/[-_.\s]/g, ""));
}

function normalizedAnchorText(value: string): string {
  return value.toLocaleLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function sourceTitleDefinesAnchor(source: ResearchSource | undefined, anchor: string): boolean {
  const title = source?.title.trim().toLocaleLowerCase() || "";
  const variants = [...new Set([
    anchor.trim().toLocaleLowerCase(),
    anchor.trim().toLocaleLowerCase().replace(/[-_.]+/g, " "),
  ])].filter(Boolean);
  return variants.some((wanted) => title === wanted || title.startsWith(`${wanted}:`));
}

function sourceIntroducesAnchor(source: ResearchSource | undefined, anchor: string): boolean {
  const abstract = normalizedAnchorText(source?.abstract || "").slice(0, 900);
  const wanted = normalizedAnchorText(anchor).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!wanted || !abstract) return false;
  return new RegExp(`(?:we|this (?:paper|work)(?: we)?) (?:present|propose|introduce)[^.!?]{0,180}${wanted}\\b`).test(abstract)
    || new RegExp(`${wanted}\\b[^.!?]{0,100}(?:is|introduces|proposes)`).test(abstract);
}

function evidenceAnchorScore(item: ResearchEvidence, anchor: string, source: ResearchSource | undefined): number {
  const title = normalizedAnchorText(source?.title || "");
  const wanted = normalizedAnchorText(anchor);
  const value = `${source?.title || ""} ${item.text}`;
  const citationWeight = Math.min(180, Math.log10((source?.citationCount || 0) + 1) * 50);
  return (sourceTitleDefinesAnchor(source, anchor) ? 260 : 0)
    + (sourceIntroducesAnchor(source, anchor) ? 180 + citationWeight : 0)
    + (title === wanted || title.startsWith(`${wanted} `) ? 20 : 0)
    + (containsAnchor(source?.title || "", anchor) ? 20 : 0)
    + (containsAnchor(value, anchor) ? 20 : 0)
    + item.score;
}

function synthesisEvidence(
  question: string,
  evidence: ResearchEvidence[],
  sources: ResearchSource[],
): ResearchEvidence[] {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const selected: ResearchEvidence[] = [];
  const selectedIds = new Set<string>();
  const add = (item: ResearchEvidence | undefined) => {
    if (!item || selectedIds.has(item.id)) return;
    selectedIds.add(item.id);
    selected.push(item);
  };
  technicalAnchors(question).slice(0, 4).forEach((anchor) => {
    add([...evidence]
      .filter((item) => containsAnchor(`${sourceById.get(item.sourceId)?.title || ""} ${item.text}`, anchor))
      .sort((left, right) => evidenceAnchorScore(right, anchor, sourceById.get(right.sourceId))
        - evidenceAnchorScore(left, anchor, sourceById.get(left.sourceId)))[0]);
  });
  evidence.forEach((item) => {
    if (selected.length < 6) add(item);
  });
  return selected.slice(0, 6);
}

function buildSynthesisContext(
  question: string,
  evidence: ResearchEvidence[],
  sources: ResearchSource[],
): SynthesisContext {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const items = synthesisEvidence(question, evidence, sources).slice(0, 4);
  const aliases = new Map<string, string>();
  const payload = items.map((item, index): SynthesisEvidencePayload => {
    const source = sourceById.get(item.sourceId);
    const alias = `E${index + 1}`;
    aliases.set(alias, item.id);
    return {
      id: alias,
      source: source?.title || item.sourceId,
      status: source?.status || "metadata-only",
      page: item.page ?? null,
      text: item.text.replace(/\s+/g, " ").trim().slice(0, 450),
    };
  });
  return { items, aliases, payload };
}

function synthesisMessages(
  question: string,
  plan: ResearchPlan,
  history: ResearchTurn[],
  context: SynthesisContext,
): Array<{ role: "system" | "user"; content: string }> {
  const schema = {
    answer: "40-55 Indonesian words grounded only in evidence",
    evidenceIds: ["exact evidence id used by answer"],
    formula: null,
    limitation: "one short evidence limitation or empty string",
  };
  return [
    {
      role: "system",
      content: [
        "Anda menyintesis jawaban riset dari bukti terlampir saja.",
        "Jawab pertanyaan secara langsung dalam 40-55 kata Bahasa Indonesia; jangan menyalin abstrak mentah.",
        "Pertahankan semua nama entitas teknis yang diminta. Untuk perbandingan, jelaskan kedua entitas secara eksplisit.",
        "evidenceIds hanya boleh berisi alias E1, E2, E3, atau E4 yang benar-benar mendukung jawaban.",
        "formula harus null kecuali pengguna meminta rumus dan bukti memuat notasi; bila dipakai, isi title, latex, explanation, evidenceIds, dan sourcePage opsional.",
        "Keluarkan tepat satu objek JSON valid tanpa markdown atau teks tambahan.",
        `Schema: ${JSON.stringify(schema)}`,
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        question,
        intent: plan.intent,
        entities: (plan.entities || []).map((entity) => entity.text),
        recentConversation: history.slice(-2).map((turn) => ({
          role: turn.role,
          content: turn.content.slice(0, 300),
        })),
        evidence: context.payload,
      }),
    },
  ];
}

function plainSynthesisMessages(
  question: string,
  context: SynthesisContext,
): Array<{ role: "system" | "user"; content: string }> {
  const anchors = technicalAnchors(question).slice(0, 4);
  return [
    {
      role: "system",
      content: [
        "Tulis hanya satu paragraf jawaban Bahasa Indonesia, tanpa JSON, judul, daftar, atau kata pembuka.",
        "Gunakan hanya bukti yang diberikan dan jangan menyalin abstrak mentah.",
        "Jawab tepat pertanyaan dalam 40-55 kata.",
        anchors.length ? `Sebutkan semua istilah berikut secara persis: ${anchors.join(", ")}.` : "",
      ].filter(Boolean).join("\n"),
    },
    {
      role: "user",
      content: [
        `PERTANYAAN: ${question}`,
        ...context.payload.map((item) => `${item.id} | ${item.source}\n${item.text}`),
      ].join("\n\n"),
    },
  ];
}

function lexicalEvidenceIds(text: string, evidence: ResearchEvidence[], limit = 3): string[] {
  const query = new Set(retrievalTokens(text));
  const ranked = evidence.map((item) => {
    const words = new Set(retrievalTokens(item.text));
    let overlap = 0;
    query.forEach((word) => { if (words.has(word)) overlap += 1; });
    return { id: item.id, score: overlap / Math.max(1, query.size) };
  }).sort((left, right) => right.score - left.score);
  const matched = ranked.filter((item) => item.score > 0).slice(0, limit).map((item) => item.id);
  return matched.length ? matched : evidence.slice(0, 1).map((item) => item.id);
}

function groundedEvidenceIds(
  ids: string[],
  text: string,
  evidence: ResearchEvidence[],
  aliases: Map<string, string>,
): string[] {
  const available = new Set(evidence.map((item) => item.id));
  const resolved = ids.map((id) => aliases.get(id.toLocaleUpperCase()) || id);
  const valid = [...new Set(resolved)].filter((id) => available.has(id)).slice(0, 4);
  return valid.length ? valid : lexicalEvidenceIds(text, evidence);
}

function firstSentence(value: string): string {
  const sentence = value.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || value.trim();
  return sentence.slice(0, 320);
}

function toGroundedAnswer(
  draft: CompactSynthesis,
  evidence: ResearchEvidence[],
  aliases: Map<string, string>,
): GroundedAnswer {
  const answer = draft.answer.replace(/\s+/g, " ").trim();
  const evidenceIds = groundedEvidenceIds(draft.evidenceIds, answer, evidence, aliases);
  const formulaIds = draft.formula
    ? groundedEvidenceIds(draft.formula.evidenceIds, `${draft.formula.title} ${draft.formula.explanation}`, evidence, aliases)
    : [];
  const formulaSteps = draft.formula ? [{
    title: draft.formula.title.trim(),
    latex: draft.formula.latex.trim(),
    explanation: draft.formula.explanation.trim(),
    evidenceIds: formulaIds,
    sourcePage: draft.formula.sourcePage,
  }].filter((formula) => formula.title && formula.latex && formula.explanation && formula.evidenceIds.length) : [];
  return {
    summary: firstSentence(answer) || "Jawaban dibatasi pada bukti yang berhasil dibaca.",
    sections: answer && evidenceIds.length ? [{
      heading: "Analisis berbasis bukti",
      paragraphs: [{ text: answer, evidenceIds }],
    }] : [],
    formulaSteps,
    limitations: draft.limitation.trim() ? [draft.limitation.trim()] : [],
    usedEvidenceIds: [...new Set([...evidenceIds, ...formulaIds])],
  };
}

function decodedFieldValues(text: string, field: string): string[] {
  const pattern = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "g");
  const values: string[] = [];
  for (const match of text.matchAll(pattern)) {
    try {
      values.push(JSON.parse(`"${match[1]}"`) as string);
    } catch {
      // Ignore only the incomplete streamed field.
    }
  }
  return values.map((value) => value.trim()).filter(Boolean);
}

function recoverStreamedSynthesis(
  text: string,
  evidence: ResearchEvidence[],
  aliases: Map<string, string>,
): CompactSynthesis | null {
  const answer = decodedFieldValues(text, "answer")[0];
  if (!answer) return null;
  const mentioned = [...aliases.entries()].filter(([alias]) => text.includes(alias)).map(([, id]) => id);
  return {
    answer,
    evidenceIds: mentioned.length ? mentioned.slice(0, 4) : lexicalEvidenceIds(answer, evidence),
    formula: null,
    limitation: "Model menyelesaikan teks jawaban, tetapi penutup JSON perlu dipulihkan dan diaudit oleh aplikasi.",
  };
}

function cleanPlainAnswer(value: string): string {
  return value
    .replace(/^```(?:text)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^(?:assistant|jawaban)\s*[:\-]\s*/i, "")
    .split(/\n\s*(?:evidenceids?|sumber|references?)\s*:/i)[0]
    .replace(/\s+/g, " ")
    .trim();
}

function missingTechnicalAnchors(question: string, answer: string): string[] {
  return technicalAnchors(question).filter((anchor) => !containsAnchor(answer, anchor));
}

function assertRequestedEntitiesPresent(question: string, answer: string): void {
  const missing = missingTechnicalAnchors(question, answer);
  if (missing.length) {
    throw new Error(`Sintesis model kehilangan istilah teknis yang diminta: ${missing.join(", ")}`);
  }
}

function sentenceCandidates(value: string): string[] {
  return (value.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 32);
}

function boundedExcerpt(value: string, maximum = 300): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= maximum) return clean;
  const clipped = clean.slice(0, maximum);
  return `${clipped.slice(0, Math.max(0, clipped.lastIndexOf(" "))).trim()}...`;
}

function evidenceSentence(item: ResearchEvidence, question: string, anchor = ""): string {
  const wanted = new Set(retrievalTokens(`${question} ${anchor}`));
  const ranked = sentenceCandidates(item.text).map((sentence, index) => {
    const tokens = new Set(retrievalTokens(sentence));
    let overlap = 0;
    wanted.forEach((token) => { if (tokens.has(token)) overlap += 1; });
    const anchorBonus = anchor && containsAnchor(sentence, anchor) ? 12 : 0;
    return { sentence, score: anchorBonus + overlap - index * 0.01 };
  }).sort((left, right) => right.score - left.score);
  return boundedExcerpt(ranked[0]?.sentence || item.text);
}

function requestedEvidenceAspects(question: string): Array<{ label: string; terms: RegExp }> {
  const requested: Array<{ label: string; terms: RegExp }> = [];
  if (/\b(?:pencocokan|matching|assignment|korespondensi)\b/i.test(question)) {
    requested.push({ label: "Prinsip pencocokan", terms: /\b(?:bipartite|hungarian|matching|assignment|correspondence)\b/i });
  }
  if (/\b(?:keterbatasan|batasan|kelemahan|limitations?|drawbacks?|praktis|practical)\b/i.test(question)) {
    requested.push({ label: "Keterbatasan praktis", terms: /\b(?:limitation|limited|cost|latency|trade[ -]?off|practical|practicality|compute|computational|memory|nms)\b/i });
  }
  return requested;
}

function evidenceForAspect(
  question: string,
  terms: RegExp,
  evidence: ResearchEvidence[],
): { item: ResearchEvidence; sentence: string } | undefined {
  const wanted = new Set(retrievalTokens(question));
  return evidence.flatMap((item) => sentenceCandidates(item.text).map((sentence, index) => {
    const matches = sentence.match(new RegExp(terms.source, `${terms.flags.includes("i") ? "i" : ""}g`))?.length || 0;
    const tokens = new Set(retrievalTokens(sentence));
    let overlap = 0;
    wanted.forEach((token) => { if (tokens.has(token)) overlap += 1; });
    return { item, sentence, matches, score: matches * 20 + overlap + item.score - index * 0.01 };
  }))
    .filter((candidate) => candidate.matches > 0)
    .sort((left, right) => right.score - left.score)[0];
}

function evidenceForAnchor(
  anchor: string,
  evidence: ResearchEvidence[],
  sources: ResearchSource[],
): ResearchEvidence | undefined {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  return [...evidence]
    .filter((item) => containsAnchor(`${sourceById.get(item.sourceId)?.title || ""} ${item.text}`, anchor))
    .sort((left, right) => evidenceAnchorScore(right, anchor, sourceById.get(right.sourceId))
      - evidenceAnchorScore(left, anchor, sourceById.get(left.sourceId)))[0];
}

function auditedExtractiveAnswer(
  question: string,
  evidence: ResearchEvidence[],
  sources: ResearchSource[],
): GroundedAnswer {
  const anchors = technicalAnchors(question).slice(0, 6);
  const selectedIds = new Set<string>();
  const paragraphs: Array<{ text: string; evidenceIds: string[] }> = anchors.map((anchor) => {
    const item = evidenceForAnchor(anchor, evidence, sources);
    if (!item) return null;
    selectedIds.add(item.id);
    const excerpt = evidenceSentence(item, question, anchor);
    return { text: `${anchor}: ${excerpt}`, evidenceIds: [item.id] };
  }).filter((paragraph): paragraph is { text: string; evidenceIds: string[] } => Boolean(paragraph));

  requestedEvidenceAspects(question).forEach((aspect) => {
    const candidate = evidenceForAspect(question, aspect.terms, evidence);
    if (!candidate) return;
    selectedIds.add(candidate.item.id);
    paragraphs.push({
      text: `${aspect.label}: ${boundedExcerpt(candidate.sentence)}`,
      evidenceIds: [candidate.item.id],
    });
  });

  if (!paragraphs.length) {
    evidence.slice(0, 3).forEach((item) => {
      selectedIds.add(item.id);
      paragraphs.push({ text: evidenceSentence(item, question), evidenceIds: [item.id] });
    });
  }
  const named = paragraphs.length && anchors.length
    ? anchors.filter((anchor) => paragraphs.some((paragraph) => containsAnchor(paragraph.text, anchor)))
    : [];
  const summary = named.length > 1
    ? `${named.join(" dan ")} dibandingkan memakai evidence publik yang benar-benar dibaca dan setiap poin dibatasi pada klaim sumber.`
    : paragraphs[0]?.text || "Tidak ada evidence yang cukup untuk menyusun jawaban.";
  return {
    summary,
    sections: paragraphs.length ? [{
      heading: anchors.length > 1 ? "Perbandingan berbasis evidence" : "Sintesis ekstraktif tervalidasi",
      paragraphs,
    }] : [],
    formulaSteps: [],
    limitations: [
      "Pada runtime tanpa WebGPU generatif yang kompatibel, aplikasi memakai ekstraksi kalimat dan audit sitasi agar antarmuka tetap responsif serta tidak menambahkan klaim di luar sumber.",
    ],
    usedEvidenceIds: [...selectedIds],
  };
}

function isGenerationTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /batas waktu|timeout|worker dihentikan/i.test(message);
}

export class GroundedAnswerGenerator {
  async synthesize(
    question: string,
    plan: ResearchPlan,
    evidence: ResearchEvidence[],
    sources: ResearchSource[],
    history: ResearchTurn[],
    onProgress?: (message: string, progress?: number) => void,
    onToken?: (token: string) => void,
    signal?: AbortSignal,
  ): Promise<ValidatedGroundedAnswer> {
    let streamed = "";
    try {
      onProgress?.("Memilih model sintesis lokal yang cocok untuk perangkat", 72);
      const model = await modelResolver.resolve("research-synthesis");
      const context = buildSynthesisContext(question, evidence, sources);
      if (model.selection.device === "wasm") {
        onProgress?.("Runtime WASM memakai sintesis ekstraktif tervalidasi agar peta tetap responsif", 90);
        const extractive = auditedExtractiveAnswer(question, evidence, sources);
        onToken?.(extractive.sections.flatMap((section) => section.paragraphs.map((paragraph) => paragraph.text)).join("\n"));
        return citationAuditor.validateAndRepair(extractive, evidence);
      }
      try {
        const draft = await model.generateStructured(
          synthesisMessages(question, plan, history, context),
          isCompactSynthesis,
          {
            maxNewTokens: plan.needsFormulaDerivation ? 190 : 128,
            temperature: 0.05,
            doSample: false,
            repetitionPenalty: 1.08,
            timeoutMs: 180_000,
            signal,
            onProgress,
            onToken: (token) => { streamed += token; },
          },
        );
        assertRequestedEntitiesPresent(question, draft.answer);
        onToken?.(draft.answer);
        return citationAuditor.validateAndRepair(toGroundedAnswer(draft, evidence, context.aliases), evidence);
      } catch (structuredError) {
        if (signal?.aborted) throw signal.reason;
        console.warn("[ITS Research] Structured synthesis incomplete", structuredError, JSON.stringify({
          streamedLength: streamed.length,
          streamedTail: streamed.slice(-240),
        }));
        const recovered = recoverStreamedSynthesis(streamed, evidence, context.aliases);
        if (recovered && missingTechnicalAnchors(question, recovered.answer).length === 0) {
          onToken?.(recovered.answer);
          onProgress?.("JSON model tidak lengkap; teks model yang utuh sedang diaudit", 90);
          return citationAuditor.validateAndRepair(toGroundedAnswer(recovered, evidence, context.aliases), evidence);
        }
        if (isGenerationTimeout(structuredError)) throw structuredError;
        onProgress?.("Format terstruktur belum valid; model menyusun paragraf biasa", 84);
        let plainStream = "";
        const plain = await model.generateText(plainSynthesisMessages(question, context), {
          maxNewTokens: 96,
          temperature: 0.08,
          doSample: false,
          repetitionPenalty: 1.1,
          timeoutMs: 90_000,
          signal,
          onProgress,
          onToken: (token) => {
            plainStream += token;
            onToken?.(token);
          },
        });
        const answer = cleanPlainAnswer(plain || plainStream);
        if (!answer) throw structuredError;
        assertRequestedEntitiesPresent(question, answer);
        const plainDraft: CompactSynthesis = {
          answer,
          evidenceIds: lexicalEvidenceIds(answer, context.items),
          formula: null,
          limitation: "Sintesis memakai bukti publik yang dapat dibaca oleh browser; akses full text dapat terbatas.",
        };
        return citationAuditor.validateAndRepair(toGroundedAnswer(plainDraft, evidence, context.aliases), evidence);
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      console.warn("[ITS Research] Local synthesis unavailable; using audited evidence fallback", error);
      onProgress?.("Generator lokal tidak kompatibel; sintesis ekstraktif sedang diaudit", 94);
      const extractive = auditedExtractiveAnswer(question, evidence, sources);
      onToken?.(extractive.sections.flatMap((section) => section.paragraphs.map((paragraph) => paragraph.text)).join("\n"));
      return citationAuditor.validateAndRepair(extractive, evidence);
    }
  }
}

export const groundedAnswerGenerator = new GroundedAnswerGenerator();
