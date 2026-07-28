import type { ResearchContentBlock, ResearchDocument, ResearchSource } from "./ResearchTypes";
import JSZip from "jszip";

const MAX_FILE_BYTES = 600_000;
const MAX_ARCHIVE_BYTES = 25_000_000;
const GITHUB_ARCHIVE_ENDPOINT = "https://its.hanifahseptiani45.workers.dev/v1/research/github/archive";
const WORKER_HEALTH_ENDPOINT = "https://its.hanifahseptiani45.workers.dev/v1/health";
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift|rb|php|cs|cpp|c|h|md|rst|toml|ya?ml|json|html?|css|scss|sh|ps1)$/i;

type GitHubTreeEntry = { path?: string; type?: string; size?: number };
let archiveCapability: Promise<boolean> | null = null;

async function fetchBounded(url: string | URL, init: RequestInit, timeoutMs: number, parent?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
  return fetch(url, { ...init, signal });
}

async function fetchBytesBounded(url: string | URL, init: RequestInit, timeoutMs: number, parent?: AbortSignal): Promise<{ response: Response; bytes: ArrayBuffer }> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
  const response = await fetch(url, { ...init, signal });
  const bytes = response.ok ? await response.arrayBuffer() : new ArrayBuffer(0);
  return { response, bytes };
}

async function githubArchiveSupported(signal?: AbortSignal): Promise<boolean> {
  // The production Worker intentionally allows the deployed ITS Maps origins,
  // not arbitrary localhost ports. Local preview/QA must use GitHub's public
  // Tree + Raw APIs directly instead of waiting for an expected CORS rejection.
  if (/^(?:localhost|127\.0\.0\.1)$/i.test(window.location.hostname)) return false;
  if (!archiveCapability) {
    archiveCapability = (async () => {
      try {
        const response = await fetchBounded(WORKER_HEALTH_ENDPOINT, { headers: { Accept: "application/json" } }, 8_000, signal);
        if (!response.ok) return false;
        const payload = await response.json() as { endpoints?: { githubArchive?: unknown } };
        return typeof payload.endpoints?.githubArchive === "string";
      } catch {
        return false;
      }
    })();
  }
  return archiveCapability;
}

function repoCoordinates(source: ResearchSource): { owner: string; repo: string } | null {
  try {
    const url = new URL(source.url);
    if (url.hostname !== "github.com") return null;
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    return owner && repo ? { owner, repo: repo.replace(/\.git$/i, "") } : null;
  } catch {
    return null;
  }
}

function tokens(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || [])].slice(0, 24);
}

function snippets(text: string, queryTokens: string[]): Array<{ line: number; text: string }> {
  const lines = text.split(/\r?\n/);
  const found: Array<{ line: number; text: string }> = [];
  lines.forEach((line, index) => {
    const normalized = line.toLocaleLowerCase();
    if (!queryTokens.some((token) => normalized.includes(token))) return;
    const start = Math.max(0, index - 2);
    const end = Math.min(lines.length, index + 3);
    found.push({ line: index + 1, text: lines.slice(start, end).join("\n").slice(0, 2_800) });
  });
  return found.slice(0, 3);
}

export class GitHubRepositoryReader {
  async read(source: ResearchSource, query: string, signal?: AbortSignal): Promise<ResearchDocument> {
    const coordinates = repoCoordinates(source);
    if (!coordinates) {
      return { sourceId: source.id, title: source.title, url: source.url, status: "failed", blocks: [], limitation: "URL repositori GitHub tidak valid." };
    }
    try {
      if (!await githubArchiveSupported(signal)) throw new Error("archive endpoint unavailable");
      const archiveUrl = new URL(GITHUB_ARCHIVE_ENDPOINT);
      archiveUrl.searchParams.set("owner", coordinates.owner);
      archiveUrl.searchParams.set("repo", coordinates.repo);
      const { response, bytes } = await fetchBytesBounded(archiveUrl, { headers: { Accept: "application/zip" } }, 20_000, signal);
      if (!response.ok) throw new Error(`archive HTTP ${response.status}`);
      const declared = Number(response.headers.get("Content-Length") || 0);
      if (declared > MAX_ARCHIVE_BYTES) throw new Error("archive too large");
      if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("archive too large");
      return await this.readZipLocally(source, query, bytes);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      // The public Tree + Raw APIs remain a no-login fallback when the bounded,
      // same-origin-approved ZIP reader is temporarily unavailable.
      return this.readThroughPublicApi(source, query, coordinates, signal);
    }
  }

  private async readZipLocally(source: ResearchSource, query: string, bytes: ArrayBuffer): Promise<ResearchDocument> {
    const archive = await JSZip.loadAsync(bytes);
    const queryTokens = tokens(query);
    const blocks: ResearchContentBlock[] = [];
    const files = Object.values(archive.files)
      .filter((entry) => !entry.dir && TEXT_FILE.test(entry.name))
      .sort((left, right) => {
        const rank = (path: string) => /(?:^|\/)readme(?:\.|$)/i.test(path) ? 0
          : /(?:model|detr|train|loss|main|index)/i.test(path) ? 1
            : 2;
        return rank(left.name) - rank(right.name);
      })
      .slice(0, 48);
    for (const entry of files) {
      const text = await entry.async("text");
      if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) continue;
      const path = entry.name.split("/").slice(1).join("/") || entry.name;
      for (const match of snippets(text, queryTokens)) {
        const sourceUrl = `${source.url}/blob/HEAD/${path}#L${match.line}`;
        blocks.push({
          id: `github-zip-${blocks.length + 1}`,
          type: "code",
          text: `${path}:${match.line}\n${match.text}\nSumber: ${sourceUrl}\nLisensi repositori: ${source.license || "tidak dinyatakan oleh API"}`,
          html: `<pre><code>${match.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</code></pre>`,
          order: blocks.length,
        });
        if (blocks.length >= 24) break;
      }
      if (blocks.length >= 24) break;
    }
    return {
      sourceId: source.id,
      title: source.title,
      url: source.url,
      status: blocks.length ? "full-text" : "metadata-only",
      blocks,
      limitation: blocks.length ? "" : "ZIP publik dibaca lokal, tetapi tidak ditemukan potongan teks yang sesuai query.",
    };
  }

  private async readThroughPublicApi(
    source: ResearchSource,
    query: string,
    coordinates: { owner: string; repo: string },
    signal?: AbortSignal,
  ): Promise<ResearchDocument> {
    const repoPath = `${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repo)}`;
    const treeResponse = await fetchBounded(`https://api.github.com/repos/${repoPath}/git/trees/HEAD?recursive=1`, {
      headers: { Accept: "application/vnd.github+json" },
    }, 15_000, signal);
    if (!treeResponse.ok) {
      return { sourceId: source.id, title: source.title, url: source.url, status: "failed", blocks: [], limitation: `GitHub API mengembalikan HTTP ${treeResponse.status}.` };
    }
    const payload = await treeResponse.json() as { tree?: GitHubTreeEntry[] };
    const candidates = (payload.tree || [])
      .filter((entry) => entry.type === "blob" && entry.path && TEXT_FILE.test(entry.path) && Number(entry.size || 0) <= MAX_FILE_BYTES)
      .sort((left, right) => {
        const rank = (path = "") => /(?:^|\/)readme(?:\.|$)/i.test(path) ? 0
          : /(?:model|detr|train|loss|main|index)/i.test(path) ? 1
            : 2;
        return rank(left.path) - rank(right.path);
      })
      .slice(0, 12);
    const queryTokens = tokens(query);
    const blocks: ResearchContentBlock[] = [];
    const fetched = await Promise.allSettled(candidates.map(async (entry) => {
      const path = entry.path!;
      const rawUrl = `https://raw.githubusercontent.com/${repoPath}/HEAD/${path.split("/").map(encodeURIComponent).join("/")}`;
      const response = await fetchBounded(rawUrl, {}, 8_000, signal);
      if (!response.ok) throw new Error(`raw HTTP ${response.status}`);
      return { path, text: await response.text() };
    }));
    for (const result of fetched) {
      if (result.status !== "fulfilled") continue;
      const { path, text } = result.value;
      for (const match of snippets(text, queryTokens)) {
        const sourceUrl = `${source.url}/blob/HEAD/${path}#L${match.line}`;
        blocks.push({
          id: `github-api-${blocks.length + 1}`,
          type: "code",
          text: `${path}:${match.line}\n${match.text}\nSumber: ${sourceUrl}\nLisensi repositori: ${source.license || "tidak dinyatakan oleh API"}`,
          html: `<pre><code>${match.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</code></pre>`,
          order: blocks.length,
        });
        if (blocks.length >= 24) break;
      }
      if (blocks.length >= 24) break;
    }
    return {
      sourceId: source.id,
      title: source.title,
      url: source.url,
      status: blocks.length ? "full-text" : "metadata-only",
      blocks,
      limitation: blocks.length ? "" : "GitHub API dapat dibaca, tetapi tidak ditemukan potongan teks yang sesuai query.",
    };
  }
}

export const githubRepositoryReader = new GitHubRepositoryReader();
