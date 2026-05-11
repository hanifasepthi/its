import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-rotate";
import "./style.css";

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

type DeviceStatus = "online" | "offline" | "degraded";

type DeviceRecord = {
  id: string;
  label: string;
  status: DeviceStatus;
  lastSeen: number;
  lastSeenText?: string;
  note?: string;
  cameraUrl?: string;
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
type BaseMapMode = "street" | "satellite";

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_CONFIG: Required<AppConfig> = {
  snapshotUrl: "./data/its-state.json",
  refreshMs: 5000,
};

// FIX: DEFAULT_CENTER sekarang hanya sebagai fallback awal sebelum snapshot dimuat.
// Setelah snapshot dimuat, peta akan berpindah ke koordinat device pertama.
const DEFAULT_CENTER: L.LatLngExpression = [-7.280734, 112.794963];
const DEFAULT_ZOOM = 17;
const OFFLINE_AFTER_MS = 60_000;

const BEARING_STEP = 90;
const BEARING_SNAP = 5;

// ─── DOM bootstrap ──────────────────────────────────────────────

function requiredElement<T extends Element>(selector: string, name: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing required element: ${name}`);
  return el;
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app element.");
app.innerHTML = `<div id="map" class="map" aria-label="Raspberry Pi realtime map"></div>`;
const mapRoot = requiredElement<HTMLDivElement>("#map", "map");

// ─── Map init ───────────────────────────────────────────────────

const map = L.map(mapRoot, {
  center: DEFAULT_CENTER,
  zoom: DEFAULT_ZOOM,
  zoomControl: false,
  preferCanvas: true,
  rotate: true,
  bearing: 0,
  touchRotate: true,
  rotateControl: false,
});

// ─── State ──────────────────────────────────────────────────────

const state = {
  config: DEFAULT_CONFIG,
  device: null as DeviceRecord | null,
  devices: [] as DeviceRecord[],
  refreshTimer: 0,
  refreshBusy: false,
  hasCentered: false,
  baseMode: "street" as BaseMapMode,
  compassNeedle: null as SVGGElement | null,
  compassBtn: null as HTMLButtonElement | null,
  cameraPreview: null as HTMLDivElement | null,
  cameraButton: null as HTMLButtonElement | null,
  modeBtnLabel: null as HTMLSpanElement | null,
  markers: new Map<string, L.Marker>(),
  offlineReported: new Set<string>(),
};

// ─── Tile layers ────────────────────────────────────────────────

const streetLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 20,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const satelliteLayer = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 20, attribution: "" },
);

if (map.attributionControl) {
  try { map.attributionControl.setPrefix("ITS Maps"); } catch { /* ignore */ }
}

// ─── Helpers ────────────────────────────────────────────────────

function isDeviceStatus(v: unknown): v is DeviceStatus {
  return v === "online" || v === "offline" || v === "degraded";
}
function clamp(v: number, min: number, max: number) { return Math.min(max, Math.max(min, v)); }
function normalizeEpoch(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v < 1e11 ? v * 1000 : v;
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

// FIX: normalizeOneDevice — parser untuk satu raw device object langsung,
// tidak membungkus ulang dalam Snapshot sehingga tidak ada double-wrapping.
function normalizeOneDevice(raw: SnapshotDevice): DeviceRecord | null {
  const lat = typeof raw.position?.lat === "number" ? raw.position.lat
    : typeof raw.position?.y === "number" ? raw.position.y : null;
  const lng = typeof raw.position?.lng === "number" ? raw.position.lng
    : typeof raw.position?.x === "number" ? raw.position.x : null;
  if (lat === null || lng === null) return null;
  const lastSeen = normalizeEpoch(typeof raw.lastSeen === "number" ? raw.lastSeen : 0);
  const rawStatus = isDeviceStatus(raw.status) ? raw.status : "offline";
  const status = lastSeen > 0 && Date.now() - lastSeen > OFFLINE_AFTER_MS ? "offline" : rawStatus;
  return {
    id: raw.id?.trim() || "raspberry-its",
    label: raw.label?.trim() || "Raspberry Pi 5 Controller",
    status, lastSeen,
    lastSeenText: raw.lastSeenText?.trim() || undefined,
    note: raw.note?.trim() || undefined,
    cameraUrl: raw.cameraUrl?.trim() || undefined,
    position: { lat: clamp(lat, -90, 90), lng: clamp(lng, -180, 180) },
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

// ─── Marker ─────────────────────────────────────────────────────

function markerHtml(status: DeviceStatus): string {
  return `<div class="marker-pin ${status}"><span class="marker-pulse"></span><span class="marker-core"></span></div>`;
}
function renderPopup(device: DeviceRecord): string {
  return `
    <div class="popup-card">
      <div class="popup-title">${escapeHtml(device.label)}</div>
      <div class="popup-row"><span>ID</span><strong>${escapeHtml(device.id)}</strong></div>
      <div class="popup-row"><span>Status</span><strong>${escapeHtml(device.status)}</strong></div>
      <div class="popup-row"><span>Last seen</span><strong>${escapeHtml(device.lastSeenText || formatTime(device.lastSeen))}</strong></div>
      <div class="popup-row"><span>Age</span><strong>${formatAge(device.lastSeen)}</strong></div>
      <div class="popup-row"><span>Lat</span><strong>${device.position.lat.toFixed(6)}</strong></div>
      <div class="popup-row"><span>Lng</span><strong>${device.position.lng.toFixed(6)}</strong></div>
      ${device.note ? `<div class="popup-note">${escapeHtml(device.note)}</div>` : ""}
    </div>`;
}
function ensureMarker(device: DeviceRecord): void {
  const icon = L.divIcon({
    className: "raspi-marker",
    html: markerHtml(device.status),
    iconSize: [42, 54], iconAnchor: [21, 50], popupAnchor: [0, -42],
  });
  const existing = state.markers.get(device.id);
  if (!existing) {
    const m = L.marker([device.position.lat, device.position.lng], { icon }).addTo(map);
    m.bindPopup(renderPopup(device), {
      closeButton: false, autoClose: true, closeOnClick: true,
      className: "raspi-popup", offset: L.point(0, -14),
    });
    m.on("click", () => {
      state.device = device;
      renderCameraTile();
      m.openPopup();
    });
    state.markers.set(device.id, m);
    return;
  }
  // FIX: update posisi marker setiap refresh jika koordinat berubah
  existing.setLatLng([device.position.lat, device.position.lng]);
  existing.setIcon(icon);
  existing.setPopupContent(renderPopup(device));
}

function removeMissingMarkers(activeIds: Set<string>): void {
  for (const [deviceId, marker] of state.markers.entries()) {
    if (!activeIds.has(deviceId)) {
      map.removeLayer(marker);
      state.markers.delete(deviceId);
    }
  }
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
  state.compassNeedle.setAttribute("transform", `rotate(${norm}, 22, 22)`);
  if (state.compassBtn) {
    const isNorth = norm < BEARING_SNAP || norm > (360 - BEARING_SNAP);
    state.compassBtn.classList.toggle("compass-active", !isNorth);
    state.compassBtn.title = isNorth
      ? "Kompas – klik untuk putar peta ke Timur (90°)"
      : `Kompas mengarah ke ${bearingLabel(norm)} — klik lagi untuk lanjut`;
  }
}

function handleCompassClick(): void {
  const norm = normBearing(map.getBearing?.() ?? 0);
  const snapped = Math.round(norm / BEARING_STEP) * BEARING_STEP;
  const nextBearing = (snapped + BEARING_STEP) % 360;
  map.setBearing(nextBearing);
  map.closePopup();
}

// ─── Base map ───────────────────────────────────────────────────

function setBaseMap(mode: BaseMapMode): void {
  if (state.baseMode === mode) return;
  if (mode === "street") {
    if (map.hasLayer(satelliteLayer)) map.removeLayer(satelliteLayer);
    if (!map.hasLayer(streetLayer)) streetLayer.addTo(map);
  } else {
    if (map.hasLayer(streetLayer)) map.removeLayer(streetLayer);
    if (!map.hasLayer(satelliteLayer)) satelliteLayer.addTo(map);
  }
  state.baseMode = mode;
  if (state.modeBtnLabel) {
    state.modeBtnLabel.textContent = mode === "street" ? "3D" : "街";
  }
}

// ─── Camera tile ────────────────────────────────────────────────

function renderCameraTile(): void {
  if (!state.cameraPreview) return;
  const url = state.device?.cameraUrl?.trim();
  state.cameraPreview.innerHTML = url
    ? `<img class="camera-thumb-img" src="${escapeHtml(url)}" alt="Camera preview">`
    : "";
}

// ─── Map actions ────────────────────────────────────────────────

// FIX: goHome sekarang fly ke posisi device pertama yang diketahui,
// bukan ke DEFAULT_CENTER yang hardcoded.
function goHome(): void {
  const primary = state.devices[0] ?? state.device;
  if (primary) {
    map.setView([primary.position.lat, primary.position.lng], DEFAULT_ZOOM, { animate: true });
  } else {
    map.setView(DEFAULT_CENTER, DEFAULT_ZOOM, { animate: true });
  }
  map.setBearing(0);
}

function locateUser(): void {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const latlng: L.LatLngExpression = [pos.coords.latitude, pos.coords.longitude];
      map.setView(latlng, Math.max(map.getZoom(), 16), { animate: true });
      L.circleMarker(latlng, { radius: 8 }).addTo(map).bindPopup("Lokasi Anda").openPopup();
    },
    () => { /* silent */ },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 },
  );
}

function toggleBaseMap(): void {
  setBaseMap(state.baseMode === "street" ? "satellite" : "street");
}

function openCameraPreview(): void {
  const device = state.device;
  const anchor = map.getCenter();
  const content = device?.cameraUrl
    ? `<div class="camera-card">
        <img class="camera-image" src="${escapeHtml(device.cameraUrl)}" alt="Camera preview">
        <div class="camera-caption">${escapeHtml(device.label)} camera</div>
      </div>`
    : `<div class="camera-card">
        <div class="camera-placeholder">Camera preview belum tersedia.</div>
        <div class="camera-caption">Tambahkan <code>cameraUrl</code> di snapshot JSON.</div>
      </div>`;
  L.popup({ className: "camera-popup", closeButton: true, autoPan: true, maxWidth: 320 })
    .setLatLng(anchor).setContent(content).openOn(map);
}

// ─── Toolbar Control ─────────────────────────────────────────────

function firebaseDeviceUrl(deviceId: string): string {
  return FIREBASE_DEVICES_URL.replace(/\.json$/, `/${encodeURIComponent(deviceId)}.json`);
}

async function patchFirebaseDevice(deviceId: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(firebaseDeviceUrl(deviceId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Firebase PATCH ${deviceId} failed: HTTP ${res.status}`);
}

function makeCompassSvg(): string {
  return `<svg class="compass-svg" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">
    <circle cx="22" cy="22" r="19" class="compass-ring-bg"/>
    <text x="22" y="8" text-anchor="middle" font-size="5" font-weight="700"
          font-family="sans-serif" fill="#D92B2B">N</text>
    <path d="M4 22 L8.5 19 L8.5 25 Z" class="compass-arrow-left"/>
    <path d="M40 22 L35.5 19 L35.5 25 Z" class="compass-arrow-right"/>
    <g class="compass-needle-group">
      <polygon points="22,5 19.5,23 24.5,23" fill="#D92B2B"/>
      <polygon points="22,39 19.5,23 24.5,23" fill="#B0B0B0"/>
      <circle cx="22" cy="22" r="3" fill="#fff" stroke="#999" stroke-width="0.8"/>
    </g>
  </svg>`;
}

const BottomRightControl = L.Control.extend({
  options: { position: "bottomright" },
  onAdd(): HTMLElement {
    const container = L.DomUtil.create("div", "map-toolbar");
    container.innerHTML = `
      <button type="button" class="toolbar-compass" data-action="compass"
              title="Kompas – klik untuk putar peta">
        ${makeCompassSvg()}
      </button>
      <button type="button" class="toolbar-btn" data-action="mode" title="Ganti tampilan peta">
        <span class="mode-label">3D</span>
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
        <div class="camera-thumb-wrap"></div>
        <span class="camera-tile-label">全景</span>
      </button>
    `;

    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);

    state.compassNeedle = container.querySelector<SVGGElement>(".compass-needle-group");
    state.compassBtn = container.querySelector<HTMLButtonElement>(".toolbar-compass");
    state.cameraPreview = container.querySelector<HTMLDivElement>(".camera-thumb-wrap");
    state.cameraButton = container.querySelector<HTMLButtonElement>(".toolbar-camera");
    state.modeBtnLabel = container.querySelector<HTMLSpanElement>(".mode-label");

    container.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        if (action === "compass") handleCompassClick();
        else if (action === "mode") toggleBaseMap();
        else if (action === "locate") locateUser();
        else if (action === "home") goHome();
        else if (action === "camera") openCameraPreview();
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

map.on("rotate", updateCompass);
map.on("move zoom", updateCompass);

// ─── Fetch & refresh ────────────────────────────────────────────

// Firebase RTDB — dibaca langsung sebagai fallback jika file lokal tidak tersedia
const FIREBASE_DEVICES_URL =
  "https://itstelkom-default-rtdb.asia-southeast1.firebasedatabase.app/devices.json";

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

function applyDevices(devices: DeviceRecord[]): void {
  state.devices = devices;
  const activeIds = new Set(devices.map((d) => d.id));
  removeMissingMarkers(activeIds);
  devices.forEach((d) => ensureMarker(d));
  const selected = state.device && activeIds.has(state.device.id)
    ? devices.find((d) => d.id === state.device!.id) ?? devices[0]
    : devices[0];
  state.device = selected;
  renderCameraTile();
  if (!state.hasCentered) {
    map.setView([selected.position.lat, selected.position.lng],
      map.getZoom() || DEFAULT_ZOOM, { animate: false });
    state.hasCentered = true;
  }
}

function reportOfflineDevices(devices: DeviceRecord[]): void {
  const staleOffline = devices.filter((device) =>
    device.status === "offline"
    && device.lastSeen > 0
    && Date.now() - device.lastSeen > OFFLINE_AFTER_MS
    && !state.offlineReported.has(device.id),
  );

  staleOffline.forEach((device) => {
    state.offlineReported.add(device.id);
    void patchFirebaseDevice(device.id, {
      status: "offline",
      note: "controller tidak mengirim heartbeat; status diset offline oleh dashboard",
    }).catch((err) => {
      state.offlineReported.delete(device.id);
      console.warn("[ITS] Failed to mark device offline:", err);
    });
  });
}

async function refreshSnapshot(): Promise<void> {
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
      console.warn("[ITS] Local snapshot failed, trying Firebase:", localErr);
      snapshot = await fetchFirebaseDevices();
    }

    let devices = normalizeDevices(snapshot);

    // Jika lokal ada tapi kosong, coba Firebase
    if (!devices.length) {
      console.warn("[ITS] Local snapshot empty, trying Firebase...");
      try {
        const fbSnapshot = await fetchFirebaseDevices();
        devices = normalizeDevices(fbSnapshot);
      } catch { /* Firebase juga gagal, biarkan devices tetap kosong */ }
    }

    if (!devices.length) throw new Error("No valid devices found (local & Firebase)");

    applyDevices(devices);
    reportOfflineDevices(devices);
  } catch (err) {
    console.warn("[ITS] Snapshot error:", err);
    for (const marker of state.markers.values()) map.removeLayer(marker);
    state.markers.clear();
    state.devices = [];
    state.device = null;
  } finally {
    state.refreshBusy = false;
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(refreshSnapshot, state.config.refreshMs);
  }
}

window.addEventListener("beforeunload", () => {
  window.clearTimeout(state.refreshTimer);
  map.remove();
});

void refreshSnapshot();
