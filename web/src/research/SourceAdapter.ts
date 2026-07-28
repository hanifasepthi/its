import { sourceRegistry, type SourceProviderManifest } from "./SourceRegistry";
import type { ResearchPlan, ResearchQuerySpec, ResearchSource } from "./ResearchTypes";
import { anchorVariants, entityText, retrievalTokens, technicalAnchors } from "./ResearchText";

type JsonRecord = Record<string, any>;

const RESULT_LIMIT = 12;
const REQUEST_TIMEOUT = 14_000;

function compactText(value: unknown, maximum = 24_000): string {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => compactText(item, 200)).filter(Boolean);
}

function sourceId(provider: string, value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${provider}-${(hash >>> 0).toString(36)}`;
}

function linkedSignal(parent: AbortSignal | undefined, timeoutMs = REQUEST_TIMEOUT): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(new DOMException("Batas waktu sumber terlewati.", "TimeoutError")), timeoutMs);
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      window.clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
    },
  };
}

async function fetchJson(url: URL, signal?: AbortSignal): Promise<JsonRecord> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const linked = linkedSignal(signal);
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: linked.signal });
      if (response.ok) return await response.json() as JsonRecord;
      if (attempt === 2 || (response.status !== 429 && response.status < 500)) {
        throw new Error(`${url.hostname} HTTP ${response.status}`);
      }
    } finally {
      linked.cleanup();
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(resolve, 450 * (attempt + 1));
      signal?.addEventListener("abort", () => {
        window.clearTimeout(timeout);
        reject(signal.reason);
      }, { once: true });
    });
  }
  throw new Error(`${url.hostname} tidak mengembalikan JSON.`);
}

async function fetchText(url: URL, accept: string, signal?: AbortSignal): Promise<string> {
  const linked = linkedSignal(signal);
  try {
    const response = await fetch(url, { headers: { Accept: accept }, signal: linked.signal });
    if (!response.ok) throw new Error(`${url.hostname} HTTP ${response.status}`);
    return await response.text();
  } finally {
    linked.cleanup();
  }
}

function baseSource(provider: string, values: Partial<ResearchSource> & Pick<ResearchSource, "title" | "url">): ResearchSource {
  const key = values.doi || values.url || values.title;
  return {
    id: sourceId(provider, key.toLowerCase()),
    provider,
    title: compactText(values.title, 500),
    authors: values.authors || [],
    year: compactText(values.year, 12),
    venue: compactText(values.venue, 300),
    doi: compactText(values.doi, 200),
    url: values.url,
    pdfUrl: values.pdfUrl || "",
    abstract: compactText(values.abstract),
    citationCount: Math.max(0, Number(values.citationCount) || 0),
    license: compactText(values.license, 120),
    imageUrl: values.imageUrl || "",
    imageSourceUrl: values.imageSourceUrl || "",
    status: values.abstract ? "abstract" : "metadata-only",
    accessNote: values.accessNote || "",
    score: Number(values.score) || 0,
    retrievedAt: Date.now(),
  };
}

function dateYear(value: unknown): string {
  if (!Array.isArray(value) || !Array.isArray(value[0])) return "";
  return compactText(value[0][0], 8);
}

async function searchCrossref(query: string, signal?: AbortSignal): Promise<ResearchSource[]> {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.bibliographic", query);
  url.searchParams.set("rows", String(RESULT_LIMIT));
  url.searchParams.set("select", "DOI,title,author,published-print,published-online,container-title,URL,abstract,is-referenced-by-count,link,license,type");
  const payload = await fetchJson(url, signal);
  const items = Array.isArray(payload.message?.items) ? payload.message.items : [];
  return items.map((item: JsonRecord) => {
    const links = Array.isArray(item.link) ? item.link : [];
    const pdf = links.find((link: JsonRecord) => String(link["content-type"] || "").includes("pdf"))?.URL || "";
    const doi = compactText(item.DOI, 200);
    return baseSource("crossref", {
      title: strings(item.title)[0] || doi || "Crossref record",
      authors: (Array.isArray(item.author) ? item.author : []).map((author: JsonRecord) => compactText(`${author.given || ""} ${author.family || ""}`, 200)).filter(Boolean),
      year: dateYear(item["published-print"]?.["date-parts"]) || dateYear(item["published-online"]?.["date-parts"]),
      venue: strings(item["container-title"])[0] || compactText(item.type, 120),
      doi,
      url: compactText(item.URL, 2_000) || (doi ? `https://doi.org/${doi}` : ""),
      pdfUrl: compactText(pdf, 2_000),
      abstract: compactText(item.abstract),
      citationCount: Number(item["is-referenced-by-count"]) || 0,
      license: compactText(item.license?.[0]?.URL, 300),
    });
  }).filter((source: ResearchSource) => Boolean(source.title && source.url));
}

function openAlexAbstract(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const words: Array<[number, string]> = [];
  Object.entries(value as Record<string, unknown>).forEach(([word, positions]) => {
    if (!Array.isArray(positions)) return;
    positions.forEach((position) => {
      const numeric = Number(position);
      if (Number.isFinite(numeric)) words.push([numeric, word]);
    });
  });
  return compactText(words.sort((left, right) => left[0] - right[0]).map((entry) => entry[1]).join(" "));
}

async function searchOpenAlex(query: string, signal?: AbortSignal): Promise<ResearchSource[]> {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query);
  url.searchParams.set("per-page", String(RESULT_LIMIT));
  url.searchParams.set("mailto", "opensource@itstelkom.web.app");
  const payload = await fetchJson(url, signal);
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.map((item: JsonRecord) => {
    const primary = item.primary_location || {};
    const best = item.best_oa_location || {};
    const doi = compactText(item.doi, 300).replace(/^https?:\/\/doi\.org\//i, "");
    return baseSource("openalex", {
      title: compactText(item.display_name, 500) || doi || "OpenAlex record",
      authors: (Array.isArray(item.authorships) ? item.authorships : []).map((entry: JsonRecord) => compactText(entry.author?.display_name, 200)).filter(Boolean),
      year: compactText(item.publication_year, 8),
      venue: compactText(primary.source?.display_name || best.source?.display_name || item.type, 300),
      doi,
      url: compactText(primary.landing_page_url || best.landing_page_url || item.doi || item.id, 2_000),
      pdfUrl: compactText(best.pdf_url || primary.pdf_url, 2_000),
      abstract: openAlexAbstract(item.abstract_inverted_index),
      citationCount: Number(item.cited_by_count) || 0,
      license: compactText(best.license || primary.license, 120),
    });
  }).filter((source: ResearchSource) => Boolean(source.title && source.url));
}

async function searchHuggingFacePapers(query: string, signal?: AbortSignal): Promise<ResearchSource[]> {
  const url = new URL("https://huggingface.co/api/papers/search");
  url.searchParams.set("q", query);
  const payload = await fetchJson(url, signal);
  const results = Array.isArray(payload) ? payload.slice(0, RESULT_LIMIT) : [];
  return results.map((entry: JsonRecord) => {
    const paper = entry.paper || entry;
    const arxivId = compactText(paper.id, 80);
    const publishedAt = compactText(paper.publishedAt, 40);
    return baseSource("huggingface-papers", {
      title: compactText(paper.title, 500) || arxivId || "Hugging Face paper",
      authors: (Array.isArray(paper.authors) ? paper.authors : [])
        .map((author: JsonRecord) => compactText(author.name || author.user?.fullname, 200))
        .filter(Boolean),
      year: publishedAt.slice(0, 4),
      venue: "Hugging Face Papers / arXiv",
      doi: compactText(paper.doi, 200),
      url: arxivId ? `https://huggingface.co/papers/${arxivId}` : "https://huggingface.co/papers",
      pdfUrl: arxivId ? `https://arxiv.org/pdf/${encodeURIComponent(arxivId)}` : "",
      abstract: compactText(paper.summary || paper.abstract),
      license: compactText(paper.license, 120),
      accessNote: "Metadata dan abstrak publik dari Hugging Face Papers.",
    });
  }).filter((source: ResearchSource) => Boolean(source.title && source.abstract));
}

async function searchEuropePmc(query: string, signal?: AbortSignal): Promise<ResearchSource[]> {
  const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("resultType", "core");
  url.searchParams.set("pageSize", String(RESULT_LIMIT));
  const payload = await fetchJson(url, signal);
  const results = Array.isArray(payload.resultList?.result) ? payload.resultList.result : [];
  return results.map((item: JsonRecord) => {
    const doi = compactText(item.doi, 200);
    const pmcid = compactText(item.pmcid, 100);
    const urlValue = doi ? `https://doi.org/${doi}` : pmcid ? `https://europepmc.org/articles/${pmcid}` : `https://europepmc.org/article/${compactText(item.source, 50)}/${compactText(item.id, 100)}`;
    return baseSource("europepmc", {
      title: compactText(item.title, 500) || doi || "Europe PMC record",
      authors: strings((Array.isArray(item.authorList?.author) ? item.authorList.author : [])
        .map((author: JsonRecord) => author.fullName)),
      year: compactText(item.pubYear, 8),
      venue: compactText(item.journalInfo?.journal?.title || item.journalTitle, 300),
      doi,
      url: urlValue,
      // The Europe PMC PDF renderer does not expose CORS headers to browser
      // clients. Keep the public landing page and abstract instead of issuing a
      // request that the browser will always block.
      pdfUrl: "",
      abstract: compactText(item.abstractText),
      citationCount: Number(item.citedByCount) || 0,
      license: compactText(item.license, 120),
    });
  }).filter((source: ResearchSource) => Boolean(source.title && source.url));
}

async function searchWikipedia(query: string, signal?: AbortSignal): Promise<ResearchSource[]> {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  Object.entries({
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrlimit: String(RESULT_LIMIT),
    prop: "extracts|info|pageimages",
    exintro: "1",
    explaintext: "1",
    inprop: "url",
    piprop: "original|thumbnail",
    pithumbsize: "900",
    format: "json",
    origin: "*",
  }).forEach(([key, value]) => url.searchParams.set(key, value));
  const payload = await fetchJson(url, signal);
  const pages = Object.values(payload.query?.pages || {}) as JsonRecord[];
  return pages.map((page) => baseSource("wikipedia", {
    title: compactText(page.title, 500),
    url: compactText(page.fullurl, 2_000),
    abstract: compactText(page.extract),
    venue: "Wikipedia",
    license: "CC BY-SA 4.0",
    imageUrl: compactText(page.original?.source || page.thumbnail?.source, 2_000),
    imageSourceUrl: compactText(page.fullurl, 2_000),
  })).filter((source) => Boolean(source.title && source.url));
}

async function searchCommons(query: string, signal?: AbortSignal): Promise<ResearchSource[]> {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  Object.entries({
    action: "query",
    generator: "search",
    gsrnamespace: "6",
    gsrsearch: query,
    gsrlimit: String(RESULT_LIMIT),
    prop: "imageinfo",
    iiprop: "url|extmetadata",
    iiurlwidth: "1200",
    format: "json",
    origin: "*",
  }).forEach(([key, value]) => url.searchParams.set(key, value));
  const payload = await fetchJson(url, signal);
  const pages = Object.values(payload.query?.pages || {}) as JsonRecord[];
  return pages.map((page) => {
    const image = Array.isArray(page.imageinfo) ? page.imageinfo[0] : {};
    const meta = image.extmetadata || {};
    return baseSource("wikimedia", {
      title: compactText(meta.ObjectName?.value || page.title, 500),
      url: compactText(image.descriptionurl, 2_000),
      abstract: compactText(meta.ImageDescription?.value || meta.Categories?.value),
      venue: "Wikimedia Commons",
      license: compactText(meta.LicenseShortName?.value || meta.UsageTerms?.value, 120),
      imageUrl: compactText(image.thumburl || image.url, 2_000),
      imageSourceUrl: compactText(image.descriptionurl, 2_000),
    });
  }).filter((source) => Boolean(source.imageUrl && source.url));
}

async function searchArxiv(query: string, signal?: AbortSignal): Promise<ResearchSource[]> {
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("search_query", `all:${query}`);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", String(RESULT_LIMIT));
  const linked = linkedSignal(signal);
  try {
    const response = await fetch(url, { headers: { Accept: "application/atom+xml" }, signal: linked.signal });
    if (!response.ok) throw new Error(`arXiv HTTP ${response.status}`);
    const xml = new DOMParser().parseFromString(await response.text(), "application/xml");
    return [...xml.querySelectorAll("entry")].map((entry) => {
      const identifier = compactText(entry.querySelector("id")?.textContent, 500);
      const pdfUrl = [...entry.querySelectorAll("link")].find((link) => link.getAttribute("type") === "application/pdf")?.getAttribute("href") || "";
      return baseSource("arxiv", {
        title: compactText(entry.querySelector("title")?.textContent, 500),
        authors: [...entry.querySelectorAll("author > name")].map((node) => compactText(node.textContent, 200)).filter(Boolean),
        year: compactText(entry.querySelector("published")?.textContent, 4),
        venue: "arXiv",
        url: identifier,
        pdfUrl,
        abstract: compactText(entry.querySelector("summary")?.textContent),
        license: compactText(entry.querySelector("license")?.getAttribute("href"), 200),
      });
    }).filter((source) => Boolean(source.title && source.url));
  } finally {
    linked.cleanup();
  }
}

async function searchWikidata(query: string, signal?: AbortSignal): Promise<ResearchSource[]> {
  const url = new URL("https://www.wikidata.org/w/api.php");
  Object.entries({
    action: "wbsearchentities",
    search: query,
    language: navigator.language.split("-")[0] || "en",
    uselang: navigator.language.split("-")[0] || "en",
    type: "item",
    limit: String(RESULT_LIMIT),
    format: "json",
    origin: "*",
  }).forEach(([key, value]) => url.searchParams.set(key, value));
  const payload = await fetchJson(url, signal);
  const results = Array.isArray(payload.search) ? payload.search : [];
  return results.map((item: JsonRecord) => baseSource("wikidata", {
    title: compactText(item.label || item.id, 500),
    url: compactText(item.concepturi || `https://www.wikidata.org/wiki/${item.id}`, 2_000),
    abstract: compactText(item.description, 2_000),
    venue: "Wikidata",
    license: "CC0-1.0",
  })).filter((source: ResearchSource) => Boolean(source.title && source.url));
}

async function searchGithub(query: string, signal?: AbortSignal): Promise<ResearchSource[]> {
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", String(RESULT_LIMIT));
  const payload = await fetchJson(url, signal);
  const results = Array.isArray(payload.items) ? payload.items : [];
  return results.map((item: JsonRecord) => baseSource("github", {
    title: compactText(item.full_name || item.name, 500),
    url: compactText(item.html_url, 2_000),
    abstract: compactText(item.description, 4_000),
    venue: "GitHub",
    license: compactText(item.license?.spdx_id, 120),
    citationCount: Number(item.stargazers_count) || 0,
  })).filter((source: ResearchSource) => Boolean(source.title && source.url));
}

function youtubeVideoId(value: string): string {
  try {
    const url = new URL(value.replaceAll("&amp;", "&"));
    if (/^(?:www\.)?youtu\.be$/i.test(url.hostname)) return url.pathname.split("/").filter(Boolean)[0] || "";
    if (/^(?:www\.)?youtube(?:-nocookie)?\.com$/i.test(url.hostname)) {
      if (url.pathname === "/watch") return url.searchParams.get("v") || "";
      const parts = url.pathname.split("/").filter(Boolean);
      if (["embed", "shorts", "live"].includes(parts[0] || "")) return parts[1] || "";
    }
  } catch {
    return "";
  }
  return "";
}

async function searchGithubReadmeVideos(query: string, signal?: AbortSignal): Promise<ResearchSource[]> {
  const repositories = await searchGithub(`${query} in:name,description`, signal);
  const anchor = technicalSearchTopic(query).toLocaleLowerCase();
  const ranked = [...repositories].sort((left, right) => {
    const score = (source: ResearchSource) => {
      const name = source.title.toLocaleLowerCase();
      if (name.endsWith(`/${anchor}`)) return 3;
      if (name.includes(anchor)) return 2;
      return source.abstract.toLocaleLowerCase().includes(anchor) ? 1 : 0;
    };
    return score(right) - score(left) || right.citationCount - left.citationCount;
  });
  for (const repository of ranked.slice(0, 3)) {
    const match = repository.url.match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/i);
    if (!match) continue;
    const readmeUrl = new URL(`https://api.github.com/repos/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}/readme`);
    try {
      const markdown = await fetchText(readmeUrl, "application/vnd.github.raw+json", signal);
      // Parse every Markdown URL first, then let the URL parser decide whether
      // it is a supported YouTube form. This handles image-link wrappers and
      // query-string ordering without an increasingly brittle mega-regex.
      const links = [...markdown.matchAll(/https?:\/\/[^\s)"'<]+/gi)]
        .filter((entry) => Boolean(youtubeVideoId(entry[0].replace(/[.,;]+$/, ""))));
      const seen = new Set<string>();
      const videos: ResearchSource[] = [];
      links.forEach((entry) => {
        const id = youtubeVideoId(entry[0].replace(/[.,;]+$/, ""));
        if (!/^[A-Za-z0-9_-]{6,20}$/.test(id) || seen.has(id)) return;
        seen.add(id);
        const contextStart = Math.max(0, (entry.index || 0) - 180);
        const contextEnd = Math.min(markdown.length, (entry.index || 0) + entry[0].length + 180);
        const context = compactText(markdown.slice(contextStart, contextEnd), 500);
        videos.push(baseSource("youtube", {
          title: context.match(/\[!\[([^\]]+)/)?.[1]?.replace(/[-_]+/g, " ") || `Video ${anchor || repository.title}`,
          url: `https://www.youtube.com/watch?v=${id}`,
          venue: `YouTube · ditemukan di README ${repository.title}`,
          abstract: `README repository publik ${repository.title} menautkan video ini. ${context}`,
          license: repository.license,
          accessNote: "Video diputar melalui YouTube IFrame Player resmi. Ringkasan hanya memakai deskripsi README; audio atau transkrip tidak diklaim telah dibaca.",
        }));
      });
      if (videos.length) return videos.slice(0, 4);
    } catch {
      // Continue to the next public repository. A provider failure is not
      // converted into synthetic media evidence.
    }
  }
  return [];
}

function technicalSearchTopic(value: string): string {
  const candidates = value.match(/\b[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)+\b/g) || [];
  const acronym = value.match(/\b[A-Z][A-Z0-9]{2,}\b/g) || [];
  return [...new Set([...candidates, ...acronym])]
    .sort((left, right) => right.length - left.length)[0]
    || value.replace(/\b(?:cari|jelaskan|implementasi|github|paper|video|tentang|tampilkan|putar|sumber|yang|ditemukan|dan|di)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .slice(0, 4)
      .join(" ");
}

async function searchInternetArchive(query: string, signal?: AbortSignal): Promise<ResearchSource[]> {
  const url = new URL("https://archive.org/advancedsearch.php");
  url.searchParams.set("q", query);
  url.searchParams.set("fl[]", "identifier,title,description,creator,date,mediatype,licenseurl");
  url.searchParams.set("rows", String(RESULT_LIMIT));
  url.searchParams.set("output", "json");
  const payload = await fetchJson(url, signal);
  const docs = Array.isArray(payload.response?.docs) ? payload.response.docs : [];
  return docs.map((item: JsonRecord) => {
    const identifier = compactText(item.identifier, 300);
    return baseSource("internet-archive", {
      title: compactText(item.title, 500) || identifier,
      authors: strings(Array.isArray(item.creator) ? item.creator : [item.creator]),
      year: compactText(item.date, 4),
      venue: `Internet Archive · ${compactText(item.mediatype, 80)}`,
      url: `https://archive.org/details/${encodeURIComponent(identifier)}`,
      abstract: compactText(item.description),
      license: compactText(item.licenseurl, 200),
      accessNote: "Media diputar melalui halaman resmi Internet Archive; isi hanya diringkas bila teks/deskripsi berhasil dibaca.",
    });
  }).filter((source: ResearchSource) => Boolean(source.title && source.url));
}

async function searchSearxNg(query: string, signal?: AbortSignal): Promise<ResearchSource[]> {
  const configured = String(import.meta.env.VITE_SEARXNG_ENDPOINT || "").trim();
  if (!configured) return [];
  const url = new URL("/search", configured);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const payload = await fetchJson(url, signal);
  const results = Array.isArray(payload.results) ? payload.results.slice(0, RESULT_LIMIT) : [];
  return results.map((item: JsonRecord) => baseSource("searxng", {
    title: compactText(item.title, 500),
    url: compactText(item.url, 2_000),
    abstract: compactText(item.content, 4_000),
    venue: compactText(item.engine || "SearXNG", 120),
    imageUrl: compactText(item.img_src || item.thumbnail, 2_000),
    imageSourceUrl: compactText(item.url, 2_000),
    accessNote: "Hasil dari instance SearXNG yang dikonfigurasi operator.",
  })).filter((source: ResearchSource) => Boolean(source.title && source.url));
}

async function searchNominatim(query: string, signal?: AbortSignal): Promise<ResearchSource[]> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("namedetails", "1");
  url.searchParams.set("limit", String(RESULT_LIMIT));
  const linked = linkedSignal(signal);
  try {
    const response = await fetch(url, { headers: { Accept: "application/json", "Accept-Language": navigator.language }, signal: linked.signal });
    if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
    const results = await response.json() as JsonRecord[];
    return (Array.isArray(results) ? results : []).map((item) => {
      const osmType = compactText(item.osm_type, 20);
      const osmId = compactText(item.osm_id, 40);
      const prefix = osmType === "node" ? "node" : osmType === "way" ? "way" : "relation";
      return baseSource("openstreetmap", {
        title: compactText(item.display_name, 500),
        url: osmId ? `https://www.openstreetmap.org/${prefix}/${osmId}` : "https://www.openstreetmap.org/",
        abstract: compactText(`${item.type || "place"}; ${item.category || ""}; latitude ${item.lat || ""}; longitude ${item.lon || ""}`, 2_000),
        venue: "OpenStreetMap",
        license: "ODbL-1.0",
      });
    }).filter((source) => Boolean(source.title && source.url));
  } finally {
    linked.cleanup();
  }
}

function directUrls(question: string): ResearchSource[] {
  const matches = question.match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  return [...new Set(matches)].map((value) => {
    const cleaned = value.replace(/[.,;:!?]+$/, "");
    let title = cleaned;
    try {
      const url = new URL(cleaned);
      title = url.hostname.replace(/^www\./, "");
    } catch {
      // Keep the original URL as a transparent title.
    }
    return baseSource("direct", { title, url: cleaned });
  });
}

function sourceTokens(value: string): Set<string> {
  return new Set(retrievalTokens(value));
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

function titleStartsWithAnchor(source: ResearchSource, anchor: string): boolean {
  const title = normalizedAnchorText(source.title);
  const wanted = normalizedAnchorText(anchor);
  return Boolean(wanted) && (title === wanted || title.startsWith(`${wanted} `));
}

function titleDefinesAnchor(source: ResearchSource, anchor: string): boolean {
  const title = source.title.trim().toLocaleLowerCase();
  const variants = [...new Set([
    anchor.trim().toLocaleLowerCase(),
    anchor.trim().toLocaleLowerCase().replace(/[-_.]+/g, " "),
  ])].filter(Boolean);
  return variants.some((wanted) => title === wanted || title.startsWith(`${wanted}:`));
}

function sourceIntroducesAnchor(source: ResearchSource, anchor: string): boolean {
  const abstract = normalizedAnchorText(source.abstract).slice(0, 900);
  const wanted = normalizedAnchorText(anchor).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!wanted || !abstract) return false;
  return new RegExp(`(?:we|this (?:paper|work)(?: we)?) (?:present|propose|introduce)[^.!?]{0,180}${wanted}\\b`).test(abstract)
    || new RegExp(`${wanted}\\b[^.!?]{0,100}(?:is|introduces|proposes)`).test(abstract);
}

function primaryAnchorSource(ranked: ResearchSource[], anchor: string): ResearchSource | undefined {
  return ranked.find((source) => titleDefinesAnchor(source, anchor))
    || ranked.filter((source) => sourceIntroducesAnchor(source, anchor))
      .sort((left, right) => right.citationCount - left.citationCount)[0]
    || ranked.find((source) => titleStartsWithAnchor(source, anchor))
    || ranked.find((source) => containsAnchor(source.title, anchor))
    || ranked.find((source) => containsAnchor(`${source.title} ${source.abstract}`, anchor));
}

function lexicalRelevance(source: ResearchSource, plan: ResearchPlan): { score: number; anchorMatches: number } {
  const actual = sourceTokens(`${source.title} ${source.abstract} ${source.venue}`);
  const queryValues = [
    ...(plan.querySpecs || []).map((query) => query.text),
    ...(plan.queries || []),
    ...(plan.entities || []).map(entityText),
  ].filter(Boolean);
  let best = 0;
  queryValues.forEach((query) => {
    const wanted = sourceTokens(query);
    let overlap = 0;
    wanted.forEach((token) => { if (actual.has(token)) overlap += 1; });
    best = Math.max(best, overlap / Math.max(1, wanted.size));
  });
  const sourceValue = `${source.title} ${source.abstract} ${source.venue}`.toLocaleLowerCase();
  const anchors = anchorVariants(queryValues.join(" "));
  const anchorMatches = anchors.filter((anchor) => sourceValue.includes(anchor)).length;
  return { score: best, anchorMatches };
}

function relevance(source: ResearchSource, plan: ResearchPlan): number {
  const lexical = lexicalRelevance(source, plan);
  return lexical.score * 2.4
    + Math.min(1.2, lexical.anchorMatches * 0.4)
    + Math.min(0.8, Math.log10(source.citationCount + 1) * 0.12)
    + (source.abstract ? 0.35 : 0)
    + (source.pdfUrl ? 0.15 : 0)
    + (source.provider === "direct" ? 1 : 0);
}

function dedupe(plan: ResearchPlan, sources: ResearchSource[]): ResearchSource[] {
  const map = new Map<string, ResearchSource>();
  const requiredAnchors = anchorVariants(`${(plan.queries || []).join(" ")} ${(plan.entities || []).map(entityText).join(" ")}`);
  sources.forEach((source) => {
    const lexical = lexicalRelevance(source, plan);
    if (source.provider !== "direct" && requiredAnchors.length && lexical.anchorMatches === 0) return;
    if (source.provider !== "direct" && !requiredAnchors.length && lexical.score <= 0) return;
    const key = source.doi ? `doi:${source.doi.toLowerCase()}` : source.url.toLowerCase().replace(/[?#].*$/, "");
    const scored = { ...source, score: relevance(source, plan) };
    const prior = map.get(key);
    if (!prior || scored.score > prior.score) map.set(key, scored);
  });
  const ranked = [...map.values()].sort((left, right) => right.score - left.score);
  const selected: ResearchSource[] = [];
  const selectedIds = new Set<string>();
  const add = (source: ResearchSource | undefined) => {
    if (!source || selectedIds.has(source.id)) return;
    selectedIds.add(source.id);
    selected.push(source);
  };
  if (ranked.some((source) => source.provider === "youtube")) {
    ranked
      .filter((source) => source.provider === "youtube" || source.provider === "internet-archive")
      .slice(0, 3)
      .forEach(add);
  }
  technicalAnchors(`${(plan.queries || []).join(" ")} ${(plan.entities || []).map(entityText).join(" ")}`)
    .slice(0, 6)
    .forEach((anchor) => add(primaryAnchorSource(ranked, anchor)));
  ranked.forEach((source) => {
    if (selected.length < 16) add(source);
  });
  return selected.slice(0, 16);
}

function queriesToSearch(querySpecs: ResearchQuerySpec[]): ResearchQuerySpec[] {
  const selected: ResearchQuerySpec[] = [];
  const seen = new Set<string>();
  const add = (query: ResearchQuerySpec | undefined) => {
    const key = query?.text.trim().toLocaleLowerCase() || "";
    if (!query || !key || seen.has(key)) return;
    seen.add(key);
    selected.push(query);
  };
  add(querySpecs.find((query) => query.kind === "broad"));
  add(querySpecs.find((query) => query.kind === "comparison"));
  querySpecs.filter((query) => query.id.startsWith("query-aspect")).slice(0, 2).forEach(add);
  querySpecs.filter((query) => query.kind === "exact").slice(0, 4).forEach(add);
  add(querySpecs.find((query) => query.kind === "document" || query.kind === "open-access"));
  if (!selected.length) querySpecs.slice(0, 6).forEach(add);
  return selected.slice(0, 7);
}

export class SourceAdapter {
  constructor() {
    this.installProviders();
  }

  async search(question: string, plan: ResearchPlan, signal?: AbortSignal): Promise<ResearchSource[]> {
    const direct = directUrls(question);
    // An explicit URL is an unambiguous user-selected source. Do not silently
    // blend unrelated search results into a request to read that page.
    if (direct.length) return dedupe(plan, direct);
    const querySpecs: ResearchQuerySpec[] = plan.querySpecs?.length
      ? plan.querySpecs
      : (plan.queries || []).map((text, index) => ({ id: `query-${index + 1}`, kind: "broad", text, sourceTypes: [] }));
    const discovered: ResearchSource[] = [];
    for (const query of queriesToSearch(querySpecs)) {
      const providers = sourceRegistry.select(plan, query, 8);
      const settled = await Promise.allSettled(
        providers.map((provider) => provider.search({ question, plan, query, signal })),
      );
      if (signal?.aborted) throw signal.reason;
      settled.forEach((result) => {
        if (result.status === "fulfilled") discovered.push(...result.value);
      });
    }
    // Intent-critical providers must not disappear merely because a generated
    // query was classified as broad instead of exact.
    const primaryQuery = querySpecs[0]?.text || question;
    if (/\b(?:github|repository|repo|implementasi|source\s*code|kode sumber)\b/i.test(question)) {
      try {
        const topic = technicalSearchTopic(`${question} ${primaryQuery}`);
        discovered.push(...await searchGithub(`${topic} in:name,description`, signal));
      } catch {
        // Other providers remain usable; failed providers are reported by the
        // research activity and never converted into invented evidence.
      }
    }
    if (/\b(?:video|watch|youtube|rekaman|putar|transkrip)\b/i.test(question)) {
      const topic = technicalSearchTopic(`${question} ${primaryQuery}`);
      try {
        discovered.push(...await searchInternetArchive(`${topic} mediatype:movies`, signal));
      } catch {
        // A missing public media result is an explicit limitation, not a fake
        // player or synthetic transcript.
      }
      try {
        discovered.push(...await searchGithubReadmeVideos(topic, signal));
      } catch {
        // GitHub README discovery is an independent public fallback. Its
        // failure must not erase valid results from another media provider.
      }
    }
    return dedupe(plan, [...direct, ...discovered]);
  }

  providers(): SourceProviderManifest[] {
    return sourceRegistry.list();
  }

  private installProviders(): void {
    const register = (provider: SourceProviderManifest) => sourceRegistry.register(provider);
    register({ id: "direct", label: "Direct public URL", capabilities: ["discover_official_source", "read_public_html", "query:exact"], sourceTypes: ["official source", "public website"], openAccess: true, priority: 12, search: async ({ question }) => directUrls(question) });
    // Crossref does not currently return browser CORS headers. Keep the adapter
    // implementation for a future server proxy, but do not issue guaranteed
    // failing requests from the WebApp.
    register({ id: "crossref", label: "Crossref", capabilities: ["search_public_sources", "search_scientific_sources", "query:broad", "query:exact", "query:document"], sourceTypes: ["peer-reviewed paper", "journal metadata", "document"], openAccess: true, priority: 8, available: () => false, search: ({ query, signal }) => searchCrossref(query.text, signal) });
    register({ id: "openalex", label: "OpenAlex", capabilities: ["search_public_sources", "search_scientific_sources", "query:broad", "query:exact", "query:comparison", "query:open-access", "query:document"], sourceTypes: ["peer-reviewed paper", "open access", "scientific work"], openAccess: true, priority: 10, search: ({ query, signal }) => searchOpenAlex(query.text, signal) });
    register({ id: "huggingface-papers", label: "Hugging Face Papers", capabilities: ["search_public_sources", "search_scientific_sources", "read_open_pdf", "query:broad", "query:exact", "query:comparison", "query:open-access", "query:document"], sourceTypes: ["scientific paper", "open access", "preprint", "open PDF"], openAccess: true, priority: 11, search: ({ query, signal }) => searchHuggingFacePapers(query.text, signal) });
    register({ id: "europepmc", label: "Europe PMC", capabilities: ["search_scientific_sources", "query:open-access", "query:document"], sourceTypes: ["peer-reviewed paper", "biomedical", "life science", "open access"], openAccess: true, priority: 7, search: ({ query, signal }) => searchEuropePmc(query.text, signal) });
    register({ id: "arxiv", label: "arXiv", capabilities: ["search_scientific_sources", "read_open_pdf", "query:open-access", "query:document"], sourceTypes: ["preprint", "scientific paper", "open PDF"], openAccess: true, priority: 7, available: () => false, search: ({ query, signal }) => searchArxiv(query.text, signal) });
    register({ id: "wikipedia", label: "Wikipedia", capabilities: ["search_public_sources", "query:broad", "query:exact", "query:comparison"], sourceTypes: ["encyclopedia", "public overview"], openAccess: true, priority: 6, search: ({ query, signal }) => searchWikipedia(query.text, signal) });
    register({ id: "wikidata", label: "Wikidata", capabilities: ["resolve_entities", "search_public_sources", "search_open_places", "query:exact"], sourceTypes: ["knowledge graph", "entity", "place"], openAccess: true, priority: 7, search: ({ query, signal }) => searchWikidata(query.text, signal) });
    register({ id: "wikimedia", label: "Wikimedia Commons", capabilities: ["fetch_open_media", "analyse_image", "query:image"], sourceTypes: ["open licensed image", "figure", "media"], openAccess: true, priority: 11, search: ({ query, signal }) => searchCommons(query.text, signal) });
    register({ id: "github", label: "GitHub", capabilities: ["search_public_sources", "discover_official_source", "query:exact"], sourceTypes: ["source code", "software repository", "official project"], openAccess: true, priority: 5, search: ({ query, signal }) => searchGithub(query.text, signal) });
    register({ id: "internet-archive", label: "Internet Archive", capabilities: ["search_public_sources", "fetch_open_media", "query:broad", "query:exact"], sourceTypes: ["video", "audio", "open media", "public archive"], openAccess: true, priority: 6, search: ({ query, signal }) => searchInternetArchive(query.text, signal) });
    register({ id: "searxng", label: "SearXNG (optional)", capabilities: ["search_public_sources", "discover_official_source", "query:broad", "query:exact"], sourceTypes: ["public website", "news", "documentation"], openAccess: true, priority: 9, available: () => Boolean(String(import.meta.env.VITE_SEARXNG_ENDPOINT || "").trim()), search: ({ query, signal }) => searchSearxNg(query.text, signal) });
    register({ id: "openstreetmap", label: "OpenStreetMap Nominatim", capabilities: ["search_open_places", "query_map_geometry", "query:exact"], sourceTypes: ["place", "map geometry", "point of interest"], openAccess: true, priority: 10, search: ({ query, signal }) => searchNominatim(query.text, signal) });
    register({ id: "overture", label: "Overture Maps", capabilities: ["search_open_places", "query_map_geometry"], sourceTypes: ["place taxonomy", "map geometry"], openAccess: true, priority: 4, available: () => false, search: async () => [] });
  }
}

export const sourceAdapter = new SourceAdapter();
