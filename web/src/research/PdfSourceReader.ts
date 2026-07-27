import type {
  PdfReadCoverage,
  ResearchContentBlock,
  ResearchDocument,
  ResearchSource,
} from "./ResearchTypes";
import { modelResolver } from "../ai-runtime/ModelResolver";

type PdfWorkerResponse = {
  id: string;
  type: "progress" | "result" | "error";
  message?: string;
  page?: number;
  totalPages?: number;
  blocks?: ResearchContentBlock[];
  coverage?: PdfReadCoverage;
};

let sequence = 0;

function emptyCoverage(): PdfReadCoverage {
  return {
    totalPages: 0,
    renderedPages: [],
    textReadPages: [],
    visuallyAnalysedPages: [],
    skippedPages: [],
    failedPages: [],
  };
}

function isBrowserReadablePdf(value: string): boolean {
  try {
    const url = new URL(value, window.location.href);
    if (url.origin === window.location.origin) return true;
    return [
      "arxiv.org",
      "export.arxiv.org",
      "europepmc.org",
      "www.ebi.ac.uk",
      "pmc.ncbi.nlm.nih.gov",
      "www.ncbi.nlm.nih.gov",
    ].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

export class PdfSourceReader {
  async read(
    source: ResearchSource,
    onProgress?: (message: string, page?: number, totalPages?: number) => void,
    signal?: AbortSignal,
    maximumPages = 24,
  ): Promise<ResearchDocument> {
    if (!source.pdfUrl) {
      return {
        sourceId: source.id,
        title: source.title,
        url: source.url,
        status: "failed",
        blocks: [],
        coverage: emptyCoverage(),
        limitation: "Sumber tidak menyediakan URL PDF open-access.",
      };
    }
    if (!isBrowserReadablePdf(source.pdfUrl)) {
      return {
        sourceId: source.id,
        title: source.title,
        url: source.pdfUrl,
        status: "blocked",
        blocks: [],
        coverage: emptyCoverage(),
        limitation: "PDF lintas-origin tidak mengizinkan pembacaan browser. Dokumen tidak diminta agar konsol tetap bersih; abstrak provider digunakan bila tersedia.",
      };
    }
    const id = `pdf-read-${Date.now()}-${sequence += 1}`;
    let ocrSelection: {
      modelId: string;
      pipeline: string;
      dtype: string;
      device: string;
    } | null = null;
    try {
      const resolved = await modelResolver.resolve("OCR");
      ocrSelection = {
        modelId: resolved.selection.candidate.id,
        pipeline: resolved.selection.candidate.pipeline,
        dtype: resolved.selection.dtype,
        device: resolved.selection.device,
      };
    } catch {
      onProgress?.("Model OCR lokal tidak tersedia; halaman tanpa text layer akan ditandai belum dibaca");
    }
    const worker = new Worker(new URL("./PdfSourceWorker.ts", import.meta.url), { type: "module" });
    return new Promise<ResearchDocument>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        signal?.removeEventListener("abort", abort);
        worker.terminate();
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        finish();
        reject(signal?.reason || new DOMException("Pembacaan PDF dibatalkan.", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        finish();
        resolve({
          sourceId: source.id,
          title: source.title,
          url: source.pdfUrl,
          status: "failed",
          blocks: [],
          coverage: emptyCoverage(),
          limitation: "Pembacaan PDF melewati batas waktu dan worker dihentikan.",
        });
      }, 60_000);
      const complete = () => {
        window.clearTimeout(timer);
        settled = true;
        finish();
      };
      worker.addEventListener("message", (event: MessageEvent<PdfWorkerResponse>) => {
        const response = event.data;
        if (response.id !== id || settled) return;
        if (response.type === "progress") {
          onProgress?.(response.message || "Membaca PDF", response.page, response.totalPages);
          return;
        }
        if (response.type === "result") {
          complete();
          const coverage = response.coverage || emptyCoverage();
          const unreadScans = coverage.skippedPages.filter((page) => page <= Math.min(coverage.totalPages, maximumPages));
          resolve({
            sourceId: source.id,
            title: source.title,
            url: source.pdfUrl,
            status: "pdf",
            blocks: response.blocks || [],
            coverage,
            limitation: unreadScans.length
              ? `${unreadScans.length} halaman tidak mempunyai text layer; halaman tersebut tidak diklaim telah dibaca karena OCR belum menghasilkan teks.`
              : coverage.skippedPages.length ? `Pembacaan dibatasi pada ${maximumPages} halaman pertama.` : "",
          });
          return;
        }
        complete();
        resolve({
          sourceId: source.id,
          title: source.title,
          url: source.pdfUrl,
          status: "failed",
          blocks: [],
          coverage: emptyCoverage(),
          limitation: response.message || "PDF.js tidak dapat membaca dokumen.",
        });
      });
      worker.addEventListener("error", (event) => {
        if (settled) return;
        complete();
        resolve({
          sourceId: source.id,
          title: source.title,
          url: source.pdfUrl,
          status: "failed",
          blocks: [],
          coverage: emptyCoverage(),
          limitation: event.message || "Worker PDF.js gagal dimuat.",
        });
      });
      if (signal?.aborted) {
        abort();
        return;
      }
      worker.postMessage({ id, url: source.pdfUrl, maximumPages, ocrSelection });
    });
  }
}

export const pdfSourceReader = new PdfSourceReader();
