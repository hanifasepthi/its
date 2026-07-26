import maplibregl, {
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MapLibreMap,
} from "maplibre-gl";
import * as THREE from "three";

import { MODE_PROFILES } from "./services";

import type {
  LngLat,
  NavigationMode,
  Ornament3D,
} from "./types";

type AnimatedPart = {
  object: THREE.Object3D;
  phase: number;
  amplitude: number;
  axis: "x" | "y";
  motion: "swing" | "spin";
};

type ProjectionInput = CustomRenderMethodInput & {
  defaultProjectionData?: { mainMatrix?: ArrayLike<number> };
  matrix?: ArrayLike<number>;
};

function standardMaterial(
  color: number,
  roughness = 0.82,
  metalness = 0.08,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function emissiveMaterial(color: number, intensity: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.55,
  });
}

function addAvatarHalo(group: THREE.Group, radius: number): void {
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(radius * 0.62, radius, 32),
    new THREE.MeshBasicMaterial({
      color: 0x39d8ff,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  halo.position.z = 0.055;
  halo.renderOrder = 3;
  group.add(halo);

  const center = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 0.6, 28),
    new THREE.MeshBasicMaterial({
      color: 0x159ee6,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  center.position.z = 0.05;
  center.renderOrder = 2;
  group.add(center);
}

function verticalCylinder(
  topRadius: number,
  bottomRadius: number,
  height: number,
  color: number,
  segments = 10,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(topRadius, bottomRadius, height, segments),
    standardMaterial(color),
  );
  mesh.rotation.x = Math.PI / 2;
  mesh.position.z = height / 2;
  return mesh;
}

function box(
  width: number,
  depth: number,
  height: number,
  color: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(width, depth, height),
    standardMaterial(color),
  );
  mesh.position.z = height / 2;
  return mesh;
}

function sphere(radius: number, color: number, detail = 10): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius, detail, Math.max(6, detail - 2)),
    standardMaterial(color),
  );
}

function registerAnimation(
  root: THREE.Object3D,
  object: THREE.Object3D,
  phase: number,
  amplitude: number,
  axis: AnimatedPart["axis"] = "x",
  motion: AnimatedPart["motion"] = "swing",
): void {
  const parts = (root.userData.animatedParts ||= []) as AnimatedPart[];
  parts.push({ object, phase, amplitude, axis, motion });
}

function createTree(palm = false): THREE.Group {
  const group = new THREE.Group();
  group.add(
    verticalCylinder(
      palm ? 0.12 : 0.16,
      palm ? 0.2 : 0.24,
      palm ? 4.5 : 3.1,
      0x896746,
    ),
  );

  if (palm) {
    for (let index = 0; index < 8; index += 1) {
      const angle = (index / 8) * Math.PI * 2;
      const leaf = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.13, 1.35, 3, 6),
        standardMaterial(index % 2 ? 0x3f9b59 : 0x4daa62),
      );
      leaf.rotation.z = Math.PI / 2;
      leaf.rotation.y = angle;
      leaf.position.set(Math.cos(angle) * 0.65, Math.sin(angle) * 0.65, 4.35);
      group.add(leaf);
    }
  } else {
    const firstCrown = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.35, 1),
      standardMaterial(0x4da761),
    );
    firstCrown.scale.set(1.15, 0.95, 0.9);
    firstCrown.position.z = 3.4;
    group.add(firstCrown);

    const secondCrown = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.9, 1),
      standardMaterial(0x5ab56d),
    );
    secondCrown.position.set(0.65, -0.2, 3.55);
    group.add(secondCrown);
  }
  return group;
}

function createStreetLight(): THREE.Group {
  const group = new THREE.Group();
  group.add(verticalCylinder(0.07, 0.11, 6.1, 0x67727c));

  const arm = box(0.1, 1.5, 0.12, 0x67727c);
  arm.position.set(0, 0.65, 5.95);
  group.add(arm);

  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 8, 6),
    emissiveMaterial(0xf5d58e, 0.55),
  );
  lamp.position.set(0, 1.38, 5.85);
  group.add(lamp);
  return group;
}

function createTrafficSignal(): THREE.Group {
  const group = new THREE.Group();
  group.add(verticalCylinder(0.08, 0.12, 4.6, 0x505a63));

  const housing = box(0.46, 0.34, 1.32, 0x171d23);
  housing.position.set(0, 0, 4.35);
  group.add(housing);

  [0xe84c4c, 0xf3bf3f, 0x3ecf6f].forEach((color, index) => {
    const light = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 10, 8),
      emissiveMaterial(color, index === 2 ? 0.55 : 0.15),
    );
    light.position.set(0, 0.18, 4.78 - index * 0.38);
    group.add(light);
  });
  return group;
}

function createCctv(etle = false): THREE.Group {
  const group = new THREE.Group();
  group.add(verticalCylinder(0.07, 0.11, 5.4, 0x5f6973));

  const arm = box(0.09, 1.4, 0.1, 0x5f6973);
  arm.position.set(0, 0.64, 5.25);
  group.add(arm);

  const camera = box(0.34, 0.52, 0.28, etle ? 0xd43d46 : 0x168ca7);
  camera.position.set(0, 1.32, 5.06);
  group.add(camera);

  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 0.04, 10),
    emissiveMaterial(0x8ee7ff, 0.35),
  );
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, 1.59, 5.07);
  group.add(lens);
  return group;
}

function createBusStop(): THREE.Group {
  const group = new THREE.Group();
  group.add(box(1.5, 4.2, 0.12, 0xb8c1c7));
  for (const y of [-1.8, 1.8]) {
    const pole = verticalCylinder(0.06, 0.07, 2.5, 0x616d76);
    pole.position.y = y;
    group.add(pole);
  }
  const roof = box(1.7, 4.4, 0.14, 0xb64950);
  roof.position.z = 2.45;
  group.add(roof);
  const bench = box(0.45, 2.2, 0.45, 0x8c6b4d);
  bench.position.set(-0.25, 0, 0.4);
  group.add(bench);
  return group;
}

function createBollard(): THREE.Group {
  const group = new THREE.Group();
  group.add(verticalCylinder(0.09, 0.12, 0.85, 0x69747d));
  const stripe = verticalCylinder(0.095, 0.095, 0.13, 0xf1d34b);
  stripe.position.z = 0.58;
  group.add(stripe);
  return group;
}

function createHydrant(): THREE.Group {
  const group = new THREE.Group();
  group.add(verticalCylinder(0.18, 0.23, 0.8, 0xd53d47));
  const top = sphere(0.2, 0xd53d47);
  top.position.z = 0.82;
  group.add(top);
  for (const x of [-0.25, 0.25]) {
    const valve = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.09, 0.16, 8),
      standardMaterial(0xc72e39),
    );
    valve.rotation.z = Math.PI / 2;
    valve.position.set(x, 0, 0.52);
    group.add(valve);
  }
  return group;
}

function createBridgePier(heightM: number): THREE.Group {
  const group = new THREE.Group();
  const height = Math.max(2.5, Math.min(30, heightM));
  group.add(verticalCylinder(0.75, 0.95, height, 0x929ba2, 14));
  const cap = box(4.2, 1, 0.45, 0xa5adb3);
  cap.position.z = height;
  group.add(cap);
  return group;
}

function createBarrier(): THREE.Group {
  const group = new THREE.Group();
  group.add(box(0.5, 0.4, 0.65, 0x6f7880));
  const arm = box(4, 0.16, 0.16, 0xf1f1ef);
  arm.position.set(1.8, 0, 0.9);
  group.add(arm);
  for (const x of [0.5, 1.5, 2.5, 3.5]) {
    const stripe = box(0.34, 0.17, 0.17, 0xd84149);
    stripe.position.set(x, 0, 0.9);
    group.add(stripe);
  }
  return group;
}

function createGuardrail(): THREE.Group {
  const group = new THREE.Group();
  for (const x of [-1.8, 0, 1.8]) {
    const post = verticalCylinder(0.055, 0.07, 0.82, 0x8f989f, 8);
    post.position.x = x;
    group.add(post);
  }
  const rail = box(4.2, 0.12, 0.28, 0xb4bbc0);
  rail.position.z = 0.72;
  group.add(rail);
  return group;
}

function createRoadwork(): THREE.Group {
  const group = new THREE.Group();
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.28, 0.85, 12),
    standardMaterial(0xf47c2e),
  );
  cone.rotation.x = Math.PI / 2;
  cone.position.z = 0.43;
  group.add(cone);
  const base = box(0.7, 0.7, 0.09, 0x31363b);
  group.add(base);
  return group;
}

function createCrossingBeacon(): THREE.Group {
  const group = new THREE.Group();
  const pole = verticalCylinder(0.04, 0.055, 2.25, 0x68737c, 8);
  group.add(pole);
  const sign = box(0.06, 0.6, 0.6, 0x247fba);
  sign.position.z = 1.9;
  group.add(sign);
  return group;
}

function createWheel(radius: number, thickness: number): THREE.Mesh {
  const wheel = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, thickness, 14),
    standardMaterial(0x20252a, 0.9, 0.02),
  );
  wheel.rotation.z = Math.PI / 2;
  return wheel;
}

function createPedestrian(): THREE.Group {
  const group = new THREE.Group();
  const torso = verticalCylinder(0.2, 0.27, 0.8, 0x1689c8);
  torso.position.z = 0.83;
  group.add(torso);

  const head = sphere(0.22, 0xe4b18a, 12);
  head.position.z = 1.78;
  group.add(head);

  for (const [x, phase] of [[-0.13, 0], [0.13, Math.PI]] as const) {
    const leg = verticalCylinder(0.07, 0.075, 0.72, 0x2d4054, 8);
    leg.position.set(x, 0, 0.35);
    group.add(leg);
    registerAnimation(group, leg, phase, 0.55, "x");
  }
  for (const [x, phase] of [[-0.31, Math.PI], [0.31, 0]] as const) {
    const arm = verticalCylinder(0.045, 0.055, 0.72, 0xe4b18a, 8);
    arm.position.set(x, 0, 1.05);
    group.add(arm);
    registerAnimation(group, arm, phase, 0.48, "x");
  }
  return group;
}

function createBicycle(motorcycle: boolean): THREE.Group {
  const group = new THREE.Group();
  const wheelRadius = motorcycle ? 0.38 : 0.34;
  for (const y of [-0.68, 0.68]) {
    const wheel = motorcycle
      ? createWheel(wheelRadius, 0.13)
      : new THREE.Mesh(
          new THREE.TorusGeometry(wheelRadius, 0.035, 7, 18),
          standardMaterial(0x20252a),
        );
    if (!motorcycle) wheel.rotation.y = Math.PI / 2;
    wheel.position.set(0, y, wheelRadius);
    group.add(wheel);
    registerAnimation(group, wheel, 0, 1.8, "x", "spin");
  }

  const body = box(
    motorcycle ? 0.54 : 0.12,
    1.12,
    motorcycle ? 0.45 : 0.12,
    motorcycle ? 0x1489c8 : 0x2c9d67,
  );
  body.position.z = motorcycle ? 0.57 : 0.47;
  group.add(body);

  const rider = verticalCylinder(0.13, 0.18, 0.72, 0x1689c8, 9);
  rider.position.z = 0.78;
  group.add(rider);
  const head = sphere(0.17, 0xe4b18a, 10);
  head.position.z = 1.55;
  group.add(head);
  return group;
}

function createVehicle(truck: boolean): THREE.Group {
  const group = new THREE.Group();
  const length = truck ? 5.6 : 3.8;
  const width = truck ? 2.25 : 1.85;
  const bodyHeight = truck ? 2.2 : 0.78;
  const body = box(width, length, bodyHeight, truck ? 0xf0a23c : 0x168bd0);
  body.position.z = bodyHeight / 2 + 0.38;
  group.add(body);

  const cabin = box(
    width * 0.9,
    truck ? 1.5 : 1.55,
    truck ? 1.45 : 0.82,
    truck ? 0xe1842c : 0x0d6fae,
  );
  cabin.position.set(0, length * 0.25, truck ? 1.45 : 1.16);
  group.add(cabin);

  const windscreen = box(width * 0.72, 0.05, truck ? 0.6 : 0.42, 0xa9d8eb);
  windscreen.position.set(0, length * 0.25 + (truck ? 0.77 : 0.8), truck ? 1.65 : 1.38);
  group.add(windscreen);

  for (const x of [-width * 0.32, width * 0.32]) {
    const headlight = new THREE.Mesh(
      new THREE.SphereGeometry(truck ? 0.12 : 0.09, 8, 6),
      emissiveMaterial(0xffedb0, 0.75),
    );
    headlight.position.set(x, length / 2 + 0.035, truck ? 0.78 : 0.7);
    group.add(headlight);
  }

  const axlePositions = truck ? [-2, 0.9, 2] : [-1.15, 1.15];
  for (const y of axlePositions) {
    for (const x of [-width / 2, width / 2]) {
      const wheel = createWheel(truck ? 0.45 : 0.34, 0.2);
      wheel.position.set(x, y, truck ? 0.45 : 0.34);
      group.add(wheel);
      registerAnimation(group, wheel, 0, 1.8, "x", "spin");
    }
  }
  return group;
}

function createAvatar(mode: NavigationMode): THREE.Group {
  const avatarKind = MODE_PROFILES[mode].avatar;
  let avatar: THREE.Group;
  switch (avatarKind) {
    case "pedestrian": avatar = createPedestrian(); break;
    case "bicycle": avatar = createBicycle(false); break;
    case "motorcycle": avatar = createBicycle(true); break;
    case "truck": avatar = createVehicle(true); break;
    default: avatar = createVehicle(false); break;
  }
  addAvatarHalo(
    avatar,
    avatarKind === "pedestrian" ? 0.72 : avatarKind === "bicycle" ? 0.92 : 1.38,
  );
  avatar.scale.setScalar(avatarKind === "pedestrian" ? 1.12 : 1.06);
  return avatar;
}

function modelForOrnament(ornament: Ornament3D): THREE.Group {
  switch (ornament.kind) {
    case "tree": return createTree(false);
    case "palm": return createTree(true);
    case "street-light": return createStreetLight();
    case "traffic-signal": return createTrafficSignal();
    case "cctv": return createCctv(false);
    case "etle":
    case "speed-camera": return createCctv(true);
    case "bus-stop": return createBusStop();
    case "hydrant": return createHydrant();
    case "bridge-pier": return createBridgePier(Number(ornament.metadata?.heightM || 5));
    case "barrier": return createBarrier();
    case "guardrail": return createGuardrail();
    case "roadwork": return createRoadwork();
    case "crossing": return createCrossingBeacon();
    default: return createBollard();
  }
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material.dispose();
  });
}

function clearAndDispose(group: THREE.Group): void {
  for (const child of group.children.slice()) {
    group.remove(child);
    disposeObject(child);
  }
}

function normalizeBearing(value: number): number {
  return ((value % 360) + 360) % 360;
}

function interpolateBearing(current: number, target: number, amount: number): number {
  const difference = ((target - current + 540) % 360) - 180;
  return normalizeBearing(current + difference * amount);
}

/**
 * MapLibre custom layer for meter-scaled procedural objects. The layer contains
 * no remote model dependency: an empty/failed Overpass response simply renders
 * an empty ornament group while the navigation basemap and route remain usable.
 */
export class ThreeOrnamentsLayer implements CustomLayerInterface {
  readonly id = "its-navigation-3d-models";
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private map: MapLibreMap | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly camera = new THREE.Camera();
  private readonly scene = new THREE.Scene();
  private readonly world = new THREE.Group();
  private readonly avatar = new THREE.Group();
  private avatarVisual = new THREE.Group();
  private avatarMode: NavigationMode = "car";
  private origin: LngLat = [0, 0];
  private originIsSet = false;
  private transform = { x: 0, y: 0, z: 0, scale: 1 };
  private avatarCoordinate: LngLat | null = null;
  private avatarTarget = new THREE.Vector3();
  private avatarBearing = 0;
  private avatarTargetBearing = 0;
  private animationUntil = 0;
  private lastFrameAt = 0;
  private layerVisible = true;
  private lightingInstalled = false;

  onAdd(
    map: MapLibreMap,
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    this.map = map;
    if (!this.lightingInstalled) {
      this.scene.add(new THREE.HemisphereLight(0xffffff, 0x7f96a6, 1.65));

      const keyLight = new THREE.DirectionalLight(0xffffff, 2.25);
      keyLight.position.set(-50, -70, 120);
      this.scene.add(keyLight);

      const fillLight = new THREE.DirectionalLight(0xbfe6ff, 1.05);
      fillLight.position.set(80, 40, 65);
      this.scene.add(fillLight);
      this.lightingInstalled = true;
    }
    this.scene.add(this.world);
    this.scene.add(this.avatar);

    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl,
      antialias: true,
      alpha: true,
    });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.setAvatarMode(this.avatarMode);
    this.avatar.visible = this.layerVisible && Boolean(this.avatarCoordinate);
  }

  onRemove(): void {
    clearAndDispose(this.world);
    clearAndDispose(this.avatarVisual);
    this.renderer?.dispose();
    this.renderer = null;
    this.map = null;
  }

  setOrigin(origin: LngLat): void {
    if (!Number.isFinite(origin[0]) || !Number.isFinite(origin[1])) return;
    this.origin = [origin[0], origin[1]];
    this.originIsSet = true;
    const mercator = maplibregl.MercatorCoordinate.fromLngLat(this.origin, 0);
    this.transform = {
      x: mercator.x,
      y: mercator.y,
      z: mercator.z,
      scale: mercator.meterInMercatorCoordinateUnits(),
    };

    for (const object of this.world.children) {
      const coordinate = object.userData.coordinate as LngLat | undefined;
      const altitudeM = Number(object.userData.altitudeM || 0);
      if (coordinate) object.position.copy(this.localPosition(coordinate, altitudeM));
    }
    if (this.avatarCoordinate) {
      this.avatarTarget.copy(this.localPosition(this.avatarCoordinate, 0.08));
      this.avatar.position.copy(this.avatarTarget);
    }
    this.map?.triggerRepaint();
  }

  private localPosition(coordinate: LngLat, altitudeM = 0): THREE.Vector3 {
    const origin = maplibregl.MercatorCoordinate.fromLngLat(this.origin, 0);
    const target = maplibregl.MercatorCoordinate.fromLngLat(coordinate, altitudeM);
    const scale = origin.meterInMercatorCoordinateUnits();
    return new THREE.Vector3(
      (target.x - origin.x) / scale,
      -(target.y - origin.y) / scale,
      altitudeM,
    );
  }

  setOrnaments(origin: LngLat, ornaments: Ornament3D[]): void {
    clearAndDispose(this.world);
    this.setOrigin(origin);

    const valid = ornaments
      .filter(
        (ornament) =>
          Number.isFinite(ornament.coordinate?.[0]) && Number.isFinite(ornament.coordinate?.[1]),
      )
      .sort(
        (first, second) =>
          (second.priority || 0) - (first.priority || 0) || first.id.localeCompare(second.id),
      )
      .slice(0, 2_000);

    for (const ornament of valid) {
      const object = modelForOrnament(ornament);
      const altitudeM = Number.isFinite(ornament.altitudeM) ? ornament.altitudeM || 0 : 0;
      object.position.copy(this.localPosition(ornament.coordinate, altitudeM));
      object.rotation.z = -(normalizeBearing(ornament.bearing || 0) * Math.PI) / 180;
      object.scale.setScalar(Math.max(0.2, Math.min(4, ornament.scale || 1)));
      object.userData.coordinate = ornament.coordinate;
      object.userData.altitudeM = altitudeM;
      object.userData.priority = ornament.priority || 0;
      object.userData.kind = ornament.kind;
      this.world.add(object);
    }

    this.updateLevelOfDetail();
    this.map?.triggerRepaint();
  }

  setAvatarMode(mode: NavigationMode): void {
    this.avatarMode = mode;
    this.avatar.remove(this.avatarVisual);
    clearAndDispose(this.avatarVisual);
    this.avatarVisual = createAvatar(mode);
    this.avatar.add(this.avatarVisual);
    this.animationUntil = performance.now() + 450;
    this.map?.triggerRepaint();
  }

  updateAvatar(coordinate: LngLat, bearing: number): void {
    if (!Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) return;
    if (!this.originIsSet) this.setOrigin(coordinate);

    this.avatarCoordinate = [coordinate[0], coordinate[1]];
    this.avatarTarget.copy(this.localPosition(this.avatarCoordinate, 0.08));
    this.avatarTargetBearing = normalizeBearing(Number.isFinite(bearing) ? bearing : 0);
    if (!this.avatar.visible || this.avatar.position.lengthSq() === 0) {
      this.avatar.position.copy(this.avatarTarget);
      this.avatarBearing = this.avatarTargetBearing;
    }
    this.avatar.visible = this.layerVisible;
    this.animationUntil = performance.now() + 1_800;
    this.map?.triggerRepaint();
  }

  setVisible(visible: boolean): void {
    this.layerVisible = visible;
    this.world.visible = visible;
    this.avatar.visible = visible && Boolean(this.avatarCoordinate);
    this.map?.triggerRepaint();
  }

  clear(): void {
    clearAndDispose(this.world);
    this.avatarCoordinate = null;
    this.avatar.visible = false;
    this.map?.triggerRepaint();
  }

  private updateLevelOfDetail(): void {
    const zoom = this.map?.getZoom() || 18;
    const budget =
      zoom < 14 ? 24 : zoom < 16 ? 72 : zoom < 18 ? 220 : zoom < 20 ? 650 : 2_000;
    this.world.children.forEach((object, index) => {
      const priority = Number(object.userData.priority || 0);
      object.visible = index < budget || priority >= 88;
    });
  }

  private animateAvatar(time: number): boolean {
    if (!this.avatarCoordinate || !this.avatar.visible) return false;
    const deltaSeconds = Math.min(0.1, Math.max(0, (time - this.lastFrameAt) / 1_000));
    const positionAmount = 1 - Math.exp(-12 * deltaSeconds);
    const bearingAmount = 1 - Math.exp(-14 * deltaSeconds);
    this.avatar.position.lerp(this.avatarTarget, positionAmount);
    this.avatarBearing = interpolateBearing(
      this.avatarBearing,
      this.avatarTargetBearing,
      bearingAmount,
    );
    this.avatar.rotation.z = -(this.avatarBearing * Math.PI) / 180;

    const parts = (this.avatarVisual.userData.animatedParts || []) as AnimatedPart[];
    const moving = time < this.animationUntil;
    for (const part of parts) {
      if (part.motion === "spin") {
        if (moving) part.object.rotation[part.axis] = time * 0.008 * part.amplitude + part.phase;
      } else {
        part.object.rotation[part.axis] = moving
          ? Math.sin(time * 0.009 + part.phase) * part.amplitude
          : 0;
      }
    }
    if (this.avatarMode === "walk" && moving) {
      this.avatarVisual.position.z = 0.035 + Math.abs(Math.sin(time * 0.009)) * 0.055;
    } else {
      this.avatarVisual.position.z = 0;
    }

    const positionMoving = this.avatar.position.distanceToSquared(this.avatarTarget) > 0.0001;
    const bearingDifference = Math.abs(
      ((this.avatarTargetBearing - this.avatarBearing + 540) % 360) - 180,
    );
    return moving || positionMoving || bearingDifference > 0.15;
  }

  render(
    _gl: WebGLRenderingContext | WebGL2RenderingContext,
    input: CustomRenderMethodInput,
  ): void {
    if (!this.renderer || !this.originIsSet) return;
    const args = input as ProjectionInput;
    const projectionMatrix =
      args.defaultProjectionData?.mainMatrix || args.modelViewProjectionMatrix || args.matrix;
    if (!projectionMatrix) return;

    const projection = new THREE.Matrix4().fromArray(projectionMatrix);
    const localTransform = new THREE.Matrix4()
      .makeTranslation(this.transform.x, this.transform.y, this.transform.z)
      .scale(new THREE.Vector3(this.transform.scale, -this.transform.scale, this.transform.scale));
    this.camera.projectionMatrix.copy(projection).multiply(localTransform);

    const now = performance.now();
    this.updateLevelOfDetail();
    const animating = this.animateAvatar(now);
    this.lastFrameAt = now;

    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    this.renderer.resetState();
    if (animating) this.map?.triggerRepaint();
  }
}
