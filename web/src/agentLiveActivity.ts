import type { ResearchContentBlock, ResearchSource } from "./research/ResearchTypes";

export type ResearchActivityType =
  | "session-start"
  | "question-understood"
  | "plan-created"
  | "skill-selected"
  | "skill-start"
  | "skill-complete"
  | "model-candidate-found"
  | "model-selected"
  | "query-created"
  | "query-typing"
  | "search-started"
  | "search-submit"
  | "search-results"
  | "pointer-move"
  | "pointer-click"
  | "tab-open"
  | "tab-activate"
  | "content-loaded"
  | "scroll-to-block"
  | "read-block-start"
  | "read-block-progress"
  | "read-word-progress"
  | "read-block-complete"
  | "pdf-open"
  | "pdf-page-rendered"
  | "pdf-page-read"
  | "figure-open"
  | "figure-analysed"
  | "media-loaded"
  | "media-analysed"
  | "evidence-saved"
  | "contradiction-found"
  | "replan-created"
  | "tab-close"
  | "writing-start"
  | "writing-token"
  | "citation-validation"
  | "claim-validated"
  | "validation-complete"
  | "session-complete"
  | "session-error";

export type PlaybackTab = {
  id: string;
  kind: "search" | "article" | "pdf" | "figure" | "writing";
  title: string;
  url: string;
  active: boolean;
  closed: boolean;
  scrollTop: number;
};

export type AgentActivitySource = Pick<
  ResearchSource,
  "id" | "title" | "provider" | "url" | "pdfUrl" | "abstract" | "authors" | "year" | "status"
>;

export type ResearchActivityPayload = {
  question?: string;
  query?: string;
  provider?: string;
  url?: string;
  tab?: PlaybackTab;
  tabId?: string;
  targetId?: string;
  source?: AgentActivitySource;
  sources?: AgentActivitySource[];
  blocks?: ResearchContentBlock[];
  block?: ResearchContentBlock;
  blockId?: string;
  evidenceId?: string;
  page?: number;
  totalPages?: number;
  token?: string;
  wordIndex?: number;
  wordCount?: number;
  characterIndex?: number;
  characterCount?: number;
  supportRatio?: number;
  capability?: string;
  capabilities?: string[];
  skillId?: string;
  modelId?: string;
  searchLabel?: string;
  searchUrl?: string;
  iteration?: number;
  validationErrors?: string[];
  detail?: string;
  progress?: number;
};

export type AgentActivityEvent = {
  id: string;
  sessionId: string;
  type: ResearchActivityType;
  title: string;
  payload: ResearchActivityPayload;
  sequence: number;
  timestamp: number;
  stateVersion: number;
};

type ActivityInput = {
  type: ResearchActivityType;
  title: string;
  payload?: ResearchActivityPayload;
};

type ActivityListener = (event: AgentActivityEvent) => void;

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

class ResearchPlaybackBus {
  private listeners = new Set<ActivityListener>();
  private events: AgentActivityEvent[] = [];
  private activeSessionId = "";
  private sequence = 0;
  private stateVersion = 0;

  start(question: string): string {
    const sessionId = uniqueId("research");
    this.activeSessionId = sessionId;
    this.events = [];
    this.sequence = 0;
    this.stateVersion += 1;
    this.emit(sessionId, {
      type: "session-start",
      title: "Sesi riset dimulai",
      payload: { question, progress: 0 },
    });
    return sessionId;
  }

  emit(sessionId: string, input: ActivityInput): AgentActivityEvent {
    const event: AgentActivityEvent = {
      id: uniqueId("event"),
      sessionId,
      type: input.type,
      title: input.title,
      payload: input.payload || {},
      sequence: this.sequence += 1,
      timestamp: performance.timeOrigin + performance.now(),
      stateVersion: this.stateVersion,
    };
    if (sessionId === this.activeSessionId) {
      this.events.push(event);
      if (this.events.length > 4_000) this.events.splice(0, this.events.length - 4_000);
    }
    this.listeners.forEach((listener) => listener(event));
    return event;
  }

  complete(sessionId: string, detail: string): void {
    this.emit(sessionId, {
      type: "session-complete",
      title: "Riset selesai",
      payload: { detail, progress: 100 },
    });
  }

  fail(sessionId: string, error: unknown): void {
    this.emit(sessionId, {
      type: "session-error",
      title: "Riset berhenti",
      payload: {
        detail: error instanceof Error ? error.message : String(error),
        progress: 100,
      },
    });
  }

  subscribe(listener: ActivityListener): () => void {
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

export const agentLiveActivity = new ResearchPlaybackBus();

type ViewState = {
  tabs: Map<string, PlaybackTab>;
  blocksByTab: Map<string, ResearchContentBlock[]>;
  readWordsByBlock: Map<string, number>;
  sources: AgentActivitySource[];
  activeTabId: string;
  query: string;
  searchLabel: string;
  searchUrl: string;
  searchPending: boolean;
  writing: string;
  highlightedTarget: string;
  pointerTarget: string;
  pointerClick: boolean;
  status: string;
  progress: number;
};

function initialState(): ViewState {
  return {
    tabs: new Map(),
    blocksByTab: new Map(),
    readWordsByBlock: new Map(),
    sources: [],
    activeTabId: "",
    query: "",
    searchLabel: "ITS Open Search",
    searchUrl: "about:research",
    searchPending: false,
    writing: "",
    highlightedTarget: "",
    pointerTarget: "",
    pointerClick: false,
    status: "Menyiapkan riset",
    progress: 0,
  };
}

function cloneState(value: ViewState): ViewState {
  return {
    ...value,
    tabs: new Map([...value.tabs.entries()].map(([key, tab]) => [key, { ...tab }])),
    blocksByTab: new Map([...value.blocksByTab.entries()].map(([key, blocks]) => [key, blocks.map((block) => ({ ...block }))])),
    readWordsByBlock: new Map(value.readWordsByBlock),
    sources: value.sources.map((source) => ({ ...source })),
  };
}

function reduceEvent(state: ViewState, event: AgentActivityEvent): void {
  const payload = event.payload;
  state.status = event.title;
  if (payload.progress != null) state.progress = clamp(payload.progress, 0, 100);
  switch (event.type) {
    case "session-start": {
      const tab: PlaybackTab = {
        id: "search",
        kind: "search",
        title: payload.searchLabel || "ITS Open Search",
        url: payload.searchUrl || "about:research",
        active: true,
        closed: false,
        scrollTop: 0,
      };
      state.tabs.set(tab.id, tab);
      state.activeTabId = tab.id;
      state.query = "";
      state.searchPending = false;
      break;
    }
    case "search-started": {
      state.searchLabel = payload.searchLabel || state.searchLabel;
      state.searchUrl = payload.searchUrl || state.searchUrl;
      state.query = "";
      state.sources = [];
      state.searchPending = false;
      const searchTab = state.tabs.get("search");
      if (searchTab) {
        searchTab.title = state.searchLabel;
        searchTab.url = state.searchUrl;
      }
      break;
    }
    case "query-created":
      state.searchLabel = payload.searchLabel || state.searchLabel;
      state.searchUrl = payload.searchUrl || state.searchUrl;
      break;
    case "query-typing":
      state.query = payload.query || "";
      break;
    case "search-submit": {
      state.searchPending = true;
      const searchTab = state.tabs.get("search");
      if (searchTab) {
        searchTab.title = state.query ? `${state.query} - ${state.searchLabel}` : state.searchLabel;
        searchTab.url = `${state.searchUrl}?q=${encodeURIComponent(state.query)}`;
      }
      break;
    }
    case "search-results":
      state.sources = payload.sources || [];
      state.searchPending = false;
      break;
    case "tab-open":
    case "pdf-open":
    case "figure-open":
    case "writing-start": {
      if (payload.tab) {
        state.tabs.forEach((tab) => { tab.active = false; });
        state.tabs.set(payload.tab.id, { ...payload.tab, active: true, closed: false });
        state.activeTabId = payload.tab.id;
      }
      if (event.type === "writing-start") state.writing = "";
      break;
    }
    case "tab-activate": {
      const tabId = payload.tabId || "";
      state.tabs.forEach((tab) => { tab.active = tab.id === tabId; });
      if (state.tabs.has(tabId)) state.activeTabId = tabId;
      break;
    }
    case "content-loaded":
      if (payload.tabId) state.blocksByTab.set(payload.tabId, payload.blocks || []);
      break;
    case "scroll-to-block":
    case "read-block-start":
    case "pdf-page-read":
    case "figure-analysed":
    case "evidence-saved":
      state.highlightedTarget = payload.targetId || payload.blockId || state.highlightedTarget;
      break;
    case "read-block-complete":
      if (state.highlightedTarget === (payload.targetId || payload.blockId)) state.highlightedTarget = "";
      break;
    case "read-word-progress":
      if (payload.blockId) state.readWordsByBlock.set(payload.blockId, payload.wordIndex || 0);
      state.highlightedTarget = payload.targetId || payload.blockId || state.highlightedTarget;
      break;
    case "pointer-move":
      state.pointerTarget = payload.targetId || "";
      state.pointerClick = false;
      break;
    case "pointer-click":
      state.pointerTarget = payload.targetId || state.pointerTarget;
      state.pointerClick = true;
      break;
    case "writing-token":
      state.writing += payload.token || "";
      break;
    case "tab-close": {
      const tab = state.tabs.get(payload.tabId || "");
      if (tab) {
        tab.closed = true;
        tab.active = false;
      }
      const fallback = [...state.tabs.values()].reverse().find((candidate) => !candidate.closed);
      if (fallback) {
        fallback.active = true;
        state.activeTabId = fallback.id;
      }
      break;
    }
    default:
      break;
  }
}

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

function safeUrl(value: string): string {
  try {
    const url = new URL(value, window.location.href);
    return ["http:", "https:", "about:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function providerLabel(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === "openalex") return "OpenAlex";
  if (normalized === "europepmc") return "Europe PMC";
  if (normalized === "crossref") return "Crossref";
  if (normalized === "wikipedia") return "Wikipedia";
  if (normalized === "wikimedia") return "Wikimedia";
  return value || "Web";
}

function faviconUrl(value: string): string {
  try {
    const url = new URL(value, window.location.href);
    if (!/^https?:$/.test(url.protocol)) return "";
    return new URL("/favicon.ico", url.origin).href;
  } catch {
    return "";
  }
}

function createFavicon(
  className: string,
  pageUrl: string,
  fallback: string,
  kind = "article",
): HTMLElement {
  const icon = createElement("i", className, fallback.slice(0, 1).toUpperCase());
  icon.dataset.kind = kind;
  const source = faviconUrl(pageUrl);
  if (!source) return icon;
  const image = document.createElement("img");
  image.src = source;
  image.alt = "";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("load", () => {
    icon.textContent = "";
    icon.appendChild(image);
    icon.classList.add("has-image");
  }, { once: true });
  return icon;
}

function sourceForTab(state: ViewState, tab: PlaybackTab): AgentActivitySource | undefined {
  return state.sources.find((source) => source.id === tab.id || safeUrl(source.url) === safeUrl(tab.url));
}

function eventElapsed(events: AgentActivityEvent[], timestamp: number): string {
  if (!events.length) return "0:00";
  const seconds = Math.max(0, Math.round((timestamp - events[0].timestamp) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

type PlaybackUi = {
  tabs: HTMLElement;
  address: HTMLElement;
  viewport: HTMLElement;
  cursor: HTMLElement;
  status: HTMLElement;
  progress: HTMLElement;
  timeline: HTMLOListElement;
  time: HTMLOutputElement;
  slider: HTMLInputElement;
  live: HTMLButtonElement;
};

function appendProgressiveText(parent: HTMLElement, text: string, wordsRead: number): void {
  const words = text.split(/(\s+)/);
  let visibleIndex = 0;
  words.forEach((word) => {
    if (!word.trim()) {
      parent.appendChild(document.createTextNode(word));
      return;
    }
    const span = createElement("span", visibleIndex < wordsRead ? "is-read" : "", word);
    parent.appendChild(span);
    visibleIndex += 1;
  });
}

function renderBlock(block: ResearchContentBlock, highlighted: string, wordsRead = 0): HTMLElement {
  const targetId = `article-block-${block.id}`;
  const container = createElement("section", `its-research-content-block is-${block.type}`);
  container.dataset.playbackId = targetId;
  container.classList.toggle("is-reading", highlighted === targetId || highlighted === block.id);
  if (block.type === "heading") container.appendChild(createElement("h4", "", block.text));
  else if (block.type === "code" || block.type === "equation") {
    const pre = createElement("pre");
    pre.appendChild(createElement("code", "", block.text));
    container.appendChild(pre);
  } else if (block.type === "image" && block.imageUrl) {
    const image = document.createElement("img");
    image.src = block.imageUrl;
    image.alt = block.alt || block.text;
    image.loading = "lazy";
    container.append(image, createElement("p", "", block.text));
  } else {
    const paragraph = createElement("p");
    appendProgressiveText(paragraph, block.text, wordsRead);
    container.appendChild(paragraph);
  }
  if (block.page != null) container.appendChild(createElement("small", "", `Halaman ${block.page}`));
  return container;
}

function renderSearch(state: ViewState): HTMLElement {
  const shell = createElement("section", "its-academic-search");
  const brand = createElement("div", "its-academic-brand");
  brand.append(
    createElement("span", "its-academic-brand-mark", "ITS"),
    createElement("strong", "", state.searchLabel),
    createElement("small", "", "Open sources, verified evidence"),
  );
  shell.appendChild(brand);
  const query = createElement("div", "its-academic-query");
  const value = createElement("span", "its-academic-query-text", state.query);
  value.dataset.playbackId = "search-query";
  if (!state.searchPending && !state.sources.length) value.appendChild(createElement("i", "its-academic-caret"));
  const searchButton = createElement("span", "its-academic-search-button");
  searchButton.dataset.playbackId = "search-submit";
  searchButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"></circle><path d="m16 16 4 4"></path></svg><span>Cari</span>';
  query.append(value, searchButton);
  shell.appendChild(query);
  if (state.searchPending) {
    const loading = createElement("div", "its-academic-loading");
    for (let index = 0; index < 3; index += 1) {
      const row = createElement("div", "its-academic-skeleton");
      row.append(createElement("i"), createElement("span"));
      loading.appendChild(row);
    }
    shell.appendChild(loading);
  }
  if (state.sources.length) {
    const resultShell = createElement("div", "its-academic-results");
    state.sources.forEach((source, index) => {
      const item = createElement("article", "its-research-result");
      item.dataset.playbackId = `result-${source.id}`;
      const favicon = createFavicon(
        "its-research-result-favicon",
        source.url,
        providerLabel(source.provider),
      );
      favicon.dataset.provider = source.provider.toLowerCase();
      const body = createElement("div", "its-research-result-body");
      const link = createElement("a", "", source.title);
      link.href = safeUrl(source.url) || "#";
      link.target = "_blank";
      link.rel = "noopener";
      const meta = createElement("span", "", `${providerLabel(source.provider)}${source.year ? ` - ${source.year}` : ""}`);
      const text = createElement("p", "", source.abstract || `Status akses: ${source.status}`);
      body.append(link, meta, text);
      if (source.pdfUrl) {
        const pdf = createElement("a", "its-research-pdf-badge", "PDF");
        pdf.href = safeUrl(source.pdfUrl) || "#";
        pdf.target = "_blank";
        pdf.rel = "noopener";
        body.appendChild(pdf);
      }
      item.append(favicon, body);
      if (index === 0) item.classList.add("is-top-result");
      resultShell.appendChild(item);
    });
    shell.appendChild(resultShell);
  }
  return shell;
}

function renderActiveViewport(state: ViewState): HTMLElement {
  const tab = state.tabs.get(state.activeTabId);
  if (!tab || tab.kind === "search") return renderSearch(state);
  if (tab.kind === "writing") {
    const writing = createElement("article", "its-research-writing");
    writing.dataset.playbackId = "writing-output";
    writing.append(createElement("span", "", "DRAFT GROUNDED"), createElement("p", "", state.writing || "Menunggu token model..."));
    return writing;
  }
  const source = sourceForTab(state, tab);
  const article = createElement("article", "its-research-reader");
  article.append(
    createElement("span", "", `${providerLabel(source?.provider || "web")} - ${source?.status || "full-text"}`),
    createElement("h4", "", tab.title),
  );
  const blocks = state.blocksByTab.get(tab.id) || [];
  if (blocks.length) blocks.forEach((block) => article.appendChild(renderBlock(block, state.highlightedTarget, state.readWordsByBlock.get(block.id) || 0)));
  else {
    const loading = createElement("div", "its-research-reader-loading");
    loading.setAttribute("role", "status");
    loading.setAttribute("aria-live", "polite");
    loading.append(
      createElement("strong", "", "Dokumen aktual sedang dibaca"),
      createElement("p", "", "Blok teks akan tampil setelah ekstraksi halaman selesai."),
    );
    const skeleton = createElement("div", "its-research-reader-skeleton");
    skeleton.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 5; index += 1) skeleton.appendChild(createElement("i"));
    loading.appendChild(skeleton);
    article.appendChild(loading);
  }
  return article;
}

function pointerPosition(root: HTMLElement, target: HTMLElement): { x: number; y: number } {
  const rootRect = root.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  return {
    x: clamp(targetRect.left - rootRect.left + targetRect.width * 0.55, 8, Math.max(8, rootRect.width - 24)),
    y: clamp(targetRect.top - rootRect.top + Math.min(targetRect.height * 0.45, 34), 8, Math.max(8, rootRect.height - 30)),
  };
}

function movePointer(ui: PlaybackUi, targetId: string, clicking: boolean, animate: boolean): void {
  if (!targetId) return;
  const selector = `[data-playback-id="${CSS.escape(targetId)}"]`;
  const target = ui.viewport.querySelector<HTMLElement>(selector) || ui.tabs.querySelector<HTMLElement>(selector);
  if (!target) return;
  requestAnimationFrame(() => {
    const destination = pointerPosition(ui.viewport.parentElement || ui.viewport, target);
    const currentX = Number(ui.cursor.dataset.x || 12);
    const currentY = Number(ui.cursor.dataset.y || 72);
    const distance = Math.hypot(destination.x - currentX, destination.y - currentY);
    const duration = animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? clamp(distance * 2.4, 180, 780)
      : 0;
    ui.cursor.getAnimations().forEach((animation) => animation.cancel());
    ui.cursor.animate([
      { transform: `translate3d(${currentX}px, ${currentY}px, 0)` },
      { transform: `translate3d(${currentX + (destination.x - currentX) * 0.28}px, ${currentY + (destination.y - currentY) * 0.14}px, 0)`, offset: 0.35 },
      { transform: `translate3d(${currentX + (destination.x - currentX) * 0.72}px, ${currentY + (destination.y - currentY) * 0.86}px, 0)`, offset: 0.72 },
      { transform: `translate3d(${destination.x}px, ${destination.y}px, 0)` },
    ], { duration, easing: "cubic-bezier(.22,.7,.2,1)", fill: "forwards" });
    ui.cursor.dataset.x = String(destination.x);
    ui.cursor.dataset.y = String(destination.y);
    ui.cursor.classList.toggle("is-clicking", clicking);
    if (clicking) window.setTimeout(() => ui.cursor.classList.remove("is-clicking"), Math.max(160, duration + 80));
  });
}

/**
 * Mounts a visual replay of the real research event stream. The panel never
 * claims to control external browser tabs; every visible source, block and PDF
 * page comes from the same data supplied to the research synthesizer.
 */
export function mountAgentLiveActivity(host: HTMLElement): () => void {
  const panel = createElement("section", "its-agent-playback");
  panel.hidden = true;
  panel.setAttribute("aria-label", "Aktivitas riset AI langsung");
  host.appendChild(panel);

  let activeSessionId = "";
  let events: AgentActivityEvent[] = [];
  let state = initialState();
  let followLive = true;
  let completionTimer = 0;
  let clockTimer = 0;
  let sessionFinished = false;
  let ui: PlaybackUi | null = null;

  const ensureUi = (): PlaybackUi => {
    if (ui) return ui;
    panel.hidden = false;
    panel.innerHTML = `
      <header class="its-agent-playback-head">
        <div><span><i aria-hidden="true"></i> <b data-playback-mode>LIVE</b></span><strong data-playback-status>Riset publik</strong></div>
        <button type="button" data-playback-collapse aria-expanded="true" aria-label="Minimalkan aktivitas riset">-</button>
      </header>
      <div class="its-agent-playback-body">
        <div class="its-research-browser" data-playback-browser>
          <div class="its-research-browser-bar"><span class="its-browser-lights" aria-hidden="true"><i></i><i></i><i></i></span><div class="its-research-tabs" data-playback-tabs></div><span class="its-browser-new-tab" aria-hidden="true">+</span></div>
          <div class="its-research-address"><span class="its-research-nav" aria-hidden="true">&#x2039;&nbsp;&nbsp;&#x203A;</span><span class="its-research-address-pill"><svg class="its-research-lock" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg><code data-playback-url>about:research</code></span><span class="its-research-browser-menu" aria-hidden="true">&#x22EE;</span></div>
          <div class="its-research-viewport" data-playback-viewport></div>
          <span class="its-research-cursor" data-playback-cursor data-x="12" data-y="72" aria-hidden="true"><svg viewBox="0 0 18 24"><path d="M1 1v18l5-4 3.3 7 3-1.4-3.2-6.7H16L1 1Z"/></svg></span>
        </div>
        <div class="its-agent-playback-controls"><output data-playback-time>0:00</output><input type="range" min="0" max="0" value="0" step="1" aria-label="Posisi waktu aktivitas riset"><button type="button" data-playback-live class="is-live">LIVE</button></div>
        <div class="its-agent-playback-progress"><i data-playback-progress></i></div>
        <ol class="its-agent-playback-timeline" data-playback-timeline></ol>
      </div>`;
    ui = {
      tabs: panel.querySelector<HTMLElement>("[data-playback-tabs]")!,
      address: panel.querySelector<HTMLElement>("[data-playback-url]")!,
      viewport: panel.querySelector<HTMLElement>("[data-playback-viewport]")!,
      cursor: panel.querySelector<HTMLElement>("[data-playback-cursor]")!,
      status: panel.querySelector<HTMLElement>("[data-playback-status]")!,
      progress: panel.querySelector<HTMLElement>("[data-playback-progress]")!,
      timeline: panel.querySelector<HTMLOListElement>("[data-playback-timeline]")!,
      time: panel.querySelector<HTMLOutputElement>("[data-playback-time]")!,
      slider: panel.querySelector<HTMLInputElement>("input[type='range']")!,
      live: panel.querySelector<HTMLButtonElement>("[data-playback-live]")!,
    };
    panel.querySelector<HTMLButtonElement>("[data-playback-collapse]")?.addEventListener("click", (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const collapsed = panel.classList.toggle("is-collapsed");
      button.textContent = collapsed ? "+" : "-";
      button.setAttribute("aria-expanded", String(!collapsed));
    });
    ui.slider.addEventListener("input", () => {
      followLive = false;
      renderAt(Number(ui?.slider.value || 0), false);
    });
    ui.live.addEventListener("click", () => {
      followLive = true;
      renderAt(events.at(-1)?.timestamp || 0, false);
    });
    return ui;
  };

  const renderTabs = (current: PlaybackUi, view: ViewState) => {
    const visibleTabs = [...view.tabs.values()].filter((tab) => !tab.closed);
    current.tabs.replaceChildren(...visibleTabs.map((tab) => {
      const element = createElement("span", `its-research-tab${tab.active ? " is-active" : ""}`);
      element.dataset.playbackId = `tab-${tab.id}`;
      const source = sourceForTab(view, tab);
      const icon = tab.kind === "search"
        ? createFavicon("its-research-tab-favicon", window.location.origin, "ITS", "search")
        : createFavicon(
          "its-research-tab-favicon",
          source?.url || tab.url,
          tab.kind === "pdf" ? "PDF" : providerLabel(source?.provider || "Web"),
          tab.kind,
        );
      element.append(icon, createElement("span", "its-research-tab-label", tab.title));
      if (tab.kind !== "search") {
        const close = createElement("i", "its-research-tab-close", "x");
        close.dataset.playbackId = `tab-close-${tab.id}`;
        element.appendChild(close);
      }
      return element;
    }));
  };

  const renderTimeline = (current: PlaybackUi, timestamp: number) => {
    const visible = events.filter((event) => event.timestamp <= timestamp).slice(-5);
    current.timeline.replaceChildren(...visible.map((event, index) => {
      const item = createElement("li", index === visible.length - 1 ? "active" : "");
      item.append(createElement("i"), createElement("span", "", event.title));
      return item;
    }));
  };

  const renderState = (view: ViewState, timestamp: number, animate: boolean) => {
    const current = ensureUi();
    renderTabs(current, view);
    const tab = view.tabs.get(view.activeTabId);
    current.address.textContent = tab?.url || "about:research";
    current.viewport.replaceChildren(renderActiveViewport(view));
    const selectedTab = view.tabs.get(view.activeTabId);
    if (selectedTab?.scrollTop) current.viewport.scrollTop = selectedTab.scrollTop;
    if (view.highlightedTarget) {
      const target = current.viewport.querySelector<HTMLElement>(`[data-playback-id="${CSS.escape(view.highlightedTarget)}"]`)
        || current.viewport.querySelector<HTMLElement>(`[data-playback-id="${CSS.escape(`article-block-${view.highlightedTarget}`)}"]`);
      target?.scrollIntoView({ block: "center", behavior: animate ? "smooth" : "auto" });
    }
    movePointer(current, view.pointerTarget, view.pointerClick, animate);
    current.status.textContent = view.status;
    current.progress.style.width = `${view.progress}%`;
    const duration = events.length ? Math.max(0, (events.at(-1)!.timestamp - events[0].timestamp)) : 0;
    const elapsed = events.length ? Math.max(0, timestamp - events[0].timestamp) : 0;
    current.slider.max = String(Math.max(1, Math.round(duration)));
    current.slider.value = String(clamp(Math.round(elapsed), 0, Math.max(1, Math.round(duration))));
    current.time.textContent = eventElapsed(events, timestamp);
    current.live.classList.toggle("is-live", followLive);
    current.live.textContent = followLive ? "LIVE" : "KEMBALI LIVE";
    panel.dataset.playbackQuery = view.query;
    const mode = panel.querySelector<HTMLElement>("[data-playback-mode]");
    if (mode) mode.textContent = followLive ? "LIVE" : "REPLAY";
    renderTimeline(current, timestamp);
  };

  const stateAt = (timestamp: number): ViewState => {
    const rebuilt = initialState();
    events.filter((event) => event.timestamp <= timestamp).forEach((event) => reduceEvent(rebuilt, event));
    return rebuilt;
  };

  const renderAt = (timestamp: number, animate: boolean) => {
    state = stateAt(timestamp);
    renderState(cloneState(state), timestamp, animate);
  };

  const unsubscribe = agentLiveActivity.subscribe((event) => {
    if (event.sessionId !== activeSessionId) {
      window.clearTimeout(completionTimer);
      activeSessionId = event.sessionId;
      events = [];
      state = initialState();
      followLive = true;
      sessionFinished = false;
      panel.replaceChildren();
      ui = null;
      window.clearInterval(clockTimer);
      clockTimer = window.setInterval(() => {
        if (!followLive || sessionFinished || !events.length || !ui) return;
        renderState(cloneState(state), performance.timeOrigin + performance.now(), false);
      }, 250);
    }
    events.push(event);
    if (followLive) {
      reduceEvent(state, event);
      renderState(cloneState(state), event.timestamp, true);
    } else if (ui) {
      const duration = Math.max(1, Math.round(event.timestamp - events[0].timestamp));
      ui.slider.max = String(duration);
    }
    if ((event.type === "session-complete" || event.type === "session-error") && followLive) {
      sessionFinished = true;
      window.clearTimeout(completionTimer);
      completionTimer = window.setTimeout(() => {
        if (!followLive) return;
        panel.hidden = true;
      }, 10_000);
    }
  });

  return () => {
    window.clearTimeout(completionTimer);
    window.clearInterval(clockTimer);
    unsubscribe();
    panel.remove();
  };
}
