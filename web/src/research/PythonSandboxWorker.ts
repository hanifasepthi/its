/// <reference lib="webworker" />

import { loadPyodide, type PyodideInterface } from "pyodide";

type RunRequest = { id: string; code: string };
type RunResponse = { id: string; ok: boolean; output: string };

const ALLOWED_IMPORTS = new Set(["math", "statistics", "json", "re", "collections", "itertools", "functools"]);
let runtime: Promise<PyodideInterface> | null = null;

function validate(code: string): void {
  const imports = [...code.matchAll(/(?:^|\n)\s*(?:from|import)\s+([a-zA-Z0-9_]+)/g)].map((match) => match[1]);
  const denied = imports.filter((name) => !ALLOWED_IMPORTS.has(name));
  if (denied.length) throw new Error(`Import tidak diizinkan: ${[...new Set(denied)].join(", ")}`);
  if (/\b(?:open|fetch|XMLHttpRequest|WebSocket|eval|exec|compile|__import__)\s*\(/.test(code)) {
    throw new Error("Operasi berkas, jaringan, atau evaluasi dinamis tidak diizinkan.");
  }
}

self.addEventListener("message", async (event: MessageEvent<RunRequest>) => {
  const { id, code } = event.data;
  try {
    validate(code);
    runtime ||= loadPyodide();
    const pyodide = await runtime;
    pyodide.setStdout({ batched: (value) => self.postMessage({ id, ok: true, output: value } satisfies RunResponse) });
    const result = await pyodide.runPythonAsync(code);
    self.postMessage({ id, ok: true, output: result == null ? "Selesai." : String(result) } satisfies RunResponse);
  } catch (error) {
    self.postMessage({ id, ok: false, output: error instanceof Error ? error.message : String(error) } satisfies RunResponse);
  }
});

export {};
