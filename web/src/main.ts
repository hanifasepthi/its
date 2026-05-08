import "./style.css";

type DeviceStatus = "online" | "offline" | "degraded";

type DeviceRecord = {
  id: string;
  label: string;
  status: DeviceStatus;
  lastSeen: number;
  note?: string;
  position: { x: number; y: number };
};

type SnapshotDevice = Partial<DeviceRecord> & {
  position?: Partial<DeviceRecord["position"]>;
};

type Snapshot = {
  updatedAt?: number;
  source?: string;
  devices?: SnapshotDevice[];
};

type AppConfig = {
  snapshotUrl?: string;
  refreshMs?: number;
};

const DEFAULT_CONFIG: Required<AppConfig> = {
  snapshotUrl: "./data/its-state.json",
  refreshMs: 5000,
};

const EMPTY_DEVICE: DeviceRecord = {
  id: "raspberry-its",
  label: "Raspberry Pi 5 Controller",
  status: "offline",
  lastSeen: 0,
  note: "snapshot belum tersedia",
  position: { x: 54.8, y: 48.5 },
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app element.");
}

app.innerHTML = `
  <div class="shell">
    <section class="map-frame" id="mapFrame" aria-label="ITS realtime map">
      <div class="map-topbar glass-card">
        <div>
          <p class="eyebrow">ITS realtime map</p>
          <h1>Raspberry Pi marker</h1>
          <p id="syncNote" class="topbar-copy">menarik snapshot terbaru...</p>
        </div>
        <div class="topbar-actions">
          <span id="syncBadge" class="pill">loading</span>
          <button id="refreshBtn" class="refresh-btn" type="button">Refresh</button>
        </div>
      </div>

      <svg class="map-svg" viewBox="0 0 1600 1100" aria-hidden="true">
        <g id="terrainLayer"></g>
        <g id="waterLayer"></g>
        <g id="roadLayer"></g>
        <g id="labelLayer"></g>
      </svg>

      <div id="markerLayer" class="marker-layer"></div>
      <div id="popupLayer" class="popup-layer" aria-live="polite"></div>

      <div class="map-footer glass-card">
        <span id="mapStatus">status marker menunggu data realtime</span>
        <span>OpenStreetMap style • ITS Telkom University</span>
      </div>
    </section>
  </div>
`;

const refs = {
  mapFrame: requiredElement<HTMLElement>("#mapFrame", "mapFrame"),
  terrainLayer: requiredElement<SVGGElement>("#terrainLayer", "terrainLayer"),
  waterLayer: requiredElement<SVGGElement>("#waterLayer", "waterLayer"),
  roadLayer: requiredElement<SVGGElement>("#roadLayer", "roadLayer"),
  labelLayer: requiredElement<SVGGElement>("#labelLayer", "labelLayer"),
  markerLayer: requiredElement<HTMLDivElement>("#markerLayer", "markerLayer"),
  popupLayer: requiredElement<HTMLDivElement>("#popupLayer", "popupLayer"),
  syncNote: requiredElement<HTMLElement>("#syncNote", "syncNote"),
  syncBadge: requiredElement<HTMLElement>("#syncBadge", "syncBadge"),
  mapStatus: requiredElement<HTMLElement>("#mapStatus", "mapStatus"),
  refreshBtn: requiredElement<HTMLButtonElement>("#refreshBtn", "refreshBtn"),
};

const parcelBlocks = [
  { points: "148,128 418,96 570,186 438,302 176,258", kind: "slate" },
  { points: "612,112 882,100 1038,188 908,306 634,272", kind: "mist" },
  { points: "1084,124 1368,138 1454,292 1258,354 1048,270", kind: "slate" },
  { points: "152,334 422,304 520,436 356,552 132,500", kind: "light" },
  { points: "558,334 790,324 948,430 804,560 556,520", kind: "light" },
  { points: "1012,360 1412,334 1488,526 1180,616 1000,504", kind: "mist" },
  { points: "176,592 458,560 550,724 392,844 112,794", kind: "green" },
  { points: "608,616 852,588 980,726 840,880 602,852", kind: "slate" },
  { points: "1028,642 1422,620 1490,882 1266,950 1030,836", kind: "pink" },
];

const waterShapes = [
  "M 90 746 C 250 694, 398 732, 542 700 S 854 642, 1062 674 S 1320 770, 1510 740",
  "M 86 786 C 250 728, 396 762, 556 728 S 868 678, 1108 702 S 1324 792, 1516 760",
];

const majorRoads = [
  "M 92 216 C 320 170, 508 190, 688 230 S 1004 322, 1510 262",
  "M 66 356 C 280 320, 496 326, 692 386 S 1058 500, 1520 426",
  "M 120 548 C 352 496, 538 518, 726 588 S 1040 708, 1472 642",
  "M 118 874 C 306 810, 582 828, 768 874 S 1152 966, 1496 916",
  "M 332 98 C 282 280, 286 478, 344 674 S 420 956, 358 1048",
  "M 600 84 C 562 254, 572 456, 624 656 S 696 924, 656 1036",
  "M 870 112 C 846 268, 846 422, 878 614 S 948 866, 930 1046",
  "M 1184 126 C 1142 288, 1146 474, 1190 654 S 1256 898, 1236 1042",
];

const minorRoads = [
  "M 170 178 L 284 270 L 216 400",
  "M 456 198 L 586 250 L 546 410",
  "M 842 228 L 1018 276 L 1032 428",
  "M 1182 220 L 1338 248 L 1408 402",
  "M 210 474 L 480 472",
  "M 568 502 L 870 502",
  "M 934 542 L 1324 538",
  "M 260 678 L 506 696",
  "M 600 762 L 936 762",
  "M 1048 774 L 1378 772",
  "M 318 912 L 560 920",
  "M 918 924 L 1188 922",
  "M 250 320 L 350 212",
  "M 936 874 L 1068 762",
];

const labels = [
  { title: "Koridor Barat", subtitle: "Area operasional", x: 21, y: 22 },
  { title: "Pusat ITS", subtitle: "Marker utama", x: 45, y: 37 },
  { title: "Koridor Timur", subtitle: "Pengamatan lapangan", x: 72, y: 24 },
  { title: "Gerbang Selatan", subtitle: "Akses kamera", x: 36, y: 74 },
  { title: "Sungai ITS", subtitle: "Batas visual", x: 63, y: 63 },
];

const state = {
  config: DEFAULT_CONFIG,
  device: null as DeviceRecord | null,
  updatedAt: 0,
  popupVisible: false,
  popupX: EMPTY_DEVICE.position.x,
  popupY: EMPTY_DEVICE.position.y,
  refreshTimer: 0,
  refreshBusy: false,
};

function requiredElement<T extends Element>(selector: string, name: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${name}`);
  }
  return element;
}

function isDeviceStatus(value: unknown): value is DeviceStatus {
  return value === "online" || value === "offline" || value === "degraded";
}

function normalizeDevice(snapshot: Snapshot): DeviceRecord {
  const raw = snapshot.devices?.[0];
  if (!raw) {
    return EMPTY_DEVICE;
  }

  const positionX = clamp(raw.position?.x ?? EMPTY_DEVICE.position.x, 4, 96);
  const positionY = clamp(raw.position?.y ?? EMPTY_DEVICE.position.y, 4, 96);

  return {
    id: raw.id?.trim() || EMPTY_DEVICE.id,
    label: raw.label?.trim() || EMPTY_DEVICE.label,
    status: isDeviceStatus(raw.status) ? raw.status : EMPTY_DEVICE.status,
    lastSeen: typeof raw.lastSeen === "number" ? raw.lastSeen : 0,
    note: raw.note?.trim() || EMPTY_DEVICE.note,
    position: { x: positionX, y: positionY },
  };
}

function hasRealSnapshot(device: DeviceRecord | null): device is DeviceRecord {
  return Boolean(device && device.lastSeen > 0 && device.note !== "snapshot belum tersedia");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatTime(value: number): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function statusLabel(status: DeviceStatus): string {
  if (status === "online") return "online";
  if (status === "offline") return "offline";
  return "degraded";
}

function renderTerrain(): void {
  refs.terrainLayer.innerHTML = parcelBlocks
    .map(
      ({ points, kind }) =>
        `<path class="parcel parcel-${kind}" d="M ${points} Z"></path>`,
    )
    .join("");

  refs.waterLayer.innerHTML = waterShapes
    .map((path) => `<path class="waterway" d="${path}"></path>`)
    .join("");

  refs.roadLayer.innerHTML = [
    ...majorRoads.map((path) => `<path class="major-road" d="${path}"></path>`),
    ...minorRoads.map((path) => `<path class="minor-road" d="${path}"></path>`),
  ].join("");

  refs.labelLayer.innerHTML = labels
    .map(
      ({ title, subtitle, x, y }) => `
        <g transform="translate(${x * 16}, ${y * 10})">
          <rect class="label-chip" x="-10" y="-32" rx="18" ry="18" width="220" height="58"></rect>
          <text class="label-title" x="10" y="-5">${title}</text>
          <text class="label-subtitle" x="10" y="16">${subtitle}</text>
        </g>
      `,
    )
    .join("");
}

function renderMarker(): void {
  refs.markerLayer.innerHTML = "";

  if (!state.device) {
    return;
  }

  const marker = document.createElement("button");
  marker.type = "button";
  marker.className = `device-marker device-${state.device.status}`;
  marker.style.left = `${state.device.position.x}%`;
  marker.style.top = `${state.device.position.y}%`;
  marker.setAttribute("aria-label", `Buka status ${state.device.id}`);
  marker.innerHTML = `
    <span class="marker-pin"><span class="marker-core"></span></span>
    <span class="marker-tag">Raspberry Pi</span>
  `;

  marker.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePopup(true);
  });

  refs.markerLayer.appendChild(marker);
}

function renderPopup(): void {
  refs.popupLayer.innerHTML = "";

  if (!state.popupVisible || !state.device) {
    return;
  }

  const popup = document.createElement("div");
  popup.className = `device-popup device-${state.device.status}`;
  popup.style.left = `${clamp(state.popupX + 2, 4, 88)}%`;
  popup.style.top = `${clamp(state.popupY - 14, 6, 86)}%`;
  popup.innerHTML = `
    <div class="popup-head">
      <strong>${state.device.id}</strong>
      <span class="status-badge">${statusLabel(state.device.status)}</span>
    </div>
    <p class="popup-line">Status: <strong>${statusLabel(state.device.status)}</strong></p>
    <p class="popup-line">Last seen: <strong>${formatTime(state.device.lastSeen)}</strong></p>
    <button id="closePopupBtn" class="popup-close" type="button">Tutup</button>
  `;

  popup.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  refs.popupLayer.appendChild(popup);
  requiredElement<HTMLButtonElement>("#closePopupBtn", "closePopupBtn").addEventListener("click", () => {
    togglePopup(false);
  });
}

function togglePopup(open: boolean): void {
  state.popupVisible = open;
  renderPopup();
}

function renderHeader(): void {
  if (!state.device) {
    refs.syncBadge.textContent = "waiting";
    refs.syncBadge.className = "pill";
    refs.syncNote.textContent = "menunggu snapshot dari Raspberry Pi...";
    refs.mapStatus.textContent = "snapshot Pi belum tersedia";
    return;
  }

  refs.syncBadge.textContent = state.device.status;
  refs.syncBadge.className = `pill ${state.device.status}`;
  refs.syncNote.textContent = `device ${state.device.id} • ${formatTime(state.updatedAt)}`;
  refs.mapStatus.textContent = `${state.device.id} • ${state.device.status} • ${state.device.note ?? ""}`.trim();
}

function renderAll(): void {
  renderHeader();
  renderTerrain();
  renderMarker();
  renderPopup();
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function refreshSnapshot(): Promise<void> {
  if (state.refreshBusy) {
    return;
  }

  state.refreshBusy = true;
  const shouldKeepPopupOpen = state.popupVisible;
  try {
    const config = await fetchJson<AppConfig>("./data/its-config.json");
    state.config = {
      snapshotUrl: config.snapshotUrl?.trim() || DEFAULT_CONFIG.snapshotUrl,
      refreshMs: config.refreshMs && config.refreshMs > 0 ? config.refreshMs : DEFAULT_CONFIG.refreshMs,
    };

    const snapshot = await fetchJson<Snapshot>(state.config.snapshotUrl);
    state.device = normalizeDevice(snapshot);
    state.updatedAt = snapshot.updatedAt ?? state.device.lastSeen;
    state.popupX = state.device.position.x;
    state.popupY = state.device.position.y;
    refs.syncBadge.textContent = hasRealSnapshot(state.device) ? "live" : "waiting";
    refs.syncNote.textContent = hasRealSnapshot(state.device)
      ? `sinkron dari GitHub JSON • ${formatTime(state.updatedAt)}`
      : "menunggu snapshot dari Raspberry Pi...";
  } catch {
    state.device = null;
    state.updatedAt = 0;
    refs.syncBadge.textContent = "offline";
    refs.syncNote.textContent = "snapshot Raspberry Pi tidak bisa diambil";
  } finally {
    state.refreshBusy = false;
    state.popupVisible = shouldKeepPopupOpen;
    renderAll();
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(refreshSnapshot, state.config.refreshMs);
  }
}

refs.refreshBtn.addEventListener("click", () => {
  void refreshSnapshot();
});

refs.mapFrame.addEventListener("click", () => {
  togglePopup(false);
});

renderAll();
void refreshSnapshot();
