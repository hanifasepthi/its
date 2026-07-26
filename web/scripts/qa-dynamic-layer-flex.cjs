const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

const baseUrl = process.env.ITS_QA_URL || "http://127.0.0.1:4173";
const output = path.resolve(__dirname, "..", "test-output", "dynamic-layer-flex.png");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(window, expression, timeout = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`, true)) return;
    await delay(120);
  }
  throw new Error(`Timed out: ${expression}`);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await window.loadURL(`${baseUrl}/?lat=-6.180346&lng=106.826604&z=17&mode=street`);
  await waitFor(window, '!document.querySelector("#its-splash")');
  await waitFor(window, 'document.querySelector("[data-dynamics-panel]")');
  await window.webContents.executeJavaScript('document.querySelector("[data-dynamics-panel]").click()', true);
  await waitFor(window, 'document.querySelector("#m-layer-modal.open")');
  await delay(500);
  const state = await window.webContents.executeJavaScript(`(() => {
    const map = document.querySelector("#map")?.getBoundingClientRect();
    const sheet = document.querySelector("#m-layer-modal .m-layer-sheet")?.getBoundingClientRect();
    const backdrop = document.querySelector("#m-layer-modal .m-layer-backdrop");
    return {
      sidePanel: document.body.classList.contains("side-panel-open"),
      panelWidth: getComputedStyle(document.documentElement).getPropertyValue("--side-panel-active-width"),
      mapRight: map?.right,
      sheetLeft: sheet?.left,
      mapWidth: map?.width,
      sheetWidth: sheet?.width,
      mapClass: document.querySelector("#map")?.className,
      mapComputedRight: getComputedStyle(document.querySelector("#map")).right,
      backdropPointerEvents: backdrop ? getComputedStyle(backdrop).pointerEvents : "",
      bodyOverflow: document.body.scrollWidth - innerWidth,
    };
  })()`, true);
  if (!state.sidePanel || state.mapWidth >= 1100 || Math.abs(state.mapRight - state.sheetLeft) > 3
    || state.backdropPointerEvents !== "none" || state.bodyOverflow > 1) {
    throw new Error(`Dynamic panel does not flex the map:\n${JSON.stringify(state, null, 2)}`);
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, (await window.webContents.capturePage()).toPNG());
  process.stdout.write(`${JSON.stringify({ ok: true, output, state }, null, 2)}\n`);
  await window.close();
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
