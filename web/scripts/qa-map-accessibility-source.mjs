import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [main, style, renderer, index] = await Promise.all([
  readFile(path.join(root, "src", "main.ts"), "utf8"),
  readFile(path.join(root, "src", "style.css"), "utf8"),
  readFile(path.join(root, "src", "map-detail", "MapDynamicsLeafletRenderer.ts"), "utf8"),
  readFile(path.join(root, "index.html"), "utf8"),
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const nextFunction = nextName ? source.indexOf(`function ${nextName}`, start + 1) : -1;
  const end = nextName
    ? (nextFunction >= 0 ? nextFunction : source.indexOf(nextName, start + 1))
    : source.length;
  assert(start >= 0 && end > start, `Unable to inspect ${name}.`);
  return source.slice(start, end);
}

const poiIcon = functionSource(main, "makePoiIcon", "renderPoiModal");
const poiCluster = functionSource(main, "makePoiClusterIcon", "poiCollisionGridSize");
const crossing = functionSource(main, "makeRailCrossingIcon", "makeWaterNameIcon");
const signal = functionSource(main, "makeTrafficSignalGuideIcon", "makeTreeGuideIcon");
const tree = functionSource(main, "makeTreeGuideIcon", "makeSchoolZoneGuideIcon");
const school = functionSource(main, "makeSchoolZoneGuideIcon", "transitGuideCasingStyle");
const ornament = functionSource(main, "makeOrnamentIcon", "ornamentLineStyle");
const modeUpdate = functionSource(main, "updateModeControlButtons", "syncModeControlVisibility");

assert(/Math\.max\(48,/.test(poiIcon), "POI hit area must be at least 48 px.");
for (const [name, source] of Object.entries({ poiCluster, crossing, signal, tree, ornament })) {
  assert(/iconSize:\s*\[(?:48|5[0-9]|[6-9][0-9]),\s*(?:48|5[0-9]|[6-9][0-9])\]/.test(source), `${name} marker must use at least a 48x48 hit area.`);
}
assert(/iconSize:\s*\[112,\s*48\]/.test(school), "School marker must be at least 48 px high.");
assert(/aria-label=/.test(crossing) && /role="img"/.test(crossing), "Crossings need an accessible image name.");
assert(/aria-label=/.test(school) && /role="img"/.test(school), "School guides need an accessible image name.");
assert(/aria-label=/.test(ornament) && /role="img"/.test(ornament), "Ornaments need an accessible image name.");
assert(/aria-pressed="false"/.test(main) && /setAttribute\("aria-pressed"/.test(modeUpdate), "Map mode buttons need a synchronized pressed state.");

for (const selector of [".map-license-link", ".mode-control .mode-btn", ".poi-marker-icon", ".map-dynamics-point-icon"]) {
  const offset = style.indexOf(selector);
  assert(offset >= 0, `Missing accessibility style for ${selector}.`);
  const block = style.slice(offset, style.indexOf("}", offset) + 1);
  const width = Number(block.match(/min-width:\s*(\d+)px/)?.[1] || 0);
  const height = Number(block.match(/min-height:\s*(\d+)px/)?.[1] || 0);
  assert(width >= 48 && height >= 48, `${selector} lacks a 48x48 px minimum hit area.`);
}
assert(/\.mode-control \.mode-btn:focus-visible/.test(style), "Mode buttons need a visible keyboard focus indicator.");
assert(/\.map-license-link:focus-visible[\s\S]{0,180}outline:\s*3px/.test(style), "Map licence action needs a visible keyboard focus indicator.");
assert(/\.road-guide-name-icon,[\s\S]{0,260}\.transit-guide-name-icon[\s\S]{0,180}pointer-events:\s*none\s*!important/.test(style), "Visual-only road/transit labels must not become tiny touch targets.");

for (const rendererBlock of [
  functionSource(renderer, "pointSymbol", "stableFeatureKey"),
  functionSource(renderer, "pointClusterSymbol", "export class MapDynamicsLeafletRenderer"),
]) {
  assert(/iconSize:\s*\[48,\s*48\]/.test(rendererBlock), "JSON map markers must expose a 48x48 hit area.");
}

assert(!/cn2tw_1\.json|tw2cn_1\.json/i.test(`${main}\n${index}`), "ITS Maps must not request browser-extension Chinese dictionaries.");

process.stdout.write("Map accessibility source QA passed: 48px targets, accessible names/states, focus rings, decorative-label semantics, no extension dictionaries.\n");
