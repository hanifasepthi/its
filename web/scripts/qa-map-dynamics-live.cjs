const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const baseUrl = process.env.ITS_QA_URL || "http://127.0.0.1:4181";
const expectedVersion = process.env.ITS_QA_DATASET_VERSION || "2026-07-21.3";
const testLat = Number(process.env.ITS_QA_LAT || -6.977254);
const testLng = Number(process.env.ITS_QA_LNG || 107.631817);
const testLabel = String(process.env.ITS_QA_LABEL || "telkom-bandung").replace(/[^a-z0-9-]+/gi, "-");
const outputDir = path.resolve(__dirname, "..", "test-output", "map-dynamics-live");
fsSync.mkdirSync(outputDir, { recursive: true });
app.setPath("userData", path.join(outputDir, "electron-user-data"));
app.disableHardwareAcceleration();

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(window, expression, timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`, true)) return true;
    await delay(180);
  }
  return false;
}

async function run() {
  await fs.mkdir(outputDir, { recursive: true });
  const errors = [];
  const window = new BrowserWindow({
    width: 1365,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 3 && !/favicon|ERR_BLOCKED_BY_CLIENT|cloudflareinsights\.com\/cdn-cgi\/rum/i.test(message)) errors.push(message);
  });
  window.webContents.on("render-process-gone", (_event, details) => errors.push(`renderer:${details.reason}`));
  await window.loadURL(`${baseUrl}/?lat=${testLat}&lng=${testLng}&z=17&place=${encodeURIComponent(testLabel)}`);
  // The splash is injected after initial HTML evaluation, so waiting for its
  // absence alone can resolve before application bootstrap has even begun.
  await waitFor(window, 'document.querySelector("img.leaflet-tile[src*=\\"cartocdn.com\\"]")', 30_000);
  await delay(2_500);
  await waitFor(window, '!document.querySelector("#its-splash")', 15_000);
  const loaded = await waitFor(window, `document.querySelector("#map")?.dataset.mapDynamicsVersion === ${JSON.stringify(expectedVersion)} && Number(document.querySelector("#map")?.dataset.mapDynamicsFeatures || 0) > 0`);
  const state = await window.webContents.executeJavaScript(`(() => {
    const map = document.querySelector("#map");
    const pane = document.querySelector('[data-map-dynamics-pane="verified-only"]');
    return {
      version: map?.dataset.mapDynamicsVersion || "",
      features: Number(map?.dataset.mapDynamicsFeatures || 0),
      pane: Boolean(pane),
      paths: pane?.querySelectorAll("path").length || 0,
      symbols: pane?.querySelectorAll("span, svg").length || 0,
      cartoTiles: document.querySelectorAll('img.leaflet-tile[src*="cartocdn.com"]').length,
      standalonePoiDisplay: getComputedStyle(document.querySelector(".poi-visibility-control")).display,
      consentUi: document.querySelectorAll('[data-analytics-consent], [data-analytics-preferences], .analytics-consent-banner, .analytics-preferences-button, .analytics-preferences-panel').length,
      overflow: Math.max(0, document.body.scrollWidth - innerWidth),
    };
  })()`, true);
  const image = await window.webContents.capturePage();
  await fs.writeFile(path.join(outputDir, `${testLabel}.png`), image.toPNG());
  await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify({ baseUrl, generatedAt: new Date().toISOString(), loaded, state, errors }, null, 2));
  window.destroy();

  const failures = [];
  if (!loaded || state.version !== expectedVersion || state.features <= 0) failures.push("published shard did not load");
  if (!state.pane || state.paths <= 0) failures.push("verified pane did not render geometry");
  if (state.cartoTiles <= 0) failures.push("CARTO is not the underlying 2D basemap");
  if (state.standalonePoiDisplay !== "none") failures.push("standalone POI eye is visible");
  if (state.consentUi !== 0) failures.push("retired analytics consent UI returned");
  if (state.overflow > 1) failures.push("viewport overflow");
  if (errors.length) failures.push(`application errors: ${JSON.stringify(errors)}`);
  if (failures.length) throw new Error(`${failures.join(", ")}\n${JSON.stringify(state, null, 2)}`);
  return state;
}

app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("no-sandbox");

app.whenReady().then(async () => {
  try {
    const state = await run();
    process.stdout.write(`Map dynamics live QA passed: version=${state.version}, features=${state.features}, paths=${state.paths}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
  }
});
