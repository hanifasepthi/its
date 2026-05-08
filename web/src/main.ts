import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";

type DeviceStatus = "online" | "offline" | "degraded";

type DeviceRecord = {
  id: string;
  label: string;
  status: DeviceStatus;
  lastSeen: number;
  note?: string;
  position: {
    lat: number;
    lng: number;
  };
};

type SnapshotDevice = Partial<Omit<DeviceRecord, "position">> & {
  position?: Partial<DeviceRecord["position"]> & {
    x?: number;
    y?: number;
  };
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

const DEFAULT_CENTER: L.LatLngExpression = [-7.280734, 112.794963];
const DEFAULT_ZOOM = 17;
const OFFLINE_AFTER_MS = 60_000;

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app element.");
}

app.innerHTML = `
  <div id="map" class="map" aria-label="Raspberry Pi realtime map"></div>
`;

const mapRoot = requiredElement<HTMLDivElement>("#map", "map");
const state = {
  config: DEFAULT_CONFIG,
  device: null as DeviceRecord | null,
  refreshTimer: 0,
  refreshBusy: false,
  map: L.map(mapRoot, {
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    zoomControl: true,
    preferCanvas: true,
  }),
  marker: null as L.Marker | null,
  deviceRail: null as HTMLDivElement | null,
};

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 20,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(state.map);

// Replace default Leaflet/OSM prefix with project attribution
if (state.map.attributionControl) {
  try {
    state.map.attributionControl.setPrefix("ITS Maps • Telkom University");
  } catch {
    // ignore if not available
  }
}

const deviceRail = (L.control as any)({ position: "bottomright" });
deviceRail.onAdd = function () {
  const container = L.DomUtil.create("div", "device-rail");
  state.deviceRail = container;
  container.innerHTML = `
    <div class="device-rail-inner">
      <div class="device-tile">
        <span class="tile-label">Status</span>
        <strong class="tile-value" data-device-status>Loading</strong>
      </div>
      <div class="device-tile">
        <span class="tile-label">Last seen</span>
        <strong class="tile-value" data-device-last-seen>-</strong>
      </div>
      <button class="camera-tile" aria-label="Camera preview coming soon" title="Camera preview coming soon" disabled>
        <span class="camera-lens"></span>
        <strong>Coming soon</strong>
      </button>
    </div>
  `;

  L.DomEvent.disableClickPropagation(container);
  L.DomEvent.disableScrollPropagation(container);
  return container;
};
deviceRail.addTo(state.map);

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatAge(value: number): string {
  if (value <= 0) {
    return "-";
  }

  const ageMs = Math.max(0, Date.now() - value);
  if (ageMs < 60_000) {
    return `${Math.max(1, Math.round(ageMs / 1000))}s ago`;
  }

  return `${Math.round(ageMs / 60_000)}m ago`;
}

function normalizeDevice(snapshot: Snapshot): DeviceRecord | null {
  const raw = snapshot.devices?.[0];
  if (!raw) {
    return null;
  }

  const latitude = typeof raw.position?.lat === "number"
    ? raw.position.lat
    : typeof raw.position?.y === "number"
      ? raw.position.y
      : null;
  const longitude = typeof raw.position?.lng === "number"
    ? raw.position.lng
    : typeof raw.position?.x === "number"
      ? raw.position.x
      : null;

  if (latitude === null || longitude === null) {
    return null;
  }

  const lastSeen = typeof raw.lastSeen === "number" ? raw.lastSeen : 0;
  const rawStatus = isDeviceStatus(raw.status) ? raw.status : "offline";
  const status = lastSeen > 0 && Date.now() - lastSeen > OFFLINE_AFTER_MS ? "offline" : rawStatus;

  return {
    id: raw.id?.trim() || "raspberry-its",
    label: raw.label?.trim() || "Raspberry Pi 5 Controller",
    status,
    lastSeen,
    note: raw.note?.trim() || undefined,
    position: {
      lat: clamp(latitude, -90, 90),
      lng: clamp(longitude, -180, 180),
    },
  };
}

function markerHtml(status: DeviceStatus): string {
  return `
    <div class="marker-pin ${status}">
      <span class="marker-pulse"></span>
      <span class="marker-core"></span>
    </div>
  `;
}

function ensureMarker(device: DeviceRecord): void {
  const icon = L.divIcon({
    className: "raspi-marker",
    html: markerHtml(device.status),
    iconSize: [42, 54],
    iconAnchor: [21, 50],
    popupAnchor: [0, -42],
  });

  if (!state.marker) {
    state.marker = L.marker([device.position.lat, device.position.lng], { icon }).addTo(state.map);
    state.marker.bindPopup(renderPopup(device), {
      closeButton: false,
      autoClose: true,
      closeOnClick: true,
      className: "raspi-popup",
      offset: L.point(0, -14),
    });
    state.marker.on("click", () => {
      state.marker?.openPopup();
    });
    return;
  }

  state.marker.setLatLng([device.position.lat, device.position.lng]);
  state.marker.setIcon(icon);
  state.marker.setPopupContent(renderPopup(device));
}

function renderPopup(device: DeviceRecord): string {
  return `
    <div class="popup-card">
      <div class="popup-title">${device.label}</div>
      <div class="popup-row"><span>ID</span><strong>${device.id}</strong></div>
      <div class="popup-row"><span>Status</span><strong>${device.status}</strong></div>
      ${device.lastSeen > 0 ? `<div class="popup-row"><span>Last seen</span><strong>${formatTime(device.lastSeen)}</strong></div>` : ""}
    </div>
  `;
}

function renderDeviceRail(device: DeviceRecord | null): void {
  if (!state.deviceRail) {
    return;
  }

  const statusElement = state.deviceRail.querySelector<HTMLElement>("[data-device-status]");
  const lastSeenElement = state.deviceRail.querySelector<HTMLElement>("[data-device-last-seen]");
  if (!statusElement || !lastSeenElement) {
    return;
  }

  state.deviceRail.dataset.status = device?.status || "offline";
  statusElement.textContent = device ? device.status : "offline";
  lastSeenElement.textContent = device ? formatAge(device.lastSeen) : "-";
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
  try {
    const config = await fetchJson<AppConfig>("./data/its-config.json");
    state.config = {
      snapshotUrl: config.snapshotUrl?.trim() || DEFAULT_CONFIG.snapshotUrl,
      refreshMs: config.refreshMs && config.refreshMs > 0 ? config.refreshMs : DEFAULT_CONFIG.refreshMs,
    };

    const snapshot = await fetchJson<Snapshot>(state.config.snapshotUrl);
    const device = normalizeDevice(snapshot);

    if (!device) {
      throw new Error("Snapshot missing device position");
    }

    state.device = device;
    ensureMarker(device);
    renderDeviceRail(device);
    state.map.setView([device.position.lat, device.position.lng], state.map.getZoom() || DEFAULT_ZOOM, {
      animate: false,
    });
  } catch {
    if (state.marker) {
      state.map.removeLayer(state.marker);
      state.marker = null;
    }
    state.device = null;
    renderDeviceRail(null);
  } finally {
    state.refreshBusy = false;
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(refreshSnapshot, state.config.refreshMs);
  }
}

window.addEventListener("beforeunload", () => {
  window.clearTimeout(state.refreshTimer);
  state.map.remove();
});

void refreshSnapshot();
