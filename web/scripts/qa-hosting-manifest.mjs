import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDir, "..");
const distRoot = path.join(webRoot, "dist");
const manifestPath = path.join(distRoot, "data", "map-dynamics", "manifest.json");
const requiredShards = new Set([
  "10-817-531.1.17ad6645ba32.geojson",
  "10-818-531.1.ea377585be5f.geojson",
  "10-818-531.2.2225d51bf105.geojson",
  "10-818-532.1.d850b704d080.geojson",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(filePath) {
  const bytes = await fs.readFile(filePath);
  assert(bytes.byteLength > 0, `${filePath} kosong`);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

const { value: manifest } = await readJson(manifestPath);
assert(manifest?.schemaVersion === "1.0", "schemaVersion manifest harus 1.0");
assert(Array.isArray(manifest.shards) && manifest.shards.length > 0, "manifest tidak memiliki shard");

const seenIds = new Set();
const seenUrls = new Set();
let externalCount = 0;
const externalFiles = [];
for (const shard of manifest.shards) {
  assert(shard && typeof shard === "object", "entri shard bukan objek");
  assert(typeof shard.id === "string" && shard.id, "shard tanpa id");
  assert(typeof shard.url === "string" && shard.url, `shard ${shard.id} tanpa URL`);
  assert(!seenIds.has(shard.id), `id shard duplikat: ${shard.id}`);
  assert(!seenUrls.has(shard.url), `URL shard duplikat: ${shard.url}`);
  seenIds.add(shard.id);
  seenUrls.add(shard.url);

  const fileName = path.posix.basename(shard.url.replaceAll("\\", "/"));
  let payload;
  if (/^https:\/\//i.test(shard.url)) {
    externalCount += 1;
    externalFiles.push(shard.url.includes("/map-hotspots/")
      ? `web/public/data/map-hotspots/${fileName}`
      : `web/public/data/map-dynamics/shards/${fileName}`);
    // The build keeps a local mirror for deterministic integrity checks, while
    // Firebase excludes the heavy mirror and serves the rewritten GitHub URL.
    const localDirectory = shard.url.includes("/map-hotspots/")
      ? path.join(distRoot, "data", "map-hotspots")
      : path.join(distRoot, "data", "map-dynamics", "shards");
    payload = await readJson(path.join(localDirectory, fileName));
  } else {
    const resolved = path.resolve(path.dirname(manifestPath), shard.url);
    assert(resolved.startsWith(distRoot + path.sep), `path shard keluar dari dist: ${shard.url}`);
    payload = await readJson(resolved);
  }
  assert(payload.value?.type === "FeatureCollection", `${fileName} bukan FeatureCollection`);
  assert(Array.isArray(payload.value.features), `${fileName} tidak memiliki features`);
  if (Number.isFinite(shard.bytes)) {
    assert(payload.bytes.byteLength === shard.bytes, `${fileName} bytes ${payload.bytes.byteLength} != manifest ${shard.bytes}`);
  }
  if (typeof shard.sha256 === "string" && shard.sha256) {
    assert(sha256(payload.bytes) === shard.sha256, `${fileName} sha256 tidak sesuai`);
  }
  if (requiredShards.has(fileName) && /^https:\/\//i.test(shard.url)) {
    const response = await fetch(shard.url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    assert(response.ok, `${shard.url} merespons HTTP ${response.status}`);
  }
  requiredShards.delete(fileName);
}

assert(requiredShards.size === 0, `empat shard regresi tidak ditemukan: ${[...requiredShards].join(", ")}`);
const revision = String(manifest?.hosting?.revision || "");
assert(/^[a-f0-9]{40}$/.test(revision), "revision distribusi harus SHA Git immutable");
const repositoryRoot = path.resolve(webRoot, "..");
const committedFiles = new Set(execFileSync(
  "git",
  ["ls-tree", "-r", "--name-only", revision, "--", "web/public/data/map-dynamics/shards", "web/public/data/map-hotspots"],
  { cwd: repositoryRoot, encoding: "utf8" },
).split(/\r?\n/).filter(Boolean));
const missingFromRevision = externalFiles.filter((file) => !committedFiles.has(file));
assert(missingFromRevision.length === 0, `${missingFromRevision.length} shard tidak ada pada revision ${revision}: ${missingFromRevision.slice(0, 8).join(", ")}`);
await fs.access(path.join(distRoot, "index.html"));
console.log(`qa-hosting-manifest: OK ${manifest.shards.length} shard (${externalCount} eksternal), termasuk empat shard regresi.`);
