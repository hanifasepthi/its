type Pending = {
  resolve: (value: string) => void;
  reject: (reason?: unknown) => void;
  timer: number;
};

export class PythonSandbox {
  private worker: Worker | null = null;
  private pending = new Map<string, Pending>();

  runFromUserGesture(code: string, timeoutMs = 12_000): Promise<string> {
    if (!navigator.userActivation?.isActive) {
      return Promise.reject(new Error("Eksekusi Python harus dimulai langsung dari tindakan pengguna."));
    }
    this.worker ||= this.createWorker();
    const id = crypto.randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        this.terminate();
        reject(new Error("Eksekusi Python dihentikan karena melewati batas waktu."));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker!.postMessage({ id, code: code.slice(0, 20_000) });
    });
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.forEach(({ reject, timer }) => {
      window.clearTimeout(timer);
      reject(new Error("Sandbox Python dihentikan."));
    });
    this.pending.clear();
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL("./PythonSandboxWorker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<{ id: string; ok: boolean; output: string }>) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      window.clearTimeout(pending.timer);
      if (event.data.ok) pending.resolve(event.data.output);
      else pending.reject(new Error(event.data.output));
    });
    return worker;
  }
}

export const pythonSandbox = new PythonSandbox();
