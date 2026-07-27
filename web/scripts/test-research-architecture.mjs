import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptRoot, "..");

async function read(relativePath) {
  return fs.readFile(path.join(webRoot, relativePath), "utf8");
}

async function importTypeScript(relativePath) {
  const absolutePath = path.join(webRoot, relativePath);
  const result = await build({
    absWorkingDir: webRoot,
    stdin: {
      contents: await fs.readFile(absolutePath, "utf8"),
      resolveDir: path.dirname(absolutePath),
      sourcefile: path.basename(absolutePath),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2023",
    logLevel: "silent",
  });
  const source = result.outputFiles[0]?.text || "";
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

function source(id) {
  return {
    id,
    provider: "test",
    title: `Source ${id}`,
    authors: ["Researcher"],
    year: "2026",
    venue: "Test Journal",
    doi: `10.0/${id}`,
    url: `https://example.test/${id}`,
    pdfUrl: "",
    abstract: "",
    citationCount: 0,
    license: "cc-by",
    imageUrl: "",
    imageSourceUrl: "",
    status: "abstract",
    accessNote: "",
    score: 1,
    retrievedAt: Date.now(),
  };
}

function evidence(id, sourceId, text) {
  return {
    id,
    sourceId,
    blockId: `block-${id}`,
    type: "paragraph",
    text,
    score: 1,
    savedAt: Date.now(),
  };
}

const checks = [];
async function check(name, operation) {
  await operation();
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

await check("citation bibliography invariant", async () => {
  const module = await importTypeScript("src/research/CitationAuditor.ts");
  const sources = Array.from({ length: 10 }, (_, index) => source(`s${index + 1}`));
  const evidenceItems = sources.map((item, index) => evidence(`e${index + 1}`, item.id, `Verified statement number ${index + 1}`));
  const answer = {
    summary: "Grounded summary",
    sections: [{
      heading: "Evidence",
      paragraphs: evidenceItems.slice(0, 4).map((item) => ({ text: item.text, evidenceIds: [item.id] })),
    }],
    formulaSteps: [],
    limitations: [],
    usedEvidenceIds: evidenceItems.slice(0, 4).map((item) => item.id),
    supportRatio: 1,
    citedSourceIds: sources.slice(0, 4).map((item) => item.id),
  };
  const bibliography = module.bibliographyForAnswer(answer, evidenceItems, sources);
  assert.deepEqual(bibliography.map((item) => item.id), ["s1", "s2", "s3", "s4"]);
  const repaired = new module.CitationAuditor().validateAndRepair({
    summary: "Unsupported unrelated claim",
    sections: [{ heading: "Evidence", paragraphs: [{ text: evidenceItems[0].text, evidenceIds: ["e1"] }] }],
    formulaSteps: [],
    limitations: [],
    usedEvidenceIds: ["e1"],
  }, evidenceItems);
  assert.equal(repaired.summary, evidenceItems[0].text, "unsupported summary must be replaced by a validated claim");
  assert.throws(
    () => module.assertCitationInvariant(new Set(["s1"]), new Set(["s1", "s2"])),
    /do not match/,
  );
});

await check("direct website URL remains the only acceptance source", async () => {
  const module = await importTypeScript("src/research/SourceAdapter.ts");
  const url = "https://support.google.com/tagmanager/answer/14847097?hl=en&ref_topic=15191151";
  const plan = {
    intent: "website",
    needsRealtime: false,
    needsResearch: true,
    needsPdf: false,
    needsImages: false,
    needsFormulaDerivation: false,
    needsFreshSearch: true,
    followUpType: "none",
    topic: "Google Tag Manager",
    entities: [],
    queries: ["Google Tag Manager"],
    requiredTools: ["research-synthesis"],
    confidence: 1,
  };
  const found = await module.sourceAdapter.search(`Baca ${url}`, plan);
  assert.equal(found.length, 1);
  assert.equal(found[0].url, url);
  assert.equal(found[0].provider, "direct");
});

await check("one research orchestrator and no deterministic research engine", async () => {
  const main = await read("src/main.ts");
  const publicAgent = await read("src/publicResearchAgent.ts");
  const banned = [
    "itsDeterministicResearchAnswer",
    "itsCreateResearchTask",
    "itsSearchResearchSources",
    "itsAnswerResearchTask",
    "plan_its_research",
    "add_its_research_evidence",
    "finish_its_research",
  ];
  banned.forEach((token) => assert.equal(main.includes(token), false, `${token} masih ada di main.ts`));
  assert.match(main, /publicResearchAgent\.createWebMcpTools\(\)/);
  assert.match(publicAgent, /researchOrchestrator\.run/);
});

await check("synthesis is model-backed and domain-neutral in source", async () => {
  const generator = await read("src/research/GroundedAnswerGenerator.ts");
  assert.match(generator, /modelResolver\.resolve\("research-synthesis"\)/);
  assert.match(generator, /generateStructured/);
  ["Hungarian matching", "GIoU", "RF-DETR", "sigma bertopi"].forEach((phrase) => {
    assert.equal(generator.includes(phrase), false, `Jawaban statis ${phrase} ditemukan`);
  });
});

await check("planner is first and RTDB is conditional", async () => {
  const main = await read("src/main.ts");
  const orchestrator = await read("src/agent-core/AgentOrchestrator.ts");
  assert.match(main, /agentOrchestrator\.run\(/, "chat tidak memakai executive orchestrator");
  const plannerCall = orchestrator.indexOf("this.planQuestion(");
  const skillSelection = orchestrator.indexOf("this.selector.select(");
  assert.ok(plannerCall >= 0, "planner model tidak dipanggil");
  assert.ok(skillSelection > plannerCall, "skill dipilih sebelum planner selesai");
  assert.match(main, /context\.plan\.needsRealtimeData/, "adapter RTDB tidak memiliki guard planner");
});

await check("every factual question researches and hosted inference is absent", async () => {
  const planner = await read("src/agent-core/ExecutivePlanner.ts");
  const main = await read("src/main.ts");
  const resolver = await read("src/ai-runtime/ModelResolver.ts");
  assert.match(planner, /return !isBriefGreeting\(question\)/);
  assert.match(main, /if \(!socialOnly\)/);
  assert.doesNotMatch(main, /cloudflareAiClient\.generate\("research-synthesis"/);
  assert.doesNotMatch(resolver, /cloudflareAiClient\.generate/);
});

await check("Qwen3 local model cascade is configured", async () => {
  const models = await read("src/ai-runtime/ModelTaskTypes.ts");
  const expected = [
    "onnx-community/Qwen3-4B-ONNX",
    "onnx-community/Qwen3-1.7B-ONNX",
    "onnx-community/Qwen3-0.6B-ONNX",
  ];
  expected.forEach((id) => assert.ok(models.includes(id), `${id} tidak dikonfigurasi`));
});

await check("GitHub public repository reader uses browser-safe Tree and Raw APIs", async () => {
  const reader = await read("src/research/GitHubRepositoryReader.ts");
  const orchestrator = await read("src/research/ResearchOrchestrator.ts");
  assert.doesNotMatch(reader, /fetch\(archiveUrl/);
  assert.match(reader, /api\.github\.com\/repos/);
  assert.match(reader, /raw\.githubusercontent\.com/);
  assert.match(reader, /MAX_FILE_BYTES/);
  assert.match(reader, /Lisensi repositori/);
  assert.match(orchestrator, /githubRepositoryReader\.read/);
});

await check("Pyodide sandbox is user-triggered, allowlisted, timed, and terminable", async () => {
  const client = await read("src/research/PythonSandbox.ts");
  const worker = await read("src/research/PythonSandboxWorker.ts");
  assert.match(client, /navigator\.userActivation\?\.isActive/);
  assert.match(client, /setTimeout/);
  assert.match(client, /\.terminate\(\)/);
  assert.match(worker, /ALLOWED_IMPORTS/);
  assert.match(worker, /loadPyodide/);
});

await check("national shard URLs use an immutable existing GitHub revision", async () => {
  const hosting = await read("scripts/prepare-hosting-artifacts.mjs");
  assert.match(hosting, /MAP_DATA_REVISION\s*=\s*"[a-f0-9]{40}"/);
  assert.doesNotMatch(hosting, /raw\.githubusercontent\.com\/hanifasepthi\/its\/upload\/its-maps-final/);
});

await check("public provider registry includes optional metasearch and open media", async () => {
  const adapter = await read("src/research/SourceAdapter.ts");
  ["Crossref", "OpenAlex", "Europe PMC", "Wikipedia", "Wikimedia Commons", "Internet Archive", "SearXNG"].forEach((provider) => {
    assert.ok(adapter.includes(provider), `${provider} belum terdaftar`);
  });
});

await check("follow-up memory preserves topic and prior evidence", async () => {
  const orchestrator = await read("src/research/ResearchOrchestrator.ts");
  const memory = await read("src/research/ConversationResearchMemory.ts");
  assert.match(orchestrator, /previousResearchPlan:\s*memory\.plan/);
  assert.match(orchestrator, /previousTopic:\s*memory\.topic/);
  assert.match(orchestrator, /reusePrevious\s*=\s*!plan\.needsFreshSearch/);
  assert.match(memory, /sessionStorage\.setItem/);
  assert.match(memory, /evidence:\s*value\.evidence\.slice/);
  assert.match(memory, /figures:\s*value\.figures\.slice/);
});

await check("live playback exposes every required real-process event", async () => {
  const playback = await read("src/agentLiveActivity.ts");
  const orchestrator = await read("src/research/ResearchOrchestrator.ts");
  const eventNames = [
    "session-start", "plan-created", "query-typing", "search-submit", "search-results",
    "pointer-move", "pointer-click", "tab-open", "tab-activate", "content-loaded",
    "scroll-to-block", "read-block-start", "read-word-progress", "read-block-complete",
    "pdf-open", "pdf-page-rendered", "pdf-page-read", "figure-open", "figure-analysed",
    "evidence-saved", "tab-close", "writing-start", "writing-token", "citation-validation",
    "session-complete", "session-error",
  ];
  eventNames.forEach((name) => assert.ok(playback.includes(`| "${name}"`) || playback.includes(`"${name}"`), `${name} tidak dideklarasikan`));
  ["content-loaded", "read-block-start", "evidence-saved", "writing-token"].forEach((name) => {
    assert.ok(orchestrator.includes(`type: "${name}"`), `${name} tidak berasal dari orchestrator`);
  });
  assert.match(playback, /getBoundingClientRect\(\)/);
  assert.match(playback, /data-playback-id/);
});

await check("PDF is worker-based with selective OCR and coverage", async () => {
  const reader = await read("src/research/PdfSourceReader.ts");
  const worker = await read("src/research/PdfSourceWorker.ts");
  assert.match(reader, /new Worker\(new URL\("\.\/PdfSourceWorker\.ts"/);
  assert.match(reader, /modelResolver\.resolve\("OCR"\)/);
  assert.match(worker, /getTextContent\(\)/);
  assert.match(worker, /readCanvasWithOcr/);
  assert.match(worker, /visuallyAnalysedPages\.push/);
  assert.match(worker, /disposeOcr\(\)/);
});

await check("forbidden swipe copy is absent while gesture hooks remain", async () => {
  const files = [
    await read("src/main.ts"),
    await read("scripts/generate-method-docs.mjs"),
    await read("public/roadmap/index.html"),
  ];
  const combined = files.join("\n").toLowerCase();
  ["swipe ke atas", "tarik ke atas", "tarik bagian yang disorot"].forEach((phrase) => {
    assert.equal(combined.includes(phrase), false, `${phrase} masih tampil`);
  });
  assert.ok(combined.includes("data-swipe-handle") || combined.includes("pointerdown"), "gesture swipe ikut terhapus");
});

await check("chat has natural opening, internal cancellation, and busy lock", async () => {
  const main = await read("src/main.ts");
  const style = await read("src/style.css");
  assert.match(main, /Saya siap membantu\. Tanyakan kondisi ITS Maps/);
  assert.doesNotMatch(main, /data-ai-chat-cancel/);
  assert.match(main, /AbortController/);
  assert.match(style, /\.its-ai-chat-form\.is-busy input/);
  assert.match(style, /cursor: not-allowed/);
});

process.stdout.write(`\n${checks.length} acceptance checks passed.\n`);
