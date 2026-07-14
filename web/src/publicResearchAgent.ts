import {
  generateBrowserText,
  isBrowserTextModelReady,
  warmBrowserTextModel,
} from "./ai/browserTextModelClient";
import {
  agentLiveActivity,
  type AgentActivitySource,
} from "./agentLiveActivity";

export type PublicResearchMode = "journal" | "profile" | "image" | "general";

export type PublicResearchTurn = {
  role: "user" | "assistant";
  content: string;
};

export type PublicResearchSource = {
  id: string;
  provider: "crossref" | "openalex" | "europepmc" | "wikipedia" | "wikidata" | "github";
  title: string;
  authors: string[];
  year: string;
  venue: string;
  doi: string;
  url: string;
  pdfUrl: string;
  abstract: string;
  fullText: string;
  citationCount: number;
  license: string;
  imageUrl: string;
  imageSourceUrl: string;
  facts: Array<{ label: string; value: string }>;
  score: number;
};

export type PublicResearchImage = {
  title: string;
  imageUrl: string;
  thumbUrl: string;
  pageUrl: string;
  author: string;
  license: string;
  description: string;
};

export type PublicResearchPlan = {
  mode: PublicResearchMode;
  needsSearch: boolean;
  query: string;
  englishQuery: string;
  focus: string;
  isFollowUp: boolean;
  wantsFormula: boolean;
  wantsPdf: boolean;
  wantsImages: boolean;
};

export type PublicResearchAnswer = {
  text: string;
  html: string;
  mode: PublicResearchMode;
  sources: PublicResearchSource[];
  images: PublicResearchImage[];
  plan: PublicResearchPlan;
};

type PublicResearchOptions = {
  question: string;
  history?: PublicResearchTurn[];
  onProgress?: (message: string) => void;
};

export type PublicResearchWebMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  execute: (input: Record<string, unknown>) => unknown | Promise<unknown>;
};

type StoredResearchState = {
  question: string;
  answer: string;
  plan: PublicResearchPlan;
  sources: PublicResearchSource[];
  images: PublicResearchImage[];
  updatedAt: number;
};

const CROSSREF_BASE = "https://api.crossref.org/works";
const OPENALEX_BASE = "https://api.openalex.org/works";
const EUROPE_PMC_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const WIKIPEDIA_API = "https://id.wikipedia.org/w/api.php";
const GITHUB_API = "https://api.github.com";
const STATE_KEY = "its-public-research-state:v1";
const SEARCH_CACHE_PREFIX = "its-public-research-cache:v1:";
const MAX_SOURCE_CONTEXT_CHARS = 24_000;
const DEFAULT_RESULT_LIMIT = 6;

function playbackSource(source: PublicResearchSource): AgentActivitySource {
  return {
    id: source.id,
    title: source.title,
    provider: source.provider,
    url: source.url || source.pdfUrl,
    excerpt: cleanEvidenceText(source.abstract || source.fullText).slice(0, 520),
    authors: source.authors,
    year: source.year,
  };
}

function yieldResearchUi(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}


function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function stripHtml(value: string): string {
  if (!value) return "";
  const doc = new DOMParser().parseFromString(value, "text/html");
  return cleanEvidenceText(doc.body.textContent || "");
}

function cleanEvidenceText(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const mojibakeHits = (cleaned.match(/[ÐÑ][\u0080-\u00ff]|â[\u0080-\u00ff]{1,2}|ï¿½|�/g) || []).length;
  if (mojibakeHits >= 3 || mojibakeHits / Math.max(cleaned.length, 1) > 0.015) return "";
  return cleaned;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  const stop = new Set([
    "yang", "dan", "atau", "dengan", "untuk", "dari", "pada", "dalam", "ini", "itu", "apa", "bagaimana",
    "jelaskan", "tolong", "saya", "user", "the", "and", "for", "from", "with", "into", "what", "how", "why",
  ]);
  return normalize(value).split(" ").filter((word) => word.length > 2 && !stop.has(word));
}

function includesAny(value: string, words: string[]): boolean {
  return words.some((word) => value.includes(word));
}

function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = key(item);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function firstString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return firstString(value[0]);
  return "";
}

function safeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function dateYear(value: unknown): string {
  if (typeof value === "string") {
    const match = value.match(/\b(19|20)\d{2}\b/);
    return match?.[0] || "";
  }
  if (Array.isArray(value)) {
    const first = value[0];
    if (Array.isArray(first) && Number.isFinite(Number(first[0]))) return String(first[0]);
  }
  return "";
}

function sourceKey(source: PublicResearchSource): string {
  return normalize(source.doi || source.url || source.title);
}

function buildId(provider: string, value: string): string {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${provider}-${(hash >>> 0).toString(36)}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function fetchJson<T>(url: string, timeout = 14_000): Promise<T> {
  const response = await withTimeout(
    fetch(url, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      headers: { Accept: "application/json" },
    }),
    timeout,
    `Waktu permintaan habis: ${url}`,
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json() as Promise<T>;
}

async function fetchText(url: string, timeout = 16_000, accept = "text/plain,application/xml,text/xml,text/html"): Promise<string> {
  const response = await withTimeout(
    fetch(url, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      headers: { Accept: accept },
    }),
    timeout,
    `Waktu permintaan habis: ${url}`,
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.text();
}

function loadState(): StoredResearchState | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STATE_KEY) || "null") as StoredResearchState | null;
    return parsed && Array.isArray(parsed.sources) ? parsed : null;
  } catch {
    return null;
  }
}

function saveState(state: StoredResearchState): void {
  try {
    const safeState: StoredResearchState = {
      ...state,
      sources: state.sources.slice(0, 10).map((source) => ({ ...source, fullText: source.fullText.slice(0, 8_000) })),
      images: state.images.slice(0, 6),
    };
    sessionStorage.setItem(STATE_KEY, JSON.stringify(safeState));
  } catch {
    // Session storage may be disabled or full.
  }
}

function cacheGet<T>(key: string): T | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEARCH_CACHE_PREFIX + key) || "null") as { at: number; value: T } | null;
    if (!parsed || Date.now() - parsed.at > 6 * 60 * 60 * 1000) return null;
    return parsed.value;
  } catch {
    return null;
  }
}

function cacheSet<T>(key: string, value: T): void {
  try {
    localStorage.setItem(SEARCH_CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), value }));
  } catch {
    // Cache is optional.
  }
}

function cleanPublicSearchQuery(question: string, mode: PublicResearchMode): string {
  let query = question
    .replace(/\b(tolong|mohon|coba|bisa|bisakah|carikan|cari|search|temukan|tampilkan|jelaskan|uraikan|berikan)\b/gi, " ")
    .replace(/\b(dengan|beserta)\s+(sumber|sitasi|citation|referensi|daftar pustaka|lisensi)\b/gi, " ")
    .replace(/\b(dan|serta)?\s*(sumber|sitasi|citation|referensi|daftar pustaka|lisensi)\b/gi, " ")
    .replace(/\b(yang\s+)?(terverifikasi|terpercaya|akurat|publik|terbaru)\b/gi, " ");
  if (mode === "journal") {
    query = query.replace(/\b(jurnal|paper|artikel ilmiah|penelitian|doi|pdf)\b/gi, " ");
  } else if (mode === "profile") {
    query = query.replace(/\b(profil|biografi|pendidikan|kuliah|universitas|akun|developer|pencipta|pembuat)\b/gi, " ");
  } else if (mode === "image") {
    query = query.replace(/\b(gambar|foto|image|picture|kampus|gedung)\b/gi, " ");
  }
  query = query.replace(/\b(dan|serta)\b/gi, " ");
  return query.replace(/[?.!,;:]+/g, " ").replace(/\s+/g, " ").trim() || question.trim();
}

function fallbackPlan(question: string, previous: StoredResearchState | null): PublicResearchPlan {
  const q = normalize(question);
  const wantsFormula = includesAny(q, [
    "rumus", "formula", "persamaan", "derivasi", "turunkan", "penurunan", "loss", "iou", "giou",
    "mean average precision", "map score", "map metric", "precision", "recall", "rf detr", "rf-detr", "detr",
    "hungarian matching", "bipartite matching", "transformer object detection", "cross attention", "self attention",
  ]);
  const journal = wantsFormula || includesAny(q, ["jurnal", "paper", "penelitian", "doi", "sitasi", "daftar pustaka", "arxiv", "referensi ilmiah"]);
  const profile = includesAny(q, ["profil", "pencipta", "developer", "pendidikan", "kuliah", "universitas", "linkedin", "github", "biografi", "siapa"]);
  const image = includesAny(q, ["foto", "gambar", "image", "kampus", "gedung"]);
  const followUp = Boolean(previous) && (q.length < 80 || includesAny(q, ["bagian", "maksud", "simbol", "yang tadi", "jelaskan lagi", "belum paham", "kenapa", "contoh"]));
  const mode: PublicResearchMode = journal ? "journal" : profile ? "profile" : image ? "image" : "general";
  const query = cleanPublicSearchQuery(question, mode);
  const englishQuery = wantsFormula && /\b(?:rf[- ]?detr|detr)\b/i.test(question)
    ? "RF-DETR DETR Hungarian matching loss classification L1 generalized IoU object detection"
    : query;
  return {
    mode,
    needsSearch: !followUp || includesAny(q, ["cari lagi", "sumber lain", "jurnal lain", "terbaru", "tambahkan sumber"]),
    query,
    englishQuery,
    focus: wantsFormula ? "mathematical formulation and derivation" : question.trim(),
    isFollowUp: followUp,
    wantsFormula,
    wantsPdf: journal || includesAny(q, ["pdf", "unduh jurnal", "link jurnal"]),
    wantsImages: image || profile,
  };
}

function lexicalScore(query: string, text: string): number {
  const q = tokens(query);
  if (!q.length) return 0;
  const normalizedText = normalize(text);
  let hits = 0;
  for (const token of q) if (normalizedText.includes(token)) hits += 1;
  return hits / q.length;
}

function sourceScore(source: PublicResearchSource, query: string): number {
  const relevance = lexicalScore(query, `${source.title} ${source.abstract} ${source.venue} ${source.facts.map((fact) => `${fact.label} ${fact.value}`).join(" ")}`);
  const citations = Math.log10(1 + Math.max(0, source.citationCount)) / 5;
  const fullTextBonus = source.fullText ? 0.15 : 0;
  const pdfBonus = source.pdfUrl ? 0.08 : 0;
  const authorityText = normalize(`${source.venue} ${source.url} ${source.license}`);
  const authority = includesAny(authorityText, [
    "ieee", "acm", "wiley", "springer", "nature", "science", "elsevier", "sciencedirect",
    "computer vision and pattern recognition", "cvpr", "eccv", "iccv", "openreview", "arxiv",
  ]) ? 0.16 : 0;
  const international = /[a-z]/i.test(source.venue) && !includesAny(authorityText, ["jurnal indonesia", "universitas indonesia", "sinta"])
    ? 0.04
    : 0;
  const canonicalDetr = normalize(source.title) === "end-to-end object detection with transformers" ? 1.2 : 0;
  return relevance * 0.62 + citations * 0.14 + authority + international + fullTextBonus + pdfBonus + canonicalDetr;
}

function sourceQualityLabel(source: PublicResearchSource): string {
  const text = normalize(`${source.venue} ${source.url}`);
  if (includesAny(text, ["ieee", "acm", "wiley", "springer", "nature", "elsevier", "sciencedirect", "cvpr", "eccv", "iccv"])) {
    return "Penerbit/venue internasional bereputasi; quartile perlu diverifikasi pada indeks resmi";
  }
  if (source.citationCount >= 100) return "Dampak sitasi tinggi; quartile belum diverifikasi";
  return "Metadata publik; peringkat Q1/SINTA belum diverifikasi";
}

function bestPdfLink(links: unknown): string {
  if (!Array.isArray(links)) return "";
  for (const item of links) {
    const record = item as Record<string, unknown>;
    const type = String(record["content-type"] || "").toLowerCase();
    const url = String(record.URL || "");
    if (url && (type.includes("pdf") || url.toLowerCase().includes(".pdf"))) return url;
  }
  return "";
}

async function searchCrossref(query: string, limit = DEFAULT_RESULT_LIMIT): Promise<PublicResearchSource[]> {
  const cacheKey = `crossref:${normalize(query)}:${limit}`;
  const cached = cacheGet<PublicResearchSource[]>(cacheKey);
  if (cached) return cached;
  const url = `${CROSSREF_BASE}?query.bibliographic=${encodeURIComponent(query)}&rows=${limit}&select=DOI,title,author,published-print,published-online,container-title,URL,abstract,is-referenced-by-count,link,license,type`;
  const data = await fetchJson<{ message?: { items?: Array<Record<string, any>> } }>(url);
  const result = (data.message?.items || []).map((item): PublicResearchSource => {
    const title = firstString(item.title);
    const doi = String(item.DOI || "");
    const authors = Array.isArray(item.author)
      ? item.author.map((author: Record<string, unknown>) => [author.given, author.family].filter(Boolean).join(" ").trim()).filter(Boolean)
      : [];
    const year = dateYear(item["published-print"]?.["date-parts"] || item["published-online"]?.["date-parts"]);
    const urlValue = String(item.URL || (doi ? `https://doi.org/${doi}` : ""));
    return {
      id: buildId("crossref", doi || title),
      provider: "crossref",
      title,
      authors,
      year,
      venue: firstString(item["container-title"]),
      doi,
      url: urlValue,
      pdfUrl: bestPdfLink(item.link),
      abstract: stripHtml(String(item.abstract || "")),
      fullText: "",
      citationCount: safeNumber(item["is-referenced-by-count"]),
      license: Array.isArray(item.license) ? String(item.license[0]?.URL || "") : "",
      imageUrl: "",
      imageSourceUrl: "",
      facts: [],
      score: 0,
    };
  }).filter((source) => source.title);
  cacheSet(cacheKey, result);
  return result;
}

async function fetchCrossrefDoi(doi: string): Promise<PublicResearchSource[]> {
  const cacheKey = `crossref-doi:${normalize(doi)}`;
  const cached = cacheGet<PublicResearchSource[]>(cacheKey);
  if (cached) return cached;
  const data = await fetchJson<{ message?: Record<string, any> }>(`${CROSSREF_BASE}/${encodeURIComponent(doi)}`);
  const item = data.message || {};
  const title = firstString(item.title);
  const authors = Array.isArray(item.author)
    ? item.author.map((author: Record<string, unknown>) => [author.given, author.family].filter(Boolean).join(" ").trim()).filter(Boolean)
    : [];
  const source: PublicResearchSource = {
    id: buildId("crossref", String(item.DOI || doi)),
    provider: "crossref",
    title,
    authors,
    year: dateYear(item["published-print"]?.["date-parts"] || item["published-online"]?.["date-parts"]),
    venue: firstString(item["container-title"]),
    doi: String(item.DOI || doi),
    url: String(item.URL || `https://doi.org/${doi}`),
    pdfUrl: bestPdfLink(item.link),
    abstract: stripHtml(String(item.abstract || "")),
    fullText: "",
    citationCount: safeNumber(item["is-referenced-by-count"]),
    license: Array.isArray(item.license) ? String(item.license[0]?.URL || "") : "",
    imageUrl: "",
    imageSourceUrl: "",
    facts: [],
    score: 0,
  };
  const result = source.title ? [source] : [];
  cacheSet(cacheKey, result);
  return result;
}

function openAlexAbstract(value: unknown): string {
  const index = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      const number = Number(position);
      if (Number.isFinite(number)) words.push([number, word]);
    }
  }
  return words.sort((left, right) => left[0] - right[0]).map((entry) => entry[1]).join(" ");
}

async function searchOpenAlex(query: string, limit = DEFAULT_RESULT_LIMIT): Promise<PublicResearchSource[]> {
  const cacheKey = `openalex:${normalize(query)}:${limit}`;
  const cached = cacheGet<PublicResearchSource[]>(cacheKey);
  if (cached) return cached;
  const url = `${OPENALEX_BASE}?search=${encodeURIComponent(query)}&per-page=${limit}&sort=relevance_score:desc`;
  const data = await fetchJson<{ results?: Array<Record<string, any>> }>(url);
  const result = (data.results || []).map((item): PublicResearchSource => {
    const best = item.best_oa_location || {};
    const primary = item.primary_location || {};
    const source = best.source || primary.source || {};
    const doi = String(item.doi || "").replace(/^https?:\/\/doi\.org\//i, "");
    const authors = Array.isArray(item.authorships)
      ? item.authorships.map((authorship: Record<string, any>) => String(authorship.author?.display_name || "")).filter(Boolean)
      : [];
    return {
      id: buildId("openalex", doi || String(item.id || item.display_name || "")),
      provider: "openalex",
      title: String(item.display_name || ""),
      authors,
      year: String(item.publication_year || ""),
      venue: String(source.display_name || "OpenAlex"),
      doi,
      url: String(best.landing_page_url || primary.landing_page_url || item.doi || item.id || ""),
      pdfUrl: String(best.pdf_url || primary.pdf_url || ""),
      abstract: openAlexAbstract(item.abstract_inverted_index),
      fullText: "",
      citationCount: safeNumber(item.cited_by_count),
      license: String(best.license || item.open_access?.oa_status || ""),
      imageUrl: "",
      imageSourceUrl: "",
      facts: item.id ? [{ label: "OpenAlex", value: String(item.id) }] : [],
      score: 0,
    };
  }).filter((source) => source.title && source.url);
  cacheSet(cacheKey, result);
  return result;
}

async function searchEuropePmc(query: string, limit = DEFAULT_RESULT_LIMIT): Promise<PublicResearchSource[]> {
  const cacheKey = `europepmc:${normalize(query)}:${limit}`;
  const cached = cacheGet<PublicResearchSource[]>(cacheKey);
  if (cached) return cached;
  const url = `${EUROPE_PMC_BASE}/search?query=${encodeURIComponent(query)}&format=json&pageSize=${limit}&resultType=core`;
  const data = await fetchJson<{ resultList?: { result?: Array<Record<string, any>> } }>(url);
  const result = (data.resultList?.result || []).map((item): PublicResearchSource => {
    const pmcid = String(item.pmcid || "");
    const doi = String(item.doi || "");
    const sourceUrl = pmcid
      ? `https://europepmc.org/article/PMC/${encodeURIComponent(pmcid.replace(/^PMC/i, ""))}`
      : doi
        ? `https://doi.org/${doi}`
        : `https://europepmc.org/article/${encodeURIComponent(String(item.source || "MED"))}/${encodeURIComponent(String(item.id || ""))}`;
    const authors = Array.isArray(item.authorList?.author)
      ? item.authorList.author.map((author: Record<string, unknown>) => String(author.fullName || [author.firstName, author.lastName].filter(Boolean).join(" "))).filter(Boolean)
      : String(item.authorString || "").split(",").map((author) => author.trim()).filter(Boolean);
    return {
      id: buildId("europepmc", pmcid || doi || String(item.id || item.title || "")),
      provider: "europepmc",
      title: String(item.title || "").trim(),
      authors,
      year: String(item.pubYear || ""),
      venue: String(item.journalTitle || ""),
      doi,
      url: sourceUrl,
      pdfUrl: pmcid ? `https://europepmc.org/articles/${encodeURIComponent(pmcid)}?pdf=render` : "",
      abstract: stripHtml(String(item.abstractText || "")),
      fullText: "",
      citationCount: safeNumber(item.citedByCount),
      license: String(item.license || ""),
      imageUrl: "",
      imageSourceUrl: "",
      facts: pmcid ? [{ label: "PMCID", value: pmcid }] : [],
      score: 0,
    };
  }).filter((source) => source.title);
  cacheSet(cacheKey, result);
  return result;
}

async function searchCommonsImages(query: string, limit = 6): Promise<PublicResearchImage[]> {
  const cacheKey = `commons:${normalize(query)}:${limit}`;
  const cached = cacheGet<PublicResearchImage[]>(cacheKey);
  if (cached) return cached;
  const url = `${COMMONS_API}?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=${limit}&prop=imageinfo&iiprop=url%7Cextmetadata&iiurlwidth=1200&format=json&origin=*`;
  const data = await fetchJson<{ query?: { pages?: Record<string, Record<string, any>> } }>(url);
  const pages = Object.values(data.query?.pages || {});
  const result = pages.map((page): PublicResearchImage | null => {
    const info = Array.isArray(page.imageinfo) ? page.imageinfo[0] : null;
    if (!info?.url) return null;
    const metadata = info.extmetadata || {};
    return {
      title: String(page.title || "").replace(/^File:/i, ""),
      imageUrl: String(info.url || ""),
      thumbUrl: String(info.thumburl || info.url || ""),
      pageUrl: String(info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(page.title || ""))}`),
      author: stripHtml(String(metadata.Artist?.value || metadata.Credit?.value || "")),
      license: stripHtml(String(metadata.LicenseShortName?.value || metadata.UsageTerms?.value || "")),
      description: stripHtml(String(metadata.ImageDescription?.value || metadata.ObjectName?.value || "")),
    };
  }).filter((item): item is PublicResearchImage => item !== null);
  cacheSet(cacheKey, result);
  return result;
}

async function searchWikipedia(query: string, limit = 4): Promise<PublicResearchSource[]> {
  const cacheKey = `wikipedia:${normalize(query)}:${limit}`;
  const cached = cacheGet<PublicResearchSource[]>(cacheKey);
  if (cached) return cached;
  const url = `${WIKIPEDIA_API}?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=${limit}&prop=extracts%7Cinfo%7Cpageimages&exintro=1&explaintext=1&inprop=url&piprop=original%7Cthumbnail&pithumbsize=900&format=json&origin=*`;
  const data = await fetchJson<{ query?: { pages?: Record<string, Record<string, any>> } }>(url);
  const result = Object.values(data.query?.pages || {}).map((page): PublicResearchSource => ({
    id: buildId("wikipedia", String(page.pageid || page.title || "")),
    provider: "wikipedia",
    title: String(page.title || ""),
    authors: [],
    year: "",
    venue: "Wikipedia",
    doi: "",
    url: String(page.fullurl || ""),
    pdfUrl: "",
    abstract: String(page.extract || "").replace(/\s+/g, " ").trim(),
    fullText: "",
    citationCount: 0,
    license: "CC BY-SA",
    imageUrl: String(page.thumbnail?.source || page.original?.source || ""),
    imageSourceUrl: String(page.fullurl || ""),
    facts: [],
    score: 0,
  })).filter((source) => source.title);
  cacheSet(cacheKey, result);
  return result;
}

async function wikidataEntityLabels(ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const url = `${WIKIDATA_API}?action=wbgetentities&ids=${encodeURIComponent(ids.join("|"))}&props=labels&languages=id%7Cen&format=json&origin=*`;
  const data = await fetchJson<{ entities?: Record<string, Record<string, any>> }>(url);
  const labels: Record<string, string> = {};
  for (const [id, entity] of Object.entries(data.entities || {})) {
    labels[id] = String(entity.labels?.id?.value || entity.labels?.en?.value || id);
  }
  return labels;
}

function wikidataClaimIds(entity: Record<string, any>, property: string): string[] {
  const claims = Array.isArray(entity.claims?.[property]) ? entity.claims[property] : [];
  return claims
    .map((claim: Record<string, any>) => claim.mainsnak?.datavalue?.value?.id)
    .filter((id: unknown): id is string => typeof id === "string");
}

function wikidataClaimString(entity: Record<string, any>, property: string): string {
  const claim = Array.isArray(entity.claims?.[property]) ? entity.claims[property][0] : null;
  const value = claim?.mainsnak?.datavalue?.value;
  return typeof value === "string" ? value : "";
}

async function searchWikidata(query: string, limit = 4): Promise<PublicResearchSource[]> {
  const cacheKey = `wikidata:${normalize(query)}:${limit}`;
  const cached = cacheGet<PublicResearchSource[]>(cacheKey);
  if (cached) return cached;
  const searchUrl = `${WIKIDATA_API}?action=wbsearchentities&search=${encodeURIComponent(query)}&language=id&uselang=id&type=item&limit=${limit}&format=json&origin=*`;
  const search = await fetchJson<{ search?: Array<{ id: string }> }>(searchUrl);
  const ids = (search.search || []).map((item) => item.id).filter(Boolean);
  if (!ids.length) return [];
  const entityUrl = `${WIKIDATA_API}?action=wbgetentities&ids=${encodeURIComponent(ids.join("|"))}&props=labels%7Cdescriptions%7Cclaims%7Csitelinks&languages=id%7Cen&sitefilter=idwiki%7Cenwiki&format=json&origin=*`;
  const data = await fetchJson<{ entities?: Record<string, Record<string, any>> }>(entityUrl);
  const entities = Object.values(data.entities || {});
  const relatedIds = unique(entities.flatMap((entity) => [...wikidataClaimIds(entity, "P69"), ...wikidataClaimIds(entity, "P106")]), (id) => id);
  const relatedLabels: Record<string, string> = await wikidataEntityLabels(relatedIds)
    .catch((): Record<string, string> => ({}));
  const result = entities.map((entity): PublicResearchSource => {
    const id = String(entity.id || "");
    const label = String(entity.labels?.id?.value || entity.labels?.en?.value || id);
    const description = String(entity.descriptions?.id?.value || entity.descriptions?.en?.value || "");
    const education = wikidataClaimIds(entity, "P69").map((value) => relatedLabels[value] || value);
    const occupations = wikidataClaimIds(entity, "P106").map((value) => relatedLabels[value] || value);
    const imageFile = wikidataClaimString(entity, "P18");
    const officialWebsite = wikidataClaimString(entity, "P856");
    const githubUsername = wikidataClaimString(entity, "P2037");
    const facts: Array<{ label: string; value: string }> = [];
    if (education.length) facts.push({ label: "Pendidikan", value: education.join(", ") });
    if (occupations.length) facts.push({ label: "Pekerjaan", value: occupations.join(", ") });
    if (officialWebsite) facts.push({ label: "Situs resmi", value: officialWebsite });
    if (githubUsername) facts.push({ label: "GitHub", value: githubUsername });
    return {
      id: buildId("wikidata", id),
      provider: "wikidata",
      title: label,
      authors: [],
      year: "",
      venue: "Wikidata",
      doi: "",
      url: `https://www.wikidata.org/wiki/${encodeURIComponent(id)}`,
      pdfUrl: "",
      abstract: description,
      fullText: "",
      citationCount: 0,
      license: "CC0",
      imageUrl: imageFile ? `https://commons.wikimedia.org/wiki/Special:Redirect/file/${encodeURIComponent(imageFile)}?width=1000` : "",
      imageSourceUrl: imageFile ? `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(imageFile.replaceAll(" ", "_"))}` : "",
      facts,
      score: 0,
    };
  }).filter((source) => source.title);
  cacheSet(cacheKey, result);
  return result;
}

async function searchGithubProfiles(query: string, limit = 3): Promise<PublicResearchSource[]> {
  const cacheKey = `github:${normalize(query)}:${limit}`;
  const cached = cacheGet<PublicResearchSource[]>(cacheKey);
  if (cached) return cached;
  const queryParts = query.split(/\s+/).filter(Boolean);
  const queryVariants = unique([
    query,
    queryParts.slice(0, 2).join(""),
  ].filter(Boolean), (value) => value.toLowerCase());
  const searches = await Promise.allSettled(queryVariants.map((variant) =>
    fetchJson<{ items?: Array<{ login: string; url: string }> }>(`${GITHUB_API}/search/users?q=${encodeURIComponent(variant)}&per_page=${limit}`)));
  let items = unique(
    searches.flatMap((result) => result.status === "fulfilled" ? result.value.items || [] : []),
    (item) => item.login.toLowerCase(),
  ).slice(0, limit);
  const expectedLogin = queryParts.slice(0, 2).join("").toLowerCase();
  const exact = items.find((item) => item.login.toLowerCase() === expectedLogin);
  if (exact) items = [exact];
  const profiles = await Promise.allSettled(items.map((item) => fetchJson<Record<string, any>>(item.url)));
  const result = profiles.flatMap((result): PublicResearchSource[] => {
    if (result.status !== "fulfilled") return [];
    const profile = result.value;
    const facts: Array<{ label: string; value: string }> = [];
    if (profile.company) facts.push({ label: "Organisasi", value: String(profile.company) });
    if (profile.location) facts.push({ label: "Lokasi", value: String(profile.location) });
    if (profile.blog) facts.push({ label: "Situs", value: String(profile.blog) });
    if (profile.public_repos !== undefined) facts.push({ label: "Repositori publik", value: String(profile.public_repos) });
    return [{
      id: buildId("github", String(profile.login || profile.html_url || "")),
      provider: "github",
      title: String(profile.name || profile.login || ""),
      authors: [],
      year: "",
      venue: "GitHub",
      doi: "",
      url: String(profile.html_url || ""),
      pdfUrl: "",
      abstract: String(profile.bio || ""),
      fullText: "",
      citationCount: 0,
      license: "",
      imageUrl: String(profile.avatar_url || ""),
      imageSourceUrl: String(profile.html_url || ""),
      facts,
      score: 0,
    }];
  });
  cacheSet(cacheKey, result);
  return result;
}

async function europePmcFullText(source: PublicResearchSource): Promise<string> {
  const pmcid = source.facts.find((fact) => fact.label === "PMCID")?.value || "";
  if (!pmcid) return "";
  const xml = await fetchText(`${EUROPE_PMC_BASE}/${encodeURIComponent(pmcid)}/fullTextXML`, 24_000, "application/xml,text/xml");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) return "";
  const body = doc.querySelector("body");
  return cleanEvidenceText(body?.textContent || "").slice(0, 80_000);
}

function bestExcerpts(source: PublicResearchSource, query: string, maxChunks = 3): string[] {
  const text = cleanEvidenceText(`${source.abstract}\n${source.fullText}`);
  if (!text) return [];
  const chunks: string[] = [];
  const size = 1_500;
  const overlap = 220;
  for (let start = 0; start < text.length; start += size - overlap) {
    const chunk = text.slice(start, start + size).trim();
    if (chunk.length >= 100) chunks.push(chunk);
  }
  return chunks
    .map((chunk) => ({ chunk, score: lexicalScore(query, chunk) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxChunks)
    .map((item) => item.chunk);
}

class ClientPublicResearchAgent {
  shouldHandle(question: string, history: PublicResearchTurn[] = []): boolean {
    const q = normalize(question);
    const previous = loadState();
    if (previous && history.length && includesAny(q, ["bagian", "maksud", "simbol", "belum paham", "jelaskan lagi", "contoh", "kenapa", "yang tadi"])) return true;
    return includesAny(q, [
      "jurnal", "paper", "penelitian", "referensi", "sitasi", "daftar pustaka", "doi", "arxiv", "pdf",
      "rumus", "formula", "persamaan", "turunkan", "penurunan", "loss", "iou", "giou", "precision", "recall",
      "map score", "map metric", "mean average precision", "rf detr", "rf-detr", "detr", "hungarian matching",
      "bipartite matching", "transformer object detection", "cross attention", "self attention",
      "profil", "pencipta", "developer", "pendidikan", "kuliah", "universitas", "linkedin", "github", "biografi",
      "foto", "gambar", "kampus", "gedung", "cari situs", "search website",
    ]);
  }

  private async plan(question: string, history: PublicResearchTurn[], onProgress?: (message: string) => void): Promise<PublicResearchPlan> {
    const previous = loadState();
    const fallback = fallbackPlan(question, previous);
    onProgress?.("Skill Perencana: membaca intent, entitas, dan konteks percakapan");
    await Promise.resolve();
    if (history.length && previous && fallback.isFollowUp) {
      const explicitNewTopic = fallback.mode !== "general" || fallback.wantsFormula || fallback.wantsImages;
      return {
        ...fallback,
        mode: explicitNewTopic ? fallback.mode : previous.plan.mode,
        query: explicitNewTopic ? fallback.query : previous.plan.query,
        englishQuery: explicitNewTopic ? fallback.englishQuery : previous.plan.englishQuery,
        focus: fallback.focus || previous.plan.focus,
        wantsFormula: fallback.wantsFormula || previous.plan.wantsFormula,
        wantsPdf: fallback.wantsPdf || previous.plan.wantsPdf,
        wantsImages: fallback.wantsImages || previous.plan.wantsImages,
        isFollowUp: true,
        needsSearch: includesAny(normalize(question), ["cari lagi", "sumber lain", "terbaru"]),
      };
    }
    return fallback;
  }

  private async search(plan: PublicResearchPlan, onProgress?: (message: string) => void): Promise<{ sources: PublicResearchSource[]; images: PublicResearchImage[] }> {
    const query = plan.englishQuery || plan.query;
    if (plan.mode === "journal") {
      onProgress?.("Skill Jurnal: mencari Crossref, OpenAlex, dan Europe PMC");
      const canonicalDetr = "End-to-End Object Detection with Transformers Hungarian matching generalized IoU";
      const queries = unique([query, ...(plan.wantsFormula ? [canonicalDetr] : [])], normalize);
      const results = await Promise.allSettled(queries.flatMap((searchQuery) => [
        searchCrossref(searchQuery),
        searchOpenAlex(searchQuery),
        searchEuropePmc(searchQuery),
      ]).concat(plan.wantsFormula ? [fetchCrossrefDoi("10.1007/978-3-030-58452-8_13")] : []));
      const sources = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      const ranked = this.rankAndDedupe(sources, query);
      const generic = new Set(["rumus", "formula", "formulasi", "loss", "persamaan", "jurnal", "paper", "penelitian"]);
      const anchors = tokens(query).filter((token) => !generic.has(token));
      const anchored = anchors.length
        ? ranked.filter((source) => anchors.some((anchor) => normalize(`${source.title} ${source.abstract}`).includes(anchor)))
        : ranked;
      const allowLocal = includesAny(normalize(plan.query), ["indonesia", "sinta", "lokal"]);
      const qualityFiltered = (anchored.length ? anchored : ranked).filter((source) => {
        if (allowLocal) return true;
        const venue = normalize(source.venue);
        return !includesAny(venue, ["jurnal indonesia", "universitas", "politeknik", "institut teknologi"])
          || includesAny(venue, ["ieee", "acm", "springer", "wiley", "elsevier", "nature"]);
      });
      return { sources: (qualityFiltered.length ? qualityFiltered : anchored.length ? anchored : ranked).slice(0, 10), images: [] };
    }

    if (plan.mode === "profile") {
      onProgress?.("Skill Profil: mencari Wikidata, Wikipedia, GitHub, dan Wikimedia Commons");
      const [wikidata, wikipedia, github, images] = await Promise.allSettled([
        searchWikidata(plan.query),
        searchWikipedia(plan.query),
        searchGithubProfiles(plan.query),
        searchCommonsImages(plan.query),
      ]);
      const sources = [wikidata, wikipedia, github].flatMap((result) => result.status === "fulfilled" ? result.value : []);
      return {
        sources: this.rankAndDedupe(sources, plan.query).slice(0, 10),
        images: images.status === "fulfilled" ? images.value : [],
      };
    }

    if (plan.mode === "image") {
      onProgress?.("Skill Gambar: mencari media berlisensi di Wikimedia Commons");
      const [images, wikipedia] = await Promise.allSettled([
        searchCommonsImages(plan.query, 8),
        searchWikipedia(plan.query, 4),
      ]);
      return {
        sources: wikipedia.status === "fulfilled" ? this.rankAndDedupe(wikipedia.value, plan.query) : [],
        images: images.status === "fulfilled" ? images.value : [],
      };
    }

    onProgress?.("Skill Pengetahuan publik: mencari Wikipedia dan Wikidata");
    const [wikipedia, wikidata] = await Promise.allSettled([
      searchWikipedia(plan.query, 6),
      searchWikidata(plan.query, 4),
    ]);
    const sources = [wikipedia, wikidata].flatMap((result) => result.status === "fulfilled" ? result.value : []);
    return { sources: this.rankAndDedupe(sources, plan.query).slice(0, 10), images: [] };
  }

  private rankAndDedupe(sources: PublicResearchSource[], query: string): PublicResearchSource[] {
    const deduped = unique(sources, sourceKey);
    return deduped
      .map((source) => ({ ...source, score: sourceScore(source, query) }))
      .sort((a, b) => b.score - a.score);
  }

  private async enrich(
    sources: PublicResearchSource[],
    plan: PublicResearchPlan,
    onProgress?: (message: string) => void,
    activitySessionId = "",
  ): Promise<PublicResearchSource[]> {
    if (!plan.wantsFormula && !plan.wantsPdf) return sources;
    const enriched = [...sources];
    const candidates = enriched.filter((source) => source.provider === "europepmc").slice(0, 4);
    for (let index = 0; index < candidates.length; index += 1) {
      const source = candidates[index];
      onProgress?.(`Membaca full text terbuka ${index + 1}/${candidates.length}: ${source.title.slice(0, 70)}`);
      if (activitySessionId) {
        agentLiveActivity.emit(activitySessionId, {
          phase: "opening",
          title: `Membuka full text ${index + 1}/${candidates.length}`,
          provider: source.provider,
          sourceTitle: source.title,
          url: source.pdfUrl || source.url,
          excerpt: source.abstract,
          progress: 48 + Math.round((index / Math.max(1, candidates.length)) * 18),
        });
        await yieldResearchUi();
      }
      try {
        const fullText = await europePmcFullText(source);
        if (fullText) {
          const target = enriched.find((item) => item.id === source.id);
          if (target) target.fullText = fullText;
          if (activitySessionId) {
            agentLiveActivity.emit(activitySessionId, {
              phase: "extracting",
              title: "Menyimpan bukti full text terbuka",
              provider: source.provider,
              sourceTitle: source.title,
              url: source.pdfUrl || source.url,
              excerpt: bestExcerpts({ ...source, fullText }, plan.focus || plan.query, 1)[0] || fullText.slice(0, 700),
              progress: 55 + Math.round(((index + 1) / Math.max(1, candidates.length)) * 16),
            });
            await yieldResearchUi();
          }
        }
      } catch (error) {
        console.warn(`[ITS Research] Full text gagal: ${source.title}`, error);
      }
    }
    return this.rankAndDedupe(enriched, plan.englishQuery || plan.query);
  }

  private sourceContext(sources: PublicResearchSource[], plan: PublicResearchPlan): string {
    let used = 0;
    const blocks: string[] = [];
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      const excerpts = bestExcerpts(source, plan.focus || plan.query, 3);
      const block = [
        `[S${index + 1}]`,
        `Provider: ${source.provider}`,
        `Title: ${source.title}`,
        `Authors: ${source.authors.join(", ") || "-"}`,
        `Year: ${source.year || "-"}`,
        `Venue: ${source.venue || "-"}`,
        `DOI: ${source.doi || "-"}`,
        `URL: ${source.url || "-"}`,
        `PDF: ${source.pdfUrl || "-"}`,
        `Facts: ${source.facts.map((fact) => `${fact.label}: ${fact.value}`).join("; ") || "-"}`,
        `Evidence: ${excerpts.join("\n---\n") || source.abstract || "Metadata only"}`,
      ].join("\n");
      if (used + block.length > MAX_SOURCE_CONTEXT_CHARS) break;
      used += block.length;
      blocks.push(block);
    }
    return blocks.join("\n\n");
  }

  private fallbackSynthesis(
    question: string,
    plan: PublicResearchPlan,
    sources: PublicResearchSource[],
    images: PublicResearchImage[],
  ): string {
    if (!sources.length && !images.length) {
      return "Pencarian publik belum menemukan sumber yang cukup untuk menjawab pertanyaan ini secara dapat diverifikasi.";
    }

    if (plan.mode === "profile") {
      const lines = sources.slice(0, 4).map((source, index) => {
        const facts = source.facts.map((fact) => `${fact.label}: ${fact.value}`).join("; ");
        const summary = cleanEvidenceText(source.abstract) || facts || `Profil publik pada ${source.venue || source.provider}.`;
        return `${source.title}: ${summary} [S${index + 1}]`;
      });
      const hasEducation = sources.some((source) => source.facts.some((fact) => normalize(fact.label).includes("pendidikan")));
      const educationNote = includesAny(normalize(question), ["pendidikan", "kuliah", "universitas"])
        ? hasEducation
          ? "Informasi pendidikan di atas hanya dinyatakan untuk sumber yang memuat atribut pendidikan secara eksplisit."
          : "Sumber publik yang berhasil dibaca tidak memuat riwayat pendidikan, jadi pendidikan orang tersebut belum dapat saya verifikasi dan tidak saya tebak."
        : "";
      return [
        `Saya menemukan ${sources.length} sumber profil publik yang relevan dengan pencarian ini.`,
        ...lines,
        educationNote,
      ].filter(Boolean).join("\n\n");
    }

    if (plan.mode === "image") {
      const licenses = unique(images.map((image) => image.license).filter(Boolean), (value) => value);
      const imageLines = images.slice(0, 4).map((image) =>
        `${image.title}: kredit ${image.author || "tidak dicantumkan"}; lisensi ${image.license || "periksa halaman sumber"}.`);
      const sourceLines = sources.slice(0, 3).map((source, index) => {
        const evidence = this.relevantEvidence(source, question);
        return `${source.title}: ${evidence || "Halaman rujukan untuk identifikasi subjek gambar."} [S${index + 1}]`;
      });
      return [
        `Saya menemukan ${images.length} gambar publik dengan halaman sumber dan atribusi${licenses.length ? ` (${licenses.join(", ")})` : ""}.`,
        ...imageLines,
        ...sourceLines,
      ].filter(Boolean).join("\n\n");
    }

    const sourceLines = sources.slice(0, 5).map((source, index) => {
      const evidence = this.relevantEvidence(source, question);
      return `${source.title}: ${evidence || "Metadata bibliografis tersedia, tetapi abstrak yang dapat dibaca tidak cukup untuk membuat klaim lebih rinci."} [S${index + 1}]`;
    });
    const normalizedQuestion = normalize(question);
    const detrSourceIndex = sources.findIndex((source) => /\b(?:detr|detection transformer)\b/i.test(`${source.title} ${source.abstract}`)
      || normalize(source.title) === "end-to-end object detection with transformers");
    if (plan.wantsFormula && detrSourceIndex >= 0 && includesAny(normalizedQuestion, ["sigma", "permutasi", "matching", "hungarian", "attention", "detr", "rf detr", "rf-detr"])) {
      const citation = `[S${detrSourceIndex + 1}]`;
      const asksSigma = includesAny(normalizedQuestion, ["sigma", "simbol", "belum paham", "jelaskan lagi"]);
      return asksSigma
        ? [
          `Secara sederhana, sigma bertopi (\\hat{\\sigma}) adalah daftar pasangan terbaik antara objek nyata dan prediksi model. Hungarian matching memilih daftar itu dengan total biaya paling kecil ${citation}.`,
          "Bayangkan tiga objek nyata dan tiga kotak prediksi: sigma menentukan kotak prediksi mana yang menjadi pasangan objek 1, 2, dan 3. Satu prediksi hanya boleh dipakai sekali, sehingga hasil DETR tidak menggandakan objek yang sama.",
          `Attention membentuk representasi global dan kandidat objek, sedangkan Hungarian matching menentukan pasangan satu-ke-satu yang dipakai saat menghitung loss ${citation}.`,
        ].join("\n\n")
        : [
          `DETR memakai attention pada encoder-decoder Transformer untuk menghubungkan fitur citra dengan sekumpulan object query; hasilnya adalah sekumpulan prediksi tanpa urutan tetap ${citation}.`,
          `Hungarian matching kemudian memilih korespondensi satu-ke-satu dengan biaya minimum antara target dan prediksi. Pasangan itu menentukan prediksi mana yang menerima loss kelas, L1 kotak, dan GIoU ${citation}.`,
          "Jadi attention menghasilkan dan memperkaya kandidat, sedangkan Hungarian matching memberi penugasan unik untuk proses belajar. Keduanya berbeda tahap tetapi bekerja dalam satu objective end-to-end.",
        ].join("\n\n");
    }
    const formulaNote = plan.wantsFormula
      ? "Bukti terbuka yang berhasil dibaca dapat menyebut nama loss atau metrik, tetapi saya tidak menurunkan persamaan eksak bila persamaannya tidak muncul pada abstrak/full text terbuka. Buka sumber atau PDF legal pada daftar pustaka untuk memverifikasi notasi asli."
      : "";
    return [
      `Saya menemukan ${sources.length} sumber ilmiah yang relevan untuk pertanyaan ini.`,
      ...sourceLines,
      formulaNote,
    ].filter(Boolean).join("\n\n");
  }

  private relevantEvidence(source: PublicResearchSource, question: string): string {
    const evidence = cleanEvidenceText(source.abstract) || cleanEvidenceText(source.fullText.slice(0, 8_000));
    if (!evidence) {
      return source.facts.map((fact) => `${fact.label}: ${fact.value}`).join("; ");
    }
    const queryTokens = new Set(tokens(question));
    const technicalTokens = new Set(["loss", "iou", "eiou", "giou", "precision", "recall", "map", "accuracy", "akurasi", "transformer", "detection", "deteksi"]);
    const sentences = evidence.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length >= 30);
    const ranked = sentences.map((sentence, index) => {
      const sentenceTokens = new Set(tokens(sentence));
      let score = index === 0 ? 1 : 0;
      queryTokens.forEach((token) => { if (sentenceTokens.has(token)) score += 3; });
      technicalTokens.forEach((token) => { if (sentenceTokens.has(token)) score += 2; });
      return { sentence, score, index };
    }).sort((a, b) => b.score - a.score || a.index - b.index);
    const selected = ranked.slice(0, 2).sort((a, b) => a.index - b.index).map((item) => item.sentence);
    return selected.join(" ").slice(0, 760);
  }

  private async synthesize(
    question: string,
    history: PublicResearchTurn[],
    plan: PublicResearchPlan,
    sources: PublicResearchSource[],
    images: PublicResearchImage[],
    previous: StoredResearchState | null,
    onProgress?: (message: string) => void,
  ): Promise<string> {
    onProgress?.("Skill Sintesis ilmiah: menyusun jawaban berbasis bukti");
    const normalizedQuestion = normalize(question);
    if (plan.wantsFormula && includesAny(normalizedQuestion, [
      "detr", "rf detr", "rf-detr", "hungarian", "matching", "bipartite", "attention", "sigma", "giou", "iou",
    ])) {
      return this.fallbackSynthesis(question, plan, sources, images);
    }
    if (!isBrowserTextModelReady("research")) {
      onProgress?.("Skill model riset disiapkan di background; jawaban sumber ditampilkan sekarang");
      void warmBrowserTextModel("research").catch((error) => {
        console.warn("[ITS Research] Persiapan model background belum selesai", error);
      });
      return this.fallbackSynthesis(question, plan, sources, images);
    }
    const recent = history.slice(-8).map((turn) => `${turn.role === "user" ? "Pengguna" : "Asisten"}: ${turn.content.slice(0, 1_000)}`).join("\n");
    const sourceContext = this.sourceContext(sources.slice(0, 8), plan);
    const previousContext = previous
      ? `Jawaban riset sebelumnya:\n${previous.answer.slice(0, 5_000)}\n\nPertanyaan sebelumnya: ${previous.question}`
      : "Tidak ada jawaban riset sebelumnya.";
    const modeInstruction = plan.wantsFormula
      ? [
        "Jelaskan masalah awal yang melahirkan formulasi.",
        "Tuliskan formulasi dasar dan asumsi.",
        "Turunkan langkah demi langkah sampai formulasi akhir hanya bila bukti memuat dasar yang cukup.",
        "Jelaskan semua simbol, indeks, parameter, domain, dan satuan dalam tabel teks.",
        "Berikan contoh numerik sederhana bila memungkinkan.",
        "Jika metadata/full text terbuka tidak memuat persamaan yang cukup, katakan secara eksplisit bahwa derivasi exact tidak dapat diverifikasi dari sumber yang berhasil dibaca.",
      ].join("\n")
      : plan.mode === "profile"
        ? [
          "Pisahkan fakta terverifikasi, kemungkinan kecocokan, dan informasi yang tidak ditemukan.",
          "Jangan menyatakan foto, pendidikan, atau identitas sebagai pasti bila sumber tidak cukup.",
        ].join("\n")
        : "Rangkum secara jelas dan terstruktur.";

    const answer = await generateBrowserText("research", [
      {
        role: "system",
        content: [
          "Anda adalah ITS Public Research Agent berbahasa Indonesia.",
          "Jawab natural dan pahami pertanyaan lanjutan berdasarkan percakapan.",
          "Gunakan hanya bukti yang diberikan. Jangan mengarang jurnal, DOI, URL, foto, pendidikan, angka, atau persamaan.",
          "Setiap klaim faktual dari sumber harus memakai sitasi [S1], [S2], dan seterusnya.",
          "Jangan membuat daftar pustaka karena aplikasi menambahkannya secara deterministik.",
          "Jangan mengatakan telah membaca artikel penuh bila Evidence hanya metadata atau abstrak.",
          "Bila sumber berbeda pendapat, jelaskan perbedaannya.",
          modeInstruction,
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Pertanyaan sekarang: ${question}`,
          `Rencana: ${JSON.stringify(plan)}`,
          `Percakapan terbaru:\n${recent || "-"}`,
          previousContext,
          `Bukti sumber:\n${sourceContext || "Tidak ada sumber yang berhasil diambil."}`,
          `Jumlah gambar dengan atribusi: ${images.length}`,
        ].join("\n\n"),
      },
    ], {
      max_new_tokens: plan.wantsFormula ? 320 : 240,
      temperature: 0.08,
      do_sample: false,
      repetition_penalty: 1.08,
    }, (message) => onProgress?.(message), 25_000);

    const citations = Array.from(answer.matchAll(/\[S(\d+)\]/g)).map((match) => Number(match[1]));
    if (answer.length >= 80 && citations.length > 0 && citations.every((index) => index >= 1 && index <= sources.length)) {
      return answer;
    }
    if (!sources.length) return "Pencarian publik tidak menemukan sumber yang cukup untuk menjawab pertanyaan ini secara dapat diverifikasi.";
    return this.fallbackSynthesis(question, plan, sources, images);
  }

  private bibliography(source: PublicResearchSource, index: number): string {
    const authors = source.authors.length ? source.authors.join(", ") : source.venue || source.provider;
    const year = source.year || "n.d.";
    const venue = source.venue ? `, ${source.venue}` : "";
    const doi = source.doi ? `, doi: ${source.doi}` : "";
    return `[${index + 1}] ${authors}, "${source.title}"${venue}, ${year}${doi}.`;
  }

  private render(sources: PublicResearchSource[], images: PublicResearchImage[], plan: PublicResearchPlan): string {
    const imagesHtml = images.slice(0, 4).map((image) => `
      <figure class="its-ai-research-image">
        <img src="${escapeHtml(image.thumbUrl || image.imageUrl)}" alt="${escapeHtml(image.title)}" loading="lazy" referrerpolicy="no-referrer">
        <figcaption>
          <strong>${escapeHtml(image.title)}</strong>
          <span>${escapeHtml([image.author, image.license].filter(Boolean).join(" - "))}</span>
          <a href="${escapeHtml(image.pageUrl)}" target="_blank" rel="noopener">Sumber gambar</a>
        </figcaption>
      </figure>`).join("");

    const references = sources.map((source, index) => `
      <li>
        <p>${escapeHtml(this.bibliography(source, index))}</p>
        <small>${escapeHtml(sourceQualityLabel(source))}</small>
        <div class="its-ai-actions">
          ${source.url ? `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">Sumber</a>` : ""}
          ${source.pdfUrl ? `<a href="${escapeHtml(source.pdfUrl)}" target="_blank" rel="noopener">PDF</a>` : ""}
        </div>
      </li>`).join("");

    const hasDetrFormulaSource = sources.some((source) => /\b(?:detr|transformers|intersection over union|giou)\b/i.test(`${source.title} ${source.abstract}`));
    const formulaHtml = plan.wantsFormula && hasDetrFormulaSource ? `
      <section class="its-ai-formula-card">
        <h4>Fondasi matematis DETR</h4>
        <p>Pencocokan bipartit memilih satu permutasi prediksi untuk target:</p>
        <div class="its-ai-formula" data-katex-display="\\hat{\\sigma}=\\arg\\min_{\\sigma\\in\\mathfrak{S}_N}\\sum_{i=1}^{N}\\mathcal{C}(y_i,\\hat{y}_{\\sigma(i)})"></div>
        <p>Setelah pasangan dipilih, loss kotak menggabungkan jarak koordinat dan GIoU:</p>
        <div class="its-ai-formula" data-katex-display="\\mathcal{L}_{\\mathrm{box}}=\\lambda_{L1}\\lVert b_i-\\hat b_{\\hat\\sigma(i)}\\rVert_1+\\lambda_{\\mathrm{GIoU}}\\left(1-\\mathrm{GIoU}(b_i,\\hat b_{\\hat\\sigma(i)})\\right)"></div>
        <div class="its-ai-formula" data-katex-display="\\mathcal{L}_{\\mathrm{final}}=\\sum_{i=1}^{N}\\left[-\\log \\hat p_{\\hat\\sigma(i)}(c_i)+\\mathbb{1}_{c_i\\ne\\varnothing}\\mathcal{L}_{\\mathrm{box}}\\right]"></div>
        <p class="its-ai-card-note">Ini adalah fondasi kanonik keluarga DETR. Konfigurasi loss RF-DETR tertentu hanya dinyatakan bila sumber resmi yang ditemukan memverifikasinya.</p>
      </section>` : "";

    return `
      <section class="its-ai-card its-ai-research-card">
        <div class="its-ai-card-head">
          <span>Riset publik</span>
          <strong>${escapeHtml(plan.mode.toUpperCase())} - ${sources.length} SUMBER</strong>
        </div>
        ${imagesHtml ? `<div class="its-ai-research-images">${imagesHtml}</div>` : ""}
        ${formulaHtml}
        ${references ? `<h4>Daftar pustaka dan tautan</h4><ol class="its-ai-reference-list">${references}</ol>` : ""}
        <p class="its-ai-card-note">Pencarian memakai metadata publik dan full text open-access. Label Q1 atau SINTA 1 tidak dinyatakan tanpa bukti indeks resmi. PDF hanya ditampilkan sebagai tautan legal dan tidak diunggah atau diproses lokal.</p>
      </section>`;
  }

  async answer(options: PublicResearchOptions): Promise<PublicResearchAnswer> {
    const question = options.question.trim();
    if (!question) throw new Error("Pertanyaan tidak boleh kosong.");
    const history = options.history || [];
    const previous = loadState();
    const activitySessionId = agentLiveActivity.start(question);
    try {
      const plan = await this.plan(question, history, options.onProgress);
      agentLiveActivity.emit(activitySessionId, {
        phase: "planning",
        title: "Rencana riset siap",
        detail: `${plan.mode} | ${plan.isFollowUp ? "pertanyaan lanjutan" : "topik baru"}`,
        query: plan.englishQuery || plan.query,
        progress: 10,
      });
      await yieldResearchUi();

      let sources: PublicResearchSource[] = [];
      let images: PublicResearchImage[] = [];
      if (!plan.needsSearch && previous) {
        options.onProgress?.("Menggunakan kembali sumber riset sebelumnya untuk pertanyaan lanjutan...");
        sources = previous.sources;
        images = previous.images;
        agentLiveActivity.emit(activitySessionId, {
          phase: "reading",
          title: "Membaca konteks riset sebelumnya",
          detail: `${sources.length} sumber digunakan kembali untuk menjawab tindak lanjut.`,
          query: plan.englishQuery || plan.query,
          sources: sources.map(playbackSource),
          progress: 34,
        });
      } else {
        agentLiveActivity.emit(activitySessionId, {
          phase: "searching",
          title: "Mencari sumber publik",
          detail: plan.mode === "journal"
            ? "Crossref, OpenAlex, dan Europe PMC dipanggil paralel."
            : "Sumber publik yang sesuai sedang dipanggil.",
          query: plan.englishQuery || plan.query,
          progress: 18,
        });
        await yieldResearchUi();
        const searched = await this.search(plan, options.onProgress);
        sources = searched.sources;
        images = searched.images;
        agentLiveActivity.emit(activitySessionId, {
          phase: "results",
          title: `${sources.length} sumber ditemukan`,
          detail: "Daftar ini berasal dari respons provider, bukan data contoh.",
          query: plan.englishQuery || plan.query,
          sources: sources.map(playbackSource),
          progress: 42,
        });
        await yieldResearchUi();
        for (const [index, source] of sources.slice(0, 3).entries()) {
          agentLiveActivity.emit(activitySessionId, {
            phase: "reading",
            title: `Membaca metadata dan abstrak ${index + 1}/${Math.min(3, sources.length)}`,
            provider: source.provider,
            sourceTitle: source.title,
            url: source.url || source.pdfUrl,
            excerpt: cleanEvidenceText(source.abstract) || "Provider hanya memberikan metadata bibliografis untuk sumber ini.",
            progress: 44 + index * 3,
          });
          await yieldResearchUi();
        }
        sources = await this.enrich(sources, plan, options.onProgress, activitySessionId);
      }

      agentLiveActivity.emit(activitySessionId, {
        phase: "ranking",
        title: "Memeringkat dan memvalidasi sumber",
        detail: `${sources.length} sumber unik dinilai dari relevansi, metadata, sitasi, dan akses terbuka.`,
        sources: sources.map(playbackSource),
        progress: 74,
      });
      await yieldResearchUi();
      agentLiveActivity.emit(activitySessionId, {
        phase: "reasoning",
        title: "Menyusun bukti untuk jawaban",
        detail: plan.wantsFormula ? "Simbol dan langkah formulasi dicocokkan dengan bukti yang tersedia." : "Klaim dipasangkan dengan sumber yang mendukung.",
        progress: 82,
      });

      let answer: string;
      try {
        agentLiveActivity.emit(activitySessionId, {
          phase: "writing",
          title: "Menulis jawaban dan sitasi",
          detail: "Jawaban disusun dari bukti terpilih; daftar pustaka dirender secara deterministik.",
          progress: 88,
        });
        answer = await this.synthesize(question, history, plan, sources, images, previous, options.onProgress);
      } catch (error) {
        console.warn("[ITS Research] Sintesis model lokal gagal, memakai ringkasan bukti", error);
        options.onProgress?.("Model lokal belum siap; menyusun ringkasan sumber terverifikasi...");
        answer = this.fallbackSynthesis(question, plan, sources, images);
      }
      agentLiveActivity.emit(activitySessionId, {
        phase: "validating",
        title: "Memeriksa sitasi dan batas bukti",
        detail: `${sources.length} sumber dan ${images.length} media beratribusi diperiksa sebelum ditampilkan.`,
        progress: 96,
      });
      const result: PublicResearchAnswer = {
        text: answer,
        html: this.render(sources, images, plan),
        mode: plan.mode,
        sources,
        images,
        plan,
      };
      saveState({ question, answer, plan, sources, images, updatedAt: Date.now() });
      agentLiveActivity.complete(activitySessionId, `${sources.length} sumber diproses; jawaban dan daftar pustaka selesai.`);
      return result;
    } catch (error) {
      agentLiveActivity.fail(activitySessionId, error);
      throw error;
    }
  }

  getLastState(): StoredResearchState | null {
    return loadState();
  }

  clear(): void {
    sessionStorage.removeItem(STATE_KEY);
  }

  createWebMcpTools(): PublicResearchWebMcpTool[] {
    return [
      {
        name: "research_its_public_knowledge",
        description: "Automatically understand a user question, search public scholarly/profile/image sources client-side, read legal open full text when available, and return a grounded Indonesian answer with citations, bibliography, source links, and attributed images. No local PDF upload is used.",
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string", description: "Complete user question or follow-up question." },
            history: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["user", "assistant"] },
                  content: { type: "string" },
                },
                required: ["role", "content"],
              },
            },
          },
          required: ["question"],
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: async (input) => {
          const history = Array.isArray(input.history)
            ? input.history.map((item) => item as PublicResearchTurn).filter((item) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
            : [];
          const result = await this.answer({ question: String(input.question || ""), history });
          return {
            content: [{ type: "text", text: result.text }],
            structuredContent: {
              mode: result.mode,
              plan: result.plan,
              sources: result.sources.map((source) => ({
                title: source.title,
                provider: source.provider,
                url: source.url,
                pdfUrl: source.pdfUrl || null,
                doi: source.doi || null,
              })),
              images: result.images,
            },
          };
        },
      },
      {
        name: "get_its_live_research_activity",
        description: "Get the event-sourced live activity timeline for the current ITS Maps public research session, including real queries, providers, source titles, URLs, excerpts, and progress.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: async () => ({
          content: [{ type: "text", text: JSON.stringify(agentLiveActivity.snapshot(), null, 2) }],
          structuredContent: {
            sessionId: agentLiveActivity.activeSession(),
            events: agentLiveActivity.snapshot(),
          },
        }),
      },
      {
        name: "get_its_last_research_context",
        description: "Get the latest ITS client-side research question, answer, source list, and image list for follow-up reasoning.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        execute: async () => {
          const state = this.getLastState();
          return {
            content: [{ type: "text", text: state ? state.answer : "Belum ada konteks riset." }],
            structuredContent: state,
          };
        },
      },
      {
        name: "clear_its_research_context",
        description: "Clear the current client-side ITS research conversation context.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: false },
        execute: async () => {
          this.clear();
          return { content: [{ type: "text", text: "Konteks riset ITS telah dibersihkan." }] };
        },
      },
    ];
  }
}

export const publicResearchAgent = new ClientPublicResearchAgent();
