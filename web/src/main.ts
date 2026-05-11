import L from "leaflet";
import "leaflet/dist/leaflet.css";
// Plugin rotasi peta — install dulu: npm install leaflet-rotate
// Cukup import saja, plugin otomatis extend L.Map
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
const DEFAULT_CENTER: L.LatLngExpression = [-7.280734, 112.794963];
const DEFAULT_ZOOM = 17;
const OFFLINE_AFTER_MS = 60_000;

// Tiap klik maju 90° searah jarum jam (N→E→S→W→N)
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

// ─── Map init (dengan rotate enabled) ───────────────────────────

const map = L.map(mapRoot, {
  center: DEFAULT_CENTER,
  zoom: DEFAULT_ZOOM,
  zoomControl: false,
  preferCanvas: true,
  // leaflet-rotate options
  rotate: true,          // aktifkan rotasi
  bearing: 0,            // mulai dari utara
  touchRotate: true,     // dua jari untuk rotasi di mobile
  rotateControl: false,  // matikan kontrol default plugin (kita punya sendiri)
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
};

// ─── Tile layers ────────────────────────────────────────────────

const streetLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 20,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const satelliteLayer = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 20, attribution: "" }, // kosongkan attribution Esri
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
function normalizeDevice(snapshot: Snapshot): DeviceRecord | null {
  const raw = Array.isArray(snapshot.devices)
    ? snapshot.devices[0]
    : snapshot.devices && typeof snapshot.devices === "object"
      ? Object.values(snapshot.devices)[0]
      : null;
  if (!raw) return null;
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

function normalizeDevices(snapshot: Snapshot): DeviceRecord[] {
  const rawDevices = snapshot.devices;
  const entries = Array.isArray(rawDevices)
    ? rawDevices.map((device, index) => [device.id?.trim() || `device-${index}`, device] as const)
    : rawDevices && typeof rawDevices === "object"
      ? Object.entries(rawDevices)
      : [];

  return entries
    .map(([deviceId, device]) => normalizeDevice({ devices: [{ ...device, id: device.id?.trim() || deviceId }] }))
    .filter((device): device is DeviceRecord => Boolean(device));
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

/**
 * Sinkronkan jarum SVG dengan bearing peta saat ini.
 * leaflet-rotate fire event "rotate" setiap kali bearing berubah.
 */
// Label mata angin berdasarkan bearing
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

// Normalisasi bearing ke 0..359 (leaflet-rotate kadang return negatif)
function normBearing(raw: number): number {
  return ((raw % 360) + 360) % 360;
}

function updateCompass(): void {
  if (!state.compassNeedle) return;
  const norm = normBearing(map.getBearing?.() ?? 0);

  // Kompas mengikuti arah bearing peta saat ini.
  state.compassNeedle.setAttribute("transform", `rotate(${norm}, 22, 22)`);

  if (state.compassBtn) {
    const isNorth = norm < BEARING_SNAP || norm > (360 - BEARING_SNAP);
    state.compassBtn.classList.toggle("compass-active", !isNorth);
    state.compassBtn.title = isNorth
      ? "Kompas – klik untuk putar peta ke Timur (90°)"
      : `Kompas mengarah ke ${bearingLabel(norm)} — klik lagi untuk lanjut`;
  }
}

/**
 * Tiap klik maju tepat 90° searah jarum jam:
 *   N(0°) → E(90°) → S(180°) → W(270°) → N(0°)
 *
 * Algoritma: snap bearing saat ini ke kelipatan 90° terdekat,
 * lalu tambah 90°. Ini memastikan tidak ada posisi nanggung
 * walau user sempat putar manual.
 */
function handleCompassClick(): void {
  const norm = normBearing(map.getBearing?.() ?? 0);

  // Kelipatan 90° terdekat dari posisi saat ini
  const snapped = Math.round(norm / BEARING_STEP) * BEARING_STEP;
  // Maju satu step, wrap di 360
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

function goHome(): void {
  map.setView(DEFAULT_CENTER, DEFAULT_ZOOM, { animate: true });
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
  const anchor = (state as typeof state & { _marker?: L.Marker })._marker?.getLatLng() ?? map.getCenter();
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

function makeCompassSvg(): string {
  // Jarum: segitiga merah (utara) lebih panjang dan lancip dari putih (selatan)
  // Ini memastikan orientasi jelas di semua sudut (0/90/180/270)
  return `<svg class="compass-svg" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">
    <!-- Ring luar -->
    <circle cx="22" cy="22" r="19" class="compass-ring-bg"/>
    <!-- Tanda N kecil di atas ring -->
    <text x="22" y="8" text-anchor="middle" font-size="5" font-weight="700"
          font-family="sans-serif" fill="#D92B2B">N</text>
    <!-- Arrow kiri kanan -->
    <path d="M4 22 L8.5 19 L8.5 25 Z" class="compass-arrow-left"/>
    <path d="M40 22 L35.5 19 L35.5 25 Z" class="compass-arrow-right"/>
    <!-- Jarum: grup yang dirotasi JS -->
    <g class="compass-needle-group">
      <!-- Utara: merah, runcing ke atas, lebih panjang -->
      <polygon points="22,5 19.5,23 24.5,23" fill="#D92B2B"/>
      <!-- Selatan: abu, lebih pendek dan tumpul -->
      <polygon points="22,39 19.5,23 24.5,23" fill="#B0B0B0"/>
      <!-- Titik tengah -->
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
      <button type="button" class="toolbar-btn" data-action="home" title="Kembali ke posisi awal">
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

// Update jarum kompas setiap kali bearing peta berubah
// leaflet-rotate menambahkan event "rotate"
map.on("rotate", updateCompass);
map.on("move zoom", updateCompass); // fallback

// ─── Fetch & refresh ────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return (await res.json()) as T;
}

async function refreshSnapshot(): Promise<void> {
  if (state.refreshBusy) return;
  state.refreshBusy = true;
  try {
    const config = await fetchJson<AppConfig>("./data/its-config.json");
    state.config = {
      snapshotUrl: config.snapshotUrl?.trim() || DEFAULT_CONFIG.snapshotUrl,
      refreshMs: config.refreshMs && config.refreshMs > 0
        ? config.refreshMs : DEFAULT_CONFIG.refreshMs,
    };
    const snapshot = await fetchJson<Snapshot>(state.config.snapshotUrl);
    const devices = normalizeDevices(snapshot);
    if (!devices.length) throw new Error("Snapshot missing devices");

    state.devices = devices;
    const activeIds = new Set(devices.map((device) => device.id));
    removeMissingMarkers(activeIds);

    devices.forEach((device) => ensureMarker(device));

    const selected = state.device && activeIds.has(state.device.id)
      ? state.device
      : devices[0];
    state.device = selected;
    renderCameraTile();

    if (!state.hasCentered && selected) {
      map.setView([selected.position.lat, selected.position.lng],
        map.getZoom() || DEFAULT_ZOOM, { animate: false });
      state.hasCentered = true;
    }
  } catch {
    for (const marker of state.markers.values()) {
      map.removeLayer(marker);
    }
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