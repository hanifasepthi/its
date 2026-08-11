import {
  CctvCatalogLoader,
  type CctvCatalogFeature,
  type CctvCatalogRegion,
  type CctvCatalogRegionPage,
  type CctvCatalogSummary,
} from "../cctv/CctvCatalogLoader";

type FeedSignal = "red" | "yellow" | "green" | "unknown";

type RegionView = {
  region: CctvCatalogRegion;
  pages: CctvCatalogRegionPage[];
  loadingPage: boolean;
};

type FeedSnapshot = {
  id: string;
  imageUrl: string;
  capturedAt: number;
  objectCount: number;
  elapsedSec?: number;
  accent?: string;
  detections?: Array<{ label?: string; confidence?: number }>;
};

type AnalysisStatus = {
  state: string;
  message: string;
};

type SearchRegion = {
  region: CctvCatalogRegion;
  features: CctvCatalogFeature[];
};

const FEED_BATCH_SIZE = 4;
const MAX_SEGMENTS_PER_CARD = 3;
const SEARCH_RESULT_LIMIT = 60;
const SEARCH_DEBOUNCE_MS = 260;
const ANALYSIS_REFRESH_SCAN_MS = 30_000;
const ANALYSIS_FRESH_FOR_MS = 90_000;
const ANALYSIS_RETRY_AFTER_MS = 120_000;
const TRAVEL_ALERT_STORAGE_KEY = "its-cctv-travel-alerts:v1";
const LAST_USER_LOCATION_STORAGE_KEY = "its-last-user-location:v1";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cleanText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function normalized(value: unknown): string {
  return cleanText(value).toLocaleLowerCase("id-ID");
}

function featureId(feature: CctvCatalogFeature): string {
  return cleanText(feature.id) || cleanText(feature.properties.sourceId);
}

function featureTitle(feature: CctvCatalogFeature): string {
  const properties = feature.properties;
  return cleanText(properties.name)
    || cleanText(properties.title)
    || cleanText(properties.label)
    || cleanText(properties.description)
    || featureId(feature)
    || "CCTV";
}

function featureSubtitle(feature: CctvCatalogFeature, regionName: string): string {
  const properties = feature.properties;
  return cleanText(properties.address)
    || cleanText(properties.location)
    || cleanText(properties.area)
    || cleanText(properties.city)
    || regionName;
}

function regionDisplayName(regionName: string, features: CctvCatalogFeature[]): string {
  const first = features[0]?.properties;
  if (!first) return regionName;
  const explicitProvince = cleanText(first.province)
    || cleanText(first.provinceName)
    || cleanText(first.provinsi);
  if (explicitProvince && normalized(explicitProvince) !== normalized(regionName)) {
    return `${regionName} · ${explicitProvince}`;
  }
  const address = cleanText(first.address) || cleanText(first.location);
  if (!address) return regionName;
  const regionAt = normalized(address).lastIndexOf(normalized(regionName));
  if (regionAt < 0) return regionName;
  const suffix = address.slice(regionAt + regionName.length).replace(/^\s*,\s*/, "");
  const inferredProvince = suffix.split(",")[0]?.trim() || "";
  return inferredProvince && normalized(inferredProvince) !== normalized(regionName)
    ? `${regionName} · ${inferredProvince}`
    : regionName;
}

function featureSource(feature: CctvCatalogFeature): string {
  const properties = feature.properties;
  return cleanText(properties.operator)
    || cleanText(properties.source)
    || cleanText(properties.attribution)
    || "Direktori publik resmi";
}

function featureStreamUrl(feature: CctvCatalogFeature): string {
  const properties = feature.properties;
  const direct = cleanText(properties.streamUrl);
  if (/^(?:https?|wss):\/\//i.test(direct) && !direct.includes("@")) return direct;
  if (!Array.isArray(properties.streams)) return "";
  for (const entry of properties.streams) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const candidate = cleanText(record.streamUrl) || cleanText(record.url);
    if (/^(?:https?|wss):\/\//i.test(candidate) && !candidate.includes("@")) return candidate;
  }
  return "";
}

function featureIsVerifiedLive(feature: CctvCatalogFeature): boolean {
  return /^(?:verified-live|public-live|live|reachable)$/i.test(cleanText(feature.properties.streamStatus));
}

function distanceMeters(left: { lat: number; lng: number }, right: { lat: number; lng: number }): number {
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(right.lat - left.lat);
  const dLng = radians(right.lng - left.lng);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(left.lat)) * Math.cos(radians(right.lat)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function readLastUserLocation(): { lat: number; lng: number; updatedAt: number } | null {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_USER_LOCATION_STORAGE_KEY) || "null") as Record<string, unknown> | null;
    const lat = Number(value?.lat);
    const lng = Number(value?.lng);
    const updatedAt = Number(value?.updatedAt);
    return Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(updatedAt)
      ? { lat, lng, updatedAt }
      : null;
  } catch {
    return null;
  }
}

function featureCoordinates(feature: CctvCatalogFeature): { lat: number; lng: number } | null {
  const coordinates = feature.geometry.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const [longitude, latitude] = coordinates;
  return Number.isFinite(longitude) && Number.isFinite(latitude)
    ? { lat: Number(latitude), lng: Number(longitude) }
    : null;
}

function readTravelAlertState(): boolean {
  try {
    return localStorage.getItem(TRAVEL_ALERT_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function safeSnapshot(value: unknown): FeedSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id);
  const imageUrl = cleanText(record.imageUrl);
  const capturedAt = Number(record.capturedAt);
  if (!id || !/^(?:data:image\/|blob:|https?:\/\/)/i.test(imageUrl) || !Number.isFinite(capturedAt)) return null;
  const detections = Array.isArray(record.detections)
    ? record.detections.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const detection = entry as Record<string, unknown>;
      return [{ label: cleanText(detection.label), confidence: Number(detection.confidence) || 0 }];
    })
    : [];
  return {
    id,
    imageUrl,
    capturedAt,
    objectCount: Math.max(0, Math.round(Number(record.objectCount) || 0)),
    elapsedSec: Number.isFinite(Number(record.elapsedSec)) ? Number(record.elapsedSec) : undefined,
    accent: /^#[0-9a-f]{6}$/i.test(cleanText(record.accent)) ? cleanText(record.accent) : undefined,
    detections,
  };
}

function congestionForCount(count: number): { label: string; color: FeedSignal } {
  if (count >= 24) return { label: "MACET", color: "red" };
  if (count >= 10) return { label: "PADAT", color: "yellow" };
  return { label: "LANCAR", color: "green" };
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function estimatedSignal(id: string, vehicles: number, now = Date.now()): { signal: FeedSignal; remaining: number } {
  if (!id) return { signal: "unknown", remaining: 0 };
  const redDuration = Math.max(24, Math.min(62, 28 + Math.round(vehicles * 1.25)));
  const yellowDuration = 4;
  const greenDuration = Math.max(20, Math.min(48, 42 - Math.round(vehicles * 0.45)));
  const total = redDuration + yellowDuration + greenDuration;
  const elapsed = (Math.floor(now / 1_000) + stableHash(id) % total) % total;
  if (elapsed < redDuration) return { signal: "red", remaining: redDuration - elapsed };
  if (elapsed < redDuration + yellowDuration) {
    return { signal: "yellow", remaining: redDuration + yellowDuration - elapsed };
  }
  return { signal: "green", remaining: total - elapsed };
}

function analysisLabel(status: AnalysisStatus | undefined, snapshots: FeedSnapshot[]): { state: string; headline: string; detail: string } {
  if (snapshots.length) {
    const vehicles = snapshots[0]?.objectCount || 0;
    const congestion = congestionForCount(vehicles);
    return {
      state: "complete",
      headline: congestion.label,
      detail: `${vehicles} kendaraan · segmen AI ${snapshots.length}/3`,
    };
  }
  const state = status?.state || "ready";
  const detail = status?.message || "AI dimulai otomatis saat kamera terlihat";
  const headline: Record<string, string> = {
    ready: "AI OTOMATIS",
    queued: "ANTRE AI",
    loading: "MENYIAPKAN",
    analyzing: "AI AKTIF",
    retry: "COBA LAGI",
    deferred: "DITUNDA",
    unsupported: "FORMAT TERBATAS",
    unavailable: "TIDAK TERSEDIA",
    complete: "SELESAI",
  };
  return { state, headline: headline[state] || "AI OTOMATIS", detail };
}

function featureMatches(feature: CctvCatalogFeature, regionName: string, terms: string[]): boolean {
  if (!terms.length) return true;
  const properties = feature.properties;
  const searchable = [
    featureTitle(feature),
    featureSubtitle(feature, regionName),
    regionName,
    properties.operator,
    properties.source,
    properties.attribution,
    properties.catalogSourceKey,
  ].map(normalized).join(" ");
  return terms.every((term) => searchable.includes(term));
}

export class ItsCctvTrafficFeed extends HTMLElement {
  private readonly loader = new CctvCatalogLoader();

  private summary: CctvCatalogSummary | null = null;

  private readonly regions = new Map<string, RegionView>();

  private orderedRegionIds: string[] = [];

  private readonly featureIndex = new Map<string, CctvCatalogFeature>();

  private readonly snapshotCache = new Map<string, FeedSnapshot[]>();

  private readonly analysisStatus = new Map<string, AnalysisStatus>();

  private readonly requestedAnalysis = new Set<string>();

  private readonly nextAnalysisAt = new Map<string, number>();

  private activeFeature: CctvCatalogFeature | null = null;

  private activeFeatureToken = 0;

  private nextOffset = 0;

  private exhausted = false;

  private loadingSummary = true;

  loadingRegions = false;

  observer: IntersectionObserver | null = null;

  private regionObserver: IntersectionObserver | null = null;

  private cardObserver: IntersectionObserver | null = null;

  private analysisPrewarmTimer = 0;

  catalogContinuationFrame = 0;

  private observerSyncFrame = 0;

  private signalTimer = 0;

  private analysisRefreshTimer = 0;

  private pinCarouselIndex = 0;

  private pinCarouselTimer = 0;

  private readonly pinCarouselIntervalMs = 4500;

  private searchTimer = 0;

  private searchToken = 0;

  private searchQuery = "";

  private searchLoading = false;

  private searchResults: SearchRegion[] | null = null;

  private errorMessage = "";

  private connected = false;

  private headerCompact = false;

  private compactSearchOpen = false;

  private scrollHost: HTMLElement | null = null;

  private userLocation: { lat: number; lng: number; updatedAt: number } | null = null;

  private travelActive = false;

  private renderSearchSkeleton(
    cardCount = 4
  ): string {
    const cards = Array.from(
      { length: cardCount },
      (_, index) => `
      <article
        class="
          its-cctv-feed__card
          its-cctv-feed__search-skeleton-card
        "
        aria-hidden="true"
        style="--skeleton-index:${index}"
      >

        <!-- =========================
             BAGIAN ATAS CARD
             ========================= -->

        <div class="its-cctv-search-skeleton__summary">

          <!-- Traffic light -->
          <div class="its-cctv-search-skeleton__traffic">
            <i></i>
            <i></i>
            <i></i>
          </div>


          <!-- Judul -->
          <div class="its-cctv-search-skeleton__title">

            <i
              class="
                its-cctv-search-skeleton__line
                its-cctv-search-skeleton__line--title
              "
            ></i>

            <i
              class="
                its-cctv-search-skeleton__line
                its-cctv-search-skeleton__line--subtitle
              "
            ></i>

          </div>


          <!-- Countdown -->
          <div class="its-cctv-search-skeleton__countdown">
            <i></i>
            <span></span>
          </div>

        </div>


        <!-- =========================
             3 PREVIEW / SEGMENT CCTV
             ========================= -->

        <div class="its-cctv-search-skeleton__segments">

          ${Array.from(
        { length: 3 },
        (_, segmentIndex) => `
              <div
                class="its-cctv-search-skeleton__segment"
                style="--segment-index:${segmentIndex}"
              >
                <i
                  class="its-cctv-search-skeleton__image"
                ></i>

                <span>
                  <i
                    class="
                      its-cctv-search-skeleton__line
                      its-cctv-search-skeleton__line--segment
                    "
                  ></i>

                  <i
                    class="
                      its-cctv-search-skeleton__line
                      its-cctv-search-skeleton__line--time
                    "
                  ></i>
                </span>
              </div>
            `
      ).join("")}

        </div>


        <!-- =========================
             FOOTER
             ========================= -->

        <footer class="its-cctv-search-skeleton__footer">

          <i
            class="
              its-cctv-search-skeleton__line
              its-cctv-search-skeleton__line--source
            "
          ></i>

          <i
            class="its-cctv-search-skeleton__button"
          ></i>

        </footer>

      </article>
    `
    ).join("");


    return `
    <section
      class="
        its-cctv-feed__region
        its-cctv-feed__search-skeleton
      "
      aria-busy="true"
      aria-label="Mencari CCTV"
    >

      <!-- Skeleton header wilayah -->
      <header>

        <div>
          <i
            class="
              its-cctv-search-skeleton__line
              its-cctv-search-skeleton__line--region
            "
            aria-hidden="true"
          ></i>

          <i
            class="
              its-cctv-search-skeleton__line
              its-cctv-search-skeleton__line--region-meta
            "
            aria-hidden="true"
          ></i>
        </div>


        <i
          class="
            its-cctv-search-skeleton__line
            its-cctv-search-skeleton__line--counter
          "
          aria-hidden="true"
        ></i>

      </header>


      <div class="its-cctv-feed__grid">
        ${cards}
      </div>


      <span class="its-cctv-feed__sr-only">
        Sedang mencari CCTV yang sesuai dengan
        ${escapeHtml(this.searchQuery.trim())}
      </span>

    </section>
  `;
  }

  private syncPinCarousel(animate = false): void {
    const carousel =
      this.querySelector<HTMLElement>(
        "[data-cctv-pin-carousel]"
      );

    if (!carousel) return;


    const viewport =
      carousel.querySelector<HTMLElement>(
        ".its-cctv-feed__pin-viewport"
      );

    const track =
      carousel.querySelector<HTMLElement>(
        ".its-cctv-feed__pin-track"
      );

    const slides = Array.from(
      carousel.querySelectorAll<HTMLElement>(
        ".its-cctv-feed__pin-slide"
      )
    );

    const dotsHost =
      carousel.querySelector<HTMLElement>(
        ".its-cctv-feed__pin-dots"
      );


    if (
      !viewport ||
      !track ||
      !dotsHost ||
      slides.length === 0
    ) {
      return;
    }


    /* ===============================
       Pastikan index valid
       =============================== */

    this.pinCarouselIndex =
      (
        this.pinCarouselIndex %
        slides.length +
        slides.length
      ) % slides.length;


    /* ===============================
       Buat DOT otomatis
  
       2 slide = 2 dot
       3 slide = 3 dot
       dst.
       =============================== */

    if (
      dotsHost.children.length !==
      slides.length
    ) {
      dotsHost.replaceChildren();

      slides.forEach((_, index) => {
        const dot =
          document.createElement("button");

        dot.type = "button";

        dot.className =
          "its-cctv-feed__pin-dot";

        dot.dataset.cctvPinDot =
          String(index);

        dot.setAttribute(
          "aria-label",
          `Tampilkan informasi ${index + 1}`
        );

        dotsHost.appendChild(dot);
      });
    }


    /* ===============================
       Hitung tinggi CARD
  
       Ambil card paling tinggi supaya
       pergeseran track selalu presisi.
       =============================== */

    let slideHeight =
      Number.parseFloat(
        carousel.style.getPropertyValue(
          "--cctv-pin-slide-height"
        )
      );


    if (
      !Number.isFinite(slideHeight) ||
      slideHeight <= 0
    ) {
      /*
       * Belum ada ukuran.
       * Ukur semua card terlebih dahulu.
       */

      const heights =
        slides.map((slide) =>
          Math.ceil(
            slide.getBoundingClientRect().height
          )
        );


      slideHeight =
        Math.max(
          58,
          ...heights
        );


      carousel.style.setProperty(
        "--cctv-pin-slide-height",
        `${slideHeight}px`
      );

      carousel.classList.add(
        "is-carousel-ready"
      );
    }


    /* tinggi viewport = tepat 1 card */

    viewport.style.height =
      `${slideHeight}px`;


    /* ===============================
       Geser TRACK secara vertikal
       =============================== */

    if (!animate) {
      track.style.transition = "none";
    }


    const offset =
      this.pinCarouselIndex *
      slideHeight;


    track.style.transform =
      `translate3d(0, -${offset}px, 0)`;


    if (!animate) {
      requestAnimationFrame(() => {
        if (!track.isConnected) return;

        track.style.transition = "";
      });
    }


    /* ===============================
       Update DOT
       =============================== */

    const dots = Array.from(
      dotsHost.querySelectorAll<HTMLButtonElement>(
        ".its-cctv-feed__pin-dot"
      )
    );


    dots.forEach((dot, index) => {
      const active =
        index === this.pinCarouselIndex;

      dot.classList.toggle(
        "is-active",
        active
      );

      dot.setAttribute(
        "aria-current",
        active ? "true" : "false"
      );
    });


    /* Accessibility */

    slides.forEach((slide, index) => {
      slide.setAttribute(
        "aria-hidden",
        String(
          index !==
          this.pinCarouselIndex
        )
      );
    });
  }

  private showPinCarouselSlide(
    index: number
  ): void {
    const slides =
      this.querySelectorAll<HTMLElement>(
        ".its-cctv-feed__pin-slide"
      );

    if (!slides.length) return;


    const nextIndex =
      (
        index %
        slides.length +
        slides.length
      ) % slides.length;


    if (
      nextIndex ===
      this.pinCarouselIndex
    ) {
      return;
    }


    this.pinCarouselIndex =
      nextIndex;


    this.syncPinCarousel(true);
  }

  private nextPinCarouselSlide(): void {
    this.showPinCarouselSlide(
      this.pinCarouselIndex + 1
    );
  }

  private startPinCarouselAutoplay(): void {
    window.clearInterval(
      this.pinCarouselTimer
    );


    this.pinCarouselTimer = 0;


    if (!this.connected) return;


    this.pinCarouselTimer =
      window.setInterval(
        () => {
          /*
           * Jangan animasi jika tab/browser
           * sedang tidak terlihat.
           */
          if (
            document.visibilityState !==
            "visible"
          ) {
            return;
          }


          const slides =
            this.querySelectorAll(
              ".its-cctv-feed__pin-slide"
            );


          if (slides.length <= 1) {
            return;
          }


          this.nextPinCarouselSlide();
        },

        this.pinCarouselIntervalMs
      );
  }

  private restartPinCarouselAutoplay(): void {
    window.clearInterval(
      this.pinCarouselTimer
    );

    this.pinCarouselTimer = 0;

    this.startPinCarouselAutoplay();
  }

  private readonly handleScroll = (): void => {
    // The feed lives in its own scrolling sheet.  Always re-check the current
    // sentinel after the scroll; the compact-header render below can replace
    // the sentinel node that an IntersectionObserver was watching.
    this.scheduleCatalogContinuation();
    const compact = Math.max(window.scrollY, this.scrollHost?.scrollTop || 0) > 72;
    if (compact === this.headerCompact) return;
    this.headerCompact = compact;
    if (!compact) this.compactSearchOpen = false;
    this.render();
  };

  private setCompactSearchOpen(
    open: boolean
  ): void {
    this.compactSearchOpen = open;

    const head =
      this.querySelector<HTMLElement>(
        ".its-cctv-feed__head"
      );

    const search =
      this.querySelector<HTMLElement>(
        ".its-cctv-feed__search"
      );

    const toggle =
      this.querySelector<HTMLButtonElement>(
        "[data-cctv-search-toggle]"
      );

    const input =
      search?.querySelector<HTMLInputElement>(
        "[data-cctv-search]"
      );


    head?.classList.toggle(
      "is-searching",
      open
    );

    search?.classList.toggle(
      "is-collapsed",
      !open
    );

    toggle?.setAttribute(
      "aria-expanded",
      String(open)
    );


    if (open) {
      window.requestAnimationFrame(() => {
        input?.focus({
          preventScroll: true
        });
      });
    } else {
      input?.blur();
    }
  }

  private readonly handleClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const pinDot =
      target.closest<HTMLButtonElement>(
        "[data-cctv-pin-dot]"
      );


    if (pinDot) {
      const index =
        Number(
          pinDot.dataset.cctvPinDot
        );


      if (
        Number.isInteger(index)
      ) {
        this.showPinCarouselSlide(
          index
        );

        this.restartPinCarouselAutoplay();
      }


      return;
    }
    if (
      target.closest(
        "[data-cctv-search-toggle]"
      )
    ) {
      this.setCompactSearchOpen(
        !this.compactSearchOpen
      );

      return;
    }
    if (target.closest("[data-cctv-travel-alert-toggle]")) {
      window.dispatchEvent(new Event("its:toggle-cctv-travel-alerts"));
      window.setTimeout(() => this.render(), 0);
      return;
    }
    if (
      target.closest(
        "[data-cctv-search-clear]"
      )
    ) {

      /*
       * Kalau sudah ada text:
       * × pertama = hapus text.
       */
      if (this.searchQuery) {
        this.setSearchQuery("");
        return;
      }


      /*
       * Kalau kosong:
       * × = tutup search.
       */
      this.setCompactSearchOpen(false);

      return;
    }
    if (target.closest("[data-cctv-feed-retry]")) {
      void this.loadMoreRegions();
      return;
    }
    const regionMore = target.closest<HTMLButtonElement>("[data-region-more]");
    if (regionMore?.dataset.regionMore) {
      void this.loadNextPage(regionMore.dataset.regionMore);
      return;
    }
    const segment = target.closest<HTMLButtonElement>("[data-cctv-segment]");
    if (segment?.dataset.cctvSegment) {
      const elapsedSec = Number(segment.dataset.cctvElapsed);
      this.openCamera(segment.dataset.cctvSegment, Number.isFinite(elapsedSec) ? elapsedSec : undefined);
      return;
    }
    const open = target.closest<HTMLButtonElement>("[data-cctv-open]");
    if (open?.dataset.cctvOpen) this.openCamera(open.dataset.cctvOpen);
  };

  private readonly handleInput = (event: Event): void => {
    const input = (event.target as HTMLElement | null)?.closest<HTMLInputElement>("[data-cctv-search]");
    if (input) this.setSearchQuery(input.value, true);
  };

  private readonly handleAnalysisStatus = (event: Event): void => {
    const detail = (event as CustomEvent<{ cctvId?: string; state?: string; message?: string }>).detail || {};
    const id = cleanText(detail.cctvId);
    if (!id) return;
    const state = cleanText(detail.state) || "ready";
    this.analysisStatus.set(id, {
      state,
      message: cleanText(detail.message) || "AI diperbarui otomatis",
    });
    if (state === "complete") {
      this.requestedAnalysis.delete(id);
      this.nextAnalysisAt.set(id, Date.now() + ANALYSIS_FRESH_FOR_MS);
    } else if (state === "unavailable") {
      this.requestedAnalysis.delete(id);
      this.nextAnalysisAt.set(id, Date.now() + ANALYSIS_RETRY_AFTER_MS);
    } else if (state === "unsupported") {
      this.requestedAnalysis.delete(id);
      this.nextAnalysisAt.set(id, Number.POSITIVE_INFINITY);
    }
    this.updateCameraCards(id);
  };

  private readonly handleSnapshot = (event: Event): void => {
    const detail = (event as CustomEvent<{ cctvId?: string; snapshot?: unknown }>).detail || {};
    const id = cleanText(detail.cctvId);
    const snapshot = safeSnapshot(detail.snapshot);
    if (!id || !snapshot) return;
    const next = [snapshot, ...this.snapshotsFor(id).filter((item) => item.id !== snapshot.id)]
      .sort((left, right) => right.capturedAt - left.capturedAt)
      .slice(0, MAX_SEGMENTS_PER_CARD);
    this.snapshotCache.set(id, next);
    this.updateCameraCards(id);
  };

  private readonly handleOpenCamera = (event: Event): void => {
    const detail = (event as CustomEvent<{ id?: string; cctvId?: string }>).detail || {};
    const id = cleanText(detail.id) || cleanText(detail.cctvId);
    if (id) void this.pinActiveCamera(id);
  };

  private readonly handleUserLocation = (event: Event): void => {
    const detail = (event as CustomEvent<{ lat?: number; lng?: number; updatedAt?: number; speedKmh?: number }>).detail || {};
    const lat = Number(detail.lat);
    const lng = Number(detail.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const updatedAt = Number(detail.updatedAt) || Date.now();
    const previous = this.userLocation;
    const elapsedHours = previous ? Math.max(1, updatedAt - previous.updatedAt) / 3_600_000 : 0;
    const derivedSpeed = previous && elapsedHours
      ? distanceMeters(previous, { lat, lng }) / 1_000 / elapsedHours
      : 0;
    const speedKmh = Number.isFinite(Number(detail.speedKmh)) ? Number(detail.speedKmh) : derivedSpeed;
    this.userLocation = { lat, lng, updatedAt };
    this.travelActive = speedKmh >= 3;
    this.render();
  };

  connectedCallback(): void {
    if (this.connected) return;
    this.connected = true;
    this.addEventListener("click", this.handleClick);
    this.addEventListener("input", this.handleInput);
    window.addEventListener("its:cctv-analysis-status", this.handleAnalysisStatus);
    window.addEventListener("its:cctv-snapshot", this.handleSnapshot);
    window.addEventListener("its:open-cctv", this.handleOpenCamera);
    window.addEventListener("its:user-location", this.handleUserLocation);
    window.addEventListener("scroll", this.handleScroll, { passive: true });
    this.scrollHost = this.closest<HTMLElement>(".m-ai-history-content");
    this.scrollHost?.addEventListener("scroll", this.handleScroll, { passive: true });
    this.headerCompact = Math.max(window.scrollY, this.scrollHost?.scrollTop || 0) > 72;
    this.userLocation = readLastUserLocation();
    this.render();

    this.startPinCarouselAutoplay();

    this.signalTimer =
      window.setInterval(
        () => this.updateSignalClocks(),
        1_000
      );
    this.analysisRefreshTimer = window.setInterval(
      () => this.refreshVisibleCardAnalysis(),
      ANALYSIS_REFRESH_SCAN_MS,
    );
    void this.initialize();
  }

  disconnectedCallback(): void {
    this.connected = false;
    this.removeEventListener("click", this.handleClick);
    this.removeEventListener("input", this.handleInput);
    window.removeEventListener("its:cctv-analysis-status", this.handleAnalysisStatus);
    window.removeEventListener("its:cctv-snapshot", this.handleSnapshot);
    window.removeEventListener("its:open-cctv", this.handleOpenCamera);
    window.removeEventListener("its:user-location", this.handleUserLocation);
    window.removeEventListener("scroll", this.handleScroll);
    this.scrollHost?.removeEventListener("scroll", this.handleScroll);
    this.scrollHost = null;
    this.observer?.disconnect();
    this.regionObserver?.disconnect();
    this.cardObserver?.disconnect();
    this.observer = null;
    this.regionObserver = null;
    this.cardObserver = null;
    window.clearInterval(
      this.signalTimer
    );

    window.clearInterval(
      this.analysisRefreshTimer
    );

    window.clearTimeout(this.analysisPrewarmTimer);


    /* CAROUSEL */
    window.clearInterval(
      this.pinCarouselTimer
    );

    this.pinCarouselTimer = 0;


    window.clearTimeout(
      this.searchTimer
    );
    window.cancelAnimationFrame(this.catalogContinuationFrame);
    window.cancelAnimationFrame(this.observerSyncFrame);
  }

  private async pinActiveCamera(id: string): Promise<void> {
    const highlight = (card: HTMLElement): void => {
      this.querySelectorAll<HTMLElement>("[data-cctv-card].is-highlighted")
        .forEach((item) => item.classList.remove("is-highlighted"));
      card.classList.add("is-highlighted");
      card.dataset.cctvActive = "true";
    };
    const current = this.querySelector<HTMLElement>(`[data-cctv-card="${CSS.escape(id)}"]`);
    if (current) {
      highlight(current);
      return;
    }
    const token = ++this.activeFeatureToken;
    const feature = this.featureIndex.get(id) || await this.loader.getFeatureById(id);
    if (!feature || token !== this.activeFeatureToken || !this.connected) return;
    this.featureIndex.set(id, feature);
    this.activeFeature = feature;
    const host = this.querySelector<HTMLElement>("[data-cctv-active-camera]");
    const cardHost = host?.querySelector<HTMLElement>("[data-cctv-active-card]");
    if (!host || !cardHost) {
      this.render();
      return;
    }
    const regionName = cleanText(feature.properties.city)
      || cleanText(feature.properties.region)
      || cleanText(feature.properties.area)
      || "Kamera aktif";
    host.hidden = false;
    cardHost.innerHTML = this.renderCard(feature, regionName);
    const card = cardHost.querySelector<HTMLElement>(`[data-cctv-card="${CSS.escape(id)}"]`);
    if (card) highlight(card);
    this.scheduleObserverSync();
  }

  private async initialize(): Promise<void> {
    this.loadingSummary = true;
    this.errorMessage = "";
    this.render();
    try {
      const [summary, batch] = await Promise.all([
        this.loader.summary(),
        this.loader.loadRegionBatch(0, FEED_BATCH_SIZE),
      ]);
      this.summary = summary;
      this.replaceBatch(batch.regions);
      this.nextOffset = batch.nextOffset;
      this.exhausted = batch.exhausted;
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : "Gagal memuat feed CCTV.";
    } finally {
      this.loadingSummary = false;
      this.loadingRegions = false;
      this.render();
    }
  }

  private indexPage(page: CctvCatalogRegionPage): void {
    for (const feature of page.features) {
      const id = featureId(feature);
      if (id) this.featureIndex.set(id, feature);
    }
  }

  private replaceBatch(regions: CctvCatalogRegionPage[]): void {
    this.regions.clear();
    this.orderedRegionIds = [];
    for (const page of regions) {
      this.indexPage(page);
      this.regions.set(page.region.id, { region: page.region, pages: [page], loadingPage: false });
      this.orderedRegionIds.push(page.region.id);
    }
  }

  private async loadMoreRegions(): Promise<void> {
    if (this.loadingRegions || this.exhausted || this.searchQuery) return;
    this.loadingRegions = true;
    this.errorMessage = "";
    this.syncCatalogSentinel();
    try {
      const batch = await this.loader.loadRegionBatch(this.nextOffset, FEED_BATCH_SIZE);
      for (const page of batch.regions) {
        this.indexPage(page);
        const existing = this.regions.get(page.region.id);
        if (existing) existing.pages = [page];
        else {
          this.regions.set(page.region.id, { region: page.region, pages: [page], loadingPage: false });
          this.orderedRegionIds.push(page.region.id);
        }
      }
      this.nextOffset = batch.nextOffset;
      this.exhausted = batch.exhausted;
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : "Gagal memuat wilayah CCTV berikutnya.";
    } finally {
      this.loadingRegions = false;
      this.render();
      this.scheduleCatalogContinuation();
    }
  }

  private async loadNextPage(regionId: string): Promise<void> {
    const regionView = this.regions.get(regionId);
    if (!regionView || regionView.loadingPage) return;
    const nextPage = regionView.pages.length;
    if (nextPage >= regionView.region.pageCount) return;
    regionView.loadingPage = true;
    this.syncRegionControl(regionId);
    try {
      const page = await this.loader.loadRegionPage(regionView.region, nextPage);
      this.indexPage(page);
      regionView.pages = [...regionView.pages, page];
      regionView.loadingPage = false;
      this.appendRegionPage(regionId, page);
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : "Gagal memuat kamera berikutnya.";
      regionView.loadingPage = false;
      this.render();
    }
  }

  private appendRegionPage(regionId: string, page: CctvCatalogRegionPage): void {
    const view = this.regions.get(regionId);
    const section = this.querySelector<HTMLElement>(`[data-cctv-region="${CSS.escape(regionId)}"]`);
    const grid = section?.querySelector<HTMLElement>(".its-cctv-feed__grid");
    if (!view || !section || !grid) {
      this.render();
      return;
    }
    grid.insertAdjacentHTML(
      "beforeend",
      page.features.map((feature) => this.renderCard(feature, view.region.name)).join(""),
    );
    const visibleCount = view.pages.reduce((total, item) => total + item.features.length, 0);
    const progress = section.querySelector<HTMLElement>("header small");
    if (progress) progress.textContent = `${visibleCount}/${view.region.featureCount} tampil`;
    const complete = view.pages.length >= view.region.pageCount;
    const sentinel = section.querySelector<HTMLElement>("[data-region-more-sentinel]");
    const button = section.querySelector<HTMLButtonElement>("[data-region-more]");
    if (sentinel) sentinel.hidden = complete;
    if (button) {
      button.hidden = complete;
      button.disabled = false;
      button.setAttribute("aria-busy", "false");
      button.textContent = "Muat kamera berikutnya";
    }
    this.scheduleObserverSync();
    this.scheduleCatalogContinuation();
  }

  private setSearchQuery(value: string, preserveFocus = false): void {
    const query = value.replace(/\s+/g, " ").trimStart().slice(0, 120);
    if (query === this.searchQuery && preserveFocus) return;
    this.searchQuery = query;
    this.searchToken += 1;
    window.clearTimeout(this.searchTimer);
    if (!query.trim()) {
      this.searchLoading = false;
      this.searchResults = null;
      this.render(preserveFocus);
      return;
    }
    this.searchLoading = true;
    this.searchResults = [];
    this.render(preserveFocus);
    const token = this.searchToken;
    this.searchTimer = window.setTimeout(() => void this.hydrateSearch(query, token), SEARCH_DEBOUNCE_MS);
  }

  private async hydrateSearch(query: string, token: number): Promise<void> {
    const terms = normalized(query).split(/\s+/).filter(Boolean);
    const grouped = new Map<string, SearchRegion>();
    try {
      const directory = await this.loader.listRegions();
      const ordered = [...directory].sort((left, right) => {
        const leftMatch = terms.some((term) => normalized(left.name).includes(term)) ? 1 : 0;
        const rightMatch = terms.some((term) => normalized(right.name).includes(term)) ? 1 : 0;
        return rightMatch - leftMatch || right.verifiedLiveCount - left.verifiedLiveCount;
      });
      for (let offset = 0; offset < ordered.length && grouped.size <= SEARCH_RESULT_LIMIT; offset += 4) {
        if (token !== this.searchToken) return;
        const slice = ordered.slice(offset, offset + 4);
        const results = await Promise.all(slice.map(async (region) => {
          const pages: CctvCatalogRegionPage[] = [];
          for (let pageNumber = 0; pageNumber < region.pageCount; pageNumber += 1) {
            pages.push(await this.loader.loadRegionPage(region, pageNumber));
          }
          return { region, pages };
        }));
        for (const result of results) {
          const matches = result.pages.flatMap((page) => {
            this.indexPage(page);
            return page.features.filter((feature) => featureMatches(feature, result.region.name, terms));
          });
          if (matches.length) grouped.set(result.region.id, {
            region: result.region,
            features: matches.slice(0, SEARCH_RESULT_LIMIT),
          });
        }
        const count = [...grouped.values()].reduce((total, group) => total + group.features.length, 0);
        if (count >= SEARCH_RESULT_LIMIT) break;
      }
      if (token !== this.searchToken) return;
      this.searchResults = [...grouped.values()].map((group) => ({
        ...group,
        features: group.features.slice(0, SEARCH_RESULT_LIMIT),
      }));
    } catch (error) {
      if (token !== this.searchToken) return;
      this.errorMessage = error instanceof Error ? error.message : "Pencarian CCTV gagal.";
    } finally {
      if (token === this.searchToken) {
        this.searchLoading = false;
        this.render(true);
      }
    }
  }

  private snapshotsFor(id: string): FeedSnapshot[] {
    const cached = this.snapshotCache.get(id);
    if (cached) return cached;
    let snapshots: FeedSnapshot[] = [];
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(`its-cctv-snapshots:${id}`) || "[]");
      if (Array.isArray(parsed)) {
        snapshots = parsed.flatMap((item) => {
          const snapshot = safeSnapshot(item);
          return snapshot ? [snapshot] : [];
        }).sort((left, right) => right.capturedAt - left.capturedAt).slice(0, MAX_SEGMENTS_PER_CARD);
      }
    } catch {
      snapshots = [];
    }
    this.snapshotCache.set(id, snapshots);
    return snapshots;
  }

  private render(preserveSearchFocus = false): void {
    if (!this.connected) return;
    const hadSearchFocus = preserveSearchFocus && this.matches(":focus-within")
      && this.querySelector<HTMLInputElement>("[data-cctv-search]") === document.activeElement;
    const selectionStart = hadSearchFocus
      ? this.querySelector<HTMLInputElement>("[data-cctv-search]")?.selectionStart || this.searchQuery.length
      : 0;
    const summary = this.summary;
    const totalRegions = summary?.regionCount || this.orderedRegionIds.length;
    const totalLive = summary?.verifiedLiveCount || 0;
    const travelAlertsEnabled = readTravelAlertState();
    const normalRegions = this.orderedRegionIds.map((regionId) => this.renderRegion(regionId)).join("");
    const searchRegions = (this.searchResults || []).map((result) => this.renderSearchRegion(result)).join("");
    const searchSkeleton =
      this.searchQuery &&
        this.searchLoading
        ? this.renderSearchSkeleton(4)
        : "";


    const activeRegions =
      this.searchQuery
        ? (
          this.searchLoading
            ? searchSkeleton
            : searchRegions
        )
        : normalRegions;
    const searchCount = (this.searchResults || []).reduce((total, group) => total + group.features.length, 0);
    const activeId = this.activeFeature ? featureId(this.activeFeature) : "";
    const activeAlreadyVisible = activeId && [...this.regions.values()].some((view) =>
      view.pages.some((page) => page.features.some((feature) => featureId(feature) === activeId)));
    const activeRegionName = this.activeFeature
      ? cleanText(this.activeFeature.properties.city)
      || cleanText(this.activeFeature.properties.region)
      || cleanText(this.activeFeature.properties.area)
      || "Kamera aktif"
      : "Kamera aktif";
    const activeCameraHtml = this.activeFeature && !activeAlreadyVisible
      ? this.renderCard(this.activeFeature, activeRegionName)
      : "";
    const visibleFeatures = this.searchQuery
      ? (this.searchResults || []).flatMap((group) => group.features)
      : this.orderedRegionIds.flatMap((regionId) => this.regions.get(regionId)?.pages.flatMap((page) => page.features) || []);
    const distanceOrderedFeatures = this.userLocation
      ? [...visibleFeatures].sort((left, right) => {
        const leftCoordinates = featureCoordinates(left);
        const rightCoordinates = featureCoordinates(right);
        const leftDistance = leftCoordinates ? distanceMeters(this.userLocation!, leftCoordinates) : Number.POSITIVE_INFINITY;
        const rightDistance = rightCoordinates ? distanceMeters(this.userLocation!, rightCoordinates) : Number.POSITIVE_INFINITY;
        return leftDistance - rightDistance;
      })
      : visibleFeatures;
    const nearby = distanceOrderedFeatures[0];
    const nearbyCoordinates = nearby ? featureCoordinates(nearby) : null;
    const nearbyDistance = this.userLocation && nearbyCoordinates
      ? distanceMeters(this.userLocation, nearbyCoordinates)
      : null;
    const ahead = this.travelActive
      ? (this.activeFeature || distanceOrderedFeatures[1] || nearby)
      : null;
    const aheadSnapshots = ahead ? this.snapshotsFor(featureId(ahead)) : [];
    const aheadTraffic = congestionForCount(aheadSnapshots[0]?.objectCount || 0);
    const compactSearchVisible = this.compactSearchOpen;

    this.innerHTML = `
      <div class="its-cctv-feed">
        <header
          class="its-cctv-feed__head
            ${this.headerCompact ? "is-compact" : ""}
            ${compactSearchVisible ? "is-searching" : ""}"
        >
          <!-- TITLE -->
          <div class="its-cctv-feed__identity">
            <strong>
              CCTV &amp; Lalu Lintas Indonesia
            </strong>

            <span>
              ${summary
        ? `${summary.featureCount} lokasi publik · ${totalLive} live · ${totalRegions} wilayah`
        : "Memuat katalog CCTV publik"
      }
            </span>
          </div>


          <!-- SEARCH YANG AKAN MENGGANTIKAN TITLE -->
          <div
            class="its-cctv-feed__search
              ${compactSearchVisible ? "" : "is-collapsed"}"
            role="search"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle
                cx="11"
                cy="11"
                r="7"
              />
              <path d="m20 20-4-4"/>
            </svg>

            <input
              type="search"
              data-cctv-search
              value="${escapeHtml(this.searchQuery)}"
              autocomplete="off"
              inputmode="search"
              placeholder="Search"
              aria-label="Cari CCTV berdasarkan jalan, kota, atau wilayah"
            >

            <button
              type="button"
              data-cctv-search-clear
              aria-label="${this.searchQuery
        ? "Hapus pencarian"
        : "Tutup pencarian"
      }"
            >
              ×
            </button>
          </div>


          <!-- ACTIONS -->
          <div class="its-cctv-feed__head-actions">

            <button
              type="button"
              data-cctv-search-toggle
              aria-expanded="${String(compactSearchVisible)}"
              aria-label="${compactSearchVisible
        ? "Tutup pencarian"
        : "Buka pencarian CCTV"
      }"
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle
                  cx="11"
                  cy="11"
                  r="7"
                />
                <path d="m20 20-4-4"/>
              </svg>
            </button>


            <button
              type="button"
              data-cctv-travel-alert-toggle
              aria-pressed="${String(travelAlertsEnabled)}"
              aria-label="${travelAlertsEnabled
        ? "Nonaktifkan"
        : "Aktifkan"
      } peringatan perjalanan berbasis AI"
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M9 21h6"
                />
              </svg>

              <i aria-hidden="true"></i>
            </button>

          </div>
        </header>
        <aside
          class="its-cctv-feed__pins"
          aria-label="Ringkasan perjalanan yang disematkan"
          data-cctv-pin-carousel
        >
          <div class="its-cctv-feed__pin-viewport">
            <div class="its-cctv-feed__pin-track">

              <!-- SLIDE 1 -->
              <article class="its-cctv-feed__pin-slide">
                <span
                  class="its-cctv-feed__pin-icon"
                  aria-hidden="true"
                >⌖</span>

                <div>
                  <small>Di sekitar Anda</small>

                  <strong>
                    ${escapeHtml(
        nearby
          ? featureTitle(nearby)
          : "Mencari CCTV terdekat"
      )}
                  </strong>

                  <span>
                    ${escapeHtml(
        nearby
          ? `${featureSubtitle(nearby, "Indonesia")}${nearbyDistance !== null
            ? ` · ${nearbyDistance < 1_000 ? `${Math.round(nearbyDistance)} m` : `${(nearbyDistance / 1_000).toFixed(1)} km`}`
            : ""}`
          : "Aktifkan lokasi untuk hasil presisi"
      )}
                  </span>
                </div>
              </article>


              <!-- SLIDE 2 -->
              <article
                class="its-cctv-feed__pin-slide"
                data-level="${aheadTraffic.color}"
              >
                <span
                  class="its-cctv-feed__pin-icon"
                  aria-hidden="true"
                >↗</span>

                <div>
                  <small>Rute di depan · dinamis</small>

                  <strong>
                    ${escapeHtml(
        ahead
          ? featureTitle(ahead)
          : "Tidak ada perjalanan aktif"
      )}
                  </strong>

                  <span>
                    ${ahead ? "Di depan" : "Status"} ·
                    ${ahead ? escapeHtml(aheadTraffic.label) : "Diam"}
                    ·
                    ${ahead
        ? (featureIsVerifiedLive(ahead) ? "CCTV tersedia" : "CCTV belum tersedia")
        : "rute muncul saat perangkat bergerak"
      }
                  </span>
                </div>
              </article>

            </div>
          </div>


          <!-- DOT VERTIKAL DI SAMPING KANAN -->
          <div
            class="its-cctv-feed__pin-dots"
            role="group"
            aria-label="Informasi perjalanan"
          ></div>
        </aside>
        ${this.errorMessage ? `<p class="its-cctv-feed__region-hint" role="alert">${escapeHtml(this.errorMessage)}</p>` : ""}
        ${this.searchQuery ? `<div class="its-cctv-feed__search-status" role="status">${this.searchLoading
        ? `Mencari “${escapeHtml(this.searchQuery.trim())}” di katalog bertahap…`
        : `${searchCount} kamera cocok dengan “${escapeHtml(this.searchQuery.trim())}”`}</div>` : ""}
        <section class="its-cctv-feed__active-camera" data-cctv-active-camera ${activeCameraHtml ? "" : "hidden"}>
          <h3 class="its-cctv-feed__sr-only">Kamera aktif</h3>
          <div data-cctv-active-card>${activeCameraHtml}</div>
        </section>
        ${this.loadingSummary && !activeRegions ? `<div class="its-cctv-feed__loading" role="status"><i aria-hidden="true"></i><span>Menyiapkan kamera prioritas…</span></div>` : ""}
        ${activeRegions || (this.searchQuery && !this.searchLoading
        ? `<div class="its-cctv-feed__empty"><strong>Kamera tidak ditemukan</strong><span>Coba nama jalan, kota, kabupaten, atau operator lain.</span></div>`
        : "")}
        <div class="its-cctv-feed__sentinel" role="status" data-load-state="${this.errorMessage ? "failed" : this.loadingRegions ? "loading" : "idle"}" ${this.exhausted || this.searchQuery ? "hidden" : ""}>
          <i aria-hidden="true"></i>
          <span class="its-cctv-feed__sr-only">${this.loadingRegions ? "Memuat data CCTV berikutnya" : "Wilayah berikutnya siap dimuat"}</span>
          <button type="button" data-cctv-feed-retry ${this.observer || this.loadingRegions ? "hidden" : ""}>${this.errorMessage ? "Coba lagi" : "Muat wilayah berikutnya"}</button>
        </div>
      </div>
    `;
    if (hadSearchFocus) {
      const input = this.querySelector<HTMLInputElement>("[data-cctv-search]");
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(selectionStart, selectionStart);
    }
    this.scheduleObserverSync();
    this.updateSignalClocks();
    this.syncPinCarousel(false);
  }

  private renderRegion(regionId: string): string {
    const regionView = this.regions.get(regionId);
    if (!regionView) return "";
    const features = regionView.pages.flatMap((page) => page.features);
    const complete = regionView.pages.length >= regionView.region.pageCount;
    return this.renderRegionShell(regionView.region, features, {
      complete,
      loading: regionView.loadingPage,
      regionId,
    });
  }

  private renderSearchRegion(result: SearchRegion): string {
    return this.renderRegionShell(result.region, result.features, {
      complete: true,
      loading: false,
      regionId: "",
      searchResult: true,
    });
  }

  private renderRegionShell(
    region: CctvCatalogRegion,
    features: CctvCatalogFeature[],
    options: { complete: boolean; loading: boolean; regionId: string; searchResult?: boolean },
  ): string {
    const displayName = regionDisplayName(region.name, features);
    return `
        <section
          class="
            its-cctv-feed__region
            ${options.searchResult
        ? "is-search-result"
        : ""
      }
          "
          data-cctv-region="${escapeHtml(region.id)}"
        >
        <header>
          <div><strong>${escapeHtml(displayName)}</strong><span>${region.featureCount} kamera · ${region.verifiedLiveCount} live</span></div>
          <small>${options.searchResult ? `${features.length} cocok` : `${features.length}/${region.featureCount} tampil`}</small>
        </header>
        <div class="its-cctv-feed__grid">${features.map((feature) => this.renderCard(feature, region.name)).join("")}</div>
        ${options.searchResult ? "" : `
          <div class="its-cctv-feed__region-sentinel" data-region-more-sentinel="${escapeHtml(options.regionId)}" role="status" ${options.complete ? "hidden" : ""}>
            <span>${options.loading ? "Memuat kamera berikutnya…" : "Kamera lain tersedia di wilayah ini"}</span>
          </div>
          <button class="its-cctv-feed__region-more" type="button" data-region-more="${escapeHtml(options.regionId)}" aria-busy="${String(options.loading)}" ${options.complete ? "hidden" : ""}>${options.loading ? "Memuat…" : "Muat kamera berikutnya"}</button>
        `}
      </section>
    `;
  }

  private renderCard(feature: CctvCatalogFeature, regionName: string): string {
    const id = featureId(feature);
    if (!id) return "";
    const snapshots = this.snapshotsFor(id);
    const latestVehicles = snapshots[0]?.objectCount || 0;
    const status = analysisLabel(this.analysisStatus.get(id), snapshots);
    const phase = estimatedSignal(id, latestVehicles);
    const source = featureSource(feature);
    const sourceDetail = cleanText(feature.properties.attribution);
    const location = featureSubtitle(feature, regionName);
    const coordinates = featureCoordinates(feature);
    const streamStatus = cleanText(feature.properties.streamStatus) || "metadata-only";
    const accent = snapshots[0]?.accent || "#2563eb";
    return `
      <article class="its-cctv-feed__card" data-cctv-card="${escapeHtml(id)}" data-analysis-state="${escapeHtml(status.state)}" data-cctv-vehicles="${latestVehicles}" style="--cctv-accent:${escapeHtml(accent)}">
        <button class="its-cctv-feed__summary" type="button" data-cctv-open="${escapeHtml(id)}" aria-haspopup="dialog" aria-label="Buka CCTV ${escapeHtml(featureTitle(feature))} di peta">
          <span class="its-cctv-feed__signal" data-signal="${phase.signal}" role="img" aria-label="Estimasi fase lampu ${phase.signal}; bukan pembacaan controller fisik">
            <i></i><i></i><i></i>
          </span>
          <span class="its-cctv-feed__title">
            <strong title="${escapeHtml(location)}">${escapeHtml(featureTitle(feature))}</strong>
            <small><b data-cctv-congestion>${escapeHtml(status.headline)}</b> · <span data-cctv-count>${escapeHtml(status.detail)}</span></small>
          </span>
          <span class="its-cctv-feed__countdown"><b data-cctv-signal-countdown>${phase.remaining}</b><small>detik<br>estimasi</small></span>
        </button>
        <div class="its-cctv-feed__segments" data-cctv-segments>${this.renderSegments(id, snapshots, status.state)}</div>
        <footer>
          <span title="${escapeHtml(sourceDetail || source)}">Sumber: ${escapeHtml(source)}</span>
          <button type="button" data-cctv-open="${escapeHtml(id)}" aria-haspopup="dialog">Lihat kamera</button>
        </footer>
        <div class="its-cctv-feed__meta"><span>${escapeHtml(streamStatus)}</span>${coordinates ? `<span>${coordinates.lat.toFixed(4)}, ${coordinates.lng.toFixed(4)}</span>` : ""}</div>
      </article>
    `;
  }

  private renderSegments(id: string, snapshots: FeedSnapshot[], state: string): string {
    const entries = snapshots.slice(0, MAX_SEGMENTS_PER_CARD).map((snapshot, index) => `
      <button class="its-cctv-feed__segment" type="button" data-cctv-segment="${escapeHtml(id)}" data-cctv-elapsed="${Number.isFinite(snapshot.elapsedSec) ? snapshot.elapsedSec : ""}" aria-haspopup="dialog" aria-label="Buka segmen AI ${index + 1}, ${snapshot.objectCount} kendaraan">
        <img src="${escapeHtml(snapshot.imageUrl)}" alt="Segmen AI ${index + 1} CCTV, ${snapshot.objectCount} kendaraan" loading="lazy" decoding="async">
        <span><b>${snapshot.objectCount} kendaraan</b><small>${new Date(snapshot.capturedAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</small></span>
      </button>
    `);
    const pendingClass = /^(?:queued|loading|analyzing|retry|ready)$/.test(state) ? "is-skeleton" : "is-pending";
    while (entries.length < MAX_SEGMENTS_PER_CARD) {
      const index = entries.length;
      entries.push(`
        <span class="its-cctv-feed__segment ${pendingClass}" aria-hidden="true">
          <i></i><span><b>Segmen ${index + 1}</b><small>${pendingClass === "is-skeleton" ? "AI memindai" : "Belum tersedia"}</small></span>
        </span>
      `);
    }
    return entries.join("");
  }

  private updateCameraCards(id: string): void {
    const feature = this.featureIndex.get(id);
    if (!feature) return;
    const snapshots = this.snapshotsFor(id);
    const status = analysisLabel(this.analysisStatus.get(id), snapshots);
    this.querySelectorAll<HTMLElement>(`[data-cctv-card="${CSS.escape(id)}"]`).forEach((card) => {
      card.dataset.analysisState = status.state;
      card.dataset.cctvVehicles = String(snapshots[0]?.objectCount || 0);
      const congestion = card.querySelector<HTMLElement>("[data-cctv-congestion]");
      const count = card.querySelector<HTMLElement>("[data-cctv-count]");
      const segments = card.querySelector<HTMLElement>("[data-cctv-segments]");
      if (congestion) congestion.textContent = status.headline;
      if (count) count.textContent = status.detail;
      if (segments) segments.innerHTML = this.renderSegments(id, snapshots, status.state);
      if (snapshots[0]?.accent) card.style.setProperty("--cctv-accent", snapshots[0].accent);
    });
    this.updateSignalClocks();
  }

  private updateSignalClocks(): void {
    this.querySelectorAll<HTMLElement>("[data-cctv-card]").forEach((card) => {
      const id = card.dataset.cctvCard || "";
      const phase = estimatedSignal(id, Number(card.dataset.cctvVehicles) || 0);
      const signal = card.querySelector<HTMLElement>(".its-cctv-feed__signal");
      const countdown = card.querySelector<HTMLElement>("[data-cctv-signal-countdown]");
      if (signal) {
        signal.dataset.signal = phase.signal;
        signal.setAttribute("aria-label", `Estimasi fase lampu ${phase.signal}, ${phase.remaining} detik; bukan pembacaan controller fisik`);
      }
      if (countdown) countdown.textContent = String(phase.remaining);
    });
  }

  private openCamera(id: string, elapsedSec?: number): void {
    window.dispatchEvent(new CustomEvent("its:open-cctv", {
      detail: { id, elapsedSec, source: "cctv-feed" },
    }));
  }

  private requestCardAnalysis(card: HTMLElement, priority: number): void {
    const id = cleanText(card.dataset.cctvCard);
    if (!id || this.requestedAnalysis.has(id) || Date.now() < (this.nextAnalysisAt.get(id) || 0)) return;
    const snapshots = this.snapshotsFor(id);
    const newestSnapshotAt = snapshots[0]?.capturedAt || 0;
    if (snapshots.length >= MAX_SEGMENTS_PER_CARD && Date.now() - newestSnapshotAt < ANALYSIS_FRESH_FOR_MS) {
      this.nextAnalysisAt.set(id, newestSnapshotAt + ANALYSIS_FRESH_FOR_MS);
      return;
    }
    const feature = this.featureIndex.get(id);
    if (!feature) return;
    const streamUrl = featureStreamUrl(feature);
    if (!featureIsVerifiedLive(feature) || !streamUrl) {
      this.analysisStatus.set(id, {
        state: "unsupported",
        message: streamUrl ? "stream belum lolos verifikasi live" : "URL video live tidak tersedia",
      });
      this.updateCameraCards(id);
      return;
    }
    this.requestedAnalysis.add(id);
    this.nextAnalysisAt.set(id, Number.POSITIVE_INFINITY);
    window.dispatchEvent(new CustomEvent("its:request-cctv-analysis", {
      detail: {
        cctvId: id,
        streamUrl,
        mediaFormat: cleanText(feature.properties.mediaFormat),
        name: featureTitle(feature),
        priority: Math.round(priority),
        source: "visible-cctv-feed",
      },
    }));
  }

  private refreshVisibleCardAnalysis(): void {
    if (!this.connected || document.visibilityState === "hidden") return;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    this.querySelectorAll<HTMLElement>("[data-cctv-card]").forEach((card) => {
      const rect = card.getBoundingClientRect();
      if (rect.bottom < -120 || rect.top > viewportHeight + 180) return;
      this.requestCardAnalysis(card, 760);
    });
  }

  private scheduleObserverSync(): void {
    this.scheduleLoadedCardPrewarm();
    window.cancelAnimationFrame(this.observerSyncFrame);
    this.observerSyncFrame = window.requestAnimationFrame(() => this.syncObservers());
  }

  private scheduleLoadedCardPrewarm(delayMs = 1_200): void {
    window.clearTimeout(this.analysisPrewarmTimer);
    this.analysisPrewarmTimer = window.setTimeout(() => {
      if (!this.connected || document.visibilityState === "hidden") return;
      const now = Date.now();
      const pendingCards = [...this.querySelectorAll<HTMLElement>("[data-cctv-card]")]
        .filter((card) => {
          const id = cleanText(card.dataset.cctvCard);
          return Boolean(id)
            && !this.requestedAnalysis.has(id)
            && now >= (this.nextAnalysisAt.get(id) || 0);
        });
      pendingCards.slice(0, 8).forEach((card, index) => {
        this.requestCardAnalysis(card, 520 - index * 8);
      });
      // Continue across every card already loaded into the feed. The central
      // analyzer enforces queue, visibility, Save-Data, and 2G guardrails, so
      // this remains staged instead of starting every stream at once.
      if (pendingCards.length > 8) this.scheduleLoadedCardPrewarm(3_500);
    }, delayMs);
  }

  private syncObservers(): void {
    this.observer?.disconnect();
    this.regionObserver?.disconnect();
    this.cardObserver?.disconnect();
    this.observer = null;
    this.regionObserver = null;
    this.cardObserver = null;
    if (!("IntersectionObserver" in window)) {
      this.syncCatalogSentinel();
      this.querySelectorAll<HTMLElement>("[data-cctv-card]").forEach((card, index) => {
        if (index < 2) this.requestCardAnalysis(card, 800 - index * 20);
      });
      this.scheduleCatalogContinuation();
      return;
    }
    const catalogSentinel = this.querySelector<HTMLElement>(".its-cctv-feed__sentinel");
    if (catalogSentinel && !this.exhausted && !this.searchQuery) {
      this.observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void this.loadMoreRegions();
      }, { root: this.scrollHost, rootMargin: "280px 0px" });
      this.observer.observe(catalogSentinel);
    }
    this.regionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const regionId = (entry.target as HTMLElement).dataset.regionMoreSentinel;
        if (regionId) void this.loadNextPage(regionId);
      }
    }, { root: this.scrollHost, rootMargin: "220px 0px" });
    this.querySelectorAll<HTMLElement>("[data-region-more-sentinel]:not([hidden])")
      .forEach((sentinel) => this.regionObserver?.observe(sentinel));
    this.cardObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this.requestCardAnalysis(entry.target as HTMLElement, 700 + entry.intersectionRatio * 250);
      }
    }, { threshold: [0.05, 0.35, 0.75], rootMargin: "180px 0px" });
    this.querySelectorAll<HTMLElement>("[data-cctv-card]")
      .forEach((card) => this.cardObserver?.observe(card));
    this.syncCatalogSentinel();
    this.scheduleCatalogContinuation();
  }

  syncCatalogSentinel(): void {
    const sentinel = this.querySelector<HTMLElement>(".its-cctv-feed__sentinel");
    const button = sentinel?.querySelector<HTMLButtonElement>("[data-cctv-feed-retry]");
    if (!sentinel || !button) return;
    sentinel.hidden = this.exhausted || Boolean(this.searchQuery);
    sentinel.dataset.loadState = this.errorMessage ? "failed" : this.loadingRegions ? "loading" : "idle";
    button.hidden = Boolean(this.observer) || this.loadingRegions || this.exhausted || Boolean(this.searchQuery);
    button.disabled = this.loadingRegions;
    button.textContent = this.errorMessage ? "Coba lagi" : "Muat wilayah berikutnya";
    const status = sentinel.querySelector<HTMLElement>(".its-cctv-feed__sr-only");
    if (status) status.textContent = this.loadingRegions ? "Memuat data CCTV berikutnya" : "Wilayah berikutnya siap dimuat";
  }

  private syncRegionControl(regionId: string): void {
    const view = this.regions.get(regionId);
    const section = this.querySelector<HTMLElement>(`[data-cctv-region="${CSS.escape(regionId)}"]`);
    const button = section?.querySelector<HTMLButtonElement>("[data-region-more]");
    if (!view || !button) return;
    button.setAttribute("aria-busy", String(view.loadingPage));
    button.disabled = view.loadingPage;
    button.textContent = view.loadingPage ? "Memuat…" : "Muat kamera berikutnya";
  }

  private scheduleCatalogContinuation(): void {
    window.cancelAnimationFrame(this.catalogContinuationFrame);
    this.catalogContinuationFrame = window.requestAnimationFrame(() => {
      this.catalogContinuationFrame = 0;
      if (!this.connected || this.searchQuery) return;
      const scrollRect = this.scrollHost?.getBoundingClientRect();
      const viewportTop = scrollRect ? scrollRect.top - 120 : -120;
      const viewportBottom = scrollRect
        ? scrollRect.bottom + 240
        : (window.innerHeight || document.documentElement.clientHeight) + 240;
      const regionSentinels = this.querySelectorAll<HTMLElement>(
        "[data-region-more-sentinel]:not([hidden])",
      );
      for (const regionSentinel of regionSentinels) {
        const rect = regionSentinel.getBoundingClientRect();
        if (rect.top >= viewportBottom || rect.bottom <= viewportTop) continue;
        const regionId = regionSentinel.dataset.regionMoreSentinel;
        if (regionId) void this.loadNextPage(regionId);
        return;
      }
      const sentinel = this.querySelector<HTMLElement>(".its-cctv-feed__sentinel:not([hidden])");
      if (!sentinel || this.loadingRegions || this.exhausted) return;
      const rect = sentinel.getBoundingClientRect();
      if (rect.top < viewportBottom && rect.bottom > viewportTop) void this.loadMoreRegions();
    });
  }
}

if (!customElements.get("its-cctv-traffic-feed")) {
  customElements.define("its-cctv-traffic-feed", ItsCctvTrafficFeed);
}
