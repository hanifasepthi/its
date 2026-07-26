const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const baseUrl = process.env.ITS_QA_URL || "http://127.0.0.1:4173";
const liveMode = process.env.ITS_NAV3D_LIVE === "1";
const forceRouteFallback = process.env.ITS_NAV3D_FORCE_ROUTE_FALLBACK === "1";
const outputRoot = path.resolve(__dirname, "..", "test-output", "navigation3d");
const outputDir = liveMode ? path.join(outputRoot, "monas-thamrin-live") : outputRoot;
const userDataDir = path.join(outputDir, "electron-user-data");
fsSync.mkdirSync(userDataDir, { recursive: true });
app.setPath("userData", userDataDir);
app.setPath("sessionData", path.join(userDataDir, "session"));

const ORIGIN = liveMode ? [106.8230084, -6.1918644] : [107.6308, -6.9783];
const CAR_DESTINATION = [107.6352, -6.9749];
const WALK_DESTINATION = [107.63255, -6.97655];

const overpassElements = [
  { type: "node", id: 1, lon: 107.6308, lat: -6.9783 },
  { type: "node", id: 2, lon: 107.6321, lat: -6.97735 },
  { type: "node", id: 3, lon: 107.63325, lat: -6.97645 },
  { type: "node", id: 4, lon: 107.6341, lat: -6.97575 },
  { type: "node", id: 5, lon: 107.6352, lat: -6.9749 },
  {
    type: "way",
    id: 100,
    nodes: [1, 2, 3],
    tags: {
      highway: "primary",
      name: "Jalan Telekomunikasi",
      lanes: "4",
      width: "18",
      sidewalk: "both",
      lit: "yes",
      tree_lined: "both",
      divider: "dashed_line",
      surface: "asphalt",
    },
  },
  {
    type: "way",
    id: 101,
    nodes: [3, 4, 5],
    tags: {
      highway: "primary",
      name: "Jembatan Telekomunikasi",
      lanes: "4",
      width: "18",
      bridge: "yes",
      layer: "1",
      lit: "yes",
      surface: "asphalt",
    },
  },
  { type: "node", id: 10, lon: 107.63278, lat: -6.97684 },
  { type: "node", id: 11, lon: 107.63325, lat: -6.97645 },
  { type: "node", id: 12, lon: 107.63372, lat: -6.97608 },
  {
    type: "way",
    id: 102,
    nodes: [10, 11, 12],
    tags: {
      highway: "footway",
      name: "JPO Telkom University",
      bridge: "yes",
      layer: "2",
      width: "3.2",
      lit: "yes",
      foot: "yes",
    },
  },
  { type: "node", id: 20, lon: 107.6307, lat: -6.97785 },
  { type: "node", id: 21, lon: 107.6311, lat: -6.97785 },
  { type: "node", id: 22, lon: 107.6311, lat: -6.97748 },
  { type: "node", id: 23, lon: 107.6307, lat: -6.97748 },
  {
    type: "way",
    id: 103,
    nodes: [20, 21, 22, 23, 20],
    tags: { building: "university", name: "Gedung Deli", "building:levels": "8", height: "30" },
  },
  { type: "node", id: 24, lon: 107.63465, lat: -6.9759 },
  { type: "node", id: 25, lon: 107.63515, lat: -6.9759 },
  { type: "node", id: 26, lon: 107.63515, lat: -6.97552 },
  { type: "node", id: 27, lon: 107.63465, lat: -6.97552 },
  {
    type: "way",
    id: 104,
    nodes: [24, 25, 26, 27, 24],
    tags: { building: "office", name: "Gedung Rektorat", "building:levels": "6" },
  },
  { type: "node", id: 30, lon: 107.6322, lat: -6.97805 },
  { type: "node", id: 31, lon: 107.63275, lat: -6.97805 },
  { type: "node", id: 32, lon: 107.63275, lat: -6.97765 },
  { type: "node", id: 33, lon: 107.6322, lat: -6.97765 },
  {
    type: "way",
    id: 105,
    nodes: [30, 31, 32, 33, 30],
    tags: { leisure: "park", name: "Taman Telkom University" },
  },
  { type: "node", id: 40, lon: 107.63055, lat: -6.9779 },
  { type: "node", id: 41, lon: 107.6327, lat: -6.9761 },
  { type: "node", id: 42, lon: 107.635, lat: -6.97455 },
  {
    type: "way",
    id: 106,
    nodes: [40, 41, 42],
    tags: { waterway: "stream", name: "Saluran Telekomunikasi" },
  },
  {
    type: "node",
    id: 200,
    lon: 107.63208,
    lat: -6.97737,
    tags: { highway: "traffic_signals", name: "Simpang Telkom", direction: "45" },
  },
  {
    type: "node",
    id: 201,
    lon: 107.63325,
    lat: -6.97645,
    tags: { highway: "crossing", crossing: "marked", name: "Zebra Cross Telkom" },
  },
  {
    type: "node",
    id: 202,
    lon: 107.63255,
    lat: -6.97702,
    tags: { man_made: "surveillance", surveillance: "traffic", name: "CCTV Telkom" },
  },
  {
    type: "node",
    id: 203,
    lon: 107.63185,
    lat: -6.97742,
    tags: { natural: "tree", genus: "Pterocarpus", name: "Pohon Angsana" },
  },
  {
    type: "node",
    id: 204,
    lon: 107.6345,
    lat: -6.97535,
    tags: { highway: "bus_stop", name: "Halte Telkom University" },
  },
  {
    type: "node",
    id: 205,
    lon: 107.63152,
    lat: -6.9777,
    tags: { emergency: "fire_hydrant", name: "Hidran Gedung Deli" },
  },
  {
    type: "node",
    id: 206,
    lon: 107.6336,
    lat: -6.97618,
    tags: { barrier: "bollard", name: "Bollard JPO" },
  },
  {
    type: "node",
    id: 207,
    lon: 107.63482,
    lat: -6.97517,
    tags: { highway: "speed_camera", name: "ETLE Jembatan" },
  },
];

const fixture = {
  origin: ORIGIN,
  carDestination: CAR_DESTINATION,
  walkDestination: WALK_DESTINATION,
  overpassElements,
  forceRouteFallback,
};

function browserFixtureBootstrap(data) {
  const nativeFetch = window.fetch.bind(window);
  const requests = [];
  const jsonResponse = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  const transparentPng = Uint8Array.from(
    atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
    (character) => character.charCodeAt(0),
  );
  const routeForUrl = (url) => {
    const encodedCoordinates = url.pathname.split("/").at(-1) || "";
    const pairs = encodedCoordinates.split(";").map((pair) => pair.split(",").map(Number));
    const origin = pairs[0]?.length === 2 ? pairs[0] : data.origin;
    const destination = pairs[1]?.length === 2 ? pairs[1] : data.carDestination;
    const firstBend = [
      origin[0] + (destination[0] - origin[0]) * 0.34,
      origin[1] + (destination[1] - origin[1]) * 0.34,
    ];
    const secondBend = [
      origin[0] + (destination[0] - origin[0]) * 0.7,
      origin[1] + (destination[1] - origin[1]) * 0.7,
    ];
    const walking = /routed-foot/.test(`${url.hostname}${url.pathname}`);
    const distance = walking ? 310 : 690;
    const duration = walking ? 245 : 82;
    return {
      code: "Ok",
      routes: [
        {
          distance,
          duration,
          geometry: { type: "LineString", coordinates: [origin, firstBend, secondBend, destination] },
          legs: [
            {
              steps: [
                {
                  distance: Math.round(distance * 0.45),
                  duration: Math.round(duration * 0.45),
                  name: "Jalan Telekomunikasi",
                  maneuver: { type: "depart", modifier: "straight", location: origin },
                },
                {
                  distance: Math.round(distance * 0.45),
                  duration: Math.round(duration * 0.45),
                  name: walking ? "JPO Telkom University" : "Jembatan Telekomunikasi",
                  maneuver: { type: "turn", modifier: "slight right", location: secondBend },
                },
                {
                  distance: 0,
                  duration: 0,
                  name: "Tujuan",
                  maneuver: { type: "arrive", modifier: "straight", location: destination },
                },
              ],
            },
          ],
        },
      ],
      waypoints: [],
    };
  };

  window.__navigation3dQa = { requests, fixture: data };
  window.fetch = async (input, init) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, location.href);
    if (/photon\.komoot\.io|\/route\/v1\/driving\/|overpass|interpreter/.test(url.href)) {
      requests.push({ url: url.href, method: init?.method || "GET" });
    }
    if (
      data.forceRouteFallback
      && /router\.project-osrm\.org/.test(url.hostname)
      && !window.__navigation3dQa.primaryRouteFailureForced
    ) {
      window.__navigation3dQa.primaryRouteFailureForced = true;
      throw new TypeError("Forced primary OSRM failure for fallback QA");
    }
    if (/photon\.komoot\.io$/.test(url.hostname) || /\/api\/?$/.test(url.pathname) && url.searchParams.has("q")) {
      const query = (url.searchParams.get("q") || "").toLocaleLowerCase("id-ID");
      const walking = query.includes("masjid") || query.includes("jalan kaki");
      const coordinate = walking ? data.walkDestination : data.carDestination;
      const title = walking ? "Masjid Syamsul Ulum" : "Gedung Deli Telkom University";
      return jsonResponse({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: coordinate },
            properties: {
              osm_id: walking ? 9002 : 9001,
              name: title,
              street: "Jalan Telekomunikasi",
              district: "Dayeuhkolot",
              city: "Bandung",
              state: "Jawa Barat",
              country: "Indonesia",
            },
          },
        ],
      });
    }
    if (/\/route\/v1\/driving\//.test(url.pathname)) return jsonResponse(routeForUrl(url));
    if (/overpass|interpreter/.test(url.hostname + url.pathname)) {
      return jsonResponse({ version: 0.6, generator: "Overpass API QA fixture", elements: data.overpassElements });
    }
    if (/basemaps\.cartocdn\.com$/.test(url.hostname)) {
      return new Response(transparentPng, {
        status: 200,
        headers: { "Content-Type": "image/png", "Access-Control-Allow-Origin": "*" },
      });
    }
    return nativeFetch(input, init);
  };

  let watchId = 0;
  const position = () => ({
    coords: {
      latitude: data.origin[1],
      longitude: data.origin[0],
      accuracy: 3,
      altitude: null,
      altitudeAccuracy: null,
      heading: 38,
      speed: null,
    },
    timestamp: Date.now(),
  });
  const geolocation = {
    getCurrentPosition(success) {
      setTimeout(() => success(position()), 8);
    },
    watchPosition(success) {
      watchId += 1;
      setTimeout(() => success(position()), 10);
      return watchId;
    },
    clearWatch() {},
  };
  try {
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: geolocation });
  } catch {
    navigator.geolocation.getCurrentPosition = geolocation.getCurrentPosition;
    navigator.geolocation.watchPosition = geolocation.watchPosition;
    navigator.geolocation.clearWatch = geolocation.clearWatch;
  }
}

function browserLiveBootstrap(data) {
  const nativeFetch = window.fetch.bind(window);
  const requests = [];
  window.__navigation3dQa = { requests, fixture: data, live: true };
  window.fetch = async (input, init) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, location.href);
    if (/photon\.komoot\.io|nominatim\.openstreetmap\.org|\/route\/v1\/driving\/|overpass|interpreter|basemaps\.cartocdn\.com/.test(url.href)) {
      requests.push({ url: url.href, method: init?.method || "GET", startedAt: Date.now() });
    }
    return nativeFetch(input, init);
  };

  let watchId = 0;
  const position = () => ({
    coords: {
      latitude: data.origin[1],
      longitude: data.origin[0],
      accuracy: 3,
      altitude: null,
      altitudeAccuracy: null,
      heading: 348,
      speed: null,
    },
    timestamp: Date.now(),
  });
  const geolocation = {
    getCurrentPosition(success) {
      setTimeout(() => success(position()), 8);
    },
    watchPosition(success) {
      watchId += 1;
      setTimeout(() => success(position()), 10);
      return watchId;
    },
    clearWatch() {},
  };
  try {
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: geolocation });
  } catch {
    navigator.geolocation.getCurrentPosition = geolocation.getCurrentPosition;
    navigator.geolocation.watchPosition = geolocation.watchPosition;
    navigator.geolocation.clearWatch = geolocation.clearWatch;
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const evaluate = (window, source) => window.webContents.executeJavaScript(source, true);
const stage = (message) => process.stdout.write(`[navigation3d-qa] ${message}\n`);

async function waitFor(window, expression, timeoutMs = 30_000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await evaluate(window, `Boolean(${expression})`)) return true;
    } catch (error) {
      lastError = error;
    }
    await delay(120);
  }
  if (lastError) throw lastError;
  return false;
}

async function capture(window, filename) {
  await evaluate(window, "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const image = await window.webContents.capturePage();
  const target = path.join(outputDir, filename);
  await fs.writeFile(target, image.toPNG());
  return { target, bytes: image.toPNG().byteLength, width: image.getSize().width, height: image.getSize().height };
}

async function inspectSearchUi(window) {
  return evaluate(window, `(() => {
    const input = document.querySelector('[data-nav3d-search-input]');
    const endpoint = input?.closest('.nav3d-endpoint');
    const panel = document.querySelector('[data-nav3d-search-panel]');
    const modes = document.querySelector('.nav3d-mode-scroll');
    const controls = Array.from(panel?.querySelectorAll('button, label.nav3d-mode') || [])
      .map((control) => ({ control, rect: control.getBoundingClientRect(), style: getComputedStyle(control) }))
      .filter(({ rect, style }) => rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden');
    const endpointStyle = endpoint ? getComputedStyle(endpoint) : null;
    const inputStyle = input ? getComputedStyle(input) : null;
    const rect = panel?.getBoundingClientRect();
    const panelStyle = panel ? getComputedStyle(panel) : null;
    const topElement = rect
      ? document.elementFromPoint(Math.min(innerWidth - 1, rect.left + rect.width / 2), Math.min(innerHeight - 1, rect.top + 24))
      : null;
    return {
      viewport: [innerWidth, innerHeight],
      panel: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width } : null,
      inputOutline: inputStyle ? [inputStyle.outlineStyle, inputStyle.outlineColor, inputStyle.outlineWidth] : null,
      endpointShadow: endpointStyle?.boxShadow || '',
      endpointBackground: endpointStyle?.backgroundColor || '',
      panelVisibility: panelStyle ? [panelStyle.display, panelStyle.visibility, panelStyle.opacity, panelStyle.zIndex] : null,
      panelOnTop: Boolean(panel && topElement && (topElement === panel || panel.contains(topElement))),
      modeOverflow: modes ? { clientWidth: modes.clientWidth, scrollWidth: modes.scrollWidth, overflowX: getComputedStyle(modes).overflowX } : null,
      minimumControlSize: controls.reduce((minimum, item) => {
        return Math.min(minimum, item.rect.width, item.rect.height);
      }, Number.POSITIVE_INFINITY),
    };
  })()`);
}

function assertSearchUi(state, compact) {
  const failures = [];
  if (!state.panel || state.panel.left < 0 || state.panel.right > state.viewport[0] + 0.5) failures.push('panel viewport bounds');
  if (!state.panelOnTop) failures.push('panel stacking order');
  if (!state.endpointShadow || state.endpointShadow === 'none') failures.push('visible endpoint focus ring');
  if (/247,\s*183,\s*49|#f7b731/i.test(`${state.endpointShadow} ${state.inputOutline?.join(' ') || ''}`)) failures.push('yellow focus ring');
  if (state.minimumControlSize < 48) failures.push(`touch target ${state.minimumControlSize}px`);
  if (!compact && state.modeOverflow && state.modeOverflow.scrollWidth > state.modeOverflow.clientWidth + 1) failures.push('desktop mode scrollbar');
  if (compact && state.modeOverflow?.overflowX !== 'auto') failures.push('mobile mode scroller');
  if (failures.length) throw new Error(`Navigation search UI assertions failed: ${failures.join(', ')}\n${JSON.stringify(state, null, 2)}`);
}

async function inspectShareableUrl(window) {
  return evaluate(window, `(() => {
    const params = new URLSearchParams(location.search);
    return {
      href: location.href,
      lat: params.get('lat'),
      lng: params.get('lng'),
      zoom: params.get('z'),
      bearing: params.get('bearing'),
      mode: params.get('mode'),
      nav: params.get('nav'),
      travel: params.get('travel'),
      destination: params.get('destination'),
      fromLat: params.get('fromLat'),
      fromLng: params.get('fromLng'),
      toLat: params.get('toLat'),
      toLng: params.get('toLng'),
    };
  })()`);
}

function assertShareableUrl(state, expectedDestination) {
  const required = ['lat', 'lng', 'zoom', 'bearing', 'mode', 'travel', 'destination', 'fromLat', 'fromLng', 'toLat', 'toLng'];
  const missing = required.filter((key) => !state[key]);
  if (missing.length) throw new Error(`Shareable map URL is missing ${missing.join(', ')}: ${JSON.stringify(state)}`);
  if (state.nav !== 'preview') throw new Error(`Shareable route URL did not enter preview state: ${JSON.stringify(state)}`);
  if (state.travel !== 'car') throw new Error(`Shareable route URL lost travel mode: ${JSON.stringify(state)}`);
  if (!String(state.destination || '').includes(expectedDestination.split(' ')[0])) {
    throw new Error(`Shareable route URL lost destination: ${JSON.stringify(state)}`);
  }
}

async function submitSearch(window, query, timeoutMs = 12_000) {
  await evaluate(
    window,
    `(() => {
      const input = document.querySelector('[data-nav3d-search-input]');
      const form = document.querySelector('[data-nav3d-search-form]');
      if (!(input instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) return false;
      input.value = ${JSON.stringify(query)};
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(query)} }));
      form.requestSubmit();
      return true;
    })()`,
  );
  if (!await waitFor(window, 'document.querySelectorAll("[data-nav3d-place-id]").length > 0', timeoutMs)) {
    throw new Error(`No geocoder result appeared for ${query}.`);
  }
}

async function selectFirstResultAndWaitForRoute(window, timeoutMs = 15_000) {
  await evaluate(window, 'document.querySelector("[data-nav3d-place-id]")?.click()');
  if (!await waitFor(
    window,
    `document.querySelector('[data-nav3d-preview]')?.hasAttribute('hidden') === false
      && document.querySelector('[data-nav3d-demo]')?.disabled === false
      && !/Menghitung|Rute gagal/.test(document.querySelector('[data-nav3d-preview-distance]')?.textContent || '')`,
    timeoutMs,
  )) {
    throw new Error("Route preview did not become ready.");
  }
  return evaluate(window, `({
    title: document.querySelector('[data-nav3d-preview-title]')?.textContent?.trim(),
    distance: document.querySelector('[data-nav3d-preview-distance]')?.textContent?.trim(),
    duration: document.querySelector('[data-nav3d-preview-duration]')?.textContent?.trim(),
    note: document.querySelector('[data-nav3d-routing-note]')?.textContent?.trim(),
  })`);
}

function navigationStateExpression() {
  return `(() => {
    const navigation = window.itsNavigation3D;
    const map = navigation?.map;
    const threeLayer = navigation?.threeLayer;
    const sourceCount = (id) => {
      const source = map?.getSource(id);
      const serialized = source?.serialize?.();
      const stored = source?._data;
      const data = stored?.geojson || serialized?.data || stored;
      if (Array.isArray(data?.features)) return data.features.length;
      return data?.type === 'Feature' ? 1 : 0;
    };
    const canvas = document.querySelector('[data-nav3d-map] canvas.maplibregl-canvas');
    const progress = document.querySelector('.nav3d-progress');
    const overlay = document.querySelector('[data-nav3d-overlay]');
    return {
      overlayVisible: Boolean(overlay && !overlay.hasAttribute('hidden')),
      canvas: Boolean(canvas),
      canvasSize: canvas ? [canvas.width, canvas.height] : [0, 0],
      mapLoaded: Boolean(map?.loaded?.()),
      pitch: Number(map?.getPitch?.() || 0),
      bearing: Number(map?.getBearing?.() || 0),
      layers: {
        roads: Boolean(map?.getLayer('nav-roads')),
        buildings: Boolean(map?.getLayer('nav-buildings')),
        bridges: Boolean(map?.getLayer('nav-bridges')),
        footbridges: Boolean(map?.getLayer('nav-footbridges')),
        markings: Boolean(map?.getLayer('nav-markings')),
        route: Boolean(map?.getLayer('nav-active-route')),
        three: Boolean(map?.getLayer('its-navigation-3d-models')),
      },
      sources: {
        roads: sourceCount('nav-roads'),
        buildings: sourceCount('nav-buildings'),
        bridges: sourceCount('nav-bridges'),
        footbridges: sourceCount('nav-footbridges'),
        markings: sourceCount('nav-markings'),
        symbols: sourceCount('nav-symbols'),
        route: sourceCount('nav-route'),
        traveled: sourceCount('nav-traveled'),
      },
      three: {
        mode: threeLayer?.avatarMode || '',
        ornaments: threeLayer?.world?.children?.length || 0,
        avatarObjects: threeLayer?.avatarVisual?.children?.length || 0,
        avatarVisible: Boolean(threeLayer?.avatar?.visible),
      },
      hud: {
        speed: Number(document.querySelector('[data-nav3d-speed]')?.textContent || 0),
        instruction: document.querySelector('[data-nav3d-instruction-text]')?.textContent?.trim() || '',
        road: document.querySelector('[data-nav3d-instruction-road]')?.textContent?.trim() || '',
        remaining: document.querySelector('[data-nav3d-remaining]')?.textContent?.trim() || '',
        progress: Number(progress?.getAttribute('aria-valuenow') || 0),
      },
      runtimeStatus: document.querySelector('[data-nav3d-runtime-status]')?.textContent?.trim() || '',
      currentCoordinate: navigation?.currentCoordinate || null,
      routeOrigin: navigation?.routeOrigin || null,
      destinationCoordinate: navigation?.selectedPlace?.coordinate || null,
      destinationTitle: navigation?.selectedPlace?.title || '',
      requests: window.__navigation3dQa?.requests || [],
    };
  })()`;
}

function assertSceneState(state, expectedMode) {
  const failures = [];
  if (!state.overlayVisible || !state.canvas || state.canvasSize[0] < 800 || state.canvasSize[1] < 500) failures.push("MapLibre canvas");
  for (const [name, present] of Object.entries(state.layers)) if (!present) failures.push(`layer:${name}`);
  for (const name of ["roads", "buildings", "bridges", "footbridges", "markings", "symbols", "route", "traveled"]) {
    if (state.sources[name] < 1) failures.push(`source:${name}`);
  }
  if (state.three.mode !== expectedMode || state.three.ornaments < 4 || state.three.avatarObjects < 1 || !state.three.avatarVisible) {
    failures.push("Three.js ornaments/avatar");
  }
  if (state.hud.speed <= 0 || state.hud.progress <= 0 || !state.hud.instruction || !state.hud.remaining) failures.push("moving HUD");
  if (state.pitch < 55) failures.push("3D pitch");
  if (failures.length) throw new Error(`${expectedMode} visual scene assertions failed: ${failures.join(", ")}\n${JSON.stringify(state, null, 2)}`);
}

function assertLiveSceneState(state, expectedMode) {
  const failures = [];
  if (!state.overlayVisible || !state.canvas || state.canvasSize[0] < 800 || state.canvasSize[1] < 500) failures.push("MapLibre canvas");
  for (const name of ["roads", "buildings", "markings", "route", "three"]) {
    if (!state.layers[name]) failures.push(`layer:${name}`);
  }
  for (const name of ["roads", "buildings", "route", "traveled"]) {
    if (state.sources[name] < 1) failures.push(`source:${name}`);
  }
  if (state.three.mode !== expectedMode || state.three.avatarObjects < 1 || !state.three.avatarVisible) failures.push("Three.js avatar");
  if (state.hud.speed <= 0 || state.hud.progress <= 0 || !state.hud.instruction || !state.hud.remaining) failures.push("moving HUD");
  if (state.pitch < 55) failures.push("3D pitch");
  if (failures.length) throw new Error(`${expectedMode} live visual scene assertions failed: ${failures.join(", ")}\n${JSON.stringify(state, null, 2)}`);
}

async function startSimulationAndInspect(window, expectedMode, live = false) {
  await evaluate(window, 'document.querySelector("[data-nav3d-demo]")?.click()');
  const sceneReadyExpression = live
    ? `(() => {
      const navigation = window.itsNavigation3D;
      const map = navigation?.map;
      const three = navigation?.threeLayer;
      const source = map?.getSource('nav-roads');
      const stored = source?._data;
      const data = stored?.geojson || source?.serialize?.()?.data || stored;
      return document.querySelector('[data-nav3d-overlay]')?.hasAttribute('hidden') === false
        && Boolean(document.querySelector('[data-nav3d-map] canvas.maplibregl-canvas'))
        && Boolean(map?.getLayer('its-navigation-3d-models'))
        && Array.isArray(data?.features) && data.features.length > 0
        && Boolean(three?.avatar?.visible)
        && Number(document.querySelector('[data-nav3d-speed]')?.textContent || 0) > 0
        && Number(document.querySelector('.nav3d-progress')?.getAttribute('aria-valuenow') || 0) > 0;
    })()`
    : `(() => {
      const navigation = window.itsNavigation3D;
      const map = navigation?.map;
      const three = navigation?.threeLayer;
      const source = map?.getSource('nav-footbridges');
      const stored = source?._data;
      const data = stored?.geojson || source?.serialize?.()?.data || stored;
      return document.querySelector('[data-nav3d-overlay]')?.hasAttribute('hidden') === false
        && Boolean(document.querySelector('[data-nav3d-map] canvas.maplibregl-canvas'))
        && Boolean(map?.getLayer('its-navigation-3d-models'))
        && Array.isArray(data?.features) && data.features.length > 0
        && (three?.world?.children?.length || 0) > 0
        && Number(document.querySelector('[data-nav3d-speed]')?.textContent || 0) > 0
        && Number(document.querySelector('.nav3d-progress')?.getAttribute('aria-valuenow') || 0) > 0;
    })()`;
  if (!await waitFor(
    window,
    sceneReadyExpression,
    live ? 90_000 : 30_000,
  )) {
    const diagnostic = await evaluate(window, navigationStateExpression());
    throw new Error(`${expectedMode} navigation scene did not become ready: ${JSON.stringify(diagnostic, null, 2)}`);
  }
  await delay(900);
  const state = await evaluate(window, navigationStateExpression());
  if (live) assertLiveSceneState(state, expectedMode);
  else assertSceneState(state, expectedMode);
  return state;
}

async function run() {
  stage("preparing output and browser session");
  await fs.mkdir(outputDir, { recursive: true });
  const preloadPath = path.join(outputDir, "fixture-preload.cjs");
  await fs.writeFile(
    preloadPath,
    liveMode
      ? `(${browserLiveBootstrap.toString()})(${JSON.stringify(fixture)});`
      : `(${browserFixtureBootstrap.toString()})(${JSON.stringify(fixture)});`,
  );
  const consoleMessages = [];
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    show: false,
    backgroundColor: "#dce6ed",
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      preload: preloadPath,
    },
  });
  window.webContents.on("console-message", (event) => {
    consoleMessages.push({ level: event.level, message: event.message, source: event.sourceId, line: event.lineNumber });
  });
  await window.webContents.session.clearStorageData({ storages: ["serviceworkers", "cachestorage", "localstorage", "cookies"] });
  await window.webContents.session.clearCache();
  stage(liveMode ? "live network QA preload installed" : "deterministic browser fixture preload installed");

  try {
    stage(`loading ${baseUrl}`);
    await window.loadURL(`${baseUrl}/?lat=${ORIGIN[1]}&lng=${ORIGIN[0]}&z=18&overpass=0&nav3d-qa=1`);
    stage("waiting for navigation bootstrap");
    if (!await waitFor(window, 'window.itsNavigation3D && document.querySelector("[data-nav3d-launcher]")', 30_000)) {
      throw new Error("Navigation3D bootstrap is not mounted. Import ./navigation3d/bootstrap from main.ts.");
    }
    await waitFor(window, '!document.querySelector("#its-splash")', 10_000);

    stage("opening and capturing search flow");
    await evaluate(window, 'document.querySelector("[data-nav3d-launcher]")?.click()');
    if (!await waitFor(window, 'document.querySelector("[data-nav3d-search-panel]")?.hasAttribute("hidden") === false', 5_000)) {
      throw new Error("Navigation search panel did not open.");
    }
    const destinationQuery = liveMode ? "Monumen Nasional" : "Gedung Deli Telkom University";
    await submitSearch(window, destinationQuery, liveMode ? 45_000 : 12_000);
    const desktopSearchUi = await inspectSearchUi(window);
    assertSearchUi(desktopSearchUi, false);
    const searchScreenshot = await capture(window, liveMode ? "monas-thamrin-live-search.png" : "search-panel.png");
    const carPreview = await selectFirstResultAndWaitForRoute(window, liveMode ? 60_000 : 15_000);
    const shareableUrl = await inspectShareableUrl(window);
    assertShareableUrl(shareableUrl, destinationQuery);
    let restoredUrl = null;
    if (!liveMode) {
      stage("validating navigation URL hydration after reload");
      await window.reload();
      if (!await waitFor(
        window,
        `window.itsNavigation3D
          && document.querySelector('[data-nav3d-search-panel]')?.hasAttribute('hidden') === false
          && document.querySelector('[data-nav3d-preview]')?.hasAttribute('hidden') === false
          && document.querySelector('[data-nav3d-demo]')?.disabled === false`,
        30_000,
      )) {
        throw new Error("Shareable navigation URL did not restore the route preview after reload.");
      }
      restoredUrl = await inspectShareableUrl(window);
      assertShareableUrl(restoredUrl, destinationQuery);
    }
    stage("starting car simulation");
    const carState = await startSimulationAndInspect(window, "car", liveMode);
    if (liveMode) await delay(2_500);
    const carScreenshot = await capture(window, liveMode ? "monas-thamrin-live-car-3d.png" : "car-3d.png");

    let mobileCarScreenshot = null;
    if (!liveMode) {
      await window.setSize(390, 844);
      await evaluate(window, "window.itsNavigation3D?.map?.resize(); window.itsNavigation3D?.updateCamera?.(true)");
      await delay(700);
      mobileCarScreenshot = await capture(window, "car-3d-mobile.png");
      await window.setSize(1440, 960);
      await evaluate(window, "window.itsNavigation3D?.map?.resize(); window.itsNavigation3D?.updateCamera?.(true)");
      await delay(400);
    }

    if (liveMode) {
      const screenshotFailures = [searchScreenshot, carScreenshot]
        .filter((item) => item.bytes < 20_000 || item.width < 1_200 || item.height < 700);
      if (screenshotFailures.length) throw new Error(`Live screenshot output is incomplete: ${JSON.stringify(screenshotFailures)}`);
      const requests = carState.requests;
      const networkAssertions = {
        geocoder: requests.filter((request) => /photon\.komoot\.io|nominatim\.openstreetmap\.org/.test(request.url)).length,
        osrmCar: requests.filter((request) => /router\.project-osrm\.org/.test(request.url)).length,
        overpass: requests.filter((request) => /overpass|interpreter/.test(request.url)).length,
      };
      if (Object.values(networkAssertions).some((count) => count < 1)) {
        throw new Error(`Expected live endpoint calls are missing: ${JSON.stringify(networkAssertions)}`);
      }
      if (!/Monumen Nasional|National Monument/i.test(carPreview.title || "")) {
        throw new Error(`Live destination did not resolve to Monumen Nasional: ${JSON.stringify(carPreview)}`);
      }
      const destination = carState.destinationCoordinate;
      const routeOrigin = carState.routeOrigin;
      if (!Array.isArray(destination) || Math.abs(destination[0] - 106.8271692) > 0.015 || Math.abs(destination[1] + 6.1754024) > 0.015) {
        throw new Error(`Live destination is outside the Monas area: ${JSON.stringify(destination)}`);
      }
      if (!Array.isArray(routeOrigin) || Math.abs(routeOrigin[0] - ORIGIN[0]) > 0.0002 || Math.abs(routeOrigin[1] - ORIGIN[1]) > 0.0002) {
        throw new Error(`Live route origin did not use the mocked Bundaran HI position: ${JSON.stringify(routeOrigin)}`);
      }
      const report = {
        status: "pass",
        mode: "live",
        baseUrl,
        generatedAt: new Date().toISOString(),
        scenario: "Bundaran HI, Jalan M.H. Thamrin to Monumen Nasional",
        mockedOnly: ["browser geolocation at Bundaran HI"],
        liveSources: ["Photon or Nominatim", "OSRM", "Overpass", "CARTO"],
        origin: ORIGIN,
        screenshots: { search: searchScreenshot, car: carScreenshot },
        searchUi: { desktop: desktopSearchUi },
        preview: { car: carPreview },
        scene: { car: carState },
        networkAssertions,
        consoleMessages,
      };
      await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2));
      return report;
    }

    await evaluate(window, 'document.querySelector("[data-nav3d-exit]")?.click()');
    if (!await waitFor(window, 'document.querySelector("[data-nav3d-overlay]")?.hasAttribute("hidden") === true', 5_000)) {
      throw new Error("Car navigation overlay did not close.");
    }
    await evaluate(window, `(() => {
      const mode = document.querySelector('[data-nav3d-mode-input][value="walk"]');
      if (!(mode instanceof HTMLInputElement)) return false;
      mode.checked = true;
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await submitSearch(window, "Masjid Syamsul Ulum jalan kaki");
    const walkPreview = await selectFirstResultAndWaitForRoute(window);
    stage("starting walk simulation");
    const walkState = await startSimulationAndInspect(window, "walk");
    const walkScreenshot = await capture(window, "walk-3d.png");

    await evaluate(window, 'document.querySelector("[data-nav3d-exit]")?.click()');
    await window.setSize(390, 844);
    if (!await waitFor(window, 'innerWidth <= 390 && document.querySelector("[data-nav3d-search-panel]")?.hasAttribute("hidden") === false', 5_000)) {
      throw new Error("Mobile search panel did not become ready.");
    }
    await evaluate(window, 'document.querySelector("[data-nav3d-search-input]")?.focus()');
    const mobileSearchUi = await inspectSearchUi(window);
    assertSearchUi(mobileSearchUi, true);
    const mobileSearchScreenshot = await capture(window, "search-panel-mobile.png");

    const screenshotFailures = [searchScreenshot, carScreenshot, walkScreenshot]
      .filter((item) => item.bytes < 20_000 || item.width < 1_200 || item.height < 700);
    if (screenshotFailures.length) throw new Error(`Screenshot output is incomplete: ${JSON.stringify(screenshotFailures)}`);
    if (!mobileCarScreenshot || mobileCarScreenshot.bytes < 12_000 || mobileCarScreenshot.width > 420 || mobileCarScreenshot.height < 700) {
      throw new Error(`Mobile navigation screenshot is incomplete: ${JSON.stringify(mobileCarScreenshot)}`);
    }
    if (mobileSearchScreenshot.bytes < 12_000 || mobileSearchScreenshot.width > 420 || mobileSearchScreenshot.height < 700) {
      throw new Error(`Mobile screenshot output is incomplete: ${JSON.stringify(mobileSearchScreenshot)}`);
    }
    const requests = walkState.requests;
    const networkAssertions = {
      photon: requests.filter((request) => /photon\.komoot\.io/.test(request.url)).length,
      osrmCar: requests.filter((request) => /router\.project-osrm\.org/.test(request.url)).length,
      osrmFoot: requests.filter((request) => /routed-foot/.test(request.url)).length,
      overpass: requests.filter((request) => /overpass|interpreter/.test(request.url)).length,
    };
    if (Object.values(networkAssertions).some((count) => count < 1)) {
      throw new Error(`Expected mocked fetch calls are missing: ${JSON.stringify(networkAssertions)}`);
    }

    const report = {
      status: "pass",
      baseUrl,
      generatedAt: new Date().toISOString(),
      fixture: "deterministic Telkom University road scene",
      screenshots: { search: searchScreenshot, car: carScreenshot, mobileCar: mobileCarScreenshot, walk: walkScreenshot, mobileSearch: mobileSearchScreenshot },
      searchUi: { desktop: desktopSearchUi, mobile: mobileSearchUi },
      shareableUrl: { initial: shareableUrl, restored: restoredUrl },
      preview: { car: carPreview, walk: walkPreview },
      scene: { car: carState, walk: walkState },
      networkAssertions,
      consoleMessages,
    };
    await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    try {
      await capture(window, "failure.png");
    } catch {}
    if (error instanceof Error && consoleMessages.length) {
      error.message += `\nBrowser console: ${JSON.stringify(consoleMessages.slice(-30), null, 2)}`;
    }
    throw error;
  } finally {
    window.destroy();
  }
}

app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("ignore-gpu-blocklist");

app.whenReady().then(async () => {
  try {
    const report = await run();
    if (liveMode) {
      process.stdout.write(
        `Navigation3D live Monas-Thamrin QA passed: car=${report.scene.car.sources.roads} roads/${report.scene.car.sources.buildings} buildings, ` +
          `screenshots=${Object.values(report.screenshots).map((item) => path.basename(item.target)).join(",")}\n`,
      );
    } else {
      process.stdout.write(
        `Navigation3D visual QA passed: car=${report.scene.car.sources.roads} roads/${report.scene.car.three.ornaments} ornaments, ` +
          `walk=${report.scene.walk.sources.footbridges} JPO, screenshots=${Object.values(report.screenshots).map((item) => path.basename(item.target)).join(",")}\n`,
      );
    }
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
  }
});
