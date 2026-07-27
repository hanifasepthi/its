import type { PdfReadCoverage, ResearchContentBlock } from "./ResearchTypes";
import { env, pipeline, RawImage } from "@huggingface/transformers";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

type OcrSelection = {
  modelId: string;
  pipeline: string;
  dtype: "q4" | "q8" | "fp16" | "fp32";
  device: "webgpu" | "wasm";
};

type PdfWorkerRequest = {
  id: string;
  url: string;
  maximumPages: number;
  ocrSelection?: OcrSelection | null;
};

type PdfWorkerResponse = {
  id: string;
  type: "progress" | "result" | "error";
  message?: string;
  page?: number;
  totalPages?: number;
  blocks?: ResearchContentBlock[];
  coverage?: PdfReadCoverage;
};

type PdfTextItem = {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
};

const scope = self as unknown as {
  postMessage: (message: PdfWorkerResponse) => void;
  onmessage: ((event: MessageEvent<PdfWorkerRequest>) => void) | null;
};

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

let ocrPipeline: any = null;
let ocrKey = "";

function send(message: PdfWorkerResponse): void {
  scope.postMessage(message);
}

function compact(value: string, maximum = Number.POSITIVE_INFINITY): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maximum);
}

function lineBlocks(items: PdfTextItem[], pageNumber: number, startOrder: number): ResearchContentBlock[] {
  const rows = new Map<number, Array<{ x: number; text: string; width: number; height: number }>>();
  items.forEach((item) => {
    const text = compact(String(item.str || ""));
    const transform = Array.isArray(item.transform) ? item.transform.map(Number) : [];
    if (!text || transform.length < 6) return;
    const x = Number(transform[4]) || 0;
    const y = Number(transform[5]) || 0;
    const rowKey = Math.round(y / 3) * 3;
    const entries = rows.get(rowKey) || [];
    entries.push({ x, text, width: Number(item.width) || 0, height: Number(item.height) || Math.abs(Number(transform[3])) || 10 });
    rows.set(rowKey, entries);
  });
  const lines = [...rows.entries()]
    .sort((left, right) => right[0] - left[0])
    .map(([y, entries]) => {
      entries.sort((left, right) => left.x - right.x);
      const text = compact(entries.map((entry) => entry.text).join(" "));
      const minimumX = Math.min(...entries.map((entry) => entry.x));
      const maximumX = Math.max(...entries.map((entry) => entry.x + entry.width));
      const maximumHeight = Math.max(...entries.map((entry) => entry.height));
      return {
        text,
        y,
        minimumX,
        maximumX,
        maximumHeight,
        heading: /^\d+(?:\.\d+)*\s+\S/.test(text) || (text.length < 100 && text === text.toUpperCase()),
      };
    })
    .filter((line) => line.text.length > 1);

  const blocks: ResearchContentBlock[] = [];
  let paragraph: typeof lines = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const first = paragraph[0];
    const last = paragraph.at(-1)!;
    const text = paragraph.reduce((result, line) => {
      if (!result) return line.text;
      return result.endsWith("-")
        ? `${result.slice(0, -1)}${line.text}`
        : `${result} ${line.text}`;
    }, "");
    const minimumX = Math.min(...paragraph.map((line) => line.minimumX));
    const maximumX = Math.max(...paragraph.map((line) => line.maximumX));
    blocks.push({
      id: `pdf-page-${pageNumber}-block-${blocks.length + 1}`,
      type: "paragraph",
      text: compact(text, 1_600),
      page: pageNumber,
      order: startOrder + blocks.length,
      boundingBox: [
        minimumX,
        last.y,
        Math.max(0, maximumX - minimumX),
        Math.max(first.maximumHeight, first.y - last.y + last.maximumHeight),
      ],
    });
    paragraph = [];
  };

  lines.forEach((line) => {
    if (line.heading) {
      flushParagraph();
      blocks.push({
        id: `pdf-page-${pageNumber}-block-${blocks.length + 1}`,
        type: "heading",
        text: line.text,
        page: pageNumber,
        order: startOrder + blocks.length,
        boundingBox: [line.minimumX, line.y, Math.max(0, line.maximumX - line.minimumX), line.maximumHeight],
      });
      return;
    }
    const previous = paragraph.at(-1);
    const verticalGap = previous ? Math.abs(previous.y - line.y) : 0;
    const currentLength = paragraph.reduce((sum, entry) => sum + entry.text.length + 1, 0);
    if (paragraph.length && (verticalGap > Math.max(24, previous!.maximumHeight * 2.2) || currentLength + line.text.length > 1_400)) {
      flushParagraph();
    }
    paragraph.push(line);
  });
  flushParagraph();
  return blocks;
}

function ocrText(output: unknown): string {
  const first = Array.isArray(output) ? output[0] : output;
  const generated = (first as { generated_text?: unknown } | null)?.generated_text;
  return compact(typeof generated === "string" ? generated : "", 12_000);
}

async function readCanvasWithOcr(
  canvas: OffscreenCanvas,
  selection: OcrSelection | null | undefined,
): Promise<string> {
  if (!selection) return "";
  const key = `${selection.pipeline}:${selection.modelId}:${selection.dtype}:${selection.device}`;
  if (!ocrPipeline || ocrKey !== key) {
    if (ocrPipeline?.dispose) await Promise.resolve(ocrPipeline.dispose());
    ocrPipeline = await pipeline(selection.pipeline as any, selection.modelId, {
      dtype: selection.dtype,
      device: selection.device,
    } as any);
    ocrKey = key;
  }
  const image = await RawImage.fromBlob(await canvas.convertToBlob({ type: "image/png" }));
  return ocrText(await ocrPipeline(image));
}

async function disposeOcr(): Promise<void> {
  if (ocrPipeline?.dispose) await Promise.resolve(ocrPipeline.dispose());
  ocrPipeline = null;
  ocrKey = "";
}

async function openPdf(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Unduhan PDF melewati batas waktu.", "TimeoutError")), 30_000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/pdf" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`PDF HTTP ${response.status}`);
    const data = new Uint8Array(await response.arrayBuffer());
    return getDocument({ data, isEvalSupported: false }).promise;
  } finally {
    clearTimeout(timer);
  }
}

async function readPdf(request: PdfWorkerRequest): Promise<void> {
  const documentNode = await openPdf(request.url);
  const totalPages = Number(documentNode.numPages) || 0;
  const maximumPages = Math.min(totalPages, Math.max(1, request.maximumPages));
  const coverage: PdfReadCoverage = {
    totalPages,
    renderedPages: [],
    textReadPages: [],
    visuallyAnalysedPages: [],
    skippedPages: [],
    failedPages: [],
  };
  const blocks: ResearchContentBlock[] = [];
  for (let pageNumber = 1; pageNumber <= maximumPages; pageNumber += 1) {
    try {
      const page = await documentNode.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageBlocks = lineBlocks(Array.isArray(content.items) ? content.items : [], pageNumber, blocks.length);
      if (pageBlocks.length) {
        blocks.push(...pageBlocks);
        coverage.textReadPages.push(pageNumber);
        send({
          id: request.id,
          type: "progress",
          message: `Teks PDF ${pageNumber}/${totalPages} dibaca`,
          page: pageNumber,
          totalPages,
        });
      } else {
        const viewport = page.getViewport({ scale: 1.1 });
        const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("OffscreenCanvas 2D tidak tersedia.");
        await page.render({ canvasContext: context, viewport }).promise;
        coverage.renderedPages.push(pageNumber);
        send({
          id: request.id,
          type: "progress",
          message: `Halaman ${pageNumber} tidak punya text layer; OCR lokal dijalankan`,
          page: pageNumber,
          totalPages,
        });
        const text = await readCanvasWithOcr(canvas, request.ocrSelection);
        if (text) {
          blocks.push({
            id: `pdf-page-${pageNumber}-ocr`,
            type: "paragraph",
            text,
            page: pageNumber,
            order: blocks.length,
            boundingBox: [0, 0, viewport.width, viewport.height],
          });
          coverage.textReadPages.push(pageNumber);
          coverage.visuallyAnalysedPages.push(pageNumber);
          send({
            id: request.id,
            type: "progress",
            message: `OCR halaman ${pageNumber}/${totalPages} selesai`,
            page: pageNumber,
            totalPages,
          });
        } else {
          coverage.skippedPages.push(pageNumber);
        }
      }
      page.cleanup?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } catch {
      coverage.failedPages.push(pageNumber);
    }
  }
  for (let page = maximumPages + 1; page <= totalPages; page += 1) coverage.skippedPages.push(page);
  await documentNode.destroy?.();
  await disposeOcr();
  send({ id: request.id, type: "result", blocks, coverage, totalPages });
}

scope.onmessage = (event) => {
  const request = event.data;
  void readPdf(request).catch((error) => {
    void disposeOcr();
    send({ id: request.id, type: "error", message: error instanceof Error ? error.message : String(error) });
  });
};
