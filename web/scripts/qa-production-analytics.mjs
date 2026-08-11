import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const origin = process.argv[2] || "https://itstelkom.web.app";
const output = path.resolve("test-output", "production-analytics");
await fs.mkdir(output, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  timeout: 120_000,
  args: [
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-features=TrackingProtection3pcd",
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    if (["image", "font", "media"].includes(request.resourceType())
      || /\.(?:wasm|onnx|pmtiles)(?:$|\?)/i.test(url)
      || /(?:basemaps\.cartocdn\.com|raw\.githubusercontent\.com)/i.test(url)) {
      void request.abort();
    } else {
      void request.continue();
    }
  });
  const analyticsRequests = [];
  const failures = [];
  const successfulUrls = new Set();
  page.on("request", (request) => {
    if (/(?:google-analytics|googletagmanager|clarity\.ms|cloudflareinsights)/i.test(request.url())) {
      analyticsRequests.push({ phase: "request", method: request.method(), url: request.url() });
    }
  });
  page.on("response", (response) => {
    if (/(?:google-analytics|googletagmanager|clarity\.ms|cloudflareinsights)/i.test(response.url())) {
      analyticsRequests.push({ phase: "response", status: response.status(), url: response.url() });
      if (response.status() >= 200 && response.status() < 400) successfulUrls.add(response.url());
    }
  });
  page.on("requestfailed", (request) => {
    if (/(?:google-analytics|googletagmanager|clarity\.ms|cloudflareinsights)/i.test(request.url())) {
      failures.push({ url: request.url(), error: request.failure()?.errorText || "unknown" });
    }
  });

  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 12_000));
  const state = await page.evaluate(() => {
    const forms = [...document.querySelectorAll("form")].map((form) => {
      const fields = [...form.querySelectorAll("input,select,textarea")]
        .filter((field) => !["hidden", "submit", "button"].includes(field.getAttribute("type") || ""))
        .map((field) => ({
          tag: field.tagName.toLowerCase(),
          name: field.getAttribute("name") || "",
          title: field.getAttribute("title") || "",
          description: field.getAttribute("toolparamdescription") || field.getAttribute("aria-description") || "",
        }));
      return {
        toolname: form.getAttribute("toolname") || "",
        tooldescription: form.getAttribute("tooldescription") || "",
        action: form.getAttribute("action") || "",
        method: form.getAttribute("method") || "",
        fields,
      };
    });
    return {
      title: document.title,
      canonical: document.querySelector('link[rel="canonical"]')?.href || "",
      robots: document.querySelector('meta[name="robots"]')?.getAttribute("content") || "",
      analyticsLoader: Boolean(document.querySelector('script[src="/analytics.js"]')),
      googleTag: Boolean(document.querySelector("script[data-its-google-tag]")),
      clarityTag: Boolean(document.querySelector('script[src*="clarity.ms/tag/"]')),
      cloudflareTag: Boolean(document.querySelector("script[data-cf-beacon]")),
      consentManager: Boolean(document.querySelector("its-consent-manager")),
      openDialogs: document.querySelectorAll("dialog[open]").length,
      analyticsStatus: typeof window.ITSAnalytics?.status === "function" ? window.ITSAnalytics.status() : null,
      forms,
      webMcpForms: forms.filter((form) => form.toolname && form.tooldescription).length,
      uncoveredForms: forms.filter((form) =>
        !form.toolname
        || !form.tooldescription
        || form.fields.some((field) => !field.name || !field.title || !field.description)),
    };
  });
  const actionableFailures = failures.filter((failure) =>
    ![...successfulUrls].some((url) => url === failure.url)
    && !/\/c\.gif(?:$|\?)/i.test(failure.url));
  const report = {
    origin,
    generatedAt: new Date().toISOString(),
    state,
    analyticsRequests,
    failures,
    actionableFailures,
  };
  await page.screenshot({ path: path.join(output, "home.png"), fullPage: false });
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
