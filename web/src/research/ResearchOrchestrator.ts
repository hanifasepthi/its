import { agentLiveActivity, type AgentActivitySource, type PlaybackTab } from "../agentLiveActivity";
import { agentOrchestrator } from "../agent-core/AgentOrchestrator";
import { bibliographyForAnswer } from "./CitationAuditor";
import { conversationResearchMemory } from "./ConversationResearchMemory";
import { EvidenceStore } from "./EvidenceStore";
import { evidenceRanker } from "./EvidenceRanker";
import { groundedAnswerGenerator } from "./GroundedAnswerGenerator";
import { htmlSourceReader } from "./HtmlSourceReader";
import { githubRepositoryReader } from "./GitHubRepositoryReader";
import { pdfSourceReader } from "./PdfSourceReader";
import { queryGenerator } from "./QueryGenerator";
import {
  researchPlanFromAgentPlan,
  type ResearchContentBlock,
  type ResearchDocument,
  type ResearchEvidence,
  type ResearchMemoryState,
  type ResearchPlan,
  type ResearchResult,
  type ResearchRunOptions,
  type ResearchSource,
  type ResearchTurn,
  type ValidatedGroundedAnswer,
} from "./ResearchTypes";
import { sourceAdapter } from "./SourceAdapter";
import { entityText, technicalAnchors } from "./ResearchText";

/** Emergency-only plan used only after the research entry point was selected. */
export function fallbackResearchPlan(
  question: string,
  _history: ResearchTurn[] = [],
  _memory: ResearchMemoryState | null = conversationResearchMemory.load(),
): ResearchPlan {
  return researchPlanFromAgentPlan({
    intent: "research-public-evidence",
    domains: [],
    entities: [],
    goals: [{ id: "research", description: question.trim(), successCriteria: ["Only actually read evidence is cited"] }],
    requiredCapabilities: [
      "understand_user_input",
      "resolve_conversation_reference",
      "search_public_sources",
      "search_scientific_sources",
      "read_public_html",
      "read_open_pdf",
      "extract_document_blocks",
      "create_embeddings",
      "rerank_results",
      "compare_evidence",
      "detect_contradictions",
      "synthesize_grounded_answer",
      "audit_citations",
    ],
    steps: [],
    requestedActions: [],
    needsRealtimeData: false,
    needsLocation: false,
    needsFreshSearch: true,
    confidence: 0.5,
    domainProfile: {
      domain: "runtime public research",
      subdomains: [],
      requiredSourceTypes: ["peer-reviewed paper", "open access", "scientific work"],
      requiredCapabilities: ["search_scientific_sources", "read_open_pdf", "audit_citations"],
    },
    preferredModelTasks: ["planner", "query-generation", "embeddings", "research-synthesis"],
  }, question);
}

function sanitizePlan(value: ResearchPlan, question: string): ResearchPlan {
  const unique = (items: string[], maximum: number) => [...new Set(items.map((item) => item.trim()).filter(Boolean))].slice(0, maximum);
  const querySpecs = (value.querySpecs || []).filter((query) => query.text.trim()).slice(0, 7);
  const queryTexts = unique(value.queries, 7);
  return {
    ...value,
    topic: value.topic.trim() || question.trim(),
    queries: queryTexts.length ? queryTexts : querySpecs.map((query) => query.text),
    querySpecs,
    requiredTools: [...new Set(value.requiredTools)],
    confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
  };
}

async function emitQueryTyping(
  sessionId: string,
  query: string,
  signal: AbortSignal,
): Promise<void> {
  const characters = Array.from(query);
  for (let index = 1; index <= characters.length; index += 1) {
    if (signal.aborted) throw signal.reason;
    agentLiveActivity.emit(sessionId, {
      type: "query-typing",
      title: "Mengetik query sumber publik",
      payload: {
        query: characters.slice(0, index).join(""),
        targetId: "search-query",
        characterIndex: index,
        characterCount: characters.length,
        progress: 12 + Math.round(index / Math.max(1, characters.length) * 4),
      },
    });
    await playbackPause(42 + (index % 4) * 11, signal);
  }
}

async function playbackPause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  // Visual playback must never block the research result when Chromium
  // throttles timers in a background/PWA/headless tab. Every activity event is
  // still recorded; only the cosmetic delay is skipped until the tab is visible.
  const delay = document.visibilityState === "visible" && !navigator.webdriver ? milliseconds : 0;
  await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
  if (signal.aborted) throw signal.reason;
}

function playbackBlocks(
  blocks: ResearchContentBlock[],
  evidenceByBlock: Map<string, ResearchEvidence>,
  limit = 14,
): ResearchContentBlock[] {
  if (blocks.length <= limit) return blocks;
  const selected = new Map<string, ResearchContentBlock>();
  const add = (block: ResearchContentBlock | undefined) => {
    if (block) selected.set(block.id, block);
  };
  blocks
    .filter((block) => block.type !== "paragraph")
    .slice(0, Math.ceil(limit / 3))
    .forEach(add);
  [...evidenceByBlock.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.ceil(limit / 2))
    .forEach((item) => add(blocks.find((block) => block.id === item.blockId)));
  const remaining = Math.max(1, limit - selected.size);
  const stride = Math.max(1, Math.floor(blocks.length / remaining));
  for (let index = 0; index < blocks.length && selected.size < limit; index += stride) add(blocks[index]);
  add(blocks.at(-1));
  return [...selected.values()]
    .sort((left, right) => left.order - right.order)
    .slice(0, limit);
}

function activitySource(source: ResearchSource): AgentActivitySource {
  return {
    id: source.id,
    title: source.title,
    provider: source.provider,
    url: source.url,
    pdfUrl: source.pdfUrl,
    abstract: source.abstract,
    authors: source.authors,
    year: source.year,
    status: source.status,
  };
}

function sourceContainsAnchor(source: ResearchSource, anchor: string, titleOnly = false): boolean {
  const normalizedAnchor = anchor.toLocaleLowerCase().replace(/[-_.\s]/g, "");
  const value = (titleOnly ? source.title : `${source.title} ${source.abstract}`)
    .toLocaleLowerCase()
    .replace(/[-_.\s]/g, "");
  return value.includes(normalizedAnchor);
}

function sourceTitleStartsWithAnchor(source: ResearchSource, anchor: string): boolean {
  const normalize = (value: string) => value.toLocaleLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  const title = normalize(source.title);
  const wanted = normalize(anchor);
  return Boolean(wanted) && (title === wanted || title.startsWith(`${wanted} `));
}

function sourceTitleDefinesAnchor(source: ResearchSource, anchor: string): boolean {
  const title = source.title.trim().toLocaleLowerCase();
  const variants = [...new Set([
    anchor.trim().toLocaleLowerCase(),
    anchor.trim().toLocaleLowerCase().replace(/[-_.]+/g, " "),
  ])].filter(Boolean);
  return variants.some((wanted) => title === wanted || title.startsWith(`${wanted}:`));
}

function sourceIntroducesAnchor(source: ResearchSource, anchor: string): boolean {
  const normalize = (value: string) => value.toLocaleLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  const abstract = normalize(source.abstract).slice(0, 900);
  const wanted = normalize(anchor).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!wanted || !abstract) return false;
  return new RegExp(`(?:we|this (?:paper|work)(?: we)?) (?:present|propose|introduce)[^.!?]{0,180}${wanted}\\b`).test(abstract)
    || new RegExp(`${wanted}\\b[^.!?]{0,100}(?:is|introduces|proposes)`).test(abstract);
}

function primarySourceForAnchor(sources: ResearchSource[], anchor: string): ResearchSource | undefined {
  return sources.find((source) => sourceTitleDefinesAnchor(source, anchor))
    || sources.filter((source) => sourceIntroducesAnchor(source, anchor))
      .sort((left, right) => right.citationCount - left.citationCount)[0]
    || sources.find((source) => sourceTitleStartsWithAnchor(source, anchor))
    || sources.find((source) => sourceContainsAnchor(source, anchor, true))
    || sources.find((source) => sourceContainsAnchor(source, anchor));
}

function sourcesToRead(question: string, plan: ResearchPlan, sources: ResearchSource[]): ResearchSource[] {
  const selected: ResearchSource[] = [];
  const selectedIds = new Set<string>();
  const add = (source: ResearchSource | undefined) => {
    if (!source || selectedIds.has(source.id)) return;
    selectedIds.add(source.id);
    selected.push(source);
  };
  const anchorInput = [
    question,
    ...(plan.queries || []),
    ...(plan.entities || []).map(entityText),
  ].join(" ");
  const needsRepository = /\b(?:github|repository|repo|implementasi|source\s*code|kode sumber)\b/i.test(question);
  const needsMedia = /\b(?:video|watch|youtube|rekaman|putar|transkrip)\b/i.test(question);
  if (needsRepository) {
    const repositoryAnchor = technicalAnchors(anchorInput)[0]?.toLocaleLowerCase() || "";
    sources
      .filter((source) => source.provider === "github")
      .sort((left, right) => {
        const matchScore = (source: ResearchSource) => {
          const title = source.title.toLocaleLowerCase();
          if (!repositoryAnchor) return 0;
          if (title.endsWith(`/${repositoryAnchor}`) || title === repositoryAnchor) return 3;
          if (title.includes(repositoryAnchor)) return 2;
          if (source.abstract.toLocaleLowerCase().includes(repositoryAnchor)) return 1;
          return 0;
        };
        return matchScore(right) - matchScore(left) || right.citationCount - left.citationCount;
      })
      .slice(0, 1)
      .forEach(add);
  }
  if (needsMedia) {
    sources
      .filter((source) => source.provider === "youtube" || source.provider === "internet-archive")
      .slice(0, 3)
      .forEach(add);
  }
  technicalAnchors(anchorInput).slice(0, 6).forEach((anchor) => {
    add(primarySourceForAnchor(sources, anchor));
  });
  sources.forEach((source) => {
    const limit = needsMedia ? 4 : needsRepository ? 6 : 10;
    if (needsRepository && source.provider === "github" && selected.some((item) => item.provider === "github")) return;
    if (needsMedia && (source.provider === "youtube" || source.provider === "internet-archive")
      && selected.filter((item) => item.provider === "youtube" || item.provider === "internet-archive").length >= 3) return;
    if (selected.length < limit) add(source);
  });
  return selected.slice(0, needsMedia ? 4 : needsRepository ? 6 : 10);
}

function searchSurface(plan: ResearchPlan, kind = ""): { searchLabel: string; searchUrl: string } {
  const capabilities = new Set(plan.requiredCapabilities);
  const mode = kind === "image" || capabilities.has("fetch_open_media")
    ? "image"
    : capabilities.has("search_open_places") || capabilities.has("query_map_geometry")
      ? "place"
      : capabilities.has("search_scientific_sources") || capabilities.has("read_open_pdf")
        ? "scholar"
        : kind === "document" || kind === "open-access"
          ? "document"
          : "open";
  const labels: Record<string, string> = {
    image: "ITS Image Search",
    place: "ITS Place Search",
    scholar: "ITS Scholar Search",
    document: "ITS Document Reader",
    open: "ITS Open Search",
  };
  return {
    searchLabel: labels[mode],
    searchUrl: `its-search://${mode}`,
  };
}

function sourceTab(source: ResearchSource, kind: PlaybackTab["kind"]): PlaybackTab {
  return {
    id: source.id,
    kind,
    title: source.title,
    url: kind === "pdf" ? source.pdfUrl : source.url,
    active: true,
    closed: false,
    scrollTop: 0,
  };
}

function abstractDocument(source: ResearchSource): ResearchDocument | null {
  const blocks: ResearchContentBlock[] = [];
  if (source.abstract) {
    blocks.push({
      id: `abstract-${source.id}`,
      type: "paragraph",
      text: source.abstract,
      order: 0,
    });
  }
  if (source.imageUrl) {
    blocks.push({
      id: `image-${source.id}`,
      type: "image",
      text: source.title,
      imageUrl: source.imageUrl,
      alt: source.title,
      order: blocks.length,
    });
  }
  if (!blocks.length) return null;
  return {
    sourceId: source.id,
    title: source.title,
    url: source.url,
    status: source.abstract ? "abstract" : "metadata-only",
    blocks,
    limitation: source.abstract ? "Isi berasal dari abstrak/metadata provider; full text belum dibaca." : "Hanya metadata media yang tersedia.",
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function youtubeEmbedUrl(value: string): string {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const id = /youtu\.be$/i.test(url.hostname)
      ? parts[0]
      : url.pathname === "/watch"
        ? url.searchParams.get("v")
        : ["embed", "shorts", "live"].includes(parts[0] || "")
          ? parts[1]
          : "";
    return id && /^[A-Za-z0-9_-]{6,20}$/.test(id)
      ? `https://www.youtube-nocookie.com/embed/${id}`
      : "";
  } catch {
    return "";
  }
}

function citationIdsFor(
  evidenceIds: string[],
  evidenceById: Map<string, ResearchEvidence>,
  sourceNumber: Map<string, number>,
): number[] {
  return [...new Set(evidenceIds.map((id) => evidenceById.get(id)?.sourceId)
    .map((id) => id ? sourceNumber.get(id) : undefined)
    .filter((value): value is number => value != null))].sort((left, right) => left - right);
}

function renderResult(
  answer: ValidatedGroundedAnswer,
  evidence: ResearchEvidence[],
  bibliography: ResearchSource[],
  otherSources: ResearchSource[],
  documents: ResearchDocument[],
): { text: string; html: string } {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const sourceNumber = new Map(bibliography.map((source, index) => [source.id, index + 1]));
  const citationText = (ids: string[]) => citationIdsFor(ids, evidenceById, sourceNumber).map((number) => `[S${number}]`).join(" ");
  const citationLinks = (ids: string[]) => citationIdsFor(ids, evidenceById, sourceNumber)
    .map((number) => `<a href="#its-ai-reference-${number}" class="its-ai-inline-citation">[S${number}]</a>`).join(" ");
  const summaryCitationText = citationText(answer.usedEvidenceIds);
  const summaryCitationLinks = citationLinks(answer.usedEvidenceIds);
  const textSections = answer.sections.map((section) => [
    section.heading,
    ...section.paragraphs.map((paragraph) => `${paragraph.text} ${citationText(paragraph.evidenceIds)}`.trim()),
  ].join("\n\n"));
  const textFormula = answer.formulaSteps.map((step) => [
    step.title,
    `\\[${step.latex}\\]`,
    `${step.explanation} ${citationText(step.evidenceIds)}`.trim(),
  ].join("\n\n"));
  const referencesText = bibliography.map((source, index) => `[S${index + 1}] ${source.authors.join(", ") || source.venue || source.provider}. "${source.title}." ${source.year || "n.d."}. ${source.doi ? `doi:${source.doi}. ` : ""}${source.url}`);
  const text = [
    `${answer.summary} ${summaryCitationText}`.trim(),
    ...textSections,
    ...textFormula,
    answer.limitations.length ? `Catatan akses sumber\n\n${answer.limitations.join("\n")}` : "",
    referencesText.length ? `Daftar pustaka\n\n${referencesText.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  const sectionsHtml = answer.sections.map((section) => `
    <section class="its-ai-grounded-section">
      <h4>${escapeHtml(section.heading)}</h4>
      ${section.paragraphs.map((paragraph) => {
        const links = citationLinks(paragraph.evidenceIds);
        return `<p>${escapeHtml(paragraph.text)} ${links}</p>`;
      }).join("")}
    </section>`).join("");
  const formulasHtml = answer.formulaSteps.map((step) => {
    const links = citationLinks(step.evidenceIds);
    return `<section class="its-ai-formula-flow"><h4>${escapeHtml(step.title)}</h4><div class="its-ai-formula" role="math" aria-label="${escapeHtml(step.title)}" data-katex-display="${escapeHtml(step.latex)}"></div><p>${escapeHtml(step.explanation)} ${links}${step.sourcePage ? ` <small>Halaman ${step.sourcePage}</small>` : ""}</p></section>`;
  }).join("");
  const imageCandidates = [
    ...evidence
      .filter((item) => item.imageUrl && answer.usedEvidenceIds.includes(item.id))
      .map((item) => ({ sourceId: item.sourceId, imageUrl: item.imageUrl || "", text: item.text })),
    ...documents.flatMap((documentNode) => documentNode.blocks
      .filter((block) => block.type === "image" && block.imageUrl)
      .map((block) => ({ sourceId: documentNode.sourceId, imageUrl: block.imageUrl || "", text: block.alt || block.text }))),
  ];
  const usedImageUrls = new Set<string>();
  const usedImages = imageCandidates.filter((item) => {
    if (!item.imageUrl || usedImageUrls.has(item.imageUrl)) return false;
    usedImageUrls.add(item.imageUrl);
    return true;
  }).slice(0, 8);
  const imagesHtml = usedImages.map((item) => {
    const source = bibliography.find((entry) => entry.id === item.sourceId)
      || otherSources.find((entry) => entry.id === item.sourceId);
    return `<figure class="its-ai-research-image"><a href="${escapeHtml(source?.imageSourceUrl || source?.url || item.imageUrl)}" target="_blank" rel="noopener"><img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.text)}" loading="lazy" referrerpolicy="no-referrer"></a><figcaption>${escapeHtml(item.text)}${source ? ` - <a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">${escapeHtml(source.title)}</a>` : ""}</figcaption></figure>`;
  }).join("");
  const referencesHtml = bibliography.map((source, index) => `
    <li id="its-ai-reference-${index + 1}" class="its-ai-reference-item">
      <p><strong>[S${index + 1}]</strong> ${escapeHtml(source.authors.join(", ") || source.venue || source.provider)}, "${escapeHtml(source.title)}," ${escapeHtml(source.year || "n.d.")}${source.doi ? `, doi: ${escapeHtml(source.doi)}` : ""}.</p>
      <small>${escapeHtml(source.status)}${source.license ? ` - ${escapeHtml(source.license)}` : ""}</small>
      <div class="its-ai-actions"><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">Sumber</a>${source.pdfUrl ? `<a href="${escapeHtml(source.pdfUrl)}" target="_blank" rel="noopener">PDF</a>` : ""}</div>
    </li>`).join("");
  const codeHtml = documents.flatMap((documentNode) => documentNode.blocks
    .filter((block) => block.type === "code")
    .slice(0, 4)
    .map((block) => `<article class="its-ai-code-evidence"><h4>${escapeHtml(documentNode.title)}</h4>${block.html || `<pre><code>${escapeHtml(block.text)}</code></pre>`}</article>`))
    .slice(0, 8)
    .join("");
  const mediaSources = [...bibliography, ...otherSources]
    .map((source) => ({ source, embedUrl: source.provider === "youtube" ? youtubeEmbedUrl(source.url) : "" }))
    .filter((item) => item.embedUrl)
    .slice(0, 3);
  const mediaHtml = mediaSources.map(({ source, embedUrl }) => `
    <figure class="its-ai-research-video">
      <div class="its-ai-video-frame">
        <iframe src="${escapeHtml(embedUrl)}" title="${escapeHtml(source.title)}" loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
      </div>
      <figcaption><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">${escapeHtml(source.title)}</a>
        <small>${escapeHtml(source.accessNote || "YouTube IFrame Player resmi.")}</small>
      </figcaption>
    </figure>`).join("");
  const otherHtml = otherSources.length ? `<details class="its-ai-other-sources"><summary>Sumber lain yang ditemukan (${otherSources.length})</summary><ul>${otherSources.map((source) => {
    let favicon = "";
    try { favicon = `${new URL(source.url).origin}/favicon.ico`; } catch { /* Keep text fallback. */ }
    return `<li>${favicon ? `<img src="${escapeHtml(favicon)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}<div><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">${escapeHtml(source.title)}</a><small>${escapeHtml(source.provider)}${source.abstract ? ` · ${escapeHtml(source.abstract.slice(0, 180))}` : ""}</small></div></li>`;
  }).join("")}</ul></details>` : "";
  const accessLimitations = documents.filter((documentNode) => documentNode.limitation);
  const limitationsHtml = [
    ...answer.limitations.map((item) => `<li>${escapeHtml(item)}</li>`),
    ...accessLimitations.map((documentNode) => `<li><a href="${escapeHtml(documentNode.url)}" target="_blank" rel="noopener">${escapeHtml(documentNode.title)}</a>: ${escapeHtml(documentNode.limitation)}</li>`),
  ].join("");
  const limitationCount = answer.limitations.length + accessLimitations.length;
  const html = `<section class="its-ai-research-support" aria-label="Jawaban dan bukti riset publik">
    <p class="its-ai-grounded-summary">${escapeHtml(answer.summary)} ${summaryCitationLinks}</p>
    ${sectionsHtml}${formulasHtml}${codeHtml}${mediaHtml ? `<div class="its-ai-research-videos">${mediaHtml}</div>` : ""}${imagesHtml ? `<div class="its-ai-research-images">${imagesHtml}</div>` : ""}
    ${limitationsHtml ? `<details class="its-ai-source-notes"><summary>Catatan akses sumber (${limitationCount})</summary><ul>${limitationsHtml}</ul></details>` : ""}
    ${referencesHtml ? `<section class="its-ai-references"><h4>Daftar pustaka (${bibliography.length})</h4><ol class="its-ai-reference-list">${referencesHtml}</ol></section>` : ""}
    ${otherHtml}
  </section>`;
  return { text, html };
}

function formulaSymbols(answer: ValidatedGroundedAnswer): string[] {
  const found = answer.formulaSteps.flatMap((step) => step.latex.match(/\\?[A-Za-z]+|[\u03B1-\u03C9\u0391-\u03A9]|\^\{[^}]+\}/g) || []);
  return [...new Set(found)].slice(0, 60);
}

export class ResearchOrchestrator {
  private activeController: AbortController | null = null;

  async planQuestion(
    question: string,
    history: ResearchTurn[] = [],
    signal?: AbortSignal,
    onProgress?: (message: string, progress?: number) => void,
    applicationState?: Record<string, unknown>,
  ): Promise<ResearchPlan> {
    const memory = conversationResearchMemory.load();
    try {
      const dynamicPlan = await agentOrchestrator.planQuestion(
        question,
        history,
        signal,
        onProgress,
        {
          ...(applicationState || {}),
          ...(memory ? { previousResearchPlan: memory.plan, previousTopic: memory.topic } : {}),
        },
      );
      return sanitizePlan(researchPlanFromAgentPlan(dynamicPlan, question), question);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      console.warn("[ITS Research] Planner lokal gagal; emergency router digunakan", error);
      onProgress?.("Planner lokal tidak tersedia; memakai router darurat", 8);
      return fallbackResearchPlan(question, history, memory);
    }
  }

  cancel(): void {
    this.activeController?.abort(new DOMException("Riset dibatalkan pengguna.", "AbortError"));
    this.activeController = null;
  }

  async run(options: ResearchRunOptions): Promise<ResearchResult> {
    const question = options.question.trim();
    if (!question) throw new Error("Pertanyaan riset tidak boleh kosong.");
    this.cancel();
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    this.activeController = controller;
    const history = options.history || [];
    const manageActivitySession = options.manageActivitySession !== false;
    const sessionId = options.activitySessionId || agentLiveActivity.start(question);
    try {
      let plan = options.plan
        ? sanitizePlan(options.plan, question)
        : await this.planQuestion(question, history, controller.signal, options.onProgress);
      if (plan.needsResearch && (!plan.queries.length || plan.needsFreshSearch)) {
        const generatedQueries = await queryGenerator.generate(question, plan, history, controller.signal, options.onProgress);
        plan = sanitizePlan({ ...plan, queries: generatedQueries.map((query) => query.text), querySpecs: generatedQueries }, question);
        generatedQueries.forEach((query) => agentLiveActivity.emit(sessionId, {
          type: "query-created",
          title: `Query ${query.kind} dibuat dari rencana runtime`,
          payload: {
            query: query.text,
            detail: query.sourceTypes.join(", "),
            ...searchSurface(plan, query.kind),
            progress: 9,
          },
        }));
      }
      agentLiveActivity.emit(sessionId, {
        type: "plan-created",
        title: `Rencana ${plan.intent} siap`,
        payload: { detail: JSON.stringify(plan), progress: 10 },
      });
      if (!plan.needsResearch) {
        throw new Error("Planner menyatakan pertanyaan ini tidak memerlukan riset sumber publik.");
      }
      const memory = conversationResearchMemory.load();
      const reusePrevious = !plan.needsFreshSearch && memory && memory.evidence.length > 0;
      let sources: ResearchSource[];
      const evidenceStore = new EvidenceStore();
      const documents: ResearchDocument[] = [];
      if (reusePrevious) {
        sources = memory.sources;
        evidenceStore.hydrate(memory.evidence);
        options.onProgress?.("Menggunakan bukti riset sebelumnya untuk tindak lanjut", 18);
      } else {
        agentLiveActivity.emit(sessionId, {
          type: "search-started",
          title: "Memilih provider terbuka dari capability dan tipe sumber",
          payload: {
            query: plan.queries[0],
            ...searchSurface(plan, plan.querySpecs[0]?.kind),
            progress: 16,
          },
        });
        await emitQueryTyping(sessionId, plan.queries[0], controller.signal);
        agentLiveActivity.emit(sessionId, {
          type: "pointer-move",
          title: "Menggerakkan pointer ke tombol cari",
          payload: { targetId: "search-submit", progress: 17 },
        });
        await playbackPause(320, controller.signal);
        agentLiveActivity.emit(sessionId, {
          type: "search-submit",
          title: "Mengirim query ke indeks publik",
          payload: { query: plan.queries[0], targetId: "search-submit", progress: 18 },
        });
        options.onProgress?.("Mencari metadata dan sumber terbuka", 20);
        sources = await sourceAdapter.search(question, plan, controller.signal);
        agentLiveActivity.emit(sessionId, {
          type: "search-results",
          title: `${sources.length} sumber nyata ditemukan`,
          payload: { query: plan.queries[0], sources: sources.map(activitySource), progress: 30 },
        });
      }

      if (!reusePrevious) {
        const readableSources = sourcesToRead(question, plan, sources);
        for (const [sourceIndex, source] of readableSources.entries()) {
          if (controller.signal.aborted) throw controller.signal.reason;
          const resultTarget = `result-${source.id}`;
          agentLiveActivity.emit(sessionId, {
            type: "pointer-move",
            title: `Memilih ${source.title}`,
            payload: { targetId: resultTarget, source: activitySource(source), progress: 32 + sourceIndex },
          });
          agentLiveActivity.emit(sessionId, {
            type: "pointer-click",
            title: `Membuka ${source.title}`,
            payload: { targetId: resultTarget, source: activitySource(source), progress: 33 + sourceIndex },
          });

          let documentNode: ResearchDocument | null = null;
          // Archive/Commons search results already carry the public metadata
          // that may be summarized safely. Opening every media landing page
          // through the signed HTML reader adds latency and still does not
          // provide a transcript, so keep those sources metadata-only unless a
          // dedicated transcript URL is discovered.
          const isMetadataMedia = source.provider === "internet-archive"
            || source.provider === "youtube"
            || source.provider === "wikimedia";
          const shouldReadHtml = !isMetadataMedia && (
            source.provider === "direct"
            || plan.requiredCapabilities.includes("read_public_html")
            || plan.requiredCapabilities.includes("discover_official_source")
          );
          if (source.provider === "github") {
            agentLiveActivity.emit(sessionId, { type: "skill-start", title: `Mengunduh ZIP dan mencari kode lokal di ${source.title}`, payload: { capability: "search_public_sources", progress: 36 + sourceIndex } });
            documentNode = await githubRepositoryReader.read(source, question, controller.signal);
            agentLiveActivity.emit(sessionId, { type: "skill-complete", title: `${documentNode.blocks.length} potongan kode ditemukan`, payload: { capability: "search_public_sources", progress: 39 + sourceIndex } });
          } else if (plan.needsPdf && source.pdfUrl && sourceIndex < 2) {
            const tab = sourceTab(source, "pdf");
            agentLiveActivity.emit(sessionId, { type: "pdf-open", title: `Membuka PDF ${source.title}`, payload: { tab, source: activitySource(source), progress: 36 + sourceIndex } });
            agentLiveActivity.emit(sessionId, { type: "tab-activate", title: `Tab PDF ${source.title} aktif`, payload: { tabId: tab.id, progress: 37 + sourceIndex } });
            documentNode = await pdfSourceReader.read(
              source,
              (message, page, totalPages) => {
                agentLiveActivity.emit(sessionId, {
                  type: "pdf-page-rendered",
                  title: message,
                  payload: { tabId: tab.id, targetId: page ? `pdf-page-${page}` : undefined, page, totalPages, progress: 38 + sourceIndex * 3 },
                });
              },
              controller.signal,
            );
          } else if (shouldReadHtml) {
            const tab = sourceTab(source, "article");
            agentLiveActivity.emit(sessionId, { type: "tab-open", title: `Membuka ${source.title}`, payload: { tab, source: activitySource(source), progress: 36 + sourceIndex } });
            agentLiveActivity.emit(sessionId, { type: "tab-activate", title: `Tab ${source.title} aktif`, payload: { tabId: tab.id, progress: 37 + sourceIndex } });
            documentNode = await htmlSourceReader.read(source, controller.signal);
          }

          if (!documentNode || (!documentNode.blocks.length && source.abstract)) {
            const abstract = abstractDocument(source);
            if (abstract) {
              if (documentNode?.limitation) abstract.limitation = `${abstract.limitation} ${documentNode.limitation}`.trim();
              documentNode = abstract;
              const tab = sourceTab(source, "article");
              agentLiveActivity.emit(sessionId, { type: "tab-open", title: `Membaca abstrak ${source.title}`, payload: { tab, source: activitySource(source), progress: 38 + sourceIndex } });
              agentLiveActivity.emit(sessionId, { type: "tab-activate", title: `Tab abstrak ${source.title} aktif`, payload: { tabId: tab.id, progress: 39 + sourceIndex } });
            }
          }
          if (!documentNode) {
            documentNode = {
              sourceId: source.id,
              title: source.title,
              url: source.url,
              status: "metadata-only",
              blocks: [],
              limitation: "Provider hanya menyediakan metadata; tidak ada isi yang diklaim telah dibaca.",
            };
          }
          source.status = documentNode.status;
          source.accessNote = documentNode.limitation;
          documents.push(documentNode);
          if (documentNode.blocks.length) {
            agentLiveActivity.emit(sessionId, {
              type: "content-loaded",
              title: `${documentNode.blocks.length} blok aktual dimuat`,
              payload: { tabId: source.id, blocks: documentNode.blocks, source: activitySource(source), progress: 42 + sourceIndex * 2 },
            });
          }
          const evidenceByBlock = new Map<string, ResearchEvidence>();
          for (const [blockIndex, block] of documentNode.blocks.entries()) {
            const evidence = evidenceStore.readBlock(plan, source, block);
            if (evidence) evidenceByBlock.set(block.id, evidence);
            if (blockIndex > 0 && blockIndex % 80 === 0) await playbackPause(0, controller.signal);
          }
          for (const block of playbackBlocks(documentNode.blocks, evidenceByBlock)) {
            const targetId = `article-block-${block.id}`;
            agentLiveActivity.emit(sessionId, { type: "scroll-to-block", title: "Berpindah ke blok sumber", payload: { tabId: source.id, targetId, blockId: block.id, block, progress: 45 + sourceIndex * 2 } });
            agentLiveActivity.emit(sessionId, { type: "pointer-move", title: `Menunjuk blok ${block.type}`, payload: { tabId: source.id, targetId, blockId: block.id, progress: 45 + sourceIndex * 2 } });
            agentLiveActivity.emit(sessionId, { type: "read-block-start", title: `Membaca ${block.type}`, payload: { tabId: source.id, targetId, blockId: block.id, block, progress: 46 + sourceIndex * 2 } });
            const wordCount = block.text.split(/\s+/).filter(Boolean).length;
            const readingStep = Math.max(1, Math.ceil(wordCount / 4));
            for (let wordIndex = readingStep; wordIndex < wordCount; wordIndex += readingStep) {
              agentLiveActivity.emit(sessionId, {
                type: "read-word-progress",
                title: `Membaca ${Math.min(wordIndex, wordCount)} dari ${wordCount} kata`,
                payload: { tabId: source.id, targetId, blockId: block.id, wordIndex: Math.min(wordIndex, wordCount), wordCount, progress: 47 + sourceIndex * 2 },
              });
              await playbackPause(36, controller.signal);
            }
            agentLiveActivity.emit(sessionId, { type: "read-word-progress", title: `${wordCount} kata selesai dibaca`, payload: { tabId: source.id, targetId, blockId: block.id, wordIndex: wordCount, wordCount, progress: 47 + sourceIndex * 2 } });
            const evidence = evidenceByBlock.get(block.id);
            if (evidence) {
              agentLiveActivity.emit(sessionId, { type: "evidence-saved", title: "Bukti relevan disimpan", payload: { tabId: source.id, targetId, blockId: block.id, evidenceId: evidence.id, progress: 48 + sourceIndex * 2 } });
            }
            agentLiveActivity.emit(sessionId, { type: "read-block-complete", title: "Blok selesai diproses", payload: { tabId: source.id, targetId, blockId: block.id, progress: 49 + sourceIndex * 2 } });
            if (block.page) {
              agentLiveActivity.emit(sessionId, { type: "pdf-page-read", title: `Teks halaman ${block.page} dibaca`, payload: { tabId: source.id, targetId, page: block.page, progress: 50 + sourceIndex * 2 } });
            }
            if (block.type === "image" && block.imageUrl) {
              agentLiveActivity.emit(sessionId, {
                type: "figure-open",
                title: "Gambar sumber dibuka",
                payload: {
                  tab: sourceTab(source, "figure"),
                  tabId: source.id,
                  targetId,
                  blockId: block.id,
                  source: activitySource(source),
                  progress: 51 + sourceIndex * 2,
                },
              });
            }
            await Promise.resolve();
          }
          const closeTarget = `tab-close-${source.id}`;
          agentLiveActivity.emit(sessionId, { type: "pointer-move", title: "Menggerakkan pointer ke tombol tutup tab", payload: { tabId: source.id, targetId: closeTarget, progress: 53 + sourceIndex * 3 } });
          await playbackPause(220, controller.signal);
          agentLiveActivity.emit(sessionId, { type: "pointer-click", title: "Menutup tab sumber", payload: { tabId: source.id, targetId: closeTarget, progress: 54 + sourceIndex * 3 } });
          await playbackPause(120, controller.signal);
          agentLiveActivity.emit(sessionId, { type: "tab-close", title: `Selesai dengan ${source.title}`, payload: { tabId: source.id, progress: 54 + sourceIndex * 3 } });
        }
      }

      agentLiveActivity.emit(sessionId, {
        type: "skill-start",
        title: "Mengurutkan evidence dengan embedding ONNX",
        payload: { capability: "create_embeddings", progress: 62 },
      });
      const evidence = await evidenceRanker.rank(
        plan,
        evidenceStore.list(),
        24,
        (message, progress) => {
          options.onProgress?.(message, progress);
          agentLiveActivity.emit(sessionId, {
            type: "read-block-progress",
            title: message,
            payload: { capability: "rerank_results", progress: 62 + Math.round((progress || 0) * 0.08) },
          });
        },
        controller.signal,
      );
      agentLiveActivity.emit(sessionId, {
        type: "skill-complete",
        title: `${evidence.length} evidence paling relevan dipilih`,
        payload: { capability: "rerank_results", progress: 70 },
      });
      if (!evidence.length) {
        const blocked = documents.filter((documentNode) => documentNode.status === "blocked");
        const limitations = [...new Set(documents.map((documentNode) => documentNode.limitation).filter(Boolean))];
        const answer: ValidatedGroundedAnswer = {
          summary: blocked.length
            ? "Isi sumber tidak dapat dibaca oleh browser karena pembatasan akses. Tidak ada konten halaman yang direka atau disintesis."
            : "Tidak ada blok sumber yang cukup relevan untuk menyusun jawaban berbasis bukti.",
          sections: [],
          formulaSteps: [],
          limitations: limitations.length
            ? limitations
            : ["Provider hanya mengembalikan metadata dan tidak menyediakan isi yang dapat diverifikasi."],
          usedEvidenceIds: [],
          supportRatio: 1,
          citedSourceIds: [],
        };
        const rendered = renderResult(answer, [], [], sources, documents);
        agentLiveActivity.emit(sessionId, {
          type: "citation-validation",
          title: "Tidak ada klaim faktual yang memerlukan sitasi",
          payload: { supportRatio: 1, detail: "0 evidence digunakan", progress: 97 },
        });
        if (manageActivitySession) agentLiveActivity.complete(sessionId, "Selesai tanpa sintesis karena tidak ada evidence yang dapat dibaca.");
        return {
          text: rendered.text,
          html: rendered.html,
          plan,
          answer,
          sources,
          bibliography: [],
          otherSources: sources,
          evidence: [],
          documents,
        };
      }
      const writingTab: PlaybackTab = {
        id: "writing",
        kind: "writing",
        title: "Grounded answer",
        url: "about:writing",
        active: true,
        closed: false,
        scrollTop: 0,
      };
      agentLiveActivity.emit(sessionId, { type: "writing-start", title: "Model menyusun jawaban grounded", payload: { tab: writingTab, progress: 72 } });
      const answer = await groundedAnswerGenerator.synthesize(
        question,
        plan,
        evidence,
        sources,
        history,
        options.onProgress,
        (token) => agentLiveActivity.emit(sessionId, { type: "writing-token", title: "Token jawaban diterima", payload: { tabId: writingTab.id, token, progress: 86 } }),
        controller.signal,
      );
      if (/\b(?:video|watch|youtube|rekaman|putar|transkrip)\b/i.test(question)) {
        const videoSourceIds = new Set(sources.filter((source) => source.provider === "youtube").map((source) => source.id));
        const videoEvidence = evidence.find((item) => videoSourceIds.has(item.sourceId));
        if (videoEvidence && !answer.usedEvidenceIds.includes(videoEvidence.id)) {
          answer.sections.push({
            heading: "Sumber video",
            paragraphs: [{
              text: videoEvidence.text,
              evidenceIds: [videoEvidence.id],
            }],
          });
          answer.usedEvidenceIds.push(videoEvidence.id);
          if (!answer.citedSourceIds.includes(videoEvidence.sourceId)) answer.citedSourceIds.push(videoEvidence.sourceId);
        }
        if (videoSourceIds.size) {
          answer.limitations.push(
            "Video diputar melalui YouTube IFrame Player resmi. Tidak ada transkrip publik yang berhasil dibaca; ringkasan video dibatasi pada deskripsi README repository yang ditemukan.",
          );
        } else {
          answer.limitations.push(
            "Tidak ada sumber video publik yang berhasil ditemukan, sehingga isi audio atau transkrip tidak diringkas.",
          );
        }
        answer.limitations = [...new Set(answer.limitations)];
      }
      const bibliography = bibliographyForAnswer(answer, evidence, sources);
      const bibliographyIds = new Set(bibliography.map((source) => source.id));
      const otherSources = sources.filter((source) => !bibliographyIds.has(source.id));
      agentLiveActivity.emit(sessionId, {
        type: "citation-validation",
        title: "Sitasi dan bibliografi tervalidasi",
        payload: { supportRatio: answer.supportRatio, detail: `${bibliography.length} sumber benar-benar digunakan`, progress: 97 },
      });
      const rendered = renderResult(answer, evidence, bibliography, otherSources, documents);
      conversationResearchMemory.save({
        topic: plan.topic,
        plan,
        evidence,
        usedEvidenceIds: answer.usedEvidenceIds,
        formulaSymbols: formulaSymbols(answer),
        figures: documents.flatMap((documentNode) => documentNode.blocks.filter((block) => block.type === "image")),
        sources,
        answer,
        updatedAt: Date.now(),
      });
      if (manageActivitySession) agentLiveActivity.complete(sessionId, `${answer.usedEvidenceIds.length} bukti dan ${bibliography.length} sumber dipakai.`);
      return {
        text: rendered.text,
        html: rendered.html,
        plan,
        answer,
        sources,
        bibliography,
        otherSources,
        evidence,
        documents,
      };
    } catch (error) {
      if (manageActivitySession) agentLiveActivity.fail(sessionId, error);
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", forwardAbort);
      if (this.activeController === controller) this.activeController = null;
    }
  }

  getMemory(): ResearchMemoryState | null {
    return conversationResearchMemory.load();
  }

  clearMemory(): void {
    conversationResearchMemory.clear();
  }
}

export const researchOrchestrator = new ResearchOrchestrator();
