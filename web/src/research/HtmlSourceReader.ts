import type {
  ResearchContentBlock,
  ResearchDocument,
  ResearchSource,
} from "./ResearchTypes";

function blockHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(31, hash) + value.charCodeAt(index) | 0;
  return Math.abs(hash).toString(36);
}

function compact(value: string, maximum = 16_000): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, maximum);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function absoluteUrl(value: string, baseUrl: string): string {
  try {
    const url = new URL(value, baseUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function cleanDocument(documentNode: Document): void {
  documentNode.querySelectorAll("script,style,noscript,iframe,form,template,svg").forEach((element) => element.remove());
  documentNode.querySelectorAll("*").forEach((element) => {
    [...element.attributes].forEach((attribute) => {
      if (attribute.name.toLowerCase().startsWith("on")) element.removeAttribute(attribute.name);
    });
  });
}

function elementType(element: Element): ResearchContentBlock["type"] | null {
  const tag = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "p" || tag === "blockquote") return "paragraph";
  if (tag === "ul" || tag === "ol") return "list";
  if (tag === "pre" || tag === "code") return "code";
  if (tag === "math" || element.classList.contains("katex") || element.hasAttribute("data-equation")) return "equation";
  if (tag === "table") return "table";
  if (tag === "img" || tag === "figure") return "image";
  return null;
}

function tableText(table: Element): string {
  return [...table.querySelectorAll("tr")].map((row) => [...row.querySelectorAll("th,td")]
    .map((cell) => compact(cell.textContent || "", 2_000)).filter(Boolean).join(" | "))
    .filter(Boolean).join("\n");
}

export function parseResearchHtml(html: string, sourceUrl: string): { title: string; blocks: ResearchContentBlock[] } {
  const documentNode = new DOMParser().parseFromString(html, "text/html");
  cleanDocument(documentNode);
  const title = compact(documentNode.querySelector("title")?.textContent || documentNode.querySelector("h1")?.textContent || "", 500);
  const candidates = [...documentNode.body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,blockquote,ul,ol,pre,code,math,table,figure,img")];
  const blocks: ResearchContentBlock[] = [];
  const seen = new Set<string>();
  candidates.forEach((element) => {
    const type = elementType(element);
    if (!type) return;
    if (element.tagName.toLowerCase() === "code" && element.closest("pre")) return;
    if (element.tagName.toLowerCase() === "img" && element.closest("figure")) return;
    let text = type === "table" ? tableText(element) : compact(element.textContent || "");
    let imageUrl = "";
    let alt = "";
    if (type === "image") {
      const image = element.tagName.toLowerCase() === "img" ? element as HTMLImageElement : element.querySelector("img");
      imageUrl = absoluteUrl(image?.getAttribute("src") || image?.getAttribute("data-src") || "", sourceUrl);
      alt = compact(image?.getAttribute("alt") || "", 500);
      const caption = compact(element.querySelector("figcaption")?.textContent || "", 2_000);
      text = compact([caption, alt].filter(Boolean).join(" - "), 2_000);
      if (!imageUrl) return;
    }
    if (!text && type !== "image") return;
    if (text.length < 2) return;
    const identity = `${type}:${text.slice(0, 1_000)}:${imageUrl}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const order = blocks.length;
    blocks.push({
      id: `html-${order + 1}-${blockHash(identity)}`,
      type,
      text,
      html: type === "code" || type === "equation" ? `<pre><code>${escapeHtml(text)}</code></pre>` : undefined,
      imageUrl: imageUrl || undefined,
      alt: alt || undefined,
      order,
    });
  });
  return { title, blocks };
}

function linkedSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(new DOMException("Batas waktu halaman terlewati.", "TimeoutError")), timeoutMs);
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

export class HtmlSourceReader {
  async read(source: ResearchSource, signal?: AbortSignal): Promise<ResearchDocument> {
    try {
      const target = new URL(source.url, window.location.href);
      if (target.origin !== window.location.origin) {
        return {
          sourceId: source.id,
          title: source.title,
          url: source.url,
          status: "blocked",
          blocks: [],
          limitation: "Browser membatasi pembacaan HTML lintas-origin melalui CORS. Abstrak provider tetap dapat digunakan bila tersedia, tetapi isi halaman tidak diklaim telah dibaca.",
        };
      }
    } catch {
      return {
        sourceId: source.id,
        title: source.title,
        url: source.url,
        status: "failed",
        blocks: [],
        limitation: "URL sumber tidak valid.",
      };
    }
    const linked = linkedSignal(signal, 20_000);
    try {
      const response = await fetch(source.url, {
        headers: { Accept: "text/html,application/xhtml+xml" },
        signal: linked.signal,
      });
      if (!response.ok) {
        return {
          sourceId: source.id,
          title: source.title,
          url: source.url,
          status: "failed",
          blocks: [],
          limitation: `Halaman mengembalikan HTTP ${response.status}.`,
        };
      }
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("html") && !contentType.includes("xml") && !contentType.startsWith("text/")) {
        return {
          sourceId: source.id,
          title: source.title,
          url: source.url,
          status: "failed",
          blocks: [],
          limitation: `Tipe konten ${contentType || "tidak diketahui"} bukan HTML.`,
        };
      }
      const parsed = parseResearchHtml(await response.text(), source.url);
      return {
        sourceId: source.id,
        title: parsed.title || source.title,
        url: source.url,
        status: parsed.blocks.length ? "full-text" : "failed",
        blocks: parsed.blocks,
        limitation: parsed.blocks.length ? "" : "Halaman berhasil diterima, tetapi tidak mempunyai blok teks yang dapat digunakan.",
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const blocked = error instanceof TypeError;
      return {
        sourceId: source.id,
        title: source.title,
        url: source.url,
        status: blocked ? "blocked" : "failed",
        blocks: [],
        limitation: blocked
          ? "Browser memblokir pembacaan isi halaman melalui CORS. Hanya metadata atau abstrak provider yang boleh dipakai."
          : error instanceof Error ? error.message : String(error),
      };
    } finally {
      linked.cleanup();
    }
  }
}

export const htmlSourceReader = new HtmlSourceReader();
