const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

const baseUrl = process.env.ITS_QA_URL || "http://127.0.0.1:4182";
const target = `${baseUrl}/?lat=-6.971881&lng=107.502390&z=16&bearing=0&mode=street`;
const output = path.resolve(__dirname, "..", "test-output", "vector-map", "custom-street-target.png");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const errors = [];
  const archiveRequests = [];
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { contextIsolation: true } });
  window.webContents.session.webRequest.onCompleted({ urls: ["https://its.hanifahseptiani45.workers.dev/*"] }, (details) => {
    archiveRequests.push({ url: details.url, status: details.statusCode, headers: details.responseHeaders });
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2 && !/Electron Security Warning/i.test(message)) errors.push(`${message} @ ${sourceId || "unknown"}:${line || 0}`);
  });
  await window.loadURL(target);
  const started = Date.now();
  while (Date.now() - started < 45_000) {
    const ready = await window.webContents.executeJavaScript(`Boolean(
      document.querySelector('[data-mode="street"].active') &&
      document.querySelector('.maplibre-overlay.is-ready canvas')
    )`);
    if (ready) break;
    await delay(250);
  }
  await delay(2_500);
  const state = await window.webContents.executeJavaScript(`(() => ({
    streetActive: Boolean(document.querySelector('[data-mode="street"].active')),
    mapLibreReady: Boolean(document.querySelector('.maplibre-overlay.is-ready canvas')),
    cartoVisible: [...document.querySelectorAll('img.leaflet-tile')].some((image) =>
      /cartocdn\\.com/i.test(image.currentSrc || image.src) && getComputedStyle(image).display !== 'none'),
    center: new URLSearchParams(location.search).get('lat') + ',' + new URLSearchParams(location.search).get('lng'),
    overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    canvas: (() => { const canvas = document.querySelector('.maplibre-overlay canvas'); return canvas ? { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight } : null; })(),
    rects: (() => { const map = document.querySelector('#map')?.getBoundingClientRect(); const overlay = document.querySelector('.maplibre-overlay')?.getBoundingClientRect(); return { map: map && { width: map.width, height: map.height }, overlay: overlay && { width: overlay.width, height: overlay.height } }; })(),
  }))()`);
  const image = await window.webContents.capturePage();
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, image.toPNG());
  if (!state.streetActive || !state.mapLibreReady || state.cartoVisible || state.overflow > 1 || errors.length) {
    throw new Error(JSON.stringify({ state, errors, archiveRequests }, null, 2));
  }
  console.log(JSON.stringify({ passed: true, target, output, state, archiveRequests: archiveRequests.map((request) => ({ url: request.url, status: request.status, range: request.headers?.["content-range"] })) }, null, 2));
  await window.close();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
