import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-rotate";
import "maplibre-gl/dist/maplibre-gl.css";
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
  roadName?: string;
  roadHint?: string;
  trafficColor?: "red" | "yellow" | "green";
  trafficDuration?: number;
  vehicleCount?: number;
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
type BaseMapMode = "street" | "3d" | "satellite";
type TrafficColor = "red" | "yellow" | "green";
type TrafficState = {
  color: TrafficColor;
  duration: number;
  vehicleCount: number;
  roadName: string;
  recommendation: string;
  updatedAt: number;
};

type PoiKind = "hospital" | "mall" | "campus" | "parking" | "park";

type PoiRecord = {
  id: string;
  kind: PoiKind;
  title: string;
  description: string;
  address: string;
  imageUrl: string;
  rating: string;
  icon: string;
  lat: number;
  lng: number;
};

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_CONFIG: Required<AppConfig> = {
  snapshotUrl: "./data/its-state.json",
  refreshMs: 5000,
};

// DEFAULT_CENTER — fallback jika tidak ada device. Akan di-override saat snapshot dimuat.
// User harus set ITS_LATITUDE & ITS_LONGITUDE di env var controller untuk lokasi yang tepat.
const DEFAULT_CENTER: L.LatLngExpression = [0, 0]; // Neutral; peta akan auto-pan ke marker pertama
const DEFAULT_ZOOM = 17;
const OFFLINE_AFTER_MS = 60_000;

const BEARING_STEP = 90;
const BEARING_SNAP = 5;
const MAPLIBRE_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const MAPLIBRE_3D_PITCH = 60;

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
  poiMarkers: new Map<string, L.Marker>(),
  poiData: new Map<string, PoiRecord>(),
  trafficById: new Map<string, TrafficState>(),
  roadNameById: new Map<string, string>(),
  maplibreMap: null as any,
  maplibreContainer: null as HTMLDivElement | null,
  maplibreSyncing: false,
  activeModalDeviceId: null as string | null,
  activeModalPoiId: null as string | null,
  trafficRefreshTimer: 0,
  offlineReported: new Set<string>(),
  overpassLayer: null as L.LayerGroup | null,
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

// Add Overpass vector layer for clickable features (kept separate from POI markers)
state.overpassLayer = L.layerGroup().addTo(map);

// ─── Scale Control ──────────────────────────────────────────────
// Custom scale ruler yang dinamis sesuai zoom level
const ScaleControl = L.Control.extend({
  options: { position: "bottomleft" },
  onAdd(): HTMLElement {
    const container = L.DomUtil.create("div", "map-scale-control");
    const updateScale = () => {
      const bounds = map.getBounds();
      const maxMeters = bounds.getNorthEast().distanceTo(bounds.getSouthWest()) / 2;
      let dist: string, unit = "m";
      if (maxMeters > 1000) {
        dist = (maxMeters / 1000).toFixed(1);
        unit = "km";
      } else {
        dist = Math.round(maxMeters).toString();
      }
      container.innerHTML = `<div class="scale-label">≈ ${dist} ${unit}</div>`;
    };
    map.on("moveend zoomend", updateScale);
    updateScale();
    return container;
  },
});
new ScaleControl().addTo(map);

// ─── POI Layer ─────────────────────────────────────────────────────

const POI_LIBRARY: Record<PoiKind, {
  rating: string;
  imageUrl: string;
  description: string;
}> = {
  hospital: {
    rating: "4.7",
    imageUrl: "https://images.unsplash.com/photo-1516549655169-df83a0774514?auto=format&fit=crop&w=900&q=80",
    description: "Layanan kesehatan dengan akses darurat, IGD, dan area parkir pasien.",
  },
  mall: {
    rating: "4.5",
    imageUrl: "https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=900&q=80",
    description: "Area belanja, restoran, dan fasilitas publik yang ramai di jam sibuk.",
  },
  campus: {
    rating: "4.8",
    imageUrl: "https://images.unsplash.com/photo-1523050854058-8df90110c9f1?auto=format&fit=crop&w=900&q=80",
    description: "Area pendidikan dengan gedung perkuliahan, kantor akademik, dan akses pejalan kaki.",
  },
  parking: {
    rating: "4.2",
    imageUrl: "https://images.unsplash.com/photo-1502877338535-766e1452684a?auto=format&fit=crop&w=900&q=80",
    description: "Zona parkir kendaraan dengan akses masuk-keluar yang terkontrol.",
  },
  park: {
    rating: "4.6",
    imageUrl: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=80",
    description: "Ruang hijau untuk istirahat, jalan santai, dan titik orientasi di peta.",
  },
};

function poiMarkerSizeByZoom(): number {
  const zoom = map.getZoom();
  return clamp(20 + (zoom - 13) * 1.6, 18, 34);
}

function makePoiIcon(poi: PoiRecord, size: number): L.DivIcon {
  return L.divIcon({
    className: "poi-marker-icon",
    html: `<div class="poi-marker" title="${escapeHtml(poi.title)}"><span>${poi.icon}</span></div>`,
    iconSize: [size, size],
    iconAnchor: [Math.round(size / 2), Math.round(size / 2)],
  });
}

function renderPoiModal(poi: PoiRecord): string {
  return `
    <div class="info-modal poi-modal" data-poi-id="${poi.id}">
      <div class="modal-header poi-modal-header">
        <button class="modal-close" data-action="close">×</button>
        <h2 class="modal-title">${escapeHtml(poi.title)}</h2>
      </div>
      <div class="modal-content poi-modal-content">
        <div class="poi-hero">
          <img class="poi-hero-image" src="${escapeHtml(poi.imageUrl)}" alt="${escapeHtml(poi.title)}">
          <div class="poi-hero-overlay">
            <span class="poi-badge">${escapeHtml(poi.kind.toUpperCase())}</span>
            <span class="poi-rating">★ ${escapeHtml(poi.rating)}</span>
          </div>
        </div>
        <div class="poi-summary">
          <div class="poi-icon-large">${poi.icon}</div>
          <div>
            <div class="poi-title">${escapeHtml(poi.title)}</div>
            <div class="poi-address">${escapeHtml(poi.address)}</div>
          </div>
        </div>
        <div class="poi-description">${escapeHtml(poi.description)}</div>
        <div class="info-row"><span class="label">Kategori</span><span class="value">${escapeHtml(poi.kind)}</span></div>
        <div class="info-row"><span class="label">Koordinat</span><span class="value">${poi.lat.toFixed(6)}, ${poi.lng.toFixed(6)}</span></div>
      </div>
    </div>`;
}

function openPoiModal(poi: PoiRecord): void {
  closeModal();
  state.activeModalPoiId = poi.id;
  const container = document.createElement("div");
  container.className = "modal-wrapper";
  container.innerHTML = renderPoiModal(poi);
  document.body.appendChild(container);

  const modal = container.querySelector<HTMLElement>(".info-modal");
  if (!modal) return;

  modal.querySelector<HTMLButtonElement>(".modal-close")?.addEventListener("click", closeModal);
  L.DomEvent.disableClickPropagation(container);
  L.DomEvent.disableScrollPropagation(container);
}

function syncPoiMarkers(anchor: L.LatLngExpression): void {
  const center = L.latLng(anchor);
  const radiusMeters = 400; // search radius for nearby POIs

  // Build a small bbox around center (approximate degrees)
  const lat = center.lat;
  const lng = center.lng;
  const latDelta = radiusMeters / 111320; // ~ meters to degrees
  const lngDelta = Math.abs(radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180)));
  const bounds = L.latLngBounds([lat - latDelta, lng - lngDelta], [lat + latDelta, lng + lngDelta]);

  void fetchOverpassFeaturesForBounds(bounds).then((pois) => {
    const keep = new Set<string>();
    const iconSize = poiMarkerSizeByZoom();
    pois.forEach((poi) => {
      keep.add(poi.id);
      state.poiData.set(poi.id, poi);
      const existing = state.poiMarkers.get(poi.id);
      const icon = makePoiIcon(poi, iconSize);
      if (!existing) {
        const marker = L.marker([poi.lat, poi.lng], {
          icon,
          interactive: true,
          riseOnHover: true,
          zIndexOffset: 500,
        }).addTo(map);
        marker.on("click", () => openPoiModal(poi));
        state.poiMarkers.set(poi.id, marker);
        return;
      }
      existing.setLatLng([poi.lat, poi.lng]);
      existing.setIcon(icon);
      existing.off("click");
      existing.on("click", () => openPoiModal(poi));
    });

    // Remove stale POI markers
    for (const [id, marker] of state.poiMarkers.entries()) {
      if (!keep.has(id)) {
        map.removeLayer(marker);
        state.poiMarkers.delete(id);
        state.poiData.delete(id);
      }
    }
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

async function fetchOverpassFeaturesForBounds(bounds: L.LatLngBounds): Promise<PoiRecord[]> {
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
    );
    out center tags;
  `;

  try {
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: q,
    });
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
    const data = await res.json();
    const elements = Array.isArray(data.elements) ? data.elements : [];
    const pois: PoiRecord[] = elements.map((el: any) => {
      const tags = el.tags || {};
      const name = tags.name || tags.official_name || tags['brand'] || tags['operator'] || tags.amenity || tags.shop || tags.tourism || `${tags.amenity || tags.shop || 'POI'}`;
      const lat = el.type === 'node' ? el.lat : (el.center && el.center.lat) || el.lat || 0;
      const lng = el.type === 'node' ? el.lon : (el.center && el.center.lon) || el.lon || 0;
      const kind: PoiKind = tags.amenity === 'hospital' ? 'hospital'
        : tags.shop ? 'mall'
          : tags.tourism === 'university' ? 'campus'
            : tags.amenity === 'parking' || tags.parking ? 'parking'
              : tags.leisure === 'park' ? 'park'
                : 'park';
      const imageUrl = tags.image || tags['image:source'] || POI_LIBRARY[kind].imageUrl;
      const description = tags.description || tags['note'] || POI_LIBRARY[kind].description;
      const addressParts = [] as string[];
      if (tags['addr:street']) addressParts.push(tags['addr:street']);
      if (tags['addr:housenumber']) addressParts.push(tags['addr:housenumber']);
      if (tags['addr:city']) addressParts.push(tags['addr:city']);
      const address = addressParts.join(" ") || (tags['addr'] || "");
      return {
        id: `overpass-${el.type}-${el.id}`,
        kind,
        title: name || `POI ${el.id}`,
        description: description || '',
        address: address || '',
        imageUrl: imageUrl || POI_LIBRARY[kind].imageUrl,
        rating: POI_LIBRARY[kind].rating,
        icon: tags.amenity === 'hospital' ? '🏥' : (tags.shop ? '🏬' : (tags.tourism ? '🎓' : '🌳')),
        lat, lng,
      };
    }).filter((p: PoiRecord) => p.lat && p.lng && !Number.isNaN(p.lat) && !Number.isNaN(p.lng));
    return pois;
  } catch (err) {
    console.warn("Overpass fetch failed:", err);
    return [];
  }
}

let lastOverpassFetchBounds: L.LatLngBounds | null = null;
async function refreshOverpassLayer(): Promise<void> {
  const bounds = map.getBounds();
  // Avoid refetch if bounds similar
  if (lastOverpassFetchBounds && lastOverpassFetchBounds.contains(bounds.getSouthWest()) && lastOverpassFetchBounds.contains(bounds.getNorthEast())) return;
  lastOverpassFetchBounds = bounds.pad(0.2);
  const pois = await fetchOverpassFeaturesForBounds(bounds);
  if (!state.overpassLayer) state.overpassLayer = L.layerGroup().addTo(map);
  state.overpassLayer.clearLayers();
  pois.forEach((poi) => {
    const marker = L.circleMarker([poi.lat, poi.lng], {
      radius: 8,
      color: '#2563eb',
      weight: 1.5,
      fillColor: '#3b82f6',
      fillOpacity: 0.85,
      interactive: true,
      pane: 'overlayPane',
    }).addTo(state.overpassLayer as L.LayerGroup);
    marker.on('click', () => openPoiModal(poi));
  });
}

// When user clicks on raster tile, query a small radius for nearby features and open modal
map.on('click', async (ev: L.LeafletMouseEvent) => {
  const lat = ev.latlng.lat;
  const lng = ev.latlng.lng;
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
      );
      out center tags;
    `;
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: q,
    });
    if (!res.ok) return;
    const data = await res.json();
    const el = (data.elements || [])[0];
    if (!el) return;
    const tags = el.tags || {};
    const latR = el.type === 'node' ? el.lat : (el.center && el.center.lat) || el.lat;
    const lngR = el.type === 'node' ? el.lon : (el.center && el.center.lon) || el.lon;
    const poi: PoiRecord = {
      id: `overpass-click-${el.type}-${el.id}`,
      kind: 'park',
      title: tags.name || tags.amenity || tags.shop || `Feature ${el.id}`,
      description: tags.description || tags['note'] || '',
      address: (tags['addr:street'] || '') + (tags['addr:city'] ? ', ' + tags['addr:city'] : ''),
      imageUrl: tags.image || POI_LIBRARY.park.imageUrl,
      rating: POI_LIBRARY.park.rating,
      icon: tags.amenity === 'hospital' ? '🏥' : (tags.shop ? '🏬' : '📍'),
      lat: latR, lng: lngR,
    };
    openPoiModal(poi);
  } catch (err) {
    // ignore
  }
});

map.on('moveend', () => { void refreshOverpassLayer(); });

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
  const seed = hashString(`${device.id}:${Math.floor(Date.now() / 4000)}`);
  const colors: TrafficColor[] = ["red", "yellow", "green"];
  return colors[seed % colors.length];
}

function trafficDurationFor(color: TrafficColor, device: DeviceRecord): number {
  const seed = hashString(`${device.id}:${Math.floor(Date.now() / 4000)}:${color}`);
  if (color === "red") return 8 + (seed % 18);
  if (color === "yellow") return 3 + (seed % 4);
  return 10 + (seed % 20);
}

function vehicleCountFor(device: DeviceRecord): number {
  const seed = hashString(`${device.id}:${Math.floor(Date.now() / 5000)}`);
  return 5 + (seed % 70);
}

function buildTrafficState(device: DeviceRecord): TrafficState {
  const color = trafficColorFor(device);
  const roadName = state.roadNameById.get(device.id) || device.roadName || device.roadHint || "Jalan tidak terdeteksi";
  const vehicleCount = vehicleCountFor(device);
  const duration = trafficDurationFor(color, device);
  return {
    color,
    duration,
    vehicleCount,
    roadName,
    recommendation: trafficColorLabel(color),
    updatedAt: Date.now(),
  };
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
    roadName: raw.roadName?.trim() || undefined,
    roadHint: raw.roadHint?.trim() || undefined,
    trafficColor: isDeviceStatus(raw.status) ? undefined : undefined,
    trafficDuration: typeof (raw as Record<string, unknown>).trafficDuration === "number"
      ? (raw as Record<string, unknown>).trafficDuration as number
      : undefined,
    vehicleCount: typeof (raw as Record<string, unknown>).vehicleCount === "number"
      ? (raw as Record<string, unknown>).vehicleCount as number
      : undefined,
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

// ─── Marker (Traffic Light) ─────────────────────────────────────

function trafficStateForDevice(device: DeviceRecord): TrafficState {
  const cached = state.trafficById.get(device.id);
  const roadName = state.roadNameById.get(device.id) || device.roadName || device.roadHint || device.label;
  if (cached && cached.roadName === roadName && Date.now() - cached.updatedAt < 2500) {
    return cached;
  }

  const next = buildTrafficState({ ...device, roadName });
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

function renderDeviceModal(device: DeviceRecord, traffic: TrafficState): string {
  const road = escapeHtml(traffic.roadName);
  const recommendation = escapeHtml(traffic.recommendation);
  return `
    <div class="info-modal" data-device-id="${device.id}">
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
          <div class="info-row"><span class="label">Lokasi</span><span class="value">${device.position.lat.toFixed(6)}, ${device.position.lng.toFixed(6)}</span></div>
          <div class="info-row"><span class="label">ID Sistem</span><span class="value">${escapeHtml(device.id)}</span></div>
          <div class="info-row"><span class="label">Status</span><span class="value status-${device.status}">${escapeHtml(device.status)}</span></div>
          <div class="info-row"><span class="label">Last Seen</span><span class="value">${escapeHtml(device.lastSeenText || formatTime(device.lastSeen))}</span></div>
          <div class="info-row"><span class="label">Age</span><span class="value">${formatAge(device.lastSeen)}</span></div>
          <div class="info-row"><span class="label">Road</span><span class="value">${road}</span></div>
        </div>
        <div class="modal-tab-pane" data-tab="traffic">
          <div class="info-row"><span class="label">Jalan</span><span class="value">${road}</span></div>
          <div class="info-row"><span class="label">Jumlah Kendaraan</span><span class="value">${traffic.vehicleCount}</span></div>
          <div class="info-row"><span class="label">Durasi Lampu</span><span class="value">${traffic.duration}s (${traffic.color})</span></div>
          <div class="info-row"><span class="label">Rekomendasi</span><span class="value">${recommendation}</span></div>
        </div>
      </div>
    </div>`;
}

function closeModal(): void {
  document.querySelectorAll(".modal-wrapper").forEach((m) => m.remove());
  state.activeModalDeviceId = null;
  state.activeModalPoiId = null;
  window.clearInterval(state.trafficRefreshTimer);
  state.trafficRefreshTimer = 0;
}

function openModal(device: DeviceRecord): void {
  closeModal();
  state.activeModalDeviceId = device.id;
  state.activeModalPoiId = null;
  const traffic = trafficStateForDevice(device);
  const container = document.createElement("div");
  container.className = "modal-wrapper";
  container.innerHTML = renderDeviceModal(device, traffic);
  document.body.appendChild(container);

  const modal = container.querySelector<HTMLElement>(".info-modal");
  if (!modal) return;

  modal.querySelectorAll<HTMLButtonElement>(".modal-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabName = btn.dataset.tab;
      modal.querySelectorAll(".modal-tab-btn").forEach((b) => b.classList.remove("active"));
      modal.querySelectorAll(".modal-tab-pane").forEach((pane) => pane.classList.remove("active"));
      btn.classList.add("active");
      modal.querySelector<HTMLElement>(`.modal-tab-pane[data-tab="${tabName}"]`)?.classList.add("active");
    });
  });

  modal.querySelector<HTMLButtonElement>(".modal-close")?.addEventListener("click", closeModal);
  L.DomEvent.disableClickPropagation(container);
  L.DomEvent.disableScrollPropagation(container);

  window.clearInterval(state.trafficRefreshTimer);
  state.trafficRefreshTimer = window.setInterval(() => {
    const active = state.device;
    const activeId = state.activeModalDeviceId;
    if (!active || !activeId || active.id !== activeId) return;
    const nextTraffic = trafficStateForDevice(active);
    modal.outerHTML = renderDeviceModal(active, nextTraffic);
    const nextModal = document.querySelector<HTMLElement>(".info-modal[data-device-id]");
    if (nextModal) {
      nextModal.querySelectorAll<HTMLButtonElement>(".modal-tab-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const tabName = btn.dataset.tab;
          nextModal.querySelectorAll(".modal-tab-btn").forEach((b) => b.classList.remove("active"));
          nextModal.querySelectorAll(".modal-tab-pane").forEach((pane) => pane.classList.remove("active"));
          btn.classList.add("active");
          nextModal.querySelector<HTMLElement>(`.modal-tab-pane[data-tab="${tabName}"]`)?.classList.add("active");
        });
      });
      nextModal.querySelector<HTMLButtonElement>(".modal-close")?.addEventListener("click", closeModal);
    }
  }, 2500);
}

function ensureMarker(device: DeviceRecord): void {
  const traffic = trafficStateForDevice(device);
  const size = markerSizeByZoom();
  const icon = L.divIcon({
    className: "traffic-light-marker-icon",
    html: makeTrafficLightSvg(traffic, size),
    iconSize: [size, Math.round(size * 1.5)],
    iconAnchor: markerAnchorBySize(size),
    popupAnchor: [0, -Math.round(size * 1.2)],
  });
  const existing = state.markers.get(device.id);

  if (!existing) {
    const m = L.marker([device.position.lat, device.position.lng], {
      icon,
      interactive: true,
      zIndexOffset: 1000,
      riseOnHover: true,
    }).addTo(map);
    m.on("click", () => {
      state.device = device;
      renderCameraTile();
      openModal(device);
    });
    state.markers.set(device.id, m);
    return;
  }

  existing.setLatLng([device.position.lat, device.position.lng]);
  existing.setIcon(icon);
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
    marker.setIcon(L.divIcon({
      className: "traffic-light-marker-icon",
      html: makeTrafficLightSvg(trafficStateForDevice(device), deviceSize),
      iconSize: [deviceSize, Math.round(deviceSize * 1.5)],
      iconAnchor: markerAnchorBySize(deviceSize),
      popupAnchor: [0, -Math.round(deviceSize * 1.2)],
    }));
  }

  const poiSize = poiMarkerSizeByZoom();
  for (const [id, poi] of state.poiData.entries()) {
    const marker = state.poiMarkers.get(id);
    if (!marker) continue;
    marker.setIcon(makePoiIcon(poi, poiSize));
  }
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
  const norm = normBearing(map.getBearing?.() ?? 0);
  const snapped = Math.round(norm / BEARING_STEP) * BEARING_STEP;
  const nextBearing = (snapped + BEARING_STEP) % 360;
  map.setBearing(nextBearing);
  map.closePopup();
}

// ─── Base map ───────────────────────────────────────────────────

async function ensureMapLibreMap(): Promise<any | null> {
  if (state.maplibreMap) return state.maplibreMap;

  try {
    const maplibreglImport = await import("maplibre-gl");
    const maplibregl = (maplibreglImport as any).default || maplibreglImport;

    if (!state.maplibreContainer) {
      const container = document.createElement("div");
      container.className = "maplibre-overlay";
      mapRoot.appendChild(container);
      state.maplibreContainer = container;
    }

    const maplibreMap = new maplibregl.Map({
      container: state.maplibreContainer,
      style: MAPLIBRE_STYLE_URL,
      center: map.getCenter(),
      zoom: map.getZoom(),
      bearing: map.getBearing?.() ?? 0,
      pitch: MAPLIBRE_3D_PITCH,
      attributionControl: false,
      interactive: false,
      preserveDrawingBuffer: false,
      fadeDuration: 0,
    });

    maplibreMap.on("load", () => {
      syncMapLibreView(true);
    });
    state.maplibreMap = maplibreMap;
    return maplibreMap;
  } catch (err) {
    console.error("ensureMapLibreMap error:", err);
    return null;
  }
}

async function removeMapLibreMap(): Promise<void> {
  if (!state.maplibreMap) return;
  try {
    state.maplibreMap.remove();
  } catch {
    /* ignore */
  }
  state.maplibreMap = null;
  if (state.maplibreContainer) {
    state.maplibreContainer.remove();
    state.maplibreContainer = null;
  }
}

function syncMapLibreView(force = false): void {
  const maplibreMap = state.maplibreMap;
  if (!maplibreMap) return;
  if (state.maplibreSyncing && !force) return;

  const center = map.getCenter();
  const zoom = map.getZoom();
  const bearing = map.getBearing?.() ?? 0;
  const pitch = MAPLIBRE_3D_PITCH;

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
      center,
      zoom,
      bearing,
      pitch,
      animate: false,
    });
  } finally {
    state.maplibreSyncing = false;
  }
}

async function setBaseMap(mode: BaseMapMode): Promise<void> {
  if (state.baseMode === mode) return;

  // Reset any previous 3D CSS transform (legacy fallback)
  const mapEl = mapRoot as HTMLElement;
  mapEl.style.transform = "";
  mapEl.style.transformOrigin = "";
  mapEl.style.perspective = "";
  (mapEl.parentElement as HTMLElement | null)?.style.setProperty("perspective", "");
  mapEl.classList.remove("map-mode-3d");

  if (mode === "street") {
    // remove any GL or satellite layer
    await removeMapLibreMap();
    if (map.hasLayer(satelliteLayer)) map.removeLayer(satelliteLayer);
    if (!map.hasLayer(streetLayer)) streetLayer.addTo(map);
  } else if (mode === "3d") {
    // Prefer true 3D: render MapLibre GL above the Leaflet map.
    if (map.hasLayer(satelliteLayer)) map.removeLayer(satelliteLayer);
    if (map.hasLayer(streetLayer)) map.removeLayer(streetLayer);

    const gl = await ensureMapLibreMap();
    if (!gl) {
      // fallback: use CSS tilt if MapLibre not available
      if (!map.hasLayer(streetLayer)) streetLayer.addTo(map);
      const wrapper = mapEl.parentElement as HTMLElement | null;
      if (wrapper) wrapper.style.perspective = "800px";
      mapEl.style.transform = "rotateX(45deg) scale(1.4)";
      mapEl.style.transformOrigin = "50% 100%";
      mapEl.style.transition = "transform 0.5s ease";
      state.baseMode = "street";
      if (state.modeBtnLabel) state.modeBtnLabel.textContent = "3D";
      return;
    }

    mapEl.classList.add("map-mode-3d");
    syncMapLibreView(true);
    map.invalidateSize();
  } else {
    // satellite
    await removeMapLibreMap();
    if (map.hasLayer(streetLayer)) map.removeLayer(streetLayer);
    if (!map.hasLayer(satelliteLayer)) satelliteLayer.addTo(map);
  }

  state.baseMode = mode;
  if (state.modeBtnLabel) state.modeBtnLabel.textContent = mode === "3d" ? "2D" : "3D";
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

async function toggleBaseMap(): Promise<void> {
  if (state.baseMode === "3d") await setBaseMap("street");
  else await setBaseMap("3d");
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
    state.modeBtnLabel = container.querySelector<HTMLSpanElement>(".mode-label");

    container.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        if (action === "compass") handleCompassClick();
        else if (action === "mode") void toggleBaseMap();
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
map.on("zoomend", rescaleMarkers);
map.on("move zoom rotate", () => syncMapLibreView());
map.on("resize", () => {
  state.maplibreMap?.resize();
  syncMapLibreView(true);
});

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
        closeModal();
        openModal(device);
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
