type MapLegendEntry = {
  name: string;
  pattern: string;
  meaning: string;
  swatch: string;
};

type MapLegendGroup = {
  title: string;
  entries: readonly MapLegendEntry[];
};

const MAP_LEGEND_GROUPS: readonly MapLegendGroup[] = [
  {
    title: "Hierarki jalan dan ruang pejalan kaki",
    entries: [
      {
        name: "Jalan tol / arteri",
        pattern: "Pita jingga berlapis",
        meaning: "Lebar visual mengikuti kelas jalan dan tingkat zoom; garis tengah menunjukkan pembagian lajur.",
        swatch: "road-major",
      },
      {
        name: "Jalan kolektor / lokal",
        pattern: "Pita kuning muda",
        meaning: "Nama jalan mengikuti geometri. Warna yang lebih ringan membedakannya dari koridor utama.",
        swatch: "road-local",
      },
      {
        name: "Trotoar / jalur pejalan kaki",
        pattern: "Garis biru-abu terputus",
        meaning: "Ditampilkan hanya jika jalur pejalan kaki dipetakan; sidewalk=separate tidak digandakan ke badan jalan.",
        swatch: "sidewalk",
      },
      {
        name: "Jalur sepeda",
        pattern: "Garis hijau-toska terputus",
        meaning: "Cycleway terpisah atau sisi jalan; arah dan keterhubungan mengikuti data geometri sumber.",
        swatch: "cycleway",
      },
    ],
  },
  {
    title: "Angkutan umum dan rel",
    entries: [
      {
        name: "Busway / BRT",
        pattern: "Garis merah dengan casing putih",
        meaning: "Koridor khusus bus. Label memakai moda + nomor/nama rute, misalnya Busway 1 atau TransJakarta.",
        swatch: "busway",
      },
      {
        name: "MRT",
        pattern: "Garis biru",
        meaning: "Jalur metro/subway; nama resmi, referensi rute, dan operator diprioritaskan dari metadata peta.",
        swatch: "mrt",
      },
      {
        name: "LRT / tram",
        pattern: "Garis hijau atau ungu",
        meaning: "LRT memakai hijau, tram memakai ungu, kecuali data jaringan menyediakan warna resminya.",
        swatch: "lrt-tram",
      },
      {
        name: "Kereta antarkota / komuter",
        pattern: "Rel abu dengan bantalan",
        meaning: "Label bukan sekadar ‘jalur kereta’: jenis moda, ref, atau nama lintas ditampilkan bila tersedia.",
        swatch: "rail",
      },
      {
        name: "Halte / stasiun",
        pattern: "Penanda transit biru",
        meaning: "Nama halte, stasiun, pintu masuk MRT, atau tram stop dibaca dari nama resmi objek.",
        swatch: "station",
      },
    ],
  },
  {
    title: "Hidrologi, keselamatan, dan ornamen",
    entries: [
      {
        name: "Sungai / kanal / drainase",
        pattern: "Garis biru mengikuti aliran",
        meaning: "Nama ditempatkan searah bentuk aliran; ketebalan membedakan sungai dari kanal atau drainase.",
        swatch: "water",
      },
      {
        name: "Penyeberangan sebidang",
        pattern: "Marka zebra",
        meaning: "Crossing pejalan kaki mengikuti orientasi jalan dan dikurangi otomatis saat simbol saling bertabrakan.",
        swatch: "crossing",
      },
      {
        name: "JPO / footbridge",
        pattern: "Dek dan dua akses tangga",
        meaning: "Jembatan penyeberangan orang atau footway bridge; nama fasilitas ditampilkan bila dipetakan.",
        swatch: "footbridge",
      },
      {
        name: "Lampu lalu lintas",
        pattern: "Merah - kuning - hijau",
        meaning: "Titik traffic_signals pada simpang. Status realtime perangkat ITS ditampilkan terpisah dari data peta.",
        swatch: "signal",
      },
      {
        name: "POI tematik",
        pattern: "Pin berwarna per kategori",
        meaning: "Sekolah, rumah sakit, halte, tempat ibadah, layanan publik, dan POI lain memakai ikon kategorinya.",
        swatch: "poi",
      },
    ],
  },
];

let legendModal: HTMLElement | null = null;
let returnFocus: HTMLButtonElement | null = null;
let closeTimer = 0;
let legendOwnedSidePanel = false;
let sidePanelWasOpen = false;
let previousSidePanelWidth = "";
let resetLegendGesture: ((animate?: boolean, restoreFlex?: boolean) => void) | null = null;

function usesDesktopLegendPanel(): boolean {
  return window.matchMedia("(min-width: 721px)").matches;
}

function setLegendMapFlex(sheet: HTMLElement | null, open: boolean, notify = true, visibleWidth?: number): number {
  if (!usesDesktopLegendPanel()) {
    if (legendOwnedSidePanel) {
      if (previousSidePanelWidth) document.documentElement.style.setProperty("--side-panel-active-width", previousSidePanelWidth);
      else document.documentElement.style.removeProperty("--side-panel-active-width");
      document.body.classList.toggle("side-panel-open", sidePanelWasOpen);
      legendOwnedSidePanel = false;
      document.documentElement.style.removeProperty("--map-legend-panel-full-width");
      if (notify) window.dispatchEvent(new Event("resize"));
    }
    return 0;
  }
  let appliedWidth = 0;
  if (open && sheet) {
    if (!legendOwnedSidePanel) {
      previousSidePanelWidth = document.documentElement.style.getPropertyValue("--side-panel-active-width");
      sidePanelWasOpen = document.body.classList.contains("side-panel-open");
      legendOwnedSidePanel = true;
    }
    const modal = sheet.closest<HTMLElement>(".map-legend-modal");
    const fullWidth = Math.max(0, Math.round(modal?.getBoundingClientRect().width || sheet.getBoundingClientRect().width));
    appliedWidth = visibleWidth === undefined
      ? fullWidth
      : Math.max(0, Math.min(fullWidth, Math.round(visibleWidth)));
    document.documentElement.style.setProperty("--map-legend-panel-full-width", `${fullWidth}px`);
    document.documentElement.style.setProperty("--side-panel-active-width", `${appliedWidth}px`);
    document.body.classList.add("side-panel-open");
  } else if (legendOwnedSidePanel) {
    if (previousSidePanelWidth) document.documentElement.style.setProperty("--side-panel-active-width", previousSidePanelWidth);
    else document.documentElement.style.removeProperty("--side-panel-active-width");
    document.body.classList.toggle("side-panel-open", sidePanelWasOpen);
    legendOwnedSidePanel = false;
    document.documentElement.style.removeProperty("--map-legend-panel-full-width");
  }
  if (notify) window.dispatchEvent(new Event("resize"));
  return appliedWidth;
}

function poiToggleHtml(context: "legend" | "layer"): string {
  const className = context === "legend" ? "map-legend-poi-toggle" : "m-layer-poi-toggle";
  return `
    <button type="button" class="${className}" data-map-poi-toggle aria-pressed="true">
      <span class="map-poi-toggle-icon" aria-hidden="true">
        <svg data-poi-eye-on viewBox="0 0 24 24"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.8"/></svg>
        <svg data-poi-eye-off viewBox="0 0 24 24"><path d="M3 3l18 18M10.7 6.1A10.2 10.2 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-2.2 3M6.2 6.2C3.9 8 2.5 12 2.5 12s3.5 6 9.5 6a10 10 0 0 0 3.2-.5M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>
      </span>
      <span class="map-poi-toggle-copy">
        <strong>Point of interest (POI)</strong>
        <small data-map-poi-status>Ditampilkan pada peta</small>
      </span>
      <span class="map-poi-toggle-switch" aria-hidden="true"><i></i></span>
    </button>
  `;
}

function syncPoiToggleControls(): void {
  const source = document.querySelector<HTMLButtonElement>(".poi-visibility-button");
  const visible = source?.getAttribute("aria-pressed") !== "false";
  document.querySelectorAll<HTMLButtonElement>("[data-map-poi-toggle]").forEach((button) => {
    button.disabled = !source;
    button.classList.toggle("is-active", visible);
    button.setAttribute("aria-pressed", String(visible));
    button.setAttribute("aria-label", visible ? "Sembunyikan point of interest pada peta" : "Tampilkan point of interest pada peta");
    const status = button.querySelector<HTMLElement>("[data-map-poi-status]");
    if (status) status.textContent = source
      ? visible ? "Ditampilkan pada peta" : "Disembunyikan dari peta"
      : "Kontrol peta sedang disiapkan";
  });
}

function togglePoiVisibility(): void {
  document.querySelector<HTMLButtonElement>(".poi-visibility-button")?.click();
  queueMicrotask(syncPoiToggleControls);
}

function enhanceLayerModal(): void {
  const sheet = document.querySelector<HTMLElement>("#m-layer-modal .m-layer-sheet");
  if (!sheet || sheet.querySelector("[data-map-poi-setting]")) return;
  const section = document.createElement("section");
  section.className = "m-layer-visibility";
  section.dataset.mapPoiSetting = "";
  section.innerHTML = `
    <div class="m-layer-visibility-head">
      <strong>Objek peta</strong>
      <span>Atur kepadatan informasi tanpa menambah tombol di atas peta.</span>
    </div>
    ${poiToggleHtml("layer")}
  `;
  section.querySelector<HTMLButtonElement>("[data-map-poi-toggle]")?.addEventListener("click", togglePoiVisibility);
  sheet.appendChild(section);
  syncPoiToggleControls();
}

function bindLegendSwipe(modal: HTMLElement): void {
  const sheet = modal.querySelector<HTMLElement>(".map-legend-sheet");
  if (!sheet) return;
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let startedAt = 0;
  let horizontal = true;
  let distance = 0;
  let extent = 1;
  let fullPanelWidth = 0;
  let axisState: "pending" | "primary" | "cross" = "pending";
  let lastMoveAt = 0;
  let lastDistance = 0;
  let recentVelocity = 0;
  let settleTimer = 0;

  const releasePointer = () => {
    const activePointer = pointerId;
    pointerId = null;
    if (activePointer === null) return;
    try {
      if (sheet.hasPointerCapture(activePointer)) sheet.releasePointerCapture(activePointer);
    } catch { /* Pointer may already have been released by the browser. */ }
  };

  const reset = (animate = true, restoreFlex = true) => {
    const hasDisplacement = distance > 0 || Boolean(sheet.style.transform);
    window.clearTimeout(settleTimer);
    releasePointer();
    axisState = "pending";
    distance = 0;
    lastDistance = 0;
    recentVelocity = 0;
    modal.classList.remove("is-swiping");
    modal.style.removeProperty("--map-legend-swipe-progress");

    if (!restoreFlex) {
      document.body.classList.remove("map-legend-dragging");
      return;
    }

    const shouldAnimate = animate && hasDisplacement && modal.classList.contains("open");
    sheet.style.transition = shouldAnimate
      ? "transform 240ms cubic-bezier(.32,.72,0,1)"
      : "none";
    document.body.classList.remove("map-legend-dragging");
    sheet.style.removeProperty("transform");
    if (modal.classList.contains("open")) {
      setLegendMapFlex(sheet, true, false);
    }

    if (shouldAnimate) {
      settleTimer = window.setTimeout(() => sheet.style.removeProperty("transition"), 250);
    } else {
      requestAnimationFrame(() => sheet.style.removeProperty("transition"));
    }
  };

  resetLegendGesture = reset;

  sheet.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement;
    if (
      pointerId !== null
      || !modal.classList.contains("open")
      || event.button !== 0
      || target.closest("button, a, input, select, textarea")
      || !target.closest(".map-legend-head, .map-legend-grip")
    ) return;
    window.clearTimeout(settleTimer);
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startedAt = performance.now();
    lastMoveAt = startedAt;
    lastDistance = 0;
    recentVelocity = 0;
    distance = 0;
    axisState = "pending";
    horizontal = usesDesktopLegendPanel();
    extent = Math.max(1, horizontal ? sheet.getBoundingClientRect().width : sheet.getBoundingClientRect().height);
    fullPanelWidth = horizontal ? setLegendMapFlex(sheet, true, false) : 0;
    sheet.style.transition = "none";
    modal.classList.add("is-swiping");
    document.body.classList.add("map-legend-dragging");
    try { sheet.setPointerCapture(event.pointerId); } catch { /* Capture can be unavailable in older WebViews. */ }
  });

  sheet.addEventListener("pointermove", (event) => {
    if (pointerId !== event.pointerId) return;
    const primary = horizontal ? event.clientX - startX : event.clientY - startY;
    const cross = horizontal ? event.clientY - startY : event.clientX - startX;
    if (axisState === "pending") {
      if (Math.hypot(primary, cross) < 6) return;
      if (Math.abs(cross) > Math.abs(primary) * 1.15) {
        axisState = "cross";
        reset(false, true);
        return;
      }
      axisState = "primary";
    }
    if (axisState !== "primary") return;
    distance = Math.max(0, primary);
    if (event.cancelable) event.preventDefault();
    const progress = Math.min(1, distance / Math.max(1, extent));
    modal.style.setProperty("--map-legend-swipe-progress", progress.toFixed(3));
    sheet.style.transform = horizontal ? `translateX(${distance}px)` : `translateY(${distance}px)`;
    if (horizontal) setLegendMapFlex(sheet, true, false, fullPanelWidth - distance);

    const now = performance.now();
    const sampleElapsed = Math.max(1, now - lastMoveAt);
    const instantaneousVelocity = Math.max(0, distance - lastDistance) / sampleElapsed;
    recentVelocity = recentVelocity === 0
      ? instantaneousVelocity
      : recentVelocity * 0.58 + instantaneousVelocity * 0.42;
    lastMoveAt = now;
    lastDistance = distance;
  });

  const finish = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    const releaseGap = performance.now() - lastMoveAt;
    const elapsed = Math.max(1, performance.now() - startedAt);
    const velocity = releaseGap <= 80 ? Math.max(recentVelocity, distance / elapsed) : 0;
    const dismiss = distance >= Math.min(152, extent * 0.28) || (distance >= 44 && velocity >= 0.72);
    if (dismiss) {
      const direction = horizontal ? "right" : "down";
      reset(false, false);
      closeMapLegend(direction);
      return;
    }
    reset(true);
  };
  sheet.addEventListener("pointerup", finish);
  sheet.addEventListener("pointercancel", (event) => {
    if (pointerId === event.pointerId) reset(true);
  });
  sheet.addEventListener("lostpointercapture", (event) => {
    if (pointerId === event.pointerId) reset(true);
  });
  window.addEventListener("blur", () => {
    if (pointerId !== null) reset(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && pointerId !== null) reset(true);
  });
}

function legendTableHtml(): string {
  return MAP_LEGEND_GROUPS.map((group) => `
    <tbody>
      <tr class="map-legend-group-row">
        <th colspan="3" scope="rowgroup">${group.title}</th>
      </tr>
      ${group.entries.map((entry) => `
        <tr>
          <td data-label="Simbol">
            <span class="map-legend-swatch map-legend-swatch-${entry.swatch}" aria-hidden="true"><i></i></span>
          </td>
          <th data-label="Objek" scope="row">
            <strong>${entry.name}</strong>
            <span>${entry.pattern}</span>
          </th>
          <td data-label="Interpretasi">${entry.meaning}</td>
        </tr>
      `).join("")}
    </tbody>
  `).join("");
}

function ensureLegendModal(): HTMLElement {
  if (legendModal) return legendModal;

  const modal = document.createElement("div");
  modal.id = "map-symbol-legend-modal";
  modal.className = "map-license-modal map-legend-modal";
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  modal.innerHTML = `
    <section class="map-license-sheet map-legend-sheet" role="dialog" aria-modal="true" aria-labelledby="map-legend-title" aria-describedby="map-legend-description" tabindex="-1">
      <div class="map-license-grip map-legend-grip" aria-hidden="true"></div>
      <header class="map-license-head map-legend-head">
        <div>
          <span>Atlas simbol · ITS Maps</span>
          <h2 id="map-legend-title">Legenda kartografi</h2>
          <p id="map-legend-description">Referensi visual untuk membaca jaringan, label, warna, dan ornamen peta secara konsisten.</p>
        </div>
        <button type="button" data-map-legend-close aria-label="Tutup legenda peta">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
        </button>
      </header>

      <div class="map-legend-metrics" aria-label="Ringkasan cakupan legenda">
        <span><b>3</b> kelompok</span>
        <span><b>14</b> pola</span>
        <span><b>OSM</b> sumber geometri</span>
        <span><b>Adaptif</b> terhadap zoom</span>
      </div>

      <div class="map-legend-scroll">
        <section class="map-legend-layer-panel" aria-labelledby="map-legend-layer-title">
          <div class="map-legend-layer-head">
            <div>
              <strong id="map-legend-layer-title">Lapisan tampilan</strong>
              <span>Visibilitas objek kini terpusat di panel peta.</span>
            </div>
            <span class="map-legend-layer-badge">Realtime</span>
          </div>
          ${poiToggleHtml("legend")}
        </section>

        <aside class="map-legend-method" aria-label="Metode penamaan peta">
          <div class="map-legend-method-icon" aria-hidden="true">Aa</div>
          <div>
            <strong>Kaidah label</strong>
            <p>Nama lokal/resmi diprioritaskan, lalu nama umum dan referensi rute. Nama kategori dipakai hanya saat objek belum mempunyai nama di sumber.</p>
          </div>
          <ol aria-label="Urutan prioritas nama">
            <li><span>1</span><code>name:id</code></li>
            <li><span>2</span><code>name</code></li>
            <li><span>3</span><code>ref</code></li>
            <li><span>4</span><code>jenis objek</code></li>
          </ol>
        </aside>

        <div class="map-legend-table-wrap">
          <table class="map-legend-table">
            <caption>Simbol dan interpretasi layer peta ITS Maps</caption>
            <thead>
              <tr>
                <th scope="col">Simbol</th>
                <th scope="col">Objek / pola</th>
                <th scope="col">Interpretasi data</th>
              </tr>
            </thead>
            ${legendTableHtml()}
          </table>
        </div>

        <p class="map-legend-footnote"><strong>Catatan data.</strong> Kepadatan dan kelengkapan nama bergantung pada data terbuka yang tersedia di lokasi tersebut. Simbol mengalami collision control agar tetap terbaca.</p>
      </div>
    </section>
  `;

  modal.addEventListener("click", (event) => {
    if (event.target === modal || (event.target as Element).closest("[data-map-legend-close]")) closeMapLegend();
  });
  modal.querySelector<HTMLButtonElement>("[data-map-poi-toggle]")?.addEventListener("click", togglePoiVisibility);
  bindLegendSwipe(modal);
  document.body.appendChild(modal);
  legendModal = modal;
  syncPoiToggleControls();
  return modal;
}

function focusableElements(modal: HTMLElement): HTMLElement[] {
  return [...modal.querySelectorAll<HTMLElement>("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")]
    .filter((element) => !element.hidden && element.getClientRects().length > 0);
}

function closeMapLegend(direction: "right" | "down" = usesDesktopLegendPanel() ? "right" : "down"): void {
  if (!legendModal || !legendModal.classList.contains("open")) return;
  const sheet = legendModal.querySelector<HTMLElement>(".map-legend-sheet");
  resetLegendGesture?.(false, false);
  legendModal.classList.remove("is-swiping");
  legendModal.style.removeProperty("--map-legend-swipe-progress");
  document.body.classList.remove("map-legend-dragging");
  document.body.classList.add("map-legend-closing");
  if (sheet) {
    sheet.style.transition = "transform 220ms cubic-bezier(.4,0,1,1)";
    sheet.style.transform = direction === "right"
      ? "translateX(calc(100% + 32px))"
      : "translateY(calc(100% + 24px))";
  }
  legendModal.classList.remove("open");
  legendModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("map-legend-open");
  setLegendMapFlex(sheet, false, false);
  document.querySelectorAll<HTMLButtonElement>("[data-map-symbol-legend]").forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
  window.clearTimeout(closeTimer);
  closeTimer = window.setTimeout(() => {
    if (legendModal && !legendModal.classList.contains("open")) {
      legendModal.hidden = true;
      const closedSheet = legendModal.querySelector<HTMLElement>(".map-legend-sheet");
      closedSheet?.style.removeProperty("transition");
      closedSheet?.style.removeProperty("transform");
      document.body.classList.remove("map-legend-closing", "map-legend-dragging");
      window.dispatchEvent(new Event("resize"));
    }
  }, 230);
  returnFocus?.focus({ preventScroll: true });
  returnFocus = null;
}

function openMapLegend(trigger: HTMLButtonElement): void {
  const modal = ensureLegendModal();
  const sheet = modal.querySelector<HTMLElement>(".map-legend-sheet");
  window.clearTimeout(closeTimer);
  resetLegendGesture?.(false, true);
  modal.classList.remove("open", "is-swiping");
  modal.style.removeProperty("--map-legend-swipe-progress");
  document.body.classList.remove("map-legend-closing", "map-legend-dragging");
  returnFocus = trigger;
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("map-legend-open");
  setLegendMapFlex(sheet, true);
  document.querySelectorAll<HTMLButtonElement>("[data-map-symbol-legend]").forEach((button) => {
    button.setAttribute("aria-expanded", "true");
  });
  sheet?.style.removeProperty("transition");
  sheet?.style.removeProperty("transform");
  syncPoiToggleControls();
  requestAnimationFrame(() => {
    modal.classList.add("open");
    modal.querySelector<HTMLButtonElement>("[data-map-legend-close]")?.focus({ preventScroll: true });
  });
}

window.addEventListener("resize", () => {
  if (!legendModal?.classList.contains("open")) return;
  resetLegendGesture?.(false, true);
  setLegendMapFlex(legendModal.querySelector<HTMLElement>(".map-legend-sheet"), true, false);
});

document.addEventListener("click", (event) => {
  const trigger = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-map-symbol-legend]");
  if (!trigger) return;
  event.preventDefault();
  event.stopPropagation();
  openMapLegend(trigger);
}, true);

document.addEventListener("keydown", (event) => {
  if (!legendModal?.classList.contains("open")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeMapLegend();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = focusableElements(legendModal);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
});

window.addEventListener("its:poi-visibility", syncPoiToggleControls);

const layerModalObserver = new MutationObserver(() => enhanceLayerModal());
layerModalObserver.observe(document.body, { childList: true, subtree: true });
enhanceLayerModal();
