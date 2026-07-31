import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const origin = process.env.ITS_QA_URL || process.argv[2] || "http://localhost:4173";
const localPreview = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(origin);
const output = path.resolve("test-output", "universal-agent");
const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const scenarioTimeout = Math.max(30_000, Number(process.env.ITS_QA_SCENARIO_TIMEOUT_MS || 720_000));
const allQuestions = [
  "Bisa bantu jelaskan apa itu RF-DETR?",
  "Cari implementasi RF-DETR di GitHub dan jelaskan file utama.",
  "Cari paper RF-DETR, tampilkan PDF dan jelaskan rumus loss.",
  "Cari video tentang RF-DETR, putar sumber yang ditemukan, dan rangkum hanya dari transkrip/deskripsi yang berhasil dibaca.",
];
const requestedIndexes = String(process.env.ITS_QA_SCENARIOS || "")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value >= 1 && value <= allQuestions.length);
const questions = requestedIndexes.length
  ? requestedIndexes.map((index) => allQuestions[index - 1])
  : allQuestions;

async function capture(page, filename) {
  await Promise.race([
    page.screenshot({ path: path.join(output, filename), fullPage: false }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Screenshot timeout: ${filename}`)), 30_000)),
  ]);
}

await fs.mkdir(output, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  timeout: 120_000,
  protocolTimeout: 900_000,
  userDataDir: path.join(output, `chrome-profile-${process.pid}`),
  args: [
    "--disable-gpu",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--proxy-bypass-list=<-loopback>;localhost;127.0.0.1",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
const consoleErrors = [];
const responseErrors = [];
const researchResponses = [];
page.on("console", (entry) => {
  if (entry.type() !== "error" || /ERR_BLOCKED_BY_CLIENT|favicon/i.test(entry.text())) return;
  const locationUrl = entry.location().url || "";
  const previewOnlyMapCors = localPreview
    && (/its\.hanifahseptiani45\.workers\.dev\/v1\/map\/deltas/i.test(entry.text())
      || /its\.hanifahseptiani45\.workers\.dev\/v1\/map\/deltas/i.test(locationUrl));
  if (!previewOnlyMapCors) consoleErrors.push(entry.text());
});
page.on("response", (response) => {
  if (response.status() >= 400) responseErrors.push({ status: response.status(), url: response.url() });
  if (/api\.github\.com\/(?:search\/repositories|repos\/[^/]+\/[^/]+\/readme)|archive\.org\/advancedsearch/i.test(response.url())) {
    researchResponses.push({ status: response.status(), url: response.url() });
  }
});
await page.evaluateOnNewDocument(() => {
  localStorage.setItem("its:consent:v1", JSON.stringify({ analytics: false, advertising: false, updatedAt: Date.now() }));
});
await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {
  // The map intentionally keeps long-lived startup requests. Readiness is
  // asserted below from the actual AI control instead of a navigation event.
});
await new Promise((resolve) => setTimeout(resolve, 10_000));
try {
  await page.waitForSelector('button[aria-label="Buka chat AI ITS Maps"]', { visible: true, timeout: 120_000 });
} catch (error) {
  await capture(page, "startup-failure.png");
  await fs.writeFile(path.join(output, "startup-failure.json"), JSON.stringify({
    origin,
    url: page.url(),
    title: await page.title(),
    readyState: await page.evaluate(() => document.readyState),
    bodyText: await page.evaluate(() => document.body?.innerText?.slice(0, 2_000) || ""),
    consoleErrors,
    responseErrors,
  }, null, 2));
  throw error;
}
// Invoke the button itself instead of a coordinate click: map controls and
// consent transitions may temporarily overlap the floating button in headless
// rendering even though the control is visible and keyboard-activatable.
await page.$eval('button[aria-label="Buka chat AI ITS Maps"]', (button) => button.click());
await page.waitForSelector('form[toolname="ask_its_maps_assistant"]', { visible: true });
await capture(page, "desktop-chat.png");

const results = [];
for (const [index, question] of questions.entries()) {
  const assistantCount = await page.$$eval('article[aria-label="Jawaban ITS Assistant"]', (messages) => messages.length);
  await page.$eval('input[name="question"]', (input, value) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); }, question);
  await page.$eval('form[toolname="ask_its_maps_assistant"]', (form) => {
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: form.querySelector("[type=submit]") }));
  });
  try {
    await page.waitForFunction(
      (previousCount) => document.querySelectorAll('article[aria-label="Jawaban ITS Assistant"]').length > previousCount
        && !document.querySelector('form[toolname="ask_its_maps_assistant"] button[type="submit"]')?.disabled,
      { timeout: scenarioTimeout },
      assistantCount,
    );
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      assistantCount: document.querySelectorAll('article[aria-label="Jawaban ITS Assistant"]').length,
      userCount: document.querySelectorAll('article[aria-label="Pertanyaan pengguna"]').length,
      formClass: document.querySelector('form[toolname="ask_its_maps_assistant"]')?.className || "",
      activity: document.querySelector('[aria-live="polite"]')?.textContent?.trim().slice(0, 4_000) || "",
      chat: document.querySelector('[role="log"]')?.textContent?.trim().slice(-4_000) || "",
    }));
    await capture(page, `scenario-${index + 1}-failure.png`);
    await fs.writeFile(path.join(output, `scenario-${index + 1}-failure.json`), JSON.stringify({
      question,
      diagnostic,
      consoleErrors,
      responseErrors,
      researchResponses,
    }, null, 2));
    await browser.close();
    throw error;
  }
  const state = await page.evaluate(() => {
    const messages = [...document.querySelectorAll('article[aria-label="Jawaban ITS Assistant"]')];
    const message = messages.at(-1);
    return {
      text: message?.textContent?.trim() || "",
      references: [...(message?.querySelectorAll("a") || [])].filter((link) => /^\[S\d+\]$/.test(link.textContent?.trim() || "")).length,
      pdf: [...(message?.querySelectorAll("a") || [])].filter((link) => link.textContent?.trim() === "PDF").length,
      code: message?.querySelectorAll("pre code").length || 0,
      video: message?.querySelectorAll('iframe[src*="youtube-nocookie.com/embed/"]').length || 0,
      formula: message?.querySelectorAll('[role="math"]').length || 0,
      transcriptDisclaimer: /tidak ada transkrip publik|transkrip.*tidak.*berhasil/i.test(message?.textContent || ""),
      playback: document.querySelectorAll(".its-agent-playback-timeline li").length,
    };
  });
  const failed = /planner menyatakan|FAILED|belum memiliki bukti atau data yang cukup/i.test(state.text);
  const expectsCode = /github|implementasi/i.test(question);
  const expectsPdf = /paper|pdf|rumus/i.test(question);
  const expectsVideo = /video|putar|transkrip/i.test(question);
  const artifactReady = (!expectsCode || state.code > 0)
    && (!expectsPdf || state.pdf > 0)
    && (!expectsPdf || state.formula > 0)
    && (!expectsVideo || (state.video > 0 && state.transcriptDisclaimer));
  results.push({ question, ...state, passed: !failed && artifactReady && state.text.length > 80 && state.references > 0 });
  console.log(`QA ${index + 1}/${questions.length}: ${results.at(-1).passed ? "passed" : "failed"}; references=${state.references}; video=${state.video}; playback=${state.playback}`);
  await capture(page, `result-${index + 1}.png`);
}

await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 1 });
await capture(page, "mobile-chat.png");
await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
const report = { origin, generatedAt: new Date().toISOString(), results, consoleErrors, responseErrors, researchResponses };
await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
if (results.some((result) => !result.passed) || consoleErrors.length || responseErrors.length) {
  const failedCount = results.filter((result) => !result.passed).length;
  throw new Error(`Universal agent QA failed: ${failedCount} scenario(s), ${consoleErrors.length} console error(s), ${responseErrors.length} HTTP error(s). See ${path.join(output, "report.json")}.`);
}
console.log(`Universal agent QA passed ${results.length}/${questions.length}.`);
