import "./style.css";

type BackendMode = "github-json" | "demo";
type DeviceStatus = "online" | "offline" | "degraded";
type CameraStatus = "online" | "offline" | "pending";
type EventSeverity = "info" | "good" | "warn" | "danger";

type DeviceRecord = {
  id: string;
  label: string;
  district: string;
  ip?: string;
  status: DeviceStatus;
  vehicles: number;
  congestion: number;
  speedKph: number;
  camera: CameraStatus;
  note?: string;
  lastSeen: number;
  position: { x: number; y: number };
  cameraTitle?: string;
  cameraThumbnailUrl?: string;
  cameraStreamUrl?: string;
};

type EventRecord = {
  id: string;
  time: number;
  label: string;
  detail: string;
  severity: EventSeverity;
  deviceId?: string;
};

type SnapshotDevice = Partial<Omit<DeviceRecord, "position">> & {
  position?: { x?: number; y?: number };
};

type Snapshot = {
  updatedAt?: number;
  source?: string;
  devices?: SnapshotDevice[];
  events?: Array<Partial<EventRecord>>;
};

type AppConfig = {
  snapshotUrl?: string;
  refreshMs?: number;
  githubRepo?: string;
  githubBranch?: string;
};

type FallbackState = {
  updatedAt: number;
  source: string;
  devices: DeviceRecord[];
  events: EventRecord[];
};

type AppState = {
  devices: DeviceRecord[];
  events: EventRecord[];
  backend: BackendMode;
  selectedId: string;
  updatedAt: number;
  config: Required<Pick<AppConfig, "snapshotUrl" | "refreshMs">>;
  refreshTimer: number;
  refreshBusy: boolean;
  filterQuery: string;
  detailOpen: boolean;
  cameraOpenDeviceId: string | null;
  zoom: number;
  mapOffsetX: number;
  mapOffsetY: number;
  dragging: boolean;
  dragStartX: number;
  dragStartY: number;
  dragOriginX: number;
  dragOriginY: number;
};

const WORLD = {
  width: 1600,
  height: 1100,
};

const FALLBACK: FallbackState = {
  updatedAt: 1777870000000,
  source: "demo",
  devices: [
    {
      id: "raspberry-its",
      label: "Raspberry Pi 5 Controller",
      district: "Koridor Utama ITS",
      ip: "10.176.37.67",
      status: "online",
      vehicles: 28,
      congestion: 62,
      speedKph: 31,
      camera: "pending",
      note: "controller aktif, kamera belum dipasang",
      lastSeen: 1777869995000,
      position: { x: 45.5, y: 46.5 },
      cameraTitle: "Controller preview",
    },
    {
      id: "edge-sensor-02",
      label: "Edge Sensor Timur",
      district: "Simpang Timur",
      ip: "10.176.37.82",
      status: "offline",
      vehicles: 9,
      congestion: 18,
      speedKph: 40,
      camera: "offline",
      note: "node cadangan belum online",
      lastSeen: 1777868880000,
      position: { x: 66.5, y: 32.5 },
      cameraTitle: "Koridor Timur camera",
    },
    {
      id: "camera-gate-01",
      label: "Camera Gate Selatan",
      district: "Gerbang Selatan",
      ip: "10.176.37.120",
      status: "degraded",
      vehicles: 41,
      congestion: 78,
      speedKph: 22,
      camera: "pending",
      note: "slot video realtime siap, menunggu device kamera",
      lastSeen: 1777869972000,
      position: { x: 38.5, y: 66.5 },
      cameraTitle: "Gate Selatan live cam",
    },
  ],
  events: [
    {
      id: "ev-1",
      time: 1777869820000,
      label: "Heartbeat Raspberry Pi",
      detail: "device raspberry-its mengirim status online",
      severity: "good",
      deviceId: "raspberry-its",
    },
    {
      id: "ev-2",
      time: 1777869600000,
      label: "Lonjakan kendaraan",
      detail: "koridor timur naik ke 78% congestion",
      severity: "warn",
      deviceId: "camera-gate-01",
    },
  ],
};

const DEFAULT_SELECTED_DEVICE = FALLBACK.devices[0]!;
const DEFAULT_CONFIG: Required<Pick<AppConfig, "snapshotUrl" | "refreshMs">> = {
  snapshotUrl: "./data/its-state.json",
  refreshMs: 5000,
};

const parcelBlocks = [
  { points: "140,120 430,90 560,180 430,300 170,260", kind: "slate" },
  { points: "600,110 870,96 1040,180 910,298 632,270", kind: "mist" },
  { points: "1085,115 1375,130 1465,290 1260,352 1055,265", kind: "slate" },
  { points: "150,330 430,300 520,430 360,548 130,500", kind: "light" },
  { points: "560,332 790,324 950,428 804,560 558,520", kind: "light" },
  { points: "1010,360 1412,330 1490,526 1180,615 1000,502", kind: "mist" },
  { points: "174,590 454,560 550,722 390,842 112,792", kind: "green" },
  { points: "604,618 848,585 980,725 840,880 600,852", kind: "slate" },
  { points: "1028,642 1422,620 1490,882 1266,950 1030,836", kind: "pink" },
];

const waterShapes = [
  "M 92 744 C 242 692, 394 730, 534 700 S 850 640, 1062 672 S 1320 768, 1508 738",
  "M 86 784 C 250 726, 394 760, 554 726 S 866 676, 1106 700 S 1324 790, 1516 758",
];

const majorRoads = [
  "M 90 214 C 320 170, 508 188, 688 228 S 1002 320, 1510 260",
  "M 64 354 C 278 318, 496 324, 690 384 S 1058 498, 1520 424",
  "M 118 546 C 350 494, 536 516, 724 586 S 1040 706, 1472 640",
  "M 118 872 C 306 808, 582 826, 768 872 S 1152 964, 1496 914",
  "M 332 96 C 282 278, 286 476, 344 672 S 420 954, 358 1048",
  "M 598 82 C 560 252, 570 454, 622 654 S 694 922, 654 1034",
  "M 870 110 C 846 266, 846 420, 878 612 S 948 864, 930 1044",
  "M 1184 124 C 1142 286, 1146 472, 1190 652 S 1256 896, 1236 1040",
];

const minorRoads = [
  "M 170 176 L 284 268 L 216 398",
  "M 456 196 L 586 248 L 546 408",
  "M 842 226 L 1018 274 L 1032 426",
  "M 1182 218 L 1338 246 L 1408 400",
  "M 210 472 L 480 470",
  "M 568 500 L 870 500",
  "M 934 540 L 1324 536",
  "M 260 676 L 506 694",
  "M 600 760 L 936 760",
  "M 1048 772 L 1378 770",
  "M 318 910 L 560 918",
  "M 918 922 L 1188 920",
  "M 250 318 L 350 210",
  "M 936 872 L 1068 760",
];

const districtLabels = [
  { title: "Koridor Barat", subtitle: "Node pemantauan", x: 21, y: 22 },
  { title: "Pusat ITS", subtitle: "Controller utama", x: 45, y: 37 },
  { title: "Koridor Timur", subtitle: "Edge monitoring", x: 72, y: 24 },
  { title: "Gerbang Selatan", subtitle: "Camera gate", x: 36, y: 74 },
  { title: "Sungai ITS", subtitle: "Batas operasional", x: 63, y: 63 },
];

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app element.");
}

function requiredElement<T extends Element>(selector: string, name: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${name}`);
  }
  return element;
}

app.innerHTML = `
  <div class="ops-shell">
    <div class="map-root">
      <header class="topbar">
        <section class="brand-panel glass-card">
          <p class="eyebrow">ITS live map</p>
          <h1>Raspberry operations map</h1>
          <p id="syncNote" class="brand-copy">menarik snapshot terbaru...</p>
        </section>

        <label class="search-panel glass-card" for="searchInput">
          <span class="search-glyph" aria-hidden="true"></span>
          <input id="searchInput" type="text" placeholder="Cari device Raspberry, district, atau IP" autocomplete="off" />
          <button id="clearSearchBtn" class="clear-btn" type="button">Reset</button>
        </label>

        <div class="action-panel">
          <button id="refreshBtn" class="action-btn primary" type="button">Refresh</button>
          <div id="backendBadge" class="backend-pill glass-card">GitHub JSON</div>
        </div>
      </header>

      <section class="map-surface" id="mapSurface" aria-label="ITS operations map">
        <div class="map-world" id="mapWorld">
          <svg class="map-svg" viewBox="0 0 1600 1100" aria-hidden="true">
            <g id="parcelLayer"></g>
            <g id="waterLayer"></g>
            <g id="minorRoadLayer"></g>
            <g id="majorRoadLayer"></g>
            <g id="districtLayer"></g>
          </svg>
          <div class="device-layer" id="deviceLayer"></div>
        </div>

        <div class="zoom-panel glass-card">
          <button id="zoomInBtn" class="zoom-btn" type="button" aria-label="Perbesar peta">+</button>
          <button id="zoomOutBtn" class="zoom-btn" type="button" aria-label="Perkecil peta">-</button>
          <button id="recenterBtn" class="zoom-btn wide" type="button">Center</button>
        </div>

        <div class="status-legend glass-card">
          <span><i class="legend-dot online"></i>Online</span>
          <span><i class="legend-dot degraded"></i>Degraded</span>
          <span><i class="legend-dot offline"></i>Offline</span>
        </div>
      </section>

      <aside class="side-rail">
        <section class="summary-panel glass-card">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Node summary</p>
              <h2>Kontrol Raspberry</h2>
            </div>
            <span id="syncAge" class="small-pill">demo</span>
          </div>

          <div class="summary-grid">
            <article class="summary-tile">
              <small>Device aktif</small>
              <strong id="activeDevices">0</strong>
              <span id="offlineDevices">0 offline</span>
            </article>
            <article class="summary-tile">
              <small>Jumlah kendaraan</small>
              <strong id="vehicleTotal">0</strong>
              <span>semua koridor</span>
            </article>
            <article class="summary-tile">
              <small>Rata-rata macet</small>
              <strong id="averageCongestion">0%</strong>
              <span>indikasi lalu lintas</span>
            </article>
            <article class="summary-tile">
              <small>Kamera siap</small>
              <strong id="cameraReady">0</strong>
              <span>preview / stream</span>
            </article>
          </div>
        </section>

        <section class="device-panel glass-card">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Device list</p>
              <h2>Node aktif</h2>
            </div>
            <span id="deviceCount" class="small-pill">0 node</span>
          </div>
          <div id="deviceList" class="device-list"></div>
        </section>

        <section class="event-panel glass-card">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Realtime feed</p>
              <h2>Traffic signal</h2>
            </div>
          </div>
          <div id="eventFeed" class="event-list"></div>
        </section>
      </aside>

      <section class="camera-rail glass-card">
        <div class="camera-rail-head">
          <div>
            <p class="eyebrow">Camera rail</p>
            <h2>Thumbnail dan stream</h2>
          </div>
          <span class="camera-note">klik thumbnail untuk membuka video realtime</span>
        </div>
        <div id="cameraRail" class="camera-strip"></div>
      </section>
    </div>

    <div id="deviceModalHost"></div>
    <div id="videoModalHost"></div>
  </div>
`;

const refs = {
  mapSurface: requiredElement<HTMLElement>("#mapSurface", "mapSurface"),
  mapWorld: requiredElement<HTMLElement>("#mapWorld", "mapWorld"),
  parcelLayer: requiredElement<SVGGElement>("#parcelLayer", "parcelLayer"),
  waterLayer: requiredElement<SVGGElement>("#waterLayer", "waterLayer"),
  minorRoadLayer: requiredElement<SVGGElement>("#minorRoadLayer", "minorRoadLayer"),
  majorRoadLayer: requiredElement<SVGGElement>("#majorRoadLayer", "majorRoadLayer"),
  districtLayer: requiredElement<SVGGElement>("#districtLayer", "districtLayer"),
  deviceLayer: requiredElement<HTMLElement>("#deviceLayer", "deviceLayer"),
  syncNote: requiredElement<HTMLElement>("#syncNote", "syncNote"),
  backendBadge: requiredElement<HTMLElement>("#backendBadge", "backendBadge"),
  searchInput: requiredElement<HTMLInputElement>("#searchInput", "searchInput"),
  clearSearchBtn: requiredElement<HTMLButtonElement>("#clearSearchBtn", "clearSearchBtn"),
  refreshBtn: requiredElement<HTMLButtonElement>("#refreshBtn", "refreshBtn"),
  zoomInBtn: requiredElement<HTMLButtonElement>("#zoomInBtn", "zoomInBtn"),
  zoomOutBtn: requiredElement<HTMLButtonElement>("#zoomOutBtn", "zoomOutBtn"),
  recenterBtn: requiredElement<HTMLButtonElement>("#recenterBtn", "recenterBtn"),
  syncAge: requiredElement<HTMLElement>("#syncAge", "syncAge"),
  activeDevices: requiredElement<HTMLElement>("#activeDevices", "activeDevices"),
  offlineDevices: requiredElement<HTMLElement>("#offlineDevices", "offlineDevices"),
  vehicleTotal: requiredElement<HTMLElement>("#vehicleTotal", "vehicleTotal"),
  averageCongestion: requiredElement<HTMLElement>("#averageCongestion", "averageCongestion"),
  cameraReady: requiredElement<HTMLElement>("#cameraReady", "cameraReady"),
  deviceCount: requiredElement<HTMLElement>("#deviceCount", "deviceCount"),
  deviceList: requiredElement<HTMLElement>("#deviceList", "deviceList"),
  eventFeed: requiredElement<HTMLElement>("#eventFeed", "eventFeed"),
  cameraRail: requiredElement<HTMLElement>("#cameraRail", "cameraRail"),
  deviceModalHost: requiredElement<HTMLElement>("#deviceModalHost", "deviceModalHost"),
  videoModalHost: requiredElement<HTMLElement>("#videoModalHost", "videoModalHost"),
};

const state: AppState = {
  devices: [...FALLBACK.devices],
  events: [...FALLBACK.events],
  backend: "github-json",
  selectedId: DEFAULT_SELECTED_DEVICE.id,
  updatedAt: FALLBACK.updatedAt,
  config: { ...DEFAULT_CONFIG },
  refreshTimer: 0,
  refreshBusy: false,
  filterQuery: "",
  detailOpen: false,
  cameraOpenDeviceId: null,
  zoom: 1,
  mapOffsetX: 0,
  mapOffsetY: 0,
  dragging: false,
  dragStartX: 0,
  dragStartY: 0,
  dragOriginX: 0,
  dragOriginY: 0,
};

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function n(value: number): string {
  return new Intl.NumberFormat("id-ID").format(value);
}

function ago(ms: number): string {
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1000))} detik lalu`;
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))} menit lalu`;
  return `${Math.max(1, Math.round(delta / 3_600_000))} jam lalu`;
}

function timeLabel(ms: number): string {
  return new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeDeviceStatus(value: unknown, fallback: DeviceStatus): DeviceStatus {
  if (typeof value !== "string") return fallback;
  const normalized = value.toLowerCase();
  if (normalized === "online" || normalized === "offline" || normalized === "degraded") {
    return normalized;
  }
  return fallback;
}

function normalizeCameraStatus(value: unknown, fallback: CameraStatus): CameraStatus {
  if (typeof value !== "string") return fallback;
  const normalized = value.toLowerCase();
  if (normalized === "online" || normalized === "offline" || normalized === "pending") {
    return normalized;
  }
  return fallback;
}

function deviceStatusLabel(status: DeviceStatus): string {
  if (status === "online") return "online";
  if (status === "offline") return "offline";
  return "degraded";
}

function cameraStatusLabel(status: CameraStatus): string {
  if (status === "online") return "kamera online";
  if (status === "offline") return "kamera offline";
  return "kamera pending";
}

function cameraSummary(device: DeviceRecord): string {
  if (device.camera === "online" && device.cameraStreamUrl) {
    return "stream realtime siap";
  }
  if (device.camera === "online") {
    return "kamera online, stream belum terhubung";
  }
  if (device.camera === "offline") {
    return "kamera offline";
  }
  return "kamera belum dipasang";
}

function selectedDevice(): DeviceRecord {
  return state.devices.find((device) => device.id === state.selectedId) ?? state.devices[0] ?? DEFAULT_SELECTED_DEVICE;
}

function fallbackDeviceAt(index: number): DeviceRecord {
  return FALLBACK.devices[index % FALLBACK.devices.length] ?? DEFAULT_SELECTED_DEVICE;
}

function findDevice(id: string): DeviceRecord | undefined {
  return state.devices.find((device) => device.id === id);
}

function deviceMatchesFilter(device: DeviceRecord): boolean {
  const query = state.filterQuery.trim().toLowerCase();
  if (!query) return true;
  return [device.id, device.label, device.district, device.ip || ""].some((field) => field.toLowerCase().includes(query));
}

function sortByCameraPriority(devices: DeviceRecord[]): DeviceRecord[] {
  const score = (device: DeviceRecord): number => {
    if (device.camera === "online" && device.cameraStreamUrl) return 0;
    if (device.camera === "online") return 1;
    if (device.camera === "pending") return 2;
    return 3;
  };

  return [...devices].sort((left, right) => score(left) - score(right));
}

function focusDevice(device: DeviceRecord): void {
  const targetX = window.innerWidth >= 1200 ? 0.39 : 0.5;
  const targetY = window.innerWidth >= 1200 ? 0.54 : 0.5;
  state.mapOffsetX = clamp((targetX - device.position.x / 100) * WORLD.width * state.zoom, -560, 560);
  state.mapOffsetY = clamp((targetY - device.position.y / 100) * WORLD.height * state.zoom, -360, 360);
}

function applyMapTransform(): void {
  refs.mapWorld.style.transform = `translate(${state.mapOffsetX}px, ${state.mapOffsetY}px) scale(${state.zoom})`;
  refs.mapSurface.classList.toggle("dragging", state.dragging);
}

function adjustZoom(delta: number): void {
  state.zoom = clamp(Number((state.zoom + delta).toFixed(2)), 1, 2.8);
  focusDevice(selectedDevice());
  render();
}

function recenterMap(): void {
  state.zoom = 1;
  state.mapOffsetX = 0;
  state.mapOffsetY = 0;
  render();
}

function renderCameraVisual(device: DeviceRecord, large: boolean): string {
  const title = esc(device.cameraTitle || `${device.label} camera`);
  if (device.cameraThumbnailUrl) {
    return `<img src="${esc(device.cameraThumbnailUrl)}" alt="${title}" class="${large ? "camera-media" : "camera-thumb-media"}" />`;
  }

  return `
    <div class="${large ? "camera-placeholder large" : "camera-placeholder"} ${device.camera}">
      <span class="camera-placeholder-label">${title}</span>
      <strong>${esc(cameraSummary(device))}</strong>
      <small>slot preview siap untuk Raspberry camera</small>
    </div>
  `;
}

function renderDeviceModal(device: DeviceRecord): string {
  return `
    <div class="modal-backdrop" id="deviceModalBackdrop">
      <article class="device-modal" role="dialog" aria-modal="true" aria-labelledby="deviceModalTitle">
        <button class="modal-close" type="button" data-close="detail" aria-label="Tutup detail device">×</button>

        <div class="device-modal-head">
          <div>
            <p class="eyebrow">Device detail</p>
            <h2 id="deviceModalTitle">${esc(device.label)}</h2>
            <p class="device-modal-subtitle">ID Raspberry: <strong>${esc(device.id)}</strong></p>
          </div>
          <span class="status-pill ${device.status}">${esc(deviceStatusLabel(device.status))}</span>
        </div>

        <div class="device-modal-grid">
          <section class="device-detail-panel">
            <div class="detail-grid">
              <div><span>ID</span><strong>${esc(device.id)}</strong></div>
              <div><span>Status</span><strong>${esc(deviceStatusLabel(device.status))}</strong></div>
              <div><span>District</span><strong>${esc(device.district)}</strong></div>
              <div><span>IP</span><strong>${esc(device.ip || "-")}</strong></div>
              <div><span>Last seen</span><strong>${esc(ago(device.lastSeen))}</strong></div>
              <div><span>Kamera</span><strong>${esc(cameraStatusLabel(device.camera))}</strong></div>
            </div>

            <div class="metric-strip">
              <article><small>Kendaraan</small><strong>${n(device.vehicles)}</strong></article>
              <article><small>Congestion</small><strong>${device.congestion}%</strong></article>
              <article><small>Speed</small><strong>${device.speedKph} km/jam</strong></article>
            </div>

            <p class="detail-note">${esc(device.note || "Device aktif tanpa catatan tambahan.")}</p>

            <div class="detail-actions">
              <button class="action-btn primary" type="button" data-open-camera="${esc(device.id)}">Buka video realtime</button>
              <button class="action-btn ghost" type="button" data-focus-id="${esc(device.id)}">Fokus di peta</button>
            </div>
          </section>

          <section class="camera-preview-panel">
            <div class="camera-preview-head">
              <div>
                <p class="eyebrow">Camera preview</p>
                <h3>${esc(device.cameraTitle || `${device.label} camera`)}</h3>
              </div>
              <span class="camera-state ${device.camera}">${esc(cameraStatusLabel(device.camera))}</span>
            </div>
            <div class="camera-preview-shell">
              ${renderCameraVisual(device, true)}
            </div>
            <p class="camera-hint">${esc(cameraSummary(device))}. Saat device kamera Raspberry aktif, isi thumbnail dan stream video di JSON agar modal ini langsung menampilkan live feed.</p>
          </section>
        </div>
      </article>
    </div>
  `;
}

function renderVideoModal(device: DeviceRecord): string {
  const title = esc(device.cameraTitle || `${device.label} camera`);
  const hasLiveVideo = Boolean(device.cameraStreamUrl);
  const media = hasLiveVideo
    ? `<video class="video-frame" src="${esc(device.cameraStreamUrl || "")}" controls autoplay muted playsinline></video>`
    : renderCameraVisual(device, true);

  const helper = hasLiveVideo
    ? "video realtime dari kamera Raspberry"
    : `${esc(cameraSummary(device))}. Isi cameraStreamUrl saat stream kamera sudah tersedia.`;

  return `
    <div class="modal-backdrop" id="videoModalBackdrop">
      <article class="video-modal" role="dialog" aria-modal="true" aria-labelledby="videoModalTitle">
        <button class="modal-close" type="button" data-close="video" aria-label="Tutup video">×</button>

        <div class="video-modal-head">
          <div>
            <p class="eyebrow">Realtime camera</p>
            <h2 id="videoModalTitle">${title}</h2>
            <p class="device-modal-subtitle">${esc(device.label)} · ${esc(device.id)}</p>
          </div>
          <span class="camera-state ${device.camera}">${esc(cameraStatusLabel(device.camera))}</span>
        </div>

        <div class="video-shell">
          ${media}
        </div>
        <p class="video-hint">${helper}</p>
      </article>
    </div>
  `;
}

function renderBackground(): void {
  refs.parcelLayer.innerHTML = parcelBlocks
    .map((block) => `<polygon points="${block.points}" class="parcel parcel-${block.kind}" />`)
    .join("");

  refs.waterLayer.innerHTML = waterShapes.map((path) => `<path d="${path}" class="waterway" />`).join("");
  refs.minorRoadLayer.innerHTML = minorRoads.map((path) => `<path d="${path}" class="minor-road" />`).join("");
  refs.majorRoadLayer.innerHTML = majorRoads.map((path) => `<path d="${path}" class="major-road" />`).join("");
  refs.districtLayer.innerHTML = districtLabels
    .map((label) => `
      <g transform="translate(${label.x * 16}, ${label.y * 11})" class="district-marker">
        <rect x="-84" y="-28" width="168" height="54" rx="18" class="district-chip"></rect>
        <text x="0" y="-2" text-anchor="middle" class="district-title">${esc(label.title)}</text>
        <text x="0" y="18" text-anchor="middle" class="district-subtitle">${esc(label.subtitle)}</text>
      </g>
    `)
    .join("");
}

function render(): void {
  const allDevices = state.devices;
  const visibleDevices = allDevices.filter(deviceMatchesFilter);
  const cameraDevices = sortByCameraPriority(visibleDevices);
  const active = allDevices.filter((device) => device.status !== "offline").length;
  const offline = allDevices.length - active;
  const vehicleTotal = allDevices.reduce((sum, device) => sum + device.vehicles, 0);
  const averageCongestion = allDevices.length
    ? Math.round(allDevices.reduce((sum, device) => sum + device.congestion, 0) / allDevices.length)
    : 0;
  const cameraReady = allDevices.filter((device) => device.camera === "online").length;
  const currentDevice = selectedDevice();

  refs.syncNote.textContent = state.refreshBusy
    ? "menarik snapshot terbaru dari JSON..."
    : `sinkron ${ago(state.updatedAt)} · klik marker untuk membuka modal device`;
  refs.backendBadge.textContent = state.backend === "github-json" ? "GitHub JSON" : "Demo mode";
  refs.syncAge.textContent = state.backend === "github-json" ? `live / ${Math.round(state.config.refreshMs / 1000)}s` : "demo";
  refs.activeDevices.textContent = String(active);
  refs.offlineDevices.textContent = `${offline} offline`;
  refs.vehicleTotal.textContent = n(vehicleTotal);
  refs.averageCongestion.textContent = `${averageCongestion}%`;
  refs.cameraReady.textContent = String(cameraReady);
  refs.deviceCount.textContent = `${visibleDevices.length} node`;
  refs.searchInput.value = state.filterQuery;

  refs.deviceLayer.innerHTML = visibleDevices
    .map((device) => `
      <button
        class="device-marker ${device.status} ${device.id === state.selectedId ? "selected" : ""}"
        type="button"
        data-id="${esc(device.id)}"
        style="left:${device.position.x}%; top:${device.position.y}%"
      >
        <span class="marker-pin"><i></i></span>
        <span class="marker-card">
          <strong>${esc(device.label)}</strong>
          <small>${esc(device.id)} · ${esc(deviceStatusLabel(device.status))}</small>
        </span>
      </button>
    `)
    .join("");

  refs.deviceList.innerHTML = visibleDevices.length
    ? visibleDevices
        .map((device) => `
          <button class="device-card ${device.id === state.selectedId ? "selected" : ""}" type="button" data-id="${esc(device.id)}">
            <div class="device-card-top">
              <div>
                <strong>${esc(device.label)}</strong>
                <p>${esc(device.district)}</p>
              </div>
              <span class="status-pill ${device.status}">${esc(deviceStatusLabel(device.status))}</span>
            </div>
            <div class="device-card-id">ID ${esc(device.id)}</div>
            <div class="device-card-meta">
              <span>${esc(device.ip || "-")}</span>
              <span>${n(device.vehicles)} kendaraan</span>
              <span>${device.speedKph} km/jam</span>
            </div>
            <div class="device-card-foot">
              <span>${esc(cameraStatusLabel(device.camera))}</span>
              <span>${esc(ago(device.lastSeen))}</span>
            </div>
          </button>
        `)
        .join("")
    : `<div class="empty-state">Tidak ada device yang cocok dengan pencarian.</div>`;

  refs.eventFeed.innerHTML = state.events.length
    ? state.events
        .slice()
        .sort((left, right) => right.time - left.time)
        .slice(0, 5)
        .map((event) => `
          <article class="event-row">
            <div class="event-dot ${event.severity}"></div>
            <div class="event-copy">
              <div class="event-row-head">
                <strong>${esc(event.label)}</strong>
                <time>${timeLabel(event.time)}</time>
              </div>
              <p>${esc(event.detail)}</p>
            </div>
          </article>
        `)
        .join("")
    : `<div class="empty-state">Belum ada event traffic.</div>`;

  refs.cameraRail.innerHTML = cameraDevices.length
    ? cameraDevices
        .map((device) => `
          <button class="camera-card ${device.camera}" type="button" data-camera-id="${esc(device.id)}">
            <div class="camera-card-media">
              ${renderCameraVisual(device, false)}
            </div>
            <div class="camera-card-copy">
              <strong>${esc(device.cameraTitle || `${device.label} camera`)}</strong>
              <p>${esc(device.label)}</p>
              <span>${esc(cameraSummary(device))}</span>
            </div>
          </button>
        `)
        .join("")
    : `<div class="empty-state wide">Belum ada node kamera yang cocok dengan filter.</div>`;

  refs.deviceModalHost.innerHTML = state.detailOpen ? renderDeviceModal(currentDevice) : "";
  refs.videoModalHost.innerHTML = state.cameraOpenDeviceId && findDevice(state.cameraOpenDeviceId)
    ? renderVideoModal(findDevice(state.cameraOpenDeviceId)!)
    : "";

  applyMapTransform();
  bindDynamicInteractions();
}

function bindDynamicInteractions(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-id]").forEach((button) => {
    button.onclick = () => {
      const id = button.dataset.id;
      if (!id) return;
      const device = findDevice(id);
      if (!device) return;
      state.selectedId = id;
      state.detailOpen = true;
      focusDevice(device);
      render();
    };
  });

  document.querySelectorAll<HTMLButtonElement>("[data-camera-id]").forEach((button) => {
    button.onclick = () => {
      const id = button.dataset.cameraId;
      if (!id) return;
      const device = findDevice(id);
      if (!device) return;
      state.selectedId = id;
      state.cameraOpenDeviceId = id;
      focusDevice(device);
      render();
    };
  });

  document.querySelectorAll<HTMLButtonElement>("[data-open-camera]").forEach((button) => {
    button.onclick = () => {
      const id = button.dataset.openCamera;
      if (!id) return;
      state.cameraOpenDeviceId = id;
      render();
    };
  });

  document.querySelectorAll<HTMLButtonElement>("[data-focus-id]").forEach((button) => {
    button.onclick = () => {
      const id = button.dataset.focusId;
      if (!id) return;
      const device = findDevice(id);
      if (!device) return;
      state.selectedId = id;
      focusDevice(device);
      state.detailOpen = false;
      render();
    };
  });

  document.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((button) => {
    button.onclick = () => {
      const mode = button.dataset.close;
      if (mode === "detail") {
        state.detailOpen = false;
      }
      if (mode === "video") {
        state.cameraOpenDeviceId = null;
      }
      render();
    };
  });

  const deviceModalBackdrop = document.querySelector<HTMLElement>("#deviceModalBackdrop");
  if (deviceModalBackdrop) {
    deviceModalBackdrop.onclick = (event) => {
      if (event.target === deviceModalBackdrop) {
        state.detailOpen = false;
        render();
      }
    };
  }

  const videoModalBackdrop = document.querySelector<HTMLElement>("#videoModalBackdrop");
  if (videoModalBackdrop) {
    videoModalBackdrop.onclick = (event) => {
      if (event.target === videoModalBackdrop) {
        state.cameraOpenDeviceId = null;
        render();
      }
    };
  }
}

function bindShellEvents(): void {
  refs.searchInput.addEventListener("input", () => {
    state.filterQuery = refs.searchInput.value.trim();
    render();
  });

  refs.clearSearchBtn.addEventListener("click", () => {
    state.filterQuery = "";
    refs.searchInput.value = "";
    render();
  });

  refs.refreshBtn.addEventListener("click", () => {
    void loadSnapshot();
  });

  refs.zoomInBtn.addEventListener("click", () => {
    adjustZoom(0.18);
  });

  refs.zoomOutBtn.addEventListener("click", () => {
    adjustZoom(-0.18);
  });

  refs.recenterBtn.addEventListener("click", () => {
    recenterMap();
  });

  refs.mapSurface.addEventListener("wheel", (event) => {
    event.preventDefault();
    adjustZoom(event.deltaY < 0 ? 0.14 : -0.14);
  }, { passive: false });

  refs.mapSurface.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest("[data-id]")) return;

    state.dragging = true;
    state.dragStartX = event.clientX;
    state.dragStartY = event.clientY;
    state.dragOriginX = state.mapOffsetX;
    state.dragOriginY = state.mapOffsetY;
    refs.mapSurface.setPointerCapture(event.pointerId);
    applyMapTransform();
  });

  window.addEventListener("pointermove", (event) => {
    if (!state.dragging) return;
    state.mapOffsetX = clamp(state.dragOriginX + event.clientX - state.dragStartX, -600, 600);
    state.mapOffsetY = clamp(state.dragOriginY + event.clientY - state.dragStartY, -420, 420);
    applyMapTransform();
  });

  window.addEventListener("pointerup", () => {
    if (!state.dragging) return;
    state.dragging = false;
    applyMapTransform();
  });

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const hadOpenModal = state.detailOpen || Boolean(state.cameraOpenDeviceId);
    state.detailOpen = false;
    state.cameraOpenDeviceId = null;
    if (hadOpenModal) {
      render();
    }
  });

  window.addEventListener("beforeunload", () => {
    window.clearInterval(state.refreshTimer);
  });
}

async function loadSnapshot(): Promise<void> {
  if (state.refreshBusy) {
    return;
  }

  state.refreshBusy = true;
  render();

  try {
    const configResponse = await fetch("./data/its-config.json", { cache: "no-store" });
    if (configResponse.ok) {
      const config = (await configResponse.json()) as Partial<AppConfig>;
      state.config = {
        ...DEFAULT_CONFIG,
        ...config,
      };
    } else {
      state.config = { ...DEFAULT_CONFIG };
    }

    const response = await fetch(state.config.snapshotUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("snapshot not found");
    }

    const snapshot = (await response.json()) as Snapshot;
    if (Array.isArray(snapshot.devices) && snapshot.devices.length) {
      state.devices = snapshot.devices.map((device, index) => {
        const fallbackDevice = fallbackDeviceAt(index);
        return {
          id: String(device.id || fallbackDevice.id),
          label: String(device.label || fallbackDevice.label),
          district: String(device.district || fallbackDevice.district),
          ip: String(device.ip || fallbackDevice.ip || ""),
          status: normalizeDeviceStatus(device.status, fallbackDevice.status),
          vehicles: Number(device.vehicles ?? fallbackDevice.vehicles),
          congestion: Number(device.congestion ?? fallbackDevice.congestion),
          speedKph: Number(device.speedKph ?? fallbackDevice.speedKph),
          camera: normalizeCameraStatus(device.camera, fallbackDevice.camera),
          note: String(device.note || fallbackDevice.note || ""),
          lastSeen: Number(device.lastSeen ?? Date.now()),
          position: {
            x: Number(device.position?.x ?? fallbackDevice.position.x),
            y: Number(device.position?.y ?? fallbackDevice.position.y),
          },
          cameraTitle: String(device.cameraTitle || fallbackDevice.cameraTitle || ""),
          cameraThumbnailUrl: String(device.cameraThumbnailUrl || ""),
          cameraStreamUrl: String(device.cameraStreamUrl || ""),
        };
      });
    } else {
      state.devices = [...FALLBACK.devices];
    }

    if (Array.isArray(snapshot.events) && snapshot.events.length) {
      state.events = snapshot.events.map((event, index) => ({
        id: String(event.id || `event_${index}_${Date.now()}`),
        time: Number(event.time ?? Date.now()),
        label: String(event.label || "Event"),
        detail: String(event.detail || ""),
        severity: (event.severity === "good" || event.severity === "warn" || event.severity === "danger" || event.severity === "info")
          ? event.severity
          : "info",
        deviceId: String(event.deviceId || ""),
      }));
    } else {
      state.events = [...FALLBACK.events];
    }

    state.backend = "github-json";
    state.updatedAt = Number(snapshot.updatedAt || Date.now());
  } catch {
    state.backend = "demo";
    state.updatedAt = Date.now();
    state.devices = [...FALLBACK.devices];
    state.events = [...FALLBACK.events];
  }

  if (!state.devices.some((device) => device.id === state.selectedId)) {
    state.selectedId = state.devices[0]?.id || DEFAULT_SELECTED_DEVICE.id;
  }

  window.clearInterval(state.refreshTimer);
  state.refreshTimer = window.setInterval(() => {
    void loadSnapshot();
  }, state.config.refreshMs);

  state.refreshBusy = false;
  render();
}

renderBackground();
bindShellEvents();
render();
void loadSnapshot();
