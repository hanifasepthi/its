export type MapDetailFeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    id?: string;
    properties: Record<string, unknown>;
    geometry: {
      type: "Point" | "LineString" | "Polygon";
      coordinates: unknown;
    };
  }>;
};

export const EMPTY_MAP_DETAIL_COLLECTION: MapDetailFeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

export function detailGroupsForZoom(zoom: number): string[] {
  const groups = ["roads", "railways", "waterways"];
  if (zoom >= 14) groups.push("green-areas", "road-labels");
  if (zoom >= 15) groups.push("pedestrian", "crossings");
  if (zoom >= 16) groups.push("traffic-signals", "medians");
  if (zoom >= 17) groups.push("tree-rows");
  if (zoom >= 18) groups.push("individual-trees");
  return groups;
}

function addLayer(map: any, layer: Record<string, unknown>): void {
  const id = String(layer.id || "");
  if (!id || map.getLayer(id)) return;
  map.addLayer(layer);
}

export function ensureMapDetailStyle(map: any): void {
  if (typeof map.isStyleLoaded === "function" && !map.isStyleLoaded()) return;
  if (!map.getSource("its-map-details")) {
    map.addSource("its-map-details", {
      type: "geojson",
      data: EMPTY_MAP_DETAIL_COLLECTION,
    });
  }

  addLayer(map, {
    id: "its-detail-green-areas",
    type: "fill",
    source: "its-map-details",
    minzoom: 14,
    filter: ["all", ["==", ["get", "kind"], "green"], ["==", ["geometry-type"], "Polygon"]],
    paint: {
      "fill-color": "#bfe5bd",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0.28, 17, 0.56],
      "fill-outline-color": "#7bc783",
    },
  });

  addLayer(map, {
    id: "its-detail-water-polygons",
    type: "fill",
    source: "its-map-details",
    minzoom: 12,
    filter: ["all", ["==", ["get", "kind"], "waterway"], ["==", ["geometry-type"], "Polygon"]],
    paint: { "fill-color": "#90d7f0", "fill-opacity": 0.68 },
  });

  addLayer(map, {
    id: "its-detail-waterways",
    type: "line",
    source: "its-map-details",
    minzoom: 11,
    filter: ["==", ["get", "kind"], "waterway"],
    paint: {
      "line-color": "#51b9df",
      "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1, 16, 3, 19, 7],
      "line-opacity": 0.82,
    },
  });

  addLayer(map, {
    id: "its-detail-roads",
    type: "line",
    source: "its-map-details",
    minzoom: 11,
    filter: ["==", ["get", "kind"], "road"],
    paint: {
      "line-color": [
        "match", ["get", "roadType"],
        "expressway", "#ffb36c",
        "avenue", "#ffd878",
        "service", "#dde5ed",
        "#ffffff",
      ],
      "line-width": [
        "interpolate", ["linear"], ["zoom"],
        11, ["match", ["get", "roadType"], "expressway", 2.4, "avenue", 1.9, 0.7],
        17, ["match", ["get", "roadType"], "expressway", 9, "avenue", 7, "service", 3.2, 4.5],
        20, ["match", ["get", "roadType"], "expressway", 18, "avenue", 14, "service", 6, 9],
      ],
      "line-opacity": 0.86,
    },
  });

  addLayer(map, {
    id: "its-detail-medians",
    type: "line",
    source: "its-map-details",
    minzoom: 16,
    filter: ["==", ["get", "kind"], "median"],
    paint: {
      "line-color": "#4dbb76",
      "line-width": ["interpolate", ["linear"], ["zoom"], 16, 1, 19, 3.5],
      "line-dasharray": [1, 3],
      "line-opacity": 0.82,
    },
  });

  addLayer(map, {
    id: "its-detail-pedestrian",
    type: "line",
    source: "its-map-details",
    minzoom: 15,
    filter: ["==", ["get", "kind"], "pedestrian"],
    paint: {
      "line-color": "#8bbdb7",
      "line-width": ["interpolate", ["linear"], ["zoom"], 15, 1, 18, 3.5],
      "line-dasharray": [1.5, 1],
      "line-opacity": 0.8,
    },
  });

  addLayer(map, {
    id: "its-detail-railways",
    type: "line",
    source: "its-map-details",
    minzoom: 11,
    filter: ["==", ["get", "kind"], "railway"],
    paint: {
      "line-color": "#485568",
      "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1, 18, 3],
      "line-dasharray": [2, 1.4],
      "line-opacity": 0.85,
    },
  });

  addLayer(map, {
    id: "its-detail-tree-rows",
    type: "line",
    source: "its-map-details",
    minzoom: 17,
    filter: ["==", ["get", "kind"], "tree_row"],
    paint: {
      "line-color": "#239b58",
      "line-width": ["interpolate", ["linear"], ["zoom"], 17, 2, 20, 6],
      "line-dasharray": [0.5, 2],
      "line-opacity": 0.9,
    },
  });

  addLayer(map, {
    id: "its-detail-trees",
    type: "circle",
    source: "its-map-details",
    minzoom: 18,
    filter: ["==", ["get", "kind"], "tree"],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 18, 2.5, 20, 5],
      "circle-color": "#2ea866",
      "circle-stroke-color": "#e8fff0",
      "circle-stroke-width": 1,
    },
  });

  addLayer(map, {
    id: "its-detail-crossings",
    type: "circle",
    source: "its-map-details",
    minzoom: 15,
    filter: ["==", ["get", "kind"], "crossing"],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 15, 3, 19, 7],
      "circle-color": "#ffffff",
      "circle-stroke-color": "#475569",
      "circle-stroke-width": 2,
    },
  });

  addLayer(map, {
    id: "its-detail-traffic-signals",
    type: "circle",
    source: "its-map-details",
    minzoom: 16,
    filter: ["==", ["get", "kind"], "traffic_signal"],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 16, 4, 20, 8],
      "circle-color": "#111827",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
    },
  });

  addLayer(map, {
    id: "its-detail-road-labels",
    type: "symbol",
    source: "its-map-details",
    minzoom: 14,
    filter: ["all", ["==", ["get", "kind"], "road"], ["!=", ["get", "name"], ""]],
    layout: {
      "symbol-placement": "line",
      "text-field": ["get", "name"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 14, 9, 19, 13],
      "text-padding": 5,
      "text-allow-overlap": false,
      "text-ignore-placement": false,
      "text-optional": true,
    },
    paint: {
      "text-color": "#344256",
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.3,
    },
  });

  addLayer(map, {
    id: "its-detail-point-labels",
    type: "symbol",
    source: "its-map-details",
    minzoom: 17,
    filter: ["all", ["in", ["get", "kind"], ["literal", ["traffic_signal", "crossing"]]], ["!=", ["get", "name"], ""]],
    layout: {
      "text-field": ["get", "name"],
      "text-size": 10,
      "text-offset": [0, 1.2],
      "text-anchor": "top",
      "text-padding": 4,
      "text-allow-overlap": false,
      "text-ignore-placement": false,
      "text-optional": true,
    },
    paint: {
      "text-color": "#1f2937",
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.4,
    },
  });
}

export function setMapDetailData(map: any, data: MapDetailFeatureCollection): void {
  if (typeof map.isStyleLoaded === "function" && !map.isStyleLoaded()) return;
  ensureMapDetailStyle(map);
  const source = map.getSource("its-map-details");
  if (source && typeof source.setData === "function") source.setData(data);
}
