import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const origin = process.env.ITS_QA_URL || process.argv[2] || "http://localhost:4173";
const output = path.resolve("test-output", "universal-agent");
const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const questions = [
  "Bisa bantu jelaskan apa itu RF-DETR?",
  "Cari implementasi RF-DETR di GitHub dan jelaskan file utama.",
  "Cari paper RF-DETR, tampilkan PDF dan jelaskan rumus loss.",
  "Cari video tentang RF-DETR, putar sumber yang ditemukan, dan rangkum hanya dari transkrip/deskripsi yang berhasil dibaca.",
];

await fs.mkdir(output, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  timeout: 120_000,
  protocolTimeout: 900_000,
  userDataDir: path.join(output, `chrome-profile-${process.pid}`),
  args: ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
const consoleErrors = [];
const responseErrors = [];
page.on("console", (entry) => {
  if (entry.type() === "error" && !/ERR_BLOCKED_BY_CLIENT|favicon/i.test(entry.text())) consoleErrors.push(entry.text());
});
page.on("response", (response) => {
  if (response.status() >= 400) responseErrors.push({ status: response.status(), url: response.url() });
});
await page.evaluateOnNewDocument(() => {
  localStorage.setItem("its:consent:v1", JSON.stringify({ analytics: false, advertising: false, updatedAt: Date.now() }));
});
await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {
  // The map intentionally keeps long-lived startup requests. Readiness is
  // asserted below from the actual AI control instead of a navigation event.
});
await new Promise((resolve) => setTimeout(resolve, 10_000));
await page.waitForSelector("#its-ai-chat-fab", { visible: true, timeout: 30_000 });
// Invoke the button itself instead of a coordinate click: map controls and
// consent transitions may temporarily overlap the floating button in headless
// rendering even though the control is visible and keyboard-activatable.
await page.$eval("#its-ai-chat-fab", (button) => button.click());
await page.waitForSelector("#its-ai-chat-modal.open", { visible: true });
await page.screenshot({ path: path.join(output, "desktop-chat.png") });

const results = [];
for (const [index, question] of questions.entries()) {
  const assistantCount = await page.$$eval(".its-ai-chat-msg.assistant", (messages) => messages.length);
  await page.$eval("#its-ai-chat-question", (input, value) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); }, question);
  await page.$eval("[data-ai-chat-form]", (form) => {
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: form.querySelector("[type=submit]") }));
  });
  await page.waitForFunction(
    (previousCount) => document.querySelectorAll(".its-ai-chat-msg.assistant").length > previousCount
      && !document.querySelector("[data-ai-chat-form]")?.classList.contains("is-busy"),
    { timeout: 720_000 },
    assistantCount,
  );
  const state = await page.evaluate(() => {
    const messages = [...document.querySelectorAll(".its-ai-chat-msg.assistant")];
    const message = messages.at(-1);
    return {
      text: message?.textContent?.trim() || "",
      references: message?.querySelectorAll(".its-ai-reference-item").length || 0,
      pdf: [...(message?.querySelectorAll("a") || [])].filter((link) => link.textContent?.trim() === "PDF").length,
      code: message?.querySelectorAll("pre code").length || 0,
      playback: document.querySelectorAll(".its-agent-playback-timeline li").length,
    };
  });
  const failed = /planner menyatakan|FAILED|belum memiliki bukti atau data yang cukup/i.test(state.text);
  const expectsCode = /github|implementasi/i.test(question);
  const expectsPdf = /paper|pdf|rumus/i.test(question);
  const expectsVideo = /video|putar|transkrip/i.test(question);
  const artifactReady = (!expectsCode || state.code > 0)
    && (!expectsPdf || state.pdf > 0)
    && (!expectsVideo || state.playback > 0);
  results.push({ question, ...state, passed: !failed && artifactReady && state.text.length > 80 && state.references > 0 });
  console.log(`QA ${index + 1}/${questions.length}: ${results.at(-1).passed ? "passed" : "failed"}; references=${state.references}; playback=${state.playback}`);
  await page.screenshot({ path: path.join(output, `result-${index + 1}.png`), fullPage: false });
}

await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 1 });
await page.screenshot({ path: path.join(output, "mobile-chat.png") });
await browser.close();
const report = { origin, generatedAt: new Date().toISOString(), results, consoleErrors, responseErrors };
await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
if (results.some((result) => !result.passed) || consoleErrors.length || responseErrors.length) {
  const failedCount = results.filter((result) => !result.passed).length;
  throw new Error(`Universal agent QA failed: ${failedCount} scenario(s), ${consoleErrors.length} console error(s), ${responseErrors.length} HTTP error(s). See ${path.join(output, "report.json")}.`);
}
console.log(`Universal agent QA passed ${results.length}/${questions.length}.`);
