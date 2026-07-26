const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
const controller = read("src/navigation3d/Navigation3D.ts");
const bootstrap = read("src/navigation3d/bootstrap.ts");
const styles = read("src/navigation3d/navigation3d.css");
const services = read("src/navigation3d/services.ts");
const main = read("src/main.ts");

const checks = [
  ["WebMCP form annotation", /toolname="search_its_maps_navigation_route"/.test(controller)],
  ["WebMCP destination parameter", /toolparamdescription="Destination name/.test(controller)],
  ["semantic route form", /data-nav3d-search-form/.test(controller) && /type="search"/.test(controller)],
  ["mode radio group", /<fieldset class="nav3d-modes">/.test(controller) && /type="radio"/.test(controller)],
  ["accessible combobox", /role="combobox"/.test(controller) && /aria-controls="its-nav3d-results"/.test(controller)],
  ["search results listbox", /role="listbox"/.test(controller) && /role="option"/.test(controller)],
  ["keyboard result navigation", /event\.key === "ArrowDown"/.test(controller) && /event\.key === "ArrowUp"/.test(controller)],
  ["live search status", /data-nav3d-search-status role="status" aria-live="polite"/.test(controller)],
  ["navigation progress semantics", /role="progressbar"/.test(controller) && /aria-valuenow/.test(controller)],
  ["explicit simulation", /Uji simulasi/.test(controller) && !/startLocationWatch[\s\S]{0,500}startSimulation\(\)/.test(controller)],
  ["scene module integration", /buildNavigationScene/.test(controller) && /installNavigationLayers/.test(controller)],
  ["mode-specific avatar", /setAvatarMode\(this\.mode\)/.test(controller)],
  ["stale search cancellation", /this\.searchAbort\?\.abort\(\)/.test(controller)],
  ["stale route cancellation", /this\.routeAbort\?\.abort\(\)/.test(controller)],
  ["minimum 48px controls", /min-height:\s*48px/.test(styles) && /min-width:\s*48px/.test(styles)],
  ["visible keyboard focus", /:focus-visible/.test(styles)],
  ["non-yellow navigation focus", !/outline:\s*3px\s+solid\s+#f7b731/i.test(styles)],
  ["blue endpoint focus treatment", /--nav3d-focus:\s*#0b6fc8/i.test(styles) && /nav3d-endpoint:has\(input:focus-visible\)[\s\S]{0,220}var\(--nav3d-focus\)/i.test(styles)],
  ["desktop mode row without forced scrolling", /grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/.test(styles)],
  ["reduced motion support", /prefers-reduced-motion/.test(styles)],
  ["imperative WebMCP tool", /open_its_maps_3d_navigation/.test(bootstrap)],
  ["validated external payloads", /function asRecord\(value: unknown\)/.test(services)],
  ["Photon never sends unsupported Indonesian lang parameter", !/url\.searchParams\.set\("lang",\s*"id"\)/.test(services)],
  ["Nominatim geocoder fallback", /VITE_NOMINATIM_URL/.test(services) && /for \(const provider of \[searchPhoton, searchNominatim\]\)/.test(services)],
  ["loaded ITS POI search fallback", /localPlaceMatches\(query, origin\)/.test(controller) && /mergePlaceResults\(localPlaces, remotePlaces\)/.test(controller)],
  ["location starts when route panel opens", /resolveOrigin\(!this\.originFromDevice\)/.test(controller)],
  ["location fallback is labelled as map/default", /Titik peta \(GPS perangkat belum diizinkan\)/.test(controller) && /Titik awal bawaan \(GPS perangkat belum diizinkan\)/.test(controller)],
  ["shareable route URL state", /params\.set\("nav", stage\)/.test(controller) && /params\.set\("toLat"/.test(controller) && /restoreNavigationUrlState/.test(controller)],
  ["dynamic map URL state", /params\.set\("lat", center\.lat\.toFixed\(6\)\)/.test(main) && /params\.set\("z"/.test(main) && /params\.set\("bearing"/.test(main) && /params\.set\("mode", state\.baseMode\)/.test(main)],
  ["CARTO base untouched", !/carto|basemaps\.cartocdn/i.test([controller, bootstrap, styles, services].join("\n"))],
];

for (const [name, passed] of checks) assert.equal(passed, true, `FAILED: ${name}`);

console.log(
  JSON.stringify(
    {
      status: "pass",
      checks: checks.length,
      accessibility: {
        touchTargetMinimumPx: 48,
        keyboardCombobox: true,
        webMcpAnnotated: true,
        liveRegions: true,
        reducedMotion: true,
      },
      cartoBaseModified: false,
    },
    null,
    2,
  ),
);
