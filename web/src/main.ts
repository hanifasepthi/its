import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-rotate";
import "./style.css";
import "./mapLegend";
import WIN_PREVIEW_WELCOME from "./windows/welcome.png";
import WIN_PREVIEW_OPTIONS from "./windows/pilihopsiinstaller.png";
import WIN_PREVIEW_DONE from "./windows/selesaiinstaller.png";
import ITS_APP_ICON from "./icon/its.png";
import ITS_APP_ICON_SMALL from "./icon/its-small.webp";
import WELCOME_SEGMENT from "./image/welcomsegment.png";
import {
  drawRfDetrDetections,
  loadImageSource,
  publishBrowserRfDetrResult,
  RF_DETR_ANDROID_MODEL_ID,
  runBrowserRfDetr,
  type BrowserRfDetrDetection,
  type BrowserRfDetrResult,
} from "./browserRfDetr";
import { publicResearchAgent } from "./publicResearchAgent";
import { agentOrchestrator } from "./agent-core/AgentOrchestrator";
import type { DynamicAgentPlan } from "./agent-core/AgentPlanSchema";
import { mountAgentLiveActivity } from "./agentLiveActivity";
import { cloudflareAiClient } from "./ai-runtime/CloudflareAiClient";
import { disablePublicPush, enablePublicPush, publicPushOptedIn, restorePublicPush } from "./pushNotifications";
import {
  fetchMicrosoftStorePublicSnapshot,
  queryItsWindowsAppInstallation,
  type MicrosoftStorePublicSnapshot,
} from "./deviceApps";
import { mapDetailCache } from "./map-detail/MapDetailCache";
import { MapDynamicsLeafletRenderer } from "./map-detail/MapDynamicsLeafletRenderer";
import { nationalVectorStyle } from "./map-detail/NationalVectorArchive";
import {
  detailGroupsForZoom,
  EMPTY_MAP_DETAIL_COLLECTION,
  ensureMapDetailStyle,
  setMapDetailData,
  type MapDetailFeatureCollection,
} from "./map-detail/MapDetailStyle";
import {
  stitchTransitMemberPaths,
  verifyTransitEndpoint,
  type TransitEndpointMemberCandidate,
  type VerifiedTransitEndpoint,
} from "./map-detail/TransitRelationSemantics";
import {
  poiIconAssetUrl,
  poiIconById,
  resolvePoiIcon,
  type PoiIconDefinition,
} from "./poi/PoiIconRegistry";

// Navigation 3D pulls in MapLibre and Three.js. Keep that renderer outside the
// critical startup bundle so the map shell and controls can paint first.
function scheduleNavigation3D(): void {
  const load = () => {
    void import("./navigation3d/bootstrap").catch((error: unknown) => {
      console.error("ITS Maps 3D navigation failed to initialize", error);
    });
  };

  if (document.readyState === "complete") {
    window.setTimeout(load, 1_500);
    return;
  }

  window.addEventListener("load", () => window.setTimeout(load, 1_500), { once: true });
}

scheduleNavigation3D();

type ItsWebMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  execute: (input: Record<string, unknown>) => unknown | Promise<unknown>;
};

type ItsWebMcpModelContext = {
  registerTool: (
    tool: ItsWebMcpTool,
    options?: Record<string, unknown>,
  ) => void | Promise<void>;
};

type ItsWebMcpHost = {
  modelContext?: ItsWebMcpModelContext;
};

const APP_SCREENSHOT_MODULES = import.meta.glob("./ss/**/*.{png,jpg,jpeg,webp,avif,svg}", {
  eager: true,
  import: "default",
}) as Record<string, string>;

const PROFILE_ASSET_MODULES = import.meta.glob("./profil/*.{png,jpg,jpeg,webp,avif}", {
  eager: true,
  import: "default",
}) as Record<string, string>;

function profileAssetUrl(index: number): string {
  return Object.entries(PROFILE_ASSET_MODULES)
    .sort(([a], [b]) => a.localeCompare(b))
    .at(index)?.[1] || ITS_APP_ICON;
}

function escapeMapServiceHtml(v: string): string {
  return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

const FREE_MAP_SERVICE_STACK = [
  ["CARTO Voyager", "Peta dasar raster untuk mode 2D/street.", "https://carto.com/attributions"],
  ["OpenStreetMap", "Sumber data jalan, bangunan, POI, rel, sungai, dan fasilitas publik (ODbL).", "https://www.openstreetmap.org/copyright"],
  ["OpenFreeMap", "Peta vektor OpenMapTiles/OpenStreetMap untuk mode 3D.", "https://openfreemap.org/"],
  ["Esri World Imagery", "Peta dasar untuk mode satelit.", "https://www.esri.com/en-us/legal/terms/full-master-agreement"],
  ["Overpass API", "Pengambilan fitur OpenStreetMap berdasarkan viewport.", "https://overpass-api.de/"],
  ["OSRM Project", "Perhitungan rute berbasis data OpenStreetMap.", "https://project-osrm.org/docs/v26.6.1/nodejs/api"],
  ["MapLibre GL JS", "Renderer vektor untuk mode 3D dan label sepanjang geometri.", "https://maplibre.org/"],
  ["Leaflet", "Renderer interaktif untuk peta 2D dan overlay ITS Maps.", "https://leafletjs.com/"],
] as const;

const AI_SERVICE_STACK = [
  ["RF-DETR", "Deteksi objek COCO pada video/snapshot browser dengan model transformer ONNX dari Hugging Face.", "https://hf.co/onnx-community/rfdetr_medium-ONNX"],
  ["SmolLM2 135M Instruct", "Model bahasa ONNX q4 yang berjalan lokal di browser untuk memahami pertanyaan bebas tanpa mengirim percakapan ke layanan AI eksternal.", "https://huggingface.co/onnx-community/SmolLM2-135M-Instruct-ONNX"],
  ["Qwen2.5 0.5B Instruct", "Model riset ONNX q4 lokal yang menyusun ringkasan hanya dari bukti hasil pencarian terstruktur.", "https://huggingface.co/onnx-community/Qwen2.5-0.5B-Instruct"],
  ["Crossref, OpenAlex, Europe PMC", "Indeks metadata ilmiah publik untuk judul, penulis, DOI, abstrak, sitasi, dan tautan open-access. ITS Maps tidak mengunggah PDF jurnal.", "https://www.crossref.org/documentation/retrieve-metadata/rest-api/"],
  ["Wikipedia dan Wikimedia Commons", "Pencarian konteks web dan gambar terbuka dengan URL sumber serta atribusi lisensi yang ditampilkan pada jawaban.", "https://www.mediawiki.org/wiki/API:Cross-site_requests"],
  ["Transformers.js", "Pipeline object-detection RF-DETR di browser, termasuk preprocessing dan postprocessing bounding box.", "https://huggingface.co/docs/transformers.js"],
  ["ONNX Runtime Web", "Runtime inference ONNX di browser untuk RF-DETR dan fallback model lokal.", "https://onnxruntime.ai/docs/"],
  ["Transformers.js / Hugging Face", "Dipakai untuk fitur vision peta eksperimental yang membaca segmentasi visual saat mode CV peta diaktifkan.", "https://huggingface.co/docs/transformers.js"],
] as const;

const PRIVACY_INFO_STACK = [
  ["Data realtime", "ITS Maps menampilkan status Raspberry Pi, lampu lalu lintas, jumlah kendaraan, lokasi perangkat, marker user jika diizinkan, dan snapshot kamera/AI.", "https://itstelkom.web.app/privacy"],
  ["Izin lokasi", "Lokasi user hanya dipakai setelah user memberi izin dari browser, Android, atau Windows. Izin dapat dicabut dari pengaturan perangkat.", "https://itstelkom.web.app/privacy#location"],
  ["Kamera dan AI", "Snapshot/stream dipakai untuk object detection dan ringkasan kendaraan. Hasil yang ditampilkan berupa bbox, label, confidence, dan timestamp.", "https://itstelkom.web.app/privacy#camera"],
  ["Firebase RTDB", "Firebase Realtime Database dipakai untuk sinkronisasi status perangkat, grafik, widget, dan data operasional lintas platform.", "https://itstelkom.web.app/privacy#firebase"],
] as const;

const APP_LICENSE_INFO_STACK = [
  ["ITS Maps application", "Aplikasi, dokumentasi, dan aset ITS Maps dipublikasikan oleh Hanifa Teams untuk dashboard peta, kamera, AI, Android APK, Windows app, dan PWA.", "https://itstelkom.web.app/licence"],
  ["MIT License", "Kode sumber repository menggunakan MIT License kecuali aset/model/dependency pihak ketiga yang memiliki lisensi masing-masing.", "https://github.com/hanifasepthi/its/blob/main/LICENSE"],
  ["Attribution", "Komponen pihak ketiga seperti Leaflet, CARTO/OSM, MapLibre/OpenFreeMap/OpenMapTiles, Firebase, Transformers.js, dan ONNX Runtime tetap mengikuti lisensi/persyaratan masing-masing.", "https://itstelkom.web.app/licence#credits"],
] as const;

const ABOUT_SITE_INFO_STACK = [
  ["ITS Maps", "Dashboard realtime untuk peta ITS, Raspberry Pi controller, kamera lalu lintas, AI RF-DETR, Firebase RTDB, Android APK, Microsoft Store app, dan Windows Widgets.", "https://itstelkom.web.app/documentation"],
  ["Developer", "Dikembangkan oleh Hanifa Septhi Larasati dan dipublikasikan oleh Hanifa Teams.", "https://github.com/hanifasepthi/its"],
  ["AI-agent access", "Halaman menyediakan manifest PWA, sitemap, robots.txt, llms.txt, llms-full.txt, dan WebMCP annotations agar browser/AI agent memahami fitur utama.", "https://itstelkom.web.app/llms.txt"],
  ["Download", "Link download Android APK, Microsoft Store/Windows app, PWA, dokumentasi, dan preview PDF tersedia di halaman dokumentasi.", "https://itstelkom.web.app/documentation#download"],
] as const;

function mapServiceStackHtml(): string {
  return FREE_MAP_SERVICE_STACK.map(([name, description, url]) => `
    <article>
      <strong>${escapeMapServiceHtml(name)}</strong>
      <p>${escapeMapServiceHtml(description)}</p>
      <a href="${escapeMapServiceHtml(url)}" target="_blank" rel="noopener" aria-label="Buka sumber dan lisensi ${escapeMapServiceHtml(name)}">Sumber &amp; lisensi <span aria-hidden="true">↗</span></a>
    </article>
  `).join("");
}

function aiServiceStackHtml(): string {
  return AI_SERVICE_STACK.map(([name, description, url]) => `
    <article>
      <strong>${escapeMapServiceHtml(name)}</strong>
      <p>${escapeMapServiceHtml(description)}</p>
      <a href="${escapeMapServiceHtml(url)}" target="_blank" rel="noopener">${escapeMapServiceHtml(url.replace(/^https?:\/\//, ""))}</a>
    </article>
  `).join("");
}

function infoStackHtml(items: readonly (readonly [string, string, string])[]): string {
  return items.map(([name, description, url]) => `
    <article>
      <strong>${escapeMapServiceHtml(name)}</strong>
      <p>${escapeMapServiceHtml(description)}</p>
      <a href="${escapeMapServiceHtml(url)}" target="_blank" rel="noopener">${escapeMapServiceHtml(url.replace(/^https?:\/\//, ""))}</a>
    </article>
  `).join("");
}


// ─── Type augmentation untuk leaflet-rotate ─────────────────────
declare module "leaflet" {
  interface Map {
    getBearing(): number;
    setBearing(bearing: number): void;
  }
  interface MapOptions {
    rotate?: boolean;
    bearing?: number;
    touchRotate?: boolean;
    rotateControl?: boolean | object;
  }
}

// ─── Types ──────────────────────────────────────────────────────

type DeviceStatus = "online" | "offline";
type CameraMode = "webrtc" | "mjpeg";
type VehicleBreakdown = {
  car: number;
  motorcycle: number;
  bus: number;
  truck: number;
  bicycle: number;
  total: number;
};
type RfDetrDetection = {
  label: string;
  confidence: number;
  vehicle?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
};
type TrafficCameraDataset = {
  snapshot1Url?: string;
  snapshot2Url?: string;
  snapshot1UpdatedAt?: number;
  snapshot2UpdatedAt?: number;
  active?: string;
  updatedAt?: number;
  source?: string;
  path?: string;
  aiDetections?: {
    snapshot1?: TrafficCameraAnalysis;
    snapshot2?: TrafficCameraAnalysis;
  };
};
type TrafficCameraAnalysis = {
  updatedAt: number;
  objectCount: number;
  vehicleCount: number;
  fps: number;
  frameWidth: number;
  frameHeight: number;
  modelUrl?: string;
  detections: RfDetrDetection[];
};
type SnapshotHistoryItem = {
  id: string;
  slot: "image1" | "image2" | string;
  imageUrl: string;
  capturedAt: number;
  deviceId: string;
  locationText: string;
  frameWidth: number;
  frameHeight: number;
  detections: RfDetrDetection[];
  analyzed?: boolean;
  scanStartedAt?: number;
  revealedAt?: number;
  analysisNote?: string;
};
type VideoAiSegment = {
  id: string;
  deviceId: string;
  createdAt: number;
  timeSec: number;
  elapsedSec: number;
  seekable: boolean;
  thumbnailUrl: string;
  detections: RfDetrDetection[];
  objectCount: number;
  vehicleCount: number;
  frameWidth: number;
  frameHeight: number;
  note: string;
  sourceKey: string;
};
type ProfileMember = {
  name: string;
  prodi: string;
  posisi: string;
  tugas: string;
  photoUrl: string;
};
type ControllerUpdateInfo = {
  status?: "running" | "complete" | "error";
  stage?: string;
  message?: string;
  updatedAt?: number;
  source?: string;
  bundleSha?: string;
};

type RuntimeTelemetry = {
  source?: string;
  heartbeatAt?: number;
  localIp?: string;
  bootId?: string;
  uptimeSec?: number;
  controllerState?: string;
  cameraStreamState?: string;
  updateTimerState?: string;
  cameraLocalOk?: boolean;
  cameraPublicOk?: boolean;
  cameraPublicUrl?: string;
  cameraNote?: string;
};

type PublicCameraHealth = {
  url: string;
  checkedAt: number;
  ok: boolean;
  checking?: boolean;
  note: string;
};

type DeviceRecord = {
  id: string;
  label: string;
  status: DeviceStatus;
  lastSeen: number;
  lastSeenText?: string;
  note?: string;
  cameraUrl?: string;
  cameraHlsUrl?: string;
  cameraThumbnailUrl?: string;
  cameraStatus?: string;
  cameraUpdatedAt?: number;
  cameraDataset?: TrafficCameraDataset;
  cameraMode?: CameraMode;
  webrtcEnabled?: boolean;
  webrtcPath?: string;
  webrtcUrl?: string;
  cameraReady?: boolean;
  roadName?: string;
  roadHint?: string;
  trafficColor?: "red" | "yellow" | "green";
  trafficDuration?: number;
  trafficStartedAt?: number;
  vehicleCount?: number;
  vehicleBreakdown?: VehicleBreakdown;
  detectorStatus?: string;
  detectorNote?: string;
  detectorUpdatedAt?: number;
  detectorFps?: number;
  detectorFrameWidth?: number;
  detectorFrameHeight?: number;
  detectorCameraSource?: string;
  detectorConfidence?: number;
  detectorOutputShape?: string;
  objectCount?: number;
  detections?: RfDetrDetection[];
  trafficSource?: string;
  gpioBackend?: string;
  gpioReady?: boolean;
  gpioNote?: string;
  update?: ControllerUpdateInfo;
  runtime?: RuntimeTelemetry;
  position: { lat: number; lng: number };
};

type SnapshotDevice = Partial<Omit<DeviceRecord, "position" | "lastSeen">> & {
  lastSeen?: number;
  position?: Partial<DeviceRecord["position"]> & { x?: number; y?: number };
};

type Snapshot = {
  updatedAt?: number;
  source?: string;
  devices?: SnapshotDevice[] | Record<string, SnapshotDevice>;
};
type AppConfig = { snapshotUrl?: string; refreshMs?: number };
type WebRtcStatus = "idle" | "connecting" | "live" | "failed";
type BrowserRfDetrStatus = "idle" | "loading" | "online" | "no-frame" | "error";
type WebRtcRuntime = {
  pc: RTCPeerConnection | null;
  deviceId: string;
  signalPath: string;
  sessionId: string;
  stream: MediaStream | null;
  pollTimer: number;
  heartbeatTimer: number;
  candidateSeq: number;
  seenCameraCandidates: Set<string>;
  pendingCandidates: RTCIceCandidateInit[];
  sessionReady: boolean;
  startedAt: number;
  status: WebRtcStatus;
  message: string;
};
type WebRtcSessionRecord = {
  answer?: RTCSessionDescriptionInit;
  cameraCandidates?: Record<string, RTCIceCandidateInit>;
  streamerStatus?: string;
  streamerError?: string;
};
type BaseMapMode = "street" | "3d" | "satellite";
type TrafficColor = "red" | "yellow" | "green";
type NoticeKind = "info" | "success" | "warning" | "error";
type TrafficState = {
  color: TrafficColor;
  duration: number;
  phaseStartedAt: number;
  vehicleCount: number;
  roadName: string;
  recommendation: string;
  updatedAt: number;
};

type PoiRecord = {
  id: string;
  kind: string;
  iconId: string;
  title: string;
  description: string;
  address: string;
  imageUrl: string;
  icon: string;
  tags: Record<string, string>;
  sourceLabel: string;
  sourceUrl: string;
  lat: number;
  lng: number;
};

type PoiClusterRecord = {
  id: string;
  lat: number;
  lng: number;
  pois: PoiRecord[];
};

type PoiDisplayRule = {
  minZoom: number;
  labelZoom: number;
  priority: number;
};

type MapDetailProperties = Record<string, string | number | boolean>;

type RoadGuideRecord = {
  id: string;
  name: string;
  ref: string;
  highway: string;
  oneway: boolean;
  onewayDirection: string;
  hasSidewalk: boolean;
  hasMedian: boolean;
  medianType: string;
  treeLined: boolean;
  waterMedian: boolean;
  isRoundabout: boolean;
  lanes: number;
  busLane: boolean;
  hasCycleway: boolean;
  pedestrianStructure: "" | "jpo" | "footbridge" | "covered_walkway";
  surface: string;
  detail: MapDetailProperties;
  roadType: "expressway" | "avenue" | "street" | "service" | "foot";
  points: L.LatLng[];
};

type RailGuideRecord = {
  id: string;
  name: string;
  label: string;
  ref: string;
  operator: string;
  network: string;
  service: string;
  usage: string;
  gauge: string;
  electrified: string;
  railway: string;
  detail: MapDetailProperties;
  points: L.LatLng[];
};

type CrossingGuideRecord = {
  id: string;
  name: string;
  latlng: L.LatLng;
  type: "rail" | "road";
  bearing: number;
  roadWidthPx?: number;
};

type TransitGuideMode = "busway" | "bus" | "mrt" | "lrt" | "tram" | "monorail" | "commuter" | "high_speed" | "train";

type TransitGuideRecord = {
  id: string;
  name: string;
  label: string;
  ref: string;
  operator: string;
  network: string;
  route: string;
  from: string;
  to: string;
  service: string;
  usage: string;
  gauge: string;
  electrified: string;
  source: "route" | "infrastructure" | "road_lane";
  color: string;
  mode: TransitGuideMode;
  relationId: string;
  componentIndex: number;
  componentCount: number;
  memberCount: number;
  verifiedFrom: VerifiedTransitEndpoint | null;
  verifiedTo: VerifiedTransitEndpoint | null;
  points: L.LatLng[];
};

type MapOrnamentKind =
  | "street_lamp"
  | "surveillance"
  | "speed_camera"
  | "traffic_calming"
  | "barrier"
  | "guardrail"
  | "bollard"
  | "toll_gate"
  | "hydrant"
  | "bench"
  | "waste_basket"
  | "drinking_water"
  | "toilets"
  | "entrance"
  | "gate"
  | "elevator"
  | "escalator"
  | "manhole"
  | "drain_grate"
  | "retaining_wall"
  | "seawall"
  | "taxi"
  | "bicycle_parking"
  | "charging_station"
  | "park_and_ride";

type MapOrnamentRecord = {
  id: string;
  name: string;
  kind: MapOrnamentKind;
  tagKey: string;
  tagValue: string;
  detail: MapDetailProperties;
  geometry: "point" | "line";
  points: L.LatLng[];
};

type MapPointGuideRecord = {
  id: string;
  name: string;
  latlng: L.LatLng;
};

type SchoolGuideRecord = MapPointGuideRecord & {
  kind: "school" | "kindergarten" | "college" | "university";
};

type WaterGuideRecord = {
  id: string;
  name: string;
  waterway: string;
  detail: MapDetailProperties;
  points: L.LatLng[];
};

type GreenGuideRecord = {
  id: string;
  name: string;
  kind: string;
  points: L.LatLng[];
};

type RoadGuideBundle = {
  roads: RoadGuideRecord[];
  rails: RailGuideRecord[];
  transit: TransitGuideRecord[];
  crossings: CrossingGuideRecord[];
  waterways: WaterGuideRecord[];
  greens: GreenGuideRecord[];
  signals: MapPointGuideRecord[];
  trees: MapPointGuideRecord[];
  schools: SchoolGuideRecord[];
  ornaments: MapOrnamentRecord[];
};

type VisionFeatureKind = "road" | "sidewalk" | "vegetation" | "water" | "building";

type VisionFeatureRecord = {
  id: string;
  kind: VisionFeatureKind;
  latlng: L.LatLng;
  score: number;
  radius: number;
};

type CachedVisionFeature = {
  kind: VisionFeatureKind;
  lat: number;
  lng: number;
  score: number;
  radius: number;
};

type VisionFeatureCacheEntry = {
  key: string;
  createdAt: number;
  features: CachedVisionFeature[];
};

type SatelliteVisionCapture = {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  zoom: number;
  pixelToLatLng: (x: number, y: number) => L.LatLng;
};

type VisionMaskData = {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
  channels: number;
};

type NativeLocationResult = {
  ok?: boolean;
  lat?: number;
  lng?: number;
  accuracy?: number;
  source?: string;
  error?: string;
};

type ItsDesktopBridge = {
  isElectron?: boolean;
  platform?: string;
  requestWindowsLocation?: () => Promise<NativeLocationResult>;
  openLocationSettings?: () => Promise<boolean>;
};

type ItsAndroidBridge = {
  installApk?: (url: string, fileName: string) => void;
  notifyUpdate?: (title: string, message: string, targetUrl: string) => void;
  activateLockScreenWidget?: () => void;
  previewLockScreenWidget?: () => void;
  openNotificationAccessSettings?: () => void;
  isLockScreenMonitoringEnabled?: () => boolean;
  setLockScreenMonitoringEnabled?: (enabled: boolean) => void;
  setVideoFullscreen?: (enabled: boolean) => void;
};

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_CONFIG: Required<AppConfig> = {
  snapshotUrl: "https://itstelkom-default-rtdb.asia-southeast1.firebasedatabase.app/devices.json",
  refreshMs: 10000,
};

// DEFAULT_CENTER — fallback jika tidak ada device. Akan di-override saat snapshot dimuat.
// User harus set ITS_LATITUDE & ITS_LONGITUDE di env var controller untuk lokasi yang tepat.
const DEFAULT_CENTER: L.LatLngExpression = [-6.977254, 107.631817];
const DEFAULT_ZOOM = 17;
const OFFLINE_AFTER_MS = 5 * 60_000;
const HARDWARE_HEARTBEAT_STALE_MS = 30_000;
const CAMERA_STATUS_FRESH_MS = 3 * 60_000;
const CAMERA_SNAPSHOT_FRESH_MS = 4 * 60_000;
const PUBLIC_CAMERA_HEALTH_TTL_MS = 15_000;
const PUBLIC_CAMERA_HEALTH_MAX_AGE_MS = 45_000;
const PUBLIC_CAMERA_HEALTH_TIMEOUT_MS = 6_000;
const HISTORY_REVEAL_DURATION_MS = 2600;
const BROWSER_RF_DETR_INTERVAL_MS = 10_000;
const VIDEO_BROWSER_RF_DETR_INTERVAL_MS = 5_000;
const ENABLE_AUTO_MAP_VISION = false;
const FIREBASE_DEVICES_URL =
  "https://itstelkom-default-rtdb.asia-southeast1.firebasedatabase.app/devices.json";
const FIREBASE_ROOT_URL = FIREBASE_DEVICES_URL.replace(/\/devices\.json$/, "");
const WEBRTC_SIGNAL_ROOT = "webrtc/devices";
const HLS_JS_URL = "https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js";
const WEBRTC_POLL_MS = 700;
const WEBRTC_HEARTBEAT_MS = 5_000;
const WEBRTC_ANSWER_TIMEOUT_MS = 18_000;
type ItsProfileSource = {
  label: string;
  url: string;
  type: "project" | "github" | "education" | "portfolio" | "other";
};

type ItsCreatorEducation = {
  institution: string;
  program: string;
  period?: string;
  sourceUrl?: string;
};

type ItsVerifiedCreatorProfile = {
  name: string;
  role: string;
  publisher: string;
  summary: string;
  photoUrl: string;
  education: ItsCreatorEducation[];
  skills: string[];
  sources: ItsProfileSource[];
};

const ITS_CREATOR_PROFILE: ItsVerifiedCreatorProfile = {
  name: "Hanifa Septhi Larasati",
  role: "Pencipta aplikasi ITS Maps",
  publisher: "Hanifa Teams",
  summary:
    "Merancang konsep, alur aplikasi, integrasi Raspberry Pi, pemantauan lalu lintas, AI deteksi objek, dan antarmuka ITS Maps.",
  photoUrl: profileAssetUrl(0),

  // Isi hanya berdasarkan data yang memang Anda izinkan untuk dipublikasikan.
  education: [
    {
      institution: "Telkom University",
      program: "ISI PROGRAM STUDI YANG BENAR",
      period: "ISI PERIODE JIKA AKAN DITAMPILKAN",
      sourceUrl: "",
    },
  ],

  skills: [
    "Intelligent Transport System",
    "Raspberry Pi",
    "TypeScript",
    "Leaflet",
    "RF-DETR",
    "Computer Vision",
    "Firebase Realtime Database",
  ],

  sources: [
    {
      label: "Repository ITS Maps",
      url: "https://github.com/hanifasepthi/its",
      type: "project",
    },
    {
      label: "Profil GitHub",
      url: "https://github.com/hanifasepthi",
      type: "github",
    },
    {
      label: "Dokumentasi ITS Maps",
      url: "https://itstelkom.web.app/documentation",
      type: "portfolio",
    },
  ],
};

const WEBRTC_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

const BEARING_STEP = 90;
const BEARING_SNAP = 5;
const MAPLIBRE_3D_PITCH = 60;
const VISION_SEGMENTATION_MODEL = "Xenova/segformer-b0-finetuned-ade-512-512";
const VISION_MIN_ZOOM = 16;
const VISION_CANVAS_SIZE = 512;
const VISION_FEATURE_CACHE_STORAGE_KEY = "its-map-vision-features:v2";
const VISION_FEATURE_CACHE_LIMIT = 54;
const VISION_FEATURE_CACHE_MAX_AGE = 1000 * 60 * 60 * 24 * 45;
const LAST_DEVICE_POSITIONS_STORAGE_KEY = "its-web-device-positions:v1";

function initialMapCenter(): L.LatLngExpression {
  const valid = (lat: number, lng: number) => Number.isFinite(lat)
    && Number.isFinite(lng)
    && Math.abs(lat) <= 90
    && Math.abs(lng) <= 180
    && !(Math.abs(lat) < 0.000001 && Math.abs(lng) < 0.000001);
  const params = new URLSearchParams(window.location.search);
  const sharedLat = Number(params.get("lat"));
  const sharedLng = Number(params.get("lng"));
  if (valid(sharedLat, sharedLng)) return [sharedLat, sharedLng];

  try {
    const raw = localStorage.getItem(LAST_DEVICE_POSITIONS_STORAGE_KEY);
    if (!raw) return DEFAULT_CENTER;
    const positions = JSON.parse(raw) as Record<string, { lat?: unknown; lng?: unknown; updatedAt?: unknown }>;
    const freshest = Object.values(positions)
      .map((position) => ({
        lat: Number(position.lat),
        lng: Number(position.lng),
        updatedAt: Number(position.updatedAt) || 0,
      }))
      .filter((position) => valid(position.lat, position.lng))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return freshest ? [freshest.lat, freshest.lng] : DEFAULT_CENTER;
  } catch {
    return DEFAULT_CENTER;
  }
}

function initialMapZoom(): number {
  const params = new URLSearchParams(window.location.search);
  const rawRequested = params.get("z") ?? params.get("zoom");
  if (rawRequested === null) return DEFAULT_ZOOM;
  const requested = Number(rawRequested);
  return Number.isFinite(requested) ? Math.max(3, Math.min(20, requested)) : DEFAULT_ZOOM;
}

function initialMapBearing(): number {
  const requested = Number(new URLSearchParams(window.location.search).get("bearing"));
  return Number.isFinite(requested) ? ((requested % 360) + 360) % 360 : 0;
}

function initialMapMode(): BaseMapMode {
  const mode = new URLSearchParams(window.location.search).get("mode");
  return mode === "3d" || mode === "satellite" ? mode : "street";
}
const SNAPSHOT_HISTORY_STORAGE_KEY = "its-map-snapshot-history:v1";
const SNAPSHOT_HISTORY_LIMIT = 36;
const PROFILE_MEMBER_COUNT = 4;
const PROFILE_MEMBERS: ProfileMember[] = [
  {
    name: "Hanifa Septhi Larasati",
    prodi: "Belum diisi",
    posisi: "Pencipta aplikasi",
    tugas: "Merancang konsep, alur aplikasi, dan validasi fitur ITS Maps.",
    photoUrl: profileAssetUrl(0),
  },
  {
    name: "Nama anggota 2",
    prodi: "Belum diisi",
    posisi: "Belum diisi",
    tugas: "Belum diisi",
    photoUrl: profileAssetUrl(1),
  },
  {
    name: "Nama anggota 3",
    prodi: "Belum diisi",
    posisi: "Belum diisi",
    tugas: "Belum diisi",
    photoUrl: profileAssetUrl(2),
  },
  {
    name: "Nama anggota 4",
    prodi: "Belum diisi",
    posisi: "Belum diisi",
    tugas: "Belum diisi",
    photoUrl: profileAssetUrl(3),
  },
];

// ─── DOM bootstrap ──────────────────────────────────────────────

function requiredElement<T extends Element>(selector: string, name: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing required element: ${name}`);
  return el;
}

function staticRouteName(pathname: string): "document" | "new" | null {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized.endsWith("/document") || normalized.endsWith("/documentation")) return "document";
  if (normalized.endsWith("/new")) return "new";
  return null;
}

function escapeStaticHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function terminalStatic(commands: string[]): string {
  return `
    <div class="static-terminal" data-static-terminal>
      <div class="static-terminal-output" data-terminal-output>
        <div>ITS Maps terminal siap. Ketik <strong>help</strong> lalu Enter.</div>
        ${commands.map((command) => `<div><span>$</span> ${escapeStaticHtml(command)}</div>`).join("")}
      </div>
      <form class="static-terminal-form" data-terminal-form toolname="run_its_maps_documentation_command" tooldescription="Run a safe ITS Maps documentation command or navigation helper in the public documentation terminal." toolautosubmit>
        <span>$</span>
        <input data-terminal-input name="command" autocomplete="off" spellcheck="false" aria-label="Terminal command" placeholder="help" toolparamdescription="A safe documentation command such as help, npm run build, firebase deploy, open /documentation, or open /new.">
        <button type="submit">Run</button>
      </form>
      <div class="static-terminal-chips">
        ${["help", "npm run build", "npm run desktop:custom-installer", "firebase deploy", "open /new"].map((command) => `<button type="button" data-terminal-command="${escapeStaticHtml(command)}">${escapeStaticHtml(command)}</button>`).join("")}
      </div>
    </div>
  `;
}

function staticTerminalResponse(command: string): string[] {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (!normalized) return ["Ketik command dulu, contoh: help"];
  if (normalized === "help") {
    return [
      "Command: npm ci, npm run dev, npm run build, npm run desktop:open, npm run desktop:custom-installer, firebase deploy.",
      "Command navigasi: open /documentation, open /document, open /new, open /.",
      "Command info: docs, structure, notifications, map, installer, clear.",
    ];
  }
  if (normalized.startsWith("explain main.ts")) {
    const topic = normalized.slice("explain main.ts".length).trim().toLowerCase();
    if (!topic || topic === "all") {
      return [
        "main.ts membangun 5 area utama: map engine, mobile sheet, AI/history pipeline, static docs/news route, dan PWA notification/update.",
        "Gunakan: explain main.ts map | explain main.ts ai | explain main.ts docs | explain main.ts pwa",
      ];
    }
    if (topic === "map") {
      return [
        "Map layer: street/2D memakai CARTO Voyager melalui Leaflet; 3D memakai MapLibre/OpenFreeMap; satellite memakai Esri.",
        "Sheet mobile mengubah inset, radius, dan offset tombol agar peta tetap usable saat panel terbuka.",
      ];
    }
    if (topic === "ai") {
      return [
        "Pipeline AI: snapshot historis, rendering canvas deteksi, dan analisis objek berjalan terpisah agar UI tetap responsif.",
        "Object counting untuk traffic difokuskan pada kendaraan agar rekomendasi lampu lalu lintas tetap stabil.",
      ];
    }
    if (topic === "docs") {
      return [
        "Route /documentation dirender dari fungsi renderStaticSitePage + docsPageHtml.",
        "Sidebar docs dibentuk otomatis dari heading [data-doc-anchor], termasuk mode print dan blok terminal interaktif.",
      ];
    }
    if (topic === "pwa") {
      return [
        "PWA flow: register service worker, optional prompt notification permission, polling app-update.json untuk notifikasi update publik.",
        "Push payload yang membawa data.url akan dibuka saat notificationclick.",
      ];
    }
    return ["Topik explain main.ts tidak dikenal. Gunakan: map, ai, docs, pwa, all."];
  }
  if (normalized.startsWith("simulate traffic")) {
    const parts = normalized.split(" ");
    const vehicles = Number(parts[2]);
    const queue = Number(parts[3]);
    if (!Number.isFinite(vehicles) || !Number.isFinite(queue)) {
      return ["Format: simulate traffic <kendaraan> <antrian>"];
    }
    const green = Math.min(120, Math.max(10, Math.round(0.85 * vehicles + 0.45 * queue + 8)));
    return [
      `Input kendaraan=${vehicles}, antrian=${queue}`,
      `Formula: t_hijau = min(120, max(10, 0.85*v + 0.45*q + 8))`,
      `Output rekomendasi waktu hijau: ${green} detik`,
    ];
  }
  if (normalized === "sync readme") {
    return [
      "Sinkronisasi README: perbarui section route docs (/documentation) dan deploy Firebase (hosting: itstelkom).",
      "Commit file utama: README.md, web/src/main.ts, web/src/style.css.",
    ];
  }
  if (normalized === "clear") return ["__CLEAR__"];
  if (normalized === "docs") {
    return [
      "Dokumentasi mencakup website, PWA/native browser install, notifikasi publik, peta 2D CARTO+OSM, peta 3D OpenFreeMap, modal download aplikasi, Windows Electron, service worker, Firebase, dan installer custom.",
    ];
  }
  if (normalized === "structure") {
    return [
      "web/src/main.ts: website, peta, PWA, notifikasi, dokumentasi, release notes, modal aplikasi.",
      "web/src/windows.ts: renderer Electron Windows.",
      "web/electron/main.cjs: window native, update, notification click, permissions.",
      "web/scripts/build-custom-windows-installer.ps1: build web, package Electron, publish .NET installer, copy artifact update.",
    ];
  }
  if (normalized === "notifications") {
    return [
      "Service worker: /sw.js.",
      "Payload push memakai data.url, lalu notificationclick membuka link tersebut.",
      "Fallback update publik membaca /app-update.json saat izin notifikasi sudah granted.",
    ];
  }
  if (normalized === "map") {
    return [
      "2D/street: CARTO Voyager melalui Leaflet sebagai basemap utama.",
      "Data nama jalan/bangunan/POI: OpenStreetMap melalui vector tile dan Overpass.",
      "3D: MapLibre/OpenFreeMap; satelit: Esri World Imagery.",
      "Lisensi dibuka dari tombol Lisensi Peta di attribution.",
    ];
  }
  if (normalized === "installer") {
    return [
      "Installer lokal: web/release/ITS-Maps-Windows-Custom-Setup-1.0.18-x64.exe.",
      "Update artifact besar: GitHub Release its-maps-v1.0.18.",
      "GitHub Actions workflow: Build Windows EXE.",
    ];
  }
  if (normalized === "npm ci") return ["Menginstal dependency sesuai package-lock.json...", "OK: dependency siap."];
  if (normalized === "npm run dev") return ["Vite dev server: http://localhost:5173", "Gunakan Ctrl+C di terminal asli untuk berhenti."];
  if (normalized === "npm run build") return ["tsc selesai.", "vite build selesai.", "Output: web/dist"];
  if (normalized === "npm run desktop:open") return ["Membuka Electron dengan renderer dari web/dist/desktop/renderer.html."];
  if (normalized === "npm run desktop:custom-installer") {
    return [
      "Build web assets...",
      "Package Electron app directory...",
      "Publish native custom setup...",
      "Custom setup ready: web/release/ITS-Maps-Windows-Custom-Setup-1.0.18-x64.exe",
    ];
  }
  if (normalized === "firebase deploy") return ["Deploy target: hosting:itstelkom", "Hosting URL: https://itstelkom.web.app"];
  if (normalized.startsWith("open ")) {
    const target = normalized.slice(5).trim();
    const safeTargets = new Set(["/", "/document", "/documentation", "/new"]);
    if (safeTargets.has(target)) {
      window.setTimeout(() => { window.location.href = target; }, 180);
      return [`Membuka ${target} ...`];
    }
    return [`Route ${target} tidak dikenal. Coba open /documentation atau open /new.`];
  }
  return [`Command tidak dikenal: ${normalized}`, "Ketik help untuk daftar command."];
}

function renderStaticSitePage(root: HTMLElement, route: "document" | "new"): void {
  document.body.classList.add("static-site-body");
  const isDocs = route === "document";
  document.title = isDocs ? "ITS Maps Documentation" : "What's New | ITS Maps";
  root.innerHTML = `
    <div class="static-splash" data-static-splash>
      <img src="./its.png" alt="ITS Maps">
    </div>
    <main class="static-page ${isDocs ? "doc-page" : "news-page"}">
      <aside class="static-sidebar">
        <a class="static-brand" href="/">
          <img src="/its.png" alt="">
          <span>ITS Maps</span>
        </a>
        <nav aria-label="${isDocs ? "Dokumentasi" : "Catatan pembaruan"}" ${isDocs ? "data-static-doc-nav" : ""}>
          ${(isDocs ? [
      ["Mulai", "#mulai"],
      ["Ringkasan", "#ringkasan"],
      ["WebApp", "#webapp"],
      ["Terminal", "#terminal"],
    ] : [
      ["Highlights", "#highlights"],
      ["Android", "#android"],
      ["Windows app", "#windows"],
      ["Website", "#website"],
      ["Fixed", "#fixed"],
      ["Terminal", "#terminal"],
    ]).map(([label, href]) => `<a href="${href}">${label}</a>`).join("")}
        </nav>
      </aside>
      <section class="static-content">
        ${isDocs ? docsPageHtml() : newsPageHtml()}
      </section>
      <button class="static-floating-terminal" type="button" data-open-static-terminal>Terminal</button>
      <section class="static-modal" data-static-modal hidden>
        <div class="static-modal-panel" data-static-modal-panel>
          <header>
            <strong>Terminal</strong>
            <button type="button" data-close-static-modal aria-label="Tutup">x</button>
          </header>
          ${terminalStatic(["cd web", "npm ci", "npm run dev", "npm run build", "npm run desktop:open"])}
        </div>
      </section>
    </main>
  `;
  bindStaticModal();
  if (isDocs) bindStaticDocumentation();
  window.setTimeout(() => {
    const splash = document.querySelector<HTMLElement>("[data-static-splash]");
    splash?.classList.add("hide");
    window.setTimeout(() => splash?.remove(), 220);
  }, 420);
}

function docsPageHtml(): string {
  return `
    <header class="static-hero static-doc-hero" id="mulai" data-doc-anchor="Mulai">
      <span>Documentation</span>
      <h1>ITS Maps</h1>
      <p>Dokumentasi teknis bergaya card seperti Rust Training: terbagi per platform, fokus arsitektur, terminal simulasi, formulasi AI, dan alur edit-publish.</p>
      <div class="static-hero-actions">
        <button type="button" class="static-action" data-print-docs>Cetak dokumentasi</button>
        <a class="static-action static-action-ghost" href="https://github.com/hanifasepthi/its" target="_blank" rel="noopener">Edit di GitHub</a>
      </div>
    </header>
    <section class="static-section" id="ringkasan" data-doc-anchor="Ringkasan Platform">
      <h2>Ringkasan platform</h2>
      <div class="doc-platform-grid">
        <article class="doc-platform-card" id="controller" data-doc-anchor="Controller">
          <span>Card 1</span>
          <h3>Controller</h3>
          <p>Service Scala pada Raspberry Pi yang menulis status perangkat, data lalu lintas, dan metadata kamera ke Firebase serta snapshot JSON.</p>
          <ul>
            <li>Fokus file: controller/Main.scala, controller/run-controller.sh</li>
            <li>Fungsi utama: polling sensor, inferensi status, publish RTDB</li>
          </ul>
        </article>
        <article class="doc-platform-card doc-platform-card-featured" id="webapp" data-doc-anchor="WebApp">
          <span>Card 2</span>
          <h3>WebApp</h3>
          <p>Frontend Vite + TypeScript yang merender peta Leaflet, AI snapshot/history, modal aplikasi, docs static route, terminal interaktif, dan PWA.</p>
          <ul>
            <li>Fokus file: web/src/main.ts, web/src/style.css</li>
            <li>Highlight: auto sidebar docs, print mode, LaTeX, terminal demo</li>
          </ul>
        </article>
        <article class="doc-platform-card" id="android" data-doc-anchor="Android">
          <span>Card 3</span>
          <h3>Android</h3>
          <p>Distribusi APK untuk pemantauan mobile: lock screen AI, widget snapshot, notifikasi, dan kontrol instalasi manual dari endpoint Firebase.</p>
          <ul>
            <li>Fokus file: bridge native, mode APK runtime, app download modal</li>
            <li>Fungsi utama: lock screen panel, data safety, preview fitur</li>
          </ul>
        </article>
        <article class="doc-platform-card" id="windows" data-doc-anchor="Windows">
          <span>Card 4</span>
          <h3>Windows</h3>
          <p>Renderer Electron untuk dashboard desktop, history, dokumentasi, updater, notifikasi, dan build custom installer berbasis script PowerShell.</p>
          <ul>
            <li>Fokus file: web/src/windows.ts, web/electron/main.cjs</li>
            <li>Fungsi utama: shell desktop, update lifecycle, titlebar action</li>
          </ul>
        </article>
      </div>
    </section>

    <section class="static-section" id="webapp-architecture" data-doc-anchor="WebApp: Arsitektur main.ts">
      <h2>WebApp: arsitektur main.ts</h2>
      <p>File main.ts menjadi orchestrator state aplikasi. Modul ini menggabungkan peta, sheet mobile, kamera, AI history, route statis, download app modal, notifikasi service worker, serta fallback runtime Android APK.</p>
      <div class="static-doc-list">
        <article><strong>Map + Traffic domain</strong><span>State perangkat, marker, peta 2D/3D/satelit, POI Overpass, dan rekomendasi lampu lalu lintas dirender dari satu sumber state.</span></article>
        <article><strong>AI + Snapshot domain</strong><span>Render canvas deteksi, history item, modal rincian, serta status inferensi agar komponen AI tetap terisolasi dari update peta.</span></article>
        <article><strong>Static docs route</strong><span>Route /documentation dan /new menggunakan renderer statik sendiri sehingga dapat dibuka dari web dan aplikasi Windows.</span></article>
      </div>
    </section>

    <section class="static-section" id="webapp-formula" data-doc-anchor="WebApp: Formulasi AI dan Matematika">
      <h2>WebApp: formulasi AI dan matematika</h2>
      <p>Dokumentasi mendukung notasi LaTeX untuk menjelaskan logika rekomendasi durasi hijau berdasarkan kendaraan dan antrian.</p>
      <div class="doc-formula-block" data-katex-display="t_{hijau}=\min\left(120,\max\left(10,\ 0.85\cdot v + 0.45\cdot q + 8\right)\right)"></div>
      <p>Dengan <span class="doc-inline-formula" data-katex-inline="v">v</span> sebagai jumlah kendaraan dan <span class="doc-inline-formula" data-katex-inline="q">q</span> sebagai indikator kepadatan antrian. Formula ini dapat diuji dari terminal docs menggunakan perintah simulate traffic.</p>
    </section>

    <section class="static-section" id="webapp-files" data-doc-anchor="WebApp: Penjelasan File .ts dan .sh">
      <h2>WebApp: penjelasan file .ts dan .sh</h2>
      <div class="doc-file-table" role="table" aria-label="Daftar file dan peran">
        <div class="doc-file-row doc-file-head" role="row"><span role="columnheader">File</span><span role="columnheader">Peran</span></div>
        <div class="doc-file-row" role="row"><span role="cell">web/src/main.ts</span><span role="cell">Core app logic: map, AI, docs route, modal app, service worker flow, mobile UX.</span></div>
        <div class="doc-file-row" role="row"><span role="cell">web/src/style.css</span><span role="cell">Seluruh styling website termasuk halaman dokumentasi, sheet mobile, modal download, dan mode print.</span></div>
        <div class="doc-file-row" role="row"><span role="cell">web/src/windows.ts</span><span role="cell">Renderer Electron untuk dashboard Windows, panel history, docs, dan routing internal app.</span></div>
        <div class="doc-file-row" role="row"><span role="cell">web/scripts/build-custom-windows-installer.ps1</span><span role="cell">Pipeline build installer custom: build web, package desktop app, publish setup.</span></div>
        <div class="doc-file-row" role="row"><span role="cell">controller/run-controller.sh</span><span role="cell">Entrypoint shell controller pada Raspberry Pi untuk mode sekali jalan maupun service.</span></div>
      </div>
    </section>

    <section class="static-section" id="webapp-edit" data-doc-anchor="WebApp: Edit di GitHub dan sinkron README">
      <h2>WebApp: edit di GitHub dan sinkron README</h2>
      <div class="static-doc-list">
        <article><strong>Edit docs langsung dari GitHub</strong><span>Halaman /documentation dirender dari fungsi docsPageHtml di web/src/main.ts dan styling di web/src/style.css.</span></article>
        <article><strong>Sinkronkan README</strong><span>Setiap perubahan jalur deploy/docs sebaiknya dicerminkan ke README.md agar developer baru mendapat alur yang sama.</span></article>
        <article><strong>Publish ke Firebase</strong><span>Alur standar: cd web, npm run build, npx firebase deploy --only hosting --project itstelkom.</span></article>
      </div>
    </section>

    <section class="static-section" id="platform-notes" data-doc-anchor="Android dan Windows Notes">
      <h2>Android dan Windows notes</h2>
      <div class="static-doc-list">
        <article><strong>Android</strong><span>Fitur lock screen AI, widget, data safety, serta installer APK manual dikontrol dari modal aplikasi di web route utama.</span></article>
        <article><strong>Windows</strong><span>Paket Electron + custom installer memisahkan lifecycle desktop dari web runtime agar update dan permission lebih stabil.</span></article>
        <article><strong>Controller</strong><span>Service Scala tetap menjadi sumber data lapangan: status perangkat, kamera, dan metrik kendaraan untuk peta.</span></article>
      </div>
    </section>

    <section class="static-section" id="notifikasi" data-doc-anchor="Notifikasi Publik">
      <h2>Notifikasi publik</h2>
      <p>Website mendaftarkan service worker dan token Firebase Cloud Messaging ke Cloudflare Worker. Push publik tetap dapat membangunkan service worker saat tab ditutup; ketika notifikasi ditekan, URL internal yang aman akan dibuka. Langganan dapat dihentikan dari tombol yang sama.</p>
      <button class="static-action" type="button" data-enable-notifications>${publicPushOptedIn() ? "Nonaktifkan notifikasi" : "Aktifkan notifikasi"}</button>
    </section>

    <section class="static-section" id="build" data-doc-anchor="Build dan Deploy Firebase">
      <h2>Build dan deploy Firebase</h2>
      <p>Build web memakai TypeScript dan Vite. Build Windows custom menjalankan build web, packaging Electron, publish .NET installer/uninstaller, lalu menyiapkan artifact update. Firebase deploy memakai folder web/dist sebagai hosting live.</p>
      <div class="static-doc-list">
        <article><strong>Local web</strong><span>npm run build menghasilkan web/dist dan bisa dicek dengan npm run preview.</span></article>
        <article><strong>Local Windows</strong><span>npm run desktop:custom-installer menghasilkan web/release/ITS-Maps-Windows-Custom-Setup-1.0.18-x64.exe.</span></article>
        <article><strong>GitHub</strong><span>Workflow Build Windows EXE berjalan otomatis setelah branch dipush dan mengupload artifact installer.</span></article>
      </div>
    </section>

    <section class="static-section" id="terminal" data-doc-anchor="Terminal Interaktif">
      <h2>Terminal</h2>
      <p>Terminal dokumentasi bersifat simulatif untuk belajar alur command, bukan shell sistem asli. Coba command help, explain main.ts ai, simulate traffic 42 18, sync readme, atau firebase deploy.</p>
      ${terminalStatic(["cd web", "npm ci", "npm run dev", "npm run build", "simulate traffic 42 18", "explain main.ts ai", "sync readme", "firebase deploy"])}
    </section>
  `;
}

function bindStaticDocumentation(): void {
  const nav = document.querySelector<HTMLElement>("[data-static-doc-nav]");
  const anchors = Array.from(document.querySelectorAll<HTMLElement>("[data-doc-anchor]"));
  if (nav && anchors.length) {
    nav.innerHTML = anchors.map((section) => {
      const id = section.id || section.dataset.docAnchor?.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "section";
      if (!section.id) section.id = id;
      return `<a href="#${id}">${escapeStaticHtml(section.dataset.docAnchor || section.id)}</a>`;
    }).join("");
    const links = Array.from(nav.querySelectorAll<HTMLAnchorElement>("a"));
    const observer = new IntersectionObserver((entries) => {
      const active = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!active) return;
      const id = (active.target as HTMLElement).id;
      links.forEach((link) => link.classList.toggle("active", link.getAttribute("href") === `#${id}`));
    }, { rootMargin: "-20% 0px -65% 0px", threshold: [0.15, 0.45] });
    anchors.forEach((section) => observer.observe(section));
  }
  document.querySelector<HTMLButtonElement>("[data-print-docs]")?.addEventListener("click", () => window.print());
  renderStaticMath();
}

function renderStaticMath(): void {
  const root = document.querySelector<HTMLElement>(".static-content");
  if (!root) return;
  renderMathIn(root);
}

let katexModulePromise: Promise<typeof import("katex")> | null = null;

function renderMathIn(root: ParentNode): void {
  const inlineNodes = Array.from(root.querySelectorAll<HTMLElement>("[data-katex-inline]"));
  const displayNodes = Array.from(root.querySelectorAll<HTMLElement>("[data-katex-display]"));
  if (!inlineNodes.length && !displayNodes.length) return;
  inlineNodes.forEach((node) => {
    if (!node.textContent) node.textContent = node.dataset.katexInline || "";
  });
  displayNodes.forEach((node) => {
    if (!node.textContent) node.textContent = node.dataset.katexDisplay || "";
  });
  if (!katexModulePromise) {
    void import("katex/dist/katex.min.css");
    katexModulePromise = import("katex");
  }
  void katexModulePromise.then((module) => {
    const renderer = module.default;
    root.querySelectorAll<HTMLElement>("[data-katex-inline]").forEach((node) => {
      const expression = node.dataset.katexInline;
      if (!expression || node.dataset.katexDone === "true") return;
      renderer.render(expression, node, { throwOnError: false });
      node.dataset.katexDone = "true";
    });
    root.querySelectorAll<HTMLElement>("[data-katex-display]").forEach((node) => {
      const expression = node.dataset.katexDisplay;
      if (!expression || node.dataset.katexDone === "true") return;
      renderer.render(expression, node, { throwOnError: false, displayMode: true });
      node.dataset.katexDone = "true";
    });
  }).catch((error) => console.warn("KaTeX lokal gagal dimuat; formula TeX tetap ditampilkan.", error));
}

/**
 * Chat responses are normally plain text so they remain safe to type out one
 * character at a time.  After typing finishes, promote explicit TeX tokens to
 * KaTeX nodes.  This covers $...$, \\(...\\), \\[...\\], and the common
 * parenthesised form (\\hat{\\sigma}) used in the DETR explanation.
 */
function hydrateChatMath(node: HTMLElement, text: string): void {
  const fragment = document.createDocumentFragment();
  const appendPlainText = (value: string) => {
    const lines = value.split("\n");
    lines.forEach((line, index) => {
      if (line) fragment.appendChild(document.createTextNode(line));
      if (index < lines.length - 1) fragment.appendChild(document.createElement("br"));
    });
  };
  const appendText = (value: string) => {
    const citationPattern = /\[S(\d+)\]/g;
    let citationCursor = 0;
    for (const citation of value.matchAll(citationPattern)) {
      const start = citation.index ?? 0;
      appendPlainText(value.slice(citationCursor, start));
      const id = citation[1];
      const link = document.createElement("a");
      link.className = "its-ai-citation";
      link.href = `#its-ai-reference-${id}`;
      link.dataset.aiCitation = id;
      link.textContent = citation[0];
      link.setAttribute("aria-label", `Buka referensi ${id}`);
      fragment.appendChild(link);
      citationCursor = start + citation[0].length;
    }
    appendPlainText(value.slice(citationCursor));
  };
  const appendMath = (expression: string, display = false) => {
    const math = document.createElement(display ? "div" : "span");
    math.className = display ? "its-ai-inline-display-math" : "its-ai-inline-math";
    if (display) math.dataset.katexDisplay = expression.trim();
    else math.dataset.katexInline = expression.trim();
    fragment.appendChild(math);
  };

  // Accept normal TeX delimiters as users type them: \(...\), \[...\],
  // $...$, and the common legacy form (\hat{\sigma}). The previous pattern
  // accidentally required two literal backslashes, leaving formulas as text.
  const tokenPattern = /\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|(?<!\\)\$([^$\n]+?)(?<!\\)\$|\((\\(?:[A-Za-z]+)(?:\{(?:[^{}]|\{[^{}]*\})*\}|[^)])*)\)/g;
  let cursor = 0;
  for (const match of text.matchAll(tokenPattern)) {
    const start = match.index ?? 0;
    appendText(text.slice(cursor, start));
    const display = Boolean(match[1]);
    const expression = match[1] || match[2] || match[3] || match[4] || "";
    appendMath(expression, display);
    cursor = start + match[0].length;
  }
  appendText(text.slice(cursor));
  node.replaceChildren(fragment);
  renderMathIn(node.parentElement || node);
}

function newsPageHtml(): string {
  return `
    <header class="static-hero" id="highlights">
      <span>What's New</span>
      <h1>ITS Maps 1.0.36</h1>
      <p>Catatan pembaruan untuk Android Lock Screen AI, UI Windows, website, notifikasi, dokumentasi, dan workflow build.</p>
    </header>
    <section class="static-release" id="android">
      <h2>Android</h2>
      <article><span>New</span><strong>Pemantauan AI Layar Kunci</strong><p>Panel native Android menampilkan jam, tanggal, status RTDB, dua snapshot live 10 detik, canvas AI, jumlah objek, notifikasi, tema Fluent, dan rincian deteksi.</p></article>
      <article><span>New</span><strong>Swipe buka layar</strong><p>Gesture swipe menyerahkan proses membuka kunci ke PIN, pola, sidik jari, atau autentikasi sistem Android tanpa membuka aplikasi utama.</p></article>
      <article><span>Changed</span><strong>RTDB realtime di layar kunci</strong><p>Dua slot snapshot Raspberry diperbarui bergantian dan inferensi berjalan terpisah dari canvas agar animasi tetap halus.</p></article>
    </section>
    <section class="static-release" id="windows">
      <h2>Windows app</h2>
      <article><span>New</span><strong>Titlebar custom dengan dokumentasi</strong><p>Ikon buku, tombol pembaruan, minimize, maximize, close, dan tooltip berada di area titlebar.</p></article>
      <article><span>Changed</span><strong>Splash lebih sederhana</strong><p>Logo berada di tengah, warna mengikuti gaya Windows, dan durasi mengikuti data yang dimuat.</p></article>
      <article><span>Changed</span><strong>Kontrol peta lebih ringkas</strong><p>Pitch peta dipadatkan menjadi 2D dan 3D agar layar tidak penuh tombol.</p></article>
    </section>
    <section class="static-release" id="website">
      <h2>Website</h2>
      <article><span>New</span><strong>/documentation dan /new</strong><p>Halaman dokumentasi dan release notes bisa dibuka langsung dari web maupun Windows app.</p></article>
      <article><span>New</span><strong>Push notification ready</strong><p>Service worker dapat menampilkan push notification publik dan membuka URL payload saat diklik.</p></article>
    </section>
    <section class="static-release" id="fixed">
      <h2>Fixed</h2>
      <article><span>Fixed</span><strong>Workflow GitHub Pages</strong><p>Path build disesuaikan dengan struktur repo saat ini supaya tidak mencari folder yang salah.</p></article>
    </section>
    <section class="static-section" id="terminal">
      <h2>Terminal</h2>
      ${terminalStatic(["cd web", "npm run build", "npm run desktop:open"])}
    </section>
  `;
}

function bindStaticModal(): void {
  const modal = document.querySelector<HTMLElement>("[data-static-modal]");
  const panel = document.querySelector<HTMLElement>("[data-static-modal-panel]");
  const close = () => {
    if (!modal || !panel) return;
    modal.classList.remove("open");
    window.setTimeout(() => { modal.hidden = true; panel.style.transform = ""; }, 180);
  };
  document.querySelector<HTMLButtonElement>("[data-open-static-terminal]")?.addEventListener("click", () => {
    if (!modal) return;
    modal.hidden = false;
    window.setTimeout(() => modal.classList.add("open"), 20);
  });
  document.querySelector<HTMLButtonElement>("[data-close-static-modal]")?.addEventListener("click", close);
  document.querySelector<HTMLButtonElement>("[data-enable-notifications]")?.addEventListener("click", requestPublicNotificationPermission);
  bindStaticTerminals();
  if (!panel) return;
  let startX = 0;
  let startY = 0;
  let current = 0;
  let dragging = false;
  panel.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, a")) return;
    startX = event.clientX;
    startY = event.clientY;
    current = 0;
    dragging = true;
    try { panel.setPointerCapture?.(event.pointerId); } catch { /* Pointer may already be released. */ }
  });
  panel.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const desktop = window.matchMedia("(min-width: 760px)").matches;
    current = desktop ? Math.max(0, event.clientX - startX) : Math.max(0, event.clientY - startY);
    if (current < 2) return;
    event.preventDefault();
    panel.style.transform = desktop ? `translateX(${current}px)` : `translateY(${current}px)`;
  });
  const finish = () => {
    if (!dragging) return;
    dragging = false;
    if (current > 84) close();
    else panel.style.transform = "";
  };
  panel.addEventListener("pointerup", finish);
  panel.addEventListener("pointercancel", finish);
}

function bindStaticTerminals(): void {
  document.querySelectorAll<HTMLElement>("[data-static-terminal]").forEach((terminal) => {
    const output = terminal.querySelector<HTMLElement>("[data-terminal-output]");
    const form = terminal.querySelector<HTMLFormElement>("[data-terminal-form]");
    const input = terminal.querySelector<HTMLInputElement>("[data-terminal-input]");
    if (!output || !form || !input || terminal.dataset.bound === "true") return;
    terminal.dataset.bound = "true";
    const append = (line: string, kind = "") => {
      if (line === "__CLEAR__") {
        output.innerHTML = "";
        return;
      }
      const row = document.createElement("div");
      if (kind) row.className = kind;
      row.textContent = line;
      output.appendChild(row);
      output.scrollTop = output.scrollHeight;
    };
    const run = (command: string) => {
      const value = command.trim();
      append(`$ ${value}`, "static-terminal-command");
      staticTerminalResponse(value).forEach((line) => append(line));
      input.value = "";
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      run(input.value);
    });
    terminal.querySelectorAll<HTMLButtonElement>("[data-terminal-command]").forEach((button) => {
      button.addEventListener("click", () => run(button.dataset.terminalCommand || ""));
    });
  });
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app element.");
const staticRoute = staticRouteName(window.location.pathname);
const desktopBridge = (window as Window & { itsDesktop?: ItsDesktopBridge }).itsDesktop;
let itsInitialDataReady = false;
let itsMapReady = false;
if (staticRoute) {
  renderStaticSitePage(app, staticRoute);
} else {
  app.innerHTML = `<div id="map" class="map" aria-label="Raspberry Pi realtime map"></div>`;
  const mapRoot = requiredElement<HTMLDivElement>("#map", "map");

  // ─── Map init ───────────────────────────────────────────────────

  const map = L.map(mapRoot, {
    center: initialMapCenter(),
    zoom: initialMapZoom(),
    zoomControl: false,
    preferCanvas: true,
    rotate: true,
    bearing: initialMapBearing(),
    touchRotate: true,
    rotateControl: false,
  });

  // The map stack is deliberate and stable across latitude/zoom sorting:
  // base road/transit geometry < road ornaments < POI < Raspberry devices.
  // Separate panes prevent a dense route or POI cluster from ever covering a
  // realtime traffic controller.
  const ROAD_ORNAMENT_PANE = "itsRoadOrnamentPane";
  const POI_PANE = "itsPoiPane";
  const RASPBERRY_PANE = "itsRaspberryPane";
  const transportGuidePane = map.createPane("transportGuidePane");
  transportGuidePane.style.zIndex = "445";
  transportGuidePane.style.pointerEvents = "none";
  const roadOrnamentPane = map.createPane(ROAD_ORNAMENT_PANE);
  roadOrnamentPane.style.zIndex = "460";
  roadOrnamentPane.style.pointerEvents = "none";
  const poiPane = map.createPane(POI_PANE);
  poiPane.style.zIndex = "640";
  poiPane.style.pointerEvents = "none";
  const raspberryPane = map.createPane(RASPBERRY_PANE);
  raspberryPane.style.zIndex = "680";
  raspberryPane.style.pointerEvents = "none";
  mapRoot.dataset.layerStack = "road:425,transit:445,ornament:460,json-point:620,poi:640,raspberry:680";
  const transportGuideRenderer = L.svg({ pane: "transportGuidePane", padding: 0.35 });
  const roadDetailRenderer = L.svg({ pane: "overlayPane", padding: 0.35 });

  map.whenReady(() => {
    itsMapReady = true;
    window.dispatchEvent(new CustomEvent("its:map-ready"));
  });

  // ─── State ──────────────────────────────────────────────────────

  const state = {
    config: DEFAULT_CONFIG,
    device: null as DeviceRecord | null,
    devices: [] as DeviceRecord[],
    knownDevicePositions: loadKnownDevicePositions(),
    snapshotHistoryItems: [] as SnapshotHistoryItem[],
    snapshotCache: new Map<string, TrafficCameraDataset>(),
    publicCameraHealth: new Map<string, PublicCameraHealth>(),
    snapshotHistoryRfDetrBusy: false,
    snapshotHistoryAnimationFrame: 0,
    lastSnapshotHistoryWriteErrorAt: 0,
    splashReady: false,
    refreshTimer: 0,
    refreshBusy: false,
    hlsScriptPromise: null as Promise<void> | null,
    hlsInstances: new WeakMap<HTMLVideoElement, any>(),
    videoRfDetrTimer: 0,
    videoRfDetrHost: null as HTMLElement | null,
    videoRfDetrBusy: false,
    videoRfDetrStatus: "idle" as BrowserRfDetrStatus,
    videoRfDetrNote: "",
    videoRfDetrDeviceId: "",
    videoRfDetrLastPublishAt: 0,
    videoRfDetrLastSourceKey: "",
    videoRfDetrLastSnapshotAt: 0,
    videoRfDetrAnimationFrame: 0,
    videoRfDetrCanvasWidth: 0,
    videoRfDetrCanvasHeight: 0,
    videoRfDetrCanvasDetections: [] as RfDetrDetection[],
    videoRfDetrCanvasScanning: false,
    videoAiSegments: [] as VideoAiSegment[],
    videoFullscreenStartedAt: 0,
    videoFullscreenPausedRefreshMs: 0,
    // A shared/deep-linked location is an explicit navigation request. Mark
    // it as the initial center immediately so the first asynchronous RTDB
    // snapshot cannot move the map back to the Raspberry device.
    hasCentered: (() => {
      const params = new URLSearchParams(window.location.search);
      const lat = Number(params.get("lat"));
      const lng = Number(params.get("lng"));
      return Number.isFinite(lat) && Number.isFinite(lng)
        && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
    })(),
    baseMode: initialMapMode(),
    compassNeedle: null as SVGGElement | null,
    compassBtn: null as HTMLButtonElement | null,
    cameraPreview: null as HTMLDivElement | null,
    cameraButton: null as HTMLButtonElement | null,
    markers: new Map<string, L.Marker>(),
    poiMarkers: new Map<string, L.Marker>(),
    poiClusterMarkers: new Map<string, L.Marker>(),
    poiClusters: [] as PoiClusterRecord[],
    poiData: new Map<string, PoiRecord>(),
    poiLabelVisibility: new Map<string, boolean>(),
    poiVisible: (() => {
      try { return localStorage.getItem("its-poi-visible:v1") !== "false"; } catch { return true; }
    })(),
    transitModeFilter: new Set<TransitGuideMode>(["busway", "bus", "mrt", "lrt", "tram", "monorail", "commuter", "high_speed", "train"]),
    roadClassFilter: new Set<"major" | "street" | "foot" | "service">(["major", "street", "foot", "service"]),
    greenVisible: true,
    waterVisible: true,
    cctvVisible: true,
    poiVisibilityButton: null as HTMLButtonElement | null,
    trafficById: new Map<string, TrafficState>(),
    roadNameById: new Map<string, string>(),
    maplibreMap: null as any,
    maplibreContainer: null as HTMLDivElement | null,
    maplibreSyncing: false,
    maplibreSyncFrame: 0,
    // Tablet / routing helpers
    vehicleMarker: null as L.Marker | null,
    tabletCategoryIndex: null as number | null,
    tabletSearchQuery: "",
    routeLayer: null as L.LayerGroup | null,
    destinationMarker: null as L.Marker | null,
    lastUserLocation: null as { lat: number; lng: number; accuracy?: number; source: string; updatedAt: number } | null,
    userLocationWatchId: null as number | null,
    nativeLocationPollTimer: 0,
    mapNavigationSeq: 0,
    pendingDeviceFocusTimer: 0,
    homeNorthTimer: 0,
    homeNorthMoveHandler: null as (() => void) | null,
    activeModalDeviceId: null as string | null,
    activeModalPoiId: null as string | null,
    trafficRefreshTimer: 0,
    offlineReported: new Set<string>(),
    overpassLayer: null as L.LayerGroup | null,
    roadGuideLayer: null as L.LayerGroup | null,
    visionLayer: null as L.LayerGroup | null,
    modeControl: null as L.Control | null,
    routeRequestSeq: 0,
    prevPositionById: new Map<string, L.LatLng>(),
    lastUpdateNoticeKey: "",
    notificationPromptShown: false,
    webrtc: {
      pc: null,
      deviceId: "",
      signalPath: "",
      sessionId: "",
      stream: null,
      pollTimer: 0,
      heartbeatTimer: 0,
      candidateSeq: 0,
      seenCameraCandidates: new Set<string>(),
      pendingCandidates: [],
      sessionReady: false,
      startedAt: 0,
      status: "idle",
      message: "",
    } as WebRtcRuntime,
  };

  // The detail query declares an 18 second server-side limit. Keep the client
  // deadline above it so a valid response is not aborted first.
  const OVERPASS_TIMEOUT_MS = 22_000;
  const OVERPASS_COOLDOWN_MS = 5 * 60 * 1000;
  const OVERPASS_ENDPOINTS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass-api.de/api/interpreter",
  ] as const;
  const OVERPASS_NETWORK_ENABLED = (() => {
    const params = new URLSearchParams(window.location.search);
    // The national PMTiles + verified shard pipeline is the production source.
    // Direct public Overpass calls remain an explicit diagnostics option; they
    // otherwise generate visible 504 errors and duplicate national features.
    return params.get("overpass") === "1";
  })();
  let overpassPoiCooldownUntil = 0;
  let overpassRoadCooldownUntil = 0;
  type OverpassInFlight = { query: string; request: Promise<any> };
  let overpassPoiInFlight: OverpassInFlight | null = null;
  let overpassRoadInFlight: OverpassInFlight | null = null;

  function fetchTimeoutSignal(ms: number): AbortSignal | undefined {
    const signalWithTimeout = AbortSignal as typeof AbortSignal & { timeout?: (timeout: number) => AbortSignal };
    return typeof signalWithTimeout.timeout === "function" ? signalWithTimeout.timeout(ms) : undefined;
  }

  function shouldSkipOverpass(kind: "poi" | "road", now = Date.now()): boolean {
    return now < (kind === "poi" ? overpassPoiCooldownUntil : overpassRoadCooldownUntil);
  }

  function rememberOverpassHttpStatus(kind: "poi" | "road", status: number): void {
    if (status === 429 || status >= 500) {
      const until = Date.now() + OVERPASS_COOLDOWN_MS;
      if (kind === "poi") overpassPoiCooldownUntil = until;
      else overpassRoadCooldownUntil = until;
    }
  }

  // ─── Tile layers ────────────────────────────────────────────────

  const CARTO_TILE_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
  // Keep provider credits in the dedicated map-licence sheet, while restoring
  // the application's legal/help actions that users expect in the map footer.
  // `ITS Maps` itself is supplied by Leaflet's attribution prefix below.
  const CARTO_ATTRIBUTION = [
    '<button type="button" class="map-license-link" data-map-license aria-label="Buka sumber dan lisensi peta" title="Sumber dan lisensi peta">Lisensi Peta</button>',
    '<span class="map-license-separator" aria-hidden="true">|</span>',
    '<button type="button" class="map-license-link" data-ai-license aria-label="Buka lisensi AI" title="Lisensi AI">Lisensi AI</button>',
    '<span class="map-license-separator" aria-hidden="true">|</span>',
    '<button type="button" class="map-license-link" data-roadmap-story aria-label="Buka Roadmap ITS Maps" title="Roadmap ITS Maps">Roadmap</button>',
    '<span class="map-license-separator" aria-hidden="true">|</span>',
    '<button type="button" class="map-license-link" data-privacy-modal aria-label="Buka kebijakan privasi" title="Kebijakan privasi">Privasi</button>',
    '<span class="map-license-separator" aria-hidden="true">|</span>',
    '<a class="map-license-link" href="/documentation/" target="_blank" rel="noopener" aria-label="Buka dokumentasi ITS Maps">Dokumentasi</a>',
    '<span class="map-license-separator" aria-hidden="true">|</span>',
    '<button type="button" class="map-license-link" data-app-license aria-label="Buka licence aplikasi" title="Licence aplikasi">Licence</button>',
    '<span class="map-license-separator" aria-hidden="true">|</span>',
    '<button type="button" class="map-license-link" data-about-site aria-label="Buka informasi tentang ITS Maps" title="Tentang ITS Maps">About</button>',
  ].join(" ");

  const streetLayer = L.tileLayer(CARTO_TILE_URL, {
    maxZoom: 20,
    subdomains: "abcd",
    className: "its-carto-map-tile",
    attribution: "",
  } as L.TileLayerOptions & { className: string; subdomains: string }).addTo(map);

  const satelliteLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 20, attribution: "" },
  );

  if (map.attributionControl) {
    try {
      map.attributionControl.setPrefix("ITS Maps");
      map.attributionControl.addAttribution(CARTO_ATTRIBUTION);
    } catch { /* Attribution is best-effort in older WebView builds. */ }
  }

  // Add Overpass vector layer for clickable features (kept separate from POI markers)
  state.overpassLayer = L.layerGroup().addTo(map);
  state.roadGuideLayer = L.layerGroup().addTo(map);
  state.visionLayer = L.layerGroup().addTo(map);

  function openMapDynamicsPoint(feature: MapDetailFeatureCollection["features"][number], point: L.LatLng): void {
    const properties = feature.properties || {};
    const kind = String(properties.kind || "").toLowerCase();
    if (!/(?:cctv|camera|surveillance|speed_camera)/.test(kind)) return;
    document.getElementById("map-dynamics-camera-modal")?.remove();
    const name = String(properties.name || properties.title || "Kamera CCTV");
    const source = String(properties.source || "Sumber data peta");
    const sourceUrl = usablePublicMediaUrl(String(properties.sourceUrl || ""));
    const streamCandidate = String(properties.streamUrl || properties.publicUrl || properties.linkLive || properties.link_live || "");
    // Never move credentials embedded by an upstream metadata service into
    // client HTML. A public player is rendered only for a credential-free URL.
    const streamUrl = /^(?:https?):\/\//i.test(streamCandidate) && !/@/.test(streamCandidate)
      ? usablePublicMediaUrl(streamCandidate)
      : "";
    const streamStatus = String(properties.streamStatus || (streamUrl ? "public-live" : "metadata-only"));
    const modal = document.createElement("div");
    modal.id = "map-dynamics-camera-modal";
    modal.className = "map-license-modal map-camera-source-modal";
    modal.innerHTML = `
      <section class="map-license-sheet map-camera-source-sheet" role="dialog" aria-modal="true" aria-labelledby="map-camera-source-title">
        <div class="map-license-grip" data-swipe-handle aria-hidden="true"></div>
        <header class="map-license-head">
          <div><span>CCTV terverifikasi</span><h2 id="map-camera-source-title">${escapeHtml(name)}</h2></div>
          <button type="button" data-camera-source-close aria-label="Tutup detail CCTV" title="Tutup"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        </header>
        ${streamUrl ? `
          <div class="map-camera-live-badge"><i></i> LIVE dari penyedia resmi</div>
          <div class="map-camera-public-player">
            <iframe src="${escapeHtml(streamUrl)}" title="Video realtime ${escapeHtml(name)}" loading="eager" allow="autoplay; fullscreen; picture-in-picture" referrerpolicy="no-referrer"></iframe>
          </div>
        ` : `
          <div class="map-camera-unavailable">
            <strong>Lokasi kamera tersedia, URL video publik langsung belum tersedia.</strong>
            <p>ITS Maps tidak menebak URL dan tidak menyalin kredensial kamera ke browser. Status sumber: ${escapeHtml(streamStatus)}.</p>
          </div>
        `}
        <dl class="map-camera-source-meta">
          <div><dt>Koordinat</dt><dd>${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}</dd></div>
          <div><dt>Sumber</dt><dd>${escapeHtml(source)}</dd></div>
        </dl>
        ${sourceUrl ? `<a class="map-camera-source-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Buka sumber resmi</a>` : ""}
      </section>`;
    const close = () => {
      modal.classList.remove("open");
      window.setTimeout(() => modal.remove(), 220);
    };
    modal.addEventListener("click", (event) => { if (event.target === modal) close(); });
    modal.querySelector("[data-camera-source-close]")?.addEventListener("click", close);
    document.body.appendChild(modal);
    const sheet = modal.querySelector<HTMLElement>(".map-camera-source-sheet");
    if (sheet) setupSheetSwipe(sheet, close);
    requestAnimationFrame(() => modal.classList.add("open"));
  }

  const mapDynamicsRenderer = new MapDynamicsLeafletRenderer(map, {
    manifestUrl: "/data/map-dynamics/manifest.json",
    paneName: "its-map-dynamics",
    paneZIndex: 425,
    pointPaneName: "its-map-dynamics-points",
    pointPaneZIndex: 620,
    moveDebounceMs: 260,
    refreshIntervalMs: 5 * 60_000,
    onPointClick: openMapDynamicsPoint,
  });

  function applySharedLocationFromUrl(): void {
    const params = new URLSearchParams(window.location.search);
    const lat = Number(params.get("lat"));
    const lng = Number(params.get("lng"));
    if (!isValidCoordinate(lat, lng)) return;
    const rawRequestedZoom = params.get("z") ?? params.get("zoom");
    const rawRequestedBearing = params.get("bearing");
    const requestedZoom = rawRequestedZoom === null ? Number.NaN : Number(rawRequestedZoom);
    const requestedBearing = rawRequestedBearing === null ? Number.NaN : Number(rawRequestedBearing);
    map.setView(
      [lat, lng],
      Number.isFinite(requestedZoom) ? clamp(requestedZoom, 3, 20) : map.getZoom(),
      { animate: false },
    );
    if (Number.isFinite(requestedBearing)) map.setBearing(requestedBearing);
  }

  function syncMapStateToUrl(): void {
    const center = map.getCenter();
    const params = new URLSearchParams(window.location.search);
    // Keep the current map view shareable, matching familiar map URLs. This is
    // replaceState (not a new history entry) so panning never floods Back/Forward.
    params.set("lat", center.lat.toFixed(6));
    params.set("lng", center.lng.toFixed(6));
    params.set("z", String(Math.round(map.getZoom() * 100) / 100));
    params.set("bearing", String(Math.round((map.getBearing?.() ?? 0) * 10) / 10));
    params.set("mode", state.baseMode);
    params.delete("zoom");
    const query = params.toString();
    const next = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", next);
  }

  map.whenReady(applySharedLocationFromUrl);
  window.addEventListener("popstate", applySharedLocationFromUrl);
  map.whenReady(() => {
    const requestedMode = initialMapMode();
    // CARTO remains the native Leaflet surface for street/2D. MapLibre is
    // created only when an explicit 3D mode is requested.
    void setBaseMap(requestedMode);
  });

  // Leaflet derives the ruler from the current latitude and zoom, then uses a
  // readable metric distance such as 5 m, 100 m, or 1 km.
  L.control.scale({
    position: "bottomleft",
    maxWidth: 96,
    metric: true,
    imperial: false,
    updateWhenIdle: false,
  }).addTo(map);

  function poiVisibilityIcon(visible: boolean): string {
    return visible
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.8"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.7 6.1A10.2 10.2 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-2.2 3M6.2 6.2C3.9 8 2.5 12 2.5 12s3.5 6 9.5 6a10 10 0 0 0 3.2-.5M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  }

  function updatePoiVisibilityButton(): void {
    const button = state.poiVisibilityButton;
    if (!button) return;
    const label = state.poiVisible ? "Sembunyikan POI" : "Tampilkan POI";
    button.innerHTML = poiVisibilityIcon(state.poiVisible);
    button.classList.toggle("is-active", state.poiVisible);
    button.setAttribute("aria-pressed", String(state.poiVisible));
    button.setAttribute("aria-label", label);
    button.title = label;
  }

  function setPoiVisibility(visible: boolean): void {
    state.poiVisible = visible;
    try { localStorage.setItem("its-poi-visible:v1", String(visible)); } catch { /* Preference persistence is optional. */ }
    updatePoiVisibilityButton();
    renderCurrentPoiDataset();
    if (visible) void refreshOverpassLayer(true);
    window.dispatchEvent(new CustomEvent("its:poi-visibility", { detail: { visible } }));
  }

  const PoiVisibilityControl = L.Control.extend({
    options: { position: "bottomright" },
    onAdd: () => {
      const container = L.DomUtil.create("div", "leaflet-control poi-visibility-control");
      const button = L.DomUtil.create("button", "poi-visibility-button", container) as HTMLButtonElement;
      button.type = "button";
      state.poiVisibilityButton = button;
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      L.DomEvent.on(button, "click", (event) => {
        L.DomEvent.stop(event);
        setPoiVisibility(!state.poiVisible);
      });
      updatePoiVisibilityButton();
      return container;
    },
  });
  new PoiVisibilityControl().addTo(map);

  // ─── POI Layer ─────────────────────────────────────────────────────

  function poiDefinition(poi: PoiRecord): PoiIconDefinition {
    return poiIconById(poi.iconId);
  }

  function normalizePoiRecord(value: PoiRecord): PoiRecord {
    const tags = value.tags && typeof value.tags === "object" ? value.tags : {};
    const definition = value.iconId ? poiIconById(value.iconId) : resolvePoiIcon(tags, [value.kind]);
    const osmMatch = String(value.id || "").match(/overpass-(node|way|relation)-(\d+)/);
    const sourceUrl = value.sourceUrl || (osmMatch ? `https://www.openstreetmap.org/${osmMatch[1]}/${osmMatch[2]}` : "https://www.openstreetmap.org/");
    const legacyRecord = !value.sourceLabel;
    return {
      ...value,
      kind: definition.category,
      iconId: definition.id,
      icon: definition.glyph,
      tags,
      description: legacyRecord ? tags.description || tags.note || "" : value.description || "",
      imageUrl: legacyRecord ? poiIconAssetUrl(definition, "hero") || ITS_APP_ICON : value.imageUrl || poiIconAssetUrl(definition, "hero") || ITS_APP_ICON,
      sourceLabel: value.sourceLabel || "OpenStreetMap",
      sourceUrl,
    };
  }

  function poiMarkerSizeByZoom(): number {
    // POI symbols use stable screen pixels. Zoom reveals more records and
    // labels without making existing markers jump or grow.
    return window.matchMedia("(max-width: 720px)").matches ? 17 : 18;
  }

  function makePoiIcon(poi: PoiRecord, baseSize: number): L.DivIcon {
    const definition = poiDefinition(poi);
    const selected = state.activeModalPoiId === poi.id;
    const variant = "micro";
    const imageUrl = poiIconAssetUrl(definition, variant) || ITS_APP_ICON;
    const size = selected
      ? clamp(baseSize * 1.22, 20, 26)
      : clamp(baseSize * (definition.baseSize / 18), 14, 21);
    const label = poi.title.trim().replace(/\s+/g, " ");
    const showLabel = state.poiLabelVisibility.get(poi.id) !== false;
    const lineCount = Math.min(2, Math.max(1, Math.ceil(label.length / 18)));
    const longestLine = Math.min(22, Math.max(8, Math.ceil(label.length / lineCount)));
    const labelWidth = showLabel ? clamp(longestLine * 6.1 + 12, 52, 142) : 0;
    // Keep the cartographic symbol small while making the marker's actual
    // interactive box meet the 48 CSS px touch-target recommendation.
    const hitWidth = Math.max(48, Math.round(size + (showLabel ? labelWidth + 7 : 0)));
    const hitHeight = Math.max(48, Math.round(Math.max(size + 9, lineCount > 1 ? 31 : 24)));
    return L.divIcon({
      className: "poi-marker-icon",
      html: `<div class="poi-marker ${selected ? "is-selected" : ""}" data-kind="${escapeHtml(poi.kind)}" data-icon-id="${escapeHtml(definition.id)}" title="${escapeHtml(poi.title)}" style="--poi-accent:${definition.color}; --poi-size:${Math.round(size)}px;">
        <span class="poi-image-marker" style="width:${Math.round(size)}px;height:${Math.round(size)}px"><img src="${escapeHtml(imageUrl)}" alt="" draggable="false" width="${Math.round(size)}" height="${Math.round(size)}"></span>
        ${showLabel ? `<span class="poi-marker-label">${escapeHtml(label)}</span>` : ""}
      </div>`,
      iconSize: [hitWidth, hitHeight],
      iconAnchor: [Math.round(size / 2), hitHeight],
      popupAnchor: [0, -Math.round(size)],
    });
  }

  function renderPoiModal(poi: PoiRecord): string {
    const definition = poiDefinition(poi);
    const heroImage = poi.imageUrl || poiIconAssetUrl(definition, "hero") || ITS_APP_ICON;
    return `
  <div class="sheet-panel-header poi-panel-header">
    <button class="sheet-icon-btn modal-close" data-action="close" aria-label="Kembali" title="Kembali">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
    </button>
    <div class="sheet-title-cluster">
      <div class="sheet-place-icon poi-sheet-place-icon" style="--poi-accent:${definition.color};"><img src="${escapeHtml(poiIconAssetUrl(definition, "micro") || ITS_APP_ICON)}" alt=""></div>
      <div class="sheet-title-copy">
        <h2 class="modal-title">${escapeHtml(poi.title)}</h2>
        <p>${escapeHtml(poi.kind)}${poi.address ? ` · ${escapeHtml(poi.address)}` : ""}</p>
      </div>
    </div>
    <div class="sheet-header-actions">
      <button class="sheet-icon-btn btn-share" data-action="share" aria-label="Bagikan lokasi" title="Bagikan">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a3 3 0 1 0-2.83-4H15a3 3 0 0 0 1.2 2.4L8.8 10.1a3 3 0 1 0 0 3.8l7.4 3.7A3 3 0 1 0 17 16a2.9 2.9 0 0 0-.8.1l-7.4-3.7a3 3 0 0 0 0-.8l7.4-3.7A2.9 2.9 0 0 0 18 8Z"/></svg>
      </button>
      <button class="sheet-icon-btn btn-start" data-action="start" aria-label="Mulai rute" title="Rute">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l7 19-7-4-7 4 7-19Z"/></svg>
      </button>
      <button class="sheet-icon-btn btn-camera" data-action="camera" aria-label="Buka kamera AR" title="Kamera">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l1.6-2h6.8L17 8h3v10H4V8Zm8 8a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/></svg>
      </button>
    </div>
  </div>
  <div class="modal-header poi-modal-header">
    <button class="modal-close" data-action="close">×</button>
    <h2 class="modal-title">${escapeHtml(poi.title)}</h2>
    <div class="poi-actions">
      <button class="btn-share" data-action="share">Share</button>
      <button class="btn-start" data-action="start">Pergi</button>
    </div>
  </div>
  <div class="modal-content poi-modal-content">
    <div class="poi-hero">
      <img class="poi-hero-image ${heroImage === ITS_APP_ICON ? "poi-hero-image-contained" : ""}" src="${escapeHtml(heroImage)}" alt="Ilustrasi kategori ${escapeHtml(poi.kind)} untuk ${escapeHtml(poi.title)}">
      <div class="poi-hero-overlay">
        <span class="poi-badge">${escapeHtml(poi.kind.toUpperCase())}</span>
        <a class="poi-source-badge" href="${escapeHtml(poi.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(poi.sourceLabel)}</a>
      </div>
    </div>
    <div class="poi-summary">
      <div class="poi-icon-large">${poi.icon}</div>
      <div>
        <div class="poi-title">${escapeHtml(poi.title)}</div>
        <div class="poi-address">${escapeHtml(poi.address)}</div>
        <div class="poi-meta"><span data-field="poi-distance">-</span> • <span data-field="poi-eta">-</span></div>
      </div>
    </div>
    ${poi.description ? `<div class="poi-description">${escapeHtml(poi.description)}</div>` : ""}
    <div class="poi-route-summary" data-field="poi-route"></div>
    <div class="info-row"><span class="label">Kategori</span><span class="value">${escapeHtml(poi.kind)}</span></div>
    <div class="info-row"><span class="label">Koordinat</span><span class="value">${poi.lat.toFixed(6)}, ${poi.lng.toFixed(6)}</span></div>
  </div>`;
  }

  function openPoiModal(poi: PoiRecord): void {
    if (isMobile()) {
      closeITSSheet();
      document.getElementById("m-profil-sheet")?.remove();
      if (document.getElementById("m-ai-history-sheet")) snapAiHistorySheet("dock");
    }
    closeModal(false);
    closePromptPanels();
    state.activeModalPoiId = poi.id;
    renderCurrentPoiDataset();
    const overlay = createSwipeableSheetModal(
      "m-poi-modal",
      "m-poi-sheet m-device-sheet",
      `
    <div class="m-sheet-handle-bar"></div>
    ${renderPoiModal(poi)}
  `,
    );
    overlay.querySelector(".m-layer-backdrop")!.addEventListener("click", () => closeModal());
    const sheet = overlay.querySelector<HTMLElement>(".m-poi-sheet");
    if (!sheet) return;
    setupSheetSwipe(sheet, closeModal);
    sheet.querySelector<HTMLButtonElement>(".modal-close")?.addEventListener("click", () => closeModal());

    // Wire up share and start buttons and populate distance/ETA + image
    const shareBtn = sheet.querySelector<HTMLButtonElement>(".btn-share");
    const startBtn = sheet.querySelector<HTMLButtonElement>(".btn-start");
    const cameraBtn = sheet.querySelector<HTMLButtonElement>(".btn-camera");
    shareBtn?.addEventListener("click", async () => {
      const url = appPlaceUrl(poi.lat, poi.lng, poi.title);
      try {
        if ((navigator as any).share) {
          await (navigator as any).share({ title: poi.title, text: poi.description || poi.title, url });
        } else {
          await navigator.clipboard.writeText(url);
          alert("Link lokasi disalin ke clipboard");
        }
      } catch (err) { console.warn(err); }
    });
    startBtn?.addEventListener("click", async () => {
      // Start navigation: draw route and if mobile open AR camera view
      void setDestinationToPoi(poi);
      if (isMobile()) {
        openARCameraSheet(poi);
      }
    });
    cameraBtn?.addEventListener("click", () => openARCameraSheet(poi));

    // Compute distance/ETA via OSRM. Image source stays from POI data/library so it
    // remains deterministic in desktop and mobile previews.
    const heroImg = sheet.querySelector<HTMLImageElement>(".poi-hero-image");
    if (heroImg) {
      heroImg.onerror = () => {
        heroImg.src = ITS_APP_ICON;
      };
    }

    const distanceEl = sheet.querySelector<HTMLElement>("[data-field=poi-distance]");
    const etaEl = sheet.querySelector<HTMLElement>("[data-field=poi-eta]");
    const routeSummaryEl = sheet.querySelector<HTMLElement>("[data-field=poi-route]");

    (async () => {
      try {
        const fromLatLng = state.vehicleMarker ? state.vehicleMarker.getLatLng() : map.getCenter();
        if (!fromLatLng) return;
        const url = `https://router.project-osrm.org/route/v1/driving/${fromLatLng.lng},${fromLatLng.lat};${poi.lng},${poi.lat}?overview=false&steps=true&geometries=geojson`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error("route failed");
        const data = await res.json();
        const route = data.routes?.[0];
        const dist = route?.distance ?? haversineDistanceMeters(fromLatLng.lat, fromLatLng.lng, poi.lat, poi.lng);
        const dur = route?.duration ?? (dist / 1000) / 40 * 3600; // fallback assume 40 km/h
        if (distanceEl) distanceEl.textContent = formatDistance(dist);
        if (etaEl) etaEl.textContent = formatEtaSeconds(dur);
        if (routeSummaryEl && route && route.legs && route.legs.length) {
          const steps = route.legs[0].steps || [];
          routeSummaryEl.innerHTML = `<div class="route-steps"><strong>Rute:</strong><ol>${steps.slice(0, 6).map((s: any) => `<li>${escapeHtml(String(s.maneuver?.instruction || s.name || 'Lurus'))} (${formatDistance(s.distance)})</li>`).join('')}</ol></div>`;
        }
      } catch (err) {
        try {
          // fallback compute straight-line distance
          const fromLatLng = state.vehicleMarker ? state.vehicleMarker.getLatLng() : map.getCenter();
          if (fromLatLng && distanceEl && etaEl) {
            const dist = haversineDistanceMeters(fromLatLng.lat, fromLatLng.lng, poi.lat, poi.lng);
            distanceEl.textContent = formatDistance(dist);
            etaEl.textContent = formatEtaSeconds((dist / 1000) / 40 * 3600);
          }
        } catch { }
      }
    })();
  }

  function openARCameraSheet(targetPoi: PoiRecord): void {
    const overlay = document.createElement('div');
    overlay.id = 'm-ar-fullscreen';
    overlay.innerHTML = `
  <div class="ar-fullscreen-wrapper">
    <video class="ar-video" autoplay playsinline muted></video>
    <canvas class="ar-canvas"></canvas>
    <div class="ar-guidance">
      <div class="ar-guidance-arrow" data-field="ar-arrow">↑</div>
      <div class="ar-guidance-text" data-field="ar-direction">Arah tujuan</div>
    </div>
    <button class="ar-target-beacon" data-field="ar-target-beacon" type="button">
      <span class="ar-target-beacon-icon">📍</span>
      <span class="ar-target-beacon-text">Tujuan</span>
    </button>
    <div class="ar-hud-bottom">
      <div class="ar-hud-status" data-field="ar-status">🎥 AR Mode aktif</div>
      <div class="ar-hud-info">
        <span data-field="ar-target">Tujuan: ${escapeHtml(targetPoi.title)}</span>
        <span data-field="ar-distance">Jarak: -</span>
        <span data-field="ar-eta">Waktu: -</span>
      </div>
    </div>
    <div class="ar-poi-layer"></div>
    <div class="ar-object-layer"></div>
    <div class="ar-controls-bottom">
      <button class="ar-toggle-3d" aria-label="Toggle 3D">3D</button>
      <button class="ar-swap-pip" aria-label="Swap PiP">↔️</button>
      <button class="ar-close">✕</button>
    </div>
    <div class="ar-pip-map-container" style="display:none">
      <div id="ar-pip-map" class="ar-pip-map"></div>
      <div class="ar-pip-info" data-field="pip-distance">Jarak: -</div>
    </div>
  </div>
`;
    document.body.appendChild(overlay);

    const video = overlay.querySelector<HTMLVideoElement>('.ar-video');
    const canvas = overlay.querySelector<HTMLCanvasElement>('.ar-canvas');
    const poiLayer = overlay.querySelector<HTMLElement>('.ar-poi-layer');
    const objectLayer = overlay.querySelector<HTMLElement>('.ar-object-layer');
    const statusEl = overlay.querySelector<HTMLElement>('[data-field="ar-status"]');
    const distanceEl = overlay.querySelector<HTMLElement>('[data-field="ar-distance"]');
    const etaEl = overlay.querySelector<HTMLElement>('[data-field="ar-eta"]');
    const guidanceArrow = overlay.querySelector<HTMLElement>('[data-field="ar-arrow"]');
    const guidanceText = overlay.querySelector<HTMLElement>('[data-field="ar-direction"]');
    const targetBeacon = overlay.querySelector<HTMLButtonElement>('[data-field="ar-target-beacon"]');
    const toggleBtn = overlay.querySelector<HTMLButtonElement>('.ar-toggle-3d');
    const swapBtn = overlay.querySelector<HTMLButtonElement>('.ar-swap-pip');
    const closeBtn = overlay.querySelector<HTMLButtonElement>('.ar-close');
    const pipContainer = overlay.querySelector<HTMLElement>('.ar-pip-map-container');
    const pipMapEl = overlay.querySelector<HTMLElement>('#ar-pip-map');
    const pipDistanceEl = overlay.querySelector<HTMLElement>('[data-field="pip-distance"]');
    if (!video || !canvas || !poiLayer || !objectLayer || !statusEl || !distanceEl || !etaEl || !guidanceArrow || !guidanceText || !targetBeacon || !toggleBtn || !closeBtn || !pipContainer || !pipMapEl || !pipDistanceEl) return;

    const videoEl = video as HTMLVideoElement;
    const canvasEl = canvas as HTMLCanvasElement;
    const poiLayerEl = poiLayer as HTMLElement;
    const objectLayerEl = objectLayer as HTMLElement;
    const statusElEl = statusEl as HTMLElement;
    const distanceElEl = distanceEl as HTMLElement;
    const etaElEl = etaEl as HTMLElement;
    const guidanceArrowEl = guidanceArrow as HTMLElement;
    const guidanceTextEl = guidanceText as HTMLElement;
    const targetBeaconEl = targetBeacon as HTMLButtonElement;
    const toggleBtnEl = toggleBtn as HTMLButtonElement;
    const closeBtnEl = closeBtn as HTMLButtonElement;
    const swapBtnEl = swapBtn as HTMLButtonElement;
    const pipContainerEl = pipContainer as HTMLElement;
    const pipMapElDiv = pipMapEl as HTMLElement;
    const pipDistanceElDiv = pipDistanceEl as HTMLElement;

    let stream: MediaStream | null = null;
    let running = true;
    let headingDeg = map.getBearing?.() ?? 0;
    let currentPos: L.LatLng | null = state.vehicleMarker?.getLatLng() ?? null;
    let currentTarget = targetPoi;
    let activePoiLookup = new Map<string, PoiRecord>();
    let destinationReached = false;
    let poiCards = new Map<string, HTMLElement>();
    let objectCards = new Map<string, HTMLElement>();
    let nearbyFetchToken = 0;
    let detectBusy = false;
    let ar3dEnabled = true;
    let arIsPrimary = true;
    let pipMapInstance: L.Map | null = null;
    let cleanedUp = false;

    function setStatus(text: string): void {
      statusElEl.textContent = text;
    }

    function bearingDelta(from: number, to: number): number {
      return ((to - from + 540) % 360) - 180;
    }

    function turnInstructionFromDelta(delta: number): string {
      const abs = Math.abs(delta);
      if (abs < 12) return 'Lurus';
      if (delta > 0) return abs < 35 ? 'Belok kanan' : 'Ke kanan';
      return abs < 35 ? 'Belok kiri' : 'Ke kiri';
    }

    function ensureSkeletonCard(poi: PoiRecord): HTMLElement {
      const existing = poiCards.get(poi.id);
      if (existing) return existing;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'ar-poi-card ar-skeleton-card';
      card.dataset.poiId = poi.id;
      card.title = poi.title;
      card.innerHTML = `
    <div class="ar-poi-icon">${escapeHtml(poi.icon)}</div>
    <div class="ar-poi-distance">-</div>
  `;
      card.addEventListener('click', () => {
        const selectedPoi = activePoiLookup.get(poi.id);
        if (!selectedPoi) return;
        openPoiModal(selectedPoi);
      });
      poiLayerEl.appendChild(card);
      poiCards.set(poi.id, card);
      return card;
    }

    function ensureObjectCard(key: string, label: string): HTMLElement {
      const existing = objectCards.get(key);
      if (existing) return existing;
      const card = document.createElement('div');
      card.className = 'ar-object-card ar-skeleton-card';
      card.dataset.objectKey = key;
      card.innerHTML = `
    <div class="ar-object-label">${escapeHtml(label)}</div>
    <div class="ar-skeleton-box"></div>
  `;
      objectLayerEl.appendChild(card);
      objectCards.set(key, card);
      return card;
    }

    function cleanupCollections(activePoiIds: Set<string>, activeObjectKeys: Set<string>): void {
      for (const [id, el] of poiCards.entries()) {
        if (!activePoiIds.has(id)) {
          el.remove();
          poiCards.delete(id);
        }
      }
      for (const [key, el] of objectCards.entries()) {
        if (!activeObjectKeys.has(key)) {
          el.remove();
          objectCards.delete(key);
        }
      }
    }

    function updateTargetStats(): void {
      if (!currentPos) return;
      const dist = haversineDistanceMeters(currentPos.lat, currentPos.lng, currentTarget.lat, currentTarget.lng);
      const eta = (dist / 1000) / 40 * 3600;
      distanceElEl.textContent = `Jarak: ${formatDistance(dist)}`;
      etaElEl.textContent = `Waktu: ${formatEtaSeconds(eta)}`;
      const bearingToTarget = computeBearing(currentPos.lat, currentPos.lng, currentTarget.lat, currentTarget.lng);
      const deltaToTarget = bearingDelta(headingDeg, bearingToTarget);
      const halfFov = 36;
      const beaconX = Math.max(8, Math.min(92, 50 + (deltaToTarget / halfFov) * 42));
      const beaconY = Math.max(14, Math.min(66, 36 + (dist / 1500) * 12));
      guidanceArrowEl.style.transform = `rotate(${deltaToTarget}deg)`;
      guidanceArrowEl.classList.toggle('is-centered', Math.abs(deltaToTarget) < 8);
      guidanceTextEl.textContent = `${bearingLabel(bearingToTarget)} · ${turnInstructionFromDelta(deltaToTarget)} · ${formatDistance(dist)}`;
      targetBeaconEl.style.left = `${beaconX}%`;
      targetBeaconEl.style.top = `${beaconY}%`;
      targetBeaconEl.title = `${currentTarget.title} · ${bearingLabel(bearingToTarget)} · ${formatDistance(dist)}`;
      targetBeaconEl.querySelector('.ar-target-beacon-text')!.textContent = `${formatDistance(dist)}`;
      targetBeaconEl.classList.toggle('is-centered', Math.abs(deltaToTarget) < 8);
      if (dist < 18 && !destinationReached) {
        destinationReached = true;
        setStatus('Anda sudah sampai tujuan');
        closeModal();
        const reached = createSwipeableSheetModal('m-arrived-modal', 'm-arrived-sheet', `
      <div class="m-sheet-handle-bar"></div>
      <div class="ar-arrived">
        <div class="ar-arrived-title">Anda sudah sampai tujuan</div>
        <div class="ar-arrived-subtitle">${escapeHtml(currentTarget.title)}</div>
      </div>
    `);
        setTimeout(() => reached.remove(), 2600);
      }
    }

    function placePoiCard(card: HTMLElement, poi: PoiRecord): boolean {
      if (poi.id === currentTarget.id) return false;
      if (!currentPos) return false;
      const dist = haversineDistanceMeters(currentPos.lat, currentPos.lng, poi.lat, poi.lng);
      const bearingToPoi = computeBearing(currentPos.lat, currentPos.lng, poi.lat, poi.lng);
      const delta = bearingDelta(headingDeg, bearingToPoi);
      const fov = 72;
      const halfFov = fov / 2;
      const inRange = dist <= 850;
      const inView = Math.abs(delta) <= halfFov;
      const visible = inRange && inView;
      if (!visible) {
        card.remove();
        poiCards.delete(poi.id);
        return false;
      }
      const screenX = Math.max(8, Math.min(92, 50 + (delta / halfFov) * 40));
      const lift = clamp(68 - Math.log10(Math.max(dist, 5)) * 18, 8, 62);
      const size = clamp(1.02 - dist / 2100, 0.86, 1.02);
      const dirLabel = bearingLabel(bearingToPoi);
      const turnLabel = turnInstructionFromDelta(delta);
      const centered = Math.abs(delta) < 8;
      card.classList.remove('ar-skeleton-card');
      card.title = `${poi.title} · ${dirLabel} · ${turnLabel}`;
      card.innerHTML = `
    <div class="ar-poi-icon">${escapeHtml(poi.icon)}</div>
    <div class="ar-poi-distance">${formatDistance(dist)}</div>
  `;
      card.classList.toggle('ar-poi-centered', centered);
      Object.assign(card.style, {
        left: `${screenX}%`,
        top: `${lift}%`,
        transform: `translate(-50%, -50%) scale(${size}) perspective(900px) rotateX(16deg) rotateY(${delta > 0 ? '-8deg' : '8deg'})`,
        opacity: `${clamp(1.15 - dist / 1300, 0.3, 1)}`,
      });
      if (poi.id === currentTarget.id) {
        card.classList.add('ar-target-card');
      }
      card.dataset.bearing = String(Math.round(bearingToPoi));
      card.dataset.delta = String(Math.round(delta));
      card.dataset.distance = String(Math.round(dist));
      return true;
    }
    mapRoot.classList.add('hidden');
    document.getElementById('m-bottom-nav')?.classList.add('hidden');

    async function fetchNearbyPoiCards(): Promise<void> {
      if (!currentPos) return;
      const token = ++nearbyFetchToken;
      setStatus('Memuat POI sekitar...');
      const bounds = L.latLngBounds(
        [currentPos.lat - 0.01, currentPos.lng - 0.01],
        [currentPos.lat + 0.01, currentPos.lng + 0.01],
      );
      let pois = await fetchOverpassFeaturesForBounds(bounds).catch(() => [] as PoiRecord[]);
      if (token !== nearbyFetchToken) return;
      if (!pois.length) {
        setStatus("POI belum tersedia untuk area ini");
      }
      pois = pois.slice(0, 12);
      activePoiLookup = new Map(pois.map((p) => [p.id, p]));
      const activePoiIds = new Set<string>();
      activePoiIds.add(currentTarget.id);
      pois.forEach((poi) => {
        const card = ensureSkeletonCard(poi);
        if (placePoiCard(card, poi)) activePoiIds.add(poi.id);
      });
      cleanupCollections(activePoiIds, new Set(objectCards.keys()));
      setStatus('POI sekitar aktif');
    }

    function updateObjectOverlays(predictions: Array<{ bbox: number[]; class?: string; score?: number }>): void {
      const active = new Set<string>();
      predictions.filter((p) => (p.score ?? 0) > 0.45).slice(0, 10).forEach((p, index) => {
        const key = `${p.class || 'object'}-${index}`;
        active.add(key);
        const label = p.class || 'object';
        const card = ensureObjectCard(key, label);
        const [x, y, w, h] = p.bbox;
        const bw = Math.max(8, (w / Math.max(videoEl.videoWidth, 1)) * 100);
        const bh = Math.max(8, (h / Math.max(videoEl.videoHeight, 1)) * 100);
        const cx = ((x + w / 2) / Math.max(videoEl.videoWidth, 1)) * 100;
        const cy = ((y + h / 2) / Math.max(videoEl.videoHeight, 1)) * 100;
        const bg = /person/i.test(label) ? 'linear-gradient(180deg,#2563eb,#93c5fd)' : /car|truck|bus|motorcycle|vehicle/i.test(label) ? 'linear-gradient(180deg,#ef4444,#fb7185)' : /plant|tree/i.test(label) ? 'linear-gradient(180deg,#16a34a,#86efac)' : 'linear-gradient(180deg,#475569,#94a3b8)';
        card.classList.remove('ar-skeleton-card');
        card.innerHTML = `
      <div class="ar-object-label">${escapeHtml(label)}</div>
      <div class="ar-object-distance">${Math.max(1, Math.round(1200 / Math.max(bw, 8)))}m</div>
    `;
        Object.assign(card.style, {
          left: `${cx}%`,
          top: `${cy}%`,
          width: `${bw}%`,
          height: `${bh}%`,
          background: bg,
          transform: ar3dEnabled ? 'perspective(900px) rotateX(18deg)' : '',
          opacity: '1',
        });
      });
      cleanupCollections(new Set(poiCards.keys()), active);
    }

    async function loadTfModel(): Promise<any | null> {
      if (!(window as any).tf) {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.8.0/dist/tf.min.js';
          s.onload = () => resolve();
          s.onerror = () => reject(new Error('tfjs load failed'));
          document.head.appendChild(s);
        });
      }
      if (!(window as any).cocoSsd) {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd';
          s.onload = () => resolve();
          s.onerror = () => reject(new Error('coco-ssd load failed'));
          document.head.appendChild(s);
        });
      }
      return (window as any).cocoSsd.load();
    }

    async function refreshAr(): Promise<void> {
      if (!running || !currentPos) return;
      updateTargetStats();
      const distToTarget = haversineDistanceMeters(currentPos.lat, currentPos.lng, currentTarget.lat, currentTarget.lng);
      const etaToTarget = formatEtaSeconds((distToTarget / 1000) / 40 * 3600);
      distanceElEl.textContent = `Jarak: ${formatDistance(distToTarget)}`;
      etaElEl.textContent = `Waktu: ${etaToTarget}`;
      if (pipDistanceElDiv && !arIsPrimary) {
        pipDistanceElDiv.textContent = `${formatDistance(distToTarget)}`;
      }
      headingDeg = map.getBearing?.() ?? headingDeg;
      await fetchNearbyPoiCards();
      if (model && !detectBusy && ar3dEnabled) {
        detectBusy = true;
        try {
          const preds = await model.detect(videoEl as any);
          updateObjectOverlays(preds || []);
        } catch (err) {
          console.warn('detect error', err);
        } finally {
          detectBusy = false;
        }
      }
      if (running) setTimeout(() => void refreshAr(), 320);
    }

    let model: any | null = null;
    let watchId: number | null = null;
    let orientationCleanup = () => { /* noop */ };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        videoEl.srcObject = stream;
        await videoEl.play();
        await new Promise<void>((resolve) => {
          if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) return resolve();
          videoEl.onloadedmetadata = () => resolve();
        });
        canvasEl.width = videoEl.videoWidth || 1280;
        canvasEl.height = videoEl.videoHeight || 720;
        const ctx = canvasEl.getContext('2d');
        if (!ctx) throw new Error('canvas context unavailable');

        const skeletonPoi = document.createElement('div');
        skeletonPoi.className = 'ar-skeleton-anchor';
        poiLayerEl.appendChild(skeletonPoi);

        try {
          model = await loadTfModel();
        } catch (err) {
          console.warn('TF model load failed', err);
        }

        watchId = navigator.geolocation?.watchPosition?.((pos) => {
          currentPos = L.latLng(pos.coords.latitude, pos.coords.longitude);
          if (pipMapInstance && !arIsPrimary) {
            pipMapInstance.setView([currentPos.lat, currentPos.lng], pipMapInstance.getZoom());
            if (pipDistanceElDiv) {
              const distToPoi = haversineDistanceMeters(currentPos.lat, currentPos.lng, currentTarget.lat, currentTarget.lng);
              pipDistanceElDiv.textContent = `${formatDistance(distToPoi)}`;
            }
          }
        }, () => { /* ignore */ }, { enableHighAccuracy: true, maximumAge: 1500, timeout: 8000 }) ?? null;

        const onOrientation = (ev: DeviceOrientationEvent) => {
          const webkitHeading = (ev as any).webkitCompassHeading;
          if (typeof webkitHeading === 'number') headingDeg = webkitHeading;
        };
        window.addEventListener('deviceorientationabsolute', onOrientation, true);
        window.addEventListener('deviceorientation', onOrientation, true);
        orientationCleanup = () => {
          window.removeEventListener('deviceorientationabsolute', onOrientation, true);
          window.removeEventListener('deviceorientation', onOrientation, true);
        };

        const drawLoop = (): void => {
          if (!running) return;
          try {
            ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
            if (ar3dEnabled) {
              const grd = ctx.createLinearGradient(0, 0, canvasEl.width, canvasEl.height);
              grd.addColorStop(0, 'rgba(59,130,246,0.08)');
              grd.addColorStop(0.5, 'rgba(16,185,129,0.04)');
              grd.addColorStop(1, 'rgba(236,72,153,0.06)');
              ctx.fillStyle = grd;
              ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
            }
          } catch {
            /* ignore */
          }
          requestAnimationFrame(drawLoop);
          overlay.style.pointerEvents = 'auto';
        };
        drawLoop();

        toggleBtnEl.addEventListener('click', () => {
          ar3dEnabled = !ar3dEnabled;
          toggleBtnEl.textContent = ar3dEnabled ? '3D On' : '3D Off';
          poiLayerEl.classList.toggle('ar-3d-off', !ar3dEnabled);
          objectLayerEl.classList.toggle('ar-3d-off', !ar3dEnabled);
        });

        const applySwapState = (primaryCamera: boolean): void => {
          arIsPrimary = primaryCamera;
          overlay.classList.toggle('ar-swapped', !primaryCamera);
          overlay.style.background = primaryCamera ? '#000' : 'transparent';
          pipContainerEl.style.display = primaryCamera ? 'block' : 'none';
          poiLayerEl.style.display = primaryCamera ? 'block' : 'none';
          objectLayerEl.style.display = primaryCamera ? 'block' : 'none';
          statusElEl.style.display = primaryCamera ? 'block' : 'none';
          distanceElEl.style.display = primaryCamera ? 'block' : 'none';
          etaElEl.style.display = primaryCamera ? 'block' : 'none';
          toggleBtnEl.style.display = primaryCamera ? 'inline-flex' : 'none';
          swapBtnEl.style.display = 'inline-flex';
          closeBtnEl.style.display = 'inline-flex';
          videoEl.style.position = primaryCamera ? 'absolute' : 'absolute';
          videoEl.style.top = primaryCamera ? '0' : '16px';
          videoEl.style.left = primaryCamera ? '0' : 'auto';
          videoEl.style.right = primaryCamera ? '0' : '16px';
          videoEl.style.bottom = primaryCamera ? '0' : 'auto';
          videoEl.style.width = primaryCamera ? '100%' : 'min(42vw, 188px)';
          videoEl.style.height = primaryCamera ? '100%' : 'min(30vw, 134px)';
          videoEl.style.objectFit = primaryCamera ? 'cover' : 'cover';
          videoEl.style.borderRadius = primaryCamera ? '0' : '16px';
          videoEl.style.zIndex = primaryCamera ? '1' : '15';
          mapRoot.classList.toggle('hidden', primaryCamera);
          document.getElementById('m-bottom-nav')?.classList.toggle('hidden', primaryCamera);
          targetBeaconEl.addEventListener('click', () => openPoiModal(currentTarget));
          if (!primaryCamera) {
            if (currentPos) {
              const distToPoi = haversineDistanceMeters(currentPos.lat, currentPos.lng, currentTarget.lat, currentTarget.lng);
              pipDistanceElDiv.textContent = `${formatDistance(distToPoi)}`;
            }
            if (!pipMapInstance && currentPos) {
              pipMapInstance = L.map(pipMapElDiv).setView([currentPos.lat, currentPos.lng], 17);
              L.tileLayer(CARTO_TILE_URL, { maxZoom: 20, subdomains: "abcd", attribution: CARTO_ATTRIBUTION }).addTo(pipMapInstance);
              L.marker([currentPos.lat, currentPos.lng], { icon: L.icon({ iconUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0Ij48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI4IiBmaWxsPSIjZmY0NDQ0Ii8+PC9zdmc+', iconSize: [24, 24] }) }).addTo(pipMapInstance);
              L.marker([currentTarget.lat, currentTarget.lng], { icon: L.icon({ iconUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0Ij48cmVjdCB4PSI0IiB5PSI0IiB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIGZpbGw9IiMxMGI5ODEiIHJ4PSIyIi8+PC9zdmc+', iconSize: [24, 24] }) }).addTo(pipMapInstance);
            }
          }
        };

        swapBtnEl.addEventListener('click', () => applySwapState(!arIsPrimary));
        pipContainerEl.addEventListener('click', () => {
          if (arIsPrimary) applySwapState(false);
        });
        videoEl.addEventListener('click', () => {
          if (!arIsPrimary) applySwapState(true);
        });
        applySwapState(true);

        const cleanupArSession = (removeOverlay: boolean): void => {
          if (cleanedUp) return;
          cleanedUp = true;
          running = false;
          orientationCleanup();
          if (watchId !== null) navigator.geolocation.clearWatch(watchId);
          if (stream) stream.getTracks().forEach((track) => track.stop());
          if (pipMapInstance) {
            pipMapInstance.remove();
            pipMapInstance = null;
          }
          poiCards.forEach((el) => el.remove());
          objectCards.forEach((el) => el.remove());
          poiCards.clear();
          objectCards.clear();
          mapRoot.classList.remove('hidden');
          document.getElementById('m-bottom-nav')?.classList.remove('hidden');
          if (removeOverlay) overlay.remove();
        };

        closeBtnEl.addEventListener('click', () => cleanupArSession(true));
        overlay.addEventListener('remove', () => cleanupArSession(false));

        currentPos = currentPos || L.latLng(targetPoi.lat, targetPoi.lng);
        setStatus('Kamera aktif');
        await fetchNearbyPoiCards();
        void refreshAr();
      } catch (err) {
        console.warn('camera denied or unavailable', err);
        poiLayerEl.innerHTML = '<div class="ar-error" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(239, 68, 68, 0.9); color: white; padding: 20px; border-radius: 10px; text-align: center;">Tidak dapat mengakses kamera.</div>';
      }
    })();
  }

  function syncPoiMarkers(anchor: L.LatLngExpression): void {
    if (!state.poiVisible) {
      renderCurrentPoiDataset();
      return;
    }
    if (state.maplibreMap && state.baseMode === "3d") {
      renderCurrentPoiDataset();
      return;
    }

    const center = L.latLng(anchor);
    const radiusMeters = 400; // search radius for nearby POIs

    // Build a small bbox around center (approximate degrees)
    const lat = center.lat;
    const lng = center.lng;
    const latDelta = radiusMeters / 111320; // ~ meters to degrees
    const lngDelta = Math.abs(radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180)));
    const bounds = L.latLngBounds([lat - latDelta, lng - lngDelta], [lat + latDelta, lng + lngDelta]);
    void fetchOverpassFeaturesForBounds(bounds).then((pois) => {
      if (pois.length) {
        mergePoiDataset(pois);
      }
      renderCurrentPoiDataset();
    }).catch(() => { /* ignore */ });
  }

  // ─── Overpass / Vector overlay for clickable raster-like features ─────────────────

  function buildOverpassBBoxString(bounds: L.LatLngBounds): string {
    const s = bounds.getSouth();
    const w = bounds.getWest();
    const n = bounds.getNorth();
    const e = bounds.getEast();
    return `${s},${w},${n},${e}`;
  }

  function poiNameFromTags(tags: Record<string, string>, fallback: string): string {
    return tags["name:id"]
      || tags.name
      || tags.official_name
      || tags.brand
      || tags.operator
      || tags.amenity
      || tags.shop
      || tags.tourism
      || tags.office
      || tags.healthcare
      || tags.craft
      || tags.place
      || tags.building
      || fallback;
  }

  function poiExplicitNameFromTags(tags: Record<string, string>): string {
    return tags["name:id"]
      || tags.name
      || tags.official_name
      || tags.short_name
      || tags.brand
      || tags.operator
      || "";
  }

  function poiAddressFromTags(tags: Record<string, string>): string {
    const parts = [
      tags["addr:street"],
      tags["addr:housenumber"],
      tags["addr:subdistrict"],
      tags["addr:city"],
    ].filter(Boolean);
    return parts.join(" ") || tags.addr || "";
  }

  function poiPriority(poi: PoiRecord): number {
    return poiDisplayRule(poi).priority;
  }

  function poiDisplayRule(poi: PoiRecord): PoiDisplayRule {
    const definition = poiDefinition(poi);
    return {
      minZoom: definition.minZoom,
      labelZoom: definition.labelZoom,
      priority: definition.priority,
    };
  }

  function stablePoiHash(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function poiRenderLimitByZoom(zoom = map.getZoom()): number {
    const flatLimit = zoom < 12
      ? 24
      : zoom < 14
        ? 48
        : zoom < 16
          ? 80
          : zoom < 18
            ? 140
            : zoom < 19
              ? 220
              : 320;
    return state.baseMode === "3d" ? Math.max(24, Math.round(flatLimit * 0.55)) : flatLimit;
  }

  function poiClusterTitle(cluster: PoiClusterRecord): string {
    const dominant = dominantPoiForCluster(cluster.pois);
    const names = cluster.pois
      .filter((poi) => poi.id !== dominant.id)
      .map((poi) => poi.title.trim())
      .filter(Boolean)
      .slice(0, 2);
    const suffix = cluster.pois.length > names.length + 1 ? ` +${cluster.pois.length - names.length - 1}` : "";
    return `${dominant.title} mewakili ${cluster.pois.length} lokasi berdekatan${names.length ? ` · termasuk ${names.join(", ")}${suffix}` : ""}`;
  }

  function dominantPoiForCluster(pois: readonly PoiRecord[]): PoiRecord {
    return [...pois].sort((left, right) => {
      const priority = poiPriority(left) - poiPriority(right);
      if (priority) return priority;
      const named = Number(!left.title.trim()) - Number(!right.title.trim());
      return named || stablePoiHash(left.id) - stablePoiHash(right.id);
    })[0] || pois[0];
  }

  function makePoiClusterIcon(cluster: PoiClusterRecord): L.DivIcon {
    const dominant = dominantPoiForCluster(cluster.pois);
    const definition = poiDefinition(dominant);
    const imageUrl = poiIconAssetUrl(definition, "micro") || ITS_APP_ICON;
    const title = poiClusterTitle(cluster);
    const size = Math.round(clamp(definition.baseSize * 1.15, 20, 26));
    return L.divIcon({
      className: "poi-cluster-icon poi-dominant-cluster-icon",
      html: `<span class="poi-dominant-cluster-symbol" data-poi-cluster="${cluster.pois.length}" data-poi-dominant-id="${escapeHtml(dominant.id)}" role="img" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}" style="--poi-accent:${definition.color};--poi-size:${size}px"><img src="${escapeHtml(imageUrl)}" alt="" draggable="false" width="${size}" height="${size}"></span>`,
      iconSize: [48, 48],
      iconAnchor: [24, 24],
    });
  }

  function poiCollisionGridSize(zoom = map.getZoom()): number {
    if (zoom < 13) return 40;
    if (zoom < 15) return 36;
    if (zoom < 17) return 32;
    if (zoom < 19) return 28;
    return 24;
  }

  function poiGridKeysForRect(left: number, top: number, width: number, height: number, gridSize: number): string[] {
    const minX = Math.floor(left / gridSize);
    const maxX = Math.floor((left + width) / gridSize);
    const minY = Math.floor(top / gridSize);
    const maxY = Math.floor((top + height) / gridSize);
    const keys: string[] = [];
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) keys.push(`${x}:${y}`);
    }
    return keys;
  }

  function poiKeysAreFree(keys: string[], occupied: Set<string>): boolean {
    return !keys.some((key) => occupied.has(key));
  }

  function occupyPoiKeys(keys: string[], occupied: Set<string>): void {
    keys.forEach((key) => occupied.add(key));
  }

  async function fetchOverpassJson(query: string, kind: "poi" | "road"): Promise<any> {
    const active = kind === "poi" ? overpassPoiInFlight : overpassRoadInFlight;
    if (active?.query === query) return active.request;
    const request = (async () => {
      let lastError: unknown = new Error(`Overpass ${kind} tidak tersedia`);
      const body = new URLSearchParams({ data: query }).toString();
      for (const endpoint of OVERPASS_ENDPOINTS) {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
              Accept: "application/json",
            },
            body,
            signal: fetchTimeoutSignal(OVERPASS_TIMEOUT_MS),
          });
          if (!res.ok) {
            rememberOverpassHttpStatus(kind, res.status);
            lastError = new Error(`Overpass ${kind} HTTP ${res.status}`);
            continue;
          }
          const data = await res.json();
          clearOverpassCooldown(kind);
          return data;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    })();
    const entry = { query, request };
    if (kind === "poi") overpassPoiInFlight = entry;
    else overpassRoadInFlight = entry;
    try {
      return await request;
    } finally {
      if (kind === "poi" && overpassPoiInFlight === entry) overpassPoiInFlight = null;
      if (kind === "road" && overpassRoadInFlight === entry) overpassRoadInFlight = null;
    }
  }

  function clearOverpassCooldown(kind: "poi" | "road"): void {
    if (kind === "poi") overpassPoiCooldownUntil = 0;
    else overpassRoadCooldownUntil = 0;
  }

  function rankPoisForView(pois: PoiRecord[]): PoiRecord[] {
    if (!state.poiVisible) return [];
    const zoom = map.getZoom();
    const bounds = map.getBounds().pad(0.08);
    const gridSize = poiCollisionGridSize(zoom);
    const occupied = new Set<string>();
    const viewport = map.getSize();
    const labelBudget = clamp(
      Math.round((viewport.x * viewport.y) / 32_000),
      window.matchMedia("(max-width: 720px)").matches ? 10 : 18,
      state.baseMode === "3d" ? 24 : zoom >= 18 ? 60 : 40,
    );
    let renderedLabelCount = 0;
    state.poiLabelVisibility.clear();
    const ranked = pois
      .filter((poi) => isValidCoordinate(poi.lat, poi.lng))
      .filter((poi) => bounds.contains([poi.lat, poi.lng]))
      .filter((poi) => zoom >= poiDisplayRule(poi).minZoom)
      .sort((a, b) => {
        const priority = poiPriority(a) - poiPriority(b);
        if (priority !== 0) return priority;
        const namedA = a.title.trim() ? 0 : 1;
        const namedB = b.title.trim() ? 0 : 1;
        if (namedA !== namedB) return namedA - namedB;
        return stablePoiHash(a.id) - stablePoiHash(b.id);
      });
    // A marker may render a small pictogram, but its interactive hit box is
    // 48 CSS px. Keep neighbouring marker centres farther apart so Lighthouse
    // and touch users do not see overlapping targets.
    const clusterCellSize = zoom >= 19 ? 52 : zoom >= 17 ? 56 : zoom >= 15 ? 60 : 64;
    const clusterBuckets = new Map<string, PoiRecord[]>();
    ranked.forEach((poi) => {
      const worldPoint = map.project([poi.lat, poi.lng], Math.floor(zoom));
      const key = `${Math.floor(worldPoint.x / clusterCellSize)}:${Math.floor(worldPoint.y / clusterCellSize)}`;
      const bucket = clusterBuckets.get(key) || [];
      bucket.push(poi);
      clusterBuckets.set(key, bucket);
    });
    const clusteredIds = new Set<string>();
    state.poiClusters = [...clusterBuckets.values()]
      .filter((bucket) => bucket.length > 1)
      .map((bucket) => {
        const sorted = [...bucket].sort((a, b) => a.id.localeCompare(b.id));
        const dominant = dominantPoiForCluster(sorted);
        sorted.forEach((poi) => clusteredIds.add(poi.id));
        return {
          id: `poi-cluster-${Math.floor(zoom)}-${stablePoiHash(sorted.map((poi) => poi.id).join("|"))}`,
          // Use the real coordinate of the representative POI rather than a
          // synthetic centroid, so the visible symbol always has a source.
          lat: dominant.lat,
          lng: dominant.lng,
          pois: sorted,
        };
      });
    const selected: PoiRecord[] = [];
    for (const poi of ranked) {
      if (clusteredIds.has(poi.id)) continue;
      if (selected.length >= poiRenderLimitByZoom(zoom)) break;
      const point = map.latLngToContainerPoint([poi.lat, poi.lng]);
      const rule = poiDisplayRule(poi);
      const wantsLabel = renderedLabelCount < labelBudget
        && zoom >= rule.labelZoom
        && poi.title.trim().length > 0;
      const labelWidth = wantsLabel ? clamp(Math.min(22, Math.max(8, Math.ceil(poi.title.length / 2))) * 5.5, 44, 142) : 0;
      const touchSize = 52;
      const fullWidth = touchSize + (wantsLabel ? labelWidth + 9 : 0);
      const fullHeight = Math.max(touchSize, wantsLabel && poi.title.length > 20 ? 32 : 24);
      const fullKeys = poiGridKeysForRect(
        point.x - touchSize / 2,
        point.y - fullHeight / 2,
        fullWidth,
        fullHeight,
        gridSize,
      );
      if (poiKeysAreFree(fullKeys, occupied)) {
        occupyPoiKeys(fullKeys, occupied);
        state.poiLabelVisibility.set(poi.id, wantsLabel);
        if (wantsLabel) renderedLabelCount += 1;
        selected.push(poi);
        continue;
      }

      // Retain an interactive icon when its label would collide with another POI.
      const iconKeys = poiGridKeysForRect(
        point.x - touchSize / 2,
        point.y - touchSize / 2,
        touchSize,
        touchSize,
        gridSize,
      );
      if (poiKeysAreFree(iconKeys, occupied)) {
        occupyPoiKeys(iconKeys, occupied);
        state.poiLabelVisibility.set(poi.id, false);
        selected.push(poi);
      }
    }
    return selected;
  }

  async function fetchOverpassFeaturesForBounds(
    bounds: L.LatLngBounds,
    zoomValue = map.getZoom(),
  ): Promise<PoiRecord[]> {
    const zoom = Math.max(13, Math.min(18, Math.floor(zoomValue)));
    const cacheKey = poiCacheKeyForBounds(bounds, zoom);
    const freshCache = await mapDetailCache.get<PoiRecord[]>(cacheKey, 7 * 24 * 60 * 60 * 1000);
    const storedCache = freshCache || await mapDetailCache.peek<PoiRecord[]>(cacheKey);
    const validCached = storedCache?.length ? storedCache.map(normalizePoiRecord) : null;
    if (freshCache && validCached) return validCached;
    if (!OVERPASS_NETWORK_ENABLED || shouldSkipOverpass("poi")) {
      // Keep the full cached dataset. The renderer applies semantic zoom and
      // collision rules, so a closer zoom can reveal more POIs without a new
      // network request.
      return validCached || [];
    }
    const bbox = buildOverpassBBoxString(bounds);
    // Query common POI tags; return nodes + ways + relations with center
    const q = `
  [out:json][timeout:15];
  (
    node["amenity"](${bbox});
    way["amenity"](${bbox});
    relation["amenity"](${bbox});
    node["shop"](${bbox});
    way["shop"](${bbox});
    relation["shop"](${bbox});
    node["tourism"](${bbox});
    way["tourism"](${bbox});
    relation["tourism"](${bbox});
    node["office"](${bbox});
    way["office"](${bbox});
    relation["office"](${bbox});
    node["leisure"="park"](${bbox});
    way["leisure"="park"](${bbox});
    relation["leisure"="park"](${bbox});
    node["public_transport"](${bbox});
    way["public_transport"](${bbox});
    relation["public_transport"](${bbox});
    node["public_transport"~"station|platform|stop_position"](${bbox});
    way["public_transport"~"station|platform|stop_position"](${bbox});
    node["highway"="bus_stop"](${bbox});
    node["amenity"="bus_station"](${bbox});
    way["amenity"="bus_station"](${bbox});
    node["railway"~"station|halt|tram_stop|subway_entrance"](${bbox});
    way["railway"~"station|halt|tram_stop|subway_entrance"](${bbox});
    relation["railway"~"station|halt|tram_stop|subway_entrance"](${bbox});
    node["historic"](${bbox});
    way["historic"](${bbox});
    relation["historic"](${bbox});
    node["healthcare"](${bbox});
    way["healthcare"](${bbox});
    relation["healthcare"](${bbox});
    node["craft"](${bbox});
    way["craft"](${bbox});
    node["emergency"](${bbox});
    way["emergency"](${bbox});
    node["place"~"neighbourhood|suburb|quarter|village|hamlet"](${bbox});
    way["place"~"neighbourhood|suburb|quarter|village|hamlet"](${bbox});
    node["man_made"]["name"](${bbox});
    way["man_made"]["name"](${bbox});
    node["sport"]["name"](${bbox});
    way["sport"]["name"](${bbox});
    relation["sport"]["name"](${bbox});
    node["leisure"](${bbox});
    way["leisure"](${bbox});
    relation["leisure"](${bbox});
    node["aeroway"]["name"](${bbox});
    way["aeroway"]["name"](${bbox});
    node["barrier"~"gate|lift_gate"](${bbox});
    node["entrance"~"yes|main|service"](${bbox});
    node["highway"~"traffic_signals|crossing"](${bbox});
    node["natural"]["name"](${bbox});
    way["natural"]["name"](${bbox});
    relation["natural"]["name"](${bbox});
    way["landuse"]["name"](${bbox});
    relation["landuse"]["name"](${bbox});
    node["building"]["name"](${bbox});
    way["building"]["name"](${bbox});
  );
  out center tags 2500;
`;

    try {
      const data = await fetchOverpassJson(q, "poi");
      const elements = Array.isArray(data.elements) ? data.elements : [];
      const pois: PoiRecord[] = elements.map((el: any) => {
        const tags = Object.fromEntries(Object.entries(el.tags || {}).map(([key, value]) => [key, String(value)])) as Record<string, string>;
        const name = poiExplicitNameFromTags(tags);
        const lat = el.type === 'node' ? el.lat : (el.center && el.center.lat) || el.lat || 0;
        const lng = el.type === 'node' ? el.lon : (el.center && el.center.lon) || el.lon || 0;
        const definition = resolvePoiIcon(tags);
        const imageUrl = tags.image || poiIconAssetUrl(definition, "hero") || ITS_APP_ICON;
        const description = tags.description || tags.note || "";
        const address = poiAddressFromTags(tags);
        return {
          id: `overpass-${el.type}-${el.id}`,
          kind: definition.category,
          iconId: definition.id,
          title: name,
          description: description || '',
          address: address || '',
          imageUrl: imageUrl || ITS_APP_ICON,
          icon: definition.glyph,
          tags,
          sourceLabel: "OpenStreetMap",
          sourceUrl: `https://www.openstreetmap.org/${encodeURIComponent(String(el.type))}/${encodeURIComponent(String(el.id))}`,
          lat, lng,
        };
      }).filter((p: PoiRecord) => Boolean(p.title) && isValidCoordinate(p.lat, p.lng));
      // Cache the raw provider records. The viewport renderer decides which
      // records and labels are visible at the current zoom, so cached POIs can
      // become available as a visitor zooms in without another network call.
      if (pois.length) void mapDetailCache.set(cacheKey, pois);
      return pois;
    } catch (err) {
      console.debug("Overpass fetch failed; no POI is fabricated:", err);
      return validCached || [];
    }
  }

  let lastRoadGuideFetchBounds: L.LatLngBounds | null = null;

  function numberTag(tags: Record<string, string>, key: string): number {
    const raw = tags[key];
    if (!raw) return 0;
    const parsed = Number(String(raw).split(";")[0].trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }

  const ROAD_DETAIL_STRING_TAGS: ReadonlyArray<readonly [string, string]> = [
    ["service", "service"],
    ["toll", "toll"],
    ["bridge", "bridge"],
    ["bridge:name", "bridgeName"],
    ["bridge:structure", "bridgeStructure"],
    ["tunnel", "tunnel"],
    ["covered", "covered"],
    ["footway", "footway"],
    ["indoor", "indoor"],
    ["bicycle", "bicycle"],
    ["segregated", "segregated"],
    ["ramp", "ramp"],
    ["incline", "incline"],
    ["lit", "lit"],
    ["smoothness", "smoothness"],
    ["condition", "condition"],
    ["road_condition", "roadCondition"],
    ["road:condition", "roadCondition"],
    ["road_function", "roadFunction"],
    ["road:function", "roadFunction"],
    ["road_system", "roadSystem"],
    ["road:system", "roadSystem"],
    ["road_status", "roadStatus"],
    ["road:status", "roadStatus"],
    ["road_class", "roadClass"],
    ["road:class", "roadClass"],
    ["center_marking", "centerMarking"],
    ["centre_marking", "centerMarking"],
    ["dual_carriageway", "divided"],
    ["divider", "divider"],
    ["median:type", "medianType"],
    ["busway", "busway"],
    ["busway:left", "busway:left"],
    ["busway:right", "busway:right"],
    ["busway:both", "busway:both"],
    ["lanes:psv", "lanes:psv"],
    ["lanes:bus", "lanes:bus"],
    ["bus:lanes", "bus:lanes"],
    ["cycleway", "cycleway"],
    ["cycleway:left", "cyclewayLeft"],
    ["cycleway:right", "cyclewayRight"],
    ["cycleway:both", "cyclewayBoth"],
    ["cycleway:left:lane", "cyclewayLeftLane"],
    ["cycleway:right:lane", "cyclewayRightLane"],
    ["cycleway:both:lane", "cyclewayBothLane"],
    ["cycleway:buffer", "cyclewayBuffer"],
    ["access", "access"],
    ["special_lane", "specialLane"],
    ["lane:type", "laneType"],
    ["motorcycle:lanes", "motorcycleLane"],
    ["taxi:lanes", "taxiLane"],
    ["evacuation:lane", "evacuationLane"],
    ["reversible", "reversible"],
    ["shoulder", "shoulder"],
    ["sidewalk:left", "sidewalkLeft"],
    ["sidewalk:right", "sidewalkRight"],
    ["sidewalk:surface", "sidewalkSurface"],
    ["kerb", "kerb"],
    ["tactile_paving", "tactilePaving"],
    ["parking:lane:left", "parkingLeft"],
    ["parking:lane:right", "parkingRight"],
    ["turn:lanes", "turnLanes"],
    ["maxspeed", "maxspeed"],
    ["embankment", "embankment"],
    ["cutting", "cutting"],
    ["ford", "ford"],
    ["temporary", "temporary"],
    ["tracktype", "tracktype"],
  ];

  const ROAD_DETAIL_NUMBER_TAGS: ReadonlyArray<readonly [string, string]> = [
    ["lanes:forward", "lanesForward"],
    ["lanes:backward", "lanesBackward"],
    ["width", "width"],
    ["layer", "layer"],
  ];

  const RAIL_DETAIL_STRING_TAGS: ReadonlyArray<readonly [string, string]> = [
    ["ref", "ref"],
    ["operator", "operator"],
    ["network", "network"],
    ["route", "route"],
    ["from", "from"],
    ["to", "to"],
    ["service", "service"],
    ["usage", "usage"],
    ["gauge", "gauge"],
    ["electrified", "electrified"],
    ["voltage", "voltage"],
    ["frequency", "frequency"],
    ["highspeed", "highspeed"],
    ["bridge", "bridge"],
    ["tunnel", "tunnel"],
    ["covered", "covered"],
  ];

  const RAIL_DETAIL_NUMBER_TAGS: ReadonlyArray<readonly [string, string]> = [
    ["maxspeed", "maxspeed"],
    ["layer", "layer"],
  ];

  const WATER_DETAIL_STRING_TAGS: ReadonlyArray<readonly [string, string]> = [
    ["official_name", "officialName"],
    ["alt_name", "alternateName"],
    ["local_name", "localName"],
    ["ref", "ref"],
    ["operator", "operator"],
    ["lined", "lined"],
    ["intermittent", "intermittent"],
    ["seasonal", "seasonal"],
    ["tunnel", "tunnel"],
    ["location", "location"],
    ["corridorId", "corridorId"],
    ["corridor_id", "corridorId"],
    ["corridor:id", "corridorId"],
  ];

  const WATER_DETAIL_NUMBER_TAGS: ReadonlyArray<readonly [string, string]> = [
    ["width", "width"],
    ["layer", "layer"],
  ];

  function allowlistedDetailProperties(
    tags: Record<string, string>,
    stringTags: ReadonlyArray<readonly [string, string]>,
    numberTags: ReadonlyArray<readonly [string, string]>,
  ): MapDetailProperties {
    const properties: MapDetailProperties = {};
    stringTags.forEach(([source, target]) => {
      const value = String(tags[source] || "").trim();
      if (value && !(target in properties)) properties[target] = value;
    });
    numberTags.forEach(([source, target]) => {
      if (!(source in tags)) return;
      const value = Number(String(tags[source]).split(";")[0].trim());
      if (Number.isFinite(value)) properties[target] = value;
    });
    return properties;
  }

  function roadDetailProperties(tags: Record<string, string>): MapDetailProperties {
    return allowlistedDetailProperties(tags, ROAD_DETAIL_STRING_TAGS, ROAD_DETAIL_NUMBER_TAGS);
  }

  function railDetailProperties(tags: Record<string, string>): MapDetailProperties {
    return allowlistedDetailProperties(tags, RAIL_DETAIL_STRING_TAGS, RAIL_DETAIL_NUMBER_TAGS);
  }

  function waterDetailProperties(tags: Record<string, string>): MapDetailProperties {
    return allowlistedDetailProperties(tags, WATER_DETAIL_STRING_TAGS, WATER_DETAIL_NUMBER_TAGS);
  }

  function firstMappedTag(tags: Record<string, string>, keys: string[]): string {
    for (const key of keys) {
      const value = String(tags[key] || "").trim();
      if (value) return value;
    }
    return "";
  }

  function mappedFeatureName(tags: Record<string, string>): string {
    return firstMappedTag(tags, ["name:id", "name", "official_name", "short_name", "local_name", "alt_name"]);
  }

  function mappedWaterName(tags: Record<string, string>): string {
    // Keep the provider's real hydrological name. A waterway ref or its type
    // is metadata, not a substitute for a river/canal name on the map.
    return firstMappedTag(tags, ["name:id", "name", "official_name", "local_name", "alt_name"]);
  }

  function meaningfulMappedValue(value: unknown): boolean {
    return Boolean(String(value || "").trim() && !/^(?:0|false|no|none)$/i.test(String(value).trim()));
  }

  function elementGeometryPoints(el: any): L.LatLng[] {
    const geometry = Array.isArray(el.geometry) ? el.geometry : [];
    return geometry
      .map((p: any) => L.latLng(Number(p.lat), Number(p.lon)))
      .filter((p: L.LatLng) => isValidCoordinate(p.lat, p.lng));
  }

  function isClosedGuideRing(points: L.LatLng[]): boolean {
    if (points.length < 4) return false;
    const first = points[0];
    const last = points[points.length - 1];
    return Math.abs(first.lat - last.lat) < 0.00002 && Math.abs(first.lng - last.lng) < 0.00002;
  }

  function guideCentroid(points: L.LatLng[]): L.LatLng | null {
    if (!points.length) return null;
    const sum = points.reduce((acc, point) => {
      acc.lat += point.lat;
      acc.lng += point.lng;
      return acc;
    }, { lat: 0, lng: 0 });
    return L.latLng(sum.lat / points.length, sum.lng / points.length);
  }

  function appPlaceUrl(lat: number, lng: number, title?: string): string {
    const origin = window.location.protocol.startsWith("http")
      ? window.location.origin
      : "https://itstelkom.web.app";
    const url = new URL(origin);
    url.pathname = "/";
    url.searchParams.set("lat", lat.toFixed(6));
    url.searchParams.set("lng", lng.toFixed(6));
    url.searchParams.set("z", String(Math.max(16, Math.round(map.getZoom() || DEFAULT_ZOOM))));
    if (title) url.searchParams.set("place", title);
    return url.toString();
  }

  function detectRoadType(tags: Record<string, string>, _name: string): RoadGuideRecord["roadType"] {
    const highway = tags.highway || "";
    if (/motorway|trunk/.test(highway)) return "expressway";
    if (/footway|path|pedestrian|corridor|cycleway|steps/.test(highway)) return "foot";
    if (/service|track/.test(highway)) return "service";
    const lanes = numberTag(tags, "lanes") || numberTag(tags, "lanes:forward") + numberTag(tags, "lanes:backward");
    if (/primary|secondary|tertiary/.test(highway) || lanes >= 4) return "avenue";
    return "street";
  }

  function roadRenderClass(road: RoadGuideRecord): "major" | "street" | "foot" | "service" {
    if (road.roadType === "expressway" || road.roadType === "avenue") return "major";
    if (road.roadType === "foot") return "foot";
    if (road.roadType === "service") return "service";
    return "street";
  }

  function roadZoomScale(min = 0.78, max = 1.24): number {
    return clamp(0.84 + (map.getZoom() - 15) * 0.12, min, max);
  }

  function roadPaletteKey(road: RoadGuideRecord): string {
    const highway = String(road.highway || road.roadType || "road").toLowerCase();
    const service = String(road.detail.service || "").toLowerCase();
    const surface = String(road.surface || "").toLowerCase();
    const bridge = meaningfulMappedValue(road.detail.bridge);
    const tunnel = meaningfulMappedValue(road.detail.tunnel) || meaningfulMappedValue(road.detail.covered);
    const base = highway === "service" && service ? `service-${service}` : highway;
    return [base, surface && `surface-${surface}`, bridge ? "bridge" : tunnel ? "tunnel" : ""]
      .filter(Boolean)
      .join("|");
  }

  function roadPaletteClassName(road: RoadGuideRecord): string {
    return roadPaletteKey(road).replace(/[^a-z0-9_-]+/g, "-");
  }

  function roadSurfaceFamily(road: RoadGuideRecord): "paved" | "unpaved" | "rough" | "unknown" {
    const surface = String(road.surface || "").toLowerCase();
    if (/^(?:asphalt|concrete|concrete:lanes|concrete:plates|paved|metal|wood)$/.test(surface)) return "paved";
    if (/^(?:cobblestone|sett|unhewn_cobblestone|paving_stones|bricks)$/.test(surface)) return "rough";
    if (/^(?:unpaved|compacted|fine_gravel|gravel|pebblestone|ground|dirt|earth|mud|sand|grass|grass_paver)$/.test(surface)) return "unpaved";
    return "unknown";
  }

  function roadGuideStyle(road: RoadGuideRecord, casing = false): L.PolylineOptions {
    const highway = String(road.highway || "road").toLowerCase();
    const surfaceFamily = roadSurfaceFamily(road);
    const bridge = meaningfulMappedValue(road.detail.bridge);
    const tunnel = meaningfulMappedValue(road.detail.tunnel) || meaningfulMappedValue(road.detail.covered);
    const construction = highway === "construction";
    const proposed = highway === "proposed";
    const pedestrian = /^(?:footway|path|pedestrian|corridor|cycleway|steps)$/.test(highway);
    const widths: Record<string, number> = {
      motorway: 8.6, motorway_link: 5.6, trunk: 8, trunk_link: 5.4,
      primary: 7.4, primary_link: 5.2, secondary: 6.6, secondary_link: 4.8,
      tertiary: 5.8, tertiary_link: 4.5, residential: 4.3, unclassified: 4.1,
      living_street: 4, service: 3.4, track: 2.8, road: 3.8,
      construction: 3.7, proposed: 3.2, bus_guideway: 4.6,
      pedestrian: 2.8, footway: 2.2, path: 2.1, corridor: 2.1, cycleway: 2.5, steps: 2.2,
    };
    const colors: Record<string, string> = {
      motorway: "#f08f62", motorway_link: "#f4aa7c", trunk: "#f3a66e", trunk_link: "#f5bc8d",
      primary: "#efc95f", primary_link: "#f3d581", secondary: "#f2dda0", secondary_link: "#f5e7bc",
      tertiary: "#f5ebc9", tertiary_link: "#f7f0da", residential: "#ffffff", unclassified: "#fbfdff",
      living_street: "#e7f3ea", service: "#e3e9ef", track: "#cdbb91", road: "#f8fafc",
      construction: "#e5a94c", proposed: "#aeb8c4", bus_guideway: "#dbeafe",
      pedestrian: "#b8ded5", footway: "#b8ded5", path: "#c4d8cf", corridor: "#d5e3ed", cycleway: "#83d3b2", steps: "#c3ceda",
    };
    const scale = roadZoomScale();
    const width = (widths[highway] || (road.roadType === "avenue" ? 6.6 : road.roadType === "service" ? 3.4 : 4.2)) * scale;
    const className = `road-guide-path road-palette-${roadPaletteClassName(road)}${casing ? " road-guide-casing" : " road-guide-fill"}`;
    if (casing) {
      return {
        color: bridge ? "#7b8794" : tunnel ? "#b7c0ca" : pedestrian ? "#f7fafc" : "#ffffff",
        weight: width + (bridge ? 4.2 : pedestrian ? 1.8 : 3.2) * scale,
        opacity: tunnel ? 0.46 : pedestrian ? 0.58 : 0.72,
        dashArray: tunnel ? "7 6" : proposed ? "4 7" : construction ? "8 5" : undefined,
        className,
        interactive: false,
      };
    }
    const mappedColor = colors[highway] || colors.road;
    const color = surfaceFamily === "unpaved" ? "#c9aa75" : surfaceFamily === "rough" ? "#d2c1a6" : mappedColor;
    return {
      color,
      weight: width,
      opacity: tunnel ? 0.48 : pedestrian ? 0.68 : 0.76,
      dashArray: proposed ? "4 7" : construction ? "9 6" : tunnel ? "7 6" : surfaceFamily === "unpaved" ? "5 3" : pedestrian ? "7 7" : undefined,
      lineCap: pedestrian || construction || proposed ? "round" : "butt",
      className,
      interactive: false,
    };
  }

  function mapLibrePitchByZoom(zoom: number): number {
    if (state.baseMode !== "3d") return 0;
    const startZoom = 13.6;
    const fullZoom = 17.2;
    if (zoom <= startZoom) return 0;
    if (zoom >= fullZoom) return MAPLIBRE_3D_PITCH;
    const normalized = (zoom - startZoom) / (fullZoom - startZoom);
    const smooth = normalized * normalized * (3 - 2 * normalized);
    return MAPLIBRE_3D_PITCH * smooth;
  }

  function elementMemberGeometryPaths(el: any, outerOnly = false): L.LatLng[][] {
    const members = Array.isArray(el?.members) ? el.members : [];
    return members
      .filter((member: any) => !outerOnly || String(member?.role || "").toLowerCase() !== "inner")
      .map((member: any) => elementGeometryPoints(member))
      .filter((points: L.LatLng[]) => points.length >= 2);
  }

  function transitEndpointMemberCandidates(
    relation: any,
    elementIndex: ReadonlyMap<string, any>,
  ): TransitEndpointMemberCandidate[] {
    const members = Array.isArray(relation?.members) ? relation.members : [];
    return members.flatMap((member: any, memberIndex: number) => {
      const memberType = String(member?.type || "");
      const memberRef = String(member?.ref ?? "");
      if (!memberType || !memberRef) return [];
      const source = elementIndex.get(`${memberType}/${memberRef}`);
      const tags = source?.tags && typeof source.tags === "object"
        ? source.tags as Record<string, string>
        : member?.tags && typeof member.tags === "object"
          ? member.tags as Record<string, string>
          : {};
      const lat = Number(source?.lat ?? member?.lat ?? source?.center?.lat ?? member?.center?.lat);
      const lng = Number(source?.lon ?? member?.lon ?? source?.center?.lon ?? member?.center?.lon);
      const mappedPoint = isValidCoordinate(lat, lng)
        ? L.latLng(lat, lng)
        : guideCentroid(elementGeometryPoints(source || member));
      if (!mappedPoint) return [];
      return [{
        memberIndex,
        memberType,
        memberRef,
        memberRole: String(member?.role || ""),
        tags,
        point: { lat: mappedPoint.lat, lng: mappedPoint.lng },
      }];
    });
  }

  function ornamentKindFromTags(tags: Record<string, string>): { kind: MapOrnamentKind; tagKey: string; tagValue: string } | null {
    const highway = String(tags.highway || "").toLowerCase();
    const amenity = String(tags.amenity || "").toLowerCase();
    const barrier = String(tags.barrier || "").toLowerCase();
    const manMade = String(tags.man_made || "").toLowerCase();
    const parkRide = String(tags.park_ride || tags["parking:park_ride"] || "").toLowerCase();
    if (amenity === "parking" && meaningfulMappedValue(parkRide)) return { kind: "park_and_ride", tagKey: tags.park_ride ? "park_ride" : "parking:park_ride", tagValue: parkRide };
    if (highway === "street_lamp") return { kind: "street_lamp", tagKey: "highway", tagValue: highway };
    if (highway === "speed_camera") return { kind: "speed_camera", tagKey: "highway", tagValue: highway };
    if (highway === "toll_gantry") return { kind: "toll_gate", tagKey: "highway", tagValue: highway };
    if (highway === "elevator" || amenity === "elevator") return { kind: "elevator", tagKey: highway === "elevator" ? "highway" : "amenity", tagValue: highway || amenity };
    if (manMade === "surveillance" || meaningfulMappedValue(tags.surveillance)) return { kind: "surveillance", tagKey: manMade === "surveillance" ? "man_made" : "surveillance", tagValue: manMade === "surveillance" ? manMade : String(tags.surveillance) };
    if (meaningfulMappedValue(tags.traffic_calming)) return { kind: "traffic_calming", tagKey: "traffic_calming", tagValue: String(tags.traffic_calming) };
    if (barrier === "guard_rail") return { kind: "guardrail", tagKey: "barrier", tagValue: barrier };
    if (barrier === "bollard") return { kind: "bollard", tagKey: "barrier", tagValue: barrier };
    if (barrier === "toll_booth") return { kind: "toll_gate", tagKey: "barrier", tagValue: barrier };
    if (/^(?:gate|lift_gate|swing_gate|sliding_gate|hampshire_gate)$/.test(barrier)) return { kind: "gate", tagKey: "barrier", tagValue: barrier };
    if (/^(?:block|chain|cycle_barrier|jersey_barrier|cattle_grid|stile|kerb)$/.test(barrier)) return { kind: "barrier", tagKey: "barrier", tagValue: barrier };
    if (tags.emergency === "fire_hydrant") return { kind: "hydrant", tagKey: "emergency", tagValue: tags.emergency };
    const amenities: Partial<Record<string, MapOrnamentKind>> = {
      bench: "bench",
      waste_basket: "waste_basket",
      drinking_water: "drinking_water",
      toilets: "toilets",
      taxi: "taxi",
      bicycle_parking: "bicycle_parking",
      charging_station: "charging_station",
    };
    if (amenities[amenity]) return { kind: amenities[amenity] as MapOrnamentKind, tagKey: "amenity", tagValue: amenity };
    if (meaningfulMappedValue(tags.entrance)) return { kind: "entrance", tagKey: "entrance", tagValue: String(tags.entrance) };
    if (meaningfulMappedValue(tags.escalator) || (highway === "steps" && meaningfulMappedValue(tags.conveying))) {
      return { kind: "escalator", tagKey: meaningfulMappedValue(tags.escalator) ? "escalator" : "conveying", tagValue: String(tags.escalator || tags.conveying) };
    }
    if (meaningfulMappedValue(tags.manhole)) return { kind: String(tags.manhole).toLowerCase() === "drain" ? "drain_grate" : "manhole", tagKey: "manhole", tagValue: String(tags.manhole) };
    if (meaningfulMappedValue(tags.drain)) return { kind: "drain_grate", tagKey: "drain", tagValue: String(tags.drain) };
    if (manMade === "manhole") return { kind: "manhole", tagKey: "man_made", tagValue: manMade };
    if (manMade === "retaining_wall" || barrier === "retaining_wall") return { kind: "retaining_wall", tagKey: manMade === "retaining_wall" ? "man_made" : "barrier", tagValue: "retaining_wall" };
    if (manMade === "seawall") return { kind: "seawall", tagKey: "man_made", tagValue: manMade };
    return null;
  }

  function ornamentDetailProperties(tags: Record<string, string>): MapDetailProperties {
    const detail: MapDetailProperties = {};
    [
      "highway", "amenity", "barrier", "man_made", "surveillance", "surveillance:type",
      "camera:type", "traffic_calming", "emergency", "fire_hydrant:type", "entrance", "access",
      "conveying", "escalator", "manhole", "drain", "park_ride", "parking:park_ride",
      "bicycle_parking", "capacity", "operator", "ref", "level",
    ].forEach((key) => {
      const value = String(tags[key] || "").trim();
      if (value) detail[key] = value;
    });
    return detail;
  }

  function mapOrnamentFromElement(el: any, tags: Record<string, string>): MapOrnamentRecord | null {
    const mapped = ornamentKindFromTags(tags);
    if (!mapped) return null;
    const sourcePoints = elementGeometryPoints(el);
    const linearKinds = new Set<MapOrnamentKind>(["barrier", "guardrail", "retaining_wall", "seawall"]);
    if (linearKinds.has(mapped.kind) && sourcePoints.length >= 2) {
      return {
        id: `ornament-${mapped.kind}-${el.type}-${el.id}`,
        name: mappedFeatureName(tags),
        ...mapped,
        detail: ornamentDetailProperties(tags),
        geometry: "line",
        points: sourcePoints,
      };
    }
    const lat = Number(el.lat ?? el.center?.lat);
    const lng = Number(el.lon ?? el.center?.lon);
    const point = isValidCoordinate(lat, lng) ? L.latLng(lat, lng) : guideCentroid(sourcePoints);
    if (!point) return null;
    return {
      id: `ornament-${mapped.kind}-${el.type}-${el.id}`,
      name: mappedFeatureName(tags),
      ...mapped,
      detail: ornamentDetailProperties(tags),
      geometry: "point",
      points: [point],
    };
  }

  function hasMappedBusLane(tags: Record<string, string>): boolean {
    const falseTokens = new Set(["", "0", "false", "no", "none"]);
    const values = [
      tags.busway,
      tags["busway:left"],
      tags["busway:right"],
      tags["busway:both"],
      tags["bus:lanes"],
      tags["lanes:bus"],
      tags["lanes:psv"],
    ];
    const hasActiveValue = values.some((value) => String(value || "")
      .toLowerCase()
      .split(/[;|]/)
      .some((token) => !falseTokens.has(token.trim())));
    return /^(?:busway|bus_guideway)$/.test(tags.highway || "") || hasActiveValue;
  }

  function hasMappedCycleway(tags: Record<string, string>): boolean {
    if (tags.highway === "cycleway") return true;
    const inactive = new Set(["", "0", "false", "no", "none", "separate"]);
    return [
      tags.cycleway,
      tags["cycleway:left"],
      tags["cycleway:right"],
      tags["cycleway:both"],
      tags["cycleway:left:lane"],
      tags["cycleway:right:lane"],
      tags["cycleway:both:lane"],
    ].some((value) => String(value || "")
      .toLowerCase()
      .split(/[;|]/)
      .some((token) => !inactive.has(token.trim())));
  }

  function pedestrianStructureFromTags(tags: Record<string, string>): RoadGuideRecord["pedestrianStructure"] {
    if (!/^(?:footway|path|pedestrian|corridor|steps)$/.test(tags.highway || "")) return "";
    const identity = [
      mappedFeatureName(tags),
      tags.bridge,
      tags["bridge:name"],
      tags["bridge:structure"],
      tags.man_made,
    ].join(" ").toLowerCase();
    const elevated = meaningfulMappedValue(tags.bridge) || numberTag(tags, "layer") > 0;
    if (/\bjpo\b|jembatan penyeberangan|pedestrian[_ -]?(?:overpass|bridge)/i.test(identity)) return "jpo";
    if (elevated) return "footbridge";
    if (meaningfulMappedValue(tags.covered) || tags.indoor === "yes") return "covered_walkway";
    return "";
  }

  function transitModeFromTags(tags: Record<string, string>): TransitGuideMode {
    const route = (tags.route || "").toLowerCase();
    const railway = (tags.railway || "").toLowerCase();
    const identity = [
      mappedFeatureName(tags), tags.ref, tags.operator, tags.network, tags.brand,
      tags.service, tags.usage, tags.highspeed,
    ].join(" ").toLowerCase();
    if (meaningfulMappedValue(tags.highspeed) || /kereta cepat|high[ -]?speed|\bwhoosh\b|\bkcic\b/.test(identity)) return "high_speed";
    if (route === "subway" || railway === "subway" || /\bmrt\b|mass rapid transit/.test(identity)) return "mrt";
    if (route === "light_rail" || railway === "light_rail" || /\blrt\b|light rail transit/.test(identity)) return "lrt";
    if (railway === "monorail" || /monorail|monorel/.test(identity)) return "monorail";
    if (route === "tram" || railway === "tram") return "tram";
    if (/\bkrl\b|commuter(?:line)?|kai commuter|kereta komuter/.test(identity)) return "commuter";
    if (route === "train" || /rail|narrow_gauge|funicular/.test(railway)) return "train";
    const rapidBus = /\bbrt\b|bus rapid transit|transjakarta|trans semarang|trans jogja|trans metro bandung/.test(identity);
    return hasMappedBusLane(tags) || (route === "bus" && rapidBus) ? "busway" : "bus";
  }

  function transitModeLabel(mode: TransitGuideMode): string {
    if (mode === "mrt") return "MRT";
    if (mode === "lrt") return "LRT";
    if (mode === "busway") return "BRT";
    if (mode === "tram") return "Tram";
    if (mode === "monorail") return "Monorel";
    if (mode === "commuter") return "KRL";
    if (mode === "high_speed") return "KA Cepat";
    if (mode === "train") return "KA";
    return "Bus";
  }

  function transitOperationalDescriptor(tags: Record<string, string>): string {
    const service = String(tags.service || "").toLowerCase();
    const usage = String(tags.usage || "").toLowerCase();
    const serviceLabels: Record<string, string> = {
      branch: "cabang",
      crossover: "sepur silang",
      siding: "sepur simpang",
      spur: "sepur cabang",
      yard: "emplasemen",
    };
    const usageLabels: Record<string, string> = {
      main: "jalur utama",
      branch: "jalur cabang",
      industrial: "jalur industri",
      military: "jalur militer",
      tourism: "jalur wisata",
    };
    return serviceLabels[service] || usageLabels[usage] || service || usage;
  }

  function semanticTransitLabel(
    tags: Record<string, string>,
    mode: TransitGuideMode,
    source: TransitGuideRecord["source"],
  ): string {
    const modeLabel = transitModeLabel(mode);
    const actualName = source === "road_lane" ? "" : mappedFeatureName(tags);
    const genericName = /^(?:jalur\s+)?(?:kereta(?:\s+api)?|rail(?:way|road)?|train|bus(?:way)?|tram|mrt|lrt|krl|ka)$/i.test(actualName);
    const routeRef = source === "road_lane"
      ? firstMappedTag(tags, ["route_ref", "bus:route_ref", "public_transport:ref"])
      : firstMappedTag(tags, ["ref", "route_ref"]);
    const from = String(tags.from || "").trim();
    const to = String(tags.to || "").trim();
    const endpoints = from && to ? `${from}–${to}` : from || to;
    const organisation = firstMappedTag(tags, ["network", "operator", "brand"]);
    const operational = transitOperationalDescriptor(tags);
    const gauge = String(tags.gauge || "").trim();
    const electrified = String(tags.electrified || "").trim().toLowerCase();
    const electricLabel = /^(?:contact_line|yes)$/.test(electrified)
      ? "listrik aliran atas"
      : electrified === "rail"
        ? "listrik rel ketiga"
        : electrified === "no"
          ? "nonlistrik"
          : "";
    const technical = [gauge && `sepur ${mappedGaugeLabel(gauge)}`, electricLabel].filter(Boolean).join(" · ");

    let identity = !genericName ? actualName : "";
    if (!identity && routeRef) identity = routeRef;
    if (!identity && endpoints) identity = endpoints;
    if (!identity && organisation) identity = organisation;
    if (!identity && operational) identity = operational;
    if (!identity && source === "infrastructure" && technical) identity = technical;
    if (!identity && source === "infrastructure" && /^(?:disused|abandoned)$/.test(tags.railway || "")) identity = "jalur nonaktif";
    if (!identity && source === "infrastructure" && mode !== "train") identity = `jalur ${modeLabel}`;
    // A raw rail commonly has only railway=rail. Do not turn every OSM way
    // segment into the same misleading "Kereta Api" pill; it remains visible
    // as infrastructure and receives a label only when OSM provides identity
    // or operational context.
    if (!identity) return "";

    const typeAlreadyPresent = /\b(?:mrt|lrt|krl|ka|kereta|train|tram|monorail|monorel|bus|brt|transjakarta)\b/i.test(identity);
    const refSuffix = routeRef && identity !== routeRef && !identity.toLowerCase().includes(routeRef.toLowerCase())
      ? ` ${routeRef}`
      : "";
    return typeAlreadyPresent ? `${identity}${refSuffix}` : `${modeLabel}${refSuffix} · ${identity}`;
  }

  function transitColorFromTags(tags: Record<string, string>, mode: TransitGuideMode): string {
    const mapped = String(tags.colour || tags.color || "").trim();
    if (/^#[0-9a-f]{3,8}$/i.test(mapped)) return mapped;
    if (/^[0-9a-f]{6}$/i.test(mapped)) return `#${mapped}`;
    if (mode === "mrt") return "#1677ff";
    if (mode === "lrt") return "#00a88f";
    if (mode === "tram") return "#7c3aed";
    if (mode === "monorail") return "#0f766e";
    if (mode === "commuter") return "#dc2626";
    if (mode === "high_speed") return "#d97706";
    if (mode === "train") return "#475569";
    if (mode === "busway") return "#e53935";
    return "#2563eb";
  }

  function transitGuideFromTags(
    id: string,
    tags: Record<string, string>,
    mode: TransitGuideMode,
    points: L.LatLng[],
    source: TransitGuideRecord["source"],
    component: Partial<Pick<TransitGuideRecord, "relationId" | "componentIndex" | "componentCount" | "memberCount">> = {},
    verifiedEndpoints: { from?: VerifiedTransitEndpoint | null; to?: VerifiedTransitEndpoint | null } = {},
  ): TransitGuideRecord {
    const routeRef = source === "road_lane"
      ? firstMappedTag(tags, ["route_ref", "bus:route_ref", "public_transport:ref"])
      : firstMappedTag(tags, ["ref", "route_ref"]);
    return {
      id,
      name: source === "road_lane" ? "" : mappedFeatureName(tags),
      label: semanticTransitLabel(tags, mode, source),
      ref: routeRef,
      operator: String(tags.operator || "").trim(),
      network: String(tags.network || "").trim(),
      route: String(tags.route || "").trim(),
      from: String(tags.from || "").trim(),
      to: String(tags.to || "").trim(),
      service: String(tags.service || "").trim(),
      usage: String(tags.usage || "").trim(),
      gauge: String(tags.gauge || "").trim(),
      electrified: String(tags.electrified || "").trim(),
      source,
      color: transitColorFromTags(tags, mode),
      mode,
      relationId: component.relationId || "",
      componentIndex: component.componentIndex || 0,
      componentCount: component.componentCount || 1,
      memberCount: component.memberCount || 1,
      verifiedFrom: verifiedEndpoints.from || null,
      verifiedTo: verifiedEndpoints.to || null,
      points,
    };
  }

  function roadMedianStyle(road: RoadGuideRecord): L.PolylineOptions {
    const scale = roadZoomScale(0.76, 1.18);
    return {
      color: road.treeLined ? "#56c786" : "#82d6bb",
      weight: (road.treeLined ? 3 : 2) * scale,
      opacity: 0.84,
      dashArray: road.treeLined ? "1 9" : "10 12",
      lineCap: "round",
      interactive: false,
    };
  }

  function roadLaneDividerStyle(road: RoadGuideRecord): L.PolylineOptions {
    const scale = roadZoomScale(0.72, 1.12);
    return {
      color: road.roadType === "expressway" ? "#fff3b0" : "#ffffff",
      weight: 1.2 * scale,
      opacity: 0.8,
      dashArray: road.oneway ? "8 12" : "14 14",
      interactive: false,
    };
  }

  function roadSidewalkStyle(road: RoadGuideRecord): L.PolylineOptions {
    const cls = roadRenderClass(road);
    const scale = roadZoomScale(0.76, 1.18);
    return {
      color: cls === "major" ? "rgb(215, 230, 247)" : "#c7d6e6",
      weight: (cls === "major" ? 14.5 : cls === "service" ? 6.5 : 9) * scale,
      opacity: cls === "foot" ? 0 : 0.62,
      dashArray: road.hasSidewalk ? "10 9" : "2 14",
      lineCap: "round",
      className: "road-sidewalk-path",
      renderer: roadDetailRenderer,
      interactive: false,
    };
  }

  function roadAvenueTreeStyle(road: RoadGuideRecord): L.PolylineOptions {
    const scale = roadZoomScale(0.72, 1.16);
    return {
      color: road.treeLined ? "#20b36b" : "#7bd389",
      weight: (road.treeLined ? 5 : 3.2) * scale,
      opacity: road.treeLined ? 0.9 : 0.55,
      dashArray: road.treeLined ? "1 13" : "2 18",
      lineCap: "round",
      interactive: false,
    };
  }

  function roadWaterMedianStyle(): L.PolylineOptions {
    const scale = roadZoomScale(0.74, 1.18);
    return {
      color: "#77cbe8",
      weight: 3.2 * scale,
      opacity: 0.72,
      dashArray: "18 14",
      lineCap: "round",
      interactive: false,
    };
  }

  function roadRoundaboutGreenStyle(): L.PolylineOptions {
    return {
      color: "#9adea9",
      fillColor: "#d8f6d8",
      fillOpacity: 0.78,
      weight: 1.2,
      opacity: 0.92,
      interactive: false,
    };
  }

  function railGuideStyle(casing = false): L.PolylineOptions {
    return {
      color: casing ? "#ffffff" : "#596273",
      weight: casing ? 6 : 3,
      opacity: casing ? 0.92 : 0.86,
      dashArray: casing ? undefined : "10 8",
      lineCap: "butt",
      interactive: false,
    };
  }

  function railSleeperStyle(): L.PolylineOptions {
    return {
      color: "#111827",
      weight: 1.4,
      opacity: 0.58,
      dashArray: "2 12",
      lineCap: "butt",
      interactive: false,
    };
  }

  function waterGuideStyle(water: WaterGuideRecord): L.PolylineOptions {
    const isRiver = /river|canal/.test(water.waterway);
    const scale = roadZoomScale(0.8, 1.2);
    return {
      color: isRiver ? "#77cbe8" : "#8bd8ef",
      weight: (isRiver ? 5.5 : 3.4) * scale,
      opacity: 0.82,
      lineCap: "round",
      interactive: false,
    };
  }

  function greenGuideStyle(green: GreenGuideRecord): L.PolylineOptions {
    const darker = /park|forest|wood/.test(green.kind);
    return {
      color: darker ? "#7edc91" : "#b9efb7",
      fillColor: darker ? "#ccf2ce" : "#e3f8d6",
      fillOpacity: 0.54,
      weight: 1,
      opacity: 0.8,
      interactive: false,
    };
  }

  function roadGuideMidpoint(points: L.LatLng[]): { latlng: L.LatLng; bearing: number } | null {
    if (points.length < 2) return null;
    const index = Math.max(0, Math.min(points.length - 2, Math.floor(points.length / 2) - 1));
    const a = points[index];
    const b = points[index + 1];
    return {
      latlng: L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2),
      bearing: computeBearing(a.lat, a.lng, b.lat, b.lng),
    };
  }

  function roadCyclewayStyle(road: RoadGuideRecord, casing = false): L.PolylineOptions {
    const scale = roadZoomScale(0.76, 1.18);
    return {
      color: casing ? "#ffffff" : "#24a866",
      weight: (casing ? 4.6 : 2.4) * scale,
      opacity: casing ? 0.86 : 0.94,
      dashArray: road.highway === "cycleway" ? undefined : "12 8",
      lineCap: "round",
      interactive: false,
    };
  }

  function roadBusLaneStyle(): L.PolylineOptions {
    const scale = roadZoomScale(0.76, 1.18);
    return {
      color: "#b83a3a",
      weight: 1.65 * scale,
      opacity: 0.8,
      dashArray: "6 2",
      lineCap: "butt",
      interactive: false,
    };
  }

  function pedestrianBridgeStyle(casing = false): L.PolylineOptions {
    const scale = roadZoomScale(0.76, 1.18);
    return {
      color: casing ? "#64748b" : "#f8fafc",
      weight: (casing ? 7 : 4.2) * scale,
      opacity: 0.94,
      dashArray: undefined,
      lineCap: "round",
      interactive: false,
    };
  }

  function nearestRoadMetrics(latlng: L.LatLng, roads: RoadGuideRecord[]): { bearing: number; widthPx: number } {
    let nearestDistance = Number.POSITIVE_INFINITY;
    let nearestBearing = 0;
    let nearestWidthPx = 8;
    const target = map.latLngToLayerPoint(latlng);
    // A mapped crossing is often a short footway. It must not become its own
    // direction reference: the zebra bars need the bearing of the carriageway.
    const carriageways = roads.filter((road) => !/footway|path|pedestrian|corridor|steps|cycleway|crossing/.test(road.highway));
    (carriageways.length ? carriageways : roads).forEach((road) => {
      for (let index = 0; index < road.points.length - 1; index += 1) {
        const startLatLng = road.points[index];
        const endLatLng = road.points[index + 1];
        const start = map.latLngToLayerPoint(startLatLng);
        const end = map.latLngToLayerPoint(endLatLng);
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSquared = dx * dx + dy * dy;
        if (lengthSquared < 0.01) continue;
        const progress = clamp(((target.x - start.x) * dx + (target.y - start.y) * dy) / lengthSquared, 0, 1);
        const projectedX = start.x + dx * progress;
        const projectedY = start.y + dy * progress;
        const distance = (target.x - projectedX) ** 2 + (target.y - projectedY) ** 2;
        if (distance >= nearestDistance) continue;
        nearestDistance = distance;
        nearestBearing = computeBearing(startLatLng.lat, startLatLng.lng, endLatLng.lat, endLatLng.lng);
        const mappedWeight = Number(roadGuideStyle(road, false).weight) || 0;
        const laneWidth = clamp((road.lanes || 1) * 1.8, 3.8, 18);
        nearestWidthPx = Math.max(mappedWeight, laneWidth);
      }
    });
    return { bearing: nearestBearing, widthPx: nearestWidthPx };
  }

  function makeRoundaboutIcon(road: RoadGuideRecord): L.DivIcon {
    const label = road.name || road.ref || "Bundaran";
    return L.divIcon({
      className: "road-guide-roundabout-icon",
      html: `<span title="${escapeHtml(label)}"></span>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
  }

  function makeRailCrossingIcon(crossing: CrossingGuideRecord): L.DivIcon {
    const isRoadCrossing = crossing.type === "road";
    const size = isRoadCrossing
      ? clamp((crossing.roadWidthPx || 8) * 1.25, 10, 28)
      : clamp(11 + (map.getZoom() - 16) * 1.5, 11, 16);
    const depth = clamp(size * 0.66, 7, 15);
    // The zebra's long axis spans across the carriageway. An unrotated CSS
    // rectangle is east-west, already perpendicular to a northbound road.
    const cssBearing = ((crossing.bearing + 540) % 360) - 180;
    return L.divIcon({
      className: isRoadCrossing ? "road-crossing-icon" : "rail-crossing-icon",
      html: `<span class="${isRoadCrossing ? "road-crossing-mark" : "rail-crossing-mark"}" role="img" style="--crossing-size:${size}px;--crossing-depth:${depth}px;--crossing-bearing:${cssBearing}deg" title="${escapeHtml(crossing.name || (isRoadCrossing ? "Penyeberangan" : "Perlintasan kereta"))}" aria-label="${escapeHtml(crossing.name || (isRoadCrossing ? "Penyeberangan" : "Perlintasan kereta"))}"></span>`,
      iconSize: [48, 48],
      iconAnchor: [24, 24],
    });
  }

  function makeWaterNameIcon(name: string, bearing: number): L.DivIcon {
    const readableBearing = bearing > 90 && bearing < 270 ? bearing + 180 : bearing;
    return L.divIcon({
      className: "water-guide-name-icon",
      html: `<span style="--water-label-bearing:${readableBearing}deg">${escapeHtml(name)}</span>`,
      iconSize: [1, 1],
      iconAnchor: [0, 0],
    });
  }

  async function fetchRoadGuidesForBounds(bounds: L.LatLngBounds): Promise<RoadGuideBundle> {
    const emptyBundle = (): RoadGuideBundle => ({
      roads: [], rails: [], transit: [], crossings: [], waterways: [], greens: [], signals: [], trees: [], schools: [], ornaments: [],
    });
    if (!OVERPASS_NETWORK_ENABLED) return emptyBundle();
    if (shouldSkipOverpass("road")) return emptyBundle();
    const bbox = buildOverpassBBoxString(bounds);
    const zoom = map.getZoom();
    const roadClasses = zoom >= 15
      ? "motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified|service|living_street|pedestrian|footway|path|corridor|cycleway|steps|track|road|construction|proposed|bus_guideway"
      : "motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link";
    const finePointQueries = zoom >= 15
      ? `node["railway"~"level_crossing|crossing|tram_crossing"](${bbox});\n    node["highway"="crossing"](${bbox});\n    way["highway"~"footway|path"]["footway"="crossing"](${bbox});\n    way["highway"="crossing"](${bbox});`
      : "";
    const trafficSignalQuery = zoom >= 16 ? `node["highway"="traffic_signals"](${bbox});` : "";
    const treeQueries = zoom >= 17
      ? `way["natural"="tree_row"](${bbox});${zoom >= 18 ? `\n    node["natural"="tree"](${bbox});` : ""}`
      : "";
    const transitRelationQueries = zoom >= 13
      ? `relation["type"="route"]["route"~"^(bus|subway|light_rail|tram|monorail|train)$"](${bbox});`
      : "";
    const transitStopMemberQueries = zoom >= 13
      ? `node["public_transport"~"^(stop_position|platform)$"](${bbox});
    way["public_transport"="platform"](${bbox});
    node["highway"="bus_stop"](${bbox});
    way["highway"="platform"](${bbox});
    node["railway"~"^(station|halt|tram_stop|subway_entrance)$"](${bbox});
    way["railway"="platform"](${bbox});`
      : "";
    const waterRelationQueries = zoom >= 15
      ? `relation["type"="waterway"](${bbox});\n    relation["type"="multipolygon"]["natural"="water"](${bbox});\n    relation["type"="multipolygon"]["water"](${bbox});`
      : "";
    const schoolQueries = zoom >= 16
      ? `node["amenity"~"school|kindergarten|college|university"](${bbox});\n    way["amenity"~"school|kindergarten|college|university"](${bbox});\n    relation["amenity"~"school|kindergarten|college|university"](${bbox});`
      : "";
    const denseOrnamentQueries = zoom >= 18
      ? `node["highway"="street_lamp"](${bbox});
    node["amenity"~"bench|waste_basket"](${bbox});
    node["barrier"="bollard"](${bbox});
    node["entrance"](${bbox});
    node["manhole"](${bbox});
    node["man_made"="manhole"](${bbox});
    node["drain"](${bbox});`
      : "";
    const ornamentQueries = zoom >= 17
      ? `node["man_made"="surveillance"](${bbox});
    node["surveillance"](${bbox});
    node["highway"="speed_camera"](${bbox});
    node["traffic_calming"](${bbox});
    node["barrier"~"^(block|chain|cycle_barrier|jersey_barrier|cattle_grid|stile|kerb|gate|lift_gate|swing_gate|sliding_gate|hampshire_gate|toll_booth)$"](${bbox});
    way["barrier"~"^(guard_rail|retaining_wall)$"](${bbox});
    node["highway"="toll_gantry"](${bbox});
    way["highway"="toll_gantry"](${bbox});
    node["emergency"="fire_hydrant"](${bbox});
    node["amenity"~"^(drinking_water|toilets|taxi|bicycle_parking|charging_station|elevator)$"](${bbox});
    way["amenity"~"^(drinking_water|toilets|taxi|bicycle_parking|charging_station|elevator)$"](${bbox});
    node["highway"="elevator"](${bbox});
    way["highway"="elevator"](${bbox});
    node["escalator"](${bbox});
    way["highway"="steps"]["conveying"](${bbox});
    way["man_made"~"^(retaining_wall|seawall)$"](${bbox});
    node["amenity"="parking"]["park_ride"](${bbox});
    way["amenity"="parking"]["park_ride"](${bbox});
    relation["amenity"="parking"]["park_ride"](${bbox});
    node["amenity"="parking"]["parking:park_ride"](${bbox});
    way["amenity"="parking"]["parking:park_ride"](${bbox});
    ${denseOrnamentQueries}`
      : "";
    const q = `
  [out:json][timeout:18];
  (
    way["highway"~"^(${roadClasses})$"](${bbox});
    way["railway"~"^(rail|light_rail|tram|subway|narrow_gauge|monorail|funicular|disused|abandoned)$"](${bbox});
    way["highway"]["busway"](${bbox});
    way["highway"]["busway:left"](${bbox});
    way["highway"]["busway:right"](${bbox});
    way["highway"]["busway:both"](${bbox});
    way["highway"]["bus:lanes"](${bbox});
    way["highway"]["lanes:bus"](${bbox});
    way["highway"]["lanes:psv"](${bbox});
    ${transitRelationQueries}
    ${transitStopMemberQueries}
    ${finePointQueries}
    ${trafficSignalQuery}
    ${treeQueries}
    ${schoolQueries}
    ${ornamentQueries}
    ${waterRelationQueries}
    way["waterway"~"river|stream|canal|drain|ditch|tidal_channel"](${bbox});
    way["man_made"~"canal|drain|ditch"](${bbox});
    way["natural"="water"](${bbox});
    way["water"~"river|stream|canal|drain|ditch|pond|lake|reservoir"](${bbox});
    way["leisure"~"park|garden|recreation_ground"](${bbox});
    way["landuse"~"grass|forest|meadow|village_green|recreation_ground"](${bbox});
    way["natural"~"wood|grassland|scrub"](${bbox});
  );
  out tags center geom 1400;
`;

    try {
      const data = await fetchOverpassJson(q, "road");
      const elements = Array.isArray(data.elements) ? data.elements : [];
      const elementIndex = new Map<string, any>(elements.flatMap((element: any) => (
        element?.type && element?.id !== undefined ? [[`${element.type}/${element.id}`, element] as const] : []
      )));
      const bundle: RoadGuideBundle = {
        roads: [],
        rails: [],
        transit: [],
        crossings: [],
        waterways: [],
        greens: [],
        signals: [],
        trees: [],
        schools: [],
        ornaments: [],
      };

      elements.forEach((el: any) => {
        const tags = el.tags || {};
        const ornament = mapOrnamentFromElement(el, tags);
        if (ornament) bundle.ornaments.push(ornament);

        if (el.type === "relation" && tags.type === "route" && /^(bus|subway|light_rail|tram|monorail|train)$/.test(tags.route || "")) {
          const mode = transitModeFromTags(tags);
          const memberPaths = elementMemberGeometryPaths(el);
          const components = stitchTransitMemberPaths(memberPaths);
          const endpointMembers = transitEndpointMemberCandidates(el, elementIndex);
          const verifiedEndpoints = {
            from: verifyTransitEndpoint(String(tags.from || ""), "from", endpointMembers),
            to: verifyTransitEndpoint(String(tags.to || ""), "to", endpointMembers),
          };
          components.forEach((component, componentIndex) => {
            bundle.transit.push(transitGuideFromTags(
              `transit-${el.id}-${componentIndex}`,
              tags,
              mode,
              component.points,
              "route",
              {
                relationId: String(el.id),
                componentIndex,
                componentCount: components.length,
                memberCount: component.memberCount,
              },
              verifiedEndpoints,
            ));
          });
          return;
        }

        if (el.type === "relation" && (
          tags.type === "waterway"
          || (tags.type === "multipolygon" && (tags.natural === "water" || Boolean(tags.water)))
        )) {
          elementMemberGeometryPaths(el, true).forEach((path, pathIndex) => {
            bundle.waterways.push({
              id: `water-${el.id}-${pathIndex}`,
              name: mappedWaterName(tags),
              waterway: tags.waterway || tags.water || tags.natural || "waterway",
              detail: waterDetailProperties(tags),
              points: path,
            });
          });
          return;
        }

        if (el.type === "node") {
          const lat = Number(el.lat);
          const lng = Number(el.lon);
          if (!isValidCoordinate(lat, lng)) return;
          if (/^(school|kindergarten|college|university)$/.test(tags.amenity || "")) {
            bundle.schools.push({
              id: `school-${el.id}`,
              name: tags["name:id"] || tags.name || "Zona sekolah",
              kind: tags.amenity,
              latlng: L.latLng(lat, lng),
            });
          }
          if (/level_crossing|crossing|tram_crossing/.test(tags.railway || "")) {
            bundle.crossings.push({
              id: `crossing-${el.id}`,
              name: tags.name || tags.ref || "Perlintasan kereta",
              latlng: L.latLng(lat, lng),
              type: "rail",
              bearing: 0,
            });
          } else if (tags.highway === "traffic_signals") {
            bundle.signals.push({
              id: `signal-${el.id}`,
              name: tags.name || tags.ref || "Lampu lalu lintas",
              latlng: L.latLng(lat, lng),
            });
          } else if (tags.highway === "crossing") {
            bundle.crossings.push({
              id: `crossing-${el.id}`,
              name: tags.name || tags.ref || "Penyeberangan",
              latlng: L.latLng(lat, lng),
              type: "road",
              bearing: 0,
            });
          } else if (tags.natural === "tree") {
            bundle.trees.push({
              id: `tree-${el.id}`,
              name: tags.name || "",
              latlng: L.latLng(lat, lng),
            });
          }
          return;
        }

        const points = elementGeometryPoints(el);
        if (/^(school|kindergarten|college|university)$/.test(tags.amenity || "")) {
          const centerLat = Number(el.center?.lat);
          const centerLng = Number(el.center?.lon);
          const center = isValidCoordinate(centerLat, centerLng) ? L.latLng(centerLat, centerLng) : guideCentroid(points);
          if (center) {
            bundle.schools.push({
              id: `school-${el.type}-${el.id}`,
              name: tags["name:id"] || tags.name || "Zona sekolah",
              kind: tags.amenity,
              latlng: center,
            });
          }
        }
        if (points.length < 2) return;

        if (tags.highway) {
          if (tags.highway === "crossing" || tags.footway === "crossing" || tags.crossing === "marked") {
            const center = guideCentroid(points);
            if (center) {
              bundle.crossings.push({
                id: `crossing-${el.type}-${el.id}`,
                name: tags.name || tags.ref || "Penyeberangan",
                latlng: center,
                type: "road",
                bearing: 0,
              });
            }
          }
          const name = mappedFeatureName(tags) || tags.ref || tags["addr:street"] || "";
          const lanes = numberTag(tags, "lanes") || (numberTag(tags, "lanes:forward") + numberTag(tags, "lanes:backward"));
          const roadType = detectRoadType(tags, name);
          const isRoundabout = tags.junction === "roundabout" || tags.junction === "circular";
          const onewayDirection = String(tags.oneway || (isRoundabout ? "yes" : "no")).trim().toLowerCase();
          const oneway = isRoundabout || /^(?:-1|1|true|yes|reversible)$/.test(onewayDirection);
          const medianType = String(tags["median:type"] || tags.median || tags.divider || "").trim();
          const hasExplicitMedian = Boolean(medianType && !/^(?:0|false|no|none)$/i.test(medianType));
          const hasMappedMedian = tags.dual_carriageway === "yes"
            || Boolean(tags.divider && tags.divider !== "no")
            || hasExplicitMedian;
          const hasMappedTreeLine = tags.tree_lined === "yes"
            || tags["tree_lined:both"] === "yes";
          const busLane = hasMappedBusLane(tags);
          const hasCycleway = hasMappedCycleway(tags);
          const pedestrianStructure = pedestrianStructureFromTags(tags);
          const detail = roadDetailProperties(tags);
          if (onewayDirection === "reversible" && !("reversible" in detail)) detail.reversible = "yes";
          if (hasExplicitMedian) detail.medianType = medianType;
          if (hasCycleway && !("cycleway" in detail)) {
            detail.cycleway = firstMappedTag(tags, ["cycleway:both", "cycleway:left", "cycleway:right"]) || "designated";
          }
          if (pedestrianStructure) detail.pedestrianStructure = pedestrianStructure;
          const sidewalkTag = String(tags.sidewalk || "").trim().toLowerCase();
          const hasAttachedSidewalk = /^(?:yes|both|left|right)$/.test(sidewalkTag)
            || [tags["sidewalk:left"], tags["sidewalk:right"]].some((value) => /^(?:yes|designated)$/i.test(String(value || "")));
          bundle.roads.push({
            id: `road-${el.id}`,
            name,
            ref: tags.ref || "",
            highway: tags.highway,
            oneway,
            onewayDirection,
            hasSidewalk: hasAttachedSidewalk || /footway|pedestrian|path/.test(tags.highway),
            hasMedian: hasMappedMedian,
            medianType: hasExplicitMedian ? medianType : "",
            treeLined: hasMappedTreeLine,
            waterMedian: tags.waterway === "stream" || tags.water === "canal",
            isRoundabout,
            lanes,
            busLane,
            hasCycleway,
            pedestrianStructure,
            surface: tags.surface || "",
            detail,
            roadType,
            points,
          });
          // A tagged bus lane is road treatment, not evidence of an entire BRT
          // route. Official route relations own the transit route layer.
          return;
        }

        if (tags.railway && /rail|light_rail|tram|subway|narrow_gauge|monorail|funicular|disused|abandoned/.test(tags.railway)) {
          const mode = transitModeFromTags(tags);
          const detail = railDetailProperties(tags);
          bundle.rails.push({
            id: `rail-${el.id}`,
            name: mappedFeatureName(tags),
            label: semanticTransitLabel(tags, mode, "infrastructure"),
            ref: String(tags.ref || "").trim(),
            operator: String(tags.operator || "").trim(),
            network: String(tags.network || "").trim(),
            service: String(tags.service || "").trim(),
            usage: String(tags.usage || "").trim(),
            gauge: String(tags.gauge || "").trim(),
            electrified: String(tags.electrified || "").trim(),
            railway: tags.railway,
            detail,
            points,
          });
          bundle.transit.push(transitGuideFromTags(`transit-rail-${el.id}`, tags, mode, points, "infrastructure"));
          return;
        }

        if (tags.waterway || tags.natural === "water" || tags.water || /canal|drain|ditch/.test(tags.man_made || "")) {
          bundle.waterways.push({
            id: `water-${el.id}`,
            name: mappedWaterName(tags),
            waterway: tags.waterway || tags.water || tags.natural || tags.man_made || "water",
            detail: waterDetailProperties(tags),
            points,
          });
          return;
        }

        if (tags.leisure || tags.landuse || /wood|grassland|scrub|tree_row/.test(tags.natural || "")) {
          bundle.greens.push({
            id: `green-${el.id}`,
            name: tags.name || "",
            kind: tags.leisure || tags.landuse || tags.natural || "green",
            points,
          });
        }
      });

      const locatedCrossings = bundle.crossings.map((crossing) => {
        const roadMetrics = nearestRoadMetrics(crossing.latlng, bundle.roads);
        return { ...crossing, bearing: roadMetrics.bearing, roadWidthPx: roadMetrics.widthPx };
      });
      bundle.crossings = locatedCrossings.filter((crossing, index, records) => records.findIndex((candidate) => (
        candidate.type === crossing.type
        && candidate.latlng.distanceTo(crossing.latlng) < 4
      )) === index);

      return bundle;
    } catch (err) {
      console.debug("Overpass road guide failed; no map detail is fabricated:", err);
      return emptyBundle();
    }
  }

  function makeTrafficSignalGuideIcon(signal: MapPointGuideRecord): L.DivIcon {
    const label = signal.name || "Lampu lalu lintas";
    return L.divIcon({
      className: "traffic-signal-guide-icon",
      html: `<span role="img" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><i></i><i></i><i></i></span>`,
      iconSize: [48, 48],
      iconAnchor: [24, 24],
    });
  }

  function makeTreeGuideIcon(tree: MapPointGuideRecord): L.DivIcon {
    const label = tree.name || "Pohon terpetakan";
    return L.divIcon({
      className: "tree-guide-icon",
      html: `<span role="img" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></span>`,
      iconSize: [48, 48],
      iconAnchor: [24, 24],
    });
  }

  function makeSchoolZoneGuideIcon(school: SchoolGuideRecord): L.DivIcon {
    const fallback = school.kind === "kindergarten" ? "Zona TK" : school.kind === "university" ? "Kampus" : "Zona sekolah";
    const label = school.name || fallback;
    return L.divIcon({
      className: "school-zone-guide-icon",
      html: `<span role="img" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><i aria-hidden="true">S</i><b aria-hidden="true">${escapeHtml(label)}</b></span>`,
      iconSize: [112, 48],
      iconAnchor: [11, 24],
    });
  }

  function transitGuideCasingStyle(transit: TransitGuideRecord): L.PolylineOptions {
    const scale = roadZoomScale(0.78, 1.16);
    return {
      color: "#ffffff",
      weight: (transit.mode === "busway" ? 6.6 : 5.8) * scale,
      opacity: 0.9,
      lineCap: "round",
      className: `transit-guide-path transit-guide-casing transit-${transit.mode}`,
      renderer: transportGuideRenderer,
      interactive: false,
    };
  }

  function transitGuideStyle(transit: TransitGuideRecord): L.PolylineOptions {
    const scale = roadZoomScale(0.78, 1.16);
    return {
      color: transit.color,
      weight: (transit.mode === "busway" ? 3.4 : 3) * scale,
      opacity: 0.9,
      dashArray: transit.mode === "bus" ? "8 7" : transit.mode === "train" ? "12 7" : undefined,
      lineCap: "round",
      className: `transit-guide-path transit-guide-line transit-${transit.mode}`,
      renderer: transportGuideRenderer,
      interactive: false,
    };
  }

  function mappedGaugeLabel(gauge: string): string {
    const numeric = Number(String(gauge || "").split(";")[0]);
    return Number.isFinite(numeric) && numeric > 0 ? `${numeric.toLocaleString("id-ID")} mm` : gauge;
  }

  function transitDetailTitle(transit: TransitGuideRecord): string {
    const endpoints = transit.from && transit.to ? `${transit.from}–${transit.to}` : transit.from || transit.to;
    const electric = meaningfulMappedValue(transit.electrified) ? `elektrifikasi ${transit.electrified}` : "";
    return [
      transit.label,
      endpoints,
      transit.network,
      transit.operator,
      transit.service && `layanan ${transit.service}`,
      transit.usage && `fungsi ${transit.usage}`,
      transit.gauge && `sepur ${mappedGaugeLabel(transit.gauge)}`,
      electric,
    ].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(" · ");
  }

  function makeTransitNameIcon(transit: TransitGuideRecord): L.DivIcon {
    const label = transit.ref || transit.name || transit.route || transit.label;
    const title = transitDetailTitle(transit) || label;
    return L.divIcon({
      className: "transit-guide-name-icon",
      html: `<span role="img" aria-label="${escapeHtml(title)}" style="--transit-color:${escapeHtml(transit.color)}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`,
      iconSize: [1, 1],
      iconAnchor: [0, 0],
    });
  }

  function makeTransitEndpointIcon(transit: TransitGuideRecord, role: "from" | "to"): L.DivIcon {
    const label = role === "from" ? transit.from : transit.to;
    const sourceTag = `${role}=${label}`;
    return L.divIcon({
      className: `transit-route-endpoint transit-route-endpoint-${role}`,
      html: `<span title="${escapeHtml(sourceTag)}" style="display:inline-flex;align-items:center;gap:5px;transform:translate(-8px,-50%);white-space:nowrap;pointer-events:none"><i aria-hidden="true" style="display:block;width:10px;height:10px;border:2px solid #fff;border-radius:50%;background:${escapeHtml(transit.color)};box-shadow:0 1px 4px rgba(15,23,42,.38)"></i><b style="padding:2px 6px;border:1px solid rgba(148,163,184,.72);border-radius:9px;background:rgba(255,255,255,.94);color:#1f2937;font:600 10px/1.2 system-ui,sans-serif;box-shadow:0 1px 4px rgba(15,23,42,.16)">${escapeHtml(label)}</b></span>`,
      iconSize: [1, 1],
      iconAnchor: [0, 0],
    });
  }

  function ornamentMinimumZoom(kind: MapOrnamentKind): number {
    return /^(?:street_lamp|bench|waste_basket|bollard|entrance|manhole|drain_grate)$/.test(kind) ? 18 : 17;
  }

  function ornamentPriority(kind: MapOrnamentKind): number {
    const priorities: Partial<Record<MapOrnamentKind, number>> = {
      speed_camera: 0,
      toll_gate: 1,
      surveillance: 2,
      hydrant: 3,
      traffic_calming: 4,
      gate: 5,
      barrier: 6,
      elevator: 7,
      escalator: 8,
      toilets: 9,
      drinking_water: 10,
      charging_station: 11,
      park_and_ride: 12,
      taxi: 13,
      bicycle_parking: 14,
    };
    return priorities[kind] ?? 30;
  }

  function ornamentSymbolMarkup(kind: MapOrnamentKind): { markup: string; wide: boolean } {
    const compactLabels: Partial<Record<MapOrnamentKind, string>> = {
      toilets: "WC", taxi: "TX", charging_station: "EV", park_and_ride: "P+R",
    };
    const label = compactLabels[kind];
    if (label) return { markup: `<b aria-hidden="true">${label}</b>`, wide: true };

    // Recognisable pictograms replace the ambiguous one-letter G/B/P markers
    // used by the first ornament pass.
    const paths: Partial<Record<MapOrnamentKind, string>> = {
      street_lamp: '<path d="M7 21h10M12 21V8m0 0c0-3 2-5 5-5h2v5h-7Z"/>',
      surveillance: '<path d="m4 8 13-3 1 6-13 3-1-6Zm10.5 4.2L17 20M13 20h8"/>',
      speed_camera: '<rect x="3" y="6" width="14" height="11" rx="2"/><circle cx="10" cy="11.5" r="3"/><path d="m17 9 4-2v9l-4-2"/>',
      traffic_calming: '<path d="M2 16h3c1-5 3-7 7-7s6 2 7 7h3M5 19h14"/>',
      barrier: '<path d="M3 9h18v6H3zM6 9l3 6m3-6 3 6m3-6 3 6M6 15v5m12-5v5"/>',
      guardrail: '<path d="M2 9h20v6H2zM6 15v5m12-5v5M6 12h12"/>',
      bollard: '<path d="M8 20h8M9 20l1-15h4l1 15M10 9h4"/>',
      toll_gate: '<path d="M3 21V7h12v14M3 10h12M15 12h6M18 9v6"/>',
      hydrant: '<path d="M8 21V8a4 4 0 0 1 8 0v13M6 12h12M5 9h3m8 0h3M6 21h12"/>',
      bench: '<path d="M4 10h16v6H4zM6 16v5m12-5v5M5 7h14v3"/>',
      waste_basket: '<path d="M7 7h10l-1 14H8L7 7Zm-2 0h14M9 4h6m-5 6v8m4-8v8"/>',
      drinking_water: '<path d="M12 3s6 7 6 12a6 6 0 0 1-12 0c0-5 6-12 6-12Zm-3 13c1 2 2 3 4 3"/>',
      entrance: '<path d="M4 21V3h12v18M9 12h12m-3-3 3 3-3 3M13 12h.01"/>',
      gate: '<path d="M4 21V5h16v16M4 9h16M8 9v12m8-12v12M8 15h8"/>',
      elevator: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="m9 9 3-3 3 3m-6 6 3 3 3-3M12 6v12"/>',
      escalator: '<path d="M4 18h4l7-9h5M4 21h6l7-9h3M7 6h.01"/>',
      manhole: '<circle cx="12" cy="12" r="8"/><path d="M6 12h12M8 8h8m-8 8h8"/>',
      drain_grate: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 7v10m4-10v10m4-10v10m4-10v10"/>',
      retaining_wall: '<path d="M3 19h18M5 19V7h14v12M5 11h14M9 7v12m6-12v12"/>',
      seawall: '<path d="M3 5v14m4-5c2-3 4-3 6 0s4 3 8 0M7 9c2-3 4-3 6 0s4 3 8 0"/>',
      bicycle_parking: '<circle cx="7" cy="16" r="4"/><circle cx="18" cy="16" r="4"/><path d="m7 16 4-8 4 8m-8 0h8l-3-5h5M10 5h4"/>',
    };
    const path = paths[kind] || '<circle cx="12" cy="12" r="7"/><path d="M12 8v8m-4-4h8"/>';
    return {
      markup: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`,
      wide: false,
    };
  }

  function ornamentColor(kind: MapOrnamentKind): string {
    if (/^(?:speed_camera|surveillance|toll_gate)$/.test(kind)) return "#b91c1c";
    if (/^(?:hydrant|traffic_calming|barrier|bollard|gate)$/.test(kind)) return "#d97706";
    if (/^(?:drinking_water|toilets|taxi|bicycle_parking|charging_station|park_and_ride)$/.test(kind)) return "#2563eb";
    if (/^(?:entrance|elevator|escalator)$/.test(kind)) return "#7c3aed";
    return "#475569";
  }

  function makeOrnamentIcon(ornament: MapOrnamentRecord): L.DivIcon {
    const title = [ornament.name, `${ornament.tagKey}=${ornament.tagValue}`].filter(Boolean).join(" · ");
    const symbol = ornamentSymbolMarkup(ornament.kind);
    const width = symbol.wide ? 25 : 20;
    return L.divIcon({
      className: `map-ornament-icon map-ornament-${ornament.kind}`,
      html: `<span role="img" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:grid;place-items:center;width:${width}px;height:20px;border:1.5px solid #fff;border-radius:6px;background:${ornamentColor(ornament.kind)};color:#fff;font:800 7px/1 system-ui,sans-serif;letter-spacing:-.25px;box-shadow:0 1px 4px rgba(15,23,42,.32);pointer-events:none">${symbol.markup}</span>`,
      iconSize: [48, 48],
      iconAnchor: [24, 24],
    });
  }

  function ornamentLineStyle(ornament: MapOrnamentRecord): L.PolylineOptions {
    const colors: Partial<Record<MapOrnamentKind, string>> = {
      guardrail: "#64748b",
      retaining_wall: "#8b6f55",
      seawall: "#477d95",
      barrier: "#6b7280",
    };
    return {
      color: colors[ornament.kind] || "#64748b",
      weight: ornament.kind === "seawall" ? 3 : 2.2,
      opacity: 0.76,
      dashArray: ornament.kind === "guardrail" ? "2 3" : ornament.kind === "barrier" ? "5 3" : undefined,
      lineCap: "round",
      className: `map-ornament-line map-ornament-${ornament.kind}`,
      interactive: false,
    };
  }

  function pedestrianStructureLabel(road: RoadGuideRecord): string {
    if (!road.pedestrianStructure) return "";
    const kind = road.pedestrianStructure === "jpo"
      ? "JPO"
      : road.pedestrianStructure === "footbridge"
        ? "Jembatan pejalan kaki"
        : "Jalur pejalan kaki tertutup";
    const identity = road.name || road.ref;
    if (!identity || identity.toLocaleLowerCase("id-ID").includes(kind.toLocaleLowerCase("id-ID"))) return identity || kind;
    return `${kind} · ${identity}`;
  }

  function cyclewaySemanticLabel(road: RoadGuideRecord): string {
    if (!road.hasCycleway || (!road.name && !road.ref)) return "";
    return /jalur sepeda|cycleway|bikeway/i.test(road.name) ? road.name : `Jalur sepeda · ${road.name || road.ref}`;
  }

  function makeRoadSemanticNameIcon(label: string, bearing: number): L.DivIcon {
    const readableBearing = bearing > 90 && bearing < 270 ? bearing + 180 : bearing;
    return L.divIcon({
      className: "road-guide-name-icon",
      html: `<span role="img" aria-label="${escapeHtml(label)}" style="--road-label-bearing:${readableBearing}deg" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`,
      iconSize: [1, 1],
      iconAnchor: [0, 0],
    });
  }

  function makeWaterCharacterIcon(character: string, bearing: number, name: string): L.DivIcon {
    let readableBearing = ((bearing + 540) % 360) - 180;
    if (readableBearing > 90) readableBearing -= 180;
    if (readableBearing < -90) readableBearing += 180;
    return L.divIcon({
      className: "water-guide-character-icon",
      html: `<span style="--water-character-bearing:${readableBearing}deg" title="${escapeHtml(name)}">${escapeHtml(character)}</span>`,
      iconSize: [1, 1],
      iconAnchor: [0, 0],
    });
  }

  function addCurvedWaterName(layer: L.LayerGroup, water: WaterGuideRecord): boolean {
    const characters = Array.from(water.name.trim()).slice(0, 28);
    if (characters.length < 2 || water.points.length < 2) return false;

    const points = water.points.map((point) => map.latLngToLayerPoint(point));
    const segments: Array<{ start: L.Point; end: L.Point; from: number; length: number }> = [];
    let totalLength = 0;
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      const length = start.distanceTo(end);
      if (length < 1) continue;
      segments.push({ start, end, from: totalLength, length });
      totalLength += length;
    }

    const letterSpacing = clamp(7.2 + (map.getZoom() - 17) * 0.45, 7.2, 8.4);
    const labelLength = characters.length * letterSpacing;
    if (!segments.length || totalLength < labelLength + 18) return false;
    const labelStart = (totalLength - labelLength) / 2;

    characters.forEach((character, index) => {
      if (!character.trim()) return;
      const distance = labelStart + (index + 0.5) * letterSpacing;
      const segment = segments.find((candidate) => distance <= candidate.from + candidate.length) || segments[segments.length - 1];
      const progress = clamp((distance - segment.from) / segment.length, 0, 1);
      const point = L.point(
        segment.start.x + (segment.end.x - segment.start.x) * progress,
        segment.start.y + (segment.end.y - segment.start.y) * progress,
      );
      const bearing = Math.atan2(segment.end.y - segment.start.y, segment.end.x - segment.start.x) * 180 / Math.PI;
      L.marker(map.layerPointToLatLng(point), {
        pane: ROAD_ORNAMENT_PANE,
        icon: makeWaterCharacterIcon(character, bearing, water.name),
        interactive: false,
        zIndexOffset: 110,
      }).addTo(layer);
    });
    return true;
  }

  function mapDetailCollection(bundle: RoadGuideBundle): MapDetailFeatureCollection {
    const features: MapDetailFeatureCollection["features"] = [];
    const lineCoordinates = (points: L.LatLng[]) => points.map((point) => [point.lng, point.lat]);
    const addLine = (id: string, kind: string, name: string, points: L.LatLng[], properties: Record<string, unknown> = {}) => {
      if (points.length < 2) return;
      features.push({
        type: "Feature",
        id,
        properties: { kind, name, confidence: "verified", ...properties },
        geometry: { type: "LineString", coordinates: lineCoordinates(points) },
      });
    };

    bundle.roads.forEach((road) => {
      const pedestrian = /footway|path|pedestrian|corridor|steps|cycleway/.test(road.highway);
      const structureLabel = pedestrianStructureLabel(road);
      const cycleLabel = cyclewaySemanticLabel(road);
      const semanticName = structureLabel || cycleLabel || road.name || road.ref;
      const featureKind = road.highway === "cycleway" ? "cycleway" : pedestrian ? "pedestrian" : "road";
      addLine(road.id, featureKind, semanticName, road.points, {
        sourceName: road.name,
        roadType: road.roadType,
        highway: road.highway,
        ...(road.detail || {}),
        lanes: road.lanes,
        oneway: road.onewayDirection || (road.oneway ? "yes" : "no"),
        surface: road.surface,
        busLane: road.busLane,
        hasCycleway: road.hasCycleway,
        pedestrianStructure: road.pedestrianStructure,
      });
      if (road.hasSidewalk && !pedestrian) {
        addLine(`${road.id}-sidewalk`, "sidewalk", road.name || road.ref, road.points, {
          roadType: road.roadType,
        });
      }
      if (road.hasMedian) {
        addLine(`${road.id}-median`, "median", "", road.points, road.medianType ? { medianType: road.medianType } : {});
      }
    });

    bundle.rails.forEach((rail) => {
      addLine(rail.id, "railway", rail.label, rail.points, {
        sourceName: rail.name,
        railway: rail.railway,
        ref: rail.ref,
        operator: rail.operator,
        network: rail.network,
        service: rail.service,
        usage: rail.usage,
        gauge: rail.gauge,
        electrified: rail.electrified,
        ...(rail.detail || {}),
      });
    });

    bundle.transit.forEach((transit) => {
      addLine(transit.id, "transit", transit.label, transit.points, {
        displayLabel: transit.label,
        sourceName: transit.name,
        transitMode: transit.mode,
        source: transit.source,
        operator: transit.operator,
        network: transit.network,
        route: transit.route,
        from: transit.from,
        to: transit.to,
        service: transit.service,
        usage: transit.usage,
        gauge: transit.gauge,
        electrified: transit.electrified,
        ref: transit.ref,
        color: transit.color,
        relationId: transit.relationId,
        componentIndex: transit.componentIndex,
        componentCount: transit.componentCount,
        stitchedMemberCount: transit.memberCount,
      });
      if (transit.source !== "route" || !transit.points.length) return;
      if (transit.componentIndex === 0 && transit.verifiedFrom) {
        const endpoint = transit.verifiedFrom;
        features.push({
          type: "Feature",
          id: `${transit.id}-from`,
          properties: {
            kind: "transit_endpoint",
            name: endpoint.label,
            endpointLabel: endpoint.label,
            endpointRole: "from",
            transitMode: transit.mode,
            relationId: transit.relationId,
            endpointMemberType: endpoint.memberType,
            endpointMemberRef: endpoint.memberRef,
            endpointMemberRole: endpoint.memberRole,
            endpointVerification: endpoint.verification,
            color: transit.color,
            confidence: "verified",
          },
          geometry: { type: "Point", coordinates: [endpoint.point.lng, endpoint.point.lat] },
        });
      }
      if (transit.componentIndex === transit.componentCount - 1 && transit.verifiedTo) {
        const endpoint = transit.verifiedTo;
        features.push({
          type: "Feature",
          id: `${transit.id}-to`,
          properties: {
            kind: "transit_endpoint",
            name: endpoint.label,
            endpointLabel: endpoint.label,
            endpointRole: "to",
            transitMode: transit.mode,
            relationId: transit.relationId,
            endpointMemberType: endpoint.memberType,
            endpointMemberRef: endpoint.memberRef,
            endpointMemberRole: endpoint.memberRole,
            endpointVerification: endpoint.verification,
            color: transit.color,
            confidence: "verified",
          },
          geometry: { type: "Point", coordinates: [endpoint.point.lng, endpoint.point.lat] },
        });
      }
    });

    bundle.ornaments.forEach((ornament) => {
      const properties = {
        ornamentKind: ornament.kind,
        tagKey: ornament.tagKey,
        tagValue: ornament.tagValue,
        ...(ornament.detail || {}),
      };
      if (ornament.geometry === "line") {
        addLine(ornament.id, "ornament", ornament.name, ornament.points, properties);
        return;
      }
      const point = ornament.points[0];
      if (!point) return;
      features.push({
        type: "Feature",
        id: ornament.id,
        properties: { kind: "ornament", name: ornament.name, confidence: "verified", ...properties },
        geometry: { type: "Point", coordinates: [point.lng, point.lat] },
      });
    });

    bundle.waterways.forEach((water) => {
      const coordinates = lineCoordinates(water.points);
      const polygon = water.points.length >= 4 && isClosedGuideRing(water.points);
      features.push({
        type: "Feature",
        id: water.id,
        properties: {
          kind: "waterway",
          name: water.name,
          waterway: water.waterway,
          confidence: "verified",
          ...(water.detail || {}),
        },
        geometry: polygon
          ? { type: "Polygon", coordinates: [coordinates] }
          : { type: "LineString", coordinates },
      });
    });

    bundle.greens.forEach((green) => {
      if (green.kind === "tree_row") {
        addLine(green.id, "tree_row", green.name, green.points);
        return;
      }
      if (green.points.length < 4 || !isClosedGuideRing(green.points)) return;
      features.push({
        type: "Feature",
        id: green.id,
        properties: { kind: "green", name: green.name, greenType: green.kind, confidence: "verified" },
        geometry: { type: "Polygon", coordinates: [lineCoordinates(green.points)] },
      });
    });

    bundle.crossings.forEach((crossing) => {
      features.push({
        type: "Feature",
        id: crossing.id,
        properties: { kind: "crossing", name: crossing.name, crossingType: crossing.type, bearing: crossing.bearing, confidence: "verified" },
        geometry: { type: "Point", coordinates: [crossing.latlng.lng, crossing.latlng.lat] },
      });
    });

    bundle.signals.forEach((signal) => {
      features.push({
        type: "Feature",
        id: signal.id,
        properties: { kind: "traffic_signal", name: signal.name, confidence: "verified" },
        geometry: { type: "Point", coordinates: [signal.latlng.lng, signal.latlng.lat] },
      });
    });

    bundle.trees.forEach((tree) => {
      features.push({
        type: "Feature",
        id: tree.id,
        properties: { kind: "tree", name: tree.name, confidence: "verified" },
        geometry: { type: "Point", coordinates: [tree.latlng.lng, tree.latlng.lat] },
      });
    });

    bundle.schools.forEach((school) => {
      features.push({
        type: "Feature",
        id: school.id,
        properties: { kind: "school_zone", name: school.name, schoolType: school.kind, confidence: "verified" },
        geometry: { type: "Point", coordinates: [school.latlng.lng, school.latlng.lat] },
      });
    });

    return { type: "FeatureCollection", features };
  }

  const MAP_DETAIL_CACHE_VERSION = 6;

  function mapDetailTileKey(bounds: L.LatLngBounds, zoom: number): string {
    const zoomBucket = Math.max(11, Math.min(18, Math.floor(zoom)));
    const center = bounds.getCenter();
    const scale = 2 ** zoomBucket;
    const tileX = Math.floor(((center.lng + 180) / 360) * scale);
    const latitude = Math.max(-85.0511, Math.min(85.0511, center.lat)) * Math.PI / 180;
    const tileY = Math.floor((1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2 * scale);
    return `details-v${MAP_DETAIL_CACHE_VERSION}:${zoomBucket}:${tileX}:${tileY}:${detailGroupsForZoom(zoom).join(",")}`;
  }

  function poiCacheKeyForBounds(bounds: L.LatLngBounds, zoomValue = map.getZoom()): string {
    const zoomBucket = Math.max(13, Math.min(18, Math.floor(zoomValue)));
    const center = bounds.getCenter();
    const scale = 2 ** zoomBucket;
    const tileX = Math.floor(((center.lng + 180) / 360) * scale);
    const latitude = Math.max(-85.0511, Math.min(85.0511, center.lat)) * Math.PI / 180;
    const tileY = Math.floor((1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2 * scale);
    return `poi:${zoomBucket}:${tileX}:${tileY}`;
  }

  let lastMapDetailKey = "";
  let mapDetailRequestSequence = 0;
  const rememberedMapDetailCollections = new Map<string, MapDetailFeatureCollection>();
  let rememberedMapDetailZoomBucket = "";

  function rememberMapDetailCollection(key: string, collection: MapDetailFeatureCollection): MapDetailFeatureCollection {
    const zoomBucket = key.split(":").slice(0, 2).join(":");
    if (rememberedMapDetailZoomBucket && rememberedMapDetailZoomBucket !== zoomBucket) {
      rememberedMapDetailCollections.clear();
    }
    rememberedMapDetailZoomBucket = zoomBucket;
    rememberedMapDetailCollections.delete(key);
    rememberedMapDetailCollections.set(key, collection);
    while (rememberedMapDetailCollections.size > 42) {
      const oldest = rememberedMapDetailCollections.keys().next().value as string | undefined;
      if (!oldest) break;
      rememberedMapDetailCollections.delete(oldest);
    }
    const byId = new Map<string, MapDetailFeatureCollection["features"][number]>();
    rememberedMapDetailCollections.forEach((item) => item.features.forEach((feature, index) => {
      const featureKey = String(feature.id || `${key}:${index}:${JSON.stringify(feature.geometry)}`);
      byId.set(featureKey, feature);
    }));
    return { type: "FeatureCollection", features: [...byId.values()] };
  }

  async function refreshMapLibreDetailLayer(force = false): Promise<void> {
    const maplibreMap = state.maplibreMap;
    if (!maplibreMap || state.baseMode === "satellite") return;
    if (typeof maplibreMap.isStyleLoaded === "function" && !maplibreMap.isStyleLoaded()) return;
    const zoom = map.getZoom();
    if (zoom < 11) {
      setMapDetailData(maplibreMap, EMPTY_MAP_DETAIL_COLLECTION);
      return;
    }

    const bounds = map.getBounds();
    const key = mapDetailTileKey(bounds, zoom);
    if (!force && key === lastMapDetailKey) return;
    lastMapDetailKey = key;
    const requestId = ++mapDetailRequestSequence;
    const cached = await mapDetailCache.get<MapDetailFeatureCollection>(key, 14 * 24 * 60 * 60 * 1000);
    const validCached = cached?.features?.length ? cached : null;
    if (validCached && requestId === mapDetailRequestSequence) {
      setMapDetailData(maplibreMap, rememberMapDetailCollection(key, validCached));
    }

    const bundle = await fetchRoadGuidesForBounds(bounds.pad(0.12));
    if (requestId !== mapDetailRequestSequence) return;
    const collection = mapDetailCollection(bundle);
    if (!collection.features.length) {
      if (!validCached && rememberedMapDetailCollections.size === 0) setMapDetailData(maplibreMap, EMPTY_MAP_DETAIL_COLLECTION);
      return;
    }
    setMapDetailData(maplibreMap, rememberMapDetailCollection(key, collection));
    void mapDetailCache.set(key, collection);
  }

  const rememberedRoadGuideBundles = new Map<string, RoadGuideBundle>();
  let visibleRoadGuideBundle: RoadGuideBundle | null = null;
  // Bump when parsed tags or derived geometry change so old cached bundles do
  // not silently drop properties required by the MapLibre detail renderer.
  const ROAD_GUIDE_CACHE_VERSION = 7;
  const ROAD_GUIDE_PREFETCH_SESSION_LIMIT = 16;
  const ROAD_GUIDE_PREFETCH_DELAY_MS = 4_800;
  const roadGuidePrefetchQueue: Array<{ bounds: L.LatLngBounds; key: string }> = [];
  const roadGuidePrefetchSeen = new Set<string>();
  let roadGuidePrefetchCount = 0;
  let roadGuidePrefetchBusy = false;
  let roadGuidePrefetchTimer = 0;

  function canPrefetchRoadGuides(): boolean {
    const connection = (navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }).connection;
    return OVERPASS_NETWORK_ENABLED
      && navigator.onLine
      && !document.hidden
      && !connection?.saveData
      && connection?.effectiveType !== "2g"
      && !shouldSkipOverpass("road")
      && roadGuidePrefetchCount < ROAD_GUIDE_PREFETCH_SESSION_LIMIT;
  }

  function scheduleNextRoadGuidePrefetch(): void {
    window.clearTimeout(roadGuidePrefetchTimer);
    if (!roadGuidePrefetchQueue.length || roadGuidePrefetchBusy || !canPrefetchRoadGuides()) return;
    roadGuidePrefetchTimer = window.setTimeout(() => void runNextRoadGuidePrefetch(), ROAD_GUIDE_PREFETCH_DELAY_MS);
  }

  async function runNextRoadGuidePrefetch(): Promise<void> {
    if (roadGuidePrefetchBusy || !canPrefetchRoadGuides()) return;
    const task = roadGuidePrefetchQueue.shift();
    if (!task) return;
    roadGuidePrefetchBusy = true;
    roadGuidePrefetchCount += 1;
    try {
      const cached = await mapDetailCache.get<RoadGuideBundle>(task.key, 7 * 24 * 60 * 60 * 1000);
      let selectedBundle = cached;
      if (!selectedBundle) {
        const bundle = await fetchRoadGuidesForBounds(task.bounds);
        if (Object.values(bundle).some((records) => records.length > 0)) {
          await mapDetailCache.set(task.key, bundle);
          selectedBundle = bundle;
        }
      }
      // Keep prefetched neighboring cells ready in memory so a later pan can
      // draw them immediately without another IndexedDB/network round trip.
      if (selectedBundle) rememberRoadGuideBundle(task.key, selectedBundle);
    } catch (error) {
      console.debug("Road detail background prefetch skipped:", error);
    } finally {
      roadGuidePrefetchBusy = false;
      scheduleNextRoadGuidePrefetch();
    }
  }

  function queueAdjacentRoadGuidePrefetch(bounds: L.LatLngBounds, zoom: number): void {
    if (zoom < 16.75 || !canPrefetchRoadGuides()) return;
    const offsets = progressivePrefetchOffsets(2);
    for (const [horizontal, vertical] of offsets) {
      if (roadGuidePrefetchQueue.length + roadGuidePrefetchCount >= ROAD_GUIDE_PREFETCH_SESSION_LIMIT) break;
      const candidate = shiftedMapBounds(bounds, horizontal, vertical);
      const key = `road:v${ROAD_GUIDE_CACHE_VERSION}:${mapDetailTileKey(candidate, zoom)}`;
      if (roadGuidePrefetchSeen.has(key)) continue;
      roadGuidePrefetchSeen.add(key);
      roadGuidePrefetchQueue.push({ bounds: candidate, key });
    }
    scheduleNextRoadGuidePrefetch();
  }

  function rememberRoadGuideBundle(key: string, bundle: RoadGuideBundle): RoadGuideBundle {
    rememberedRoadGuideBundles.delete(key);
    rememberedRoadGuideBundles.set(key, bundle);
    while (rememberedRoadGuideBundles.size > 36) {
      const oldest = rememberedRoadGuideBundles.keys().next().value as string | undefined;
      if (!oldest) break;
      rememberedRoadGuideBundles.delete(oldest);
    }
    const mergeById = <T extends { id: string }>(selector: (value: RoadGuideBundle) => T[]): T[] => {
      const records = new Map<string, T>();
      rememberedRoadGuideBundles.forEach((value) => selector(value).forEach((record) => records.set(record.id, record)));
      return [...records.values()];
    };
    return {
      roads: mergeById((value) => value.roads),
      rails: mergeById((value) => value.rails),
      transit: mergeById((value) => value.transit),
      crossings: mergeById((value) => value.crossings),
      waterways: mergeById((value) => value.waterways),
      greens: mergeById((value) => value.greens),
      signals: mergeById((value) => value.signals),
      trees: mergeById((value) => value.trees),
      schools: mergeById((value) => value.schools),
      ornaments: mergeById((value) => value.ornaments),
    };
  }

  function makePedestrianStructureIcon(label: string): L.DivIcon {
    return L.divIcon({
      className: "road-guide-structure-icon",
      html: `<span role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16h18M5 16V9m14 7V9M5 11h14M8 11l2-4h4l2 4M10 16v4m4-4v4"/></svg></span>`,
      iconSize: [48, 48],
      iconAnchor: [24, 24],
    });
  }

  function resetRoadGuideMetrics(): void {
    mapRoot.dataset.transitPaths = "0";
    mapRoot.dataset.transitMemberPaths = "0";
    mapRoot.dataset.transitStitchedComponents = "0";
    mapRoot.dataset.transitStitchedJoins = "0";
    mapRoot.dataset.routeEndpoints = "0";
    mapRoot.dataset.sidewalkPaths = "0";
    mapRoot.dataset.ornamentCount = "0";
    mapRoot.dataset.ornamentVisible = "0";
    mapRoot.dataset.ornamentKinds = "";
    mapRoot.dataset.roadPalettes = "";
  }

  async function refreshRoadGuideLayer(force = false): Promise<void> {
    if (!state.roadGuideLayer) state.roadGuideLayer = L.layerGroup().addTo(map);
    if (state.baseMode !== "street" || state.maplibreMap) {
      state.roadGuideLayer.clearLayers();
      visibleRoadGuideBundle = null;
      resetRoadGuideMetrics();
      return;
    }

    const zoom = map.getZoom();
    // The basemap already carries road geometry at normal zoom. The optional
    // Overpass guide is reserved for a close inspection, keeping the initial
    // map equivalent to the clean 2D view requested by the user.
    if (zoom < 16.75) {
      state.roadGuideLayer.clearLayers();
      visibleRoadGuideBundle = null;
      resetRoadGuideMetrics();
      return;
    }

    const bounds = map.getBounds();
    if (!force && lastRoadGuideFetchBounds && lastRoadGuideFetchBounds.contains(bounds.getSouthWest()) && lastRoadGuideFetchBounds.contains(bounds.getNorthEast())) return;
    lastRoadGuideFetchBounds = bounds.pad(0.2);

    const regionKey = `road:v${ROAD_GUIDE_CACHE_VERSION}:${mapDetailTileKey(bounds, zoom)}`;
    const freshGuide = await mapDetailCache.get<RoadGuideBundle>(regionKey, 7 * 24 * 60 * 60 * 1000);
    const storedGuide = freshGuide || await mapDetailCache.peek<RoadGuideBundle>(regionKey);
    let selectedGuide = storedGuide;
    if (!freshGuide) {
      const fetchedGuide = await fetchRoadGuidesForBounds(bounds.pad(0.12));
      const hasFetchedData = Object.values(fetchedGuide).some((records) => records.length > 0);
      if (hasFetchedData) {
        selectedGuide = fetchedGuide;
        void mapDetailCache.set(regionKey, fetchedGuide);
      }
    }
    if (!selectedGuide) return;
    const guide = rememberRoadGuideBundle(regionKey, selectedGuide);
    visibleRoadGuideBundle = guide;
    state.roadGuideLayer.clearLayers();
    mapRoot.dataset.transitPaths = String(guide.transit.length);
    const routeTransit = guide.transit.filter((transit) => transit.source === "route");
    const routeMemberPaths = routeTransit.reduce((total, transit) => total + transit.memberCount, 0);
    const routeEndpointCount = routeTransit.reduce((total, transit) => (
      total
      + Number(transit.componentIndex === 0 && Boolean(transit.verifiedFrom))
      + Number(transit.componentIndex === transit.componentCount - 1 && Boolean(transit.verifiedTo))
    ), 0);
    mapRoot.dataset.transitMemberPaths = String(routeMemberPaths);
    mapRoot.dataset.transitStitchedComponents = String(routeTransit.length);
    mapRoot.dataset.transitStitchedJoins = String(Math.max(0, routeMemberPaths - routeTransit.length));
    mapRoot.dataset.routeEndpoints = String(routeEndpointCount);
    mapRoot.dataset.sidewalkPaths = String(guide.roads.filter((road) => road.hasSidewalk && roadRenderClass(road) !== "foot").length);
    mapRoot.dataset.ornamentCount = String(guide.ornaments.length);
    mapRoot.dataset.ornamentKinds = [...new Set(guide.ornaments.map((ornament) => ornament.kind))].sort().join(",");
    mapRoot.dataset.roadPalettes = [...new Set(guide.roads.map((road) => roadPaletteKey(road)))].sort().join(",");
    const limit = zoom >= 18 ? 120 : zoom >= 16 ? 84 : 52;

    (state.greenVisible ? guide.greens : []).slice(0, zoom >= 17 ? 80 : 44).forEach((green) => {
      if (green.points.length >= 4 && isClosedGuideRing(green.points)) {
        L.polygon(green.points, greenGuideStyle(green)).addTo(state.roadGuideLayer as L.LayerGroup);
      } else {
        L.polyline(green.points, { ...greenGuideStyle(green), fillOpacity: 0, weight: 3.5, opacity: 0.5 }).addTo(state.roadGuideLayer as L.LayerGroup);
      }
    });

    const visibleWaterways = (state.waterVisible ? guide.waterways : []).slice(0, zoom >= 17 ? 70 : 36);
    visibleWaterways.forEach((water) => {
      if (water.points.length >= 4 && isClosedGuideRing(water.points)) {
        L.polygon(water.points, {
          color: "#8bd8ef",
          fillColor: "#c9f0fb",
          fillOpacity: 0.64,
          weight: 1,
          opacity: 0.78,
          interactive: false,
        }).addTo(state.roadGuideLayer as L.LayerGroup);
      } else {
        L.polyline(water.points, waterGuideStyle(water)).addTo(state.roadGuideLayer as L.LayerGroup);
      }
    });

    const selectedWaterLabels = zoom < 16 ? [] : visibleWaterways
      .map((water) => ({ water, mid: roadGuideMidpoint(water.points) }))
      .filter((candidate): candidate is { water: WaterGuideRecord; mid: { latlng: L.LatLng; bearing: number } } => Boolean(candidate.mid && candidate.water.name))
      .sort((a, b) => map.distance(a.mid.latlng, map.getCenter()) - map.distance(b.mid.latlng, map.getCenter()))
      .reduce<Array<{ water: WaterGuideRecord; mid: { latlng: L.LatLng; bearing: number } }>>((selected, candidate) => {
        if (selected.length >= (zoom >= 18 ? 14 : 9) || !map.getBounds().contains(candidate.mid.latlng)) return selected;
        const point = map.latLngToContainerPoint(candidate.mid.latlng);
        const collides = selected.some((placed) => {
          const distance = point.distanceTo(map.latLngToContainerPoint(placed.mid.latlng));
          return distance < 86 || (
            placed.water.name.toLocaleLowerCase("id-ID") === candidate.water.name.toLocaleLowerCase("id-ID")
            && distance < 260
          );
        });
        if (!collides) selected.push(candidate);
        return selected;
      }, []);
    selectedWaterLabels.forEach(({ water, mid }) => {
      const layer = state.roadGuideLayer as L.LayerGroup;
      if (!addCurvedWaterName(layer, water)) {
        L.marker(mid.latlng, {
          pane: ROAD_ORNAMENT_PANE,
          icon: makeWaterNameIcon(water.name, mid.bearing),
          interactive: false,
          zIndexOffset: 110,
        }).addTo(layer);
      }
    });

    const railModesVisible = ["commuter", "high_speed", "train"].some((mode) => state.transitModeFilter.has(mode as TransitGuideMode));
    (railModesVisible ? guide.rails : []).slice(0, zoom >= 17 ? 55 : 30).forEach((rail) => {
      L.polyline(rail.points, railGuideStyle(true)).addTo(state.roadGuideLayer as L.LayerGroup);
      L.polyline(rail.points, railGuideStyle(false)).addTo(state.roadGuideLayer as L.LayerGroup);
      L.polyline(rail.points, railSleeperStyle()).addTo(state.roadGuideLayer as L.LayerGroup);
    });

    const visibleTransit = guide.transit
      .filter((transit) => state.transitModeFilter.has(transit.mode))
      .slice(0, zoom >= 17 ? 80 : 45);
    visibleTransit.forEach((transit) => {
      L.polyline(transit.points, transitGuideCasingStyle(transit)).addTo(state.roadGuideLayer as L.LayerGroup);
      L.polyline(transit.points, transitGuideStyle(transit)).addTo(state.roadGuideLayer as L.LayerGroup);
    });
    const transitSourcePriority: Record<TransitGuideRecord["source"], number> = { route: 0, infrastructure: 1, road_lane: 2 };
    const selectedTransitLabels = zoom < 17 ? [] : visibleTransit
      .filter((transit) => Boolean(transit.label))
      .map((transit) => ({ transit, midpoint: roadGuideMidpoint(transit.points) }))
      .filter((candidate): candidate is { transit: TransitGuideRecord; midpoint: { latlng: L.LatLng; bearing: number } } => Boolean(candidate.midpoint))
      .sort((a, b) => (
        transitSourcePriority[a.transit.source] - transitSourcePriority[b.transit.source]
        || map.distance(a.midpoint.latlng, map.getCenter()) - map.distance(b.midpoint.latlng, map.getCenter())
      ))
      .reduce<Array<{ transit: TransitGuideRecord; midpoint: { latlng: L.LatLng; bearing: number } }>>((selected, candidate) => {
        if (selected.length >= (zoom >= 18 ? 14 : 9) || !map.getBounds().contains(candidate.midpoint.latlng)) return selected;
        const point = map.latLngToContainerPoint(candidate.midpoint.latlng);
        const normalizedLabel = candidate.transit.label.toLocaleLowerCase("id-ID");
        const collides = selected.some((placed) => {
          const distance = point.distanceTo(map.latLngToContainerPoint(placed.midpoint.latlng));
          return distance < 104 || (
            placed.transit.label.toLocaleLowerCase("id-ID") === normalizedLabel
            && distance < 520
          );
        });
        if (!collides) selected.push(candidate);
        return selected;
      }, []);
    selectedTransitLabels.forEach(({ transit, midpoint }) => {
      L.marker(midpoint.latlng, {
        pane: ROAD_ORNAMENT_PANE,
        icon: makeTransitNameIcon(transit),
        interactive: false,
        zIndexOffset: 116,
      }).addTo(state.roadGuideLayer as L.LayerGroup);
    });

    const endpointCandidates = zoom < 18 ? [] : visibleTransit.flatMap((transit) => {
      if (transit.source !== "route" || !transit.points.length) return [];
      const endpoints: Array<{ transit: TransitGuideRecord; role: "from" | "to"; latlng: L.LatLng }> = [];
      if (transit.componentIndex === 0 && transit.verifiedFrom) {
        endpoints.push({ transit, role: "from", latlng: L.latLng(transit.verifiedFrom.point.lat, transit.verifiedFrom.point.lng) });
      }
      if (transit.componentIndex === transit.componentCount - 1 && transit.verifiedTo) {
        endpoints.push({ transit, role: "to", latlng: L.latLng(transit.verifiedTo.point.lat, transit.verifiedTo.point.lng) });
      }
      return endpoints;
    });
    const selectedEndpoints = endpointCandidates
      .filter((endpoint) => bounds.contains(endpoint.latlng))
      .sort((a, b) => map.distance(a.latlng, map.getCenter()) - map.distance(b.latlng, map.getCenter()))
      .reduce<typeof endpointCandidates>((selected, endpoint) => {
        if (selected.length >= 12) return selected;
        const point = map.latLngToContainerPoint(endpoint.latlng);
        const collides = selected.some((placed) => point.distanceTo(map.latLngToContainerPoint(placed.latlng)) < 112);
        if (!collides) selected.push(endpoint);
        return selected;
      }, []);
    selectedEndpoints.forEach((endpoint) => {
      L.marker(endpoint.latlng, {
        pane: ROAD_ORNAMENT_PANE,
        icon: makeTransitEndpointIcon(endpoint.transit, endpoint.role),
        interactive: false,
        zIndexOffset: 126,
      }).addTo(state.roadGuideLayer as L.LayerGroup);
    });

    guide.roads
      .filter((road) => state.roadClassFilter.has(roadRenderClass(road)))
      .sort((a, b) => {
        const ca = roadRenderClass(a);
        const cb = roadRenderClass(b);
        const weight = { major: 0, street: 1, foot: 2, service: 3 };
        return weight[ca] - weight[cb];
      })
      .slice(0, limit)
      .forEach((road) => {
        const cls = roadRenderClass(road);
        if (road.isRoundabout && isClosedGuideRing(road.points)) {
          L.polygon(road.points, roadRoundaboutGreenStyle()).addTo(state.roadGuideLayer as L.LayerGroup);
          const center = guideCentroid(road.points);
          if (center && zoom >= 16) {
            L.marker(center, {
              pane: ROAD_ORNAMENT_PANE,
              icon: makeRoundaboutIcon(road),
              interactive: false,
              zIndexOffset: 107,
            }).addTo(state.roadGuideLayer as L.LayerGroup);
          }
        }
        if (road.hasSidewalk && cls !== "foot") {
          L.polyline(road.points, roadSidewalkStyle(road)).addTo(state.roadGuideLayer as L.LayerGroup);
        }
        if (road.pedestrianStructure) {
          L.polyline(road.points, pedestrianBridgeStyle(true)).addTo(state.roadGuideLayer as L.LayerGroup);
          L.polyline(road.points, pedestrianBridgeStyle(false)).addTo(state.roadGuideLayer as L.LayerGroup);
        } else if (road.highway === "cycleway") {
          L.polyline(road.points, roadCyclewayStyle(road, true)).addTo(state.roadGuideLayer as L.LayerGroup);
          L.polyline(road.points, roadCyclewayStyle(road, false)).addTo(state.roadGuideLayer as L.LayerGroup);
        } else if (cls !== "foot") {
          L.polyline(road.points, roadGuideStyle(road, true)).addTo(state.roadGuideLayer as L.LayerGroup);
          L.polyline(road.points, roadGuideStyle(road, false)).addTo(state.roadGuideLayer as L.LayerGroup);
        } else {
          L.polyline(road.points, roadGuideStyle(road, false)).addTo(state.roadGuideLayer as L.LayerGroup);
        }
        if (road.hasCycleway && road.highway !== "cycleway") {
          L.polyline(road.points, roadCyclewayStyle(road, false)).addTo(state.roadGuideLayer as L.LayerGroup);
        }
        if (road.busLane) {
          L.polyline(road.points, roadBusLaneStyle()).addTo(state.roadGuideLayer as L.LayerGroup);
        }
        if (road.hasMedian) {
          L.polyline(road.points, roadMedianStyle(road)).addTo(state.roadGuideLayer as L.LayerGroup);
        }
        if (road.treeLined && road.roadType !== "foot") {
          L.polyline(road.points, roadAvenueTreeStyle(road)).addTo(state.roadGuideLayer as L.LayerGroup);
        }
        if (road.waterMedian && road.roadType !== "foot") {
          L.polyline(road.points, roadWaterMedianStyle()).addTo(state.roadGuideLayer as L.LayerGroup);
        }
        if (road.roadType === "avenue" || road.roadType === "expressway") {
          L.polyline(road.points, roadLaneDividerStyle(road)).addTo(state.roadGuideLayer as L.LayerGroup);
        }
        // Basemap text already follows road geometry. Keep our guide layer visual-only
        // so artificial AVE/JLN labels and arrows do not drift over buildings.
      });

    if (zoom >= 17) {
      guide.ornaments
        .filter((ornament) => ornament.geometry === "line" && ornament.points.some((point) => bounds.pad(0.08).contains(point)))
        .sort((a, b) => ornamentPriority(a.kind) - ornamentPriority(b.kind))
        .slice(0, zoom >= 18 ? 90 : 48)
        .forEach((ornament) => {
          L.polyline(ornament.points, ornamentLineStyle(ornament)).addTo(state.roadGuideLayer as L.LayerGroup);
        });
    }

    const pointOrnaments = guide.ornaments
      .filter((ornament) => state.cctvVisible || (ornament.kind !== "surveillance" && ornament.kind !== "speed_camera"))
      .filter((ornament) => ornament.geometry === "point" && ornamentMinimumZoom(ornament.kind) <= zoom && Boolean(ornament.points[0]) && bounds.contains(ornament.points[0]))
      .sort((a, b) => (
        ornamentPriority(a.kind) - ornamentPriority(b.kind)
        || map.distance(a.points[0], map.getCenter()) - map.distance(b.points[0], map.getCenter())
      ));
    const ornamentLimit = zoom >= 18 ? 84 : 36;
    const ornamentSeparation = zoom >= 18 ? 20 : 27;
    const selectedOrnaments = pointOrnaments.reduce<MapOrnamentRecord[]>((selected, ornament) => {
      if (selected.length >= ornamentLimit) return selected;
      const point = map.latLngToContainerPoint(ornament.points[0]);
      const collides = selected.some((placed) => point.distanceTo(map.latLngToContainerPoint(placed.points[0])) < ornamentSeparation);
      if (!collides) selected.push(ornament);
      return selected;
    }, []);
    mapRoot.dataset.ornamentVisible = String(selectedOrnaments.length);
    selectedOrnaments.forEach((ornament) => {
      const title = [ornament.name, `${ornament.tagKey}=${ornament.tagValue}`].filter(Boolean).join(" · ");
      const marker = L.marker(ornament.points[0], {
        pane: ROAD_ORNAMENT_PANE,
        icon: makeOrnamentIcon(ornament),
        interactive: true,
        keyboard: true,
        title,
        zIndexOffset: 120,
      }).bindTooltip(escapeHtml(title), { direction: "top", sticky: true, opacity: 0.94 });
      if (ornament.kind === "surveillance" || ornament.kind === "speed_camera") {
        marker.on("click", () => openMapDynamicsPoint({
          type: "Feature",
          id: ornament.id,
          geometry: {
            type: "Point",
            coordinates: [ornament.points[0].lng, ornament.points[0].lat],
          },
          properties: {
            ...ornament.detail,
            kind: ornament.kind === "surveillance" ? "cctv" : "speed_camera",
            name: ornament.name || (ornament.kind === "surveillance" ? "Kamera pengawas" : "Kamera kecepatan"),
            source: "OpenStreetMap",
            sourceUrl: "https://www.openstreetmap.org/",
            streamStatus: "metadata-only",
          },
        }, ornament.points[0]));
      }
      marker.addTo(state.roadGuideLayer as L.LayerGroup);
    });

    const selectedStructureLabels = zoom < 17 ? [] : guide.roads
      .map((road) => ({
        road,
        label: pedestrianStructureLabel(road) || (road.highway === "cycleway" ? cyclewaySemanticLabel(road) : ""),
        midpoint: roadGuideMidpoint(road.points),
      }))
      .filter((candidate): candidate is { road: RoadGuideRecord; label: string; midpoint: { latlng: L.LatLng; bearing: number } } => Boolean(candidate.label && candidate.midpoint))
      .sort((a, b) => map.distance(a.midpoint.latlng, map.getCenter()) - map.distance(b.midpoint.latlng, map.getCenter()))
      .reduce<Array<{ road: RoadGuideRecord; label: string; midpoint: { latlng: L.LatLng; bearing: number } }>>((selected, candidate) => {
        if (selected.length >= (zoom >= 18 ? 10 : 6) || !map.getBounds().contains(candidate.midpoint.latlng)) return selected;
        const point = map.latLngToContainerPoint(candidate.midpoint.latlng);
        const collides = selected.some((placed) => point.distanceTo(map.latLngToContainerPoint(placed.midpoint.latlng)) < 96);
        if (!collides) selected.push(candidate);
        return selected;
      }, []);
    selectedStructureLabels.forEach(({ road, label, midpoint }) => {
      const isPedestrianStructure = Boolean(road.pedestrianStructure);
      const marker = L.marker(midpoint.latlng, {
        pane: ROAD_ORNAMENT_PANE,
        icon: isPedestrianStructure
          ? makePedestrianStructureIcon(label)
          : makeRoadSemanticNameIcon(label, midpoint.bearing),
        interactive: isPedestrianStructure,
        keyboard: isPedestrianStructure,
        title: isPedestrianStructure ? label : undefined,
        zIndexOffset: 114,
      });
      if (isPedestrianStructure) marker.bindTooltip(escapeHtml(label), { direction: "top", opacity: 0.94 });
      marker.addTo(state.roadGuideLayer as L.LayerGroup);
    });

    // Crossing data remains complete in the source bundle/GeoJSON, but the
    // ornament layer is intentionally decluttered. Prefer rail crossings and
    // crossings near the viewport centre, then reject symbols whose screen
    // footprints would overlap. This keeps dense junctions readable without
    // inventing or discarding any underlying OSM detail.
    const crossingLimit = 12;
    const crossingSeparation = 56;
    const mapCentre = map.getCenter();
    const selectedCrossings = [...guide.crossings]
      .sort((a, b) => {
        const typePriority = Number(b.type === "rail") - Number(a.type === "rail");
        return typePriority || map.distance(a.latlng, mapCentre) - map.distance(b.latlng, mapCentre);
      })
      .reduce<CrossingGuideRecord[]>((selected, crossing) => {
        if (selected.length >= crossingLimit || !map.getBounds().contains(crossing.latlng)) return selected;
        const point = map.latLngToContainerPoint(crossing.latlng);
        const collides = selected.some((placed) => (
          point.distanceTo(map.latLngToContainerPoint(placed.latlng)) < crossingSeparation
        ));
        if (!collides) selected.push(crossing);
        return selected;
      }, []);
    selectedCrossings.forEach((crossing) => {
      const title = crossing.name || (crossing.type === "road" ? "Penyeberangan" : "Perlintasan kereta");
      L.marker(crossing.latlng, {
        pane: ROAD_ORNAMENT_PANE,
        icon: makeRailCrossingIcon(crossing),
        interactive: true,
        keyboard: false,
        title,
        zIndexOffset: 118,
      }).bindTooltip(escapeHtml(title), { direction: "top", sticky: true, opacity: 0.94 })
        .addTo(state.roadGuideLayer as L.LayerGroup);
    });

    guide.signals.slice(0, zoom >= 18 ? 64 : 32).forEach((signal) => {
      const title = signal.name || "Lampu lalu lintas";
      L.marker(signal.latlng, {
        pane: ROAD_ORNAMENT_PANE,
        icon: makeTrafficSignalGuideIcon(signal),
        interactive: true,
        keyboard: false,
        title,
        zIndexOffset: 121,
      }).bindTooltip(escapeHtml(title), { direction: "top", sticky: true, opacity: 0.94 })
        .addTo(state.roadGuideLayer as L.LayerGroup);
    });

    if (zoom >= 18) {
      guide.trees.slice(0, 140).forEach((tree) => {
        const title = tree.name || "Pohon terpetakan";
        L.marker(tree.latlng, {
          pane: ROAD_ORNAMENT_PANE,
          icon: makeTreeGuideIcon(tree),
          interactive: true,
          keyboard: false,
          title,
          zIndexOffset: 106,
        }).bindTooltip(escapeHtml(title), { direction: "top", sticky: true, opacity: 0.94 })
          .addTo(state.roadGuideLayer as L.LayerGroup);
      });
    }

    if (zoom >= 17) {
      guide.schools.slice(0, 28).forEach((school) => {
        const title = school.name || (school.kind === "university" ? "Kampus" : "Zona sekolah");
        L.marker(school.latlng, {
          pane: ROAD_ORNAMENT_PANE,
          icon: makeSchoolZoneGuideIcon(school),
          interactive: true,
          keyboard: false,
          title,
          zIndexOffset: 117,
        }).bindTooltip(escapeHtml(title), { direction: "top", sticky: true, opacity: 0.94 })
          .addTo(state.roadGuideLayer as L.LayerGroup);
      });
    }
    queueAdjacentRoadGuidePrefetch(bounds.pad(0.12), zoom);
  }

  let visionSegmenterPromise: Promise<any> | null = null;
  let visionBusy = false;
  let lastVisionKey = "";
  let visionStatusHideTimer = 0;
  let visionFeatureCache: VisionFeatureCacheEntry[] = loadVisionFeatureCache();

  function showVisionStatus(message: string, progress?: number, done = false): void {
    let el = document.getElementById("vision-status") as HTMLDivElement | null;
    if (!el) {
      el = document.createElement("div");
      el.id = "vision-status";
      el.className = "vision-status";
      mapRoot.appendChild(el);
    }
    el.classList.toggle("done", done);
    const pct = typeof progress === "number" ? clamp(progress, 0, 100) : null;
    el.innerHTML = `
  <span class="vision-status-dot"></span>
  <span>${escapeHtml(message)}</span>
  ${pct === null ? "" : `<strong>${Math.round(pct)}%</strong>`}
`;
    window.clearTimeout(visionStatusHideTimer);
    if (done) {
      visionStatusHideTimer = window.setTimeout(() => el?.remove(), 1900);
    }
  }

  function hideVisionStatusSoon(): void {
    const el = document.getElementById("vision-status");
    window.clearTimeout(visionStatusHideTimer);
    visionStatusHideTimer = window.setTimeout(() => el?.remove(), 1200);
  }

  function loadVisionFeatureCache(): VisionFeatureCacheEntry[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(VISION_FEATURE_CACHE_STORAGE_KEY) || "[]") as VisionFeatureCacheEntry[];
      if (!Array.isArray(parsed)) return [];
      const now = Date.now();
      return parsed
        .filter((entry) => entry && typeof entry.key === "string" && Array.isArray(entry.features))
        .filter((entry) => now - Number(entry.createdAt || 0) < VISION_FEATURE_CACHE_MAX_AGE)
        .slice(0, VISION_FEATURE_CACHE_LIMIT);
    } catch {
      return [];
    }
  }

  function saveVisionFeatureCache(): void {
    try {
      localStorage.setItem(VISION_FEATURE_CACHE_STORAGE_KEY, JSON.stringify(visionFeatureCache.slice(0, VISION_FEATURE_CACHE_LIMIT)));
    } catch {
      visionFeatureCache = visionFeatureCache.slice(0, Math.max(12, Math.floor(VISION_FEATURE_CACHE_LIMIT / 2)));
    }
  }

  function cachedVisionFeatures(key: string): VisionFeatureRecord[] | null {
    const hitIndex = visionFeatureCache.findIndex((entry) => entry.key === key);
    if (hitIndex < 0) return null;
    const [entry] = visionFeatureCache.splice(hitIndex, 1);
    visionFeatureCache.unshift(entry);
    return entry.features
      .filter((feature) => isValidCoordinate(feature.lat, feature.lng))
      .map((feature, index) => ({
        id: `vision-cache-${key}-${index}`,
        kind: feature.kind,
        latlng: L.latLng(feature.lat, feature.lng),
        score: feature.score,
        radius: feature.radius,
      }));
  }

  function rememberVisionFeatures(key: string, features: VisionFeatureRecord[]): void {
    const compact = features.slice(0, 360).map((feature) => ({
      kind: feature.kind,
      lat: Number(feature.latlng.lat.toFixed(7)),
      lng: Number(feature.latlng.lng.toFixed(7)),
      score: Number(feature.score.toFixed(3)),
      radius: Number(feature.radius.toFixed(2)),
    }));
    visionFeatureCache = visionFeatureCache.filter((entry) => entry.key !== key);
    visionFeatureCache.unshift({ key, createdAt: Date.now(), features: compact });
    visionFeatureCache = visionFeatureCache.slice(0, VISION_FEATURE_CACHE_LIMIT);
    saveVisionFeatureCache();
  }

  async function loadVisionSegmenter(progress?: (value: number) => void): Promise<any> {
    if (visionSegmenterPromise) return visionSegmenterPromise;
    visionSegmenterPromise = (async () => {
      const mod = await import("@huggingface/transformers");
      const pipeline = (mod as any).pipeline;
      const env = (mod as any).env;
      if (env) {
        env.allowRemoteModels = true;
        env.useBrowserCache = true;
        env.allowLocalModels = false;
      }

      const progressByFile: Record<string, number> = {};
      const progressCallback = (info: any) => {
        if (info?.status === "progress" && info.file) {
          progressByFile[info.file] = Number(info.progress) || 0;
          const values = Object.values(progressByFile);
          const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
          progress?.(avg);
        } else if (info?.status === "ready") {
          progress?.(100);
        }
      };

      const preferred: any = {
        dtype: "q8",
        progress_callback: progressCallback,
      };
      if ((navigator as any).gpu) preferred.device = "webgpu";

      try {
        return await pipeline("image-segmentation", VISION_SEGMENTATION_MODEL, preferred);
      } catch (firstErr) {
        console.warn("Vision WebGPU/q8 load failed, falling back to WASM:", firstErr);
        try {
          return await pipeline("image-segmentation", VISION_SEGMENTATION_MODEL, {
            dtype: "q8",
            progress_callback: progressCallback,
          });
        } catch (secondErr) {
          console.warn("Vision q8 load failed, falling back to default dtype:", secondErr);
          return pipeline("image-segmentation", VISION_SEGMENTATION_MODEL, {
            progress_callback: progressCallback,
          });
        }
      }
    })();
    return visionSegmenterPromise;
  }

  function latLngToGlobalPixel(lat: number, lng: number, zoom: number): { x: number; y: number } {
    const sinLat = Math.sin((lat * Math.PI) / 180);
    const size = 256 * Math.pow(2, zoom);
    return {
      x: ((lng + 180) / 360) * size,
      y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * size,
    };
  }

  function globalPixelToLatLng(x: number, y: number, zoom: number): L.LatLng {
    const size = 256 * Math.pow(2, zoom);
    const lng = (x / size) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * y) / size;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return L.latLng(lat, lng);
  }

  function satelliteVisionTileUrl(z: number, x: number, y: number): string {
    return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  }

  function loadVisionTileImage(url: string): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  async function captureSatelliteVisionCanvas(): Promise<SatelliteVisionCapture> {
    const zoom = clamp(Math.round(map.getZoom()), VISION_MIN_ZOOM, 18);
    const size = isMobile() ? 384 : VISION_CANVAS_SIZE;
    const center = map.getCenter();
    const centerPx = latLngToGlobalPixel(center.lat, center.lng, zoom);
    const origin = {
      x: centerPx.x - size / 2,
      y: centerPx.y - size / 2,
    };
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas 2D tidak tersedia");
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, size, size);

    const maxTile = Math.pow(2, zoom);
    const startX = Math.floor(origin.x / 256);
    const startY = Math.floor(origin.y / 256);
    const endX = Math.floor((origin.x + size) / 256);
    const endY = Math.floor((origin.y + size) / 256);
    const draws: Promise<void>[] = [];
    let loadedTiles = 0;

    for (let tx = startX; tx <= endX; tx += 1) {
      for (let ty = startY; ty <= endY; ty += 1) {
        if (ty < 0 || ty >= maxTile) continue;
        const wrappedX = ((tx % maxTile) + maxTile) % maxTile;
        const dx = Math.round(tx * 256 - origin.x);
        const dy = Math.round(ty * 256 - origin.y);
        draws.push(loadVisionTileImage(satelliteVisionTileUrl(zoom, wrappedX, ty)).then((img) => {
          if (!img) return;
          loadedTiles += 1;
          ctx.drawImage(img, dx, dy, 256, 256);
        }));
      }
    }

    await Promise.all(draws);
    if (!loadedTiles) throw new Error("Tile satelit tidak bisa dibaca untuk computer vision");

    return {
      canvas,
      width: size,
      height: size,
      zoom,
      pixelToLatLng: (x, y) => globalPixelToLatLng(origin.x + x, origin.y + y, zoom),
    };
  }

  function visionKindFromLabel(rawLabel: string): VisionFeatureKind | null {
    const label = rawLabel.toLowerCase();
    if (/\b(water|river|sea|lake|canal|pool|pond|waterfall)\b/.test(label)) return "water";
    if (/\b(sidewalk|pavement|path|walkway|footpath|stairway|stairs)\b/.test(label)) return "sidewalk";
    if (/\b(road|street|runway|highway|route)\b/.test(label)) return "road";
    if (/\b(tree|plant|grass|field|earth|flower|palm|forest|wood|vegetation|land|terrain)\b/.test(label)) return "vegetation";
    if (/\b(building|house|skyscraper|edifice|apartment|booth|tower)\b/.test(label)) return "building";
    return null;
  }

  function visionMaskData(mask: any): VisionMaskData | null {
    if (!mask) return null;
    if (mask instanceof HTMLCanvasElement) {
      const ctx = mask.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      const image = ctx.getImageData(0, 0, mask.width, mask.height);
      return { width: mask.width, height: mask.height, data: image.data, channels: 4 };
    }
    if (typeof ImageData !== "undefined" && mask instanceof ImageData) {
      return { width: mask.width, height: mask.height, data: mask.data, channels: 4 };
    }
    if (mask.canvas instanceof HTMLCanvasElement) return visionMaskData(mask.canvas);
    const width = Number(mask.width || mask.naturalWidth || 0);
    const height = Number(mask.height || mask.naturalHeight || 0);
    const data = mask.data as Uint8ClampedArray | Uint8Array | undefined;
    if (!width || !height || !data) return null;
    const channels = data.length >= width * height * 4 ? 4 : 1;
    return { width, height, data, channels };
  }

  function visionMaskValue(mask: VisionMaskData, x: number, y: number, capture: SatelliteVisionCapture): number {
    const ix = clamp(Math.floor((x / capture.width) * mask.width), 0, mask.width - 1);
    const iy = clamp(Math.floor((y / capture.height) * mask.height), 0, mask.height - 1);
    const offset = (iy * mask.width + ix) * mask.channels;
    if (mask.channels === 1) return Number(mask.data[offset] || 0);
    const alpha = Number(mask.data[offset + 3] || 0);
    if (alpha) return alpha;
    return (Number(mask.data[offset] || 0) + Number(mask.data[offset + 1] || 0) + Number(mask.data[offset + 2] || 0)) / 3;
  }

  function visionSampleStep(kind: VisionFeatureKind): number {
    const zoom = map.getZoom();
    const zoomFactor = zoom >= 18 ? 0.78 : zoom >= 17 ? 0.9 : 1.18;
    const base = kind === "vegetation" ? 26 : kind === "water" ? 22 : kind === "sidewalk" ? 28 : kind === "road" ? 34 : 42;
    return Math.round(base * zoomFactor);
  }

  function visionFeatureLimit(kind: VisionFeatureKind): number {
    const zoom = map.getZoom();
    const zoomFactor = zoom >= 18 ? 1.2 : zoom >= 17 ? 1 : 0.62;
    const base = kind === "vegetation" ? 120 : kind === "water" ? 96 : kind === "sidewalk" ? 86 : kind === "road" ? 64 : 44;
    return Math.round(base * zoomFactor);
  }

  function visionRadius(kind: VisionFeatureKind, score: number): number {
    const zoomScale = map.getZoom() >= 18 ? 1.08 : map.getZoom() >= 17 ? 0.96 : 0.76;
    const base = kind === "vegetation" ? 2.8 : kind === "water" ? 3.2 : kind === "sidewalk" ? 2.2 : kind === "road" ? 2.5 : 2.4;
    return clamp((base + score * 2) * zoomScale, 1.8, 6.2);
  }

  function extractVisionFeatures(result: any, capture: SatelliteVisionCapture): VisionFeatureRecord[] {
    const segments = Array.isArray(result) ? result : Array.isArray(result?.segments) ? result.segments : [];
    const features: VisionFeatureRecord[] = [];
    const countByKind: Record<VisionFeatureKind, number> = {
      road: 0,
      sidewalk: 0,
      vegetation: 0,
      water: 0,
      building: 0,
    };

    segments.forEach((segment: any, segmentIndex: number) => {
      const kind = visionKindFromLabel(String(segment.label || segment.class || ""));
      if (!kind) return;
      const mask = visionMaskData(segment.mask || segment.bitmap || segment.image);
      if (!mask) return;
      const score = clamp(Number(segment.score) || 0.55, 0.2, 1);
      const step = visionSampleStep(kind);
      const limit = visionFeatureLimit(kind);
      const phase = (segmentIndex * 11) % step;

      for (let y = phase; y < capture.height && countByKind[kind] < limit; y += step) {
        for (let x = phase; x < capture.width && countByKind[kind] < limit; x += step) {
          const value = visionMaskValue(mask, x, y, capture);
          if (value < 46) continue;
          if (((Math.round(x) + Math.round(y) + segmentIndex * 17) % (kind === "vegetation" ? 2 : 3)) !== 0) continue;
          const latlng = capture.pixelToLatLng(x, y);
          if (!map.getBounds().pad(0.08).contains(latlng)) continue;
          countByKind[kind] += 1;
          features.push({
            id: `vision-${kind}-${segmentIndex}-${countByKind[kind]}`,
            kind,
            latlng,
            score,
            radius: visionRadius(kind, score),
          });
        }
      }
    });

    return features;
  }

  function renderVisionFeatures(features: VisionFeatureRecord[]): void {
    if (!state.visionLayer) state.visionLayer = L.layerGroup().addTo(map);
    state.visionLayer.clearLayers();

    const styleByKind: Record<VisionFeatureKind, L.CircleMarkerOptions> = {
      vegetation: {
        radius: 3,
        color: "#16a34a",
        fillColor: "#4ade80",
        fillOpacity: 0.72,
        opacity: 0.62,
        weight: 1,
        interactive: false,
      },
      water: {
        radius: 3.4,
        color: "#0284c7",
        fillColor: "#7dd3fc",
        fillOpacity: 0.64,
        opacity: 0.62,
        weight: 1,
        interactive: false,
      },
      sidewalk: {
        radius: 2.5,
        color: "#94a3b8",
        fillColor: "#e2e8f0",
        fillOpacity: 0.76,
        opacity: 0.56,
        weight: 1,
        interactive: false,
      },
      road: {
        radius: 2.6,
        color: "#f59e0b",
        fillColor: "#fde68a",
        fillOpacity: 0.46,
        opacity: 0.44,
        weight: 1,
        interactive: false,
      },
      building: {
        radius: 2.3,
        color: "#c08457",
        fillColor: "#f1d6bb",
        fillOpacity: 0.42,
        opacity: 0.4,
        weight: 1,
        interactive: false,
      },
    };

    features.forEach((feature) => {
      const style = { ...styleByKind[feature.kind], radius: feature.radius };
      L.circleMarker(feature.latlng, style).addTo(state.visionLayer as L.LayerGroup);
    });
  }

  function visionRefreshKey(): string {
    const zoom = clamp(Math.round(map.getZoom()), VISION_MIN_ZOOM, 18);
    const center = map.getCenter();
    const px = latLngToGlobalPixel(center.lat, center.lng, zoom);
    return `${state.baseMode}:${zoom}:${Math.floor(px.x / 192)}:${Math.floor(px.y / 192)}`;
  }

  async function refreshVisionLayer(force = false): Promise<void> {
    if (!state.visionLayer) state.visionLayer = L.layerGroup().addTo(map);
    if (!ENABLE_AUTO_MAP_VISION) {
      state.visionLayer.clearLayers();
      return;
    }
    if (state.baseMode !== "street" || state.maplibreMap || map.getZoom() < VISION_MIN_ZOOM) {
      state.visionLayer.clearLayers();
      return;
    }
    if (visionBusy) return;
    const key = visionRefreshKey();
    if (!force && key === lastVisionKey) return;
    const cached = cachedVisionFeatures(key);
    if (cached && cached.length) {
      lastVisionKey = key;
      renderVisionFeatures(cached);
      showVisionStatus(`Vision 2D dari cache lokal - ${cached.length} petunjuk`, 100, true);
      hideVisionStatusSoon();
      return;
    }
    visionBusy = true;
    lastVisionKey = key;
    showVisionStatus("Memuat AI vision peta 2D...");
    try {
      const segmenter = await loadVisionSegmenter((progress) => {
        showVisionStatus("Mengunduh model vision peta 2D", progress);
      });
      showVisionStatus("Membaca citra satelit viewport...");
      const capture = await captureSatelliteVisionCanvas();
      showVisionStatus("Mendeteksi pohon, air, trotoar, dan bangunan...");
      const result = await segmenter(capture.canvas);
      const features = extractVisionFeatures(result, capture);
      renderVisionFeatures(features);
      rememberVisionFeatures(key, features);
      showVisionStatus(`Vision 2D selesai - ${features.length} petunjuk real`, 100, true);
    } catch (err) {
      console.warn("Vision enhancement failed:", err);
      showVisionStatus("Vision belum tersedia, memakai data peta", undefined, true);
    } finally {
      visionBusy = false;
      hideVisionStatusSoon();
    }
  }

  let lastOverpassFetchBounds: L.LatLngBounds | null = null;
  let overpassLayerRequestSequence = 0;
  let poiRenderFrame = 0;
  let currentPoiDataset: PoiRecord[] = [];
  const rememberedPoiDataset = new Map<string, PoiRecord>();
  const MAX_REMEMBERED_POIS = 6_000;
  const mapLibrePoiImageTasks = new Map<string, Promise<void>>();
  const POI_PREFETCH_SESSION_LIMIT = 16;
  const POI_PREFETCH_DELAY_MS = 2_400;
  const poiPrefetchQueue: Array<{ bounds: L.LatLngBounds; key: string; zoom: number }> = [];
  const poiPrefetchSeen = new Set<string>();
  let poiPrefetchCount = 0;
  let poiPrefetchBusy = false;
  let poiPrefetchTimer = 0;

  function shiftedMapBounds(bounds: L.LatLngBounds, horizontal: number, vertical: number): L.LatLngBounds {
    const latSpan = bounds.getNorth() - bounds.getSouth();
    const lngSpan = bounds.getEast() - bounds.getWest();
    const south = clamp(bounds.getSouth() + vertical * latSpan, -85, 85);
    const north = clamp(bounds.getNorth() + vertical * latSpan, -85, 85);
    const west = clamp(bounds.getWest() + horizontal * lngSpan, -180, 180);
    const east = clamp(bounds.getEast() + horizontal * lngSpan, -180, 180);
    return L.latLngBounds([south, west], [north, east]);
  }

  function progressivePrefetchOffsets(maxRadius: number): Array<readonly [number, number]> {
    const offsets: Array<readonly [number, number]> = [];
    for (let radius = 1; radius <= maxRadius; radius += 1) {
      offsets.push([radius, 0], [-radius, 0], [0, radius], [0, -radius]);
      for (let step = 1; step <= radius; step += 1) {
        offsets.push(
          [radius, step], [radius, -step], [-radius, step], [-radius, -step],
          [step, radius], [-step, radius], [step, -radius], [-step, -radius],
        );
      }
    }
    const unique = new Map<string, readonly [number, number]>();
    offsets.forEach((offset) => unique.set(`${offset[0]}:${offset[1]}`, offset));
    return [...unique.values()];
  }

  function canPrefetchPoi(): boolean {
    const connection = (navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }).connection;
    return OVERPASS_NETWORK_ENABLED
      && navigator.onLine
      && !document.hidden
      && !connection?.saveData
      && connection?.effectiveType !== "2g"
      && !shouldSkipOverpass("poi")
      && poiPrefetchCount < POI_PREFETCH_SESSION_LIMIT;
  }

  function scheduleNextPoiPrefetch(): void {
    window.clearTimeout(poiPrefetchTimer);
    if (!poiPrefetchQueue.length || poiPrefetchBusy || !canPrefetchPoi()) return;
    poiPrefetchTimer = window.setTimeout(() => void runNextPoiPrefetch(), POI_PREFETCH_DELAY_MS);
  }

  async function runNextPoiPrefetch(): Promise<void> {
    if (poiPrefetchBusy || !canPrefetchPoi()) return;
    const task = poiPrefetchQueue.shift();
    if (!task) return;
    poiPrefetchBusy = true;
    poiPrefetchCount += 1;
    try {
      const pois = await fetchOverpassFeaturesForBounds(task.bounds, task.zoom);
      if (pois.length) mergePoiDataset(pois);
    } catch (error) {
      console.debug("POI background prefetch skipped:", error);
    } finally {
      poiPrefetchBusy = false;
      scheduleNextPoiPrefetch();
    }
  }

  function queueAdjacentPoiPrefetch(bounds: L.LatLngBounds, zoom: number): void {
    if (zoom < 14 || !canPrefetchPoi()) return;
    // Grow a bounded two-ring cache around the current area. Requests stay
    // sequential and respect data-saver/network state, while revisited cells
    // are served immediately from IndexedDB.
    const offsets = progressivePrefetchOffsets(2);
    for (const [horizontal, vertical] of offsets) {
      if (poiPrefetchQueue.length + poiPrefetchCount >= POI_PREFETCH_SESSION_LIMIT) break;
      const candidate = shiftedMapBounds(bounds, horizontal, vertical);
      const key = poiCacheKeyForBounds(candidate, zoom);
      if (poiPrefetchSeen.has(key)) continue;
      poiPrefetchSeen.add(key);
      poiPrefetchQueue.push({ bounds: candidate, key, zoom });
    }
    scheduleNextPoiPrefetch();
  }

  function mergePoiDataset(pois: PoiRecord[]): void {
    pois.forEach((poi) => {
      // Refresh insertion order so recently visited areas survive the bounded
      // cache when users explore multiple Indonesian cities.
      rememberedPoiDataset.delete(poi.id);
      rememberedPoiDataset.set(poi.id, poi);
    });
    while (rememberedPoiDataset.size > MAX_REMEMBERED_POIS) {
      const oldest = rememberedPoiDataset.keys().next().value as string | undefined;
      if (!oldest) break;
      rememberedPoiDataset.delete(oldest);
    }
    currentPoiDataset = [...rememberedPoiDataset.values()];
  }

  function mapLibrePoiImageId(iconId: string): string {
    return `poi-${iconId.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}`;
  }

  function ensureMapLibrePoiImage(definition: PoiIconDefinition): Promise<void> {
    const maplibreMap = state.maplibreMap;
    const imageId = mapLibrePoiImageId(definition.id);
    if (!maplibreMap || !maplibreMap.isStyleLoaded?.()) return Promise.resolve();
    if (maplibreMap.hasImage?.(imageId)) return Promise.resolve();
    const existing = mapLibrePoiImageTasks.get(imageId);
    if (existing) return existing;
    const task = (async () => {
      const imageUrl = poiIconAssetUrl(definition, "micro");
      if (!imageUrl) return;
      const response = await fetch(imageUrl);
      if (!response.ok) throw new Error(`POI image ${response.status}`);
      const bitmap = await createImageBitmap(await response.blob());
      if (maplibreMap.isStyleLoaded?.() && !maplibreMap.hasImage?.(imageId)) {
        maplibreMap.addImage(imageId, bitmap, { pixelRatio: 2 });
      }
    })().catch((error) => {
      console.debug(`MapLibre POI image unavailable: ${definition.id}`, error);
    }).finally(() => {
      mapLibrePoiImageTasks.delete(imageId);
    });

    mapLibrePoiImageTasks.set(imageId, task);
    return task;
  }

  // Helper: Update MapLibre POI layer with GeoJSON features
  function updateMapLibrePoiLayer(pois: PoiRecord[]): void {
    const maplibreMap = state.maplibreMap;
    if (!maplibreMap || state.baseMode === "satellite") return;

    try {
      const zoom = map.getZoom();
      const bounds = map.getBounds().pad(0.08);
      const visiblePois = state.poiVisible ? pois
        .filter((poi) => isValidCoordinate(poi.lat, poi.lng))
        .filter((poi) => bounds.contains([poi.lat, poi.lng]))
        .filter((poi) => zoom >= poiDisplayRule(poi).minZoom)
        .sort((left, right) => poiPriority(left) - poiPriority(right)) : [];
      for (const definition of new Map(visiblePois.map((poi) => [poi.iconId, poiDefinition(poi)])).values()) {
        void ensureMapLibrePoiImage(definition);
      }
      const features = visiblePois
        .filter((poi) => isValidCoordinate(poi.lat, poi.lng))
        .filter((poi) => zoom >= poiDisplayRule(poi).minZoom)
        .sort((left, right) => poiPriority(left) - poiPriority(right))
        .slice(0, Math.max(120, poiRenderLimitByZoom(zoom) * 3))
        .map(poi => ({
          type: "Feature",
          properties: {
            id: poi.id,
            title: state.poiLabelVisibility.get(poi.id) === false ? "" : poi.title,
            kind: poi.kind,
            iconId: poi.iconId,
            mapIconId: mapLibrePoiImageId(poi.iconId),
            color: poiDefinition(poi).color,
            priority: poiPriority(poi),
            "icon-emoji": poi.icon,
          },
          geometry: { type: "Point", coordinates: [poi.lng, poi.lat] }
        }));

      const source = maplibreMap.getSource("poi-source");
      if (source && "setData" in source) {
        (source as any).setData({ type: "FeatureCollection", features });
      }
    } catch (err) {
      console.warn("Failed to update POI layer:", err);
    }
  }

  function renderCurrentPoiDataset(): void {
    window.cancelAnimationFrame(poiRenderFrame);
    poiRenderFrame = window.requestAnimationFrame(() => {
      if (!state.overpassLayer) state.overpassLayer = L.layerGroup().addTo(map);

      // Keep every record for search, routing, the AI assistant, and POI
      // modals. Only the visible subset becomes a Leaflet marker.
      state.poiData.clear();
      currentPoiDataset.forEach((poi) => state.poiData.set(poi.id, poi));
      mapRoot.dataset.poiCacheSize = String(currentPoiDataset.length);

      if (!state.poiVisible) {
        updateMapLibrePoiLayer([]);
        for (const marker of state.poiMarkers.values()) {
          state.overpassLayer?.removeLayer(marker);
          if (map.hasLayer(marker)) map.removeLayer(marker);
        }
        state.poiMarkers.clear();
        for (const marker of state.poiClusterMarkers.values()) {
          state.overpassLayer?.removeLayer(marker);
          if (map.hasLayer(marker)) map.removeLayer(marker);
        }
        state.poiClusterMarkers.clear();
        state.poiClusters = [];
        mapRoot.dataset.poiClusters = "0";
        state.poiLabelVisibility.clear();
        updateTabletCategoryView();
        return;
      }

      const visiblePois = rankPoisForView(currentPoiDataset);
      const visibleIds = new Set(visiblePois.map((poi) => poi.id));
      const visibleClusterIds = new Set(state.poiClusters.map((cluster) => cluster.id));
      const useMapLibre = state.baseMode !== "satellite" && Boolean(state.maplibreMap);
      const markerSize = poiMarkerSizeByZoom();

      updateMapLibrePoiLayer(currentPoiDataset);

      visiblePois.forEach((poi) => {
        const showLabel = state.poiLabelVisibility.get(poi.id) !== false;
        const renderKey = `${Math.round(markerSize)}:${showLabel ? 1 : 0}`;
        let marker = state.poiMarkers.get(poi.id);
        if (!marker) {
          marker = L.marker([poi.lat, poi.lng], {
            pane: POI_PANE,
            icon: makePoiIcon(poi, markerSize),
            interactive: true,
            riseOnHover: true,
            zIndexOffset: 900 - poiPriority(poi) * 18,
          });
          (marker.options as L.MarkerOptions & { poiId?: string; poiRenderKey?: string }).poiId = poi.id;
          (marker.options as L.MarkerOptions & { poiId?: string; poiRenderKey?: string }).poiRenderKey = renderKey;
          state.poiMarkers.set(poi.id, marker);
        } else {
          marker.setLatLng([poi.lat, poi.lng]);
          const options = marker.options as L.MarkerOptions & { poiRenderKey?: string };
          if (options.poiRenderKey !== renderKey) {
            marker.setIcon(makePoiIcon(poi, markerSize));
            options.poiRenderKey = renderKey;
          }
          marker.setZIndexOffset(900 - poiPriority(poi) * 18);
        }

        marker.off("click");
        marker.on("click", () => handlePoiClick(poi));
        if (!(state.overpassLayer as L.LayerGroup).hasLayer(marker)) {
          (state.overpassLayer as L.LayerGroup).addLayer(marker);
        }
        const element = marker.getElement() as HTMLElement | null;
        if (element) element.style.display = useMapLibre ? "none" : "";
        setMarkerA11y(marker, `${poi.title}, kategori ${poi.kind}. Buka detail lokasi.`);
      });

      state.poiClusters.forEach((cluster) => {
        const title = poiClusterTitle(cluster);
        let marker = state.poiClusterMarkers.get(cluster.id);
        if (!marker) {
          marker = L.marker([cluster.lat, cluster.lng], {
            pane: POI_PANE,
            icon: makePoiClusterIcon(cluster),
            interactive: true,
            riseOnHover: true,
            zIndexOffset: 940,
            title,
          });
          state.poiClusterMarkers.set(cluster.id, marker);
        } else {
          marker.setLatLng([cluster.lat, cluster.lng]);
          marker.setIcon(makePoiClusterIcon(cluster));
        }
        marker.off("click");
        marker.on("click", () => {
          beginExplicitMapNavigation();
          const clusterBounds = L.latLngBounds(cluster.pois.map((poi) => [poi.lat, poi.lng] as [number, number]));
          if (clusterBounds.getNorthEast().distanceTo(clusterBounds.getSouthWest()) < 1) {
            map.setView([cluster.lat, cluster.lng], Math.min(20, map.getZoom() + 2), { animate: true });
          } else {
            map.fitBounds(clusterBounds, { padding: [48, 48], maxZoom: Math.min(20, map.getZoom() + 3), animate: true });
          }
        });
        marker.bindTooltip(escapeHtml(title), { direction: "top", sticky: true, opacity: 0.94 });
        if (!(state.overpassLayer as L.LayerGroup).hasLayer(marker)) (state.overpassLayer as L.LayerGroup).addLayer(marker);
        const element = marker.getElement() as HTMLElement | null;
        if (element) element.style.display = useMapLibre ? "none" : "";
        setMarkerA11y(marker, `${title}. Perbesar untuk memisahkan ikon.`);
      });
      mapRoot.dataset.poiClusters = String(state.poiClusters.length);

      // Remove only markers that no longer qualify. Reusing the others avoids
      // DOM churn and keeps the map responsive while panning or zooming.
      for (const [id, marker] of state.poiMarkers.entries()) {
        if (visibleIds.has(id)) continue;
        state.overpassLayer?.removeLayer(marker);
        if (map.hasLayer(marker)) map.removeLayer(marker);
        state.poiMarkers.delete(id);
      }
      for (const [id, marker] of state.poiClusterMarkers.entries()) {
        if (visibleClusterIds.has(id)) continue;
        state.overpassLayer?.removeLayer(marker);
        if (map.hasLayer(marker)) map.removeLayer(marker);
        state.poiClusterMarkers.delete(id);
      }

      updateTabletCategoryView();
    });
  }

  async function refreshOverpassLayer(force = false): Promise<void> {
    if (!state.poiVisible) {
      renderCurrentPoiDataset();
      return;
    }
    const bounds = map.getBounds();
    const zoom = map.getZoom();
    // A country-scale bbox is not useful for an interactive POI layer and can
    // overload a public Overpass endpoint. The vector basemap keeps national context;
    // verified custom POIs are requested as visitors zoom into a city.
    if (zoom < 12) {
      renderCurrentPoiDataset();
      return;
    }
    const padding = zoom < 14 ? 0.32 : zoom < 17 ? 0.2 : 0.12;
    const requestBounds = bounds.pad(padding);
    if (!force && lastOverpassFetchBounds && lastOverpassFetchBounds.contains(bounds.getSouthWest()) && lastOverpassFetchBounds.contains(bounds.getNorthEast())) {
      renderCurrentPoiDataset();
      return;
    }
    // Mark the buffered region before the request starts. A temporary offline
    // condition must not trigger a new multi-endpoint Overpass request on every
    // pan event; moving outside this buffer (or an explicit force refresh)
    // still retries it.
    lastOverpassFetchBounds = requestBounds;
    const requestId = ++overpassLayerRequestSequence;
    const pois = await fetchOverpassFeaturesForBounds(requestBounds);
    if (requestId !== overpassLayerRequestSequence) return;

    // Preserve verified records through a transient Overpass/network failure.
    // No fabricated nearby POIs are introduced here.
    if (pois.length) {
      mergePoiDataset(pois);
    }
    renderCurrentPoiDataset();
    queueAdjacentPoiPrefetch(requestBounds, zoom);
  }

  // When user clicks on raster tile, query a small radius for nearby features and open modal
  map.on('click', async (ev: L.LeafletMouseEvent) => {
    if (!state.poiVisible) return;
    const lat = ev.latlng.lat;
    const lng = ev.latlng.lng;

    // Resolve visible MapLibre POIs while Leaflet remains the interaction plane.
    if (state.baseMode !== "satellite" && state.maplibreMap) {
      try {
        const point = state.maplibreMap.project([lng, lat]);
        const features = state.maplibreMap.queryRenderedFeatures(point, {
          layers: ["poi-symbols", "poi-halo"],
        });

        if (features.length > 0) {
          const feature = features[0];
          const poi = state.poiData.get(feature.properties?.id);
          if (poi) {
            handlePoiClick(poi);
            return;
          }
        }
      } catch (err) {
        // ignore MapLibre query errors
      }
    }

    // Fallback: query Overpass for nearby features
    try {
      const q = `
    [out:json][timeout:10];
    (
      node(around:80,${lat},${lng})["amenity"];
      way(around:80,${lat},${lng})["amenity"];
      relation(around:80,${lat},${lng})["amenity"];
      node(around:80,${lat},${lng})["shop"];
      way(around:80,${lat},${lng})["shop"];
      relation(around:80,${lat},${lng})["shop"];
      node(around:80,${lat},${lng})["tourism"];
      way(around:80,${lat},${lng})["tourism"];
      relation(around:80,${lat},${lng})["tourism"];
      node(around:80,${lat},${lng})["public_transport"];
      node(around:80,${lat},${lng})["highway"="bus_stop"];
      node(around:80,${lat},${lng})["railway"="station"];
      way(around:80,${lat},${lng})["leisure"="park"];
      relation(around:80,${lat},${lng})["leisure"="park"];
    );
    out center tags;
  `;
      const data = await fetchOverpassJson(q, "poi");
      const el = (data.elements || [])[0];
      if (!el) return;
      const tags = Object.fromEntries(Object.entries(el.tags || {}).map(([key, value]) => [key, String(value)])) as Record<string, string>;
      const latR = el.type === 'node' ? el.lat : (el.center && el.center.lat) || el.lat;
      const lngR = el.type === 'node' ? el.lon : (el.center && el.center.lon) || el.lon;
      const definition = resolvePoiIcon(tags);
      const poi: PoiRecord = {
        id: `overpass-click-${el.type}-${el.id}`,
        kind: definition.category,
        iconId: definition.id,
        title: poiNameFromTags(tags, `Feature ${el.id}`),
        description: tags.description || tags['note'] || '',
        address: poiAddressFromTags(tags),
        imageUrl: tags.image || poiIconAssetUrl(definition, "hero") || ITS_APP_ICON,
        icon: definition.glyph,
        tags,
        sourceLabel: "OpenStreetMap",
        sourceUrl: `https://www.openstreetmap.org/${encodeURIComponent(String(el.type))}/${encodeURIComponent(String(el.id))}`,
        lat: latR, lng: lngR,
      };
      handlePoiClick(poi);
    } catch (err) {
      // ignore
    }
  });

  map.on('moveend', () => {
    syncMapStateToUrl();
    if (state.maplibreMap && state.baseMode !== "satellite") {
      if (state.roadGuideLayer) state.roadGuideLayer.clearLayers();
      if (state.visionLayer) state.visionLayer.clearLayers();
      void refreshOverpassLayer();
      void refreshMapLibreDetailLayer();
      return;
    }
    void refreshOverpassLayer();
    void refreshRoadGuideLayer();
    void refreshVisionLayer();
  });

  // ─── Helpers ────────────────────────────────────────────────────

  function isDeviceStatus(v: unknown): v is DeviceStatus {
    return v === "online" || v === "offline";
  }
  function isCameraMode(v: unknown): v is CameraMode {
    return v === "webrtc" || v === "mjpeg";
  }
  function isTrafficColor(v: unknown): v is TrafficColor {
    return v === "red" || v === "yellow" || v === "green";
  }
  function clamp(v: number, min: number, max: number) { return Math.min(max, Math.max(min, v)); }
  function finiteNumber(v: unknown): number | undefined {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
    return Number.isFinite(n) ? n : undefined;
  }

  function stringValue(v: unknown): string | undefined {
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  }

  function objectRecord(v: unknown): Record<string, unknown> {
    return v && typeof v === "object" ? v as Record<string, unknown> : {};
  }

  function isValidCoordinate(lat: number, lng: number): boolean {
    return Number.isFinite(lat)
      && Number.isFinite(lng)
      && Math.abs(lat) <= 90
      && Math.abs(lng) <= 180
      && !(Math.abs(lat) < 0.000001 && Math.abs(lng) < 0.000001);
  }

  function loadKnownDevicePositions(): Record<string, { lat: number; lng: number; updatedAt: number }> {
    try {
      const raw = localStorage.getItem(LAST_DEVICE_POSITIONS_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, { lat: number; lng: number; updatedAt: number }>;
      return Object.fromEntries(Object.entries(parsed).filter(([, pos]) => isValidCoordinate(pos.lat, pos.lng)));
    } catch {
      return {};
    }
  }

  function saveKnownDevicePosition(id: string, lat: number, lng: number): void {
    if (!id || !isValidCoordinate(lat, lng)) return;
    state.knownDevicePositions[id] = { lat, lng, updatedAt: Date.now() };
    try {
      localStorage.setItem(LAST_DEVICE_POSITIONS_STORAGE_KEY, JSON.stringify(state.knownDevicePositions));
    } catch {
      /* ignore */
    }
  }

  function saveSnapshotHistoryItems(): void {
    try {
      localStorage.removeItem(SNAPSHOT_HISTORY_STORAGE_KEY);
    } catch {
      state.snapshotHistoryItems = state.snapshotHistoryItems.slice(0, Math.max(8, Math.floor(SNAPSHOT_HISTORY_LIMIT / 2)));
    }
  }

  function snapshotHistoryLocationText(device: DeviceRecord | null): string {
    if (!device) return "Lokasi Raspberry belum tersedia";
    const named = device.roadName || device.roadHint || "";
    if (named && !/mencari satelit|gps aktif|belum tersedia/i.test(named)) return named;
    if (isValidCoordinate(device.position.lat, device.position.lng)) {
      return `${device.position.lat.toFixed(6)}, ${device.position.lng.toFixed(6)}`;
    }
    return "Lokasi Raspberry belum tersedia";
  }

  function snapshotHistoryTimeText(value: number): string {
    if (!value) return "-";
    const date = new Date(value);
    const time = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Jakarta" }).format(date);
    const day = new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Jakarta" }).format(date);
    return `${time} WIB - ${day}`;
  }

  function snapshotHistorySlotPriority(slot: string): number {
    const normalized = slot.trim().toLowerCase();
    if (normalized === "image1" || normalized === "snapshot1") return 0;
    if (normalized === "image2" || normalized === "snapshot2") return 1;
    return 2;
  }

  function compareSnapshotHistoryItems(a: SnapshotHistoryItem, b: SnapshotHistoryItem): number {
    const timeDelta = b.capturedAt - a.capturedAt;
    const isSameCapture = a.deviceId === b.deviceId && Math.abs(timeDelta) < 1_500;
    if (isSameCapture) {
      const slotDelta = snapshotHistorySlotPriority(a.slot) - snapshotHistorySlotPriority(b.slot);
      if (slotDelta !== 0) return slotDelta;
    }
    return timeDelta || snapshotHistorySlotPriority(a.slot) - snapshotHistorySlotPriority(b.slot);
  }

  function nextPendingSnapshotHistoryItem(): SnapshotHistoryItem | undefined {
    return state.snapshotHistoryItems
      .filter((item) => !item.analyzed)
      .sort(compareSnapshotHistoryItems)[0];
  }

  function appendSnapshotHistoryFromRaw(raw: unknown, device: DeviceRecord | null): boolean {
    const record = objectRecord(raw);
    const source = stringValue(record.source);
    if (source && /browser-rfdetr/i.test(source)) return false;
    const keys = ["image1", "image2"].filter((key) => stringValue(record[key]))
      .concat(Object.keys(record).filter((key) => /^image\d+$/i.test(key) && key !== "image1" && key !== "image2" && stringValue(record[key])));
    if (!keys.length) return false;

    let changed = false;
    const deviceId = stringValue(record.deviceId) || device?.id || "raspberry-its";
    const keepAppendMode = Boolean(document.getElementById("m-ai-history-sheet"));
    keys.forEach((key) => {
      const imageUrl = stringValue(record[key]);
      if (!imageUrl || !isUsableSnapshotImageUrl(imageUrl)) return;
      const capturedAt = normalizeEpoch(
        finiteNumber(record[`${key}UpdatedAt`])
        ?? finiteNumber(record[`${key}CapturedAt`])
        ?? finiteNumber(record.updatedAt)
        ?? Date.now(),
      ) || Date.now();
      const imageKey = Math.abs(hashString(`${imageUrl}:${capturedAt}`)).toString(36);
      const id = keepAppendMode ? `${deviceId}:${key}:${capturedAt}:${imageKey}` : `${deviceId}:${key}`;
      const analysis = normalizeCameraAnalysis(record[`${key}Analysis`]);
      const analysisMatchesSnapshot = Boolean(
        analysis
        && analysis.frameWidth > 0
        && analysis.frameHeight > 0
        && analysis.updatedAt >= capturedAt,
      );
      const existing = state.snapshotHistoryItems.find((item) =>
        item.id === id
        || (item.imageUrl === imageUrl && Math.abs(item.capturedAt - capturedAt) < 1000),
      );
      if (existing) return;
      const item: SnapshotHistoryItem = {
        id,
        slot: key,
        imageUrl,
        capturedAt,
        deviceId,
        locationText: snapshotHistoryLocationText(device),
        frameWidth: analysisMatchesSnapshot ? analysis?.frameWidth || 0 : 0,
        frameHeight: analysisMatchesSnapshot ? analysis?.frameHeight || 0 : 0,
        detections: analysisMatchesSnapshot ? analysis?.detections || [] : [],
        analyzed: analysisMatchesSnapshot,
        scanStartedAt: analysisMatchesSnapshot ? analysis?.updatedAt || Date.now() : Date.now(),
        revealedAt: analysisMatchesSnapshot ? Date.now() : 0,
        analysisNote: analysisMatchesSnapshot
          ? `RF-DETR tervalidasi${analysis?.fps ? ` ${analysis.fps.toFixed(1)} FPS` : ""}`
          : "",
      };
      state.snapshotHistoryItems = [item, ...state.snapshotHistoryItems.filter((entry) => {
        if (keepAppendMode) return entry.id !== id;
        if (entry.id === id) return false;
        if (entry.id.startsWith(`${deviceId}:${key}:`)) return false;
        return true;
      })].slice(0, SNAPSHOT_HISTORY_LIMIT);
      changed = true;
    });
    state.snapshotHistoryItems = state.snapshotHistoryItems.sort(compareSnapshotHistoryItems);
    if (changed) {
      saveSnapshotHistoryItems();
      scheduleSnapshotHistoryWarmup();
    }
    return changed;
  }

  function appendDeviceCameraHistory(device: DeviceRecord | null): boolean {
    const dataset = device?.cameraDataset;
    if (!device || !dataset || (!dataset.snapshot1Url && !dataset.snapshot2Url)) return false;
    return appendSnapshotHistoryFromRaw({
      deviceId: device.id,
      source: dataset.source || "device-camera-dataset",
      image1: dataset.snapshot1Url,
      image1UpdatedAt: dataset.snapshot1UpdatedAt || dataset.updatedAt || device.cameraUpdatedAt,
      image1Analysis: dataset.aiDetections?.snapshot1,
      image2: dataset.snapshot2Url,
      image2UpdatedAt: dataset.snapshot2UpdatedAt || dataset.updatedAt || device.cameraUpdatedAt,
      image2Analysis: dataset.aiDetections?.snapshot2,
      updatedAt: dataset.updatedAt || device.cameraUpdatedAt || Date.now(),
    }, device);
  }

  function hasDeviceCameraHistory(device: DeviceRecord | null): boolean {
    const dataset = device?.cameraDataset;
    return Boolean(dataset && (isUsableSnapshotImageUrl(dataset.snapshot1Url || "") || isUsableSnapshotImageUrl(dataset.snapshot2Url || "")));
  }

  function pruneSnapshotHistoryItemsForClosedPanel(): void {
    state.snapshotHistoryItems = [...state.snapshotHistoryItems]
      .sort(compareSnapshotHistoryItems)
      .slice(0, 2);
    saveSnapshotHistoryItems();
  }

  function isUsableSnapshotImageUrl(value: string): boolean {
    const url = value.trim();
    if (!url) return false;
    if (/^data:image\/(?:jpeg|jpg|png|webp);base64,/i.test(url)) return url.length > 1200;
    if (/^blob:/i.test(url)) return true;
    if (/^https?:\/\//i.test(url)) return isLikelyImageUrl(url) || /\/snapshot(?:\?|$)|\/image(?:\?|$)|\/frame(?:\?|$)/i.test(url);
    return false;
  }

  function normalizeCameraDataset(raw: unknown): TrafficCameraDataset | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const record = raw as Record<string, unknown>;
    const dataset: TrafficCameraDataset = {
      snapshot1Url: stringValue(record.snapshot1Url) || stringValue(record.nama1) || stringValue(record.image1),
      snapshot2Url: stringValue(record.snapshot2Url) || stringValue(record.nama2) || stringValue(record.image2),
      snapshot1UpdatedAt: normalizeEpoch(finiteNumber(record.snapshot1UpdatedAt) ?? finiteNumber(record.nama1UpdatedAt) ?? finiteNumber(record.image1UpdatedAt) ?? 0),
      snapshot2UpdatedAt: normalizeEpoch(finiteNumber(record.snapshot2UpdatedAt) ?? finiteNumber(record.nama2UpdatedAt) ?? finiteNumber(record.image2UpdatedAt) ?? 0),
      active: stringValue(record.active),
      updatedAt: normalizeEpoch(finiteNumber(record.updatedAt) ?? 0),
      source: stringValue(record.source),
      path: stringValue(record.path),
      aiDetections: normalizeCameraAnalyses(record.aiDetections),
    };
    return dataset.snapshot1Url || dataset.snapshot2Url || dataset.updatedAt ? dataset : undefined;
  }

  function normalizeCameraAnalysis(raw: unknown): TrafficCameraAnalysis | undefined {
    const record = objectRecord(raw);
    if (!Object.keys(record).length) return undefined;
    const frameWidth = Math.max(0, finiteNumber(record.frameWidth) ?? 0);
    const frameHeight = Math.max(0, finiteNumber(record.frameHeight) ?? 0);
    const detections = normalizeDetections(record.detections);
    const updatedAt = normalizeEpoch(finiteNumber(record.updatedAt) ?? 0);
    if (!updatedAt || !frameWidth || !frameHeight) return undefined;
    return {
      updatedAt,
      objectCount: Math.max(0, Math.round(finiteNumber(record.objectCount) ?? detections.length)),
      vehicleCount: Math.max(0, Math.round(finiteNumber(record.vehicleCount) ?? detections.filter((item) => item.vehicle).length)),
      fps: Math.max(0, finiteNumber(record.fps) ?? 0),
      frameWidth,
      frameHeight,
      modelUrl: stringValue(record.modelUrl),
      detections,
    };
  }

  function normalizeCameraAnalyses(raw: unknown): TrafficCameraDataset["aiDetections"] | undefined {
    const record = objectRecord(raw);
    const snapshot1 = normalizeCameraAnalysis(record.snapshot1);
    const snapshot2 = normalizeCameraAnalysis(record.snapshot2);
    return snapshot1 || snapshot2 ? { snapshot1, snapshot2 } : undefined;
  }

  function mergeCameraDataset(...datasets: Array<TrafficCameraDataset | undefined>): TrafficCameraDataset | undefined {
    const merged: TrafficCameraDataset = {};
    let metadataUpdatedAt = 0;
    datasets.forEach((dataset) => {
      if (!dataset) return;
      const snapshot1UpdatedAt = dataset.snapshot1UpdatedAt || dataset.updatedAt || 0;
      const snapshot2UpdatedAt = dataset.snapshot2UpdatedAt || dataset.updatedAt || 0;
      if (dataset.snapshot1Url && (!merged.snapshot1Url || snapshot1UpdatedAt >= (merged.snapshot1UpdatedAt || 0))) {
        merged.snapshot1Url = dataset.snapshot1Url;
        merged.snapshot1UpdatedAt = snapshot1UpdatedAt;
      }
      if (dataset.snapshot2Url && (!merged.snapshot2Url || snapshot2UpdatedAt >= (merged.snapshot2UpdatedAt || 0))) {
        merged.snapshot2Url = dataset.snapshot2Url;
        merged.snapshot2UpdatedAt = snapshot2UpdatedAt;
      }
      if (!merged.updatedAt || (dataset.updatedAt || 0) > merged.updatedAt) merged.updatedAt = dataset.updatedAt;
      if ((dataset.updatedAt || 0) >= metadataUpdatedAt) {
        metadataUpdatedAt = dataset.updatedAt || 0;
        if (dataset.active) merged.active = dataset.active;
        if (dataset.source) merged.source = dataset.source;
        if (dataset.path) merged.path = dataset.path;
      }
      const snapshot1Analysis = dataset.aiDetections?.snapshot1;
      const snapshot2Analysis = dataset.aiDetections?.snapshot2;
      if (snapshot1Analysis && snapshot1Analysis.updatedAt >= (merged.aiDetections?.snapshot1?.updatedAt || 0)) {
        merged.aiDetections = { ...merged.aiDetections, snapshot1: snapshot1Analysis };
      }
      if (snapshot2Analysis && snapshot2Analysis.updatedAt >= (merged.aiDetections?.snapshot2?.updatedAt || 0)) {
        merged.aiDetections = { ...merged.aiDetections, snapshot2: snapshot2Analysis };
      }
    });
    if (merged.snapshot2Url === merged.snapshot1Url) merged.snapshot2Url = undefined;
    return merged.snapshot1Url || merged.snapshot2Url || merged.updatedAt ? merged : undefined;
  }

  function normalizeSnapshotHistoryDataset(raw: unknown): TrafficCameraDataset | undefined {
    const record = objectRecord(raw);
    const image1 = stringValue(record.image1);
    const image2 = stringValue(record.image2);
    const image1UpdatedAt = normalizeEpoch(finiteNumber(record.image1UpdatedAt) ?? 0);
    const image2UpdatedAt = normalizeEpoch(finiteNumber(record.image2UpdatedAt) ?? 0);
    const updatedAt = normalizeEpoch(
      finiteNumber(record.updatedAt)
      ?? finiteNumber(record.image1UpdatedAt)
      ?? finiteNumber(record.image2UpdatedAt)
      ?? 0,
    );
    return image1 || image2 || updatedAt
      ? {
        snapshot1Url: image1,
        snapshot2Url: image2,
        snapshot1UpdatedAt: image1UpdatedAt,
        snapshot2UpdatedAt: image2UpdatedAt,
        active: stringValue(record.active),
        updatedAt,
        source: stringValue(record.source) || "snapshotHistory",
        path: "snapshotHistory",
      }
      : undefined;
  }

  function normalizeUpdateInfo(rawRecord: Record<string, unknown>): ControllerUpdateInfo | undefined {
    const nested = rawRecord.update && typeof rawRecord.update === "object"
      ? rawRecord.update as Record<string, unknown>
      : {};
    const status = typeof nested.status === "string" ? nested.status
      : typeof rawRecord.updateStatus === "string" ? rawRecord.updateStatus
        : undefined;
    const stage = typeof nested.stage === "string" ? nested.stage
      : typeof rawRecord.updateStage === "string" ? rawRecord.updateStage
        : undefined;
    const message = typeof nested.message === "string" ? nested.message
      : typeof rawRecord.updateMessage === "string" ? rawRecord.updateMessage
        : undefined;
    const updatedAt = finiteNumber(nested.updatedAt) ?? finiteNumber(rawRecord.updateUpdatedAt);
    const source = typeof nested.source === "string" ? nested.source
      : typeof rawRecord.updateSource === "string" ? rawRecord.updateSource
        : undefined;
    const bundleSha = typeof nested.bundleSha === "string" ? nested.bundleSha
      : typeof rawRecord.updateBundleSha === "string" ? rawRecord.updateBundleSha
        : undefined;

    if (!status && !stage && !message && !updatedAt && !bundleSha) return undefined;
    return {
      status: status === "running" || status === "complete" || status === "error" ? status : undefined,
      stage: stage?.trim() || undefined,
      message: message?.trim() || undefined,
      updatedAt,
      source: source?.trim() || undefined,
      bundleSha: bundleSha?.trim() || undefined,
    };
  }
  function normalizeRuntimeTelemetry(rawRecord: Record<string, unknown>): RuntimeTelemetry | undefined {
    const runtime = rawRecord.runtime && typeof rawRecord.runtime === "object"
      ? rawRecord.runtime as Record<string, unknown>
      : {};
    const heartbeatAt = normalizeEpoch(finiteNumber(runtime.heartbeatAt) ?? finiteNumber(rawRecord.heartbeatAt) ?? 0);
    const source = stringValue(runtime.source);
    const controllerState = stringValue(runtime.controllerState);
    const cameraStreamState = stringValue(runtime.cameraStreamState);
    const updateTimerState = stringValue(runtime.updateTimerState);
    const cameraPublicUrl = stringValue(runtime.cameraPublicUrl);
    const cameraNote = stringValue(runtime.cameraNote);
    const localIp = stringValue(runtime.localIp);
    const bootId = stringValue(runtime.bootId);
    const uptimeSec = finiteNumber(runtime.uptimeSec);
    const hasRuntime = Boolean(
      heartbeatAt || source || controllerState || cameraStreamState || updateTimerState
      || cameraPublicUrl || cameraNote || localIp || bootId || uptimeSec,
    );
    if (!hasRuntime) return undefined;
    return {
      source: source || undefined,
      heartbeatAt,
      localIp: localIp || undefined,
      bootId: bootId || undefined,
      uptimeSec,
      controllerState: controllerState || undefined,
      cameraStreamState: cameraStreamState || undefined,
      updateTimerState: updateTimerState || undefined,
      cameraLocalOk: typeof runtime.cameraLocalOk === "boolean" ? runtime.cameraLocalOk : undefined,
      cameraPublicOk: typeof runtime.cameraPublicOk === "boolean" ? runtime.cameraPublicOk : undefined,
      cameraPublicUrl: cameraPublicUrl || undefined,
      cameraNote: cameraNote || undefined,
    };
  }
  function normalizeVehicleBreakdown(v: unknown): VehicleBreakdown | undefined {
    if (!v || typeof v !== "object") return undefined;
    const raw = v as Record<string, unknown>;
    const car = Math.max(0, Math.round(finiteNumber(raw.car) ?? 0));
    const motorcycle = Math.max(0, Math.round(finiteNumber(raw.motorcycle) ?? 0));
    const bus = Math.max(0, Math.round(finiteNumber(raw.bus) ?? 0));
    const truck = Math.max(0, Math.round(finiteNumber(raw.truck) ?? 0));
    const bicycle = Math.max(0, Math.round(finiteNumber(raw.bicycle) ?? 0));
    const total = Math.max(car + motorcycle + bus + truck + bicycle, Math.round(finiteNumber(raw.total) ?? 0));
    return { car, motorcycle, bus, truck, bicycle, total };
  }
  const VEHICLE_LABELS = new Set(["car", "motorcycle", "bus", "truck", "bicycle"]);
  const DISPLAY_DETECTION_LABELS = new Set<string>();
  const DETECTION_LABEL_ALIASES: Record<string, string> = {
    human: "person",
    pedestrian: "person",
    orang: "person",
    manusia: "person",
    bike: "bicycle",
    cycle: "bicycle",
    sepeda: "bicycle",
    auto: "car",
    automobile: "car",
    vehicle: "car",
    mobil: "car",
    motorbike: "motorcycle",
    motor: "motorcycle",
    "sepeda motor": "motorcycle",
    truk: "truck",
    bis: "bus",
    lampu: "traffic light",
    "lampu lalu lintas": "traffic light",
    tanaman: "potted plant",
    tumbuhan: "potted plant",
    pohon: "tree",
    rumput: "grass",
    pembatas: "barrier",
    palang: "barrier",
    "palang parkir": "parking gate",
    wastafel: "sink",
  };
  const DETECTION_LABELS_ID: Record<string, string> = {
    person: "Orang",
    bicycle: "Sepeda",
    car: "Mobil",
    motorcycle: "Motor",
    airplane: "Pesawat",
    bus: "Bus",
    train: "Kereta",
    truck: "Truk",
    boat: "Perahu",
    "traffic light": "Lampu Lalu Lintas",
    "fire hydrant": "Hidran",
    "stop sign": "Rambu Stop",
    "parking meter": "Meter Parkir",
    bench: "Bangku",
    bird: "Burung",
    cat: "Kucing",
    dog: "Anjing",
    horse: "Kuda",
    sheep: "Domba",
    cow: "Sapi",
    elephant: "Gajah",
    bear: "Beruang",
    zebra: "Zebra",
    giraffe: "Jerapah",
    backpack: "Ransel",
    umbrella: "Payung",
    handbag: "Tas",
    tie: "Dasi",
    suitcase: "Koper",
    frisbee: "Frisbee",
    skis: "Ski",
    snowboard: "Snowboard",
    "sports ball": "Bola",
    kite: "Layang-layang",
    "baseball bat": "Tongkat Baseball",
    "baseball glove": "Sarung Tangan Baseball",
    skateboard: "Skateboard",
    surfboard: "Papan Selancar",
    "tennis racket": "Raket Tenis",
    bottle: "Botol",
    "wine glass": "Gelas",
    cup: "Cangkir",
    fork: "Garpu",
    knife: "Pisau",
    spoon: "Sendok",
    bowl: "Mangkuk",
    banana: "Pisang",
    apple: "Apel",
    sandwich: "Roti Lapis",
    orange: "Jeruk",
    broccoli: "Brokoli",
    carrot: "Wortel",
    "hot dog": "Hot Dog",
    pizza: "Pizza",
    donut: "Donat",
    cake: "Kue",
    chair: "Kursi",
    couch: "Sofa",
    "potted plant": "Tanaman",
    plant: "Tanaman",
    tree: "Pohon",
    grass: "Rumput",
    barrier: "Pembatas Jalan",
    "parking gate": "Palang Parkir",
    road: "Jalan",
    sidewalk: "Trotoar",
    bed: "Tempat Tidur",
    "dining table": "Meja Makan",
    toilet: "Toilet",
    tv: "TV",
    laptop: "Laptop",
    mouse: "Mouse",
    remote: "Remote",
    keyboard: "Keyboard",
    "cell phone": "Ponsel",
    object: "Benda",
    "unknown object": "Benda",
    "toy vehicle": "Miniatur Kendaraan",
    floor: "Lantai",
    microwave: "Microwave",
    oven: "Oven",
    toaster: "Pemanggang",
    sink: "Wastafel",
    refrigerator: "Kulkas",
    book: "Buku",
    clock: "Jam",
    vase: "Vas",
    scissors: "Gunting",
    "teddy bear": "Boneka",
    "hair drier": "Pengering Rambut",
    toothbrush: "Sikat Gigi",
  };
  function canonicalDetectionLabel(label: string): string {
    const key = label.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    return DETECTION_LABEL_ALIASES[key] || key;
  }
  function detectionLabel(label: string): string {
    const key = canonicalDetectionLabel(label);
    return DETECTION_LABELS_ID[key] || label;
  }
  function shouldDisplayDetectionLabel(label: string): boolean {
    const key = canonicalDetectionLabel(label);
    return Boolean(key) && (!DISPLAY_DETECTION_LABELS.size || DISPLAY_DETECTION_LABELS.has(key));
  }
  function normalizeDetections(v: unknown): RfDetrDetection[] {
    if (!Array.isArray(v)) return [];
    return v.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const raw = item as Record<string, unknown>;
      const label = typeof raw.label === "string" ? raw.label.trim() : "";
      const confidence = normalizeDetectionConfidence(finiteNumber(raw.confidence) ?? 0);
      const x = Math.max(0, finiteNumber(raw.x) ?? 0);
      const y = Math.max(0, finiteNumber(raw.y) ?? 0);
      const width = Math.max(0, finiteNumber(raw.width) ?? 0);
      const height = Math.max(0, finiteNumber(raw.height) ?? 0);
      if (!label || confidence <= 0 || width <= 0 || height <= 0) return [];
      const key = canonicalDetectionLabel(label);
      if (!shouldDisplayDetectionLabel(key)) return [];
      const vehicle = typeof raw.vehicle === "boolean" ? raw.vehicle : VEHICLE_LABELS.has(key);
      return [{ label: key, confidence, vehicle, x, y, width, height }];
    }).sort((a, b) => b.confidence - a.confidence).slice(0, 80);
  }
  function normalizeDetectionConfidence(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (value <= 1) return value;
    if (value <= 100) return clamp(value / 100, 0, 1);
    return 1;
  }
  function detectionBoxIsUsable(d: RfDetrDetection, frameWidth: number, frameHeight: number): boolean {
    if (![d.x, d.y, d.width, d.height, frameWidth, frameHeight].every(Number.isFinite)) return false;
    if (frameWidth <= 0 || frameHeight <= 0 || d.width < 3 || d.height < 3) return false;
    if (d.x >= frameWidth || d.y >= frameHeight || d.x + d.width <= 0 || d.y + d.height <= 0) return false;
    const widthRatio = d.width / frameWidth;
    const heightRatio = d.height / frameHeight;
    const aspect = d.width / Math.max(1, d.height);
    if (widthRatio > 1.05 || heightRatio > 1.05) return false;
    if (aspect > 18 || aspect < 0.05) return false;
    const areaRatio = (d.width * d.height) / Math.max(1, frameWidth * frameHeight);
    if (areaRatio > 0.94) return false;
    const key = canonicalDetectionLabel(d.label);
    if (VEHICLE_LABELS.has(key) && areaRatio > 0.42 && d.confidence < 0.4) return false;
    if ((key === "parking meter" || key === "tie" || key === "sink" || key === "spoon" || key === "fork" || key === "knife") && d.confidence < 0.78) return false;
    return true;
  }

  function historyDetectionConfidenceCutoff(d: RfDetrDetection, frameWidth: number, frameHeight: number): number {
    const key = canonicalDetectionLabel(d.label);
    const areaRatio = (d.width * d.height) / Math.max(1, frameWidth * frameHeight);
    if (VEHICLE_LABELS.has(key)) return areaRatio < 0.018 ? 0.18 : 0.2;
    if (key === "person") return areaRatio < 0.018 ? 0.26 : 0.23;
    if (key === "traffic light" || key === "stop sign") return 0.24;
    if (key === "parking meter") return 0.92;
    if (key === "tie" || key === "sink") return 0.78;
    if (key === "spoon" || key === "fork" || key === "knife") return 0.72;
    return areaRatio < 0.015 ? 0.34 : 0.28;
  }

  function detectionIou(a: RfDetrDetection, b: RfDetrDetection): number {
    const ax2 = a.x + a.width;
    const ay2 = a.y + a.height;
    const bx2 = b.x + b.width;
    const by2 = b.y + b.height;
    const interW = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
    const interH = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
    const inter = interW * interH;
    const union = a.width * a.height + b.width * b.height - inter;
    return union <= 0 ? 0 : inter / union;
  }

  function detectionIntersectionOverMinArea(a: RfDetrDetection, b: RfDetrDetection): number {
    const ax2 = a.x + a.width;
    const ay2 = a.y + a.height;
    const bx2 = b.x + b.width;
    const by2 = b.y + b.height;
    const interW = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
    const interH = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
    const minArea = Math.min(a.width * a.height, b.width * b.height);
    return minArea <= 0 ? 0 : (interW * interH) / minArea;
  }

  function historyConfirmedDetections(item: SnapshotHistoryItem): RfDetrDetection[] {
    if (!item.frameWidth || !item.frameHeight) return [];
    const sorted = item.detections
      .filter((d) => shouldDisplayDetectionLabel(d.label))
      .filter((d) => detectionBoxIsUsable(d, item.frameWidth, item.frameHeight))
      .filter((d) => d.confidence >= historyDetectionConfidenceCutoff(d, item.frameWidth, item.frameHeight))
      .sort((a, b) => b.confidence - a.confidence);
    const confirmed: RfDetrDetection[] = [];
    sorted.forEach((det) => {
      const duplicate = confirmed.some((other) => {
        const sameLabel = canonicalDetectionLabel(other.label) === canonicalDetectionLabel(det.label);
        const overlap = detectionIou(det, other);
        const nested = detectionIntersectionOverMinArea(det, other);
        return (sameLabel && (overlap > 0.42 || nested > 0.82)) || (nested > 0.9 && det.confidence <= other.confidence * 1.16);
      });
      if (!duplicate) confirmed.push(det);
    });
    return confirmed.slice(0, 24);
  }

  function easeOutHistory(value: number): number {
    const t = clamp(value, 0, 1);
    return 1 - Math.pow(1 - t, 3);
  }

  function visibleHistoryDetections(item: SnapshotHistoryItem, now = Date.now()): RfDetrDetection[] {
    const detections = historyConfirmedDetections(item);
    if (!item.analyzed || !detections.length) return [];
    const revealedAt = item.revealedAt || now;
    if (now < revealedAt) return [];
    const progress = easeOutHistory((now - revealedAt) / HISTORY_REVEAL_DURATION_MS);
    const count = clamp(Math.ceil(detections.length * progress), 1, detections.length);
    return detections.slice(0, count);
  }

  function historyRevealStillAnimating(item: SnapshotHistoryItem, now = Date.now()): boolean {
    return Boolean(item.analyzed && item.revealedAt && now - item.revealedAt < HISTORY_REVEAL_DURATION_MS + 700);
  }

  function historyDetectionSummary(detections: RfDetrDetection[]): Array<{ label: string; count: number; maxConfidence: number; avgConfidence: number }> {
    const groups = new Map<string, { label: string; count: number; maxConfidence: number; totalConfidence: number }>();
    detections.forEach((det) => {
      const key = canonicalDetectionLabel(det.label);
      const label = detectionLabel(key);
      const current = groups.get(key) || { label, count: 0, maxConfidence: 0, totalConfidence: 0 };
      current.count += 1;
      current.maxConfidence = Math.max(current.maxConfidence, det.confidence);
      current.totalConfidence += det.confidence;
      groups.set(key, current);
    });
    return Array.from(groups.values())
      .map((group) => ({
        label: group.label,
        count: group.count,
        maxConfidence: group.maxConfidence,
        avgConfidence: group.totalConfidence / Math.max(1, group.count),
      }))
      .sort((a, b) => b.count - a.count || b.maxConfidence - a.maxConfidence);
  }
  function normalizeEpoch(v: number): number {
    if (!Number.isFinite(v) || v <= 0) return 0;
    return v < 1e11 ? v * 1000 : v;
  }
  function isFreshEpoch(v: number, maxAgeMs = CAMERA_STATUS_FRESH_MS): boolean {
    const ts = normalizeEpoch(v);
    return ts > 0 && Date.now() - ts <= maxAgeMs;
  }
  function deviceHeartbeatIsFresh(device: DeviceRecord | null): boolean {
    if (!device) return false;
    if (device.runtime?.heartbeatAt && isFreshEpoch(device.runtime.heartbeatAt, HARDWARE_HEARTBEAT_STALE_MS)) return true;
    if (device.cameraUpdatedAt && isFreshEpoch(device.cameraUpdatedAt, HARDWARE_HEARTBEAT_STALE_MS)) return true;
    return Boolean(device.lastSeen && isFreshEpoch(device.lastSeen, OFFLINE_AFTER_MS));
  }
  function cameraTelemetryIsFresh(device: DeviceRecord | null): boolean {
    if (!device) return false;
    const runtimeCameraFresh = Boolean(
      device.runtime?.heartbeatAt
      && isFreshEpoch(device.runtime.heartbeatAt, HARDWARE_HEARTBEAT_STALE_MS)
      && (device.runtime.cameraPublicOk || device.runtime.cameraLocalOk),
    );
    if (runtimeCameraFresh) return true;
    return [device.cameraUpdatedAt]
      .some((value) => isFreshEpoch(value || 0, CAMERA_STATUS_FRESH_MS));
  }
  function snapshotIsFresh(device: DeviceRecord | null, updatedAt?: number): boolean {
    if (!device) return false;
    if (!updatedAt) return deviceHeartbeatIsFresh(device);
    return isFreshEpoch(updatedAt, CAMERA_SNAPSHOT_FRESH_MS);
  }
  function cacheBustMediaUrl(url: string, updatedAt?: number): string {
    if (!url || /^data:/i.test(url) || /^blob:/i.test(url) || !updatedAt) return url;
    try {
      const parsed = new URL(url, window.location.href);
      parsed.searchParams.set("its_t", String(Math.round(normalizeEpoch(updatedAt) || updatedAt)));
      return parsed.toString();
    } catch {
      return url;
    }
  }
  function formatTime(v: number): string {
    if (v <= 0) return "-";
    return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" })
      .format(new Date(v));
  }
  function formatAge(v: number): string {
    if (v <= 0) return "-";
    const ms = Math.max(0, Date.now() - v);
    if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
    return `${Math.round(ms / 86_400_000)}d ago`;
  }
  function escapeHtml(v: string): string {
    return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  // Helpers: bearing and distance/ETA formatting
  function toRad(deg: number) { return deg * Math.PI / 180; }
  function toDeg(rad: number) { return rad * 180 / Math.PI; }
  function computeBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function haversineDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function formatDistance(meters: number): string {
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1000).toFixed(1)} km`;
  }

  function formatEtaSeconds(sec: number): string {
    if (!Number.isFinite(sec) || sec <= 0) return "-";
    if (sec < 60) return `${Math.round(sec)}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    return `${Math.round(sec / 3600)}h`;
  }

  function hashString(input: string): number {
    let hash = 0;
    for (let i = 0; i < input.length; i += 1) {
      hash = ((hash << 5) - hash) + input.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function trafficColorLabel(color: TrafficColor): string {
    if (color === "red") return "🔴 Tunggu sebentar";
    if (color === "yellow") return "🟡 Bersiaplah";
    return "🟢 Lewati sekarang";
  }

  function trafficColorFor(device: DeviceRecord): TrafficColor {
    if (device.trafficColor) return device.trafficColor;
    const seed = hashString(`${device.id}:${Math.floor(Date.now() / 4000)}`);
    const colors: TrafficColor[] = ["red", "yellow", "green"];
    return colors[seed % colors.length];
  }

  function trafficDurationFor(color: TrafficColor, device: DeviceRecord): number {
    if (typeof device.trafficDuration === "number" && Number.isFinite(device.trafficDuration)) {
      return Math.max(1, Math.round(device.trafficDuration));
    }
    const seed = hashString(`${device.id}:${Math.floor(Date.now() / 4000)}:${color}`);
    if (color === "red") return 8 + (seed % 18);
    if (color === "yellow") return 3 + (seed % 4);
    return 10 + (seed % 20);
  }

  function vehicleCountFor(device: DeviceRecord): number {
    if (typeof device.vehicleCount === "number" && Number.isFinite(device.vehicleCount)) {
      return Math.max(0, Math.round(device.vehicleCount));
    }
    if (typeof device.vehicleBreakdown?.total === "number" && Number.isFinite(device.vehicleBreakdown.total)) {
      return Math.max(0, Math.round(device.vehicleBreakdown.total));
    }
    return 0;
  }

  function buildTrafficState(device: DeviceRecord): TrafficState {
    const color = trafficColorFor(device);
    const roadName = state.roadNameById.get(device.id) || device.roadName || device.roadHint || "Jalan tidak terdeteksi";
    const vehicleCount = vehicleCountFor(device);
    const duration = trafficDurationFor(color, device);
    return {
      color,
      duration,
      phaseStartedAt: device.trafficStartedAt || 0,
      vehicleCount,
      roadName,
      recommendation: trafficColorLabel(color),
      updatedAt: Date.now(),
    };
  }

  function vehicleBreakdownText(breakdown?: VehicleBreakdown): string {
    if (!breakdown) return "-";
    const parts = [
      ["Mobil", breakdown.car],
      ["Motor", breakdown.motorcycle],
      ["Bus", breakdown.bus],
      ["Truk", breakdown.truck],
      ["Sepeda", breakdown.bicycle],
    ].filter(([, value]) => Number(value) > 0);
    return parts.length ? parts.map(([label, value]) => `${label} ${value}`).join(" / ") : "0 kendaraan";
  }

  function vehicleStatsForDevice(device?: DeviceRecord | null, traffic?: TrafficState | null): VehicleBreakdown {
    const source = device?.vehicleBreakdown;
    const total = Math.max(0, Math.round(
      source?.total
      ?? device?.vehicleCount
      ?? traffic?.vehicleCount
      ?? 0,
    ));
    return {
      car: Math.max(0, Math.round(source?.car ?? 0)),
      motorcycle: Math.max(0, Math.round(source?.motorcycle ?? 0)),
      bicycle: Math.max(0, Math.round(source?.bicycle ?? 0)),
      bus: Math.max(0, Math.round(source?.bus ?? 0)),
      truck: Math.max(0, Math.round(source?.truck ?? 0)),
      total,
    };
  }

  function renderVehicleStatsGrid(device?: DeviceRecord | null, traffic?: TrafficState | null, className = "m-vehicle-stats-grid"): string {
    const stats = vehicleStatsForDevice(device, traffic);
    const items = [
      ["Mobil", stats.car],
      ["Motor", stats.motorcycle],
      ["Sepeda", stats.bicycle],
      ["Bus", stats.bus],
      ["Truk", stats.truck],
      ["Total", stats.total],
    ];
    return `<div class="${className}">
  ${items.map(([label, value]) => `
    <div>
      <span>${escapeHtml(String(label))}</span>
      <strong>${Number(value)}</strong>
    </div>
  `).join("")}
</div>`;
  }

  function renderDetectionOverlay(device: DeviceRecord | null): string {
    const frameWidth = device?.detectorFrameWidth || 0;
    const frameHeight = device?.detectorFrameHeight || 0;
    const detections = (device?.detections || [])
      .filter((d) => shouldDisplayDetectionLabel(d.label))
      .filter((d) => detectionBoxIsUsable(d, frameWidth, frameHeight));
    if (!detections.length || frameWidth <= 0 || frameHeight <= 0) return "";
    return `<div class="m-detection-overlay" aria-hidden="true">
  ${detections.slice(0, 12).map((d) => {
      const left = clamp((d.x / frameWidth) * 100, 0, 100);
      const top = clamp((d.y / frameHeight) * 100, 0, 100);
      const width = clamp((d.width / frameWidth) * 100, 1, 100 - left);
      const height = clamp((d.height / frameHeight) * 100, 1, 100 - top);
      const label = `${detectionLabel(d.label)} ${(d.confidence * 100).toFixed(0)}%`;
      return `<span class="m-detection-box${d.vehicle ? " is-vehicle" : ""}${top < 8 ? " is-top-edge" : ""}" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%">
      <span class="m-detection-label">${escapeHtml(label)}</span>
    </span>`;
    }).join("")}
</div>`;
  }

  async function resolveRoadName(device: DeviceRecord): Promise<string> {
    const cached = state.roadNameById.get(device.id);
    if (cached) return cached;

    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${device.position.lat}&lon=${device.position.lng}`;
    try {
      const res = await fetch(url, {
        cache: "no-store",
        headers: { "Accept": "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { address?: Record<string, string>; display_name?: string };
      const address = data.address || {};
      const road = address.road || address.pedestrian || address.footway || address.path || address.cycleway || address.service || address.residential;
      const fallback = data.display_name?.split(",")[0]?.trim();
      const resolved = road || fallback || device.roadName || device.label;
      state.roadNameById.set(device.id, resolved);
      return resolved;
    } catch {
      const fallback = device.roadName || device.roadHint || device.label;
      state.roadNameById.set(device.id, fallback);
      return fallback;
    }
  }

  function markerSizeByZoom(): number {
    const zoom = map.getZoom();
    return clamp(24 + (zoom - 13) * 2.4, 22, 54);
  }

  function markerAnchorBySize(size: number): [number, number] {
    return [Math.round(size / 2), Math.round(size * 1.5)];
  }

  // FIX: normalizeOneDevice — parser untuk satu raw device object langsung,
  // tidak membungkus ulang dalam Snapshot sehingga tidak ada double-wrapping.
  function normalizeOneDevice(raw: SnapshotDevice): DeviceRecord | null {
    const rawRecord = raw as Record<string, unknown>;
    const locationRecord = objectRecord(rawRecord.location);
    const positionRecord = objectRecord(rawRecord.position);
    const cameraRecord = objectRecord(rawRecord.camera);
    const trafficRecord = objectRecord(rawRecord.traffic);
    const objectDetectionRecord = objectRecord(rawRecord.objectDetection);
    const rawId = typeof rawRecord.id === "string" ? rawRecord.id.trim() : "";
    const id = raw.id?.trim() || rawId || "raspberry-its";
    let lat = finiteNumber(locationRecord.lat)
      ?? finiteNumber(locationRecord.y)
      ?? finiteNumber(positionRecord.lat)
      ?? finiteNumber(positionRecord.y)
      ?? null;
    let lng = finiteNumber(locationRecord.lng)
      ?? finiteNumber(locationRecord.long)
      ?? finiteNumber(locationRecord.lon)
      ?? finiteNumber(locationRecord.x)
      ?? finiteNumber(positionRecord.lng)
      ?? finiteNumber(positionRecord.x)
      ?? null;
    if (lat === null || lng === null) return null;
    if (!isValidCoordinate(lat, lng)) {
      const known = state.knownDevicePositions[id];
      lat = known?.lat ?? (DEFAULT_CENTER as [number, number])[0];
      lng = known?.lng ?? (DEFAULT_CENTER as [number, number])[1];
    } else {
      saveKnownDevicePosition(id, lat, lng);
    }
    const safeLat = lat ?? (DEFAULT_CENTER as [number, number])[0];
    const safeLng = lng ?? (DEFAULT_CENTER as [number, number])[1];
    const rawCameraMode = stringValue(cameraRecord.mode) || rawRecord.cameraMode;
    const nestedCameraUpdatedAt = normalizeEpoch(finiteNumber(cameraRecord.updatedAt) ?? 0);
    const flatCameraUpdatedAt = normalizeEpoch(
      finiteNumber(rawRecord.cameraUpdatedAt)
      ?? finiteNumber(rawRecord.detectorUpdatedAt)
      ?? finiteNumber(rawRecord.updatedAt)
      ?? 0,
    );
    const flatCameraIsNewer = flatCameraUpdatedAt > 0
      && (nestedCameraUpdatedAt <= 0 || flatCameraUpdatedAt > nestedCameraUpdatedAt + 5_000 || !isFreshEpoch(nestedCameraUpdatedAt));
    const nestedCameraUrl = stringValue(cameraRecord.tunnelUrl)
      || stringValue(cameraRecord.pageUrl)
      || stringValue(cameraRecord.url)
      || undefined;
    const flatCameraUrl = raw.cameraUrl?.trim() || undefined;
    const cameraUrl = flatCameraIsNewer
      ? flatCameraUrl || nestedCameraUrl
      : nestedCameraUrl || flatCameraUrl;
    const nestedCameraHlsUrl = stringValue(cameraRecord.hlsUrl);
    const flatCameraHlsUrl = typeof rawRecord.cameraHlsUrl === "string" ? rawRecord.cameraHlsUrl.trim() || undefined : undefined;
    const cameraHlsUrl = flatCameraIsNewer
      ? flatCameraHlsUrl || nestedCameraHlsUrl
      : nestedCameraHlsUrl || flatCameraHlsUrl;
    const nestedWebRtcUrl = stringValue(cameraRecord.webrtcUrl);
    const flatWebRtcUrl = typeof rawRecord.webrtcUrl === "string" ? rawRecord.webrtcUrl.trim() || undefined : undefined;
    const webrtcUrl = flatCameraIsNewer
      ? flatWebRtcUrl || nestedWebRtcUrl
      : nestedWebRtcUrl || flatWebRtcUrl;
    const cameraStatus = stringValue(cameraRecord.status)
      || (typeof rawRecord.cameraStatus === "string" ? rawRecord.cameraStatus.trim() || undefined : undefined);
    const cameraReady = typeof cameraRecord.ready === "boolean"
      ? cameraRecord.ready
      : typeof rawRecord.cameraReady === "boolean" ? rawRecord.cameraReady : undefined;
    const cameraUpdatedAt = Math.max(nestedCameraUpdatedAt, flatCameraUpdatedAt);
    const detectorUpdatedAt = normalizeEpoch(finiteNumber(objectDetectionRecord.updatedAt) ?? finiteNumber(rawRecord.detectorUpdatedAt) ?? 0);
    const lastSeen = normalizeEpoch(finiteNumber(rawRecord.lastSeen) ?? finiteNumber(rawRecord.updatedAt) ?? 0);
    const runtime = normalizeRuntimeTelemetry(rawRecord);
    const rawStatus = isDeviceStatus(raw.status) ? raw.status : "offline";
    const runtimeHeartbeatLive = Boolean(runtime?.heartbeatAt && isFreshEpoch(runtime.heartbeatAt, HARDWARE_HEARTBEAT_STALE_MS));
    const latestControllerTelemetry = Math.max(lastSeen, cameraUpdatedAt);
    const controllerHeartbeatLive = rawStatus === "online"
      && latestControllerTelemetry > 0
      && Date.now() - latestControllerTelemetry <= OFFLINE_AFTER_MS;
    const status: DeviceStatus = runtimeHeartbeatLive || controllerHeartbeatLive ? "online" : "offline";
    const runtimeCameraChecked = runtimeHeartbeatLive && (typeof runtime?.cameraPublicOk === "boolean" || typeof runtime?.cameraLocalOk === "boolean");
    const effectiveCameraStatus = status === "online"
      ? runtimeCameraChecked
        ? runtime?.cameraPublicOk
          ? "online"
          : runtime?.cameraLocalOk ? "local-only" : "error"
        : cameraStatus
      : "offline";
    const effectiveCameraReady = status === "online"
      ? runtimeCameraChecked ? Boolean(runtime?.cameraPublicOk) : cameraReady
      : false;
    const cameraMode = isCameraMode(rawCameraMode)
      ? rawCameraMode
      : cameraUrl || webrtcUrl
        ? "mjpeg"
        : undefined;
    const nestedTrafficUpdatedAt = normalizeEpoch(
      finiteNumber(trafficRecord.updatedAt)
      ?? finiteNumber(trafficRecord.startedAt)
      ?? 0,
    );
    const flatTrafficUpdatedAt = normalizeEpoch(
      finiteNumber(rawRecord.trafficUpdatedAt)
      ?? finiteNumber(rawRecord.trafficStartedAt)
      ?? finiteNumber(rawRecord.detectorUpdatedAt)
      ?? 0,
    );
    const useNestedTraffic = nestedTrafficUpdatedAt > 0
      && (flatTrafficUpdatedAt <= 0 || nestedTrafficUpdatedAt >= flatTrafficUpdatedAt);
    const nestedTrafficColor = stringValue(trafficRecord.current)
      || (trafficRecord.red === true ? "red" : trafficRecord.yellow === true ? "yellow" : trafficRecord.green === true ? "green" : "");
    const flatTrafficColor = typeof rawRecord.trafficColor === "string" ? rawRecord.trafficColor : "";
    const trafficColorValue = useNestedTraffic
      ? nestedTrafficColor || flatTrafficColor
      : flatTrafficColor || nestedTrafficColor;
    const trafficDuration = useNestedTraffic
      ? finiteNumber(trafficRecord.durationSec)
      ?? finiteNumber(trafficRecord.duration)
      ?? finiteNumber(rawRecord.trafficDuration)
      ?? finiteNumber(rawRecord.trafficDurationSec)
      : finiteNumber(rawRecord.trafficDuration)
      ?? finiteNumber(rawRecord.trafficDurationSec)
      ?? finiteNumber(trafficRecord.durationSec)
      ?? finiteNumber(trafficRecord.duration);
    const trafficStartedAt = useNestedTraffic
      ? finiteNumber(trafficRecord.startedAt) ?? finiteNumber(rawRecord.trafficStartedAt)
      : finiteNumber(rawRecord.trafficStartedAt) ?? finiteNumber(trafficRecord.startedAt);
    const detectorFrameWidth = finiteNumber(rawRecord.detectorFrameWidth);
    const detectorFrameHeight = finiteNumber(rawRecord.detectorFrameHeight);
    const rawDetections = normalizeDetections(rawRecord.detections);
    const detections = detectorFrameWidth && detectorFrameHeight
      ? rawDetections.filter((det) => detectionBoxIsUsable(det, detectorFrameWidth, detectorFrameHeight))
      : rawDetections;
    const rfDetrSource = [
      typeof rawRecord.trafficSource === "string" ? rawRecord.trafficSource : "",
      typeof rawRecord.detectorCameraSource === "string" ? rawRecord.detectorCameraSource : "",
    ].join(" ");
    const invalidBrowserRfDetrPayload = /browser-rfdetr/i.test(rfDetrSource)
      && rawDetections.length > 0
      && detections.length === 0;
    const vehicleBreakdown = invalidBrowserRfDetrPayload ? undefined : normalizeVehicleBreakdown(objectDetectionRecord) || normalizeVehicleBreakdown(rawRecord.vehicleBreakdown);
    const vehicleCount = invalidBrowserRfDetrPayload
      ? 0
      : finiteNumber(objectDetectionRecord.total)
      ?? finiteNumber(rawRecord.vehicleCount)
      ?? finiteNumber(rawRecord.vehicles)
      ?? vehicleBreakdown?.total;
    return {
      id,
      label: raw.label?.trim() || "Raspberry Pi 5 Controller",
      status, lastSeen,
      lastSeenText: raw.lastSeenText?.trim() || undefined,
      note: raw.note?.trim() || undefined,
      cameraUrl,
      cameraHlsUrl,
      cameraThumbnailUrl: typeof rawRecord.cameraThumbnailUrl === "string" ? rawRecord.cameraThumbnailUrl.trim() || undefined : undefined,
      cameraStatus: effectiveCameraStatus,
      cameraUpdatedAt,
      cameraDataset: normalizeCameraDataset(rawRecord.cameraDataset),
      cameraMode,
      webrtcEnabled: typeof rawRecord.webrtcEnabled === "boolean" ? rawRecord.webrtcEnabled : undefined,
      webrtcPath: typeof rawRecord.webrtcPath === "string" ? rawRecord.webrtcPath.trim() || undefined : undefined,
      webrtcUrl,
      cameraReady: effectiveCameraReady,
      roadName: raw.roadName?.trim() || stringValue(locationRecord.label) || undefined,
      roadHint: raw.roadHint?.trim() || undefined,
      trafficColor: isTrafficColor(trafficColorValue) ? trafficColorValue : undefined,
      trafficDuration,
      trafficStartedAt,
      vehicleCount,
      vehicleBreakdown,
      detectorStatus: stringValue(objectDetectionRecord.source) || (typeof rawRecord.detectorStatus === "string" ? rawRecord.detectorStatus.trim() || undefined : undefined),
      detectorNote: typeof rawRecord.detectorNote === "string" ? rawRecord.detectorNote.trim() || undefined : undefined,
      detectorUpdatedAt,
      detectorFps: finiteNumber(rawRecord.detectorFps),
      detectorFrameWidth,
      detectorFrameHeight,
      detectorCameraSource: typeof rawRecord.detectorCameraSource === "string" ? rawRecord.detectorCameraSource.trim() || undefined : undefined,
      detectorConfidence: finiteNumber(rawRecord.detectorConfidence),
      detectorOutputShape: typeof rawRecord.detectorOutputShape === "string" ? rawRecord.detectorOutputShape.trim() || undefined : undefined,
      objectCount: invalidBrowserRfDetrPayload
        ? 0
        : Math.max(0, Math.round(finiteNumber(objectDetectionRecord.objectCount) ?? finiteNumber(objectDetectionRecord.total) ?? finiteNumber(rawRecord.objectCount) ?? detections.length)),
      detections,
      trafficSource: typeof rawRecord.trafficSource === "string" ? rawRecord.trafficSource.trim() || undefined : undefined,
      gpioBackend: typeof rawRecord.gpioBackend === "string" ? rawRecord.gpioBackend.trim() || undefined : undefined,
      gpioReady: typeof rawRecord.gpioReady === "boolean" ? rawRecord.gpioReady : undefined,
      gpioNote: typeof rawRecord.gpioNote === "string" ? rawRecord.gpioNote.trim() || undefined : undefined,
      update: normalizeUpdateInfo(rawRecord),
      runtime,
      position: { lat: clamp(safeLat, -90, 90), lng: clamp(safeLng, -180, 180) },
    };
  }

  // FIX: normalizeDevices langsung iterasi tiap entry dan panggil normalizeOneDevice.
  // Juga handle format Firebase lama di mana node device masih berisi nested
  // {devices:[...], source, updatedAt} — unwrap otomatis jika position tidak ada
  // tapi ada field "devices" di dalamnya.
  function normalizeDevices(snapshot: Snapshot): DeviceRecord[] {
    const rawDevices = snapshot.devices;

    if (Array.isArray(rawDevices)) {
      return rawDevices
        .flatMap((raw) => {
          // Handle format lama: device node yang masih berisi nested snapshot wrapper
          if (!raw.position && Array.isArray((raw as Record<string, unknown>).devices)) {
            const nested = (raw as Record<string, unknown>).devices as SnapshotDevice[];
            return nested.map((d) => normalizeOneDevice(d));
          }
          return [normalizeOneDevice(raw)];
        })
        .filter((d): d is DeviceRecord => d !== null);
    }

    if (rawDevices && typeof rawDevices === "object") {
      return Object.entries(rawDevices)
        .flatMap(([key, raw]) => {
          // Handle format Firebase lama: raspberry-its → {devices:[...], source, updatedAt}
          if (!raw.position && Array.isArray((raw as Record<string, unknown>).devices)) {
            const nested = (raw as Record<string, unknown>).devices as SnapshotDevice[];
            return nested.map((d) => normalizeOneDevice({ ...d, id: d.id?.trim() || key }));
          }
          return [normalizeOneDevice({ ...raw, id: raw.id?.trim() || key })];
        })
        .filter((d): d is DeviceRecord => d !== null);
    }

    return [];
  }

  // ─── Marker (Traffic Light) ─────────────────────────────────────

  function trafficStateForDevice(device: DeviceRecord): TrafficState {
    const cached = state.trafficById.get(device.id);
    const roadName = state.roadNameById.get(device.id) || device.roadName || device.roadHint || device.label;
    const next = buildTrafficState({ ...device, roadName });
    if (
      cached &&
      cached.roadName === next.roadName &&
      cached.color === next.color &&
      cached.duration === next.duration &&
      cached.phaseStartedAt === next.phaseStartedAt &&
      cached.vehicleCount === next.vehicleCount &&
      Date.now() - cached.updatedAt < 1200
    ) {
      return cached;
    }

    state.trafficById.set(device.id, next);
    return next;
  }

  function makeTrafficLightSvg(state: TrafficState, size: number): string {
    const colorMap: Record<TrafficColor, string> = {
      red: "#ef4444",
      yellow: "#facc15",
      green: "#22c55e",
    };
    const active = colorMap[state.color];
    const inactive = "#4b5563";
    const bulb = (cx: number, cy: number, lit: boolean, fill: string) => `
  <circle cx="${cx}" cy="${cy}" r="5.6" fill="${lit ? fill : inactive}" opacity="${lit ? 1 : 0.45}"/>
  <circle cx="${cx}" cy="${cy}" r="2.4" fill="${lit ? "#fff" : "#9ca3af"}" opacity="${lit ? 0.35 : 0.2}"/>
`;
    return `<svg viewBox="0 0 32 48" xmlns="http://www.w3.org/2000/svg" class="traffic-light-marker" width="${size}" height="${size * 1.5}">
  <rect x="2" y="2" width="28" height="44" rx="6" fill="#111827" stroke="#374151" stroke-width="1.2"/>
  ${bulb(16, 11, state.color === "red", active)}
  ${bulb(16, 24, state.color === "yellow", active)}
  ${bulb(16, 37, state.color === "green", active)}
</svg>`;
  }

  function setMarkerA11y(marker: L.Marker | null | undefined, label: string): void {
    const el = marker?.getElement?.() as HTMLElement | null;
    if (!el) return;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", label);
    el.setAttribute("title", label);
    el.tabIndex = 0;
  }

  function renderDeviceModal(device: DeviceRecord, traffic: TrafficState): string {
    const road = escapeHtml(traffic.roadName);
    const recommendation = escapeHtml(traffic.recommendation);
    const statsGrid = renderVehicleStatsGrid(device, traffic, "modal-vehicle-grid");
    const status = effectiveDeviceStatus(device);
    return `
  <div class="sheet-panel-header device-panel-header">
    <button class="sheet-icon-btn modal-close" data-action="close" aria-label="Kembali" title="Kembali">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
    </button>
    <div class="sheet-title-cluster">
      <div class="sheet-device-icon" aria-hidden="true">${makeTrafficLightSvg(traffic, 28)}</div>
      <div class="sheet-title-copy">
        <h2 class="modal-title">${escapeHtml(device.label)}</h2>
        <p>${escapeHtml(status)} · ${road}</p>
      </div>
    </div>
  </div>
  <div class="modal-header">
    <button class="modal-close" data-action="close">×</button>
    <h2 class="modal-title">${escapeHtml(device.label)}</h2>
  </div>
  <div class="modal-tabs">
    <button class="modal-tab-btn active" data-tab="system">
      <span class="tab-icon">ℹ️</span> Sistem
    </button>
    <button class="modal-tab-btn" data-tab="traffic">
      <span class="tab-icon">🚦</span> Lalu Lintas
    </button>
  </div>
  <div class="modal-content">
    <div class="modal-tab-pane active" data-tab="system">
      <div class="info-row"><span class="label">Lokasi</span><span class="value" data-field="device-location">${device.position.lat.toFixed(6)}, ${device.position.lng.toFixed(6)}</span></div>
      <div class="info-row"><span class="label">ID Sistem</span><span class="value" data-field="device-id">${escapeHtml(device.id)}</span></div>
      <div class="info-row"><span class="label">Status</span><span class="value status-${status}" data-field="device-status">${escapeHtml(status)}</span></div>
      <div class="info-row"><span class="label">Last Seen</span><span class="value" data-field="device-last-seen">${escapeHtml(device.lastSeenText || formatTime(device.lastSeen))}</span></div>
      <div class="info-row"><span class="label">Age</span><span class="value" data-field="device-age">${formatAge(device.lastSeen)}</span></div>
      <div class="info-row"><span class="label">Jalan</span><span class="value" data-field="device-road">${road}</span></div>
    </div>
    <div class="modal-tab-pane" data-tab="traffic">
      ${statsGrid}
      <div class="info-row"><span class="label">Jalan</span><span class="value" data-field="traffic-road">${road}</span></div>
      <div class="info-row"><span class="label">Durasi Lampu</span><span class="value" data-field="traffic-duration">${traffic.duration}s (${traffic.color})</span></div>
      <div class="info-row"><span class="label">Rekomendasi</span><span class="value" data-field="traffic-recommendation">${recommendation}</span></div>
    </div>
  </div>`;
  }

  function usesDesktopSidePanel(): boolean {
    return window.matchMedia("(min-width: 721px)").matches;
  }

  function setSidePanelWidth(widthPx: number): void {
    const width = usesDesktopSidePanel() ? Math.max(0, Math.round(widthPx)) : 0;
    document.documentElement.style.setProperty("--side-panel-active-width", `${width}px`);
    document.body.classList.toggle("side-panel-open", width > 0);
    window.dispatchEvent(new Event("resize"));
  }

  function setSidePanelWidthFromSheet(sheetEl: HTMLElement | null): void {
    if (!sheetEl || !usesDesktopSidePanel()) return;
    setSidePanelWidth(sheetEl.getBoundingClientRect().width);
  }

  function mapSidePanelSelector(): string {
    return [
      "#windows-download-modal.open",
      "#map-license-modal.open",
      "#ai-license-modal.open",
      "#roadmap-story-modal.open",
      "#privacy-info-modal.open",
      "#app-license-info-modal.open",
      "#about-site-info-modal.open",
      "#m-device-modal.open",
      "#m-poi-modal.open",
      "#m-ai-history-detail-modal.open",
      "body.ai-history-sheet-open #m-ai-history-sheet",
    ].join(", ");
  }

  function isMapSidePanelModal(id: string): boolean {
    return id === "m-device-modal" || id === "m-poi-modal" || id === "m-ai-history-detail-modal";
  }

  function clearSidePanelWidth(delayMs = 260): void {
    setSidePanelWidth(0);
    window.setTimeout(() => {
      if (!document.querySelector(mapSidePanelSelector())) {
        document.body.classList.remove("side-panel-open", "app-download-panel-open", "map-license-panel-open", "map-modal-panel-open");
        document.documentElement.style.removeProperty("--side-panel-active-width");
      }
    }, delayMs);
  }

  function closePromptPanels(): void {
    const downloadModal = document.getElementById("windows-download-modal");
    if (downloadModal) downloadModal.remove();
    document.querySelectorAll("#map-license-modal, #ai-license-modal, #roadmap-story-modal, #privacy-info-modal, #app-license-info-modal, #about-site-info-modal")
      .forEach((modal) => modal.remove());
    document.body.classList.remove("app-download-panel-open", "map-license-panel-open");
    clearSidePanelWidth(0);
  }

  function closeModal(animate = true): void {
    const modals = Array.from(document.querySelectorAll<HTMLElement>(".modal-wrapper, #m-device-modal, #m-poi-modal"));
    modals.forEach((modal) => {
      if (!animate) {
        modal.remove();
        return;
      }
      modal.querySelector<HTMLElement>(".m-device-sheet, .m-poi-sheet, .m-ai-history-detail-sheet")
        ?.style.removeProperty("transform");
      modal.classList.remove("open");
      modal.classList.add("closing");
      window.setTimeout(() => modal.remove(), 260);
    });
    state.activeModalDeviceId = null;
    state.activeModalPoiId = null;
    window.clearInterval(state.trafficRefreshTimer);
    state.trafficRefreshTimer = 0;
    document.body.classList.remove("map-modal-panel-open");
    clearSidePanelWidth();
    renderCurrentPoiDataset();
  }

  function setSheetActiveTab(sheet: HTMLElement, tabName: string): void {
    sheet.querySelectorAll(".modal-tab-btn").forEach((btn) => btn.classList.remove("active"));
    sheet.querySelectorAll(".modal-tab-pane").forEach((pane) => pane.classList.remove("active"));
    sheet.querySelector<HTMLButtonElement>(`.modal-tab-btn[data-tab="${tabName}"]`)?.classList.add("active");
    sheet.querySelector<HTMLElement>(`.modal-tab-pane[data-tab="${tabName}"]`)?.classList.add("active");
  }

  function getActiveModalTab(sheet: HTMLElement): string {
    return sheet.querySelector<HTMLButtonElement>(".modal-tab-btn.active")?.dataset.tab || "system";
  }

  function createSwipeableSheetModal(id: string, sheetClass: string, bodyHtml: string): HTMLElement {
    const overlay = document.createElement("div");
    overlay.id = id;
    overlay.className = id;
    overlay.innerHTML = `
  <div class="m-layer-backdrop"></div>
  <div class="${sheetClass}">${bodyHtml}</div>
`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.classList.add("open");
      const sheet = overlay.querySelector<HTMLElement>(`.${sheetClass.split(" ")[0]}`);
      if (sheet && isMapSidePanelModal(id)) {
        const desktopPanel = usesDesktopSidePanel();
        sheet.style.transform = desktopPanel ? "translateX(0)" : "translateY(0)";
        window.setTimeout(() => {
          if (!overlay.classList.contains("open") || overlay.classList.contains("closing")) return;
          const matrix = new DOMMatrix(getComputedStyle(sheet).transform);
          const remainingOffset = desktopPanel ? Math.abs(matrix.m41) : Math.abs(matrix.m42);
          if (remainingOffset < 1) return;
          sheet.style.transition = "none";
          sheet.style.transform = desktopPanel ? "translateX(0)" : "translateY(0)";
          void sheet.offsetWidth;
          requestAnimationFrame(() => sheet.style.removeProperty("transition"));
        }, 380);
      }
      if (isMapSidePanelModal(id)) {
        document.body.classList.add("map-modal-panel-open");
        setSidePanelWidthFromSheet(sheet);
      }
    });
    L.DomEvent.disableClickPropagation(overlay);
    L.DomEvent.disableScrollPropagation(overlay);
    return overlay;
  }

  function openModal(device: DeviceRecord): void {
    if (isMobile()) {
      closeITSSheet();
      document.getElementById("m-profil-sheet")?.remove();
      if (document.getElementById("m-ai-history-sheet")) snapAiHistorySheet("dock");
    }
    closeModal(false);
    closePromptPanels();
    state.activeModalDeviceId = device.id;
    state.activeModalPoiId = null;
    const traffic = trafficStateForDevice(device);

    const overlay = createSwipeableSheetModal(
      "m-device-modal",
      "m-device-sheet",
      `
    <div class="m-sheet-handle-bar"></div>
    ${renderDeviceModal(device, traffic)}
  `,
    );

    overlay.querySelector(".m-layer-backdrop")!.addEventListener("click", () => closeModal());
    const sheet = overlay.querySelector<HTMLElement>(".m-device-sheet");
    if (!sheet) return;
    setupSheetSwipe(sheet, closeModal);
    sheet.querySelectorAll<HTMLButtonElement>(".modal-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => setSheetActiveTab(sheet, btn.dataset.tab || "system"));
    });
    sheet.querySelector<HTMLButtonElement>(".modal-close")?.addEventListener("click", () => closeModal());

    window.clearInterval(state.trafficRefreshTimer);
    state.trafficRefreshTimer = window.setInterval(() => {
      const active = state.device;
      const activeId = state.activeModalDeviceId;
      if (!active || !activeId || active.id !== activeId) return;
      refreshOpenDeviceModal(active);
    }, 2500);
  }

  function refreshOpenDeviceModal(device: DeviceRecord): void {
    const sheet = document.querySelector<HTMLElement>(".m-device-sheet");
    if (!sheet) return;

    const activeTab = getActiveModalTab(sheet);
    const nextTraffic = trafficStateForDevice(device);
    sheet.innerHTML = `
  <div class="m-sheet-handle-bar"></div>
  ${renderDeviceModal(device, nextTraffic)}
`;
    sheet.querySelector<HTMLButtonElement>(".modal-close")?.addEventListener("click", () => closeModal());
    sheet.querySelectorAll<HTMLButtonElement>(".modal-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => setSheetActiveTab(sheet, btn.dataset.tab || "system"));
    });
    setSheetActiveTab(sheet, activeTab);
  }

  function ensureMarker(device: DeviceRecord): void {
    const traffic = trafficStateForDevice(device);
    const size = markerSizeByZoom();
    const hitWidth = Math.max(48, size);
    const hitHeight = Math.max(48, Math.round(size * 1.5));
    const icon = L.divIcon({
      className: "traffic-light-marker-icon",
      html: makeTrafficLightSvg(traffic, size),
      iconSize: [hitWidth, hitHeight],
      iconAnchor: [Math.round(hitWidth / 2), hitHeight],
      popupAnchor: [0, -Math.round(size * 1.2)],
    });
    const existing = state.markers.get(device.id);

    const latlng = L.latLng(device.position.lat, device.position.lng);

    if (!existing) {
      const m = L.marker(latlng, {
        pane: RASPBERRY_PANE,
        icon,
        interactive: true,
        title: `${device.label} - buka detail traffic light`,
        alt: `${device.label} traffic light`,
        zIndexOffset: 1000,
        riseOnHover: true,
      } as L.MarkerOptions & { alt?: string }).addTo(map);
      m.on("click", () => {
        state.device = device;
        renderCameraTile();
        openModal(device);
      });
      state.markers.set(device.id, m);
      state.prevPositionById.set(device.id, latlng);
      setMarkerA11y(m, `${device.label}, traffic light ${traffic.color}, ${traffic.duration} detik. Buka detail perangkat.`);
      return;
    }

    // Update position and icon
    existing.setLatLng(latlng);
    existing.setIcon(icon);
    existing.setZIndexOffset(1000);

    // Compute heading from the previous position. Leaflet owns the marker-root
    // transform (translate/rotate); only rotate the inner drawing so a realtime
    // update can never displace the marker from its geographic anchor.
    const prev = state.prevPositionById.get(device.id) || null;
    try {
      const el = existing.getElement?.() as HTMLElement | null;
      if (el) {
        const visual = el.querySelector<SVGElement>(".traffic-light-marker");
        if (prev) {
          const bearing = computeBearing(prev.lat, prev.lng, latlng.lat, latlng.lng);
          if (visual) visual.style.transform = `rotate(${bearing}deg)`;
        } else {
          visual?.style.removeProperty("transform");
        }
        if (visual) {
          visual.style.transformBox = "fill-box";
          visual.style.transformOrigin = "50% 100%";
          visual.style.transition = "transform 300ms linear";
        }
        el.style.filter = "grayscale(0.35)";
        el.style.transition = "filter 300ms";
        el.style.pointerEvents = "auto";
      }
    } catch { /* ignore DOM access errors */ }
    setMarkerA11y(existing, `${device.label}, traffic light ${traffic.color}, ${traffic.duration} detik. Buka detail perangkat.`);

    state.prevPositionById.set(device.id, latlng);

    existing.off("click");
    existing.on("click", () => {
      state.device = device;
      renderCameraTile();
      openModal(device);
    });
  }

  function rescaleMarkers(): void {
    const deviceSize = markerSizeByZoom();
    for (const device of state.devices) {
      const marker = state.markers.get(device.id);
      if (!marker) continue;
      const hitWidth = Math.max(48, deviceSize);
      const hitHeight = Math.max(48, Math.round(deviceSize * 1.5));
      marker.setIcon(L.divIcon({
        className: "traffic-light-marker-icon",
        html: makeTrafficLightSvg(trafficStateForDevice(device), deviceSize),
        iconSize: [hitWidth, hitHeight],
        iconAnchor: [Math.round(hitWidth / 2), hitHeight],
        popupAnchor: [0, -Math.round(deviceSize * 1.2)],
      }));
      setMarkerA11y(marker, `${device.label}, traffic light ${trafficStateForDevice(device).color}. Buka detail perangkat.`);
    }

    renderCurrentPoiDataset();

    // Keep MapLibre POI text stable in screen pixels as the camera zooms.
    const maplibreMap = state.maplibreMap;
    if (maplibreMap && state.baseMode !== "satellite" && maplibreMap.getLayer?.("poi-symbols")) {
      try {
        maplibreMap.setLayoutProperty("poi-symbols", "text-size", 11);
      } catch {
        /* ignore */
      }
    }
  }

  function removeMissingMarkers(activeIds: Set<string>): void {
    for (const [deviceId, marker] of state.markers.entries()) {
      if (!activeIds.has(deviceId)) {
        map.removeLayer(marker);
        state.markers.delete(deviceId);
      }
    }
    mapRoot.dataset.raspberryMarkerCount = String(state.markers.size);
  }

  // ─── Compass ────────────────────────────────────────────────────

  function bearingLabel(deg: number): string {
    const n = ((deg % 360) + 360) % 360;
    if (n < 22.5 || n >= 337.5) return "Utara (N)";
    if (n < 67.5) return "Timur Laut (NE)";
    if (n < 112.5) return "Timur (E)";
    if (n < 157.5) return "Tenggara (SE)";
    if (n < 202.5) return "Selatan (S)";
    if (n < 247.5) return "Barat Daya (SW)";
    if (n < 292.5) return "Barat (W)";
    return "Barat Laut (NW)";
  }

  function normBearing(raw: number): number {
    return ((raw % 360) + 360) % 360;
  }

  function updateCompass(): void {
    if (!state.compassNeedle) return;
    const norm = normBearing(map.getBearing?.() ?? 0);
    state.compassNeedle.setAttribute("transform", `rotate(${norm}, 24, 24)`);
    if (state.compassBtn) {
      const isNorth = norm < BEARING_SNAP || norm > (360 - BEARING_SNAP);
      state.compassBtn.classList.toggle("compass-active", !isNorth);
      const tip = state.compassBtn.querySelector<HTMLSpanElement>(".toolbar-tip");
      if (tip) {
        tip.textContent = isNorth
          ? "Kompas - klik untuk putar peta ke Timur (90 deg)"
          : `Kompas mengarah ke ${bearingLabel(norm)} - klik lagi untuk lanjut`;
      }
      window.setTimeout(() => state.compassBtn?.removeAttribute("title"), 0);
      state.compassBtn.title = isNorth
        ? "Kompas – klik untuk putar peta ke Timur (90°)"
        : `Kompas mengarah ke ${bearingLabel(norm)} — klik lagi untuk lanjut`;
    }
  }

  function handleCompassClick(): void {
    beginExplicitMapNavigation();
    const norm = normBearing(map.getBearing?.() ?? 0);
    const snapped = Math.round(norm / BEARING_STEP) * BEARING_STEP;
    const nextBearing = (snapped + BEARING_STEP) % 360;
    map.setBearing(nextBearing);
    map.closePopup();
  }

  // ─── Base map ───────────────────────────────────────────────────

  function mapLibreSurfaceReady(): boolean {
    return Boolean(state.maplibreContainer?.classList.contains("is-ready"));
  }

  function applyMapLibreDimensionMode(maplibreMap: any): void {
    const visibility = state.baseMode === "3d" ? "visible" : "none";
    const layers = maplibreMap.getStyle?.()?.layers || [];
    layers.forEach((layer: any) => {
      if (layer?.type !== "fill-extrusion") return;
      try { maplibreMap.setLayoutProperty(layer.id, "visibility", visibility); } catch { /* Optional style layer. */ }
    });
  }

  async function ensureMapLibreMap(): Promise<any | null> {
    if (state.maplibreMap) return state.maplibreMap;

    try {
      const maplibreglImport = await import("maplibre-gl");
      const maplibregl = (maplibreglImport as any).default || maplibreglImport;
      const nationalStyle = await nationalVectorStyle(maplibregl);

      if (!state.maplibreContainer) {
        const container = document.createElement("div");
        container.className = "maplibre-overlay";
        mapRoot.appendChild(container);
        state.maplibreContainer = container;
      }

      const maplibreMap = new maplibregl.Map({
        container: state.maplibreContainer,
        style: nationalStyle,
        center: map.getCenter(),
        zoom: map.getZoom(),
        bearing: map.getBearing?.() ?? 0,
        pitch: mapLibrePitchByZoom(map.getZoom()),
        attributionControl: false,
        interactive: false,
        preserveDrawingBuffer: false,
        fadeDuration: 0,
      });
      state.maplibreMap = maplibreMap;

      // Register before `load`: missing sprite icons can be requested while the
      // style is still parsing, earlier than the former load-handler listener.
      maplibreMap.on("styleimagemissing", (event: any) => {
        const id = event?.id;
        if (!id || maplibreMap.hasImage(id)) return;
        maplibreMap.addImage(id, {
          width: 1,
          height: 1,
          data: new Uint8Array([0, 0, 0, 0]),
        });
      });

      let surfaceRevealed = false;
      const revealRenderedSurface = () => {
        if (surfaceRevealed || !state.maplibreContainer?.isConnected) return;
        if (state.baseMode === "satellite" || state.maplibreMap !== maplibreMap) return;
        if (typeof maplibreMap.isStyleLoaded === "function" && !maplibreMap.isStyleLoaded()) return;
        if (typeof maplibreMap.areTilesLoaded === "function" && !maplibreMap.areTilesLoaded()) return;
        surfaceRevealed = true;
        state.maplibreContainer.classList.add("is-ready");
        // Make the active POI renderer explicit at the map-root level. Leaflet
        // markers can be created asynchronously after this frame (for example
        // when an Overpass response arrives), so hiding individual elements is
        // not sufficient to prevent duplicate vector + DOM symbols.
        mapRoot.classList.add("maplibre-pois-active");
        if (map.hasLayer(streetLayer)) map.removeLayer(streetLayer);
      };
      maplibreMap.on("idle", revealRenderedSurface);
      maplibreMap.on("render", revealRenderedSurface);

      maplibreMap.on("load", () => {
        if (state.baseMode === "satellite" || state.maplibreMap !== maplibreMap) return;
        state.roadGuideLayer?.clearLayers();
        state.visionLayer?.clearLayers();
        syncMapLibreView(true);
        ensureMapDetailStyle(maplibreMap);
        void refreshOverpassLayer();
        void refreshMapLibreDetailLayer(true);

        // Some MapLibre builds do not implement setFog.
        const maybeSetFog = (maplibreMap as any).setFog;
        if (typeof maybeSetFog === "function") {
          maybeSetFog.call(maplibreMap, {
            "range": [0.5, 10],
            "color": "#ffffff",
            "high-color": "#245cdf",
            "space-color": "#000000"
          });
        }

        // Prevent noisy runtime warnings when style references icons not present
        // in the remote sprite sheet.
        // Add POI GeoJSON source for 3D rendering (prevents drift)
        try {
          if (!maplibreMap.getSource("poi-source")) {
            maplibreMap.addSource("poi-source", {
              type: "geojson",
              data: { type: "FeatureCollection", features: [] },
              // Symbol collision keeps a single semantically dominant POI.
              // Numeric cluster badges are deliberately not used.
              cluster: false,
            });
          }

          if (!maplibreMap.getLayer("poi-halo")) {
            maplibreMap.addLayer({
              id: "poi-halo",
              type: "circle",
              source: "poi-source",
              filter: ["!", ["has", "point_count"]],
              paint: {
                "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 4, 18, 10],
                "circle-color": ["coalesce", ["get", "color"], "#475569"],
                "circle-opacity": 0.32,
                "circle-stroke-color": "#ffffff",
                "circle-stroke-width": 2
              }
            });
          }

          // The same generated POI icon manifest drives Leaflet and MapLibre.
          if (!maplibreMap.getLayer("poi-symbols")) {
            maplibreMap.addLayer({
              id: "poi-symbols",
              type: "symbol",
              source: "poi-source",
              filter: ["!", ["has", "point_count"]],
              minzoom: 13,
              layout: {
                "icon-image": ["get", "mapIconId"],
                "icon-size": 0.22,
                "icon-anchor": "bottom",
                "icon-allow-overlap": false,
                "icon-ignore-placement": false,
                "icon-optional": true,
                "symbol-sort-key": ["coalesce", ["get", "priority"], 999],
                "text-field": ["get", "title"],
                "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
                "text-size": 11,
                "text-offset": [0, 1.45],
                "text-anchor": "top",
                "text-max-width": 12,
                "text-allow-overlap": false,
                "text-ignore-placement": false,
                "text-optional": true,
              },
              paint: {
                "text-color": "#111827",
                "text-halo-color": "#ffffff",
                "text-halo-width": 1.4,
                "text-opacity": 1
              }
            });
          }

          // Add click handler for POI (allow MapLibre to detect clicks)
          // Note: MapLibre is non-interactive by default, so we detect features via ray casting
          // when Leaflet receives a click and is in 3D mode
        } catch (err) {
          console.warn("Failed to setup POI layer:", err);
        }

        const style = maplibreMap.getStyle();
        if (style && style.layers) {
          style.layers.forEach((layer: any) => {
            const id = layer.id;
            const sourceLayer = layer['source-layer'];

            // ITS Maps renders its own collision-ranked POIs. Hiding the
            // basemap POI symbols prevents duplicate icons and labels.
            if (sourceLayer === "poi" && layer.type === "symbol") {
              try { maplibreMap.setLayoutProperty(id, "visibility", "none"); } catch { /* Optional style layer. */ }
            }

            // 1. Mewarnai Tata Guna Lahan (Tanah Dasar)
            if (sourceLayer === 'landuse' && layer.type === 'fill') {
              try {
                maplibreMap.setPaintProperty(id, 'fill-color', [
                  'match', ['get', 'class'],
                  'hospital', '#ffd6d6',
                  'school', '#fff4c2',
                  'education', '#fff4c2',
                  'residential', '#f4f1ea',
                  'commercial', '#ffe4c7',
                  'industrial', '#e2d9f3',
                  '#eef2f5'
                ]);
                maplibreMap.setPaintProperty(id, 'fill-opacity', 0.95);
              } catch {
                /* ignore layer incompatibility */
              }
            }

            // Taman & Air
            if ((sourceLayer === 'landcover' || sourceLayer === 'park') && layer.type === 'fill') {
              try {
                maplibreMap.setPaintProperty(id, 'fill-color', [
                  'match', ['get', 'class'],
                  'grass', '#d8efcf',
                  'wood', '#bde09b',
                  '#e9f7de'
                ]);
                maplibreMap.setPaintProperty(id, 'fill-opacity', 0.95);
              } catch {
                /* ignore layer incompatibility */
              }
            }
            if (sourceLayer === 'water' && layer.type === 'fill') {
              try {
                maplibreMap.setPaintProperty(id, 'fill-color', '#8ec5f7');
                maplibreMap.setPaintProperty(id, 'fill-opacity', 0.93);
              } catch {
                /* ignore layer incompatibility */
              }
            }

            // 2. Mewarnai Jalan Tol dan Raya
            if (sourceLayer === 'transportation' && layer.type === 'line') {
              try {
                maplibreMap.setPaintProperty(id, 'line-color', [
                  'match', ['get', 'class'],
                  'motorway', '#f59e0b',
                  'trunk', '#f59e0b',
                  'primary', '#ffd878',
                  'secondary', '#ffe9a6',
                  'tertiary', '#fff4cf',
                  'minor', '#ffffff',
                  'service', '#eef2f5',
                  'path', '#e7ddd0',
                  '#f8fafc'
                ]);
              } catch {
                /* ignore layer incompatibility */
              }
            }

            // Keep the provider's mapped heights, but use a restrained
            // scientific palette instead of exaggerating building geometry.
            if (layer.type === 'fill-extrusion') {
              try {
                maplibreMap.setPaintProperty(id, 'fill-extrusion-color', [
                  'interpolate',
                  ['linear'],
                  ['to-number', ['coalesce', ['get', 'render_height'], ['get', 'height'], ['*', ['to-number', ['coalesce', ['get', 'building:levels'], 0], 0], 3], 0], 0],
                  0, '#e4e9ef',
                  20, '#d4dde8',
                  60, '#c3cfdf',
                  150, '#afbed3'
                ]);
                maplibreMap.setPaintProperty(id, 'fill-extrusion-opacity', 0.86);
              } catch {
                /* ignore layer incompatibility */
              }
            }

            if ((sourceLayer === 'building' || id.includes('building')) && layer.type === 'fill') {
              try {
                maplibreMap.setPaintProperty(id, 'fill-color', '#d6e4d4');
                maplibreMap.setPaintProperty(id, 'fill-opacity', 0.88);
              } catch {
                /* ignore layer incompatibility */
              }
            }
          });

          const buildingFill = style.layers.find((layer: any) =>
            layer.type === "fill" && (layer["source-layer"] === "building" || String(layer.id).includes("building")));
          if (buildingFill && !maplibreMap.getLayer("its-building-footprints")) {
            const firstSymbol = style.layers.find((layer: any) => layer.type === "symbol")?.id;
            maplibreMap.addLayer({
              id: "its-building-footprints",
              type: "fill",
              source: buildingFill.source,
              "source-layer": buildingFill["source-layer"],
              minzoom: 14,
              ...(Array.isArray(buildingFill.filter) ? { filter: buildingFill.filter } : {}),
              paint: {
                "fill-color": "#e1e6eb",
                "fill-outline-color": "#c7d0d9",
                "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0.7, 17, 0.88],
              },
            }, firstSymbol);
          }
          applyMapLibreDimensionMode(maplibreMap);
          updateMapLibrePoiLayer(Array.from(state.poiData.values()));
        }
      });
      return maplibreMap;
    } catch (err) {
      console.error("ensureMapLibreMap error:", err);
      return null;
    }
  }

  async function removeMapLibreMap(): Promise<void> {
    mapRoot.classList.remove("maplibre-pois-active");
    if (state.maplibreMap) {
      try {
        state.maplibreMap.remove();
      } catch {
        /* ignore */
      }
    }
    state.maplibreMap = null;
    if (state.maplibreContainer) {
      state.maplibreContainer.remove();
      state.maplibreContainer = null;
    }
  }

  function restoreLeafletPoiSurface(): void {
    if (state.overpassLayer) {
      state.overpassLayer.getLayers().forEach((layer: any) => {
        const element = typeof layer.getElement === "function"
          ? layer.getElement()
          : layer._icon || layer._path;
        if (element instanceof HTMLElement || element instanceof SVGElement) {
          element.style.display = "";
        }
      });
    }
    for (const marker of state.poiMarkers.values()) {
      const element = marker.getElement() as HTMLElement | null;
      if (element) element.style.display = "";
    }
  }

  function syncMapLibreView(force = false): void {
    const maplibreMap = state.maplibreMap;
    if (!maplibreMap || state.baseMode === "satellite") return;
    if (!force) {
      if (state.maplibreSyncFrame) return;
      state.maplibreSyncFrame = window.requestAnimationFrame(() => {
        state.maplibreSyncFrame = 0;
        syncMapLibreView(true);
      });
      return;
    }
    if (state.maplibreSyncing && !force) return;

    const center = map.getCenter();
    const zoom = map.getZoom();
    const bearing = map.getBearing?.() ?? 0;
    const pitch = state.baseMode === "3d" ? mapLibrePitchByZoom(zoom) : 0;

    const currentCenter = maplibreMap.getCenter();
    const currentZoom = maplibreMap.getZoom();
    const currentBearing = maplibreMap.getBearing();
    const currentPitch = maplibreMap.getPitch();

    const centerChanged = currentCenter.lat !== center.lat || currentCenter.lng !== center.lng;
    const zoomChanged = currentZoom !== zoom;
    const bearingChanged = currentBearing !== bearing;
    const pitchChanged = currentPitch !== pitch;

    if (!force && !centerChanged && !zoomChanged && !bearingChanged && !pitchChanged) return;

    state.maplibreSyncing = true;
    try {
      maplibreMap.jumpTo({
        animate: false,
        center,
        zoom,
        bearing,
        pitch,

      });
      // MapLibre owns POI labels while active; Leaflet remains the interaction plane.
      if (state.overpassLayer) {
        state.overpassLayer.getLayers().forEach((layer: any) => {
          if (layer._path) layer._path.style.display = "none";
          if (layer._icon) layer._icon.style.display = "none";
        });
      }
      for (const marker of state.poiMarkers.values()) {
        const el = marker.getElement() as HTMLElement | null;
        if (el) el.style.display = "none";
      }
    } finally {
      state.maplibreSyncing = false;
    }
  }

  async function setBaseMap(mode: BaseMapMode): Promise<void> {
    const isCurrentSurface = mode === "street"
      ? !state.maplibreMap && map.hasLayer(streetLayer) && !map.hasLayer(satelliteLayer)
      : mode === "3d"
        ? Boolean(state.maplibreMap) && !map.hasLayer(satelliteLayer)
        : !state.maplibreMap && map.hasLayer(satelliteLayer) && !map.hasLayer(streetLayer);
    if (state.baseMode === mode && isCurrentSurface) {
      updateModeControlButtons();
      syncMapStateToUrl();
      return;
    }
    const mapEl = mapRoot as HTMLElement;
    mapEl.style.transform = "";
    mapEl.style.transformOrigin = "";
    mapEl.style.perspective = "";
    (mapEl.parentElement as HTMLElement | null)?.style.setProperty("perspective", "");
    state.baseMode = mode;
    mapEl.classList.toggle("map-mode-3d", mode === "3d");

    if (mode === "street") {
      await removeMapLibreMap();
      if (state.baseMode !== mode) return;
      restoreLeafletPoiSurface();
      if (map.hasLayer(satelliteLayer)) map.removeLayer(satelliteLayer);
      if (!map.hasLayer(streetLayer)) streetLayer.addTo(map);
      renderCurrentPoiDataset();
      void refreshOverpassLayer();
      void refreshRoadGuideLayer(true);
      void refreshVisionLayer(true);
    } else if (mode === "3d") {
      if (map.hasLayer(satelliteLayer)) map.removeLayer(satelliteLayer);
      // Keep CARTO underneath until MapLibre has a complete
      // rendered frame. This avoids a blank map on slow or WebGL-limited clients.
      if (!mapLibreSurfaceReady() && !map.hasLayer(streetLayer)) streetLayer.addTo(map);
      const maplibreMap = await ensureMapLibreMap();
      if (state.baseMode !== mode) return;
      if (!maplibreMap) {
        state.baseMode = "street";
        mapEl.classList.remove("map-mode-3d");
        mapEl.classList.remove("maplibre-pois-active");
        if (!map.hasLayer(streetLayer)) streetLayer.addTo(map);
        restoreLeafletPoiSurface();
      } else if (state.maplibreMap === maplibreMap) {
        const center = map.getCenter();
        maplibreMap.resize();
        applyMapLibreDimensionMode(maplibreMap);
        maplibreMap.easeTo({
          center,
          zoom: map.getZoom(),
          bearing: map.getBearing?.() ?? 0,
          pitch: mapLibrePitchByZoom(map.getZoom()),
          duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 420,
        });
        state.roadGuideLayer?.clearLayers();
        state.visionLayer?.clearLayers();
        renderCurrentPoiDataset();
      }
    } else {
      await removeMapLibreMap();
      restoreLeafletPoiSurface();
      if (map.hasLayer(streetLayer)) map.removeLayer(streetLayer);
      if (!map.hasLayer(satelliteLayer)) satelliteLayer.addTo(map);
      // The viewport has not changed merely because the base map changed.
      // Reuse POIs immediately and let the buffered-bounds check decide
      // whether a network refresh is actually necessary.
      renderCurrentPoiDataset();
      void refreshOverpassLayer();
      void refreshRoadGuideLayer(true);
      void refreshVisionLayer(true);
    }

    updateModeControlButtons();
    map.invalidateSize();
    syncMapStateToUrl();
  }

  // ─── Camera tile ────────────────────────────────────────────────

  function publicCameraUrl(device: DeviceRecord | null): string {
    return usablePublicMediaUrl(device?.cameraUrl) || usablePublicMediaUrl(device?.webrtcUrl) || "";
  }

  function publicCameraHlsUrl(device: DeviceRecord | null): string {
    const explicit = usablePublicMediaUrl(device?.cameraHlsUrl);
    if (explicit) return hlsPlaylistUrl(explicit);
    const url = publicCameraUrl(device);
    return url && isLikelyHlsUrl(url) ? hlsPlaylistUrl(url) : "";
  }

  function publicCameraPageUrl(device: DeviceRecord | null): string {
    const url = publicCameraUrl(device);
    if (url && !isLikelyHlsUrl(url)) return hlsPageUrl(url) || url;
    return hlsPageUrl(publicCameraHlsUrl(device));
  }

  function publicCameraProbeUrl(device: DeviceRecord | null): string {
    return publicCameraHlsUrl(device) || publicCameraUrl(device);
  }

  function publicCameraHealthFor(device: DeviceRecord | null): PublicCameraHealth | undefined {
    const url = publicCameraProbeUrl(device);
    if (!url) return undefined;
    const entry = state.publicCameraHealth.get(url);
    if (!entry) return undefined;
    return Date.now() - entry.checkedAt <= PUBLIC_CAMERA_HEALTH_MAX_AGE_MS || entry.checking ? entry : undefined;
  }

  function publicCameraNeedsProbe(device: DeviceRecord | null): boolean {
    const url = publicCameraProbeUrl(device);
    if (!device || !url || !/^https?:\/\//i.test(url) || isWebRtcSignalingCamera(device)) return false;
    try {
      const parsed = new URL(url, window.location.href);
      // Cross-origin camera pages can render in an iframe even when their media
      // endpoint intentionally omits CORS headers. Probing those URLs with fetch
      // made mobile reject a healthy tunnel while desktop still displayed it.
      return parsed.origin === window.location.origin;
    } catch {
      return false;
    }
  }

  function ensurePublicCameraHealth(device: DeviceRecord | null): void {
    if (!publicCameraNeedsProbe(device)) return;
    const url = publicCameraProbeUrl(device);
    const existing = state.publicCameraHealth.get(url);
    if (existing?.checking || (existing && Date.now() - existing.checkedAt <= PUBLIC_CAMERA_HEALTH_TTL_MS)) return;

    state.publicCameraHealth.set(url, {
      url,
      checkedAt: Date.now(),
      ok: false,
      checking: true,
      note: "mengecek frame kamera publik",
    });

    void probePublicCameraUrl(url)
      .then((result) => {
        state.publicCameraHealth.set(url, { url, checkedAt: Date.now(), ...result });
      })
      .catch((err) => {
        state.publicCameraHealth.set(url, {
          url,
          checkedAt: Date.now(),
          ok: false,
          note: err instanceof Error ? err.message : "tunnel publik tidak bisa dicek",
        });
      })
      .finally(() => refreshCameraHealthUi());
  }

  function refreshCameraHealthUi(): void {
    renderCameraTile();
    const device = state.device;
    const live = deviceCameraIsLive(device);
    const statusText = videoSurfaceStatusText(device);
    document.querySelectorAll<HTMLElement>(".custom-video-card").forEach((card) => {
      card.dataset.liveState = live ? "online" : "offline";
      const status = card.querySelector<HTMLElement>(".custom-video-status");
      if (status) status.textContent = statusText || "Menunggu frame video live...";
      const badge = card.querySelector<HTMLElement>(".custom-video-live");
      if (badge) {
        badge.innerHTML = `<span></span>${live ? "LIVE" : "OFFLINE"}`;
      }
    });
    const fullscreenLive = document.querySelector<HTMLElement>(".video-fullscreen-live");
    if (fullscreenLive) {
      fullscreenLive.dataset.liveState = live ? "online" : "offline";
      fullscreenLive.innerHTML = `<span></span>${live ? "LIVE" : "OFFLINE"}`;
    }
    const fullscreenMessage = document.querySelector<HTMLElement>("[data-video-title-message]");
    if (fullscreenMessage) fullscreenMessage.textContent = statusText || "AI RF-DETR siap memproses video";
    if (document.getElementById("m-its-scroll")) renderITSSheetContent();
  }

  async function probePublicCameraUrl(url: string): Promise<Omit<PublicCameraHealth, "url" | "checkedAt">> {
    if (isLikelyHlsUrl(url)) return probeHlsCameraUrl(hlsPlaylistUrl(url));
    const snapshotUrl = publicSnapshotProbeUrl(url);
    return probeSnapshotCameraUrl(snapshotUrl);
  }

  async function probeHlsCameraUrl(url: string, depth = 0): Promise<Omit<PublicCameraHealth, "url" | "checkedAt">> {
    const playlistResponse = await fetchWithTimeout(url);
    if (!playlistResponse.ok) return { ok: false, note: `tunnel publik error HTTP ${playlistResponse.status}` };
    const playlist = await playlistResponse.text();
    if (!playlist.includes("#EXTM3U")) return { ok: false, note: "playlist HLS tidak valid" };
    const segment = playlist.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).pop();
    if (!segment) return { ok: false, note: "playlist HLS belum punya segment video" };
    const segmentUrl = new URL(segment, url).toString();
    if (isLikelyHlsUrl(segmentUrl)) {
      if (depth >= 2) return { ok: false, note: "playlist HLS terlalu bertingkat" };
      return probeHlsCameraUrl(segmentUrl, depth + 1);
    }
    const segmentResponse = await fetchWithTimeout(segmentUrl);
    if (!segmentResponse.ok) return { ok: false, note: `segment video error HTTP ${segmentResponse.status}` };
    const bytes = new Uint8Array(await segmentResponse.arrayBuffer());
    if (bytes.length < 512) return { ok: false, note: "segment video kosong" };
    if (bytesLookLikeHlsPlaylist(bytes)) {
      if (depth >= 2) return { ok: false, note: "segment HLS masih berupa playlist" };
      return probeHlsCameraUrl(segmentUrl, depth + 1);
    }
    if (bytesLookLikeTextError(bytes, segmentResponse.headers.get("content-type"))) {
      return { ok: false, note: "segment video berisi error tunnel" };
    }
    return { ok: true, note: "frame kamera publik valid" };
  }

  async function probeSnapshotCameraUrl(url: string): Promise<Omit<PublicCameraHealth, "url" | "checkedAt">> {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return { ok: false, note: `snapshot kamera error HTTP ${response.status}` };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 512) return { ok: false, note: "snapshot kamera kosong" };
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!isJpeg || bytesLookLikeTextError(bytes, response.headers.get("content-type"))) {
      return { ok: false, note: "snapshot kamera bukan JPEG valid" };
    }
    return { ok: true, note: "snapshot kamera publik valid" };
  }

  async function fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), PUBLIC_CAMERA_HEALTH_TIMEOUT_MS);
    try {
      return await fetch(cacheBustMediaUrl(url, Date.now()), {
        cache: "no-store",
        mode: "cors",
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw new Error("cek kamera publik timeout");
      throw new Error("tunnel publik tidak bisa diakses dari browser");
    } finally {
      window.clearTimeout(timer);
    }
  }

  function publicSnapshotProbeUrl(value: string): string {
    if (isLikelyImageUrl(value)) return value;
    try {
      const url = new URL(value, window.location.href);
      if (/\/cam\/?$/i.test(url.pathname)) {
        url.pathname = "/snapshot.jpg";
        url.search = "";
        return url.toString();
      }
      if (url.pathname.endsWith("/")) {
        url.pathname = `${url.pathname}snapshot.jpg`;
        url.search = "";
        return url.toString();
      }
    } catch {
      // Fallback below keeps old behavior for unusual but still valid URLs.
    }
    return value;
  }

  function bytesLookLikeTextError(bytes: Uint8Array, contentType: string | null): boolean {
    const type = contentType?.toLowerCase() || "";
    if (type.includes("text/html") || type.includes("text/plain")) return true;
    const prefix = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 96))).toLowerCase();
    return /<html|cloudflare tunnel error|error code:\s*1033|no tunnel here/.test(prefix);
  }

  function bytesLookLikeHlsPlaylist(bytes: Uint8Array): boolean {
    const prefix = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 32))).toLowerCase();
    return prefix.includes("#extm3u");
  }

  function latestCameraSnapshot(device: DeviceRecord | null): string {
    if (!device) return "";
    const datasetShot = preferredCameraDatasetSnapshot(device.cameraDataset);
    const thumbnail = device.cameraThumbnailUrl?.trim() || "";
    const datasetAt = device.cameraDataset?.updatedAt || 0;
    const thumbnailAt = Math.max(device.cameraUpdatedAt || 0, device.detectorUpdatedAt || 0);
    const freshDataset = datasetShot && snapshotIsFresh(device, datasetAt);
    const freshThumbnail = thumbnail && snapshotIsFresh(device, thumbnailAt);
    const selected = freshDataset && datasetAt >= thumbnailAt ? datasetShot : freshThumbnail ? thumbnail : freshDataset ? datasetShot : "";
    return cacheBustMediaUrl(selected, freshDataset && selected === datasetShot ? datasetAt : thumbnailAt);
  }

  function latestCameraAnalysisSnapshot(device: DeviceRecord | null): string {
    if (!device) return "";
    const dataset = device?.cameraDataset;
    const datasetAt = dataset?.updatedAt || 0;
    if (!snapshotIsFresh(device, datasetAt)) return "";
    const datasetShot = preferredCameraDatasetSnapshot(dataset);
    const hasBrowserRfDetrDetections = /browser-rfdetr/i.test(device?.trafficSource || "")
      && Boolean(device?.detections?.length);
    const selected = datasetShot
      || (hasBrowserRfDetrDetections ? "" : device?.cameraThumbnailUrl?.trim() || "");
    return cacheBustMediaUrl(selected, datasetAt || device.cameraUpdatedAt || device.detectorUpdatedAt);
  }

  function preferredCameraDatasetSnapshot(dataset?: TrafficCameraDataset): string {
    if (!dataset) return "";
    const image1 = dataset.snapshot1Url?.trim() || "";
    const image2 = dataset.snapshot2Url?.trim() || "";
    const active = dataset.active?.trim().toLowerCase();
    if (active === "image1" && image1) return image1;
    if (active === "image2" && image2) return image2;
    if ((dataset.snapshot2UpdatedAt || 0) > (dataset.snapshot1UpdatedAt || 0) && image2) return image2;
    return image1 || image2;
  }

  function cameraTitleText(device: DeviceRecord | null): string {
    const label = device?.label?.trim() || "Raspberry Pi Camera";
    return /live$/i.test(label) ? label : `${label} live`;
  }

  function cameraRfDetrHeadline(device: DeviceRecord | null): string {
    if (!device) return "";
    if (!device.detectorUpdatedAt || !isFreshEpoch(device.detectorUpdatedAt, CAMERA_STATUS_FRESH_MS)) return "";
    const fps = device.detectorFps && device.detectorFps > 0 ? `${device.detectorFps.toFixed(1)} FPS` : "";
    const objectCount = Math.max(0, Math.round(device.objectCount || 0));
    const vehicleCount = Math.max(0, Math.round(device.vehicleCount || device.vehicleBreakdown?.total || 0));
    if (!fps && !device.detectorStatus && !device.detectorUpdatedAt) return "";
    return `RF-DETR web${fps ? ` ${fps}` : ""} - ${vehicleCount} kendaraan${objectCount > vehicleCount ? `, ${objectCount} objek lokal` : ""}`;
  }

  function cameraStatusTime(device: DeviceRecord | null): number {
    return Math.max(device?.cameraUpdatedAt || 0, device?.detectorUpdatedAt || 0, device?.lastSeen || 0);
  }

  function deviceCameraIsLive(device: DeviceRecord | null): boolean {
    if (!device) return false;
    if (!deviceIsOnline(device)) return false;
    ensurePublicCameraHealth(device);
    const publicHealth = publicCameraHealthFor(device);
    if (publicCameraNeedsProbe(device)) {
      if (!publicHealth || publicHealth.checking) return false;
      if (!publicHealth.ok) return false;
    }
    if (device.runtime?.heartbeatAt && isFreshEpoch(device.runtime.heartbeatAt, HARDWARE_HEARTBEAT_STALE_MS)) {
      return Boolean(device.runtime.cameraPublicOk || (isWebRtcSignalingCamera(device) && state.webrtc.status === "live"));
    }
    const freshCamera = cameraTelemetryIsFresh(device);
    const hasPublicMedia = Boolean(publicCameraPageUrl(device) || publicCameraHlsUrl(device));
    return Boolean(
      (hasPublicMedia && (device.cameraStatus?.toLowerCase() === "online" || device.cameraReady))
      ||
      (freshCamera && (device.cameraStatus?.toLowerCase() === "online" || device.cameraReady || hasPublicMedia))
      || (isWebRtcSignalingCamera(device) && state.webrtc.status === "live"),
    );
  }

  function deviceIsOnline(device: DeviceRecord | null): boolean {
    if (!device) return false;
    return device.status === "online" && deviceHeartbeatIsFresh(device);
  }

  function effectiveDeviceStatus(device: DeviceRecord | null): DeviceStatus {
    return deviceIsOnline(device) ? "online" : "offline";
  }

  function usablePublicMediaUrl(value: unknown): string {
    const url = typeof value === "string" ? value.trim() : "";
    if (!url) return "";
    if (/^https?:\/\/(?:127\.0\.0\.1|0\.0\.0\.0|localhost)(?::|\/|$)/i.test(url)) return "";
    return url;
  }

  function hlsPageUrl(value: string): string {
    if (!value) return "";
    try {
      const url = new URL(value, window.location.href);
      if (/\/index\.m3u8$/i.test(url.pathname)) {
        url.pathname = url.pathname.replace(/index\.m3u8$/i, "");
        return url.toString();
      }
    } catch {
      // Keep the caller fallback empty when URL parsing fails.
    }
    return "";
  }

  function hlsPlaylistUrl(value: string): string {
    const clean = value.trim();
    if (!clean) return "";
    if (/\.m3u8(\?|$)/i.test(clean)) return clean;
    const [base, query = ""] = clean.split("?");
    const playlist = `${base.replace(/\/?$/, "/")}index.m3u8`;
    return query ? `${playlist}?${query}` : playlist;
  }

  function cameraEmbedUrl(value: string): string {
    if (!value || isLikelyImageUrl(value)) return value;
    try {
      const url = new URL(value, window.location.href);
      url.searchParams.set("controls", "false");
      url.searchParams.set("muted", "true");
      url.searchParams.set("autoplay", "true");
      url.searchParams.set("playsinline", "true");
      url.searchParams.set("disablepictureinpicture", "true");
      return url.toString();
    } catch {
      return value;
    }
  }

  function cameraFramePageUrl(device: DeviceRecord | null): string {
    const hlsUrl = publicCameraHlsUrl(device);
    if (hlsUrl) return publicCameraPageUrl(device) || hlsPageUrl(hlsUrl) || hlsUrl;
    const url = publicCameraPageUrl(device);
    return url && !isLikelyImageUrl(url) ? url : "";
  }

  function syncOpenCameraFrameUrls(device: DeviceRecord | null = state.device): void {
    const pageUrl = cameraFramePageUrl(device);
    if (!pageUrl) return;
    const nextSrc = cameraEmbedUrl(pageUrl);
    document.querySelectorAll<HTMLIFrameElement>(
      ".camera-popup iframe, #video-fullscreen-modal iframe, #m-its-scroll iframe",
    ).forEach((iframe) => {
      if (iframe.src !== nextSrc) {
        iframe.src = nextSrc;
      }
    });
  }

  function isLikelyHlsUrl(url: string): boolean {
    return /\.m3u8(\?|$)/i.test(url);
  }

  function isLikelyImageUrl(url: string): boolean {
    return /^data:image/i.test(url) || /\.(mjpg|mjpeg|jpg|jpeg|png|webp)(\?|$)/i.test(url);
  }

  function prefersWebRtcCamera(device: DeviceRecord | null): boolean {
    return Boolean(device && (device.cameraMode === "webrtc" || device.webrtcEnabled || device.cameraReady));
  }

  function cameraModeFor(device: DeviceRecord | null): CameraMode | null {
    if (!device) return null;
    if (publicCameraPageUrl(device) || publicCameraHlsUrl(device)) return device.cameraMode === "webrtc" ? "mjpeg" : device.cameraMode || "mjpeg";
    if (prefersWebRtcCamera(device)) return "webrtc";
    return null;
  }

  function isWebRtcSignalingCamera(device: DeviceRecord | null): boolean {
    return cameraModeFor(device) === "webrtc";
  }

  function webRtcSignalPath(device: DeviceRecord): string {
    return (device.webrtcPath?.trim() || `${WEBRTC_SIGNAL_ROOT}/${device.id}`).replace(/^\/+|\/+$/g, "");
  }

  function firebaseDbUrl(path: string): string {
    const encoded = path
      .split("/")
      .filter(Boolean)
      .map((part) => encodeURIComponent(part))
      .join("/");
    return `${FIREBASE_ROOT_URL}/${encoded}.json`;
  }

  async function firebaseGetPath<T>(path: string): Promise<T | null> {
    const res = await fetch(firebaseDbUrl(path), { cache: "no-store" });
    if (!res.ok) throw new Error(`Firebase GET ${path} failed: HTTP ${res.status}`);
    const text = await res.text();
    if (!text || text === "null") return null;
    return JSON.parse(text) as T;
  }

  async function firebaseWritePath(method: "PUT" | "PATCH" | "DELETE", path: string, payload?: unknown): Promise<void> {
    const res = await fetch(firebaseDbUrl(path), {
      method,
      headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Firebase ${method} ${path} failed: HTTP ${res.status}`);
  }

  function browserViewerId(): string {
    const storageKey = "its-webrtc-viewer-id";
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) return existing;
    const random = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const id = `viewer-${random.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    window.sessionStorage.setItem(storageKey, id);
    return id;
  }

  function newWebRtcSessionId(deviceId: string): string {
    const random = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const safeDeviceId = deviceId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${safeDeviceId}-${random.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  }

  function webRtcSessionPath(): string {
    return `${state.webrtc.signalPath}/sessions/${state.webrtc.sessionId}`;
  }

  function webRtcStatusText(): string {
    if (state.webrtc.status === "live") return "Live WebRTC";
    if (state.webrtc.status === "failed") return state.webrtc.message || "WebRTC gagal tersambung";
    if (state.webrtc.status === "connecting") return state.webrtc.message || "Menghubungkan WebRTC...";
    return "Menunggu kamera WebRTC";
  }

  function updateWebRtcStatusElements(): void {
    const text = webRtcStatusText();
    document.querySelectorAll<HTMLElement>("[data-webrtc-status]").forEach((el) => {
      el.textContent = text;
      el.dataset.status = state.webrtc.status;
    });
    document.querySelectorAll<HTMLElement>("[data-webrtc-dot]").forEach((el) => {
      el.dataset.status = state.webrtc.status;
    });
    state.cameraButton?.classList.toggle("camera-live", state.webrtc.status === "live");
    state.cameraButton?.classList.toggle("camera-failed", state.webrtc.status === "failed");
  }

  function setWebRtcStatus(status: WebRtcStatus, message = ""): void {
    state.webrtc.status = status;
    state.webrtc.message = message;
    updateWebRtcStatusElements();
  }

  function attachWebRtcStream(): void {
    const stream = state.webrtc.stream;
    document.querySelectorAll<HTMLVideoElement>("video[data-webrtc-camera]").forEach((video) => {
      if (video.dataset.webrtcCamera !== state.webrtc.deviceId) return;
      if (video.dataset.customVideoEvents !== "true") {
        video.dataset.customVideoEvents = "true";
        video.addEventListener("play", () => syncCustomVideoButtons(document));
        video.addEventListener("pause", () => syncCustomVideoButtons(document));
      }
      if (stream && video.srcObject !== stream) video.srcObject = stream;
      if (stream) void video.play().catch(() => { /* autoplay may wait for user interaction */ });
    });
    updateWebRtcStatusElements();
  }

  function resetWebRtcRuntime(): void {
    Object.assign(state.webrtc, {
      pc: null,
      deviceId: "",
      signalPath: "",
      sessionId: "",
      stream: null,
      pollTimer: 0,
      heartbeatTimer: 0,
      candidateSeq: 0,
      seenCameraCandidates: new Set<string>(),
      pendingCandidates: [],
      sessionReady: false,
      startedAt: 0,
      status: "idle" as WebRtcStatus,
      message: "",
    });
  }

  function stopWebRtcSession(removeRemote = true): void {
    const sessionPath = state.webrtc.signalPath && state.webrtc.sessionId ? webRtcSessionPath() : "";
    window.clearInterval(state.webrtc.pollTimer);
    window.clearInterval(state.webrtc.heartbeatTimer);
    if (removeRemote && sessionPath) {
      void firebaseWritePath("PATCH", sessionPath, {
        viewerStatus: "closed",
        updatedAt: Date.now(),
      })
        .finally(() => {
          void firebaseWritePath("DELETE", sessionPath).catch(() => { /* ignore cleanup errors */ });
        })
        .catch(() => { /* ignore cleanup errors */ });
    }
    state.webrtc.pc?.close();
    state.webrtc.stream?.getTracks().forEach((track) => track.stop());
    document.querySelectorAll<HTMLVideoElement>("video[data-webrtc-camera]").forEach((video) => {
      video.srcObject = null;
    });
    resetWebRtcRuntime();
    updateWebRtcStatusElements();
  }

  async function sendViewerCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!state.webrtc.signalPath || !state.webrtc.sessionId) return;
    if (!state.webrtc.sessionReady) {
      state.webrtc.pendingCandidates.push(candidate);
      return;
    }
    state.webrtc.candidateSeq += 1;
    const key = `${Date.now()}_${state.webrtc.candidateSeq}`;
    await firebaseWritePath("PUT", `${webRtcSessionPath()}/viewerCandidates/${key}`, candidate);
  }

  function flushPendingViewerCandidates(): void {
    const pending = state.webrtc.pendingCandidates.splice(0);
    pending.forEach((candidate) => {
      void sendViewerCandidate(candidate).catch((err) => console.warn("[ITS] WebRTC candidate failed:", err));
    });
  }

  async function pollWebRtcSession(): Promise<void> {
    const pc = state.webrtc.pc;
    if (!pc || !state.webrtc.sessionId) return;
    const session = await firebaseGetPath<WebRtcSessionRecord>(webRtcSessionPath());
    if (!session) return;

    if (session.streamerStatus === "failed") {
      throw new Error(session.streamerError || "Streamer Raspberry gagal membuat answer");
    }

    if (session.answer && !pc.currentRemoteDescription) {
      await pc.setRemoteDescription(session.answer);
      setWebRtcStatus("connecting", "Answer diterima, membuka jalur video...");
    }

    if (session.cameraCandidates && typeof session.cameraCandidates === "object") {
      for (const [key, candidate] of Object.entries(session.cameraCandidates)) {
        if (state.webrtc.seenCameraCandidates.has(key)) continue;
        state.webrtc.seenCameraCandidates.add(key);
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    }

    if (!pc.currentRemoteDescription && Date.now() - state.webrtc.startedAt > WEBRTC_ANSWER_TIMEOUT_MS) {
      throw new Error("Timeout menunggu answer WebRTC dari Raspberry Pi");
    }
  }

  async function startWebRtcSession(device: DeviceRecord): Promise<void> {
    if (!isWebRtcSignalingCamera(device)) return;
    if (!("RTCPeerConnection" in window)) {
      setWebRtcStatus("failed", "Browser tidak mendukung WebRTC");
      return;
    }
    if (state.webrtc.pc && state.webrtc.deviceId === device.id && state.webrtc.status !== "failed") {
      attachWebRtcStream();
      return;
    }

    stopWebRtcSession(true);
    const signalPath = webRtcSignalPath(device);
    const sessionId = newWebRtcSessionId(device.id);
    const pc = new RTCPeerConnection({ iceServers: WEBRTC_ICE_SERVERS });

    Object.assign(state.webrtc, {
      pc,
      deviceId: device.id,
      signalPath,
      sessionId,
      stream: null,
      pollTimer: 0,
      heartbeatTimer: 0,
      candidateSeq: 0,
      seenCameraCandidates: new Set<string>(),
      pendingCandidates: [],
      sessionReady: false,
      startedAt: Date.now(),
      status: "connecting" as WebRtcStatus,
      message: "Mengirim offer ke Raspberry Pi...",
    });
    updateWebRtcStatusElements();

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      state.webrtc.stream = remoteStream || new MediaStream([event.track]);
      setWebRtcStatus("live");
      attachWebRtcStream();
    };
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      void sendViewerCandidate(event.candidate.toJSON()).catch((err) => {
        console.warn("[ITS] WebRTC ICE candidate publish failed:", err);
      });
    };
    pc.onconnectionstatechange = () => {
      void firebaseWritePath("PATCH", webRtcSessionPath(), {
        viewerConnectionState: pc.connectionState,
        viewerSeenAt: Date.now(),
        updatedAt: Date.now(),
      }).catch(() => { /* ignore heartbeat errors */ });
      if (pc.connectionState === "connected") setWebRtcStatus("live");
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        setWebRtcStatus("failed", `Koneksi WebRTC ${pc.connectionState}`);
      }
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!pc.localDescription) throw new Error("Local WebRTC offer kosong");

      await firebaseWritePath("PUT", webRtcSessionPath(), {
        deviceId: device.id,
        sessionId,
        viewerId: browserViewerId(),
        viewerStatus: "offer-sent",
        viewerSeenAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        offer: {
          type: pc.localDescription.type,
          sdp: pc.localDescription.sdp,
        },
      });

      state.webrtc.sessionReady = true;
      flushPendingViewerCandidates();
      state.webrtc.pollTimer = window.setInterval(() => {
        void pollWebRtcSession().catch((err) => {
          console.warn("[ITS] WebRTC poll failed:", err);
          setWebRtcStatus("failed", err instanceof Error ? err.message : "WebRTC poll gagal");
        });
      }, WEBRTC_POLL_MS);
      state.webrtc.heartbeatTimer = window.setInterval(() => {
        void firebaseWritePath("PATCH", webRtcSessionPath(), {
          viewerStatus: "watching",
          viewerSeenAt: Date.now(),
          updatedAt: Date.now(),
        }).catch(() => { /* ignore heartbeat errors */ });
      }, WEBRTC_HEARTBEAT_MS);
      await pollWebRtcSession();
    } catch (err) {
      console.warn("[ITS] WebRTC start failed:", err);
      setWebRtcStatus("failed", err instanceof Error ? err.message : "WebRTC gagal dimulai");
    }
  }

  function syncCameraViews(device: DeviceRecord | null = state.device): void {
    if (!device || !isWebRtcSignalingCamera(device)) {
      if (!device || state.webrtc.deviceId !== device.id) stopWebRtcSession(true);
      return;
    }
    if (state.webrtc.pc && state.webrtc.deviceId === device.id && state.webrtc.status !== "failed") {
      attachWebRtcStream();
      return;
    }
    void startWebRtcSession(device);
  }

  function renderWebRtcSurface(device: DeviceRecord, videoClass: string): string {
    const status = escapeHtml(webRtcStatusText());
    return `
  <div class="webrtc-video-wrap">
    <video class="${videoClass} webrtc-video" data-webrtc-camera="${escapeHtml(device.id)}" autoplay playsinline muted></video>
    <div class="webrtc-status-bar">
      <span class="webrtc-dot" data-webrtc-dot data-status="${state.webrtc.status}"></span>
      <span data-webrtc-status data-status="${state.webrtc.status}">${status}</span>
    </div>
  </div>
`;
  }

  function renderCameraSurface(device: DeviceRecord | null, imageClass: string, frameClass: string): string {
    ensurePublicCameraHealth(device);
    const hlsUrl = publicCameraHlsUrl(device);
    if (hlsUrl) {
      const pageUrl = publicCameraPageUrl(device) || hlsPageUrl(hlsUrl) || hlsUrl;
      return `<div class="hls-video-wrap">
      <video class="${imageClass} hls-video" data-hls-video data-src="${escapeHtml(hlsUrl)}" data-page-src="${escapeHtml(pageUrl)}" crossorigin="anonymous" autoplay playsinline muted></video>
      <iframe class="${frameClass} hls-fallback-frame" data-hls-iframe src="${escapeHtml(cameraEmbedUrl(pageUrl))}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" referrerpolicy="no-referrer" hidden></iframe>
      <div class="hls-video-message" data-hls-message hidden></div>
    </div>`;
    }
    const url = publicCameraPageUrl(device);
    if (url) {
      return isLikelyImageUrl(url)
        ? `<img class="${imageClass}" src="${escapeHtml(url)}" alt="Camera preview" crossorigin="anonymous">`
        : `<iframe class="${frameClass}" src="${escapeHtml(cameraEmbedUrl(url))}" allow="autoplay; camera; microphone; fullscreen; encrypted-media; picture-in-picture" referrerpolicy="no-referrer"></iframe>`;
    }
    if (device && isWebRtcSignalingCamera(device)) return renderWebRtcSurface(device, imageClass);
    return "";
  }

  function setupHlsVideos(root: ParentNode = document): void {
    root.querySelectorAll<HTMLVideoElement>("video[data-hls-video]").forEach((video) => setupHlsVideo(video));
  }

  function setupHlsVideo(video: HTMLVideoElement): void {
    const src = video.dataset.src || "";
    if (!src) return;
    const playlist = hlsPlaylistUrl(src);
    if (!playlist) return;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = "auto";
    if (video.dataset.hlsReady === "true") {
      playHlsVideo(video);
      return;
    }
    video.dataset.hlsReady = "true";
    const hide = () => hideHlsMessage(video);
    video.addEventListener("loadedmetadata", hide);
    video.addEventListener("loadeddata", hide);
    video.addEventListener("canplay", hide);
    video.addEventListener("playing", hide);
    video.addEventListener("play", () => syncCustomVideoButtons(document));
    video.addEventListener("pause", () => syncCustomVideoButtons(document));
    video.addEventListener("error", () => {
      showHlsMessage(video, "HLS live sedang disambungkan ulang...");
      scheduleHlsRetry(video, playlist);
    });

    if (shouldUseNativeHls(video)) {
      video.src = playlist;
      playHlsVideo(video);
      return;
    }

    void loadHlsScript().then(() => {
      const Hls = (window as any).Hls;
      if (!Hls?.isSupported?.()) {
        video.src = playlist;
        playHlsVideo(video);
        return;
      }
      const hls = new Hls({
        lowLatencyMode: false,
        capLevelToPlayerSize: true,
        backBufferLength: 12,
        maxBufferLength: 18,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 8,
        manifestLoadingMaxRetry: 4,
        levelLoadingMaxRetry: 4,
        fragLoadingMaxRetry: 4,
      });
      state.hlsInstances.set(video, hls);
      hls.attachMedia(video);
      hls.on?.(Hls.Events.MEDIA_ATTACHED, () => {
        hls.loadSource(playlist);
      });
      hls.on?.(Hls.Events.MANIFEST_PARSED, () => {
        video.dataset.hlsFatalCount = "0";
        playHlsVideo(video);
      });
      hls.on?.(Hls.Events.LEVEL_LOADED, hide);
      hls.on?.(Hls.Events.FRAG_BUFFERED, hide);
      hls.on?.(Hls.Events.ERROR, (_event: unknown, data: { fatal?: boolean; type?: string }) => {
        if (!data?.fatal) return;
        const fatalCount = Number(video.dataset.hlsFatalCount || 0) + 1;
        video.dataset.hlsFatalCount = String(fatalCount);
        showHlsMessage(video, "HLS live sedang disambungkan ulang...", fatalCount >= 5);
        if (data.type === Hls.ErrorTypes?.NETWORK_ERROR) {
          try { hls.startLoad?.(); } catch { /* retry below */ }
        } else if (data.type === Hls.ErrorTypes?.MEDIA_ERROR) {
          try { hls.recoverMediaError?.(); } catch { /* retry below */ }
        }
        scheduleHlsRetry(video, cacheBustMediaUrl(playlist, Date.now()));
      });
      playHlsVideo(video);
    }).catch((err) => {
      console.warn("[ITS] HLS script failed:", err);
      video.src = playlist;
      showHlsMessage(video, "hls.js tidak tersedia, mencoba native HLS...");
      playHlsVideo(video);
    });
  }

  function playHlsVideo(video: HTMLVideoElement): void {
    void video.play().then(() => {
      hideHlsMessage(video);
      syncCustomVideoButtons(document);
    }).catch(() => {
      showHlsMessage(video, "Ketuk tombol play jika browser menahan autoplay.");
      syncCustomVideoButtons(document);
    });
  }

  function shouldUseNativeHls(video: HTMLVideoElement): boolean {
    const canPlay = video.canPlayType("application/vnd.apple.mpegurl");
    if (!canPlay) return false;
    const ua = navigator.userAgent;
    const isAppleNative = /\b(Safari|iPhone|iPad|iPod)\b/i.test(ua)
      && !/\b(Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS)\b/i.test(ua);
    return isAppleNative;
  }

  function scheduleHlsRetry(video: HTMLVideoElement, playlist: string): void {
    const existing = Number(video.dataset.hlsRetryTimer || 0);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      const hls = state.hlsInstances.get(video);
      try {
        if (hls?.loadSource) {
          hls.stopLoad?.();
          hls.loadSource(playlist);
          hls.startLoad?.(-1);
        }
        else if (hls?.startLoad) hls.startLoad(-1);
        else {
          video.src = playlist;
          video.load();
        }
        void video.play().catch(() => undefined);
      } catch (err) {
        console.warn("[ITS] HLS retry failed:", err);
      }
    }, 4500);
    video.dataset.hlsRetryTimer = String(timer);
  }

  function showHlsMessage(video: HTMLVideoElement, message: string, revealFallback = false): void {
    const wrap = video.closest<HTMLElement>(".hls-video-wrap");
    const messageEl = wrap?.querySelector<HTMLElement>("[data-hls-message]");
    const iframe = wrap?.querySelector<HTMLIFrameElement>("[data-hls-iframe]");
    const pageUrl = cameraEmbedUrl(usablePublicMediaUrl(video.dataset.pageSrc) || hlsPageUrl(video.dataset.src || ""));
    if (revealFallback && iframe && pageUrl) {
      if (iframe.src !== pageUrl) iframe.src = pageUrl;
      iframe.hidden = false;
      video.classList.add("hls-fallback-hidden");
    }
    if (messageEl) {
      messageEl.hidden = false;
      messageEl.textContent = message;
    }
  }

  function hideHlsMessage(video: HTMLVideoElement): void {
    const wrap = video.closest<HTMLElement>(".hls-video-wrap");
    const messageEl = wrap?.querySelector<HTMLElement>("[data-hls-message]");
    const iframe = wrap?.querySelector<HTMLIFrameElement>("[data-hls-iframe]");
    video.classList.remove("hls-fallback-hidden");
    if (iframe) iframe.hidden = true;
    if (messageEl) messageEl.hidden = true;
  }

  function loadHlsScript(): Promise<void> {
    if ((window as any).Hls) return Promise.resolve();
    if (state.hlsScriptPromise) return state.hlsScriptPromise;
    state.hlsScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = HLS_JS_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("hls.js load failed"));
      document.head.appendChild(script);
    });
    return state.hlsScriptPromise;
  }

  function stopHlsVideos(root: ParentNode): void {
    root.querySelectorAll<HTMLVideoElement>("video[data-hls-video]").forEach((video) => {
      const timer = Number(video.dataset.hlsRetryTimer || 0);
      if (timer) window.clearTimeout(timer);
      const hls = state.hlsInstances.get(video);
      if (hls?.destroy) {
        try { hls.destroy(); } catch { /* ignore */ }
      }
      state.hlsInstances.delete(video);
      video.pause();
      video.removeAttribute("src");
      video.load();
    });
  }

  function playSvg(): string {
    return `<svg viewBox="0 0 20 20" fill="none" width="16" height="16" aria-hidden="true"><path d="M7 5.5v9l7-4.5-7-4.5Z" fill="currentColor"/></svg>`;
  }

  function pauseSvg(): string {
    return `<svg viewBox="0 0 20 20" fill="none" width="16" height="16" aria-hidden="true"><path d="M6 5h3v10H6V5Zm5 0h3v10h-3V5Z" fill="currentColor"/></svg>`;
  }

  function fullscreenSvg(): string {
    return `<svg viewBox="0 0 16 16" fill="none" width="15" height="15" aria-hidden="true">
      <path d="M1.5 6V1.5H6M10 1.5h4.5V6M14.5 10v4.5H10M6 14.5H1.5V10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    </svg>`;
  }

  function fullscreenExitSvg(): string {
    return `<svg viewBox="0 0 16 16" fill="none" width="15" height="15" aria-hidden="true">
      <path d="M6 1.5V6H1.5M14.5 6H10V1.5M10 14.5V10h4.5M1.5 10H6v4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    </svg>`;
  }

  function cameraAiIconSvg(): string {
    return `<svg viewBox="0 0 28 28" fill="none" width="24" height="24" aria-hidden="true">
      <path d="M5 10.5h3.1l1.6-2.2h5.2l1.6 2.2H20a3 3 0 0 1 3 3V19a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3v-5.5a3 3 0 0 1 3-3Z" fill="currentColor" opacity=".96"/>
      <circle cx="12.5" cy="16.2" r="4.1" fill="#fff" opacity=".92"/>
      <circle cx="12.5" cy="16.2" r="2.2" fill="#0f172a" opacity=".72"/>
      <path d="M22.2 3.2l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8.8-2.1Z" fill="#38bdf8"/>
      <path d="M18.2 5.2l.45 1.1 1.1.45-1.1.45-.45 1.1-.45-1.1-1.1-.45 1.1-.45.45-1.1Z" fill="#facc15"/>
    </svg>`;
  }

  function cameraPlainIconSvg(): string {
    return `<svg viewBox="0 0 24 24" fill="none" width="24" height="24" aria-hidden="true">
      <path d="M4 8.5h3.1l1.55-2h6.7l1.55 2H20a2 2 0 0 1 2 2v6.8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6.8a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      <circle cx="12" cy="14" r="3.3" stroke="currentColor" stroke-width="1.8"/>
    </svg>`;
  }

  function cameraImageIconSvg(): string {
    return `<svg viewBox="0 0 24 24" fill="none" width="24" height="24" aria-hidden="true">
      <rect x="4" y="5" width="16" height="14" rx="2" stroke="currentColor" stroke-width="1.8"/>
      <circle cx="9" cy="10" r="1.5" fill="currentColor"/>
      <path d="M6.8 16.2l3.1-3.1 2.5 2.2 2.1-2.1 2.7 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  function clockIconSvg(): string {
    return `<svg viewBox="0 0 16 16" fill="none" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="5.6" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.8v3.5l2.2 1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  }

  function pinIconSvg(): string {
    return `<svg viewBox="0 0 16 16" fill="none" width="14" height="14" aria-hidden="true"><path d="M8 14s4.5-4 4.5-7.2A4.4 4.4 0 0 0 8 2.4a4.4 4.4 0 0 0-4.5 4.4C3.5 10 8 14 8 14Z" stroke="currentColor" stroke-width="1.45"/><circle cx="8" cy="6.8" r="1.6" stroke="currentColor" stroke-width="1.45"/></svg>`;
  }

  function customVideoRoot(button: HTMLElement): ParentNode {
    return button.closest(".video-fullscreen-stage, .m-its-camera-box, .camera-card, .custom-video-card") || document;
  }

  function applyVideoAmbientFromSnapshot(host: HTMLElement, device: DeviceRecord | null): void {
    const liveVideo = Array.from(host.querySelectorAll<HTMLVideoElement>("video"))
      .find((video) => !video.classList.contains("hls-fallback-hidden")
        && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        && video.videoWidth > 0
        && video.videoHeight > 0);
    if (liveVideo && applyVideoAmbientFromSource(host, liveVideo)) return;

    const src = latestCameraSnapshot(device);
    if (!src) return;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      applyVideoAmbientFromSource(host, image);
    };
    image.src = src;
  }

  function applyVideoAmbientFromSource(host: HTMLElement, source: CanvasImageSource): boolean {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 48;
      canvas.height = 27;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return false;
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const regions = [
        { r: 0, g: 0, b: 0, weight: 0 },
        { r: 0, g: 0, b: 0, weight: 0 },
        { r: 0, g: 0, b: 0, weight: 0 },
      ];
      for (let i = 0; i < data.length; i += 16) {
        const alpha = data[i + 3] / 255;
        if (alpha < 0.12) continue;
        const cr = data[i];
        const cg = data[i + 1];
        const cb = data[i + 2];
        const luminance = cr * 0.2126 + cg * 0.7152 + cb * 0.0722;
        if (luminance < 4) continue;
        const max = Math.max(cr, cg, cb);
        const min = Math.min(cr, cg, cb);
        const chroma = max - min;
        const pixel = i / 4;
        const x = pixel % canvas.width;
        const y = Math.floor(pixel / canvas.width);
        const region = x < canvas.width * 0.38 ? 0 : x > canvas.width * 0.62 ? 1 : y > canvas.height * 0.52 ? 2 : -1;
        if (region < 0) continue;
        const weight = 0.18 + chroma / 150 + luminance / 420;
        regions[region].r += cr * weight;
        regions[region].g += cg * weight;
        regions[region].b += cb * weight;
        regions[region].weight += weight;
      }
      const populated = regions.filter((region) => region.weight > 0);
      if (!populated.length) return false;
      const fallback = populated[0];
      regions.forEach((region, index) => {
        const value = region.weight > 0 ? region : fallback;
        host.style.setProperty(`--video-ambient-${String.fromCharCode(97 + index)}`, `rgb(${Math.round(value.r / value.weight)}, ${Math.round(value.g / value.weight)}, ${Math.round(value.b / value.weight)})`);
      });
      return true;
    } catch {
      // Cross-origin frames can reject canvas sampling; keep the fallback ambient color.
      return false;
    }
  }

  function syncCustomVideoButtons(root: ParentNode = document): void {
    root.querySelectorAll<HTMLButtonElement>("[data-custom-video-play]").forEach((button) => {
      const scopedRoot = customVideoRoot(button);
      const videos = Array.from(scopedRoot.querySelectorAll<HTMLVideoElement>("video"));
      const iframe = scopedRoot.querySelector<HTMLIFrameElement>("iframe");
      const playing = videos.length
        ? videos.some((video) => !video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)
        : Boolean(iframe && iframe.src && iframe.src !== "about:blank" && !(scopedRoot instanceof HTMLElement && scopedRoot.dataset.videoPaused === "true"));
      button.innerHTML = playing ? pauseSvg() : playSvg();
      button.setAttribute("aria-label", playing ? "Jeda video" : "Putar video");
    });
  }

  function videoSurfaceStatusText(device: DeviceRecord | null): string {
    ensurePublicCameraHealth(device);
    const publicHealth = publicCameraHealthFor(device);
    if (publicCameraNeedsProbe(device)) {
      if (!publicHealth || publicHealth.checking) return "mengecek frame kamera publik...";
      if (!publicHealth.ok) return `tunnel publik belum sehat - ${publicHealth.note}`;
    }
    const rfDetr = cameraRfDetrHeadline(device);
    if (rfDetr) return rfDetr;
    if (device?.runtime?.heartbeatAt && isFreshEpoch(device.runtime.heartbeatAt, HARDWARE_HEARTBEAT_STALE_MS)) {
      if (device.runtime.cameraPublicOk) return `kamera publik online - update ${formatAge(device.runtime.heartbeatAt)}`;
      if (device.runtime.cameraLocalOk) return `kamera lokal online, tunnel publik belum sehat - update ${formatAge(device.runtime.heartbeatAt)}`;
      if (device.runtime.cameraNote) return `${device.runtime.cameraNote} - update ${formatAge(device.runtime.heartbeatAt)}`;
    }
    if (deviceCameraIsLive(device)) return `kamera online - update ${formatAge(cameraStatusTime(device))}`;
    if (isWebRtcSignalingCamera(device)) return webRtcStatusText();
    if (latestCameraSnapshot(device)) return `kamera offline - snapshot terakhir ${formatAge(cameraStatusTime(device))}`;
    return "kamera offline - menunggu frame";
  }

  function renderCameraTile(): void {
    if (!state.cameraPreview) return;
    const device = state.device;
    ensurePublicCameraHealth(device);
    const webrtc = isWebRtcSignalingCamera(device);
    const url = publicCameraPageUrl(device);
    const hlsUrl = publicCameraHlsUrl(device);
    state.cameraPreview.innerHTML = !webrtc && url && !hlsUrl && isLikelyImageUrl(url)
      ? `<img class="camera-thumb-img" src="${escapeHtml(url)}" alt="Camera preview">`
      : device && (webrtc || url || hlsUrl)
        ? `<span class="camera-ai-icon">${cameraPlainIconSvg()}</span><div class="camera-live-badge"><span data-webrtc-dot data-status="${state.webrtc.status}"></span>LIVE</div>`
        : `<span class="camera-ai-icon">${cameraPlainIconSvg()}</span>`;
    syncCameraViews(device);
  }

  // ─── Map actions ────────────────────────────────────────────────

  function beginExplicitMapNavigation(): number {
    state.mapNavigationSeq += 1;
    window.clearTimeout(state.pendingDeviceFocusTimer);
    state.pendingDeviceFocusTimer = 0;
    window.clearTimeout(state.homeNorthTimer);
    state.homeNorthTimer = 0;
    if (state.homeNorthMoveHandler) {
      map.off("moveend", state.homeNorthMoveHandler);
      state.homeNorthMoveHandler = null;
    }
    return state.mapNavigationSeq;
  }

  // Home follows the actively selected controller and is an explicit
  // north-up navigation action, independent from an earlier GPS request.
  function goHome(): void {
    const navigationSeq = beginExplicitMapNavigation();
    const primary = state.device ?? state.devices[0];
    const target = primary
      ? L.latLng(primary.position.lat, primary.position.lng)
      : L.latLng((DEFAULT_CENTER as [number, number])[0], (DEFAULT_CENTER as [number, number])[1]);
    const enforceNorth = () => {
      if (navigationSeq !== state.mapNavigationSeq) return;
      if (Math.abs(normBearing(map.getBearing?.() ?? 0)) > 0.01) map.setBearing(0);
      updateCompass();
    };

    const finishHome = () => {
      if (navigationSeq !== state.mapNavigationSeq) return;
      enforceNorth();
      map.off("moveend", finishHome);
      if (state.homeNorthMoveHandler === finishHome) state.homeNorthMoveHandler = null;
      window.clearTimeout(state.homeNorthTimer);
      state.homeNorthTimer = 0;
    };

    map.stop();
    state.homeNorthMoveHandler = finishHome;
    map.once("moveend", finishHome);
    map.setBearing(0);
    map.setView(target, DEFAULT_ZOOM, { animate: true });
    window.requestAnimationFrame(enforceNorth);
    state.homeNorthTimer = window.setTimeout(finishHome, 700);
    map.closePopup();
  }

  function applyLocatedUser(lat: number, lng: number, accuracy?: number, center = true, source = "gps"): void {
    const latlng: [number, number] = [lat, lng];
    state.lastUserLocation = { lat, lng, accuracy, source, updatedAt: Date.now() };
    if (center) map.setView(latlng, Math.max(map.getZoom(), 16), { animate: true });
    showVehicleMarker(latlng);
    state.vehicleMarker?.bindPopup(`Lokasi Anda${accuracy ? ` ±${Math.round(accuracy)}m` : ""}`);
    if (center) state.vehicleMarker?.openPopup();
    state.vehicleMarker?.getElement()?.setAttribute("title", `Lokasi Anda (${source})`);
    if (isTablet()) createTabletCategoryPanel();
  }

  function requestBrowserPosition(): Promise<GeolocationPosition> {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("browser-geolocation-unavailable"));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 9000,
        maximumAge: 12_000,
      });
    });
  }

  async function requestNativeDesktopPosition(): Promise<NativeLocationResult | null> {
    if (!desktopBridge?.requestWindowsLocation) return null;
    try {
      const result = await desktopBridge.requestWindowsLocation();
      const lat = Number(result?.lat);
      const lng = Number(result?.lng);
      if (result?.ok && Number.isFinite(lat) && Number.isFinite(lng)) return { ...result, lat, lng };
    } catch (err) {
      console.warn("Native Windows location failed:", err);
    }
    return null;
  }

  function startDesktopLocationPolling(): void {
    if (!desktopBridge?.requestWindowsLocation) return;
    window.clearInterval(state.nativeLocationPollTimer);
    state.nativeLocationPollTimer = window.setInterval(() => {
      void requestNativeDesktopPosition().then((result) => {
        if (!result?.ok || typeof result.lat !== "number" || typeof result.lng !== "number") return;
        applyLocatedUser(result.lat, result.lng, result.accuracy, false, result.source || "windows-location");
      });
    }, 5000);
  }

  function startBrowserLocationWatch(): void {
    if (!navigator.geolocation || state.userLocationWatchId !== null) return;
    state.userLocationWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        applyLocatedUser(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, false, "browser-gps");
      },
      () => {
        if (state.userLocationWatchId !== null) {
          navigator.geolocation.clearWatch(state.userLocationWatchId);
          state.userLocationWatchId = null;
        }
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 12000 },
    );
  }

  async function locateUser(): Promise<void> {
    const navigationSeq = beginExplicitMapNavigation();
    const applyLocationWithoutStealingNewerNavigation = (
      lat: number,
      lng: number,
      accuracy: number | undefined,
      source: string,
    ) => {
      applyLocatedUser(lat, lng, accuracy, state.mapNavigationSeq === navigationSeq, source);
    };
    showGlobalNotice("warning", "Mencari lokasi", "Mengambil lokasi terkini dari Windows atau browser...");
    const preferNative = Boolean(desktopBridge?.isElectron && desktopBridge.platform === "win32");
    const native = preferNative ? await requestNativeDesktopPosition() : null;
    if (native?.ok && typeof native.lat === "number" && typeof native.lng === "number") {
      applyLocationWithoutStealingNewerNavigation(native.lat, native.lng, native.accuracy, native.source || "windows-location");
      startDesktopLocationPolling();
      showGlobalNotice("success", "Lokasi aktif", "GPS Windows tersambung dan akan diperbarui berkala.");
      return;
    }

    try {
      const pos = await requestBrowserPosition();
      applyLocationWithoutStealingNewerNavigation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, "browser-gps");
      startBrowserLocationWatch();
      showGlobalNotice("success", "Lokasi aktif", "Lokasi browser tersambung dan bergerak realtime.");
      return;
    } catch {
      const fallbackNative = preferNative ? null : await requestNativeDesktopPosition();
      if (fallbackNative?.ok && typeof fallbackNative.lat === "number" && typeof fallbackNative.lng === "number") {
        applyLocationWithoutStealingNewerNavigation(fallbackNative.lat, fallbackNative.lng, fallbackNative.accuracy, fallbackNative.source || "windows-location");
        startDesktopLocationPolling();
        return;
      }
    }

    showGlobalNotice(
      "error",
      "Lokasi belum tersedia",
      "Aktifkan Location Services Windows lalu izinkan ITS Maps memakai lokasi.",
      desktopBridge?.openLocationSettings
        ? { actionLabel: "Settings lokasi", onAction: () => { void desktopBridge.openLocationSettings?.(); } }
        : undefined,
    );
  }

  function openCameraPreview(): void {
    const device = state.device;
    const anchor = map.getCenter();
    const cameraSurface = renderCameraSurface(device, "camera-image camera-video-popup", "camera-frame");
    const statusText = videoSurfaceStatusText(device);
    const cameraLive = deviceCameraIsLive(device);
    const content = cameraSurface
      ? `<div class="camera-card custom-video-card" data-live-state="${cameraLive ? "online" : "offline"}">
      <div class="custom-video-status">${escapeHtml(statusText || "Menunggu frame video live...")}</div>
      <div class="custom-video-live"><span></span>${cameraLive ? "LIVE" : "OFFLINE"}</div>
      ${cameraSurface}
      <canvas class="camera-rf-detr-canvas" data-video-rf-detr-canvas data-detector-fit="contain" aria-hidden="true"></canvas>
      <div class="camera-popup-controls">
        <button type="button" data-popup-pip aria-label="Picture-in-picture" title="Picture-in-picture">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM12 12h6v5h-6z"/></svg>
        </button>
        <button type="button" data-popup-fullscreen aria-label="Fullscreen">${fullscreenSvg()}</button>
      </div>
    </div>`
      : `<div class="camera-card">
      <div class="camera-placeholder">Camera preview belum tersedia.</div>
      <div class="camera-caption">Controller belum mengirim URL publik atau path WebRTC.</div>
    </div>`;
    L.popup({ className: "camera-popup", closeButton: true, autoPan: true, maxWidth: 320 })
      .setLatLng(anchor).setContent(content).openOn(map);
    setupHlsVideos(document);
    syncCameraViews(device);
    attachWebRtcStream();
    const popupEl = document.querySelector<HTMLElement>(".camera-popup");
    if (popupEl && cameraSurface) {
      drawExistingVideoDetections(popupEl, device);
      drawVideoScannerIfNeeded(popupEl);
      window.setTimeout(() => startVideoBrowserRfDetr(popupEl, device), 550);
    }
    popupEl?.querySelector<HTMLButtonElement>("[data-popup-fullscreen]")
      ?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openVideoFullscreen(device);
      });
    popupEl?.querySelector<HTMLButtonElement>("[data-popup-pip]")
      ?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void openItsVideoPictureInPicture(popupEl, device).then((opened) => {
          if (!opened) showGlobalNotice("warning", "PiP belum tersedia", "Putar video lebih dahulu atau gunakan Chrome/Edge terbaru di desktop.");
        });
      });
    if (popupEl) {
      window.setTimeout(() => registerVideoAutoPictureInPicture(popupEl, device), 320);
      map.once("popupclose", () => unregisterVideoAutoPictureInPicture(popupEl));
    }
    syncCustomVideoButtons(document);
  }

  type VideoRailPanelKind = "title" | "ai" | "segments" | "detail";
  type VideoRfDetrFrameSource = {
    source: HTMLVideoElement | HTMLImageElement;
    drawOverlay: boolean;
    key: string;
    staticImage?: boolean;
  };

  type ItsDocumentPictureInPictureApi = {
    window: Window | null;
    requestWindow: (options?: { width?: number; height?: number }) => Promise<Window>;
  };

  type ItsPictureInPictureMediaSession = MediaSession & {
    setActionHandler: (
      action: "enterpictureinpicture",
      handler: (() => void) | null,
    ) => void;
  };

  let itsVideoPipWindow: Window | null = null;
  let itsVideoPipUpdateTimer = 0;
  let itsAutoPipRoot: HTMLElement | null = null;

  function documentPictureInPictureApi(): ItsDocumentPictureInPictureApi | null {
    return (window as Window & { documentPictureInPicture?: ItsDocumentPictureInPictureApi }).documentPictureInPicture || null;
  }

  function videoPipSnapshot(device: DeviceRecord | null): string {
    if (!device) return WELCOME_SEGMENT;
    return preferredCameraDatasetSnapshot(device.cameraDataset)
      || device.cameraThumbnailUrl?.trim()
      || WELCOME_SEGMENT;
  }

  function videoPipDetectionState(device: DeviceRecord | null): {
    frameWidth: number;
    frameHeight: number;
    detections: RfDetrDetection[];
  } {
    if (state.videoRfDetrCanvasWidth > 0 && state.videoRfDetrCanvasHeight > 0) {
      return {
        frameWidth: state.videoRfDetrCanvasWidth,
        frameHeight: state.videoRfDetrCanvasHeight,
        detections: state.videoRfDetrCanvasDetections,
      };
    }
    return {
      frameWidth: device?.detectorFrameWidth || 0,
      frameHeight: device?.detectorFrameHeight || 0,
      detections: (device?.detections || []).filter((detection) => shouldDisplayDetectionLabel(detection.label)),
    };
  }

  function videoPipDetectionHtml(device: DeviceRecord | null): string {
    const { frameWidth, frameHeight, detections } = videoPipDetectionState(device);
    if (frameWidth <= 0 || frameHeight <= 0 || !detections.length) {
      return state.videoRfDetrCanvasScanning ? '<span class="its-pip-scanner" aria-hidden="true"></span>' : "";
    }
    return detections.slice(0, 12).map((detection) => {
      const left = clamp((detection.x / frameWidth) * 100, 0, 100);
      const top = clamp((detection.y / frameHeight) * 100, 0, 100);
      const width = clamp((detection.width / frameWidth) * 100, 1, 100 - left);
      const height = clamp((detection.height / frameHeight) * 100, 1, 100 - top);
      const label = `${detectionLabel(detection.label)} ${(detection.confidence * 100).toFixed(0)}%`;
      return `<span class="its-pip-box" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%"><b>${escapeHtml(label)}</b></span>`;
    }).join("");
  }

  function videoPipStatsHtml(device: DeviceRecord | null): string {
    const traffic = device ? trafficStateForDevice(device) : null;
    const stats = vehicleStatsForDevice(device, traffic);
    const items = [
      ["Mobil", stats.car],
      ["Motor", stats.motorcycle],
      ["Sepeda", stats.bicycle],
      ["Bus", stats.bus],
      ["Truk", stats.truck],
      ["Total", stats.total],
    ];
    return items.map(([label, value]) => `<div><span>${label}</span><strong>${Number(value)}</strong></div>`).join("");
  }

  function videoPipCss(): string {
    return `
      *{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;background:#080d18;color:#f8fafc;font:12px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
      button{font:inherit}.its-pip{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr);background:#080d18}.its-pip-head{height:42px;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid rgba(148,163,184,.18);background:rgba(8,13,24,.94)}
      .its-pip-head i{width:8px;height:8px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.18)}.its-pip-head strong{min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.its-pip-head small{color:#67e8f9;font-weight:800;white-space:nowrap}
      .its-pip-head button,.its-pip-data-toggle{min-width:40px;min-height:32px;border:1px solid rgba(255,255,255,.18);border-radius:7px;background:#fff;color:#0f172a;font-weight:850;cursor:pointer}.its-pip-head .its-pip-close{width:34px;min-width:34px;padding:0;font-size:19px}
      .its-pip-main{position:relative;min-height:0;display:grid;place-items:center;overflow:hidden}.its-pip-media{position:relative;width:100%;height:100%;min-height:0;background:#020617;overflow:hidden}.its-pip-media video,.its-pip-media img{width:100%;height:100%;display:block;object-fit:fill}.its-pip-media video[hidden],.its-pip-media img[hidden]{display:none}
      .its-pip-overlay{position:absolute;inset:0;pointer-events:none}.its-pip-box{position:absolute;border:2px solid #22d3ee;border-radius:3px;box-shadow:0 0 0 1px rgba(2,6,23,.72)}.its-pip-box b{position:absolute;left:-2px;top:-20px;max-width:170px;padding:3px 5px;border-radius:3px;background:#22d3ee;color:#042f2e;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .its-pip-scanner{position:absolute;left:36%;top:31%;width:28%;height:34%;border:1px solid rgba(34,211,238,.85);border-radius:4px;animation:pipScan 1.45s ease-in-out infinite}.its-pip-scanner:after{content:"";position:absolute;left:8%;right:8%;height:2px;top:12%;background:#67e8f9;box-shadow:0 0 10px #22d3ee;animation:pipLine 1.45s ease-in-out infinite}
      .its-pip-data-toggle{position:absolute;right:10px;bottom:10px;z-index:4;padding:0 12px}.its-pip-stats{position:absolute;left:10px;right:10px;bottom:52px;z-index:3;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;padding:8px;border:1px solid rgba(148,163,184,.24);border-radius:8px;background:rgba(2,6,23,.88);backdrop-filter:blur(10px);opacity:0;transform:translateY(8px);pointer-events:none;transition:opacity .18s ease,transform .18s ease}.its-pip.show-data .its-pip-stats{opacity:1;transform:none}
      .its-pip-stats div{min-width:0;padding:5px 7px;border-radius:5px;background:rgba(30,41,59,.88)}.its-pip-stats span,.its-pip-stats strong{display:block}.its-pip-stats span{color:#94a3b8;font-size:9px;font-weight:800}.its-pip-stats strong{margin-top:2px;font-size:14px}.its-pip-empty{position:absolute;left:10px;bottom:10px;padding:5px 7px;border-radius:5px;background:rgba(2,6,23,.74);color:#cbd5e1;font-size:10px;font-weight:750}
      @keyframes pipScan{0%,100%{opacity:.45;transform:scale(.94)}50%{opacity:1;transform:scale(1)}}@keyframes pipLine{0%{top:12%}50%{top:84%}100%{top:12%}}@media(prefers-reduced-motion:reduce){.its-pip-scanner,.its-pip-scanner:after{animation:none}}
    `;
  }

  function updateItsVideoPip(pipWindow: Window, fallbackDevice: DeviceRecord | null): void {
    if (pipWindow.closed) return;
    const device = deviceForVideoRfDetr() || state.device || fallbackDevice;
    const root = pipWindow.document.querySelector<HTMLElement>(".its-pip");
    const status = pipWindow.document.querySelector<HTMLElement>("[data-pip-ai-status]");
    const live = pipWindow.document.querySelector<HTMLElement>("[data-pip-live]");
    const overlay = pipWindow.document.querySelector<HTMLElement>("[data-pip-detections]");
    const stats = pipWindow.document.querySelector<HTMLElement>("[data-pip-stats]");
    const image = pipWindow.document.querySelector<HTMLImageElement>("[data-pip-image]");
    const detectionState = videoPipDetectionState(device);
    const detected = detectionState.detections.length;
    if (root) root.dataset.detections = String(detected);
    if (status) status.textContent = detected > 0 ? `${detected} objek` : videoAiStatusText(device);
    if (live) live.textContent = deviceCameraIsLive(device) ? "LIVE" : "OFFLINE";
    if (overlay) overlay.innerHTML = videoPipDetectionHtml(device);
    if (stats) stats.innerHTML = videoPipStatsHtml(device);
    if (image && !image.hidden) {
      const nextSource = videoPipSnapshot(device);
      if (image.dataset.source !== nextSource) {
        image.dataset.source = nextSource;
        image.src = nextSource;
      }
    }
  }

  function clearItsVideoPip(pipWindow: Window): void {
    if (itsVideoPipWindow !== pipWindow) return;
    window.clearInterval(itsVideoPipUpdateTimer);
    itsVideoPipUpdateTimer = 0;
    itsVideoPipWindow = null;
  }

  async function openItsVideoPictureInPicture(sourceRoot: HTMLElement, fallbackDevice: DeviceRecord | null): Promise<boolean> {
    if (itsVideoPipWindow && !itsVideoPipWindow.closed) {
      itsVideoPipWindow.focus();
      return true;
    }
    const sourceVideo = activeVideoElement(sourceRoot);
    const api = documentPictureInPictureApi();
    if (api) {
      try {
        const pipWindow = await api.requestWindow({ width: 440, height: 310 });
        itsVideoPipWindow = pipWindow;
        const style = pipWindow.document.createElement("style");
        style.textContent = videoPipCss();
        pipWindow.document.head.appendChild(style);
        pipWindow.document.body.innerHTML = `
          <main class="its-pip">
            <header class="its-pip-head"><i aria-hidden="true"></i><strong>ITS Maps - Kamera AI</strong><small data-pip-live>OFFLINE</small><small data-pip-ai-status>AI siap</small><button class="its-pip-close" type="button" aria-label="Tutup">&times;</button></header>
            <section class="its-pip-main">
              <div class="its-pip-media"><video data-pip-video autoplay muted playsinline hidden></video><img data-pip-image alt="Snapshot kamera AI ITS Maps"><div class="its-pip-overlay" data-pip-detections></div></div>
              <div class="its-pip-stats" data-pip-stats></div>
              <button class="its-pip-data-toggle" type="button" aria-expanded="false">Lihat data</button>
            </section>
          </main>`;
        const root = pipWindow.document.querySelector<HTMLElement>(".its-pip");
        const pipVideo = pipWindow.document.querySelector<HTMLVideoElement>("[data-pip-video]");
        const pipImage = pipWindow.document.querySelector<HTMLImageElement>("[data-pip-image]");
        let attachedVideo = false;
        if (sourceVideo && pipVideo) {
          try {
            const capture = sourceVideo as HTMLVideoElement & { captureStream?: () => MediaStream };
            const stream = capture.captureStream?.();
            if (stream?.getTracks().length) {
              pipVideo.srcObject = stream;
              pipVideo.hidden = false;
              if (pipImage) pipImage.hidden = true;
              await pipVideo.play().catch(() => undefined);
              attachedVideo = true;
            }
          } catch {
            attachedVideo = false;
          }
        }
        if (!attachedVideo && pipImage) {
          pipImage.hidden = false;
          const source = videoPipSnapshot(fallbackDevice);
          pipImage.src = source;
          pipImage.dataset.source = source;
        }
        pipWindow.document.querySelector<HTMLButtonElement>(".its-pip-close")?.addEventListener("click", () => pipWindow.close());
        pipWindow.document.querySelector<HTMLButtonElement>(".its-pip-data-toggle")?.addEventListener("click", (event) => {
          const button = event.currentTarget as HTMLButtonElement;
          const expanded = button.getAttribute("aria-expanded") === "true";
          button.setAttribute("aria-expanded", String(!expanded));
          button.textContent = expanded ? "Lihat data" : "Tutup data";
          root?.classList.toggle("show-data", !expanded);
        });
        pipWindow.addEventListener("pagehide", () => clearItsVideoPip(pipWindow), { once: true });
        updateItsVideoPip(pipWindow, fallbackDevice);
        itsVideoPipUpdateTimer = window.setInterval(() => updateItsVideoPip(pipWindow, fallbackDevice), 600);
        return true;
      } catch {
        // A standard video PiP remains available when Document PiP is blocked.
      }
    }
    if (sourceVideo && document.pictureInPictureEnabled && sourceVideo.requestPictureInPicture) {
      try {
        await sourceVideo.requestPictureInPicture();
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  function registerVideoAutoPictureInPicture(sourceRoot: HTMLElement, device: DeviceRecord | null): void {
    itsAutoPipRoot = sourceRoot;
    const video = activeVideoElement(sourceRoot);
    video?.setAttribute("autopictureinpicture", "");
    if (!navigator.mediaSession) return;
    try {
      if (typeof MediaMetadata !== "undefined") {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: "Kamera AI ITS Maps",
          artist: device?.label || "Raspberry Pi",
          album: "ITS Maps realtime",
          artwork: [{ src: ITS_APP_ICON, sizes: "512x512", type: "image/png" }],
        });
      }
      (navigator.mediaSession as ItsPictureInPictureMediaSession).setActionHandler("enterpictureinpicture", () => {
        if (itsAutoPipRoot?.isConnected) void openItsVideoPictureInPicture(itsAutoPipRoot, device);
      });
    } catch {
      // Auto PiP is progressive enhancement controlled by browser permission.
    }
  }

  function unregisterVideoAutoPictureInPicture(sourceRoot: HTMLElement): void {
    if (itsAutoPipRoot !== sourceRoot) return;
    itsAutoPipRoot = null;
    try {
      (navigator.mediaSession as ItsPictureInPictureMediaSession | undefined)?.setActionHandler("enterpictureinpicture", null);
    } catch {
      // Older browsers do not expose the automatic PiP media action.
    }
  }

  function formatVideoOffset(seconds: number): string {
    const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const secs = safe % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
      : `${minutes}:${String(secs).padStart(2, "0")}`;
  }

  function formatVideoInfoClock(value: number): string {
    if (!value) return "Waktu belum tersedia";
    const time = new Intl.DateTimeFormat("id-ID", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Jakarta",
    }).format(new Date(value)).replace(":", ".");
    return `${time} WIB`;
  }

  function conciseVideoStatus(status: string): string {
    const value = status.trim();
    if (!value) return "Menunggu status kamera";
    if (/tunnel publik belum sehat|tunnel.*belum/i.test(value)) return "Tunnel kamera belum tersambung";
    if (/offline|menunggu frame/i.test(value)) return "Menunggu frame video";
    if (/mengecek frame/i.test(value)) return "Memeriksa video publik";
    if (/online|aktif/i.test(value)) return "Kamera aktif";
    return value.length > 48 ? `${value.slice(0, 45).trim()}...` : value;
  }

  function videoInfoDescription(device: DeviceRecord | null): string {
    const ai = cameraRfDetrHeadline(device);
    if (ai) return `${ai}. AI mendokumentasikan perubahan objek sebagai segmen video.`;
    return "Kamera Raspberry menayangkan video realtime dan AI mendokumentasikan perubahan objek sebagai segmen.";
  }

  function videoSourceLink(device: DeviceRecord | null): string {
    return publicCameraHlsUrl(device) || publicCameraPageUrl(device) || publicCameraUrl(device) || "";
  }

  function activeVideoElement(root: ParentNode): HTMLVideoElement | null {
    return Array.from(root.querySelectorAll<HTMLVideoElement>("video"))
      .find((video) => !video.classList.contains("hls-fallback-hidden") && video.readyState >= HTMLMediaElement.HAVE_METADATA)
      || null;
  }

  function videoLiveEdge(video: HTMLVideoElement): number {
    if (video.seekable.length) return video.seekable.end(video.seekable.length - 1);
    return Number.isFinite(video.duration) ? video.duration : video.currentTime;
  }

  function videoBehindLive(video: HTMLVideoElement): boolean {
    return videoLiveEdge(video) - video.currentTime > 2.5;
  }

  function renderVideoSegmentCards(segments: VideoAiSegment[]): string {
    if (!segments.length) return `
      <div class="video-segment-empty">
        <img src="${escapeHtml(WELCOME_SEGMENT)}" alt="Belum ada segmen video AI">
        <strong>Belum ada segmen yang dibuat</strong>
      </div>
    `;
    return segments.map((segment) => `
      <article class="video-segment-card" data-video-segment-id="${escapeHtml(segment.id)}">
        <button type="button" class="video-segment-jump" data-video-segment-seek="${escapeHtml(segment.id)}" aria-label="Buka video pada ${escapeHtml(formatVideoOffset(segment.elapsedSec))}" ${segment.seekable ? "" : "data-snapshot-only=\"true\""}>
          <span class="video-segment-thumb">
            <img src="${escapeHtml(segment.thumbnailUrl)}" alt="Frame deteksi AI ${escapeHtml(formatVideoOffset(segment.elapsedSec))}">
          </span>
        </button>
        <button type="button" class="video-segment-count" data-video-segment-detail="${escapeHtml(segment.id)}" aria-label="Buka rincian ${segment.objectCount} objek">
          <strong>${segment.objectCount} objek</strong>
          <span>${escapeHtml(formatVideoOffset(segment.elapsedSec))}</span>
        </button>
      </article>
    `).join("");
  }

  function renderVideoSegmentDetail(segment: VideoAiSegment): string {
    const summary = historyDetectionSummary(segment.detections);
    const detailRows = segment.detections.map((det, index) => {
      const frameWidth = Math.max(1, segment.frameWidth);
      const frameHeight = Math.max(1, segment.frameHeight);
      const left = Math.round((det.x / frameWidth) * 100);
      const top = Math.round((det.y / frameHeight) * 100);
      const cropWidth = clamp(det.width / frameWidth, 0.01, 1);
      const cropHeight = clamp(det.height / frameHeight, 0.01, 1);
      const thumbWidth = Math.round((1 / cropWidth) * 100);
      const thumbHeight = Math.round((1 / cropHeight) * 100);
      const size = `${Math.round((det.width / frameWidth) * 100)}% x ${Math.round((det.height / frameHeight) * 100)}%`;
      return `
        <li>
          <span class="m-ai-detail-thumb" aria-hidden="true">
            <img src="${escapeHtml(segment.thumbnailUrl)}" alt="" style="width:${thumbWidth}%;height:${thumbHeight}%;transform:translate(-${left}%,-${top}%);">
            <em>${index + 1}</em>
          </span>
          <div>
            <strong>${escapeHtml(detectionLabel(det.label))}</strong>
            <span>Akurasi ${Math.round(det.confidence * 100)}% · area ${escapeHtml(size)} · posisi ${left}%, ${top}%</span>
          </div>
        </li>
      `;
    }).join("");
    return `
      <div class="video-segment-detail-content">
        <img class="video-segment-detail-frame" src="${escapeHtml(segment.thumbnailUrl)}" alt="Frame video hasil deteksi AI">
        <div class="m-ai-detail-total">
          <span>Objek terkonfirmasi</span>
          <strong>${segment.objectCount}</strong>
        </div>
        <div class="m-ai-detail-summary">
          ${summary.map((item) => `<div><span>${escapeHtml(item.label)}</span><strong>${item.count}</strong><em>akurasi maks ${Math.round(item.maxConfidence * 100)}%</em></div>`).join("")}
        </div>
        <ol class="m-ai-detail-list">${detailRows}</ol>
        ${segment.note ? `<p class="video-segment-detail-note">${escapeHtml(segment.note)}</p>` : ""}
      </div>
    `;
  }

  function updateVideoSegmentPanel(root: ParentNode): void {
    const segments = state.videoAiSegments;
    root.querySelectorAll<HTMLElement>("[data-video-segment-preview]").forEach((preview) => {
      preview.innerHTML = renderVideoSegmentCards(segments);
    });
    root.querySelectorAll<HTMLElement>("[data-video-segment-all]").forEach((all) => {
      all.innerHTML = renderVideoSegmentCards(segments);
    });
    root.querySelectorAll<HTMLElement>("[data-video-segment-total]").forEach((count) => {
      count.textContent = String(segments.length);
    });
    root.querySelectorAll<HTMLButtonElement>("[data-video-segments-all]").forEach((viewAll) => {
      viewAll.hidden = false;
    });
  }

  type VideoSegmentSceneChange = "same" | "count" | "label" | "position";

  function videoSegmentSceneChange(
    previous: VideoAiSegment,
    detections: RfDetrDetection[],
    frameWidth: number,
    frameHeight: number,
  ): VideoSegmentSceneChange {
    if (detections.length > previous.detections.length) return "count";
    if (detections.length < previous.detections.length) return "same";
    const previousLabels = previous.detections.map((det) => det.label).sort().join("|");
    const nextLabels = detections.map((det) => det.label).sort().join("|");
    if (previousLabels !== nextLabels) return "label";

    const available = previous.detections.map((det, index) => ({ det, index }));
    const previousWidth = Math.max(1, previous.frameWidth);
    const previousHeight = Math.max(1, previous.frameHeight);
    const nextWidth = Math.max(1, frameWidth);
    const nextHeight = Math.max(1, frameHeight);
    let maximumMovement = 0;

    for (const detection of detections) {
      const nextCenterX = (detection.x + detection.width / 2) / nextWidth;
      const nextCenterY = (detection.y + detection.height / 2) / nextHeight;
      let matchAt = -1;
      let nearestDistance = Number.POSITIVE_INFINITY;
      available.forEach((candidate, candidateIndex) => {
        if (candidate.det.label !== detection.label) return;
        const previousCenterX = (candidate.det.x + candidate.det.width / 2) / previousWidth;
        const previousCenterY = (candidate.det.y + candidate.det.height / 2) / previousHeight;
        const distance = Math.hypot(nextCenterX - previousCenterX, nextCenterY - previousCenterY);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          matchAt = candidateIndex;
        }
      });
      if (matchAt < 0) return "label";
      maximumMovement = Math.max(maximumMovement, nearestDistance);
      available.splice(matchAt, 1);
    }

    return maximumMovement >= 0.1 ? "position" : "same";
  }

  function recordVideoAiSegment(
    overlay: HTMLElement,
    device: DeviceRecord,
    result: BrowserRfDetrResult,
    frameSource: VideoRfDetrFrameSource,
  ): void {
    if (overlay.id !== "video-fullscreen-modal") return;
    const detections = result.detections
      .filter((det) => shouldDisplayDetectionLabel(det.label))
      .map(toWebRfDetrDetection);
    const thumbnailUrl = result.annotatedThumbnailUrl || result.rawThumbnailUrl || "";
    if (!detections.length || !thumbnailUrl) return;
    const video = frameSource.source instanceof HTMLVideoElement ? frameSource.source : null;
    const now = Date.now();
    const playbackTime = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const elapsedSec = Math.max(0, (now - state.videoFullscreenStartedAt) / 1000);
    const previous = state.videoAiSegments.at(-1);
    if (previous) {
      const sceneChange = videoSegmentSceneChange(previous, detections, result.frameWidth, result.frameHeight);
      if (sceneChange === "same") return;
      const minimumInterval = sceneChange === "position" ? 4500 : 1500;
      if (now - previous.createdAt < minimumInterval) return;
    }
    const segment: VideoAiSegment = {
      id: `${device.id}-${now}-${Math.round(playbackTime * 10)}`,
      deviceId: device.id,
      createdAt: now,
      timeSec: playbackTime,
      elapsedSec,
      seekable: Boolean(video && video.seekable.length),
      thumbnailUrl,
      detections,
      objectCount: detections.length,
      vehicleCount: result.vehicleCount,
      frameWidth: result.frameWidth,
      frameHeight: result.frameHeight,
      note: result.note,
      sourceKey: frameSource.key,
    };
    state.videoAiSegments = [...state.videoAiSegments, segment].slice(-36);
    updateVideoSegmentPanel(overlay);
  }

  function enterVideoFocusMode(): void {
    document.body.classList.add("video-focus-mode");
    document.body.classList.remove("video-focus-restoring");
    state.videoFullscreenPausedRefreshMs = Math.max(500, state.config.refreshMs || DEFAULT_CONFIG.refreshMs);
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = 0;
    window.clearInterval(state.trafficRefreshTimer);
    state.trafficRefreshTimer = 0;
    if (state.snapshotHistoryAnimationFrame) cancelAnimationFrame(state.snapshotHistoryAnimationFrame);
    state.snapshotHistoryAnimationFrame = 0;
    map.stop();
    mapRoot.setAttribute("inert", "");
    mapRoot.setAttribute("aria-hidden", "true");
  }

  function leaveVideoFocusMode(): void {
    document.body.classList.remove("video-focus-mode");
    document.body.classList.add("video-focus-restoring");
    mapRoot.removeAttribute("inert");
    mapRoot.removeAttribute("aria-hidden");
    window.setTimeout(() => {
      document.body.classList.remove("video-focus-restoring");
      if (!state.refreshTimer && !document.getElementById("video-fullscreen-modal")) {
        state.refreshTimer = window.setTimeout(refreshSnapshot, Math.min(1200, state.videoFullscreenPausedRefreshMs || 800));
      }
      const historyHost = document.querySelector<HTMLElement>("#m-ai-history-sheet [data-ai-history-content]");
      if (historyHost && aiHistoryActiveTab === "history" && !aiHistoryIsMobileDocked()) {
        startAiHistoryCanvasAnimation(historyHost);
        void analyzeVisibleHistorySnapshots(historyHost);
      }
    }, 420);
  }

  function openVideoFullscreen(device: DeviceRecord | null): void {
    if (document.getElementById("video-fullscreen-modal")) return;
    const mobileVideoMode = isMobile();
    state.videoAiSegments = [];
    state.videoFullscreenStartedAt = Date.now();
    const activeDevice = device ?? state.device ?? null;
    const traffic = activeDevice ? trafficStateForDevice(activeDevice) : null;
    const reusableSurface = document.querySelector<HTMLElement>(
      ".camera-popup .custom-video-card .hls-video-wrap, .camera-popup .custom-video-card .webrtc-video-wrap, .camera-popup .custom-video-card > iframe.camera-frame, .camera-popup .custom-video-card > img.camera-video-popup",
    );
    const reuseParent = reusableSurface?.parentNode || null;
    const reusePlaceholder = reusableSurface ? document.createComment("its-camera-surface-placeholder") : null;
    if (reusableSurface && reuseParent && reusePlaceholder) reuseParent.insertBefore(reusePlaceholder, reusableSurface);
    const surface = reusableSurface ? "" : renderCameraSurface(activeDevice, "video-fullscreen-media", "video-fullscreen-frame");
    const statusText = videoSurfaceStatusText(activeDevice);
    const titleText = cameraTitleText(activeDevice);
    const descriptionText = videoInfoDescription(activeDevice);
    const initialStatusLine = statusText || "AI RF-DETR siap memproses video";
    const compactStatusLine = conciseVideoStatus(initialStatusLine);
    const cameraLive = deviceCameraIsLive(activeDevice);
    const sourceUrl = videoSourceLink(activeDevice);
    const activeAt = cameraStatusTime(activeDevice);
    const activeText = formatVideoInfoClock(activeAt);
    const overlay = document.createElement("div");
    overlay.id = "video-fullscreen-modal";
    const androidBridge = nativeAndroidBridge();
    const nativeOrientation = mobileVideoMode && Boolean(androidBridge?.setVideoFullscreen);
    overlay.className = `video-fullscreen${mobileVideoMode ? " video-fullscreen-mobile" : ""}${nativeOrientation ? " video-native-orientation" : ""}`;
    overlay.style.setProperty("--video-ambient-a", "#0f172a");
    overlay.style.setProperty("--video-ambient-b", "#111827");
    overlay.style.setProperty("--video-ambient-c", "#020617");
    overlay.innerHTML = `
  <div class="video-fullscreen-shell">
    <section class="video-fullscreen-stage" aria-label="Video realtime">
      <div class="video-fullscreen-ambient" aria-hidden="true"></div>
      <div class="video-fullscreen-surface" data-video-surface>
        ${surface || ""}
        <canvas class="video-rf-detr-canvas" data-video-rf-detr-canvas data-detector-fit="contain" aria-hidden="true"></canvas>
      </div>
      <button type="button" class="video-fullscreen-status video-fullscreen-title" data-video-title-toggle aria-expanded="false">
        <span class="webrtc-dot" data-status="${state.webrtc.status}"></span>
        <span class="video-fullscreen-title-copy">
          <strong data-video-title-text>${escapeHtml(titleText || "Video Realtime")}</strong>
          <span data-video-title-message aria-live="polite">${escapeHtml(initialStatusLine)}</span>
        </span>
      </button>
      <div class="video-fullscreen-live" data-live-state="${cameraLive ? "online" : "offline"}"><span></span>${cameraLive ? "LIVE" : "OFFLINE"}</div>
      <div class="video-fullscreen-caption" data-video-rf-detr-note hidden>${escapeHtml(initialStatusLine)}</div>
      <div class="video-fullscreen-controls">
        <button type="button" class="video-sync-live" data-video-sync-live hidden>Sinkronkan live</button>
        <button type="button" class="video-fullscreen-ai" data-video-ai>AI</button>
        <button type="button" class="video-fullscreen-pip" data-video-pip aria-label="Picture-in-picture" title="Picture-in-picture">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM12 12h6v5h-6z"/></svg>
        </button>
        <button type="button" class="video-fullscreen-close" data-video-close aria-label="Keluar fullscreen">${fullscreenExitSvg()}</button>
      </div>
    </section>
    <div class="video-panel-rail" data-video-panel-rail>
      <section class="video-fullscreen-description video-title-panel video-rail-panel" data-video-panel="title" data-video-description hidden>
        <div class="video-ai-handle" data-swipe-handle aria-hidden="true"></div>
        <div class="video-title-view" data-video-title-view="info">
          <header class="video-panel-header">
            <strong>Info Video</strong>
            <button type="button" data-video-title-close aria-label="Tutup judul">×</button>
          </header>
          <div class="video-panel-scroll">
            <h2 class="video-info-title">${escapeHtml(titleText || "Video Realtime")}</h2>
            <section class="video-info-facts" aria-label="Aktivitas kamera">
              <div><span>Waktu aktif</span><strong>${escapeHtml(activeText)}</strong></div>
              <div><span>Status</span><strong data-video-status-detail>${escapeHtml(compactStatusLine)}</strong></div>
            </section>
            <section class="video-description-card">
              <p data-video-description-copy>${escapeHtml(descriptionText)}</p>
              ${descriptionText.length > 96 ? `<button type="button" data-video-description-more aria-expanded="false">...Lainnya</button>` : ""}
              ${sourceUrl ? `<a class="video-source-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer"><span>Buka sumber video</span><b aria-hidden="true">↗</b></a>` : ""}
            </section>
            <section class="video-segments-section">
              <header><strong>Segmen AI</strong><button type="button" data-video-segments-all aria-label="Lihat semua segmen">›</button></header>
              <span class="video-segment-total" aria-live="polite"><b data-video-segment-total>0</b> segmen</span>
              <div class="video-segment-list video-segment-list-preview" data-video-segment-preview data-video-segment-scroll>${renderVideoSegmentCards([])}</div>
            </section>
          </div>
        </div>
        <div class="video-title-view" data-video-title-view="segments" hidden>
          <header class="video-panel-header video-segment-page-header">
            <button type="button" data-video-segments-back aria-label="Kembali ke info video">&#8592;</button>
            <strong>Semua Segmen</strong>
            <button type="button" data-video-title-close aria-label="Tutup judul">×</button>
          </header>
          <div class="video-panel-scroll"><div class="video-segment-list video-segment-list-all" data-video-segment-all>${renderVideoSegmentCards([])}</div></div>
        </div>
        <div class="video-title-view" data-video-title-view="detail" hidden>
          <header class="video-panel-header video-segment-page-header">
            <button type="button" data-video-detail-back aria-label="Kembali ke semua segmen">&#8592;</button>
            <strong data-video-mobile-detail-title>Segmen 0:00</strong>
            <button type="button" data-video-title-close aria-label="Tutup judul">×</button>
          </header>
          <div class="video-detection-scroll" data-video-mobile-detail-body></div>
        </div>
      </section>
    <aside class="video-ai-panel video-rail-panel" data-video-panel="ai" aria-label="AI kendaraan" hidden>
      <div class="video-ai-handle" data-swipe-handle aria-hidden="true"></div>
      <header>
        <div>
          <span>AI RF-DETR</span>
          <strong data-video-ai-status>${escapeHtml(videoAiStatusText(activeDevice))}</strong>
        </div>
        <button type="button" data-video-ai-close aria-label="Tutup AI">×</button>
      </header>
      <div data-video-ai-stats>${renderVehicleStatsGrid(activeDevice, traffic, "video-ai-stats")}</div>
    </aside>
    <aside class="video-segments-panel video-detection-panel video-rail-panel" data-video-panel="segments" aria-label="Semua segmen AI" hidden>
      <div class="video-ai-handle" data-swipe-handle aria-hidden="true"></div>
      <header class="video-segment-page-header">
        <button type="button" data-video-segments-panel-back aria-label="Kembali ke info video">&#8592;</button>
        <strong>Semua Segmen</strong>
        <button type="button" data-video-segments-panel-close aria-label="Tutup semua segmen">×</button>
      </header>
      <div class="video-detection-scroll"><div class="video-segment-list video-segment-list-all" data-video-segment-all>${renderVideoSegmentCards([])}</div></div>
    </aside>
    <aside class="video-detection-panel video-rail-panel" data-video-panel="detail" aria-label="Rincian deteksi segmen" hidden>
      <div class="video-ai-handle" data-swipe-handle aria-hidden="true"></div>
      <header class="video-segment-page-header">
        <button type="button" data-video-detail-back aria-label="Kembali ke semua segmen">&#8592;</button>
        <strong data-video-detail-title>Segmen 0:00</strong>
        <button type="button" data-video-detail-close aria-label="Tutup rincian">×</button>
      </header>
      <div class="video-detection-scroll" data-video-detail-body></div>
    </aside>
    </div>
  </div>
`;
    document.body.appendChild(overlay);
    if (nativeOrientation) androidBridge?.setVideoFullscreen?.(true);
    enterVideoFocusMode();
    const fullscreenRequest = overlay.requestFullscreen?.();
    const orientationControl = screen.orientation as ScreenOrientation & {
      lock?: (orientation: string) => Promise<void>;
      unlock?: () => void;
    };
    const lockMobileLandscape = () => {
      if (!mobileVideoMode || !orientationControl.lock) return;
      void orientationControl.lock("landscape").catch(() => undefined);
    };
    if (fullscreenRequest?.then) void fullscreenRequest.then(lockMobileLandscape).catch(lockMobileLandscape);
    else lockMobileLandscape();
    mapRoot.classList.add("hidden");
    document.getElementById("m-bottom-nav")?.classList.add("hidden");

    let scale = 1;
    let ambientTimer = 0;
    let liveSyncTimer = 0;
    let closingVideo = false;
    let handleNativeFullscreenExit = () => undefined;
    const pointers = new Map<number, PointerEvent>();
    let startDistance = 0;
    let startScale = 1;
    let stageSwipeStartY = 0;
    let stageSwipeStartX = 0;
    let stageSwipeY = 0;
    let stageSwipeStartedAt = 0;
    let stageSwipeCandidate = false;
    let segmentPlaybackSelected = false;
    const surfaceEl = overlay.querySelector<HTMLElement>("[data-video-surface]");
    const shellEl = overlay.querySelector<HTMLElement>(".video-fullscreen-shell");
    const panelRail = overlay.querySelector<HTMLElement>("[data-video-panel-rail]");
    const titlePanel = overlay.querySelector<HTMLElement>("[data-video-description]");
    const aiPanel = overlay.querySelector<HTMLElement>(".video-ai-panel");
    const segmentsPanel = overlay.querySelector<HTMLElement>('[data-video-panel="segments"]');
    const detailPanel = overlay.querySelector<HTMLElement>('[data-video-panel="detail"]');
    if (surfaceEl && reusableSurface) {
      reusableSurface.classList.add("video-fullscreen-reused");
      reusableSurface.querySelectorAll("iframe, img, video").forEach((child) => {
        child.classList.add("video-fullscreen-reused-media");
      });
      surfaceEl.prepend(reusableSurface);
    }
    type VideoPanelKind = VideoRailPanelKind;
    const videoPanelOrder: VideoPanelKind[] = [];
    const videoPanels: Record<VideoPanelKind, HTMLElement | null> = {
      title: titlePanel,
      ai: aiPanel,
      segments: segmentsPanel,
      detail: detailPanel,
    };
    const setScale = (next: number) => {
      const clamped = clamp(next, 1, 2.4);
      scale = Math.abs(clamped - 1) < 0.035 ? 1 : clamped;
      (shellEl || overlay).style.setProperty("--video-scale", scale.toFixed(3));
    };
    const setPanelExtent = (open: boolean) => {
      if (!shellEl || !panelRail) return;
      shellEl.style.setProperty("--video-ai-live-width", !open ? "0px" : `${Math.max(0, Math.round(panelRail.getBoundingClientRect().width))}px`);
      shellEl.style.setProperty("--video-ai-live-height", "0px");
    };
    const syncPanelRailWidth = () => {
      const open = videoPanelOrder.length > 0;
      requestAnimationFrame(() => setPanelExtent(open));
    };
    const clearVideoPanelDragStyles = () => {
      Object.values(videoPanels).forEach((panel) => {
        if (!panel) return;
        panel.style.transform = "";
        panel.style.flex = "";
        panel.style.transition = "";
      });
    };
    const syncVideoPanelStack = () => {
      const titleOpen = videoPanelOrder.includes("title");
      const aiOpen = videoPanelOrder.includes("ai");
      const segmentsOpen = videoPanelOrder.includes("segments");
      const detailOpen = videoPanelOrder.includes("detail");
      overlay.classList.toggle("title-open", titleOpen);
      overlay.classList.toggle("ai-open", aiOpen);
      overlay.classList.toggle("segments-open", segmentsOpen);
      overlay.classList.toggle("detail-open", detailOpen);
      overlay.classList.toggle("video-panel-two-open", videoPanelOrder.length > 1);
      titlePanel?.toggleAttribute("hidden", !titleOpen);
      aiPanel?.toggleAttribute("hidden", !aiOpen);
      segmentsPanel?.toggleAttribute("hidden", !segmentsOpen);
      detailPanel?.toggleAttribute("hidden", !detailOpen);
      videoPanelOrder.forEach((kind, index) => {
        const panel = videoPanels[kind];
        if (panel) panel.style.order = String(index + 1);
      });
      const titleButton = overlay.querySelector<HTMLButtonElement>("[data-video-title-toggle]");
      titleButton?.setAttribute("aria-expanded", String(titleOpen));
      syncPanelRailWidth();
    };
    const openVideoPanel = (kind: VideoPanelKind) => {
      if (mobileVideoMode) {
        videoPanelOrder.splice(0, videoPanelOrder.length, kind === "ai" ? "ai" : "title");
        clearVideoPanelDragStyles();
        syncVideoPanelStack();
        if (kind === "ai") {
          drawExistingVideoDetections(overlay, deviceForVideoRfDetr() || activeDevice);
          drawVideoScannerIfNeeded(overlay);
          updateVideoAiPanel(overlay);
          window.setTimeout(() => startVideoBrowserRfDetr(overlay, activeDevice), 120);
        }
        return;
      }
      if (kind === "ai") {
        const detailIndex = videoPanelOrder.indexOf("detail");
        if (detailIndex >= 0) videoPanelOrder.splice(detailIndex, 1);
        const segmentsIndex = videoPanelOrder.indexOf("segments");
        if (segmentsIndex >= 0) videoPanelOrder.splice(segmentsIndex, 1);
      }
      if (kind === "segments" || kind === "detail") {
        const aiIndex = videoPanelOrder.indexOf("ai");
        if (aiIndex >= 0) videoPanelOrder.splice(aiIndex, 1);
        const otherKind: VideoPanelKind = kind === "detail" ? "segments" : "detail";
        const otherIndex = videoPanelOrder.indexOf(otherKind);
        if (otherIndex >= 0) videoPanelOrder.splice(otherIndex, 1);
        if (!videoPanelOrder.includes("title")) videoPanelOrder.unshift("title");
      }
      if (!videoPanelOrder.includes(kind)) videoPanelOrder.push(kind);
      clearVideoPanelDragStyles();
      syncVideoPanelStack();
      if (kind === "ai") {
        drawExistingVideoDetections(overlay, deviceForVideoRfDetr() || activeDevice);
        drawVideoScannerIfNeeded(overlay);
        updateVideoAiPanel(overlay);
        window.setTimeout(() => startVideoBrowserRfDetr(overlay, activeDevice), 120);
      }
    };
    const closeVideoPanel = (kind: VideoPanelKind) => {
      const index = videoPanelOrder.indexOf(kind);
      if (index >= 0) videoPanelOrder.splice(index, 1);
      clearVideoPanelDragStyles();
      syncVideoPanelStack();
      if (kind === "ai") updateVideoAiPanel(overlay);
    };
    const toggleVideoPanel = (kind: VideoPanelKind) => {
      if (videoPanelOrder.includes(kind)) closeVideoPanel(kind);
      else openVideoPanel(kind);
    };
    const closeVideo = () => {
      if (closingVideo) return;
      closingVideo = true;
      document.removeEventListener("fullscreenchange", handleNativeFullscreenExit);
      overlay.classList.remove("open", "ai-open", "title-open", "segments-open", "detail-open");
      window.clearInterval(ambientTimer);
      window.clearInterval(liveSyncTimer);
      unregisterVideoAutoPictureInPicture(overlay);
      stopVideoBrowserRfDetr();
      state.videoAiSegments = [];
      if (!reusableSurface) stopHlsVideos(overlay);
      if (reusableSurface && reuseParent && reusePlaceholder?.parentNode === reuseParent) {
        reuseParent.insertBefore(reusableSurface, reusePlaceholder);
        reuseParent.removeChild(reusePlaceholder);
        reusableSurface.classList.remove("video-fullscreen-reused");
        reusableSurface.querySelectorAll(".video-fullscreen-reused-media").forEach((child) => {
          child.classList.remove("video-fullscreen-reused-media");
        });
      }
      if (document.fullscreenElement === overlay) {
        const fullscreenExit = document.exitFullscreen?.();
        if (fullscreenExit?.catch) void fullscreenExit.catch(() => undefined);
      }
      if (nativeOrientation) androidBridge?.setVideoFullscreen?.(false);
      orientationControl.unlock?.();
      mapRoot.classList.remove("hidden");
      document.getElementById("m-bottom-nav")?.classList.remove("hidden");
      window.setTimeout(() => {
        overlay.remove();
        leaveVideoFocusMode();
      }, 220);
    };
    handleNativeFullscreenExit = () => {
      if (!document.fullscreenElement && overlay.isConnected) closeVideo();
    };
    document.addEventListener("fullscreenchange", handleNativeFullscreenExit);
    const openAi = () => toggleVideoPanel("ai");
    const closeAi = () => closeVideoPanel("ai");
    const closeSegments = () => closeVideoPanel("segments");
    const closeDetail = () => closeVideoPanel("detail");
    let segmentDetailReturnView: "info" | "segments" = "info";
    const closeTitle = () => {
      closeVideoPanel("detail");
      closeVideoPanel("segments");
      closeVideoPanel("title");
      showTitleView("info");
    };
    const showTitleView = (view: "info" | "segments" | "detail") => {
      titlePanel?.querySelectorAll<HTMLElement>("[data-video-title-view]").forEach((element) => {
        element.toggleAttribute("hidden", element.dataset.videoTitleView !== view);
      });
      titlePanel?.classList.toggle("showing-segments", view === "segments");
      titlePanel?.classList.toggle("showing-detail", view === "detail");
    };
    const openSegmentDetail = (segment: VideoAiSegment, returnView: "info" | "segments") => {
      segmentDetailReturnView = returnView;
      if (mobileVideoMode) {
        const body = titlePanel?.querySelector<HTMLElement>("[data-video-mobile-detail-body]");
        const title = titlePanel?.querySelector<HTMLElement>("[data-video-mobile-detail-title]");
        if (body) body.innerHTML = renderVideoSegmentDetail(segment);
        if (title) title.textContent = `Segmen ${formatVideoOffset(segment.elapsedSec)}`;
        openVideoPanel("title");
        showTitleView("detail");
        return;
      }
      const title = detailPanel?.querySelector<HTMLElement>("[data-video-detail-title]");
      const body = detailPanel?.querySelector<HTMLElement>("[data-video-detail-body]");
      if (title) title.textContent = `Segmen ${formatVideoOffset(segment.elapsedSec)}`;
      if (body) body.innerHTML = renderVideoSegmentDetail(segment);
      openVideoPanel("detail");
    };
    const refreshLiveSyncButton = () => {
      const button = overlay.querySelector<HTMLButtonElement>("[data-video-sync-live]");
      const video = activeVideoElement(overlay);
      const behind = Boolean(segmentPlaybackSelected && video && video.seekable.length && videoBehindLive(video));
      if (button) button.hidden = !behind;
      overlay.classList.toggle("video-behind-live", behind);
    };
    const seekVideoSegment = (segment: VideoAiSegment) => {
      const video = activeVideoElement(overlay);
      if (!segment.seekable || !video || !video.seekable.length) {
        state.videoRfDetrNote = "Segmen ini berasal dari snapshot kamera; sumber iframe tidak menyediakan kontrol waktu.";
        updateVideoAiPanel(overlay);
        return;
      }
      const start = video.seekable.start(0);
      const end = video.seekable.end(video.seekable.length - 1);
      video.currentTime = clamp(segment.timeSec, start, Math.max(start, end - 0.05));
      segmentPlaybackSelected = true;
      state.videoRfDetrCanvasWidth = segment.frameWidth;
      state.videoRfDetrCanvasHeight = segment.frameHeight;
      state.videoRfDetrCanvasDetections = segment.detections.map((det) => ({ ...det }));
      state.videoRfDetrCanvasScanning = true;
      void video.play().catch(() => undefined);
      window.setTimeout(refreshLiveSyncButton, 80);
    };

    surfaceEl?.addEventListener("wheel", (event) => {
      event.preventDefault();
      setScale(scale + (event.deltaY < 0 ? 0.08 : -0.08));
    }, { passive: false });
    surfaceEl?.addEventListener("pointerdown", (event) => {
      pointers.set(event.pointerId, event);
      if (pointers.size === 1 && mobileVideoMode && scale === 1) {
        stageSwipeStartX = event.clientX;
        stageSwipeStartY = event.clientY;
        stageSwipeStartedAt = performance.now();
        stageSwipeY = 0;
        stageSwipeCandidate = true;
      }
      try { surfaceEl.setPointerCapture?.(event.pointerId); } catch { /* Pointer may already be released. */ }
      if (pointers.size === 2) {
        stageSwipeCandidate = false;
        stageSwipeY = 0;
        overlay.classList.remove("video-stage-dragging");
        overlay.style.setProperty("--video-swipe-y", "0px");
        overlay.style.setProperty("--video-swipe-opacity", "1");
        const [a, b] = [...pointers.values()];
        startDistance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        startScale = scale;
      }
    });
    surfaceEl?.addEventListener("pointermove", (event) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, event);
      if (pointers.size === 2 && startDistance > 0) {
        event.preventDefault();
        const [a, b] = [...pointers.values()];
        const nextDistance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        setScale(startScale * (nextDistance / startDistance));
      } else if (pointers.size === 1 && stageSwipeCandidate && scale === 1) {
        const dx = event.clientX - stageSwipeStartX;
        const dy = Math.max(0, event.clientY - stageSwipeStartY);
        if (dy > 4 && dy > Math.abs(dx) * 1.12) {
          event.preventDefault();
          stageSwipeY = dy;
          overlay.classList.add("video-stage-dragging");
          overlay.style.setProperty("--video-swipe-y", `${dy.toFixed(1)}px`);
          overlay.style.setProperty("--video-swipe-opacity", `${clamp(1 - dy / Math.max(420, window.innerHeight) * 0.72, 0.28, 1).toFixed(3)}`);
        }
      }
    });
    const clearPointer = (event: PointerEvent) => {
      const elapsed = Math.max(1, performance.now() - stageSwipeStartedAt);
      const shouldClose = stageSwipeCandidate
        && stageSwipeY > 0
        && (stageSwipeY > Math.min(150, window.innerHeight * 0.17) || stageSwipeY / elapsed > 0.72);
      pointers.delete(event.pointerId);
      if (pointers.size < 2) startDistance = 0;
      if (!pointers.size && stageSwipeCandidate) {
        overlay.classList.remove("video-stage-dragging");
        if (shouldClose) {
          overlay.style.setProperty("--video-swipe-y", `${window.innerHeight}px`);
          overlay.style.setProperty("--video-swipe-opacity", "0");
          window.setTimeout(closeVideo, 170);
        } else {
          overlay.style.setProperty("--video-swipe-y", "0px");
          overlay.style.setProperty("--video-swipe-opacity", "1");
        }
        stageSwipeCandidate = false;
        stageSwipeY = 0;
      }
    };
    surfaceEl?.addEventListener("pointerup", clearPointer);
    surfaceEl?.addEventListener("pointercancel", clearPointer);

    overlay.querySelector<HTMLButtonElement>("[data-video-title-toggle]")?.addEventListener("click", (event) => {
      event.preventDefault();
      if (videoPanelOrder.includes("title")) closeTitle();
      else {
        showTitleView("info");
        openVideoPanel("title");
      }
    });
    overlay.querySelector<HTMLButtonElement>("[data-video-ai]")?.addEventListener("click", openAi);
    overlay.querySelector<HTMLButtonElement>("[data-video-pip]")?.addEventListener("click", () => {
      void openItsVideoPictureInPicture(overlay, activeDevice).then((opened) => {
        if (!opened) showGlobalNotice("warning", "PiP belum tersedia", "Putar video lebih dahulu atau gunakan Chrome/Edge terbaru di desktop.");
      });
    });
    overlay.querySelector<HTMLButtonElement>("[data-video-ai-close]")?.addEventListener("click", closeAi);
    overlay.querySelectorAll<HTMLButtonElement>("[data-video-title-close]").forEach((button) => button.addEventListener("click", closeTitle));
    overlay.querySelector<HTMLButtonElement>("[data-video-detail-close]")?.addEventListener("click", closeDetail);
    overlay.querySelector<HTMLButtonElement>("[data-video-segments-panel-close]")?.addEventListener("click", closeSegments);
    overlay.querySelector<HTMLButtonElement>("[data-video-segments-panel-back]")?.addEventListener("click", closeSegments);
    overlay.querySelectorAll<HTMLButtonElement>("[data-video-detail-back]").forEach((button) => {
      button.addEventListener("click", () => {
        if (mobileVideoMode) showTitleView(segmentDetailReturnView);
        else {
          closeDetail();
          if (segmentDetailReturnView === "segments") openVideoPanel("segments");
        }
      });
    });
    overlay.querySelector<HTMLButtonElement>("[data-video-description-more]")?.addEventListener("click", (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const paragraph = button.parentElement?.querySelector<HTMLElement>("[data-video-description-copy]");
      const expanded = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!expanded));
      button.textContent = expanded ? "...Lainnya" : "Ringkas";
      paragraph?.classList.toggle("expanded", !expanded);
    });
    overlay.querySelector<HTMLButtonElement>("[data-video-sync-live]")?.addEventListener("click", () => {
      const video = activeVideoElement(overlay);
      if (!video) return;
      const edge = videoLiveEdge(video);
      if (Number.isFinite(edge)) video.currentTime = Math.max(0, edge - 0.08);
      segmentPlaybackSelected = false;
      void video.play().catch(() => undefined);
      refreshLiveSyncButton();
    });
    titlePanel?.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-video-segments-all]")) {
        updateVideoSegmentPanel(overlay);
        if (mobileVideoMode) showTitleView("segments");
        else openVideoPanel("segments");
        return;
      }
      if (target.closest("[data-video-segments-back]")) {
        showTitleView("info");
        return;
      }
      const detailButton = target.closest<HTMLButtonElement>("[data-video-segment-detail]");
      if (detailButton) {
        const segment = state.videoAiSegments.find((item) => item.id === detailButton.dataset.videoSegmentDetail);
        const returnView = target.closest('[data-video-title-view="segments"]') ? "segments" : "info";
        if (segment) openSegmentDetail(segment, returnView);
        return;
      }
      const seekButton = target.closest<HTMLButtonElement>("[data-video-segment-seek]");
      if (seekButton) {
        const segment = state.videoAiSegments.find((item) => item.id === seekButton.dataset.videoSegmentSeek);
        if (segment) seekVideoSegment(segment);
      }
    });
    segmentsPanel?.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const detailButton = target.closest<HTMLButtonElement>("[data-video-segment-detail]");
      if (detailButton) {
        const segment = state.videoAiSegments.find((item) => item.id === detailButton.dataset.videoSegmentDetail);
        if (segment) openSegmentDetail(segment, "segments");
        return;
      }
      const seekButton = target.closest<HTMLButtonElement>("[data-video-segment-seek]");
      if (seekButton) {
        const segment = state.videoAiSegments.find((item) => item.id === seekButton.dataset.videoSegmentSeek);
        if (segment) seekVideoSegment(segment);
      }
    });
    overlay.querySelectorAll<HTMLButtonElement>("[data-video-close]").forEach((button) => {
      button.addEventListener("click", closeVideo);
    });

    if (titlePanel) setupVideoRailPanelDismiss(titlePanel, "title", videoPanelOrder, videoPanels, (kind) => {
      showTitleView("info");
      closeVideoPanel(kind);
    });
    if (aiPanel) setupVideoRailPanelDismiss(aiPanel, "ai", videoPanelOrder, videoPanels, closeVideoPanel);
    if (segmentsPanel) setupVideoRailPanelDismiss(segmentsPanel, "segments", videoPanelOrder, videoPanels, closeVideoPanel);
    if (detailPanel) setupVideoRailPanelDismiss(detailPanel, "detail", videoPanelOrder, videoPanels, closeVideoPanel);
    updateVideoSegmentPanel(overlay);
    syncCameraViews(activeDevice);
    attachWebRtcStream();
    setupHlsVideos(overlay);
    applyVideoAmbientFromSnapshot(overlay, activeDevice);
    ambientTimer = window.setInterval(() => applyVideoAmbientFromSnapshot(overlay, activeDevice), 2200);
    liveSyncTimer = window.setInterval(refreshLiveSyncButton, 1000);
    syncCustomVideoButtons(overlay);
    window.setTimeout(() => registerVideoAutoPictureInPicture(overlay, activeDevice), 320);
    window.setTimeout(() => overlay.classList.add("open"), 20);
    drawExistingVideoDetections(overlay, activeDevice);
    drawVideoScannerIfNeeded(overlay);
    window.setTimeout(() => startVideoBrowserRfDetr(overlay, activeDevice), 550);
  }

  function keyboardTargetIsTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    if (el.isContentEditable) return true;
    return Boolean(el.closest("input, textarea, select, [contenteditable='true']"));
  }

  function handleVideoFullscreenShortcut(event: KeyboardEvent): void {
    if (keyboardTargetIsTyping(event.target)) return;
    const key = event.key.toLowerCase();
    const modal = document.getElementById("video-fullscreen-modal");
    if (key === "escape" && modal) {
      event.preventDefault();
      modal.querySelector<HTMLButtonElement>("[data-video-close]")?.click();
      return;
    }
    if (key !== "f") return;
    event.preventDefault();
    if (modal) {
      modal.querySelector<HTMLButtonElement>("[data-video-close]")?.click();
      return;
    }
    openVideoFullscreen(state.device ?? null);
  }

  window.addEventListener("keydown", handleVideoFullscreenShortcut);

  document.addEventListener("visibilitychange", () => {
    const overlay = state.videoRfDetrHost;
    if (document.hidden) {
      if (state.videoRfDetrAnimationFrame) cancelAnimationFrame(state.videoRfDetrAnimationFrame);
      state.videoRfDetrAnimationFrame = 0;
      return;
    }
    if (overlay?.isConnected) {
      startVideoRfDetrCanvasAnimation(overlay);
      void processVideoRfDetrFrame(overlay);
    }
  });

  function startVideoBrowserRfDetr(overlay: HTMLElement, device: DeviceRecord | null): void {
    const nextDeviceId = device?.id || state.device?.id || "";
    if (
      state.videoRfDetrTimer
      && state.videoRfDetrHost === overlay
      && state.videoRfDetrDeviceId === nextDeviceId
      && overlay.isConnected
    ) {
      void processVideoRfDetrFrame(overlay);
      return;
    }
    stopVideoBrowserRfDetr();
    state.videoRfDetrHost = overlay;
    state.videoRfDetrDeviceId = nextDeviceId;
    state.videoRfDetrStatus = "loading";
    state.videoRfDetrNote = "RF-DETR menyiapkan frame video live...";
    state.videoRfDetrLastSourceKey = "";
    state.videoRfDetrLastSnapshotAt = 0;
    state.videoRfDetrCanvasScanning = true;
    startVideoRfDetrCanvasAnimation(overlay);
    const tick = () => {
      if (!overlay.isConnected) {
        stopVideoBrowserRfDetr();
        return;
      }
      void processVideoRfDetrFrame(overlay);
    };
    tick();
    state.videoRfDetrTimer = window.setInterval(tick, VIDEO_BROWSER_RF_DETR_INTERVAL_MS);
  }

  function stopVideoBrowserRfDetr(): void {
    window.clearInterval(state.videoRfDetrTimer);
    if (state.videoRfDetrAnimationFrame) cancelAnimationFrame(state.videoRfDetrAnimationFrame);
    state.videoRfDetrTimer = 0;
    state.videoRfDetrAnimationFrame = 0;
    state.videoRfDetrHost = null;
    state.videoRfDetrBusy = false;
    state.videoRfDetrStatus = "idle";
    state.videoRfDetrNote = "";
    state.videoRfDetrDeviceId = "";
    state.videoRfDetrLastSourceKey = "";
    state.videoRfDetrLastSnapshotAt = 0;
    state.videoRfDetrCanvasWidth = 0;
    state.videoRfDetrCanvasHeight = 0;
    state.videoRfDetrCanvasDetections = [];
    state.videoRfDetrCanvasScanning = false;
  }

  function videoCanvasFrameSize(overlay: HTMLElement): { width: number; height: number } | null {
    const video = Array.from(overlay.querySelectorAll<HTMLVideoElement>("video"))
      .find((candidate) => candidate.videoWidth > 0 && candidate.videoHeight > 0);
    if (video) return { width: video.videoWidth, height: video.videoHeight };
    const image = overlay.querySelector<HTMLImageElement>("img");
    if (image?.naturalWidth && image.naturalHeight) return { width: image.naturalWidth, height: image.naturalHeight };
    return null;
  }

  function startVideoRfDetrCanvasAnimation(overlay: HTMLElement): void {
    if (state.videoRfDetrAnimationFrame) cancelAnimationFrame(state.videoRfDetrAnimationFrame);
    let lastDrawAt = 0;
    let drewFrame = false;
    const tick = (timestamp: number) => {
      if (!overlay.isConnected || state.videoRfDetrHost !== overlay) {
        state.videoRfDetrAnimationFrame = 0;
        return;
      }
      if (timestamp - lastDrawAt < 32) {
        state.videoRfDetrAnimationFrame = requestAnimationFrame(tick);
        return;
      }
      lastDrawAt = timestamp;
      const canvas = overlay.querySelector<HTMLCanvasElement>("[data-video-rf-detr-canvas]");
      const fallbackSize = videoCanvasFrameSize(overlay);
      const frameWidth = state.videoRfDetrCanvasWidth || fallbackSize?.width || 0;
      const frameHeight = state.videoRfDetrCanvasHeight || fallbackSize?.height || 0;
      // A stale device heartbeat must not hide an HLS frame that is still
      // advancing. Device status remains independent; the HUD follows pixels.
      if (canvas && frameWidth > 0 && frameHeight > 0) {
        const detections = state.videoRfDetrCanvasDetections;
        drawRfDetrDetections(canvas, detections, frameWidth, frameHeight, {
          scanActive: state.videoRfDetrCanvasScanning,
          scannerFocus: detections[0] || null,
        });
        overlay.classList.add("rf-detr-active");
        drewFrame = true;
      } else {
        overlay.classList.remove("rf-detr-active");
        if (drewFrame) clearVideoRfDetrCanvas(overlay);
        drewFrame = false;
      }
      state.videoRfDetrAnimationFrame = requestAnimationFrame(tick);
    };
    state.videoRfDetrAnimationFrame = requestAnimationFrame(tick);
  }

  async function processVideoRfDetrFrame(overlay: HTMLElement): Promise<void> {
    if (document.hidden) return;
    if (state.videoRfDetrBusy) return;
    state.videoRfDetrBusy = true;
    try {
      const frameSource = await videoRfDetrSource(overlay);
      if (!frameSource) {
        state.videoRfDetrStatus = "no-frame";
        state.videoRfDetrNote = "Menunggu frame video live yang valid...";
        state.videoRfDetrCanvasScanning = false;
        state.videoRfDetrCanvasWidth = 0;
        state.videoRfDetrCanvasHeight = 0;
        state.videoRfDetrCanvasDetections = [];
        overlay.classList.remove("rf-detr-active");
        clearVideoRfDetrCanvas(overlay);
        updateVideoAiPanel(overlay);
        return;
      }
      state.videoRfDetrStatus = state.videoRfDetrStatus === "online" ? "online" : "loading";
      state.videoRfDetrNote = "RF-DETR memproses frame...";
      state.videoRfDetrCanvasScanning = true;
      updateVideoAiPanel(overlay);
      const result = await runBrowserRfDetr(frameSource.source, isAndroidApkRuntime()
        ? { captureMaxEdge: 640, detailCrops: false, modelId: RF_DETR_ANDROID_MODEL_ID, worker: true }
        : {});
      state.videoRfDetrStatus = result.status;
      state.videoRfDetrNote = result.note;
      if (result.status === "online") {
        state.videoRfDetrCanvasWidth = result.frameWidth;
        state.videoRfDetrCanvasHeight = result.frameHeight;
        state.videoRfDetrCanvasDetections = result.detections
          .filter((det) => shouldDisplayDetectionLabel(det.label))
          .map(toWebRfDetrDetection);
        state.videoRfDetrCanvasScanning = !frameSource.staticImage;
        overlay.classList.toggle("rf-detr-active", result.frameWidth > 0 && result.frameHeight > 0);
        const device = deviceForVideoRfDetr();
        if (device) {
          applyVideoRfDetrResult(device, result);
          publishVideoRfDetrIfNeeded(device, result);
          recordVideoAiSegment(overlay, device, result, frameSource);
        }
        updateVideoAiPanel(overlay);
        return;
      }
      overlay.classList.remove("rf-detr-active");
      state.videoRfDetrCanvasWidth = 0;
      state.videoRfDetrCanvasHeight = 0;
      state.videoRfDetrCanvasDetections = [];
      state.videoRfDetrCanvasScanning = false;
      clearVideoRfDetrCanvas(overlay);
      updateVideoAiPanel(overlay);
    } finally {
      state.videoRfDetrBusy = false;
    }
  }

  async function videoRfDetrSource(overlay: HTMLElement): Promise<VideoRfDetrFrameSource | null> {
    const video = Array.from(overlay.querySelectorAll<HTMLVideoElement>("video"))
      .find((candidate) => !candidate.classList.contains("hls-fallback-hidden")
        && !candidate.paused
        && candidate.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        && candidate.videoWidth > 0
        && candidate.videoHeight > 0);
    if (video) return { source: video, drawOverlay: true, key: `video:${video.currentSrc || video.dataset.src || ""}:${Math.floor(video.currentTime * 2)}`, staticImage: false };
    const image = overlay.querySelector<HTMLImageElement>(".video-fullscreen-surface img, .camera-card img, img.camera-image");
    if (image?.complete && image.naturalWidth && image.naturalHeight) return { source: image, drawOverlay: true, key: `image:${image.currentSrc || image.src}`, staticImage: true };
    return null;
  }

  function clearVideoRfDetrCanvas(overlay: HTMLElement): void {
    const canvas = overlay.querySelector<HTMLCanvasElement>("[data-video-rf-detr-canvas]");
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function drawVideoScannerIfNeeded(overlay: HTMLElement): void {
    state.videoRfDetrCanvasScanning = Boolean(videoCanvasFrameSize(overlay) || deviceForVideoRfDetr());
    if (state.videoRfDetrCanvasScanning && state.videoRfDetrHost === overlay && !state.videoRfDetrAnimationFrame) {
      startVideoRfDetrCanvasAnimation(overlay);
    }
  }

  function drawExistingVideoDetections(overlay: HTMLElement, device: DeviceRecord | null): void {
    const canvas = overlay.querySelector<HTMLCanvasElement>("[data-video-rf-detr-canvas]");
    if (!device) {
      overlay.classList.remove("rf-detr-active");
      state.videoRfDetrCanvasWidth = 0;
      state.videoRfDetrCanvasHeight = 0;
      state.videoRfDetrCanvasDetections = [];
      state.videoRfDetrCanvasScanning = false;
      clearVideoRfDetrCanvas(overlay);
      return;
    }
    if (!canvas || !device?.detections?.length || !device.detectorFrameWidth || !device.detectorFrameHeight) {
      overlay.classList.remove("rf-detr-active");
      const frameSize = videoCanvasFrameSize(overlay);
      state.videoRfDetrCanvasWidth = frameSize?.width || 0;
      state.videoRfDetrCanvasHeight = frameSize?.height || 0;
      state.videoRfDetrCanvasDetections = [];
      state.videoRfDetrCanvasScanning = true;
      return;
    }
    const detections = device.detections
      .filter((d) => shouldDisplayDetectionLabel(d.label))
      .filter((d) => detectionBoxIsUsable(d, device.detectorFrameWidth || 0, device.detectorFrameHeight || 0))
      .map((d) => ({ ...d }));
    if (!detections.length) {
      overlay.classList.remove("rf-detr-active");
      state.videoRfDetrCanvasWidth = device.detectorFrameWidth;
      state.videoRfDetrCanvasHeight = device.detectorFrameHeight;
      state.videoRfDetrCanvasDetections = [];
      state.videoRfDetrCanvasScanning = true;
      clearVideoRfDetrCanvas(overlay);
      return;
    }
    overlay.classList.add("rf-detr-active");
    state.videoRfDetrCanvasWidth = device.detectorFrameWidth;
    state.videoRfDetrCanvasHeight = device.detectorFrameHeight;
    state.videoRfDetrCanvasDetections = detections;
    state.videoRfDetrCanvasScanning = false;
    drawRfDetrDetections(canvas, detections, device.detectorFrameWidth, device.detectorFrameHeight, {
      scanActive: false,
      scannerFocus: detections[0] || null,
    });
  }

  function deviceForVideoRfDetr(): DeviceRecord | null {
    return state.devices.find((device) => device.id === state.videoRfDetrDeviceId)
      || (state.device?.id === state.videoRfDetrDeviceId ? state.device : null)
      || state.device;
  }

  function cameraSourceForBrowserRfDetr(device: DeviceRecord): string {
    return isWebRtcSignalingCamera(device)
      ? webRtcSignalPath(device)
      : publicCameraHlsUrl(device)
      || publicCameraUrl(device)
      || latestCameraAnalysisSnapshot(device)
      || latestCameraSnapshot(device)
      || "browser-frame";
  }

  function applyVideoRfDetrResult(device: DeviceRecord, result: BrowserRfDetrResult): void {
    const detections = result.detections.map(toWebRfDetrDetection);
    const updated: DeviceRecord = {
      ...device,
      detectorStatus: result.status,
      detectorNote: result.note,
      detectorUpdatedAt: result.updatedAt,
      detectorFps: result.fps,
      detectorFrameWidth: result.frameWidth,
      detectorFrameHeight: result.frameHeight,
      detectorCameraSource: cameraSourceForBrowserRfDetr(device),
      detectorConfidence: 0.45,
      detectorOutputShape: result.outputShape,
      vehicleBreakdown: result.vehicleBreakdown,
      vehicleCount: result.vehicleCount,
      objectCount: result.objectCount,
      detections,
      trafficSource: "browser-rfdetr-vehicle-count",
    };
    state.devices = state.devices.map((item) => item.id === updated.id ? updated : item);
    if (!state.devices.some((item) => item.id === updated.id)) state.devices.push(updated);
    if (!state.device || state.device.id === updated.id) state.device = updated;
    state.trafficById.delete(updated.id);
  }

  function toWebRfDetrDetection(det: BrowserRfDetrDetection): RfDetrDetection {
    return {
      label: det.label,
      confidence: det.confidence,
      vehicle: det.vehicle,
      x: det.x,
      y: det.y,
      width: det.width,
      height: det.height,
    };
  }

  function publishVideoRfDetrIfNeeded(device: DeviceRecord, result: BrowserRfDetrResult): void {
    if (Date.now() - state.videoRfDetrLastPublishAt < BROWSER_RF_DETR_INTERVAL_MS) return;
    state.videoRfDetrLastPublishAt = Date.now();
    const cameraUrl = cameraSourceForBrowserRfDetr(device);
    void publishBrowserRfDetrResult(FIREBASE_ROOT_URL, device.id, browserViewerId(), cameraUrl, result)
      .catch((err) => {
        console.warn("[ITS] browser RF-DETR publish failed:", err);
        state.lastSnapshotHistoryWriteErrorAt = Date.now();
        state.videoRfDetrNote = "RF-DETR lokal aktif; RTDB objectDetection menolak write.";
        const overlay = document.getElementById("video-fullscreen-modal");
        if (overlay) updateVideoAiPanel(overlay);
      });
  }

  function updateVideoAiPanel(root: ParentNode): void {
    const device = deviceForVideoRfDetr();
    const statusEl = root.querySelector<HTMLElement>("[data-video-ai-status]");
    if (statusEl) statusEl.textContent = videoAiStatusText(device);
    const statsHost = root.querySelector<HTMLElement>("[data-video-ai-stats]");
    if (statsHost) statsHost.innerHTML = renderVehicleStatsGrid(device, device ? trafficStateForDevice(device) : null, "video-ai-stats");
    const caption = root.querySelector<HTMLElement>(".video-fullscreen-caption");
    const message = state.videoRfDetrNote || videoSurfaceStatusText(device) || webRtcStatusText();
    if (caption) caption.textContent = message;
    const detail = root.querySelector<HTMLElement>("[data-video-status-detail]");
    if (detail) detail.textContent = conciseVideoStatus(message);
    const title = root.querySelector<HTMLElement>("[data-video-title-toggle]");
    const titleMessage = root.querySelector<HTMLElement>("[data-video-title-message]");
    const titleText = root.querySelector<HTMLElement>("[data-video-title-text]");
    const showStatusInTitle = Boolean(
      message
      && (
        state.videoRfDetrStatus === "loading"
        || state.videoRfDetrStatus === "no-frame"
        || state.videoRfDetrStatus === "error"
        || Date.now() - state.lastSnapshotHistoryWriteErrorAt < 30_000
      ),
    );
    if (titleMessage) titleMessage.textContent = message;
    if (titleText && device) titleText.textContent = cameraTitleText(device);
    title?.classList.toggle("status-carousel", showStatusInTitle);
    updateVideoSegmentPanel(root);
  }

  function videoAiStatusText(device: DeviceRecord | null): string {
    if (state.videoRfDetrStatus === "loading") return state.videoRfDetrNote || "RF-DETR memuat model...";
    if (state.videoRfDetrStatus === "no-frame") {
      return state.videoRfDetrNote || "Menunggu frame video live";
    }
    if (state.videoRfDetrStatus === "error") return state.videoRfDetrNote || "RF-DETR gagal";
    if (state.videoRfDetrStatus === "online") {
      const fps = device?.detectorFps && device.detectorFps > 0 ? ` - ${device.detectorFps.toFixed(1)} FPS` : "";
      return `RF-DETR browser aktif${fps}`;
    }
    if (!device) return "Menunggu data AI";
    const fps = device.detectorFps && device.detectorFps > 0 ? ` - ${device.detectorFps.toFixed(1)} FPS` : "";
    if (device.detectorStatus === "disabled") return "AI Raspberry disabled, fallback browser siap";
    return `${device.detectorStatus || "menunggu"}${fps}`;
  }

  function setupVideoRailPanelDismiss(
    sheetEl: HTMLElement,
    kind: VideoRailPanelKind,
    panelOrder: VideoRailPanelKind[],
    panels: Record<VideoRailPanelKind, HTMLElement | null>,
    closePanel: (kind: VideoRailPanelKind) => void,
  ): void {
    let startX = 0;
    let startY = 0;
    let currentX = 0;
    let currentY = 0;
    let pointerId = -1;
    let startedAt = 0;
    let dragging = false;
    let startBottomHeight = 0;
    let startUpperHeight = 0;
    let wheelOffset = 0;
    let wheelTimer = 0;

    const bottomKind = () => panelOrder[panelOrder.length - 1];
    const upperKind = () => panelOrder.length > 1 ? panelOrder[0] : null;
    const isDismissiblePanel = () => bottomKind() === kind;
    const isSinglePanel = () => panelOrder.length === 1 && panelOrder[0] === kind;
    const setStageWidthForHorizontalDrag = (offsetPx: number) => {
      const shell = sheetEl.closest<HTMLElement>(".video-fullscreen-shell");
      const rail = sheetEl.closest<HTMLElement>(".video-panel-rail");
      if (!shell || !rail) return;
      const railBox = rail.getBoundingClientRect();
      const remaining = Math.max(0, railBox.width - offsetPx);
      shell.style.setProperty("--video-ai-live-width", `${Math.round(remaining)}px`);
    };
    const clearDragStyles = () => {
      Object.values(panels).forEach((panel) => {
        if (!panel) return;
        panel.style.transform = "";
        panel.style.flex = "";
        panel.style.transition = "";
      });
    };
    const applyDrag = (offsetPx: number) => {
      if (!isDismissiblePanel()) return;
      if (isSinglePanel()) {
        const offset = clamp(offsetPx, 0, sheetEl.getBoundingClientRect().width + 40);
        currentX = offset;
        currentY = 0;
        sheetEl.style.transition = "none";
        sheetEl.style.transform = `translateX(${Math.round(offset)}px)`;
        setStageWidthForHorizontalDrag(offset);
        return;
      }
      const offset = clamp(offsetPx, 0, startBottomHeight + 80);
      currentY = offset;
      currentX = 0;
      const upper = upperKind();
      const upperPanel = upper ? panels[upper] : null;
      sheetEl.style.transition = "none";
      sheetEl.style.transform = `translateY(${Math.round(offset)}px)`;
      if (upperPanel) {
        upperPanel.style.transition = "none";
        const nextBottom = Math.max(0, startBottomHeight - offset);
        const nextUpper = Math.max(0, startUpperHeight + Math.min(offset, startBottomHeight));
        sheetEl.style.flex = `0 0 ${Math.round(nextBottom)}px`;
        upperPanel.style.flex = `0 0 ${Math.round(nextUpper)}px`;
      }
    };
    const restore = () => {
      Object.values(panels).forEach((panel) => {
        if (!panel) return;
        panel.style.transition = "";
      });
      clearDragStyles();
      setStageWidthForHorizontalDrag(0);
      currentX = 0;
      currentY = 0;
    };

    sheetEl.addEventListener("pointerdown", (event) => {
      const target = event.target as HTMLElement;
      if (!isDismissiblePanel()) return;
      if (target.closest("[data-video-segment-scroll]")) return;
      const startsOnHandle = Boolean(target.closest("[data-swipe-handle], header, .video-panel-header"));
      if (target.closest("button, a, input, label, select, textarea")) return;
      if (!startsOnHandle && !canStartSheetDismiss(target, sheetEl, false)) return;
      startX = event.clientX;
      startY = event.clientY;
      currentX = 0;
      currentY = 0;
      pointerId = event.pointerId;
      startedAt = performance.now();
      dragging = true;
      startBottomHeight = sheetEl.getBoundingClientRect().height;
      const upper = upperKind();
      startUpperHeight = upper && panels[upper] ? panels[upper]!.getBoundingClientRect().height : 0;
      sheetEl.style.transition = "none";
      try { sheetEl.setPointerCapture?.(event.pointerId); } catch { /* Pointer may already be released. */ }
    });

    sheetEl.addEventListener("pointermove", (event) => {
      if (!dragging || event.pointerId !== pointerId) return;
      if (isSinglePanel()) {
        const x = Math.max(0, event.clientX - startX);
        if (x > 2) event.preventDefault();
        applyDrag(x);
        return;
      }
      const y = Math.max(0, event.clientY - startY);
      if (y > 2) event.preventDefault();
      applyDrag(y);
    });

    const finish = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== pointerId) return;
      dragging = false;
      pointerId = -1;
      const elapsed = Math.max(1, performance.now() - startedAt);
      const distance = isSinglePanel() ? currentX : currentY;
      const velocity = distance / elapsed;
      const threshold = isSinglePanel()
        ? Math.min(150, Math.max(80, sheetEl.getBoundingClientRect().width * 0.35))
        : Math.min(150, Math.max(80, startBottomHeight * 0.38));
      if (distance > threshold || velocity > 0.55) closePanel(kind);
      else restore();
    };
    sheetEl.addEventListener("pointerup", finish);
    sheetEl.addEventListener("pointercancel", finish);

    sheetEl.addEventListener("wheel", (event) => {
      if (!isDismissiblePanel()) return;
      if (isSinglePanel()) {
        const horizontalPull = event.deltaX > 12 ? event.deltaX : 0;
        if (!horizontalPull) return;
        event.preventDefault();
        wheelOffset = clamp(wheelOffset + horizontalPull, 0, sheetEl.getBoundingClientRect().width + 40);
        applyDrag(wheelOffset);
        window.clearTimeout(wheelTimer);
        wheelTimer = window.setTimeout(() => {
          if (wheelOffset > Math.min(150, Math.max(80, sheetEl.getBoundingClientRect().width * 0.35))) closePanel(kind);
          else restore();
          wheelOffset = 0;
        }, 120);
        return;
      }
      const target = event.target as HTMLElement | null;
      const scrollTarget = nearestScrollableSheetTarget(target, sheetEl);
      if (scrollTarget.scrollTop > 1 || event.deltaY >= -8) return;
      event.preventDefault();
      if (!startBottomHeight) startBottomHeight = sheetEl.getBoundingClientRect().height;
      const upper = upperKind();
      startUpperHeight = upper && panels[upper] ? panels[upper]!.getBoundingClientRect().height : 0;
      wheelOffset = clamp(wheelOffset + Math.abs(event.deltaY), 0, startBottomHeight + 80);
      applyDrag(wheelOffset);
      window.clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(() => {
        if (wheelOffset > Math.min(150, Math.max(80, startBottomHeight * 0.38))) closePanel(kind);
        else restore();
        wheelOffset = 0;
      }, 120);
    }, { passive: false });
  }

  // Tablet & POI interactions
  const TABLET_CATEGORIES = ["all", "hospital", "worship", "mall", "campus", "parking"] as const;
  const TABLET_CATEGORY_LABELS: Record<(typeof TABLET_CATEGORIES)[number], string> = {
    all: "Semua",
    hospital: "Rumah Sakit",
    worship: "Mesjid",
    mall: "Belanja",
    campus: "Sekolah/Kampus",
    parking: "Parkir",
  };

  function showVehicleMarker(latlng: [number, number]): void {
    if (state.vehicleMarker) {
      state.vehicleMarker.setLatLng(latlng);
      return;
    }
    const icon = L.divIcon({
      className: "vehicle-marker-icon",
      html: `<div class="vehicle-marker-shell"><div class="vehicle-marker-pulse"></div><div class="vehicle-marker-core"><div class="vehicle-glyph">🚗</div></div></div>`,
      iconSize: [56, 56],
      iconAnchor: [28, 28],
    });
    const m = L.marker(latlng, { icon, interactive: true, zIndexOffset: 2000 }).addTo(map);
    m.on("click", () => {
      if (isTablet()) createTabletCategoryPanel(true);
    });
    // Ensure marker DOM accepts pointer events (some CSS may disable them)
    setTimeout(() => {
      try {
        const el = m.getElement() as HTMLElement | null;
        if (el) {
          el.style.pointerEvents = 'auto';
          el.style.cursor = 'pointer';
          el.setAttribute('title', 'Lokasi Anda');
        }
      } catch {
        /* ignore */
      }
    }, 0);
    state.vehicleMarker = m;
  }

  function createTabletCategoryPanel(autoFocus = false): void {
    // If already open, keep it
    const existing = document.getElementById("m-tablet-categories");
    if (existing) {
      if (autoFocus) {
        existing.querySelector<HTMLInputElement>(".tablet-search-input")?.focus();
      }
      return;
    }
    const bodyHtml = `
  <div class="m-sheet-handle-bar"></div>
  <div class="tablet-categories">
    <div class="tablet-header">
      <div class="tablet-title">Lokasi Anda</div>
      <div class="tablet-subtitle">Cari POI atau pilih kategori untuk menampilkan tempat terdekat</div>
    </div>
    <label class="tablet-search">
      <span class="tablet-search-icon">⌕</span>
      <input type="search" class="tablet-search-input" placeholder="Cari masjid, sekolah, SPBU, mall..." autocomplete="off" />
    </label>
    <div class="tablet-cats-list">
      ${TABLET_CATEGORIES.map((c, i) => `<button class="tablet-cat-btn" data-index="${i}">${TABLET_CATEGORY_LABELS[c]}</button>`).join("")}
    </div>
    <div class="tablet-hint">Ketuk marker POI di peta untuk memilih tujuan.</div>
  </div>`;
    const overlay = createSwipeableSheetModal("m-tablet-categories", "m-tablet-sheet", bodyHtml);
    overlay.querySelector<HTMLDivElement>('.m-layer-backdrop')?.addEventListener('click', () => { overlay.remove(); });
    const sheet = overlay.querySelector<HTMLElement>(".m-tablet-sheet");
    if (!sheet) return;
    setupSheetSwipe(sheet, () => overlay.remove());
    const searchInput = sheet.querySelector<HTMLInputElement>(".tablet-search-input");
    if (searchInput) {
      searchInput.value = state.tabletSearchQuery || "";
      searchInput.addEventListener("input", () => {
        state.tabletSearchQuery = searchInput.value.trim().toLowerCase();
        updateTabletCategoryView();
      });
      if (autoFocus) window.setTimeout(() => searchInput.focus(), 0);
    }
    sheet.querySelectorAll<HTMLButtonElement>(".tablet-cat-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.index || 0);
        state.tabletCategoryIndex = idx;
        updateTabletCategoryView();
        overlay.remove();
      });
    });
  }

  function updateTabletCategoryView(): void {
    const idx = state.tabletCategoryIndex ?? 0;
    const kind = TABLET_CATEGORIES[idx] || "all";
    const query = (state.tabletSearchQuery || "").trim();
    for (const [id, marker] of state.poiMarkers.entries()) {
      const poi = state.poiData.get(id);
      const el = marker.getElement() as HTMLElement | null;
      if (!poi) continue;
      const matchesQuery = !query || `${poi.title} ${poi.kind} ${poi.address || ""}`.toLowerCase().includes(query);
      const show = (kind === "all" || poi.kind === kind) && matchesQuery;
      if (el) el.style.display = show ? "" : "none";
    }

    // If the filter is not all, ensure the POI layer remains visually filtered after map moves.
    if (state.overpassLayer) {
      state.overpassLayer.getLayers().forEach((layer: any) => {
        const poiId = layer?.options?.poiId;
        if (!poiId) return;
        const poi = state.poiData.get(poiId);
        if (!poi) return;
        const visible = (kind === "all" || poi.kind === kind) && (!query || `${poi.title} ${poi.kind} ${poi.address || ""}`.toLowerCase().includes(query));
        const layerEl = layer.getElement?.() as HTMLElement | null;
        if (layerEl) layerEl.style.display = visible ? "" : "none";
      });
    }
  }

  function clearDestinationRoute(): void {
    if (state.routeLayer) {
      try { map.removeLayer(state.routeLayer); } catch { }
      state.routeLayer = null;
    }
    if (state.destinationMarker) {
      try { map.removeLayer(state.destinationMarker); } catch { }
      state.destinationMarker = null;
    }
  }

  function setDestinationToPoi(poi: PoiRecord): void {
    clearDestinationRoute();
    const from = state.vehicleMarker ? state.vehicleMarker.getLatLng() : map.getCenter();
    const to = L.latLng(poi.lat, poi.lng);
    const routeRequestId = ++state.routeRequestSeq;

    const drawRoute = (points: L.LatLngExpression[]): void => {
      if (routeRequestId !== state.routeRequestSeq) return;
      const poly = L.polyline(points, { color: "#2563eb", weight: 4, opacity: 0.9 }).addTo(map);
      const dest = L.marker(to, { title: poi.title }).addTo(map);
      const group = L.layerGroup([poly, dest]);
      state.routeLayer = group.addTo(map);
      state.destinationMarker = dest;
      map.fitBounds(poly.getBounds().pad(0.2));
    };

    const drawFallback = (): void => drawRoute([from, to]);

    void (async () => {
      try {
        const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`Route request failed: ${res.status}`);
        const data = await res.json() as {
          routes?: Array<{ geometry?: { coordinates?: Array<[number, number]> } }>;
        };
        const coords = data.routes?.[0]?.geometry?.coordinates;
        if (!coords || coords.length < 2) throw new Error("Route geometry missing");
        drawRoute(coords.map(([lng, lat]) => [lat, lng] as L.LatLngExpression));
      } catch {
        drawFallback();
      }
    })();
  }

  function handlePoiClick(poi: PoiRecord): void {
    if (isTablet()) {
      // If tablet category is active, treat POI as destination; otherwise open modal
      if (state.tabletCategoryIndex !== null) {
        void setDestinationToPoi(poi);
        // close tablet sheet if open
        document.getElementById("m-tablet-categories")?.remove();
        return;
      }
      // fallback: open modal
      openPoiModal(poi);
      return;
    }
    // desktop: open modal as before
    openPoiModal(poi);
  }

  // ─── Toolbar Control ─────────────────────────────────────────────

  Object.assign(itsRuntimeBridge(), {
    getPoiSnapshot: () => Array.from(state.poiData.values()).map((poi) => ({
      id: poi.id,
      title: poi.title,
      kind: poi.kind,
      icon: poi.icon,
      lat: poi.lat,
      lng: poi.lng,
      address: poi.address,
    })),
    getUserLocation: () => state.lastUserLocation,
    getMapCenter: () => {
      const center = map.getCenter();
      return { lat: center.lat, lng: center.lng, source: "leaflet-map-center" };
    },
    getSystemLocation: () => {
      const primary = state.devices[0] ?? state.device;
      return primary
        ? { lat: primary.position.lat, lng: primary.position.lng, deviceId: primary.id }
        : null;
    },
    applyUserLocation: (lat: number, lng: number, accuracy?: number, center = true, source = "ai-chat-gps") => {
      applyLocatedUser(lat, lng, accuracy, center, source);
    },
    focusPoi: (poiId: string, lat: number, lng: number) => {
      const poi = state.poiData.get(poiId);
      map.setView([lat, lng], Math.max(17, map.getZoom()), { animate: true });
      if (poi) {
        openPoiModal(poi);
        void setDestinationToPoi(poi);
      }
    },
    focusLatLng: (lat: number, lng: number, label = "Lokasi") => {
      map.setView([lat, lng], Math.max(17, map.getZoom()), { animate: true });
      L.popup({ closeButton: true, autoClose: true })
        .setLatLng([lat, lng])
        .setContent(escapeHtml(label))
        .openOn(map);
    },
    goHome: () => {
      const primary = state.devices[0] ?? state.device;

      const fallbackCenter = DEFAULT_CENTER as [number, number];

      const lat =
        primary?.position.lat ??
        Number(fallbackCenter[0]);

      const lng =
        primary?.position.lng ??
        Number(fallbackCenter[1]);

      goHome();

      return {
        ok: true,
        deviceId: primary?.id ?? null,
        lat,
        lng,
        zoom: DEFAULT_ZOOM,
      };
    },

    closeAiHistory: () => {
      const sheet =
        document.getElementById("m-ai-history-sheet");

      if (!sheet) return false;

      closeAiHistorySheet();
      return true;
    },
  } satisfies ItsMapsRuntimeBridge);

  function makeCompassSvg(): string {
    return `<svg class="compass-svg" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="24" cy="24" r="21.5" class="compass-ring-bg"/>
  <path d="M11.2 24 L15.2 20.8 L15.2 27.2 Z" class="compass-arrow-left"/>
  <path d="M36.8 24 L32.8 20.8 L32.8 27.2 Z" class="compass-arrow-right"/>
  <text x="24" y="9.8" text-anchor="middle" class="compass-label compass-label-n">N</text>
  <text x="24" y="42.4" text-anchor="middle" class="compass-label">S</text>
  <text x="9" y="26.4" text-anchor="middle" class="compass-label">W</text>
  <text x="39" y="26.4" text-anchor="middle" class="compass-label">E</text>
  <g class="compass-needle-group">
    <polygon points="24,13.5 28.4,24 24,34.5 19.6,24" class="compass-needle-shadow"/>
    <polygon points="24,13.5 28.4,24 24,24 19.6,24" class="compass-needle-north"/>
    <polygon points="24,34.5 28.4,24 24,24 19.6,24" class="compass-needle-south"/>
    <circle cx="24" cy="24" r="2.2" class="compass-needle-cap"/>
  </g>
</svg>`;
  }

  function bindDesktopCameraAiPopover(container: HTMLElement): void {
    if (isMobile()) return;
    const cameraButton = container.querySelector<HTMLButtonElement>('.toolbar-camera[data-action="camera"]');
    if (!cameraButton || container.querySelector(".camera-ai-popover")) return;

    const popover = document.createElement("div");
    popover.className = "camera-ai-popover";
    popover.innerHTML = `
      <div class="camera-ai-popover-icon" aria-hidden="true">
        ${cameraPlainIconSvg()}
        <span>AI</span>
      </div>
      <button type="button" data-camera-ai-history>Riwayat AI</button>
      <button type="button" data-camera-ai-about>Tentang AI</button>
    `;
    container.appendChild(popover);

    let closeTimer = 0;
    const open = () => {
      window.clearTimeout(closeTimer);
      container.classList.add("camera-ai-popover-open");
    };
    const close = () => {
      window.clearTimeout(closeTimer);
      closeTimer = window.setTimeout(() => container.classList.remove("camera-ai-popover-open"), 180);
    };

    cameraButton.addEventListener("mouseenter", open);
    cameraButton.addEventListener("focus", open);
    cameraButton.addEventListener("mouseleave", close);
    cameraButton.addEventListener("blur", close);
    popover.addEventListener("mouseenter", open);
    popover.addEventListener("mouseleave", close);
    popover.addEventListener("click", (event) => event.stopPropagation());
    popover.querySelector<HTMLButtonElement>("[data-camera-ai-history]")?.addEventListener("click", () => {
      aiHistoryActiveTab = "history";
      openAiHistorySheet("peek");
      renderAiHistorySheetContent();
    });
    popover.querySelector<HTMLButtonElement>("[data-camera-ai-about]")?.addEventListener("click", () => {
      aiHistoryActiveTab = "about";
      openAiHistorySheet("peek");
      renderAiHistorySheetContent();
    });
  }

  const BottomRightControl = L.Control.extend({
    options: { position: "bottomright" },
    onAdd(): HTMLElement {
      const mobile = isMobile();
      const container = L.DomUtil.create("div", mobile ? "map-toolbar map-toolbar-mobile" : "map-toolbar");
      container.innerHTML = mobile ? `
    <button type="button" class="toolbar-compass" data-action="compass"
            title="Kompas – klik untuk putar peta">
      ${makeCompassSvg()}
    </button>
    <button type="button" class="toolbar-btn" data-action="locate" title="Lokasi saya">
      <svg viewBox="0 0 20 20" fill="none" width="16" height="16">
        <circle cx="10" cy="10" r="3.2" stroke="currentColor" stroke-width="1.7"/>
        <path d="M10 1.5v2.8M10 15.7v2.8M1.5 10h2.8M15.7 10h2.8"
              stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
      </svg>
    </button>
    <button type="button" class="toolbar-btn" data-action="home" title="Kembali ke posisi device">
      <svg viewBox="0 0 20 20" fill="none" width="16" height="16">
        <path d="M3 9.5L10 3l7 6.5V17a1 1 0 01-1 1H5a1 1 0 01-1-1V9.5z"
              stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
        <path d="M7.5 18v-5h5v5"
              stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
      </svg>
    </button>
    <div class="toolbar-divider"></div>
    <button type="button" class="toolbar-btn toolbar-zoom" data-action="zoom-in"  title="Zoom in">+</button>
    <button type="button" class="toolbar-btn toolbar-zoom" data-action="zoom-out" title="Zoom out">−</button>
    <div class="toolbar-divider"></div>
    <button type="button" class="toolbar-camera" data-action="camera" title="Camera preview">
      <div class="camera-thumb-wrap">${cameraPlainIconSvg()}</div>
      <span class="camera-tile-label"></span>
    </button>
  ` : `
    <button type="button" class="toolbar-compass" data-action="compass"
            title="Kompas – klik untuk putar peta">
      ${makeCompassSvg()}
    </button>
    <button type="button" class="toolbar-btn" data-action="locate" title="Lokasi saya">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="8.2" stroke="currentColor" stroke-width="1.3" opacity="0.45"/>
        <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.7"/>
        <circle cx="12" cy="12" r="1.4" fill="currentColor"/>
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
      </svg>
    </button>
    <button type="button" class="toolbar-btn" data-action="home" title="Kembali ke posisi device">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 11.5L12 4l8 7.5V19a1.2 1.2 0 01-1.2 1.2H5.2A1.2 1.2 0 014 19V11.5z"
              stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
        <path d="M9.5 20.2v-5.4a1 1 0 011-1h3a1 1 0 011 1v5.4"
              stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
      </svg>
    </button>
    <div class="toolbar-divider"></div>
    <button type="button" class="toolbar-btn toolbar-zoom" data-action="zoom-in"  title="Zoom in">+</button>
    <button type="button" class="toolbar-btn toolbar-zoom" data-action="zoom-out" title="Zoom out">−</button>
    <div class="toolbar-divider"></div>
    <button type="button" class="toolbar-camera" data-action="camera" title="Camera preview">
      <div class="camera-thumb-wrap">${cameraPlainIconSvg()}</div>
      <span class="camera-tile-label"></span>
    </button>
  `;

      const tooltipLabels: Record<string, string> = {
        compass: "Kompas - klik untuk putar peta ke Timur (90 deg)",
        mode: "Ganti tampilan peta",
        locate: "Lokasi saya",
        home: "Kembali ke posisi device",
        "zoom-in": "Zoom in",
        "zoom-out": "Zoom out",
        camera: "Camera preview",
      };
      container.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((btn) => {
        const action = btn.dataset.action || "";
        const label = tooltipLabels[action] || btn.getAttribute("title") || btn.getAttribute("aria-label") || "";
        btn.removeAttribute("title");
        if (!btn.getAttribute("aria-label") && label) btn.setAttribute("aria-label", label);
        if (!btn.querySelector(".toolbar-tip") && label) {
          const tip = document.createElement("span");
          tip.className = "toolbar-tip";
          tip.textContent = label;
          btn.appendChild(tip);
        }
      });

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);

      state.compassNeedle = container.querySelector<SVGGElement>(".compass-needle-group");
      state.compassBtn = container.querySelector<HTMLButtonElement>(".toolbar-compass");
      state.cameraPreview = container.querySelector<HTMLDivElement>(".camera-thumb-wrap");
      state.cameraButton = container.querySelector<HTMLButtonElement>(".toolbar-camera");
      bindDesktopCameraAiPopover(container);

      container.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const action = btn.dataset.action;
          if (action === "compass") handleCompassClick();
          else if (action === "locate") locateUser();
          else if (action === "home") goHome();
          else if (action === "camera") {
            if (isMobile()) {
              if (!document.getElementById("m-ai-history-sheet")) openAiHistorySheet("dock");
              else snapAiHistorySheet("dock");
              document.querySelectorAll(".m-nav-tab").forEach((button) => button.classList.remove("active"));
              document.querySelector<HTMLButtonElement>('.m-nav-tab[data-tab="its"]')?.classList.add("active");
              mobileState.activeTab = "its";
              openITSSheet({ overlay: true });
            } else {
              openCameraPreview();
            }
          }
          else if (action === "zoom-in") map.zoomIn();
          else if (action === "zoom-out") map.zoomOut();
        });
      });

      renderCameraTile();
      updateCompass();
      return container;
    },
  });

  new BottomRightControl().addTo(map);

  // Mode control for switching base maps (street / 3d / satellite)
  const ModeControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd(): HTMLElement {
      const container = L.DomUtil.create('div', 'mode-control');
      container.setAttribute("role", "group");
      container.setAttribute("aria-label", "Tampilan peta");
      container.innerHTML = `
    <button class="mode-btn" data-mode="street" type="button" title="Peta 2D" aria-label="Tampilkan peta 2D" aria-pressed="false">2D</button>
    <button class="mode-btn mode-legend-btn" data-map-symbol-legend type="button" title="Legenda simbol peta" aria-label="Legenda simbol peta" aria-expanded="false">?</button>
    <button class="mode-btn" data-mode="3d" type="button" title="Peta 3D" aria-label="Tampilkan peta 3D" aria-pressed="false">3D</button>
    <button class="mode-btn" data-mode="satellite" type="button" title="Peta satelit" aria-label="Tampilkan peta satelit" aria-pressed="false">Sat</button>
    <button class="mode-btn mode-dynamics-btn" data-dynamics-panel type="button" title="Filter detail dinamis" aria-label="Buka filter transportasi, jalan, POI, dan CCTV">Dyn</button>
    <div class="map-symbol-legend" data-map-symbol-panel hidden>
      <strong>Legenda 2D</strong>
      <span><i class="legend-road"></i> Jalan utama / avenue</span>
      <span><i class="legend-tree"></i> Median atau tepi berpohon</span>
      <span><i class="legend-water"></i> Sungai, kanal, drainase</span>
      <span><i class="legend-sidewalk"></i> Trotoar / jalur jalan kaki</span>
      <span><i class="legend-rail"></i> Rel dan palang perlintasan</span>
      <span><i class="legend-ai"></i> Petunjuk AI dari satelit</span>
    </div>
  `;
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      container.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (btn.dataset.mapSymbolLegend !== undefined) return;
          if (btn.dataset.dynamicsPanel !== undefined) {
            openLayerModal();
            return;
          }
          const m = (btn.dataset.mode as BaseMapMode) || 'street';
          void setBaseMap(m);
        });
      });
      const legendBtn = container.querySelector<HTMLButtonElement>("[data-map-symbol-legend]");
      const legendPanel = container.querySelector<HTMLElement>("[data-map-symbol-panel]");
      legendBtn?.addEventListener("click", () => {
        const open = legendPanel?.hidden ?? true;
        if (legendPanel) legendPanel.hidden = !open;
        legendBtn.setAttribute("aria-expanded", String(open));
      });
      return container;
    }
  });

  function updateModeControlButtons(): void {
    document.querySelectorAll<HTMLButtonElement>(".mode-control [data-mode]").forEach((button) => {
      const active = button.dataset.mode === state.baseMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  let isMapTearingDown = false;

  function syncModeControlVisibility(): void {
    if (isMapTearingDown) return;
    const mapInternals = map as typeof map & { _controlCorners?: Record<string, HTMLElement> };
    const mapContainer = map.getContainer();
    const topRightCorner = mapInternals._controlCorners?.topright;
    if (!mapContainer.isConnected || !topRightCorner?.isConnected) return;
    const shouldShowModeControl = !isMobile() && !isTablet();
    if (shouldShowModeControl) {
      if (!state.modeControl) {
        state.modeControl = new ModeControl();
        state.modeControl.addTo(map);
      }
      updateModeControlButtons();
      return;
    }

    if (state.modeControl) {
      map.removeControl(state.modeControl);
      state.modeControl = null;
    }
  }

  syncModeControlVisibility();

  map.on("rotate", updateCompass);
  map.on("move zoom", updateCompass);
  map.on("zoomend", rescaleMarkers);
  map.on("zoomend", () => {
    // A zoom transition changes semantic visibility and label collision cells.
    // Re-render cached records immediately, then fetch only when the visible
    // map moved outside the existing buffered viewport.
    renderCurrentPoiDataset();
    void refreshOverpassLayer();
  });
  map.on("move zoom rotate", () => syncMapLibreView());
  map.on("resize", () => {
    state.maplibreMap?.resize();
    syncMapLibreView(true);
    syncModeControlVisibility();
  });
  window.addEventListener("resize", syncModeControlVisibility);

  // ─── Fetch & refresh ────────────────────────────────────────────

  // Firebase RTDB — dibaca langsung sebagai fallback jika file lokal tidak tersedia
  async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const text = await res.text();
    // Guard: pastikan response adalah JSON, bukan HTML 404 page
    if (text.trimStart().startsWith("<")) {
      throw new Error(`Expected JSON but got HTML from ${url}`);
    }
    return JSON.parse(text) as T;
  }

  /**
   * Baca Firebase RTDB: GET /devices.json
   * Hasilnya Record<id, DeviceRecord|LegacyWrapper> dibungkus sebagai Snapshot.
   */
  async function fetchFirebaseDevices(): Promise<Snapshot> {
    const res = await fetch(FIREBASE_DEVICES_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`Firebase HTTP ${res.status}`);
    const data = await res.json() as Record<string, unknown> | null;
    if (!data || typeof data !== "object") throw new Error("Firebase: empty/null");
    return { devices: data as Record<string, SnapshotDevice>, source: "firebase" };
  }

  async function hydrateFirebaseTelemetry(devices: DeviceRecord[]): Promise<DeviceRecord[]> {
    const snapshotHistory = await firebaseGetPath<unknown>("snapshotHistory").catch(() => null);
    const hydrated = devices.map((device) => {
      try {
        return mergeDeviceTelemetry(device, snapshotHistory);
      } catch {
        return device;
      }
    });
    const activeDevice = hydrated[0] ?? state.device;
    let appended = false;
    if (document.body.classList.contains("ai-history-sheet-open")) {
      let hasDeviceDataset = false;
      hydrated.forEach((device) => {
        if (hasDeviceCameraHistory(device)) hasDeviceDataset = true;
        if (appendDeviceCameraHistory(device)) appended = true;
      });
      if (!hasDeviceDataset && appendSnapshotHistoryFromRaw(snapshotHistory, activeDevice)) appended = true;
    }
    if (appended) renderAiHistorySheetContent();
    return hydrated;
  }

  function mergeDeviceTelemetry(device: DeviceRecord, snapshotRaw: unknown): DeviceRecord {
    const snapshotDataset = normalizeSnapshotHistoryDataset(snapshotRaw);
    const snapshotFresh = Boolean(snapshotDataset?.updatedAt && Date.now() - snapshotDataset.updatedAt <= CAMERA_SNAPSHOT_FRESH_MS);
    const mergedDataset = mergeCameraDataset(snapshotFresh ? snapshotDataset : undefined, device.cameraDataset);

    return {
      ...device,
      cameraThumbnailUrl: snapshotFresh ? mergedDataset?.snapshot1Url || mergedDataset?.snapshot2Url || device.cameraThumbnailUrl : device.cameraThumbnailUrl,
      cameraDataset: mergedDataset,
      cameraUpdatedAt: Math.max(device.cameraUpdatedAt || 0, snapshotFresh ? snapshotDataset?.updatedAt || 0 : 0) || device.cameraUpdatedAt,
    };
  }

  function applyDevices(devices: DeviceRecord[]): void {
    state.devices = devices;
    const activeIds = new Set(devices.map((d) => d.id));
    removeMissingMarkers(activeIds);
    devices.forEach((d) => ensureMarker(d));
    mapRoot.dataset.raspberryMarkerCount = String(state.markers.size);
    const selected = state.device && activeIds.has(state.device.id)
      ? devices.find((d) => d.id === state.device!.id) ?? devices[0]
      : devices[0];
    state.device = selected;
    showUpdateNoticeForDevice(selected);
    renderCameraTile();
    syncOpenCameraFrameUrls(selected);
    devices.forEach((device) => {
      void resolveRoadName(device).then(() => {
        state.trafficById.set(device.id, buildTrafficState(device));
        const marker = state.markers.get(device.id);
        if (marker) {
          const size = markerSizeByZoom();
          marker.setIcon(L.divIcon({
            className: "traffic-light-marker-icon",
            html: makeTrafficLightSvg(trafficStateForDevice(device), size),
            iconSize: [size, Math.round(size * 1.5)],
            iconAnchor: markerAnchorBySize(size),
            popupAnchor: [0, -Math.round(size * 1.2)],
          }));
        }
        if (state.activeModalDeviceId === device.id && state.device?.id === device.id) {
          refreshOpenDeviceModal(device);
        }
      });
    });
    if (!state.hasCentered) {
      map.setView([selected.position.lat, selected.position.lng],
        map.getZoom() || DEFAULT_ZOOM, { animate: false });
      state.hasCentered = true;
    }

    syncPoiMarkers([selected.position.lat, selected.position.lng]);
    rescaleMarkers();
  }

  function updateNoticeTitle(update: ControllerUpdateInfo): string {
    if (update.status === "error") return "Update controller gagal";
    if (update.stage === "downloading") return "Mengunduh update controller";
    if (update.stage === "downloaded") return "Update controller berhasil diunduh";
    if (update.stage === "installing") return "Menerapkan update controller";
    if (update.stage === "rebooting") return "Raspberry Pi akan restart";
    if (update.stage === "restarted") return "Controller berhasil direstart";
    if (update.stage === "up-to-date") return "Controller sudah versi terbaru";
    if (update.status === "complete") return "Update controller selesai";
    return "Status update controller";
  }

  function updateNoticeMessage(update: ControllerUpdateInfo): string {
    if (isControllerHtmlBundleError(update)) {
      return "Controller menerima HTML website dari hosting, bukan paket update controller. Tidak ada filesystem Raspberry yang disentuh dashboard; URL update controller di Raspberry perlu diarahkan ke artefak controller yang benar.";
    }
    return update.message || "Status update controller berubah";
  }

  function isControllerHtmlBundleError(update: ControllerUpdateInfo): boolean {
    const rawBundle = update.bundleSha?.replace(/\s+/g, "").toLowerCase() || "";
    return update.status === "error" && rawBundle.startsWith("<!doctypehtml");
  }

  function maybeShowBrowserNotification(title: string, message: string): void {
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    try {
      const notification = new Notification(title, {
        body: message,
        tag: "its-controller-update",
        silent: false,
      });
      window.setTimeout(() => notification.close(), 7000);
    } catch {
      // Browser may block system notifications despite a granted permission.
    }
  }

  function requestBrowserNotificationPermission(): void {
    if (!("Notification" in window)) {
      showGlobalNotice("warning", "Notifikasi browser tidak didukung", "Browser ini belum mendukung notifikasi sistem");
      return;
    }
    void (async () => {
      try {
        const registration = await navigator.serviceWorker.ready;
        const push = await enablePublicPush(registration);
        if (push.subscribed) {
          showGlobalNotice("success", "Notifikasi publik aktif", push.message);
          maybeShowBrowserNotification("Notifikasi ITS aktif", "Update publik dapat diterima melalui service worker saat tab ditutup");
        } else {
          showGlobalNotice("warning", "Notifikasi belum aktif", push.message);
        }
      } catch (error) {
        showGlobalNotice("warning", "Notifikasi belum aktif", error instanceof Error ? error.message : "Registrasi push gagal");
      }
    })();
  }

  function maybePromptNotificationPermission(): void {
    if (state.notificationPromptShown) return;
    if (!("Notification" in window) || Notification.permission !== "default") return;
    state.notificationPromptShown = true;
    showGlobalNotice(
      "info",
      "Aktifkan notifikasi publik",
      "Tekan Aktifkan agar release dan status penting dapat diterima meski tab ITS Maps ditutup",
      { actionLabel: "Aktifkan", onAction: requestBrowserNotificationPermission },
    );
  }

  function showGlobalNotice(
    kind: NoticeKind,
    title: string,
    message: string,
    action?: { actionLabel: string; onAction: () => void },
  ): void {
    let host = document.querySelector<HTMLDivElement>(".global-notice-host");
    if (!host) {
      host = document.createElement("div");
      host.className = "global-notice-host";
      document.body.appendChild(host);
    }

    const notice = document.createElement("div");
    notice.className = `global-notice global-notice-${kind}`;
    notice.innerHTML = `
  <div class="global-notice-dot"></div>
  <div class="global-notice-copy">
    <strong>${escapeHtml(title)}</strong>
    <span>${escapeHtml(message)}</span>
  </div>
  ${action ? `<button class="global-notice-action" type="button">${escapeHtml(action.actionLabel)}</button>` : ""}
`;
    notice.querySelector<HTMLButtonElement>(".global-notice-action")?.addEventListener("click", () => {
      action?.onAction();
      notice.classList.remove("show");
      window.setTimeout(() => notice.remove(), 220);
    });
    host.appendChild(notice);
    window.setTimeout(() => notice.classList.add("show"), 20);
    window.setTimeout(() => {
      notice.classList.remove("show");
      window.setTimeout(() => notice.remove(), 220);
    }, action ? 12000 : kind === "error" ? 9000 : 6500);
  }

  function showUpdateNoticeForDevice(device: DeviceRecord | null): void {
    const update = device?.update;
    if (!device || !update) return;
    const updatedAt = normalizeEpoch(update.updatedAt ?? 0);
    if (!updatedAt) return;
    const ageMs = Date.now() - updatedAt;
    if (ageMs > 20 * 60_000 && update.status !== "running") return;
    const key = `${device.id}:${update.status || ""}:${update.stage || ""}:${updatedAt}`;
    if (state.lastUpdateNoticeKey === key) return;
    state.lastUpdateNoticeKey = key;
    if (isControllerHtmlBundleError(update)) return;

    const kind = update.status === "error"
      ? "error"
      : update.status === "complete"
        ? "success"
        : update.stage === "rebooting"
          ? "warning"
          : "info";
    const title = updateNoticeTitle(update);
    const message = updateNoticeMessage(update);
    showGlobalNotice(kind, title, message);
    maybeShowBrowserNotification(title, message);
  }

  function reportOfflineDevices(devices: DeviceRecord[]): void {
    const staleOffline = devices.filter((device) =>
      device.status === "offline"
      && device.lastSeen > 0
      && Date.now() - device.lastSeen > OFFLINE_AFTER_MS
      && !deviceCameraIsLive(device)
      && !state.offlineReported.has(device.id),
    );

    staleOffline.forEach((device) => {
      state.offlineReported.add(device.id);
      console.info("[ITS] Device heartbeat stale; dashboard keeps RTDB status read-only:", device.id);
    });
  }

  async function refreshSnapshot(): Promise<void> {
    if (document.body.classList.contains("video-focus-mode")) {
      window.clearTimeout(state.refreshTimer);
      state.refreshTimer = 0;
      return;
    }
    if (state.refreshBusy) return;
    state.refreshBusy = true;
    try {
      // Baca config — jangan crash jika tidak ada (return HTML 404)
      try {
        const config = await fetchJson<AppConfig>("./data/its-config.json");
        state.config = {
          snapshotUrl: config.snapshotUrl?.trim() || DEFAULT_CONFIG.snapshotUrl,
          refreshMs: config.refreshMs && config.refreshMs > 0
            ? config.refreshMs : DEFAULT_CONFIG.refreshMs,
        };
      } catch {
        state.config = DEFAULT_CONFIG;
      }

      // Coba snapshot lokal → fallback Firebase
      let snapshot: Snapshot | null = null;
      try {
        snapshot = await fetchJson<Snapshot>(state.config.snapshotUrl);
      } catch (localErr) {
        console.debug("[ITS] Local snapshot failed, trying Firebase:", localErr);
        snapshot = await fetchFirebaseDevices();
      }

      let devices = normalizeDevices(snapshot);
      if (snapshot.source === "firebase" && devices.length) {
        devices = await hydrateFirebaseTelemetry(devices);
      }

      // Jika lokal ada tapi kosong, coba Firebase
      if (!devices.length) {
        console.debug("[ITS] Local snapshot empty, trying Firebase...");
        try {
          const fbSnapshot = await fetchFirebaseDevices();
          devices = normalizeDevices(fbSnapshot);
          if (devices.length) devices = await hydrateFirebaseTelemetry(devices);
        } catch { /* Firebase juga gagal, biarkan devices tetap kosong */ }
      }

      if (!devices.length) throw new Error("No valid devices found (local & Firebase)");

      applyDevices(devices);
      maybePromptNotificationPermission();
      reportOfflineDevices(devices);
    } catch (err) {
      console.debug("[ITS] Snapshot fallback unavailable:", err);
      for (const marker of state.markers.values()) map.removeLayer(marker);
      state.markers.clear();
      state.devices = [];
      state.device = null;
    } finally {
      state.refreshBusy = false;
      window.clearTimeout(state.refreshTimer);
      state.refreshTimer = document.body.classList.contains("video-focus-mode")
        ? 0
        : window.setTimeout(refreshSnapshot, state.config.refreshMs);
      itsInitialDataReady = true;
      window.dispatchEvent(new CustomEvent("its:initial-data-ready"));
    }
  }

  const teardownMapForNavigation = (): void => {
    if (isMapTearingDown) return;
    isMapTearingDown = true;
    window.removeEventListener("resize", syncModeControlVisibility);
    window.clearTimeout(state.refreshTimer);
    window.clearTimeout(state.trafficRefreshTimer);
    window.clearTimeout(state.nativeLocationPollTimer);
    if (state.maplibreSyncFrame) window.cancelAnimationFrame(state.maplibreSyncFrame);
    if (state.snapshotHistoryAnimationFrame) window.cancelAnimationFrame(state.snapshotHistoryAnimationFrame);
    if (state.videoRfDetrAnimationFrame) window.cancelAnimationFrame(state.videoRfDetrAnimationFrame);
    stopWebRtcSession(true);
    mapDynamicsRenderer.dispose();
    map.stop();
    map.off();

    const internals = map as typeof map & {
      _initEvents?: (remove?: boolean) => void;
      _resizeRequest?: number | null;
    };
    internals._initEvents?.(true);
    if (internals._resizeRequest) {
      window.cancelAnimationFrame(internals._resizeRequest);
      internals._resizeRequest = null;
    }
  };

  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) teardownMapForNavigation();
  });
  window.addEventListener("beforeunload", teardownMapForNavigation, { once: true });

  // ═══════════════════════════════════════════════════════════════════════════
  // MOBILE UI PATCH — VERSI FIXED (semua error TS6133 sudah diperbaiki)
  // Ganti seluruh blok mobile patch di main.ts dengan file ini
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── Mobile Detection ───────────────────────────────────────────────────────

  function isMobile(): boolean {
    // Treat narrow phones as mobile. Tablets (~768px) should NOT be classified as mobile
    return window.innerWidth <= 600 || /Mobi|Android|iPhone(?!.*iPad)|Android.*Mobile/i.test(navigator.userAgent);
  }

  function isTablet(): boolean {
    // Classify tablet purely by width to avoid UA inconsistencies in responsive emulation
    const w = window.innerWidth;
    return w >= 601 && w <= 1200;
  }

  // ─── Types ───────────────────────────────────────────────────────────────────

  type MobileTab = "peta" | "its" | "profil";
  type LayerMode = "street" | "satellite" | "3d";

  const mobileState = {
    activeTab: "peta" as MobileTab,
    layerModalOpen: false,
  };

  type MobileTutorialStep = {
    id: string;
    title: string;
    body: string;
    selector?: string;
    action: "next" | "click" | "swipe" | "finish";
    cta?: string;
    onEnter?: () => void;
  };

  const MOBILE_TUTORIAL_STORAGE_KEY = "its-mobile-tutorial:v1";
  const mobileTutorialSteps: MobileTutorialStep[] = [
    {
      id: "welcome",
      title: "Selamat datang di ITS Maps",
      body: "Tutorial singkat ini akan memandu tombol peta, menu bawah, dan panel swipe. Ikuti tindakan yang diminta agar langkah berikutnya terbuka.",
      action: "next",
      cta: "Mulai",
    },
    {
      id: "zoom-in",
      title: "Perbesar peta",
      body: "Tekan tombol + untuk memperbesar area peta.",
      selector: '.map-toolbar-mobile [data-action="zoom-in"]',
      action: "click",
    },
    {
      id: "zoom-out",
      title: "Perkecil peta",
      body: "Tekan tombol - untuk mengembalikan zoom peta.",
      selector: '.map-toolbar-mobile [data-action="zoom-out"]',
      action: "click",
    },
    {
      id: "home",
      title: "Kembali ke Raspberry",
      body: "Tekan tombol rumah untuk memusatkan peta ke perangkat Raspberry.",
      selector: '.map-toolbar-mobile [data-action="home"]',
      action: "click",
    },
    {
      id: "locate",
      title: "Lokasi pengguna",
      body: "Tekan tombol lokasi untuk menampilkan posisi pengguna. Jika browser meminta izin, pilih izinkan.",
      selector: '.map-toolbar-mobile [data-action="locate"]',
      action: "click",
    },
    {
      id: "layer",
      title: "Lapisan peta",
      body: "Tekan tombol lapisan untuk memilih tampilan 2D, satelit, atau 3D.",
      selector: "#m-layer-btn",
      action: "click",
    },
    {
      id: "layer-choice",
      title: "Pilih mode peta",
      body: "Tekan salah satu pilihan tampilan peta. Setelah dipilih, panel akan menutup otomatis.",
      selector: "#m-layer-modal .m-layer-opt",
      action: "click",
    },
    {
      id: "camera",
      title: "Video Raspberry",
      body: "Tekan tombol kamera untuk membuka panel ITS berisi video realtime, data kendaraan, dan status lalu lintas.",
      selector: ".map-toolbar-mobile .toolbar-camera",
      action: "click",
    },
    {
      id: "back-to-map",
      title: "Kembali ke menu Peta",
      body: "Tekan menu Peta untuk kembali ke tampilan peta utama sebelum mencoba panel riwayat.",
      selector: '#m-bottom-nav [data-tab="peta"]',
      action: "click",
    },
    {
      id: "history-swipe",
      title: "Panel riwayat AI",
      body: "Buka panel Riwayat AI untuk melihat snapshot Raspberry dan hasil analisis.",
      selector: '#m-ai-history-sheet [data-ai-history-tab="history"]',
      action: "click",
      onEnter: () => {
        closeITSSheet();
        openAiHistorySheet("dock");
      },
    },
    {
      id: "about-tab",
      title: "Tentang tim",
      body: "Tekan tab Tentang untuk melihat tabel profil pencipta dan anggota tim.",
      selector: '#m-ai-history-sheet [data-ai-history-tab="about"]',
      action: "click",
      onEnter: () => snapAiHistorySheet("peek"),
    },
    {
      id: "profile-menu",
      title: "Menu Profil",
      body: "Tekan Profil untuk melihat ringkasan perangkat, status online, dan informasi operator.",
      selector: '#m-bottom-nav [data-tab="profil"]',
      action: "click",
    },
    {
      id: "finish",
      title: "Tutorial selesai",
      body: "ITS Maps siap digunakan. Semoga membantu!",
      action: "finish",
      cta: "Selesai",
    },
  ];

  const mobileTutorial = {
    active: false,
    index: 0,
    overlay: null as HTMLElement | null,
    card: null as HTMLElement | null,
    spotlight: null as HTMLElement | null,
    retryTimer: 0,
  };

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

  function mobileTutorialStep(): MobileTutorialStep {
    return mobileTutorialSteps[Math.min(mobileTutorial.index, mobileTutorialSteps.length - 1)];
  }

  function mobileTutorialTarget(step = mobileTutorialStep()): HTMLElement | null {
    if (!step.selector) return null;
    const el = document.querySelector<HTMLElement>(step.selector);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return el;
  }

  function mobileTutorialCardPosition(targetRect: DOMRect | null, card: HTMLElement): void {
    const margin = 14;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cardRect = card.getBoundingClientRect();
    const cardW = Math.min(cardRect.width || 318, vw - margin * 2);
    const cardH = cardRect.height || 176;
    let left = targetRect
      ? targetRect.left + targetRect.width / 2 - cardW / 2
      : vw / 2 - cardW / 2;
    left = clamp(left, margin, Math.max(margin, vw - cardW - margin));
    let top = targetRect
      ? targetRect.bottom + 14
      : Math.max(80, vh * 0.18);
    if (targetRect && top + cardH + margin > vh) top = targetRect.top - cardH - 14;
    if (top < margin) top = Math.min(vh - cardH - margin, targetRect ? targetRect.bottom + 14 : margin);
    card.style.left = `${Math.round(clamp(left, margin, Math.max(margin, vw - cardW - margin)))}px`;
    card.style.top = `${Math.round(clamp(top, margin, Math.max(margin, vh - cardH - margin)))}px`;
  }

  function renderMobileTutorialStep(): void {
    if (!mobileTutorial.active || !mobileTutorial.overlay || !mobileTutorial.card || !mobileTutorial.spotlight) return;
    window.clearTimeout(mobileTutorial.retryTimer);
    const step = mobileTutorialStep();
    step.onEnter?.();
    const target = mobileTutorialTarget(step);
    const rect = target?.getBoundingClientRect() || null;
    const needsAction = step.action === "click" || step.action === "swipe";
    const progress = `${Math.min(mobileTutorial.index + 1, mobileTutorialSteps.length)} / ${mobileTutorialSteps.length}`;
    mobileTutorial.card.innerHTML = `
      <div class="its-tutorial-kicker">${escapeHtml(progress)}</div>
      <strong>${escapeHtml(step.title)}</strong>
      <p>${escapeHtml(step.body)}</p>
      ${needsAction ? `<div class="its-tutorial-action">Tekan bagian yang disorot untuk lanjut</div>` : ""}
      <div class="its-tutorial-controls">
        <button type="button" class="its-tutorial-skip" data-tutorial-skip>Lewati</button>
        ${needsAction ? "" : `<button type="button" class="its-tutorial-next" data-tutorial-next>${escapeHtml(step.cta || "Lanjut")}</button>`}
      </div>
    `;
    mobileTutorial.card.querySelector<HTMLButtonElement>("[data-tutorial-next]")?.addEventListener("click", () => advanceMobileTutorial());
    mobileTutorial.card.querySelector<HTMLButtonElement>("[data-tutorial-skip]")?.addEventListener("click", () => finishMobileTutorial(true));
    if (rect) {
      mobileTutorial.spotlight.hidden = false;
      mobileTutorial.spotlight.style.left = `${Math.round(rect.left - 7)}px`;
      mobileTutorial.spotlight.style.top = `${Math.round(rect.top - 7)}px`;
      mobileTutorial.spotlight.style.width = `${Math.round(rect.width + 14)}px`;
      mobileTutorial.spotlight.style.height = `${Math.round(rect.height + 14)}px`;
    } else {
      mobileTutorial.spotlight.hidden = true;
    }
    requestAnimationFrame(() => {
      if (!mobileTutorial.card) return;
      mobileTutorialCardPosition(rect, mobileTutorial.card);
    });
    if (step.selector && !target) {
      mobileTutorial.retryTimer = window.setTimeout(renderMobileTutorialStep, 180);
    }
  }

  function advanceMobileTutorial(): void {
    if (!mobileTutorial.active) return;
    if (mobileTutorial.index >= mobileTutorialSteps.length - 1) {
      finishMobileTutorial(false);
      return;
    }
    mobileTutorial.index += 1;
    renderMobileTutorialStep();
  }

  function finishMobileTutorial(skipped: boolean): void {
    window.clearTimeout(mobileTutorial.retryTimer);
    mobileTutorial.active = false;
    try {
      localStorage.setItem(MOBILE_TUTORIAL_STORAGE_KEY, skipped ? "skipped" : "done");
    } catch {
      /* ignore */
    }
    document.body.classList.remove("its-tutorial-active");
    mobileTutorial.overlay?.remove();
    mobileTutorial.overlay = null;
    mobileTutorial.card = null;
    mobileTutorial.spotlight = null;
  }

  function handleMobileTutorialClick(event: MouseEvent): void {
    if (!mobileTutorial.active) return;
    const step = mobileTutorialStep();
    if (step.action !== "click" || !step.selector) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest(step.selector)) return;
    window.setTimeout(() => advanceMobileTutorial(), 260);
  }

  function handleMobileTutorialAction(event: Event): void {
    if (!mobileTutorial.active) return;
    const detail = (event as CustomEvent<{ action?: string }>).detail;
    const step = mobileTutorialStep();
    if (step.action === "swipe" && detail?.action === "history-opened") {
      window.setTimeout(() => advanceMobileTutorial(), 180);
    }
  }

  function startMobileTutorialIfNeeded(): void {
    if (!isMobile() || mobileTutorial.active) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("tutorial") === "1") {
      try { localStorage.removeItem(MOBILE_TUTORIAL_STORAGE_KEY); } catch { /* ignore */ }
    }
    try {
      if (localStorage.getItem(MOBILE_TUTORIAL_STORAGE_KEY)) return;
    } catch {
      /* ignore */
    }
    const overlay = document.createElement("div");
    overlay.id = "its-mobile-tutorial";
    overlay.className = "its-tutorial-overlay";
    overlay.setAttribute("aria-live", "polite");
    overlay.innerHTML = `
      <div class="its-tutorial-scrim" aria-hidden="true"></div>
      <div class="its-tutorial-spotlight" aria-hidden="true"></div>
      <section class="its-tutorial-card" role="dialog" aria-label="Tutorial ITS Maps"></section>
    `;
    document.body.appendChild(overlay);
    mobileTutorial.active = true;
    mobileTutorial.index = 0;
    mobileTutorial.overlay = overlay;
    mobileTutorial.card = overlay.querySelector<HTMLElement>(".its-tutorial-card");
    mobileTutorial.spotlight = overlay.querySelector<HTMLElement>(".its-tutorial-spotlight");
    document.body.classList.add("its-tutorial-active");
    renderMobileTutorialStep();
  }

  document.addEventListener("click", handleMobileTutorialClick, true);
  window.addEventListener("resize", () => {
    if (mobileTutorial.active) renderMobileTutorialStep();
  });
  window.addEventListener("its:tutorial-action", handleMobileTutorialAction);

  // ─── 1. Bottom Navigation (Blur) ─────────────────────────────────────────────

  function createMobileBottomNav(): HTMLElement {
    const nav = document.createElement("nav");
    nav.id = "m-bottom-nav";
    nav.innerHTML = `
  <button class="m-nav-tab active" data-tab="peta">
    <span class="m-nav-icon">
      <img src="/petaits.png" alt="" width="22" height="22"
           onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
      <svg style="display:none" viewBox="0 0 24 24" fill="none" width="22" height="22">
        <path d="M3 6l7-3 4 2 7-3v15l-7 3-4-2-7 3V6z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M10 3v15M14 5v15" stroke="currentColor" stroke-width="1.5"/>
      </svg>
    </span>
    <span class="m-nav-label">Peta</span>
  </button>
  <button class="m-nav-tab" data-tab="its">
    <span class="m-nav-icon">
      <img src="/itss.png" alt="" width="22" height="22"
           onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
      <svg style="display:none" viewBox="0 0 24 24" fill="none" width="22" height="22">
        <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" stroke-width="1.8"/>
        <path d="M8 21h8M12 17v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
    </span>
    <span class="m-nav-label">ITS</span>
  </button>
  <button class="m-nav-tab" data-tab="profil">
    <span class="m-nav-icon">
      <svg viewBox="0 0 24 24" fill="none" width="22" height="22">
        <circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.8"/>
        <path d="M4 20c0-3.314 3.582-6 8-6s8 2.686 8 6"
              stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
    </span>
    <span class="m-nav-label">Profil</span>
  </button>
`;

    nav.querySelectorAll<HTMLButtonElement>(".m-nav-tab").forEach(btn => {
      btn.addEventListener("click", () => switchMobileTab(btn.dataset.tab as MobileTab));
    });

    return nav;
  }

  function switchMobileTab(tab: MobileTab): void {
    closeModal(false);
    mobileState.activeTab = tab;

    document.querySelectorAll(".m-nav-tab").forEach(b => b.classList.remove("active"));
    document.querySelector<HTMLButtonElement>(`.m-nav-tab[data-tab="${tab}"]`)?.classList.add("active");

    if (tab === "peta") {
      closeITSSheet();
      openAiHistorySheet("dock");
    } else if (tab === "its") {
      document.getElementById("m-profil-sheet")?.remove();
      const hasHistorySheet = Boolean(document.getElementById("m-ai-history-sheet"));
      if (hasHistorySheet) snapAiHistorySheet("dock");
      openITSSheet({ overlay: hasHistorySheet });
    } else if (tab === "profil") {
      closeITSSheet();
      if (document.getElementById("m-ai-history-sheet")) snapAiHistorySheet("dock");
      openProfilSheet();
    }
  }

  type AiHistorySnap = "closed" | "dock" | "peek" | "full";
  let aiHistoryActiveTab: "history" | "about" = "history";
  let snapshotHistoryWarmupTimer = 0;

  const AI_HISTORY_SNAP = {
    dock: () => 56,
    peek: () => Math.round((window.innerHeight - 64) * 0.72),
    full: () => Math.round(window.innerHeight - 64),
  };

  function setAiHistorySheetProgress(heightPx: number): void {
    const dock = AI_HISTORY_SNAP.dock();
    const peek = AI_HISTORY_SNAP.peek();
    const full = AI_HISTORY_SNAP.full();
    const reveal = clamp((heightPx - dock) / Math.max(1, peek - dock), 0, 1);
    const fullProgress = clamp(heightPx / Math.max(1, full), 0, 1);
    const root = document.documentElement;
    root.style.setProperty("--ai-history-progress", reveal.toFixed(3));
    root.style.setProperty("--ai-history-full-progress", fullProgress.toFixed(3));
    root.style.setProperty("--ai-history-bg-alpha", reveal.toFixed(3));
    root.style.setProperty("--ai-history-content-alpha", clamp(reveal * 1.24 - 0.12, 0, 1).toFixed(3));
    root.style.setProperty("--ai-history-shadow-alpha", (0.18 * reveal).toFixed(3));
  }

  function aiHistoryDetailStackHeight(): number {
    const custom = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ai-history-detail-target-height"));
    if (Number.isFinite(custom) && custom > 0) return clamp(Math.round(custom), 260, Math.round(window.innerHeight * 0.58));
    return clamp(Math.round(window.innerHeight * 0.36), 260, 430);
  }

  function setAiHistoryDetailStackSpace(spacePx: number, heightPx = aiHistoryDetailStackHeight()): void {
    document.documentElement.style.setProperty("--ai-history-detail-height", `${Math.max(0, Math.round(heightPx))}px`);
    document.documentElement.style.setProperty("--ai-history-detail-space", `${Math.max(0, Math.round(spacePx))}px`);
  }

  function resetAiHistoryDetailStack(): void {
    document.body.classList.remove("ai-history-detail-stack-open");
    document.documentElement.style.removeProperty("--ai-history-detail-height");
    document.documentElement.style.removeProperty("--ai-history-detail-space");
    document.documentElement.style.removeProperty("--ai-history-detail-target-height");
  }

  function aiHistoryIsMobileDocked(): boolean {
    return isMobile() && document.body.classList.contains("ai-history-sheet-dock");
  }

  function ensureMobileHistoryNavVisible(): void {
    if (!isMobile()) return;
    document.getElementById("m-bottom-nav")?.classList.remove("hidden");
  }

  function clearDockedAiHistoryContent(): void {
    const sheet = document.getElementById("m-ai-history-sheet");
    sheet?.querySelectorAll(".m-ai-history-panel-header, .m-ai-history-tabs, .m-ai-history-content").forEach((element) => {
      element.remove();
    });
    if (state.snapshotHistoryAnimationFrame) {
      cancelAnimationFrame(state.snapshotHistoryAnimationFrame);
      state.snapshotHistoryAnimationFrame = 0;
    }
  }

  function openAiHistorySheet(startSnap: Exclude<AiHistorySnap, "closed"> = "peek"): void {
    if (isMobile()) {
      closeModal(false);
      closeITSSheet();
      document.getElementById("m-profil-sheet")?.remove();
    }
    let sheet = document.getElementById("m-ai-history-sheet");
    if (!sheet) {
      sheet = createAiHistorySheet();
      document.getElementById("app")?.appendChild(sheet);
    }
    document.body.classList.add("ai-history-sheet-open");
    appendDeviceCameraHistory(state.device);
    scheduleSnapshotHistoryWarmup(120);
    document.body.classList.toggle("ai-history-sheet-desktop", !isMobile());
    if (usesDesktopSidePanel()) document.body.classList.add("map-modal-panel-open");
    if (isMobile()) {
      ensureMobileHistoryNavVisible();
      document.querySelectorAll(".m-nav-tab").forEach((button) => button.classList.remove("active"));
      document.querySelector<HTMLButtonElement>('.m-nav-tab[data-tab="peta"]')?.classList.add("active");
      mobileState.activeTab = "peta";
    }
    snapAiHistorySheet(startSnap);
    if (!aiHistoryIsMobileDocked()) renderAiHistorySheetContent();
  }

  window.addEventListener("its:open-ai-history", () => {
    aiHistoryActiveTab = "history";
    openAiHistorySheet(isMobile() ? "peek" : "dock");
  });

  function closeAiHistorySheet(updateMap = true): void {
    const sheet = document.getElementById("m-ai-history-sheet");
    if (!sheet) return;
    document.getElementById("m-ai-history-detail-modal")?.remove();
    if (state.snapshotHistoryAnimationFrame) {
      cancelAnimationFrame(state.snapshotHistoryAnimationFrame);
      state.snapshotHistoryAnimationFrame = 0;
    }
    resetAiHistoryDetailStack();
    const desktop = usesDesktopSidePanel();
    sheet.style.transition = "transform 0.3s cubic-bezier(0.32,0.72,0,1)";
    sheet.style.transform = desktop
      ? `translateX(${Math.max(sheet.getBoundingClientRect().width, 360) + 24}px)`
      : `translateY(${window.innerHeight}px)`;
    document.body.classList.remove("ai-history-sheet-open", "ai-history-sheet-full", "ai-history-sheet-dock", "ai-history-sheet-desktop");
    document.body.classList.remove("map-modal-panel-open");
    setAiHistorySheetProgress(0);
    clearSidePanelWidth();
    pruneSnapshotHistoryItemsForClosedPanel();
    if (updateMap && isMobile()) setMapHeight(0);
    window.setTimeout(() => sheet.remove(), 320);
  }

  function snapAiHistorySheet(snap: Exclude<AiHistorySnap, "closed">): void {
    const sheet = document.getElementById("m-ai-history-sheet");
    if (!sheet) return;
    const desktop = !isMobile();
    if (desktop) {
      sheet.style.transition = "transform 0.34s cubic-bezier(0.32,0.72,0,1)";
      sheet.style.transform = "translateX(0)";
      document.body.classList.remove("ai-history-sheet-dock");
      document.body.classList.add("ai-history-sheet-full", "map-modal-panel-open");
      setAiHistorySheetProgress(AI_HISTORY_SNAP.full());
      requestAnimationFrame(() => setSidePanelWidthFromSheet(sheet));
      void refreshAiHistorySnapshot();
      window.dispatchEvent(new CustomEvent("its:tutorial-action", {
        detail: { action: "history-opened", snap: "full" },
      }));
      return;
    }
    const height = desktop ? AI_HISTORY_SNAP.full() : snap === "dock" ? AI_HISTORY_SNAP.dock() : snap === "peek" ? AI_HISTORY_SNAP.peek() : AI_HISTORY_SNAP.full();
    const y = desktop ? 0 : window.innerHeight - 64 - height;
    sheet.style.transition = "transform 0.34s cubic-bezier(0.32,0.72,0,1)";
    sheet.style.transform = `translateY(${Math.max(0, y)}px)`;
    document.body.classList.toggle("ai-history-sheet-full", snap === "full");
    document.body.classList.toggle("ai-history-sheet-dock", snap === "dock");
    setAiHistorySheetProgress(height);
    if (isMobile()) {
      ensureMobileHistoryNavVisible();
      setMapHeight(snap === "dock" ? 0 : height);
    }
    if (snap === "dock" && isMobile()) {
      clearDockedAiHistoryContent();
    } else {
      renderAiHistorySheetContent();
      void refreshAiHistorySnapshot();
    }
    window.dispatchEvent(new CustomEvent("its:tutorial-action", {
      detail: { action: snap === "dock" ? "history-docked" : "history-opened", snap },
    }));
  }

  function aiHistorySheetHandleHtml(): string {
    return `
  <div class="m-ai-history-handle-zone" data-swipe-handle>
    <div class="m-ai-history-handle"></div>
  </div>`;
  }

  function aiHistorySheetPanelHtml(): string {
    return `
  <div class="sheet-panel-header m-ai-history-panel-header" data-swipe-handle>
    <button class="sheet-icon-btn" data-ai-history-close aria-label="Kembali" title="Kembali" type="button">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
    </button>
    <div class="sheet-title-cluster">
      <div class="sheet-device-icon" aria-hidden="true">${cameraAiIconSvg()}</div>
      <div class="sheet-title-copy">
        <h2 class="modal-title">Riwayat AI</h2>
        <p>Snapshot kamera Raspberry</p>
      </div>
    </div>
  </div>
  <div class="modal-tabs m-ai-history-tabs" role="tablist" aria-label="Panel riwayat AI">
    <button type="button" id="m-ai-history-tab-history" class="modal-tab-btn active" role="tab" aria-selected="true" aria-controls="m-ai-history-panel" data-ai-history-tab="history">${cameraImageIconSvg()} Riwayat</button>
    <button type="button" id="m-ai-history-tab-about" class="modal-tab-btn" role="tab" aria-selected="false" aria-controls="m-ai-history-panel" data-ai-history-tab="about"><span class="tab-icon" aria-hidden="true">i</span> Tentang</button>
  </div>
  <div id="m-ai-history-panel" class="m-ai-history-content" role="tabpanel" aria-labelledby="m-ai-history-tab-history" data-ai-history-content></div>`;
  }

  function ensureAiHistorySheetContentHost(sheet: HTMLElement): HTMLElement | null {
    if (aiHistoryIsMobileDocked()) return null;
    if (!sheet.querySelector(".m-ai-history-handle-zone")) {
      sheet.insertAdjacentHTML("afterbegin", aiHistorySheetHandleHtml());
    }
    if (!sheet.querySelector(".m-ai-history-panel-header")) {
      sheet.querySelector(".m-ai-history-handle-zone")?.insertAdjacentHTML("afterend", aiHistorySheetPanelHtml());
    }
    let host = sheet.querySelector<HTMLElement>("[data-ai-history-content]");
    if (!host) {
      sheet.querySelector(".m-ai-history-tabs")?.insertAdjacentHTML(
        "afterend",
        '<div id="m-ai-history-panel" class="m-ai-history-content" role="tabpanel" aria-labelledby="m-ai-history-tab-history" data-ai-history-content></div>',
      );
      host = sheet.querySelector<HTMLElement>("[data-ai-history-content]");
    }
    return host;
  }

  function createAiHistorySheet(): HTMLElement {
    const sheet = document.createElement("section");
    sheet.id = "m-ai-history-sheet";
    sheet.setAttribute("aria-label", "Riwayat snapshot AI");
    sheet.innerHTML = `${aiHistorySheetHandleHtml()}${aiHistorySheetPanelHtml()}`;

    let startX = 0;
    let startY = 0;
    let startTranslate = 0;
    let pointerId = -1;
    let dragging = false;
    let startedAt = 0;

    sheet.addEventListener("pointerdown", (event) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("[data-swipe-handle], .m-ai-history-panel-header")) return;
      if (target.closest("button, a, input, label, select, textarea")) return;
      startY = event.clientY;
      startX = event.clientX;
      const matrix = new DOMMatrix(getComputedStyle(sheet).transform);
      startTranslate = usesDesktopSidePanel() ? matrix.m41 : matrix.m42;
      pointerId = event.pointerId;
      dragging = true;
      startedAt = performance.now();
      sheet.style.transition = "none";
      try { sheet.setPointerCapture?.(event.pointerId); } catch { /* Pointer may already be released. */ }
      document.body.classList.add("ai-history-sheet-dragging");
    });

    sheet.addEventListener("pointermove", (event) => {
      if (!dragging || event.pointerId !== pointerId) return;
      event.preventDefault();
      if (usesDesktopSidePanel()) {
        const rawX = startTranslate + event.clientX - startX;
        const x = clamp(rawX, 0, sheet.getBoundingClientRect().width + 32);
        sheet.style.transform = `translateX(${x}px)`;
        setSidePanelWidth(Math.max(0, sheet.getBoundingClientRect().width - x));
        return;
      }
      const rawY = startTranslate + event.clientY - startY;
      const minY = 0;
      const maxY = window.innerHeight - 64 - AI_HISTORY_SNAP.dock();
      const y = clamp(rawY, minY, maxY);
      sheet.style.transform = `translateY(${y}px)`;
      const height = window.innerHeight - 64 - y;
      document.body.classList.toggle("ai-history-sheet-dock", height <= AI_HISTORY_SNAP.dock() + 3);
      document.body.classList.toggle("ai-history-sheet-full", height >= AI_HISTORY_SNAP.full() - 3);
      setAiHistorySheetProgress(height);
      if (height > AI_HISTORY_SNAP.dock() + 18) renderAiHistorySheetContent();
      if (isMobile()) setMapHeight(height <= AI_HISTORY_SNAP.dock() ? 0 : Math.max(0, height), true);
    });

    const finish = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== pointerId) return;
      dragging = false;
      pointerId = -1;
      document.body.classList.remove("ai-history-sheet-dragging");
      if (usesDesktopSidePanel()) {
        const x = new DOMMatrix(getComputedStyle(sheet).transform).m41;
        const elapsed = Math.max(1, performance.now() - startedAt);
        const velocity = x / elapsed;
        if (x > 64 || velocity > 0.5) closeAiHistorySheet();
        else {
          sheet.style.transition = "transform 0.28s cubic-bezier(0.32,0.72,0,1)";
          sheet.style.transform = "translateX(0)";
          setSidePanelWidthFromSheet(sheet);
        }
        return;
      }
      const y = new DOMMatrix(getComputedStyle(sheet).transform).m42;
      const height = window.innerHeight - 64 - y;
      const dock = AI_HISTORY_SNAP.dock();
      const peek = AI_HISTORY_SNAP.peek();
      const full = AI_HISTORY_SNAP.full();
      if (height < lerp(dock, peek, 0.5)) {
        snapAiHistorySheet("dock");
      } else if (height < lerp(peek, full, 0.62)) {
        snapAiHistorySheet("peek");
      } else {
        snapAiHistorySheet("full");
      }
    };

    sheet.addEventListener("pointerup", finish);
    sheet.addEventListener("pointercancel", finish);
    sheet.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-ai-history-close]")) {
        event.stopPropagation();
        snapAiHistorySheet("dock");
        return;
      }
      const tab = target?.closest<HTMLButtonElement>("[data-ai-history-tab]");
      if (tab) {
        event.stopPropagation();
        aiHistoryActiveTab = tab.dataset.aiHistoryTab === "about" ? "about" : "history";
        renderAiHistorySheetContent();
      }
    });
    sheet.style.transform = `translateY(${window.innerHeight}px)`;
    return sheet;
  }

  async function refreshAiHistorySnapshot(): Promise<void> {
    if (!document.getElementById("m-ai-history-sheet")) return;
    const raw = await firebaseGetPath<unknown>("snapshotHistory").catch(() => null);
    let changed = appendDeviceCameraHistory(state.device);
    if (!hasDeviceCameraHistory(state.device) && appendSnapshotHistoryFromRaw(raw, state.device)) changed = true;
    if (changed) renderAiHistorySheetContent();
  }

  function renderAiHistorySheetContent(): void {
    const sheet = document.getElementById("m-ai-history-sheet");
    if (!sheet) return;
    if (aiHistoryIsMobileDocked()) {
      clearDockedAiHistoryContent();
      return;
    }
    const host = ensureAiHistorySheetContentHost(sheet);
    if (!host) return;
    sheet.querySelectorAll<HTMLButtonElement>("[data-ai-history-tab]").forEach((button) => {
      const active = button.dataset.aiHistoryTab === aiHistoryActiveTab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    host.setAttribute("aria-labelledby", aiHistoryActiveTab === "about" ? "m-ai-history-tab-about" : "m-ai-history-tab-history");
    if (aiHistoryActiveTab === "about") {
      host.innerHTML = renderAiAboutProfiles(PROFILE_MEMBER_COUNT);
      return;
    }

    if (!state.snapshotHistoryItems.length) {
      host.innerHTML = `
    <div class="m-ai-history-empty">
      ${cameraAiIconSvg()}
      <strong>Riwayat snapshot kosong</strong>
      <span>Menunggu snapshot 10 detik berikutnya dari Raspberry.</span>
    </div>
  `;
      return;
    }

    host.innerHTML = `
  <div class="m-ai-history-list">
    ${state.snapshotHistoryItems.map((item) => renderAiHistoryItem(item)).join("")}
  </div>
`;
    bindAiHistoryImageStates(host);
    bindAiHistoryCardActions(host);
    startAiHistoryCanvasAnimation(host);
    void analyzeVisibleHistorySnapshots(host);
  }

  function renderAiAboutProfiles(memberCount: number): string {
    const members = Array.from({ length: Math.max(1, memberCount) }, (_, index) => {
      return PROFILE_MEMBERS[index] || {
        name: `Nama anggota ${index + 1}`,
        prodi: "Belum diisi",
        posisi: "Belum diisi",
        tugas: "Belum diisi",
        photoUrl: profileAssetUrl(index),
      };
    });
    return `
  <section class="m-ai-about-section" data-jumlah-profil="${members.length}">
    ${members.map((member, index) => `
      <table class="m-ai-about-table">
        <tbody>
          <tr>
            <td class="m-profile-photo-cell" rowspan="4">
              <div class="m-profile-photo">
                <img src="${escapeHtml(member.photoUrl)}" alt="Foto ${escapeHtml(member.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.removeAttribute('hidden')">
                <span hidden>${escapeHtml(profileInitials(member.name || `P${index + 1}`))}</span>
              </div>
            </td>
            <th scope="row">Nama</th>
            <td>${escapeHtml(member.name)}</td>
          </tr>
          <tr>
            <th scope="row">Prodi</th>
            <td>${escapeHtml(member.prodi)}</td>
          </tr>
          <tr>
            <th scope="row">Posisi</th>
            <td>${escapeHtml(member.posisi)}</td>
          </tr>
          <tr>
            <th scope="row">Tugas</th>
            <td>${escapeHtml(member.tugas)}</td>
          </tr>
        </tbody>
      </table>
    `).join("")}
  </section>
`;
  }

  function profileInitials(name: string): string {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("") || "ITS";
  }

  function renderAiHistoryItem(item: SnapshotHistoryItem): string {
    const confirmed = historyConfirmedDetections(item);
    const visible = visibleHistoryDetections(item);
    const visibleCount = item.analyzed ? visible.length : 0;
    const totalCount = confirmed.length;
    const statusText = !item.analyzed
      ? "AI memindai snapshot"
      : totalCount
        ? `${visibleCount}/${totalCount} objek terkonfirmasi`
        : "AI selesai, belum ada objek yang cukup yakin";
    const detailsDisabled = !item.analyzed ? " disabled aria-disabled=\"true\"" : "";
    return `
  <article class="m-ai-history-card" data-history-id="${escapeHtml(item.id)}">
    <div class="m-ai-history-media">
      <img src="${escapeHtml(item.imageUrl)}" alt="Snapshot kamera ${escapeHtml(item.deviceId)}" loading="lazy" crossorigin="anonymous">
      <canvas data-history-rf-detr-canvas data-history-id="${escapeHtml(item.id)}" data-detector-fit="contain" aria-hidden="true"></canvas>
      <div class="m-ai-history-broken">${cameraImageIconSvg()}<span>Snapshot belum terbaca dari Raspberry</span></div>
    </div>
    <div class="m-ai-history-meta">
      <span>${clockIconSvg()}${escapeHtml(snapshotHistoryTimeText(item.capturedAt))}</span>
      <span>${pinIconSvg()}${escapeHtml(item.locationText)}</span>
      <button class="m-ai-history-result" data-history-details="${escapeHtml(item.id)}" type="button"${detailsDisabled}>
        ${cameraAiIconSvg()}
        <span data-history-status>${escapeHtml(statusText)}</span>
      </button>
    </div>
  </article>
`;
  }

  function bindAiHistoryImageStates(root: ParentNode): void {
    root.querySelectorAll<HTMLImageElement>(".m-ai-history-media img").forEach((image) => {
      const media = image.closest<HTMLElement>(".m-ai-history-media");
      if (!media) return;
      const markLoaded = () => {
        media.classList.add("image-loaded");
        const host = media.closest<HTMLElement>("[data-ai-history-content]");
        if (host) startAiHistoryCanvasAnimation(host);
      };
      const markError = () => media.classList.add("image-error");
      image.addEventListener("load", markLoaded, { once: true });
      image.addEventListener("error", markError, { once: true });
      if (image.complete) {
        if (image.naturalWidth && image.naturalHeight) markLoaded();
        else markError();
      }
    });
  }

  function drawAiHistoryCanvasesFrame(root: ParentNode, now = Date.now()): boolean {
    let shouldContinue = false;
    root.querySelectorAll<HTMLCanvasElement>("[data-history-rf-detr-canvas]").forEach((canvas) => {
      const item = state.snapshotHistoryItems.find((entry) => entry.id === canvas.dataset.historyId);
      if (!item) return;
      const image = canvas.parentElement?.querySelector<HTMLImageElement>("img") || null;
      const frameWidth = item.frameWidth || image?.naturalWidth || 0;
      const frameHeight = item.frameHeight || image?.naturalHeight || 0;
      if (!frameWidth || !frameHeight) return;
      const confirmed = historyConfirmedDetections(item);
      const detections = visibleHistoryDetections(item, now);
      const scannerFocus = item.analyzed && confirmed.length
        ? confirmed[Math.min(Math.max(0, detections.length), confirmed.length - 1)]
        : null;
      const scannerActive = !item.analyzed || historyRevealStillAnimating(item, now);
      drawRfDetrDetections(
        canvas,
        detections,
        frameWidth,
        frameHeight,
        { hud: false, scanActive: scannerActive, scannerFocus },
      );
      if (!item.analyzed || historyRevealStillAnimating(item, now)) shouldContinue = true;
    });
    updateAiHistoryProgressText(root, now);
    return shouldContinue;
  }

  function startAiHistoryCanvasAnimation(root: ParentNode): void {
    if (state.snapshotHistoryAnimationFrame) cancelAnimationFrame(state.snapshotHistoryAnimationFrame);
    let lastDrawAt = 0;
    const tick = (timestamp: number) => {
      if (document.body.classList.contains("video-focus-mode")) {
        state.snapshotHistoryAnimationFrame = 0;
        return;
      }
      const sheetOpen = Boolean(document.getElementById("m-ai-history-sheet")) && aiHistoryActiveTab === "history" && !aiHistoryIsMobileDocked();
      if (!sheetOpen) {
        state.snapshotHistoryAnimationFrame = 0;
        return;
      }
      if (timestamp - lastDrawAt < 32) {
        state.snapshotHistoryAnimationFrame = requestAnimationFrame(tick);
        return;
      }
      lastDrawAt = timestamp;
      const keepGoing = drawAiHistoryCanvasesFrame(root);
      state.snapshotHistoryAnimationFrame = keepGoing ? requestAnimationFrame(tick) : 0;
    };
    state.snapshotHistoryAnimationFrame = requestAnimationFrame(tick);
  }

  function updateAiHistoryProgressText(root: ParentNode, now = Date.now()): void {
    root.querySelectorAll<HTMLElement>(".m-ai-history-card[data-history-id]").forEach((card) => {
      const item = state.snapshotHistoryItems.find((entry) => entry.id === card.dataset.historyId);
      if (!item) return;
      const confirmed = historyConfirmedDetections(item);
      const visible = visibleHistoryDetections(item, now);
      const button = card.querySelector<HTMLButtonElement>("[data-history-details]");
      const statusEl = card.querySelector<HTMLElement>("[data-history-status]");
      if (!button || !statusEl) return;
      button.disabled = !item.analyzed;
      button.setAttribute("aria-disabled", String(button.disabled));
      statusEl.textContent = !item.analyzed
        ? "AI memindai snapshot"
        : confirmed.length
          ? `${visible.length}/${confirmed.length} objek terkonfirmasi`
          : "AI selesai, belum ada objek yang cukup yakin";
    });
  }

  function bindAiHistoryCardActions(root: ParentNode): void {
    root.querySelectorAll<HTMLButtonElement>("[data-history-details]").forEach((button) => {
      button.addEventListener("click", () => {
        const item = state.snapshotHistoryItems.find((entry) => entry.id === button.dataset.historyDetails);
        if (item) openAiHistoryDetectionModal(item);
      });
    });
  }

  function openAiHistoryDetectionModal(item: SnapshotHistoryItem): void {
    document.getElementById("m-ai-history-detail-modal")?.remove();
    resetAiHistoryDetailStack();
    const detections = historyConfirmedDetections(item);
    const summary = historyDetectionSummary(detections);
    const closeDetail = () => {
      const modal = document.getElementById("m-ai-history-detail-modal");
      if (!modal) return;
      const stacked = modal.classList.contains("ai-history-detail-stacked");
      modal.classList.remove("open");
      modal.classList.add("closing");
      if (stacked) {
        const sheet = modal.querySelector<HTMLElement>(".m-ai-history-detail-sheet");
        if (sheet) {
          sheet.style.transition = "";
          sheet.style.transform = "translateY(calc(100% + 32px))";
        }
        setAiHistoryDetailStackSpace(0);
      }
      window.setTimeout(() => {
        modal.remove();
        if (stacked) resetAiHistoryDetailStack();
        const historySheet = document.getElementById("m-ai-history-sheet");
        if (historySheet && document.body.classList.contains("ai-history-sheet-open") && usesDesktopSidePanel()) {
          document.body.classList.add("map-modal-panel-open");
          setSidePanelWidthFromSheet(historySheet);
        } else if (!document.querySelector(mapSidePanelSelector())) {
          document.body.classList.remove("map-modal-panel-open");
          clearSidePanelWidth();
        }
      }, 260);
    };
    const detailRows = detections.map((det, index) => {
      const frameW = Math.max(1, item.frameWidth);
      const frameH = Math.max(1, item.frameHeight);
      const left = Math.round((det.x / frameW) * 100);
      const top = Math.round((det.y / frameH) * 100);
      const cropWidth = clamp(det.width / frameW, 0.01, 1);
      const cropHeight = clamp(det.height / frameH, 0.01, 1);
      const thumbWidth = Math.round((1 / cropWidth) * 100);
      const thumbHeight = Math.round((1 / cropHeight) * 100);
      const size = `${Math.round((det.width / frameW) * 100)}% x ${Math.round((det.height / frameH) * 100)}%`;
      return `
        <li>
          <span class="m-ai-detail-thumb" aria-hidden="true">
            <img src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" crossorigin="anonymous" style="width:${thumbWidth}%;height:${thumbHeight}%;transform:translate(-${left}%,-${top}%);">
            <em>${index + 1}</em>
          </span>
          <div>
            <strong>${escapeHtml(detectionLabel(det.label))}</strong>
            <span>Akurasi ${Math.round(det.confidence * 100)}% · area ${escapeHtml(size)} · posisi ${left}%, ${top}%</span>
          </div>
        </li>
      `;
    }).join("");
    const overlay = createSwipeableSheetModal(
      "m-ai-history-detail-modal",
      "m-ai-history-detail-sheet",
      `
      <div class="m-sheet-handle-bar" data-swipe-handle></div>
      <div class="sheet-panel-header m-ai-detail-head">
        <button class="sheet-icon-btn" data-action="close" aria-label="Tutup rincian" title="Tutup">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
        <div class="sheet-title-copy">
          <h2>Rincian Deteksi</h2>
          <p>${escapeHtml(snapshotHistoryTimeText(item.capturedAt))}</p>
        </div>
      </div>
      <div class="m-ai-detail-body">
        <div class="m-ai-detail-total">
          <span>Objek terkonfirmasi</span>
          <strong>${detections.length}</strong>
        </div>
        ${summary.length ? `
          <div class="m-ai-detail-summary">
            ${summary.map((group) => `
              <div>
                <span>${escapeHtml(group.label)}</span>
                <strong>${group.count}</strong>
                <em>akurasi maks ${Math.round(group.maxConfidence * 100)}%</em>
              </div>
            `).join("")}
          </div>
        ` : `
          <p class="m-ai-detail-empty">RF-DETR selesai, tapi belum ada object yang cukup yakin untuk dihitung.</p>
        `}
        ${detections.length ? `<ol class="m-ai-detail-list">${detailRows}</ol>` : ""}
        ${item.analysisNote ? `<p class="m-ai-detail-note">${escapeHtml(item.analysisNote)}</p>` : ""}
      </div>
    `,
    );
    const stacked = usesDesktopSidePanel()
      && Boolean(document.getElementById("m-ai-history-sheet"))
      && document.body.classList.contains("ai-history-sheet-open");
    if (stacked) {
      overlay.classList.add("ai-history-detail-stacked");
      document.body.classList.add("ai-history-detail-stack-open");
      const targetHeight = detections.length > 1 || detailRows.length > 520
        ? clamp(Math.round(window.innerHeight * 0.5), 320, Math.round(window.innerHeight * 0.58))
        : aiHistoryDetailStackHeight();
      document.documentElement.style.setProperty("--ai-history-detail-target-height", `${targetHeight}px`);
      setAiHistoryDetailStackSpace(aiHistoryDetailStackHeight());
    }
    overlay.querySelector(".m-layer-backdrop")?.addEventListener("click", closeDetail);
    overlay.querySelector<HTMLButtonElement>('[data-action="close"]')?.addEventListener("click", closeDetail);
    const sheet = overlay.querySelector<HTMLElement>(".m-ai-history-detail-sheet");
    if (sheet) {
      if (stacked) setupHistoryDetailStackDismiss(sheet, closeDetail);
      else setupSheetSwipe(sheet, closeDetail);
    }
  }

  function setupHistoryDetailStackDismiss(sheetEl: HTMLElement, onClose: () => void): void {
    let startY = 0;
    let currentY = 0;
    let pointerId = -1;
    let startedAt = 0;
    let dragging = false;
    let wheelOffset = 0;
    let wheelTimer = 0;

    const detailHeight = () => aiHistoryDetailStackHeight();
    const applyOffset = (offsetPx: number) => {
      const base = detailHeight();
      if (offsetPx < 0) {
        const expanded = clamp(base + Math.abs(offsetPx), base, Math.round(window.innerHeight * 0.58));
        currentY = 0;
        sheetEl.style.transition = "none";
        sheetEl.style.transform = "";
        setAiHistoryDetailStackSpace(expanded, expanded);
        return;
      }
      const offset = clamp(offsetPx, 0, base + 40);
      currentY = offset;
      sheetEl.style.transform = `translateY(${Math.round(offset)}px)`;
      setAiHistoryDetailStackSpace(base - offset, base);
    };
    const restore = () => {
      sheetEl.style.transition = "";
      sheetEl.style.transform = "";
      setAiHistoryDetailStackSpace(detailHeight());
      currentY = 0;
    };
    const shouldStartFromTarget = (target: HTMLElement | null): boolean => {
      if (!target) return false;
      if (target.closest("button, a, input, label, select, textarea")) return false;
      if (target.closest("[data-swipe-handle], .sheet-panel-header, .m-ai-detail-head")) return true;
      return canStartSheetDismiss(target, sheetEl, false);
    };

    const move = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== pointerId) return;
      const y = Math.max(0, event.clientY - startY);
      if (y > 2) event.preventDefault();
      applyOffset(y);
    };

    const finish = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== pointerId) return;
      dragging = false;
      pointerId = -1;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      const velocity = currentY / Math.max(1, performance.now() - startedAt);
      if (currentY > Math.min(150, detailHeight() * 0.42) || velocity > 0.55) onClose();
      else restore();
    };

    sheetEl.addEventListener("pointerdown", (event) => {
      const target = event.target as HTMLElement | null;
      if (!shouldStartFromTarget(target)) return;
      event.preventDefault();
      startY = event.clientY;
      currentY = 0;
      pointerId = event.pointerId;
      startedAt = performance.now();
      dragging = true;
      sheetEl.style.transition = "none";
      try { sheetEl.setPointerCapture?.(event.pointerId); } catch { /* Pointer may already be released. */ }
      window.addEventListener("pointermove", move, { passive: false });
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    });

    sheetEl.addEventListener("pointermove", move);
    sheetEl.addEventListener("pointerup", finish);
    sheetEl.addEventListener("pointercancel", finish);

    sheetEl.addEventListener("wheel", (event) => {
      const target = event.target as HTMLElement | null;
      const scrollTarget = nearestScrollableSheetTarget(target, sheetEl);
      const atTop = scrollTarget.scrollTop <= 1;
      if (!atTop || event.deltaY >= -8) return;
      event.preventDefault();
      wheelOffset = clamp(wheelOffset + Math.abs(event.deltaY), 0, detailHeight() + 40);
      sheetEl.style.transition = "none";
      applyOffset(wheelOffset);
      window.clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(() => {
        if (wheelOffset > Math.min(150, detailHeight() * 0.42)) onClose();
        else restore();
        wheelOffset = 0;
      }, 120);
    }, { passive: false });
  }

  function cssSelectorValue(value: string): string {
    const escaper = window.CSS?.escape;
    if (typeof escaper === "function") return escaper(value);
    return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  }

  function aiHistoryTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error(message)), ms);
      promise.then(
        (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  function waitForAiHistoryImage(image: HTMLImageElement, timeoutMs = 15_000): Promise<void> {
    if (image.complete) return Promise.resolve();
    return aiHistoryTimeout(new Promise<void>((resolve) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => resolve(), { once: true });
    }), timeoutMs, "timeout memuat snapshot riwayat");
  }

  function snapshotHistoryRfDetrOptions() {
    return {
      captureMaxEdge: 640,
      detailCrops: false,
      modelId: RF_DETR_ANDROID_MODEL_ID,
      worker: true,
      workerFallbackToMainThread: false,
      includeThumbnails: false,
      confidenceThreshold: 0.28,
      minLabelConfidenceScale: 1,
    } as const;
  }

  async function analyzeSnapshotHistoryItem(
    next: SnapshotHistoryItem,
    image: HTMLImageElement,
  ): Promise<void> {
    await waitForAiHistoryImage(image);
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("Snapshot tidak dapat dibaca");
    const result = await aiHistoryTimeout(
      runBrowserRfDetr(image, snapshotHistoryRfDetrOptions()),
      45_000,
      "timeout analisis RF-DETR riwayat",
    );
    const confirmedAt = Date.now();
    state.snapshotHistoryItems = state.snapshotHistoryItems.map((item) => item.id === next.id
      ? {
        ...item,
        analyzed: true,
        frameWidth: result.frameWidth || image.naturalWidth,
        frameHeight: result.frameHeight || image.naturalHeight,
        detections: result.detections.map(toWebRfDetrDetection),
        revealedAt: result.detections.length ? confirmedAt + 260 : confirmedAt,
        analysisNote: result.note,
      }
      : item);

    const device = state.devices.find((candidate) => candidate.id === next.deviceId)
      || (state.device?.id === next.deviceId ? state.device : null);
    if (device && result.status === "online") {
      applyVideoRfDetrResult(device, result);
      publishVideoRfDetrIfNeeded(device, result);
    }
    saveSnapshotHistoryItems();
    if (document.getElementById("m-ai-history-sheet")) renderAiHistorySheetContent();
  }

  function scheduleSnapshotHistoryWarmup(delayMs = 180): void {
    window.clearTimeout(snapshotHistoryWarmupTimer);
    snapshotHistoryWarmupTimer = window.setTimeout(() => {
      if (document.hidden || document.body.classList.contains("video-focus-mode") || state.snapshotHistoryRfDetrBusy) {
        scheduleSnapshotHistoryWarmup(1_200);
        return;
      }
      const next = nextPendingSnapshotHistoryItem();
      if (!next) return;
      state.snapshotHistoryRfDetrBusy = true;
      void (async () => {
        const image = await loadImageSource(next.imageUrl);
        if (!image) throw new Error("Snapshot RTDB tidak dapat dimuat");
        await analyzeSnapshotHistoryItem(next, image);
      })().catch((error) => {
        console.warn("[ITS] snapshot history RF-DETR warmup failed:", error);
      }).finally(() => {
        state.snapshotHistoryRfDetrBusy = false;
        if (state.snapshotHistoryItems.some((item) => !item.analyzed)) scheduleSnapshotHistoryWarmup(180);
      });
    }, delayMs);
  }

  async function analyzeVisibleHistorySnapshots(root: ParentNode): Promise<void> {
    if (document.body.classList.contains("video-focus-mode")) return;
    if (state.snapshotHistoryRfDetrBusy) return;
    const rootElement = root instanceof HTMLElement ? root : null;
    const rootRect = rootElement?.getBoundingClientRect();
    const next = [...state.snapshotHistoryItems].sort(compareSnapshotHistoryItems).find((item) => {
      if (item.analyzed) return false;
      const candidate = root.querySelector<HTMLElement>(`.m-ai-history-card[data-history-id="${cssSelectorValue(item.id)}"]`);
      if (!candidate || !rootRect) return false;
      const rect = candidate.getBoundingClientRect();
      return rect.bottom >= rootRect.top - 40 && rect.top <= rootRect.bottom + 40;
    });
    if (!next) return;
    const card = root.querySelector<HTMLElement>(`.m-ai-history-card[data-history-id="${cssSelectorValue(next.id)}"]`);
    if (card?.querySelector(".m-ai-history-media")?.classList.contains("image-error")) return;
    const image = card?.querySelector<HTMLImageElement>("img");
    if (!image) return;
    state.snapshotHistoryRfDetrBusy = true;
    try {
      await analyzeSnapshotHistoryItem(next, image);
    } catch (err) {
      console.warn("[ITS] snapshot history RF-DETR failed:", err);
      state.snapshotHistoryItems = state.snapshotHistoryItems.map((item) => item.id === next.id ? {
        ...item,
        analyzed: true,
        revealedAt: Date.now(),
        analysisNote: err instanceof Error ? err.message : "Analisis snapshot gagal",
      } : item);
      saveSnapshotHistoryItems();
      renderAiHistorySheetContent();
    } finally {
      state.snapshotHistoryRfDetrBusy = false;
      window.setTimeout(() => {
        if (document.body.classList.contains("video-focus-mode")) return;
        if (state.snapshotHistoryRfDetrBusy) return;
        if (!state.snapshotHistoryItems.some((item) => !item.analyzed)) return;
        const host = document.querySelector<HTMLElement>("#m-ai-history-sheet [data-ai-history-content]");
        if (host && aiHistoryActiveTab === "history") void analyzeVisibleHistorySnapshots(host);
      }, 80);
    }
  }

  // ─── 2. Layer Button + Swipeable Layer Modal ──────────────────────────────────

  function createLayerButton(): HTMLElement {
    const btn = document.createElement("button");
    btn.id = "m-layer-btn";
    btn.setAttribute("aria-label", "Ganti lapisan peta");
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="m12 2.8 8.2 5.1L12 13 3.8 7.9 12 2.8Z"/>
  <path d="M4.1 14.4l7.9 4.8 7.9-4.8"/>
</svg>`;
    // Prevent clicks on the layer button from propagating to the map (which
    // could trigger marker popups underneath). Also stop default to avoid
    // unexpected map interactions.
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.disableScrollPropagation(btn);
    btn.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); openLayerModal(); });
    return btn;
  }

  function createAppSettingsButton(): HTMLElement {
    const btn = document.createElement("button");
    btn.id = "m-app-settings-btn";
    btn.type = "button";
    btn.setAttribute("aria-label", "Pengaturan aplikasi");
    btn.setAttribute("title", "Pengaturan aplikasi");
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M4 7h8M16 7h4M4 14h4M12 14h8"/>
  <circle cx="14" cy="7" r="2"/><circle cx="10" cy="14" r="2"/>
</svg>`;
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.disableScrollPropagation(btn);
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openAppSettingsModal();
    });
    return btn;
  }

  function nativeLockScreenMonitoringEnabled(): boolean {
    const bridge = nativeAndroidBridge();
    try {
      return Boolean(bridge?.isLockScreenMonitoringEnabled?.());
    } catch {
      return false;
    }
  }

  function openAppSettingsModal(): void {
    if (document.getElementById("m-app-settings-modal")) return;
    const bridge = nativeAndroidBridge();
    const enabled = nativeLockScreenMonitoringEnabled();
    const bridgeReady = Boolean(bridge);
    const overlay = document.createElement("div");
    overlay.id = "m-app-settings-modal";
    overlay.innerHTML = `
      <div class="m-app-settings-backdrop"></div>
      <section class="m-app-settings-sheet" role="dialog" aria-modal="true" aria-labelledby="m-app-settings-title">
        <div class="m-sheet-handle-bar" data-swipe-handle></div>
        <header class="m-app-settings-head">
          <div class="m-app-settings-title-wrap">
            <span class="m-app-settings-title-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h8M16 7h4M4 14h4M12 14h8"/><circle cx="14" cy="7" r="2"/><circle cx="10" cy="14" r="2"/></svg>
            </span>
            <h2 id="m-app-settings-title">Pengaturan</h2>
          </div>
          <button type="button" class="m-app-settings-close" aria-label="Tutup pengaturan">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
          </button>
        </header>
        <div class="m-app-settings-group">
          <label class="m-app-settings-row">
            <span class="m-app-settings-row-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
            </span>
            <span class="m-app-settings-copy">
              <strong>Pemantauan melalui layar kunci</strong>
              <small>Tampilkan dua snapshot Raspberry, canvas AI, rincian objek, dan status RTDB saat perangkat masih terkunci.</small>
            </span>
            <input type="checkbox" data-lock-screen-toggle ${enabled ? "checked" : ""} ${bridgeReady ? "" : "disabled"}>
            <span class="m-app-settings-switch" aria-hidden="true"></span>
          </label>
          <button type="button" class="m-app-settings-row m-app-settings-action-row" data-notification-access ${bridgeReady ? "" : "disabled"}>
            <span class="m-app-settings-row-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 6-3 9h18c0-3-3-2-3-9"/><path d="M10 21h4"/></svg>
            </span>
            <span class="m-app-settings-copy">
              <strong>Akses notifikasi layar kunci</strong>
              <small>Izinkan ITS Maps membaca ikon, judul, dan ringkasan notifikasi untuk ditampilkan di panel layar kunci.</small>
            </span>
            <span class="m-app-settings-open-indicator" aria-hidden="true">›</span>
          </button>
        </div>
        <button type="button" class="m-app-settings-preview" data-lock-screen-preview ${enabled && bridgeReady ? "" : "disabled"}>
          Pratinjau layar kunci
        </button>
        <p class="m-app-settings-note">${bridgeReady
        ? "Saat membuka kunci, Android tetap meminta PIN, pola, sidik jari, atau autentikasi sistem perangkat."
        : "Jembatan native Android belum siap. Tutup lalu buka lagi Pengaturan setelah aplikasi selesai dimuat."}</p>
      </section>
    `;
    const close = () => {
      overlay.classList.remove("open");
      overlay.classList.add("closing");
      window.setTimeout(() => overlay.remove(), 320);
    };
    overlay.querySelector(".m-app-settings-backdrop")?.addEventListener("click", close);
    overlay.querySelector(".m-app-settings-close")?.addEventListener("click", close);
    const toggle = overlay.querySelector<HTMLInputElement>("[data-lock-screen-toggle]");
    const preview = overlay.querySelector<HTMLButtonElement>("[data-lock-screen-preview]");
    toggle?.addEventListener("change", () => {
      bridge?.setLockScreenMonitoringEnabled?.(toggle.checked);
      if (preview) preview.disabled = !toggle.checked;
    });
    overlay.querySelector<HTMLButtonElement>("[data-notification-access]")?.addEventListener("click", () => {
      bridge?.openNotificationAccessSettings?.();
    });
    preview?.addEventListener("click", () => bridge?.previewLockScreenWidget?.());
    setupSheetSwipe(overlay.querySelector<HTMLElement>(".m-app-settings-sheet")!, close);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("open"));
  }

  function openLayerModal(): void {
    if (document.getElementById("m-layer-modal")) return;
    mobileState.layerModalOpen = true;

    const overlay = document.createElement("div");
    overlay.id = "m-layer-modal";
    const guide = visibleRoadGuideBundle;
    const transitLegend = guide?.transit
      .filter((item) => state.transitModeFilter.has(item.mode))
      .filter((item, index, rows) => rows.findIndex((candidate) => (
        candidate.mode === item.mode
        && candidate.label === item.label
        && candidate.from === item.from
        && candidate.to === item.to
      )) === index)
      .slice(0, 28) || [];
    const roadLegend = guide?.roads
      .filter((item) => state.roadClassFilter.has(roadRenderClass(item)))
      .filter((item, index, rows) => rows.findIndex((candidate) => (
        candidate.name === item.name && candidate.highway === item.highway
      )) === index)
      .slice(0, 24) || [];
    const ornamentLegend = (guide?.ornaments
      .reduce<Array<{ kind: MapOrnamentKind; count: number }>>((rows, item) => {
        const found = rows.find((row) => row.kind === item.kind);
        if (found) found.count += 1;
        else rows.push({ kind: item.kind, count: 1 });
        return rows;
      }, [])
      .sort((a, b) => ornamentPriority(a.kind) - ornamentPriority(b.kind))) || [];
    const namedNature = [
      ...(guide?.waterways || []).filter((item) => item.name).map((item) => ({ icon: "💧", name: item.name })),
      ...(guide?.greens || []).filter((item) => item.name).map((item) => ({ icon: "🌳", name: item.name })),
    ].filter((item, index, rows) => rows.findIndex((candidate) => candidate.name === item.name) === index).slice(0, 16);
    const ornamentNames: Partial<Record<MapOrnamentKind, string>> = {
      surveillance: "CCTV", speed_camera: "Kamera kecepatan / ETLE", street_lamp: "Lampu jalan",
      traffic_calming: "Penenang lalu lintas", toll_gate: "Gerbang tol", gate: "Gerbang",
      barrier: "Pembatas", guardrail: "Pagar pengaman", bollard: "Bollard", hydrant: "Hidran",
      bench: "Bangku", waste_basket: "Tempat sampah", drinking_water: "Air minum",
      toilets: "Toilet", entrance: "Pintu masuk", elevator: "Lift", escalator: "Eskalator",
      manhole: "Manhole", drain_grate: "Drainase", retaining_wall: "Dinding penahan",
      seawall: "Tanggul", taxi: "Taksi", bicycle_parking: "Parkir sepeda",
      charging_station: "Pengisian kendaraan", park_and_ride: "Park and ride",
    };
    const transitModeNames: Record<TransitGuideMode, string> = {
      busway: "Busway", bus: "Bus / angkot", mrt: "MRT", lrt: "LRT", tram: "Tram",
      monorail: "Monorel", commuter: "KRL komuter", high_speed: "Kereta cepat", train: "Kereta",
    };
    const transitDetailsHtml = transitLegend.length ? transitLegend.map((item) => {
      const endpoints = item.from && item.to ? `${item.from} → ${item.to}` : item.from || item.to || item.network || item.operator;
      return `<li tabindex="0" data-legend-kind="transit" data-legend-index="${transitLegend.indexOf(item)}"><i style="--legend-color:${escapeHtml(item.color)}"></i><span><b>${escapeHtml(item.ref || item.name || item.label || transitModeNames[item.mode])}</b>${endpoints ? `<small>${escapeHtml(endpoints)}</small>` : ""}</span></li>`;
    }).join("") : `<li class="m-legend-empty">Perbesar peta untuk membaca rute di area ini.</li>`;
    const roadDetailsHtml = roadLegend.length ? roadLegend.map((item) => (
      `<li tabindex="0" data-legend-kind="road" data-legend-index="${roadLegend.indexOf(item)}"><i class="road-${roadRenderClass(item)}"></i><span><b>${escapeHtml(item.name || item.ref || "Jalan tanpa nama")}</b><small>${escapeHtml(item.highway)}${item.lanes ? ` · ${item.lanes} lajur` : ""}${item.detail.bridge ? " · jembatan" : ""}</small></span></li>`
    )).join("") : `<li class="m-legend-empty">Perbesar peta untuk membaca jenis jalan di area ini.</li>`;
    const objectDetailsHtml = [
      ...ornamentLegend.map((item) => `<li tabindex="0" data-legend-kind="ornament" data-legend-ornament="${escapeHtml(item.kind)}"><span class="m-legend-symbol">${ornamentSymbolMarkup(item.kind).markup}</span><span><b>${escapeHtml(ornamentNames[item.kind] || item.kind)}</b><small>${item.count.toLocaleString("id-ID")} titik pada area termuat</small></span></li>`),
      ...namedNature.map((item) => `<li><span class="m-legend-symbol">${item.icon}</span><span><b>${escapeHtml(item.name)}</b><small>Nama resmi dari data peta</small></span></li>`),
    ].join("") || `<li class="m-legend-empty">Belum ada objek bernama pada area termuat.</li>`;
    overlay.innerHTML = `
  <div class="m-layer-backdrop"></div>
  <div class="m-layer-sheet">
    <div class="m-sheet-handle-bar"></div>
    <div class="m-layer-title">Lapisan dinamis ITS Maps</div>
    <div class="m-layer-options">
      <button class="m-layer-opt ${state.baseMode === 'street' ? 'active' : ''}" data-mode="street">
        <div class="m-layer-icon">🗺️</div>
        <span>Peta 2D</span>
      </button>
      <button class="m-layer-opt ${state.baseMode === 'satellite' ? 'active' : ''}" data-mode="satellite">
        <div class="m-layer-icon">🛰️</div>
        <span>Satelit</span>
      </button>
      <button class="m-layer-opt ${state.baseMode === '3d' ? 'active' : ''}" data-mode="3d">
        <div class="m-layer-icon">🏙️</div>
        <span>3D</span>
      </button>
    </div>
    <div class="m-dynamics-sections">
      <details class="m-dynamics-group" open>
        <summary>Moda transportasi <span>${transitLegend.length} jalur</span></summary>
        <div class="m-dynamics-grid">
        ${([
          ["busway", "Busway"], ["bus", "Bus / angkot"], ["mrt", "MRT"],
          ["lrt", "LRT"], ["tram", "Tram"], ["monorail", "Monorel"],
          ["commuter", "KRL komuter"], ["high_speed", "Kereta cepat"], ["train", "Kereta"],
        ] as Array<[TransitGuideMode, string]>).map(([value, label]) => `
          <label><input type="checkbox" data-transit-mode="${value}" ${state.transitModeFilter.has(value) ? "checked" : ""}><span>${label}</span></label>
        `).join("")}
        </div>
        <ul class="m-dynamics-legend">${transitDetailsHtml}</ul>
      </details>
      <details class="m-dynamics-group">
        <summary>Jenis jalan <span>${roadLegend.length} jenis/nama</span></summary>
        <div class="m-dynamics-grid">
        ${([
          ["major", "Jalan utama/tol"], ["street", "Jalan kota"], ["foot", "Trotoar & sepeda"], ["service", "Jalan layanan"],
        ] as Array<["major" | "street" | "foot" | "service", string]>).map(([value, label]) => `
          <label><input type="checkbox" data-road-class="${value}" ${state.roadClassFilter.has(value) ? "checked" : ""}><span>${label}</span></label>
        `).join("")}
        </div>
        <ul class="m-dynamics-legend">${roadDetailsHtml}</ul>
      </details>
      <details class="m-dynamics-group">
        <summary>POI, alam & ornamen <span>${ornamentLegend.reduce((sum, item) => sum + item.count, 0)} objek</span></summary>
        <div class="m-dynamics-grid">
        <label><input type="checkbox" data-map-detail-toggle="green" ${state.greenVisible ? "checked" : ""}><span>🌳 Taman & area hijau</span></label>
        <label><input type="checkbox" data-map-detail-toggle="water" ${state.waterVisible ? "checked" : ""}><span>💧 Air, sungai & drainase</span></label>
        <label><input type="checkbox" data-map-detail-toggle="poi" ${state.poiVisible ? "checked" : ""}><span>📍 POI</span></label>
        <label><input type="checkbox" data-map-detail-toggle="cctv" ${state.cctvVisible ? "checked" : ""}><span>📹 CCTV & kamera kecepatan</span></label>
        </div>
        <p class="m-video-note"><i class="m-video-dot"></i> Video hanya ditampilkan jika feed publik dan koordinat titiknya terverifikasi.</p>
        <ul class="m-dynamics-legend">${objectDetailsHtml}</ul>
      </details>
    </div>
  </div>
`;

    let legendHighlight: L.Layer | null = null;
    const clearLegendHighlight = (): void => {
      if (legendHighlight && map.hasLayer(legendHighlight)) map.removeLayer(legendHighlight);
      legendHighlight = null;
      overlay.querySelectorAll(".m-dynamics-legend li.is-highlighted").forEach((item) => item.classList.remove("is-highlighted"));
    };
    const showLegendHighlight = (item: HTMLElement): void => {
      clearLegendHighlight();
      item.classList.add("is-highlighted");
      const kind = item.dataset.legendKind;
      const index = Number(item.dataset.legendIndex);
      if (kind === "transit" && transitLegend[index]?.points.length) {
        const record = transitLegend[index];
        legendHighlight = L.polyline(record.points, {
          pane: ROAD_ORNAMENT_PANE, color: record.color, weight: 9, opacity: 0.96,
          lineCap: "round", interactive: false, className: "legend-map-highlight",
        }).addTo(map);
      } else if (kind === "road" && roadLegend[index]?.points.length) {
        const record = roadLegend[index];
        legendHighlight = L.polyline(record.points, {
          pane: ROAD_ORNAMENT_PANE, color: "#1677ff", weight: 9, opacity: 0.92,
          lineCap: "round", interactive: false, className: "legend-map-highlight",
        }).addTo(map);
      } else if (kind === "ornament") {
        const ornament = guide?.ornaments.find((record) => record.kind === item.dataset.legendOrnament && record.points[0]);
        if (ornament) {
          legendHighlight = L.circleMarker(ornament.points[0], {
            pane: ROAD_ORNAMENT_PANE, radius: 18, color: "#fff", weight: 4,
            fillColor: ornamentColor(ornament.kind), fillOpacity: 0.9, interactive: false,
            className: "legend-map-highlight",
          }).addTo(map);
        }
      }
    };
    overlay.querySelectorAll<HTMLElement>(".m-dynamics-legend li[data-legend-kind]").forEach((item) => {
      item.addEventListener("mouseenter", () => showLegendHighlight(item));
      item.addEventListener("mouseleave", clearLegendHighlight);
      item.addEventListener("focus", () => showLegendHighlight(item));
      item.addEventListener("blur", clearLegendHighlight);
      item.addEventListener("click", () => {
        showLegendHighlight(item);
        const kind = item.dataset.legendKind;
        const index = Number(item.dataset.legendIndex);
        const points = kind === "transit" ? transitLegend[index]?.points : kind === "road" ? roadLegend[index]?.points : null;
        if (points?.length) map.fitBounds(L.latLngBounds(points), { padding: [56, 56], maxZoom: 18, animate: true });
      });
    });
    const closeInteractiveLayerModal = (): void => {
      clearLegendHighlight();
      closeLayerModal();
    };

    overlay.querySelector(".m-layer-backdrop")!.addEventListener("click", closeInteractiveLayerModal);

    overlay.querySelectorAll<HTMLButtonElement>(".m-layer-opt").forEach(btn => {
      btn.addEventListener("click", async () => {
        const mode = btn.dataset.mode as LayerMode;
        overlay.querySelectorAll(".m-layer-opt").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        await setBaseMap(mode);
        setTimeout(closeInteractiveLayerModal, 280);
      });
    });

    const rerenderDetails = (): void => {
      lastRoadGuideFetchBounds = null;
      void refreshRoadGuideLayer(true);
    };
    overlay.querySelectorAll<HTMLInputElement>("[data-transit-mode]").forEach((input) => {
      input.addEventListener("change", () => {
        const mode = input.dataset.transitMode as TransitGuideMode;
        if (input.checked) state.transitModeFilter.add(mode);
        else state.transitModeFilter.delete(mode);
        rerenderDetails();
      });
    });
    overlay.querySelectorAll<HTMLInputElement>("[data-road-class]").forEach((input) => {
      input.addEventListener("change", () => {
        const roadClass = input.dataset.roadClass as "major" | "street" | "foot" | "service";
        if (input.checked) state.roadClassFilter.add(roadClass);
        else state.roadClassFilter.delete(roadClass);
        rerenderDetails();
      });
    });
    overlay.querySelectorAll<HTMLInputElement>("[data-map-detail-toggle]").forEach((input) => {
      input.addEventListener("change", () => {
        const detail = input.dataset.mapDetailToggle;
        if (detail === "green") state.greenVisible = input.checked;
        if (detail === "water") state.waterVisible = input.checked;
        if (detail === "cctv") state.cctvVisible = input.checked;
        if (detail === "poi") setPoiVisibility(input.checked);
        if (detail !== "poi") rerenderDetails();
      });
    });

    setupSheetSwipe(
      overlay.querySelector<HTMLElement>(".m-layer-sheet")!,
      closeInteractiveLayerModal
    );

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("open"));
  }

  function closeLayerModal(): void {
    const modal = document.getElementById("m-layer-modal");
    if (!modal) return;
    modal.classList.remove("open");
    modal.classList.add("closing");
    setTimeout(() => modal.remove(), 320);
    mobileState.layerModalOpen = false;
  }

  // ─── 3. Generic Sheet Swipe Handler ──────────────────────────────────────────

  function sheetSwipeHandleTarget(target: HTMLElement | null): boolean {
    return Boolean(target?.closest(
      "[data-swipe-handle], .m-sheet-handle-bar, .m-layer-title, .modal-header, .poi-modal-header, .sheet-panel-header, .windows-download-head, .windows-download-detail-head, .map-license-head, .m-profil-inner",
    ));
  }

  function nearestScrollableSheetTarget(target: HTMLElement | null, sheetEl: HTMLElement): HTMLElement {
    let node: HTMLElement | null = target;
    while (node && node !== sheetEl) {
      const style = window.getComputedStyle(node);
      const canScroll = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 2;
      if (canScroll) return node;
      node = node.parentElement;
    }
    return sheetEl;
  }

  function canStartSheetDismiss(target: HTMLElement | null, sheetEl: HTMLElement, horizontal: boolean): boolean {
    if (horizontal) return true;
    const scrollTarget = nearestScrollableSheetTarget(target, sheetEl);
    return scrollTarget.scrollTop <= 1;
  }

  function installWheelSheetDismiss(sheetEl: HTMLElement, onClose: () => void): void {
    let offset = 0;
    let resetTimer = 0;
    sheetEl.addEventListener("wheel", (event) => {
      if (usesDesktopSidePanel()) return;
      const target = event.target as HTMLElement | null;
      const scrollTarget = nearestScrollableSheetTarget(target, sheetEl);
      const atTop = scrollTarget.scrollTop <= 1;
      const atBottom = scrollTarget.scrollTop + scrollTarget.clientHeight >= scrollTarget.scrollHeight - 2;
      const pullDownFromTop = atTop && event.deltaY < -8;
      const pushPastBottom = atBottom && event.deltaY > 10;
      const wheelPull = pullDownFromTop ? Math.abs(event.deltaY) : pushPastBottom ? event.deltaY * 0.55 : 0;
      if (!wheelPull) return;
      event.preventDefault();
      offset = clamp(offset + wheelPull, 0, 190);
      sheetEl.style.transition = "none";
      sheetEl.style.transform = `translateY(${offset}px)`;
      window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => {
        sheetEl.style.transition = "";
        if (offset > 74) onClose();
        else sheetEl.style.transform = "";
        offset = 0;
      }, 110);
    }, { passive: false });
  }

  function setupSheetSwipe(sheetEl: HTMLElement, onClose: () => void): void {
    let startAxis = 0;
    let currentAxis = 0;
    let dragging = false;
    let pointerId = -1;
    let startedAt = 0;

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      const startsOnHandle = sheetSwipeHandleTarget(target);
      if (target.closest("button, a, input, label, select, textarea")) return;
      const horizontal = usesDesktopSidePanel();
      if (!startsOnHandle && !canStartSheetDismiss(target, sheetEl, horizontal)) return;
      startAxis = horizontal ? e.clientX : e.clientY;
      currentAxis = 0;
      dragging = true;
      pointerId = e.pointerId;
      startedAt = performance.now();
      sheetEl.dataset.swipeAxis = horizontal ? "x" : "y";
      sheetEl.style.transition = "none";
      try { sheetEl.setPointerCapture?.(e.pointerId); } catch { /* Pointer may already be released. */ }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging || e.pointerId !== pointerId) return;
      const horizontal = sheetEl.dataset.swipeAxis === "x";
      const axis = horizontal ? e.clientX : e.clientY;
      currentAxis = Math.max(0, axis - startAxis);
      if (currentAxis > 2) e.preventDefault();
      sheetEl.style.transform = horizontal ? `translateX(${currentAxis}px)` : `translateY(${currentAxis}px)`;
      if (horizontal && document.body.classList.contains("map-modal-panel-open")) {
        const remaining = Math.max(0, sheetEl.getBoundingClientRect().width - currentAxis);
        setSidePanelWidth(remaining);
      }
    };

    const onPointerEnd = (e: PointerEvent) => {
      if (!dragging || e.pointerId !== pointerId) return;
      dragging = false;
      pointerId = -1;
      sheetEl.style.transition = "";
      const elapsed = Math.max(1, performance.now() - startedAt);
      const velocity = currentAxis / elapsed;
      if (currentAxis > 56 || velocity > 0.55) {
        onClose();
      } else {
        sheetEl.style.transform = "";
        if (sheetEl.dataset.swipeAxis === "x" && document.body.classList.contains("map-modal-panel-open")) {
          setSidePanelWidthFromSheet(sheetEl);
        }
      }
    };

    sheetEl.addEventListener("pointerdown", onPointerDown);
    sheetEl.addEventListener("pointermove", onPointerMove);
    sheetEl.addEventListener("pointerup", onPointerEnd);
    sheetEl.addEventListener("pointercancel", onPointerEnd);
    installWheelSheetDismiss(sheetEl, onClose);
  }

  // ─── 4. ITS Sheet (Swipeable, Dynamic Map Resize) ────────────────────────────

  const ITS_SNAP = {
    closed: 0,
    peek: () => Math.round((window.innerHeight - 64) * 0.65),
    full: () => Math.round((window.innerHeight - 64) * 0.85),
  };

  // FIX 1: hapus itsSheetDragY yang tidak pernah dipakai
  let itsCurrentSnap: "closed" | "peek" | "full" = "closed";
  let itsSheetOverlayMode = false;

  function getMapEl(): HTMLElement | null {
    return document.getElementById("map");
  }

  function setMobileToolbarSheetOffset(heightPx: number): void {
    if (!isMobile()) {
      document.documentElement.style.setProperty("--m-sheet-offset", "0px");
      document.documentElement.style.setProperty("--m-sheet-progress", "0");
      return;
    }
    const offset = Math.max(0, Math.round(heightPx > 0 ? heightPx + 64 : 0));
    const progress = clamp(heightPx / Math.max(1, ITS_SNAP.peek()), 0, 1);
    const root = document.documentElement;
    root.style.setProperty("--m-sheet-offset", `${offset}px`);
    root.style.setProperty("--m-sheet-progress", progress.toFixed(3));
    root.style.setProperty("--m-locate-left", `${Math.round(lerp(12, 82, progress))}px`);
    root.style.setProperty("--m-home-left", `${Math.round(lerp(12, 28, progress))}px`);
    root.style.setProperty("--m-zoom-in-right", `${Math.round(lerp(12, 82, progress))}px`);
    root.style.setProperty("--m-zoom-out-right", `${Math.round(lerp(12, 28, progress))}px`);
    root.style.setProperty("--m-locate-bottom", `${Math.round(lerp(120, 28, progress) + offset)}px`);
    root.style.setProperty("--m-home-bottom", `${Math.round(lerp(168, 28, progress) + offset)}px`);
    root.style.setProperty("--m-zoom-in-bottom", `${Math.round(lerp(216, 28, progress) + offset)}px`);
    root.style.setProperty("--m-zoom-out-bottom", `${Math.round(168 + (28 - 168) * progress + offset)}px`);
    root.style.setProperty("--m-camera-opacity", `${(1 - progress).toFixed(3)}`);
    root.style.setProperty("--m-camera-y", `${Math.round(12 * progress)}px`);
    root.style.setProperty("--m-camera-scale", `${(1 - progress * 0.04).toFixed(3)}`);
    root.style.setProperty("--m-nav-bottom", `${Math.round(lerp(22, 0, progress))}px`);
    root.style.setProperty("--m-nav-left", `${lerp(50, 0, progress).toFixed(2)}%`);
    root.style.setProperty("--m-nav-width", `${lerp(80, 100, progress).toFixed(2)}vw`);
    root.style.setProperty("--m-nav-max-width", `${Math.round(lerp(520, window.innerWidth, progress))}px`);
    root.style.setProperty("--m-nav-transform-x", `${lerp(-50, 0, progress).toFixed(2)}%`);
    root.style.setProperty("--m-nav-radius", `${Math.round(lerp(18, 0, progress))}px`);
  }

  function setMapHeight(heightPx: number, immediate = false): void {
    const mapEl = getMapEl();
    if (!mapEl) return;
    const total = window.innerHeight - 64;
    const mapH = heightPx <= 0
      ? window.innerHeight
      : heightPx >= total - 2
        ? 0
        : Math.max(0, total - heightPx);
    const progress = isMobile() ? clamp(heightPx / Math.max(1, ITS_SNAP.peek()), 0, 1) : 0;
    document.documentElement.style.setProperty("--its-sheet-height", `${Math.max(0, heightPx)}px`);
    document.documentElement.style.setProperty("--m-map-inset", `${Math.round(8 * progress)}px`);
    document.documentElement.style.setProperty("--m-map-radius", `${Math.round(18 * progress)}px`);
    mapEl.style.height = `${mapH}px`;
    mapEl.style.transition = immediate ? "none" : "height 0.32s cubic-bezier(0.32,0.72,0,1)";
    mapEl.classList.toggle("its-open", heightPx > 0);
    setMobileToolbarSheetOffset(heightPx);
    map.invalidateSize();
  }

  function openITSSheet(options: { overlay?: boolean } = {}): void {
    if (isMobile()) {
      closeModal(false);
      document.getElementById("m-profil-sheet")?.remove();
    }
    let sheet = document.getElementById("m-its-sheet");
    if (!sheet) {
      sheet = createITSSheet();
      document.getElementById("app")!.appendChild(sheet);
    }
    itsSheetOverlayMode = Boolean(options.overlay);
    document.body.classList.add("its-sheet-open");
    document.body.classList.toggle("its-sheet-overlay-history", itsSheetOverlayMode);
    renderITSSheetContent();
    snapITSSheet("peek");
  }

  function closeITSSheet(): void {
    const sheet = document.getElementById("m-its-sheet");
    if (sheet && state.videoRfDetrHost && sheet.contains(state.videoRfDetrHost)) {
      stopVideoBrowserRfDetr();
    }
    snapITSSheet("closed");
    document.body.classList.remove("its-sheet-open");
    document.body.classList.remove("its-sheet-overlay-history");
    const wasOverlay = itsSheetOverlayMode;
    itsSheetOverlayMode = false;
    if (!wasOverlay) setMobileToolbarSheetOffset(0);
    setTimeout(() => {
      const mapEl = getMapEl();
      if (mapEl && !wasOverlay) {
        mapEl.style.height = "";
        map.invalidateSize();
      }
      document.getElementById("m-its-sheet")?.remove();
    }, 340);
  }

  function snapITSSheet(snap: "closed" | "peek" | "full"): void {
    const sheet = document.getElementById("m-its-sheet");
    if (!sheet) return;
    itsCurrentSnap = snap;

    const h = snap === "closed" ? 0 : snap === "peek" ? ITS_SNAP.peek() : ITS_SNAP.full();

    sheet.style.transition = "transform 0.34s cubic-bezier(0.32,0.72,0,1)";
    sheet.style.transform = `translateY(${window.innerHeight - h - 64}px)`;
    if (itsSheetOverlayMode) {
      document.documentElement.style.setProperty("--its-sheet-height", `${h}px`);
    } else {
      setMapHeight(h);
    }
  }

  function createITSSheet(): HTMLElement {
    const sheet = document.createElement("div");
    sheet.id = "m-its-sheet";

    let touchStartY = 0;
    let touchStartTranslate = 0;

    sheet.addEventListener("touchstart", (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".m-its-handle-zone")) return;
      touchStartY = e.touches[0].clientY;
      const matrix = new DOMMatrix(getComputedStyle(sheet).transform);
      touchStartTranslate = matrix.m42;
      sheet.style.transition = "none";
      document.body.classList.add("its-sheet-dragging");
    }, { passive: true });

    sheet.addEventListener("touchmove", (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".m-its-handle-zone")) return;
      e.preventDefault();
      const delta = e.touches[0].clientY - touchStartY;
      const rawY = touchStartTranslate + delta;
      const minY = window.innerHeight - ITS_SNAP.full() - 64;
      const maxY = window.innerHeight - 64;
      const clampedY = Math.max(minY, Math.min(maxY, rawY));
      sheet.style.transform = `translateY(${clampedY}px)`;
      const sheetH = window.innerHeight - 64 - clampedY;
      if (itsSheetOverlayMode) {
        document.documentElement.style.setProperty("--its-sheet-height", `${Math.max(0, sheetH)}px`);
      } else {
        setMapHeight(Math.max(0, sheetH), true);
      }
    }, { passive: false });

    sheet.addEventListener("touchend", () => {
      document.body.classList.remove("its-sheet-dragging");
      const matrix = new DOMMatrix(getComputedStyle(sheet).transform);
      const currentY = matrix.m42;
      const sheetH = window.innerHeight - 64 - currentY;
      const peekH = ITS_SNAP.peek();
      const fullH = ITS_SNAP.full();

      let snap: "closed" | "peek" | "full";
      if (sheetH < peekH * 0.55) {
        closeITSSheet();
        setTimeout(() => {
          document.querySelectorAll(".m-nav-tab").forEach(b => b.classList.remove("active"));
          document.querySelector<HTMLButtonElement>('.m-nav-tab[data-tab="peta"]')?.classList.add("active");
          mobileState.activeTab = "peta";
        }, 340);
        return;
      } else if (sheetH < lerp(peekH, fullH, 0.55)) {
        snap = "peek";
      } else {
        snap = "full";
      }

      snapITSSheet(snap);
    });

    sheet.addEventListener("touchcancel", () => {
      document.body.classList.remove("its-sheet-dragging");
      snapITSSheet(itsCurrentSnap);
    });

    sheet.innerHTML = `
  <div class="m-its-handle-zone">
    <div class="m-its-handle-bar"></div>
  </div>
  <div class="m-its-scroll-content" id="m-its-scroll"></div>
`;

    sheet.style.transform = `translateY(${window.innerHeight - 64}px)`;
    return sheet;
  }

  function renderITSSheetContent(): void {
    const scroll = document.getElementById("m-its-scroll");
    if (!scroll) return;

    const device = state.device;
    const traffic = device ? trafficStateForDevice(device) : null;
    const cameraSurface = renderCameraSurface(device, "m-camera-img", "m-camera-frame");
    const statsGrid = renderVehicleStatsGrid(device, traffic);

    const colorMap: Record<string, string> = {
      red: "#ef4444", yellow: "#facc15", green: "#22c55e",
    };
    const bulbColor = traffic ? colorMap[traffic.color] : "#9ca3af";
    scroll.dataset.cameraKey = cameraRenderKey(device);

    scroll.innerHTML = `
  <div class="m-its-section" id="m-its-video">
    <div class="m-its-section-title">Video Realtime</div>
    <div class="m-its-camera-box">
      ${cameraSurface || `<div class="m-camera-placeholder">
             <svg viewBox="0 0 48 48" fill="none" width="36" height="36">
               <rect x="4" y="12" width="34" height="26" rx="4" stroke="#9ca3af" stroke-width="2"/>
               <path d="M38 20l6-4v16l-6-4V20z" stroke="#9ca3af" stroke-width="2" stroke-linejoin="round"/>
             </svg>
             <span>Belum ada kamera</span>
           </div>`}
      ${cameraSurface ? renderDetectionOverlay(device) : ""}
      ${cameraSurface ? `<canvas class="m-camera-rf-detr-canvas" data-video-rf-detr-canvas data-detector-fit="contain" aria-hidden="true"></canvas>` : ""}
      <button type="button" class="m-camera-fullscreen" aria-label="Fullscreen">
        <svg viewBox="0 0 16 16" fill="none" width="14" height="14">
          <path d="M1 6V1h5M10 1h5v5M15 10v5h-5M6 15H1v-5"
                stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  </div>

  <div class="m-its-section">
    <div class="m-its-section-title">Data Kendaraan</div>
    ${statsGrid}
  </div>

  ${traffic ? `
  <div class="m-its-section">
    <div class="m-its-section-title">Status Lalu Lintas</div>
    <div class="m-its-traffic-row">
      <div class="m-traffic-light-col">
        ${makeTrafficLightSvg(traffic, 32)}
      </div>
      <div class="m-traffic-info-col">
        <div class="m-traffic-road">${escapeHtml(traffic.roadName)}</div>
        <div class="m-traffic-recom" style="color:${bulbColor}">${escapeHtml(traffic.recommendation)}</div>
        <div class="m-traffic-meta">
          <span>🚗 ${traffic.vehicleCount} kendaraan</span>
          <span>${escapeHtml(vehicleBreakdownText(device?.vehicleBreakdown))}</span>
          <span>⏱ ${traffic.duration}s</span>
        </div>
      </div>
    </div>
  </div>` : ""}

  <div class="m-its-section">
    <div class="m-its-section-title">Perangkat (${state.devices.length})</div>
    ${state.devices.map(d => {          // FIX 2: hapus parameter idx yang tidak dipakai
      const t = trafficStateForDevice(d);
      const c = colorMap[t.color];
      const status = effectiveDeviceStatus(d);
      return `<div class="m-device-row" data-id="${d.id}">
        <span class="m-device-bulb" style="background:${c}"></span>
        <span class="m-device-name">${escapeHtml(d.label)}</span>
        <span class="m-device-status status-${status}">${status}</span>
      </div>`;
    }).join("")}
  </div>

  <div style="height:24px"></div>
`;

    setupHlsVideos(scroll);
    syncCameraViews(device);
    attachWebRtcStream();
    if (cameraSurface) {
      const cameraBox = scroll.querySelector<HTMLElement>(".m-its-camera-box");
      if (cameraBox) applyVideoAmbientFromSnapshot(cameraBox, device);
      drawExistingVideoDetections(scroll, device);
      drawVideoScannerIfNeeded(scroll);
      window.setTimeout(() => startVideoBrowserRfDetr(scroll, device), 550);
    }
    requestAnimationFrame(() => drawTrafficChart());
    scroll.querySelector<HTMLButtonElement>(".m-camera-fullscreen")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openVideoFullscreen(device);
    });
    syncCustomVideoButtons(scroll);

    scroll.querySelectorAll<HTMLDivElement>(".m-device-row").forEach(row => {
      row.addEventListener("click", () => {
        const id = row.dataset.id;
        const d = state.devices.find(x => x.id === id);
        if (!d) return;
        const navigationSeq = beginExplicitMapNavigation();
        state.device = d;
        renderCameraTile();
        snapITSSheet("peek");
        state.pendingDeviceFocusTimer = window.setTimeout(() => {
          state.pendingDeviceFocusTimer = 0;
          if (navigationSeq !== state.mapNavigationSeq) return;
          map.stop();
          map.setView([d.position.lat, d.position.lng], 17, { animate: true });
        }, 200);
      });
    });
  }

  function cameraRenderKey(device: DeviceRecord | null): string {
    if (!device) return "none";
    const source = publicCameraHlsUrl(device)
      || publicCameraPageUrl(device)
      || (isWebRtcSignalingCamera(device) ? webRtcSignalPath(device) : "")
      || "none";
    return `${device.id}:${source}`;
  }

  function drawTrafficChart(): void {
    const canvas = document.getElementById("m-traffic-chart") as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, W, H);

    const points: { x: number; y: number }[] = [];
    for (let i = 0; i < 12; i++) {
      const seed = hashString(`chart:${i}:${Math.floor(Date.now() / 8000)}`);
      points.push({ x: 5 + (seed % 95), y: 3 + ((seed * 7) % 40) });
    }
    state.devices.forEach(d => {
      const t = trafficStateForDevice(d);
      points.push({ x: t.vehicleCount, y: t.duration });
    });

    const padL = 42, padB = 30, padT = 14, padR = 16;
    const chartW = W - padL - padR;
    const chartH = H - padT - padB;
    const maxX = 120, maxY = 45;

    const toScreen = (x: number, y: number) => ({
      sx: padL + (x / maxX) * chartW,
      sy: padT + chartH - (y / maxY) * chartH,
    });

    ctx.strokeStyle = "#1e293b";
    ctx.lineWidth = 1;
    for (let y = 0; y <= maxY; y += 5) {
      const { sy } = toScreen(0, y);
      ctx.beginPath(); ctx.moveTo(padL, sy); ctx.lineTo(W - padR, sy); ctx.stroke();
    }

    ctx.fillStyle = "#94a3b8";
    ctx.font = "10px monospace";
    ctx.textAlign = "right";
    for (let y = 0; y <= maxY; y += 10) {
      const { sy } = toScreen(0, y);
      ctx.fillText(String(y), padL - 4, sy + 3);
    }

    ctx.textAlign = "center";
    [4, 20, 60, 100].forEach(x => {
      const { sx } = toScreen(x, 0);
      ctx.fillText(String(x), sx, H - 6);
    });

    ctx.save();
    ctx.translate(10, H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = "#64748b";
    ctx.font = "9px monospace";
    ctx.textAlign = "center";
    ctx.fillText("Waktu Hijau", 0, 0);
    ctx.restore();

    ctx.textAlign = "center";
    ctx.fillStyle = "#64748b";
    ctx.font = "9px monospace";
    ctx.fillText("Jumlah Kendaraan", W / 2, H - 1);

    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 1;
    const { sy: threshSy } = toScreen(0, 8);
    ctx.beginPath(); ctx.moveTo(padL, threshSy); ctx.lineTo(W - padR, threshSy); ctx.stroke();
    ctx.setLineDash([]);

    points.forEach(p => {
      const { sx, sy } = toScreen(p.x, p.y);
      ctx.fillStyle = "#f8fafc";
      ctx.fillRect(sx - 2, sy - 5, 4, 10);
    });

    const colorMap: Record<string, string> = { red: "#ef4444", yellow: "#facc15", green: "#22c55e" };
    state.devices.forEach(d => {
      const t = trafficStateForDevice(d);
      const { sx, sy } = toScreen(t.vehicleCount, t.duration);
      ctx.beginPath();
      ctx.arc(sx, sy, 4, 0, Math.PI * 2);
      ctx.fillStyle = colorMap[t.color] || "#60a5fa";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }

  // ─── 5. Profil Sheet ─────────────────────────────────────────────────────────

  function openProfilSheet(): void {
    if (document.getElementById("m-profil-sheet")) return;

    closeModal(false);
    closeITSSheet();

    const sheet = document.createElement("div");
    sheet.id = "m-profil-sheet";

    const online = state.devices.filter((d) => effectiveDeviceStatus(d) === "online").length;
    const offline = state.devices.filter((d) => effectiveDeviceStatus(d) === "offline").length;

    sheet.innerHTML = `
  <div class="m-layer-backdrop"></div>
  <div class="m-profil-inner">
    <div class="m-sheet-handle-bar" style="margin:0 auto 16px"></div>
    <div class="m-profil-avatar">
      <svg viewBox="0 0 64 64" fill="none" width="56" height="56">
        <circle cx="32" cy="24" r="14" fill="#3b82f6" opacity="0.15"/>
        <circle cx="32" cy="24" r="10" stroke="#3b82f6" stroke-width="2"/>
        <path d="M8 56c0-11 10.745-20 24-20s24 8.955 24 20"
              stroke="#3b82f6" stroke-width="2" stroke-linecap="round"/>
      </svg>
    </div>
    <div class="m-profil-name">Operator ITS Maps</div>
    <div class="m-profil-role">Sistem Manajemen Lalu Lintas</div>
    <div class="m-profil-stats">
      <div class="m-stat">
        <span class="m-stat-val">${state.devices.length}</span>
        <span class="m-stat-lbl">Perangkat</span>
      </div>
      <div class="m-stat">
        <span class="m-stat-val" style="color:#22c55e">${online}</span>
        <span class="m-stat-lbl">Online</span>
      </div>
      <div class="m-stat">
        <span class="m-stat-val" style="color:#ef4444">${offline}</span>
        <span class="m-stat-lbl">Offline</span>
      </div>
    </div>
  </div>
`;

    const goBackToPeta = () => {
      sheet.remove();
      document.querySelectorAll(".m-nav-tab").forEach(b => b.classList.remove("active"));
      document.querySelector<HTMLButtonElement>('.m-nav-tab[data-tab="peta"]')?.classList.add("active");
      mobileState.activeTab = "peta";
    };

    sheet.querySelector(".m-layer-backdrop")!.addEventListener("click", goBackToPeta);
    setupSheetSwipe(sheet.querySelector<HTMLElement>(".m-profil-inner")!, goBackToPeta);

    document.body.appendChild(sheet);
    requestAnimationFrame(() => sheet.classList.add("open"));
  }

  // ─── 6. Repositioning Leaflet Controls untuk Mobile ──────────────────────────

  // FIX 3, 4, 5: hapus const zoomIn, zoomOut, compassBtn yang tidak dipakai
  function repositionLeafletControls(): void {
    if (!isMobile()) return;
    const toolbar = document.querySelector<HTMLElement>(".map-toolbar");
    if (toolbar) {
      // Keep mobile toolbar as-is; individual controls are positioned by CSS
      // Do NOT add m-toolbar-repositioned which bundles controls into one column
    }
  }

  // ─── 7. Init ──────────────────────────────────────────────────────────────────

  function initMobileUI(): void {
    if (!isMobile()) return;

    const appEl = document.getElementById("app");
    if (!appEl) return;

    appEl.appendChild(createMobileBottomNav());

    const mapEl = document.getElementById("map");
    if (mapEl) {
      // Do not force calc-based height; allow JS `setMapHeight` to control height
      // to ensure the map fills the viewport on initial load
      mapEl.classList.add("m-map");
      mapEl.appendChild(createLayerButton());
      if (isAndroidApkRuntime()) {
        mapEl.classList.add("has-app-settings");
        mapEl.appendChild(createAppSettingsButton());
      }
    }

    repositionLeafletControls();
    window.setTimeout(() => {
      if (mobileState.activeTab === "peta" && !document.getElementById("m-ai-history-sheet")) {
        openAiHistorySheet("dock");
      }
    }, 180);
    window.setTimeout(startMobileTutorialIfNeeded, 920);

    // FIX 6: hapus const _orig yang tidak dipakai
    setInterval(() => {
      const scroll = document.getElementById("m-its-scroll");
      if (mobileState.activeTab === "its" && scroll && scroll.dataset.cameraKey !== cameraRenderKey(state.device)) {
        renderITSSheetContent();
      } else if (mobileState.activeTab === "its" && scroll) {
        syncCustomVideoButtons(scroll);
        updateVideoAiPanel(scroll);
      }
    }, 4000);

    window.addEventListener("resize", () => {
      if (itsCurrentSnap !== "closed") snapITSSheet(itsCurrentSnap);
    });
    window.addEventListener("pagehide", () => closeAiHistorySheet(false));

    map.invalidateSize();
  }
  initMobileUI();
  void refreshSnapshot();
  // CARTO paints the normal 2D/street surface immediately. MapLibre is reserved
  // for an explicit 3D request while Leaflet keeps interaction and overlays.
  lastOverpassFetchBounds = null;
  void refreshOverpassLayer();
  void refreshRoadGuideLayer(true);
}

// ─── PWA: Service Worker registration and install prompt handler ─────
async function requestPublicNotificationPermission(): Promise<void> {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-enable-notifications]")];
  const disabling = publicPushOptedIn();
  buttons.forEach((button) => { button.disabled = true; button.textContent = disabling ? "Menonaktifkan..." : "Mengaktifkan..."; });
  try {
    if (disabling) {
      const state = await disablePublicPush();
      buttons.forEach((button) => { button.textContent = "Aktifkan notifikasi"; button.title = state.message; });
      return;
    }
    const registration = await navigator.serviceWorker?.ready;
    if (!registration) throw new Error("Service worker belum siap.");
    const state = await enablePublicPush(registration);
    buttons.forEach((button) => {
      button.textContent = state.subscribed ? "Nonaktifkan notifikasi" : "Aktifkan notifikasi";
      button.title = state.message;
    });
    if (!state.subscribed) return;
    await registration.showNotification("Notifikasi ITS Maps aktif", {
      body: state.message,
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-96.png",
      tag: "its-public-notification-ready",
      data: { url: "/new" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Notifikasi belum dapat diaktifkan.";
    console.warn("[PWA] Public push subscription failed", error);
    buttons.forEach((button) => { button.textContent = "Coba lagi"; button.title = message; });
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function notifyLatestPublicUpdate(registration: ServiceWorkerRegistration): Promise<void> {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const response = await fetch(new URL("./app-update.json", window.location.href), { cache: "no-store" });
    if (!response.ok) return;
    const update = await response.json() as { versionName?: string; version?: string; releaseNotes?: string[]; updatedAt?: string };
    const version = update.versionName || update.version || "";
    const key = `${version}:${update.updatedAt || ""}`;
    if (!version || localStorage.getItem("its-public-update-notified:v1") === key) return;
    localStorage.setItem("its-public-update-notified:v1", key);
    await registration.showNotification(`ITS Maps ${version}`, {
      body: update.releaseNotes?.[0] || "Catatan pembaruan terbaru tersedia.",
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-96.png",
      tag: "its-public-app-update",
      data: { url: "/new" },
    });
  } catch {
    // Notification polling is best-effort; push events cover true background delivery.
  }
}

if ('serviceWorker' in navigator && !isAndroidApkRuntime()) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    const reloadKey = "its-sw-controller-reload:v31";
    if (sessionStorage.getItem(reloadKey) === "1") return;
    sessionStorage.setItem(reloadKey, "1");
    window.location.reload();
  });
  window.addEventListener('load', async () => {
    try {
      const registered = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
        updateViaCache: "none",
      });
      await registered.update();
      const registration = await navigator.serviceWorker.ready;
      console.log('[PWA] Service Worker registered');
      void notifyLatestPublicUpdate(registration);
      void restorePublicPush(registration);
    } catch (err) {
      console.warn('[PWA] Service Worker registration failed', err);
    }
  });
}

// PWA install UI is intentionally left to the browser, so Chrome/Edge can show
// their native install and notification affordances without an extra app button.

function promptUsesDesktopSidePanel(): boolean {
  return window.matchMedia("(min-width: 721px)").matches;
}

function setPromptSidePanelWidth(widthPx: number): void {
  const width = promptUsesDesktopSidePanel() ? Math.max(0, Math.round(widthPx)) : 0;
  document.documentElement.style.setProperty("--side-panel-active-width", `${width}px`);
  document.body.classList.toggle("side-panel-open", width > 0);
  window.dispatchEvent(new Event("resize"));
}

function setPromptSidePanelWidthFromSheet(sheetEl: HTMLElement | null): void {
  if (!sheetEl || !promptUsesDesktopSidePanel()) return;
  setPromptSidePanelWidth(sheetEl.getBoundingClientRect().width);
}

function clearPromptSidePanelWidth(delayMs = 260): void {
  setPromptSidePanelWidth(0);
  window.setTimeout(() => {
    if (!document.querySelector("#windows-download-modal.open, #map-license-modal.open, #ai-license-modal.open, #roadmap-story-modal.open, #privacy-info-modal.open, #app-license-info-modal.open, #about-site-info-modal.open, #its-ai-chat-modal.open, #m-device-modal.open, #m-poi-modal.open")) {
      document.body.classList.remove("side-panel-open", "app-download-panel-open", "map-license-panel-open", "map-modal-panel-open");
      document.documentElement.style.removeProperty("--side-panel-active-width");
    }
  }, delayMs);
}

function promptSheetSwipeHandleTarget(target: HTMLElement | null): boolean {
  return Boolean(target?.closest(
    "[data-swipe-handle], .windows-download-head, .windows-download-detail-head, .map-license-head, .its-ai-chat-head",
  ));
}

function promptNearestScrollableTarget(target: HTMLElement | null, sheetEl: HTMLElement): HTMLElement {
  let node: HTMLElement | null = target;
  while (node && node !== sheetEl) {
    const style = window.getComputedStyle(node);
    const canScroll = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 2;
    if (canScroll) return node;
    node = node.parentElement;
  }
  return sheetEl;
}

function promptCanStartDismiss(target: HTMLElement | null, sheetEl: HTMLElement, horizontal: boolean): boolean {
  if (horizontal) return true;
  return promptNearestScrollableTarget(target, sheetEl).scrollTop <= 1;
}

function installPromptWheelDismiss(sheetEl: HTMLElement, onClose: () => void): void {
  let offset = 0;
  let resetTimer = 0;
  sheetEl.addEventListener("wheel", (event) => {
    if (promptUsesDesktopSidePanel()) return;
    const scrollTarget = promptNearestScrollableTarget(event.target as HTMLElement | null, sheetEl);
    const atTop = scrollTarget.scrollTop <= 1;
    const atBottom = scrollTarget.scrollTop + scrollTarget.clientHeight >= scrollTarget.scrollHeight - 2;
    const pull = atTop && event.deltaY < -8 ? Math.abs(event.deltaY) : atBottom && event.deltaY > 10 ? event.deltaY * 0.55 : 0;
    if (!pull) return;
    event.preventDefault();
    offset = Math.min(190, Math.max(0, offset + pull));
    sheetEl.style.transition = "none";
    sheetEl.style.transform = `translateY(${offset}px)`;
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      sheetEl.style.transition = "";
      if (offset > 74) onClose();
      else sheetEl.style.transform = "";
      offset = 0;
    }, 110);
  }, { passive: false });
}

function closeFloatingMapPanels(): void {
  document.querySelectorAll("#windows-download-modal, #map-license-modal, #ai-license-modal, #roadmap-story-modal, #privacy-info-modal, #app-license-info-modal, #about-site-info-modal, #its-ai-chat-modal, #m-device-modal, #m-poi-modal").forEach((modal) => {
    if (itsAgentPanelTransitionActive && modal.id === "its-ai-chat-modal") return;
    modal.remove();
  });
  document.body.classList.remove("app-download-panel-open", "map-license-panel-open", "map-modal-panel-open");
  if (!itsAgentPanelTransitionActive) clearPromptSidePanelWidth(0);
}

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.closest("[data-map-license]")) {
    event.preventDefault();
    event.stopPropagation();
    itsShowMapLicenseModal();
  }
  if (target?.closest("[data-ai-license]")) {
    event.preventDefault();
    event.stopPropagation();
    itsShowAiLicenseModal();
  }
  if (target?.closest("[data-roadmap-story]")) {
    event.preventDefault();
    event.stopPropagation();
    itsShowRoadmapStoryModal();
  }
  if (target?.closest("[data-privacy-modal]")) {
    event.preventDefault();
    event.stopPropagation();
    itsShowSiteInfoModal("privacy");
  }
  if (target?.closest("[data-app-license]")) {
    event.preventDefault();
    event.stopPropagation();
    itsShowSiteInfoModal("app-license");
  }
  if (target?.closest("[data-about-site]")) {
    event.preventDefault();
    event.stopPropagation();
    itsShowSiteInfoModal("about-site");
  }
});

function itsShowRoadmapStoryModal(): void {
  if (document.getElementById("roadmap-story-modal")) return;
  closeFloatingMapPanels();
  const modal = document.createElement("div");
  modal.id = "roadmap-story-modal";
  modal.className = "map-license-modal roadmap-story-modal";
  modal.innerHTML = `
    <section class="map-license-sheet roadmap-story-sheet" role="dialog" aria-modal="true" aria-labelledby="roadmap-story-title">
      <div class="map-license-grip" data-swipe-handle aria-hidden="true"></div>
      <header class="map-license-head">
        <div>
          <span>AMP Web Story</span>
          <h2 id="roadmap-story-title">Roadmap ITS Maps</h2>
        </div>
        <a class="roadmap-open-link" href="/roadmap/" target="_blank" rel="noopener">Buka penuh</a>
        <button type="button" aria-label="Tutup Roadmap" title="Tutup" data-license-close>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </header>
      <div class="roadmap-story-frame-wrap">
        <iframe class="roadmap-story-frame" title="Roadmap ITS Maps AMP story" src="/roadmap/" loading="lazy" allow="autoplay; fullscreen; encrypted-media"></iframe>
      </div>
    </section>
  `;
  document.body.appendChild(modal);
  let closeRoadmapModal: () => void = () => undefined;
  let roadmapClosing = false;
  const keyHandler = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key === "Escape") closeRoadmapModal();
  };
  closeRoadmapModal = () => {
    if (roadmapClosing) return;
    roadmapClosing = true;
    if (modal.classList.contains("its-ai-agent-target-stacked")) {
      itsReleaseAgentPanelStack();
    }
    window.removeEventListener("keydown", keyHandler);
    modal.classList.remove("open");
    document.body.classList.remove("map-license-panel-open");
    clearPromptSidePanelWidth();
    window.setTimeout(() => modal.remove(), 220);
  };
  modal.addEventListener("click", (clickEvent) => {
    if (clickEvent.target === modal) closeRoadmapModal();
  });
  modal.querySelector<HTMLButtonElement>("[data-license-close]")?.addEventListener("click", closeRoadmapModal);
  const sheet = modal.querySelector<HTMLElement>(".map-license-sheet");
  if (sheet) setupPromptSheetSwipe(sheet, closeRoadmapModal);
  window.addEventListener("keydown", keyHandler);
  window.setTimeout(() => {
    modal.classList.add("open");
    document.body.classList.add("map-license-panel-open");
    setPromptSidePanelWidthFromSheet(sheet);
  }, 20);
}

type SiteInfoModalKind = "privacy" | "app-license" | "about-site";

const SITE_INFO_MODAL_META: Record<SiteInfoModalKind, {
  id: string;
  eyebrow: string;
  title: string;
  closeLabel: string;
  items: readonly (readonly [string, string, string])[];
}> = {
  privacy: {
    id: "privacy-info-modal",
    eyebrow: "ITS Maps",
    title: "Privasi",
    closeLabel: "Tutup Privasi",
    items: PRIVACY_INFO_STACK,
  },
  "app-license": {
    id: "app-license-info-modal",
    eyebrow: "ITS Maps",
    title: "Licence Aplikasi",
    closeLabel: "Tutup Licence Aplikasi",
    items: APP_LICENSE_INFO_STACK,
  },
  "about-site": {
    id: "about-site-info-modal",
    eyebrow: "About this site",
    title: "ITS Maps",
    closeLabel: "Tutup About this site",
    items: ABOUT_SITE_INFO_STACK,
  },
};

function itsShowSiteInfoModal(kind: SiteInfoModalKind): void {
  const meta = SITE_INFO_MODAL_META[kind];
  if (document.getElementById(meta.id)) return;
  closeFloatingMapPanels();
  const modal = document.createElement("div");
  modal.id = meta.id;
  modal.className = `map-license-modal site-info-modal site-info-${kind}`;
  modal.innerHTML = `
    <section class="map-license-sheet" role="dialog" aria-modal="true" aria-labelledby="${meta.id}-title">
      <div class="map-license-grip" data-swipe-handle aria-hidden="true"></div>
      <header class="map-license-head">
        <div>
          <span>${escapeMapServiceHtml(meta.eyebrow)}</span>
          <h2 id="${meta.id}-title">${escapeMapServiceHtml(meta.title)}</h2>
        </div>
        <button type="button" aria-label="${escapeMapServiceHtml(meta.closeLabel)}" title="Tutup" data-license-close>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </header>
      <div class="map-license-list">
        ${infoStackHtml(meta.items)}
      </div>
    </section>
  `;
  document.body.appendChild(modal);
  let closeInfoModal: () => void = () => undefined;
  let infoModalClosing = false;
  const keyHandler = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key === "Escape") closeInfoModal();
  };
  closeInfoModal = () => {
    if (infoModalClosing) return;
    infoModalClosing = true;
    if (modal.classList.contains("its-ai-agent-target-stacked")) {
      itsReleaseAgentPanelStack();
    }
    window.removeEventListener("keydown", keyHandler);
    modal.classList.remove("open");
    document.body.classList.remove("map-license-panel-open");
    clearPromptSidePanelWidth();
    window.setTimeout(() => modal.remove(), 220);
  };
  modal.addEventListener("click", (clickEvent) => {
    if (clickEvent.target === modal) closeInfoModal();
  });
  modal.querySelector<HTMLButtonElement>("[data-license-close]")?.addEventListener("click", closeInfoModal);
  const sheet = modal.querySelector<HTMLElement>(".map-license-sheet");
  if (sheet) setupPromptSheetSwipe(sheet, closeInfoModal);
  window.addEventListener("keydown", keyHandler);
  window.setTimeout(() => {
    modal.classList.add("open");
    document.body.classList.add("map-license-panel-open");
    setPromptSidePanelWidthFromSheet(sheet);
  }, 20);
}

function itsShowMapLicenseModal(): void {
  if (document.getElementById("map-license-modal")) return;
  closeFloatingMapPanels();
  const modal = document.createElement("div");
  modal.id = "map-license-modal";
  modal.className = "map-license-modal";
  modal.innerHTML = `
    <section class="map-license-sheet" role="dialog" aria-modal="true" aria-labelledby="map-license-title">
      <div class="map-license-grip" data-swipe-handle aria-hidden="true"></div>
      <header class="map-license-head">
        <div>
          <span>ITS Maps</span>
          <h2 id="map-license-title">Lisensi Peta</h2>
        </div>
        <button type="button" aria-label="Tutup Lisensi Peta" title="Tutup" data-license-close>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </header>
      <div class="map-license-list">
        ${mapServiceStackHtml()}
      </div>
    </section>
  `;
  document.body.appendChild(modal);
  let closeLicenseModal: () => void = () => undefined;
  let mapLicenseClosing = false;
  const keyHandler = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key === "Escape") closeLicenseModal();
  };
  closeLicenseModal = () => {
    if (mapLicenseClosing) return;
    mapLicenseClosing = true;
    if (modal.classList.contains("its-ai-agent-target-stacked")) {
      itsReleaseAgentPanelStack();
    }
    window.removeEventListener("keydown", keyHandler);
    modal.classList.remove("open");
    document.body.classList.remove("map-license-panel-open");
    clearPromptSidePanelWidth();
    window.setTimeout(() => modal.remove(), 220);
  };
  modal.addEventListener("click", (clickEvent) => {
    if (clickEvent.target === modal) closeLicenseModal();
  });
  modal.querySelector<HTMLButtonElement>("[data-license-close]")?.addEventListener("click", closeLicenseModal);
  const sheet = modal.querySelector<HTMLElement>(".map-license-sheet");
  if (sheet) setupPromptSheetSwipe(sheet, closeLicenseModal);
  window.addEventListener("keydown", keyHandler);
  window.setTimeout(() => {
    modal.classList.add("open");
    document.body.classList.add("map-license-panel-open");
    setPromptSidePanelWidthFromSheet(sheet);
  }, 20);
}

function itsShowAiLicenseModal(): void {
  if (document.getElementById("ai-license-modal")) return;
  closeFloatingMapPanels();
  const modal = document.createElement("div");
  modal.id = "ai-license-modal";
  modal.className = "map-license-modal ai-license-modal";
  modal.innerHTML = `
    <section class="map-license-sheet" role="dialog" aria-modal="true" aria-labelledby="ai-license-title">
      <div class="map-license-grip" data-swipe-handle aria-hidden="true"></div>
      <header class="map-license-head">
        <div>
          <span>ITS Maps</span>
          <h2 id="ai-license-title">Lisensi AI</h2>
        </div>
        <button type="button" aria-label="Tutup Lisensi AI" title="Tutup" data-license-close>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </header>
      <div class="map-license-list">
        ${aiServiceStackHtml()}
      </div>
    </section>
  `;
  document.body.appendChild(modal);
  let closeLicenseModal: () => void = () => undefined;
  let aiLicenseClosing = false;
  const keyHandler = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key === "Escape") closeLicenseModal();
  };
  closeLicenseModal = () => {
    if (aiLicenseClosing) return;
    aiLicenseClosing = true;
    if (modal.classList.contains("its-ai-agent-target-stacked")) {
      itsReleaseAgentPanelStack();
    }
    window.removeEventListener("keydown", keyHandler);
    modal.classList.remove("open");
    document.body.classList.remove("map-license-panel-open");
    clearPromptSidePanelWidth();
    window.setTimeout(() => modal.remove(), 220);
  };
  modal.addEventListener("click", (clickEvent) => {
    if (clickEvent.target === modal) closeLicenseModal();
  });
  modal.querySelector<HTMLButtonElement>("[data-license-close]")?.addEventListener("click", closeLicenseModal);
  const sheet = modal.querySelector<HTMLElement>(".map-license-sheet");
  if (sheet) setupPromptSheetSwipe(sheet, closeLicenseModal);
  window.addEventListener("keydown", keyHandler);
  window.setTimeout(() => {
    modal.classList.add("open");
    document.body.classList.add("map-license-panel-open");
    setPromptSidePanelWidthFromSheet(sheet);
  }, 20);
}

const ITS_WINDOWS_VERSION = "1.0.21";
const ITS_ANDROID_VERSION = "1.0.36";
const ITS_IOS_VERSION = "PWA";
const ITS_MICROSOFT_STORE_URL = "https://apps.microsoft.com/detail/9MWFGGW3FD2C";
const ITS_MICROSOFT_STORE_DEEP_LINK = "ms-windows-store://pdp/?productid=9MWFGGW3FD2C";
const ITS_MICROSOFT_STORE_REVIEW_LINK = "ms-windows-store://review/?ProductId=9MWFGGW3FD2C";
const ITS_WINDOWS_INSTALL_URL = "https://github.com/hanifasepthi/its/releases/download/its-maps-v1.0.21/ITS-Maps-Windows-Custom-Setup-1.0.21-x64.exe";
const ITS_WINDOWS_INSTALL_NAME = "ITS-Maps-Windows-Custom-Setup-1.0.21-x64.exe";
const ITS_ANDROID_INSTALL_URL = "https://itstelkom.web.app/artifacts/apps/ITS-Maps-Android-1.0.36.apk.b64";
const ITS_ANDROID_INSTALL_NAME = "ITS-Maps-Android-1.0.36.apk";
const ITS_IOS_INSTALL_URL = "https://itstelkom.web.app/?install=ios";
const ITS_FALLBACK_PREVIEWS = [WIN_PREVIEW_WELCOME, WIN_PREVIEW_OPTIONS, WIN_PREVIEW_DONE];
const ITS_APP_ACCESS_ITEMS: Record<AppDownloadPlatform, Array<[string, string]>> = {
  android: [
    ["Internet dan status jaringan", "Dipakai untuk tile peta, Firebase RTDB, tunnel kamera Raspberry, WebRTC/HLS/MJPEG, update metadata, dan download APK terbaru."],
    ["Lokasi tepat dan perkiraan", "Dipakai untuk marker posisi pengguna, jarak POI, tombol lokasi terkini, dan konteks pemantauan lalu lintas. Lokasi latar belakang dipakai hanya saat fitur realtime/widget aktif."],
    ["Kamera dan mikrofon", "Dipakai oleh WebView saat membuka kamera/WebRTC yang memang meminta izin media; kamera Raspberry tetap berasal dari URL/tunnel, bukan kamera pribadi tanpa persetujuan."],
    ["Notifikasi Android", "Dipakai untuk status service realtime, update manual, dan pemberitahuan penting agar pemantauan tidak diam-diam berhenti."],
    ["Akses notifikasi perangkat", "Opsional. Jika diaktifkan, panel layar kunci membaca ikon, judul, ringkasan, dan waktu notifikasi untuk ditampilkan di area notifikasi lock screen."],
    ["Full-screen intent dan layar kunci", "Dipakai untuk menampilkan panel AI Layar Kunci saat layar menyala dalam kondisi terkunci. Android tetap mengelola PIN, pola, sidik jari, atau face unlock."],
    ["Foreground service dan boot", "Dipakai agar widget, status Raspberry, dan dua snapshot RTDB dapat tersinkron setelah aplikasi aktif atau perangkat baru dinyalakan."],
    ["Install paket", "Dipakai hanya saat pengguna menekan Unduh APK dan memilih memasang file update secara manual."],
    ["Optimasi baterai", "Dipakai untuk meminta pengecualian agar refresh widget dan lock screen tidak dimatikan terlalu cepat oleh sistem."],
  ],
  windows: [
    ["Jaringan", "Dipakai untuk tile peta, Firebase RTDB, tunnel kamera Raspberry Pi, update aplikasi, dan data POI/rute."],
    ["Lokasi", "Dipakai jika pengguna mengaktifkan posisi perangkat untuk marker dan jarak ke POI."],
    ["Kamera dan mikrofon", "Dipakai oleh renderer desktop saat fitur kamera/WebRTC membutuhkan izin media dari Windows."],
    ["Notifikasi desktop", "Dipakai untuk pemberitahuan update, status Raspberry, dan pesan penting di aplikasi Windows."],
    ["Penyimpanan aplikasi", "Dipakai installer untuk menaruh file aplikasi, cache renderer, log, dan data update lokal."],
    ["Akses installer", "Installer berjalan as-invoker; elevasi hanya muncul jika pengguna memilih lokasi yang memang butuh izin admin Windows."],
  ],
  ios: [
    ["Jaringan", "Dipakai Safari/PWA untuk peta, Firebase, kamera publik, dan data aplikasi."],
    ["Lokasi", "Dipakai jika pengguna mengizinkan marker posisi dan fitur jarak POI."],
    ["Kamera", "Dipakai sesuai izin browser ketika membuka fitur kamera/preview yang tersedia di iOS."],
    ["Notifikasi browser", "Mengikuti dukungan iOS/Safari; tidak sama dengan notifikasi native Android."],
    ["Penyimpanan PWA", "Dipakai browser untuk cache web app dan asset peta yang didukung Safari."],
  ],
};
type AppFeaturePreview = {
  title: string;
  subtitle: string;
  image: string;
  description: string;
};

function compactStoreCount(value: number | null): string {
  if (value === null) return "-";
  return new Intl.NumberFormat("id-ID", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function windowsStoreIntegrationHtml(): string {
  return `
    <section class="windows-store-integration" data-windows-store-integration aria-labelledby="windows-store-integration-title">
      <header>
        <span class="windows-store-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M4 6.5 10.5 5v6H4zm7.5-1.7L20 3v8h-8.5zM4 12h6.5v6L4 16.5zm7.5 0H20v8l-8.5-1.8z"/></svg>
        </span>
        <span>
          <strong id="windows-store-integration-title">Microsoft Store</strong>
          <small>Data paket dan ulasan terverifikasi</small>
        </span>
      </header>
      <div class="windows-store-metrics">
        <div><span>Apps on device</span><strong data-store-installed>Belum diperiksa</strong></div>
        <div><span>Rating</span><strong data-store-rating>-</strong></div>
        <div><span>Unduhan</span><strong data-store-downloads>-</strong></div>
      </div>
      <p class="windows-store-device-note">Izin browser hanya memeriksa paket ITS Maps terkait; situs tidak membaca daftar aplikasi lain.</p>
      <p class="windows-store-note" data-store-note>Rating, ulasan, dan akuisisi hanya ditampilkan jika snapshot Partner Center telah diverifikasi.</p>
      <div class="windows-store-reviews" data-store-reviews hidden></div>
      <div class="windows-store-actions">
        <button type="button" data-store-check-app>Periksa aplikasi</button>
        <a href="${ITS_MICROSOFT_STORE_REVIEW_LINK}" data-store-review-link>Beri ulasan</a>
      </div>
    </section>
  `;
}

function renderMicrosoftStoreSnapshot(root: HTMLElement, snapshot: MicrosoftStorePublicSnapshot): void {
  const rating = root.querySelector<HTMLElement>("[data-store-rating]");
  const downloads = root.querySelector<HTMLElement>("[data-store-downloads]");
  const note = root.querySelector<HTMLElement>("[data-store-note]");
  const reviews = root.querySelector<HTMLElement>("[data-store-reviews]");
  if (!snapshot.available) {
    if (note) note.textContent = "Statistik publik belum diterbitkan oleh akun Partner Center. Tidak ada angka perkiraan yang ditampilkan.";
    return;
  }
  if (rating) {
    rating.textContent = snapshot.averageRating === null
      ? "-"
      : `${snapshot.averageRating.toLocaleString("id-ID", { maximumFractionDigits: 1 })} / 5${snapshot.ratingCount === null ? "" : ` (${compactStoreCount(snapshot.ratingCount)})`}`;
  }
  if (downloads) downloads.textContent = compactStoreCount(snapshot.acquisitionCount);
  if (note) {
    const date = snapshot.updatedAt ? new Date(snapshot.updatedAt) : null;
    note.textContent = date && Number.isFinite(date.getTime())
      ? `Snapshot Partner Center diperbarui ${date.toLocaleString("id-ID")}.`
      : "Snapshot statistik berasal dari publikasi Partner Center terverifikasi.";
  }
  if (reviews && snapshot.reviews.length) {
    reviews.hidden = false;
    reviews.innerHTML = snapshot.reviews.map((review) => `
      <article>
        <span><strong>${escapeStaticHtml(review.author)}</strong><b>${"★".repeat(Math.round(review.rating))}</b></span>
        ${review.title ? `<h4>${escapeStaticHtml(review.title)}</h4>` : ""}
        <p>${escapeStaticHtml(review.body)}</p>
      </article>
    `).join("");
  }
}

async function hydrateWindowsStoreIntegration(modal: HTMLElement): Promise<void> {
  const root = modal.querySelector<HTMLElement>("[data-windows-store-integration]");
  if (!root) return;
  const installed = root.querySelector<HTMLElement>("[data-store-installed]");
  const checkButton = root.querySelector<HTMLButtonElement>("[data-store-check-app]");
  const checkInstallation = async () => {
    if (!checkButton || !installed) return;
    checkButton.disabled = true;
    checkButton.textContent = "Memeriksa...";
    const status = await queryItsWindowsAppInstallation(true);
    installed.textContent = status.error
      ? "Izin ditolak"
      : status.supported
        ? status.installed ? "Terpasang" : "Tidak terdeteksi"
        : "Tidak didukung";
    installed.dataset.state = status.installed ? "installed" : "missing";
    checkButton.textContent = status.installed ? "Periksa lagi" : "Periksa aplikasi";
    checkButton.disabled = false;
  };
  checkButton?.addEventListener("click", () => void checkInstallation());
  // Opening the app/download panel is itself an explicit user gesture. Check
  // the verified related Store package immediately so Chromium can show its
  // native "Apps on your device" permission prompt when the API is supported.
  if (/Windows/i.test(navigator.userAgent)) void checkInstallation();
  root.querySelector<HTMLAnchorElement>("[data-store-review-link]")?.addEventListener("click", (event) => {
    if (!/Windows/i.test(navigator.userAgent)) {
      event.preventDefault();
      window.open(ITS_MICROSOFT_STORE_URL, "_blank", "noopener");
    }
  });
  renderMicrosoftStoreSnapshot(root, await fetchMicrosoftStorePublicSnapshot(FIREBASE_ROOT_URL));
}
const ITS_ANDROID_FEATURE_PREVIEWS: AppFeaturePreview[] = [
  {
    title: "AI Layar Kunci",
    subtitle: "Panel Fluent saat perangkat terkunci",
    image: "/screenshots/android/lockscreen-ai.png",
    description: "Menampilkan jam, status Raspberry, notifikasi, dua snapshot RTDB, animasi scanner AI, label objek Bahasa Indonesia, tombol rincian, tema Auto/Gelap/Terang, serta geser untuk membuka kunci lewat autentikasi Android.",
  },
  {
    title: "Widget Kamera AI",
    subtitle: "Widget home screen realtime",
    image: "/screenshots/android/widget-data.png",
    description: "Widget Android menampilkan data realtime, status online/offline, grafik/kendaraan, snapshot kamera Raspberry, dan kontrol refresh agar pengguna bisa memantau tanpa membuka aplikasi penuh.",
  },
  {
    title: "Rincian Deteksi",
    subtitle: "Thumbnail dan breakdown objek",
    image: "/screenshots/android/lockscreen-detail.png",
    description: "Setiap objek yang cukup yakin ditampilkan dengan nama Indonesia, persentase akurasi, thumbnail, dan rincian posisi/ukuran. Hitungan yang masuk ke sistem lalu lintas tetap dibatasi pada kendaraan.",
  },
];
const ITS_PLATFORM_RELEASE_NOTES: Record<AppDownloadPlatform, string[]> = {
  android: [
    "APK memuat peta realtime yang sama dengan website, plus tombol Pengaturan di samping Lapisan untuk fitur khusus Android.",
    "Pengaturan APK mengontrol pemantauan AI Layar Kunci native, pratinjau layar kunci, widget realtime, dan refresh RTDB.",
    "Widget snapshot AI menampilkan kotak deteksi dan label Bahasa Indonesia; hitungan/database tetap hanya kendaraan: mobil, motor, sepeda, bus, truk.",
    "Panel AI Layar Kunci menampilkan jam, status Raspberry, dua snapshot, notifikasi opsional, tema Auto/Gelap/Terang, animasi canvas AI, rincian objek, dan geser untuk membuka kunci perangkat.",
    "Download APK dibuat manual melalui installer Android agar pengguna tidak mendapat auto-download mendadak.",
  ],
  windows: [
    "EXE Windows adalah aplikasi desktop Electron untuk peta, kamera, grafik, history, dokumentasi, notifikasi desktop, dan update aplikasi.",
    "Installer Windows menyiapkan shortcut, lokasi instalasi, cache aplikasi, dan akses jaringan; tidak membawa widget Android atau Lock Screen AI.",
    "Fitur izin Windows disesuaikan dengan desktop: lokasi opsional, media kamera/WebRTC, jaringan, penyimpanan aplikasi, dan notifikasi desktop.",
    "Release Windows terbaru yang tersedia di repo saat ini adalah 1.0.21, terpisah dari versi APK Android 1.0.36.",
  ],
  ios: [
    "iOS memakai pengalaman Safari/PWA, bukan file APK/EXE.",
    "Fitur mengikuti kemampuan browser iOS: peta, kamera publik, lokasi opsional, dan cache PWA.",
    "Lock Screen AI native Android dan widget Android tidak tersedia di iOS.",
  ],
};

type AppDownloadPlatform = "windows" | "android" | "ios";
type AppDownloadInfo = {
  platform: AppDownloadPlatform;
  platformName: string;
  extension: ".exe" | ".apk" | ".app";
  versionName: string;
  fileName: string;
  url: string;
  previewFolder: "windows" | "mobile";
  shortDescription: string;
  longDescription: string;
  releaseNotes: string[];
  accessItems: Array<[string, string]>;
};
type DynamicAppLinks = Partial<Record<AppDownloadPlatform, string>>;

let itsDynamicAppLinks: DynamicAppLinks = {};
let itsDynamicAppLinksPromise: Promise<void> | null = null;

function safeDynamicDownloadUrl(value: unknown): string {
  const url = typeof value === "string" ? value.trim() : "";
  if (!url) return "";
  if (/^https?:\/\//i.test(url) || url.startsWith("/")) return url;
  return "";
}

async function refreshDynamicAppLinks(force = false): Promise<void> {
  if (itsDynamicAppLinksPromise && !force) return itsDynamicAppLinksPromise;
  itsDynamicAppLinksPromise = (async () => {
    try {
      const res = await fetch(`${FIREBASE_ROOT_URL}/linkDynamics.json`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json() as Record<string, unknown> | null;
      if (!data || typeof data !== "object") return;
      itsDynamicAppLinks = {
        android: safeDynamicDownloadUrl(data.android),
        ios: safeDynamicDownloadUrl(data.ios),
        windows: safeDynamicDownloadUrl(data.windows),
      };
    } catch {
      // Keep bundled fallback links when RTDB is unreachable.
    }
  })();
  return itsDynamicAppLinksPromise;
}

function appScreenshotUrls(folder: "windows" | "mobile"): string[] {
  const prefix = `./ss/${folder}/`;
  return Object.entries(APP_SCREENSHOT_MODULES)
    .filter(([path]) => path.startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, url]) => url);
}

function detectAppDownloadPlatform(): AppDownloadPlatform {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  if (/iPad|iPhone|iPod/i.test(ua) || (/Mac/i.test(platform) && navigator.maxTouchPoints > 1)) return "ios";
  if (/android/i.test(ua) || window.innerWidth <= 720 || navigator.maxTouchPoints > 1) return "android";
  return "windows";
}

function nativeAndroidBridge(): ItsAndroidBridge | null {
  return (window as Window & { ItsApkInstaller?: ItsAndroidBridge }).ItsApkInstaller || null;
}

function isAndroidApkRuntime(): boolean {
  const ua = navigator.userAgent || "";
  const host = window.location.hostname;
  const protocol = window.location.protocol;
  if (/ITSMapsAndroidApk/i.test(ua)) return true;
  if (nativeAndroidBridge()) return true;
  const w = window as Window & { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } };
  try {
    if (w.Capacitor?.isNativePlatform?.() && w.Capacitor?.getPlatform?.() === "android") return true;
  } catch {
    // Fallback below covers older Capacitor injections.
  }
  return /Android/i.test(ua)
    && (["localhost", "127.0.0.1"].includes(host) || ["file:", "capacitor:"].includes(protocol));
}

function getAppDownloadInfo(): AppDownloadInfo {
  const platform = detectAppDownloadPlatform();
  if (platform === "android") {
    return {
      platform,
      platformName: "Android",
      extension: ".apk",
      versionName: ITS_ANDROID_VERSION,
      fileName: ITS_ANDROID_INSTALL_NAME,
      url: itsDynamicAppLinks.android || ITS_ANDROID_INSTALL_URL,
      previewFolder: "mobile",
      shortDescription: "Aplikasi Android ITS Maps untuk peta realtime, kamera, pemantauan Lock Screen AI, notifikasi, dan kontrol Raspberry Pi.",
      longDescription: "ITS Maps Android membawa peta realtime berbasis data OSM, lokasi pengguna, kamera Raspberry Pi, notifikasi, widget home screen, panel Lock Screen AI native, dua snapshot yang dianalisis AI, animasi scanner canvas, dan ringkasan kendaraan. Build APK dipakai untuk instalasi manual di perangkat Android.",
      releaseNotes: ITS_PLATFORM_RELEASE_NOTES.android,
      accessItems: ITS_APP_ACCESS_ITEMS.android,
    };
  }
  if (platform === "ios") {
    return {
      platform,
      platformName: "iOS",
      extension: ".app",
      versionName: ITS_IOS_VERSION,
      fileName: "ITS-Maps-iOS.app",
      url: itsDynamicAppLinks.ios || ITS_IOS_INSTALL_URL,
      previewFolder: "mobile",
      shortDescription: "Mode iOS ITS Maps memakai pengalaman app-like dengan Safari/PWA dan tampilan mobile.",
      longDescription: "ITS Maps di iOS berjalan sebagai pengalaman web app yang dapat dipasang dari Safari. Fitur peta, notifikasi yang didukung browser, preview kamera, dan dokumentasi tetap mengikuti tampilan mobile yang sama.",
      releaseNotes: ITS_PLATFORM_RELEASE_NOTES.ios,
      accessItems: ITS_APP_ACCESS_ITEMS.ios,
    };
  }
  return {
    platform,
    platformName: "Windows",
    extension: ".exe",
    versionName: ITS_WINDOWS_VERSION,
    fileName: ITS_WINDOWS_INSTALL_NAME,
    url: itsDynamicAppLinks.windows || ITS_WINDOWS_INSTALL_URL,
    previewFolder: "windows",
    shortDescription: "Installer Windows ITS Maps dengan peta dan POI realtime, kamera AI, notifikasi desktop, serta pembaruan aplikasi.",
    longDescription: "ITS Maps Windows adalah aplikasi desktop Electron untuk memantau Raspberry Pi, peta realtime, kamera, grafik lalu lintas, history, update otomatis, dokumentasi, dan panel What's New. EXE Windows tidak memuat widget Android atau Lock Screen AI; fiturnya disesuaikan dengan perangkat desktop.",
    releaseNotes: ITS_PLATFORM_RELEASE_NOTES.windows,
    accessItems: ITS_APP_ACCESS_ITEMS.windows,
  };
}

function appPreviewImages(info: AppDownloadInfo): string[] {
  const screenshots = appScreenshotUrls(info.previewFolder);
  return screenshots.length ? screenshots : ITS_FALLBACK_PREVIEWS;
}

function appFeaturePreviews(info: AppDownloadInfo): AppFeaturePreview[] {
  return info.platform === "android" ? ITS_ANDROID_FEATURE_PREVIEWS : [];
}

function appDataSafetyIcon(kind: "share" | "collect" | "lock" | "delete" | "feature"): string {
  const paths: Record<typeof kind, string> = {
    share: '<path d="M18 8a3 3 0 1 0-2.83-4H15a3 3 0 0 0 .17 1L8.6 8.8A3 3 0 0 0 6 7a3 3 0 1 0 2.6 4.5l6.58 3.84A3 3 0 1 0 16 14a3 3 0 0 0-.18.03L9.24 10.2a3 3 0 0 0 0-.4l6.58-3.84c.53.63 1.32 1.04 2.18 1.04Z"/>',
    collect: '<path d="M12 3 4 7.5V16c0 1.7 3.74 4.25 8 5 4.26-.75 8-3.3 8-5V7.5L12 3Z"/><path d="M8 12h8M8 16h5"/>',
    lock: '<path d="M7 11V8a5 5 0 0 1 10 0v3"/><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M12 15v3"/>',
    delete: '<path d="M4 7h16M9 7V5h6v2M8 10v8M12 10v8M16 10v8"/><path d="M6 7l1 14h10l1-14"/>',
    feature: '<path d="M4 5h16v11H4z"/><path d="M8 21h8M10 16l-1 5M14 16l1 5"/>',
  };
  return `<svg class="windows-data-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[kind]}</svg>`;
}

function appAccessPreviewHtml(info: AppDownloadInfo, limit = 3): string {
  const shown = info.accessItems.slice(0, limit);
  const remaining = Math.max(0, info.accessItems.length - shown.length);
  return `
    <div class="windows-data-safety-preview">
      ${shown.map(([title, description]) => `
        <article>
          ${appDataSafetyIcon("collect")}
          <span>
            <strong>${escapeStaticHtml(title)}</strong>
            <small>${escapeStaticHtml(description)}</small>
          </span>
        </article>
      `).join("")}
      ${remaining > 0 ? `
        <article class="muted">
          ${appDataSafetyIcon("feature")}
          <span>
            <strong>+${remaining} izin dan data lain</strong>
            <small>Termasuk fitur Android seperti widget, layar kunci, dan update manual.</small>
          </span>
        </article>
      ` : ""}
    </div>
  `;
}

function appDataSafetySummaryHtml(info: AppDownloadInfo): string {
  return `
    <button type="button" class="windows-data-safety-card" data-download-detail aria-label="Buka detail data dan izin aplikasi">
      <span class="windows-data-safety-head">
        <span>
          <strong>Data keamanan</strong>
          <small>Transparansi izin yang dipakai ITS Maps ${escapeStaticHtml(info.platformName)}.</small>
        </span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
      </span>
      <span class="windows-data-safety-copy">Aplikasi memakai izin sesuai fitur yang diaktifkan pengguna. Ringkasan berikut hanya menampilkan sebagian izin utama.</span>
      ${appAccessPreviewHtml(info, 3)}
    </button>
  `;
}

function appPermissionDetailHtml(info: AppDownloadInfo): string {
  return `
    <section class="windows-data-detail-app">
      <img src="${ITS_APP_ICON_SMALL}" alt="" width="64" height="96">
      <span>
        <strong>ITS Maps ${escapeStaticHtml(info.platformName)}</strong>
        <small>Versi ${escapeStaticHtml(info.versionName)} · pemantauan lalu lintas Raspberry Pi</small>
      </span>
    </section>
    <section class="windows-data-detail-hero">
      <h3>Data keamanan</h3>
      <p>Informasi berikut menjelaskan izin Android dan jenis data yang dapat dipakai aplikasi. Pemakaian izin mengikuti fitur yang pengguna aktifkan, seperti lokasi, widget realtime, notifikasi, dan Lock Screen AI.</p>
    </section>
    <div class="windows-data-detail-list">
      <article>
        ${appDataSafetyIcon("share")}
        <span>
          <strong>Data yang dapat dibagikan</strong>
          <small>Data operasional dapat dikirim ke Firebase RTDB atau endpoint Raspberry untuk sinkronisasi status, kamera, dan kontrol lalu lintas.</small>
        </span>
      </article>
      <article>
        ${appDataSafetyIcon("collect")}
        <span>
          <strong>Data yang dapat dikumpulkan</strong>
          <small>Lokasi, status jaringan, log sinkronisasi, snapshot Raspberry, metadata widget, dan notifikasi jika akses notifikasi diaktifkan.</small>
        </span>
      </article>
      <article>
        ${appDataSafetyIcon("lock")}
        <span>
          <strong>Data dienkripsi saat transit</strong>
          <small>Koneksi web, Firebase, dan download update memakai HTTPS. Kunci layar tetap dikelola Android.</small>
        </span>
      </article>
      <article>
        ${appDataSafetyIcon("delete")}
        <span>
          <strong>Data lokal dapat dihapus</strong>
          <small>Menghapus aplikasi akan menghapus cache WebView, preferensi widget, dan data lokal aplikasi dari perangkat.</small>
        </span>
      </article>
    </div>
    <div class="windows-download-section-title">Rincian izin aplikasi</div>
    <div class="windows-access-list windows-access-list-detail">
      ${info.accessItems.map(([title, description]) => `
        <article>
          <strong>${escapeStaticHtml(title)}</strong>
          <span>${escapeStaticHtml(description)}</span>
        </article>
      `).join("")}
    </div>
  `;
}

function appFeatureGalleryHtml(features: AppFeaturePreview[]): string {
  return `
    <div class="windows-feature-gallery">
      ${features.map((feature) => `
        <article>
          <img src="${escapeStaticHtml(feature.image)}" alt="${escapeStaticHtml(feature.title)}">
          <span>
            <strong>${escapeStaticHtml(feature.title)}</strong>
            <small>${escapeStaticHtml(feature.subtitle)}</small>
            <p>${escapeStaticHtml(feature.description)}</p>
          </span>
        </article>
      `).join("")}
    </div>
  `;
}

function itsCreateSplash(): void {
  if (document.getElementById("its-splash")) return;
  const startedAt = performance.now();
  const splash = document.createElement("div");
  splash.id = "its-splash";
  splash.innerHTML = `
    <div class="its-splash-card">
      <span class="its-splash-logo" aria-hidden="true">
        <svg viewBox="0 0 48 48" fill="none" role="img">
          <path d="M24 44s15-13.4 15-26A15 15 0 1 0 9 18c0 12.6 15 26 15 26Z" fill="white" fill-opacity=".92"/>
          <circle cx="24" cy="18" r="7" fill="#2563eb"/>
        </svg>
      </span>
      <strong>ITS Maps</strong>
      <span>Menyiapkan peta...</span>
      <i aria-hidden="true"></i>
    </div>
  `;
  document.body.appendChild(splash);

  let done = false;
  let mapReady = itsMapReady;
  let dataReady = itsInitialDataReady;
  const hide = () => {
    if (done) return;
    done = true;
    const wait = Math.max(0, 520 - (performance.now() - startedAt));
    window.setTimeout(() => splash.classList.add("hide"), wait);
    window.setTimeout(() => splash.remove(), wait + 320);
  };
  const hideWhenReady = () => {
    if (mapReady || dataReady) hide();
  };

  window.addEventListener("its:map-ready", () => {
    mapReady = true;
    hideWhenReady();
  }, { once: true });
  window.addEventListener("its:initial-data-ready", () => {
    dataReady = true;
    hideWhenReady();
  }, { once: true });
  hideWhenReady();
  window.setTimeout(hide, isAndroidApkRuntime() ? 1400 : 2200);
}

function itsDownloadApp(info: AppDownloadInfo): void {
  const androidBridge = nativeAndroidBridge();
  if (info.platform === "android" && androidBridge?.installApk) {
    androidBridge.installApk(info.url, info.fileName);
    return;
  }
  if (info.platform === "android" && isEncodedAndroidApkUrl(info.url)) {
    void downloadEncodedAndroidApk(info);
    return;
  }
  const link = document.createElement("a");
  link.href = info.url;
  link.download = info.fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function isEncodedAndroidApkUrl(url: string): boolean {
  return /\.apk\.b64(?:[?#]|$)/i.test(url) || /[?&]format=apk-base64(?:&|$)/i.test(url);
}

async function downloadEncodedAndroidApk(info: AppDownloadInfo): Promise<void> {
  showDownloadNotice("Menyiapkan APK dari Firebase...", "info");
  try {
    const response = await fetch(info.url, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const encoded = (await response.text()).replace(/\s+/g, "");
    const blob = base64ToBlob(encoded, "application/vnd.android.package-archive");
    downloadBlob(blob, info.fileName || "ITS.apk");
    showDownloadNotice("APK siap diunduh. Jika diminta, izinkan instalasi dari browser.", "success");
  } catch (err) {
    console.warn("[ITS] Encoded APK download failed", err);
    showDownloadNotice("Gagal menyiapkan APK dari Firebase. Coba lagi saat koneksi stabil.", "error");
  }
}

function base64ToBlob(encoded: string, contentType: string): Blob {
  const chunks: BlobPart[] = [];
  const chunkSize = 128 * 1024;
  for (let offset = 0; offset < encoded.length; offset += chunkSize) {
    const chunk = encoded.slice(offset, offset + chunkSize);
    const binary = window.atob(chunk);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    chunks.push(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  return new Blob(chunks, { type: contentType });
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function showDownloadNotice(message: string, kind: "info" | "success" | "error"): void {
  let notice = document.getElementById("its-download-notice") as HTMLDivElement | null;
  if (!notice) {
    notice = document.createElement("div");
    notice.id = "its-download-notice";
    notice.className = "its-download-notice";
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    document.body.appendChild(notice);
  }
  notice.dataset.kind = kind;
  notice.textContent = message;
  window.clearTimeout(Number(notice.dataset.timer || 0));
  const timer = window.setTimeout(() => notice?.remove(), kind === "info" ? 6000 : 9000);
  notice.dataset.timer = String(timer);
}

function itsCreateWindowsDownloadButton(): void {
  if (isAndroidApkRuntime()) {
    document.getElementById("windows-download-app")?.remove();
    document.getElementById("windows-download-modal")?.remove();
    return;
  }
  if (document.getElementById("windows-download-app")) return;
  void refreshDynamicAppLinks();
  const info = getAppDownloadInfo();
  const previews = appPreviewImages(info);
  const host = document.createElement("div");
  host.id = "windows-download-app";
  host.className = "windows-download-app";
  host.innerHTML = `
    <button type="button" class="windows-download-trigger" aria-label="Download ITS Maps ${info.platformName}" title="Download ITS Maps ${info.platformName}" data-tooltip="Download ITS Maps ${info.platformName}">
      <img src="${ITS_APP_ICON_SMALL}" alt="" width="64" height="96">
      <span class="windows-download-badge" aria-hidden="true"></span>
    </button>
    <div class="windows-download-hover-card" aria-hidden="true">
      <div class="windows-download-hover-head">
        <img src="${ITS_APP_ICON_SMALL}" alt="" width="64" height="96">
        <div>
          <strong>ITS Maps ${info.platformName}</strong>
          <span>Versi ${info.versionName}</span>
        </div>
      </div>
      <img class="windows-download-hover-preview" src="${previews[0] || "/screenshots/desktop-map.png"}" alt="">
    </div>
  `;
  host.querySelector<HTMLButtonElement>(".windows-download-trigger")?.addEventListener("click", () => void itsShowWindowsDownloadModal());
  document.body.appendChild(host);
}

async function itsShowWindowsDownloadModal(): Promise<void> {
  if (document.getElementById("windows-download-modal")) return;
  await refreshDynamicAppLinks(true);
  closeFloatingMapPanels();
  document.querySelectorAll("#map-license-modal, #ai-license-modal, #roadmap-story-modal, #privacy-info-modal, #app-license-info-modal, #about-site-info-modal")
    .forEach((modal) => modal.remove());
  document.body.classList.remove("map-license-panel-open");
  const info = getAppDownloadInfo();
  const previews = appPreviewImages(info);
  const featurePreviews = appFeaturePreviews(info);
  const modal = document.createElement("div");
  modal.id = "windows-download-modal";
  modal.className = `windows-download-modal platform-${info.platform}`;
  modal.innerHTML = `
    <section class="windows-download-sheet" role="dialog" aria-modal="true" aria-labelledby="windows-download-title">
      <div class="windows-download-grip" data-swipe-handle aria-hidden="true"></div>
      <div class="windows-download-view windows-download-summary active" data-download-view="summary">
        <div class="windows-download-head">
          <img class="windows-download-icon" src="${ITS_APP_ICON_SMALL}" alt="" width="64" height="96">
          <div>
            <h2 id="windows-download-title">ITS Maps ${info.platformName}</h2>
            <p>Versi ${info.versionName}</p>
          </div>
          <button type="button" class="windows-download-close" aria-label="Tutup" title="Tutup" data-windows-close>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
          </button>
        </div>
        <div class="windows-download-modal-actions">
          <button type="button" class="windows-download-primary" data-windows-download>Unduh ${info.extension.toUpperCase()}</button>
          ${info.platform === "windows" ? `<a class="windows-download-secondary windows-download-store" href="${ITS_MICROSOFT_STORE_URL}" data-windows-store-link target="_blank" rel="noopener">Microsoft Store</a>` : ""}
        </div>
        <div class="windows-download-section-title">Gambar pratinjau</div>
        <div class="windows-download-modal-carousel" aria-label="Preview aplikasi ${info.platformName}">
          ${previews.map((src, index) => `<img src="${src}" alt="Preview ITS Maps ${info.platformName} ${index + 1}" class="${index === 0 ? "active" : ""}">`).join("")}
          <div class="windows-download-dots">
            ${previews.map((_, index) => `<button type="button" aria-label="Preview ${index + 1}" class="${index === 0 ? "active" : ""}"></button>`).join("")}
          </div>
        </div>
        <div class="windows-download-section-title">Deskripsi</div>
        <p class="windows-download-description">${info.shortDescription}</p>
        ${info.platform === "windows" ? windowsStoreIntegrationHtml() : ""}
        ${featurePreviews.length ? `
          <div class="windows-download-section-title">Gambaran fitur</div>
          <button type="button" class="windows-feature-showcase-card" data-feature-gallery aria-label="Buka semua gambaran fitur Android">
            <img src="${escapeStaticHtml(featurePreviews[0].image)}" alt="">
            <span>
              <strong>${escapeStaticHtml(featurePreviews[0].title)}</strong>
              <small>${featurePreviews.length} gambaran fitur Android tersedia</small>
            </span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
          </button>
        ` : ""}
        ${appDataSafetySummaryHtml(info)}
      </div>
      <div class="windows-download-view windows-download-detail" data-download-view="detail">
        <div class="windows-download-detail-head">
          <button type="button" class="windows-download-back" data-download-back aria-label="Kembali" title="Kembali">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <img class="windows-download-icon" src="${ITS_APP_ICON_SMALL}" alt="" width="64" height="96">
          <div>
            <h2 data-download-detail-title>Data dan izin aplikasi</h2>
            <p data-download-detail-subtitle>ITS Maps ${info.platformName} ${info.versionName}</p>
          </div>
          <button type="button" class="windows-download-close" aria-label="Tutup" title="Tutup" data-windows-close>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
          </button>
        </div>
        <div class="windows-download-detail-body" data-download-detail-body>${appPermissionDetailHtml(info)}</div>
      </div>
    </section>
  `;
  document.body.appendChild(modal);
  document.body.classList.add("app-download-panel-open");
  if (info.platform === "windows") void hydrateWindowsStoreIntegration(modal);

  let carouselIndex = 0;
  let carouselTimer = 0;
  let closeDownloadModal: () => void = () => undefined;
  const keyHandler = (event: KeyboardEvent) => {
    if (event.key === "Escape") closeDownloadModal();
  };
  closeDownloadModal = () => {
    window.clearInterval(carouselTimer);
    window.removeEventListener("keydown", keyHandler);
    modal.classList.remove("open");
    document.body.classList.remove("app-download-panel-open");
    clearPromptSidePanelWidth();
    window.setTimeout(() => modal.remove(), 220);
  };
  const setCarouselIndex = (nextIndex: number) => {
    const images = modal.querySelectorAll<HTMLImageElement>(".windows-download-modal-carousel img");
    const dots = modal.querySelectorAll<HTMLButtonElement>(".windows-download-dots button");
    if (!images.length) return;
    images[carouselIndex]?.classList.remove("active");
    dots[carouselIndex]?.classList.remove("active");
    carouselIndex = nextIndex % images.length;
    images[carouselIndex]?.classList.add("active");
    dots[carouselIndex]?.classList.add("active");
  };

  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeDownloadModal();
  });
  modal.querySelectorAll<HTMLButtonElement>("[data-windows-close]").forEach((button) => {
    button.addEventListener("click", closeDownloadModal);
  });
  modal.querySelector<HTMLButtonElement>("[data-windows-download]")?.addEventListener("click", () => itsDownloadApp(info));
  modal.querySelector<HTMLAnchorElement>("[data-windows-store-link]")?.addEventListener("click", (event) => {
    // Prefer the native Store picker on Windows while retaining the web Store
    // page as a safe fallback in browsers and embedded web views.
    if (/Windows/i.test(navigator.userAgent)) {
      event.preventDefault();
      window.location.href = ITS_MICROSOFT_STORE_DEEP_LINK;
      window.setTimeout(() => {
        if (document.visibilityState === "visible") window.open(ITS_MICROSOFT_STORE_URL, "_blank", "noopener");
      }, 900);
    }
  });
  const detailTitle = modal.querySelector<HTMLElement>("[data-download-detail-title]");
  const detailSubtitle = modal.querySelector<HTMLElement>("[data-download-detail-subtitle]");
  const detailBody = modal.querySelector<HTMLElement>("[data-download-detail-body]");
  const openDetailView = (title: string, subtitle: string, bodyHtml: string) => {
    if (detailTitle) detailTitle.textContent = title;
    if (detailSubtitle) detailSubtitle.textContent = subtitle;
    if (detailBody) detailBody.innerHTML = bodyHtml;
    modal.classList.add("detail-open");
    sheet?.scrollTo({ top: 0, behavior: "smooth" });
  };
  modal.querySelector<HTMLButtonElement>("[data-download-detail]")?.addEventListener("click", () => {
    openDetailView("Data dan izin aplikasi", `ITS Maps ${info.platformName} ${info.versionName}`, appPermissionDetailHtml(info));
  });
  modal.querySelectorAll<HTMLButtonElement>("[data-feature-gallery]").forEach((button) => {
    button.addEventListener("click", () => {
      openDetailView("Gambaran fitur", `ITS Maps ${info.platformName} ${info.versionName}`, appFeatureGalleryHtml(featurePreviews));
    });
  });
  modal.querySelector<HTMLButtonElement>("[data-download-back]")?.addEventListener("click", () => {
    modal.classList.remove("detail-open");
  });
  modal.querySelectorAll<HTMLButtonElement>(".windows-download-dots button").forEach((dot, index) => {
    dot.addEventListener("click", () => setCarouselIndex(index));
  });
  const sheet = modal.querySelector<HTMLElement>(".windows-download-sheet");
  if (sheet) setupPromptSheetSwipe(sheet, closeDownloadModal);
  window.addEventListener("keydown", keyHandler);
  window.setTimeout(() => {
    modal.classList.add("open");
    setPromptSidePanelWidthFromSheet(sheet);
  }, 20);
  carouselTimer = window.setInterval(() => setCarouselIndex(carouselIndex + 1), 2600);
}

function setupPromptSheetSwipe(sheetEl: HTMLElement, onClose: () => void): void {
  let startAxis = 0;
  let startCrossAxis = 0;
  let currentAxis = 0;
  let dragging = false;
  let directionLocked = false;
  let pointerId = -1;
  let startedAt = 0;

  sheetEl.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement;
    const startsOnHandle = promptSheetSwipeHandleTarget(target);
    // Header areas double as swipe handles, but their controls must retain the
    // original pointer target. Capturing a close-button pointer on the sheet
    // retargets the click to <section> and makes the button appear unresponsive.
    if (target.closest("button, a, input, label, select, textarea")) return;
    const horizontal = window.matchMedia("(min-width: 721px)").matches;
    if (!startsOnHandle && !promptCanStartDismiss(target, sheetEl, horizontal)) return;
    startAxis = horizontal ? event.clientX : event.clientY;
    startCrossAxis = horizontal ? event.clientY : event.clientX;
    currentAxis = 0;
    dragging = true;
    directionLocked = false;
    pointerId = event.pointerId;
    startedAt = performance.now();
    sheetEl.dataset.swipeAxis = horizontal ? "x" : "y";
    sheetEl.style.transition = "none";
    try { sheetEl.setPointerCapture?.(event.pointerId); } catch { /* Pointer may already be released. */ }
  });

  sheetEl.addEventListener("pointermove", (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    const horizontal = sheetEl.dataset.swipeAxis === "x";
    const axis = horizontal ? event.clientX : event.clientY;
    const crossAxis = horizontal ? event.clientY : event.clientX;
    const primaryDelta = axis - startAxis;
    const crossDelta = crossAxis - startCrossAxis;
    if (!directionLocked) {
      if (Math.max(Math.abs(primaryDelta), Math.abs(crossDelta)) < 8) return;
      if (Math.abs(crossDelta) > Math.abs(primaryDelta)) {
        dragging = false;
        sheetEl.style.transition = "";
        sheetEl.style.transform = "";
        return;
      }
      directionLocked = true;
    }
    currentAxis = Math.max(0, primaryDelta);
    if (currentAxis > 2) event.preventDefault();
    sheetEl.style.transform = horizontal ? `translateX(${currentAxis}px)` : `translateY(${currentAxis}px)`;
    sheetEl.style.opacity = String(Math.max(0.72, 1 - currentAxis / Math.max(480, sheetEl.clientWidth * 2)));
    if (horizontal) {
      const remaining = Math.max(0, sheetEl.getBoundingClientRect().width - currentAxis);
      setPromptSidePanelWidth(remaining);
    }
  });

  const finish = (event: PointerEvent) => {
    if (!dragging || event.pointerId !== pointerId) return;
    dragging = false;
    pointerId = -1;
    sheetEl.style.transition = "";
    sheetEl.style.opacity = "";
    const elapsed = Math.max(1, performance.now() - startedAt);
    const velocity = currentAxis / elapsed;
    if (currentAxis > 56 || velocity > 0.55) onClose();
    else {
      sheetEl.style.transform = "";
      if (sheetEl.dataset.swipeAxis === "x") setPromptSidePanelWidthFromSheet(sheetEl);
    }
  };

  sheetEl.addEventListener("pointerup", finish);
  sheetEl.addEventListener("pointercancel", finish);
  installPromptWheelDismiss(sheetEl, onClose);
}

type ItsWebMcpResource = "home" | "documentation" | "method" | "privacy" | "licence" | "ai-license" | "roadmap" | "pdf" | "llms" | "about";

let itsWebMcpListenersInstalled = false;
let itsWebMcpImperativeRegistered = false;
let itsAgentModeEnabled = false;
let itsAgentPanelTransitionActive = false;
let itsAgentStackCleanup: (() => void) | null = null;
let itsLastRealPointer = { x: Math.max(16, window.innerWidth - 72), y: Math.max(16, window.innerHeight - 72), valid: false };

const ITS_MODEL_IDS = {
  control: "onnx-community/SmolLM2-135M-Instruct-ONNX",
  research: "onnx-community/Qwen2.5-0.5B-Instruct",
  vision: RF_DETR_ANDROID_MODEL_ID,
} as const;

document.addEventListener("pointermove", (event) => {
  if ((event.target as HTMLElement | null)?.closest("#its-agent-cursor")) return;
  itsLastRealPointer = { x: event.clientX, y: event.clientY, valid: true };
}, { passive: true });

type ItsAssistantResponse = {
  text: string;
  html?: string;
};

type ItsChatTurn = {
  role: "user" | "assistant";
  content: string;
};

type ItsAssistantDetectionDetail = {
  imageUrl: string;
  capturedAt: number;
  modelUrl: string;
  note: string;
  fps: number;
  frameWidth: number;
  frameHeight: number;
  detections: RfDetrDetection[];
  vehicleBreakdown: VehicleBreakdown;
};

type ItsRuntimePoiSnapshot = {
  id: string;
  title: string;
  kind: string;
  icon: string;
  lat: number;
  lng: number;
  address?: string;
};

type ItsMapsRuntimeBridge = {
  getPoiSnapshot?: () => ItsRuntimePoiSnapshot[];
  getUserLocation?: () => { lat: number; lng: number; accuracy?: number; source?: string; updatedAt?: number } | null;
  getMapCenter?: () => { lat: number; lng: number; source?: string } | null;
  getSystemLocation?: () => { lat: number; lng: number; deviceId?: string } | null;
  applyUserLocation?: (lat: number, lng: number, accuracy?: number, center?: boolean, source?: string) => void;
  focusPoi?: (poiId: string, lat: number, lng: number) => void;
  focusLatLng?: (lat: number, lng: number, label?: string) => void;
  goHome?: () => {
    ok: boolean;
    deviceId: string | null;
    lat: number;
    lng: number;
    zoom: number;
  };

  closeAiHistory?: () => boolean;
};

const itsChatDetectionDetails = new Map<string, ItsAssistantDetectionDetail>();

function itsRuntimeBridge(): ItsMapsRuntimeBridge {
  const host = window as typeof window & { __itsMapsRuntimeBridge?: ItsMapsRuntimeBridge };
  if (!host.__itsMapsRuntimeBridge) host.__itsMapsRuntimeBridge = {};
  return host.__itsMapsRuntimeBridge;
}

const ITS_WEBMCP_RESOURCE_URLS: Record<ItsWebMcpResource, string> = {
  home: "/",
  documentation: "/documentation",
  method: "/method",
  privacy: "/privacy",
  licence: "/licence",
  "ai-license": "/license",
  roadmap: "/roadmap/",
  pdf: "/pdf-preview/documentation",
  llms: "/llms.txt",
  about: "/#about",
};

function itsAbsoluteUrl(pathname: string): string {
  return new URL(pathname, "https://itstelkom.web.app").href;
}

function itsOpenWebMcpResource(resourceValue: FormDataEntryValue | null, navigate = true): { resource: ItsWebMcpResource; url: string; message: string } {
  const resource = String(resourceValue || "documentation") as ItsWebMcpResource;
  const safeResource = resource in ITS_WEBMCP_RESOURCE_URLS ? resource : "documentation";
  if (navigate) {
    if (safeResource === "about") {
      itsShowSiteInfoModal("about-site");
    } else {
      window.location.assign(ITS_WEBMCP_RESOURCE_URLS[safeResource]);
    }
  }
  return {
    resource: safeResource,
    url: itsAbsoluteUrl(ITS_WEBMCP_RESOURCE_URLS[safeResource]),
    message: `Opened ITS Maps ${safeResource}.`,
  };
}

async function itsReadWebMcpContext(formatValue: FormDataEntryValue | null): Promise<{ url: string; text: string }> {
  const format = String(formatValue || "summary").toLowerCase() === "full" ? "full" : "summary";
  const url = format === "full" ? "/llms-full.txt" : "/llms.txt";
  const response = await fetch(url, { cache: "no-store" });
  const text = await response.text();
  return { url: itsAbsoluteUrl(url), text };
}

function itsWebMcpContentResponse(text: string, structuredContent?: unknown): unknown {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

function itsAiSparkIconSvg(): string {
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 3l1.8 5.3L19 10l-5.2 1.7L12 17l-1.8-5.3L5 10l5.2-1.7L12 3z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
    <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2zM5.5 14l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6.6-1.6z" fill="currentColor"/>
  </svg>`;
}

function itsHandleWebMcpSubmit(event: SubmitEvent): void {
  const form = event.currentTarget as HTMLFormElement | null;
  if (!form) return;
  const submitEvent = event as SubmitEvent & { agentInvoked?: boolean; respondWith?: (response: Promise<unknown> | unknown) => void };
  if (submitEvent.agentInvoked !== true || typeof submitEvent.respondWith !== "function") return;
  const respondWith = submitEvent.respondWith.bind(submitEvent);

  event.preventDefault();
  const data = new FormData(form);

  if (form.matches("[data-webmcp-open-resource]")) {
    const result = itsOpenWebMcpResource(data.get("resource"), false);
    respondWith(itsWebMcpContentResponse(result.message, result));
    return;
  }

  if (form.matches("[data-webmcp-site-search]")) {
    const query = String(data.get("query") || "").trim();
    const target = query ? `/documentation?search=${encodeURIComponent(query)}#kode-baris-per-baris` : "/documentation";
    const result = { query, url: itsAbsoluteUrl(target) };
    respondWith(itsWebMcpContentResponse(`Prepared ITS Maps documentation search for "${query || "overview"}".`, result));
    return;
  }

  if (form.matches("[data-webmcp-public-context]")) {
    const task = itsReadWebMcpContext(data.get("format")).then((result) => itsWebMcpContentResponse(result.text, result));
    respondWith(task);
  }
}

function finiteNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function objectRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function normalizeEpoch(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v < 1_000_000_000_000 ? Math.round(v * 1000) : Math.round(v);
}

function formatAge(v: number): string {
  const epoch = normalizeEpoch(v);
  if (!epoch) return "belum ada update";
  const sec = Math.max(0, Math.floor((Date.now() - epoch) / 1000));
  if (sec < 60) return `${sec}s lalu`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m lalu`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h lalu`;
  return `${Math.floor(hour / 24)}d lalu`;
}

function escapeHtml(v: string): string {
  return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function closeIconSvg(): string {
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
}

async function itsFetchRtdbJson<T>(path: string): Promise<T | null> {
  const cleanPath = path.replace(/^\/+/, "").replace(/\.json$/i, "");
  const res = await fetch(`${FIREBASE_ROOT_URL}/${cleanPath}.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`RTDB HTTP ${res.status}`);
  const text = await res.text();
  if (!text || text === "null") return null;
  return JSON.parse(text) as T;
}

function itsStringField(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function itsNumberField(value: unknown): number | null {
  const n = finiteNumber(value);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function itsVehicleBreakdownFrom(raw: Record<string, unknown>): VehicleBreakdown {
  const objectDetection = objectRecord(raw.objectDetection);
  const vehicleBreakdown = objectRecord(raw.vehicleBreakdown);
  const read = (...keys: string[]) => {
    for (const key of keys) {
      const direct = itsNumberField(objectDetection[key]);
      if (direct !== null) return Math.max(0, Math.round(direct));
      const legacy = itsNumberField(vehicleBreakdown[key]);
      if (legacy !== null) return Math.max(0, Math.round(legacy));
    }
    return 0;
  };
  const car = read("car", "mobil");
  const motorcycle = read("motorcycle", "motor");
  const bus = read("bus");
  const truck = read("truck", "truk");
  const bicycle = read("bicycle", "sepeda", "bike");
  const explicitTotal = itsNumberField(objectDetection.total)
    ?? itsNumberField(vehicleBreakdown.total)
    ?? itsNumberField(raw.vehicleCount)
    ?? itsNumberField(raw.vehicles);
  const total = Math.max(0, Math.round(explicitTotal ?? (car + motorcycle + bus + truck + bicycle)));
  return { car, motorcycle, bus, truck, bicycle, total };
}

function itsDetectionListFrom(raw: Record<string, unknown>): Record<string, unknown>[] {
  const direct = Array.isArray(raw.detections) ? raw.detections : [];
  const objectDetection = objectRecord(raw.objectDetection);
  const nested = Array.isArray(objectDetection.detections) ? objectDetection.detections : [];
  return [...direct, ...nested].slice(0, 20).map((entry) => {
    const d = objectRecord(entry);
    const confidenceRaw = itsNumberField(d.confidence) ?? itsNumberField(d.score) ?? 0;
    const confidence = confidenceRaw > 1 ? confidenceRaw : confidenceRaw * 100;
    return {
      label: itsStringField(d.label) || itsStringField(d.className) || itsStringField(d.class) || "object",
      confidencePercent: Math.max(0, Math.min(100, Math.round(confidence))),
      isVehicle: Boolean(d.vehicle),
      box: {
        x: itsNumberField(d.x) ?? 0,
        y: itsNumberField(d.y) ?? 0,
        width: itsNumberField(d.width) ?? 0,
        height: itsNumberField(d.height) ?? 0,
      },
    };
  });
}

function itsSummarizeDevice(id: string, raw: Record<string, unknown>): Record<string, unknown> {
  const runtime = objectRecord(raw.runtime);
  const location = objectRecord(raw.location);
  const traffic = objectRecord(raw.traffic);
  const objectDetection = objectRecord(raw.objectDetection);
  const update = objectRecord(raw.update);
  const heartbeatAt = normalizeEpoch(itsNumberField(runtime.heartbeatAt) ?? itsNumberField(raw.heartbeatAt) ?? 0);
  const lastSeen = normalizeEpoch(itsNumberField(raw.lastSeen) ?? itsNumberField(raw.updatedAt) ?? 0);
  const detectorUpdatedAt = normalizeEpoch(itsNumberField(objectDetection.updatedAt) ?? itsNumberField(raw.detectorUpdatedAt) ?? 0);
  const cameraUpdatedAt = normalizeEpoch(itsNumberField(raw.cameraUpdatedAt) ?? detectorUpdatedAt);
  const heartbeatFresh = Boolean(heartbeatAt && Date.now() - heartbeatAt <= HARDWARE_HEARTBEAT_STALE_MS);
  const fallbackOnline = String(raw.status || "").toLowerCase() === "online" && lastSeen > 0 && Date.now() - lastSeen <= OFFLINE_AFTER_MS;
  const status = heartbeatFresh || fallbackOnline ? "online" : "offline";
  const trafficColor = itsStringField(raw.trafficColor)
    || itsStringField(traffic.current)
    || (traffic.red === true ? "red" : traffic.yellow === true ? "yellow" : traffic.green === true ? "green" : null);
  const trafficDurationSec = itsNumberField(raw.trafficDurationSec)
    ?? itsNumberField(raw.trafficDuration)
    ?? itsNumberField(traffic.durationSec)
    ?? itsNumberField(traffic.duration);
  const vehicles = itsVehicleBreakdownFrom(raw);
  const label = itsStringField(raw.label) || "Raspberry Pi Controller";
  const roadName = itsStringField(location.label) || itsStringField(raw.roadName) || itsStringField(raw.roadHint);
  return {
    id,
    label,
    status,
    roadName,
    lastSeenIso: lastSeen ? new Date(lastSeen).toISOString() : null,
    lastSeenText: heartbeatAt ? formatAge(heartbeatAt) : lastSeen ? formatAge(lastSeen) : itsStringField(raw.lastSeenText),
    trafficColor,
    trafficDurationSec,
    vehicleBreakdown: vehicles,
    totalVehicles: vehicles.total,
    objectDetection: {
      total: itsNumberField(objectDetection.total) ?? itsNumberField(raw.objectCount) ?? vehicles.total,
      modelUrl: itsStringField(objectDetection.modelUrl) || itsStringField(raw.detectorModel) || null,
      fps: itsNumberField(objectDetection.fps) ?? itsNumberField(raw.detectorFps),
      updatedAtIso: detectorUpdatedAt ? new Date(detectorUpdatedAt).toISOString() : null,
      detections: itsDetectionListFrom(raw),
    },
    cameraStatus: {
      localOk: typeof runtime.cameraLocalOk === "boolean" ? runtime.cameraLocalOk : null,
      publicOk: typeof runtime.cameraPublicOk === "boolean" ? runtime.cameraPublicOk : null,
      streamState: itsStringField(runtime.cameraStreamState) || itsStringField(raw.cameraStatus),
      note: itsStringField(runtime.cameraNote) || itsStringField(raw.cameraNote),
      updatedAtIso: cameraUpdatedAt ? new Date(cameraUpdatedAt).toISOString() : null,
    },
    update: Object.keys(update).length ? {
      status: itsStringField(update.status),
      stage: itsStringField(update.stage),
      message: itsStringField(update.message),
      updatedAtIso: normalizeEpoch(itsNumberField(update.updatedAt) ?? 0)
        ? new Date(normalizeEpoch(itsNumberField(update.updatedAt) ?? 0)).toISOString()
        : null,
    } : null,
    location: {
      label: roadName,
      lat: itsNumberField(location.lat) ?? itsNumberField(raw.lat),
      lng: itsNumberField(location.lng) ?? itsNumberField(location.lon) ?? itsNumberField(location.long) ?? itsNumberField(raw.lng),
    },
  };
}

async function itsGetDeviceStatusSummary(deviceId?: string): Promise<Record<string, unknown>> {
  const raw = await itsFetchRtdbJson<Record<string, any>>("devices");
  if (!raw) return { devices: [] };
  const entries = Object.entries(raw);
  const summarized = entries.map(([id, value]) => itsSummarizeDevice(id, value));
  if (deviceId) {
    const match = summarized.find((d) => d.id === deviceId);
    return match ? { device: match } : { error: `Device '${deviceId}' tidak ditemukan`, availableIds: summarized.map((d) => d.id) };
  }
  return { devices: summarized };
}

async function itsGetLatestAiDetections(): Promise<Record<string, unknown>> {
  const raw = await itsFetchRtdbJson<Record<string, any>>("snapshotHistory");
  if (!raw) return { snapshot: null, message: "Belum ada data snapshotHistory" };
  const image1UpdatedAt = Number(raw.image1UpdatedAt) || 0;
  const image2UpdatedAt = Number(raw.image2UpdatedAt) || 0;
  const activeAt = Math.max(image1UpdatedAt, image2UpdatedAt);
  return {
    capturedAt: activeAt ? new Date(activeAt).toISOString() : null,
    source: raw.source || null,
    hasImage1: Boolean(raw.image1),
    hasImage2: Boolean(raw.image2),
    note: "Gunakan get_its_maps_device_status untuk daftar deteksi objek terbaru per device (field detections).",
  };
}

async function itsListDeviceIds(): Promise<Record<string, unknown>> {
  const result = await itsGetDeviceStatusSummary();
  const devices = Array.isArray(result.devices) ? result.devices : [];
  return {
    devices: devices.map((device) => {
      const d = device as Record<string, unknown>;
      return { id: d.id, label: d.label, status: d.status };
    }),
  };
}

async function itsGetCameraHealth(deviceId = "raspberry-its"): Promise<Record<string, unknown>> {
  const raw = await itsFetchRtdbJson<Record<string, any>>("devices");
  const device = raw?.[deviceId];
  if (!device) return { error: `Device '${deviceId}' tidak ditemukan`, availableIds: raw ? Object.keys(raw) : [] };
  const runtime = objectRecord(device.runtime);
  return {
    deviceId,
    localOk: typeof runtime.cameraLocalOk === "boolean" ? runtime.cameraLocalOk : null,
    publicOk: typeof runtime.cameraPublicOk === "boolean" ? runtime.cameraPublicOk : null,
    streamState: itsStringField(runtime.cameraStreamState) || itsStringField(device.cameraStatus),
    note: itsStringField(runtime.cameraNote) || itsStringField(device.cameraNote),
    publicUrl: itsStringField(runtime.cameraPublicUrl) || itsStringField(device.cameraUrl),
    heartbeatAt: normalizeEpoch(itsNumberField(runtime.heartbeatAt) ?? 0) || null,
  };
}

function itsDataUrlParts(value: unknown): { base64Data: string; mimeType: string } | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text.startsWith("data:image/")) return null;
  const parts = text.split(",");
  if (parts.length < 2) return null;
  const mimeType = parts[0].match(/data:(.*);base64/i)?.[1] || "image/jpeg";
  return { base64Data: parts.slice(1).join(","), mimeType };
}

async function itsGetLatestSnapshotImage(): Promise<Record<string, unknown>> {
  const raw = await itsFetchRtdbJson<Record<string, any>>("devices");
  const firstId = Object.keys(raw || {})[0];
  const device = raw?.["raspberry-its"] || (firstId ? raw?.[firstId] : undefined);
  if (!device) return { error: "Device Raspberry belum tersedia di RTDB." };
  const dataset = objectRecord(device.cameraDataset);
  const candidates = [
    dataset.snapshot1Url,
    dataset.snapshot2Url,
    device.cameraThumbnailUrl,
  ];
  const dataUrl = candidates.map(itsDataUrlParts).find(Boolean);
  const summary = itsSummarizeDevice(device.id || "raspberry-its", device);
  if (!dataUrl) {
    const history = await itsFetchRtdbJson<Record<string, any>>("snapshotHistory").catch(() => null);
    const historyCandidates = [
      history?.image1,
      history?.image2,
      history?.snapshot1Url,
      history?.snapshot2Url,
      history?.nama1,
      history?.nama2,
      objectRecord(history?.cameraDataset).snapshot1Url,
      objectRecord(history?.cameraDataset).snapshot2Url,
    ].map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
    const historyImage = historyCandidates.find((item) => item.startsWith("data:image/") || /^https?:\/\//i.test(item) || item.startsWith("/"));
    const capturedAt = normalizeEpoch(
      itsNumberField(history?.image1UpdatedAt)
      ?? itsNumberField(history?.image2UpdatedAt)
      ?? itsNumberField(history?.updatedAt)
      ?? 0,
    );
    return {
      error: historyImage ? "" : "Snapshot base64 belum tersedia dari Raspberry.",
      imageUrl: candidates.find((item) => typeof item === "string" && item.trim()) || historyImage || null,
      capturedAt: capturedAt || null,
      objectCount: (summary.objectDetection as Record<string, unknown>)?.total ?? 0,
      device: summary,
    };
  }
  return {
    ...dataUrl,
    objectCount: (summary.objectDetection as Record<string, unknown>)?.total ?? 0,
    device: summary,
  };
}

async function itsGetRealtimeMapSummary(): Promise<Record<string, unknown>> {
  const status = await itsGetDeviceStatusSummary();
  const devices = Array.isArray(status.devices) ? status.devices : status.device ? [status.device] : [];
  return {
    generatedAt: new Date().toISOString(),
    deviceCount: devices.length,
    onlineCount: devices.filter((device) => (device as Record<string, unknown>).status === "online").length,
    devices,
  };
}

async function itsSearchTrafficLocation(location: string): Promise<Record<string, unknown>> {
  const query = location.trim().toLowerCase();
  const status = await itsGetDeviceStatusSummary();
  const devices = Array.isArray(status.devices) ? status.devices as Record<string, unknown>[] : [];
  const matches = devices.filter((device) => [
    device.id,
    device.label,
    device.roadName,
    (device.location as Record<string, unknown> | undefined)?.label,
  ].some((value) => String(value || "").toLowerCase().includes(query)));
  return {
    query: location,
    matches,
    count: matches.length,
    availableIds: devices.map((device) => device.id),
  };
}

function itsNormalizeResearchText(value: string): string {
  return value
    .replace(/\u0000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function itsValueText(value: unknown, fallback = "-"): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function itsTrafficColorText(value: unknown): string {
  const color = String(value || "").toLowerCase();
  if (color === "red" || color === "merah") return "Merah";
  if (color === "yellow" || color === "kuning") return "Kuning";
  if (color === "green" || color === "hijau") return "Hijau";
  return itsValueText(value, "belum tersedia");
}

function itsDevicesFromStatus(status: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(status.devices)
    ? status.devices as Record<string, unknown>[]
    : status.device ? [status.device as Record<string, unknown>] : [];
}

function itsPrimaryDevice(status: Record<string, unknown>): Record<string, unknown> | null {
  return itsDevicesFromStatus(status)[0] || null;
}

function itsVehicleMetricItems(vehicles: Record<string, unknown>): Array<{ key: string; label: string; value: unknown; color: string; icon: string }> {
  return [
    { key: "car", label: "Mobil", value: vehicles.car ?? 0, color: "#f97316", icon: "M5 14h14l-1.4-4.2A2 2 0 0 0 15.7 8H8.3a2 2 0 0 0-1.9 1.8L5 14Zm1 0v3m12-3v3M8 17h.01M16 17h.01" },
    { key: "motorcycle", label: "Motor", value: vehicles.motorcycle ?? 0, color: "#2563eb", icon: "M5 16a3 3 0 1 0 0 .01M19 16a3 3 0 1 0 0 .01M8 16h4l2-7h3l2 7M10 9h3" },
    { key: "bicycle", label: "Sepeda", value: vehicles.bicycle ?? 0, color: "#0d9488", icon: "M5 16a3 3 0 1 0 0 .01M19 16a3 3 0 1 0 0 .01M8 16l4-7 3 7M12 9h4M10 7h3" },
    { key: "bus", label: "Bus", value: vehicles.bus ?? 0, color: "#16a34a", icon: "M6 7h12v8H6V7Zm1 8v2m10-2v2M8 10h8M9 18h6" },
    { key: "truck", label: "Truk", value: vehicles.truck ?? 0, color: "#7c3aed", icon: "M4 9h10v7H4V9Zm10 3h3l3 3v1h-6v-4ZM7 17h.01M17 17h.01" },
    { key: "total", label: "Total", value: vehicles.total ?? 0, color: "#e11d48", icon: "M5 19V9m7 10V5m7 14v-7" },
  ];
}

function itsMiniIcon(path: string, color: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="${path}" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function itsVehicleMetricGridHtml(vehicles: Record<string, unknown>): string {
  return `<div class="its-ai-metric-grid">
    ${itsVehicleMetricItems(vehicles).map((item) => `
      <div class="its-ai-metric">
        ${itsMiniIcon(item.icon, item.color)}
        <span>${escapeHtml(item.label)}</span>
        <strong style="color:${item.color}">${escapeHtml(String(item.value ?? 0))}</strong>
      </div>`).join("")}
  </div>`;
}

function itsChartCardHtml(device: Record<string, unknown>): string {
  const vehicles = objectRecord(device.vehicleBreakdown);
  const total = Number(vehicles.total || device.totalVehicles || 0);
  const currentColor = String(device.trafficColor || "").toLowerCase();
  const currentDuration = Number(device.trafficDurationSec || 0);
  const series = [
    { key: "red", label: "Merah", color: "#ef4444", value: currentColor === "red" || currentColor === "merah" ? currentDuration : 0 },
    { key: "yellow", label: "Kuning", color: "#eab308", value: currentColor === "yellow" || currentColor === "kuning" ? currentDuration : 0 },
    { key: "green", label: "Hijau", color: "#22c55e", value: currentColor === "green" || currentColor === "hijau" ? currentDuration : 0 },
  ];
  const maxY = Math.max(10, currentDuration, total);
  const plot = { left: 44, top: 24, right: 226, bottom: 110 };
  const pointY = (value: number) => plot.bottom - Math.min(plot.bottom - plot.top, (value / maxY) * (plot.bottom - plot.top));
  const pointX = (index: number) => 84 + index * 42;
  const totalY = pointY(total);
  const ticks = [maxY, Math.round(maxY / 2), 0];
  return `<section class="its-ai-card its-ai-chart-card">
    <div class="its-ai-card-head">
      <span>${itsMiniIcon("M4 19V7m6 12V5m6 14v-9m4 9H4", "#2563eb")} Grafik realtime</span>
      <strong>${escapeHtml(String(total))} kendaraan</strong>
    </div>
    <svg class="its-ai-chart" viewBox="0 0 260 154" role="img" aria-label="Grafik realtime RTDB: sumbu X adalah jenis data saat update terakhir, sumbu Y adalah durasi lampu dan jumlah kendaraan">
      <path d="M${plot.left} ${plot.top}v${plot.bottom - plot.top}h${plot.right - plot.left}" stroke="#cbd5e1" stroke-width="1.5"/>
      ${ticks.map((tick) => {
    const y = pointY(tick);
    return `<path d="M${plot.left} ${y}H${plot.right}" stroke="#1e293b" stroke-width="0.8" opacity="0.5"/><text x="${plot.left - 6}" y="${y + 3}" text-anchor="end">${tick}</text>`;
  }).join("")}
      ${series.map((item, index) => {
    const x = pointX(index);
    const y = pointY(item.value);
    return `<path d="M${x} ${plot.bottom}V${y}" stroke="${item.color}" stroke-width="2.2" stroke-linecap="round" opacity="0.86"/>
      <circle cx="${x}" cy="${y}" r="${item.value ? 6 : 4}" fill="${item.color}" stroke="#fff" stroke-width="2"><title>${item.label} ${item.value}s</title></circle>
      <text x="${x}" y="124" text-anchor="middle">${item.label}</text>`;
  }).join("")}
      <rect x="204" y="${Math.max(plot.top, totalY)}" width="18" height="${Math.max(4, plot.bottom - Math.max(plot.top, totalY))}" rx="4" fill="#94a3b8" opacity="0.9"><title>Jumlah kendaraan ${total}</title></rect>
      <circle cx="213" cy="${totalY}" r="4.5" fill="#94a3b8" stroke="#fff" stroke-width="2"/>
      <text x="213" y="124" text-anchor="middle">Kend.</text>
      <text x="${plot.left}" y="146">X: status lampu + kendaraan</text>
      <text x="${plot.left}" y="13">Y: detik / jumlah</text>
    </svg>
    <div class="its-ai-chart-legend">
      ${series.map((item) => `<span><i style="background:${item.color}"></i>${item.label} ${item.value}s</span>`).join("")}
      <span><i style="background:#94a3b8"></i>Kendaraan ${escapeHtml(String(total))}</span>
    </div>
    <p class="its-ai-card-note">Grafik mengikuti nilai realtime terakhir yang tersedia di RTDB.</p>
  </section>`;
}

function itsSnapshotImageUrl(snapshot: Record<string, unknown>): string {
  const base64 = itsStringField(snapshot.base64Data);
  const mime = itsStringField(snapshot.mimeType) || "image/jpeg";
  if (base64) return `data:${mime};base64,${base64}`;
  return itsStringField(snapshot.imageUrl) || "/bwits.png";
}

function itsDetectionToPercentStyle(detection: Record<string, unknown>, frameWidth = 0, frameHeight = 0): string {
  const box = objectRecord(detection.box);
  const rawX = itsNumberField(box.x) ?? itsNumberField(detection.x) ?? 0;
  const rawY = itsNumberField(box.y) ?? itsNumberField(detection.y) ?? 0;
  const rawWidth = itsNumberField(box.width) ?? itsNumberField(detection.width) ?? 0;
  const rawHeight = itsNumberField(box.height) ?? itsNumberField(detection.height) ?? 0;
  const toPercent = (value: number, base: number) => {
    if (base > 1 && value > 1) return Math.max(0, Math.min(100, (value / base) * 100));
    if (value <= 1) return Math.max(0, Math.min(100, value * 100));
    return Math.max(0, Math.min(100, value));
  };
  const x = toPercent(rawX, frameWidth);
  const y = toPercent(rawY, frameHeight);
  const width = Math.max(6, Math.min(96, toPercent(rawWidth, frameWidth) || 26));
  const height = Math.max(6, Math.min(92, toPercent(rawHeight, frameHeight) || 24));
  return `left:${x}%;top:${y}%;width:${width}%;height:${height}%;`;
}

function itsDetectionLabelText(label: unknown): string {
  const text = String(label || "objek").trim().toLowerCase();
  const map: Record<string, string> = {
    car: "Mobil",
    motorcycle: "Motor",
    bicycle: "Sepeda",
    bus: "Bus",
    truck: "Truk",
    person: "Orang",
    "traffic light": "Lampu lalu lintas",
  };
  return map[text] || text.replace(/\b\w/g, (c) => c.toUpperCase());
}

function itsBrowserDetectionToRecord(detection: BrowserRfDetrDetection): Record<string, unknown> {
  return {
    label: detection.label,
    confidencePercent: Math.round(detection.confidence * 100),
    isVehicle: Boolean(detection.vehicle),
    x: detection.x,
    y: detection.y,
    width: detection.width,
    height: detection.height,
  };
}

function itsDetectionBboxHtml(detections: Record<string, unknown>[], frameWidth = 0, frameHeight = 0): string {
  return detections.slice(0, 8).map((detection) => {
    const label = itsDetectionLabelText(detection.label);
    const confidence = Math.round(Number(detection.confidencePercent || 0));
    return `<span class="its-ai-bbox" style="${itsDetectionToPercentStyle(detection, frameWidth, frameHeight)}"><b>${escapeHtml(label)} ${confidence}%</b></span>`;
  }).join("");
}

function itsLoadImageForAi(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.crossOrigin = src.startsWith("data:") || src.startsWith("/") ? "" : "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Snapshot tidak bisa dibaca oleh RF-DETR browser."));
    image.src = src;
  });
}

function itsTrafficLightSignalDetection(image: HTMLImageElement, colorValue: unknown): BrowserRfDetrDetection[] {
  const color = String(colorValue || "").toLowerCase();
  const expected = color.includes("merah") || color.includes("red")
    ? "red"
    : color.includes("kuning") || color.includes("yellow")
      ? "yellow"
      : color.includes("hijau") || color.includes("green")
        ? "green"
        : "";
  if (!image.naturalWidth || !image.naturalHeight) return [];
  const maxEdge = 360;
  const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(image, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const buckets: Record<string, { minX: number; minY: number; maxX: number; maxY: number; score: number; area: number; sx: number; sy: number }> = {
    red: { minX: width, minY: height, maxX: 0, maxY: 0, score: 0, area: 0, sx: 0, sy: 0 },
    yellow: { minX: width, minY: height, maxX: 0, maxY: 0, score: 0, area: 0, sx: 0, sy: 0 },
    green: { minX: width, minY: height, maxX: 0, maxY: 0, score: 0, area: 0, sx: 0, sy: 0 },
  };
  const addHit = (key: "red" | "yellow" | "green", x: number, y: number, bright: number) => {
    const bucket = buckets[key];
    bucket.minX = Math.min(bucket.minX, x);
    bucket.minY = Math.min(bucket.minY, y);
    bucket.maxX = Math.max(bucket.maxX, x);
    bucket.maxY = Math.max(bucket.maxY, y);
    const weight = bright / 255;
    bucket.score += weight;
    bucket.area += 1;
    bucket.sx += x * weight;
    bucket.sy += y * weight;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const r = pixels[idx];
      const g = pixels[idx + 1];
      const b = pixels[idx + 2];
      const bright = Math.max(r, g, b);
      if (bright < 90) continue;
      if (r > 130 && r > g * 1.22 && r > b * 1.18) addHit("red", x, y, bright);
      if (r > 120 && g > 92 && r > b * 1.25 && g > b * 1.2) addHit("yellow", x, y, bright);
      if (g > 120 && g > r * 1.14 && g > b * 1.12) addHit("green", x, y, bright);
    }
  }
  const selectedKey = expected && buckets[expected]?.score >= 5
    ? expected
    : Object.entries(buckets).sort((a, b) => b[1].score - a[1].score)[0]?.[0] || "";
  const selected = selectedKey ? buckets[selectedKey] : null;
  if (!selected || selected.score < 7 || selected.area < 12) return [];
  const rawArea = Math.max(0, (selected.maxX - selected.minX + 1) * (selected.maxY - selected.minY + 1));
  let sx = selected.minX;
  let sy = selected.minY;
  let sw = selected.maxX - selected.minX + 1;
  let sh = selected.maxY - selected.minY + 1;
  if (rawArea > width * height * 0.18) {
    const cx = selected.sx / Math.max(1, selected.score);
    const cy = selected.sy / Math.max(1, selected.score);
    const size = Math.max(34, Math.min(width, height) * 0.22);
    sx = Math.max(0, Math.round(cx - size / 2));
    sy = Math.max(0, Math.round(cy - size / 2));
    sw = Math.min(width - sx, Math.round(size));
    sh = Math.min(height - sy, Math.round(size));
  } else {
    const pad = Math.max(8, Math.round(Math.sqrt(rawArea) * 1.2));
    sx = Math.max(0, selected.minX - pad);
    sy = Math.max(0, selected.minY - pad);
    sw = Math.min(width - sx, selected.maxX - selected.minX + 1 + pad * 2);
    sh = Math.min(height - sy, selected.maxY - selected.minY + 1 + pad * 2);
  }
  const confidence = Math.min(0.95, 0.74 + Math.min(0.2, selected.score / Math.max(120, width * height * 0.01)));
  return [{
    label: "traffic light",
    confidence,
    vehicle: false,
    x: sx / scale,
    y: sy / scale,
    width: sw / scale,
    height: sh / scale,
  }];
}

function itsFormatDetectionConclusion(result: BrowserRfDetrResult, visualSource = "rfdetr", trafficColor?: unknown): string {
  if (!result.detections.length) {
    return `RF-DETR selesai (${result.fps.toFixed(1)} FPS), tetapi belum ada objek visual yang cukup yakin pada snapshot ini.`;
  }
  const top = result.detections.slice().sort((a, b) => b.confidence - a.confidence)[0];
  if (visualSource === "traffic-signal") {
    return `RF-DETR selesai (${result.fps.toFixed(1)} FPS). Validasi visual + RTDB mengonfirmasi ${itsDetectionLabelText(top.label)} ${itsTrafficColorText(trafficColor)} dengan akurasi ${Math.round(top.confidence * 100)}%.`;
  }
  return `RF-DETR mendeteksi ${result.detections.length} objek. Tertinggi: ${itsDetectionLabelText(top.label)} dengan akurasi ${Math.round(top.confidence * 100)}%.`;
}

function itsSnapshotCardHtml(device: Record<string, unknown>, snapshot: Record<string, unknown>): string {
  const objectDetection = objectRecord(device.objectDetection);
  const vehicles = objectRecord(device.vehicleBreakdown);
  const detailId = `chat-detection-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `<section class="its-ai-card">
    <div class="its-ai-card-head">
      <span>${itsMiniIcon("M4 7h3l2-2h6l2 2h3v12H4V7Zm8 9a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "#0d9488")} Snapshot AI</span>
      <strong data-ai-rfdetr-count>${escapeHtml(String(objectDetection.total ?? snapshot.objectCount ?? 0))} OBJ</strong>
    </div>
    <div class="its-ai-snapshot" data-ai-rfdetr-card data-ai-detail-id="${escapeHtml(detailId)}" data-device-id="${escapeHtml(String(device.id || "raspberry-its"))}" data-system-color="${escapeHtml(String(device.trafficColor || ""))}" data-system-duration="${escapeHtml(String(device.trafficDurationSec || ""))}">
      <img src="${escapeHtml(itsSnapshotImageUrl(snapshot))}" alt="Snapshot kamera Raspberry Pi ITS Maps" crossorigin="anonymous">
      <canvas data-ai-chat-rfdetr-canvas data-detector-fit="contain" aria-hidden="true"></canvas>
    </div>
    <p class="its-ai-card-note" data-ai-rfdetr-status><strong>Menunggu RF-DETR</strong> Snapshot masuk. AI akan memindai frame, menjalankan object detection, lalu menampilkan hasil akhir.</p>
    ${itsVehicleMetricGridHtml(vehicles)}
    <button type="button" class="its-ai-detail-btn" data-ai-detection-detail="${escapeHtml(detailId)}" disabled>Lihat hasil deteksi lengkap</button>
  </section>`;
}

async function itsHydrateSnapshotDetectionCards(root: ParentNode): Promise<void> {
  const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-ai-rfdetr-card]"));
  for (const card of cards) {
    if (card.dataset.aiRfDetrHydrated === "true") continue;
    card.dataset.aiRfDetrHydrated = "true";
    const img = card.querySelector<HTMLImageElement>("img");
    const canvas = card.querySelector<HTMLCanvasElement>("[data-ai-chat-rfdetr-canvas]");
    const wrapper = card.closest<HTMLElement>(".its-ai-card");
    const status = wrapper?.querySelector<HTMLElement>("[data-ai-rfdetr-status]");
    const count = wrapper?.querySelector<HTMLElement>("[data-ai-rfdetr-count]");
    const detailButton = wrapper?.querySelector<HTMLButtonElement>("[data-ai-detection-detail]");
    if (!img || !canvas || !wrapper || !status || !count || !detailButton) continue;
    let animationFrame = 0;
    let running = true;
    let frameWidth = 0;
    let frameHeight = 0;
    let visibleDetections: BrowserRfDetrDetection[] = [];
    const draw = () => {
      const width = frameWidth || img.naturalWidth;
      const height = frameHeight || img.naturalHeight;
      if (width && height) {
        drawRfDetrDetections(canvas, visibleDetections, width, height, {
          hud: false,
          scanActive: running,
          scannerFocus: visibleDetections[0] || null,
        });
      }
      if (running) animationFrame = requestAnimationFrame(draw);
    };
    status.innerHTML = "<strong>Memanggil RF-DETR</strong> Model browser sedang dimuat. FPS dan jumlah objek akan berubah saat inference selesai.";
    wrapper.classList.remove("rfdetr-complete");
    wrapper.classList.add("rfdetr-running");
    try {
      const source = await itsLoadImageForAi(img.currentSrc || img.src);
      frameWidth = source.naturalWidth;
      frameHeight = source.naturalHeight;
      animationFrame = requestAnimationFrame(draw);
      status.innerHTML = "<strong>RF-DETR aktif</strong> Mohon tunggu, AI sedang memindai snapshot dan mencari bbox objek.";
      const result = await runBrowserRfDetr(source, {
        captureMaxEdge: 720,
        confidenceThreshold: 0.05,
        minLabelConfidenceScale: 0.42,
        includeThumbnails: false,
        worker: true,
        workerFallbackToMainThread: true,
      });
      const confidentDetections = result.detections.filter((detection) => detection.confidence >= 0.35);
      const signalDetections = confidentDetections.length
        ? []
        : itsTrafficLightSignalDetection(source, card.dataset.systemColor);
      const finalDetections = confidentDetections.length ? confidentDetections : signalDetections;
      const visualSource = confidentDetections.length ? "rfdetr" : signalDetections.length ? "traffic-signal" : "none";
      const finalResult: BrowserRfDetrResult = {
        ...result,
        note: visualSource === "traffic-signal"
          ? "RF-DETR selesai; deteksi confidence rendah diabaikan, lalu lampu lalu lintas divalidasi oleh analisis warna snapshot dan status RTDB."
          : result.note,
        objectCount: finalDetections.length,
        detections: finalDetections,
      };
      frameWidth = result.frameWidth || source.naturalWidth;
      frameHeight = result.frameHeight || source.naturalHeight;
      visibleDetections = finalDetections;
      count.textContent = `${finalDetections.length} OBJ`;
      status.innerHTML = `<strong>Hasil akhir</strong> ${escapeHtml(itsFormatDetectionConclusion(finalResult, visualSource, card.dataset.systemColor))}`;
      const detailId = detailButton.dataset.aiDetectionDetail || card.dataset.aiDetailId || `chat-detection-${Date.now()}`;
      itsChatDetectionDetails.set(detailId, {
        imageUrl: img.currentSrc || img.src,
        capturedAt: Date.now(),
        modelUrl: finalResult.modelUrl,
        note: finalResult.note,
        fps: result.fps,
        frameWidth,
        frameHeight,
        detections: finalDetections,
        vehicleBreakdown: finalResult.vehicleBreakdown,
      });
      detailButton.disabled = false;
      detailButton.textContent = finalDetections.length ? "Lihat hasil deteksi lengkap" : "Lihat rincian RF-DETR";
      const nextMetricGrid = document.createRange().createContextualFragment(itsVehicleMetricGridHtml(finalResult.vehicleBreakdown)).firstElementChild;
      if (nextMetricGrid) wrapper.querySelector<HTMLElement>(".its-ai-metric-grid")?.replaceWith(nextMetricGrid);
      window.setTimeout(() => {
        running = false;
        if (animationFrame) cancelAnimationFrame(animationFrame);
        drawRfDetrDetections(canvas, finalDetections, frameWidth, frameHeight, {
          hud: false,
          scanActive: false,
          scannerFocus: finalDetections[0] || null,
        });
        wrapper.classList.add("rfdetr-complete");
      }, finalDetections.length ? 1800 : 900);
    } catch (error) {
      status.innerHTML = `<strong>RF-DETR belum selesai</strong> ${escapeHtml(error instanceof Error ? error.message : String(error))}`;
      wrapper.classList.add("rfdetr-complete");
    } finally {
      window.setTimeout(() => {
        running = false;
        if (animationFrame) cancelAnimationFrame(animationFrame);
        wrapper.classList.remove("rfdetr-running");
      }, 1900);
    }
  }
}

function itsLatLng(device: Record<string, unknown>): { lat: number; lng: number } | null {
  const location = objectRecord(device.location);
  const lat = itsNumberField(location.lat);
  const lng = itsNumberField(location.lng);
  if (lat === null || lng === null) return null;
  return { lat, lng };
}

function itsLonToTile(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** zoom);
}

function itsLatToTile(lat: number, zoom: number): number {
  const rad = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * 2 ** zoom);
}

function itsChatDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRadLocal = (value: number) => value * Math.PI / 180;
  const radius = 6371000;
  const dLat = toRadLocal(lat2 - lat1);
  const dLon = toRadLocal(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadLocal(lat1)) * Math.cos(toRadLocal(lat2)) * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function itsChatDistanceText(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

function itsTrafficLightMarkerHtml(colorValue: unknown): string {
  const color = String(colorValue || "").toLowerCase();
  const red = color === "red" || color === "merah";
  const yellow = color === "yellow" || color === "kuning";
  const green = color === "green" || color === "hijau";
  return `<span class="its-ai-traffic-marker" aria-label="Marker lampu lalu lintas ${escapeHtml(itsTrafficColorText(colorValue))}">
    <i class="${red ? "active red" : ""}"></i>
    <i class="${yellow ? "active yellow" : ""}"></i>
    <i class="${green ? "active green" : ""}"></i>
  </span>`;
}

function itsMapTiles(point: { lat: number; lng: number }, z = 17): string[] {
  const x = itsLonToTile(point.lng, z);
  const y = itsLatToTile(point.lat, z);
  return [
    `https://a.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`,
    `https://b.basemaps.cartocdn.com/light_all/${z}/${x + 1}/${y}.png`,
    `https://c.basemaps.cartocdn.com/light_all/${z}/${x}/${y + 1}.png`,
    `https://d.basemaps.cartocdn.com/light_all/${z}/${x + 1}/${y + 1}.png`,
  ];
}

function itsMapMosaicHtml(point: { lat: number; lng: number }, markerHtml: string, label: string): string {
  return `<div class="its-ai-map-mosaic" aria-label="${escapeHtml(label)}">
    ${itsMapTiles(point).map((tile) => `<img src="${tile}" alt="">`).join("")}
    ${markerHtml}
  </div>`;
}

function itsUserMarkerHtml(): string {
  return `<span class="its-ai-map-marker its-ai-user-marker" aria-label="Marker lokasi user">Anda</span>`;
}

function itsSystemPoint(device: Record<string, unknown>): { lat: number; lng: number } {
  return itsLatLng(device)
    || itsRuntimeBridge().getSystemLocation?.()
    || (() => {
      const [lat, lng] = initialMapCenter() as [number, number];
      return { lat, lng };
    })();
}

function itsMapCardHtml(device: Record<string, unknown>): string {
  const point = itsSystemPoint(device);
  const gmaps = `https://www.google.com/maps/search/?api=1&query=${point.lat},${point.lng}`;
  const bing = `https://www.bing.com/maps?cp=${point.lat}~${point.lng}&lvl=18`;
  const its = `https://itstelkom.web.app/?lat=${point.lat}&lng=${point.lng}&z=18&mode=street`;
  return `<section class="its-ai-card">
    <div class="its-ai-card-head">
      <span>${itsMiniIcon("M12 21s7-5.4 7-11a7 7 0 0 0-14 0c0 5.6 7 11 7 11Zm0-8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "#2563eb")} Peta lokasi</span>
      <strong>${escapeHtml(itsTrafficColorText(device.trafficColor))}</strong>
    </div>
    ${itsMapMosaicHtml(point, itsTrafficLightMarkerHtml(device.trafficColor), "Peta titik Raspberry ITS Maps")}
    <p class="its-ai-card-note">${escapeHtml(String(device.roadName || objectRecord(device.location).label || "Gang Gotong Royong"))}: ${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}.</p>
    <div class="its-ai-actions">
      <a href="${gmaps}" target="_blank" rel="noopener">Google Maps</a>
      <a href="${bing}" target="_blank" rel="noopener">Bing Maps</a>
      <a href="${its}" target="_blank" rel="noopener">ITS Maps</a>
    </div>
  </section>`;
}

function itsUserLocationCardHtml(device: Record<string, unknown>): string {
  const point = itsSystemPoint(device);
  return `<section class="its-ai-card" data-ai-user-location-card data-system-lat="${point.lat}" data-system-lng="${point.lng}" data-system-color="${escapeHtml(String(device.trafficColor || ""))}">
    <div class="its-ai-card-head">
      <span>${itsMiniIcon("M12 21s7-5.4 7-11a7 7 0 0 0-14 0c0 5.6 7 11 7 11Zm0-8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "#0d9488")} Lokasi saya</span>
      <strong>Izin browser</strong>
    </div>
    <p class="its-ai-card-note" data-ai-user-location-result>Tekan tombol ini supaya browser meminta izin lokasi. Saya hanya membandingkan posisi Anda dengan titik Raspberry ITS Maps di halaman ini.</p>
    <div class="its-ai-actions">
      <button type="button" data-ai-user-location>Gunakan lokasi saya</button>
    </div>
  </section>`;
}

function itsPoiCardHtml(device: Record<string, unknown>): string {
  const origin = itsRuntimeBridge().getUserLocation?.() || itsSystemPoint(device);
  const runtimePois = itsRuntimeBridge().getPoiSnapshot?.() || [];
  const pois = runtimePois
    .map((poi) => ({
      poi,
      distance: itsChatDistanceMeters(origin.lat, origin.lng, poi.lat, poi.lng),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5);
  return `<section class="its-ai-card its-ai-poi-card">
    <div class="its-ai-card-head">
      <span>${itsMiniIcon("M4 6h16M4 12h16M4 18h10", "#0d9488")} POI sekitar</span>
      <strong>${pois.length || 0}</strong>
    </div>
    ${pois.length ? `<div class="its-ai-poi-list">
      ${pois.map(({ poi, distance }) => `<button type="button" data-ai-poi-id="${escapeHtml(poi.id)}" data-ai-poi-lat="${poi.lat}" data-ai-poi-lng="${poi.lng}">
        <span>${escapeHtml(poi.icon || "*")}</span>
        <b>${escapeHtml(poi.title)}</b>
        <em>${escapeHtml(poi.kind)} - ${escapeHtml(itsChatDistanceText(distance))}</em>
      </button>`).join("")}
    </div>` : `<p class="its-ai-card-note">POI belum termuat di viewport ini. Buka peta atau geser area peta supaya Overpass/POI lokal dimuat, lalu tanya lagi.</p>`}
  </section>`;
}


function itsDelay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function itsSetChatStatus(text = ""): void {
  const form = document.querySelector<HTMLFormElement>("#its-ai-chat-modal [data-ai-chat-form]");
  const status = form?.querySelector<HTMLElement>("[data-ai-chat-status]");
  if (!form || !status) return;
  form.classList.toggle("agent-thinking", Boolean(text));
  status.hidden = !text;
  const copy = status.querySelector<HTMLElement>("span");
  if (copy) copy.textContent = text;
}

function itsSetAgentWorking(isWorking: boolean): void {
  document.getElementById("its-ai-chat-modal")?.classList.toggle("agent-working", isWorking);
}

function itsEnsureAgentCursor(): HTMLElement {
  const existing = document.getElementById("its-agent-cursor");
  if (existing) return existing;
  const cursor = document.createElement("div");
  cursor.id = "its-agent-cursor";
  cursor.setAttribute("aria-hidden", "true");
  cursor.innerHTML = `<svg viewBox="0 0 18 24"><path d="M1 1v18l5-4 3.3 7 3-1.4-3.2-6.7H16L1 1Z"/></svg>`;
  cursor.style.left = `${itsLastRealPointer.x}px`;
  cursor.style.top = `${itsLastRealPointer.y}px`;
  document.body.appendChild(cursor);
  return cursor;
}

function itsVisibleAgentTarget(selector: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).find((element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 2 && rect.height > 2 && style.visibility !== "hidden" && style.display !== "none";
  }) || null;
}

function itsAnimateAgentCursor(
  cursor: HTMLElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    cursor.style.left = `${to.x}px`;
    cursor.style.top = `${to.y}px`;
    return itsDelay(30);
  }
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const duration = Math.max(320, Math.min(760, 300 + distance * 0.24));
  const direction = to.x >= from.x ? 1 : -1;
  const arc = Math.min(72, Math.max(20, distance * 0.12));
  const controlA = {
    x: from.x + (to.x - from.x) * 0.28 + direction * arc,
    y: from.y + (to.y - from.y) * 0.18 - arc,
  };
  const controlB = {
    x: from.x + (to.x - from.x) * 0.72 - direction * arc * 0.35,
    y: from.y + (to.y - from.y) * 0.82 + arc * 0.2,
  };
  const startedAt = performance.now();
  cursor.style.transition = "opacity 100ms ease, transform 100ms ease";
  return new Promise((resolve) => {
    const frame = (now: number) => {
      const linear = Math.min(1, (now - startedAt) / duration);
      const t = 1 - Math.pow(1 - linear, 3);
      const inverse = 1 - t;
      const x = inverse ** 3 * from.x
        + 3 * inverse ** 2 * t * controlA.x
        + 3 * inverse * t ** 2 * controlB.x
        + t ** 3 * to.x;
      const y = inverse ** 3 * from.y
        + 3 * inverse ** 2 * t * controlA.y
        + 3 * inverse * t ** 2 * controlB.y
        + t ** 3 * to.y;
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
      if (linear < 1) window.requestAnimationFrame(frame);
      else resolve();
    };
    window.requestAnimationFrame(frame);
  });
}

async function itsAgentClick(selector: string, fallback: () => void): Promise<void> {
  const target = itsVisibleAgentTarget(selector);
  const cursor = itsEnsureAgentCursor();
  const start = { ...itsLastRealPointer };
  const rect = target?.getBoundingClientRect();
  const destination = rect
    ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    : { x: Math.max(28, window.innerWidth - 52), y: Math.max(64, window.innerHeight - 54) };
  document.body.classList.add("its-agent-cursor-active");
  cursor.classList.add("visible");
  await itsDelay(20);
  await itsAnimateAgentCursor(cursor, start, destination);
  cursor.classList.add("clicking");
  itsAgentPanelTransitionActive = true;
  try {
    if (target) target.click();
    else fallback();
  } finally {
    await itsDelay(80);
    itsAgentPanelTransitionActive = false;
  }
  cursor.classList.remove("clicking");
  await itsAnimateAgentCursor(cursor, destination, start);
  cursor.remove();
  document.body.classList.remove("its-agent-cursor-active");
}

async function itsWaitForAgentTarget(selector: string, timeoutMs = 1800): Promise<HTMLElement | null> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) return element;
    await itsDelay(40);
  }
  return null;
}

function itsAgentTargetSheet(target: HTMLElement): HTMLElement {
  if (target.id === "m-ai-history-sheet") return target;
  return target.querySelector<HTMLElement>(".map-license-sheet, .m-device-sheet, .m-poi-sheet, .m-ai-history-detail-sheet") || target;
}

function itsReleaseAgentPanelStack(): void {
  const cleanup = itsAgentStackCleanup;
  itsAgentStackCleanup = null;
  cleanup?.();
}

function itsSetupStackedSwipeDismiss(chatModal: HTMLElement, bottomSheet: HTMLElement, target: HTMLElement, closeBottom: () => void): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  const targetSheet = itsAgentTargetSheet(target);
  let startY = 0;
  let pull = 0;
  let pointerId = -1;
  let dragging = false;
  let wheelTimer = 0;
  let baseTargetHeight = 0;

  const begin = () => {
    baseTargetHeight = target.getBoundingClientRect().height;
    bottomSheet.style.transition = "none";
    target.style.transition = "none";
    targetSheet.style.transition = "none";
  };
  const apply = (nextPull: number) => {
    pull = Math.max(0, Math.min(bottomSheet.getBoundingClientRect().height, nextPull));
    const progress = Math.min(1, pull / Math.max(120, bottomSheet.getBoundingClientRect().height * 0.72));
    bottomSheet.style.transform = `translateY(${pull}px)`;
    bottomSheet.style.opacity = String(Math.max(0.18, 1 - progress * 0.82));
    if (baseTargetHeight > 0) target.style.height = `${Math.min(window.innerHeight, baseTargetHeight + pull)}px`;
  };
  const restore = () => {
    bottomSheet.style.transition = "transform 240ms cubic-bezier(0.32, 0.72, 0, 1), opacity 180ms ease";
    target.style.transition = "height 240ms cubic-bezier(0.32, 0.72, 0, 1)";
    targetSheet.style.transition = "height 240ms cubic-bezier(0.32, 0.72, 0, 1), transform 240ms cubic-bezier(0.32, 0.72, 0, 1)";
    bottomSheet.style.transform = "";
    bottomSheet.style.opacity = "";
    target.style.height = "";
    window.setTimeout(() => {
      bottomSheet.style.transition = "";
      target.style.transition = "";
      targetSheet.style.transition = "";
    }, 250);
  };
  const dismiss = () => {
    const height = bottomSheet.getBoundingClientRect().height;
    bottomSheet.style.transition = "transform 260ms cubic-bezier(0.32, 0.72, 0, 1), opacity 200ms ease";
    target.style.transition = "height 260ms cubic-bezier(0.32, 0.72, 0, 1)";
    bottomSheet.style.transform = `translateY(${height + 24}px)`;
    bottomSheet.style.opacity = "0";
    target.style.height = `${window.innerHeight}px`;
    window.setTimeout(closeBottom, 250);
  };

  bottomSheet.addEventListener("pointerdown", (event) => {
    if (!chatModal.classList.contains("agent-target-stack-open")) return;
    const handle = (event.target as HTMLElement | null)?.closest("[data-swipe-handle], .its-ai-chat-head");
    if (!handle) return;
    event.stopImmediatePropagation();
    dragging = true;
    pointerId = event.pointerId;
    startY = event.clientY;
    pull = 0;
    begin();
    try { bottomSheet.setPointerCapture(event.pointerId); } catch { /* Pointer capture is optional. */ }
  }, { capture: true, signal });
  bottomSheet.addEventListener("pointermove", (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    apply(event.clientY - startY);
  }, { capture: true, signal });
  const finishPointer = (event: PointerEvent) => {
    if (!dragging || event.pointerId !== pointerId) return;
    event.stopImmediatePropagation();
    dragging = false;
    pointerId = -1;
    if (pull > 82) dismiss();
    else restore();
  };
  bottomSheet.addEventListener("pointerup", finishPointer, { capture: true, signal });
  bottomSheet.addEventListener("pointercancel", finishPointer, { capture: true, signal });
  bottomSheet.addEventListener("wheel", (event) => {
    if (!chatModal.classList.contains("agent-target-stack-open") || event.deltaY <= 8) return;
    const scrollTarget = promptNearestScrollableTarget(event.target as HTMLElement | null, bottomSheet);
    const atBottom = scrollTarget.scrollTop + scrollTarget.clientHeight >= scrollTarget.scrollHeight - 2;
    if (!atBottom) return;
    event.preventDefault();
    if (!pull) begin();
    apply(pull + event.deltaY * 0.62);
    window.clearTimeout(wheelTimer);
    wheelTimer = window.setTimeout(() => {
      if (pull > 82) dismiss();
      else restore();
      pull = 0;
    }, 120);
  }, { capture: true, passive: false, signal });
  return () => {
    window.clearTimeout(wheelTimer);
    controller.abort();
    bottomSheet.style.transform = "";
    bottomSheet.style.opacity = "";
    target.style.height = "";
    target.style.transition = "";
    targetSheet.style.transition = "";
  };
}

function itsDockAgentPanelStack(target: HTMLElement): void {
  itsReleaseAgentPanelStack();
  const chatModal = document.getElementById("its-ai-chat-modal");
  const chatSheet = chatModal?.querySelector<HTMLElement>(".its-ai-chat-sheet");
  if (!chatModal || !chatSheet || !target.isConnected) return;
  const width = Math.max(320, Math.round(itsAgentTargetSheet(target).getBoundingClientRect().width || chatSheet.getBoundingClientRect().width));
  const viewportHeight = Math.max(480, document.documentElement.clientHeight || window.innerHeight);
  const chatHeight = promptUsesDesktopSidePanel()
    ? Math.min(360, Math.max(260, Math.round(viewportHeight * 0.38)))
    : Math.min(410, Math.max(250, Math.round(viewportHeight * 0.43)));
  document.documentElement.style.setProperty("--its-agent-stack-width", `${width}px`);
  document.documentElement.style.setProperty("--its-agent-chat-stack-height", `${chatHeight}px`);
  document.documentElement.style.setProperty("--its-agent-chat-stack-height-mobile", `${chatHeight}px`);
  target.classList.add("its-ai-agent-target-stacked");
  chatModal.classList.add("agent-target-stack-open");
  setPromptSidePanelWidth(width);
  const closeBottom = () => chatModal.querySelector<HTMLButtonElement>("[data-ai-chat-close]")?.click();
  const removeGesture = itsSetupStackedSwipeDismiss(chatModal, chatSheet, target, closeBottom);
  const observer = new MutationObserver(() => {
    if (!target.isConnected || (!target.classList.contains("open") && target.id !== "m-ai-history-sheet")) {
      itsReleaseAgentPanelStack();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  if (target.id !== "m-ai-history-sheet") observer.observe(target, { attributes: true, attributeFilter: ["class"] });
  itsAgentStackCleanup = () => {
    observer.disconnect();
    removeGesture();
    target.classList.remove("its-ai-agent-target-stacked");
    chatModal.classList.remove("agent-target-stack-open");
    document.documentElement.style.removeProperty("--its-agent-stack-width");
    document.documentElement.style.removeProperty("--its-agent-chat-stack-height");
    document.documentElement.style.removeProperty("--its-agent-chat-stack-height-mobile");
    if (target.isConnected) setPromptSidePanelWidthFromSheet(itsAgentTargetSheet(target));
    else if (chatModal.isConnected) setPromptSidePanelWidthFromSheet(chatSheet);
    else clearPromptSidePanelWidth(0);
  };
}

type ItsModalScrollMode =
  | "none"
  | "top"
  | "bottom"
  | "both";

type ItsModalAnalysis = {
  panelId: string | null;
  title: string;
  activeTab: string | null;
  summary: string;
  scroll: {
    top: number;
    height: number;
    viewport: number;
    canScroll: boolean;
  };
  history: Array<{
    title: string;
    status: string | null;
    text: string;
  }>;
  metrics: Array<{
    label: string;
    value: string;
  }>;
  textExcerpt: string;
};

function itsElementIsVisible(
  element: HTMLElement,
): boolean {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();

  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity) !== 0 &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function itsFindTopmostOpenPanel(): HTMLElement | null {
  const selectors = [
    "#its-ai-chat-detection-detail-modal.open",
    "#m-ai-history-detail-modal.open",
    "#roadmap-story-modal.open",
    "#privacy-info-modal.open",
    "#app-license-info-modal.open",
    "#about-site-info-modal.open",
    "#ai-license-modal.open",
    "#map-license-modal.open",
    "#windows-download-modal.open",
    "#m-device-modal.open",
    "#m-poi-modal.open",
    "body.ai-history-sheet-open #m-ai-history-sheet",
  ];

  const candidates = selectors
    .map((selector, priority) => ({
      element:
        document.querySelector<HTMLElement>(selector),
      priority,
    }))
    .filter(
      (
        item,
      ): item is {
        element: HTMLElement;
        priority: number;
      } =>
        Boolean(
          item.element &&
          itsElementIsVisible(item.element),
        ),
    );

  if (!candidates.length) return null;

  candidates.sort((left, right) => {
    const leftZ =
      Number.parseInt(
        window.getComputedStyle(left.element).zIndex || "0",
        10,
      ) || 0;

    const rightZ =
      Number.parseInt(
        window.getComputedStyle(right.element).zIndex || "0",
        10,
      ) || 0;

    if (leftZ !== rightZ) return rightZ - leftZ;

    return left.priority - right.priority;
  });

  return candidates[0].element;
}

function itsFindModalScrollableArea(
  panel: HTMLElement,
): HTMLElement {
  const selectors = [
    ".m-ai-history-content",
    "[data-ai-history-content]",
    ".m-ai-detail-body",
    ".map-license-list",
    ".windows-download-detail-body",
    ".modal-content",
    ".poi-modal-content",
    ".its-ai-chat-log",
  ];

  const candidates = Array.from(
    panel.querySelectorAll<HTMLElement>(
      selectors.join(", "),
    ),
  ).filter(itsElementIsVisible);

  return (
    candidates.find(
      (element) =>
        element.scrollHeight >
        element.clientHeight + 4,
    ) ||
    candidates[0] ||
    panel
  );
}

async function itsScrollOpenModal(
  mode: ItsModalScrollMode,
  amount = 0.9,
): Promise<{
  ok: boolean;
  panelId: string | null;
  mode: ItsModalScrollMode;
  top: number;
  height: number;
  viewport: number;
}> {
  const panel = itsFindTopmostOpenPanel();

  if (!panel) {
    return {
      ok: false,
      panelId: null,
      mode,
      top: 0,
      height: 0,
      viewport: 0,
    };
  }

  const scrollable = itsFindModalScrollableArea(panel);
  const maxTop = Math.max(
    0,
    scrollable.scrollHeight -
    scrollable.clientHeight,
  );

  const safeAmount = Math.min(
    1,
    Math.max(
      0.1,
      Number.isFinite(amount) ? amount : 0.9,
    ),
  );

  if (mode === "top") {
    scrollable.scrollTo({
      top: 0,
      behavior: "smooth",
    });

    await itsDelay(260);
  }

  if (mode === "bottom") {
    scrollable.scrollTo({
      top: maxTop,
      behavior: "smooth",
    });

    await itsDelay(360);
  }

  if (mode === "both") {
    scrollable.scrollTo({
      top: 0,
      behavior: "smooth",
    });

    await itsDelay(220);

    scrollable.scrollTo({
      top: maxTop * safeAmount,
      behavior: "smooth",
    });

    await itsDelay(360);

    scrollable.scrollTo({
      top: maxTop,
      behavior: "smooth",
    });

    await itsDelay(320);

    scrollable.scrollTo({
      top: 0,
      behavior: "smooth",
    });

    await itsDelay(220);
  }

  return {
    ok: true,
    panelId: panel.id || null,
    mode,
    top: Math.round(scrollable.scrollTop),
    height: scrollable.scrollHeight,
    viewport: scrollable.clientHeight,
  };
}

function itsCloseTopmostModal(): boolean {
  const panel = itsFindTopmostOpenPanel();
  if (!panel) return false;

  if (panel.id === "m-ai-history-sheet") {
    const closed =
      itsRuntimeBridge().closeAiHistory?.();

    if (closed) return true;
  }

  const closeButton =
    panel.querySelector<HTMLButtonElement>([
      "[data-action='close']",
      "[data-license-close]",
      "[data-windows-close]",
      "[data-ai-history-close]",
      "[data-ai-detail-close]",
      "[data-poi-close]",
      "[data-device-close]",
      "[aria-label='Tutup']",
      "[aria-label='Close']",
    ].join(", "));

  if (closeButton) {
    closeButton.click();
    return true;
  }

  panel.classList.remove("open");
  panel.setAttribute("aria-hidden", "true");

  return true;
}

async function itsAnalyzeOpenModalContent(
  options: {
    scroll?: ItsModalScrollMode;
    maxItems?: number;
  } = {},
): Promise<ItsModalAnalysis | null> {
  const panel = itsFindTopmostOpenPanel();
  if (!panel) return null;

  const scrollMode = options.scroll || "both";
  const maxItems = Math.min(
    30,
    Math.max(1, options.maxItems || 12),
  );

  if (scrollMode !== "none") {
    await itsScrollOpenModal(scrollMode);
  }

  const scrollable = itsFindModalScrollableArea(panel);

  const title =
    panel
      .querySelector<HTMLElement>(
        "h1, h2, h3, .modal-title, .sheet-title-copy h2",
      )
      ?.textContent?.trim() ||
    "Panel aktif";

  const activeTab =
    panel
      .querySelector<HTMLElement>(
        "[aria-selected='true'], .active[data-ai-history-tab], .active[role='tab']",
      )
      ?.textContent?.trim() || null;

  const history = Array.from(
    panel.querySelectorAll<HTMLElement>(
      ".m-ai-history-card, [data-history-item]",
    ),
  )
    .slice(0, maxItems)
    .map((card) => ({
      title:
        card
          .querySelector<HTMLElement>(
            ".m-ai-history-meta, strong, h3",
          )
          ?.textContent?.trim() ||
        "Item riwayat",

      status:
        card
          .querySelector<HTMLElement>(
            "[data-history-status], .status, .badge",
          )
          ?.textContent?.trim() || null,

      text: itsNormalizeResearchText(
        card.innerText,
      ).slice(0, 900),
    }));

  const metrics = Array.from(
    panel.querySelectorAll<HTMLElement>(
      ".its-ai-metric, [data-ai-metric], .m-ai-detail-total",
    ),
  )
    .slice(0, maxItems)
    .map((metric) => ({
      label:
        metric
          .querySelector<HTMLElement>(
            "span, label, small",
          )
          ?.textContent?.trim() ||
        "Metrik",

      value:
        metric
          .querySelector<HTMLElement>(
            "strong, b, output",
          )
          ?.textContent?.trim() ||
        "-",
    }));

  const textExcerpt = itsNormalizeResearchText(
    scrollable.innerText || panel.innerText,
  ).slice(0, 6000);

  const summaryParts = [
    `Panel "${title}" sedang terbuka.`,
  ];

  if (activeTab) {
    summaryParts.push(
      `Tab aktif adalah "${activeTab}".`,
    );
  }

  summaryParts.push(
    `Ditemukan ${history.length} item riwayat dan ${metrics.length} metrik.`,
  );

  if (
    scrollable.scrollHeight >
    scrollable.clientHeight + 4
  ) {
    summaryParts.push(
      "Panel memiliki data yang dapat digulir dari atas ke bawah.",
    );
  }

  if (history.length) {
    summaryParts.push(
      `Contoh data: ${history
        .slice(0, 3)
        .map((item) => item.title)
        .join(", ")}.`,
    );
  }

  return {
    panelId: panel.id || null,
    title,
    activeTab,
    summary: summaryParts.join(" "),
    scroll: {
      top: Math.round(scrollable.scrollTop),
      height: scrollable.scrollHeight,
      viewport: scrollable.clientHeight,
      canScroll:
        scrollable.scrollHeight >
        scrollable.clientHeight + 4,
    },
    history,
    metrics,
    textExcerpt,
  };
}

let itsAgentRuntimeBindingsInstalled = false;

function itsDistanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const radius = 6_371_000;
  const radians = (value: number) => value * Math.PI / 180;
  const latitude = radians(b.lat - a.lat);
  const longitude = radians(b.lng - a.lng);
  const value = Math.sin(latitude / 2) ** 2
    + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(longitude / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function itsAgentApplicationState(): Record<string, unknown> {
  const panel = itsFindTopmostOpenPanel();
  return {
    application: {
      name: "ITS Maps",
      developer: ITS_CREATOR_PROFILE.name,
      publisher: ITS_CREATOR_PROFILE.publisher,
      description: ITS_CREATOR_PROFILE.summary,
      publicSources: ITS_CREATOR_PROFILE.sources,
      resources: Object.fromEntries(Object.entries(ITS_WEBMCP_RESOURCE_URLS).map(([name, pathname]) => [name, itsAbsoluteUrl(pathname)])),
    },
    map: {
      userLocationAvailable: Boolean(itsRuntimeBridge().getUserLocation?.()),
      visiblePlaces: (itsRuntimeBridge().getPoiSnapshot?.() || []).slice(0, 40),
    },
    interface: {
      openPanel: panel?.id || null,
      allowedActions: [
        { type: "open_panel", targets: ["ai-history", "roadmap", "privacy", "ai-license", "app-license"] },
        { type: "render_chart" },
        { type: "render_snapshot" },
        { type: "render_map" },
        { type: "render_places" },
        { type: "focus_map" },
        { type: "open_place" },
        { type: "create_route" },
      ],
    },
  };
}

function itsEntityTokens(plan: DynamicAgentPlan): string[] {
  return plan.entities.flatMap((entity) => entity.text.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u)).filter((token) => token.length > 1);
}

function itsRankRuntimePlaces(plan: DynamicAgentPlan): Array<ItsRuntimePoiSnapshot & { distanceMeters?: number }> {
  const places = itsRuntimeBridge().getPoiSnapshot?.() || [];
  const tokens = itsEntityTokens(plan);
  const origin = itsRuntimeBridge().getUserLocation?.();
  return places.map((place) => {
    const searchable = `${place.title} ${place.kind} ${place.address || ""}`.toLocaleLowerCase();
    const relevance = tokens.reduce((score, token) => score + (searchable.includes(token) ? 1 : 0), 0);
    const distanceMeters = origin ? itsDistanceMeters(origin, place) : undefined;
    return { ...place, relevance, distanceMeters };
  }).sort((left, right) => {
    if (right.relevance !== left.relevance) return right.relevance - left.relevance;
    return (left.distanceMeters ?? Number.MAX_SAFE_INTEGER) - (right.distanceMeters ?? Number.MAX_SAFE_INTEGER);
  }).map(({ relevance: _relevance, ...place }) => place).slice(0, 20);
}

function itsRequestBrowserLocation(signal: AbortSignal): Promise<{ lat: number; lng: number; accuracy: number; source: string; updatedAt: number }> {
  const current = itsRuntimeBridge().getUserLocation?.();
  if (current) return Promise.resolve({ ...current, accuracy: current.accuracy || 0, source: current.source || "runtime", updatedAt: current.updatedAt || Date.now() });
  if (!navigator.geolocation) return Promise.reject(new Error("Browser tidak menyediakan Geolocation API."));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException("Permintaan lokasi dibatalkan.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    navigator.geolocation.getCurrentPosition((position) => {
      signal.removeEventListener("abort", abort);
      const location = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
        source: "browser-geolocation",
        updatedAt: Date.now(),
      };
      itsRuntimeBridge().applyUserLocation?.(location.lat, location.lng, location.accuracy, true, location.source);
      resolve(location);
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(new Error(`Lokasi tidak tersedia: ${error.message}`));
    }, { enableHighAccuracy: true, maximumAge: 15_000, timeout: 18_000 });
  });
}

function itsPlanTargetPlace(plan: DynamicAgentPlan): ItsRuntimePoiSnapshot | undefined {
  const ranked = itsRankRuntimePlaces(plan);
  const requestedTarget = plan.requestedActions.map((action) => action.target?.trim()).find(Boolean)?.toLocaleLowerCase();
  if (requestedTarget) {
    const exact = ranked.find((place) => place.id.toLocaleLowerCase() === requestedTarget || place.title.toLocaleLowerCase() === requestedTarget);
    if (exact) return exact;
  }
  return ranked[0];
}

function itsInstallAgentRuntimeBindings(): void {
  if (itsAgentRuntimeBindingsInstalled) return;
  itsAgentRuntimeBindingsInstalled = true;
  agentOrchestrator.registerCapabilityAdapter("query_realtime_state", async (context) => {
    context.emit({ type: "skill-start", title: "Membaca Firebase RTDB karena rencana memerlukannya", payload: { capability: "query_realtime_state" } });
    const status = await itsGetRealtimeMapSummary();
    context.blackboard.set("realtime-status", status);
    return { status: "completed", output: status };
  });
  agentOrchestrator.registerCapabilityAdapter("resolve_location", async (context) => {
    try {
      const location = await itsRequestBrowserLocation(context.signal);
      context.blackboard.set("user-location", location);
      return { status: "completed", output: location };
    } catch (error) {
      return { status: "failed", limitations: [error instanceof Error ? error.message : String(error)] };
    }
  });
  agentOrchestrator.registerCapabilityAdapter("resolve_entities", async (context) => {
    const places = itsRankRuntimePlaces(context.plan);
    return {
      status: "completed",
      output: {
        entities: context.plan.entities,
        placeMatches: places.slice(0, Math.max(1, context.plan.entities.length || 5)),
      },
    };
  });
  agentOrchestrator.registerCapabilityAdapter("search_open_places", async (context) => {
    const places = itsRankRuntimePlaces(context.plan);
    context.blackboard.set("place-results", places);
    return {
      status: places.length ? "completed" : "skipped",
      output: { places },
      limitations: places.length ? [] : ["Belum ada POI terbuka yang termuat pada viewport peta."],
    };
  });
  agentOrchestrator.registerCapabilityAdapter("query_map_geometry", async (context) => {
    const geometry = {
      userLocation: itsRuntimeBridge().getUserLocation?.() || null,
      places: itsRankRuntimePlaces(context.plan),
    };
    context.blackboard.set("map-geometry", geometry);
    return { status: "completed", output: geometry };
  });
  agentOrchestrator.registerCapabilityAdapter("analyse_image", async (context) => {
    const research = context.blackboard.get<Record<string, unknown>>("research-result");
    if (research && !context.plan.needsRealtimeData) return { status: "completed", output: research };
    if (!context.plan.needsRealtimeData) return { status: "skipped", limitations: ["Tidak ada media terbuka yang berhasil dimuat untuk dianalisis."] };
    const snapshot = await itsGetLatestSnapshotImage();
    context.blackboard.set("camera-snapshot", snapshot);
    return { status: "completed", output: snapshot };
  });
  agentOrchestrator.registerCapabilityAdapter("focus_map", async (context) => {
    const location = context.blackboard.get<{ lat: number; lng: number }>("user-location");
    const place = itsPlanTargetPlace(context.plan);
    if (place) {
      itsRuntimeBridge().focusLatLng?.(place.lat, place.lng, place.title);
      return { status: "completed", output: place };
    }
    if (location) {
      itsRuntimeBridge().focusLatLng?.(location.lat, location.lng, "Lokasi pengguna");
      return { status: "completed", output: location };
    }
    return { status: "skipped", limitations: ["Tidak ada koordinat hasil resolusi yang dapat difokuskan."] };
  });
  agentOrchestrator.registerCapabilityAdapter("open_place", async (context) => {
    const place = itsPlanTargetPlace(context.plan);
    if (!place) return { status: "skipped", limitations: ["Entitas tempat belum terhubung ke POI yang termuat."] };
    itsRuntimeBridge().focusPoi?.(place.id, place.lat, place.lng);
    return { status: "completed", output: place };
  });
  agentOrchestrator.registerCapabilityAdapter("create_route", async (context) => {
    const place = itsPlanTargetPlace(context.plan);
    if (!place) return { status: "skipped", limitations: ["Tujuan rute belum dapat diresolusi."] };
    itsRuntimeBridge().focusPoi?.(place.id, place.lat, place.lng);
    return { status: "completed", output: { destination: place, routeRequested: true } };
  });
}

async function itsExecutePlannedUiActions(plan: DynamicAgentPlan, onStage?: (stage: string) => void): Promise<void> {
  const panelActions: Record<string, { trigger: string; panel: string; open: () => void }> = {
    "ai-history": {
      trigger: "[data-ai-history], [data-open-ai-history]",
      panel: "#m-ai-history-sheet",
      open: () => window.dispatchEvent(new CustomEvent("its:open-ai-history", { detail: { source: "its-agent" } })),
    },
    roadmap: {
      trigger: "[data-roadmap-story]",
      panel: "#roadmap-story-modal",
      open: itsShowRoadmapStoryModal,
    },
    privacy: {
      trigger: "[data-privacy-modal]",
      panel: "#privacy-info-modal",
      open: () => itsShowSiteInfoModal("privacy"),
    },
    "ai-license": {
      trigger: "[data-ai-license]",
      panel: "#ai-license-modal",
      open: itsShowAiLicenseModal,
    },
    "app-license": {
      trigger: "[data-app-license]",
      panel: "#app-license-info-modal",
      open: () => itsShowSiteInfoModal("app-license"),
    },
    licence: {
      trigger: "[data-app-license]",
      panel: "#app-license-info-modal",
      open: () => itsShowSiteInfoModal("app-license"),
    },
  };
  for (const action of plan.requestedActions) {
    const type = action.type.trim().toLocaleLowerCase().replaceAll("-", "_");
    if (type !== "open_panel") continue;
    const target = (action.target || "").trim().toLocaleLowerCase().replaceAll("_", "-");
    const panelAction = panelActions[target];
    if (!panelAction) continue;
    onStage?.(`Membuka panel ${target || "yang diminta"}`);
    itsSetAgentWorking(true);
    try {
      await itsAgentClick(panelAction.trigger, panelAction.open);
      const panel = await itsWaitForAgentTarget(panelAction.panel);
      if (panel) itsDockAgentPanelStack(panel);
    } finally {
      itsSetAgentWorking(false);
    }
  }
}

function itsAgentCardsFromOutputs(plan: DynamicAgentPlan, outputs: Record<string, unknown>): string {
  const cards: string[] = [];
  const capabilities = new Set(plan.requiredCapabilities);
  const actions = new Set(plan.requestedActions.map((action) => action.type.trim().toLocaleLowerCase().replaceAll("-", "_")));
  const realtime = objectRecord(outputs["capability:query_realtime_state"]);
  const snapshot = objectRecord(outputs["capability:analyse_image"]);
  const device = itsPrimaryDevice(realtime) || objectRecord(snapshot.device);
  if (device && (snapshot.imageUrl || snapshot.base64Data) && capabilities.has("analyse_image")) {
    cards.push(itsSnapshotCardHtml(device, snapshot));
  }
  if (device && actions.has("render_chart")) cards.push(itsChartCardHtml(device));
  if (device && (actions.has("render_map") || capabilities.has("focus_map") || capabilities.has("query_map_geometry"))) {
    cards.push(itsMapCardHtml(device));
  }
  if (device && (actions.has("render_places") || capabilities.has("search_open_places") || capabilities.has("open_place"))) {
    cards.push(itsPoiCardHtml(device));
  }
  if (device && plan.needsLocation) cards.push(itsUserLocationCardHtml(device));
  return cards.length ? `<div class="its-ai-card-stack">${cards.join("")}</div>` : "";
}

function itsWeatherDescription(code: number): string {
  if (code === 0) return "cerah";
  if (code <= 3) return "berawan";
  if (code === 45 || code === 48) return "berkabut";
  if (code >= 51 && code <= 57) return "gerimis";
  if (code >= 61 && code <= 67) return "hujan";
  if (code >= 71 && code <= 77) return "salju";
  if (code >= 80 && code <= 82) return "hujan lokal";
  if (code >= 85 && code <= 86) return "salju lokal";
  if (code >= 95) return "badai petir";
  return "kondisi belum terklasifikasi";
}

function itsWeatherPlaceFromQuestion(question: string): string {
  const match = question.match(/\b(?:di|untuk|sekitar|daerah)\s+([\p{L}\p{N} .'-]{2,60}?)(?:\s+(?:hari ini|sekarang|saat ini))?[?.!,]*$/iu);
  return match?.[1]?.trim() || "";
}

async function itsWeatherAssistantResponse(question: string, signal?: AbortSignal): Promise<ItsAssistantResponse> {
  const requestedPlace = itsWeatherPlaceFromQuestion(question);
  let point = itsRuntimeBridge().getUserLocation?.() || itsRuntimeBridge().getSystemLocation?.() || null;
  let placeLabel = point && itsRuntimeBridge().getUserLocation?.() ? "lokasi Anda" : "lokasi sistem ITS Maps";

  if (requestedPlace) {
    const geocodeUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
    geocodeUrl.searchParams.set("name", requestedPlace);
    geocodeUrl.searchParams.set("count", "1");
    geocodeUrl.searchParams.set("language", "id");
    geocodeUrl.searchParams.set("format", "json");
    const geocodeResponse = await fetch(geocodeUrl, { signal, cache: "no-store" });
    if (!geocodeResponse.ok) throw new Error(`Pencarian lokasi cuaca gagal (HTTP ${geocodeResponse.status}).`);
    const geocode = objectRecord(await geocodeResponse.json());
    const result = Array.isArray(geocode.results) ? objectRecord(geocode.results[0]) : {};
    const lat = itsNumberField(result.latitude);
    const lng = itsNumberField(result.longitude);
    if (lat === null || lng === null) {
      return { text: `Saya belum menemukan lokasi "${requestedPlace}". Tambahkan nama kota atau kabupaten agar pencarian cuaca lebih tepat.` };
    }
    point = { lat, lng };
    placeLabel = [itsStringField(result.name), itsStringField(result.admin1), itsStringField(result.country)].filter(Boolean).join(", ");
  }

  if (!point) {
    const [lat, lng] = initialMapCenter() as [number, number];
    point = { lat, lng };
    placeLabel = "titik awal ITS Maps";
  }

  const weatherUrl = new URL("https://api.open-meteo.com/v1/forecast");
  weatherUrl.searchParams.set("latitude", String(point.lat));
  weatherUrl.searchParams.set("longitude", String(point.lng));
  weatherUrl.searchParams.set("current", "temperature_2m,apparent_temperature,precipitation,rain,weather_code,cloud_cover,wind_speed_10m");
  weatherUrl.searchParams.set("timezone", "auto");
  const response = await fetch(weatherUrl, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Data cuaca gagal dimuat (HTTP ${response.status}).`);
  const payload = objectRecord(await response.json());
  const current = objectRecord(payload.current);
  const units = objectRecord(payload.current_units);
  const temperature = itsNumberField(current.temperature_2m);
  const apparent = itsNumberField(current.apparent_temperature);
  const rain = itsNumberField(current.rain) ?? itsNumberField(current.precipitation) ?? 0;
  const clouds = itsNumberField(current.cloud_cover);
  const wind = itsNumberField(current.wind_speed_10m);
  const description = itsWeatherDescription(itsNumberField(current.weather_code) ?? -1);
  const temperatureText = temperature === null ? "-" : `${temperature.toFixed(1)}${itsStringField(units.temperature_2m) || " C"}`;
  const sourceUrl = `https://open-meteo.com/en/docs#latitude=${point.lat}&longitude=${point.lng}`;
  return {
    text: `Cuaca saat ini di ${placeLabel} ${description}, dengan suhu ${temperatureText}${apparent === null ? "" : ` dan terasa seperti ${apparent.toFixed(1)} C`}. Data ini adalah pengamatan/prakiraan cuaca, bukan sensor Raspberry ITS Maps.`,
    html: `<section class="its-ai-card its-ai-weather-card">
      <div class="its-ai-card-head">
        <span>${itsMiniIcon("M7 17h10a4 4 0 0 0 .5-8A6 6 0 0 0 6.2 10.2 3.5 3.5 0 0 0 7 17Z", "#0284c7")} Cuaca saat ini</span>
        <strong>${escapeHtml(temperatureText)}</strong>
      </div>
      <div class="its-ai-weather-grid">
        <span><b>Kondisi</b>${escapeHtml(description)}</span>
        <span><b>Hujan</b>${escapeHtml(String(rain))} ${escapeHtml(itsStringField(units.rain) || "mm")}</span>
        <span><b>Awan</b>${clouds === null ? "-" : `${clouds}%`}</span>
        <span><b>Angin</b>${wind === null ? "-" : `${wind} ${escapeHtml(itsStringField(units.wind_speed_10m) || "km/h")}`}</span>
      </div>
      <p class="its-ai-card-note">${escapeHtml(placeLabel)} - pembaruan ${escapeHtml(itsStringField(current.time) || "terbaru tersedia")}.</p>
      <div class="its-ai-actions"><a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener">Sumber Open-Meteo</a></div>
    </section>`,
  };
}

async function itsFastAssistantResponse(
  question: string,
  history: ItsChatTurn[],
  signal?: AbortSignal,
  onStage?: (stage: string) => void,
): Promise<ItsAssistantResponse | null> {
  const normalized = question.toLocaleLowerCase("id-ID").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  signal?.throwIfAborted();
  if (/^(halo|hallo|hai|hi|hello|selamat pagi|selamat siang|selamat sore|selamat malam)( semuanya| asisten| its maps)?$/.test(normalized)) {
    const returning = history.some((turn) => turn.role === "assistant");
    return { text: returning ? "Halo lagi. Ada bagian ITS Maps atau topik lain yang ingin Anda lanjutkan?" : "Halo. Saya siap membantu membaca ITS Maps atau menjawab pertanyaan Anda. Apa yang ingin diperiksa?" };
  }
  if (/^(terima kasih|makasih|thanks|thank you|oke terima kasih)$/.test(normalized)) {
    return { text: "Sama-sama. Saya siap melanjutkan ketika Anda punya pertanyaan berikutnya." };
  }
  if (/\b(cuaca|weather|suhu|hujan|berawan|cerah)\b/.test(normalized)) {
    onStage?.("Mengambil cuaca terbaru untuk lokasi yang diminta...");
    return itsWeatherAssistantResponse(question, signal);
  }
  if (/\b(snapshot|kamera|gambar ai|deteksi (?:gambar|objek)|object detection)\b/.test(normalized)) {
    onStage?.("Membaca snapshot terbaru dan menyiapkan RF-DETR...");
    const snapshot = await itsGetLatestSnapshotImage();
    const device = objectRecord(snapshot.device);
    if (!snapshot.imageUrl && !snapshot.base64Data) return { text: itsStringField(snapshot.error) || "Snapshot kamera belum tersedia." };
    return {
      text: "Saya memuat snapshot terbaru yang tersedia. RF-DETR browser akan memindai gambar, menyaring confidence rendah, lalu menampilkan bbox dan rincian hanya untuk objek yang terkonfirmasi.",
      html: itsSnapshotCardHtml(device, snapshot),
    };
  }
  if (/\b(grafik|chart|diagram)\b/.test(normalized) && /\b(lalu lintas|traffic|kendaraan|rtdb|its)\b/.test(normalized)) {
    onStage?.("Membaca data grafik terbaru dari RTDB...");
    const status = await itsGetRealtimeMapSummary();
    const device = itsPrimaryDevice(status);
    return device
      ? { text: "Berikut grafik dari nilai RTDB terbaru. Sumbu X memisahkan status lampu dan kendaraan; sumbu Y menunjukkan detik atau jumlah sesuai legendanya.", html: itsChartCardHtml(device) }
      : { text: "Belum ada perangkat RTDB yang dapat dibuatkan grafik." };
  }
  if (/\b(peta|maps|lokasi|poi|tempat|rute)\b/.test(normalized) && !/\b(rumus|jurnal|penelitian|arsitektur)\b/.test(normalized)) {
    onStage?.("Membaca lokasi dan POI yang sedang termuat...");
    const status = await itsGetRealtimeMapSummary();
    const device = itsPrimaryDevice(status);
    if (!device) return { text: "Belum ada lokasi perangkat yang tersedia di RTDB." };
    const wantsPoi = /\b(poi|tempat|sekitar|restoran|sekolah|kampus|masjid|toko)\b/.test(normalized);
    const wantsUser = /\b(lokasi saya|lokasi terkini|posisi saya)\b/.test(normalized);
    return {
      text: wantsPoi ? "Saya menampilkan POI terdekat yang benar-benar sudah dimuat dari data peta." : "Berikut lokasi perangkat ITS Maps berdasarkan koordinat RTDB terbaru.",
      html: [itsMapCardHtml(device), wantsPoi ? itsPoiCardHtml(device) : "", wantsUser ? itsUserLocationCardHtml(device) : ""].filter(Boolean).join(""),
    };
  }
  if (/\b(status|raspberry|perangkat|lampu|traffic|lalu lintas|kendaraan|online|offline)\b/.test(normalized)
    && !/\b(rumus|jurnal|penelitian|paper|arsitektur|metode)\b/.test(normalized)) {
    onStage?.("Membaca status perangkat terbaru dari RTDB...");
    const status = await itsGetRealtimeMapSummary();
    const device = itsPrimaryDevice(status);
    if (!device) return { text: "Belum ada perangkat yang tercatat di RTDB." };
    const vehicles = objectRecord(device.vehicleBreakdown);
    return {
      text: `Sistem ${String(device.id || "Raspberry")} saat ini ${String(device.status || "belum diketahui")}; pembaruan ${String(device.lastSeenText || "belum tersedia")}. Lampu ${itsTrafficColorText(device.trafficColor)} selama ${String(device.trafficDurationSec ?? "-")} detik, dengan ${String(device.totalVehicles ?? vehicles.total ?? 0)} kendaraan pada data terakhir.`,
      html: `<section class="its-ai-card"><div class="its-ai-card-head"><span>Status realtime RTDB</span><strong>${escapeHtml(String(device.status || "-"))}</strong></div>${itsVehicleMetricGridHtml(vehicles)}<p class="its-ai-card-note">Nilai ditampilkan apa adanya dari pembaruan perangkat terakhir.</p></section>`,
    };
  }
  if (/\b(siapa (?:yang )?(?:membuat|developer|pengembang|pencipta)|tentang (?:aplikasi )?its maps|apa itu its maps)\b/.test(normalized)) {
    return {
      text: `ITS Maps dikembangkan oleh ${ITS_CREATOR_PROFILE.name} dan dipublikasikan oleh ${ITS_CREATOR_PROFILE.publisher}. Aplikasi ini menghubungkan peta, Raspberry Pi, kamera, Firebase RTDB, RF-DETR, Android, Windows, dan Windows Widgets.`,
      html: `<section class="its-ai-card"><div class="its-ai-card-head"><span>Developer terverifikasi di proyek</span><strong>${escapeHtml(ITS_CREATOR_PROFILE.publisher)}</strong></div><p class="its-ai-card-note">${escapeHtml(ITS_CREATOR_PROFILE.summary)}</p><div class="its-ai-actions"><a href="https://github.com/hanifasepthi/its" target="_blank" rel="noopener">GitHub ITS Maps</a><a href="/documentation">Dokumentasi</a></div></section>`,
    };
  }
  return null;
}

async function askItsMapsAssistant(
  question: string,
  onStage?: (stage: string) => void,
  history: ItsChatTurn[] = [],
  signal?: AbortSignal,
): Promise<ItsAssistantResponse> {
  const fastResponse = await itsFastAssistantResponse(question, history, signal, onStage);
  if (fastResponse) return fastResponse;
  itsInstallAgentRuntimeBindings();
  const execution = await agentOrchestrator.run({
    question,
    history,
    signal,
    onProgress: (message) => onStage?.(message),
    applicationState: itsAgentApplicationState(),
  });
  await itsExecutePlannedUiActions(execution.plan, onStage);
  const cards = itsAgentCardsFromOutputs(execution.plan, execution.outputs);
  const modelText = execution.responseText.trim();
  return {
    text: modelText || "Saya belum memiliki bukti atau data yang cukup untuk menjawab dengan aman. Mohon tambahkan konteks yang ingin diperiksa.",
    html: [execution.responseHtml, cards].filter(Boolean).join(""),
  };
}

function itsAppAiFabIconHtml(): string {
  return `<span class="its-ai-chat-icon" aria-hidden="true">
    <img src="${ITS_APP_ICON}" alt="">
    <span class="its-ai-chat-spark">${itsAiSparkIconSvg()}</span>
  </span>`;
}

function itsCreateAiChatButton(): void {
  if (document.getElementById("its-ai-chat-fab")) return;
  const button = document.createElement("button");
  button.id = "its-ai-chat-fab";
  button.className = "its-ai-chat-fab";
  button.type = "button";
  button.setAttribute("aria-label", "Buka chat AI ITS Maps");
  button.innerHTML = itsAppAiFabIconHtml();
  button.addEventListener("click", () => itsShowAiChatModal());
  document.body.appendChild(button);
}

function setupAiChatSheetDrag(sheetEl: HTMLElement, modal: HTMLElement, onClose: () => void): void {
  const grip = sheetEl.querySelector<HTMLElement>(".map-license-grip");
  if (!grip) return;
  let startY = 0;
  let deltaY = 0;
  let pointerId = -1;
  let dragging = false;

  grip.addEventListener("pointerdown", (event) => {
    if (!window.matchMedia("(max-width: 820px)").matches) return;
    dragging = true;
    pointerId = event.pointerId;
    startY = event.clientY;
    deltaY = 0;
    sheetEl.style.transition = "none";
    try { grip.setPointerCapture?.(event.pointerId); } catch { /* Pointer capture can fail on older WebView builds. */ }
  });

  grip.addEventListener("pointermove", (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    deltaY = event.clientY - startY;
    event.preventDefault();
    if (deltaY < 0) {
      const pull = Math.max(deltaY, -90);
      sheetEl.style.transform = `translateY(${pull}px)`;
    } else {
      sheetEl.style.transform = `translateY(${deltaY}px)`;
    }
  });

  const finish = (event: PointerEvent) => {
    if (!dragging || event.pointerId !== pointerId) return;
    dragging = false;
    pointerId = -1;
    sheetEl.style.transition = "";
    sheetEl.style.transform = "";
    if (deltaY < -42) modal.classList.add("expanded");
    else if (deltaY > 84) onClose();
  };

  grip.addEventListener("pointerup", finish);
  grip.addEventListener("pointercancel", finish);
}

function itsOpenChatDetectionDetail(detail: ItsAssistantDetectionDetail): void {
  document.getElementById("its-ai-chat-detection-detail-modal")?.remove();
  const chatModal = document.getElementById("its-ai-chat-modal");
  const stacked = promptUsesDesktopSidePanel() && Boolean(chatModal?.classList.contains("open"));
  if (stacked) {
    document.documentElement.style.setProperty("--ai-chat-detail-height", `${detail.detections.length ? 360 : 300}px`);
    chatModal?.classList.add("detail-stack-open");
  }
  const closeDetail = () => {
    const modal = document.getElementById("its-ai-chat-detection-detail-modal");
    if (!modal) return;
    modal.classList.remove("open");
    modal.classList.add("closing");
    window.setTimeout(() => {
      modal.remove();
      chatModal?.classList.remove("detail-stack-open");
      document.documentElement.style.removeProperty("--ai-chat-detail-height");
    }, 240);
  };
  const rows = detail.detections.map((detection, index) => {
    const left = Math.round((detection.x / Math.max(1, detail.frameWidth)) * 100);
    const top = Math.round((detection.y / Math.max(1, detail.frameHeight)) * 100);
    const size = `${Math.round((detection.width / Math.max(1, detail.frameWidth)) * 100)}% x ${Math.round((detection.height / Math.max(1, detail.frameHeight)) * 100)}%`;
    return `<li>
      <span class="m-ai-detail-thumb" aria-hidden="true">
        <img src="${escapeHtml(detail.imageUrl)}" alt="" loading="lazy">
        <em>${index + 1}</em>
      </span>
      <div>
        <strong>${escapeHtml(itsDetectionLabelText(detection.label))}</strong>
        <span>Akurasi ${Math.round(detection.confidence * 100)}% · area ${escapeHtml(size)} · posisi ${left}%, ${top}%</span>
      </div>
    </li>`;
  }).join("");
  const overlay = document.createElement("section");
  overlay.id = "its-ai-chat-detection-detail-modal";
  overlay.className = `map-license-modal its-ai-chat-detection-detail-modal${stacked ? " ai-chat-detail-stacked" : ""}`;
  overlay.innerHTML = `
    <section class="map-license-sheet m-ai-history-detail-sheet its-ai-chat-detection-detail-sheet" role="dialog" aria-modal="true" aria-labelledby="its-ai-chat-detection-detail-title">
      <div class="m-sheet-handle-bar" data-swipe-handle></div>
      <div class="sheet-panel-header m-ai-detail-head">
        <button class="sheet-icon-btn" data-action="close" aria-label="Tutup rincian deteksi" title="Tutup" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
        <div class="sheet-title-copy">
          <h2 id="its-ai-chat-detection-detail-title">Rincian Deteksi</h2>
          <p>${new Date(detail.capturedAt).toLocaleString("id-ID", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short", year: "numeric" })}</p>
        </div>
      </div>
      <div class="m-ai-detail-body">
        <div class="m-ai-detail-total">
          <span>Objek terkonfirmasi</span>
          <strong>${detail.detections.length}</strong>
        </div>
        <div class="its-ai-detail-preview">
          <img src="${escapeHtml(detail.imageUrl)}" alt="Snapshot yang dianalisis RF-DETR">
          ${itsDetectionBboxHtml(detail.detections.map(itsBrowserDetectionToRecord), detail.frameWidth, detail.frameHeight)}
        </div>
        <p class="m-ai-detail-note">Model ${escapeHtml(detail.modelUrl)} · ${detail.fps.toFixed(1)} FPS · ${escapeHtml(detail.note)}</p>
        ${detail.detections.length ? `<ol class="m-ai-detail-list">${rows}</ol>` : `<p class="m-ai-detail-empty">RF-DETR selesai, tetapi belum ada objek yang cukup yakin untuk dihitung.</p>`}
        ${itsVehicleMetricGridHtml(detail.vehicleBreakdown)}
      </div>
    </section>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("open"));
  overlay.querySelector<HTMLButtonElement>('[data-action="close"]')?.addEventListener("click", closeDetail);
  const sheet = overlay.querySelector<HTMLElement>(".m-ai-history-detail-sheet");
  if (sheet) setupPromptSheetSwipe(sheet, closeDetail);
}

function itsShowAiChatModal(): void {
  document.getElementById("its-ai-chat-modal")?.remove();
  closeFloatingMapPanels();
  const modal = document.createElement("section");
  modal.id = "its-ai-chat-modal";
  modal.className = "its-ai-chat-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "its-ai-chat-title");
  modal.innerHTML = `
    <div class="its-ai-chat-sheet">
      <div class="map-license-grip" data-swipe-handle aria-hidden="true"></div>
      <header class="its-ai-chat-head">
        <div>
          <span>ITS AI <small data-ai-cloud-status>Cloudflare diperiksa...</small></span>
          <h2 id="its-ai-chat-title">Asisten ITS Maps</h2>
          <p>Teks nonprivat dapat diproses Workers AI + AI Gateway; pola credential, PII, dan koordinat dialihkan ke model lokal privat/offline.</p>
        </div>
        <button type="button" data-ai-chat-close aria-label="Tutup chat AI">${closeIconSvg()}</button>
      </header>
      <div class="its-ai-chat-log" data-ai-chat-log>
        <article class="its-ai-chat-msg assistant">
          <strong>ITS Assistant</strong>
          <p>Saya siap membantu. Tanyakan kondisi ITS Maps, data perangkat, sumber ilmiah, formula, atau topik lain.</p>
        </article>
      </div>
      <div class="its-ai-chat-quick">
        <button type="button" data-ai-chat-prompt="Bagaimana status Raspberry Pi sekarang?">Status</button>
        <button type="button" data-ai-chat-prompt="Buatkan gambar snapshot AI dan jelaskan objeknya.">Gambar</button>
        <button type="button" data-ai-chat-prompt="Tampilkan peta lokasi Raspberry dengan link maps.">Peta</button>
        <button type="button" data-ai-agent-toggle class="${itsAgentModeEnabled ? "active" : ""}" aria-pressed="${itsAgentModeEnabled ? "true" : "false"}">${itsAgentModeEnabled ? "Agent aktif" : "Agent"}</button>
      </div>
      <form class="its-ai-chat-form" data-ai-chat-form>
        <div class="its-ai-chat-inline-status" data-ai-chat-status role="status" aria-live="polite" hidden>
          <i aria-hidden="true"></i><span></span>
        </div>
        <label>
          <span>Pertanyaan</span>
          <input name="question" type="text" autocomplete="off" placeholder="Tanya apa saja tentang ITS Maps..." required>
        </label>
        <button type="submit" data-ai-chat-send><span data-ai-send-label>Kirim</span><i data-ai-send-spinner aria-hidden="true"></i></button>
      </form>
    </div>`;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add("open"));
  const sheet = modal.querySelector<HTMLElement>(".its-ai-chat-sheet");
  const log = modal.querySelector<HTMLElement>("[data-ai-chat-log]");
  const input = modal.querySelector<HTMLInputElement>("input[name='question']");
  const form = modal.querySelector<HTMLFormElement>("[data-ai-chat-form]");
  const sendButton = modal.querySelector<HTMLButtonElement>("[data-ai-chat-send]");
  const sendLabel = sendButton?.querySelector<HTMLElement>("[data-ai-send-label]");
  const cloudStatus = modal.querySelector<HTMLElement>("[data-ai-cloud-status]");
  void cloudflareAiClient.status().then((status) => {
    if (!cloudStatus || !cloudStatus.isConnected) return;
    cloudStatus.textContent = status.ok ? "Cloudflare siap" : "AI lokal fallback";
    cloudStatus.title = status.ok ? status.endpoint : status.error || "Cloudflare Worker belum siap";
  });
  const disposeLiveActivity = log ? mountAgentLiveActivity(log) : () => undefined;
  const conversation: ItsChatTurn[] = [];
  let promptRunning = false;
  let promptController: AbortController | null = null;
  const close = () => {
    promptController?.abort(new DOMException("Permintaan dibatalkan karena panel ditutup.", "AbortError"));
    agentOrchestrator.cancel();
    publicResearchAgent.cancel();
    itsReleaseAgentPanelStack();
    disposeLiveActivity();
    modal.classList.remove("open");
    clearPromptSidePanelWidth();
    window.setTimeout(() => modal.remove(), 220);
  };
  const scrollLog = () => {
    if (log) log.scrollTop = log.scrollHeight;
  };
  const typewrite = (node: HTMLElement, text: string): Promise<void> => new Promise((resolve) => {
    node.classList.add("its-ai-typewriter");
    node.textContent = "";
    let index = 0;
    const chunkSize = text.length > 1_500 ? 16 : text.length > 800 ? 8 : text.length > 360 ? 4 : 1;
    const delay = text.length > 800 ? 7 : text.length > 360 ? 9 : 12;
    const tick = () => {
      node.textContent = text.slice(0, index);
      scrollLog();
      index += chunkSize;
      if (index <= text.length) window.setTimeout(tick, delay);
      else {
        node.textContent = text;
        node.classList.remove("its-ai-typewriter");
        resolve();
      }
    };
    tick();
  });
  const addMessage = (role: "user" | "assistant" | "status", text: string, html = "") => {
    if (!log) return null;
    const item = document.createElement("article");
    item.className = `its-ai-chat-msg ${role}`;
    item.innerHTML = role === "status"
      ? `<span class="typing-dot"></span><p>${escapeHtml(text)}</p><div class="its-ai-working-bars" aria-hidden="true"><i></i><i></i><i></i></div>`
      : `<strong>${role === "user" ? "Anda" : "ITS Assistant"}</strong><p>${escapeHtml(text)}</p>${html}`;
    log.appendChild(item);
    scrollLog();
    return item;
  };
  const addAssistantMessage = async (text: string, html = "") => {
    const item = addMessage("assistant", "", "");
    const paragraph = item?.querySelector<HTMLElement>("p");
    if (paragraph) {
      await typewrite(paragraph, text);
      hydrateChatMath(paragraph, text);
    }
    if (html && item) {
      const host = document.createElement("div");
      host.innerHTML = html;
      item.appendChild(host);
      scrollLog();
      void itsHydrateSnapshotDetectionCards(host);
      renderMathIn(host);
    }
  };
  const setPromptBusy = (busy: boolean) => {
    promptRunning = busy;
    form?.classList.toggle("is-busy", busy);
    form?.setAttribute("aria-busy", String(busy));
    if (input) input.disabled = busy;
    if (sendButton) sendButton.disabled = busy;
    if (sendLabel) sendLabel.textContent = busy ? "Memproses" : "Kirim";
    modal.querySelectorAll<HTMLButtonElement>("[data-ai-chat-prompt], [data-ai-agent-toggle]").forEach((button) => {
      button.disabled = busy;
    });
  };
  const runPrompt = async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || promptRunning) return;
    promptController = new AbortController();
    setPromptBusy(true);
    const previousConversation = conversation.slice();
    addMessage("user", trimmed);
    conversation.push({ role: "user", content: trimmed });
    itsSetChatStatus("Memahami pertanyaan dan memilih sumber data...");
    try {
      const answer = await askItsMapsAssistant(trimmed, (stage) => {
        itsSetChatStatus(stage);
      }, previousConversation, promptController.signal);
      itsSetChatStatus();
      await addAssistantMessage(answer.text, answer.html || "");
      conversation.push({ role: "assistant", content: answer.text });
    } catch (error) {
      itsSetChatStatus();
      const aborted = error instanceof DOMException && error.name === "AbortError";
      await addAssistantMessage(aborted ? "Permintaan dibatalkan." : error instanceof Error ? error.message : "Chat AI belum dapat menjawab.");
    } finally {
      promptController = null;
      setPromptBusy(false);
      input?.focus();
    }
  };
  modal.querySelector<HTMLButtonElement>("[data-ai-chat-close]")?.addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const citation = target?.closest<HTMLAnchorElement>("[data-ai-citation]");
    if (citation) {
      event.preventDefault();
      const reference = modal.querySelector<HTMLElement>(`#its-ai-reference-${citation.dataset.aiCitation || ""}`);
      if (reference) {
        reference.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
        reference.classList.add("is-citation-target");
        window.setTimeout(() => reference.classList.remove("is-citation-target"), 1500);
      }
      return;
    }
    const detailButton = target?.closest<HTMLButtonElement>("[data-ai-detection-detail]");
    if (detailButton && !detailButton.disabled) {
      event.preventDefault();
      const detail = detailButton.dataset.aiDetectionDetail ? itsChatDetectionDetails.get(detailButton.dataset.aiDetectionDetail) : undefined;
      if (detail) itsOpenChatDetectionDetail(detail);
      return;
    }
    const openPanelButton = target?.closest<HTMLButtonElement>("[data-ai-open-panel]");
    if (openPanelButton) {
      event.preventDefault();
      const panel = openPanelButton.dataset.aiOpenPanel;
      if (panel === "privacy") itsShowSiteInfoModal("privacy");
      else if (panel === "app-license") itsShowSiteInfoModal("app-license");
      else if (panel === "ai-license") itsShowAiLicenseModal();
      else if (panel === "roadmap") itsShowRoadmapStoryModal();
      return;
    }
    const poiButton = target?.closest<HTMLButtonElement>("[data-ai-poi-id]");
    if (poiButton) {
      event.preventDefault();
      const lat = Number(poiButton.dataset.aiPoiLat);
      const lng = Number(poiButton.dataset.aiPoiLng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        itsRuntimeBridge().focusPoi?.(poiButton.dataset.aiPoiId || "", lat, lng);
      }
      return;
    }
    const userLocationButton = target?.closest<HTMLButtonElement>("[data-ai-user-location]");
    if (userLocationButton) {
      event.preventDefault();
      const card = userLocationButton.closest<HTMLElement>("[data-ai-user-location-card]");
      const resultEl = card?.querySelector<HTMLElement>("[data-ai-user-location-result]");
      if (!navigator.geolocation || !card || !resultEl) {
        if (resultEl) resultEl.textContent = "Browser ini belum menyediakan izin lokasi.";
        return;
      }
      userLocationButton.disabled = true;
      resultEl.textContent = "Meminta izin lokasi dan menghitung jarak ke titik Raspberry ITS Maps...";
      navigator.geolocation.getCurrentPosition((position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        itsRuntimeBridge().applyUserLocation?.(lat, lng, position.coords.accuracy, true, "ai-chat-gps");
        const runtimeSystem = itsRuntimeBridge().getSystemLocation?.();
        const systemLat = Number(card.dataset.systemLat || runtimeSystem?.lat);
        const systemLng = Number(card.dataset.systemLng || runtimeSystem?.lng);
        const distance = itsChatDistanceMeters(lat, lng, systemLat, systemLng);
        const near = distance <= 1800;
        const gmaps = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
        const bing = `https://www.bing.com/maps?cp=${lat}~${lng}&lvl=17`;
        const its = `https://itstelkom.web.app/?lat=${lat}&lng=${lng}&z=17&mode=street`;
        const userPoint = { lat, lng };
        const systemPoint = { lat: systemLat, lng: systemLng };
        resultEl.innerHTML = `
          <span>${near
            ? `Lokasi Anda berjarak ${escapeHtml(itsChatDistanceText(distance))} dari titik Raspberry terdekat. Status titik ITS Maps: ${escapeHtml(itsTrafficColorText(card.dataset.systemColor))}.`
            : `Lokasi Anda berjarak ${escapeHtml(itsChatDistanceText(distance))} dari titik Raspberry. Belum ada sensor ITS Maps yang cukup dekat untuk menyimpulkan macet di titik Anda.`}</span>
          <div class="its-ai-map-split">
            <div><b>Lokasi Anda</b>${itsMapMosaicHtml(userPoint, itsUserMarkerHtml(), "Peta lokasi user")}</div>
            <div><b>Raspberry terdekat</b>${itsMapMosaicHtml(systemPoint, itsTrafficLightMarkerHtml(card.dataset.systemColor), "Peta Raspberry terdekat")}</div>
          </div>`;
        const actions = card.querySelector<HTMLElement>(".its-ai-actions");
        if (actions) actions.innerHTML = `
          <a href="${gmaps}" target="_blank" rel="noopener">Google Maps</a>
          <a href="${bing}" target="_blank" rel="noopener">Bing Maps</a>
          <a href="${its}" target="_blank" rel="noopener">ITS Maps</a>`;
      }, (error) => {
        resultEl.textContent = `Izin lokasi belum diberikan: ${error.message || "browser menolak akses lokasi"}.`;
        userLocationButton.disabled = false;
      }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 });
      return;
    }
    if (event.target === modal) close();
  });
  modal.querySelectorAll<HTMLButtonElement>("[data-ai-chat-prompt]").forEach((button) => {
    button.addEventListener("click", () => void runPrompt(button.dataset.aiChatPrompt || ""));
  });
  modal.querySelector<HTMLButtonElement>("[data-ai-agent-toggle]")?.addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    itsAgentModeEnabled = !itsAgentModeEnabled;
    button.setAttribute("aria-pressed", String(itsAgentModeEnabled));
    button.textContent = itsAgentModeEnabled ? "Agent aktif" : "Agent";
    button.classList.toggle("active", itsAgentModeEnabled);
    itsSetChatStatus(itsAgentModeEnabled ? "Agent in-page aktif; aksi tetap terbatas pada halaman ITS Maps" : "Agent in-page dimatikan");
    window.setTimeout(() => itsSetChatStatus(), 1600);
  });
  modal.querySelector<HTMLFormElement>("[data-ai-chat-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input?.value || "";
    if (input) input.value = "";
    void runPrompt(value);
  });
  if (sheet) {
    setupPromptSheetSwipe(sheet, close);
    setupAiChatSheetDrag(sheet, modal, close);
  }
  window.setTimeout(() => {
    setPromptSidePanelWidthFromSheet(sheet);
  }, 20);
  input?.focus();
}

function itsRegisterWebMcpTools(): boolean {
  if (!itsWebMcpListenersInstalled) {
    document.querySelectorAll<HTMLFormElement>("[data-webmcp-open-resource], [data-webmcp-site-search], [data-webmcp-public-context]")
      .forEach((form) => form.addEventListener("submit", itsHandleWebMcpSubmit));
    itsWebMcpListenersInstalled = true;
  }

  const modelContext =
    (document as Document & ItsWebMcpHost)
      .modelContext;

  if (!modelContext?.registerTool) return false;
  if (itsWebMcpImperativeRegistered) return true;
  itsWebMcpImperativeRegistered = true;
  const register = (tool: ItsWebMcpTool) => {
    const handleError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate tool name/i.test(message)) console.warn(`[ITS] WebMCP tool ${tool.name} skipped`, error);
    };
    try {
      const pending = modelContext.registerTool(tool);
      if (pending && typeof (pending as Promise<void>).catch === "function") void (pending as Promise<void>).catch(handleError);
    } catch (error) {
      handleError(error);
    }
  };

  register({
    name: "list_its_maps_device_ids",
    description: "List all ITS Maps Raspberry Pi device IDs and their online/offline status from Firebase RTDB.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const result = await itsListDeviceIds();
      return itsWebMcpContentResponse(JSON.stringify(result, null, 2), result);
    },
  });

  register({
    name: "get_its_maps_device_status",
    description: "Get realtime ITS Maps Raspberry Pi status: online/offline, last heartbeat, road, traffic light color/duration, vehicle counts, RF-DETR object data, camera status, and update state from Firebase RTDB.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: {
          type: "string",
          description: "Optional device ID, for example 'raspberry-its'. Omit to list every device.",
        },
      },
    },
    annotations: { readOnlyHint: true },
    execute: async (input: Record<string, unknown>) => {
      const result = await itsGetDeviceStatusSummary(typeof input.deviceId === "string" ? input.deviceId : undefined);
      return itsWebMcpContentResponse(JSON.stringify(result, null, 2), result);
    },
  });

  register({
    name: "get_its_maps_camera_health",
    description: "Check whether the ITS Maps Raspberry Pi camera tunnel is healthy, including local camera, public camera, stream state, note, and heartbeat.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: {
          type: "string",
          description: "Device ID. Default is 'raspberry-its'.",
        },
      },
    },
    annotations: { readOnlyHint: true },
    execute: async (input: Record<string, unknown>) => {
      const result = await itsGetCameraHealth(typeof input.deviceId === "string" ? input.deviceId : "raspberry-its");
      return itsWebMcpContentResponse(JSON.stringify(result, null, 2), result);
    },
  });

  register({
    name: "get_its_maps_camera_snapshot",
    description: "Get the latest ITS Maps Raspberry Pi camera snapshot image when RTDB stores a base64 data URL, together with the current object detection count.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const result = await itsGetLatestSnapshotImage();
      if (typeof result.base64Data === "string" && typeof result.mimeType === "string") {
        return {
          content: [
            { type: "text", text: `Snapshot kamera terbaru, ${result.objectCount ?? 0} objek/kendaraan terdeteksi.` },
            { type: "image", data: result.base64Data, mimeType: result.mimeType },
          ],
          structuredContent: result,
        };
      }
      return itsWebMcpContentResponse(JSON.stringify(result, null, 2), result);
    },
  });

  register({
    name: "get_its_maps_latest_ai_detections",
    description: "Get metadata about the latest ITS Maps AI/camera snapshot pair captured by Raspberry Pi from Firebase RTDB snapshotHistory.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const result = await itsGetLatestAiDetections();
      return itsWebMcpContentResponse(JSON.stringify(result, null, 2), result);
    },
  });

  register({
    name: "get_its_maps_realtime_map_summary",
    description: "Return a realtime ITS Maps summary for AI agents: generated time, device count, online count, and per-device traffic/camera/object status.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const result = await itsGetRealtimeMapSummary();
      return itsWebMcpContentResponse(JSON.stringify(result, null, 2), result);
    },
  });

  register({
    name: "get_its_maps_windows_app_status",
    description: "Check whether the verified ITS Maps Microsoft Store package is installed on this Windows device. The browser may request the Apps on device permission.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const result = await queryItsWindowsAppInstallation(true);
      return itsWebMcpContentResponse(JSON.stringify(result, null, 2), result);
    },
  });

  register({
    name: "get_its_maps_microsoft_store_public_status",
    description: "Read the verified public Microsoft Store rating, acquisition count, and recent reviews snapshot for ITS Maps. Missing values are returned as unavailable and are never estimated.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const result = await fetchMicrosoftStorePublicSnapshot(FIREBASE_ROOT_URL, true);
      return itsWebMcpContentResponse(JSON.stringify(result, null, 2), result);
    },
  });

  register({
    name: "search_its_maps_traffic_location",
    description: "Search ITS Maps RTDB traffic devices by location, road name, device ID, or Raspberry label.",
    inputSchema: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "Location text, road name, or device ID, for example 'Gang Gotong Royong' or 'raspberry-its'.",
        },
      },
      required: ["location"],
    },
    annotations: { readOnlyHint: true },
    execute: async (input: Record<string, unknown>) => {
      const result = await itsSearchTrafficLocation(String(input.location || ""));
      return itsWebMcpContentResponse(JSON.stringify(result, null, 2), result);
    },
  });
  register({
    name: "close_its_modal",
    description:
      "Close the topmost visible ITS Maps modal, detail panel, or AI history sheet.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: {
      readOnlyHint: false,
    },
    execute: async () => {
      const before =
        await itsAnalyzeOpenModalContent({
          scroll: "none",
          maxItems: 4,
        });

      const closed = itsCloseTopmostModal();

      await itsDelay(260);

      const result = {
        closed,
        closedPanelId: before?.panelId || null,
        closedTitle: before?.title || null,
        remainingPanelId:
          itsFindTopmostOpenPanel()?.id || null,
      };

      return itsWebMcpContentResponse(
        closed
          ? "Modal teratas sudah ditutup."
          : "Tidak ada modal yang sedang terbuka.",
        result,
      );
    },
  });

  register({
    name: "analyze_its_modal",
    description:
      "Read and summarize the open ITS Maps modal, including active tab, AI history, metrics, text, and scroll state.",
    inputSchema: {
      type: "object",
      properties: {
        scroll: {
          type: "string",
          enum: [
            "none",
            "top",
            "bottom",
            "both",
          ],
        },
        maxItems: {
          type: "number",
          minimum: 1,
          maximum: 30,
        },
      },
    },
    annotations: {
      readOnlyHint: true,
    },
    execute: async (
      input: Record<string, unknown>,
    ) => {
      const requested =
        String(input.scroll || "both");

      const scroll: ItsModalScrollMode =
        ["none", "top", "bottom", "both"]
          .includes(requested)
          ? requested as ItsModalScrollMode
          : "both";

      const result =
        await itsAnalyzeOpenModalContent({
          scroll,
          maxItems:
            finiteNumber(input.maxItems) || 12,
        });

      if (!result) {
        return itsWebMcpContentResponse(
          "Tidak ada modal yang sedang terbuka.",
          { open: false },
        );
      }

      return itsWebMcpContentResponse(
        result.summary,
        {
          open: true,
          ...result,
        },
      );
    },
  });

  register({
    name: "scroll_its_modal",
    description:
      "Scroll the open ITS Maps modal to the top, bottom, or both directions.",
    inputSchema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["top", "bottom", "both"],
        },
        amount: {
          type: "number",
          minimum: 0.1,
          maximum: 1,
        },
      },
      required: ["direction"],
    },
    annotations: {
      readOnlyHint: false,
    },
    execute: async (
      input: Record<string, unknown>,
    ) => {
      const requested =
        String(input.direction || "both");

      const direction: ItsModalScrollMode =
        ["top", "bottom", "both"]
          .includes(requested)
          ? requested as ItsModalScrollMode
          : "both";

      const result = await itsScrollOpenModal(
        direction,
        finiteNumber(input.amount) || 0.9,
      );

      return itsWebMcpContentResponse(
        result.ok
          ? `Modal sudah digulir ke ${direction}.`
          : "Tidak ada modal yang sedang terbuka.",
        result,
      );
    },
  });

  register({
    name: "go_its_raspberry_home",
    description:
      "Close the blocking modal and center ITS Maps on the primary Raspberry Pi device.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: {
      readOnlyHint: false,
    },
    execute: async () => {
      const activePanel =
        itsFindTopmostOpenPanel()?.id || null;

      if (activePanel) {
        itsCloseTopmostModal();
        await itsDelay(260);
      }

      const result =
        itsRuntimeBridge().goHome?.();

      if (!result) {
        document
          .querySelector<HTMLButtonElement>(
            '[data-action="home"]',
          )
          ?.click();
      }

      return itsWebMcpContentResponse(
        "Peta sudah kembali ke lokasi Raspberry Pi utama.",
        {
          closedPanel: activePanel,
          ...(result || {
            ok: true,
            source: "home-button",
          }),
        },
      );
    },
  });

  register({
    name: "get_its_creator_profile",
    description:
      "Return the locally verified ITS Maps creator profile, photo, education, skills, and source links. No external search API is used.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: {
      readOnlyHint: true,
    },
    execute: async () => {
      return itsWebMcpContentResponse(
        `${ITS_CREATOR_PROFILE.name} — ${ITS_CREATOR_PROFILE.role}`,
        ITS_CREATOR_PROFILE,
      );
    },
  });

  register({
    name: "list_its_ai_skills",
    description:
      "List the client-side AI skills and models available in ITS Maps.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: {
      readOnlyHint: true,
    },
    execute: async () => {
      const result = {
        skills: [
          {
            name: "control",
            model: ITS_MODEL_IDS.control,
            function:
              "Memahami perintah ringan dan navigasi aplikasi.",
          },
          {
            name: "profile",
            model: "structured-local-data",
            function:
              "Membaca profil dan foto lokal yang sudah diverifikasi.",
          },
          {
            name: "research",
            model: ITS_MODEL_IDS.research,
            function:
              "Merangkum jurnal dan menjelaskan penurunan formulasi.",
          },
          {
            name: "vision",
            model: ITS_MODEL_IDS.vision,
            function:
              "Mendeteksi objek dan kendaraan pada gambar/video.",
          },
          {
            name: "modal",
            model: "DOM-analysis",
            function:
              "Menutup, menggulir, dan menganalisis modal.",
          },
        ],
        inferenceLocation: "browser-device",
        paidApiRequired: false,
      };

      return itsWebMcpContentResponse(
        JSON.stringify(result, null, 2),
        result,
      );
    },
  });
  publicResearchAgent.createWebMcpTools().forEach((tool) => register(tool as ItsWebMcpTool));
  return true;
}

function itsScheduleWebMcpRegistration(): void {
  let attempts = 0;
  const run = () => {
    const registered = itsRegisterWebMcpTools();
    attempts += 1;
    if (!registered && attempts < 10) {
      window.setTimeout(run, attempts < 3 ? 250 : 1000);
    }
  };
  run();
  window.addEventListener("load", run, { once: true });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) run();
  });
}

if (!staticRoute) {
  itsScheduleWebMcpRegistration();
  itsCreateAiChatButton();
  itsCreateSplash();
  itsCreateWindowsDownloadButton();
  const checkInstalledWindowsApp = () => window.setTimeout(() => {
    void queryItsWindowsAppInstallation().catch(() => undefined);
  }, 1_200);
  if (document.readyState === "complete") checkInstalledWindowsApp();
  else window.addEventListener("load", checkInstalledWindowsApp, { once: true });
}
