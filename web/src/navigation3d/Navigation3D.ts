import maplibregl, { type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";

const nationalPmtilesProtocol = new Protocol();
maplibregl.addProtocol("pmtiles", nationalPmtilesProtocol.tile);

import {
  DEFAULT_NAVIGATION_CENTER,
  MODE_PROFILES,
  bearingDeltaDegrees,
  coordinateAlongLine,
  distanceM,
  fetchRoadScene,
  forwardBearingOnRoute,
  formatDistance,
  formatDuration,
  nearestPointOnRoute,
  requestRoute,
  searchPlaces,
  smoothBearing,
} from "./services";
import { buildNavigationScene } from "./sceneBuilder";
import {
  installNavigationLayers,
  navigationStyle,
  setRoute,
  setScene,
  setTraveledRoute,
} from "./NavigationLayers";
import { ThreeOrnamentsLayer } from "./ThreeOrnamentsLayer";
import type {
  LngLat,
  NavigationMode,
  NavigationRequest,
  NavigationRoute,
  RouteManeuver,
  SearchPlace,
} from "./types";

const SEARCH_DEBOUNCE_MS = 360;
const MAP_LOAD_TIMEOUT_MS = 20_000;

function routeWindowAround(
  coordinates: LngLat[],
  center: LngLat,
  radiusM: number,
): LngLat[] {
  if (coordinates.length < 2) return coordinates.slice();
  const nearest = nearestPointOnRoute(center, coordinates);
  const targetLengthM = Math.max(120, radiusM * 1.5);
  let start = nearest.segmentIndex;
  let end = Math.min(coordinates.length - 1, nearest.segmentIndex + 1);
  let beforeM = 0;
  let afterM = 0;
  while (start > 0 && beforeM < targetLengthM) {
    beforeM += distanceM(coordinates[start], coordinates[start - 1]);
    start -= 1;
  }
  while (end < coordinates.length - 1 && afterM < targetLengthM) {
    afterM += distanceM(coordinates[end], coordinates[end + 1]);
    end += 1;
  }
  return coordinates.slice(start, end + 1);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function requestPosition(options: PositionOptions): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolokasi tidak tersedia pada perangkat ini."));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

async function getPosition(): Promise<GeolocationPosition> {
  try {
    return await requestPosition({
      enableHighAccuracy: true,
      timeout: 9_000,
      maximumAge: 15_000,
    });
  } catch (error) {
    // A denied permission cannot be improved by a second request. A timeout or
    // unavailable GPS can still use a fast browser/network location.
    if (typeof error === "object" && error !== null && "code" in error && Number(error.code) === 1) {
      throw error;
    }
    return requestPosition({
      enableHighAccuracy: false,
      timeout: 6_000,
      maximumAge: 5 * 60_000,
    });
  }
}

type NavigationRuntimeLocation = {
  lat: number;
  lng: number;
  accuracy?: number;
  source?: string;
};

type NavigationRuntimePlace = NavigationRuntimeLocation & {
  id: string;
  title: string;
  kind: string;
  address?: string;
};

type NavigationRuntimeBridge = {
  getPoiSnapshot?: () => NavigationRuntimePlace[];
  getUserLocation?: () => NavigationRuntimeLocation | null;
  getMapCenter?: () => NavigationRuntimeLocation | null;
  applyUserLocation?: (
    lat: number,
    lng: number,
    accuracy?: number,
    center?: boolean,
    source?: string,
  ) => void;
};

function navigationRuntimeBridge(): NavigationRuntimeBridge | null {
  return (window as typeof window & {
    __itsMapsRuntimeBridge?: NavigationRuntimeBridge;
  }).__itsMapsRuntimeBridge || null;
}

function normalizedSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("id-ID")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function localPlaceMatches(query: string, bias: LngLat): SearchPlace[] {
  const normalizedQuery = normalizedSearchText(query);
  if (normalizedQuery.length < 3) return [];
  const queryTerms = normalizedQuery.split(" ").filter(Boolean);
  const places = navigationRuntimeBridge()?.getPoiSnapshot?.() || [];
  return places
    .flatMap((place): Array<{ place: SearchPlace; score: number; distance: number }> => {
      if (!Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return [];
      const searchable = normalizedSearchText(`${place.title} ${place.kind} ${place.address || ""}`);
      if (!queryTerms.every((term) => searchable.includes(term))) return [];
      const title = normalizedSearchText(place.title);
      const score = title === normalizedQuery ? 4 : title.startsWith(normalizedQuery) ? 3 : title.includes(normalizedQuery) ? 2 : 1;
      return [{
        place: {
          id: `local:${place.id}`,
          title: place.title,
          subtitle: place.address || `${place.kind} · data ITS Maps`,
          coordinate: [place.lng, place.lat],
        },
        score,
        distance: distanceM(bias, [place.lng, place.lat]),
      }];
    })
    .sort((first, second) => second.score - first.score || first.distance - second.distance)
    .slice(0, 8)
    .map((match) => match.place);
}

function mergePlaceResults(local: SearchPlace[], remote: SearchPlace[]): SearchPlace[] {
  const merged: SearchPlace[] = [];
  for (const place of [...local, ...remote]) {
    const duplicate = merged.some((existing) =>
      normalizedSearchText(existing.title) === normalizedSearchText(place.title)
      && distanceM(existing.coordinate, place.coordinate) < 45,
    );
    if (!duplicate) merged.push(place);
    if (merged.length >= 8) break;
  }
  return merged;
}

function modeFields(): string {
  return (Object.keys(MODE_PROFILES) as NavigationMode[])
    .map((mode) => {
      const profile = MODE_PROFILES[mode];
      return `
        <button
            type="button"
            class="nav3d-mode"
            data-nav3d-mode-input
            value="${mode}"
            id="its-nav3d-mode-${mode}"
            title="Moda ${escapeHtml(profile.label)}"
            aria-label="Moda ${escapeHtml(profile.label)}"
            role="radio"
            aria-checked="${mode === "car" ? "true" : "false"}"
            tabindex="${mode === "car" ? "0" : "-1"}"
          >
          <span aria-hidden="true">${profile.icon}</span>
          <small>${escapeHtml(profile.label)}</small>
        </button>`;
    })
    .join("");
}

function applicationHtml(): string {
  return `
    <div class="nav3d-launcher">
      <input
        type="search"
        id="its-nav3d-quick-search"
        name="destination_query"
        class="nav3d-quick-search"
        data-nav3d-quick-search
        title="Cari tempat atau rute"
        aria-label="Cari tempat atau rute"
        aria-description="Masukkan nama tempat, alamat, atau tujuan navigasi ITS Maps."
        toolparamdescription="Nama tempat, alamat, atau tujuan yang ingin dicari pada ITS Maps."
        placeholder="Cari tempat atau rute"
        autocomplete="off"
      >
      <button
        type="button"
        class="nav3d-launcher-search"
        data-nav3d-launcher
        aria-label="Buka pencarian rute"
        aria-controls="its-nav3d-search-panel"
        aria-expanded="false"
        aria-haspopup="dialog"
      >⌕</button>
    </div>

    <section
      id="its-nav3d-search-panel"
      class="nav3d-search-panel"
      data-nav3d-search-panel
      role="dialog"
      aria-modal="false"
      aria-labelledby="its-nav3d-search-title"
      hidden
    >
      <header class="nav3d-search-header">
        <div>
          <strong id="its-nav3d-search-title">Rute ITS Maps</strong>
          <small>Cari tujuan lalu pilih moda perjalanan</small>
        </div>
        <button type="button" class="nav3d-icon-button" data-nav3d-close-search aria-label="Tutup pencarian">×</button>
      </header>

      <form
        class="nav3d-route-form"
        data-nav3d-search-form
        toolname="search_its_maps_navigation_route"
        tooldescription="Search a destination in ITS Maps, choose a travel mode, and preview an accessible 3D navigation route."
        toolautosubmit
      >
        <fieldset class="nav3d-modes">
          <legend>Moda perjalanan</legend>
          <label class="nav3d-webmcp-mode" for="its-nav3d-mode-parameter">
            Moda untuk agen
            <select
              id="its-nav3d-mode-parameter"
              name="mode"
              data-nav3d-mode-parameter
              title="Moda perjalanan navigasi"
              aria-description="Pilih moda perjalanan yang dipakai untuk menghitung rute navigasi 3D."
              toolparamdescription="Travel mode for the route: car, motorcycle, truck, bicycle, walk, or transit."
            >
              ${(Object.keys(MODE_PROFILES) as NavigationMode[]).map((mode) => `<option value="${mode}">${escapeHtml(MODE_PROFILES[mode].label)}</option>`).join("")}
            </select>
          </label>
          <div class="nav3d-mode-scroll">${modeFields()}</div>
        </fieldset>

        <div class="nav3d-endpoints" aria-label="Lokasi awal dan tujuan">
          <span class="nav3d-route-rail" aria-hidden="true"><i></i><b></b><i></i></span>
          <label class="nav3d-endpoint nav3d-origin-field">
            <span>Lokasi awal</span>
            <input
              type="text"
              name="origin"
              data-nav3d-origin-input
              value="Lokasi saya saat ini"
              title="Lokasi awal navigasi"
              aria-description="Lokasi Anda saat ini digunakan sebagai titik awal setelah izin lokasi diberikan."
              readonly
              toolparamdescription="Route origin. ITS Maps uses the current device location when permission is available."
            >
          </label>
          <label class="nav3d-endpoint nav3d-destination-field">
            <span>Tujuan</span>
            <input
              id="its-nav3d-destination"
              data-nav3d-search-input
              type="search"
              name="destination"
              placeholder="Cari gedung, jalan, kota, atau halte"
              autocomplete="off"
              enterkeyhint="search"
              role="combobox"
              aria-autocomplete="list"
              aria-controls="its-nav3d-results"
              aria-expanded="false"
              aria-activedescendant=""
              title="Tujuan navigasi"
              aria-description="Masukkan nama tempat, alamat, jalan, gedung, stasiun, atau kota tujuan."
              required
              minlength="3"
              toolparamdescription="Destination name, address, road, city, building, station, or public place to find."
            >
          </label>
          <button type="submit" class="nav3d-search-submit" aria-label="Cari tujuan">
            <span aria-hidden="true">⌕</span><span class="nav3d-search-submit-label">Cari</span>
          </button>
        </div>
      </form>

      <p class="nav3d-search-hint" data-nav3d-search-hint>
        Ketik minimal tiga karakter. Hasil bergantung pada data lokasi terbuka yang tersedia.
      </p>
      <div class="nav3d-status-sr" data-nav3d-search-status role="status" aria-live="polite"></div>
      <div id="its-nav3d-results" class="nav3d-results" data-nav3d-results role="listbox" aria-label="Hasil pencarian" hidden></div>

      <section class="nav3d-preview" data-nav3d-preview aria-labelledby="its-nav3d-preview-title" hidden>
        <div class="nav3d-preview-route">
          <span aria-hidden="true" class="nav3d-preview-pin">●</span>
          <div>
            <small>Tujuan terpilih</small>
            <strong id="its-nav3d-preview-title" data-nav3d-preview-title>—</strong>
            <span data-nav3d-preview-subtitle>—</span>
          </div>
        </div>
        <div class="nav3d-preview-metrics" aria-live="polite">
          <strong data-nav3d-preview-distance>—</strong>
          <span data-nav3d-preview-duration>—</span>
        </div>
        <p class="nav3d-routing-note" data-nav3d-routing-note></p>
        <footer>
          <button type="button" class="nav3d-secondary-action" data-nav3d-demo hidden disabled>
            <span aria-hidden="true">▶</span> Uji simulasi
          </button>
          <button type="button" class="nav3d-primary-action" data-nav3d-start disabled>
            Mulai navigasi 3D
          </button>
        </footer>
      </section>
    </section>

    <section
      class="nav3d-overlay"
      data-nav3d-overlay
      role="dialog"
      aria-modal="true"
      aria-label="Navigasi 3D ITS Maps"
      hidden
    >
      <div class="nav3d-map" data-nav3d-map role="application" aria-label="Peta navigasi 3D interaktif"></div>
      <div class="nav3d-loading" data-nav3d-loading role="status" aria-live="polite">
        <span aria-hidden="true"></span>
        <strong data-nav3d-loading-title>Menyiapkan navigasi 3D</strong>
        <small data-nav3d-loading-detail>Menghitung jalan, gedung, jembatan, dan ornamen yang tersedia.</small>
      </div>

      <div class="nav3d-hud">
        <section class="nav3d-instruction" aria-live="polite" aria-atomic="true">
          <div class="nav3d-turn" data-nav3d-turn aria-hidden="true">↑</div>
          <div>
            <strong data-nav3d-instruction-distance>—</strong>
            <span data-nav3d-instruction-text>Menyiapkan rute</span>
            <small data-nav3d-instruction-road>ITS Maps</small>
          </div>
        </section>

        <section class="nav3d-speed" aria-label="Kecepatan">
          <div><strong data-nav3d-speed>0</strong><small>km/j</small></div>
          <div><small>Batas</small><strong data-nav3d-speed-limit>50</strong></div>
        </section>

        <div class="nav3d-lanes" aria-label="Panduan lajur ilustratif">
          <span aria-hidden="true">↑</span><span class="active" aria-hidden="true">↑</span><span aria-hidden="true">↗</span>
        </div>

        <button type="button" class="nav3d-exit" data-nav3d-exit aria-label="Keluar dari navigasi 3D">× <span>Keluar</span></button>
        <button type="button" class="nav3d-recenter" data-nav3d-recenter aria-label="Ikuti kembali posisi perjalanan">◎</button>

        <div class="nav3d-screen-avatar" aria-hidden="true"><i></i><b></b></div>

        <section class="nav3d-summary" aria-label="Ringkasan perjalanan">
          <div><small>Tiba</small><strong data-nav3d-arrival>—</strong></div>
          <div><small>Sisa perjalanan</small><strong data-nav3d-remaining>—</strong></div>
          <div class="nav3d-progress" role="progressbar" aria-label="Kemajuan perjalanan" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>
        </section>
        <p class="nav3d-runtime-status" data-nav3d-runtime-status role="status" aria-live="polite"></p>
      </div>
    </section>`;
}

function maneuverArrow(maneuver: RouteManeuver | null): string {
  if (!maneuver) return "↑";
  if (maneuver.type === "arrive") return "●";
  if (maneuver.type.includes("roundabout") || maneuver.type.includes("rotary")) return "⟳";
  if (maneuver.modifier.includes("uturn")) return "↶";
  if (maneuver.modifier.includes("left")) return "↰";
  if (maneuver.modifier.includes("right")) return "↱";
  return "↑";
}

function isNavigationMode(value: string): value is NavigationMode {
  return Object.hasOwn(MODE_PROFILES, value);
}

function modeSpeedLimit(mode: NavigationMode): number {
  if (mode === "walk") return 5;
  if (mode === "bicycle") return 25;
  if (mode === "truck") return 40;
  return 50;
}

export class Navigation3D {
  private root: HTMLElement | null = null;
  private map: MapLibreMap | null = null;
  private threeLayer: ThreeOrnamentsLayer | null = null;
  private mode: NavigationMode = "car";
  private selectedPlace: SearchPlace | null = null;
  private searchResults: SearchPlace[] = [];
  private activeResultIndex = -1;
  private route: NavigationRoute | null = null;
  private currentCoordinate: LngLat = DEFAULT_NAVIGATION_CENTER;
  private currentBearing = 0;
  private currentSpeedKmh = 0;
  private routeOrigin: LngLat = DEFAULT_NAVIGATION_CENTER;
  private originResolved = false;
  private originFromDevice = false;
  private originPromise: Promise<LngLat> | null = null;
  private lastOriginAttemptAt = 0;
  private searchAbort: AbortController | null = null;
  private routeAbort: AbortController | null = null;
  private sceneAbort: AbortController | null = null;
  private sceneCenter: LngLat | null = null;
  private locationWatch: number | null = null;
  private simulationFrame = 0;
  private simulationStart = 0;
  private followCamera = true;
  private searchTimer = 0;
  private routeSequence = 0;
  private launcherBeforeOverlay: HTMLElement | null = null;
  private searchSheetPointerId: number | null = null;
  private searchSheetStartY = 0;
  private searchSheetDragY = 0;

  mount(): void {
    if (this.root || location.pathname !== "/") return;
    this.root = document.createElement("div");
    this.root.className = "its-navigation3d";
    this.root.innerHTML = applicationHtml();
    document.body.appendChild(this.root);
    this.bindEvents();
    this.restoreNavigationUrlState();
  }

  private restoreNavigationUrlState(): void {
    const params = new URLSearchParams(window.location.search);
    const stage = params.get("nav");
    if (stage !== "search" && stage !== "preview") return;
    const requestedMode = params.get("travel");
    const mode = requestedMode && isNavigationMode(requestedMode) ? requestedMode : undefined;
    const destination = (params.get("destination") || "").slice(0, 180);
    const rawLatitude = params.get("toLat");
    const rawLongitude = params.get("toLng");
    const latitude = rawLatitude === null ? Number.NaN : Number(rawLatitude);
    const longitude = rawLongitude === null ? Number.NaN : Number(rawLongitude);
    if (stage === "preview" && destination && Number.isFinite(latitude)
      && Math.abs(latitude) <= 90 && Number.isFinite(longitude) && Math.abs(longitude) <= 180) {
      window.setTimeout(() => {
        this.openSearch("", mode);
        this.selectPlace({
          id: `url:${latitude.toFixed(6)}:${longitude.toFixed(6)}`,
          title: destination,
          subtitle: "Tujuan dari tautan ITS Maps",
          coordinate: [longitude, latitude],
        });
      }, 0);
      return;
    }
    window.setTimeout(() => this.openSearch(destination, mode), 0);
  }

  openSearch(query = "", mode?: NavigationMode): void {
    if (!this.root) this.mount();
    if (!this.root) return;
    if (mode) this.setMode(mode);
    const panel = this.element<HTMLElement>("[data-nav3d-search-panel]");
    const launcher = this.element<HTMLButtonElement>("[data-nav3d-launcher]");
    panel.removeAttribute("hidden");
    launcher.setAttribute("aria-expanded", "true");
    const input = this.element<HTMLInputElement>("[data-nav3d-search-input]");
    if (query) input.value = query;
    window.setTimeout(() => input.focus(), 40);
    if (query.trim().length >= 3) void this.performSearch();
    // Opening this panel is explicit navigation intent. Start location
    // detection immediately, without waiting for the route submit button.
    void this.resolveOrigin(!this.originFromDevice);
    this.syncNavigationUrl("search", query || input.value);
  }

  private element<T extends Element>(selector: string): T {
    const element = this.root?.querySelector<T>(selector);
    if (!element) throw new Error(`Elemen navigasi ${selector} tidak ditemukan.`);
    return element;
  }

  private bindEvents(): void {
    const quickSearch = this.element<HTMLInputElement>("[data-nav3d-quick-search]");
    const launchSearch = (): void => this.openSearch(quickSearch.value);
    this.element<HTMLButtonElement>("[data-nav3d-launcher]").addEventListener("click", launchSearch);
    quickSearch.addEventListener("focus", launchSearch);
    quickSearch.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      launchSearch();
    });
    this.element<HTMLButtonElement>("[data-nav3d-close-search]").addEventListener("click", () =>
      this.closeSearch(),
    );
    this.element<HTMLFormElement>("[data-nav3d-search-form]").addEventListener("submit", (event) => {
      event.preventDefault();
      const parameterMode = this.element<HTMLSelectElement>("[data-nav3d-mode-parameter]").value;
      if (isNavigationMode(parameterMode) && parameterMode !== this.mode) this.setMode(parameterMode);
      void this.performSearch();
    });

    const input = this.element<HTMLInputElement>("[data-nav3d-search-input]");
    input.addEventListener("input", () => {
      window.clearTimeout(this.searchTimer);
      this.activeResultIndex = -1;
      this.syncComboboxState();
      this.searchTimer = window.setTimeout(() => void this.performSearch(), SEARCH_DEBOUNCE_MS);
    });
    input.addEventListener("keydown", (event) => this.handleSearchKeys(event));
    this.bindSearchSheetGesture();

    this.root?.addEventListener("click", (event) => {
      const target = event.target as Element;
      const modeButton = target.closest<HTMLButtonElement>("[data-nav3d-mode-input]");
      if (modeButton && isNavigationMode(modeButton.value)) {
        this.setMode(modeButton.value);
        return;
      }
      const placeButton = target.closest<HTMLButtonElement>("[data-nav3d-place-id]");
      if (!placeButton) return;
      const place = this.searchResults.find((item) => item.id === placeButton.dataset.nav3dPlaceId);
      if (place) this.selectPlace(place);
    });

    this.element<HTMLButtonElement>("[data-nav3d-start]").addEventListener("click", () =>
      void this.start(false),
    );
    this.element<HTMLButtonElement>("[data-nav3d-demo]").addEventListener("click", () =>
      void this.start(true),
    );
    this.element<HTMLButtonElement>("[data-nav3d-exit]").addEventListener("click", () => this.stop());
    this.element<HTMLButtonElement>("[data-nav3d-recenter]").addEventListener("click", () => {
      this.followCamera = true;
      this.updateCamera(true);
      this.setRuntimeStatus("Kamera kembali mengikuti perjalanan.");
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !this.root) return;
      if (!this.element<HTMLElement>("[data-nav3d-overlay]").hasAttribute("hidden")) this.stop();
      else if (!this.element<HTMLElement>("[data-nav3d-search-panel]").hasAttribute("hidden"))
        this.closeSearch();
    });
  }

  private bindSearchSheetGesture(): void {
    const panel = this.element<HTMLElement>("[data-nav3d-search-panel]");
    const reset = (): void => {
      panel.classList.remove("is-dragging");
      panel.style.removeProperty("--nav3d-sheet-drag-y");
      this.searchSheetPointerId = null;
      this.searchSheetDragY = 0;
    };
    panel.addEventListener("pointerdown", (event) => {
      if (!window.matchMedia("(max-width: 720px)").matches || event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (!target.closest(".nav3d-search-header, .nav3d-search-panel") || target.closest("button, input, select, label")) return;
      this.searchSheetPointerId = event.pointerId;
      this.searchSheetStartY = event.clientY;
      this.searchSheetDragY = 0;
      panel.classList.add("is-dragging");
      panel.setPointerCapture(event.pointerId);
    });
    panel.addEventListener("pointermove", (event) => {
      if (this.searchSheetPointerId !== event.pointerId) return;
      this.searchSheetDragY = Math.max(0, event.clientY - this.searchSheetStartY);
      panel.style.setProperty("--nav3d-sheet-drag-y", `${this.searchSheetDragY}px`);
    });
    panel.addEventListener("pointerup", (event) => {
      if (this.searchSheetPointerId !== event.pointerId) return;
      const shouldClose = this.searchSheetDragY > Math.min(150, panel.clientHeight * 0.24);
      reset();
      if (shouldClose) this.closeSearch();
    });
    panel.addEventListener("pointercancel", reset);
  }

  private closeSearch(): void {
    this.searchAbort?.abort();
    window.clearTimeout(this.searchTimer);
    const panel = this.element<HTMLElement>("[data-nav3d-search-panel]");
    panel.classList.remove("is-dragging");
    panel.style.removeProperty("--nav3d-sheet-drag-y");
    panel.setAttribute("hidden", "");
    const launcher = this.element<HTMLButtonElement>("[data-nav3d-launcher]");
    launcher.setAttribute("aria-expanded", "false");
    this.syncNavigationUrl("map");
    launcher.focus();
  }

  private handleSearchKeys(event: KeyboardEvent): void {
    if (this.searchResults.length === 0) {
      if (event.key === "Escape") this.closeSearch();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const increment = event.key === "ArrowDown" ? 1 : -1;
      this.activeResultIndex =
        (this.activeResultIndex + increment + this.searchResults.length) % this.searchResults.length;
      this.syncComboboxState();
      this.root
        ?.querySelector<HTMLElement>(`#its-nav3d-option-${this.activeResultIndex}`)
        ?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key === "Enter" && this.activeResultIndex >= 0) {
      event.preventDefault();
      const place = this.searchResults[this.activeResultIndex];
      if (place) this.selectPlace(place);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.clearSearchResults();
    }
  }

  private syncComboboxState(): void {
    const input = this.element<HTMLInputElement>("[data-nav3d-search-input]");
    const expanded = this.searchResults.length > 0;
    input.setAttribute("aria-expanded", String(expanded));
    input.setAttribute(
      "aria-activedescendant",
      this.activeResultIndex >= 0 ? `its-nav3d-option-${this.activeResultIndex}` : "",
    );
    this.root?.querySelectorAll<HTMLElement>("[data-nav3d-place-id]").forEach((option, index) => {
      option.setAttribute("aria-selected", String(index === this.activeResultIndex));
    });
  }

  private setMode(mode: NavigationMode): void {
    this.mode = mode;
    this.root?.querySelectorAll<HTMLButtonElement>("[data-nav3d-mode-input]").forEach((button) => {
      const selected = button.value === mode;
      button.setAttribute("aria-checked", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    this.element<HTMLSelectElement>("[data-nav3d-mode-parameter]").value = mode;
    this.element("[data-nav3d-speed-limit]").textContent = String(modeSpeedLimit(mode));
    this.updateRoutingNote();
    this.syncNavigationUrl(this.selectedPlace ? "preview" : "search");
    if (this.selectedPlace) void this.previewRoute();
  }

  private updateRoutingNote(): void {
    const note = this.element<HTMLElement>("[data-nav3d-routing-note]");
    note.textContent =
      this.mode === "motorcycle" || this.mode === "truck" || this.mode === "transit"
        ? "Rute moda ini masih memakai estimasi jaringan jalan terbuka; patuhi rambu dan kondisi lapangan."
        : "Prediksi kemacetan AI memakai sinyal lalu lintas realtime yang tersedia; kondisi lapangan tetap menjadi acuan.";
  }

  private async resolveOrigin(force = false): Promise<LngLat> {
    if (this.originFromDevice && !force) return this.routeOrigin;
    if (this.originPromise) return this.originPromise;
    // Do not immediately reopen a denied permission prompt on every keypress.
    // A later panel open retries automatically after this short cooldown.
    if (!force && this.originResolved && Date.now() - this.lastOriginAttemptAt < 30_000) {
      return this.routeOrigin;
    }
    const originInput = this.element<HTMLInputElement>("[data-nav3d-origin-input]");
    originInput.value = "Mendeteksi lokasi…";
    this.lastOriginAttemptAt = Date.now();
    this.originPromise = (async () => {
      try {
        const position = await getPosition();
        this.routeOrigin = [position.coords.longitude, position.coords.latitude];
        this.currentCoordinate = this.routeOrigin;
        this.originResolved = true;
        this.originFromDevice = true;
        const accuracy = Number(position.coords.accuracy);
        originInput.value = Number.isFinite(accuracy) && accuracy > 0
          ? `Lokasi saya saat ini (±${Math.max(1, Math.round(accuracy))} m)`
          : "Lokasi saya saat ini";
        navigationRuntimeBridge()?.applyUserLocation?.(
          position.coords.latitude,
          position.coords.longitude,
          position.coords.accuracy,
          false,
          "navigation3d-geolocation",
        );
        this.syncNavigationUrl(this.selectedPlace ? "preview" : "search");
      } catch {
        const params = new URLSearchParams(window.location.search);
        const rawLatitude = params.get("fromLat") ?? params.get("lat");
        const rawLongitude = params.get("fromLng") ?? params.get("lng");
        const latitude = rawLatitude === null ? Number.NaN : Number(rawLatitude);
        const longitude = rawLongitude === null ? Number.NaN : Number(rawLongitude);
        const urlLocation = Number.isFinite(latitude) && Math.abs(latitude) <= 90
          && Number.isFinite(longitude) && Math.abs(longitude) <= 180
          ? { lat: latitude, lng: longitude }
          : null;
        const runtimeLocation = navigationRuntimeBridge()?.getUserLocation?.()
          || navigationRuntimeBridge()?.getMapCenter?.()
          || null;
        const fallback = urlLocation || runtimeLocation;
        this.routeOrigin = fallback
          ? [fallback.lng, fallback.lat]
          : DEFAULT_NAVIGATION_CENTER;
        this.currentCoordinate = this.routeOrigin;
        this.originResolved = true;
        this.originFromDevice = !urlLocation
          && Boolean(runtimeLocation?.source && /geo|gps|location/i.test(runtimeLocation.source));
        originInput.value = fallback
          ? "Titik peta (GPS perangkat belum diizinkan)"
          : "Titik awal bawaan (GPS perangkat belum diizinkan)";
        this.syncNavigationUrl(this.selectedPlace ? "preview" : "search");
      }
      return this.routeOrigin;
    })();
    try {
      return await this.originPromise;
    } finally {
      this.originPromise = null;
    }
  }

  private syncNavigationUrl(stage: "map" | "search" | "preview", query = ""): void {
    const params = new URLSearchParams(window.location.search);
    params.set("nav", stage);
    params.set("travel", this.mode);
    const destinationQuery = query.trim() || this.selectedPlace?.title || "";
    if (destinationQuery) params.set("destination", destinationQuery.slice(0, 180));
    else params.delete("destination");
    if (this.originResolved) {
      params.set("fromLat", this.routeOrigin[1].toFixed(6));
      params.set("fromLng", this.routeOrigin[0].toFixed(6));
      params.set("origin", this.originFromDevice ? "device" : "map");
    }
    if (this.selectedPlace) {
      params.set("toLat", this.selectedPlace.coordinate[1].toFixed(6));
      params.set("toLng", this.selectedPlace.coordinate[0].toFixed(6));
    } else {
      params.delete("toLat");
      params.delete("toLng");
    }
    const queryString = params.toString();
    const next = `${window.location.pathname}${queryString ? `?${queryString}` : ""}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", next);
  }

  private setSearchStatus(message: string): void {
    this.element("[data-nav3d-search-status]").textContent = message;
  }

  private clearSearchResults(): void {
    this.searchResults = [];
    this.activeResultIndex = -1;
    this.element<HTMLElement>("[data-nav3d-results]").setAttribute("hidden", "");
    this.element<HTMLElement>("[data-nav3d-results]").replaceChildren();
    this.syncComboboxState();
  }

  private async performSearch(): Promise<void> {
    const input = this.element<HTMLInputElement>("[data-nav3d-search-input]");
    const results = this.element<HTMLElement>("[data-nav3d-results]");
    const query = input.value.trim();
    this.syncNavigationUrl("search", query);
    if (query.length < 3) {
      this.clearSearchResults();
      this.setSearchStatus("Ketik minimal tiga karakter untuk mencari tujuan.");
      return;
    }

    this.searchAbort?.abort();
    this.searchAbort = new AbortController();
    this.searchResults = [];
    this.activeResultIndex = -1;
    results.removeAttribute("hidden");
    results.innerHTML = `<div class="nav3d-empty" role="presentation"><span aria-hidden="true" class="nav3d-inline-spinner"></span>Mencari “${escapeHtml(query)}”…</div>`;
    this.setSearchStatus(`Mencari ${query}.`);
    this.syncComboboxState();

    try {
      const origin = await this.resolveOrigin();
      const localPlaces = localPlaceMatches(query, origin);
      let remotePlaces: SearchPlace[] = [];
      try {
        remotePlaces = await searchPlaces(query, origin, this.searchAbort.signal);
      } catch (error) {
        if ((error as Error).name === "AbortError") throw error;
        // Already loaded ITS/OSM POIs remain searchable when a public geocoder
        // is temporarily unavailable.
        if (localPlaces.length === 0) throw error;
      }
      const places = mergePlaceResults(localPlaces, remotePlaces);
      this.searchResults = places;
      if (places.length === 0) {
        results.innerHTML = `<div class="nav3d-empty" role="presentation">Lokasi tidak ditemukan. Coba nama yang lebih lengkap.</div>`;
        this.setSearchStatus("Lokasi tidak ditemukan.");
        this.syncComboboxState();
        return;
      }
      results.innerHTML = places
        .map(
          (place, index) => `
          <button
            type="button"
            id="its-nav3d-option-${index}"
            class="nav3d-place"
            data-nav3d-place-id="${escapeHtml(place.id)}"
            role="option"
            aria-selected="false"
          >
            <span class="nav3d-place-pin" aria-hidden="true">●</span>
            <span class="nav3d-place-copy"><strong>${escapeHtml(place.title)}</strong><small>${escapeHtml(place.subtitle)}</small></span>
            <span class="nav3d-place-arrow" aria-hidden="true">›</span>
          </button>`,
        )
        .join("");
      this.setSearchStatus(`${places.length} hasil ditemukan.`);
      this.syncComboboxState();
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      this.searchResults = [];
      results.innerHTML = `<div class="nav3d-error" role="presentation">Pencarian belum dapat dijangkau. Periksa koneksi lalu coba lagi.</div>`;
      this.setSearchStatus("Pencarian gagal dijangkau.");
      this.syncComboboxState();
    }
  }

  private selectPlace(place: SearchPlace): void {
    this.selectedPlace = place;
    this.clearSearchResults();
    const input = this.element<HTMLInputElement>("[data-nav3d-search-input]");
    input.value = place.title;
    this.element<HTMLElement>("[data-nav3d-preview]").removeAttribute("hidden");
    this.element("[data-nav3d-preview-title]").textContent = place.title;
    this.element("[data-nav3d-preview-subtitle]").textContent = place.subtitle;
    this.updateRoutingNote();
    this.syncNavigationUrl("preview", place.title);
    void this.previewRoute();
  }

  private setRouteActionsEnabled(enabled: boolean): void {
    this.element<HTMLButtonElement>("[data-nav3d-start]").disabled = !enabled;
    this.element<HTMLButtonElement>("[data-nav3d-demo]").disabled = !enabled;
  }

  private async previewRoute(): Promise<void> {
    if (!this.selectedPlace) return;
    const sequence = ++this.routeSequence;
    this.routeAbort?.abort();
    this.routeAbort = new AbortController();
    this.route = null;
    this.setRouteActionsEnabled(false);
    this.element("[data-nav3d-preview-distance]").textContent = "Menghitung…";
    this.element("[data-nav3d-preview-duration]").textContent = MODE_PROFILES[this.mode].label;
    try {
      const origin = await this.resolveOrigin();
      if (sequence !== this.routeSequence || !this.selectedPlace) return;
      const request: NavigationRequest = {
        origin,
        destination: this.selectedPlace.coordinate,
        destinationName: this.selectedPlace.title,
        mode: this.mode,
      };
      const route = await requestRoute(request, this.routeAbort.signal);
      if (sequence !== this.routeSequence) return;
      this.routeOrigin = origin;
      this.route = route;
      this.element("[data-nav3d-preview-distance]").textContent = formatDistance(route.distanceM);
      this.element("[data-nav3d-preview-duration]").textContent = formatDuration(route.durationS);
      this.setRouteActionsEnabled(true);
      this.setSearchStatus(`Rute ${MODE_PROFILES[this.mode].label} siap.`);
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      this.route = null;
      this.element("[data-nav3d-preview-distance]").textContent = "Rute gagal";
      this.element("[data-nav3d-preview-duration]").textContent =
        error instanceof Error ? error.message : "Coba lagi";
      this.setRouteActionsEnabled(false);
      this.setSearchStatus("Rute belum dapat dihitung.");
    }
  }

  private setLoading(title: string, detail: string): void {
    this.element("[data-nav3d-loading-title]").textContent = title;
    this.element("[data-nav3d-loading-detail]").textContent = detail;
    this.element<HTMLElement>("[data-nav3d-loading]").removeAttribute("hidden");
  }

  private async start(simulation: boolean): Promise<void> {
    if (!this.selectedPlace || !this.route) return;
    this.launcherBeforeOverlay = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = this.element<HTMLElement>("[data-nav3d-overlay]");
    overlay.removeAttribute("hidden");
    document.body.classList.add("nav3d-active");
    this.setLoading(
      "Menyiapkan navigasi 3D",
      "Membangun jalan, gedung, jembatan, dan ornamen dari data yang tersedia.",
    );

    try {
      const origin = simulation ? this.routeOrigin : await this.resolveOrigin(true);
      this.currentCoordinate = origin;
      if (distanceM(origin, this.routeOrigin) > 45) {
        this.route = await requestRoute({
          origin,
          destination: this.selectedPlace.coordinate,
          destinationName: this.selectedPlace.title,
          mode: this.mode,
        });
        this.routeOrigin = origin;
      }
      const routeCoordinates = this.route.geometry.geometry.coordinates as LngLat[];
      const initialMatch = nearestPointOnRoute(origin, routeCoordinates);
      this.currentCoordinate = initialMatch.distanceToRouteM <= 45 ? initialMatch.coordinate : origin;
      this.currentBearing = forwardBearingOnRoute(
        routeCoordinates,
        initialMatch.distanceAlongRouteM,
        36,
      );
      await this.createMap(this.currentCoordinate);
      await this.loadScene(this.currentCoordinate, true, initialMatch.distanceAlongRouteM);
      this.element<HTMLElement>("[data-nav3d-loading]").setAttribute("hidden", "");
      this.element<HTMLButtonElement>("[data-nav3d-exit]").focus();
      this.updateHud(0);
      if (simulation) {
        this.setRuntimeStatus("Mode simulasi aktif. Posisi bergerak mengikuti rute terhitung.");
        this.startSimulation();
      } else {
        this.setRuntimeStatus("Menunggu pembaruan GPS perangkat.");
        this.startLocationWatch();
      }
    } catch (error) {
      this.stop(false);
      this.setSearchStatus(
        `Navigasi 3D belum dapat dimulai: ${error instanceof Error ? error.message : "kesalahan tidak diketahui"}`,
      );
      this.element<HTMLButtonElement>("[data-nav3d-start]").focus();
    }
  }

  private async createMap(center: LngLat): Promise<void> {
    this.map?.remove();
    // The overlay has just changed from `display:none` to fullscreen. Wait for
    // layout before MapLibre measures its canvas; otherwise Chromium may keep
    // the canvas at the HTML default 300px height.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    this.map = new maplibregl.Map({
      container: this.element<HTMLElement>("[data-nav3d-map]"),
      // Buildings close to navigation come from the higher-resolution
      // Overpass scene, where footprints intersecting the snapped route are
      // removed. The z15 national building backdrop is intentionally omitted
      // here so an overscaled footprint can never cover the guidance lane.
      style: navigationStyle({ includeNationalBuildings: true }),
      center,
      zoom: MODE_PROFILES[this.mode].zoom,
      pitch: MODE_PROFILES[this.mode].pitch,
      bearing: this.currentBearing,
      minZoom: 14,
      maxZoom: 22,
      maxPitch: 80,
      attributionControl: { compact: true },
      canvasContextAttributes: { antialias: true },
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Peta 3D melewati batas waktu.")), MAP_LOAD_TIMEOUT_MS);
      this.map?.once("load", () => {
        window.clearTimeout(timeout);
        resolve();
      });
    });
    if (!this.map) throw new Error("Peta 3D tidak tersedia.");
    installNavigationLayers(this.map);
    if (this.route) setRoute(this.map, this.route);
    this.threeLayer = new ThreeOrnamentsLayer();
    this.map.addLayer(this.threeLayer);
    this.threeLayer.setOrigin(center);
    this.threeLayer.setAvatarMode(this.mode);
    this.threeLayer.updateAvatar(center, this.currentBearing);
    this.map.on("dragstart", () => {
      this.followCamera = false;
      this.setRuntimeStatus("Kamera bebas. Tekan tombol pusat untuk mengikuti perjalanan kembali.");
    });
    this.map.on("error", () => {
      this.setRuntimeStatus("Sebagian detail peta 3D belum termuat; navigasi rute tetap berjalan.");
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    this.map.resize();
    this.updateCamera(true);
  }

  private async loadScene(
    center: LngLat,
    force = false,
    knownDistanceAlongRouteM?: number,
  ): Promise<void> {
    if (!this.map) return;
    const profile = MODE_PROFILES[this.mode];
    const routeCoordinates = (this.route?.geometry.geometry.coordinates || []) as LngLat[];
    const matched =
      routeCoordinates.length >= 2 ? nearestPointOnRoute(center, routeCoordinates) : null;
    const distanceAlongRouteM =
      knownDistanceAlongRouteM ?? matched?.distanceAlongRouteM ?? 0;
    // Load the real geometry primarily in front of the vehicle, where a
    // pitched navigation camera can see it. The current position remains well
    // inside the query radius, while upcoming junctions/bridges arrive early.
    const sceneLookAheadM = Math.min(260, Math.max(65, profile.sceneRadiusM * 0.27));
    const sceneFocus =
      routeCoordinates.length >= 2
        ? coordinateAlongLine(
            routeCoordinates,
            distanceAlongRouteM + sceneLookAheadM,
          ).coordinate
        : center;
    if (
      !force &&
      this.sceneCenter &&
      distanceM(this.sceneCenter, sceneFocus) < profile.reloadDistanceM
    ) {
      return;
    }
    this.sceneCenter = sceneFocus;
    this.sceneAbort?.abort();
    this.sceneAbort = new AbortController();
    try {
      const payload = await fetchRoadScene(
        sceneFocus,
        profile.sceneRadiusM,
        this.sceneAbort.signal,
      );
      if (!this.map) return;
      const localRoute = routeWindowAround(
        routeCoordinates,
        sceneFocus,
        profile.sceneRadiusM * 1.25,
      );
      if (this.route && localRoute.length >= 2) {
        setRoute(this.map, {
          ...this.route,
          geometry: {
            ...this.route.geometry,
            geometry: { type: "LineString", coordinates: localRoute },
          },
        });
      }
      const scene = buildNavigationScene(payload, {
        maximumOrnaments: 650,
        focusRoute: localRoute,
        routeClearanceM: 1.35,
      });
      setScene(this.map, scene);
      this.threeLayer?.setOrnaments(sceneFocus, scene.ornaments);
      this.threeLayer?.setAvatarMode(this.mode);
      this.threeLayer?.updateAvatar(this.currentCoordinate, this.currentBearing);
      this.setRuntimeStatus("Detail jalan 3D diperbarui dari data terbuka di sekitar perjalanan.");
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        this.setRuntimeStatus("Detail ornamen sekitar belum tersedia; rute 3D tetap dapat digunakan.");
      }
    }
  }

  private startLocationWatch(): void {
    if (!navigator.geolocation) {
      this.setRuntimeStatus("GPS tidak tersedia. Keluar lalu pilih Uji simulasi untuk demonstrasi.");
      return;
    }
    this.locationWatch = navigator.geolocation.watchPosition(
      (position) => {
        const coordinate: LngLat = [position.coords.longitude, position.coords.latitude];
        const speed = Number.isFinite(position.coords.speed)
          ? Math.max(0, Number(position.coords.speed) * 3.6)
          : this.currentSpeedKmh;
        this.applyPosition(coordinate, position.coords.heading, speed);
      },
      () => {
        this.setRuntimeStatus("Pembaruan GPS terhenti. Keluar lalu pilih Uji simulasi bila diperlukan.");
      },
      { enableHighAccuracy: true, maximumAge: 1_200, timeout: 12_000 },
    );
  }

  private startSimulation(): void {
    if (!this.route) return;
    cancelAnimationFrame(this.simulationFrame);
    this.simulationStart = performance.now();
    const speed =
      this.mode === "walk" ? 5 : this.mode === "bicycle" ? 18 : this.mode === "truck" ? 42 : 48;
    const animate = (time: number): void => {
      if (!this.route || !this.map) return;
      const elapsedSeconds = (time - this.simulationStart) / 1_000;
      const traveled = elapsedSeconds * (speed / 3.6);
      const sample = coordinateAlongLine(
        this.route.geometry.geometry.coordinates as LngLat[],
        traveled,
      );
      this.applyPosition(sample.coordinate, sample.bearing, speed);
      if (traveled < this.route.distanceM) this.simulationFrame = requestAnimationFrame(animate);
      else this.setRuntimeStatus("Simulasi tiba di tujuan.");
    };
    this.simulationFrame = requestAnimationFrame(animate);
  }

  private applyPosition(rawCoordinate: LngLat, rawBearing: number | null, speedKmh: number): void {
    if (!this.route || !this.map) return;
    const routeCoordinates = this.route.geometry.geometry.coordinates as LngLat[];
    const matched = nearestPointOnRoute(rawCoordinate, routeCoordinates);
    this.currentCoordinate = matched.distanceToRouteM < 38 ? matched.coordinate : rawCoordinate;
    const safeSpeedKmh = Math.max(0, speedKmh);
    const routeBearing = forwardBearingOnRoute(
      routeCoordinates,
      matched.distanceAlongRouteM,
      Math.max(18, Math.min(58, safeSpeedKmh * 0.8 + 18)),
    );
    const gpsBearingIsUsable =
      rawBearing !== null &&
      Number.isFinite(rawBearing) &&
      safeSpeedKmh >= 4 &&
      (matched.distanceToRouteM >= 38 ||
        Math.abs(bearingDeltaDegrees(routeBearing, rawBearing)) <= 58);
    // While snapped, route order is authoritative. Phone headings are often
    // 180 degrees wrong when stationary; accepting that value made the old
    // camera look backwards even though the route itself was correct.
    const bearing = gpsBearingIsUsable ? Number(rawBearing) : routeBearing;
    this.currentBearing = smoothBearing(
      this.currentBearing,
      bearing,
      this.currentSpeedKmh < 1 ? 0.72 : 0.38,
    );
    this.currentSpeedKmh = this.currentSpeedKmh * 0.65 + safeSpeedKmh * 0.35;
    this.threeLayer?.updateAvatar(this.currentCoordinate, this.currentBearing);
    const traveled = routeCoordinates.slice(0, matched.segmentIndex + 1);
    traveled.push(this.currentCoordinate);
    setTraveledRoute(this.map, traveled);
    if (this.followCamera) this.updateCamera(false);
    this.updateHud(matched.distanceAlongRouteM);
    void this.loadScene(this.currentCoordinate, false, matched.distanceAlongRouteM);
  }

  private updateCamera(immediate: boolean): void {
    if (!this.map) return;
    const profile = MODE_PROFILES[this.mode];
    const canvas = this.map.getCanvas();
    const viewportWidth = Math.max(320, canvas.clientWidth || canvas.width || window.innerWidth);
    const viewportHeight = Math.max(480, canvas.clientHeight || canvas.height || window.innerHeight);
    const compact = viewportWidth <= 720;
    // Keep the tracked avatar below the visual center so the next road segment
    // occupies the lower and middle viewport, like a lane-level navigation view.
    // Reserve only the actual HUD footprint. Large simultaneous top/bottom
    // padding collapses MapLibre's usable camera viewport on a phone and can
    // push the road into a corner.
    const topPadding = compact
      ? Math.max(94, Math.min(124, Math.round(viewportHeight * 0.13)))
      : Math.max(72, Math.min(108, Math.round(viewportHeight * 0.1)));
    const bottomPadding = compact
      ? Math.max(profile.bottomPadding, Math.min(172, Math.round(viewportHeight * 0.19)))
      : Math.max(104, Math.min(profile.bottomPadding, Math.round(viewportHeight * 0.16)));
    const horizontalPadding = compact ? 12 : 26;
    const zoomAdjustment =
      this.currentSpeedKmh >= 80 ? -0.85 : this.currentSpeedKmh >= 50 ? -0.45 : this.currentSpeedKmh >= 25 ? -0.15 : 0;
    let cameraCenter = this.currentCoordinate;
    if (this.route) {
      const coordinates = this.route.geometry.geometry.coordinates as LngLat[];
      const matched = nearestPointOnRoute(this.currentCoordinate, coordinates);
      // A navigation camera must read the road ahead, not stare at the bonnet.
      // Scale the target with speed while retaining enough context for urban
      // junctions, ramps and bridges to enter the view before the maneuver.
      const profileLookAheadM = this.mode === "truck"
        ? 125
        : this.mode === "motorcycle"
          ? 64
          : this.mode === "bicycle"
            ? 48
            : this.mode === "walk"
              ? 20
              : this.mode === "transit"
                ? 82
                : 68;
      const lookAheadM = Math.max(16, Math.min(145, profileLookAheadM + this.currentSpeedKmh * 0.22));
      cameraCenter = coordinateAlongLine(
        coordinates,
        matched.distanceAlongRouteM + lookAheadM,
      ).coordinate;
    }
    this.map.easeTo({
      center: cameraCenter,
      bearing: this.currentBearing,
      pitch: profile.pitch,
      zoom: profile.zoom + zoomAdjustment,
      duration: immediate ? 0 : 420,
      essential: true,
      padding: {
        top: topPadding,
        right: horizontalPadding,
        bottom: bottomPadding,
        left: horizontalPadding,
      },
    });
  }

  private updateHud(traveledM: number): void {
    if (!this.route) return;
    const remainingM = Math.max(0, this.route.distanceM - traveledM);
    const progress = this.route.distanceM > 0 ? Math.min(1, traveledM / this.route.distanceM) : 0;
    const remainingSeconds = this.route.durationS * (1 - progress);
    const arrival = new Date(Date.now() + remainingSeconds * 1_000);
    let nextManeuver: RouteManeuver | null = null;
    let nextDistance = remainingM;
    for (const maneuver of this.route.maneuvers) {
      const match = nearestPointOnRoute(
        maneuver.coordinate,
        this.route.geometry.geometry.coordinates as LngLat[],
      );
      const maneuverDistance = match.distanceAlongRouteM - traveledM;
      if (maneuverDistance >= -10) {
        nextManeuver = maneuver;
        nextDistance = Math.max(0, maneuverDistance);
        break;
      }
    }
    this.element("[data-nav3d-turn]").textContent = maneuverArrow(nextManeuver);
    this.element("[data-nav3d-instruction-distance]").textContent = formatDistance(nextDistance);
    this.element("[data-nav3d-instruction-text]").textContent =
      nextManeuver?.instruction || "Lanjutkan perjalanan";
    this.element("[data-nav3d-instruction-road]").textContent =
      nextManeuver?.roadName || this.selectedPlace?.title || "ITS Maps";
    this.element("[data-nav3d-speed]").textContent = String(Math.round(this.currentSpeedKmh));
    this.element("[data-nav3d-speed-limit]").textContent = String(modeSpeedLimit(this.mode));
    this.element("[data-nav3d-arrival]").textContent = arrival.toLocaleTimeString("id-ID", {
      hour: "2-digit",
      minute: "2-digit",
    });
    this.element("[data-nav3d-remaining]").textContent =
      `${formatDistance(remainingM)} · ${formatDuration(remainingSeconds)}`;
    const progressBar = this.element<HTMLElement>(".nav3d-progress");
    const percentage = Math.round(progress * 100);
    progressBar.setAttribute("aria-valuenow", String(percentage));
    const fill = progressBar.querySelector<HTMLElement>("span");
    if (fill) fill.style.width = `${percentage}%`;
  }

  private setRuntimeStatus(message: string): void {
    if (!this.root) return;
    this.element("[data-nav3d-runtime-status]").textContent = message;
  }

  stop(restoreFocus = true): void {
    cancelAnimationFrame(this.simulationFrame);
    this.simulationFrame = 0;
    if (this.locationWatch !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(this.locationWatch);
    }
    this.sceneAbort?.abort();
    this.map?.remove();
    this.map = null;
    this.threeLayer = null;
    this.sceneCenter = null;
    this.locationWatch = null;
    this.followCamera = true;
    this.currentSpeedKmh = 0;
    if (!this.root) return;
    this.element<HTMLElement>("[data-nav3d-overlay]").setAttribute("hidden", "");
    this.element<HTMLElement>("[data-nav3d-loading]").removeAttribute("hidden");
    document.body.classList.remove("nav3d-active");
    if (restoreFocus) {
      (this.launcherBeforeOverlay || this.element<HTMLElement>("[data-nav3d-start]")).focus();
    }
  }
}
