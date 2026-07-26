import type {
  LngLat,
  MatchedPosition,
  ModeProfile,
  NavigationMode,
  NavigationRequest,
  NavigationRoute,
  OverpassPayload,
  RouteManeuver,
  SearchPlace,
} from "./types";

const EARTH_RADIUS_M = 6_378_137;

export const DEFAULT_NAVIGATION_CENTER: LngLat = [107.631817, -6.977254];

export const MODE_PROFILES: Record<NavigationMode, ModeProfile> = {
  car: {
    label: "Mobil",
    icon: "🚗",
    routeCosting: "auto",
    pitch: 69,
    zoom: 20.2,
    bottomPadding: 150,
    sceneRadiusM: 680,
    reloadDistanceM: 300,
    avatar: "car",
  },
  motorcycle: {
    label: "Motor",
    icon: "🏍️",
    routeCosting: "motorcycle",
    pitch: 71,
    zoom: 20.35,
    bottomPadding: 148,
    sceneRadiusM: 760,
    reloadDistanceM: 340,
    avatar: "motorcycle",
  },
  truck: {
    label: "Truk",
    icon: "🚚",
    routeCosting: "truck",
    pitch: 65,
    zoom: 19.75,
    bottomPadding: 158,
    sceneRadiusM: 820,
    reloadDistanceM: 360,
    avatar: "truck",
  },
  bicycle: {
    label: "Sepeda",
    icon: "🚲",
    routeCosting: "bicycle",
    pitch: 73,
    zoom: 20.45,
    bottomPadding: 145,
    sceneRadiusM: 520,
    reloadDistanceM: 240,
    avatar: "bicycle",
  },
  walk: {
    label: "Jalan kaki",
    icon: "🚶",
    routeCosting: "pedestrian",
    pitch: 76,
    zoom: 20.65,
    bottomPadding: 140,
    sceneRadiusM: 340,
    reloadDistanceM: 140,
    avatar: "pedestrian",
  },
  transit: {
    label: "Angkutan",
    icon: "🚌",
    routeCosting: "multimodal",
    pitch: 68,
    zoom: 20.05,
    bottomPadding: 152,
    sceneRadiusM: 680,
    reloadDistanceM: 300,
    avatar: "pedestrian",
  },
};

const ENDPOINTS = {
  photon: import.meta.env.VITE_PHOTON_URL || "https://photon.komoot.io/api/",
  nominatim:
    import.meta.env.VITE_NOMINATIM_URL || "https://nominatim.openstreetmap.org/search",
  osrmCar: [
    import.meta.env.VITE_OSRM_CAR_URL,
    "https://router.project-osrm.org/route/v1/driving",
    "https://routing.openstreetmap.de/routed-car/route/v1/driving",
  ].filter((value, index, values): value is string =>
    Boolean(value) && values.indexOf(value) === index),
  osrmBike: [
    import.meta.env.VITE_OSRM_BIKE_URL,
    "https://routing.openstreetmap.de/routed-bike/route/v1/driving",
    "https://router.project-osrm.org/route/v1/driving",
  ].filter((value, index, values): value is string =>
    Boolean(value) && values.indexOf(value) === index),
  osrmFoot: [
    import.meta.env.VITE_OSRM_FOOT_URL,
    "https://routing.openstreetmap.de/routed-foot/route/v1/driving",
    "https://router.project-osrm.org/route/v1/driving",
  ].filter((value, index, values): value is string =>
    Boolean(value) && values.indexOf(value) === index),
  overpass: [
    import.meta.env.VITE_OVERPASS_URL,
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ].filter((value, index, values): value is string =>
    Boolean(value) && values.indexOf(value) === index),
};

const OVERPASS_ENDPOINT_TIMEOUT_MS = 18_000;
const ROUTING_ENDPOINT_TIMEOUT_MS = 15_000;

const PLACE_SEARCH_CACHE_TTL_MS = 10 * 60_000;
const PLACE_SEARCH_CACHE_LIMIT = 48;
const placeSearchCache = new Map<string, { expiresAt: number; places: SearchPlace[] }>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function radians(value: number): number {
  return (value * Math.PI) / 180;
}

function degrees(value: number): number {
  return (value * 180) / Math.PI;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function lngLatToMeters(coordinate: LngLat): [number, number] {
  const latitude = clamp(coordinate[1], -85.05112878, 85.05112878);
  return [
    EARTH_RADIUS_M * radians(coordinate[0]),
    EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + radians(latitude) / 2)),
  ];
}

export function metersToLngLat(point: [number, number]): LngLat {
  return [
    degrees(point[0] / EARTH_RADIUS_M),
    degrees(2 * Math.atan(Math.exp(point[1] / EARTH_RADIUS_M)) - Math.PI / 2),
  ];
}

export function distanceM(first: LngLat, second: LngLat): number {
  const firstLatitude = radians(first[1]);
  const secondLatitude = radians(second[1]);
  const latitudeDifference = secondLatitude - firstLatitude;
  const longitudeDifference = radians(second[0] - first[0]);
  const haversine =
    Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.sin(longitudeDifference / 2) ** 2;
  return (
    2 *
    EARTH_RADIUS_M *
    Math.atan2(Math.sqrt(haversine), Math.sqrt(Math.max(0, 1 - haversine)))
  );
}

export function bearingDegrees(first: LngLat, second: LngLat): number {
  const firstLatitude = radians(first[1]);
  const secondLatitude = radians(second[1]);
  const longitudeDifference = radians(second[0] - first[0]);
  const y = Math.sin(longitudeDifference) * Math.cos(secondLatitude);
  const x =
    Math.cos(firstLatitude) * Math.sin(secondLatitude) -
    Math.sin(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.cos(longitudeDifference);
  return (degrees(Math.atan2(y, x)) + 360) % 360;
}

export function lineLengthM(coordinates: LngLat[]): number {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    total += distanceM(coordinates[index - 1], coordinates[index]);
  }
  return total;
}

export function interpolateCoordinate(first: LngLat, second: LngLat, ratio: number): LngLat {
  const firstPoint = lngLatToMeters(first);
  const secondPoint = lngLatToMeters(second);
  const safeRatio = clamp(ratio, 0, 1);
  return metersToLngLat([
    firstPoint[0] + (secondPoint[0] - firstPoint[0]) * safeRatio,
    firstPoint[1] + (secondPoint[1] - firstPoint[1]) * safeRatio,
  ]);
}

export function coordinateAlongLine(
  coordinates: LngLat[],
  targetDistanceM: number,
): { coordinate: LngLat; segmentIndex: number; bearing: number } {
  if (coordinates.length < 2) {
    return { coordinate: coordinates[0] || DEFAULT_NAVIGATION_CENTER, segmentIndex: 0, bearing: 0 };
  }

  let consumedDistance = 0;
  const safeTarget = Math.max(0, targetDistanceM);
  for (let index = 1; index < coordinates.length; index += 1) {
    const first = coordinates[index - 1];
    const second = coordinates[index];
    const segmentDistance = distanceM(first, second);
    if (consumedDistance + segmentDistance >= safeTarget) {
      const ratio = segmentDistance > 0 ? (safeTarget - consumedDistance) / segmentDistance : 0;
      return {
        coordinate: interpolateCoordinate(first, second, ratio),
        segmentIndex: index - 1,
        bearing: bearingDegrees(first, second),
      };
    }
    consumedDistance += segmentDistance;
  }

  const lastIndex = coordinates.length - 1;
  return {
    coordinate: coordinates[lastIndex],
    segmentIndex: lastIndex - 1,
    bearing: bearingDegrees(coordinates[lastIndex - 1], coordinates[lastIndex]),
  };
}

/** Smallest signed rotation from the current heading to the target heading. */
export function bearingDeltaDegrees(current: number, target: number): number {
  return ((target - current + 540) % 360) - 180;
}

/**
 * Returns the forward (origin to destination) heading at a distance along a
 * snapped route. A short look-ahead removes vertex jitter and prevents a
 * navigation camera from accidentally using the reverse segment bearing.
 */
export function forwardBearingOnRoute(
  coordinates: LngLat[],
  distanceAlongRouteM: number,
  lookAheadM = 28,
): number {
  if (coordinates.length < 2) return 0;
  const totalDistance = lineLengthM(coordinates);
  const currentDistance = clamp(distanceAlongRouteM, 0, totalDistance);
  const aheadDistance = Math.min(totalDistance, currentDistance + Math.max(4, lookAheadM));
  const current = coordinateAlongLine(coordinates, currentDistance);
  const ahead = coordinateAlongLine(coordinates, aheadDistance);
  if (distanceM(current.coordinate, ahead.coordinate) >= 0.35) {
    return bearingDegrees(current.coordinate, ahead.coordinate);
  }

  const lastIndex = coordinates.length - 1;
  return bearingDegrees(coordinates[lastIndex - 1], coordinates[lastIndex]);
}

export function sampleLine(
  coordinates: LngLat[],
  spacingM: number,
): Array<{ coordinate: LngLat; bearing: number }> {
  const samples: Array<{ coordinate: LngLat; bearing: number }> = [];
  const totalDistance = lineLengthM(coordinates);
  for (let value = 0; value <= totalDistance; value += Math.max(2, spacingM)) {
    const sample = coordinateAlongLine(coordinates, value);
    samples.push({ coordinate: sample.coordinate, bearing: sample.bearing });
  }
  return samples;
}

function normalVector(
  first: [number, number],
  second: [number, number],
): [number, number] {
  const x = second[0] - first[0];
  const y = second[1] - first[1];
  const length = Math.hypot(x, y) || 1;
  return [-y / length, x / length];
}

export function offsetLine(coordinates: LngLat[], offsetM: number): LngLat[] {
  if (coordinates.length < 2) return coordinates.slice();
  const points = coordinates.map(lngLatToMeters);
  const result: Array<[number, number]> = [];
  for (let index = 0; index < points.length; index += 1) {
    let normal: [number, number];
    if (index === 0) {
      normal = normalVector(points[0], points[1]);
    } else if (index === points.length - 1) {
      normal = normalVector(points[index - 1], points[index]);
    } else {
      const previous = normalVector(points[index - 1], points[index]);
      const next = normalVector(points[index], points[index + 1]);
      const x = previous[0] + next[0];
      const y = previous[1] + next[1];
      const length = Math.hypot(x, y) || 1;
      normal = [x / length, y / length];
    }
    result.push([
      points[index][0] + normal[0] * offsetM,
      points[index][1] + normal[1] * offsetM,
    ]);
  }
  return result.map(metersToLngLat);
}

export function polygonAroundLine(coordinates: LngLat[], widthM: number): GeoJSON.Polygon {
  const halfWidth = Math.max(0.5, widthM / 2);
  const ring = [
    ...offsetLine(coordinates, halfWidth),
    ...offsetLine(coordinates, -halfWidth).reverse(),
  ];
  if (ring.length > 0) ring.push(ring[0]);
  return { type: "Polygon", coordinates: [ring] };
}

export function nearestPointOnRoute(coordinate: LngLat, route: LngLat[]): MatchedPosition {
  if (route.length < 2) {
    return {
      coordinate: route[0] || coordinate,
      distanceToRouteM: route[0] ? distanceM(coordinate, route[0]) : 0,
      distanceAlongRouteM: 0,
      segmentIndex: 0,
      segmentT: 0,
      bearing: 0,
    };
  }

  const target = lngLatToMeters(coordinate);
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestCoordinate = route[0];
  let bestSegment = 0;
  let bestRatio = 0;
  let distanceAlongRoute = 0;
  let previousDistance = 0;

  for (let index = 1; index < route.length; index += 1) {
    const first = lngLatToMeters(route[index - 1]);
    const second = lngLatToMeters(route[index]);
    const x = second[0] - first[0];
    const y = second[1] - first[1];
    const squaredLength = x * x + y * y;
    const ratio =
      squaredLength > 0
        ? clamp(((target[0] - first[0]) * x + (target[1] - first[1]) * y) / squaredLength, 0, 1)
        : 0;
    const projected: [number, number] = [first[0] + x * ratio, first[1] + y * ratio];
    const projectedDistance = Math.hypot(target[0] - projected[0], target[1] - projected[1]);
    const segmentDistance = distanceM(route[index - 1], route[index]);
    if (projectedDistance < bestDistance) {
      bestDistance = projectedDistance;
      bestCoordinate = metersToLngLat(projected);
      bestSegment = index - 1;
      bestRatio = ratio;
      distanceAlongRoute = previousDistance + segmentDistance * ratio;
    }
    previousDistance += segmentDistance;
  }

  return {
    coordinate: bestCoordinate,
    distanceToRouteM: bestDistance,
    distanceAlongRouteM: distanceAlongRoute,
    segmentIndex: bestSegment,
    segmentT: bestRatio,
    bearing: bearingDegrees(route[bestSegment], route[bestSegment + 1]),
  };
}

export function smoothBearing(current: number, target: number, ratio = 0.28): number {
  const difference = ((target - current + 540) % 360) - 180;
  return (current + difference * ratio + 360) % 360;
}

export function formatDistance(valueM: number): string {
  if (!Number.isFinite(valueM)) return "—";
  if (valueM < 1_000) {
    const rounded = valueM >= 100 ? Math.round(valueM / 10) * 10 : Math.round(valueM);
    return `${Math.max(0, rounded)} m`;
  }
  const kilometres = valueM / 1_000;
  return kilometres < 10 ? `${kilometres.toFixed(1)} km` : `${Math.round(kilometres)} km`;
}

export function formatDuration(valueSeconds: number): string {
  if (!Number.isFinite(valueSeconds)) return "—";
  const minutes = Math.max(1, Math.round(valueSeconds / 60));
  if (minutes < 60) return `${minutes} menit`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} jam ${remainingMinutes} menit` : `${hours} jam`;
}

function clonePlaces(places: SearchPlace[]): SearchPlace[] {
  return places.map((place) => ({ ...place, coordinate: [...place.coordinate] as LngLat }));
}

function rememberPlaceSearch(key: string, places: SearchPlace[]): void {
  if (placeSearchCache.size >= PLACE_SEARCH_CACHE_LIMIT) {
    const oldestKey = placeSearchCache.keys().next().value;
    if (typeof oldestKey === "string") placeSearchCache.delete(oldestKey);
  }
  placeSearchCache.set(key, {
    expiresAt: Date.now() + PLACE_SEARCH_CACHE_TTL_MS,
    places: clonePlaces(places),
  });
}

function cachedPlaceSearch(key: string): SearchPlace[] | null {
  const cached = placeSearchCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    placeSearchCache.delete(key);
    return null;
  }
  // Refresh insertion order so frequently used entries survive the small LRU cache.
  placeSearchCache.delete(key);
  placeSearchCache.set(key, cached);
  return clonePlaces(cached.places);
}

function parseCoordinateQuery(query: string): SearchPlace[] {
  const match = query.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!match) return [];
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return [];
  const coordinateText = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
  return [{
    id: `coordinate:${latitude.toFixed(6)}:${longitude.toFixed(6)}`,
    title: coordinateText,
    subtitle: "Koordinat yang dimasukkan",
    coordinate: [longitude, latitude],
  }];
}

function uniquePlaces(places: SearchPlace[], limit = 8): SearchPlace[] {
  const unique: SearchPlace[] = [];
  const seen = new Set<string>();
  for (const place of places) {
    const key = `${place.title.toLocaleLowerCase("id-ID")}:${place.coordinate[0].toFixed(5)}:${place.coordinate[1].toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(place);
    if (unique.length >= limit) break;
  }
  return unique;
}

async function searchPhoton(
  cleanQuery: string,
  bias?: LngLat,
  signal?: AbortSignal,
): Promise<SearchPlace[]> {
  const url = new URL(ENDPOINTS.photon);
  url.searchParams.set("q", cleanQuery);
  url.searchParams.set("limit", "8");
  if (bias) {
    url.searchParams.set("lon", String(bias[0]));
    url.searchParams.set("lat", String(bias[1]));
  }

  // The public Photon instance currently accepts only its configured language
  // set. Indonesian is requested through the normal browser language header so
  // Photon can safely fall back to the local OSM name instead of rejecting the
  // entire query with HTTP 400.
  const response = await fetch(url, {
    signal,
    headers: { Accept: "application/json", "Accept-Language": "id,en;q=0.8" },
  });
  if (!response.ok) throw new Error(`Pencarian lokasi gagal (HTTP ${response.status}).`);

  const payload = asRecord(await response.json());
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const places: SearchPlace[] = [];
  const seen = new Set<string>();
  for (const [index, rawFeature] of features.entries()) {
    const feature = asRecord(rawFeature);
    const geometry = asRecord(feature?.geometry);
    const coordinates = Array.isArray(geometry?.coordinates) ? geometry.coordinates : [];
    const longitude = asFiniteNumber(coordinates[0]);
    const latitude = asFiniteNumber(coordinates[1]);
    if (longitude === null || latitude === null) continue;
    const properties = asRecord(feature?.properties) || {};
    const stringProperty = (name: string): string =>
      typeof properties[name] === "string" ? properties[name] : "";
    const title =
      stringProperty("name") ||
      stringProperty("street") ||
      stringProperty("city") ||
      "Lokasi";
    const subtitle = [
      stringProperty("street"),
      stringProperty("district"),
      stringProperty("city"),
      stringProperty("county"),
      stringProperty("state"),
      stringProperty("country"),
    ]
      .filter((value, itemIndex, values) => Boolean(value) && values.indexOf(value) === itemIndex)
      .join(", ");
    const stableId = String(properties.osm_id || `${longitude}:${latitude}:${index}`);
    const key = `${title.toLocaleLowerCase("id-ID")}:${longitude.toFixed(5)}:${latitude.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    places.push({
      id: stableId,
      title,
      subtitle: subtitle || title,
      coordinate: [longitude, latitude],
    });
  }
  return uniquePlaces(places);
}

async function searchNominatim(
  cleanQuery: string,
  bias?: LngLat,
  signal?: AbortSignal,
): Promise<SearchPlace[]> {
  const url = new URL(ENDPOINTS.nominatim);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("q", cleanQuery);
  url.searchParams.set("limit", "8");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "id,en");
  // ITS Maps currently targets Indonesia. This also keeps a failed location
  // permission from biasing results towards the hard-coded development point.
  url.searchParams.set("countrycodes", "id");
  if (bias) {
    const latitudeDelta = 1.35;
    const longitudeDelta = latitudeDelta / Math.max(0.2, Math.cos(radians(bias[1])));
    url.searchParams.set(
      "viewbox",
      [
        clamp(bias[0] - longitudeDelta, -180, 180),
        clamp(bias[1] + latitudeDelta, -90, 90),
        clamp(bias[0] + longitudeDelta, -180, 180),
        clamp(bias[1] - latitudeDelta, -90, 90),
      ].join(","),
    );
  }

  const response = await fetch(url, {
    signal,
    headers: { Accept: "application/json", "Accept-Language": "id,en;q=0.8" },
  });
  if (!response.ok) throw new Error(`Pencarian cadangan gagal (HTTP ${response.status}).`);
  const payload: unknown = await response.json();
  const items = Array.isArray(payload) ? payload : [];
  const places: SearchPlace[] = [];
  for (const [index, rawItem] of items.entries()) {
    const item = asRecord(rawItem);
    if (!item) continue;
    const longitude = asFiniteNumber(item.lon);
    const latitude = asFiniteNumber(item.lat);
    if (longitude === null || latitude === null) continue;
    const displayName = typeof item.display_name === "string" ? item.display_name.trim() : "";
    const namedetails = asRecord(item.namedetails);
    const address = asRecord(item.address);
    const titleCandidates = [
      typeof item.name === "string" ? item.name : "",
      typeof namedetails?.name === "string" ? namedetails.name : "",
      typeof address?.amenity === "string" ? address.amenity : "",
      typeof address?.road === "string" ? address.road : "",
      displayName.split(",")[0] || "",
    ];
    const title = titleCandidates.find((value) => value.trim())?.trim() || "Lokasi";
    const subtitle = displayName || [
      typeof address?.road === "string" ? address.road : "",
      typeof address?.city === "string" ? address.city : "",
      typeof address?.state === "string" ? address.state : "",
    ].filter(Boolean).join(", ") || title;
    const stableId = String(item.osm_id || item.place_id || `${longitude}:${latitude}:${index}`);
    places.push({
      id: `nominatim:${stableId}`,
      title,
      subtitle,
      coordinate: [longitude, latitude],
    });
  }
  return uniquePlaces(places);
}

export async function searchPlaces(
  query: string,
  bias?: LngLat,
  signal?: AbortSignal,
): Promise<SearchPlace[]> {
  const cleanQuery = query.trim();
  if (cleanQuery.length < 3) return [];

  const coordinatePlaces = parseCoordinateQuery(cleanQuery);
  if (coordinatePlaces.length > 0) return coordinatePlaces;

  const cacheKey = `${cleanQuery.toLocaleLowerCase("id-ID")}:${bias ? `${bias[0].toFixed(2)},${bias[1].toFixed(2)}` : "indonesia"}`;
  const cached = cachedPlaceSearch(cacheKey);
  if (cached) return cached;

  const errors: Error[] = [];
  for (const provider of [searchPhoton, searchNominatim]) {
    try {
      const places = await provider(cleanQuery, bias, signal);
      if (places.length > 0) {
        rememberPlaceSearch(cacheKey, places);
        return clonePlaces(places);
      }
    } catch (error) {
      if (signal?.aborted || (error as Error).name === "AbortError") throw error;
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (errors.length >= 2) {
    throw new Error(`Semua layanan pencarian lokasi gagal: ${errors.map((error) => error.message).join("; ")}`);
  }
  rememberPlaceSearch(cacheKey, []);
  return [];
}

function osrmEndpoints(mode: NavigationMode): string[] {
  if (mode === "walk" || mode === "transit") return ENDPOINTS.osrmFoot;
  if (mode === "bicycle") return ENDPOINTS.osrmBike;
  return ENDPOINTS.osrmCar;
}

function osrmInstruction(step: Record<string, unknown>): string {
  const maneuver = asRecord(step.maneuver) || {};
  const type = typeof maneuver.type === "string" ? maneuver.type : "continue";
  const modifier = typeof maneuver.modifier === "string" ? maneuver.modifier : "";
  const roadName = typeof step.name === "string" ? step.name : "";
  const directions: Record<string, string> = {
    left: "ke kiri",
    "slight left": "sedikit ke kiri",
    "sharp left": "tajam ke kiri",
    right: "ke kanan",
    "slight right": "sedikit ke kanan",
    "sharp right": "tajam ke kanan",
    straight: "lurus",
    uturn: "putar balik",
  };
  if (type === "arrive") return "Tujuan berada di depan";
  if (type === "depart") return roadName ? `Mulai menuju ${roadName}` : "Mulai perjalanan";
  if (type === "roundabout" || type === "rotary") {
    const exit = asFiniteNumber(maneuver.exit) || 0;
    return exit > 0 ? `Masuk bundaran, ambil keluar ke-${exit}` : "Masuk bundaran";
  }
  if (type === "merge") return `Bergabung ${directions[modifier] || modifier || "lurus"}`;
  if (type === "fork") return `Ambil cabang ${directions[modifier] || modifier || "lurus"}`;
  const direction = directions[modifier] || "lurus";
  return roadName ? `Belok ${direction} ke ${roadName}` : `Lanjut ${direction}`;
}

export async function requestRoute(
  request: NavigationRequest,
  signal?: AbortSignal,
): Promise<NavigationRoute> {
  const coordinates =
    `${request.origin[0]},${request.origin[1]};` +
    `${request.destination[0]},${request.destination[1]}`;
  let payload: Record<string, unknown> | null = null;
  let lastError: Error | null = null;
  for (const endpoint of osrmEndpoints(request.mode)) {
    const url = new URL(`${endpoint}/${coordinates}`);
    url.searchParams.set("overview", "full");
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("steps", "true");
    const requestAbort = new AbortController();
    let endpointTimedOut = false;
    const abortFromCaller = (): void => requestAbort.abort();
    if (signal?.aborted) requestAbort.abort();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = window.setTimeout(() => {
      endpointTimedOut = true;
      requestAbort.abort();
    }, ROUTING_ENDPOINT_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: requestAbort.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const candidate = asRecord(await response.json());
      if (!candidate || !Array.isArray(candidate.routes) || candidate.routes.length === 0) {
        throw new Error("rute tidak ditemukan");
      }
      payload = candidate;
      break;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = endpointTimedOut
        ? new Error(`batas waktu ${Math.round(ROUTING_ENDPOINT_TIMEOUT_MS / 1_000)} detik`)
        : error instanceof Error ? error : new Error(String(error));
    } finally {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
  if (!payload) {
    throw new Error(`Layanan rute belum dapat dijangkau: ${lastError?.message || "semua endpoint gagal"}.`);
  }
  const routes = Array.isArray(payload?.routes) ? payload.routes : [];
  const route = asRecord(routes[0]);
  const geometry = asRecord(route?.geometry);
  const rawCoordinates = Array.isArray(geometry?.coordinates) ? geometry.coordinates : [];
  const routeCoordinates: LngLat[] = rawCoordinates
    .map((coordinate): LngLat | null => {
      if (!Array.isArray(coordinate)) return null;
      const longitude = asFiniteNumber(coordinate[0]);
      const latitude = asFiniteNumber(coordinate[1]);
      return longitude === null || latitude === null ? null : [longitude, latitude];
    })
    .filter((coordinate): coordinate is LngLat => coordinate !== null);
  if (routeCoordinates.length < 2) throw new Error("Rute tidak ditemukan untuk moda ini.");

  const rawLegs = Array.isArray(route?.legs) ? route.legs : [];
  const rawSteps = rawLegs.flatMap((leg) => {
    const record = asRecord(leg);
    return Array.isArray(record?.steps) ? record.steps : [];
  });
  const maneuvers: RouteManeuver[] = rawSteps.flatMap((rawStep, index) => {
    const step = asRecord(rawStep);
    const maneuver = asRecord(step?.maneuver);
    const location = Array.isArray(maneuver?.location) ? maneuver.location : [];
    const longitude = asFiniteNumber(location[0]);
    const latitude = asFiniteNumber(location[1]);
    if (!step || !maneuver || longitude === null || latitude === null) return [];
    return [
      {
        index,
        coordinate: [longitude, latitude],
        type: typeof maneuver.type === "string" ? maneuver.type : "continue",
        modifier: typeof maneuver.modifier === "string" ? maneuver.modifier : "",
        instruction: osrmInstruction(step),
        roadName: typeof step.name === "string" ? step.name : "",
        distanceM: asFiniteNumber(step.distance) || 0,
        durationS: asFiniteNumber(step.duration) || 0,
      },
    ];
  });

  return {
    geometry: {
      type: "Feature",
      properties: {
        mode: request.mode,
        destinationName: request.destinationName,
        routingProfile: MODE_PROFILES[request.mode].routeCosting,
        routeApproximation:
          request.mode === "motorcycle" || request.mode === "truck" || request.mode === "transit",
      },
      geometry: { type: "LineString", coordinates: routeCoordinates },
    },
    distanceM: asFiniteNumber(route?.distance) || lineLengthM(routeCoordinates),
    durationS: asFiniteNumber(route?.duration) || 0,
    maneuvers,
  };
}

function createRoadSceneQuery(center: LngLat, radiusM: number): string {
  const safeRadius = Math.round(clamp(radiusM, 100, 2_000));
  const [longitude, latitude] = center;
  return `
[out:json][timeout:20];
(
  way(around:${safeRadius},${latitude},${longitude})["highway"];
  way(around:${safeRadius},${latitude},${longitude})["building"];
  way(around:${safeRadius},${latitude},${longitude})["waterway"];
  way(around:${safeRadius},${latitude},${longitude})["natural"="water"];
  way(around:${safeRadius},${latitude},${longitude})["leisure"~"park|garden"];
  way(around:${safeRadius},${latitude},${longitude})["landuse"~"grass|forest|recreation_ground"];
  node(around:${safeRadius},${latitude},${longitude})["highway"~"traffic_signals|crossing|speed_camera|street_lamp|bus_stop"];
  node(around:${safeRadius},${latitude},${longitude})["public_transport"="platform"];
  node(around:${safeRadius},${latitude},${longitude})["man_made"="surveillance"];
  node(around:${safeRadius},${latitude},${longitude})["surveillance"];
  node(around:${safeRadius},${latitude},${longitude})["natural"="tree"];
  node(around:${safeRadius},${latitude},${longitude})["emergency"="fire_hydrant"];
  node(around:${safeRadius},${latitude},${longitude})["barrier"~"bollard|lift_gate"];
);
out body;
>;
out skel qt;`;
}

function isOverpassPayload(value: unknown): value is OverpassPayload {
  const record = asRecord(value);
  return Array.isArray(record?.elements);
}

export async function fetchRoadScene(
  center: LngLat,
  radiusM: number,
  signal?: AbortSignal,
): Promise<OverpassPayload> {
  const body = new URLSearchParams({ data: createRoadSceneQuery(center, radiusM) });
  let lastError: Error | null = null;
  for (const endpoint of ENDPOINTS.overpass) {
    const requestAbort = new AbortController();
    let endpointTimedOut = false;
    const abortFromCaller = (): void => requestAbort.abort();
    if (signal?.aborted) requestAbort.abort();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = window.setTimeout(() => {
      endpointTimedOut = true;
      requestAbort.abort();
    }, OVERPASS_ENDPOINT_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        signal: requestAbort.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload: unknown = await response.json();
      if (!isOverpassPayload(payload)) throw new Error("Respons Overpass tidak valid.");
      return payload;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = endpointTimedOut
        ? new Error(`batas waktu ${Math.round(OVERPASS_ENDPOINT_TIMEOUT_MS / 1_000)} detik`)
        : error instanceof Error ? error : new Error(String(error));
    } finally {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
  throw new Error(`Data detail jalan belum tersedia: ${lastError?.message || "endpoint gagal"}`);
}
