export type AgentActivityPhase =
  | "planning"
  | "searching"
  | "results"
  | "opening"
  | "reading"
  | "scrolling"
  | "extracting"
  | "ranking"
  | "reasoning"
  | "validating"
  | "writing"
  | "complete"
  | "error";

export type AgentActivitySource = {
  id: string;
  title: string;
  provider: string;
  url: string;
  excerpt: string;
  authors?: string[];
  year?: string;
};

export type AgentActivityEvent = {
  id: string;
  sessionId: string;
  phase: AgentActivityPhase;
  title: string;
  detail?: string;
  query?: string;
  provider?: string;
  url?: string;
  sourceTitle?: string;
  excerpt?: string;
  sources?: AgentActivitySource[];
  progress?: number;
  createdAt: number;
};

type ActivityInput = Omit<AgentActivityEvent, "id" | "sessionId" | "createdAt">;
type AgentActivityListener = (event: AgentActivityEvent) => void;

function activityId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

class AgentLiveActivityBus {
  private listeners = new Set<AgentActivityListener>();
  private events: AgentActivityEvent[] = [];
  private activeSessionId = "";

  start(question: string): string {
    const sessionId = activityId("research");
    this.activeSessionId = sessionId;
    this.events = [];
    this.emit(sessionId, {
      phase: "planning",
      title: "Memahami pertanyaan",
      detail: question,
      query: question,
      progress: 3,
    });
    return sessionId;
  }

  emit(sessionId: string, input: ActivityInput): AgentActivityEvent {
    const event: AgentActivityEvent = {
      ...input,
      id: activityId("event"),
      sessionId,
      progress: input.progress == null ? undefined : clamp(input.progress, 0, 100),
      createdAt: Date.now(),
    };
    if (sessionId === this.activeSessionId) {
      this.events.push(event);
      this.events = this.events.slice(-120);
    }
    this.listeners.forEach((listener) => listener(event));
    return event;
  }

  complete(sessionId: string, detail: string): void {
    this.emit(sessionId, {
      phase: "complete",
      title: "Riset selesai",
      detail,
      progress: 100,
    });
  }

  fail(sessionId: string, error: unknown): void {
    this.emit(sessionId, {
      phase: "error",
      title: "Riset berhenti",
      detail: error instanceof Error ? error.message : String(error),
      progress: 100,
    });
  }

  subscribe(listener: AgentActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): AgentActivityEvent[] {
    return [...this.events];
  }

  activeSession(): string {
    return this.activeSessionId;
  }
}

export const agentLiveActivity = new AgentLiveActivityBus();

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function safeExternalUrl(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

function sourceMeta(source: AgentActivitySource): string {
  return [source.provider, source.year, ...(source.authors || []).slice(0, 2)]
    .filter(Boolean)
    .join(" | ");
}

export function mountAgentLiveActivity(host: HTMLElement): () => void {
  const panel = createElement("section", "its-agent-playback");
  panel.hidden = true;
  panel.setAttribute("aria-label", "Aktivitas riset AI langsung");
  panel.innerHTML = `
    <header class="its-agent-playback-head">
      <div><span><i aria-hidden="true"></i> LIVE RESEARCH</span><strong>Aktivitas Agent</strong></div>
      <button type="button" data-playback-collapse aria-expanded="true" aria-label="Minimalkan aktivitas riset">-</button>
    </header>
    <div class="its-agent-playback-body">
      <div class="its-research-browser" data-playback-browser>
        <div class="its-research-browser-bar">
          <span class="its-browser-lights" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="its-research-tab" data-playback-tab>Riset ITS Maps</span>
        </div>
        <div class="its-research-address"><span aria-hidden="true">https</span><code data-playback-url>about:research</code></div>
        <div class="its-research-viewport" data-playback-viewport></div>
        <span class="its-research-cursor" data-playback-cursor aria-hidden="true">
          <svg viewBox="0 0 18 24"><path d="M1 1v18l5-4 3.3 7 3-1.4-3.2-6.7H16L1 1Z"/></svg>
        </span>
      </div>
      <div class="its-agent-playback-controls">
        <output data-playback-time>0:00</output>
        <input type="range" min="0" max="0" value="0" step="1" aria-label="Putar ulang aktivitas riset">
        <button type="button" data-playback-live>LIVE</button>
      </div>
      <div class="its-agent-playback-progress"><i data-playback-progress></i></div>
      <ol class="its-agent-playback-timeline" data-playback-timeline></ol>
    </div>`;
  host.appendChild(panel);

  const browser = panel.querySelector<HTMLElement>("[data-playback-browser]");
  const viewport = panel.querySelector<HTMLElement>("[data-playback-viewport]");
  const cursor = panel.querySelector<HTMLElement>("[data-playback-cursor]");
  const tab = panel.querySelector<HTMLElement>("[data-playback-tab]");
  const address = panel.querySelector<HTMLElement>("[data-playback-url]");
  const timeline = panel.querySelector<HTMLOListElement>("[data-playback-timeline]");
  const progress = panel.querySelector<HTMLElement>("[data-playback-progress]");
  const time = panel.querySelector<HTMLOutputElement>("[data-playback-time]");
  const slider = panel.querySelector<HTMLInputElement>("input[type='range']");
  const liveButton = panel.querySelector<HTMLButtonElement>("[data-playback-live]");
  let events: AgentActivityEvent[] = [];
  let followLive = true;
  let sessionId = "";

  const moveCursorToTarget = () => {
    if (!browser || !cursor) return;
    const target = browser.querySelector<HTMLElement>("[data-playback-target]");
    if (!target) return;
    requestAnimationFrame(() => {
      const rootRect = browser.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const x = clamp(targetRect.left - rootRect.left + Math.min(targetRect.width / 2, 92), 8, Math.max(8, rootRect.width - 24));
      const y = clamp(targetRect.top - rootRect.top + Math.min(targetRect.height / 2, 28), 8, Math.max(8, rootRect.height - 30));
      cursor.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
      cursor.classList.add("is-clicking");
      window.setTimeout(() => cursor.classList.remove("is-clicking"), 180);
    });
  };

  const renderSearchResults = (event: AgentActivityEvent) => {
    if (!viewport) return;
    const heading = createElement("h4", "", "Hasil pencarian sumber publik");
    const query = createElement("p", "its-research-query", event.query || event.detail || "");
    viewport.replaceChildren(heading, query);
    (event.sources || []).forEach((source, index) => {
      const item = createElement("article", "its-research-result");
      if (index === 0) item.dataset.playbackTarget = "true";
      const link = createElement("a", "", source.title);
      link.href = safeExternalUrl(source.url) || "#";
      link.target = "_blank";
      link.rel = "noopener";
      const meta = createElement("span", "", sourceMeta(source));
      const excerpt = createElement("p", "", source.excerpt || "Metadata bibliografis tersedia.");
      item.append(link, meta, excerpt);
      viewport.appendChild(item);
    });
  };

  const renderReader = (event: AgentActivityEvent) => {
    if (!viewport) return;
    const article = createElement("article", "its-research-reader");
    article.dataset.playbackTarget = "true";
    const label = createElement("span", "", `${event.provider || "Sumber publik"} | Reader ITS Maps`);
    const heading = createElement("h4", "", event.sourceTitle || event.title);
    const excerpt = createElement("p", "", event.excerpt || event.detail || "Metadata sumber sedang diproses.");
    article.append(label, heading, excerpt);
    const url = safeExternalUrl(event.url);
    if (url) {
      const link = createElement("a", "", "Buka sumber asli");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      article.appendChild(link);
    }
    viewport.replaceChildren(article);
  };

  const renderGeneric = (event: AgentActivityEvent) => {
    if (!viewport) return;
    const card = createElement("article", `its-research-stage is-${event.phase}`);
    card.dataset.playbackTarget = "true";
    card.append(
      createElement("span", "", event.phase.toUpperCase()),
      createElement("h4", "", event.title),
      createElement("p", "", event.detail || event.excerpt || "Aktivitas sedang berjalan."),
    );
    viewport.replaceChildren(card);
  };

  const renderTimeline = (activeIndex: number) => {
    if (!timeline) return;
    timeline.replaceChildren(...events.slice(Math.max(0, activeIndex - 4), activeIndex + 1).map((event, index, visible) => {
      const item = createElement("li", index === visible.length - 1 ? "active" : "");
      item.append(createElement("i"), createElement("span", "", event.title));
      return item;
    }));
  };

  const renderEvent = (index: number) => {
    const event = events[index];
    if (!event) return;
    panel.hidden = false;
    if (tab) tab.textContent = event.sourceTitle || event.provider || "Riset ITS Maps";
    if (address) address.textContent = safeExternalUrl(event.url) || (event.query ? `search://${event.query}` : "about:research");
    if (event.phase === "results") renderSearchResults(event);
    else if (["opening", "reading", "scrolling", "extracting"].includes(event.phase)) renderReader(event);
    else renderGeneric(event);
    if (progress) progress.style.width = `${event.progress ?? 0}%`;
    const elapsed = Math.max(0, Math.round((event.createdAt - events[0].createdAt) / 1000));
    if (time) time.textContent = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
    if (slider) {
      slider.max = String(Math.max(0, events.length - 1));
      slider.value = String(index);
    }
    if (liveButton) liveButton.classList.toggle("is-live", followLive);
    renderTimeline(index);
    moveCursorToTarget();
  };

  const unsubscribe = agentLiveActivity.subscribe((event) => {
    if (event.sessionId !== sessionId) {
      sessionId = event.sessionId;
      events = [];
      followLive = true;
    }
    events = agentLiveActivity.snapshot();
    if (followLive) renderEvent(events.length - 1);
  });

  slider?.addEventListener("input", () => {
    followLive = Number(slider.value) >= events.length - 1;
    renderEvent(Number(slider.value));
  });
  liveButton?.addEventListener("click", () => {
    followLive = true;
    renderEvent(events.length - 1);
  });
  panel.querySelector<HTMLButtonElement>("[data-playback-collapse]")?.addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const collapsed = panel.classList.toggle("is-collapsed");
    button.setAttribute("aria-expanded", String(!collapsed));
    button.textContent = collapsed ? "+" : "-";
  });

  return () => {
    unsubscribe();
    panel.remove();
  };
}
