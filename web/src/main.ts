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

type PoiKind = "hospital" | "mall" | "campus" | "parking" | "park" | "worship" | "school" | "office" | "restaurant" | "monument" | "other";

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
const MAPLIBRE_3D_PITCH = 52;

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
  worship: {
    rating: "4.7",
    imageUrl: "https://images.unsplash.com/photo-1514222497938-d0edb2e47c23?auto=format&fit=crop&w=900&q=80",
    description: "Tempat ibadah dan pusat kegiatan keagamaan di sekitar lokasi.",
  },
  school: {
    rating: "4.4",
    imageUrl: "https://images.unsplash.com/photo-1503676260728-1c00da094a0b?auto=format&fit=crop&w=900&q=80",
    description: "Fasilitas pendidikan seperti sekolah dasar, menengah, dan setara.",
  },
  office: {
    rating: "4.1",
    imageUrl: "https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=900&q=80",
    description: "Bangunan kantor, administrasi, dan fasilitas kerja.",
  },
  restaurant: {
    rating: "4.3",
    imageUrl: "https://images.unsplash.com/photo-1414235077428-338989a2e8c0?auto=format&fit=crop&w=900&q=80",
    description: "Tempat makan, kafe, atau layanan kuliner di area sekitar.",
  },
  monument: {
    rating: "4.2",
    imageUrl: "https://images.unsplash.com/photo-1508804185872-d7badad00f7d?auto=format&fit=crop&w=900&q=80",
    description: "Landmark, monumen, atau penanda sejarah yang mudah dikenali.",
  },
  other: {
    rating: "4.0",
    imageUrl: "https://images.unsplash.com/photo-1524429656589-6633a470097c?auto=format&fit=crop&w=900&q=80",
    description: "Titik orientasi umum di peta.",
  },
};

const POI_VISUALS: Record<PoiKind, { icon: string; color: string }> = {
  hospital: { icon: "🏥", color: "#ef4444" },
  mall: { icon: "🏬", color: "#8b5cf6" },
  campus: { icon: "🎓", color: "#0ea5e9" },
  parking: { icon: "🅿️", color: "#64748b" },
  park: { icon: "🌳", color: "#22c55e" },
  worship: { icon: "🕌", color: "#f59e0b" },
  school: { icon: "🏫", color: "#2563eb" },
  office: { icon: "🏢", color: "#14b8a6" },
  restaurant: { icon: "🍽️", color: "#fb7185" },
  monument: { icon: "🗿", color: "#a16207" },
  other: { icon: "📍", color: "#475569" },
};

function classifyPoiKind(tags: Record<string, string>): PoiKind {
  const amenity = tags.amenity;
  const tourism = tags.tourism;
  if (amenity === "hospital") return "hospital";
  if (amenity === "place_of_worship" || tags.religion) return "worship";
  if (amenity === "school" || amenity === "kindergarten" || tags.education === "school") return "school";
  if (amenity === "university" || amenity === "college" || tourism === "university") return "campus";
  if (amenity === "restaurant" || amenity === "cafe" || amenity === "fast_food") return "restaurant";
  if (amenity === "parking" || tags.parking) return "parking";
  if (amenity === "office" || tags.office) return "office";
  if (tags.shop) return "mall";
  if (tags.historic === "monument" || tourism === "attraction" || tags.building === "monument") return "monument";
  if (tags.leisure === "park") return "park";
  return "other";
}

function poiVisual(kind: PoiKind): { icon: string; color: string } {
  return POI_VISUALS[kind] || POI_VISUALS.other;
}

function poiMarkerSizeByZoom(): number {
  const zoom = map.getZoom();
  return clamp(12 + (zoom - 13) * 1.15, 12, 24);
}

function makePoiIcon(poi: PoiRecord, size: number): L.DivIcon {
  const visual = poiVisual(poi.kind);
  return L.divIcon({
    className: "poi-marker-icon",
    html: `<div class="poi-marker poi-kind-${poi.kind}" title="${escapeHtml(poi.title)}" style="--poi-accent:${visual.color}; --poi-size:${size}px;">
      <span class="poi-marker-glyph">${visual.icon}</span>
    </div>`,
    iconSize: [size, size],
    iconAnchor: [Math.round(size / 2), Math.round(size / 2)],
  });
}

function renderPoiModal(poi: PoiRecord): string {
  return `
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
    </div>`;
}

function openPoiModal(poi: PoiRecord): void {
  closeModal();
  state.activeModalPoiId = poi.id;
  const overlay = createSwipeableSheetModal(
    "m-poi-modal",
    "m-poi-sheet m-device-sheet",
    `
      <div class="m-sheet-handle-bar"></div>
      ${renderPoiModal(poi)}
    `,
  );
  overlay.querySelector(".m-layer-backdrop")!.addEventListener("click", closeModal);
  const sheet = overlay.querySelector<HTMLElement>(".m-poi-sheet");
  if (!sheet) return;
  setupSheetSwipe(sheet, closeModal);
  sheet.querySelector<HTMLButtonElement>(".modal-close")?.addEventListener("click", closeModal);
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
      const kind = classifyPoiKind(tags);
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
        icon: poiVisual(kind).icon,
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

// Helper: Update MapLibre POI layer with GeoJSON features
function updateMapLibrePoiLayer(pois: PoiRecord[]): void {
  const maplibreMap = state.maplibreMap;
  if (!maplibreMap || state.baseMode !== "3d") return;

  try {
    const features = pois.map(poi => ({
      type: "Feature",
      properties: {
        id: poi.id,
        title: poi.title,
        kind: poi.kind,
        "icon-emoji": poi.icon // Use emoji from POI record
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

async function refreshOverpassLayer(): Promise<void> {
  const bounds = map.getBounds();
  // Avoid refetch if bounds similar
  if (lastOverpassFetchBounds && lastOverpassFetchBounds.contains(bounds.getSouthWest()) && lastOverpassFetchBounds.contains(bounds.getNorthEast())) return;
  lastOverpassFetchBounds = bounds.pad(0.2);
  const pois = await fetchOverpassFeaturesForBounds(bounds);
  
  // Update MapLibre POI layer (for 3D)
  updateMapLibrePoiLayer(pois);

  if (!state.overpassLayer) state.overpassLayer = L.layerGroup().addTo(map);
  state.overpassLayer.clearLayers();
  pois.forEach((poi) => {
    const marker = L.marker([poi.lat, poi.lng], {
      icon: makePoiIcon(poi, poiMarkerSizeByZoom()),
      interactive: true,
      riseOnHover: true,
      zIndexOffset: 450,
    }).addTo(state.overpassLayer as L.LayerGroup);
    marker.on('click', () => openPoiModal(poi));
  });
}

// When user clicks on raster tile, query a small radius for nearby features and open modal
map.on('click', async (ev: L.LeafletMouseEvent) => {
  const lat = ev.latlng.lat;
  const lng = ev.latlng.lng;
  
  // In 3D mode, check if click is on a MapLibre POI
  if (state.baseMode === '3d' && state.maplibreMap) {
    try {
      const features = state.maplibreMap.querySourceFeatures("poi-source", {
        sourceLayer: undefined
      }).filter((f: any) => {
        if (!f.properties || !f.geometry) return false;
        const [lng2, lat2] = f.geometry.coordinates;
        const dist = Math.sqrt(Math.pow(lat2 - lat, 2) + Math.pow(lng2 - lng, 2));
        return dist < 0.003; // ~300m at this zoom level
      });
      
      if (features.length > 0) {
        const feature = features[0];
        const poi = state.poiData.get(feature.properties?.id);
        if (poi) {
          openPoiModal(poi);
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
    const kind = classifyPoiKind(tags);
    const poi: PoiRecord = {
      id: `overpass-click-${el.type}-${el.id}`,
      kind,
      title: tags.name || tags.amenity || tags.shop || `Feature ${el.id}`,
      description: tags.description || tags['note'] || '',
      address: (tags['addr:street'] || '') + (tags['addr:city'] ? ', ' + tags['addr:city'] : ''),
      imageUrl: tags.image || POI_LIBRARY[kind].imageUrl,
      rating: POI_LIBRARY[kind].rating,
      icon: poiVisual(kind).icon,
      lat: latR, lng: lngR,
    };
    openPoiModal(poi);
  } catch (err) {
    // ignore
  }
});

map.on('moveend', () => {
  if (state.baseMode === '3d') {
    if (state.overpassLayer) state.overpassLayer.clearLayers();
    return;
  }
  void refreshOverpassLayer();
});

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
        <div class="info-row"><span class="label">Status</span><span class="value status-${device.status}" data-field="device-status">${escapeHtml(device.status)}</span></div>
        <div class="info-row"><span class="label">Last Seen</span><span class="value" data-field="device-last-seen">${escapeHtml(device.lastSeenText || formatTime(device.lastSeen))}</span></div>
        <div class="info-row"><span class="label">Age</span><span class="value" data-field="device-age">${formatAge(device.lastSeen)}</span></div>
        <div class="info-row"><span class="label">Road</span><span class="value" data-field="device-road">${road}</span></div>
      </div>
      <div class="modal-tab-pane" data-tab="traffic">
        <div class="info-row"><span class="label">Jalan</span><span class="value" data-field="traffic-road">${road}</span></div>
        <div class="info-row"><span class="label">Jumlah Kendaraan</span><span class="value" data-field="traffic-count">${traffic.vehicleCount}</span></div>
        <div class="info-row"><span class="label">Durasi Lampu</span><span class="value" data-field="traffic-duration">${traffic.duration}s (${traffic.color})</span></div>
        <div class="info-row"><span class="label">Rekomendasi</span><span class="value" data-field="traffic-recommendation">${recommendation}</span></div>
      </div>
    </div>`;
}

function closeModal(): void {
  document.querySelectorAll(".modal-wrapper, #m-device-modal, #m-poi-modal").forEach((m) => m.remove());
  state.activeModalDeviceId = null;
  state.activeModalPoiId = null;
  window.clearInterval(state.trafficRefreshTimer);
  state.trafficRefreshTimer = 0;
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
  requestAnimationFrame(() => overlay.classList.add("open"));
  L.DomEvent.disableClickPropagation(overlay);
  L.DomEvent.disableScrollPropagation(overlay);
  return overlay;
}

function openModal(device: DeviceRecord): void {
  closeModal();
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

  overlay.querySelector(".m-layer-backdrop")!.addEventListener("click", closeModal);
  const sheet = overlay.querySelector<HTMLElement>(".m-device-sheet");
  if (!sheet) return;
  setupSheetSwipe(sheet, closeModal);
  sheet.querySelectorAll<HTMLButtonElement>(".modal-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => setSheetActiveTab(sheet, btn.dataset.tab || "system"));
  });
  sheet.querySelector<HTMLButtonElement>(".modal-close")?.addEventListener("click", closeModal);

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
  sheet.querySelector<HTMLButtonElement>(".modal-close")?.addEventListener("click", closeModal);
  sheet.querySelectorAll<HTMLButtonElement>(".modal-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => setSheetActiveTab(sheet, btn.dataset.tab || "system"));
  });
  setSheetActiveTab(sheet, activeTab);
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

  // Rescale MapLibre POI layer text size
  const maplibreMap = state.maplibreMap;
  if (maplibreMap && state.baseMode === "3d") {
    try {
      const scaledSize = 14 + (map.getZoom() - 13) * 1.2;
      maplibreMap.setLayoutProperty("poi-symbols", "text-size", Math.min(Math.max(scaledSize, 10), 24));
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
      maplibreMap.on("styleimagemissing", (e: any) => {
        const id = e?.id;
        if (!id || maplibreMap.hasImage(id)) return;
        const transparentPixel = new Uint8Array([0, 0, 0, 0]);
        maplibreMap.addImage(id, { width: 1, height: 1, data: transparentPixel });
      });

      // Add POI GeoJSON source for 3D rendering (prevents drift)
      try {
        if (!maplibreMap.getSource("poi-source")) {
          maplibreMap.addSource("poi-source", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] }
          });
        }

        // Add POI symbol layer using text labels with emoji icons (simple, no drift)
        if (!maplibreMap.getLayer("poi-symbols")) {
          maplibreMap.addLayer({
            id: "poi-symbols",
            type: "symbol",
            source: "poi-source",
            layout: {
              "text-field": ["get", "icon-emoji"],
              "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
              "text-size": 18,
              "text-offset": [0, 0],
              "text-allow-overlap": true,
              "text-ignore-placement": true
            },
            paint: {
              "text-opacity": 1
            }
          }, "building");
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

          // 1. Mewarnai Tata Guna Lahan (Tanah Dasar)
          if (sourceLayer === 'landuse' && layer.type === 'fill') {
            try {
              maplibreMap.setPaintProperty(id, 'fill-color', [
                'match', ['get', 'class'],
                'hospital', '#ffd6d6',
                'school', '#fff4c2',
                'education', '#fff4c2',
                'residential', '#def7e3',
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
                'primary', '#ffffff',
                '#f8fafc'
              ]);
            } catch {
              /* ignore layer incompatibility */
            }
          }

          // 3. Bangunan 3D Berwarna berdasarkan Tinggi Gedung
          if (layer.type === 'fill-extrusion' || id.includes('building')) {
            try {
              maplibreMap.setPaintProperty(id, 'fill-extrusion-color', [
                'interpolate',
                ['linear'],
                ['to-number', ['coalesce', ['get', 'render_height'], ['get', 'height'], ['*', ['to-number', ['coalesce', ['get', 'building:levels'], 0], 0], 3], 0], 0],
                0, '#fbbf24',
                10, '#4ade80',
                25, '#60a5fa',
                50, '#a78bfa',
                100, '#f87171'
              ]);
              maplibreMap.setPaintProperty(id, 'fill-extrusion-opacity', 0.92);
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
      }
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
      animate: false,
      center,
      zoom,
      bearing,
      pitch: MAPLIBRE_3D_PITCH,

    });
    if (state.baseMode === "3d") {
      // Matikan overlay Overpass di 3D agar tidak terlihat geser terhadap bidang
      // perspektif MapLibre. POI akan ditampilkan via MapLibre native layer.
      if (state.overpassLayer) {
        state.overpassLayer.getLayers().forEach((layer: any) => {
          if (layer._path) layer._path.style.display = 'none';
          if (layer._icon) layer._icon.style.display = 'none';
        });
      }
      // Also hide Leaflet POI markers
      for (const marker of state.poiMarkers.values()) {
        (marker.getElement() as HTMLElement).style.display = 'none';
      }
    } else {
      // Mode Street 2D Normal (Leaflet mengambil alih lagi)
      if (state.overpassLayer) {
        state.overpassLayer.getLayers().forEach((layer: any) => {
          if (layer._path) layer._path.style.display = '';
          if (layer._icon) layer._icon.style.display = '';
        });
      }
      // Show Leaflet POI markers again
      for (const marker of state.poiMarkers.values()) {
        (marker.getElement() as HTMLElement).style.display = '';
      }
      // Clear MapLibre POI layer in 2D mode
      const maplibreMap = state.maplibreMap;
      if (maplibreMap) {
        try {
          const source = maplibreMap.getSource("poi-source");
          if (source && "setData" in source) {
            (source as any).setData({ type: "FeatureCollection", features: [] });
          }
        } catch {
          /* ignore */
        }
      }
    }
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
        <div class="camera-thumb-wrap"></div>
        <span class="camera-tile-label">全景</span>
      </button>
    ` : `
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

    container.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        if (action === "compass") handleCompassClick();
        else if (action === "locate") locateUser();
        else if (action === "home") goHome();
        else if (action === "camera") {
          if (isMobile()) {
            switchMobileTab("its");
            focusITSVideoSection();
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

// ═══════════════════════════════════════════════════════════════════════════
// MOBILE UI PATCH — VERSI FIXED (semua error TS6133 sudah diperbaiki)
// Ganti seluruh blok mobile patch di main.ts dengan file ini
// ═══════════════════════════════════════════════════════════════════════════

// ─── Mobile Detection ───────────────────────────────────────────────────────

function isMobile(): boolean {
  return window.innerWidth <= 768 || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
}

// ─── Types ───────────────────────────────────────────────────────────────────

type MobileTab = "peta" | "its" | "profil";
type LayerMode = "street" | "satellite" | "3d";

const mobileState = {
  activeTab: "peta" as MobileTab,
  layerModalOpen: false,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

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
  mobileState.activeTab = tab;

  document.querySelectorAll(".m-nav-tab").forEach(b => b.classList.remove("active"));
  document.querySelector<HTMLButtonElement>(`.m-nav-tab[data-tab="${tab}"]`)?.classList.add("active");

  if (tab === "peta") {
    closeITSSheet();
  } else if (tab === "its") {
    openITSSheet();
  } else if (tab === "profil") {
    closeITSSheet();
    openProfilSheet();
  }
}

// ─── 2. Layer Button + Swipeable Layer Modal ──────────────────────────────────

function createLayerButton(): HTMLElement {
  const btn = document.createElement("button");
  btn.id = "m-layer-btn";
  btn.setAttribute("aria-label", "Ganti lapisan peta");
  btn.innerHTML = `
    <img src="/lapisan.svg" alt="Lapisan" width="20" height="20"
         onerror="this.outerHTML='<svg viewBox=\\'0 0 24 24\\' fill=\\'none\\' width=\\'20\\' height=\\'20\\'><path d=\\'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5\\' stroke=\\'currentColor\\' stroke-width=\\'1.8\\' stroke-linejoin=\\'round\\'/></svg>'">
  `;
  // Prevent clicks on the layer button from propagating to the map (which
  // could trigger marker popups underneath). Also stop default to avoid
  // unexpected map interactions.
  L.DomEvent.disableClickPropagation(btn);
  L.DomEvent.disableScrollPropagation(btn);
  btn.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); openLayerModal(); });
  return btn;
}

function openLayerModal(): void {
  if (document.getElementById("m-layer-modal")) return;
  mobileState.layerModalOpen = true;

  const overlay = document.createElement("div");
  overlay.id = "m-layer-modal";
  overlay.innerHTML = `
    <div class="m-layer-backdrop"></div>
    <div class="m-layer-sheet">
      <div class="m-sheet-handle-bar"></div>
      <div class="m-layer-title">Pilih Tampilan Peta</div>
      <div class="m-layer-options">
        <button class="m-layer-opt ${state.baseMode === 'street' ? 'active' : ''}" data-mode="street">
          <div class="m-layer-icon">🗺️</div>
          <span>Normal</span>
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
    </div>
  `;

  overlay.querySelector(".m-layer-backdrop")!.addEventListener("click", closeLayerModal);

  overlay.querySelectorAll<HTMLButtonElement>(".m-layer-opt").forEach(btn => {
    btn.addEventListener("click", async () => {
      const mode = btn.dataset.mode as LayerMode;
      overlay.querySelectorAll(".m-layer-opt").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      await setBaseMap(mode);
      setTimeout(closeLayerModal, 280);
    });
  });

  setupSheetSwipe(
    overlay.querySelector<HTMLElement>(".m-layer-sheet")!,
    closeLayerModal
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

function setupSheetSwipe(sheetEl: HTMLElement, onClose: () => void): void {
  let startY = 0;
  let currentY = 0;

  const onTouchStart = (e: TouchEvent) => {
    startY = e.touches[0].clientY;
    currentY = 0;
    sheetEl.style.transition = "none";
  };

  const onTouchMove = (e: TouchEvent) => {
    const delta = e.touches[0].clientY - startY;
    currentY = Math.max(0, delta);
    sheetEl.style.transform = `translateY(${currentY}px)`;
  };

  const onTouchEnd = () => {
    sheetEl.style.transition = "";
    if (currentY > 80) {
      onClose();
    } else {
      sheetEl.style.transform = "";
    }
  };

  sheetEl.addEventListener("touchstart", onTouchStart, { passive: true });
  sheetEl.addEventListener("touchmove", onTouchMove, { passive: true });
  sheetEl.addEventListener("touchend", onTouchEnd);
}

// ─── 4. ITS Sheet (Swipeable, Dynamic Map Resize) ────────────────────────────

const ITS_SNAP = {
  closed: 0,
  peek: () => Math.round((window.innerHeight - 64) * 0.65),
  full: () => Math.round((window.innerHeight - 64) * 0.85),
};

// FIX 1: hapus itsSheetDragY yang tidak pernah dipakai
let itsCurrentSnap: "closed" | "peek" | "full" = "closed";

function getMapEl(): HTMLElement | null {
  return document.getElementById("map");
}

function setMapHeight(heightPx: number): void {
  const mapEl = getMapEl();
  if (!mapEl) return;
  const total = window.innerHeight - 64;
  const mapH = Math.max(60, total - heightPx);
  document.documentElement.style.setProperty("--its-sheet-height", `${Math.max(0, heightPx)}px`);
  mapEl.style.height = `${mapH}px`;
  mapEl.style.transition = "height 0.32s cubic-bezier(0.32,0.72,0,1)";
  mapEl.classList.toggle("its-open", heightPx > 0);
  map.invalidateSize();
}

function openITSSheet(): void {
  let sheet = document.getElementById("m-its-sheet");
  if (!sheet) {
    sheet = createITSSheet();
    document.getElementById("app")!.appendChild(sheet);
  }
  document.body.classList.add("its-sheet-open");
  renderITSSheetContent();
  snapITSSheet("peek");
}

function closeITSSheet(): void {
  snapITSSheet("closed");
  document.body.classList.remove("its-sheet-open");
  setTimeout(() => {
    const mapEl = getMapEl();
    if (mapEl) {
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

  setMapHeight(h);
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
  }, { passive: true });

  sheet.addEventListener("touchmove", (e: TouchEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest(".m-its-handle-zone")) return;
    const delta = e.touches[0].clientY - touchStartY;
    const rawY = touchStartTranslate + delta;
    const minY = window.innerHeight - ITS_SNAP.full() - 64;
    const maxY = window.innerHeight - 64;
    const clampedY = Math.max(minY, Math.min(maxY, rawY));
    sheet.style.transform = `translateY(${clampedY}px)`;
    const sheetH = window.innerHeight - 64 - clampedY;
    setMapHeight(Math.max(0, sheetH));
  }, { passive: true });

  sheet.addEventListener("touchend", () => {
    const matrix = new DOMMatrix(getComputedStyle(sheet).transform);
    const currentY = matrix.m42;
    const sheetH = window.innerHeight - 64 - currentY;
    const peekH = ITS_SNAP.peek();
    const fullH = ITS_SNAP.full();

    let snap: "closed" | "peek" | "full";
    if (sheetH < peekH * 0.4) {
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

  sheet.innerHTML = `
    <div class="m-its-handle-zone">
      <div class="m-its-handle-bar"></div>
    </div>
    <div class="m-its-scroll-content" id="m-its-scroll"></div>
  `;

  sheet.style.transform = `translateY(${window.innerHeight - 64}px)`;
  return sheet;
}

function focusITSVideoSection(): void {
  if (!isMobile()) return;
  const target = document.getElementById("m-its-video");
  if (!target) return;
  requestAnimationFrame(() => {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function renderITSSheetContent(): void {
  const scroll = document.getElementById("m-its-scroll");
  if (!scroll) return;

  const device = state.device;
  const traffic = device ? trafficStateForDevice(device) : null;
  const cameraUrl = device?.cameraUrl;

  const colorMap: Record<string, string> = {
    red: "#ef4444", yellow: "#facc15", green: "#22c55e",
  };
  const bulbColor = traffic ? colorMap[traffic.color] : "#9ca3af";

  scroll.innerHTML = `
    <div class="m-its-section" id="m-its-video">
      <div class="m-its-section-title">Video Realtime</div>
      <div class="m-its-camera-box">
        ${cameraUrl
      ? `<img src="${escapeHtml(cameraUrl)}" class="m-camera-img" alt="Camera">`
      : `<div class="m-camera-placeholder">
               <svg viewBox="0 0 48 48" fill="none" width="36" height="36">
                 <rect x="4" y="12" width="34" height="26" rx="4" stroke="#9ca3af" stroke-width="2"/>
                 <path d="M38 20l6-4v16l-6-4V20z" stroke="#9ca3af" stroke-width="2" stroke-linejoin="round"/>
               </svg>
               <span>Belum ada kamera</span>
             </div>`
    }
        <button class="m-camera-fullscreen" aria-label="Fullscreen">
          <svg viewBox="0 0 16 16" fill="none" width="14" height="14">
            <path d="M1 6V1h5M10 1h5v5M15 10v5h-5M6 15H1v-5"
                  stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </div>

    <div class="m-its-section">
      <div class="m-its-section-title">Data Scan</div>
      <div class="m-its-chart-wrap">
        <canvas id="m-traffic-chart" width="320" height="180"></canvas>
      </div>
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
      return `<div class="m-device-row" data-id="${d.id}">
          <span class="m-device-bulb" style="background:${c}"></span>
          <span class="m-device-name">${escapeHtml(d.label)}</span>
          <span class="m-device-status status-${d.status}">${d.status}</span>
        </div>`;
    }).join("")}
    </div>

    <div style="height:24px"></div>
  `;

  requestAnimationFrame(() => drawTrafficChart());

  scroll.querySelectorAll<HTMLDivElement>(".m-device-row").forEach(row => {
    row.addEventListener("click", () => {
      const id = row.dataset.id;
      const d = state.devices.find(x => x.id === id);
      if (!d) return;
      snapITSSheet("peek");
      setTimeout(() => {
        map.setView([d.position.lat, d.position.lng], 17, { animate: true });
      }, 200);
    });
  });
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

  const sheet = document.createElement("div");
  sheet.id = "m-profil-sheet";

  const online = state.devices.filter(d => d.status === "online").length;
  const offline = state.devices.filter(d => d.status === "offline").length;

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
  }

  repositionLeafletControls();

  // FIX 6: hapus const _orig yang tidak dipakai
  setInterval(() => {
    if (mobileState.activeTab === "its" && document.getElementById("m-its-scroll")) {
      renderITSSheetContent();
    }
  }, 4000);

  window.addEventListener("resize", () => {
    if (itsCurrentSnap !== "closed") snapITSSheet(itsCurrentSnap);
  });

  map.invalidateSize();
}
initMobileUI();
void refreshSnapshot();

// ─── PWA: Service Worker registration and install prompt handler ─────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('/sw.js');
      console.log('[PWA] Service Worker registered');
    } catch (err) {
      console.warn('[PWA] Service Worker registration failed', err);
    }
  });
}

let deferredPrompt: any = null;
function createInstallButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 'pwa-install-btn';
  btn.className = 'pwa-install-btn';
  btn.textContent = 'Pasang Aplikasi';
  Object.assign(btn.style, {
    position: 'fixed',
    right: '12px',
    bottom: '84px',
    zIndex: '9999',
    padding: '8px 12px',
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    boxShadow: '0 6px 14px rgba(37,99,235,0.24)',
    cursor: 'pointer'
  });

  btn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    try {
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      console.log('[PWA] install outcome', choice.outcome);
      if (choice.outcome === 'accepted') btn.style.display = 'none';
    } catch (e) {
      console.warn('[PWA] prompt error', e);
    }
    deferredPrompt = null;
  });
  return btn;
}

window.addEventListener('beforeinstallprompt', (e: Event) => {
  e.preventDefault();
  deferredPrompt = e;
  if (!document.getElementById('pwa-install-btn')) {
    const btn = createInstallButton();
    document.body.appendChild(btn);
  } else {
    (document.getElementById('pwa-install-btn') as HTMLElement).style.display = 'block';
  }
});

window.addEventListener('appinstalled', () => {
  console.log('[PWA] appinstalled');
  const b = document.getElementById('pwa-install-btn');
  if (b) b.remove();
});
