import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import ts from "typescript";

const projectRoot = resolve(import.meta.dirname, "..");

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
      verbatimModuleSyntax: true,
    },
  }).outputText;
}

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

const servicesSource = (
  await readFile(join(projectRoot, "src/navigation3d/services.ts"), "utf8")
).replaceAll("import.meta.env", "({})");
const servicesUrl = moduleUrl(transpile(servicesSource));
const servicesModule = await import(servicesUrl);
const sceneSource = await readFile(
  join(projectRoot, "src/navigation3d/sceneBuilder.ts"),
  "utf8",
);
const sceneOutput = transpile(sceneSource).replace(
  /from\s+["']\.\/services["']/,
  `from ${JSON.stringify(servicesUrl)}`,
);
const layersSource = await readFile(
  join(projectRoot, "src/navigation3d/NavigationLayers.ts"),
  "utf8",
);
const sceneModule = await import(moduleUrl(sceneOutput));
const layersModule = await import(moduleUrl(transpile(layersSource)));

  const fixture = {
    elements: [
      { type: "node", id: 1, lon: 107.63, lat: -6.98 },
      {
        type: "node",
        id: 2,
        lon: 107.631,
        lat: -6.98,
        tags: { highway: "crossing", crossing: "marked" },
      },
      { type: "node", id: 3, lon: 107.632, lat: -6.98 },
      {
        type: "way",
        id: 10,
        nodes: [1, 2, 3],
        tags: {
          highway: "primary",
          name: "Jalan Uji",
          lanes: "4",
          width: "14 m",
          sidewalk: "both",
          lit: "yes",
          tree_lined: "yes",
        },
      },
      { type: "node", id: 11, lon: 107.6302, lat: -6.9798 },
      { type: "node", id: 12, lon: 107.6304, lat: -6.9798 },
      { type: "node", id: 13, lon: 107.6304, lat: -6.9796 },
      { type: "node", id: 14, lon: 107.6302, lat: -6.9796 },
      {
        type: "way",
        id: 20,
        nodes: [11, 12, 13, 14, 11],
        tags: { building: "yes", "building:levels": "3", name: "Gedung Uji" },
      },
      // An open land-use way must not be closed across missing Overpass data.
      {
        type: "way",
        id: 30,
        nodes: [11, 12, 13],
        tags: { landuse: "grass" },
      },
    ],
  };

  const scene = sceneModule.buildNavigationScene(fixture, 80);
  assert.equal(scene.roads.features.length, 1, "road polygon");
  assert.equal(scene.sidewalks.features.length, 2, "two explicit sidewalks");
  assert.equal(scene.buildings.features.length, 1, "closed building extrusion footprint");
  assert.equal(scene.greens.features.length, 0, "open polygon is not fabricated");
  assert.ok(
    Math.abs(scene.buildings.features[0].properties.height - 9.6) < 0.001,
    "height from levels",
  );
  assert.ok(scene.markings.features.length >= 8, "lanes, edges, and crossing stripes");
  assert.ok(scene.ornaments.some((item) => item.kind === "crossing"), "crossing model");
  assert.ok(scene.ornaments.some((item) => item.kind === "street-light"), "tag-derived lights");

  const crossing = scene.markings.features.find(
    (item) => item.properties?.markingType === "crossing",
  );
  assert.ok(crossing && crossing.geometry.type === "LineString", "crossing line geometry");
  const [crossingStart, crossingEnd] = crossing.geometry.coordinates;
  assert.ok(
    Math.abs(crossingEnd[1] - crossingStart[1]) >
      Math.abs(crossingEnd[0] - crossingStart[0]) * 2,
    "east-west road gets a perpendicular north-south crosswalk",
  );

  // Deterministic corridor fixture around the orientation used by Jalan M.H.
  // Thamrin: a northbound primary road, a real crossing street, a footbridge,
  // tagged signal, adjacent tower and a corrupt footprint across the route.
  // The test guards the geometry rules without depending on live Overpass.
  const thamrinRoute = [
    [106.8228, -6.1912],
    [106.8228, -6.1894],
    [106.82284, -6.1874],
  ];
  const thamrinFixture = {
    elements: [
      { type: "node", id: 1001, lon: 106.8228, lat: -6.1912 },
      {
        type: "node",
        id: 1002,
        lon: 106.8228,
        lat: -6.1894,
        tags: { highway: "traffic_signals", direction: "0" },
      },
      { type: "node", id: 1003, lon: 106.82284, lat: -6.1874 },
      { type: "node", id: 1004, lon: 106.8208, lat: -6.1894 },
      { type: "node", id: 1005, lon: 106.8248, lat: -6.1894 },
      {
        type: "way",
        id: 1100,
        nodes: [1001, 1002, 1003],
        tags: { highway: "primary", name: "Jalan M.H. Thamrin", lanes: "6", width: "21" },
      },
      {
        type: "way",
        id: 1101,
        nodes: [1004, 1002, 1005],
        tags: { highway: "secondary", name: "Jalan Kebon Kacang", lanes: "4", width: "14" },
      },
      { type: "node", id: 1010, lon: 106.8219, lat: -6.1892 },
      { type: "node", id: 1011, lon: 106.8237, lat: -6.1892 },
      {
        type: "way",
        id: 1110,
        nodes: [1010, 1011],
        tags: { highway: "footway", bridge: "yes", layer: "1", name: "JPO Thamrin" },
      },
      // An adjacent building must remain.
      { type: "node", id: 1020, lon: 106.82315, lat: -6.1907 },
      { type: "node", id: 1021, lon: 106.82345, lat: -6.1907 },
      { type: "node", id: 1022, lon: 106.82345, lat: -6.1902 },
      { type: "node", id: 1023, lon: 106.82315, lat: -6.1902 },
      {
        type: "way",
        id: 1120,
        nodes: [1020, 1021, 1022, 1023, 1020],
        tags: { building: "office", height: "54", name: "Gedung Koridor Thamrin" },
      },
      // This intentionally corrupt footprint intersects the snapped route and
      // must not become a solid cube in front of the vehicle.
      { type: "node", id: 1030, lon: 106.82272, lat: -6.19025 },
      { type: "node", id: 1031, lon: 106.82288, lat: -6.19025 },
      { type: "node", id: 1032, lon: 106.82288, lat: -6.18995 },
      { type: "node", id: 1033, lon: 106.82272, lat: -6.18995 },
      {
        type: "way",
        id: 1121,
        nodes: [1030, 1031, 1032, 1033, 1030],
        tags: { building: "yes", height: "80", name: "Footprint konflik" },
      },
      // Simulate the untagged node emitted later by `>; out skel qt;`.
      { type: "node", id: 1002, lon: 106.8228, lat: -6.1894 },
    ],
  };
  const thamrinScene = sceneModule.buildNavigationScene(thamrinFixture, {
    maximumOrnaments: 120,
    focusRoute: thamrinRoute,
    routeClearanceM: 1.35,
  });
  assert.equal(thamrinScene.roads.features.length, 2, "Thamrin junction keeps both real road arms");
  assert.equal(thamrinScene.footbridges.features.length, 1, "tagged JPO is rendered above the road");
  assert.deepEqual(
    thamrinScene.buildings.features.map((item) => item.id),
    [1120],
    "only the route-blocking corrupt extrusion is rejected",
  );
  assert.ok(
    thamrinScene.ornaments.some((item) => item.kind === "traffic-signal"),
    "tagged signal survives a later untagged Overpass skeleton node",
  );
  const northbound = servicesModule.forwardBearingOnRoute(thamrinRoute, 0, 36);
  const southbound = servicesModule.forwardBearingOnRoute([...thamrinRoute].reverse(), 0, 36);
  assert.ok(
    Math.abs(servicesModule.bearingDeltaDegrees(northbound, 0)) < 3,
    "northbound route camera faces north rather than backwards",
  );
  assert.ok(
    Math.abs(servicesModule.bearingDeltaDegrees(southbound, 180)) < 3,
    "reversed route camera follows the reversed route order",
  );

  const empty = sceneModule.buildScene({ elements: [] });
  assert.equal(empty.roads.features.length, 0, "network failure fallback has no invented road");
  assert.equal(empty.ornaments.length, 0, "network failure fallback has no invented ornament");

  class MockGeoJSONSource {
    constructor(definition) { this.definition = definition; }
    data = null;
    setData(data) { this.data = data; }
  }

  class MockMap {
    sources = new Map();
    layers = new Map();
    isStyleLoaded() { return true; }
    getStyle() { return { version: 8, sources: {}, layers: [] }; }
    getSource(id) { return this.sources.get(id); }
    addSource(id, definition) { this.sources.set(id, new MockGeoJSONSource(definition)); }
    removeSource(id) { this.sources.delete(id); }
    getLayer(id) { return this.layers.get(id); }
    addLayer(layer) { this.layers.set(layer.id, layer); }
    removeLayer(id) { this.layers.delete(id); }
    once() {}
    off() {}
  }

  const mockMap = new MockMap();
  const navigationLayers = new layersModule.NavigationLayers(mockMap);
  navigationLayers.install();
  assert.equal(mockMap.sources.size, 13, "all navigation sources installed");
  assert.equal(mockMap.layers.get("nav-roads").type, "fill-extrusion", "3D road deck");
  assert.equal(mockMap.layers.get("nav-buildings").type, "fill-extrusion", "3D buildings");
  assert.equal(mockMap.layers.get("nav-bridges").type, "fill-extrusion", "3D bridges");
  const baseStyle = layersModule.navigationStyle();
  const validationStyle = {
    ...baseStyle,
    sources: {
      ...baseStyle.sources,
      ...Object.fromEntries(
        [...mockMap.sources].map(([id, source]) => [id, source.definition]),
      ),
    },
    layers: [...baseStyle.layers, ...mockMap.layers.values()],
  };
  const styleErrors = validateStyleMin(validationStyle);
  assert.deepEqual(
    styleErrors.map((error) => error.message),
    [],
    "MapLibre style validates",
  );
  navigationLayers.setScene(scene);
  assert.equal(mockMap.sources.get("nav-roads").data.features.length, 1, "scene applied");
  navigationLayers.clear();
  assert.equal(mockMap.sources.get("nav-roads").data.features.length, 0, "scene cleared");
  navigationLayers.destroy();
  assert.equal(mockMap.sources.size, 0, "sources removed");
  assert.equal(mockMap.layers.size, 0, "layers removed");

  const ornamentsSource = await readFile(
    join(projectRoot, "src/navigation3d/ThreeOrnamentsLayer.ts"),
    "utf8",
  );
  for (const expected of [
    "createPedestrian",
    "createBicycle",
    "createVehicle",
    "createTrafficSignal",
    "createBusStop",
    "createBridgePier",
    "meterInMercatorCoordinateUnits",
  ]) {
    assert.ok(ornamentsSource.includes(expected), `procedural renderer includes ${expected}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        roads: scene.roads.features.length,
        sidewalks: scene.sidewalks.features.length,
        markings: scene.markings.features.length,
        ornaments: scene.ornaments.length,
        layers: 17,
        crossingOrientation: "perpendicular",
        thamrin: {
          roads: thamrinScene.roads.features.length,
          buildings: thamrinScene.buildings.features.length,
          footbridges: thamrinScene.footbridges.features.length,
          signals: thamrinScene.ornaments.filter((item) => item.kind === "traffic-signal").length,
          northboundBearing: Number(northbound.toFixed(2)),
        },
        fallback: "empty-scene",
      },
      null,
      2,
    ),
  );
