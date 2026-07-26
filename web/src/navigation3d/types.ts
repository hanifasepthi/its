export type LngLat = [longitude: number, latitude: number];

export type NavigationMode =
  | "car"
  | "motorcycle"
  | "truck"
  | "bicycle"
  | "walk"
  | "transit";

export type SearchPlace = {
  id: string;
  title: string;
  subtitle: string;
  coordinate: LngLat;
};

export type NavigationVehicleProfile = {
  heightM?: number;
  widthM?: number;
  lengthM?: number;
  weightTons?: number;
  axleLoadTons?: number;
  hazardousMaterial?: boolean;
};

export type NavigationRequest = {
  origin: LngLat;
  destination: LngLat;
  destinationName: string;
  mode: NavigationMode;
  avoidTolls?: boolean;
  avoidHighways?: boolean;
  vehicle?: NavigationVehicleProfile;
};

export type RouteManeuver = {
  index: number;
  coordinate: LngLat;
  type: string;
  modifier: string;
  instruction: string;
  roadName: string;
  distanceM: number;
  durationS: number;
};

export type NavigationRoute = {
  geometry: GeoJSON.Feature<GeoJSON.LineString>;
  distanceM: number;
  durationS: number;
  maneuvers: RouteManeuver[];
};

export type OrnamentKind =
  | "tree"
  | "palm"
  | "street-light"
  | "traffic-signal"
  | "cctv"
  | "etle"
  | "speed-camera"
  | "crossing"
  | "bus-stop"
  | "hydrant"
  | "bollard"
  | "barrier"
  | "guardrail"
  | "bridge-pier"
  | "roadwork";

export type Ornament3D = {
  id: string;
  kind: OrnamentKind;
  coordinate: LngLat;
  altitudeM?: number;
  bearing?: number;
  scale?: number;
  priority?: number;
  metadata?: Record<string, unknown>;
};

export type SceneCollections = {
  roads: GeoJSON.FeatureCollection;
  sidewalks: GeoJSON.FeatureCollection;
  medians: GeoJSON.FeatureCollection;
  bridges: GeoJSON.FeatureCollection;
  footbridges: GeoJSON.FeatureCollection;
  tunnels: GeoJSON.FeatureCollection;
  markings: GeoJSON.FeatureCollection;
  waterways: GeoJSON.FeatureCollection;
  greens: GeoJSON.FeatureCollection;
  buildings: GeoJSON.FeatureCollection;
  pointSymbols: GeoJSON.FeatureCollection;
  ornaments: Ornament3D[];
};

export type OverpassNode = {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
};

export type OverpassWay = {
  type: "way";
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
};

export type OverpassPayload = {
  elements: Array<OverpassNode | OverpassWay>;
};

export type ModeProfile = {
  label: string;
  icon: string;
  routeCosting: string;
  pitch: number;
  zoom: number;
  bottomPadding: number;
  sceneRadiusM: number;
  reloadDistanceM: number;
  avatar: "car" | "motorcycle" | "truck" | "bicycle" | "pedestrian";
};

export type MatchedPosition = {
  coordinate: LngLat;
  distanceToRouteM: number;
  distanceAlongRouteM: number;
  segmentIndex: number;
  segmentT: number;
  bearing: number;
};
