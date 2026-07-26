import type {
  GeoJSONSource,
  LayerSpecification,
  Map as MapLibreMap,
  StyleSpecification,
} from "maplibre-gl";

import type {
  LngLat,
  NavigationRoute,
  SceneCollections,
} from "./types";

const EMPTY_COLLECTION: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

const NATIONAL_PM_TILES =
  "pmtiles://https://its.hanifahseptiani45.workers.dev/v1/map/archive/indonesia.pmtiles";

const SOURCE_IDS = [
  "nav-roads",
  "nav-sidewalks",
  "nav-medians",
  "nav-bridges",
  "nav-footbridges",
  "nav-tunnels",
  "nav-markings",
  "nav-waterways",
  "nav-greens",
  "nav-buildings",
  "nav-symbols",
  "nav-route",
  "nav-traveled",
] as const;

const LAYER_IDS = [
  "nav-greens",
  "nav-water-polygons",
  "nav-water-lines",
  "nav-buildings",
  "nav-tunnels",
  "nav-road-shadow",
  "nav-roads",
  "nav-sidewalks",
  "nav-medians",
  "nav-bridge-shadow",
  "nav-bridges",
  "nav-footbridges",
  "nav-markings",
  "nav-route-shadow",
  "nav-active-route",
  "nav-traveled",
  "nav-point-symbols",
  "nav-point-symbol-labels",
] as const;

export function navigationStyle(options: { includeNationalBuildings?: boolean } = {}): StyleSpecification {
  const style: StyleSpecification = {
    version: 8,
    name: "ITS Maps Lane-Level Navigation",
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    light: {
      anchor: "viewport",
      color: "#fff8ec",
      intensity: 0.58,
      position: [1.15, 205, 34],
    },
    sky: {
      "sky-color": "#79c9ee",
      "horizon-color": "#e8f5f8",
      "fog-color": "#dceced",
      "sky-horizon-blend": 0.58,
      "horizon-fog-blend": 0.28,
      "fog-ground-blend": 0.18,
      "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 14, 0.75, 20, 0.28, 22, 0.12],
    },
    sources: {
      "its-national": {
        type: "vector",
        url: NATIONAL_PM_TILES,
        attribution: "ITS Maps · © OpenStreetMap contributors · OpenMapTiles",
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#f3f8f3", "background-opacity": 1 },
      },
      {
        id: "its-national-landcover",
        type: "fill",
        source: "its-national",
        "source-layer": "landcover",
        paint: {
          "fill-color": ["match", ["get", "class"], "wood", "#b7dcae", "grass", "#c9e5bd", "#dcebd5"],
          "fill-opacity": 0.72,
        },
      },
      {
        id: "its-national-water",
        type: "fill",
        source: "its-national",
        "source-layer": "water",
        paint: { "fill-color": "#86cde5", "fill-opacity": 0.96 },
      },
      {
        id: "its-national-waterway",
        type: "line",
        source: "its-national",
        "source-layer": "waterway",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#69bfdd", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 18, 8] },
      },
      {
        id: "its-national-roads-casing",
        type: "line",
        source: "its-national",
        "source-layer": "transportation",
        filter: ["!=", ["get", "class"], "rail"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#f7fafb",
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 15, ["match", ["get", "class"], "motorway", 13, "trunk", 12, "primary", 11, "secondary", 9, 6], 20, ["match", ["get", "class"], "motorway", 70, "trunk", 64, "primary", 58, "secondary", 48, 30]],
        },
      },
      {
        id: "its-national-roads",
        type: "line",
        source: "its-national",
        "source-layer": "transportation",
        filter: ["!=", ["get", "class"], "rail"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["match", ["get", "class"], "motorway", "#2d3c4f", "trunk", "#344456", "primary", "#39495b", "secondary", "#435163", "path", "#d9e1e3", "#53606d"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 15, ["match", ["get", "class"], "motorway", 10, "trunk", 9, "primary", 8, "secondary", 6, 3], 20, ["match", ["get", "class"], "motorway", 62, "trunk", 56, "primary", 50, "secondary", 40, 24]],
        },
      },
      {
        id: "its-national-lane-markings",
        type: "line",
        source: "its-national",
        "source-layer": "transportation",
        minzoom: 16,
        filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary", "secondary", "tertiary"]]],
        layout: { "line-cap": "butt", "line-join": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-width": ["interpolate", ["linear"], ["zoom"], 16, 0.55, 19, 1.4, 22, 2.6],
          "line-dasharray": [3, 5],
          "line-opacity": 0.92,
        },
      },
      {
        id: "its-national-direction-arrows",
        type: "symbol",
        source: "its-national",
        "source-layer": "transportation",
        minzoom: 17,
        filter: ["all",
          ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary", "secondary"]]],
          ["in", ["to-string", ["coalesce", ["get", "oneway"], ""]], ["literal", ["1", "true", "yes"]]],
        ],
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 150,
          "text-field": "➤",
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 17, 10, 21, 17],
          "text-rotation-alignment": "map",
          "text-pitch-alignment": "map",
          "text-keep-upright": false,
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#dbeafe",
          "text-halo-color": "#334155",
          "text-halo-width": 1,
        },
      },
      {
        id: "its-national-rail",
        type: "line",
        source: "its-national",
        "source-layer": "transportation",
        filter: ["==", ["get", "class"], "rail"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#7064c5", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 18, 5], "line-dasharray": [2, 1.4] },
      },
      {
        id: "its-national-rail-sleepers",
        type: "line",
        source: "its-national",
        "source-layer": "transportation",
        minzoom: 14,
        filter: ["==", ["get", "class"], "rail"],
        layout: { "line-cap": "butt", "line-join": "round" },
        paint: {
          "line-color": "#f8fafc",
          "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.8, 18, 2.2, 21, 4],
          "line-dasharray": [0.5, 2.2],
          "line-opacity": 0.96,
        },
      },
      {
        id: "its-national-buildings",
        type: "fill-extrusion",
        source: "its-national",
        "source-layer": "building",
        minzoom: 13,
        paint: {
          "fill-extrusion-color": [
            "interpolate",
            ["linear"],
            ["to-number", ["coalesce", ["get", "render_height"], ["get", "height"], 8], 8],
            0, "#f1e8d8",
            18, "#e8d8c0",
            55, "#d9c5ae",
            120, "#c9b4a4",
            300, "#b9a89f",
          ],
          "fill-extrusion-base": ["to-number", ["coalesce", ["get", "render_min_height"], ["get", "min_height"], 0], 0],
          "fill-extrusion-height": ["max", 3, ["to-number", ["coalesce", ["get", "render_height"], ["get", "height"], 8], 8]],
          "fill-extrusion-opacity": 0.93,
          "fill-extrusion-vertical-gradient": true,
        },
      },
      {
        id: "its-national-poi-dots",
        type: "circle",
        source: "its-national",
        "source-layer": "poi",
        minzoom: 14,
        filter: ["==", ["get", "class"], "__its_custom_poi_only__"],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 2.5, 18, 5],
          "circle-color": ["match", ["get", "class"], "hospital", "#d9363e", "school", "#d59b28", "college", "#d59b28", "bus", "#c74747", "railway", "#7064c5", "#3185b5"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
        },
      },
      {
        id: "its-national-poi-labels",
        type: "symbol",
        source: "its-national",
        "source-layer": "poi",
        minzoom: 15,
        layout: {
          "text-field": ["coalesce", ["get", "name:id"], ["get", "name"]],
          "text-size": ["interpolate", ["linear"], ["zoom"], 15, 10, 18, 12],
          "text-font": ["Noto Sans Regular"],
          "text-offset": [0, 1.1],
          "text-anchor": "top",
          "text-max-width": 11,
          "text-allow-overlap": false,
          "text-ignore-placement": false,
          "text-optional": true,
          "text-padding": 8,
          "symbol-sort-key": ["coalesce", ["get", "rank"], 99],
        },
        paint: { "text-color": "#243747", "text-halo-color": "rgba(255,255,255,.96)", "text-halo-width": 1.6 },
      },
      {
        id: "its-national-road-labels",
        type: "symbol",
        source: "its-national",
        "source-layer": "transportation_name",
        filter: ["!=", ["get", "class"], "rail"],
        minzoom: 12,
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 900,
          "text-field": ["coalesce", ["get", "name:id"], ["get", "name"], ["get", "ref"]],
          "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10, 18, 14],
          "text-font": ["Noto Sans Regular"],
          "text-max-angle": 35,
          "text-padding": 8,
          "text-rotation-alignment": "map",
          "text-pitch-alignment": "map",
        },
        paint: { "text-color": "#334155", "text-halo-color": "rgba(247,251,252,.92)", "text-halo-width": 1.5 },
      },
      {
        id: "its-national-rail-labels",
        type: "symbol",
        source: "its-national",
        "source-layer": "transportation_name",
        filter: ["==", ["get", "class"], "rail"],
        minzoom: 12,
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 1000,
          "text-field": ["coalesce", ["get", "name:id"], ["get", "name"], ["get", "ref"]],
          "text-size": 11,
          "text-font": ["Noto Sans Regular"],
          "text-max-angle": 28,
          "text-padding": 12,
          "text-rotation-alignment": "map",
          "text-pitch-alignment": "map",
        },
        paint: { "text-color": "#5f55b3", "text-halo-color": "rgba(250,250,255,.94)", "text-halo-width": 1.5 },
      },
      {
        id: "its-national-water-labels",
        type: "symbol",
        source: "its-national",
        "source-layer": "water_name",
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 520,
          "text-field": ["coalesce", ["get", "name:id"], ["get", "name"]],
          "text-size": 12,
          "text-font": ["Noto Sans Italic"],
          "text-padding": 10,
        },
        paint: { "text-color": "#277b9c", "text-halo-color": "rgba(239,249,252,.9)", "text-halo-width": 1.5 },
      },
    ],
  };
  if (options.includeNationalBuildings === false) {
    style.layers = style.layers.filter((layer) => layer.id !== "its-national-buildings");
  }
  return style;
}

function ensureSource(map: MapLibreMap, id: string): void {
  if (map.getSource(id)) return;
  map.addSource(id, {
    type: "geojson",
    data: EMPTY_COLLECTION,
  });
}

function addLayer(map: MapLibreMap, layer: LayerSpecification): void {
  if (!map.getLayer(layer.id)) map.addLayer(layer);
}

function layerSpecifications(): LayerSpecification[] {
  return [
    {
      id: "nav-greens",
      type: "fill-extrusion",
      source: "nav-greens",
      paint: {
        "fill-extrusion-color": "#a9d69d",
        "fill-extrusion-base": 0,
        "fill-extrusion-height": 0.12,
        "fill-extrusion-opacity": 0.94,
      },
    },
    {
      id: "nav-water-polygons",
      type: "fill",
      source: "nav-waterways",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": "#8fcfe5", "fill-opacity": 0.94 },
    },
    {
      id: "nav-water-lines",
      type: "line",
      source: "nav-waterways",
      filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#58b5d5",
        "line-width": ["interpolate", ["linear"], ["zoom"], 14, 1.25, 18, 4, 21, 9],
      },
    },
    {
      id: "nav-buildings",
      type: "fill-extrusion",
      source: "nav-buildings",
      minzoom: 14,
      paint: {
        "fill-extrusion-color": [
          "interpolate",
          ["linear"],
          ["coalesce", ["get", "height"], 9],
          0,
          "#d8e8ef",
          30,
          "#dfeef3",
            100,
            "#eaf4f7",
        ],
        "fill-extrusion-base": ["coalesce", ["get", "baseHeight"], 0],
        "fill-extrusion-height": ["interpolate", ["linear"], ["coalesce", ["get", "height"], 9], 0, 2.8, 35, 19, 100, 34, 300, 52],
        "fill-extrusion-opacity": 0.42,
        "fill-extrusion-vertical-gradient": true,
      },
    },
    {
      id: "nav-tunnels",
      type: "line",
      source: "nav-tunnels",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#263441",
        "line-width": ["interpolate", ["linear"], ["zoom"], 14, 3, 16, 7, 21, 28],
        "line-opacity": 0.52,
        "line-dasharray": [2, 1.3],
      },
    },
    {
      id: "nav-road-shadow",
      type: "fill",
      source: "nav-roads",
      paint: {
        "fill-color": "#15222e",
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0.08, 17, 0.22],
        "fill-translate": [0, 3],
      },
    },
    {
      id: "nav-roads",
      type: "fill-extrusion",
      source: "nav-roads",
      paint: {
        "fill-extrusion-color": [
          "match",
          ["get", "surfaceRole"],
          "bus",
          "#a94f57",
          "cycle",
          "#35a774",
          "pedestrian",
          "#dfe5e8",
          [
            "match",
            ["get", "roadClass"],
            "motorway",
            "#2f3f52",
            "trunk",
            "#354659",
            "primary",
            "#3a4a5d",
            "secondary",
            "#425164",
            "residential",
            "#4d5a6b",
            "#465465",
          ],
        ],
        "fill-extrusion-base": 0,
        "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 14, 0.08, 18, 0.18],
        "fill-extrusion-opacity": 1,
        "fill-extrusion-vertical-gradient": false,
      },
    },
    {
      id: "nav-sidewalks",
      type: "fill-extrusion",
      source: "nav-sidewalks",
      minzoom: 15,
      paint: {
        "fill-extrusion-color": "#e2e8e9",
        "fill-extrusion-base": 0.08,
        "fill-extrusion-height": 0.24,
        "fill-extrusion-opacity": 1,
      },
    },
    {
      id: "nav-medians",
      type: "fill-extrusion",
      source: "nav-medians",
      minzoom: 14.5,
      paint: {
        "fill-extrusion-color": [
          "match",
          ["get", "medianType"],
          "garden",
          "#94ca8d",
          "water",
          "#8fcfe5",
          "#d3dadd",
        ],
        "fill-extrusion-base": 0.1,
        "fill-extrusion-height": [
          "match",
          ["get", "medianType"],
          "garden",
          0.42,
          "water",
          0.12,
          0.28,
        ],
        "fill-extrusion-opacity": 0.98,
      },
    },
    {
      id: "nav-bridge-shadow",
      type: "fill",
      source: "nav-bridges",
      paint: { "fill-color": "#142230", "fill-opacity": 0.38, "fill-translate": [0, 9] },
    },
    {
      id: "nav-bridges",
      type: "fill-extrusion",
      source: "nav-bridges",
      paint: {
        "fill-extrusion-color": "#465568",
        "fill-extrusion-base": ["coalesce", ["get", "baseHeight"], 5],
        "fill-extrusion-height": ["coalesce", ["get", "deckHeight"], 5.72],
        "fill-extrusion-opacity": 1,
      },
    },
    {
      id: "nav-footbridges",
      type: "fill-extrusion",
      source: "nav-footbridges",
      paint: {
        "fill-extrusion-color": "#aeb8c0",
        "fill-extrusion-base": ["coalesce", ["get", "baseHeight"], 5],
        "fill-extrusion-height": ["coalesce", ["get", "deckHeight"], 5.4],
        "fill-extrusion-opacity": 0.98,
      },
    },
    {
      id: "nav-markings",
      type: "line",
      source: "nav-markings",
      minzoom: 15.5,
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": ["match", ["get", "color"], "yellow", "#f3c84b", "#ffffff"],
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          15.5,
          ["case", ["==", ["get", "markingType"], "crossing"], 1.2, 0.6],
          19,
          ["case", ["==", ["get", "markingType"], "crossing"], 4.2, 1.4],
          22,
          ["case", ["==", ["get", "markingType"], "crossing"], 7, 3],
        ],
        "line-dasharray": [
          "case",
          ["==", ["get", "pattern"], "dashed"],
          ["literal", [3, 4]],
          ["literal", [1, 0]],
        ],
        "line-opacity": 0.97,
      },
    },
    {
      id: "nav-route-shadow",
      type: "line",
      source: "nav-route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#075466",
        "line-width": ["interpolate", ["linear"], ["zoom"], 14, 8, 18, 22, 21, 38],
        "line-opacity": 0.72,
        "line-blur": 2,
        "line-translate": [0, 4],
      },
    },
    {
      id: "nav-active-route",
      type: "line",
      source: "nav-route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": [
          "match",
          ["get", "traffic"],
          "heavy",
          "#e25454",
          "medium",
          "#e4a13f",
          "#18b98c",
        ],
        "line-width": ["interpolate", ["linear"], ["zoom"], 14, 5, 18, 16, 21, 30],
        "line-opacity": 0.97,
      },
    },
    {
      id: "nav-traveled",
      type: "line",
      source: "nav-traveled",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#8fa3ad",
        "line-width": ["interpolate", ["linear"], ["zoom"], 14, 3, 21, 20],
        "line-opacity": 0.58,
      },
    },
    {
      id: "nav-point-symbols",
      type: "circle",
      source: "nav-symbols",
      minzoom: 15,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 15, 3, 20, 7],
        "circle-color": [
          "match",
          ["get", "kind"],
          "traffic-signal",
          "#17202a",
          "cctv",
          "#0a8eaa",
          "etle",
          "#d54149",
          "speed-camera",
          "#d54149",
          "crossing",
          "#ffffff",
          "bus-stop",
          "#bf4f56",
          "hydrant",
          "#d83743",
          "#758691",
        ],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
      },
    },
    {
      id: "nav-point-symbol-labels",
      type: "symbol",
      source: "nav-symbols",
      minzoom: 15,
      layout: {
        "text-field": ["match", ["get", "kind"], "crossing", "⇄", "cctv", "▣", "etle", "▣", "speed-camera", "◉", "bus-stop", "H", "traffic-signal", "●", "footbridge", "↟", "•"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 15, 10, 20, 16],
        "text-font": ["Noto Sans Bold"],
        "text-allow-overlap": false,
        "text-ignore-placement": false,
        "text-padding": 4,
      },
      paint: { "text-color": "#ffffff", "text-halo-color": "#173042", "text-halo-width": 1 },
    },
  ];
}

/** Installs only the custom navigation sources and layers on the current style. */
export function installNavigationLayers(map: MapLibreMap): void {
  for (const sourceId of SOURCE_IDS) ensureSource(map, sourceId);
  for (const layer of layerSpecifications()) addLayer(map, layer);
}

function setSourceData(
  map: MapLibreMap,
  sourceId: string,
  data: GeoJSON.FeatureCollection | GeoJSON.Feature,
): void {
  const source = map.getSource(sourceId) as GeoJSONSource | undefined;
  source?.setData(data);
}

export function setScene(map: MapLibreMap, scene: SceneCollections): void {
  setSourceData(map, "nav-roads", scene.roads);
  setSourceData(map, "nav-sidewalks", scene.sidewalks);
  setSourceData(map, "nav-medians", scene.medians);
  setSourceData(map, "nav-bridges", scene.bridges);
  setSourceData(map, "nav-footbridges", scene.footbridges);
  setSourceData(map, "nav-tunnels", scene.tunnels);
  setSourceData(map, "nav-markings", scene.markings);
  setSourceData(map, "nav-waterways", scene.waterways);
  setSourceData(map, "nav-greens", scene.greens);
  setSourceData(map, "nav-buildings", scene.buildings);
  setSourceData(map, "nav-symbols", scene.pointSymbols);
}

export function setRoute(map: MapLibreMap, route: NavigationRoute): void {
  setSourceData(map, "nav-route", route.geometry);
}

export function setTraveledRoute(map: MapLibreMap, coordinates: LngLat[]): void {
  setSourceData(
    map,
    "nav-traveled",
    coordinates.length >= 2
      ? {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates },
        }
      : EMPTY_COLLECTION,
  );
}

/**
 * Stateful facade used by the navigation controller. It survives a delayed style
 * load and reapplies the most recent scene, route, and traveled path afterwards.
 */
export class NavigationLayers {
  private readonly map: MapLibreMap;
  private installed = false;
  private waitingForStyle = false;
  private scene: SceneCollections | null = null;
  private route: NavigationRoute | null = null;
  private traveled: LngLat[] = [];

  constructor(map: MapLibreMap) {
    this.map = map;
  }

  private readonly handleStyleLoad = (): void => {
    this.waitingForStyle = false;
    this.installNow();
  };

  private installNow(): void {
    if (!this.map.isStyleLoaded()) {
      this.install();
      return;
    }
    installNavigationLayers(this.map);
    this.installed = true;
    if (this.scene) setScene(this.map, this.scene);
    if (this.route) setRoute(this.map, this.route);
    setTraveledRoute(this.map, this.traveled);
  }

  install(): void {
    if (this.map.isStyleLoaded()) {
      this.installNow();
      return;
    }
    if (!this.waitingForStyle) {
      this.waitingForStyle = true;
      this.map.once("style.load", this.handleStyleLoad);
    }
  }

  setScene(scene: SceneCollections): void {
    this.scene = scene;
    if (!this.installed || !this.map.getSource("nav-roads")) this.install();
    else setScene(this.map, scene);
  }

  setRoute(route: NavigationRoute): void {
    this.route = route;
    if (!this.installed || !this.map.getSource("nav-route")) this.install();
    else setRoute(this.map, route);
  }

  setTraveledRoute(coordinates: LngLat[]): void {
    this.traveled = coordinates.slice();
    if (!this.installed || !this.map.getSource("nav-traveled")) this.install();
    else setTraveledRoute(this.map, this.traveled);
  }

  clear(): void {
    this.scene = null;
    this.route = null;
    this.traveled = [];
    if (!this.map.getSource("nav-roads")) return;
    for (const sourceId of SOURCE_IDS) setSourceData(this.map, sourceId, EMPTY_COLLECTION);
  }

  destroy(): void {
    if (this.waitingForStyle) {
      this.map.off("style.load", this.handleStyleLoad);
      this.waitingForStyle = false;
    }
    if (this.map.getStyle()) {
      for (const layerId of [...LAYER_IDS].reverse()) {
        if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
      }
      for (const sourceId of [...SOURCE_IDS].reverse()) {
        if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
      }
    }
    this.installed = false;
    this.scene = null;
    this.route = null;
    this.traveled = [];
  }
}
