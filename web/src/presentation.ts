import "./presentation.css";

import JSZip from "jszip";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { runPptAiPipeline } from "./ppt-ai-pipeline";
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, GoogleAuthProvider, linkWithPopup, signInAnonymously, signInWithPopup, type User } from "firebase/auth";
import {
  connectDatabaseEmulator,
  get,
  getDatabase,
  onChildAdded,
  onDisconnect,
  onValue,
  push,
  ref,
  remove,
  serverTimestamp,
  set,
  update,
  type Unsubscribe,
} from "firebase/database";
import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import {
  AdbDaemonWebUsbDeviceManager,
  type AdbDaemonWebUsbDevice,
  type AdbDaemonWebUsbConnection,
} from "@yume-chan/adb-daemon-webusb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCjF1ukhniubgZf4K-zNaY9EdB8Yq8wAsg",
  authDomain: "itstelkom.firebaseapp.com",
  databaseURL: "https://itstelkom-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "itstelkom",
  storageBucket: "itstelkom.firebasestorage.app",
  messagingSenderId: "224371234284",
  appId: "1:224371234284:web:e2b2f4711fae246a545cc9",
};
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const SLIDE_WIDTH = 960;
const SLIDE_HEIGHT = 540;
const BROADCAST_SCALE = 2;
const SAVE_DELAY = 450;
const MIRROR_INTERVAL = 260;
const PPTX_EMU_PER_INCH = 914400;
const PPTX_FONT_SCALE = 1;
const DEFAULT_PPTX_SLIDE = { cx: 12192000, cy: 6858000 };
const CANVA_CAPTURE_HELP = "Canva tidak memberi izin membaca data desain langsung dari browser, jadi ITS Presentasi akan mengimpor link Canva sebagai gambar slide lewat izin share tab/window. Buka Canva, pilih mode presentasi, lalu izinkan capture tab/window Canva.";
const CANVA_AUTO_UPDATE_INTERVAL = 180_000;
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

type Role = "owner" | "editor" | "viewer";
type TextVariant = "title" | "body";
type ElementAnimation = "" | "appear" | "fade" | "fly" | "wipe" | "zoom" | "motion";
type TextElement = {
  id: string;
  type: "text";
  variant: TextVariant;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: "left" | "center" | "right";
  insetLeft?: number;
  insetRight?: number;
  insetTop?: number;
  insetBottom?: number;
  lineHeight?: number;
  animation?: ElementAnimation;
};
type PhoneElement = {
  id: string;
  type: "phone";
  x: number;
  y: number;
  w: number;
  h: number;
  deviceSerial: string | null;
  deviceLabel?: string;
  animation?: ElementAnimation;
};
type ImageElement = {
  id: string;
  type: "image";
  x: number;
  y: number;
  w: number;
  h: number;
  src: string;
  alt?: string;
  animation?: ElementAnimation;
};
type CanvasElement = {
  id: string;
  type: "canvas";
  x: number;
  y: number;
  w: number;
  h: number;
  src: string;
  alt?: string;
  animation?: ElementAnimation;
};
type CanvaElement = {
  id: string;
  type: "canva";
  x: number;
  y: number;
  w: number;
  h: number;
  url: string;
  embedUrl: string;
  title?: string;
  animation?: ElementAnimation;
};
type ShapeElement = {
  id: string;
  type: "shape";
  x: number;
  y: number;
  w: number;
  h: number;
  shape: "rect" | "ellipse" | "line";
  fill?: string;
  stroke?: string;
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: "left" | "center" | "right";
  insetLeft?: number;
  insetRight?: number;
  insetTop?: number;
  insetBottom?: number;
  lineHeight?: number;
  tableId?: string;
  tableRow?: number;
  tableCol?: number;
  animation?: ElementAnimation;
};
type SlideElement = TextElement | PhoneElement | ImageElement | CanvasElement | CanvaElement | ShapeElement;
type Slide = { id: string; name: string; notes: string; elements: SlideElement[]; transition?: string; section?: string };
type DeckSource = {
  type: "canva";
  url: string;
  mode?: "capture";
  resolvedUrl?: string;
  viewUrl?: string;
  signature?: string;
  version?: string;
  timestamp?: number;
  pageCount?: number;
  importedAt?: number;
  lastCheckedAt?: number;
  autoUpdate?: boolean;
};
type Deck = { title: string; slides: Slide[]; source?: DeckSource };
type CanvaImportSlide = {
  page: number;
  pageHash?: number;
  width?: number;
  height?: number;
  mime?: string;
  src: string;
  elements?: unknown[];
};
type CanvaImportResult = {
  ok?: boolean;
  title: string;
  sourceUrl: string;
  mode?: "capture";
  resolvedUrl?: string;
  viewUrl?: string;
  importedAt?: number;
  version?: string;
  timestamp?: number;
  pageCount?: number;
  pageHashes?: number[];
  signature?: string;
  slides: CanvaImportSlide[];
};
type PresentationState = {
  currentSlide: number;
  presenting: boolean;
  presenterSession?: string | null;
  updatedAt?: number;
};
type PresentationRecord = {
  ownerUid: string;
  ownerName?: string;
  visibility: "public";
  deck: Deck;
  state: PresentationState;
  createdAt: number;
  updatedAt: number;
};
type CursorPresence = {
  x: number;
  y: number;
  slide: number;
  visible: boolean;
  target?: string;
  targetId?: string;
  editing?: string;
  updatedAt?: number;
};
type PresenceRecord = { uid: string; sessionId: string; name: string; role: Role; color: string; lastSeen: number | object; slide?: number; cursor?: CursorPresence };
type ProjectIndexRecord = { title: string; updatedAt: number; createdAt: number };
type SharedProjectRecord = { id: string; title: string; role: Role; updatedAt: number; createdAt?: number; ownerUid?: string; url?: string };
type CollaborationPacket = { uid: string; name: string; deck: Deck; updatedAt: number };
type CommentRecord = {
  id: string;
  slide: number;
  elementId: string;
  elementLabel: string;
  elementKind: SlideElement["type"];
  elementText?: string;
  elementImage?: string;
  authorUid: string;
  authorName: string;
  authorColor: string;
  text: string;
  createdAt: number | object;
  parentId?: string;
  reactions?: {
    like?: Record<string, boolean>;
  };
  resolved?: boolean;
  resolvedAt?: number | object;
  deleted?: boolean;
};
type ConnectedAdb = { device: AdbDaemonWebUsbDevice; connection: AdbDaemonWebUsbConnection; adb: Adb; label: string };
type MirrorState = { running: boolean; lastUrl: string | null };
type BrowserUsbDevice = {
  manufacturerName?: string;
  productName?: string;
  vendorId: number;
  productId: number;
  opened: boolean;
  configurations?: Array<{ interfaces?: Array<{ interfaceNumber: number; alternates?: Array<{ interfaceClass: number; interfaceSubclass: number; interfaceProtocol: number }> }> }>;
};
type BrowserUsbConnectionEvent = { device: unknown };
type BrowserUsbApi = {
  getDevices(): Promise<BrowserUsbDevice[]>;
  addEventListener(type: "connect" | "disconnect", listener: (event: BrowserUsbConnectionEvent) => void): void;
};
type MenuItem = {
  label?: string;
  icon?: string;
  shortcut?: string;
  disabled?: () => boolean;
  checked?: () => boolean;
  action?: () => void | Promise<void>;
  items?: MenuItem[];
  separator?: boolean;
};
type PptxRelationship = { id: string; target: string; type: string };
type PptxRunStyle = Pick<TextElement, "fontFamily" | "fontSize" | "color" | "bold" | "italic" | "underline" | "align" | "insetLeft" | "insetRight" | "insetTop" | "insetBottom" | "lineHeight">;

const $ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T => {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Elemen UI tidak ditemukan: ${selector}`);
  return found;
};
const uid = (prefix = "id") => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 14)}`;
const clone = <T>(value: T): T => structuredClone(value);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let projectOwnerUid = "";
const isWritableOwner = () => role === "owner" && (!projectOwnerUid || projectOwnerUid === firebaseUser?.uid);
const isEditableRole = () => role === "editor" || isWritableOwner();

const savedParticipantName = localStorage.getItem("its-presentasi-name") || localStorage.getItem("its-presentasi-anonymous-name") || sessionStorage.getItem("its-presentasi-name") || "";
let participantName = savedParticipantName || `Anonymous ${Math.floor(1000 + Math.random() * 9000)}`;
if (!localStorage.getItem("its-presentasi-name") && !localStorage.getItem("its-presentasi-anonymous-name")) {
  localStorage.setItem("its-presentasi-anonymous-name", participantName);
}
sessionStorage.setItem("its-presentasi-name", participantName);

const firebaseApp = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(firebaseApp);
const googleProvider = new GoogleAuthProvider();
const db = getDatabase(firebaseApp);
const params = new URLSearchParams(location.search);
const emulatorMode = params.get("emulator") === "1";
const localMode = params.get("local") === "1" || params.get("test") === "1";
if (emulatorMode) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectDatabaseEmulator(db, "127.0.0.1", 9000);
}

let firebaseUser: User;
let projectId = params.get("p") || "";
let editorToken = params.get("edit") || "";
let role: Role = params.get("view") === "1" ? "viewer" : editorToken ? "editor" : "owner";
let deck: Deck = defaultDeck();
let presentationState: PresentationState = { currentSlide: 0, presenting: false };
let projectCreatedAt = 0;
let currentSlide = 0;
let slideDragIndex = -1;
let presenterSlide = 0;
let followingPresenter = true;
let selectedElementId: string | null = null;
let zoom = 1;
let fitZoom = 1;
let saveTimer = 0;
let presenceTimer = 0;
let toastTimer = 0;
let audienceChromeTimer = 0;
let remoteUnsubscribe: Unsubscribe | null = null;
let presenceUnsubscribe: Unsubscribe | null = null;
let collaborationUnsubscribe: Unsubscribe | null = null;
let commentsUnsubscribe: Unsubscribe | null = null;
let rtcViewerUnsubscribe: Unsubscribe | null = null;
let activePresencePath = "";
let presenceSessionId = "";
let lastCursorSent = 0;
let lastCursorPoint: CursorPresence | null = null;
let applyingRemote = false;
let deleteTarget = "";
let lastAppliedCollaboration = 0;
let broadcastTimer = 0;
let presenterCursorTimer = 0;
let broadcastStream: MediaStream | null = null;
let presenterRequestUnsubscribe: Unsubscribe | null = null;
let viewerPeer: RTCPeerConnection | null = null;
const presenterPeers = new Map<string, { peer: RTCPeerConnection; unsubscribers: Unsubscribe[] }>();
const runtimeUnsubscribers: Unsubscribe[] = [];
const connectedDevices = new Map<string, ConnectedAdb>();
const mirrorStates = new Map<string, MirrorState>();
const frameImages = new Map<string, HTMLImageElement>();
const deckImages = new Map<string, HTMLImageElement>();
const undoStack: Deck[] = [];
const redoStack: Deck[] = [];
let lastHistoryJson = "";
let activeMenuButton: HTMLElement | null = null;
let showSpeakerNotes = true;
let joinedSharedProject = false;
let activePresenceRecords: PresenceRecord[] = [];
let activeComments: CommentRecord[] = [];
let activeCommentElementId = "";
let activeCommentSlide = 0;
let pendingCommentAction: { elementId: string; slideIndex: number } | null = null;
let replyTargetCommentId = "";
let replyTargetCommentName = "";
let commentsListenerReady = false;
let seenCommentIds = new Set<string>();
let commentDeepLinkHandled = false;
let pendingReplaceImageElementId = "";
let latestSharedRecords: Record<string, SharedProjectRecord> = {};
let audienceFillMode: "contain" | "cover" = "contain";
let audiencePinchDistance = 0;
let audienceSwipeSuppressClickUntil = 0;
let joinPreviewIndex = 0;
let joinCarouselTimer = 0;
let projectOwnerName = "";
let canvaAutoTimer = 0;
let canvaAutoKey = "";
let canvaAutoInFlight = false;
let canvaCaptureUrl = "";
let canvaCaptureStream: MediaStream | null = null;
let canvaCaptureTimer = 0;
let canvaCaptureSlides: Array<CanvaImportSlide & { hash: string }> = [];

const usbManager = AdbDaemonWebUsbDeviceManager.BROWSER;
const credentialStore = new AdbWebCredentialStore(`PrezADB@${location.hostname}`);
const PRESENTATION_RECENTS_KEY = "its-presentasi-recent-shortcuts:v1";

function defaultDeck(): Deck {
  return {
    title: "Presentasi tanpa judul",
    slides: [{
      id: uid("slide"),
      name: "Slide 1",
      notes: "",
      elements: [
        { id: uid("el"), type: "text", variant: "title", x: 74, y: 226, w: 812, h: 74, text: "Klik - tambahkan judul", fontSize: 50, color: "#000000" },
        { id: uid("el"), type: "text", variant: "body", x: 126, y: 324, w: 708, h: 58, text: "Klik - tambahkan subjudul", fontSize: 30, color: "#5f6368" },
      ],
    }],
  };
}

function cleanColor(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const color = value.trim();
  return /^#[0-9a-f]{6}$/i.test(color) || /^rgba?\(/i.test(color) ? color.slice(0, 64) : fallback;
}

function cleanAnimation(value: unknown): ElementAnimation {
  return ["appear", "fade", "fly", "wipe", "zoom", "motion"].includes(String(value)) ? value as ElementAnimation : "";
}

function cleanFontFamily(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[;"<>]/g, "").trim().slice(0, 80);
  return cleaned || undefined;
}

function sanitizeDeckSource(value: unknown): DeckSource | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<DeckSource> & Record<string, unknown>;
  if (item.type !== "canva") return undefined;
  const url = normalizeCanvaUrl(typeof item.url === "string" ? item.url : typeof item.resolvedUrl === "string" ? item.resolvedUrl : "");
  if (!url) return undefined;
  const source: DeckSource = {
    type: "canva",
    url,
    autoUpdate: item.autoUpdate !== false,
  };
  if (item.mode === "capture") source.mode = "capture";
  const resolvedUrl = normalizeCanvaUrl(typeof item.resolvedUrl === "string" ? item.resolvedUrl : "");
  const viewUrl = normalizeCanvaUrl(typeof item.viewUrl === "string" ? item.viewUrl : "");
  if (resolvedUrl) source.resolvedUrl = resolvedUrl;
  if (viewUrl) source.viewUrl = viewUrl;
  if (typeof item.signature === "string") source.signature = item.signature.slice(0, 600);
  if (typeof item.version === "string") source.version = item.version.slice(0, 120);
  for (const key of ["timestamp", "pageCount", "importedAt", "lastCheckedAt"] as const) {
    const numberValue = Number(item[key]);
    if (Number.isFinite(numberValue)) source[key] = numberValue;
  }
  return source;
}

function normalizeCanvaUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (host === "canva.link" || host.endsWith(".canva.link")) {
      url.search = "";
      url.hash = "";
      return url.href;
    }
    if (!/(^|\.)canva\.com$/i.test(url.hostname)) return null;
    if (!/^\/design\/[^/]+/i.test(url.pathname)) return null;
    url.pathname = url.pathname.replace(/\/(edit|view|watch|present)(\/.*)?$/i, "/view");
    url.hash = "";
    url.search = "";
    return url.href;
  } catch {
    return null;
  }
}

function canvaEmbedUrl(value: string, refresh = false): string {
  const normalized = normalizeCanvaUrl(value) || value;
  const url = new URL(normalized);
  if (/(^|\.)canva\.com$/i.test(url.hostname)) {
    url.pathname = url.pathname.replace(/\/(edit|watch|present)(\/.*)?$/i, "/view");
    url.search = "";
    url.searchParams.set("embed", "");
  }
  if (refresh) url.searchParams.set("its_refresh", String(Date.now()));
  return url.href;
}

async function importCanvaByLink(url: string): Promise<void> {
  if (!isEditableRole()) return;
  const normalized = normalizeCanvaUrl(url);
  if (!normalized) {
    toast("Link Canva tidak valid atau tidak publik.");
    return;
  }
  openCanvaCaptureDialog(normalized);
}

async function requestCanvaImport(url: string): Promise<CanvaImportResult> {
  console.warn("[ITS Presentasi] Canva import requested without backend:", url);
  throw new Error(CANVA_CAPTURE_HELP);
}

function deckFromCanvaImport(result: CanvaImportResult): Deck {
  const title = (result.title || "Presentasi Canva").trim();
  const sourceUrl = normalizeCanvaUrl(result.sourceUrl || result.resolvedUrl || "") || result.sourceUrl || "";
  const resolvedUrl = normalizeCanvaUrl(result.resolvedUrl || "") || sourceUrl;
  const viewUrl = normalizeCanvaUrl(result.viewUrl || "") || "";
  const source: DeckSource = {
    type: "canva",
    url: sourceUrl,
    resolvedUrl,
    signature: result.signature || "",
    version: result.version || "",
    timestamp: Number(result.timestamp) || 0,
    pageCount: Number(result.pageCount) || result.slides.length,
    importedAt: Number(result.importedAt) || Date.now(),
    lastCheckedAt: Date.now(),
    autoUpdate: true,
  };
  if (viewUrl) source.viewUrl = viewUrl;
  if (result.mode === "capture") source.mode = "capture";
  const slides: Slide[] = result.slides.map((slide, index) => {
    const page = Number(slide.page) || index + 1;
    const canvas: CanvasElement = {
      id: uid("canvas"),
      type: "canvas",
      x: 0,
      y: 0,
      w: SLIDE_WIDTH,
      h: SLIDE_HEIGHT,
      src: slide.src,
      alt: `Canva slide ${page}`,
    };
    const importedElements = Array.isArray(slide.elements)
      ? sanitizeDeck({ title: "", slides: [{ id: "canva-slide", name: "", notes: "", elements: slide.elements as SlideElement[] }] }).slides[0]?.elements || []
      : [];
    return {
      id: uid("slide"),
      name: `Slide ${page}`,
      section: page === 1 ? "Intro" : "",
      notes: `Diimpor dari Canva halaman ${page}`,
      elements: [canvas, ...importedElements],
    };
  });
  return sanitizeDeck({ title, source, slides });
}

function openCanvaCaptureDialog(url: string): void {
  canvaCaptureUrl = normalizeCanvaUrl(url) || url;
  canvaCaptureSlides = [];
  $("#canva-capture-url").textContent = canvaCaptureUrl;
  $("#canva-capture-help").textContent = CANVA_CAPTURE_HELP;
  renderCanvaCaptureSlides();
  updateCanvaCaptureStatus("Siap. Buka Canva, lalu mulai capture.");
  const dialog = $("#canva-capture-dialog") as HTMLDialogElement;
  if (!dialog.open) dialog.showModal();
}

function updateCanvaCaptureStatus(message: string): void {
  $("#canva-capture-status").textContent = message;
  $("#canva-capture-count").textContent = String(canvaCaptureSlides.length);
}

function stopCanvaCapture(): void {
  if (canvaCaptureTimer) window.clearInterval(canvaCaptureTimer);
  canvaCaptureTimer = 0;
  canvaCaptureStream?.getTracks().forEach((track) => track.stop());
  canvaCaptureStream = null;
  const video = $("#canva-capture-video") as HTMLVideoElement;
  video.pause();
  video.srcObject = null;
}

function openCanvaSourceWindow(): void {
  if (!canvaCaptureUrl) return;
  window.open(canvaCaptureUrl, "_blank", "noopener,noreferrer");
}

async function startCanvaScreenCapture(): Promise<void> {
  if (!("mediaDevices" in navigator) || !navigator.mediaDevices.getDisplayMedia) {
    toast("Browser ini belum mendukung capture tab/window.");
    return;
  }
  stopCanvaCapture();
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  canvaCaptureStream = stream;
  const video = $("#canva-capture-video") as HTMLVideoElement;
  video.srcObject = stream;
  video.muted = true;
  await video.play();
  updateCanvaCaptureStatus("Capture aktif. Pindahkan slide Canva, ITS otomatis menangkap frame berbeda.");
  await captureCanvaFrame(true);
  canvaCaptureTimer = window.setInterval(() => void captureCanvaFrame(false), 1100);
  stream.getVideoTracks()[0]?.addEventListener("ended", () => {
    stopCanvaCapture();
    updateCanvaCaptureStatus("Capture berhenti. Klik selesai impor jika semua slide sudah tertangkap.");
  }, { once: true });
}

function canvaFrameHash(canvas: HTMLCanvasElement): string {
  const sample = document.createElement("canvas");
  sample.width = 8;
  sample.height = 8;
  const context = sample.getContext("2d", { willReadFrequently: true });
  if (!context) return String(Date.now());
  context.drawImage(canvas, 0, 0, sample.width, sample.height);
  const data = context.getImageData(0, 0, sample.width, sample.height).data;
  const values: number[] = [];
  for (let i = 0; i < data.length; i += 4) values.push(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.map((value) => value > average ? "1" : "0").join("");
}

function hashDistance(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  let distance = Math.abs(a.length - b.length);
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) distance++;
  return distance;
}

async function captureCanvaFrame(force: boolean): Promise<void> {
  const video = $("#canva-capture-video") as HTMLVideoElement;
  if (!video.videoWidth || !video.videoHeight) return;
  const maxW = 1920;
  const ratio = video.videoWidth / video.videoHeight || 16 / 9;
  const width = Math.min(maxW, video.videoWidth);
  const height = Math.round(width / ratio);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return;
  context.drawImage(video, 0, 0, width, height);
  const hash = canvaFrameHash(canvas);
  const isDuplicate = canvaCaptureSlides.some((slide) => hashDistance(slide.hash, hash) <= 8);
  if (!force && isDuplicate) return;
  const src = canvas.toDataURL("image/jpeg", 0.86);
  canvaCaptureSlides.push({
    page: canvaCaptureSlides.length + 1,
    pageHash: hash.split("").reduce((sum, bit, index) => sum + (bit === "1" ? index + 1 : 0), 0),
    width,
    height,
    mime: "image/jpeg",
    src,
    hash,
  });
  renderCanvaCaptureSlides();
  updateCanvaCaptureStatus(`${canvaCaptureSlides.length} slide gambar tertangkap.`);
}

function renderCanvaCaptureSlides(): void {
  const list = $("#canva-capture-list");
  list.innerHTML = "";
  canvaCaptureSlides.forEach((slide, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "canva-capture-thumb";
    item.innerHTML = `<img src="${escapeAttribute(slide.src)}" alt=""><span>Slide ${index + 1}</span>`;
    item.addEventListener("click", () => {
      canvaCaptureSlides.splice(index, 1);
      canvaCaptureSlides.forEach((entry, entryIndex) => { entry.page = entryIndex + 1; });
      renderCanvaCaptureSlides();
      updateCanvaCaptureStatus(`${canvaCaptureSlides.length} slide gambar tertangkap.`);
    });
    list.append(item);
  });
}

async function finishCanvaCaptureImport(): Promise<void> {
  if (!canvaCaptureSlides.length) {
    toast("Belum ada slide Canva yang tertangkap.");
    return;
  }
  stopCanvaCapture();
  const result: CanvaImportResult = {
    ok: true,
    title: "Presentasi Canva",
    sourceUrl: canvaCaptureUrl,
    resolvedUrl: canvaCaptureUrl,
    viewUrl: canvaCaptureUrl,
    mode: "capture",
    importedAt: Date.now(),
    timestamp: Date.now(),
    pageCount: canvaCaptureSlides.length,
    signature: canvaCaptureSlides.map((slide) => slide.hash).join("|"),
    slides: canvaCaptureSlides.map(({ hash: _hash, ...slide }) => slide),
  };
  deck = deckFromCanvaImport(result);
  currentSlide = 0;
  selectedElementId = null;
  recordHistory();
  renderAll();
  scheduleSave("Menyimpan import Canva gambar...");
  ($("#canva-capture-dialog") as HTMLDialogElement).close();
  toast(`${deck.slides.length} slide Canva berhasil diimpor sebagai gambar.`);
}

async function refreshCanvaSource(silent = false): Promise<void> {
  const source = deck.source;
  if (!source || source.type !== "canva" || source.autoUpdate === false || !isWritableOwner()) return;
  if (source.mode === "capture") {
    if (!silent) openCanvaCaptureDialog(source.url);
    return;
  }
  if (canvaAutoInFlight) return;
  canvaAutoInFlight = true;
  try {
    if (!silent) setSaveState("saving", "Mengecek update Canva...");
    const result = await requestCanvaImport(source.url);
    if (result.signature && source.signature && result.signature === source.signature) {
      deck.source = { ...source, lastCheckedAt: Date.now() };
      if (!silent) {
        setSaveState("saved");
        toast("Canva belum berubah.");
      }
      return;
    }
    const keepSlide = currentSlide;
    deck = deckFromCanvaImport(result);
    currentSlide = clamp(keepSlide, 0, deck.slides.length - 1);
    selectedElementId = null;
    recordHistory();
    renderAll();
    scheduleSave("Menyimpan update Canva...");
    toast(`${deck.slides.length} slide Canva diperbarui otomatis.`);
  } catch (error) {
    if (!silent) {
      setSaveState("error", "Update Canva gagal");
      toast(`Update Canva gagal: ${friendlyError(error)}`);
    }
  } finally {
    canvaAutoInFlight = false;
  }
}

function cleanStyleFields(item: Record<string, unknown>): PptxRunStyle & { animation?: ElementAnimation } {
  const style: PptxRunStyle & { animation?: ElementAnimation } = {};
  const fontFamily = cleanFontFamily(item.fontFamily);
  const fontSize = clamp(Number(item.fontSize) || 0, 6, 120);
  const color = cleanColor(item.color);
  if (fontFamily) style.fontFamily = fontFamily;
  if (fontSize) style.fontSize = fontSize;
  if (color) style.color = color;
  if (item.bold === true) style.bold = true;
  if (item.italic === true) style.italic = true;
  if (item.underline === true) style.underline = true;
  if (["left", "center", "right"].includes(String(item.align))) style.align = item.align as TextElement["align"];
  for (const key of ["insetLeft", "insetRight", "insetTop", "insetBottom"] as const) {
    const value = Number(item[key]);
    if (Number.isFinite(value)) style[key] = clamp(value, 0, 72);
  }
  const lineHeight = Number(item.lineHeight);
  if (Number.isFinite(lineHeight)) style.lineHeight = clamp(lineHeight, 0.7, 2.4);
  const animation = cleanAnimation(item.animation);
  if (animation) style.animation = animation;
  return style;
}

function sanitizeDeck(input: unknown): Deck {
  if (!input || typeof input !== "object") return defaultDeck();
  const raw = input as Partial<Deck>;
  const slides = Array.isArray(raw.slides) ? raw.slides.slice(0, 200).map((slide, index): Slide => {
    const source = slide && typeof slide === "object" ? slide as Partial<Slide> : {};
    const elements = Array.isArray(source.elements) ? source.elements.slice(0, 500).flatMap((element): SlideElement[] => {
      if (!element || typeof element !== "object") return [];
      const item = element as Partial<SlideElement> & Record<string, unknown>;
      const base = {
        id: typeof item.id === "string" ? item.id.slice(0, 80) : uid("el"),
        x: clamp(Number(item.x) || 0, -SLIDE_WIDTH, SLIDE_WIDTH * 2),
        y: clamp(Number(item.y) || 0, -SLIDE_HEIGHT, SLIDE_HEIGHT * 2),
        w: clamp(Number(item.w) || 100, 20, SLIDE_WIDTH * 2),
        h: clamp(Number(item.h) || 50, 20, SLIDE_HEIGHT * 2),
      };
      if (item.type === "phone") {
        const animation = cleanAnimation(item.animation);
        const phone: PhoneElement = { ...base, type: "phone", deviceSerial: typeof item.deviceSerial === "string" ? item.deviceSerial.slice(0, 200) : null };
        if (typeof item.deviceLabel === "string" && item.deviceLabel) phone.deviceLabel = item.deviceLabel.slice(0, 160);
        if (animation) phone.animation = animation;
        return [phone];
      }
      if (item.type === "image" || item.type === "canvas") {
        const src = typeof item.src === "string" ? item.src : "";
        if (!/^data:image\//i.test(src) && !/^https?:\/\//i.test(src) && !src.startsWith("./")) return [];
        const animation = cleanAnimation(item.animation);
        const image: ImageElement | CanvasElement = {
          ...base,
          type: item.type === "canvas" ? "canvas" : "image",
          src: src.slice(0, 20_000_000),
          alt: typeof item.alt === "string" ? item.alt.slice(0, 240) : "",
        };
        if (animation) image.animation = animation;
        return [image];
      }
      if (item.type === "canva") {
        const url = normalizeCanvaUrl(typeof item.url === "string" ? item.url : typeof item.embedUrl === "string" ? item.embedUrl : "");
        if (!url) return [];
        const animation = cleanAnimation(item.animation);
        const canva: CanvaElement = {
          ...base,
          type: "canva",
          url,
          embedUrl: canvaEmbedUrl(url),
          title: typeof item.title === "string" ? item.title.slice(0, 160) : "Canva",
        };
        if (animation) canva.animation = animation;
        return [canva];
      }
      if (item.type === "shape") {
        const animation = cleanAnimation(item.animation);
        const shape: ShapeElement = {
          ...base,
          type: "shape",
          shape: item.shape === "ellipse" ? "ellipse" : item.shape === "line" ? "line" : "rect",
          fill: cleanColor(item.fill, "transparent"),
          stroke: cleanColor(item.stroke, "#dadce0"),
          text: typeof item.text === "string" ? item.text.slice(0, 2000) : "",
          ...cleanStyleFields(item),
        };
        if (typeof item.tableId === "string") shape.tableId = item.tableId.slice(0, 80);
        if (Number.isFinite(Number(item.tableRow))) shape.tableRow = clamp(Number(item.tableRow), 0, 200);
        if (Number.isFinite(Number(item.tableCol))) shape.tableCol = clamp(Number(item.tableCol), 0, 200);
        if (animation) shape.animation = animation;
        return [shape];
      }
      if (item.type === "text") {
        const text: TextElement = { ...base, type: "text", variant: item.variant === "title" ? "title" : "body", text: typeof item.text === "string" ? item.text.slice(0, 10000) : "", ...cleanStyleFields(item) };
        if (["left", "center", "right"].includes(String(item.align))) text.align = item.align as TextElement["align"];
        return [text];
      }
      return [];
    }) : [];
    return {
      id: typeof source.id === "string" ? source.id.slice(0, 80) : uid("slide"),
      name: typeof source.name === "string" ? source.name.slice(0, 160) : `Slide ${index + 1}`,
      notes: typeof source.notes === "string" ? source.notes.slice(0, 10000) : "",
      transition: typeof source.transition === "string" ? source.transition.slice(0, 60) : "",
      section: typeof source.section === "string" ? source.section.slice(0, 120) : "",
      elements,
    };
  }) : [];
  const cleanDeck: Deck = {
    title: typeof raw.title === "string" ? raw.title.slice(0, 200) : "Presentasi tanpa judul",
    slides: slides.length ? slides : defaultDeck().slides,
  };
  const source = sanitizeDeckSource((raw as Record<string, unknown>).source);
  if (source) cleanDeck.source = source;
  return cleanDeck;
}

function serializableDeck(): Deck {
  return sanitizeDeck(deck);
}

function current(): Slide {
  currentSlide = clamp(currentSlide, 0, deck.slides.length - 1);
  return deck.slides[currentSlide];
}

function selected(): SlideElement | null {
  return current().elements.find((element) => element.id === selectedElementId) || null;
}

function elementLabel(element: SlideElement | null): string {
  if (!element) return current().name || `Slide ${currentSlide + 1}`;
  if (element.type === "text") {
    const preview = element.text.replace(/\s+/g, " ").trim().slice(0, 36);
    return preview ? `Teks: ${preview}` : "Kotak teks";
  }
  if (element.type === "image" || element.type === "canvas") return element.alt ? `Canvas: ${element.alt.slice(0, 34)}` : "Canvas";
  if (element.type === "canva") return element.title ? `Canva: ${element.title.slice(0, 34)}` : "Canva embed";
  if (element.type === "phone") return "Mockup HP / ADB";
  return element.text ? `Bentuk: ${element.text.slice(0, 34)}` : `Bentuk ${element.shape}`;
}

function elementAtSlidePoint(x: number, y: number, slideIndex = currentSlide): SlideElement | null {
  const slide = deck.slides[clamp(slideIndex, 0, deck.slides.length - 1)];
  if (!slide) return null;
  for (const element of [...slide.elements].reverse()) {
    if (x >= element.x && x <= element.x + element.w && y >= element.y && y <= element.y + element.h) return element;
  }
  return null;
}

function log(message: string, notify = false): void {
  const time = new Date().toLocaleTimeString("id-ID", { hour12: false });
  const target = $("#connection-log");
  const row = document.createElement("div");
  row.textContent = `[${time}] ${message}`;
  target.append(row);
  target.scrollTop = target.scrollHeight;
  if (notify) toast(message);
}

function toast(message: string): void {
  const target = $("#toast");
  target.textContent = message;
  target.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => target.classList.remove("show"), 3300);
}

function setSaveState(state: "saved" | "saving" | "error", message?: string): void {
  const target = $("#save-state");
  target.className = `save-state ${state === "saved" ? "" : state}`;
  $("span:last-child", target).textContent = message || (state === "saved" ? "Tersimpan" : state === "saving" ? "Menyimpan..." : "Gagal menyimpan");
}

function randomColor(value: string): string {
  const palette = ["#1a73e8", "#7b1fa2", "#00897b", "#e65100", "#c2185b", "#3949ab", "#2e7d32"];
  let hash = 0;
  for (const char of value) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

function shortInitials(name: string): string {
  return name.split(/\s+/).slice(-2).map((part) => part[0]?.toUpperCase()).join("").slice(0, 2);
}

function formatDateTime(value: number | undefined): string {
  return value ? new Date(value).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" }) : "Belum disimpan";
}

function trimNotificationText(value: string, max = 130): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

function buildUrl(options: { view?: boolean; edit?: string } = {}): string {
  const url = new URL("./", location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("p", projectId);
  if (options.view) url.searchParams.set("view", "1");
  if (options.edit) url.searchParams.set("edit", options.edit);
  if (emulatorMode) url.searchParams.set("emulator", "1");
  return url.href;
}

function homeUrl(): string {
  const url = new URL("./", location.href);
  url.search = "";
  url.hash = "";
  if (emulatorMode) url.searchParams.set("emulator", "1");
  return url.href;
}

function sharedHistoryKey(): string {
  return "its-presentasi-shared-history";
}

function loadLocalSharedHistory(): Record<string, SharedProjectRecord> {
  try {
    const value = JSON.parse(localStorage.getItem(sharedHistoryKey()) || "{}") as Record<string, SharedProjectRecord>;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function saveLocalSharedHistory(records: Record<string, SharedProjectRecord>): void {
  localStorage.setItem(sharedHistoryKey(), JSON.stringify(records));
}

function sharedProjectUrl(id: string, sharedRole: Role, token = ""): string {
  const url = new URL("./", location.href);
  url.search = "";
  url.searchParams.set("p", id);
  if (sharedRole === "viewer") url.searchParams.set("view", "1");
  if (sharedRole === "editor" && token) url.searchParams.set("edit", token);
  if (emulatorMode) url.searchParams.set("emulator", "1");
  return url.href;
}

async function rememberSharedProject(sharedRole = role): Promise<void> {
  if (!projectId || sharedRole === "owner") return;
  const now = Date.now();
  const record: SharedProjectRecord = {
    id: projectId,
    title: deck.title || "Presentasi tanpa judul",
    role: sharedRole,
    ownerUid: undefined,
    createdAt: projectCreatedAt || now,
    updatedAt: now,
    url: sharedProjectUrl(projectId, sharedRole, editorToken),
  };
  const local = loadLocalSharedHistory();
  local[projectId] = record;
  saveLocalSharedHistory(local);
  if (!localMode && firebaseUser) {
    const remoteRecord = { ...record };
    delete remoteRecord.ownerUid;
    await set(ref(db, `presentationUsers/${firebaseUser.uid}/shared/${projectId}`), remoteRecord).catch(() => undefined);
  }
}

async function removeSharedHistory(id: string): Promise<void> {
  const local = loadLocalSharedHistory();
  delete local[id];
  saveLocalSharedHistory(local);
  delete latestSharedRecords[id];
  if (!localMode && firebaseUser) await remove(ref(db, `presentationUsers/${firebaseUser.uid}/shared/${id}`)).catch(() => undefined);
  renderSharedProjects(latestSharedRecords);
}

async function renderSharedProjects(records: Record<string, SharedProjectRecord> = latestSharedRecords): Promise<void> {
  const list = $("#shared-project-list");
  list.innerHTML = "";
  const search = ($("#project-search") as HTMLInputElement).value.trim().toLowerCase();
  const entries = Object.entries(records || {})
    .filter(([, item]) => !search || (item?.title || "Presentasi tanpa judul").toLowerCase().includes(search))
    .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0));
  $("#empty-shared-projects").toggleAttribute("hidden", entries.length !== 0);
  for (const [id, item] of entries) {
    const card = document.createElement("article");
    card.className = "project-card shared";
    card.innerHTML = `<div class="project-preview"></div><div class="project-meta"><div class="project-card-actions"><strong></strong><button class="project-delete" title="Hapus histori">...</button></div><span></span></div>`;
    $("strong", card).textContent = item.title || "Presentasi tanpa judul";
    $(".project-meta span", card).textContent = `${item.role === "editor" ? "Editor" : "Viewer"} · Dibuka ${formatDateTime(item.updatedAt)}`;
    const preview = $(".project-preview", card);
    void get(ref(db, `presentations/${id}/deck`)).then((deckSnapshot) => {
      if (!deckSnapshot.exists()) return;
      const projectDeck = sanitizeDeck(deckSnapshot.val());
      preview.innerHTML = "";
      preview.classList.add("has-preview");
      preview.append(createSlidePreview(projectDeck.slides[0], "project-slide-preview"));
    }).catch(() => undefined);
    card.addEventListener("click", () => { location.href = item.url || sharedProjectUrl(id, item.role); });
    $(".project-delete", card).addEventListener("click", (event) => {
      event.stopPropagation();
      void removeSharedHistory(id);
    });
    list.append(card);
  }
}

function ownerEditorTokenKey(): string {
  return `prezadb-edit-token:${firebaseUser.uid}:${projectId}`;
}

function getOrCreateEditorToken(rotate = false): string {
  let token = rotate ? "" : localStorage.getItem(ownerEditorTokenKey()) || "";
  if (!token) {
    token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    localStorage.setItem(ownerEditorTokenKey(), token);
  }
  return token;
}

type PresentationShortcutItem = { title: string; url: string; updatedAt: number; themeColor?: string; backgroundColor?: string };

function loadPresentationRecents(): PresentationShortcutItem[] {
  try {
    const value = JSON.parse(localStorage.getItem(PRESENTATION_RECENTS_KEY) || "[]") as PresentationShortcutItem[];
    return Array.isArray(value)
      ? value.filter((item) => item?.url && item?.title).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)).slice(0, 6)
      : [];
  } catch {
    return [];
  }
}

function currentPresentationShortcutUrl(): string {
  if (!projectId) return "/presentation/?source=pwa";
  const url = new URL("/presentation/", location.origin);
  url.searchParams.set("p", projectId);
  if (role === "viewer") url.searchParams.set("view", "1");
  if (role === "editor" && editorToken) url.searchParams.set("edit", editorToken);
  return `${url.pathname}${url.search}`;
}

function syncPresentationShortcutsToServiceWorker(): void {
  const items = loadPresentationRecents().slice(0, 3).map((item) => ({
    title: item.title,
    url: item.url,
    themeColor: item.themeColor,
    backgroundColor: item.backgroundColor,
  }));
  const message = { type: "ITS_PRESENTATION_RECENTS", items };
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.controller?.postMessage(message);
  void navigator.serviceWorker.ready.then((registration) => registration.active?.postMessage(message)).catch(() => undefined);
}

function rememberPresentationShortcut(): void {
  if (!projectId) return;
  const url = currentPresentationShortcutUrl();
  const colors = sampleSlideColors(deck.slides[0] || defaultDeck().slides[0]);
  const item: PresentationShortcutItem = {
    title: (deck.title || "Presentasi tanpa judul").trim().slice(0, 64),
    url,
    updatedAt: Date.now(),
    themeColor: colors[1],
    backgroundColor: colors[0],
  };
  const next = [item, ...loadPresentationRecents().filter((recent) => recent.url !== url)].slice(0, 6);
  localStorage.setItem(PRESENTATION_RECENTS_KEY, JSON.stringify(next));
  syncPresentationShortcutsToServiceWorker();
}

function redirectToLastPresentationIfNeeded(): boolean {
  if (params.get("last") !== "1" || projectId) return false;
  const [latest] = loadPresentationRecents();
  if (!latest?.url) return false;
  location.replace(latest.url);
  return true;
}

function setNamedMeta(selector: string, value: string): void {
  const element = document.head.querySelector<HTMLMetaElement>(selector);
  if (element) element.content = value;
}

function updatePresentationMetadata(): void {
  const title = deck.title || "ITS Presentasi";
  const ownerName = projectOwnerName || (role === "owner" ? authDisplayName(firebaseUser) || participantName : "pemilik presentasi");
  const description = role === "editor"
    ? `Bergabung dan berkontribusi di dalam ${title} yang dibuat oleh ${ownerName}.`
    : role === "viewer"
      ? `Bergabung di presentasi ${title} yang dibuat oleh ${ownerName}.`
      : `${title} - presentasi realtime oleh ${ownerName} dengan komentar dan WebUSB ADB.`;
  const absoluteUrl = projectId ? new URL(currentPresentationShortcutUrl(), location.origin).href : "https://itstelkom.web.app/presentation/";
  const colors = sampleSlideColors(deck.slides[0] || defaultDeck().slides[0]);
  document.title = `${title} | ITS Presentasi`;
  setNamedMeta('meta[name="description"]', description);
  setNamedMeta('meta[name="theme-color"]', colors[1]);
  setNamedMeta('meta[property="og:title"]', title);
  setNamedMeta('meta[property="og:description"]', description);
  setNamedMeta('meta[property="og:url"]', absoluteUrl);
  setNamedMeta('meta[name="twitter:title"]', title);
  setNamedMeta('meta[name="twitter:description"]', description);
  document.documentElement.style.setProperty("--ambient-a", colors[0]);
  document.documentElement.style.setProperty("--ambient-b", colors[1]);
  document.documentElement.style.setProperty("--ambient-c", colors[2]);
}

function registerPresentationServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js")
      .then(() => syncPresentationShortcutsToServiceWorker())
      .catch((error) => console.warn("[PWA] Presentation Service Worker registration failed", error));
  }, { once: true });
}

async function boot(): Promise<void> {
  try {
    if (redirectToLastPresentationIfNeeded()) return;
    if (localMode) {
      firebaseUser = { uid: "local-presentasi-user" } as User;
      projectId ||= "local";
      projectCreatedAt = Date.now();
      presentationState = { currentSlide: 0, presenting: false, updatedAt: Date.now() };
      $("#hub-user-name").textContent = participantName;
      showEditor();
      return;
    }
    $("#boot-note").textContent = emulatorMode ? "Menghubungkan emulator Firebase lokal" : "Menyiapkan sesi masuk";
    firebaseUser = await signInAnonymousIfNeeded();
    syncIdentityUi();
    if (!projectId) {
      await showProjectHub();
    } else {
      await openProject();
    }
  } catch (error) {
    console.error(error);
    $("#boot-note").textContent = `Firebase gagal: ${friendlyError(error)}`;
    toast("Firebase Anonymous Authentication perlu diaktifkan untuk memakai presentasi.");
  }
}

function friendlyError(error: unknown): string {
  const message = String((error as { message?: string })?.message || error || "Kesalahan tidak diketahui");
  if (message.includes("auth/operation-not-allowed")) return "Anonymous Authentication belum diaktifkan di Firebase Console.";
  if (message.includes("auth/popup-closed-by-user")) return "Login Google dibatalkan.";
  if (message.includes("auth/credential-already-in-use")) return "Akun Google itu sudah terhubung ke sesi lain. Untuk project owner ini, tetap gunakan sesi owner yang sedang aktif.";
  if (message.includes("auth/unauthorized-domain")) return "Domain ini belum diizinkan untuk Google Sign-In di Firebase Console.";
  if (message.includes("PERMISSION_DENIED")) {
    if (role === "owner" && projectOwnerUid && firebaseUser?.uid !== projectOwnerUid) return "Sesi ini bukan UID pemilik project. Masuk dengan akun pembuat project untuk menghapus atau menyimpan.";
    return "Database Rules belum mengizinkan operasi ini untuk sesi saat ini.";
  }
  if (message.toLowerCase().includes("network")) return "koneksi jaringan tidak tersedia.";
  return message;
}

function authDisplayName(user: User): string {
  return (user.displayName || user.email || "").trim();
}

function syncIdentityUi(): void {
  const name = authDisplayName(firebaseUser) || participantName;
  $("#hub-user-name").textContent = name;
  const googleButton = $("#hub-google-login") as HTMLButtonElement;
  googleButton.textContent = firebaseUser?.isAnonymous ? "Google" : "Akun Google";
  syncOwnerAuthUi();
}

function syncOwnerAuthUi(): void {
  const button = document.getElementById("owner-google-login") as HTMLButtonElement | null;
  if (!button) return;
  button.hidden = role !== "owner";
  button.textContent = firebaseUser?.isAnonymous ? "Google" : "Akun Google";
  button.title = firebaseUser?.isAnonymous ? "Masuk dengan Google" : authDisplayName(firebaseUser) || "Akun Google";
}

async function signInAnonymousIfNeeded(): Promise<User> {
  if (auth.currentUser) return auth.currentUser;
  return (await signInAnonymously(auth)).user;
}

async function signInWithGoogleAccount(): Promise<User> {
  const current = auth.currentUser;
  const credential = current?.isAnonymous
    ? await linkWithPopup(current, googleProvider).catch(async (error) => {
      if (String(error?.code || error?.message || "").includes("credential-already-in-use") && !(projectId && role === "owner")) return signInWithPopup(auth, googleProvider);
      throw error;
    })
    : await signInWithPopup(auth, googleProvider);
  firebaseUser = credential.user;
  const display = authDisplayName(firebaseUser);
  if (display) {
    participantName = display;
    sessionStorage.setItem("its-presentasi-name", participantName);
    localStorage.setItem("its-presentasi-name", participantName);
  }
  syncIdentityUi();
  return firebaseUser;
}

async function showProjectHub(): Promise<void> {
  stopJoinCarousel();
  cleanupProjectRuntime();
  $("#boot-screen").setAttribute("hidden", "");
  $("#editor-app").setAttribute("hidden", "");
  $("#audience-view").setAttribute("hidden", "");
  $("#share-entry").setAttribute("hidden", "");
  $("#project-hub").removeAttribute("hidden");
  const indexRef = ref(db, `presentationUsers/${firebaseUser.uid}/projects`);
  let latestRecords: Record<string, ProjectIndexRecord> | null = null;
  const renderProjects = async (records: Record<string, ProjectIndexRecord> | null) => {
    const list = $("#project-list");
    list.innerHTML = "";
    const search = ($("#project-search") as HTMLInputElement).value.trim().toLowerCase();
    const entries = Object.entries(records || {})
      .filter(([, item]) => !search || (item?.title || "Presentasi tanpa judul").toLowerCase().includes(search))
      .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0));
    $("#empty-projects").toggleAttribute("hidden", entries.length !== 0);
    for (const [id, item] of entries) {
      const card = document.createElement("article");
      card.className = "project-card";
      card.innerHTML = `<div class="project-preview"></div><div class="project-meta"><div class="project-card-actions"><strong></strong><button class="project-delete" title="Hapus project">⋮</button></div><span></span></div>`;
      $("strong", card).textContent = item?.title || "Presentasi tanpa judul";
      $(".project-delete", card).textContent = "...";
      const preview = $(".project-preview", card);
      void get(ref(db, `presentations/${id}/deck`)).then((deckSnapshot) => {
        const projectDeck = sanitizeDeck(deckSnapshot.val());
        preview.innerHTML = "";
        preview.classList.add("has-preview");
        preview.append(createSlidePreview(projectDeck.slides[0], "project-slide-preview"));
      }).catch(() => undefined);
      $(".project-meta span", card).textContent = `Diubah ${formatDateTime(item?.updatedAt)}`;
      card.addEventListener("click", () => navigateToProject(id));
      $(".project-delete", card).addEventListener("click", (event) => {
        event.stopPropagation();
        deleteTarget = id;
        ($("#confirm-dialog") as HTMLDialogElement).showModal();
      });
      list.append(card);
    }
  };
  runtimeUnsubscribers.push(onValue(indexRef, (snapshot) => {
    latestRecords = snapshot.val() as Record<string, ProjectIndexRecord> | null;
    void renderProjects(latestRecords);
  }));
  latestSharedRecords = loadLocalSharedHistory();
  void renderSharedProjects(latestSharedRecords);
  if (!localMode) {
    runtimeUnsubscribers.push(onValue(ref(db, `presentationUsers/${firebaseUser.uid}/shared`), (snapshot) => {
      latestSharedRecords = { ...loadLocalSharedHistory(), ...((snapshot.val() || {}) as Record<string, SharedProjectRecord>) };
      void renderSharedProjects(latestSharedRecords);
    }));
  }
  $("#project-search").addEventListener("input", () => {
    void renderProjects(latestRecords);
    void renderSharedProjects(latestSharedRecords);
  });
}

function templateDeck(kind: string): Deck {
  const base = defaultDeck();
  if (!kind) return base;
  const palettes: Record<string, [string, string, string]> = {
    photo: ["#e8f0fe", "#1a73e8", "Album Foto"],
    wedding: ["#fce8e6", "#b3261e", "Pernikahan"],
    portfolio: ["#e6f4ea", "#188038", "Portofolio"],
    collection: ["#fff7e6", "#b06000", "Buku Koleksi"],
    pitch: ["#e8eaed", "#3c4043", "Pitch"],
  };
  const [fill, accent, title] = palettes[kind] || palettes.portfolio;
  return {
    title,
    slides: [{
      id: uid("slide"),
      name: "Slide 1",
      notes: "",
      elements: [
        { id: uid("el"), type: "shape", shape: "rect", x: 0, y: 0, w: SLIDE_WIDTH, h: SLIDE_HEIGHT, fill, stroke: fill },
        { id: uid("el"), type: "shape", shape: "rect", x: 0, y: 498, w: SLIDE_WIDTH, h: 42, fill: accent, stroke: accent },
        { id: uid("el"), type: "text", variant: "title", x: 92, y: 184, w: 760, h: 82, text: title, fontSize: 48, color: "#202124" },
        { id: uid("el"), type: "text", variant: "body", x: 94, y: 274, w: 620, h: 54, text: "Klik untuk menambahkan subjudul", fontSize: 24, color: "#5f6368" },
      ],
    }],
  };
}

async function createProject(template = ""): Promise<void> {
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  const now = Date.now();
  const newDeck = templateDeck(template);
  const record: PresentationRecord = {
    ownerUid: firebaseUser.uid,
    ownerName: authDisplayName(firebaseUser) || participantName,
    visibility: "public",
    deck: newDeck,
    state: { currentSlide: 0, presenting: false, updatedAt: now },
    createdAt: now,
    updatedAt: now,
  };
  setSaveState("saving", "Membuat...");
  await set(ref(db, `presentations/${id}`), record);
  await set(ref(db, `presentationUsers/${firebaseUser.uid}/projects/${id}`), { title: newDeck.title, createdAt: now, updatedAt: now });
  projectId = id;
  projectCreatedAt = now;
  projectOwnerName = record.ownerName || participantName;
  getOrCreateEditorToken();
  navigateToProject(id);
}

async function createCopyProject(): Promise<void> {
  if (!firebaseUser || !isEditableRole()) return;
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  const now = Date.now();
  const copiedDeck = sanitizeDeck({ ...serializableDeck(), title: `${deck.title || "Presentasi"} salinan` });
  const record: PresentationRecord = {
    ownerUid: firebaseUser.uid,
    ownerName: authDisplayName(firebaseUser) || participantName,
    visibility: "public",
    deck: copiedDeck,
    state: { currentSlide: 0, presenting: false, updatedAt: now },
    createdAt: now,
    updatedAt: now,
  };
  setSaveState("saving", "Membuat salinan...");
  await set(ref(db, `presentations/${id}`), record);
  await set(ref(db, `presentationUsers/${firebaseUser.uid}/projects/${id}`), { title: copiedDeck.title, createdAt: now, updatedAt: now });
  projectOwnerName = record.ownerName || participantName;
  toast("Salinan presentasi dibuat.");
  navigateToProject(id);
}

function navigateToProject(id: string): void {
  const url = new URL("./", location.href);
  url.search = "";
  url.searchParams.set("p", id);
  if (emulatorMode) url.searchParams.set("emulator", "1");
  location.href = url.href;
}

async function openProject(): Promise<void> {
  const snapshot = await get(ref(db, `presentations/${projectId}`));
  if (!snapshot.exists()) {
    $("#boot-screen").setAttribute("hidden", "");
    toast("Presentasi tidak ditemukan atau sudah dihapus.");
    projectId = "";
    await showProjectHub();
    return;
  }
  const record = snapshot.val() as PresentationRecord;
  // Bare ?p= URLs are the owner workspace. Viewer/editor links use explicit view/edit params.
  projectOwnerUid = String(record.ownerUid || "");
  const requestedBareOwner = role === "owner";
  if (requestedBareOwner && projectOwnerUid && projectOwnerUid !== firebaseUser.uid) {
    role = "viewer";
  }
  deck = sanitizeDeck(record.deck);
  presentationState = record.state || { currentSlide: 0, presenting: false };
  projectCreatedAt = Number(record.createdAt) || Number(record.updatedAt) || 0;
  projectOwnerName = (record.ownerName || "").trim() || (role === "owner" ? authDisplayName(firebaseUser) || participantName : "pemilik presentasi");
  currentSlide = clamp(Number(presentationState.currentSlide) || 0, 0, deck.slides.length - 1);
  selectedElementId = null;
  resetHistoryBaseline();

  startRecordListener();
  startCommentsListener();
  if (role === "owner") {
    showEditor();
    startOwnerCollaborationListener();
    await startPresence();
    void requestPresentationNotificationPermission();
  } else {
    showJoinGate(role);
    if (requestedBareOwner) toast("Sesi ini bukan akun pemilik project. Masuk dengan akun pembuat atau buka sebagai viewer/editor.");
  }
}

function showEditor(): void {
  stopJoinCarousel();
  updatePresentationMetadata();
  rememberPresentationShortcut();
  $("#boot-screen").setAttribute("hidden", "");
  $("#project-hub").setAttribute("hidden", "");
  $("#audience-view").setAttribute("hidden", "");
  $("#share-entry").setAttribute("hidden", "");
  const app = $("#editor-app");
  app.removeAttribute("hidden");
  app.classList.toggle("readonly", !isEditableRole());
  $("#role-badge").textContent = role === "owner" ? "Pemilik" : "Editor kolaborasi";
  $("#share-button").toggleAttribute("hidden", role !== "owner");
  syncOwnerAuthUi();
  $("#present-button").innerHTML = role === "owner" ? "<span>▶</span><span>Slideshow</span>" : "Preview";
  if (role !== "owner") {
    $("#present-button").textContent = "Preview";
  }
  renderAll();
  handleCommentDeepLink();
  requestAnimationFrame(fitWorkspace);
}

function showAudience(): void {
  stopJoinCarousel();
  updatePresentationMetadata();
  rememberPresentationShortcut();
  $("#boot-screen").setAttribute("hidden", "");
  $("#project-hub").setAttribute("hidden", "");
  $("#editor-app").setAttribute("hidden", "");
  $("#share-entry").setAttribute("hidden", "");
  const audienceView = $("#audience-view");
  audienceView.removeAttribute("hidden");
  audienceView.classList.toggle("audience-viewer", role === "viewer");
  setAudienceFillMode("contain");
  followingPresenter = true;
  presenterSlide = clamp(Number(presentationState.currentSlide) || 0, 0, deck.slides.length - 1);
  currentSlide = presenterSlide;
  renderAudienceSlide();
  handleCommentDeepLink();
  resizeAudienceSlide();
  syncFullscreenButton();
  showAudienceChrome();
  ensurePresenterCursorVisible(true);
  if (presentationState.presenting && role !== "owner") void connectViewerRtc();
}

function showJoinGate(nextRole: Role): void {
  updatePresentationMetadata();
  rememberPresentationShortcut();
  $("#boot-screen").setAttribute("hidden", "");
  $("#project-hub").setAttribute("hidden", "");
  $("#editor-app").setAttribute("hidden", "");
  $("#audience-view").setAttribute("hidden", "");
  const entry = $("#share-entry");
  entry.removeAttribute("hidden");
  $("#join-title").textContent = deck.title || "Presentasi tanpa judul";
  $("#join-mode-label").textContent = nextRole === "editor" ? "EDITOR" : "VIEWER";
  $("#join-role-title").textContent = nextRole === "editor" ? "Pilih editor sebagai apa" : "Pilih lihat sebagai apa";
  ($("#join-name") as HTMLInputElement).value = participantName;
  ($("#join-remember") as HTMLInputElement).checked = Boolean(localStorage.getItem("its-presentasi-name"));
  $("#join-meta").textContent = `${deck.slides.length} halaman - Dibuat ${formatDateTime(projectCreatedAt)}`;
  joinPreviewIndex = clamp(currentSlide, 0, Math.min(2, Math.max(0, deck.slides.length - 1)));
  const previewList = $("#join-preview-list");
  const previewDots = $("#join-preview-dots");
  previewList.innerHTML = "";
  previewDots.innerHTML = "";
  deck.slides.slice(0, 3).forEach((slide, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "join-preview-card";
    item.append(createSlidePreview(slide, "join-slide-preview"));
    const label = document.createElement("span");
    label.textContent = `Slide ${index + 1}`;
    item.append(label);
    item.addEventListener("click", () => {
      joinPreviewIndex = index;
      renderJoinActivePreview();
      restartJoinCarousel();
    });
    previewList.append(item);
    const dot = document.createElement("span");
    previewDots.append(dot);
  });
  renderJoinActivePreview();
  restartJoinCarousel();
}

function renderJoinActivePreview(): void {
  const cards = [...document.querySelectorAll<HTMLElement>(".join-preview-card")];
  const activeIndex = joinPreviewIndex < cards.length ? joinPreviewIndex : 0;
  cards.forEach((item, index) => item.classList.toggle("active", index === activeIndex));
  document.querySelectorAll<HTMLElement>(".join-preview-dots span").forEach((item, index) => item.classList.toggle("active", index === activeIndex));
  cards[activeIndex]?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  updateJoinAmbient(activeIndex);
}

function stopJoinCarousel(): void {
  clearInterval(joinCarouselTimer);
  joinCarouselTimer = 0;
}

function restartJoinCarousel(): void {
  stopJoinCarousel();
  const count = Math.min(3, deck.slides.length);
  if (count <= 1) return;
  joinCarouselTimer = window.setInterval(() => {
    if ($("#share-entry").hasAttribute("hidden")) {
      stopJoinCarousel();
      return;
    }
    joinPreviewIndex = (joinPreviewIndex + 1) % count;
    renderJoinActivePreview();
  }, 4200);
}

function updateJoinAmbient(slideIndex: number): void {
  const entry = document.getElementById("share-entry");
  const slide = deck.slides[clamp(slideIndex, 0, Math.max(0, deck.slides.length - 1))];
  if (!entry || !slide) return;
  let colors = sampleSlideColors(slide);
  if (colors[0] === "#274a5a" && colors[1] === "#4a2638" && colors[2] === "#14151b") {
    colors = ["#242729", "#37322e", "#101214"];
  }
  entry.style.setProperty("--join-ambient-a", colors[0]);
  entry.style.setProperty("--join-ambient-b", colors[1]);
  entry.style.setProperty("--join-ambient-c", colors[2]);
  entry.style.setProperty("--join-readable-on-a", readableTextFor(colors[0]));
  entry.style.setProperty("--join-readable-muted", readableMutedTextFor(colors[0]));
  entry.style.setProperty("--join-form-text", "#202124");
  entry.style.setProperty("--join-form-muted", "#5f6368");
}

async function enterSharedProject(): Promise<void> {
  const selectedAuth = (document.querySelector<HTMLInputElement>('input[name="join-auth"]:checked')?.value || "anonymous") as "anonymous" | "google";
  if (selectedAuth === "google") {
    await signInWithGoogleAccount();
  }
  const name = ($("#join-name") as HTMLInputElement).value.trim() || participantName;
  participantName = name;
  sessionStorage.setItem("its-presentasi-name", participantName);
  localStorage.setItem("its-presentasi-anonymous-name", participantName);
  if (($("#join-remember") as HTMLInputElement).checked) localStorage.setItem("its-presentasi-name", participantName);
  else localStorage.removeItem("its-presentasi-name");
  await rememberSharedProject(role);
  joinedSharedProject = true;
  if (role === "viewer") {
    showAudience();
    const fullscreen = document.fullscreenEnabled ? document.documentElement.requestFullscreen().catch(() => undefined) : Promise.resolve();
    await startPresence();
    await fullscreen;
    await tryLockLandscape();
  } else {
    showEditor();
    await startPresence();
  }
}

function startRecordListener(): void {
  remoteUnsubscribe?.();
  remoteUnsubscribe = onValue(ref(db, `presentations/${projectId}`), (snapshot) => {
    if (!snapshot.exists()) {
      toast("Presentasi telah dihapus pemilik.");
      setTimeout(() => { location.href = homeUrl(); }, 900);
      return;
    }
    const record = snapshot.val() as PresentationRecord;
    const nextDeck = sanitizeDeck(record.deck);
    const nextState = record.state || { currentSlide: 0, presenting: false };
    projectCreatedAt = Number(record.createdAt) || projectCreatedAt;
    const stateChanged = JSON.stringify(nextState) !== JSON.stringify(presentationState);
    const deckChanged = JSON.stringify(nextDeck) !== JSON.stringify(serializableDeck());
    presentationState = nextState;
    presenterSlide = clamp(Number(nextState.currentSlide) || 0, 0, nextDeck.slides.length - 1);
    if (role === "viewer" || (deckChanged && !saveTimer)) {
      applyingRemote = true;
      deck = nextDeck;
      currentSlide = role === "viewer" && !followingPresenter ? clamp(currentSlide, 0, deck.slides.length - 1) : presenterSlide;
      selectedElementId = null;
      if (role === "viewer") {
        if (joinedSharedProject) renderAudienceSlide();
        else renderJoinActivePreview();
      } else {
        renderAll();
      }
      applyingRemote = false;
    }
    if (role === "viewer" && stateChanged && joinedSharedProject) {
      if (followingPresenter) currentSlide = presenterSlide;
      renderAudienceSlide();
      if (followingPresenter && nextState.presenting && !viewerPeer) void connectViewerRtc();
      if ((!nextState.presenting || !followingPresenter) && viewerPeer) disconnectViewerRtc();
    }
  }, (error) => toast(`Sinkronisasi gagal: ${friendlyError(error)}`));
}

async function startPresence(): Promise<void> {
  const sessionKey = `its-presentasi-session:${projectId}:${role}`;
  const sessionId = sessionStorage.getItem(sessionKey) || `${firebaseUser.uid.slice(0, 10)}_${crypto.randomUUID().slice(0, 8)}`;
  sessionStorage.setItem(sessionKey, sessionId);
  presenceSessionId = sessionId;
  activePresencePath = `presentationPresence/${projectId}/${sessionId}`;
  const presenceRef = ref(db, activePresencePath);
  const presence: PresenceRecord = { uid: firebaseUser.uid, sessionId, name: participantName, role, color: randomColor(participantName), lastSeen: serverTimestamp(), slide: currentSlide };
  await set(presenceRef, presence);
  await onDisconnect(presenceRef).remove();
  void removeDuplicatePresenceSessions(sessionId);
  clearInterval(presenceTimer);
  presenceTimer = window.setInterval(() => void update(presenceRef, { lastSeen: serverTimestamp(), role, slide: currentSlide }), 25000);
  presenceUnsubscribe?.();
  presenceUnsubscribe = onValue(ref(db, `presentationPresence/${projectId}`), (snapshot) => renderPresence((snapshot.val() || {}) as Record<string, PresenceRecord>));
}

async function removeDuplicatePresenceSessions(activeSessionId: string): Promise<void> {
  try {
    const snapshot = await get(ref(db, `presentationPresence/${projectId}`));
    const records = (snapshot.val() || {}) as Record<string, PresenceRecord>;
    const removals = Object.entries(records)
      .filter(([id, item]) => id !== activeSessionId && item?.uid === firebaseUser.uid && item?.name === participantName)
      .map(([id]) => remove(ref(db, `presentationPresence/${projectId}/${id}`)));
    await Promise.all(removals);
  } catch {
    // Presence cleanup is best-effort; the UI also dedupes stale entries.
  }
}

function updatePresenceSlide(): void {
  if (!activePresencePath) return;
  void update(ref(db, activePresencePath), { slide: currentSlide, lastSeen: serverTimestamp() }).catch(() => undefined);
}

function presenceTime(value: PresenceRecord): number {
  return typeof value.lastSeen === "number" ? value.lastSeen : Number(value.cursor?.updatedAt || 0);
}

function normalizePresenceRecords(records: Record<string, PresenceRecord>): PresenceRecord[] {
  const now = Date.now();
  const byPerson = new Map<string, PresenceRecord>();
  for (const item of Object.values(records)) {
    if (!item?.name) continue;
    const seen = presenceTime(item);
    if (seen && now - seen > 120000) continue;
    const key = `${item.uid}:${item.role}:${item.name}`;
    const previous = byPerson.get(key);
    if (!previous || presenceTime(previous) <= seen) byPerson.set(key, item);
  }
  return [...byPerson.values()].sort((a, b) => presenceTime(b) - presenceTime(a));
}

function updatePresenceCursor(cursor: CursorPresence, force = false): void {
  if (!activePresencePath) return;
  const now = Date.now();
  if (!force && now - lastCursorSent < 120) return;
  lastCursorSent = now;
  lastCursorPoint = sanitizeCursorPresence({ ...cursor, updatedAt: now });
  void update(ref(db, activePresencePath), { cursor: lastCursorPoint, slide: currentSlide, lastSeen: serverTimestamp() }).catch(() => undefined);
}

function sanitizeCursorPresence(cursor: CursorPresence): CursorPresence {
  const clean: CursorPresence = {
    x: Number.isFinite(cursor.x) ? cursor.x : 0,
    y: Number.isFinite(cursor.y) ? cursor.y : 0,
    slide: Number.isFinite(cursor.slide) ? cursor.slide : currentSlide,
    visible: Boolean(cursor.visible),
  };
  if (cursor.target) clean.target = cursor.target;
  if (cursor.targetId) clean.targetId = cursor.targetId;
  if (cursor.editing) clean.editing = cursor.editing;
  if (Number.isFinite(Number(cursor.updatedAt))) clean.updatedAt = Number(cursor.updatedAt);
  return clean;
}

function announceEditing(element: SlideElement | null): void {
  if (!element || !activePresencePath) return;
  const base = lastCursorPoint || {
    x: Math.round(element.x + element.w / 2),
    y: Math.round(element.y + Math.min(24, element.h / 2)),
    slide: currentSlide,
    visible: true,
  };
  updatePresenceCursor({
    ...base,
    slide: currentSlide,
    visible: true,
    target: elementLabel(element),
    targetId: element.id,
    editing: `Mengedit ${elementLabel(element)}`,
  }, true);
}

function hidePresenceCursor(): void {
  if (!lastCursorPoint) return;
  if (role === "owner" && presentationState.presenting && isAudienceOpen()) return;
  updatePresenceCursor({ ...lastCursorPoint, visible: false, updatedAt: Date.now() }, true);
}

function ensurePresenterCursorVisible(force = false): void {
  if (role !== "owner" || !presentationState.presenting || !isAudienceOpen()) return;
  const base: CursorPresence = lastCursorPoint && lastCursorPoint.slide === currentSlide ? lastCursorPoint : {
    x: Math.round(SLIDE_WIDTH * 0.52),
    y: Math.round(SLIDE_HEIGHT * 0.48),
    slide: currentSlide,
    visible: true,
  };
  updatePresenceCursor({
    ...base,
    slide: currentSlide,
    visible: true,
    target: base.target || current().name || `Slide ${currentSlide + 1}`,
    editing: base.editing || "Mempresentasikan",
  }, force);
}

function startPresenterCursorHeartbeat(): void {
  clearInterval(presenterCursorTimer);
  presenterCursorTimer = window.setInterval(() => ensurePresenterCursorVisible(true), 1800);
  ensurePresenterCursorVisible(true);
}

function stopPresenterCursorHeartbeat(): void {
  clearInterval(presenterCursorTimer);
  presenterCursorTimer = 0;
}

function renderPresence(records: Record<string, PresenceRecord>): void {
  const active = normalizePresenceRecords(records).slice(0, 12);
  activePresenceRecords = active;
  const target = $("#presence-list");
  target.innerHTML = "";
  for (const item of active.slice(0, 5)) {
    const avatar = document.createElement("span");
    avatar.className = "presence-avatar";
    avatar.style.background = item.color || randomColor(item.name);
    avatar.title = `${item.name} • ${item.role}`;
    avatar.textContent = shortInitials(item.name);
    target.append(avatar);
  }
  $("#share-presence").textContent = `${active.length} orang sedang membuka presentasi ini.`;
  renderAudiencePeople();
  renderRemoteCursors();
}

function commentTime(value: CommentRecord): number {
  return typeof value.createdAt === "number" ? value.createdAt : 0;
}

function activeCommentRecords(): CommentRecord[] {
  return activeComments
    .filter((comment) => comment && !comment.deleted)
    .sort((a, b) => commentTime(a) - commentTime(b));
}

function commentsForElement(elementId: string, slideIndex = currentSlide): CommentRecord[] {
  return activeCommentRecords().filter((comment) => comment.elementId === elementId && Number(comment.slide) === slideIndex);
}

function topLevelCommentsForElement(elementId: string, slideIndex = currentSlide): CommentRecord[] {
  return commentsForElement(elementId, slideIndex).filter((comment) => !comment.parentId);
}

function repliesForComment(parentId: string): CommentRecord[] {
  return activeCommentRecords().filter((comment) => comment.parentId === parentId);
}

function likeCount(comment: CommentRecord): number {
  return Object.values(comment.reactions?.like || {}).filter(Boolean).length;
}

function userLiked(comment: CommentRecord): boolean {
  return Boolean(firebaseUser?.uid && comment.reactions?.like?.[firebaseUser.uid]);
}

function unresolvedComments(): CommentRecord[] {
  return activeCommentRecords().filter((comment) => !comment.resolved);
}

function elementById(slideIndex: number, elementId: string): SlideElement | null {
  return deck.slides[slideIndex]?.elements.find((element) => element.id === elementId) || null;
}

function startCommentsListener(): void {
  commentsUnsubscribe?.();
  commentsListenerReady = false;
  seenCommentIds = new Set();
  if (localMode) {
    activeComments = [];
    renderCommentBadges();
    return;
  }
  commentsUnsubscribe = onValue(ref(db, `presentationComments/${projectId}`), (snapshot) => {
    const nextComments = Object.entries((snapshot.val() || {}) as Record<string, CommentRecord>)
      .map(([id, value]) => ({ ...value, id: value?.id || id }))
      .filter((comment) => Boolean(comment.elementId));
    const nextSeen = new Set(nextComments.map((comment) => comment.id));
    if (commentsListenerReady) {
      const newComments = nextComments.filter((comment) => !seenCommentIds.has(comment.id) && !comment.deleted);
      void notifyNewPresentationComments(newComments);
    } else {
      commentsListenerReady = true;
    }
    seenCommentIds = nextSeen;
    activeComments = nextComments;
    renderCommentBadges();
    if (($("#comment-dialog") as HTMLDialogElement).open && activeCommentElementId) renderCommentDialog();
    handleCommentDeepLink();
  }, (error) => toast(`Komentar gagal dimuat: ${friendlyError(error)}`));
}

async function notifyNewPresentationComments(comments: CommentRecord[]): Promise<void> {
  if (role !== "owner" || !projectOwnerUid || projectOwnerUid !== firebaseUser?.uid) return;
  for (const comment of comments) {
    if (comment.authorUid === firebaseUser.uid) continue;
    await showPresentationCommentNotification(comment);
  }
}

async function requestPresentationNotificationPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

function commentDeepLink(comment: CommentRecord): string {
  const url = new URL(currentPresentationShortcutUrl(), location.origin);
  url.searchParams.set("comment", comment.id);
  url.searchParams.set("element", comment.elementId);
  url.searchParams.set("slide", String((Number(comment.slide) || 0) + 1));
  return `${url.pathname}${url.search}`;
}

async function commentNotificationImage(comment: CommentRecord): Promise<string | undefined> {
  const slide = deck.slides[clamp(Number(comment.slide) || 0, 0, deck.slides.length - 1)];
  if (!slide) return comment.elementImage;
  await waitForSlideImages(slide).catch(() => undefined);
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext("2d");
  if (!context) return comment.elementImage;
  drawSlideToContext(context, slide, canvas.width / SLIDE_WIDTH);
  return canvas.toDataURL("image/png");
}

async function showPresentationCommentNotification(comment: CommentRecord): Promise<void> {
  if (!(await requestPresentationNotificationPermission())) return;
  const isReply = Boolean(comment.parentId);
  const title = isReply
    ? `Balasan baru di ${deck.title || "ITS Presentasi"}`
    : `Komentar baru di ${deck.title || "ITS Presentasi"}`;
  const body = `${comment.authorName}: ${trimNotificationText(comment.text)}`;
  const data = {
    url: commentDeepLink(comment),
    projectId,
    commentId: comment.id,
    elementId: comment.elementId,
    slide: Number(comment.slide) || 0,
  };
  const image = await commentNotificationImage(comment).catch(() => comment.elementImage);
  const options: NotificationOptions & { image?: string } = {
    body,
    icon: "/its-presentasi.png",
    badge: "/icons/icon-96.png",
    image,
    tag: `its-presentasi-comment-${projectId}-${comment.id}`,
    data,
  };
  if ("serviceWorker" in navigator) {
    const registration = await navigator.serviceWorker.ready.catch(() => null);
    if (registration) {
      await registration.showNotification(title, options);
      return;
    }
  }
  new Notification(title, options);
}

function handleCommentDeepLink(): void {
  if (commentDeepLinkHandled) return;
  const commentId = params.get("comment") || "";
  const elementIdParam = params.get("element") || "";
  if (!commentId && !elementIdParam) return;
  const found = commentId ? activeCommentRecords().find((comment) => comment.id === commentId) : null;
  const elementId = found?.elementId || elementIdParam;
  const slideIndex = found ? Number(found.slide) || 0 : clamp(Number(params.get("slide") || 1) - 1, 0, deck.slides.length - 1);
  if (!elementId) return;
  commentDeepLinkHandled = true;
  currentSlide = clamp(slideIndex, 0, deck.slides.length - 1);
  selectedElementId = elementId;
  if (isAudienceOpen()) renderAudienceSlide();
  else renderAll();
  openCommentDialogForElement(elementId, currentSlide);
  highlightCommentTarget(elementId);
}

function highlightCommentTarget(elementId: string): void {
  requestAnimationFrame(() => {
    const node = document.querySelector<HTMLElement>(`.slide-element[data-element-id="${CSS.escape(elementId)}"], .audience-element[data-element-id="${CSS.escape(elementId)}"]`);
    if (!node) return;
    node.classList.add("comment-target-highlight");
    node.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    window.setTimeout(() => node.classList.remove("comment-target-highlight"), 3600);
  });
}

function renderCommentBadges(): void {
  const unresolved = unresolvedComments();
  const alert = $("#comment-alert") as HTMLButtonElement;
  alert.hidden = role !== "owner" || unresolved.length === 0;
  $("span", alert).textContent = String(unresolved.length);
  document.querySelectorAll<HTMLElement>(".slide-element").forEach((node) => {
    const elementId = node.dataset.elementId || "";
    const comments = commentsForElement(elementId, currentSlide);
    node.classList.toggle("has-comments", comments.some((comment) => !comment.resolved));
    node.querySelector(".comment-marker-stack")?.remove();
    if (!comments.length) return;
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "comment-marker-stack";
    marker.title = `${comments.length} komentar`;
    comments.slice(-3).forEach((comment) => {
      const avatar = document.createElement("span");
      avatar.className = "comment-marker";
      avatar.style.background = comment.authorColor || randomColor(comment.authorName);
      avatar.textContent = shortInitials(comment.authorName);
      marker.append(avatar);
    });
    if (comments.length > 3) {
      const more = document.createElement("span");
      more.className = "comment-marker more";
      more.textContent = `+${comments.length - 3}`;
      marker.append(more);
    }
    marker.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      openCommentDialogForElement(elementId, currentSlide);
    });
    node.append(marker);
  });
}

function commentPreviewHtml(element: SlideElement | null): string {
  if (!element) return "<strong>Elemen tidak ditemukan</strong><p>Elemen ini mungkin sudah dihapus.</p>";
  if (element.type === "text") return `<strong>${escapeHtml(elementLabel(element))}</strong><p>${escapeHtml(element.text || "")}</p>`;
  if (element.type === "shape") return `<strong>${escapeHtml(elementLabel(element))}</strong><p>${escapeHtml(element.text || element.shape)}</p>`;
  if (element.type === "image" || element.type === "canvas") return `<strong>${escapeHtml(elementLabel(element))}</strong><img src="${escapeAttribute(element.src)}" alt="">`;
  if (element.type === "canva") return `<strong>${escapeHtml(elementLabel(element))}</strong><p>${escapeHtml(element.url)}</p>`;
  if (element.type === "phone") return `<strong>Mockup HP</strong><p>${escapeHtml(element.deviceLabel || getDeviceLabel(element.deviceSerial) || "Perangkat mobile")}</p>`;
  return `<strong>${escapeHtml(elementLabel(element))}</strong>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] || char));
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function openElementContextMenu(elementId: string, slideIndex: number, x: number, y: number): void {
  let menu = document.getElementById("element-context-menu");
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "element-context-menu";
    menu.className = "element-context-menu";
    document.body.append(menu);
  }
  menu.innerHTML = "";
  const addComment = document.createElement("button");
  addComment.type = "button";
  addComment.textContent = "Tambahkan komentar";
  addComment.addEventListener("click", () => {
    menu!.hidden = true;
    openCommentDialogForElement(elementId, slideIndex);
  });
  menu.append(addComment);
  const existing = commentsForElement(elementId, slideIndex).length;
  if (existing) {
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = `Lihat ${existing} komentar`;
    open.addEventListener("click", () => {
      menu!.hidden = true;
      openCommentDialogForElement(elementId, slideIndex);
    });
    menu.append(open);
  }
  menu.style.left = `${Math.min(x, innerWidth - 230)}px`;
  menu.style.top = `${Math.min(y, innerHeight - 120)}px`;
  menu.hidden = false;
}

function closeElementContextMenu(): void {
  const menu = document.getElementById("element-context-menu");
  if (menu) menu.hidden = true;
}

function openCommentDialogForElement(elementId: string, slideIndex: number): void {
  activeCommentElementId = elementId;
  activeCommentSlide = slideIndex;
  replyTargetCommentId = "";
  replyTargetCommentName = "";
  renderCommentDialog();
  const dialog = $("#comment-dialog") as HTMLDialogElement;
  const actionSheet = $("#comment-action-sheet") as HTMLDialogElement;
  if (actionSheet.open) actionSheet.close();
  if (isAudienceOpen()) {
    openAudienceRailDialog(dialog);
  } else {
    dialog.classList.remove("audience-rail-dialog");
    resetDialogMotion(dialog);
    if (!dialog.open) dialog.showModal();
  }
}

function openCommentActionSheet(elementId: string, slideIndex: number): void {
  pendingCommentAction = { elementId, slideIndex };
  const sheet = $("#comment-action-sheet") as HTMLDialogElement;
  resetDialogMotion(sheet);
  if (!sheet.open) sheet.showModal();
}

function submitCommentActionSheet(): void {
  if (!pendingCommentAction) return;
  const { elementId, slideIndex } = pendingCommentAction;
  pendingCommentAction = null;
  const sheet = $("#comment-action-sheet") as HTMLDialogElement;
  if (sheet.open) sheet.close();
  openCommentDialogForElement(elementId, slideIndex);
}

function isCompactAudienceLayout(): boolean {
  return matchMedia("(max-width: 760px)").matches || matchMedia("(max-height: 560px) and (orientation: landscape)").matches;
}

function renderCommentDialog(): void {
  const element = elementById(activeCommentSlide, activeCommentElementId);
  $("#comment-title").textContent = `Komentar untuk ${elementLabel(element)} pada slide ${activeCommentSlide + 1}`;
  $("#comment-preview").innerHTML = commentPreviewHtml(element);
  const avatar = $("#comment-author-avatar");
  avatar.textContent = shortInitials(participantName);
  avatar.setAttribute("style", `background:${randomColor(participantName)}`);
  const list = $("#comment-list");
  list.innerHTML = "";
  const comments = topLevelCommentsForElement(activeCommentElementId, activeCommentSlide);
  if (!comments.length) {
    list.innerHTML = '<p class="empty-people">Belum ada komentar untuk elemen ini.</p>';
  }
  if (comments.length) comments.forEach((comment) => list.append(renderCommentRow(comment)));
  updateReplyTargetUi();
  ($("#replace-comment-image") as HTMLButtonElement).hidden = !(role === "owner" && element?.type === "image");
}

function renderCommentRow(comment: CommentRecord, depth = 0): HTMLElement {
  const row = document.createElement("article");
  row.className = `comment-row${comment.resolved ? " resolved" : ""}${depth ? " reply" : ""}`;
  row.innerHTML = '<span class="presence-avatar"></span><div class="comment-row-body"><div class="comment-meta"><strong></strong><time></time></div><p></p><div class="comment-actions"></div><div class="comment-replies"></div></div>';
  const marker = $(".presence-avatar", row);
  marker.textContent = shortInitials(comment.authorName);
  marker.setAttribute("style", `background:${comment.authorColor || randomColor(comment.authorName)}`);
  $("strong", row).textContent = comment.authorName;
  $("p", row).textContent = comment.text;
  $("time", row).textContent = comment.resolved ? `Selesai - ${formatDateTime(commentTime(comment))}` : formatDateTime(commentTime(comment));
  const actions = $(".comment-actions", row);

  const likeButton = document.createElement("button");
  likeButton.type = "button";
  likeButton.className = userLiked(comment) ? "active" : "";
  likeButton.setAttribute("aria-label", userLiked(comment) ? "Batalkan suka komentar" : "Sukai komentar");
  likeButton.textContent = `Suka ${likeCount(comment) || ""}`.trim();
  likeButton.addEventListener("click", () => void toggleCommentLike(comment.id));
  actions.append(likeButton);

  const replyButton = document.createElement("button");
  replyButton.type = "button";
  replyButton.textContent = "Balas";
  replyButton.addEventListener("click", () => setReplyTarget(comment));
  actions.append(replyButton);

  if (role === "owner" || comment.authorUid === firebaseUser.uid) {
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.textContent = "Hapus";
    removeButton.addEventListener("click", () => void deleteComment(comment.id));
    actions.append(removeButton);
  }
  if (role === "owner") {
    const resolveButton = document.createElement("button");
    resolveButton.type = "button";
    resolveButton.textContent = comment.resolved ? "Buka lagi" : "Selesai";
    resolveButton.addEventListener("click", () => void resolveComment(comment.id, !comment.resolved));
    actions.append(resolveButton);
  }

  const repliesWrap = $(".comment-replies", row);
  repliesForComment(comment.id).forEach((reply) => repliesWrap.append(renderCommentRow(reply, depth + 1)));
  return row;
}

function setReplyTarget(comment: CommentRecord): void {
  replyTargetCommentId = comment.id;
  replyTargetCommentName = comment.authorName;
  updateReplyTargetUi();
  ($("#comment-input") as HTMLTextAreaElement).focus();
}

function updateReplyTargetUi(): void {
  const target = $("#comment-reply-target");
  if (!replyTargetCommentId) {
    target.hidden = true;
    target.innerHTML = "";
    ($("#comment-input") as HTMLTextAreaElement).placeholder = "Tulis komentar";
    return;
  }
  target.hidden = false;
  target.innerHTML = `<span>Membalas ${escapeHtml(replyTargetCommentName)}</span><button type="button" aria-label="Batal balas">x</button>`;
  $("button", target).addEventListener("click", () => {
    replyTargetCommentId = "";
    replyTargetCommentName = "";
    updateReplyTargetUi();
  });
  ($("#comment-input") as HTMLTextAreaElement).placeholder = `Balas ${replyTargetCommentName}`;
}

async function submitComment(): Promise<void> {
  const element = elementById(activeCommentSlide, activeCommentElementId);
  const input = $("#comment-input") as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!element || !text) return;
  const id = uid("comment");
  const record: CommentRecord = {
    id,
    slide: activeCommentSlide,
    elementId: element.id,
    elementLabel: elementLabel(element),
    elementKind: element.type,
    authorUid: firebaseUser.uid,
    authorName: participantName,
    authorColor: randomColor(participantName),
    text,
    createdAt: serverTimestamp(),
  };
  if (replyTargetCommentId) record.parentId = replyTargetCommentId;
  if (element.type === "text") record.elementText = element.text.slice(0, 400);
  if (element.type === "shape" && element.text) record.elementText = element.text.slice(0, 400);
  if (element.type === "image" || element.type === "canvas") record.elementImage = element.src.slice(0, 600);
  if (element.type === "canva") record.elementText = element.url.slice(0, 400);
  input.value = "";
  replyTargetCommentId = "";
  replyTargetCommentName = "";
  if (localMode) {
    activeComments.push({ ...record, createdAt: Date.now() });
    renderCommentBadges();
    renderCommentDialog();
    return;
  }
  await set(ref(db, `presentationComments/${projectId}/${id}`), record);
  if (role !== "owner") toast("Komentar dikirim ke pemilik.");
}

async function deleteComment(id: string): Promise<void> {
  if (!id) return;
  if (localMode) activeComments = activeComments.filter((comment) => comment.id !== id);
  else await update(ref(db, `presentationComments/${projectId}/${id}`), { deleted: true, deletedAt: serverTimestamp() });
  renderCommentBadges();
  renderCommentDialog();
}

async function resolveComment(id: string, resolved: boolean): Promise<void> {
  if (!id || role !== "owner") return;
  if (localMode) {
    activeComments = activeComments.map((comment) => comment.id === id ? { ...comment, resolved, resolvedAt: Date.now() } : comment);
  } else {
    await update(ref(db, `presentationComments/${projectId}/${id}`), { resolved, resolvedAt: serverTimestamp() });
  }
  renderCommentBadges();
  renderCommentDialog();
}

async function toggleCommentLike(id: string): Promise<void> {
  if (!id || !firebaseUser?.uid) return;
  const found = activeComments.find((comment) => comment.id === id);
  if (!found) return;
  const nextLiked = !userLiked(found);
  if (localMode) {
    activeComments = activeComments.map((comment) => {
      if (comment.id !== id) return comment;
      const like = { ...(comment.reactions?.like || {}) };
      if (nextLiked) like[firebaseUser.uid] = true;
      else delete like[firebaseUser.uid];
      return { ...comment, reactions: { ...(comment.reactions || {}), like } };
    });
    renderCommentBadges();
    renderCommentDialog();
    return;
  }
  await update(ref(db, `presentationComments/${projectId}/${id}/reactions/like`), { [firebaseUser.uid]: nextLiked ? true : null });
}

function openFirstUnresolvedComment(): void {
  const first = unresolvedComments()[0];
  if (!first) return;
  currentSlide = clamp(Number(first.slide) || 0, 0, deck.slides.length - 1);
  selectedElementId = first.elementId;
  if (!isAudienceOpen()) renderAll();
  else renderAudienceSlide();
  openCommentDialogForElement(first.elementId, currentSlide);
}

function startOwnerCollaborationListener(): void {
  const token = getOrCreateEditorToken();
  collaborationUnsubscribe?.();
  collaborationUnsubscribe = onValue(ref(db, `presentationCollab/${projectId}/${token}`), (snapshot) => {
    const packets = Object.values((snapshot.val() || {}) as Record<string, CollaborationPacket>)
      .filter((packet) => packet?.deck && Number(packet.updatedAt) > lastAppliedCollaboration)
      .sort((a, b) => Number(a.updatedAt) - Number(b.updatedAt));
    const latest = packets.at(-1);
    if (!latest) return;
    lastAppliedCollaboration = Number(latest.updatedAt);
    applyingRemote = true;
    deck = sanitizeDeck(latest.deck);
    currentSlide = clamp(currentSlide, 0, deck.slides.length - 1);
    selectedElementId = null;
    applyingRemote = false;
    renderAll();
    scheduleSave(`Perubahan dari ${latest.name}`);
  });
}

function recordHistory(): void {
  const snapshot = serializableDeck();
  const json = JSON.stringify(snapshot);
  if (json === lastHistoryJson) return;
  if (lastHistoryJson) undoStack.push(JSON.parse(lastHistoryJson) as Deck);
  if (undoStack.length > 60) undoStack.shift();
  lastHistoryJson = json;
  redoStack.length = 0;
  updateHistoryButtons();
}

function resetHistoryBaseline(): void {
  undoStack.length = 0;
  redoStack.length = 0;
  lastHistoryJson = JSON.stringify(serializableDeck());
  updateHistoryButtons();
}

function updateHistoryButtons(): void {
  ($("#undo") as HTMLButtonElement).disabled = !undoStack.length || !isEditableRole();
  ($("#redo") as HTMLButtonElement).disabled = !redoStack.length || !isEditableRole();
}

function undo(): void {
  const previous = undoStack.pop();
  if (!previous) return;
  redoStack.push(serializableDeck());
  deck = sanitizeDeck(previous);
  lastHistoryJson = JSON.stringify(deck);
  selectedElementId = null;
  renderAll();
  scheduleSave();
  updateHistoryButtons();
}

function redo(): void {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(serializableDeck());
  deck = sanitizeDeck(next);
  lastHistoryJson = JSON.stringify(deck);
  selectedElementId = null;
  renderAll();
  scheduleSave();
  updateHistoryButtons();
}

function scheduleSave(label = "Menyimpan…"): void {
  if (applyingRemote || !isEditableRole()) return;
  setSaveState("saving", label);
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void persistDeck(), SAVE_DELAY);
}

function flushSave(label = "Menyimpan..."): void {
  scheduleSave(label);
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  void persistDeck();
}

async function persistDeck(): Promise<void> {
  saveTimer = 0;
  const cleanDeck = serializableDeck();
  const now = Date.now();
  updatePresentationMetadata();
  rememberPresentationShortcut();
  if (localMode) {
    try {
      localStorage.setItem(`its-presentasi-local:${projectId}`, JSON.stringify({ deck: cleanDeck, updatedAt: now }));
    } catch {
      // Deck PPT raster HD can exceed browser localStorage quota in test mode.
    }
    setSaveState("saved");
    return;
  }
  try {
    if (role === "owner") {
      await Promise.all([
        set(ref(db, `presentations/${projectId}/deck`), cleanDeck),
        update(ref(db, `presentations/${projectId}`), { updatedAt: now }),
        set(ref(db, `presentationUsers/${firebaseUser.uid}/projects/${projectId}`), { title: cleanDeck.title, updatedAt: now, createdAt: projectCreatedAt || now }),
      ]);
    } else if (role === "editor" && editorToken) {
      const packet: CollaborationPacket = { uid: firebaseUser.uid, name: participantName, deck: cleanDeck, updatedAt: now };
      await set(ref(db, `presentationCollab/${projectId}/${editorToken}/${firebaseUser.uid}`), packet);
    }
    setSaveState("saved");
  } catch (error) {
    console.error(error);
    setSaveState("error");
    toast(`Gagal menyimpan: ${friendlyError(error)}`);
  }
}

function renderAll(): void {
  if (document.activeElement !== $("#deck-title")) ($("#deck-title") as HTMLInputElement).value = deck.title;
  renderSlideList();
  renderCanvas();
  renderProperties();
  renderDeviceSelect();
  syncInspectorMode();
  renderCounterAndNotes();
  updateHistoryButtons();
  syncCanvaAutoUpdate();
}

function syncCanvaAutoUpdate(): void {
  const source = deck.source;
  const nextKey = source?.type === "canva" && source.autoUpdate !== false && isWritableOwner() && !localMode
    ? `${projectId}:${source.url}`
    : "";
  if (!nextKey) {
    stopCanvaAutoUpdate();
    return;
  }
  if (canvaAutoTimer && canvaAutoKey === nextKey) return;
  stopCanvaAutoUpdate();
  canvaAutoKey = nextKey;
  canvaAutoTimer = window.setInterval(() => {
    void refreshCanvaSource(true);
  }, CANVA_AUTO_UPDATE_INTERVAL);
}

function stopCanvaAutoUpdate(): void {
  if (canvaAutoTimer) window.clearInterval(canvaAutoTimer);
  canvaAutoTimer = 0;
  canvaAutoKey = "";
}

function createSlidePreview(slide: Slide | undefined, className = "mini-slide"): HTMLElement {
  const frame = document.createElement("div");
  frame.className = `mini-slide ${className}`;
  if (!slide) {
    frame.innerHTML = '<span class="mini-empty"></span>';
    return frame;
  }
  for (const element of slide.elements) {
    const node = document.createElement("span");
    node.className = `mini-element mini-${element.type}`;
    node.style.left = `${(element.x / SLIDE_WIDTH) * 100}%`;
    node.style.top = `${(element.y / SLIDE_HEIGHT) * 100}%`;
    node.style.width = `${(element.w / SLIDE_WIDTH) * 100}%`;
    node.style.height = `${(element.h / SLIDE_HEIGHT) * 100}%`;
    if (element.type === "text") {
      node.textContent = element.text || "";
      node.style.fontFamily = element.fontFamily || "";
      node.style.fontSize = `${Math.max(4, (element.fontSize || (element.variant === "title" ? 36 : 20)) * 0.12)}px`;
      node.style.color = element.color || (element.variant === "title" ? "#202124" : "#5f6368");
      node.style.fontWeight = element.bold || element.variant === "title" ? "600" : "400";
      node.style.fontStyle = element.italic ? "italic" : "";
      node.style.textDecoration = element.underline ? "underline" : "";
      node.style.textAlign = element.align || "";
    } else if (element.type === "image" || element.type === "canvas") {
      const image = document.createElement("img");
      image.src = element.src;
      image.alt = "";
      node.append(image);
    } else if (element.type === "canva") {
      node.classList.add("mini-canva");
      node.textContent = "Canva";
    } else if (element.type === "shape") {
      node.classList.add(`mini-shape-${element.shape}`);
      node.style.background = element.shape === "line" ? "transparent" : element.fill || "transparent";
      node.style.borderColor = element.stroke || "#dadce0";
      node.textContent = element.text || "";
      node.style.color = element.color || "#202124";
    } else {
      node.innerHTML = '<i></i>';
    }
    frame.append(node);
  }
  return frame;
}

type SlideSegment = { label: string; start: number; end: number };

function slideSegmentLabel(index: number): string {
  const slide = deck.slides[index];
  return (slide?.section || slide?.name || `Slide ${index + 1}`).trim() || `Slide ${index + 1}`;
}

function slideSegments(): SlideSegment[] {
  const segments: SlideSegment[] = [];
  deck.slides.forEach((_, index) => {
    const label = slideSegmentLabel(index);
    const previous = segments.at(-1);
    if (previous && previous.label === label) previous.end = index;
    else segments.push({ label, start: index, end: index });
  });
  return segments;
}

function segmentForSlide(index: number): SlideSegment {
  return slideSegments().find((segment) => index >= segment.start && index <= segment.end) || { label: slideSegmentLabel(index), start: index, end: index };
}

function renderSegmentDialog(): void {
  const list = $("#segment-list");
  list.innerHTML = "";
  slideSegments().forEach((segment) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `segment-row${presenterSlide >= segment.start && presenterSlide <= segment.end ? " live-owner" : ""}${currentSlide >= segment.start && currentSlide <= segment.end ? " active" : ""}`;
    row.innerHTML = '<span class="segment-row-thumb"></span><span class="segment-row-copy"><strong></strong><em></em></span>';
    $(".segment-row-thumb", row).append(createSlidePreview(deck.slides[segment.start], "segment-slide-preview"));
    $("strong", row).textContent = segment.label;
    $("em", row).textContent = segment.start === segment.end ? `Slide ${segment.start + 1}` : `Slide ${segment.start + 1} - ${segment.end + 1}`;
    row.addEventListener("click", () => {
      ($("#segment-dialog") as HTMLDialogElement).close();
      goToAudienceSlide(segment.start);
    });
    list.append(row);
  });
}

function moveSlide(from: number, to: number): void {
  if (!isEditableRole() || from === to || from < 0 || to < 0 || from >= deck.slides.length || to >= deck.slides.length) return;
  const [slide] = deck.slides.splice(from, 1);
  deck.slides.splice(to, 0, slide);
  if (currentSlide === from) currentSlide = to;
  else if (from < currentSlide && to >= currentSlide) currentSlide -= 1;
  else if (from > currentSlide && to <= currentSlide) currentSlide += 1;
  selectedElementId = null;
  recordHistory();
  renderAll();
  scheduleSave();
  if (presentationState.presenting && role === "owner") void publishSlideState();
}

function renameSlide(index: number): void {
  const slide = deck.slides[index];
  if (!slide || !isEditableRole()) return;
  const oldName = slide.name || `Slide ${index + 1}`;
  const next = prompt("Nama slide", oldName);
  if (next === null) return;
  const cleaned = next.trim().slice(0, 160);
  if (!cleaned) return;
  slide.name = cleaned;
  if (!slide.section || slide.section === oldName) slide.section = cleaned;
  recordHistory();
  renderAll();
  scheduleSave();
}

function renameSegment(index: number): void {
  if (!isEditableRole()) return;
  const segment = segmentForSlide(index);
  const next = prompt("Nama segment", segment.label);
  if (next === null) return;
  const cleaned = next.trim().slice(0, 120);
  if (!cleaned) return;
  for (let i = segment.start; i <= segment.end; i += 1) deck.slides[i].section = cleaned;
  recordHistory();
  renderAll();
  scheduleSave();
}

function setSlideSectionFromNeighbor(index: number, direction: -1 | 1): void {
  const slide = deck.slides[index];
  const neighbor = deck.slides[index + direction];
  if (!slide || !neighbor || !isEditableRole()) return;
  slide.section = slideSegmentLabel(index + direction);
  recordHistory();
  renderAll();
  scheduleSave();
}

function ensureSlideContextMenu(): HTMLElement {
  let menu = document.getElementById("slide-context-menu");
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "slide-context-menu";
    menu.className = "slide-context-menu";
    menu.hidden = true;
    document.body.append(menu);
  }
  return menu;
}

function closeSlideContextMenu(): void {
  ensureSlideContextMenu().hidden = true;
}

function openSlideContextMenu(index: number, x: number, y: number): void {
  if (!isEditableRole()) return;
  const menu = ensureSlideContextMenu();
  const items: Array<{ label: string; disabled?: boolean; action: () => void }> = [
    { label: "Ganti nama slide", action: () => renameSlide(index) },
    { label: "Ganti nama segment", action: () => renameSegment(index) },
    { label: "Masukkan ke segment sebelumnya", disabled: index <= 0, action: () => setSlideSectionFromNeighbor(index, -1) },
    { label: "Masukkan ke segment berikutnya", disabled: index >= deck.slides.length - 1, action: () => setSlideSectionFromNeighbor(index, 1) },
    { label: "Slide baru", action: addSlide },
    { label: "Duplikasikan slide", action: duplicateSlide },
    { label: "Hapus slide", disabled: deck.slides.length <= 1, action: deleteCurrentSlide },
  ];
  currentSlide = index;
  selectedElementId = null;
  renderAll();
  menu.innerHTML = "";
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.label;
    button.disabled = Boolean(item.disabled);
    button.addEventListener("click", () => {
      closeSlideContextMenu();
      item.action();
    });
    menu.append(button);
  }
  menu.style.left = `${Math.min(x, innerWidth - 245)}px`;
  menu.style.top = `${Math.min(y, innerHeight - 250)}px`;
  menu.hidden = false;
}

function renderSlideList(): void {
  const target = $("#slide-list");
  target.innerHTML = "";
  deck.slides.forEach((slide, index) => {
    const node = document.createElement("div");
    node.className = `slide-thumb${index === currentSlide ? " active" : ""}`;
    node.draggable = isEditableRole();
    node.dataset.slideIndex = String(index);
    node.innerHTML = `<span class="slide-thumb-number">${index + 1}</span><div><div class="slide-thumb-frame"></div><span class="slide-thumb-label"></span></div>`;
    $(".slide-thumb-frame", node).append(createSlidePreview(slide, "sidebar-slide-preview"));
    $(".slide-thumb-label", node).textContent = slideSegmentLabel(index);
    node.title = slide.name;
    node.addEventListener("click", () => {
      currentSlide = index;
      selectedElementId = null;
      renderAll();
      updatePresenceSlide();
      if (presentationState.presenting && role === "owner") void publishSlideState();
    });
    node.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openSlideContextMenu(index, event.clientX, event.clientY);
    });
    node.addEventListener("dragstart", (event) => {
      if (!isEditableRole()) return;
      slideDragIndex = index;
      node.classList.add("dragging");
      event.dataTransfer?.setData("text/plain", String(index));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    node.addEventListener("dragover", (event) => {
      if (slideDragIndex < 0 || !isEditableRole()) return;
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      node.classList.toggle("drop-after", event.clientY > rect.top + rect.height / 2);
      node.classList.toggle("drop-before", event.clientY <= rect.top + rect.height / 2);
    });
    node.addEventListener("dragleave", () => node.classList.remove("drop-before", "drop-after"));
    node.addEventListener("drop", (event) => {
      if (slideDragIndex < 0 || !isEditableRole()) return;
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const targetIndex = index + (event.clientY > rect.top + rect.height / 2 ? 1 : 0);
      const adjusted = slideDragIndex < targetIndex ? targetIndex - 1 : targetIndex;
      node.classList.remove("drop-before", "drop-after");
      moveSlide(slideDragIndex, clamp(adjusted, 0, deck.slides.length - 1));
      slideDragIndex = -1;
    });
    node.addEventListener("dragend", () => {
      slideDragIndex = -1;
      document.querySelectorAll(".slide-thumb").forEach((item) => item.classList.remove("dragging", "drop-before", "drop-after"));
    });
    target.append(node);
  });
}

function renderCanvas(): void {
  const canvas = $("#slide-canvas");
  canvas.innerHTML = "";
  if (!current().elements.length) {
    canvas.innerHTML = '<div class="empty-slide"><strong>Slide kosong</strong><span>Tambahkan teks atau mockup HP dari toolbar.</span></div>';
    renderRemoteCursors();
    return;
  }
  for (const element of current().elements) canvas.append(createElementNode(element, false));
  renderRemoteCursors();
  renderCommentBadges();
}

function applyTextStyle(node: HTMLElement, element: Pick<TextElement, "fontFamily" | "fontSize" | "color" | "bold" | "italic" | "underline" | "variant" | "align" | "insetLeft" | "insetRight" | "insetTop" | "insetBottom" | "lineHeight">): void {
  node.style.fontFamily = element.fontFamily ? `${element.fontFamily}, Inter, Segoe UI, Arial` : "";
  node.style.fontSize = element.fontSize ? `${element.fontSize}px` : "";
  node.style.color = element.color || "";
  node.style.fontWeight = element.bold ? "700" : "";
  node.style.fontStyle = element.italic ? "italic" : "";
  node.style.textDecoration = element.underline ? "underline" : "";
  node.style.textAlign = element.align || "";
  if ([element.insetTop, element.insetRight, element.insetBottom, element.insetLeft].some((value) => typeof value === "number")) {
    node.style.padding = `${element.insetTop ?? 6}px ${element.insetRight ?? 8}px ${element.insetBottom ?? 6}px ${element.insetLeft ?? 8}px`;
  }
  node.style.lineHeight = element.lineHeight ? String(element.lineHeight) : "";
}

function ensureDeckImage(src: string): HTMLImageElement {
  let image = deckImages.get(src);
  if (!image) {
    image = new Image();
    image.onload = () => drawBroadcastFrame();
    image.src = src;
    deckImages.set(src, image);
  }
  return image;
}

function appendMoveHandle(node: HTMLElement): void {
  node.dataset.dragHandle = "element";
}

function isNearElementEdge(event: PointerEvent, node: HTMLElement): boolean {
  const rect = node.getBoundingClientRect();
  const threshold = Math.max(8, Math.min(16, 12 * zoom));
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  return x <= threshold || y <= threshold || rect.width - x <= threshold || rect.height - y <= threshold;
}

function updateElementCursor(event: PointerEvent, node: HTMLElement): void {
  if (!selectedElementId || node.dataset.elementId !== selectedElementId) return;
  node.classList.toggle("edge-hover", isNearElementEdge(event, node));
}

function bindCommentInteractions(node: HTMLElement, element: SlideElement, audience: boolean): void {
  let longPressTimer = 0;
  let longPressOpenedAt = 0;
  const slideIndex = currentSlide;
  node.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openElementContextMenu(element.id, slideIndex, event.clientX, event.clientY);
  });
  node.addEventListener("click", (event) => {
    if (Date.now() - longPressOpenedAt < 700) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if ((event.target as HTMLElement).closest('[contenteditable="true"], .resize-handle')) return;
    if (!commentsForElement(element.id, slideIndex).length) return;
    event.preventDefault();
    event.stopPropagation();
    openCommentDialogForElement(element.id, slideIndex);
  });
  node.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch") return;
    clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(() => {
      if (isAudienceOpen() && isCompactAudienceLayout()) openCommentActionSheet(element.id, slideIndex);
      else openElementContextMenu(element.id, slideIndex, event.clientX, event.clientY);
      longPressOpenedAt = Date.now();
    }, 560);
  });
  node.addEventListener("pointermove", () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = 0;
    }
  });
  node.addEventListener("pointerup", () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = 0;
    }
  });
  if (audience) node.tabIndex = 0;
}

function elementFromSurfaceEvent(event: MouseEvent | PointerEvent, surface: HTMLElement): SlideElement | null {
  const point = pointerToSlidePoint(event, surface);
  return elementAtSlidePoint(point.x, point.y);
}

function openElementContextMenuFromSurface(event: MouseEvent | PointerEvent, surface: HTMLElement): boolean {
  if (event.defaultPrevented) return false;
  if ((event.target as HTMLElement).closest("dialog, .element-context-menu, button, input, textarea, select, [contenteditable='true']")) return false;
  const element = elementFromSurfaceEvent(event, surface);
  if (!element) return false;
  event.preventDefault();
  event.stopPropagation();
  openElementContextMenu(element.id, currentSlide, event.clientX, event.clientY);
  return true;
}

function bindSurfaceCommentInteractions(surface: HTMLElement): void {
  let longPressTimer = 0;
  let startX = 0;
  let startY = 0;
  surface.addEventListener("contextmenu", (event) => {
    openElementContextMenuFromSurface(event, surface);
  });
  surface.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch") return;
    startX = event.clientX;
    startY = event.clientY;
    clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(() => {
      if (isAudienceOpen() && isCompactAudienceLayout()) {
        const element = elementFromSurfaceEvent(event, surface);
        if (element) {
          event.preventDefault();
          event.stopPropagation();
          openCommentActionSheet(element.id, currentSlide);
        }
      } else {
        openElementContextMenuFromSurface(event, surface);
      }
    }, 560);
  });
  surface.addEventListener("pointermove", (event) => {
    if (!longPressTimer) return;
    if (Math.abs(event.clientX - startX) > 8 || Math.abs(event.clientY - startY) > 8) {
      clearTimeout(longPressTimer);
      longPressTimer = 0;
    }
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
    surface.addEventListener(type, () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = 0;
      }
    });
  }
}

function bindAudienceStageGestures(surface: HTMLElement): void {
  const pointers = new Map<number, PointerEvent>();
  let lastTap = 0;
  let swipePointerId = -1;
  let swipeStartX = 0;
  let swipeStartY = 0;
  let swiping = false;
  const distance = () => {
    const values = [...pointers.values()];
    if (values.length < 2) return 0;
    return Math.hypot(values[0].clientX - values[1].clientX, values[0].clientY - values[1].clientY);
  };
  surface.addEventListener("pointerdown", (event) => {
    pointers.set(event.pointerId, event);
    if (pointers.size === 2) audiencePinchDistance = distance();
    if (event.pointerType === "touch" && pointers.size === 1) {
      swipePointerId = event.pointerId;
      swipeStartX = event.clientX;
      swipeStartY = event.clientY;
      swiping = false;
      const now = Date.now();
      if (now - lastTap < 280) {
        event.preventDefault();
        toggleAudienceFillMode();
      }
      lastTap = now;
    }
  });
  surface.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, event);
    if (event.pointerId === swipePointerId && pointers.size === 1) {
      const dx = event.clientX - swipeStartX;
      const dy = event.clientY - swipeStartY;
      if (!swiping && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.25) swiping = true;
      if (swiping) {
        event.preventDefault();
        const slide = $("#audience-slide");
        surface.classList.add("slide-swiping");
        surface.classList.remove("slide-settling");
        const atEnd = (dx > 0 && currentSlide >= deck.slides.length - 1) || (dx < 0 && currentSlide <= 0);
        const damped = atEnd ? dx * 0.28 : dx;
        slide.style.setProperty("--audience-slide-x", `${damped}px`);
        slide.style.setProperty("--audience-slide-opacity", String(Math.max(0.64, 1 - Math.abs(dx) / Math.max(360, surface.clientWidth))));
      }
    }
    if (pointers.size !== 2 || !audiencePinchDistance) return;
    const next = distance();
    if (Math.abs(next - audiencePinchDistance) < 34) return;
    setAudienceFillMode(next > audiencePinchDistance ? "cover" : "contain");
    audiencePinchDistance = next;
  });
  const release = (event: PointerEvent) => {
    if (event.pointerId === swipePointerId) {
      const dx = event.clientX - swipeStartX;
      const dy = Math.abs(event.clientY - swipeStartY);
      if (swiping) {
        audienceSwipeSuppressClickUntil = Date.now() + 420;
        const direction = dx > 0 ? 1 : -1;
        const nextIndex = clamp(currentSlide + direction, 0, deck.slides.length - 1);
        if (Math.abs(dx) > Math.min(140, surface.clientWidth * 0.18) && dy < 120 && nextIndex !== currentSlide) {
          animateAudienceSwipeToSlide(nextIndex, direction as 1 | -1);
        } else {
          resetAudienceSwipeMotion(true);
        }
      }
      swiping = false;
      swipePointerId = -1;
    }
    pointers.delete(event.pointerId);
    if (pointers.size < 2) audiencePinchDistance = 0;
  };
  surface.addEventListener("pointerup", release);
  surface.addEventListener("pointercancel", release);
  surface.addEventListener("pointerleave", release);
  surface.addEventListener("dblclick", (event) => {
    event.preventDefault();
    toggleAudienceFillMode();
  });
}

function createElementNode(element: SlideElement, audience: boolean): HTMLDivElement {
  const node = document.createElement("div");
  node.className = `slide-element ${element.type}-slide-element${!audience && selectedElementId === element.id ? " selected" : ""}${element.animation ? ` anim-${element.animation}` : ""}`;
  node.dataset.elementId = element.id;
  node.style.left = `${element.x}px`;
  node.style.top = `${element.y}px`;
  node.style.width = `${element.w}px`;
  node.style.height = `${element.h}px`;
  if (element.type === "text") {
    const text = document.createElement("div");
    text.className = `text-element ${element.variant}`;
    text.textContent = element.text;
    text.contentEditable = String(!audience && isEditableRole());
    text.spellcheck = false;
    applyTextStyle(text, element);
    text.addEventListener("focus", () => { selectedElementId = element.id; renderProperties(); });
    text.addEventListener("input", () => {
      element.text = text.textContent || "";
      announceEditing(element);
      scheduleSave();
    });
    text.addEventListener("blur", recordHistory);
    node.append(text);
  } else if (element.type === "phone") {
    const label = getDeviceLabel(element.deviceSerial) || element.deviceLabel || "Belum memilih perangkat";
    node.innerHTML = `<div class="device-label${element.deviceSerial && mirrorStates.get(element.deviceSerial)?.running ? " live" : ""}"><i></i><span></span></div><div class="phone-element"><div class="phone-notch"></div><div class="phone-screen"><div class="phone-placeholder"><b>▯</b><span></span></div></div><div class="phone-home"></div></div>`;
    $(".device-label span", node).textContent = label;
    $(".phone-placeholder span", node).textContent = element.deviceSerial ? "Klik Mulai mirror atau Presentasikan" : "Pilih perangkat USB pada panel kanan";
    if (element.deviceSerial) {
      const frame = frameImages.get(element.deviceSerial);
      if (frame?.src) {
        const image = new Image();
        image.src = frame.src;
        $(".phone-screen", node).innerHTML = "";
        $(".phone-screen", node).append(image);
      }
    }
  } else if (element.type === "image") {
    const image = ensureDeckImage(element.src).cloneNode(false) as HTMLImageElement;
    image.className = "image-element";
    image.alt = element.alt || "Gambar presentasi";
    image.draggable = false;
    node.append(image);
  } else if (element.type === "canvas") {
    const canvas = document.createElement("canvas");
    canvas.className = "canvas-element";
    canvas.width = Math.max(1, Math.round(element.w * 2));
    canvas.height = Math.max(1, Math.round(element.h * 2));
    canvas.setAttribute("aria-label", element.alt || "Canvas presentasi");
    const context = canvas.getContext("2d");
    const image = ensureDeckImage(element.src);
    const draw = () => {
      if (!context || !image.complete || !image.naturalWidth) return;
      context.setTransform(canvas.width / element.w, 0, 0, canvas.height / element.h, 0, 0);
      context.clearRect(0, 0, element.w, element.h);
      context.drawImage(image, 0, 0, element.w, element.h);
    };
    if (image.complete && image.naturalWidth) draw();
    else image.addEventListener("load", draw, { once: true });
    node.append(canvas);
  } else if (element.type === "canva") {
    const shell = document.createElement("div");
    shell.className = "canva-element";
    const message = document.createElement("div");
    message.className = "canva-import-note";
    message.innerHTML = "<strong>Canva belum diekstrak</strong><span>Gunakan export PPTX dari Canva atau worker server-side ITS. Elemen ini bukan iframe.</span>";
    const open = document.createElement("a");
    open.href = element.url;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = "Buka Canva";
    shell.append(message, open);
    node.append(shell);
  } else {
    const shape = document.createElement("div");
    shape.className = `shape-element ${element.shape}`;
    shape.style.background = element.shape === "line" ? "transparent" : element.fill || "transparent";
    shape.style.borderColor = element.stroke || "transparent";
    shape.textContent = element.text || "";
    shape.contentEditable = String(!audience && isEditableRole() && element.shape !== "line");
    shape.spellcheck = false;
    applyTextStyle(shape, { ...element, variant: "body" });
    shape.addEventListener("focus", () => { selectedElementId = element.id; renderProperties(); });
    shape.addEventListener("input", () => {
      element.text = shape.textContent || "";
      announceEditing(element);
      scheduleSave();
    });
    shape.addEventListener("blur", recordHistory);
    node.append(shape);
  }
  if (!audience && isEditableRole()) {
    appendMoveHandle(node);
    for (const handle of ["nw", "ne", "sw", "se"]) {
      const resize = document.createElement("span");
      resize.className = `resize-handle ${handle}`;
      resize.dataset.handle = handle;
      node.append(resize);
    }
    node.addEventListener("pointerdown", (event) => beginPointerTransform(event, node, element));
    node.addEventListener("pointermove", (event) => updateElementCursor(event, node));
    node.addEventListener("pointerleave", () => node.classList.remove("edge-hover"));
  }
  bindCommentInteractions(node, element, audience);
  return node;
}

function selectElementNode(elementId: string, node?: HTMLElement): void {
  selectedElementId = elementId;
  document.querySelectorAll<HTMLElement>("#slide-canvas .slide-element.selected").forEach((item) => item.classList.remove("selected"));
  (node || document.querySelector<HTMLElement>(`#slide-canvas .slide-element[data-element-id="${CSS.escape(elementId)}"]`))?.classList.add("selected");
  renderProperties();
  renderDeviceSelect();
  syncInspectorMode();
}

function syncNodeBounds(node: HTMLElement, element: SlideElement): void {
  node.style.left = `${element.x}px`;
  node.style.top = `${element.y}px`;
  node.style.width = `${element.w}px`;
  node.style.height = `${element.h}px`;
}

function syncCanvasElementBounds(elements: SlideElement[] = current().elements): void {
  for (const item of elements) {
    const node = document.querySelector<HTMLElement>(`#slide-canvas .slide-element[data-element-id="${CSS.escape(item.id)}"]`);
    if (node) syncNodeBounds(node, item);
  }
}

function focusTextElement(elementId: string): void {
  requestAnimationFrame(() => {
    const node = document.querySelector<HTMLElement>(`#slide-canvas .slide-element[data-element-id="${CSS.escape(elementId)}"] .text-element`);
    if (!node) return;
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

function beginPointerTransform(event: PointerEvent, node: HTMLElement, element: SlideElement): void {
  const target = event.target as HTMLElement;
  const resizeTarget = target.closest<HTMLElement>(".resize-handle");
  selectElementNode(element.id, node);
  const canMove = Boolean(resizeTarget) || isNearElementEdge(event, node);
  if (!canMove) return;
  const editableText = target.closest('[contenteditable="true"]');
  if (editableText && !resizeTarget && !isNearElementEdge(event, node)) return;

  event.preventDefault();
  node.setPointerCapture?.(event.pointerId);
  const handle = resizeTarget?.dataset.handle || "";
  const movingGroup = !handle && element.type === "shape" && element.tableId
    ? current().elements.filter((item): item is ShapeElement => item.type === "shape" && item.tableId === element.tableId)
    : [element];
  const groupStart = movingGroup.map((item) => ({ element: item, x: item.x, y: item.y }));
  const start = { clientX: event.clientX, clientY: event.clientY, x: element.x, y: element.y, w: element.w, h: element.h };
  let frame = 0;
  let moved = false;

  const updateFromPointer = (next: PointerEvent) => {
    const dx = (next.clientX - start.clientX) / zoom;
    const dy = (next.clientY - start.clientY) / zoom;
    moved = true;
    if (!handle) {
      for (const item of groupStart) {
        item.element.x = clamp(item.x + dx, -item.element.w + 16, SLIDE_WIDTH - 16);
        item.element.y = clamp(item.y + dy, -item.element.h + 16, SLIDE_HEIGHT - 16);
      }
    } else {
      if (handle.includes("e")) element.w = Math.max(40, start.w + dx);
      if (handle.includes("s")) element.h = Math.max(30, start.h + dy);
      if (handle.includes("w")) {
        const width = Math.max(40, start.w - dx);
        element.x = start.x + (start.w - width);
        element.w = width;
      }
      if (handle.includes("n")) {
        const height = Math.max(30, start.h - dy);
        element.y = start.y + (start.h - height);
        element.h = height;
      }
    }
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (movingGroup.length > 1) syncCanvasElementBounds(movingGroup);
        else syncNodeBounds(node, element);
        renderProperties();
      });
    }
  };

  const stop = () => {
    removeEventListener("pointermove", updateFromPointer);
    removeEventListener("pointerup", stop);
    removeEventListener("pointercancel", stop);
    if (frame) cancelAnimationFrame(frame);
    if (movingGroup.length > 1) syncCanvasElementBounds(movingGroup);
    else syncNodeBounds(node, element);
    renderProperties();
    node.releasePointerCapture?.(event.pointerId);
    if (moved) {
      recordHistory();
      scheduleSave();
      drawBroadcastFrame();
    }
  };

  addEventListener("pointermove", updateFromPointer);
  addEventListener("pointerup", stop, { once: true });
  addEventListener("pointercancel", stop, { once: true });
}

function renderProperties(): void {
  const element = selected();
  $("#property-title").textContent = element
    ? element.type === "phone" ? "Mockup HP"
      : element.type === "image" ? "Gambar"
        : element.type === "canvas" ? "Canvas slide"
        : element.type === "canva" ? "Canva"
        : element.type === "shape" ? "Bentuk"
          : element.variant === "title" ? "Judul" : "Teks"
    : "Tidak ada pilihan";
  const ids = ["prop-x", "prop-y", "prop-w", "prop-h", "prop-text"];
  for (const id of ids) ($(`#${id}`) as HTMLInputElement | HTMLTextAreaElement).disabled = !element || !isEditableRole();
  $("#text-property").toggleAttribute("hidden", !(element?.type === "text" || element?.type === "shape"));
  if (!element) {
    for (const id of ids) ($(`#${id}`) as HTMLInputElement | HTMLTextAreaElement).value = "";
    return;
  }
  ($("#prop-x") as HTMLInputElement).value = String(Math.round(element.x));
  ($("#prop-y") as HTMLInputElement).value = String(Math.round(element.y));
  ($("#prop-w") as HTMLInputElement).value = String(Math.round(element.w));
  ($("#prop-h") as HTMLInputElement).value = String(Math.round(element.h));
  ($("#prop-text") as HTMLTextAreaElement).value = element.type === "text" || element.type === "shape" ? element.text || "" : "";
}

function updateProperties(): void {
  const element = selected();
  if (!element || !isEditableRole()) return;
  element.x = Number(($("#prop-x") as HTMLInputElement).value) || 0;
  element.y = Number(($("#prop-y") as HTMLInputElement).value) || 0;
  element.w = Math.max(20, Number(($("#prop-w") as HTMLInputElement).value) || 20);
  element.h = Math.max(20, Number(($("#prop-h") as HTMLInputElement).value) || 20);
  if (element.type === "text" || element.type === "shape") element.text = ($("#prop-text") as HTMLTextAreaElement).value;
  announceEditing(element);
  renderCanvas();
  scheduleSave();
}

function renderCounterAndNotes(): void {
  $("#slide-counter").textContent = `Slide ${currentSlide + 1} / ${deck.slides.length}`;
  const notes = $("#speaker-note") as HTMLInputElement;
  if (document.activeElement !== notes) notes.value = current().notes || "";
  notes.disabled = !isEditableRole();
}

function addText(variant: TextVariant): void {
  if (!isEditableRole()) return;
  const element: TextElement = { id: uid("el"), type: "text", variant, x: 90, y: 90 + current().elements.length * 12, w: variant === "title" ? 520 : 430, h: variant === "title" ? 74 : 70, text: variant === "title" ? "Judul slide" : "Tulis teks di sini" };
  current().elements.push(element);
  selectedElementId = element.id;
  recordHistory();
  renderAll();
  focusTextElement(element.id);
  scheduleSave();
}

function addPhone(): void {
  if (!isEditableRole()) return;
  const element: PhoneElement = { id: uid("el"), type: "phone", x: 650, y: 48, w: 220, h: 448, deviceSerial: null };
  current().elements.push(element);
  selectedElementId = element.id;
  recordHistory();
  renderAll();
  switchInspector("device");
  scheduleSave();
}

function addSlide(): void {
  if (!isEditableRole()) return;
  const slide: Slide = { id: uid("slide"), name: `Slide ${deck.slides.length + 1}`, notes: "", elements: [] };
  deck.slides.push(slide);
  currentSlide = deck.slides.length - 1;
  selectedElementId = null;
  recordHistory();
  renderAll();
  scheduleSave();
}

function deleteSelected(): void {
  if (!selectedElementId || !isEditableRole()) return;
  const element = selected();
  if (element?.type === "phone" && element.deviceSerial) stopMirror(element.deviceSerial);
  current().elements = current().elements.filter((item) => item.id !== selectedElementId);
  selectedElementId = null;
  recordHistory();
  renderAll();
  flushSave("Menghapus slide...");
}

function duplicateSlide(): void {
  if (!isEditableRole()) return;
  const duplicated = clone(current());
  duplicated.id = uid("slide");
  duplicated.name = `${current().name} salinan`;
  duplicated.elements.forEach((element) => { element.id = uid("el"); });
  deck.slides.splice(currentSlide + 1, 0, duplicated);
  currentSlide += 1;
  selectedElementId = null;
  recordHistory();
  renderAll();
  scheduleSave();
}

function deleteCurrentSlide(): void {
  if (!isEditableRole()) return;
  if (deck.slides.length === 1) { toast("Presentasi harus memiliki minimal satu slide."); return; }
  deck.slides.splice(currentSlide, 1);
  currentSlide = clamp(currentSlide, 0, deck.slides.length - 1);
  selectedElementId = null;
  recordHistory();
  renderAll();
  scheduleSave();
}

function duplicateSelected(): void {
  const element = selected();
  if (!element || !isEditableRole()) return;
  const copy = clone(element);
  copy.id = uid("el");
  copy.x = clamp(copy.x + 20, 0, SLIDE_WIDTH - 20);
  copy.y = clamp(copy.y + 20, 0, SLIDE_HEIGHT - 20);
  current().elements.push(copy);
  selectedElementId = copy.id;
  recordHistory();
  renderAll();
  scheduleSave();
}

function addShape(shape: ShapeElement["shape"] = "rect"): void {
  if (!isEditableRole()) return;
  const element: ShapeElement = {
    id: uid("el"),
    type: "shape",
    shape,
    x: 160,
    y: 140,
    w: shape === "line" ? 260 : 220,
    h: shape === "line" ? 0 : 110,
    fill: shape === "line" ? "transparent" : "#e8f0fe",
    stroke: "#1a73e8",
    text: "",
  };
  current().elements.push(element);
  selectedElementId = element.id;
  recordHistory();
  renderAll();
  scheduleSave();
}

function addTable(rows = 3, cols = 3): void {
  if (!isEditableRole()) return;
  rows = clamp(Math.round(rows), 1, 20);
  cols = clamp(Math.round(cols), 1, 12);
  const startX = 140;
  const startY = 116;
  const cellW = clamp(Math.floor(520 / cols), 52, 150);
  const cellH = 48;
  const tableId = uid("table");
  const cells: ShapeElement[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      cells.push({
        id: uid("el"),
        type: "shape",
        shape: "rect",
        x: startX + col * cellW,
        y: startY + row * cellH,
        w: cellW,
        h: cellH,
        fill: row === 0 ? "#edf2fa" : "#ffffff",
        stroke: "#5f6368",
        text: row === 0 ? `Header ${col + 1}` : "",
        fontSize: 16,
        color: "#202124",
        align: "center",
        tableId,
        tableRow: row,
        tableCol: col,
      });
    }
  }
  current().elements.push(...cells);
  selectedElementId = cells[0]?.id || null;
  recordHistory();
  renderAll();
  scheduleSave();
}

function promptAddTable(): void {
  const rawRows = prompt("Jumlah baris tabel", "3");
  if (rawRows === null) return;
  const rawCols = prompt("Jumlah kolom tabel", "3");
  if (rawCols === null) return;
  addTable(Number(rawRows) || 3, Number(rawCols) || 3);
}

function tableCellsForSelected(): ShapeElement[] {
  const element = selected();
  if (element?.type !== "shape" || !element.tableId) return [];
  return current().elements.filter((item): item is ShapeElement => item.type === "shape" && item.tableId === element.tableId);
}

function tableBounds(cells: ShapeElement[]): { rows: number; cols: number; cellW: number; cellH: number; x: number; y: number } {
  const rows = Math.max(0, ...cells.map((cell) => Number(cell.tableRow ?? 0))) + 1;
  const cols = Math.max(0, ...cells.map((cell) => Number(cell.tableCol ?? 0))) + 1;
  const first = cells[0];
  return { rows, cols, cellW: first?.w || 100, cellH: first?.h || 44, x: Math.min(...cells.map((cell) => cell.x)), y: Math.min(...cells.map((cell) => cell.y)) };
}

function rebuildTable(tableId: string, rows: number, cols: number, keep: ShapeElement[]): void {
  const bounds = tableBounds(keep);
  const byCell = new Map(keep.map((cell) => [`${cell.tableRow}:${cell.tableCol}`, cell]));
  const rebuilt: ShapeElement[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const existing = byCell.get(`${row}:${col}`);
      rebuilt.push(existing ? { ...existing, x: bounds.x + col * bounds.cellW, y: bounds.y + row * bounds.cellH, tableRow: row, tableCol: col } : {
        id: uid("el"),
        type: "shape",
        shape: "rect",
        x: bounds.x + col * bounds.cellW,
        y: bounds.y + row * bounds.cellH,
        w: bounds.cellW,
        h: bounds.cellH,
        fill: row === 0 ? "#edf2fa" : "#ffffff",
        stroke: "#5f6368",
        text: "",
        fontSize: 16,
        color: "#202124",
        align: "center",
        tableId,
        tableRow: row,
        tableCol: col,
      });
    }
  }
  current().elements = current().elements.filter((item) => !(item.type === "shape" && item.tableId === tableId));
  current().elements.push(...rebuilt);
  selectedElementId = rebuilt[0]?.id || null;
}

function editSelectedTable(mode: "row-after" | "row-delete" | "col-after" | "col-delete"): void {
  if (!isEditableRole()) return;
  const cells = tableCellsForSelected();
  const selectedCell = selected();
  if (!cells.length || selectedCell?.type !== "shape" || !selectedCell.tableId) { toast("Pilih salah satu sel tabel dahulu."); return; }
  const bounds = tableBounds(cells);
  let keep = cells.map((cell) => ({ ...cell }));
  if (mode === "row-after") {
    const after = Number(selectedCell.tableRow ?? 0);
    keep = keep.map((cell) => Number(cell.tableRow ?? 0) > after ? { ...cell, tableRow: Number(cell.tableRow) + 1 } : cell);
    rebuildTable(selectedCell.tableId, bounds.rows + 1, bounds.cols, keep);
  } else if (mode === "col-after") {
    const after = Number(selectedCell.tableCol ?? 0);
    keep = keep.map((cell) => Number(cell.tableCol ?? 0) > after ? { ...cell, tableCol: Number(cell.tableCol) + 1 } : cell);
    rebuildTable(selectedCell.tableId, bounds.rows, bounds.cols + 1, keep);
  } else if (mode === "row-delete") {
    if (bounds.rows <= 1) { toast("Tabel harus memiliki minimal satu baris."); return; }
    const row = Number(selectedCell.tableRow ?? 0);
    keep = keep.filter((cell) => Number(cell.tableRow ?? 0) !== row).map((cell) => Number(cell.tableRow ?? 0) > row ? { ...cell, tableRow: Number(cell.tableRow) - 1 } : cell);
    rebuildTable(selectedCell.tableId, bounds.rows - 1, bounds.cols, keep);
  } else {
    if (bounds.cols <= 1) { toast("Tabel harus memiliki minimal satu kolom."); return; }
    const col = Number(selectedCell.tableCol ?? 0);
    keep = keep.filter((cell) => Number(cell.tableCol ?? 0) !== col).map((cell) => Number(cell.tableCol ?? 0) > col ? { ...cell, tableCol: Number(cell.tableCol) - 1 } : cell);
    rebuildTable(selectedCell.tableId, bounds.rows, bounds.cols - 1, keep);
  }
  recordHistory();
  renderAll();
  scheduleSave();
}

function deleteSelectedTable(): void {
  if (!isEditableRole()) return;
  const cells = tableCellsForSelected();
  const tableId = cells[0]?.tableId;
  if (!tableId) { toast("Pilih salah satu sel tabel dahulu."); return; }
  current().elements = current().elements.filter((item) => !(item.type === "shape" && item.tableId === tableId));
  selectedElementId = null;
  recordHistory();
  renderAll();
  scheduleSave();
}

function addImageFromDataUrl(src: string, alt = "Gambar"): void {
  if (!isEditableRole()) return;
  const image = ensureDeckImage(src);
  const ratio = image.naturalWidth && image.naturalHeight ? image.naturalWidth / image.naturalHeight : 16 / 9;
  const width = Math.min(520, Math.max(180, ratio >= 1 ? 420 : 260));
  const height = Math.min(360, Math.max(120, width / ratio));
  const element: ImageElement = { id: uid("el"), type: "image", x: 180, y: 110, w: width, h: height, src, alt };
  current().elements.push(element);
  selectedElementId = element.id;
  recordHistory();
  renderAll();
  scheduleSave();
}

async function addImageFile(file: File): Promise<void> {
  if (!file.type.startsWith("image/")) { toast("File gambar tidak dikenali."); return; }
  const src = await readFileAsDataUrl(file);
  if (pendingReplaceImageElementId) {
    const element = elementById(activeCommentSlide, pendingReplaceImageElementId);
    pendingReplaceImageElementId = "";
    if (element?.type === "image") {
      element.src = src;
      element.alt = file.name;
      recordHistory();
      renderAll();
      scheduleSave("Mengganti gambar...");
      toast("Gambar elemen diganti.");
      return;
    }
  }
  addImageFromDataUrl(src, file.name);
}

async function addCanvaLink(url: string): Promise<void> {
  if (!isEditableRole()) return;
  await importCanvaByLink(url);
}

function promptCanvaImport(): void {
  const value = prompt("Tempel link Canva publik", "");
  if (value === null) return;
  void addCanvaLink(value).catch((error) => {
    setSaveState("error");
    toast(`Gagal import Canva: ${friendlyError(error)}`);
  });
}

function arrangeSelected(mode: "front" | "back" | "forward" | "backward"): void {
  const element = selected();
  if (!element || !isEditableRole()) return;
  const elements = current().elements;
  const index = elements.findIndex((item) => item.id === element.id);
  if (index < 0) return;
  elements.splice(index, 1);
  if (mode === "front") elements.push(element);
  else if (mode === "back") elements.unshift(element);
  else if (mode === "forward") elements.splice(Math.min(elements.length, index + 1), 0, element);
  else elements.splice(Math.max(0, index - 1), 0, element);
  recordHistory();
  renderAll();
  scheduleSave();
}

function centerSelected(axis: "horizontal" | "vertical" | "both"): void {
  const element = selected();
  if (!element || !isEditableRole()) return;
  if (axis === "horizontal" || axis === "both") element.x = (SLIDE_WIDTH - element.w) / 2;
  if (axis === "vertical" || axis === "both") element.y = (SLIDE_HEIGHT - element.h) / 2;
  recordHistory();
  renderAll();
  scheduleSave();
}

function applySelectedTextFormat(format: "bold" | "italic" | "underline" | "title" | "body" | "color", value?: string): void {
  const element = selected();
  if (!element || !isEditableRole()) return;
  if (element.type !== "text" && element.type !== "shape") { toast("Pilih teks atau bentuk berisi teks dahulu."); return; }
  if (format === "bold") element.bold = !element.bold;
  if (format === "italic") element.italic = !element.italic;
  if (format === "underline") element.underline = !element.underline;
  if (format === "title" && element.type === "text") element.variant = "title";
  if (format === "body" && element.type === "text") element.variant = "body";
  if (format === "color" && value) element.color = value;
  recordHistory();
  renderAll();
  scheduleSave();
}

function applySelectedAnimation(animation: ElementAnimation): void {
  const element = selected();
  if (!element || !isEditableRole()) return;
  element.animation = animation || "";
  recordHistory();
  renderAll();
  scheduleSave();
}

function applySlideTransition(transition: string): void {
  if (!isEditableRole()) return;
  current().transition = transition;
  recordHistory();
  renderAll();
  scheduleSave();
}

function applySelectedFontSize(delta: number): void {
  const element = selected();
  if (!element || !isEditableRole() || (element.type !== "text" && element.type !== "shape")) return;
  const currentSize = element.fontSize || (element.type === "text" && element.variant === "title" ? 36 : 20);
  element.fontSize = clamp(currentSize + delta, 6, 160);
  recordHistory();
  renderAll();
  scheduleSave();
}

function applySelectedTextAlign(align: "left" | "center" | "right"): void {
  const element = selected();
  if (!element || !isEditableRole() || (element.type !== "text" && element.type !== "shape")) return;
  element.align = align;
  recordHistory();
  renderAll();
  scheduleSave();
}

function applySelectedShapeColor(kind: "fill" | "stroke", color: string): void {
  const element = selected();
  if (!element || !isEditableRole() || element.type !== "shape") return;
  element[kind] = color;
  recordHistory();
  renderAll();
  scheduleSave();
}

function setSlideBackground(color = "#ffffff"): void {
  if (!isEditableRole()) return;
  const slide = current();
  const existing = slide.elements.find((item): item is ShapeElement =>
    item.type === "shape" && item.shape === "rect" && item.x <= 0 && item.y <= 0 && item.w >= SLIDE_WIDTH && item.h >= SLIDE_HEIGHT);
  if (existing) {
    existing.fill = color;
    existing.stroke = color;
  } else {
    slide.elements.unshift({ id: uid("el"), type: "shape", shape: "rect", x: 0, y: 0, w: SLIDE_WIDTH, h: SLIDE_HEIGHT, fill: color, stroke: color });
  }
  selectedElementId = null;
  recordHistory();
  renderAll();
  scheduleSave();
}

function promptSlideBackground(): void {
  const color = prompt("Warna background slide (#RRGGBB)", "#ffffff");
  if (!color) return;
  setSlideBackground(cleanColor(color, "#ffffff"));
}

function applyTheme(kind: "light" | "dark" | "blue" | "green" | "gold"): void {
  if (!isEditableRole()) return;
  const palettes: Record<"light" | "dark" | "blue" | "green" | "gold", { background: string; accent: string; text: string }> = {
    light: { background: "#ffffff", accent: "#fbbc04", text: "#202124" },
    dark: { background: "#202124", accent: "#8ab4f8", text: "#ffffff" },
    blue: { background: "#e8f0fe", accent: "#1a73e8", text: "#174ea6" },
    green: { background: "#e6f4ea", accent: "#188038", text: "#137333" },
    gold: { background: "#fff7e6", accent: "#f9ab00", text: "#3c4043" },
  };
  const palette = palettes[kind];
  setSlideBackground(palette.background);
  for (const element of current().elements) {
    if (element.type === "text") element.color = palette.text;
    if (element.type === "shape" && element.y > SLIDE_HEIGHT - 70) {
      element.fill = palette.accent;
      element.stroke = palette.accent;
    }
  }
  recordHistory();
  renderAll();
  scheduleSave();
}

function resetSlideLayout(): void {
  if (!isEditableRole()) return;
  current().elements = [
    { id: uid("el"), type: "text", variant: "title", x: 86, y: 178, w: 788, h: 78, text: "Klik - tambahkan judul", fontSize: 44, align: "center", color: "#202124" },
    { id: uid("el"), type: "text", variant: "body", x: 128, y: 282, w: 704, h: 54, text: "Klik - tambahkan subjudul", fontSize: 26, align: "center", color: "#5f6368" },
  ];
  selectedElementId = null;
  recordHistory();
  renderAll();
  scheduleSave();
}

function addSlideNumber(): void {
  if (!isEditableRole()) return;
  const element: TextElement = { id: uid("el"), type: "text", variant: "body", x: 856, y: 498, w: 70, h: 26, text: String(currentSlide + 1), fontSize: 14, color: "#5f6368", align: "right" };
  current().elements.push(element);
  selectedElementId = element.id;
  recordHistory();
  renderAll();
  scheduleSave();
}

function addHeaderFooter(): void {
  if (!isEditableRole()) return;
  const footer: TextElement = { id: uid("el"), type: "text", variant: "body", x: 38, y: 502, w: 420, h: 24, text: deck.title || "ITS Presentasi", fontSize: 12, color: "#5f6368" };
  current().elements.push(footer);
  selectedElementId = footer.id;
  recordHistory();
  renderAll();
  scheduleSave();
}

function addCommentToNotes(): void {
  if (!isEditableRole()) return;
  const comment = prompt("Komentar slide", "");
  if (!comment) return;
  current().notes = `${current().notes ? `${current().notes}\n` : ""}Komentar: ${comment}`;
  recordHistory();
  renderCounterAndNotes();
  scheduleSave();
}

function downloadDeckJson(): void {
  const blob = new Blob([JSON.stringify(serializableDeck(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${(deck.title || "presentasi").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "presentasi"}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function downloadDeckPptx(): Promise<void> {
  setSaveState("saving", "Membuat file PPTX...");
  try {
    const zip = new JSZip();
    const title = deck.title || "ITS Presentasi";
    zip.file("[Content_Types].xml", pptxContentTypes(deck.slides.length));
    zip.folder("_rels")?.file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);
    zip.folder("docProps")?.file("core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeHtml(title)}</dc:title>
  <dc:creator>ITS Presentasi</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`);
    zip.folder("docProps")?.file("app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>ITS Presentasi</Application><Slides>${deck.slides.length}</Slides></Properties>`);
    const ppt = zip.folder("ppt");
    const slidesFolder = ppt?.folder("slides");
    const slideRelsFolder = slidesFolder?.folder("_rels");
    const mediaFolder = ppt?.folder("media");
    ppt?.file("presentation.xml", pptxPresentationXml(deck.slides.length));
    ppt?.folder("_rels")?.file("presentation.xml.rels", pptxPresentationRels(deck.slides.length));
    ppt?.folder("theme")?.file("theme1.xml", pptxThemeXml());
    ppt?.folder("slideMasters")?.file("slideMaster1.xml", pptxSlideMasterXml());
    ppt?.folder("slideMasters")?.folder("_rels")?.file("slideMaster1.xml.rels", pptxSlideMasterRelsXml());
    ppt?.folder("slideLayouts")?.file("slideLayout1.xml", pptxSlideLayoutXml());
    ppt?.folder("slideLayouts")?.folder("_rels")?.file("slideLayout1.xml.rels", pptxSlideLayoutRelsXml());
    for (const [index, slide] of deck.slides.entries()) {
      await waitForSlideImages(slide);
      const canvas = document.createElement("canvas");
      canvas.width = SLIDE_WIDTH * 2;
      canvas.height = SLIDE_HEIGHT * 2;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas export PPTX tidak tersedia.");
      drawSlideToContext(context, slide, 2);
      const blob = await canvasToBlob(canvas, "image/png");
      mediaFolder?.file(`slide${index + 1}.png`, await blob.arrayBuffer());
      slidesFolder?.file(`slide${index + 1}.xml`, pptxSlideImageXml(index + 1));
      slideRelsFolder?.file(`slide${index + 1}.xml.rels`, pptxSlideRelsXml(index + 1));
    }
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeFilename(title)}.pptx`;
    link.click();
    URL.revokeObjectURL(url);
    setSaveState("saved");
    toast("PPTX berhasil dibuat.");
  } catch (error) {
    setSaveState("error", "Export PPTX gagal");
    toast(`Export PPTX gagal: ${friendlyError(error)}`);
  }
}

function pptxContentTypes(count: number): string {
  const slides = Array.from({ length: count }, (_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  const media = Array.from({ length: count }, (_, index) => `<Override PartName="/ppt/media/slide${index + 1}.png" ContentType="image/png"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${media}
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  ${slides}
</Types>`;
}

function pptxPresentationXml(count: number): string {
  const ids = Array.from({ length: count }, (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId${count + 1}"/></p:sldMasterIdLst>
  <p:sldIdLst>${ids}</p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;
}

function pptxPresentationRels(count: number): string {
  const slides = Array.from({ length: count }, (_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${slides}
  <Relationship Id="rId${count + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  <Relationship Id="rId${count + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
</Relationships>`;
}

function pptxSlideImageXml(index: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    <p:pic><p:nvPicPr><p:cNvPr id="${10 + index}" name="Slide ${index}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>
  </p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function pptxSlideRelsXml(index: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/slide${index}.png"/>
</Relationships>`;
}

function pptxThemeXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="ITS Presentasi"><a:themeElements><a:clrScheme name="ITS"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2><a:accent1><a:srgbClr val="1A73E8"/></a:accent1><a:accent2><a:srgbClr val="34A853"/></a:accent2><a:accent3><a:srgbClr val="FBBC04"/></a:accent3><a:accent4><a:srgbClr val="EA4335"/></a:accent4><a:accent5><a:srgbClr val="7C3AED"/></a:accent5><a:accent6><a:srgbClr val="06B6D4"/></a:accent6><a:hlink><a:srgbClr val="1A73E8"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme><a:fontScheme name="ITS"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="ITS"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
}

function pptxSlideMasterXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles/></p:sldMaster>`;
}

function pptxSlideMasterRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`;
}

function pptxSlideLayoutXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

function pptxSlideLayoutRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;
}

function downloadCurrentSlidePng(): void {
  drawBroadcastFrame();
  const canvas = $("#broadcast-canvas") as HTMLCanvasElement;
  const title = (deck.title || "presentasi").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "presentasi";
  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = `${title}-slide-${currentSlide + 1}.png`;
  link.click();
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Gagal membaca file."));
    reader.readAsDataURL(file);
  });
}

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, "application/xml");
}

async function readZipXml(zip: JSZip, path: string): Promise<Document | null> {
  const file = zip.file(path);
  if (!file) return null;
  return parseXml(await file.async("text"));
}

function descendants(root: ParentNode, localName: string): Element[] {
  return Array.from(root.querySelectorAll("*")).filter((element) => element.localName === localName);
}

function firstDescendant(root: ParentNode, localName: string): Element | null {
  return descendants(root, localName)[0] || null;
}

function childElements(root: Element | null, localName: string): Element[] {
  if (!root) return [];
  return Array.from(root.children).filter((element) => element.localName === localName);
}

function attr(element: Element | null, name: string): string {
  if (!element) return "";
  return element.getAttribute(name) || element.getAttribute(`r:${name}`) || element.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", name) || "";
}

function dirName(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

function fileName(path: string): string {
  return path.split("/").pop() || path;
}

function resolveZipPath(fromDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const stack: string[] = [];
  for (const part of `${fromDir}/${target}`.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function relsPathFor(path: string): string {
  return `${dirName(path)}/_rels/${fileName(path)}.rels`;
}

async function readRelationships(zip: JSZip, path: string): Promise<Map<string, PptxRelationship>> {
  const doc = await readZipXml(zip, path);
  const map = new Map<string, PptxRelationship>();
  if (!doc) return map;
  for (const rel of descendants(doc, "Relationship")) {
    const id = rel.getAttribute("Id") || "";
    if (!id) continue;
    map.set(id, { id, target: rel.getAttribute("Target") || "", type: rel.getAttribute("Type") || "" });
  }
  return map;
}

function pptxColor(scope: ParentNode | null, fallback = "", directFillOnly = false): string {
  if (!scope) return fallback;
  const directNoFill = scope instanceof Element && childElements(scope, "noFill").length > 0;
  if (directNoFill) return fallback;
  const solidFill = directFillOnly && scope instanceof Element ? childElements(scope, "solidFill")[0] : firstDescendant(scope, "solidFill");
  if (!solidFill) return fallback;
  const srgb = firstDescendant(solidFill, "srgbClr")?.getAttribute("val");
  if (srgb && /^[0-9a-f]{6}$/i.test(srgb)) return `#${srgb}`;
  const scheme = firstDescendant(solidFill, "schemeClr")?.getAttribute("val") || "";
  const schemeMap: Record<string, string> = {
    accent1: "#4472c4",
    accent2: "#ed7d31",
    accent3: "#a5a5a5",
    accent4: "#ffc000",
    accent5: "#5b9bd5",
    accent6: "#70ad47",
    tx1: "#202124",
    tx2: "#4a4f55",
    bg1: "#ffffff",
    bg2: "#f8f9fa",
  };
  return schemeMap[scheme] || fallback;
}

function normalizePptxAnimation(raw: string): ElementAnimation {
  const value = raw.toLowerCase();
  if (value.includes("fade")) return "fade";
  if (value.includes("fly") || value.includes("float")) return "fly";
  if (value.includes("wipe")) return "wipe";
  if (value.includes("zoom") || value.includes("grow")) return "zoom";
  if (value.includes("motion")) return "motion";
  return value ? "appear" : "";
}

function collectAnimationHints(slideDoc: Document): Map<string, ElementAnimation> {
  const hints = new Map<string, ElementAnimation>();
  for (const target of descendants(slideDoc, "spTgt")) {
    const shapeId = target.getAttribute("spid") || "";
    if (!shapeId) continue;
    let cursor: Element | null = target;
    let hint: ElementAnimation = "appear";
    while (cursor) {
      if (["animEffect", "animMotion", "animScale"].includes(cursor.localName)) {
        hint = normalizePptxAnimation(`${cursor.localName} ${cursor.getAttribute("transition") || ""} ${cursor.getAttribute("filter") || ""}`);
        break;
      }
      cursor = cursor.parentElement;
    }
    hints.set(shapeId, hint);
  }
  return hints;
}

function pptxTransition(slideDoc: Document): string {
  const transition = firstDescendant(slideDoc, "transition");
  if (!transition) return "";
  const child = Array.from(transition.children)[0];
  return (child?.localName || transition.getAttribute("spd") || "transition").slice(0, 60);
}

function pptxSlideBackground(slideDoc: Document): ShapeElement | null {
  const bgPr = firstDescendant(slideDoc, "bgPr");
  const color = pptxColor(bgPr);
  if (!color) return null;
  return { id: uid("el"), type: "shape", shape: "rect", x: 0, y: 0, w: SLIDE_WIDTH, h: SLIDE_HEIGHT, fill: color, stroke: color };
}

function pptxShapeId(scope: ParentNode): string {
  return firstDescendant(scope, "cNvPr")?.getAttribute("id") || "";
}

function emuToPx(value: number, totalEmu: number, totalPx: number): number {
  return totalEmu > 0 ? value / totalEmu * totalPx : value / PPTX_EMU_PER_INCH * 72;
}

function emuToPoints(value: string | null, fallback: number): number {
  if (value === null || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric / PPTX_EMU_PER_INCH * 72 : fallback;
}

function pptxBounds(scope: ParentNode, slideSize: { cx: number; cy: number }, fallbackIndex: number): { x: number; y: number; w: number; h: number; hasBounds: boolean } {
  const xfrm = firstDescendant(scope, "xfrm");
  const off = firstDescendant(xfrm || scope, "off");
  const ext = firstDescendant(xfrm || scope, "ext");
  const hasBounds = Boolean(off && ext);
  if (!hasBounds) {
    return { x: 70, y: 72 + fallbackIndex * 82, w: 760, h: 70, hasBounds: false };
  }
  const x = emuToPx(Number(off?.getAttribute("x") || 0), slideSize.cx, SLIDE_WIDTH);
  const y = emuToPx(Number(off?.getAttribute("y") || 0), slideSize.cy, SLIDE_HEIGHT);
  const w = emuToPx(Number(ext?.getAttribute("cx") || 1000000), slideSize.cx, SLIDE_WIDTH);
  const h = emuToPx(Number(ext?.getAttribute("cy") || 600000), slideSize.cy, SLIDE_HEIGHT);
  return { x, y, w: Math.max(8, w), h: Math.max(8, h), hasBounds };
}

function extractPptxText(scope: ParentNode): string {
  const txBody = firstDescendant(scope, "txBody");
  if (!txBody) return "";
  const paragraphs = childElements(txBody, "p").map((paragraph) => {
    const chunks: string[] = [];
    for (const child of Array.from(paragraph.children)) {
      if (child.localName === "br") chunks.push("\n");
      if (child.localName === "r" || child.localName === "fld") chunks.push(descendants(child, "t").map((item) => item.textContent || "").join(""));
    }
    return chunks.join("").replace(/\u00a0/g, " ");
  });
  return paragraphs.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function pptxTextInsets(txBody: Element | null): Pick<TextElement, "insetLeft" | "insetRight" | "insetTop" | "insetBottom"> {
  const bodyPr = txBody ? firstDescendant(txBody, "bodyPr") : null;
  return {
    insetLeft: emuToPoints(bodyPr?.getAttribute("lIns") ?? null, 7.2),
    insetRight: emuToPoints(bodyPr?.getAttribute("rIns") ?? null, 7.2),
    insetTop: emuToPoints(bodyPr?.getAttribute("tIns") ?? null, 3.6),
    insetBottom: emuToPoints(bodyPr?.getAttribute("bIns") ?? null, 3.6),
  };
}

function pptxLineHeight(pPr: Element | null, fontSize: number): number | undefined {
  if (!pPr) return undefined;
  const lnSpc = firstDescendant(pPr, "lnSpc");
  if (!lnSpc) return undefined;
  const pct = firstDescendant(lnSpc, "spcPct")?.getAttribute("val");
  if (pct) return clamp(Number(pct) / 100000, 0.7, 2.4);
  const pts = Number(firstDescendant(lnSpc, "spcPts")?.getAttribute("val") || 0) / 100;
  if (pts && fontSize) return clamp(pts / fontSize, 0.7, 2.4);
  return undefined;
}

function pptxFontSizes(txBody: ParentNode): number[] {
  return descendants(txBody, "rPr")
    .concat(descendants(txBody, "defRPr"), descendants(txBody, "endParaRPr"))
    .map((item) => Number(item.getAttribute("sz") || 0) / 100)
    .filter((value) => Number.isFinite(value) && value > 0);
}

function extractPptxTextStyle(scope: ParentNode): PptxRunStyle {
  const txBody = firstDescendant(scope, "txBody") || scope;
  const pPr = firstDescendant(txBody, "pPr");
  const rPr = firstDescendant(txBody, "rPr") || firstDescendant(txBody, "defRPr");
  const latin = firstDescendant(rPr || txBody, "latin");
  const sizes = pptxFontSizes(txBody);
  const fontSize = sizes.length ? Math.max(...sizes) : Number(rPr?.getAttribute("sz") || 0) / 100;
  const style: PptxRunStyle = {};
  const fontFamily = cleanFontFamily(latin?.getAttribute("typeface"));
  const color = pptxColor(rPr || txBody);
  if (fontFamily) style.fontFamily = fontFamily;
  if (fontSize) style.fontSize = clamp(fontSize * PPTX_FONT_SCALE, 7, 128);
  if (color) style.color = color;
  if (["1", "true"].includes((rPr?.getAttribute("b") || "").toLowerCase())) style.bold = true;
  if (["1", "true"].includes((rPr?.getAttribute("i") || "").toLowerCase())) style.italic = true;
  const underline = (rPr?.getAttribute("u") || "").toLowerCase();
  if (underline && underline !== "none") style.underline = true;
  const align = (pPr?.getAttribute("algn") || "").toLowerCase();
  if (align === "ctr") style.align = "center";
  if (align === "r") style.align = "right";
  Object.assign(style, pptxTextInsets(txBody instanceof Element ? txBody : null));
  const lineHeight = pptxLineHeight(pPr, style.fontSize || fontSize || 0);
  if (lineHeight) style.lineHeight = lineHeight;
  return style;
}

function pptxShapeKind(scope: ParentNode): ShapeElement["shape"] {
  const preset = firstDescendant(scope, "prstGeom")?.getAttribute("prst") || "";
  if (preset.includes("ellipse")) return "ellipse";
  if (preset.includes("line")) return "line";
  return "rect";
}

function isLightPptxFill(color: string): boolean {
  return ["#ffffff", "#f8f9fa", "transparent", ""].includes(color.toLowerCase());
}

function isNeutralPptxStroke(color: string): boolean {
  return !color || ["transparent", "#dadce0", "#d9d9d9", "#c9c9c9", "#bfbfbf"].includes(color.toLowerCase());
}

function isPptxEmptyPlaceholderShape(fill: string, stroke: string, bounds: { w: number; h: number }): boolean {
  return isLightPptxFill(fill) && isNeutralPptxStroke(stroke) && bounds.w < SLIDE_WIDTH * 0.42 && bounds.h < SLIDE_HEIGHT * 0.16;
}

function pptxDrawableNodes(root: Element): Element[] {
  const nodes: Element[] = [];
  const walk = (scope: Element) => {
    for (const child of Array.from(scope.children)) {
      if (["sp", "pic", "cxnSp", "graphicFrame"].includes(child.localName)) nodes.push(child);
      else if (child.localName === "grpSp") walk(child);
    }
  };
  walk(root);
  return nodes;
}

function imageMimeFromPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() || "";
  return IMAGE_MIME_BY_EXTENSION[extension] || "image/png";
}

async function deckFromPptx(file: File): Promise<Deck> {
  const zip = await JSZip.loadAsync(file);
  const presentation = await readZipXml(zip, "ppt/presentation.xml");
  if (!presentation) throw new Error("PPTX tidak memiliki ppt/presentation.xml.");
  const size = firstDescendant(presentation, "sldSz");
  const slideSize = {
    cx: Number(size?.getAttribute("cx") || DEFAULT_PPTX_SLIDE.cx),
    cy: Number(size?.getAttribute("cy") || DEFAULT_PPTX_SLIDE.cy),
  };
  const presentationRels = await readRelationships(zip, "ppt/_rels/presentation.xml.rels");
  const orderedSlides = descendants(presentation, "sldId")
    .map((slideId) => presentationRels.get(attr(slideId, "id"))?.target || "")
    .filter(Boolean)
    .map((target) => resolveZipPath("ppt", target));
  const fallbackSlides = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((a, b) => Number(a.match(/slide(\d+)/i)?.[1] || 0) - Number(b.match(/slide(\d+)/i)?.[1] || 0));
  const slidePaths = orderedSlides.length ? orderedSlides : fallbackSlides;
  if (!slidePaths.length) throw new Error("Tidak ada slide yang bisa dibaca dari PPTX.");

  const slides: Slide[] = [];
  for (const [slideIndex, slidePath] of slidePaths.entries()) {
    const slideDoc = await readZipXml(zip, slidePath);
    if (!slideDoc) continue;
    const rels = await readRelationships(zip, relsPathFor(slidePath));
    const animations = collectAnimationHints(slideDoc);
    const elements: SlideElement[] = [];
    const background = pptxSlideBackground(slideDoc);
    if (background) elements.push(background);

    const spTree = firstDescendant(slideDoc, "spTree") || slideDoc.documentElement;
    const drawableNodes = pptxDrawableNodes(spTree);
    for (const drawable of drawableNodes) {
      if (drawable.localName === "sp" || drawable.localName === "cxnSp") {
        const text = extractPptxText(drawable);
        const bounds = pptxBounds(drawable, slideSize, elements.length);
        const style = extractPptxTextStyle(drawable);
        const animation = animations.get(pptxShapeId(drawable));
        const spPr = firstDescendant(drawable, "spPr") || drawable;
        if (text) {
          const variant: TextVariant = (style.fontSize || 0) >= 28 || elements.filter((item) => item.type === "text").length === 0 ? "title" : "body";
          const fontSize = style.fontSize || (variant === "title" ? 36 : 20);
          const minimumHeight = fontSize * (style.lineHeight || 1.08) + (style.insetTop ?? 3.6) + (style.insetBottom ?? 3.6);
          elements.push({
            id: uid("el"),
            type: "text",
            variant,
            x: bounds.x,
            y: bounds.y,
            w: bounds.w,
            h: clamp(Math.max(bounds.h, minimumHeight), 8, SLIDE_HEIGHT - bounds.y),
            text,
            ...style,
            animation,
          });
        } else {
          const fill = pptxColor(spPr, "", true);
          const stroke = pptxColor(firstDescendant(spPr, "ln"));
          if (isPptxEmptyPlaceholderShape(fill || "transparent", stroke || "transparent", bounds)) continue;
          if (bounds.hasBounds && (fill || stroke)) {
            elements.push({
              id: uid("el"),
              type: "shape",
              shape: pptxShapeKind(spPr),
              x: bounds.x,
              y: bounds.y,
              w: bounds.w,
              h: bounds.h,
              fill: fill || "transparent",
              stroke: stroke || "transparent",
              animation,
            });
          }
        }
      } else if (drawable.localName === "pic") {
        const bounds = pptxBounds(drawable, slideSize, elements.length);
        const blip = firstDescendant(drawable, "blip");
        const rel = rels.get(attr(blip, "embed"));
        if (!rel?.target) continue;
        const mediaPath = resolveZipPath(dirName(slidePath), rel.target);
        const media = zip.file(mediaPath);
        if (!media) continue;
        const base64 = await media.async("base64");
        const cNvPr = firstDescendant(drawable, "cNvPr");
        elements.push({
          id: uid("el"),
          type: "image",
          x: bounds.x,
          y: bounds.y,
          w: bounds.w,
          h: bounds.h,
          src: `data:${imageMimeFromPath(mediaPath)};base64,${base64}`,
          alt: cNvPr?.getAttribute("descr") || cNvPr?.getAttribute("name") || fileName(mediaPath),
          animation: animations.get(pptxShapeId(drawable)),
        });
      }
    }

    slides.push({
      id: uid("slide"),
      name: `Slide ${slideIndex + 1}`,
      notes: "",
      section: slideIndex === 0 ? "Intro" : "",
      transition: pptxTransition(slideDoc),
      elements,
    });
  }
  return sanitizeDeck({ title: file.name.replace(/\.(pptx|ppt)$/i, "") || "Presentasi impor", slides });
}

async function importPptxFile(file: File): Promise<void> {
  if (!isEditableRole()) return;

  // Validasi format sama seperti sebelumnya
  if (/\.ppt$/i.test(file.name) && !/\.pptx$/i.test(file.name)) {
    toast("Format .ppt lama belum bisa dibaca langsung di browser. Simpan ulang sebagai .pptx lalu drop lagi.");
    return;
  }
  if (!/\.pptx$/i.test(file.name)) {
    toast("Drop file .pptx untuk mengganti presentasi.");
    return;
  }

  setSaveState("saving", "Mengimpor PPTX...");

  try {
    deckImages.clear();

    // STEP 1: Parse PPTX langsung di browser.
    const rawDeck = await deckFromPptx(file);

    // STEP 2: Jalankan pipeline AI lokal/best-effort.
    // Tidak ada API key, endpoint berbayar, atau batas inference server.
    // OCR model-based dilewati sementara bila aset model lokal belum siap,
    // sehingga import PPTX tetap cepat dan stabil.

    setSaveState("saving", "AI memeriksa layout...");

    const { deck: enhancedDeck, stats } = await runPptAiPipeline(rawDeck, {
      // Callback progress tampil di UI save state.
      onProgress: (percent, message) => {
        setSaveState("saving", `${message} (${percent}%)`);
      },

      enableOcr: true,

      enableLayoutFix: true,   // PP-DocLayoutV3: perbaiki posisi elemen yang berantakan
      enableTypoFix: true,
      enableAcademic: true,
      language: "id",
    });

    // STEP 3: Terapkan hasil ke deck.
    setSaveState("saving", "Merender slide menjadi canvas HD...");
    deck = await rasterizeDeckForImport(enhancedDeck);
    currentSlide = 0;
    selectedElementId = null;
    recordHistory();
    renderAll();
    scheduleSave("Menyimpan hasil impor + AI...");

    // Laporan ringkas
    const msg = [
      `${deck.slides.length} slide canvas HD diimpor`,
      stats.layoutFixed > 0 ? `${stats.layoutFixed} layout diperbaiki` : "",
      stats.academicImproved > 0 ? `${stats.academicImproved} slide ditingkatkan AI` : "",
      stats.typosFixed > 0 ? `${stats.typosFixed} typo diperbaiki` : "",
      "AI lokal aktif",
      `(${Math.round(stats.durationMs / 1000)}s)`,
    ].filter(Boolean).join(" · ");

    toast(msg);

  } catch (error) {
    console.error(error);
    setSaveState("error", "Import gagal");
    toast(`Import PPTX gagal: ${friendlyError(error as Error)}`);
  }
}

async function importPdfFile(file: File): Promise<void> {
  if (!isEditableRole()) return;
  setSaveState("saving", "Membaca PDF…");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await getDocument({ data: bytes }).promise;
    const slides: Slide[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      setSaveState("saving", `Merender PDF ${pageNumber}/${pdf.numPages}…`);
      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2.2, 1600 / Math.max(1, base.width));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas PDF tidak tersedia.");
      await page.render({ canvasContext: context, viewport }).promise;
      const ratio = Math.min(SLIDE_WIDTH / canvas.width, SLIDE_HEIGHT / canvas.height);
      const width = canvas.width * ratio; const height = canvas.height * ratio;
      slides.push({
        id: uid("slide"), name: `Slide ${pageNumber}`, notes: `Diimpor dari ${file.name} · halaman ${pageNumber}`,
        section: pageNumber === 1 ? "Intro" : "", transition: ["fade", "push", "wipe"][pageNumber % 3],
        elements: [{ id: uid("el"), type: "image", x: (SLIDE_WIDTH - width) / 2, y: (SLIDE_HEIGHT - height) / 2, w: width, h: height, src: canvas.toDataURL("image/jpeg", .9), alt: `${file.name}, halaman ${pageNumber}`, animation: "fade" }],
      });
      page.cleanup();
    }
    deckImages.clear(); deck = sanitizeDeck({ title: file.name.replace(/\.pdf$/i, "") || "Presentasi PDF", slides });
    currentSlide = 0; selectedElementId = null; recordHistory(); renderAll(); scheduleSave("Menyimpan presentasi PDF…");
    toast(`${slides.length} halaman PDF diimpor sebagai slide HD dengan transisi.`);
  } catch (error) {
    console.error(error); setSaveState("error", "Import PDF gagal"); toast(`Import PDF gagal: ${friendlyError(error)}`);
  }
}

async function importPresentationFile(file: File): Promise<void> {
  if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") return importPdfFile(file);
  return importPptxFile(file);
}

async function runAiImproveCurrentDeck(): Promise<void> {
  if (!isEditableRole()) return;
  setSaveState("saving", "AI memperbaiki presentasi...");
  try {
    const { deck: improved, stats } = await runPptAiPipeline(deck, {
      onProgress: (pct, msg) => setSaveState("saving", `${msg} (${pct}%)`),
      enableLayoutFix: false, // Sudah di browser, skip layout detection
      enableOcr: false,
      enableTypoFix: true,
      enableAcademic: true,
      language: "id",
    });
    deck = improved;
    recordHistory();
    renderAll();
    scheduleSave("Menyimpan hasil AI improve...");
    toast(`AI selesai: ${stats.academicImproved} slide diperbaiki dalam ${Math.round(stats.durationMs / 1000)}s`);
  } catch (error) {
    setSaveState("error", "AI improve gagal");
    toast(`AI improve gagal: ${friendlyError(error as Error)}`);
  }
}

function openPptxPicker(): void {
  ($("#pptx-input") as HTMLInputElement).click();
}

function openImagePicker(): void {
  ($("#image-input") as HTMLInputElement).click();
}

function toggleWorkspaceGrid(): void {
  $("#workspace").classList.toggle("grid-hidden");
}

function toggleSpeakerNotes(): void {
  showSpeakerNotes = !showSpeakerNotes;
  $("#editor-app").classList.toggle("notes-hidden", !showSpeakerNotes);
}

function menuItems(menu: string): MenuItem[] {
  const hasSelection = () => Boolean(selected());
  const editable = () => !isEditableRole();
  const tableDisabled = () => !tableCellsForSelected().length || !isEditableRole();
  const animationItems: MenuItem[] = [
    { label: "Tanpa animasi", action: () => applySelectedAnimation("") },
    { label: "Appear", action: () => applySelectedAnimation("appear") },
    { label: "Fade", action: () => applySelectedAnimation("fade") },
    { label: "Fly In", action: () => applySelectedAnimation("fly") },
    { label: "Wipe", action: () => applySelectedAnimation("wipe") },
    { label: "Zoom", action: () => applySelectedAnimation("zoom") },
    { label: "Motion", action: () => applySelectedAnimation("motion") },
  ];
  const transitionItems: MenuItem[] = [
    { label: "None", action: () => applySlideTransition("") },
    { label: "Fade", action: () => applySlideTransition("fade") },
    { label: "Push", action: () => applySlideTransition("push") },
    { label: "Wipe", action: () => applySlideTransition("wipe") },
    { label: "Zoom", action: () => applySlideTransition("zoom") },
  ];
  return {
    file: [
      { label: "Baru", shortcut: "Ctrl+Alt+N", action: () => void createProject().catch((error) => toast(friendlyError(error))) },
      { label: "Buka", shortcut: "Ctrl+O", action: () => { location.href = homeUrl(); } },
      { label: "Impor PPTX", action: openPptxPicker },
      { label: "Import Canva by link", disabled: editable, action: promptCanvaImport },
      { label: "Perbarui Canva", disabled: () => deck.source?.type !== "canva" || !isWritableOwner(), action: () => void refreshCanvaSource(false) },
      { separator: true },
      { label: "Buat salinan", disabled: editable, action: () => void createCopyProject().catch((error) => toast(friendlyError(error))) },
      { label: "Bagikan", disabled: () => role !== "owner", action: openShareDialog },
      { label: "Download PPTX", action: () => void downloadDeckPptx() },
      { label: "Download slide PNG", action: downloadCurrentSlidePng },
      { label: "Cetak", shortcut: "Ctrl+P", action: () => print() },
    ],
    edit: [
      { label: "Urungkan", shortcut: "Ctrl+Z", disabled: () => !undoStack.length, action: undo },
      { label: "Ulangi", shortcut: "Ctrl+Y", disabled: () => !redoStack.length, action: redo },
      { separator: true },
      { label: "Duplikasikan elemen", shortcut: "Ctrl+D", disabled: () => !hasSelection() || !isEditableRole(), action: duplicateSelected },
      { label: "Hapus elemen", shortcut: "Delete", disabled: () => !hasSelection() || !isEditableRole(), action: deleteSelected },
      { label: "Duplikasikan slide", disabled: editable, action: duplicateSlide },
    ],
    home: [
      { label: "Slide baru", shortcut: "Ctrl+M", disabled: editable, action: addSlide },
      { label: "Duplikasikan slide", disabled: editable, action: duplicateSlide },
      { label: "Reset layout", disabled: editable, action: resetSlideLayout },
      { separator: true },
      { label: "Tebalkan", shortcut: "Ctrl+B", disabled: () => !hasSelection(), action: () => applySelectedTextFormat("bold") },
      { label: "Miringkan", shortcut: "Ctrl+I", disabled: () => !hasSelection(), action: () => applySelectedTextFormat("italic") },
      { label: "Garis bawah", shortcut: "Ctrl+U", disabled: () => !hasSelection(), action: () => applySelectedTextFormat("underline") },
      { label: "Perbesar font", disabled: () => !hasSelection(), action: () => applySelectedFontSize(4) },
      { label: "Perkecil font", disabled: () => !hasSelection(), action: () => applySelectedFontSize(-4) },
      { separator: true },
      { label: "Rata kiri", disabled: () => !hasSelection(), action: () => applySelectedTextAlign("left") },
      { label: "Rata tengah", disabled: () => !hasSelection(), action: () => applySelectedTextAlign("center") },
      { label: "Rata kanan", disabled: () => !hasSelection(), action: () => applySelectedTextAlign("right") },
      { separator: true },
      {
        label: "Arrange", items: [
          { label: "Bawa ke depan", disabled: () => !hasSelection(), action: () => arrangeSelected("front") },
          { label: "Bawa maju", disabled: () => !hasSelection(), action: () => arrangeSelected("forward") },
          { label: "Kirim mundur", disabled: () => !hasSelection(), action: () => arrangeSelected("backward") },
          { label: "Kirim ke belakang", disabled: () => !hasSelection(), action: () => arrangeSelected("back") },
        ]
      },
    ],
    view: [
      { label: "Slideshow", shortcut: "Ctrl+F5", action: () => void togglePresentation() },
      { label: "Tampilan kisi", checked: () => !$("#workspace").classList.contains("grid-hidden"), action: toggleWorkspaceGrid },
      { label: "Tampilkan catatan pembicara", checked: () => showSpeakerNotes, action: toggleSpeakerNotes },
      { label: "Zoom pas", action: () => { ($("#zoom-select") as HTMLSelectElement).value = "fit"; setZoom(fitZoom, true); } },
      { label: "Layar penuh", action: () => void document.documentElement.requestFullscreen() },
    ],
    insert: [
      { label: "Gambar", action: openImagePicker },
      { label: "Kotak teks", action: () => addText("body") },
      { label: "Judul", action: () => addText("title") },
      { label: "Bentuk persegi", action: () => addShape("rect") },
      { label: "Bentuk lingkaran", action: () => addShape("ellipse") },
      { label: "Garis", action: () => addShape("line") },
      { label: "Canva by link", disabled: editable, action: promptCanvaImport },
      {
        label: "Tabel", items: [
          { label: "Sisipkan tabel...", action: promptAddTable },
          { label: "Tabel 3 x 3", action: () => addTable(3, 3) },
          { label: "Tabel 5 x 4", action: () => addTable(5, 4) },
          { separator: true },
          { label: "Tambah baris bawah", disabled: tableDisabled, action: () => editSelectedTable("row-after") },
          { label: "Tambah kolom kanan", disabled: tableDisabled, action: () => editSelectedTable("col-after") },
          { label: "Hapus baris", disabled: tableDisabled, action: () => editSelectedTable("row-delete") },
          { label: "Hapus kolom", disabled: tableDisabled, action: () => editSelectedTable("col-delete") },
          { label: "Hapus tabel", disabled: tableDisabled, action: deleteSelectedTable },
        ]
      },
      { separator: true },
      { label: "Header & Footer", action: addHeaderFooter },
      { label: "Nomor slide", action: addSlideNumber },
      { label: "Komentar", action: addCommentToNotes },
      { label: "Animasi", disabled: () => !hasSelection(), items: animationItems },
      { label: "Mockup HP", action: addPhone },
      { label: "Slide baru", shortcut: "Ctrl+M", action: addSlide },
    ],
    draw: [
      { label: "Pilih", action: () => toast("Mode pilih aktif.") },
      { label: "Pena hitam", action: () => addShape("line") },
      { label: "Highlighter", action: () => { addShape("rect"); const element = selected(); if (element?.type === "shape") { element.fill = "#fff475"; element.stroke = "#fff475"; element.h = 18; renderAll(); scheduleSave(); } } },
      { label: "Penggaris", checked: () => !$("#workspace").classList.contains("grid-hidden"), action: toggleWorkspaceGrid },
      { separator: true },
      { label: "Persegi", action: () => addShape("rect") },
      { label: "Lingkaran", action: () => addShape("ellipse") },
      { label: "Garis", action: () => addShape("line") },
      { label: "Shape fill biru", disabled: () => selected()?.type !== "shape", action: () => applySelectedShapeColor("fill", "#e8f0fe") },
      { label: "Shape outline biru", disabled: () => selected()?.type !== "shape", action: () => applySelectedShapeColor("stroke", "#1a73e8") },
    ],
    design: [
      { label: "Terang", action: () => applyTheme("light") },
      { label: "Gelap", action: () => applyTheme("dark") },
      { label: "Biru", action: () => applyTheme("blue") },
      { label: "Hijau", action: () => applyTheme("green") },
      { label: "Emas", action: () => applyTheme("gold") },
      { separator: true },
      { label: "Format background...", action: promptSlideBackground },
      { label: "Reset layout", action: resetSlideLayout },
    ],
    transitions: [
      { label: "Preview", action: renderAudienceSlide },
      { separator: true },
      ...transitionItems,
    ],
    animations: [
      { label: "Preview", action: () => renderCanvas() },
      { separator: true },
      ...animationItems.map((item) => ({ ...item, disabled: () => !hasSelection() })),
    ],
    slideshow: [
      { label: "Mulai slideshow", shortcut: "Ctrl+F5", action: () => void togglePresentation() },
      { label: "Publikasikan slide aktif", action: () => void publishSlideState() },
      { label: "Layar penuh", action: () => void document.documentElement.requestFullscreen() },
      { label: "Ikuti presenter", action: returnToLiveSlide },
    ],
    record: [
      { label: "Rekam layar", action: () => toast("Gunakan perekam layar browser/OS saat slideshow berjalan.") },
      { label: "Audio", action: () => toast("Perekaman audio native belum aktif; slideshow tetap bisa dibagikan live.") },
      { label: "Export video", action: () => toast("Export video belum tersedia di browser build ini.") },
    ],
    format: [
      { label: "Tebalkan", shortcut: "Ctrl+B", disabled: () => !hasSelection(), action: () => applySelectedTextFormat("bold") },
      { label: "Miringkan", shortcut: "Ctrl+I", disabled: () => !hasSelection(), action: () => applySelectedTextFormat("italic") },
      { label: "Garis bawah", shortcut: "Ctrl+U", disabled: () => !hasSelection(), action: () => applySelectedTextFormat("underline") },
      { separator: true },
      { label: "Jadikan judul", disabled: () => selected()?.type !== "text", action: () => applySelectedTextFormat("title") },
      { label: "Jadikan isi", disabled: () => selected()?.type !== "text", action: () => applySelectedTextFormat("body") },
      { label: "Warna hitam", disabled: () => !hasSelection(), action: () => applySelectedTextFormat("color", "#202124") },
      { label: "Warna biru", disabled: () => !hasSelection(), action: () => applySelectedTextFormat("color", "#1a73e8") },
      { label: "Warna merah", disabled: () => !hasSelection(), action: () => applySelectedTextFormat("color", "#b3261e") },
      { separator: true },
      { label: "Perbesar font", disabled: () => !hasSelection(), action: () => applySelectedFontSize(4) },
      { label: "Perkecil font", disabled: () => !hasSelection(), action: () => applySelectedFontSize(-4) },
    ],
    slide: [
      { label: "Slide baru", shortcut: "Ctrl+M", disabled: editable, action: addSlide },
      { label: "Duplikasikan slide", shortcut: "Ctrl+D", disabled: editable, action: duplicateSlide },
      { label: "Hapus slide", shortcut: "Shift+Delete", disabled: () => !isEditableRole() || deck.slides.length <= 1, action: deleteCurrentSlide },
      { separator: true },
      { label: "Ganti nama slide", disabled: editable, action: () => renameSlide(currentSlide) },
      { label: "Ganti nama segment", disabled: editable, action: () => renameSegment(currentSlide) },
      { label: "Ubah background", action: promptSlideBackground },
      { label: "Transisi", items: transitionItems },
    ],
    arrange: [
      { label: "Bawa ke depan", disabled: () => !hasSelection(), action: () => arrangeSelected("front") },
      { label: "Bawa maju", disabled: () => !hasSelection(), action: () => arrangeSelected("forward") },
      { label: "Kirim mundur", disabled: () => !hasSelection(), action: () => arrangeSelected("backward") },
      { label: "Kirim ke belakang", disabled: () => !hasSelection(), action: () => arrangeSelected("back") },
      { separator: true },
      { label: "Ke tengah halaman", disabled: () => !hasSelection(), action: () => centerSelected("both") },
      { label: "Tengah horizontal", disabled: () => !hasSelection(), action: () => centerSelected("horizontal") },
      { label: "Tengah vertikal", disabled: () => !hasSelection(), action: () => centerSelected("vertical") },
    ],
    tools: [
      { label: "AI rapikan presentasi", disabled: editable, action: () => void runAiImproveCurrentDeck() },
      { separator: true },
      { label: "Diagnosa USB", action: () => void diagnoseUsb() },
      { label: "Refresh izin USB", action: () => void refreshUsbDevices() },
      { separator: true },
      { label: "Periksa ejaan", action: () => toast("Pemeriksa ejaan browser aktif pada teks yang diedit.") },
      { label: "Preferensi", action: () => switchInspector("device") },
    ],
    review: [
      { label: "Spelling", action: () => toast("Pemeriksa ejaan browser aktif pada teks yang diedit.") },
      { label: "Thesaurus", action: () => toast("Thesaurus belum tersedia offline.") },
      { label: "Translate", action: () => toast("Terjemahan belum tersedia offline.") },
      { label: "Accessibility", action: () => toast("Cek aksesibilitas: gunakan teks alt pada gambar dan kontras warna yang cukup.") },
      { label: "Komentar baru", action: addCommentToNotes },
      { label: "Tampilkan komentar", action: toggleSpeakerNotes },
    ],
    extensions: [
      { label: "ADB Live Mirror", action: () => switchInspector("device") },
      { label: "Import PPTX Browser", action: openPptxPicker },
      { label: "Import Canva by link", disabled: editable, action: promptCanvaImport },
    ],
    developer: [
      { label: "Diagnosa RTDB", action: () => toast(`Project aktif: ${projectId || "lokal"}`) },
      { label: "View JSON", action: downloadDeckJson },
      { label: "Macro placeholder", action: () => toast("Macro PowerPoint native tidak berjalan di browser.") },
      { label: "Add-ins", action: () => toast("Add-ins browser bisa ditambahkan sebagai modul web berikutnya.") },
    ],
    help: [
      { label: "Import PPTX", action: openPptxPicker },
    ],
  }[menu] || [];
}

function ensureMenuPopover(): HTMLElement {
  let popover = document.getElementById("menu-popover");
  if (!popover) {
    popover = document.createElement("div");
    popover.id = "menu-popover";
    popover.className = "menu-popover";
    popover.hidden = true;
    document.body.append(popover);
  }
  return popover;
}

function closeMenu(): void {
  const popover = ensureMenuPopover();
  popover.hidden = true;
  activeMenuButton?.classList.remove("menu-open");
  activeMenuButton = null;
}

function renderMenuItem(item: MenuItem): HTMLElement {
  if (item.separator) {
    const separator = document.createElement("div");
    separator.className = "menu-separator";
    return separator;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = `menu-item${item.items?.length ? " has-submenu" : ""}`;
  const disabled = Boolean(item.disabled?.());
  button.disabled = disabled;
  button.innerHTML = `<span class="menu-check"></span><span class="menu-label"></span><span class="menu-shortcut"></span>`;
  $(".menu-check", button).textContent = item.checked?.() ? "✓" : item.icon || "";
  $(".menu-label", button).textContent = item.label || "";
  $(".menu-shortcut", button).textContent = item.items?.length ? "›" : item.shortcut || "";
  if (item.items?.length) {
    const submenu = document.createElement("div");
    submenu.className = "menu-submenu";
    item.items.forEach((child) => submenu.append(renderMenuItem(child)));
    button.append(submenu);
  }
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (disabled || item.items?.length) return;
    closeMenu();
    void item.action?.();
  });
  return button;
}

function openMenu(button: HTMLElement): void {
  const menu = button.dataset.menu || "";
  const popover = ensureMenuPopover();
  if (activeMenuButton === button && !popover.hidden) { closeMenu(); return; }
  activeMenuButton?.classList.remove("menu-open");
  activeMenuButton = button;
  button.classList.add("menu-open");
  popover.innerHTML = "";
  menuItems(menu).forEach((item) => popover.append(renderMenuItem(item)));
  const rect = button.getBoundingClientRect();
  popover.style.left = `${rect.left}px`;
  popover.style.top = `${rect.bottom + 3}px`;
  popover.hidden = false;
}

function switchInspector(tab: "device" | "properties"): void {
  if (tab === "device" && selected()?.type !== "phone") {
    toast("Pilih mockup HP terlebih dahulu untuk menghubungkan perangkat mobile.");
    tab = "properties";
  }
  document.querySelectorAll(".inspector-tabs button").forEach((button) => button.classList.toggle("active", (button as HTMLElement).dataset.tab === tab));
  $("#device-panel").classList.toggle("active", tab === "device");
  $("#properties-panel").classList.toggle("active", tab === "properties");
  syncInspectorMode();
}

function syncInspectorMode(): void {
  const hasSelectedPhone = selected()?.type === "phone";
  const inspector = $("#inspector");
  inspector.classList.toggle("adb-hidden", !hasSelectedPhone);
  if (!hasSelectedPhone && $("#device-panel").classList.contains("active")) {
    document.querySelectorAll(".inspector-tabs button").forEach((button) => button.classList.toggle("active", (button as HTMLElement).dataset.tab === "properties"));
    $("#device-panel").classList.remove("active");
    $("#properties-panel").classList.add("active");
  }
}

function fitWorkspace(): void {
  const workspace = $("#workspace");
  const availableWidth = Math.max(200, workspace.clientWidth - 80);
  const availableHeight = Math.max(120, workspace.clientHeight - 65);
  fitZoom = clamp(Math.min(availableWidth / SLIDE_WIDTH, availableHeight / SLIDE_HEIGHT), .25, 1.35);
  const select = $("#zoom-select") as HTMLSelectElement;
  if (select.value === "fit") setZoom(fitZoom, true);
}

function setZoom(value: number, fit = false): void {
  zoom = clamp(value, .25, 1.6);
  $("#slide-shell").setAttribute("style", `transform:scale(${zoom})`);
  $("#zoom-label").textContent = fit ? "Pas" : `${Math.round(zoom * 100)}%`;
}

function cssToken(value: string | undefined): string {
  return (value || "none").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "none";
}

function renderAudienceSlide(): void {
  const target = $("#audience-slide");
  target.innerHTML = "";
  const slide = deck.slides[clamp(currentSlide, 0, deck.slides.length - 1)];
  if (!slide) return;
  target.className = `audience-slide transition-${cssToken(slide.transition)}`;
  for (const element of slide.elements) target.append(createElementNode(element, true));
  resizeAudienceSlide();
  updateAudienceAmbient(slide);
  renderAudienceChrome();
  syncAudienceMediaControls();
  renderRemoteCursors();
  renderCommentBadges();
}

function renderAudienceChrome(): void {
  $("#audience-title-text").textContent = deck.title || "Presentasi tanpa judul";
  const progress = $("#audience-segments");
  progress.innerHTML = "";
  deck.slides.forEach((_, index) => {
    const step = document.createElement("button");
    step.type = "button";
    step.className = `audience-progress-step${index === currentSlide ? " viewer-current" : ""}${index === presenterSlide ? " live-owner" : ""}${index < currentSlide ? " seen" : ""}`;
    step.title = `${slideSegmentLabel(index)} - slide ${index + 1}`;
    step.setAttribute("aria-label", `Ke slide ${index + 1}`);
    step.addEventListener("click", () => goToAudienceSlide(index));
    progress.append(step);
  });
  const live = role === "owner"
    ? presentationState.presenting && currentSlide === presenterSlide
    : presentationState.presenting && followingPresenter && currentSlide === presenterSlide;
  $("#audience-slide-index").textContent = `${currentSlide + 1} / ${deck.slides.length}`;
  $("#audience-live-state").textContent = live ? "Live" : "Tidak Live";
  $("#audience-live-toggle").classList.toggle("not-live", !live);
  const ownerSegment = segmentForSlide(presenterSlide || currentSlide);
  const segmentButton = $("#audience-segment-button");
  segmentButton.textContent = ownerSegment.label;
  segmentButton.title = `Segment owner: ${ownerSegment.label}`;
  const nextIndex = Math.min(currentSlide + 1, deck.slides.length - 1);
  $("#audience-next-label").textContent = nextIndex > currentSlide ? `Slide selanjutnya ${nextIndex + 1}` : "Slide terakhir";
  const nextThumb = $("#audience-next-thumb");
  nextThumb.innerHTML = "";
  nextThumb.append(createSlidePreview(deck.slides[nextIndex], "next-slide-preview"));
  const status = $("#audience-status");
  status.classList.toggle("live", presentationState.presenting && live);
  $("span:last-child", status).textContent = presentationState.presenting
    ? live ? "LIVE - peer-to-peer" : "Tidak Live - klik Live untuk kembali"
    : "Menunggu presenter...";
  renderAudienceSharePopover();
  renderSegmentDialog();
}

function setAudienceFillMode(mode: "contain" | "cover"): void {
  audienceFillMode = mode;
  const view = document.getElementById("audience-view");
  if (view) view.classList.toggle("stage-cover", mode === "cover");
  resizeAudienceSlide();
}

function toggleAudienceFillMode(): void {
  setAudienceFillMode(audienceFillMode === "cover" ? "contain" : "cover");
  toast(audienceFillMode === "cover" ? "Slide memenuhi layar." : "Slide kembali pas layar.");
}

function resetAudienceSwipeMotion(animated = true): void {
  const stage = document.getElementById("audience-stage");
  const slide = document.getElementById("audience-slide");
  if (!stage || !slide) return;
  stage.classList.toggle("slide-swiping", !animated);
  stage.classList.toggle("slide-settling", animated);
  slide.style.setProperty("--audience-slide-x", "0px");
  slide.style.setProperty("--audience-slide-opacity", "1");
  if (animated) window.setTimeout(() => stage.classList.remove("slide-settling"), 230);
}

function animateAudienceSwipeToSlide(nextIndex: number, direction: 1 | -1): void {
  const stage = $("#audience-stage");
  const slide = $("#audience-slide");
  stage.classList.remove("slide-swiping");
  stage.classList.add("slide-settling");
  slide.style.setProperty("--audience-slide-x", `${direction * Math.max(220, stage.clientWidth)}px`);
  slide.style.setProperty("--audience-slide-opacity", "0.2");
  window.setTimeout(() => {
    goToAudienceSlide(nextIndex);
    slide.style.setProperty("--audience-slide-x", `${-direction * Math.max(140, stage.clientWidth * 0.26)}px`);
    slide.style.setProperty("--audience-slide-opacity", "0.45");
    requestAnimationFrame(() => resetAudienceSwipeMotion(true));
  }, 150);
}

function updateAudienceAmbient(slide: Slide): void {
  const view = document.getElementById("audience-view");
  if (!view) return;
  const colors = sampleSlideColors(slide);
  view.style.setProperty("--ambient-a", colors[0]);
  view.style.setProperty("--ambient-b", colors[1]);
  view.style.setProperty("--ambient-c", colors[2]);
}

function sampleSlideColors(slide: Slide): [string, string, string] {
  const canvas = document.createElement("canvas");
  canvas.width = 48;
  canvas.height = 27;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return ["#243c46", "#14151b", "#0b0c0f"];
  drawSlideToContext(context, slide, canvas.width / SLIDE_WIDTH);
  let data: Uint8ClampedArray;
  try {
    data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    return ["#243c46", "#14151b", "#0b0c0f"];
  }
  const buckets = new Map<string, { r: number; g: number; b: number; count: number; weight: number }>();
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max - min;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luminance > 238 || luminance < 18 || sat < 18) continue;
    const key = `${Math.round(r / 32)}-${Math.round(g / 32)}-${Math.round(b / 32)}`;
    const item = buckets.get(key) || { r: 0, g: 0, b: 0, count: 0, weight: 0 };
    const weight = sat + Math.abs(142 - luminance) * 0.16;
    item.r += r * weight;
    item.g += g * weight;
    item.b += b * weight;
    item.count += 1;
    item.weight += weight;
    buckets.set(key, item);
  }
  const chosen = [...buckets.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((item) => rgbToHex(item.r / item.weight, item.g / item.weight, item.b / item.weight));
  while (chosen.length < 3) chosen.push(["#274a5a", "#4a2638", "#14151b"][chosen.length]);
  return [chosen[0], chosen[1], chosen[2]] as [string, string, string];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgb(value: string): [number, number, number] {
  const hex = /^#?([0-9a-f]{6})$/i.exec(value)?.[1] || "202124";
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function relativeLuminance(value: string): number {
  const [r, g, b] = hexToRgb(value).map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function readableTextFor(color: string): string {
  return relativeLuminance(color) > 0.46 ? "#202124" : "#ffffff";
}

function readableMutedTextFor(color: string): string {
  return relativeLuminance(color) > 0.46 ? "#4b5563" : "rgba(255,255,255,.78)";
}

function renderAudiencePeople(): void {
  const active = activePresenceRecords.filter((item) => item && item.name);
  const avatars = $("#audience-avatars");
  avatars.innerHTML = "";
  active.slice(0, 3).forEach((item) => {
    const avatar = document.createElement("span");
    avatar.className = "presence-avatar";
    avatar.style.background = item.color || randomColor(item.name);
    avatar.title = item.name;
    avatar.textContent = shortInitials(item.name);
    avatars.append(avatar);
  });
  $("#audience-more").textContent = active.length > 3 ? `+${active.length - 3}` : "";
  const list = $("#people-list");
  list.innerHTML = "";
  if (!active.length) {
    list.innerHTML = '<p class="empty-people">Belum ada audiens lain.</p>';
    return;
  }
  active.forEach((item) => {
    const row = document.createElement("div");
    row.className = "people-row";
    row.innerHTML = '<span class="presence-avatar"></span><div><strong></strong><span></span></div>';
    const avatar = $(".presence-avatar", row);
    avatar.textContent = shortInitials(item.name);
    avatar.setAttribute("style", `background:${item.color || randomColor(item.name)}`);
    $("strong", row).textContent = item.name;
    $("span:last-child", row).textContent = `${item.role} · slide ${Number(item.slide || 0) + 1}`;
    list.append(row);
  });
}

function showAudienceChrome(): void {
  const view = $("#audience-view");
  view.classList.remove("chrome-hidden");
  clearTimeout(audienceChromeTimer);
  audienceChromeTimer = window.setTimeout(() => {
    if (isAudienceChromePinned()) {
      showAudienceChrome();
      return;
    }
    view.classList.add("chrome-hidden");
  }, 3600);
}

function isAudienceChromePinned(): boolean {
  if (!isAudienceOpen()) return false;
  if (($("#segment-dialog") as HTMLDialogElement).open || ($("#people-dialog") as HTMLDialogElement).open || ($("#comment-dialog") as HTMLDialogElement).open) return true;
  return Boolean(
    document.querySelector("#audience-control-layer:hover")
    || document.querySelector("#audience-control-layer:focus-within")
    || document.querySelector("#audience-share-popover:hover")
    || document.querySelector("#audience-share-popover:focus-within")
    || document.querySelector(".audience-share-wrap:hover")
    || document.querySelector(".audience-volume-panel:hover")
  );
}

function syncAudienceRailState(): void {
  const open = ($("#segment-dialog") as HTMLDialogElement).open || ($("#people-dialog") as HTMLDialogElement).open || ($("#comment-dialog") as HTMLDialogElement).open;
  const view = $("#audience-view");
  view.classList.toggle("rail-open", open && isAudienceOpen());
  if (!open) view.style.removeProperty("--rail-swipe-offset");
  resizeAudienceSlide();
}

function resetDialogMotion(dialog: HTMLDialogElement): void {
  dialog.style.transition = "";
  dialog.style.transform = "";
  dialog.style.opacity = "";
}

function openAudienceRailDialog(dialog: HTMLDialogElement): void {
  for (const other of [$("#segment-dialog") as HTMLDialogElement, $("#people-dialog") as HTMLDialogElement, $("#comment-dialog") as HTMLDialogElement]) {
    if (other !== dialog && other.open) {
      resetDialogMotion(other);
      other.close();
    }
  }
  dialog.classList.add("audience-rail-dialog");
  resetDialogMotion(dialog);
  $("#audience-view").style.removeProperty("--rail-swipe-offset");
  if (!dialog.open) dialog.show();
  syncAudienceRailState();
  showAudienceChrome();
}

function openPeopleDialog(): void {
  renderAudiencePeople();
  const dialog = $("#people-dialog") as HTMLDialogElement;
  if (isAudienceOpen()) openAudienceRailDialog(dialog);
  else {
    dialog.classList.remove("audience-rail-dialog");
    dialog.showModal();
  }
}

function goToAudienceSlide(index: number): void {
  currentSlide = clamp(index, 0, deck.slides.length - 1);
  if (role === "owner") {
    presenterSlide = currentSlide;
    followingPresenter = true;
    if (presentationState.presenting) void publishSlideState();
  } else {
    followingPresenter = currentSlide === presenterSlide;
    if (!followingPresenter) disconnectViewerRtc();
    else if (presentationState.presenting) void connectViewerRtc();
  }
  renderAudienceSlide();
  updatePresenceSlide();
  showAudienceChrome();
}

function returnToLiveSlide(): void {
  followingPresenter = true;
  currentSlide = presenterSlide;
  renderAudienceSlide();
  if (presentationState.presenting && role !== "owner") void connectViewerRtc();
  updatePresenceSlide();
  showAudienceChrome();
}

function audienceStep(delta: number): void {
  goToAudienceSlide(currentSlide + delta);
}

function isAudienceOpen(): boolean {
  return !$("#audience-view").hasAttribute("hidden");
}

function handleAudienceStageClick(event: MouseEvent): void {
  if (Date.now() < audienceSwipeSuppressClickUntil) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if ((event.target as HTMLElement).closest(".remote-cursor")) return;
  const stage = $("#audience-stage");
  const element = elementFromSurfaceEvent(event, stage);
  if (element && commentsForElement(element.id, currentSlide).length) {
    event.preventDefault();
    event.stopPropagation();
    openCommentDialogForElement(element.id, currentSlide);
    return;
  }
  const rect = stage.getBoundingClientRect();
  const x = (event.clientX - rect.left) / Math.max(1, rect.width);
  if (x < 0.34) audienceStep(-1);
  else if (x > 0.66) audienceStep(1);
  else showAudienceChrome();
}

async function leaveAudienceView(): Promise<void> {
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
  if (role === "viewer") {
    location.href = homeUrl();
    return;
  }
  $("#audience-view").setAttribute("hidden", "");
  $("#editor-app").removeAttribute("hidden");
  showAudienceChrome();
}

function syncFullscreenButton(): void {
  const button = $("#audience-fullscreen");
  const full = Boolean(document.fullscreenElement);
  button.innerHTML = full
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" fill="none" stroke="currentColor" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10V4h6M20 10V4h-6M4 14v6h6M20 14v6h-6" fill="none" stroke="currentColor" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  button.title = full ? "Keluar layar penuh" : "Layar penuh";
  button.setAttribute("aria-label", button.title);
}

function returnOwnerToEditorFromAudience(): void {
  if (role !== "owner" || !isAudienceOpen()) return;
  $("#audience-view").setAttribute("hidden", "");
  $("#editor-app").removeAttribute("hidden");
  renderAll();
  requestAnimationFrame(fitWorkspace);
}

function handleFullscreenChange(): void {
  syncFullscreenButton();
  if (!document.fullscreenElement && role === "owner" && presentationState.presenting && isAudienceOpen()) {
    returnOwnerToEditorFromAudience();
  }
}

async function tryLockLandscape(): Promise<void> {
  const orientation = screen.orientation as ScreenOrientation & { lock?: (orientation: "landscape") => Promise<void> };
  if (!orientation?.lock || !document.fullscreenElement) return;
  await orientation.lock("landscape").catch(() => undefined);
}

async function toggleAudienceFullscreen(): Promise<void> {
  if (document.fullscreenElement) {
    await document.exitFullscreen().catch(() => undefined);
    if (role === "owner") returnOwnerToEditorFromAudience();
  }
  else if (document.fullscreenEnabled) {
    await document.documentElement.requestFullscreen().catch(() => undefined);
    await tryLockLandscape();
  }
  syncFullscreenButton();
}

function pointerToSlidePoint(event: MouseEvent | PointerEvent, surface: HTMLElement): { x: number; y: number } {
  const rect = surface.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) / Math.max(1, rect.width) * SLIDE_WIDTH, 0, SLIDE_WIDTH),
    y: clamp((event.clientY - rect.top) / Math.max(1, rect.height) * SLIDE_HEIGHT, 0, SLIDE_HEIGHT),
  };
}

function editingLabelFromTarget(target: EventTarget | null, element: SlideElement | null): string {
  const node = target instanceof HTMLElement ? target : null;
  if (node?.closest('[contenteditable="true"]')) return `Mengedit ${elementLabel(element)}`;
  if (document.activeElement?.id === "prop-text" && selected()) return `Mengedit ${elementLabel(selected())}`;
  return "";
}

function updatePointerFromSurface(event: PointerEvent, surface: HTMLElement): void {
  if (!activePresencePath) return;
  const point = pointerToSlidePoint(event, surface);
  const element = elementAtSlidePoint(point.x, point.y);
  const editing = editingLabelFromTarget(event.target, element);
  updatePresenceCursor({
    x: Math.round(point.x),
    y: Math.round(point.y),
    slide: currentSlide,
    visible: true,
    target: elementLabel(element),
    targetId: element?.id,
    editing,
  });
}

function resizeAudienceSlide(): void {
  const stage = $("#audience-stage");
  const scale = audienceFillMode === "cover"
    ? Math.max(stage.clientWidth / SLIDE_WIDTH, stage.clientHeight / SLIDE_HEIGHT)
    : Math.min(stage.clientWidth / SLIDE_WIDTH, stage.clientHeight / SLIDE_HEIGHT);
  $("#audience-slide").style.setProperty("--audience-slide-scale", String(scale));
}

function cursorRecordsForSlide(slideIndex: number): PresenceRecord[] {
  const now = Date.now();
  return activePresenceRecords.filter((item) => {
    const cursor = item.cursor;
    const maxAge = item.role === "owner" ? 65000 : 15000;
    return item.sessionId !== presenceSessionId
      && cursor?.visible
      && Number(cursor.slide) === slideIndex
      && (!cursor.updatedAt || now - Number(cursor.updatedAt) < maxAge);
  });
}

function renderCursorNode(item: PresenceRecord, scaled = false): HTMLElement {
  const cursor = item.cursor!;
  const node = document.createElement("div");
  node.className = `remote-cursor remote-cursor-${item.role}`;
  node.style.setProperty("--cursor-color", item.color || randomColor(item.name));
  node.style.left = scaled ? `${(cursor.x / SLIDE_WIDTH) * 100}%` : `${cursor.x}px`;
  node.style.top = scaled ? `${(cursor.y / SLIDE_HEIGHT) * 100}%` : `${cursor.y}px`;
  node.innerHTML = '<svg class="remote-cursor-pointer" viewBox="0 0 32 32" aria-hidden="true"><path d="M4 2.8 25.4 18.5l-9.1 1.2 5.3 8.7-5.5 3.2-5.2-8.8-5.7 6.4L4 2.8Z"></path></svg><span class="remote-cursor-label"><strong></strong><em></em></span>';
  $("strong", node).textContent = item.name;
  $("em", node).textContent = cursor.editing || cursor.target || `Slide ${Number(cursor.slide || 0) + 1}`;
  return node;
}

function renderRemoteCursors(): void {
  const editorCanvas = document.getElementById("slide-canvas");
  if (editorCanvas) {
    let layer = document.getElementById("editor-cursor-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "editor-cursor-layer";
      layer.className = "remote-cursor-layer editor-cursor-layer";
      editorCanvas.append(layer);
    }
    layer.innerHTML = "";
    cursorRecordsForSlide(currentSlide).forEach((item) => layer?.append(renderCursorNode(item)));
  }

  const audienceStage = document.getElementById("audience-stage");
  if (audienceStage) {
    let layer = document.getElementById("audience-cursor-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "audience-cursor-layer";
      layer.className = "remote-cursor-layer audience-cursor-layer";
      audienceStage.append(layer);
    }
    layer.innerHTML = "";
    cursorRecordsForSlide(currentSlide).forEach((item) => layer?.append(renderCursorNode(item, true)));
  }
}

function getDeviceLabel(serial: string | null): string {
  return serial ? connectedDevices.get(serial)?.label || "" : "";
}

function deviceSerial(device: AdbDaemonWebUsbDevice): string {
  return device.serial || device.raw.serialNumber || `${device.raw.vendorId}:${device.raw.productId}:${device.name}`;
}

function setUsbStatus(message: string, state: "warning" | "online" | "error" = "warning"): void {
  const badge = $("#usb-indicator");
  badge.className = `connection-badge ${state}`;
  badge.textContent = message;
}

function explainUsbError(error: unknown): string {
  const raw = String((error as { message?: string })?.message || error || "Kesalahan USB");
  const lower = raw.toLowerCase();
  if (lower.includes("must be handling a user gesture") || lower.includes("user activation")) return "Popup USB hanya boleh dibuka langsung dari klik tombol Hubungkan.";
  if (lower.includes("access denied") || lower.includes("permission")) return "Izin USB ditolak. Buka kunci HP, aktifkan USB debugging, lalu izinkan komputer ini.";
  if (lower.includes("busy") || lower.includes("claim") || lower.includes("already in use")) return "Interface ADB sedang dipakai adb.exe, Android Studio, scrcpy, DeX, atau aplikasi lain. Tutup aplikasi tersebut lalu cabut-colok USB.";
  if (lower.includes("timeout")) return "Koneksi ADB timeout. Pastikan layar HP terbuka dan popup ‘Allow USB debugging’ disetujui.";
  if (lower.includes("disconnected") || lower.includes("lost") || lower.includes("transfer")) return "Perangkat terputus saat handshake. Gunakan kabel data, pilih mode Transfer file, lalu Refresh izin.";
  return raw;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer = 0;
  return Promise.race([promise, new Promise<T>((_, reject) => { timer = window.setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

async function requestUsbDevice(): Promise<void> {
  if (!isSecureContext || !("usb" in navigator) || !usbManager) {
    setUsbStatus("WebUSB tidak tersedia", "error");
    toast("Gunakan Chrome/Edge desktop melalui localhost atau HTTPS.");
    return;
  }
  try {
    log("Membuka pemilih WebUSB. Pilih satu perangkat Android.");
    const device = await usbManager.requestDevice();
    if (!device) { log("Pemilihan perangkat dibatalkan."); return; }
    await connectAdbDevice(device);
  } catch (error) {
    console.error(error);
    const message = explainUsbError(error);
    setUsbStatus("Koneksi gagal", "error");
    log(message, true);
  }
}

async function refreshUsbDevices(): Promise<void> {
  if (!usbManager) { toast("WebUSB tidak didukung browser ini."); return; }
  try {
    const devices = await usbManager.getDevices();
    if (!devices.length) { log("Belum ada izin USB tersimpan. Klik Hubungkan perangkat USB.", true); return; }
    log(`${devices.length} perangkat berizin ditemukan. Menghubungkan satu per satu.`);
    for (const device of devices) {
      const serial = deviceSerial(device);
      if (!connectedDevices.has(serial)) await connectAdbDevice(device);
    }
  } catch (error) {
    const message = explainUsbError(error);
    setUsbStatus("Refresh gagal", "error");
    log(message, true);
  }
}

async function connectAdbDevice(device: AdbDaemonWebUsbDevice): Promise<void> {
  const serial = deviceSerial(device);
  if (connectedDevices.has(serial)) return;
  setUsbStatus("Membuka WebUSB…");
  log(`Membuka ${device.name || serial}. Pastikan HP dalam keadaan unlock.`);
  let connection: AdbDaemonWebUsbConnection | null = null;
  try {
    connection = await withTimeout(device.connect(), 20000, "Timeout membuka interface WebUSB.");
    setUsbStatus("Izinkan pada HP…");
    log("Interface terbuka. Menunggu persetujuan ‘Allow USB debugging’ pada HP.");
    const transport = await withTimeout(AdbDaemonTransport.authenticate({ serial, connection, credentialStore, readTimeLimit: 45000 }), 80000, "Timeout handshake ADB.");
    const adb = new Adb(transport);
    const model = (await adb.getProp("ro.product.model").catch(() => "")) || device.name || serial;
    connectedDevices.set(serial, { device, connection, adb, label: model.trim() });
    void adb.disconnected.then(() => disconnectAdbDevice(serial));
    setUsbStatus(`${connectedDevices.size} perangkat siap`, "online");
    log(`ADB siap: ${model.trim()} (${serial}).`, true);
    renderDevices();
    if (presentationState.presenting) void ensureCurrentSlideMirrors();
  } catch (error) {
    try { await connection?.readable.cancel(); } catch { /* best effort */ }
    try { await connection?.writable.close(); } catch { /* best effort */ }
    throw error;
  }
}

function disconnectAdbDevice(serial: string): void {
  stopMirror(serial);
  connectedDevices.delete(serial);
  setUsbStatus(connectedDevices.size ? `${connectedDevices.size} perangkat siap` : "Perangkat terputus", connectedDevices.size ? "online" : "warning");
  renderDevices();
}

function renderDevices(): void {
  $("#device-count").textContent = String(connectedDevices.size);
  const target = $("#device-list");
  target.innerHTML = "";
  if (!connectedDevices.size) {
    target.innerHTML = '<div class="empty-device">Belum ada perangkat ADB.</div>';
  } else {
    for (const [serial, device] of connectedDevices) {
      const node = document.createElement("button");
      const selectedElement = selected();
      node.className = `device-card${selectedElement?.type === "phone" && selectedElement.deviceSerial === serial ? " selected" : ""}`;
      node.innerHTML = '<span class="device-icon">▯</span><span class="device-meta"><strong></strong><span></span></span><i class="device-ready"></i>';
      $("strong", node).textContent = device.label;
      $(".device-meta span", node).textContent = serial;
      node.addEventListener("click", () => assignDevice(serial));
      target.append(node);
    }
  }
  renderDeviceSelect();
}

function renderDeviceSelect(): void {
  const select = $("#device-select") as HTMLSelectElement;
  const element = selected();
  select.innerHTML = "";
  const initial = document.createElement("option");
  initial.value = "";
  initial.textContent = element?.type === "phone" ? "— pilih perangkat —" : "Pilih mockup terlebih dahulu";
  select.append(initial);
  for (const [serial, device] of connectedDevices) {
    const option = document.createElement("option");
    option.value = serial;
    option.textContent = `${device.label} · ${serial}`;
    select.append(option);
  }
  select.disabled = element?.type !== "phone" || !isEditableRole();
  select.value = element?.type === "phone" && element.deviceSerial ? element.deviceSerial : "";
}

function assignDevice(serial: string): void {
  const element = selected();
  if (element?.type !== "phone") { toast("Pilih mockup HP pada slide terlebih dahulu."); return; }
  const device = connectedDevices.get(serial);
  if (!device) return;
  element.deviceSerial = serial;
  element.deviceLabel = device.label;
  recordHistory();
  renderAll();
  scheduleSave();
  toast(`${device.label} dipasang ke mockup terpilih.`);
}

async function diagnoseUsb(): Promise<void> {
  try {
    const webUsb = (navigator as unknown as { usb?: BrowserUsbApi }).usb;
    if (!webUsb) { log("WebUSB tidak tersedia. Gunakan Chrome/Edge desktop.", true); return; }
    const devices = await webUsb.getDevices();
    log(`Diagnosa: ${devices.length} perangkat memiliki izin untuk origin ${location.origin}.`);
    for (const device of devices) {
      const label = [device.manufacturerName, device.productName].filter(Boolean).join(" ") || "USB device";
      log(`${label} | vendor=0x${device.vendorId.toString(16)} product=0x${device.productId.toString(16)} opened=${device.opened}`);
      for (const config of device.configurations || []) for (const iface of config.interfaces || []) for (const alternate of iface.alternates || []) {
        if (alternate.interfaceClass === 255 && alternate.interfaceSubclass === 66 && alternate.interfaceProtocol === 1) log(`Interface ADB ditemukan pada interface ${iface.interfaceNumber}.`);
      }
    }
    log("Jika interface ADB ada tetapi gagal dibuka, tutup adb.exe/Android Studio/scrcpy dan cabut-colok kabel.", true);
  } catch (error) {
    log(`Diagnosa gagal: ${explainUsbError(error)}`, true);
  }
}

async function startSelectedMirror(): Promise<void> {
  const element = selected();
  if (element?.type !== "phone") { toast("Pilih mockup HP terlebih dahulu."); return; }
  if (!element.deviceSerial || !connectedDevices.has(element.deviceSerial)) { toast("Pilih perangkat yang sudah tersambung untuk mockup ini."); return; }
  await startMirror(element.deviceSerial);
}

async function startMirror(serial: string): Promise<void> {
  if (mirrorStates.get(serial)?.running) return;
  const connected = connectedDevices.get(serial);
  if (!connected) return;
  const state: MirrorState = { running: true, lastUrl: null };
  mirrorStates.set(serial, state);
  renderCanvas();
  log(`Mirror dimulai: ${connected.label}.`);
  while (state.running && connectedDevices.has(serial)) {
    try {
      const bytes = await connected.adb.subprocess.noneProtocol.spawnWait(["screencap", "-p"]);
      if (!bytes.byteLength) throw new Error("ADB screencap menghasilkan frame kosong.");
      const png = Uint8Array.from(bytes);
      const blob = new Blob([png.buffer], { type: "image/png" });
      const url = URL.createObjectURL(blob);
      const image = frameImages.get(serial) || new Image();
      image.onload = () => updateVisiblePhoneFrames(serial, image.src);
      image.src = url;
      frameImages.set(serial, image);
      if (state.lastUrl) URL.revokeObjectURL(state.lastUrl);
      state.lastUrl = url;
    } catch (error) {
      log(`Mirror ${connected.label}: ${friendlyError(error)}`);
      await sleep(900);
    }
    await sleep(MIRROR_INTERVAL);
  }
  renderCanvas();
}

function stopMirror(serial: string): void {
  const state = mirrorStates.get(serial);
  if (!state) return;
  state.running = false;
  if (state.lastUrl) URL.revokeObjectURL(state.lastUrl);
  mirrorStates.delete(serial);
  frameImages.delete(serial);
  renderCanvas();
}

function updateVisiblePhoneFrames(serial: string, url: string): void {
  document.querySelectorAll<HTMLElement>(`.slide-element[data-element-id]`).forEach((node) => {
    const element = deck.slides.flatMap((slide) => slide.elements).find((item) => item.id === node.dataset.elementId);
    if (element?.type !== "phone" || element.deviceSerial !== serial) return;
    const screen = node.querySelector<HTMLElement>(".phone-screen");
    if (!screen) return;
    let image = screen.querySelector<HTMLImageElement>("img");
    if (!image) { image = new Image(); screen.innerHTML = ""; screen.append(image); }
    image.src = url;
    node.querySelector(".device-label")?.classList.add("live");
  });
}

async function ensureCurrentSlideMirrors(): Promise<void> {
  const serials = new Set(current().elements.flatMap((element) => element.type === "phone" && element.deviceSerial ? [element.deviceSerial] : []));
  await Promise.all([...serials].filter((serial) => connectedDevices.has(serial)).map(startMirror));
}

function drawBroadcastFrame(): void {
  const canvas = $("#broadcast-canvas") as HTMLCanvasElement;
  const width = SLIDE_WIDTH * BROADCAST_SCALE;
  const height = SLIDE_HEIGHT * BROADCAST_SCALE;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return;
  drawSlideToContext(context, current(), BROADCAST_SCALE);
}

function drawSlideToContext(context: CanvasRenderingContext2D, slide: Slide, scale = 1): void {
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, SLIDE_WIDTH, SLIDE_HEIGHT);
  for (const element of slide.elements) {
    if (element.type === "text") drawTextElement(context, element);
    else if (element.type === "phone") drawPhoneElement(context, element);
    else if (element.type === "image" || element.type === "canvas") drawImageElement(context, element);
    else if (element.type === "canva") drawCanvaElement(context, element);
    else drawShapeElement(context, element);
  }
}

function waitForDeckImage(src: string, timeoutMs = 8000): Promise<void> {
  const image = ensureDeckImage(src);
  if (image.complete && image.naturalWidth) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      image.removeEventListener("load", done);
      image.removeEventListener("error", done);
      clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(done, timeoutMs);
    image.addEventListener("load", done, { once: true });
    image.addEventListener("error", done, { once: true });
  });
}

async function waitForSlideImages(slide: Slide): Promise<void> {
  await Promise.all(slide.elements.flatMap((element) => element.type === "image" || element.type === "canvas" ? [waitForDeckImage(element.src)] : []));
}

function slideTextDigest(slide: Slide): string {
  return slide.elements
    .flatMap((element) => {
      if (element.type === "text") return [element.text];
      if (element.type === "shape" && element.text) return [element.text];
      if ((element.type === "image" || element.type === "canvas") && element.alt) return [element.alt];
      return [];
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isSlideBackgroundElement(element: SlideElement): boolean {
  return element.type === "shape"
    && element.shape === "rect"
    && element.x <= 2
    && element.y <= 2
    && element.w >= SLIDE_WIDTH - 4
    && element.h >= SLIDE_HEIGHT - 4;
}

function inferredImportFontSize(element: TextElement): number {
  const lines = Math.max(1, element.text.split("\n").length);
  const insetTop = element.insetTop ?? 3.6;
  const insetBottom = element.insetBottom ?? 3.6;
  const availableHeight = Math.max(8, element.h - insetTop - insetBottom);
  const heightSize = availableHeight / lines / (element.lineHeight || 1.12);
  const textLength = Math.max(1, element.text.replace(/\s+/g, " ").trim().length);
  const widthSize = element.w / Math.min(52, Math.max(10, textLength)) * 1.8;
  const base = Math.min(heightSize, widthSize || heightSize);
  return clamp(base, element.variant === "title" ? 18 : 10.5, element.variant === "title" ? 54 : 30);
}

let importTextMeasureContext: CanvasRenderingContext2D | null = null;

function measuredImportTextWidth(text: string, element: TextElement | ShapeElement, fontSize: number): number {
  if (!importTextMeasureContext) {
    importTextMeasureContext = document.createElement("canvas").getContext("2d");
  }
  const fallback = text.length * fontSize * 0.55;
  if (!importTextMeasureContext) return fallback;
  const italic = element.italic ? "italic " : "";
  const weight = element.bold ? "700 " : "400 ";
  importTextMeasureContext.font = `${italic}${weight}${fontSize}px ${element.fontFamily || "Arial"}`;
  return importTextMeasureContext.measureText(text).width || fallback;
}

function estimateImportTextLines(element: TextElement | ShapeElement, fontSize: number): number {
  const text = element.type === "shape" ? element.text || "" : element.text;
  const insetLeft = element.insetLeft ?? 7.2;
  const insetRight = element.insetRight ?? 7.2;
  const contentWidth = Math.max(12, element.w - insetLeft - insetRight);
  return text.split("\n").reduce((total, paragraph) => {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return total + 1;
    let lines = 1;
    let currentWidth = 0;
    for (const word of words) {
      const wordWidth = measuredImportTextWidth(`${word} `, element, fontSize);
      if (wordWidth > contentWidth) {
        lines += Math.max(0, Math.ceil(wordWidth / contentWidth) - 1);
        currentWidth = wordWidth % contentWidth;
      } else if (currentWidth > 0 && currentWidth + wordWidth > contentWidth) {
        lines += 1;
        currentWidth = wordWidth;
      } else {
        currentWidth += wordWidth;
      }
    }
    return total + lines;
  }, 0);
}

function expandImportTextBox(element: TextElement | ShapeElement): void {
  const text = element.type === "shape" ? element.text || "" : element.text;
  if (!text) return;
  const fontSize = element.fontSize || 12;
  const insetLeft = element.insetLeft ?? 7.2;
  const insetRight = element.insetRight ?? 7.2;
  const insetTop = element.insetTop ?? 3.6;
  const insetBottom = element.insetBottom ?? 3.6;
  const longestWord = text
    .split(/\s+/)
    .reduce((longest, word) => Math.max(longest, measuredImportTextWidth(word, element, fontSize)), 0);
  const neededWidth = Math.ceil(longestWord + insetLeft + insetRight + 6);
  element.w = Math.min(SLIDE_WIDTH - element.x, Math.max(element.w, neededWidth));
  const lines = estimateImportTextLines(element, fontSize);
  const lineHeight = element.lineHeight || 1.18;
  const neededHeight = Math.ceil(lines * fontSize * lineHeight + insetTop + insetBottom + 4);
  element.h = Math.min(SLIDE_HEIGHT - element.y, Math.max(element.h, neededHeight));
}

function normalizeImportOverlayElement(element: SlideElement): SlideElement | null {
  if (isSlideBackgroundElement(element)) return null;
  const clone = structuredClone(element);
  if (clone.type === "text") {
    if (!clone.fontSize || clone.fontSize < 7) clone.fontSize = inferredImportFontSize(clone);
    else if (clone.variant === "body") clone.fontSize = clamp(clone.fontSize, 10.5, 42);
    else clone.fontSize = clamp(clone.fontSize, 16, 64);
    expandImportTextBox(clone);
  }
  if (clone.type === "shape" && clone.text) {
    if (!clone.fontSize || clone.fontSize < 7) {
      const asText: TextElement = { ...clone, type: "text", variant: "body", text: clone.text };
      clone.fontSize = inferredImportFontSize(asText);
    } else {
      clone.fontSize = clamp(clone.fontSize, 10.5, 42);
    }
    expandImportTextBox(clone);
  }
  return clone;
}

function drawImportCanvasBackground(context: CanvasRenderingContext2D, slide: Slide, scale: number): void {
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, SLIDE_WIDTH, SLIDE_HEIGHT);
  for (const element of slide.elements) {
    if (isSlideBackgroundElement(element) && element.type === "shape") drawShapeElement(context, element);
  }
}

async function rasterizeDeckForImport(source: Deck): Promise<Deck> {
  const slides: Slide[] = [];
  for (const [index, slide] of source.slides.entries()) {
    await waitForSlideImages(slide);
    const canvas = document.createElement("canvas");
    const scale = 3;
    canvas.width = SLIDE_WIDTH * scale;
    canvas.height = SLIDE_HEIGHT * scale;
    const context = canvas.getContext("2d");
    if (!context) {
      slides.push(slide);
      continue;
    }
    drawImportCanvasBackground(context, slide, scale);
    const animation = slide.elements.find((element) => element.animation)?.animation || "";
    const textDigest = slideTextDigest(slide);
    const overlayElements = slide.elements
      .map(normalizeImportOverlayElement)
      .filter((element): element is SlideElement => Boolean(element));
    slides.push({
      id: slide.id || uid("slide"),
      name: slide.name || `Slide ${index + 1}`,
      section: slide.section || (index === 0 ? "Intro" : ""),
      transition: slide.transition || "",
      notes: slide.notes || "",
      elements: [{
        id: uid("canvas"),
        type: "canvas",
        x: 0,
        y: 0,
        w: SLIDE_WIDTH,
        h: SLIDE_HEIGHT,
        src: canvas.toDataURL("image/webp", 0.97),
        alt: textDigest || `Canvas slide ${index + 1}`,
        ...(animation ? { animation } : {}),
      }, ...overlayElements],
    });
  }
  return sanitizeDeck({ title: source.title, slides });
}

function drawTextElement(context: CanvasRenderingContext2D, element: TextElement): void {
  const size = element.fontSize || (element.variant === "title" ? 36 : 20);
  const insetLeft = element.insetLeft ?? 8;
  const insetRight = element.insetRight ?? 8;
  const insetTop = element.insetTop ?? 6;
  const lineHeight = element.lineHeight || 1.08;
  const innerX = element.x + insetLeft;
  const innerY = element.y + insetTop;
  const innerW = Math.max(1, element.w - insetLeft - insetRight);
  context.save();
  context.beginPath();
  context.rect(0, 0, SLIDE_WIDTH, SLIDE_HEIGHT);
  context.clip();
  context.fillStyle = readableCanvasTextColor(element.color, element.variant === "title" ? "#202124" : "#4a4f55");
  context.textBaseline = "top";
  context.textAlign = element.align || "left";
  context.font = canvasTextFont(element, size);
  const lines = wrapCanvasText(context, element.text, innerW);
  const textX = element.align === "center" ? innerX + innerW / 2 : element.align === "right" ? innerX + innerW : innerX;
  lines.forEach((line, index) => {
    const y = innerY + index * size * lineHeight;
    context.fillText(line, textX, y);
    if (element.underline) {
      const width = context.measureText(line).width;
      const startX = element.align === "center" ? textX - width / 2 : element.align === "right" ? textX - width : textX;
      context.beginPath();
      context.moveTo(startX, y + size * 0.92);
      context.lineTo(startX + width, y + size * 0.92);
      context.strokeStyle = context.fillStyle;
      context.lineWidth = Math.max(1, size / 18);
      context.stroke();
    }
  });
  context.restore();
}

function canvasTextFont(element: TextElement, size: number): string {
  const style = element.italic ? "italic " : "";
  const weight = element.bold || element.variant === "title" ? "600" : "400";
  return `${style}${weight} ${size}px ${canvasFontFamily(element.fontFamily)}`;
}

function canvasFontFamily(fontFamily?: string): string {
  if (!fontFamily) return "Inter, Segoe UI, Arial";
  const escaped = fontFamily.replace(/["\\]/g, "");
  return /[\s,]/.test(escaped) ? `"${escaped}", Inter, Segoe UI, Arial` : `${escaped}, Inter, Segoe UI, Arial`;
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (context.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    lines.push(line);
  }
  return lines;
}

function readableCanvasTextColor(color: string | undefined, fallback: string): string {
  const chosen = color || fallback;
  const hex = /^#([0-9a-f]{6})$/i.exec(chosen)?.[1];
  if (!hex) return chosen;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.92 ? "#202124" : chosen;
}

function drawImageElement(context: CanvasRenderingContext2D, element: ImageElement | CanvasElement): void {
  const image = ensureDeckImage(element.src);
  if (!image.complete || !image.naturalWidth) return;
  context.save();
  context.beginPath();
  context.rect(element.x, element.y, element.w, element.h);
  context.clip();
  context.drawImage(image, element.x, element.y, element.w, element.h);
  context.restore();
}

function drawCanvaElement(context: CanvasRenderingContext2D, element: CanvaElement): void {
  context.save();
  roundedRect(context, element.x, element.y, element.w, element.h, 16);
  const gradient = context.createLinearGradient(element.x, element.y, element.x + element.w, element.y + element.h);
  gradient.addColorStop(0, "#00c4cc");
  gradient.addColorStop(.55, "#7d2ae8");
  gradient.addColorStop(1, "#ff8b00");
  context.fillStyle = gradient;
  context.fill();
  context.fillStyle = "rgba(255,255,255,.18)";
  context.fillRect(element.x, element.y, element.w, element.h);
  context.fillStyle = "#ffffff";
  context.font = "700 28px Inter, Segoe UI, Arial";
  context.textAlign = "center";
  context.fillText(element.title || "Canva belum diekstrak", element.x + element.w / 2, element.y + element.h / 2 - 8);
  context.font = "500 13px Inter, Segoe UI, Arial";
  context.fillText("Export PPTX atau aktifkan worker ekstraksi ITS", element.x + element.w / 2, element.y + element.h / 2 + 22);
  context.restore();
}

function drawShapeElement(context: CanvasRenderingContext2D, element: ShapeElement): void {
  context.save();
  context.strokeStyle = element.stroke || "transparent";
  context.fillStyle = element.fill || "transparent";
  context.lineWidth = element.shape === "line" ? 3 : 1.5;
  if (element.shape === "ellipse") {
    context.beginPath();
    context.ellipse(element.x + element.w / 2, element.y + element.h / 2, Math.abs(element.w / 2), Math.abs(element.h / 2), 0, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  } else if (element.shape === "line") {
    context.beginPath();
    context.moveTo(element.x, element.y);
    context.lineTo(element.x + element.w, element.y + element.h);
    context.stroke();
  } else {
    context.fillRect(element.x, element.y, element.w, element.h);
    context.strokeRect(element.x, element.y, element.w, element.h);
  }
  if (element.text) drawTextElement(context, { ...element, type: "text", variant: "body", text: element.text });
  context.restore();
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number): void {
  context.beginPath();
  context.roundRect(x, y, w, h, Math.min(radius, w / 2, h / 2));
}

function drawPhoneElement(context: CanvasRenderingContext2D, element: PhoneElement): void {
  context.save();
  roundedRect(context, element.x, element.y, element.w, element.h, 28);
  context.fillStyle = "#101114";
  context.fill();
  const inset = 12;
  roundedRect(context, element.x + inset, element.y + inset, element.w - inset * 2, element.h - inset * 2, 21);
  context.clip();
  const image = element.deviceSerial ? frameImages.get(element.deviceSerial) : undefined;
  if (image?.complete && image.naturalWidth) {
    const targetW = element.w - inset * 2;
    const targetH = element.h - inset * 2;
    const ratio = Math.min(targetW / image.naturalWidth, targetH / image.naturalHeight);
    const w = image.naturalWidth * ratio;
    const h = image.naturalHeight * ratio;
    context.fillStyle = "#000";
    context.fillRect(element.x + inset, element.y + inset, targetW, targetH);
    context.drawImage(image, element.x + inset + (targetW - w) / 2, element.y + inset + (targetH - h) / 2, w, h);
  } else {
    context.fillStyle = "#101827";
    context.fillRect(element.x + inset, element.y + inset, element.w - inset * 2, element.h - inset * 2);
    context.fillStyle = "#c5cad3";
    context.font = "12px Inter, Segoe UI, Arial";
    context.textAlign = "center";
    context.fillText(element.deviceSerial ? "Menunggu frame ADB" : "Pilih perangkat USB", element.x + element.w / 2, element.y + element.h / 2);
  }
  context.restore();
}

async function togglePresentation(): Promise<void> {
  if (role !== "owner") {
    const fullscreen = document.fullscreenEnabled && !document.fullscreenElement
      ? document.documentElement.requestFullscreen().catch(() => undefined)
      : Promise.resolve();
    showAudience();
    await fullscreen;
    await tryLockLandscape();
    syncFullscreenButton();
    return;
  }
  if (presentationState.presenting) await stopPresentation(); else await startPresentation();
}

async function startPresentation(): Promise<void> {
  const fullscreen = document.fullscreenEnabled && !document.fullscreenElement
    ? document.documentElement.requestFullscreen().catch(() => undefined)
    : Promise.resolve();
  await waitForSlideImages(current());
  drawBroadcastFrame();
  const canvas = $("#broadcast-canvas") as HTMLCanvasElement;
  broadcastStream = canvas.captureStream(30);
  clearInterval(broadcastTimer);
  broadcastTimer = window.setInterval(drawBroadcastFrame, 100);
  presentationState = { currentSlide, presenting: true, presenterSession: firebaseUser.uid, updatedAt: Date.now() };
  if (!localMode) {
    await set(ref(db, `presentations/${projectId}/state`), presentationState);
    await remove(ref(db, `presentationRtc/${projectId}`)).catch(() => undefined);
  }
  const button = $("#present-button");
  button.classList.add("live");
  button.innerHTML = "<span>■</span><span>Hentikan</span>";
  await ensureCurrentSlideMirrors();
  showAudience();
  startPresenterCursorHeartbeat();
  await fullscreen;
  await tryLockLandscape();
  presenterRequestUnsubscribe?.();
  presenterRequestUnsubscribe = localMode ? null : onChildAdded(ref(db, `presentationRtc/${projectId}`), (snapshot) => {
    const request = snapshot.child("request").val() as { uid?: string } | null;
    if (request?.uid) void answerViewer(snapshot.key || "");
  });
  toast("Presentasi live dimulai. Link viewer akan menerima video peer-to-peer.");
}

async function stopPresentation(): Promise<void> {
  presentationState = { currentSlide, presenting: false, presenterSession: null, updatedAt: Date.now() };
  if (!localMode) await set(ref(db, `presentations/${projectId}/state`), presentationState);
  presenterRequestUnsubscribe?.();
  presenterRequestUnsubscribe = null;
  stopPresenterCursorHeartbeat();
  hidePresenceCursor();
  for (const [id] of presenterPeers) cleanupPresenterPeer(id);
  broadcastStream?.getTracks().forEach((track) => track.stop());
  broadcastStream = null;
  clearInterval(broadcastTimer);
  if (!localMode) await remove(ref(db, `presentationRtc/${projectId}`)).catch(() => undefined);
  const button = $("#present-button");
  button.classList.remove("live");
  button.innerHTML = "<span>▶</span><span>Presentasikan</span>";
  if (isAudienceOpen()) returnOwnerToEditorFromAudience();
  toast("Presentasi live dihentikan.");
}

async function publishSlideState(): Promise<void> {
  presenterSlide = currentSlide;
  presentationState.currentSlide = currentSlide;
  presentationState.updatedAt = Date.now();
  if (!localMode) await set(ref(db, `presentations/${projectId}/state`), presentationState);
  updatePresenceSlide();
  ensurePresenterCursorVisible(true);
  await ensureCurrentSlideMirrors();
  drawBroadcastFrame();
}

async function answerViewer(viewerId: string): Promise<void> {
  if (!viewerId || !broadcastStream || presenterPeers.has(viewerId)) return;
  const base = `presentationRtc/${projectId}/${viewerId}`;
  const peer = new RTCPeerConnection(RTC_CONFIG);
  const unsubscribers: Unsubscribe[] = [];
  presenterPeers.set(viewerId, { peer, unsubscribers });
  for (const track of broadcastStream.getTracks()) peer.addTrack(track, broadcastStream);
  peer.onicecandidate = (event) => { if (event.candidate) void push(ref(db, `${base}/presenterCandidates`), event.candidate.toJSON()); };
  peer.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(peer.connectionState)) cleanupPresenterPeer(viewerId);
  };
  unsubscribers.push(onChildAdded(ref(db, `${base}/viewerCandidates`), (snapshot) => { const candidate = snapshot.val(); if (candidate) void peer.addIceCandidate(candidate).catch(console.warn); }));
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await set(ref(db, `${base}/offer`), { type: offer.type, sdp: offer.sdp });
  unsubscribers.push(onValue(ref(db, `${base}/answer`), (snapshot) => {
    const answer = snapshot.val() as RTCSessionDescriptionInit | null;
    if (answer && !peer.currentRemoteDescription) void peer.setRemoteDescription(answer).catch(console.warn);
  }));
}

function cleanupPresenterPeer(viewerId: string): void {
  const value = presenterPeers.get(viewerId);
  if (!value) return;
  value.unsubscribers.forEach((unsubscribe) => unsubscribe());
  value.peer.close();
  presenterPeers.delete(viewerId);
}

async function connectViewerRtc(): Promise<void> {
  if (viewerPeer || role !== "viewer" || !followingPresenter) return;
  const viewerId = `${firebaseUser.uid.slice(0, 18)}_${crypto.randomUUID().slice(0, 8)}`;
  const base = `presentationRtc/${projectId}/${viewerId}`;
  const peer = new RTCPeerConnection(RTC_CONFIG);
  viewerPeer = peer;
  const video = $("#live-video") as HTMLVideoElement;
  const status = $("#audience-status");
  $("span:last-child", status).textContent = "Menghubungkan stream presenter...";
  peer.ontrack = (event) => {
    video.srcObject = event.streams[0];
    status.classList.add("live");
    $("span:last-child", status).textContent = "LIVE - peer-to-peer";
    syncAudienceMediaControls();
    const revealVideo = () => {
      if (!video.videoWidth && !video.videoHeight) return;
      video.removeAttribute("hidden");
      $("#audience-slide").setAttribute("hidden", "");
    };
    video.addEventListener("loadeddata", revealVideo, { once: true });
    video.addEventListener("playing", revealVideo, { once: true });
    void video.play().catch(() => undefined);
  };
  peer.onicecandidate = (event) => { if (event.candidate) void push(ref(db, `${base}/viewerCandidates`), event.candidate.toJSON()); };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === "failed") {
      $("span:last-child", status).textContent = "Koneksi P2P gagal - jaringan mungkin memerlukan TURN";
      status.classList.remove("live");
      video.setAttribute("hidden", "");
      $("#audience-slide").removeAttribute("hidden");
    }
  };
  await set(ref(db, `${base}/request`), { uid: firebaseUser.uid, name: participantName, createdAt: serverTimestamp() });
  await onDisconnect(ref(db, base)).remove();
  rtcViewerUnsubscribe = onValue(ref(db, `${base}/offer`), (snapshot) => {
    const offer = snapshot.val() as RTCSessionDescriptionInit | null;
    if (!offer || peer.currentRemoteDescription) return;
    void (async () => {
      await peer.setRemoteDescription(offer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await set(ref(db, `${base}/answer`), { type: answer.type, sdp: answer.sdp });
    })().catch(console.error);
  });
  runtimeUnsubscribers.push(onChildAdded(ref(db, `${base}/presenterCandidates`), (snapshot) => { const candidate = snapshot.val(); if (candidate) void peer.addIceCandidate(candidate).catch(console.warn); }));
}

function disconnectViewerRtc(): void {
  rtcViewerUnsubscribe?.();
  rtcViewerUnsubscribe = null;
  viewerPeer?.close();
  viewerPeer = null;
  const video = $("#live-video") as HTMLVideoElement;
  video.srcObject = null;
  video.setAttribute("hidden", "");
  syncAudienceMediaControls();
  $("#audience-slide").removeAttribute("hidden");
  const status = $("#audience-status");
  status.classList.remove("live");
  $("span:last-child", status).textContent = "Menunggu presenter…";
}

function openShareDialog(): void {
  if (role !== "owner") return;
  const token = getOrCreateEditorToken();
  ($("#viewer-link") as HTMLInputElement).value = buildUrl({ view: true });
  ($("#editor-link") as HTMLInputElement).value = buildUrl({ edit: token });
  ($("#share-dialog") as HTMLDialogElement).showModal();
}

async function copyInput(id: string, label: string): Promise<void> {
  const value = ($(`#${id}`) as HTMLInputElement).value;
  await navigator.clipboard.writeText(value);
  toast(`${label} disalin.`);
}

function safeFilename(value: string): string {
  return (value || "ITS Presentasi").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, "-").slice(0, 60) || "ITS-Presentasi";
}

function loadStandaloneImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Gagal memuat gambar ${src}`));
    image.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type = "image/png", quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Canvas tidak bisa dibuat menjadi gambar.")), type, quality);
  });
}

async function generatePresentationShareImageBlob(): Promise<Blob> {
  const slide = deck.slides[0] || defaultDeck().slides[0];
  await waitForSlideImages(slide);
  const width = 1200;
  const height = 630;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas share tidak tersedia.");
  const colors = sampleSlideColors(slide);
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, colors[0]);
  gradient.addColorStop(.48, colors[2]);
  gradient.addColorStop(1, colors[1]);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  context.fillStyle = "rgba(255,255,255,.08)";
  context.beginPath();
  context.arc(1040, 80, 220, 0, Math.PI * 2);
  context.fill();

  const slideW = 1000;
  const slideH = Math.round(slideW * 9 / 16);
  const slideX = Math.round((width - slideW) / 2);
  const slideY = 34;
  const slideCanvas = document.createElement("canvas");
  const slideScale = slideW / SLIDE_WIDTH;
  slideCanvas.width = slideW;
  slideCanvas.height = slideH;
  const slideContext = slideCanvas.getContext("2d");
  if (!slideContext) throw new Error("Canvas slide tidak tersedia.");
  drawSlideToContext(slideContext, slide, slideScale);
  context.save();
  context.shadowColor = "rgba(0,0,0,.26)";
  context.shadowBlur = 28;
  context.shadowOffsetY = 14;
  roundedRect(context, slideX, slideY, slideW, slideH, 18);
  context.fillStyle = "#ffffff";
  context.fill();
  context.restore();
  context.save();
  roundedRect(context, slideX, slideY, slideW, slideH, 18);
  context.clip();
  context.drawImage(slideCanvas, slideX, slideY, slideW, slideH);
  context.restore();

  const logo = await loadStandaloneImage("/its-presentasi.png").catch(() => null);
  if (logo) {
    const badge = 78;
    const badgeX = slideX + slideW - badge - 18;
    const badgeY = slideY + slideH - badge - 18;
    context.save();
    context.fillStyle = "rgba(255,255,255,.92)";
    roundedRect(context, badgeX, badgeY, badge, badge, 20);
    context.fill();
    context.drawImage(logo, badgeX + 15, badgeY + 8, badge - 30, badge - 16);
    context.restore();
  }

  return canvasToBlob(canvas, "image/png");
}

const QR_VERSION = 8;
const QR_SIZE = QR_VERSION * 4 + 17;
const QR_DATA_CODEWORDS = 194;
const QR_DATA_BLOCKS = 2;
const QR_DATA_PER_BLOCK = QR_DATA_CODEWORDS / QR_DATA_BLOCKS;
const QR_ECC_PER_BLOCK = 24;

function audienceShareUrl(): string {
  if (!projectId) return location.href;
  if (role === "editor" && editorToken) return buildUrl({ edit: editorToken });
  return buildUrl({ view: true });
}

function qrBitLength(value: number): number {
  return value === 0 ? 0 : 32 - Math.clz32(value);
}

function qrBchRemainder(value: number, poly: number): number {
  let result = value;
  const polyLength = qrBitLength(poly);
  while (qrBitLength(result) >= polyLength) result ^= poly << (qrBitLength(result) - polyLength);
  return result;
}

function qrFormatBits(mask: number): number {
  const data = (1 << 3) | mask; // Error correction level L.
  return ((data << 10) | qrBchRemainder(data << 10, 0x537)) ^ 0x5412;
}

function qrVersionBits(): number {
  return (QR_VERSION << 12) | qrBchRemainder(QR_VERSION << 12, 0x1f25);
}

function qrGfTables(): { exp: number[]; log: number[] } {
  const exp = new Array<number>(512).fill(0);
  const log = new Array<number>(256).fill(0);
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    exp[i] = x;
    log[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) exp[i] = exp[i - 255];
  return { exp, log };
}

const QR_GF = qrGfTables();

function qrGfMultiply(a: number, b: number): number {
  return a && b ? QR_GF.exp[QR_GF.log[a] + QR_GF.log[b]] : 0;
}

function qrReedSolomonGenerator(degree: number): number[] {
  let result = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(result.length + 1).fill(0);
    for (let j = 0; j < result.length; j += 1) {
      next[j] ^= result[j];
      next[j + 1] ^= qrGfMultiply(result[j], QR_GF.exp[i]);
    }
    result = next;
  }
  return result.slice(1);
}

const QR_RS_DIVISOR = qrReedSolomonGenerator(QR_ECC_PER_BLOCK);

function qrReedSolomonRemainder(data: number[]): number[] {
  const result = new Array<number>(QR_ECC_PER_BLOCK).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < QR_RS_DIVISOR.length; i += 1) result[i] ^= qrGfMultiply(QR_RS_DIVISOR[i], factor);
  }
  return result;
}

function qrDataCodewords(text: string): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  if (bytes.length > 190) throw new Error("Link terlalu panjang untuk QR cepat.");
  const bits: number[] = [];
  const appendBits = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  appendBits(0b0100, 4);
  appendBits(bytes.length, 8);
  bytes.forEach((byte) => appendBits(byte, 8));
  const capacity = QR_DATA_CODEWORDS * 8;
  appendBits(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((sum, bit) => (sum << 1) | bit, 0));
  for (let pad = 0; codewords.length < QR_DATA_CODEWORDS; pad += 1) codewords.push(pad % 2 ? 0x11 : 0xec);
  return codewords;
}

function qrAllCodewords(text: string): number[] {
  const data = qrDataCodewords(text);
  const blocks = Array.from({ length: QR_DATA_BLOCKS }, (_, index) => data.slice(index * QR_DATA_PER_BLOCK, (index + 1) * QR_DATA_PER_BLOCK));
  const ecc = blocks.map(qrReedSolomonRemainder);
  const result: number[] = [];
  for (let i = 0; i < QR_DATA_PER_BLOCK; i += 1) blocks.forEach((block) => result.push(block[i]));
  for (let i = 0; i < QR_ECC_PER_BLOCK; i += 1) ecc.forEach((block) => result.push(block[i]));
  return result;
}

function qrMask(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function qrPenalty(matrix: boolean[][]): number {
  let penalty = 0;
  const size = matrix.length;
  for (let y = 0; y < size; y += 1) {
    let runColor = matrix[y][0];
    let run = 1;
    for (let x = 1; x < size; x += 1) {
      if (matrix[y][x] === runColor) run += 1;
      else {
        if (run >= 5) penalty += 3 + run - 5;
        runColor = matrix[y][x];
        run = 1;
      }
    }
    if (run >= 5) penalty += 3 + run - 5;
  }
  for (let x = 0; x < size; x += 1) {
    let runColor = matrix[0][x];
    let run = 1;
    for (let y = 1; y < size; y += 1) {
      if (matrix[y][x] === runColor) run += 1;
      else {
        if (run >= 5) penalty += 3 + run - 5;
        runColor = matrix[y][x];
        run = 1;
      }
    }
    if (run >= 5) penalty += 3 + run - 5;
  }
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = matrix[y][x];
      if (color === matrix[y][x + 1] && color === matrix[y + 1][x] && color === matrix[y + 1][x + 1]) penalty += 3;
    }
  }
  const dark = matrix.flat().filter(Boolean).length;
  penalty += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return penalty;
}

function buildQrMatrix(text: string): boolean[][] {
  const matrix = Array.from({ length: QR_SIZE }, () => new Array<boolean>(QR_SIZE).fill(false));
  const reserved = Array.from({ length: QR_SIZE }, () => new Array<boolean>(QR_SIZE).fill(false));
  const setFunction = (x: number, y: number, dark: boolean) => {
    if (x < 0 || y < 0 || x >= QR_SIZE || y >= QR_SIZE) return;
    matrix[y][x] = dark;
    reserved[y][x] = true;
  };
  const drawFinder = (x: number, y: number) => {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const inside = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
        const dark = inside && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
        setFunction(x + dx, y + dy, dark);
      }
    }
  };
  const drawAlignment = (cx: number, cy: number) => {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) === 2 || (dx === 0 && dy === 0));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(QR_SIZE - 7, 0);
  drawFinder(0, QR_SIZE - 7);
  for (let i = 8; i < QR_SIZE - 8; i += 1) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }
  [6, 24, 42].forEach((x) => [6, 24, 42].forEach((y) => {
    if ((x === 6 && y === 6) || (x === 42 && y === 6) || (x === 6 && y === 42)) return;
    drawAlignment(x, y);
  }));
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      setFunction(8, i, false);
      setFunction(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    setFunction(QR_SIZE - 1 - i, 8, false);
    setFunction(8, QR_SIZE - 1 - i, false);
  }
  setFunction(8, QR_SIZE - 8, true);
  for (let i = 0; i < 18; i += 1) {
    setFunction(QR_SIZE - 11 + (i % 3), Math.floor(i / 3), false);
    setFunction(Math.floor(i / 3), QR_SIZE - 11 + (i % 3), false);
  }

  const codewords = qrAllCodewords(text);
  const bits = codewords.flatMap((byte) => Array.from({ length: 8 }, (_, index) => ((byte >>> (7 - index)) & 1) === 1));
  let bitIndex = 0;
  let upward = true;
  for (let right = QR_SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vert = 0; vert < QR_SIZE; vert += 1) {
      const y = upward ? QR_SIZE - 1 - vert : vert;
      for (let x = right; x >= right - 1; x -= 1) {
        if (reserved[y][x]) continue;
        matrix[y][x] = bits[bitIndex] || false;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }

  let best = matrix;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = matrix.map((row, y) => row.map((value, x) => reserved[y][x] ? value : value !== qrMask(mask, x, y)));
    const format = qrFormatBits(mask);
    for (let i = 0; i <= 5; i += 1) candidate[i][8] = ((format >>> i) & 1) !== 0;
    candidate[7][8] = ((format >>> 6) & 1) !== 0;
    candidate[8][8] = ((format >>> 7) & 1) !== 0;
    candidate[8][7] = ((format >>> 8) & 1) !== 0;
    for (let i = 9; i < 15; i += 1) candidate[8][14 - i] = ((format >>> i) & 1) !== 0;
    for (let i = 0; i < 8; i += 1) candidate[8][QR_SIZE - 1 - i] = ((format >>> i) & 1) !== 0;
    for (let i = 8; i < 15; i += 1) candidate[QR_SIZE - 15 + i][8] = ((format >>> i) & 1) !== 0;
    candidate[QR_SIZE - 8][8] = true;
    const version = qrVersionBits();
    for (let i = 0; i < 18; i += 1) {
      const dark = ((version >>> i) & 1) !== 0;
      candidate[Math.floor(i / 3)][QR_SIZE - 11 + (i % 3)] = dark;
      candidate[QR_SIZE - 11 + (i % 3)][Math.floor(i / 3)] = dark;
    }
    const penalty = qrPenalty(candidate);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      best = candidate;
    }
  }
  return best;
}

function createQrSvg(text: string): string {
  const matrix = buildQrMatrix(text);
  const size = matrix.length;
  const quiet = 4;
  const viewSize = size + quiet * 2;
  const path = matrix.flatMap((row, y) => row.map((dark, x) => dark ? `M${x + quiet} ${y + quiet}h1v1h-1z` : "")).join("");
  const logoSize = 9;
  const logo = (viewSize - logoSize) / 2;
  return `<svg viewBox="0 0 ${viewSize} ${viewSize}" role="img" aria-label="QR link presentasi" xmlns="http://www.w3.org/2000/svg">
    <rect width="${viewSize}" height="${viewSize}" rx="5" fill="#fff"/>
    <path d="${path}" fill="#111315"/>
    <rect x="${logo - 1.2}" y="${logo - 1.2}" width="${logoSize + 2.4}" height="${logoSize + 2.4}" rx="3" fill="#fff"/>
    <image href="/its-presentasi.png" x="${logo}" y="${logo - .3}" width="${logoSize}" height="${logoSize}" preserveAspectRatio="xMidYMid meet"/>
  </svg>`;
}

function renderAudienceSharePopover(): void {
  const popover = document.getElementById("audience-share-popover");
  const qr = document.getElementById("audience-share-qr");
  const link = document.getElementById("audience-share-link") as HTMLButtonElement | null;
  if (!popover || !qr || !link) return;
  const url = audienceShareUrl();
  link.textContent = url;
  link.title = "Klik untuk menyalin link";
  link.dataset.shareUrl = url;
  try {
    qr.innerHTML = createQrSvg(url);
  } catch {
    qr.textContent = "QR tidak tersedia untuk link ini.";
  }
  popover.removeAttribute("hidden");
}

async function shareAudiencePresentation(): Promise<void> {
  const url = audienceShareUrl();
  const title = deck.title || "ITS Presentasi";
  updatePresentationMetadata();
  const shareData: ShareData = { title, text: title, url };
  if ("share" in navigator) {
    try {
      const image = await generatePresentationShareImageBlob();
      const file = new File([image], `${safeFilename(title)}-preview.png`, { type: "image/png" });
      const fileShareData = { ...shareData, files: [file] } as ShareData;
      if (!("canShare" in navigator) || navigator.canShare?.(fileShareData)) {
        await navigator.share(fileShareData).catch((error) => {
          if (!String(error?.name || error).includes("Abort")) throw error;
        });
        return;
      }
    } catch (error) {
      console.warn("[ITS Presentasi] Share image fallback:", error);
    }
    const canShare = !("canShare" in navigator) || navigator.canShare?.(shareData);
    if (canShare) {
      await navigator.share(shareData).catch((error) => {
        if (!String(error?.name || error).includes("Abort")) throw error;
      });
      return;
    }
  }
  await navigator.clipboard.writeText(url);
  toast("Link viewer disalin.");
}

function downloadAudiencePresentation(): void {
  void downloadDeckPptx();
}

function syncAudienceMediaControls(): void {
  const video = $("#live-video") as HTMLVideoElement;
  const stream = video.srcObject instanceof MediaStream ? video.srcObject : null;
  const hasAudio = Boolean(stream && stream.getAudioTracks().length);
  $("#audience-volume-panel").toggleAttribute("hidden", !hasAudio);
  if (hasAudio) {
    const volume = $("#audience-volume") as HTMLInputElement;
    video.volume = Number(volume.value || 0.9);
    video.muted = video.volume <= 0;
    updateAudienceVolumeIcon();
  }
}

function updateAudienceVolume(): void {
  const video = $("#live-video") as HTMLVideoElement;
  const volume = Number(($("#audience-volume") as HTMLInputElement).value || 0);
  video.volume = clamp(volume, 0, 1);
  video.muted = video.volume <= 0;
  updateAudienceVolumeIcon();
}

function toggleAudienceMediaMute(): void {
  const video = $("#live-video") as HTMLVideoElement;
  const volume = $("#audience-volume") as HTMLInputElement;
  if (video.muted || Number(volume.value) <= 0) {
    volume.value = "0.9";
    video.muted = false;
    video.volume = 0.9;
  } else {
    volume.value = "0";
    video.muted = true;
    video.volume = 0;
  }
  updateAudienceVolumeIcon();
}

function updateAudienceVolumeIcon(): void {
  const video = $("#live-video") as HTMLVideoElement;
  const volume = Number(($("#audience-volume") as HTMLInputElement).value || 0);
  const muted = video.muted || volume <= 0;
  const waves = muted
    ? '<path d="m17 9 4 4m0-4-4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
    : volume < 0.4
      ? '<path d="M16.3 10.2c.6.5.9 1.1.9 1.8s-.3 1.3-.9 1.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
      : volume < 0.75
        ? '<path d="M16 8.5c1.2 1 1.9 2.2 1.9 3.5S17.2 14.6 16 15.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
        : '<path d="M16 8.5c1.2 1 1.9 2.2 1.9 3.5S17.2 14.6 16 15.5M18.5 6c1.9 1.6 3 3.6 3 6s-1.1 4.4-3 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
  ($("#audience-volume-button") as HTMLButtonElement).innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h4l5-4.2v13.4l-5-4.2H4Z" fill="currentColor"/>${waves}</svg>`;
}

async function deleteProject(id: string): Promise<void> {
  if (!id) return;
  try {
    if (localMode) {
      localStorage.removeItem(`its-presentasi-local:${id}`);
      const local = loadLocalSharedHistory();
      delete local[id];
      saveLocalSharedHistory(local);
      toast("Presentasi lokal dihapus.");
      if (projectId === id) setTimeout(() => { location.href = homeUrl(); }, 500);
      return;
    }
    const ownerSnapshot = await get(ref(db, `presentations/${id}/ownerUid`));
    const ownerUid = ownerSnapshot.exists() ? String(ownerSnapshot.val() || "") : "";
    if (!ownerUid) {
      await Promise.allSettled([
        remove(ref(db, `presentationUsers/${firebaseUser.uid}/projects/${id}`)),
        remove(ref(db, `presentationUsers/${firebaseUser.uid}/shared/${id}`)),
      ]);
      await removeSharedHistory(id);
      toast("Catatan presentasi dihapus dari histori. File asli sudah tidak ditemukan.");
      return;
    }
    if (ownerUid !== firebaseUser.uid) {
      await removeSharedHistory(id);
      toast("Dihapus dari histori Anda. File asli tetap milik owner.");
      return;
    }
    await Promise.allSettled([
      remove(ref(db, `presentationPresence/${id}`)),
      remove(ref(db, `presentationRtc/${id}`)),
      remove(ref(db, `presentationCollab/${id}`)),
      remove(ref(db, `presentationComments/${id}`)),
    ]);
    await remove(ref(db, `presentations/${id}`));
    await Promise.allSettled([
      remove(ref(db, `presentationUsers/${firebaseUser.uid}/projects/${id}`)),
      remove(ref(db, `presentationUsers/${firebaseUser.uid}/shared/${id}`)),
    ]);
    const local = loadLocalSharedHistory();
    delete local[id];
    saveLocalSharedHistory(local);
    localStorage.removeItem(`prezadb-edit-token:${firebaseUser.uid}:${id}`);
    toast("Presentasi dihapus permanen.");
    if (projectId === id) setTimeout(() => { location.href = homeUrl(); }, 500);
  } catch (error) {
    toast(`Gagal menghapus: ${friendlyError(error)}`);
  }
}

function cleanupProjectRuntime(): void {
  remoteUnsubscribe?.(); remoteUnsubscribe = null;
  presenceUnsubscribe?.(); presenceUnsubscribe = null;
  collaborationUnsubscribe?.(); collaborationUnsubscribe = null;
  commentsUnsubscribe?.(); commentsUnsubscribe = null;
  presenterRequestUnsubscribe?.(); presenterRequestUnsubscribe = null;
  runtimeUnsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
  activePresencePath = "";
  presenceSessionId = "";
  lastCursorPoint = null;
  joinedSharedProject = false;
  activeComments = [];
  activeCommentElementId = "";
  clearInterval(presenceTimer);
  clearInterval(broadcastTimer);
  clearInterval(presenterCursorTimer);
  presenterCursorTimer = 0;
}

async function handleDroppedFiles(fileList: FileList | File[]): Promise<void> {
  const files = Array.from(fileList);
  if (!files.length) return;
  const pptx = files.find((file) => /\.(pptx|ppt|pdf)$/i.test(file.name));
  if (pptx) { await importPresentationFile(pptx); return; }
  for (const image of files.filter((file) => file.type.startsWith("image/"))) await addImageFile(image);
}

function bindFileDrop(): void {
  const overlay = $("#drop-overlay");
  let dragDepth = 0;
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types || []).includes("Files");
  const show = (event: DragEvent) => {
    if (!isEditableRole() || !hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    overlay.removeAttribute("hidden");
  };
  const hide = () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) overlay.setAttribute("hidden", "");
  };
  document.addEventListener("dragenter", show);
  document.addEventListener("dragover", (event) => {
    if (!isEditableRole() || !hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", hide);
  document.addEventListener("drop", (event) => {
    if (!isEditableRole() || !hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    overlay.setAttribute("hidden", "");
    if (event.dataTransfer?.files) void handleDroppedFiles(event.dataTransfer.files);
  });
}

function bindSwipeRightToClose(target: HTMLElement, close: () => void): void {
  let pointerId = -1;
  let startX = 0;
  let startY = 0;
  let dragging = false;
  const audienceView = () => document.getElementById("audience-view");
  const reset = () => {
    target.style.transition = "";
    target.style.transform = "";
    target.style.opacity = "";
    audienceView()?.style.removeProperty("--rail-swipe-offset");
  };
  const closeWithAnimation = () => {
    target.style.transition = "transform .2s ease, opacity .2s ease";
    target.style.transform = "translateX(110%)";
    target.style.opacity = "0";
    if (isAudienceOpen() && target.classList.contains("audience-rail-dialog")) audienceView()?.style.setProperty("--rail-swipe-offset", "420px");
    window.setTimeout(() => {
      close();
      reset();
    }, 205);
  };
  target.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("input, textarea, select, button, a")) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    dragging = true;
    target.style.transition = "none";
    target.setPointerCapture?.(event.pointerId);
  });
  target.addEventListener("pointermove", (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    const dx = Math.max(0, event.clientX - startX);
    const dy = Math.abs(event.clientY - startY);
    if (dx > 4 && dy < 90) {
      event.preventDefault();
      target.style.transform = `translateX(${dx}px)`;
      target.style.opacity = String(Math.max(0.45, 1 - dx / 420));
      if (isAudienceOpen() && target.classList.contains("audience-rail-dialog")) {
        audienceView()?.style.setProperty("--rail-swipe-offset", `${Math.min(dx, 420)}px`);
      }
    }
  });
  target.addEventListener("pointerup", (event) => {
    if (event.pointerId !== pointerId) return;
    const dx = event.clientX - startX;
    const dy = Math.abs(event.clientY - startY);
    dragging = false;
    pointerId = -1;
    target.releasePointerCapture?.(event.pointerId);
    if (dx > 86 && dy < 70) closeWithAnimation();
    else reset();
  });
  target.addEventListener("pointercancel", () => {
    dragging = false;
    pointerId = -1;
    reset();
  });
}

function bindSwipeDownToClose(target: HTMLElement, close: () => void): void {
  let pointerId = -1;
  let startY = 0;
  let startX = 0;
  let dragging = false;
  const reset = () => {
    target.style.transition = "";
    target.style.transform = "";
    target.style.opacity = "";
  };
  target.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("input, textarea, select, button, a")) return;
    pointerId = event.pointerId;
    startY = event.clientY;
    startX = event.clientX;
    dragging = true;
    target.style.transition = "none";
    target.setPointerCapture?.(event.pointerId);
  });
  target.addEventListener("pointermove", (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    const dy = Math.max(0, event.clientY - startY);
    const dx = Math.abs(event.clientX - startX);
    if (dy > 5 && dx < 90) {
      event.preventDefault();
      target.style.transform = `translateY(${dy}px)`;
      target.style.opacity = String(Math.max(0.45, 1 - dy / 360));
    }
  });
  target.addEventListener("pointerup", (event) => {
    if (event.pointerId !== pointerId) return;
    const dy = event.clientY - startY;
    const dx = Math.abs(event.clientX - startX);
    dragging = false;
    pointerId = -1;
    target.releasePointerCapture?.(event.pointerId);
    if (dy > 86 && dx < 70 && (isCompactAudienceLayout() || !isAudienceOpen())) {
      target.style.transition = "transform .2s ease, opacity .2s ease";
      target.style.transform = "translateY(110%)";
      target.style.opacity = "0";
      window.setTimeout(() => { close(); reset(); }, 205);
    } else reset();
  });
  target.addEventListener("pointercancel", () => {
    dragging = false;
    pointerId = -1;
    reset();
  });
}

function bindElasticSwipe(target: HTMLElement): void {
  let startX = 0;
  let startY = 0;
  let dragging = false;
  const reset = () => {
    target.style.transition = "transform .22s ease, opacity .22s ease";
    target.style.transform = "";
    target.style.opacity = "";
    window.setTimeout(() => { target.style.transition = ""; }, 230);
  };
  target.addEventListener("pointerdown", (event) => {
    if (!(event.target as HTMLElement).closest(".join-handle")) return;
    startX = event.clientX;
    startY = event.clientY;
    dragging = true;
    target.style.transition = "none";
    target.setPointerCapture?.(event.pointerId);
  });
  target.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    const compact = matchMedia("(max-width: 760px)").matches;
    const translate = compact ? Math.max(0, dy) : Math.max(0, dx);
    if (!translate) return;
    target.style.transform = compact ? `translateY(${Math.min(translate, 86)}px)` : `translateX(${Math.min(translate, 120)}px)`;
    target.style.opacity = String(Math.max(0.72, 1 - translate / 520));
  });
  target.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    reset();
  });
  target.addEventListener("pointercancel", () => {
    dragging = false;
    reset();
  });
}

function openLegalDialog(kind: "terms" | "privacy"): void {
  $("#legal-title").textContent = kind === "terms" ? "Ketentuan Layanan" : "Kebijakan Privasi";
  $("#legal-body").innerHTML = kind === "terms"
    ? `<p>ITS Presentasi digunakan untuk membuat, mengimpor, membagikan, dan mempresentasikan dokumen secara realtime.</p><h3>Akun</h3><p>Anda dapat masuk sebagai Anonymous atau Google. Pemilik bertanggung jawab atas link editor dan viewer yang dibagikan.</p><h3>Konten</h3><p>Jangan mengunggah materi yang melanggar hukum, hak cipta, atau privasi pihak lain. Komentar kolaborasi terlihat oleh orang yang memiliki akses ke presentasi.</p><h3>ADB</h3><p>Fitur WebUSB ADB hanya berjalan setelah izin perangkat diberikan di browser dan digunakan untuk kebutuhan mockup/mirror presentasi.</p>`
    : `<p>ITS Presentasi menyimpan data yang diperlukan untuk menjalankan fitur realtime: identitas masuk, nama tampilan, histori project, slide, komentar, presence, dan posisi pointer.</p><h3>Penyimpanan</h3><p>Data project dan komentar tersimpan di Firebase Realtime Database. Preferensi seperti nama dan histori share juga dapat tersimpan di browser agar Anda tidak perlu masuk ulang.</p><h3>Kontrol</h3><p>Pemilik dapat menghapus project. Viewer dapat menghapus histori share dari halaman depan tanpa menghapus project asli.</p>`;
  ($("#legal-dialog") as HTMLDialogElement).showModal();
}

async function handleHubGoogleLogin(): Promise<void> {
  await signInWithGoogleAccount();
  await showProjectHub();
}

function bindUi(): void {
  $("#create-project").addEventListener("click", () => void createProject().catch((error) => toast(friendlyError(error))));
  $("#hub-google-login").addEventListener("click", () => void handleHubGoogleLogin().catch((error) => toast(friendlyError(error))));
  $("#owner-google-login").addEventListener("click", () => void signInWithGoogleAccount().catch((error) => toast(friendlyError(error))));
  $("#refresh-shared-projects").addEventListener("click", () => void renderSharedProjects(latestSharedRecords));
  document.querySelectorAll<HTMLElement>("[data-template]").forEach((button) => {
    button.addEventListener("click", () => void createProject(button.dataset.template || "").catch((error) => toast(friendlyError(error))));
  });
  $("#back-home").addEventListener("click", () => { location.href = homeUrl(); });
  $("#add-slide").addEventListener("click", addSlide);
  $("#add-slide-bottom").addEventListener("click", addSlide);
  $("#add-title").addEventListener("click", () => addText("title"));
  $("#add-text").addEventListener("click", () => addText("body"));
  $("#add-phone").addEventListener("click", addPhone);
  $("#delete-element").addEventListener("click", deleteSelected);
  $("#delete-from-properties").addEventListener("click", deleteSelected);
  $("#undo").addEventListener("click", undo);
  $("#redo").addEventListener("click", redo);
  $("#deck-title").addEventListener("input", () => { deck.title = ($("#deck-title") as HTMLInputElement).value; scheduleSave(); });
  $("#deck-title").addEventListener("blur", recordHistory);
  $("#speaker-note").addEventListener("input", () => { current().notes = ($("#speaker-note") as HTMLInputElement).value; scheduleSave(); });
  $("#speaker-note").addEventListener("blur", recordHistory);
  for (const id of ["prop-x", "prop-y", "prop-w", "prop-h", "prop-text"]) $(`#${id}`).addEventListener("input", updateProperties);
  $("#device-select").addEventListener("change", () => assignDevice(($("#device-select") as HTMLSelectElement).value));
  $("#connect-usb").addEventListener("click", () => void requestUsbDevice());
  $("#refresh-usb").addEventListener("click", () => void refreshUsbDevices());
  $("#diagnose-usb").addEventListener("click", () => void diagnoseUsb());
  $("#start-mirror").addEventListener("click", () => void startSelectedMirror());
  $("#stop-mirror").addEventListener("click", () => { const element = selected(); if (element?.type === "phone" && element.deviceSerial) stopMirror(element.deviceSerial); });
  $("#present-button").addEventListener("click", () => void togglePresentation());
  $("#share-button").addEventListener("click", openShareDialog);
  $("#presence-button").addEventListener("click", openPeopleDialog);
  $("#comment-alert").addEventListener("click", openFirstUnresolvedComment);
  $("#join-google").addEventListener("click", () => {
    const googleRadio = document.querySelector<HTMLInputElement>('input[name="join-auth"][value="google"]');
    if (googleRadio) googleRadio.checked = true;
    void signInWithGoogleAccount()
      .then(() => { ($("#join-name") as HTMLInputElement).value = participantName; })
      .catch((error) => toast(friendlyError(error)));
  });
  $("#open-terms").addEventListener("click", () => openLegalDialog("terms"));
  $("#open-privacy").addEventListener("click", () => openLegalDialog("privacy"));
  $("#join-card").addEventListener("submit", (event) => {
    event.preventDefault();
    void enterSharedProject().catch((error) => toast(friendlyError(error)));
  });
  $("#join-more-button").addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = $("#join-more-menu");
    const nextOpen = menu.hasAttribute("hidden");
    menu.toggleAttribute("hidden", !nextOpen);
    $("#join-more-button").setAttribute("aria-expanded", String(nextOpen));
  });
  $("#join-share-action").addEventListener("click", () => {
    $("#join-more-menu").setAttribute("hidden", "");
    $("#join-more-button").setAttribute("aria-expanded", "false");
    void shareAudiencePresentation().catch((error) => toast(friendlyError(error)));
  });
  $("#join-download-action").addEventListener("click", () => {
    $("#join-more-menu").setAttribute("hidden", "");
    $("#join-more-button").setAttribute("aria-expanded", "false");
    downloadAudiencePresentation();
  });
  $("#pptx-input").addEventListener("change", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) void importPresentationFile(file);
  });
  $("#image-input").addEventListener("change", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) void addImageFile(file);
  });
  $("#copy-viewer").addEventListener("click", () => void copyInput("viewer-link", "Link viewer"));
  $("#copy-editor").addEventListener("click", () => void copyInput("editor-link", "Link editor"));
  $("#send-comment").addEventListener("click", () => void submitComment().catch((error) => toast(friendlyError(error))));
  $("#comment-action-add").addEventListener("click", submitCommentActionSheet);
  $("#replace-comment-image").addEventListener("click", () => {
    pendingReplaceImageElementId = activeCommentElementId;
    ($("#image-input") as HTMLInputElement).click();
  });
  $("#canva-open-link").addEventListener("click", openCanvaSourceWindow);
  $("#canva-start-capture").addEventListener("click", () => void startCanvaScreenCapture().catch((error) => toast(`Capture Canva gagal: ${friendlyError(error)}`)));
  $("#canva-capture-now").addEventListener("click", () => void captureCanvaFrame(true).catch((error) => toast(`Capture frame gagal: ${friendlyError(error)}`)));
  $("#canva-stop-capture").addEventListener("click", () => {
    stopCanvaCapture();
    updateCanvaCaptureStatus(`${canvaCaptureSlides.length} slide gambar tertangkap.`);
  });
  $("#canva-finish-import").addEventListener("click", () => void finishCanvaCaptureImport().catch((error) => toast(`Import Canva gagal: ${friendlyError(error)}`)));
  ($("#canva-capture-dialog") as HTMLDialogElement).addEventListener("close", stopCanvaCapture);
  $("#rotate-editor-link").addEventListener("click", () => {
    const token = getOrCreateEditorToken(true);
    ($("#editor-link") as HTMLInputElement).value = buildUrl({ edit: token });
    startOwnerCollaborationListener();
    toast("Link editor lama dinonaktifkan pada aplikasi pemilik ini.");
  });
  $("#confirm-delete").addEventListener("click", () => void deleteProject(deleteTarget));
  $("#audience-fullscreen").addEventListener("click", () => void toggleAudienceFullscreen());
  $("#audience-share-action").addEventListener("click", () => void shareAudiencePresentation().catch((error) => toast(friendlyError(error))));
  $("#audience-share-action").addEventListener("pointerenter", renderAudienceSharePopover);
  $("#audience-share-action").addEventListener("focus", renderAudienceSharePopover);
  $("#audience-share-link").addEventListener("click", async (event) => {
    event.preventDefault();
    const value = ($("#audience-share-link") as HTMLButtonElement).dataset.shareUrl || audienceShareUrl();
    await navigator.clipboard.writeText(value);
    toast("Link presentasi disalin.");
  });
  $("#audience-download-action").addEventListener("click", downloadAudiencePresentation);
  $("#audience-volume-button").addEventListener("click", toggleAudienceMediaMute);
  $("#audience-volume").addEventListener("input", updateAudienceVolume);
  $("#audience-live-toggle").addEventListener("click", returnToLiveSlide);
  $("#audience-segment-button").addEventListener("click", () => {
    renderSegmentDialog();
    openAudienceRailDialog($("#segment-dialog") as HTMLDialogElement);
  });
  $("#audience-next").addEventListener("click", () => goToAudienceSlide(Math.min(currentSlide + 1, deck.slides.length - 1)));
  $("#audience-people-button").addEventListener("click", openPeopleDialog);
  $("#audience-view").addEventListener("pointerdown", showAudienceChrome);
  $("#audience-stage").addEventListener("click", handleAudienceStageClick);
  $("#slide-canvas").addEventListener("pointermove", (event) => updatePointerFromSurface(event, $("#slide-canvas")));
  $("#slide-canvas").addEventListener("pointerleave", hidePresenceCursor);
  $("#audience-stage").addEventListener("pointermove", (event) => updatePointerFromSurface(event, $("#audience-stage")));
  $("#audience-stage").addEventListener("pointerleave", hidePresenceCursor);
  bindSurfaceCommentInteractions($("#slide-canvas"));
  bindSurfaceCommentInteractions($("#audience-stage"));
  bindAudienceStageGestures($("#audience-stage"));
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  ($("#people-dialog") as HTMLDialogElement).addEventListener("close", syncAudienceRailState);
  ($("#segment-dialog") as HTMLDialogElement).addEventListener("close", syncAudienceRailState);
  ($("#comment-dialog") as HTMLDialogElement).addEventListener("close", syncAudienceRailState);
  document.querySelectorAll<HTMLElement>(".inspector-tabs button").forEach((button) => button.addEventListener("click", () => switchInspector(button.dataset.tab === "properties" ? "properties" : "device")));
  bindSwipeRightToClose($("#inspector"), () => switchInspector("properties"));
  bindSwipeRightToClose($("#people-dialog"), () => ($("#people-dialog") as HTMLDialogElement).close());
  bindSwipeRightToClose($("#segment-dialog"), () => ($("#segment-dialog") as HTMLDialogElement).close());
  bindSwipeRightToClose($("#comment-dialog"), () => ($("#comment-dialog") as HTMLDialogElement).close());
  bindSwipeDownToClose($("#comment-action-sheet"), () => ($("#comment-action-sheet") as HTMLDialogElement).close());
  bindSwipeDownToClose($("#legal-dialog"), () => ($("#legal-dialog") as HTMLDialogElement).close());
  bindElasticSwipe($("#join-card"));
  document.querySelectorAll<HTMLElement>("[data-menu]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    openMenu(button);
  }));
  document.addEventListener("click", () => { closeMenu(); closeSlideContextMenu(); closeElementContextMenu(); $("#join-more-menu").setAttribute("hidden", ""); $("#join-more-button").setAttribute("aria-expanded", "false"); });
  ($("#zoom-select") as HTMLSelectElement).addEventListener("change", () => {
    const value = ($("#zoom-select") as HTMLSelectElement).value;
    setZoom(value === "fit" ? fitZoom : Number(value), value === "fit");
  });
  $("#zoom-in").addEventListener("click", () => { ($("#zoom-select") as HTMLSelectElement).value = String(Math.min(1.25, Math.round((zoom + .25) * 100) / 100)); setZoom(zoom + .1); });
  $("#zoom-out").addEventListener("click", () => { ($("#zoom-select") as HTMLSelectElement).value = "0.75"; setZoom(zoom - .1); });
  addEventListener("resize", () => { fitWorkspace(); resizeAudienceSlide(); });
  addEventListener("keydown", (event: KeyboardEvent) => {
    const editing = ["INPUT", "TEXTAREA"].includes((event.target as HTMLElement)?.tagName) || (event.target as HTMLElement)?.isContentEditable;
    if (!editing && event.key === "Delete" && !event.shiftKey) {
      event.preventDefault();
      selectedElementId ? deleteSelected() : deleteCurrentSlide();
    }
    if (!editing && event.key === "Delete" && event.shiftKey) deleteCurrentSlide();
    if (!editing && event.ctrlKey && event.key.toLowerCase() === "d") { event.preventDefault(); duplicateSlide(); }
    if (!editing && event.ctrlKey && event.key.toLowerCase() === "m") { event.preventDefault(); addSlide(); }
    if (!editing && event.ctrlKey && event.key.toLowerCase() === "b") { event.preventDefault(); applySelectedTextFormat("bold"); }
    if (!editing && event.ctrlKey && event.key.toLowerCase() === "i") { event.preventDefault(); applySelectedTextFormat("italic"); }
    if (!editing && event.ctrlKey && event.key.toLowerCase() === "u") { event.preventDefault(); applySelectedTextFormat("underline"); }
    if (!editing && event.ctrlKey && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
    if (!editing && event.key === "Escape") {
      if (isAudienceOpen()) void leaveAudienceView();
      else closeMenu();
    }
    if (!editing && isAudienceOpen() && ["ArrowRight", "PageDown", " "].includes(event.key)) { event.preventDefault(); audienceStep(1); }
    if (!editing && isAudienceOpen() && ["ArrowLeft", "PageUp", "Backspace"].includes(event.key)) { event.preventDefault(); audienceStep(-1); }
  });
  const webUsb = (navigator as unknown as { usb?: BrowserUsbApi }).usb;
  if (webUsb) {
    webUsb.addEventListener("connect", () => log("Perangkat USB terdeteksi. Klik Refresh izin untuk menghubungkan."));
    webUsb.addEventListener("disconnect", (event: BrowserUsbConnectionEvent) => {
      for (const [serial, value] of connectedDevices) if (value.device.raw === event.device) disconnectAdbDevice(serial);
    });
  }
  addEventListener("beforeunload", () => {
    cleanupProjectRuntime();
    for (const serial of mirrorStates.keys()) stopMirror(serial);
  });
  bindFileDrop();
}

registerPresentationServiceWorker();
bindUi();
void boot();
