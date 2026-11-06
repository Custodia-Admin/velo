import * as Cesium from 'cesium';
import {
  drawnGroundHeight,
  fallbackSceneEle,
  photorealGroundShown,
  sampleGroundHeight,
  sceneEle,
  sceneFinestTerrain,
  sceneGroundHeight,
  withMeshReadCache,
} from '@/lib/cesiumUtils';
import { type AvatarColors, DEFAULT_AVATAR_COLORS } from '@/lib/avatarConfig';
import type { FinestTerrain } from '@/lib/finestTerrain';
import type { RiderPosition } from '@/lib/physics';

export type { AvatarColors } from '@/lib/avatarConfig';

/**
 * Procedural rider avatar — a stylized low-poly cyclist assembled from Cesium
 * primitives (no external 3D assets, so it works offline / in the PWA).
 *
 * Body-local frame: origin on the ground between the wheels,
 *   +X = rider's right, +Y = forward (travel direction), +Z = up.
 * Every part is positioned in that frame, then the whole rig is placed on the
 * globe via a heading/pitch/roll transform so the bike leans into corners,
 * pitches with the gradient, and points along the route.
 *
 * Animation:
 *   1. Pedaling legs alternate around the bottom bracket at cadence frequency.
 *   2. Wheels spin with ground speed (radius 0.34 m).
 *   3. Body leans into corners proportional to centripetal acceleration, smoothed.
 *   4. Hand positions shift by rider posture (hoods / tops / drops).
 *   5. Head yaws ±5° toward the direction of heading change.
 *   6. Climb-mode (grade > 8 %): body tilts forward 5° and hips sway at cadence.
 * All driven from `update()` once per frame; geometry is built once, only
 * the parts' model matrices change.
 *
 * raised geometry fidelity — segmented limbs, multi-style helmets,
 * glasses, water bottle, 4-cross spoke pattern, brake rotors, PBR-like materials,
 * and sweat/effort shading via setAvatarEffortLevel().
 */

// ---- Appearance -----------------------------------------------------------

type ColorRole = keyof AvatarColors;

/** Helmet geometry style. */
export type HelmetStyle = 'road' | 'aero' | 'climbing';

/**
 * Bike frame geometry variants.
 * drives wheel depth, tyre width, handlebar geometry, frame details.
 */
export type BikeShape =
  | 'roadAero'       // deep rims, aero bars, thick top tube
  | 'roadClimber'    // shallow rims, upright hoods, thin tubes
  | 'roadAllRounder' // standard road (default)
  | 'tt'             // aero bars + skinny clip-on extensions, disc-style rear
  | 'gravel'         // drop bars, wider tyres
  | 'fixie'          // drop bars, no derailleur box
  | 'mtbHardtail'    // flat bars, fat tyres, suspension fork tubes
  | 'mtbFullSus'     // flat bars, fat tyres, both suspension
  | 'ebike'          // battery on down tube
  | 'vintage';       // steel round tubes, no derailleur detail

/**
 * Jersey / kit colour pattern.
 * changes jersey primitives to show bands, dots, or splits.
 */
export type KitPattern =
  | 'solid'          // current behaviour (default)
  | 'polka'          // red dots on white — KOM polka dot
  | 'rainbow'        // 5 UCI bands across chest
  | 'yellowLeader'   // solid yellow, black cuff accents
  | 'sprinterGreen'  // solid green, white sleeves
  | 'stripes'        // horizontal alternating stripes
  | 'fluoro'         // bright primary + darker hem accent
  | 'teamReplica';   // 3-colour chest/mid/hem split

/** Per-kit accent colours forwarded from GearItem.accentColors. */
export interface KitAccent {
  primary: string;
  secondary?: string;
  tertiary?: string;
}

/**
 * Shoe geometry style.
 * alters sole width, cleat hint, and colour accent.
 */
export type ShoeStyle = 'roadClip' | 'gravel' | 'mtbClip' | 'vintage' | 'fluoro';

/**
 * Options for createAvatar(). All fields are optional — existing call sites
 * that pass only a viewer continue to work with sensible defaults.
 */
export interface AvatarOptions {
  /** Initial colors. Can be changed later via setColors(). */
  colors?: AvatarColors;
  /** Rider's default handlebar position. Defaults to 'hoods'. */
  posture?: RiderPosition;
  /** Helmet shell shape. Defaults to 'road'. */
  helmetStyle?: HelmetStyle;
  /** Whether to render sunglasses lenses in front of the eyes. */
  hasGlasses?: boolean;
  /** Whether to render a water bottle on the down tube. */
  hasBottle?: boolean;
  /**
   * Bike frame geometry variant
   * Defaults to 'roadAllRounder' when omitted.
   */
  bikeShape?: BikeShape;
  /**
   * Jersey / kit colour pattern
   * Defaults to 'solid' when omitted.
   */
  kitPattern?: KitPattern;
  /**
   * Accent colours for multi-colour kit patterns
   * When omitted, the base accent colour is reused.
   */
  kitAccent?: KitAccent;
  /**
   * Shoe geometry style
   * Defaults to 'roadClip' when omitted.
   */
  shoeStyle?: ShoeStyle;
}

export interface AvatarUpdate {
  /** Ground position the rider sits on. */
  lon: number;
  lat: number;
  ele: number;
  /** Heading, radians clockwise from north. */
  heading: number;
  /** Speed in m/s — drives wheel spin. */
  speed: number;
  /** Cadence in rpm — drives pedalling. 0 ⇒ estimate from speed. */
  cadence: number;
  /** Grade in percent — drives body pitch + climb-mode. */
  grade: number;
  /** Seconds since the previous update — integrates the animation. */
  dt: number;
  /** Rider's handlebar position — shapes hand/arm placement. Optional; defaults to 'hoods'. */
  riderPosition?: RiderPosition;
}

/** Handle returned by createAvatar — used by setAvatarEffortLevel. */
export type AvatarHandle = ReturnType<typeof createAvatar>;

export interface Avatar {
  /**
   * One Primitive per part: geometry built once, only the model matrix
   * changes per frame.
   */
  parts: Cesium.Primitive[];
  /** Show or hide the whole rider (e.g. a ghost that hasn't started). */
  setShow: (show: boolean) => void;
  update: (u: AvatarUpdate) => void;
  /** Smoothed scene height the rider sits at (null before the first update). */
  groundEle: () => number | null;
  /**
   * The photoreal mesh is loaded under the rider at road level (the last
   * reading was the road, or something standing over a road the rider holds).
   * False on the globe, with no mesh tile, or with only a coarse floating tile.
   */
  meshGround: () => boolean;
  /**
   * What the rider stands on (see {@link GroundKind}): what the globe and the
   * painted road follow (renderers/cesium/globeGate GroundGate).
   */
  ground: () => GroundKind;
  setColors: (c: AvatarColors) => void;
  dispose: () => void;
  /** Internal: current skin color including effort tint. Set by setAvatarEffortLevel. */
  _effortLevel: number;
}

// ---- Small vector / quaternion helpers ------------------------------------

type V3 = readonly [number, number, number];

const v3 = (x: number, y: number, z: number): V3 => [x, y, z];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mid = (a: V3, b: V3): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);

/** Quaternion rotating the +Z axis (a cylinder/box's long axis) onto `dir`. */
function quatZTo(dir: V3): Cesium.Quaternion {
  const l = len(dir) || 1;
  const d = v3(dir[0] / l, dir[1] / l, dir[2] / l);
  const dot = d[2];
  if (dot > 0.99999) return Cesium.Quaternion.clone(Cesium.Quaternion.IDENTITY, new Cesium.Quaternion());
  if (dot < -0.99999) {
    return Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_X, Math.PI, new Cesium.Quaternion());
  }
  // axis = normalize(Z × d)
  const axis = new Cesium.Cartesian3(-d[1], d[0], 0);
  Cesium.Cartesian3.normalize(axis, axis);
  return Cesium.Quaternion.fromAxisAngle(axis, Math.acos(dot), new Cesium.Quaternion());
}

const QUAT_IDENTITY = Cesium.Quaternion.IDENTITY;

/** Rotation about the body +X axis (wheel axle / pedalling plane normal). */
function quatRotX(angle: number): Cesium.Quaternion {
  return Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_X, angle, new Cesium.Quaternion());
}

/** Rotation about the body +Z axis (yaw — head turning). */
function quatRotZ(angle: number): Cesium.Quaternion {
  return Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_Z, angle, new Cesium.Quaternion());
}

// ---- Part model -----------------------------------------------------------

type GeomKind = 'box' | 'cylinder' | 'ellipsoid';

interface PartDynamic {
  /** Body-local position. */
  pos: V3;
  /** Body-local orientation. */
  rot: Cesium.Quaternion;
}

interface PartSpec {
  name: string;
  kind: GeomKind;
  /** For box: full dimensions. For cylinder: [radius, length, radius]. For ellipsoid: radii. */
  dims: V3;
  role: ColorRole;
  /** Static body-local placement, or a per-frame function for animated parts. */
  place: PartDynamic | ((d: RigDynamics) => PartDynamic);
  /**
   * Optional alpha override (0–1). Used for glass/transparent parts.
   * Applied at entity creation time — not updated per frame.
   */
  alpha?: number;
}

/** Per-frame animation state shared by the dynamic parts. */
interface RigDynamics {
  wheelAngle: number;
  crankAngle: number;
  /** Head yaw offset, radians — positive toward turn direction. */
  headYaw: number;
  /** Hip sway oscillation angle during climb-mode. */
  climbSway: number;
  /** Whether we are in climb-out-of-saddle mode (grade > 8 %). */
  climbing: boolean;
  /** Rider handlebar posture — drives hand / forearm positions. */
  riderPosition: RiderPosition;
}

// ---- Bike + rider geometry (all metres, body-local) -----------------------
//
// The landmarks are the world renderer's GLB rider (scripts/gen-rider-glb.mjs,
// +X forward / +Y up there; here +Y forward / +Z up), so photoreal draws an
// adult rider of the same size: helmet top 1.645 m over the ground, saddle at
// 0.97 m, hips at 1.05 m. An older, smaller rig (saddle 0.71 m, helmet top
// 1.36 m) drew the photoreal rider 22–55 px shorter than the world rider at
// the same camera (src/renderers/riderFraming.test.ts holds them together).

/**
 * The landmarks shared with the GLB's RIG (body-local [forward, up], metres):
 * tests pin each to scripts/gen-rider-glb.mjs.
 */
export const AVATAR_RIG = {
  wheelRadius: 0.34,
  /** Hubs ahead of / behind the origin. */
  halfWheelbase: 0.5,
  bb: [-0.09, 0.27] as const,
  crankLength: 0.1725,
  hip: [-0.27, 1.05] as const,
  thigh: 0.46,
  /** Knee to pedal: the GLB's shin (0.46 m) plus its ankle over the pedal. */
  shin: 0.53,
  /** Helmet shell centre (the road shell's top is 0.105 m above it). */
  helmet: [0.30, 1.545] as const,
};

const WHEEL_R = AVATAR_RIG.wheelRadius;
const REAR_HUB = v3(0, -AVATAR_RIG.halfWheelbase, WHEEL_R);
const FRONT_HUB = v3(0, AVATAR_RIG.halfWheelbase, WHEEL_R);
const BB = v3(0, AVATAR_RIG.bb[0], AVATAR_RIG.bb[1]); // bottom bracket / crank centre
const HEAD_TOP = v3(0, 0.37, 0.86); // top of the head tube (the stem starts here)
const HEAD_BOTTOM = v3(0, 0.41, 0.70); // bottom of the head tube (fork + down tube)
const SADDLE_J = v3(0, -0.246, 0.797); // seat-tube / top-tube junction
const SADDLE = v3(0, -0.277, 0.97);
const BAR = v3(0, 0.48, 0.90); // stem end, bar tops
const CRANK_R = AVATAR_RIG.crankLength;
const THIGH_L = AVATAR_RIG.thigh;
const SHIN_L = AVATAR_RIG.shin;

// Derived geometry constants reused by multiple detail parts
const SEATPOST_TOP = v3(0, -0.287, 0.945);
const SEATPOST_BOT = SADDLE_J;
const DROP_LEFT  = v3(-0.21, 0.48, 0.90);
const DROP_RIGHT = v3( 0.21, 0.48, 0.90);
const HOOD_LEFT  = v3(-0.21, 0.46, 0.86);
const HOOD_RIGHT = v3( 0.21, 0.46, 0.86);

// Hip / shoulder landmarks
const HIP_Y = AVATAR_RIG.hip[0];
const HIP_Z = AVATAR_RIG.hip[1];
const HIP_LEFT   = v3(-0.1, HIP_Y, HIP_Z);
const HIP_RIGHT  = v3( 0.1, HIP_Y, HIP_Z);
const KNEE_LEFT  = v3(-0.1, -0.12, 0.66);   // nominal resting knee (overridden by IK)
const KNEE_RIGHT = v3( 0.1, -0.12, 0.66);

/** Torso axis: pelvis to the base of the neck (leaning forward ~32°). */
const TORSO_BOT = v3(0, -0.25, 1.09);
const TORSO_TOP = v3(0, 0.20, 1.37);
const TORSO_R = 0.13;
/** Pelvis block (hips part) centre. */
const PELVIS = v3(0, -0.25, 1.06);

// Shoulder attachment points (top of torso where arms connect)
const SHOULDER_LEFT  = v3(-0.185, 0.18, 1.35);
const SHOULDER_RIGHT = v3( 0.185, 0.18, 1.35);
const ELBOW_LEFT     = v3(-0.205, 0.37, 1.13);
const ELBOW_RIGHT    = v3( 0.205, 0.37, 1.13);
/** Forearm length: elbow to wrist on the hoods. */
const FOREARM_L = 0.25;

/** Helmet shell centre (the GLB's: top 1.645 m with the road shell's 0.105 m). */
const HELMET_C = v3(0, AVATAR_RIG.helmet[0], AVATAR_RIG.helmet[1]);
/** Head centre, under the shell. */
const HEAD_C = v3(0, 0.32, 1.48);
/** A point HELMET_C + (0, dy, dz): helmet details keep their place on the shell. */
const onHelmet = (x: number, dy: number, dz: number): V3 => v3(x, HELMET_C[1] + dy, HELMET_C[2] + dz);

/** A point `t` of the way up the torso axis (0 = pelvis, 1 = neck). */
function torsoAt(t: number): V3 {
  return v3(
    0,
    TORSO_BOT[1] + (TORSO_TOP[1] - TORSO_BOT[1]) * t,
    TORSO_BOT[2] + (TORSO_TOP[2] - TORSO_BOT[2]) * t,
  );
}
/** How far ahead of the torso axis (horizontally) its front surface is. */
const TORSO_FRONT_M =
  TORSO_R / Math.sin(Math.atan2(TORSO_TOP[2] - TORSO_BOT[2], TORSO_TOP[1] - TORSO_BOT[1]));

/**
 * A point `t` of the way along the down tube (BB → head tube), `out` metres
 * off its axis on the upper side (bottle, battery).
 */
function onDownTube(t: number, out: number): V3 {
  const dy = HEAD_BOTTOM[1] - BB[1];
  const dz = HEAD_BOTTOM[2] - BB[2];
  const l = Math.hypot(dy, dz);
  return v3(0, BB[1] + dy * t - (dz / l) * out, BB[2] + dz * t + (dy / l) * out);
}

// ---- Hand positions per posture -------------------------------------------

/** Body-local hand positions for each rider posture. */
const HAND_POS: Record<RiderPosition, { left: V3; right: V3 }> = {
  hoods: {
    left:  v3(-0.21, 0.48, 0.88),
    right: v3( 0.21, 0.48, 0.88),
  },
  drops: {
    left:  v3(-0.21, 0.52, 0.80),
    right: v3( 0.21, 0.52, 0.80),
  },
  tops: {
    left:  v3(-0.10, 0.42, 0.94),
    right: v3( 0.10, 0.42, 0.94),
  },
};

/** Forearm wrist endpoints per posture (elbow stays fixed, wrist follows hand). */
const FOREARM_END: Record<RiderPosition, { left: V3; right: V3 }> = {
  hoods: { left: v3(-0.21, 0.46, 0.90), right: v3( 0.21, 0.46, 0.90) },
  drops: { left: v3(-0.21, 0.50, 0.82), right: v3( 0.21, 0.50, 0.82) },
  tops:  { left: v3(-0.10, 0.42, 0.96), right: v3( 0.10, 0.42, 0.96) },
};

// ---- Part factory functions -----------------------------------------------

/** A frame tube: a thin cylinder spanning two body-local points. */
function tube(name: string, a: V3, b: V3, radius: number, role: ColorRole): PartSpec {
  const dir = sub(b, a);
  return {
    name,
    kind: 'cylinder',
    dims: v3(radius, len(dir), radius),
    role,
    place: { pos: mid(a, b), rot: quatZTo(dir) },
  };
}

/** A pedal's body-local position for crank phase `phase`. */
function pedalPos(side: -1 | 1, crankAngle: number): V3 {
  const phase = crankAngle + (side === 1 ? Math.PI : 0);
  return v3(side * 0.085, BB[1] + Math.sin(phase) * CRANK_R, BB[2] - Math.cos(phase) * CRANK_R);
}

/** A crank arm from the bottom bracket to a pedal. */
function crankPart(name: string, side: -1 | 1): PartSpec {
  return {
    name,
    kind: 'cylinder',
    dims: v3(0.02, CRANK_R, 0.02),
    role: 'accent',
    place: (d) => {
      const bb = v3(side * 0.085, BB[1], BB[2]);
      const pedal = pedalPos(side, d.crankAngle);
      return { pos: mid(bb, pedal), rot: quatZTo(sub(pedal, bb)) };
    },
  };
}

/**
 * 2-bone IK leg solver — returns hip, knee, and pedal positions.
 * Shared by thigh, shin, and knee-joint parts.
 */
function solveIK(side: -1 | 1, crankAngle: number): { hip: V3; knee: V3; pedal: V3 } {
  const hip = v3(side * 0.1, HIP_Y, HIP_Z);
  const pedal = pedalPos(side, crankAngle);
  const ay = pedal[1] - hip[1];
  const az = pedal[2] - hip[2];
  let dist = Math.hypot(ay, az);
  dist = Math.min(THIGH_L + SHIN_L - 0.002, Math.max(Math.abs(THIGH_L - SHIN_L) + 0.002, dist));
  const base = Math.atan2(az, ay);
  const hipAng = Math.acos(
    Math.min(1, Math.max(-1, (THIGH_L * THIGH_L + dist * dist - SHIN_L * SHIN_L) / (2 * THIGH_L * dist))),
  );
  const thighAng = base + hipAng;
  const knee = v3(hip[0], hip[1] + Math.cos(thighAng) * THIGH_L, hip[2] + Math.sin(thighAng) * THIGH_L);
  return { hip, knee, pedal };
}

/** Thigh segment — hip to knee. */
function thighPart(name: string, side: -1 | 1): PartSpec {
  return {
    name,
    kind: 'cylinder',
    dims: v3(0.055, THIGH_L, 0.055),
    role: 'kit',
    place: (d) => {
      const { hip, knee } = solveIK(side, d.crankAngle);
      return { pos: mid(hip, knee), rot: quatZTo(sub(knee, hip)) };
    },
  };
}

/** Shin / calf segment — knee to ankle (pedal level). */
function shinPart(name: string, side: -1 | 1): PartSpec {
  return {
    name,
    kind: 'cylinder',
    dims: v3(0.042, SHIN_L, 0.042),
    role: 'skin',
    place: (d) => {
      const { knee, pedal } = solveIK(side, d.crankAngle);
      return { pos: mid(knee, pedal), rot: quatZTo(sub(pedal, knee)) };
    },
  };
}

/** Knee-cap joint — small sphere at the knee. */
function kneePart(name: string, side: -1 | 1): PartSpec {
  return {
    name,
    kind: 'ellipsoid',
    dims: v3(0.062, 0.062, 0.062),
    role: 'skin',
    place: (d) => {
      const { knee } = solveIK(side, d.crankAngle);
      return { pos: knee, rot: QUAT_IDENTITY };
    },
  };
}

/** Ankle/foot — slightly wider box at pedal, follows crank. */
function anklePart(name: string, side: -1 | 1): PartSpec {
  return {
    name,
    kind: 'ellipsoid',
    dims: v3(0.048, 0.048, 0.042),
    role: 'skin',
    place: (d) => ({ pos: pedalPos(side, d.crankAngle), rot: QUAT_IDENTITY }),
  };
}

/** Cycling shoe — follows pedal position. Geometry varies by shoeStyle. */
function shoePart(name: string, side: -1 | 1, style: ShoeStyle): PartSpec {
  // Sole dimensions: width (X), length (Y), height (Z)
  const soleDims: Record<ShoeStyle, V3> = {
    roadClip: v3(0.082, 0.20, 0.052),   // narrow, stiff
    gravel:   v3(0.090, 0.20, 0.058),   // slightly wider, walkable
    mtbClip:  v3(0.098, 0.21, 0.062),   // widest, grippiest
    vintage:  v3(0.086, 0.20, 0.056),   // leather-brown shape
    fluoro:   v3(0.082, 0.20, 0.052),   // same as road, vivid colour applied via role
  };
  const dims = soleDims[style];
  // MTB sole gets a slightly darker outsole hint via 'wheel' role (near-black).
  // Fluoro gets 'kit' role so it picks up the bright kit primary.
  // Vintage gets 'frame' role (warm brown from frame color).
  // Road/gravel get 'accent' role as before.
  const role: ColorRole =
    style === 'mtbClip'  ? 'wheel'  :
    style === 'fluoro'   ? 'kit'    :
    style === 'vintage'  ? 'frame'  : 'accent';
  return {
    name,
    kind: 'box',
    dims,
    role,
    place: (d) => ({ pos: pedalPos(side, d.crankAngle), rot: QUAT_IDENTITY }),
  };
}

/** Cleat hint on road shoes — tiny box near the toe. Allocation-free static. */
function shoeCleatPart(name: string, side: -1 | 1): PartSpec {
  return {
    name,
    kind: 'box',
    dims: v3(0.030, 0.038, 0.012),
    role: 'wheel',
    place: (d) => {
      const base = pedalPos(side, d.crankAngle);
      return { pos: v3(base[0], base[1] + 0.065, base[2] - 0.032), rot: QUAT_IDENTITY };
    },
  };
}

/** MTB outsole grip blocks — two small bumps under the sole. */
function mtbGripPart(name: string, side: -1 | 1, yOffset: number): PartSpec {
  return {
    name,
    kind: 'box',
    dims: v3(0.092, 0.030, 0.016),
    role: 'accent',
    place: (d) => {
      const base = pedalPos(side, d.crankAngle);
      return { pos: v3(base[0], base[1] + yOffset, base[2] - 0.042), rot: QUAT_IDENTITY };
    },
  };
}

/** Shoulder joint sphere — static, at top of torso where arm begins. */
function shoulderPart(name: string, side: 'left' | 'right'): PartSpec {
  const pos = side === 'left' ? SHOULDER_LEFT : SHOULDER_RIGHT;
  return {
    name,
    kind: 'ellipsoid',
    dims: v3(0.055, 0.055, 0.055),
    role: 'kit',
    place: { pos, rot: QUAT_IDENTITY },
  };
}

/** Elbow joint sphere — static. */
function elbowPart(name: string, side: 'left' | 'right'): PartSpec {
  const pos = side === 'left' ? ELBOW_LEFT : ELBOW_RIGHT;
  return {
    name,
    kind: 'ellipsoid',
    dims: v3(0.040, 0.040, 0.040),
    role: 'skin',
    place: { pos, rot: QUAT_IDENTITY },
  };
}

/** Hand — position follows rider posture (hoods / drops / tops). */
function handPart(name: string, side: 'left' | 'right'): PartSpec {
  return {
    name,
    kind: 'ellipsoid',
    dims: v3(0.040, 0.055, 0.038),
    role: 'skin',
    place: (d) => ({ pos: HAND_POS[d.riderPosition][side], rot: QUAT_IDENTITY }),
  };
}

/** Forearm — wrist follows posture, elbow is fixed. */
function forearmPart(name: string, side: 'left' | 'right'): PartSpec {
  const elbow = side === 'left' ? ELBOW_LEFT : ELBOW_RIGHT;
  return {
    name,
    kind: 'cylinder',
    dims: v3(0.033, FOREARM_L, 0.033),
    role: 'skin',
    place: (d) => {
      const wrist = FOREARM_END[d.riderPosition][side];
      return { pos: mid(elbow, wrist), rot: quatZTo(sub(wrist, elbow)) };
    },
  };
}

/** Head — yaws ±5° toward turn direction. */
function headPart(): PartSpec {
  return {
    name: 'head',
    kind: 'ellipsoid',
    dims: v3(0.10, 0.12, 0.13),
    role: 'skin',
    place: (d) => ({
      pos: HEAD_C,
      rot: d.headYaw !== 0 ? quatRotZ(d.headYaw) : QUAT_IDENTITY,
    }),
  };
}

/**
 * Helmet shell — shape differs by style:
 *   road:     short aero tail, wider vented body
 *   aero:     teardrop elongated rear
 *   climbing: rounder, taller, more vented feel
 */
function helmetShellPart(style: HelmetStyle): PartSpec {
  const dims: Record<HelmetStyle, V3> = {
    road:     v3(0.125, 0.16, 0.105),
    aero:     v3(0.118, 0.21, 0.098),   // more elongated front-to-back
    climbing: v3(0.130, 0.14, 0.115),   // taller, rounder
  };
  return {
    name: 'helmet',
    kind: 'ellipsoid',
    dims: dims[style],
    role: 'helmet',
    place: (d) => ({
      pos: HELMET_C,
      rot: d.headYaw !== 0 ? quatRotZ(d.headYaw) : QUAT_IDENTITY,
    }),
  };
}

/**
 * Helmet visor — shape/presence differs by style:
 *   aero: larger chin-guard visor
 *   road/climbing: short brim
 */
function helmetVisorPart(style: HelmetStyle): PartSpec {
  const dims: Record<HelmetStyle, V3> = {
    road:     v3(0.115, 0.055, 0.016),
    aero:     v3(0.120, 0.080, 0.020),  // larger chin area
    climbing: v3(0.105, 0.045, 0.014),  // minimal brim
  };
  /** Ahead of the shell centre. */
  const fwdOffset: Record<HelmetStyle, number> = { road: 0.12, aero: 0.14, climbing: 0.10 };
  return {
    name: 'helmet-visor',
    kind: 'box',
    dims: dims[style],
    role: 'helmet',
    place: (d) => ({
      pos: onHelmet(0, fwdOffset[style], -0.045),
      rot: d.headYaw !== 0 ? quatRotZ(d.headYaw) : QUAT_IDENTITY,
    }),
  };
}

/**
 * Helmet vent accent bar — dark horizontal slot across the mid shell.
 * Gives the visual impression of vent channels without actual gaps.
 */
function helmetVentPart(name: string, zOffset: number): PartSpec {
  return {
    name,
    kind: 'box',
    dims: v3(0.095, 0.025, 0.012),
    role: 'wheel',  // dark vent color (wheel role = near-black)
    place: (d) => ({
      pos: onHelmet(0, 0.01, -0.015 + zOffset),
      rot: d.headYaw !== 0 ? quatRotZ(d.headYaw) : QUAT_IDENTITY,
    }),
  };
}

/** Helmet retention strap — thin vertical strip under the chin. */
function helmetStrapPart(): PartSpec {
  return {
    name: 'helmet-strap',
    kind: 'box',
    dims: v3(0.008, 0.010, 0.055),
    role: 'helmet',
    place: (d) => ({
      pos: onHelmet(0, 0.05, -0.085),
      rot: d.headYaw !== 0 ? quatRotZ(d.headYaw) : QUAT_IDENTITY,
    }),
  };
}

/** Sunglasses lens — flat oval in front of the eyes. */
function glassesLensPart(name: string, xOffset: number): PartSpec {
  return {
    name,
    kind: 'ellipsoid',
    dims: v3(0.040, 0.008, 0.022),
    role: 'accent',  // tinted lens — accent color
    alpha: 0.55,
    place: (d) => ({
      pos: onHelmet(xOffset, 0.10, -0.07),
      rot: d.headYaw !== 0 ? quatRotZ(d.headYaw) : QUAT_IDENTITY,
    }),
  };
}

/** Glasses bridge bar across the nose. */
function glassesBridgePart(): PartSpec {
  return {
    name: 'glasses-bridge',
    kind: 'box',
    dims: v3(0.030, 0.006, 0.006),
    role: 'accent',
    place: (d) => ({
      pos: onHelmet(0, 0.095, -0.07),
      rot: d.headYaw !== 0 ? quatRotZ(d.headYaw) : QUAT_IDENTITY,
    }),
  };
}

/** Water bottle on the down tube — cylinder, kit color. */
function waterBottlePart(): PartSpec {
  // On top of the down tube, half way along it.
  const bottlePos = onDownTube(0.5, 0.04);
  return {
    name: 'water-bottle',
    kind: 'cylinder',
    dims: v3(0.038, 0.20, 0.038),
    role: 'kit',
    place: {
      // Align with the down-tube direction
      pos: bottlePos,
      rot: quatZTo(sub(HEAD_BOTTOM, BB)),
    },
  };
}

/** A spinning spoke bar so the wheel visibly rotates. */
function spokePart(name: string, hub: V3): PartSpec {
  return {
    name,
    kind: 'box',
    dims: v3(0.012, 0.012, WHEEL_R * 1.85),
    role: 'accent',
    place: (d) => ({ pos: hub, rot: quatRotX(d.wheelAngle) }),
  };
}

/** Second spoke cross — rotated 45° from the first for a 4-cross pattern. */
function spokeCross2(name: string, hub: V3): PartSpec {
  return {
    name,
    kind: 'box',
    dims: v3(0.012, 0.012, WHEEL_R * 1.85),
    role: 'accent',
    place: (d) => ({
      pos: hub,
      rot: Cesium.Quaternion.multiply(
        quatRotX(d.wheelAngle),
        Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_Z, Math.PI / 4, new Cesium.Quaternion()),
        new Cesium.Quaternion(),
      ),
    }),
  };
}

/** Spoke cross 3 — 90° from the first (completes the 4-cross look). */
function spokeCross3(name: string, hub: V3): PartSpec {
  return {
    name,
    kind: 'box',
    dims: v3(0.012, 0.012, WHEEL_R * 1.85),
    role: 'accent',
    place: (d) => ({
      pos: hub,
      rot: Cesium.Quaternion.multiply(
        quatRotX(d.wheelAngle),
        Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_Z, Math.PI / 2, new Cesium.Quaternion()),
        new Cesium.Quaternion(),
      ),
    }),
  };
}

/** Spoke cross 4 — 135° from the first. */
function spokeCross4(name: string, hub: V3): PartSpec {
  return {
    name,
    kind: 'box',
    dims: v3(0.012, 0.012, WHEEL_R * 1.85),
    role: 'accent',
    place: (d) => ({
      pos: hub,
      rot: Cesium.Quaternion.multiply(
        quatRotX(d.wheelAngle),
        Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_Z, (3 * Math.PI) / 4, new Cesium.Quaternion()),
        new Cesium.Quaternion(),
      ),
    }),
  };
}

/** A wheel hub — small cylinder centred on the hub, aligned with the axle (X). */
function hubPart(name: string, hub: V3): PartSpec {
  return {
    name,
    kind: 'cylinder',
    dims: v3(0.045, 0.09, 0.045),
    role: 'accent',
    place: { pos: hub, rot: quatZTo(v3(1, 0, 0)) },
  };
}

/** Brake rotor disc — thin flat disc at the hub, slightly outside the hub flange. */
function brakeRotorPart(name: string, hub: V3, side: -1 | 1): PartSpec {
  const pos = v3(hub[0] + side * 0.065, hub[1], hub[2]);
  return {
    name,
    kind: 'cylinder',
    dims: v3(0.090, 0.008, 0.090),
    role: 'accent',
    place: { pos, rot: quatZTo(v3(1, 0, 0)) },
  };
}

/**
 * Rim accent — a thin-walled ring slightly inside the tyre.
 */
function _rimAccent(name: string, hub: V3): PartSpec {
  return {
    name,
    kind: 'cylinder',
    dims: v3(WHEEL_R * 0.88, 0.025, WHEEL_R * 0.88),
    role: 'accent',
    place: { pos: hub, rot: quatZTo(v3(1, 0, 0)) },
  };
}

/** Chainring — thin disc at the bottom bracket, spins with the crank. */
function chainringPart(): PartSpec {
  return {
    name: 'chainring',
    kind: 'cylinder',
    dims: v3(0.125, 0.018, 0.125),
    role: 'accent',
    place: (d) => ({ pos: BB, rot: Cesium.Quaternion.multiply(quatZTo(v3(1, 0, 0)), quatRotX(d.crankAngle), new Cesium.Quaternion()) }),
  };
}

/** Pedal platform — follows crank angle. */
function pedalPart(name: string, side: -1 | 1): PartSpec {
  return {
    name,
    kind: 'box',
    dims: v3(0.09, 0.075, 0.016),
    role: 'accent',
    place: (d) => ({ pos: pedalPos(side, d.crankAngle), rot: QUAT_IDENTITY }),
  };
}

/** Hips — sway laterally out of the saddle on steep grades (>8 %). */
function hipsPart(): PartSpec {
  return {
    name: 'hips',
    kind: 'box',
    dims: v3(0.30, 0.22, 0.20),
    role: 'kit',
    place: (d) => {
      if (!d.climbing) return { pos: PELVIS, rot: QUAT_IDENTITY };
      const swayX = Math.sin(d.climbSway) * 0.06;
      return { pos: v3(swayX, PELVIS[1], PELVIS[2]), rot: QUAT_IDENTITY };
    },
  };
}

// ---- Bike shape geometry helpers ------------------------------

/** Rim depth multiplier and tyre width by bike shape. */
const BIKE_WHEEL_PROFILE: Record<BikeShape, { rimDepth: number; tyreWidth: number }> = {
  roadAero:       { rimDepth: 0.96, tyreWidth: 0.060 },
  roadClimber:    { rimDepth: 0.80, tyreWidth: 0.056 },
  roadAllRounder: { rimDepth: 0.88, tyreWidth: 0.060 },
  tt:             { rimDepth: 0.96, tyreWidth: 0.058 },
  gravel:         { rimDepth: 0.78, tyreWidth: 0.080 },
  fixie:          { rimDepth: 0.88, tyreWidth: 0.056 },
  mtbHardtail:    { rimDepth: 0.72, tyreWidth: 0.110 },
  mtbFullSus:     { rimDepth: 0.72, tyreWidth: 0.110 },
  ebike:          { rimDepth: 0.80, tyreWidth: 0.072 },
  vintage:        { rimDepth: 0.82, tyreWidth: 0.062 },
};

/** Frame tube radius scale — thicker for aero/TT, thinner for climber/vintage. */
const BIKE_TUBE_SCALE: Record<BikeShape, number> = {
  roadAero:       1.12,
  roadClimber:    0.88,
  roadAllRounder: 1.00,
  tt:             1.10,
  gravel:         0.96,
  fixie:          0.94,
  mtbHardtail:    1.04,
  mtbFullSus:     1.06,
  ebike:          1.10,
  vintage:        0.92,
};

/** Tyre cylinder — width varies by bike type. */
function tyrePart(name: string, hub: V3, tyreWidth: number): PartSpec {
  return {
    name,
    kind: 'cylinder',
    dims: v3(WHEEL_R, tyreWidth, WHEEL_R),
    role: 'wheel',
    place: { pos: hub, rot: quatZTo(v3(1, 0, 0)) },
  };
}

/** Rim accent with variable depth — aero bikes get a taller rim wall. */
function rimAccentShaped(name: string, hub: V3, rimDepth: number): PartSpec {
  return {
    name,
    kind: 'cylinder',
    dims: v3(WHEEL_R * rimDepth, 0.025, WHEEL_R * rimDepth),
    role: 'accent',
    place: { pos: hub, rot: quatZTo(v3(1, 0, 0)) },
  };
}

/** TT aero bar extensions — two thin forward-pointing cylinders. */
function ttBarPart(name: string, xSide: number): PartSpec {
  return {
    name,
    kind: 'cylinder',
    dims: v3(0.014, 0.22, 0.014),
    role: 'frame',
    place: { pos: v3(xSide * 0.065, BAR[1] + 0.16, BAR[2] + 0.01), rot: quatZTo(v3(0, 1, 0)) },
  };
}

/** Flat MTB/gravel bar — wide box replacing drop-bar section. */
function flatBarPart(): PartSpec {
  return {
    name: 'flat-handlebar',
    kind: 'box',
    dims: v3(0.55, 0.04, 0.038),
    role: 'frame',
    place: { pos: v3(0, BAR[1], BAR[2] + 0.02), rot: QUAT_IDENTITY },
  };
}

/** Suspension fork leg — vertical tube from steerer to wheel axle. */
function suspForkPart(name: string, xSide: number): PartSpec {
  return tube(name, v3(xSide * 0.040, HEAD_BOTTOM[1], HEAD_BOTTOM[2]),
                    v3(xSide * 0.040, FRONT_HUB[1], FRONT_HUB[2]), 0.022, 'frame');
}

/** E-bike battery box on the down tube. */
function ebikeBatteryPart(): PartSpec {
  return {
    name: 'ebike-battery',
    kind: 'box',
    dims: v3(0.065, 0.26, 0.065),
    role: 'accent',
    place: { pos: onDownTube(0.45, 0), rot: quatZTo(sub(HEAD_BOTTOM, BB)) },
  };
}

// ---- Kit pattern helpers --------------------------------------

/** Horizontal jersey band — thin box across the torso, `t` of the way up it (0 = hem). */
function jerseyBandPart(name: string, t: number, role: ColorRole): PartSpec {
  return {
    name,
    kind: 'box',
    dims: v3(0.30, 0.22, 0.065),
    role,
    place: { pos: torsoAt(t), rot: QUAT_IDENTITY },
  };
}

/** Polka dot — small ellipsoid on the jersey's front, `x` right of centre and `t` of the way up. */
function polkaDotPart(name: string, x: number, t: number): PartSpec {
  const axis = torsoAt(t);
  const across = Math.sqrt(Math.max(0, TORSO_R * TORSO_R - x * x)) / TORSO_R;
  return {
    name,
    kind: 'ellipsoid',
    dims: v3(0.028, 0.012, 0.028),
    role: 'accent',
    place: { pos: v3(x, axis[1] + TORSO_FRONT_M * across, axis[2]), rot: QUAT_IDENTITY },
  };
}

// ---- Per-instance part list builder ----------------------------------------

/**
 * Build the full PARTS list for one avatar instance.
 * Options control accessory geometry so different riders can have
 * different gear without global PARTS contamination.
 *
 * branches on bikeShape (wheels/bars/frame/accessories),
 * kitPattern (jersey overlays), and shoeStyle (sole geometry + colour role).
 */
type ResolvedAvatarOptions = Omit<Required<AvatarOptions>, 'kitAccent'> & { kitAccent: KitAccent | undefined };

function buildParts(opts: ResolvedAvatarOptions): PartSpec[] {
  const shape = opts.bikeShape;
  const { rimDepth, tyreWidth } = BIKE_WHEEL_PROFILE[shape];
  const ts = BIKE_TUBE_SCALE[shape];   // tube scale

  const isMtb    = shape === 'mtbHardtail' || shape === 'mtbFullSus';
  const isGravel = shape === 'gravel';
  const isTT     = shape === 'tt';
  const isEbike  = shape === 'ebike';

  const parts: PartSpec[] = [
    // ---- wheels — tyre width + rim depth vary by bikeShape ----------------
    tyrePart('wheel-rear',  REAR_HUB,  tyreWidth),
    tyrePart('wheel-front', FRONT_HUB, tyreWidth),
    rimAccentShaped('rim-rear',  REAR_HUB,  rimDepth),
    rimAccentShaped('rim-front', FRONT_HUB, rimDepth),
    hubPart('hub-rear',  REAR_HUB),
    hubPart('hub-front', FRONT_HUB),
    // 4-cross spoke pattern
    spokePart('spoke-rear-1',   REAR_HUB),
    spokeCross2('spoke-rear-2', REAR_HUB),
    spokeCross3('spoke-rear-3', REAR_HUB),
    spokeCross4('spoke-rear-4', REAR_HUB),
    spokePart('spoke-front-1',   FRONT_HUB),
    spokeCross2('spoke-front-2', FRONT_HUB),
    spokeCross3('spoke-front-3', FRONT_HUB),
    spokeCross4('spoke-front-4', FRONT_HUB),
    brakeRotorPart('rotor-rear',  REAR_HUB,  -1),
    brakeRotorPart('rotor-front', FRONT_HUB, -1),

    // ---- frame — tube radii scaled by bikeShape ---------------------------
    tube('down-tube',  BB,           HEAD_BOTTOM,       0.035 * ts, 'frame'),
    tube('seat-tube',  BB,           SADDLE_J,          0.032 * ts, 'frame'),
    tube('top-tube',   SADDLE_J,     HEAD_TOP,          0.030 * ts, 'frame'),
    tube('chain-stay', REAR_HUB,     BB,                0.025 * ts, 'frame'),
    tube('seat-stay',  REAR_HUB,     SADDLE_J,          0.022 * ts, 'frame'),
    tube('steerer',    HEAD_TOP,     BAR,               0.026 * ts, 'frame'),
    tube('seatpost',   SEATPOST_BOT, SEATPOST_TOP,      0.020 * ts, 'frame'),
    tube('head-tube',  HEAD_BOTTOM,  HEAD_TOP,          0.028 * ts, 'frame'),

    { name: 'saddle', kind: 'box', dims: v3(0.14, 0.18, 0.05), role: 'frame',
      place: { pos: SADDLE, rot: QUAT_IDENTITY } },
    { name: 'saddle-nose', kind: 'box', dims: v3(0.07, 0.10, 0.04), role: 'frame',
      place: { pos: v3(0, SADDLE[1] + 0.11, SADDLE[2] - 0.01), rot: QUAT_IDENTITY } },

    // ---- drivetrain ----------------------------------------------------------
    crankPart('crank-left',  -1),
    crankPart('crank-right',  1),
    chainringPart(),
    pedalPart('pedal-left',  -1),
    pedalPart('pedal-right',  1),

    // ---- rider body ----------------------------------------------------------
    hipsPart(),
    tube('torso', TORSO_BOT, TORSO_TOP, TORSO_R, 'kit'),
    shoulderPart('shoulder-left',  'left'),
    shoulderPart('shoulder-right', 'right'),
    tube('upper-arm-left',  SHOULDER_LEFT,  ELBOW_LEFT,  0.044, 'kit'),
    tube('upper-arm-right', SHOULDER_RIGHT, ELBOW_RIGHT, 0.044, 'kit'),
    elbowPart('elbow-left',  'left'),
    elbowPart('elbow-right', 'right'),
    forearmPart('forearm-left',  'left'),
    forearmPart('forearm-right', 'right'),
    handPart('hand-left',  'left'),
    handPart('hand-right', 'right'),
    headPart(),

    // ---- helmet --------------------------------------------------------------
    helmetShellPart(opts.helmetStyle),
    helmetVisorPart(opts.helmetStyle),
    helmetVentPart('helmet-vent-1', 0.010),
    helmetVentPart('helmet-vent-2', -0.010),
    helmetStrapPart(),

    // ---- legs + shoes --------------------------------------------------------
    thighPart('thigh-left',  -1),
    thighPart('thigh-right',  1),
    kneePart('knee-left',   -1),
    kneePart('knee-right',   1),
    shinPart('shin-left',   -1),
    shinPart('shin-right',   1),
    anklePart('ankle-left',  -1),
    anklePart('ankle-right',  1),
    shoePart('shoe-left',  -1, opts.shoeStyle),
    shoePart('shoe-right',  1, opts.shoeStyle),
  ];

  // ---- Handlebar geometry — varies by bikeShape ----------------------------
  if (isMtb || isGravel) {
    parts.push(flatBarPart());
  } else if (isTT) {
    parts.push(
      { name: 'handlebar', kind: 'box', dims: v3(0.38, 0.05, 0.04), role: 'frame',
        place: { pos: BAR, rot: QUAT_IDENTITY } },
      ttBarPart('tt-bar-left',  -1),
      ttBarPart('tt-bar-right',  1),
    );
  } else {
    // Standard drop-bar road geometry.
    parts.push(
      { name: 'handlebar', kind: 'box', dims: v3(0.42, 0.05, 0.04), role: 'frame',
        place: { pos: BAR, rot: QUAT_IDENTITY } },
      tube('drop-left',  DROP_LEFT,  HOOD_LEFT,  0.018, 'frame'),
      tube('drop-right', DROP_RIGHT, HOOD_RIGHT, 0.018, 'frame'),
      { name: 'hood-left',  kind: 'ellipsoid', dims: v3(0.038, 0.065, 0.040),
        role: 'frame', place: { pos: HOOD_LEFT,  rot: QUAT_IDENTITY } },
      { name: 'hood-right', kind: 'ellipsoid', dims: v3(0.038, 0.065, 0.040),
        role: 'frame', place: { pos: HOOD_RIGHT, rot: QUAT_IDENTITY } },
    );
  }

  // ---- Fork — MTB gets dual suspension legs --------------------------------
  if (isMtb) {
    parts.push(
      suspForkPart('susp-fork-left',  -1),
      suspForkPart('susp-fork-right',  1),
      { name: 'susp-brace', kind: 'cylinder', dims: v3(0.014, 0.085, 0.014),
        role: 'frame',
        place: { pos: v3(0, FRONT_HUB[1] + 0.08, FRONT_HUB[2] + 0.22),
                 rot: quatZTo(v3(1, 0, 0)) } },
    );
    if (shape === 'mtbFullSus') {
      parts.push(
        { name: 'rear-shock', kind: 'cylinder', dims: v3(0.018, 0.13, 0.018),
          role: 'accent',
          place: { pos: v3(0, -0.25, 0.52),
                   rot: quatZTo(sub(v3(0, -0.05, 0.65), v3(0, -0.30, 0.43))) } },
      );
    }
  } else {
    parts.push(tube('fork', HEAD_BOTTOM, FRONT_HUB, 0.028 * ts, 'frame'));
  }

  // ---- E-bike battery ------------------------------------------------------
  if (isEbike) parts.push(ebikeBatteryPart());

  // ---- Shoe detail geometry ------------------------------------------------
  const ss = opts.shoeStyle;
  if (ss === 'roadClip' || ss === 'gravel') {
    parts.push(shoeCleatPart('cleat-left', -1), shoeCleatPart('cleat-right', 1));
  } else if (ss === 'mtbClip') {
    parts.push(
      mtbGripPart('grip-left-f',  -1,  0.050),
      mtbGripPart('grip-left-r',  -1, -0.050),
      mtbGripPart('grip-right-f',  1,  0.050),
      mtbGripPart('grip-right-r',  1, -0.050),
    );
  }

  // ---- Kit pattern overlays ------------------------------------------------
  const kp = opts.kitPattern;
  if (kp === 'rainbow') {
    const RAINBOW_ROLES: ColorRole[] = ['accent', 'kit', 'wheel', 'helmet', 'frame'];
    for (let i = 0; i < 5; i++) {
      parts.push(jerseyBandPart(`rainbow-band-${i}`, 0.3 + i * 0.19, RAINBOW_ROLES[i]));
    }
  } else if (kp === 'polka') {
    const DOTS: [number, number][] = [
      [-0.08, 0.62], [0.08, 0.62],
      [-0.11, 0.35], [0.11, 0.35],
      [-0.06, 0.08], [0.06, 0.08],
    ];
    for (let i = 0; i < DOTS.length; i++) {
      parts.push(polkaDotPart(`polka-${i}`, DOTS[i][0], DOTS[i][1]));
    }
  } else if (kp === 'stripes') {
    parts.push(
      jerseyBandPart('stripe-0', 0.54, 'accent'),
      jerseyBandPart('stripe-1', 0.27, 'kit'),
      jerseyBandPart('stripe-2', 0, 'accent'),
    );
  } else if (kp === 'teamReplica') {
    parts.push(
      jerseyBandPart('team-chest', 0.58, 'accent'),
      jerseyBandPart('team-mid',   0.27, 'kit'),
      jerseyBandPart('team-hem',   0, 'frame'),
    );
  } else if (kp === 'yellowLeader') {
    parts.push(
      { name: 'cuff-left',  kind: 'box', dims: v3(0.075, 0.030, 0.030),
        role: 'wheel', place: { pos: v3(-0.21, 0.44, 0.86), rot: QUAT_IDENTITY } },
      { name: 'cuff-right', kind: 'box', dims: v3(0.075, 0.030, 0.030),
        role: 'wheel', place: { pos: v3( 0.21, 0.44, 0.86), rot: QUAT_IDENTITY } },
    );
  } else if (kp === 'sprinterGreen') {
    parts.push(
      { name: 'sleeve-left',  kind: 'cylinder',
        dims: v3(0.046, THIGH_L * 0.65, 0.046), role: 'skin',
        place: { pos: mid(SHOULDER_LEFT,  ELBOW_LEFT),
                 rot: quatZTo(sub(ELBOW_LEFT,  SHOULDER_LEFT))  } },
      { name: 'sleeve-right', kind: 'cylinder',
        dims: v3(0.046, THIGH_L * 0.65, 0.046), role: 'skin',
        place: { pos: mid(SHOULDER_RIGHT, ELBOW_RIGHT),
                 rot: quatZTo(sub(ELBOW_RIGHT, SHOULDER_RIGHT)) } },
    );
  } else if (kp === 'fluoro') {
    parts.push(jerseyBandPart('fluoro-hem', 0.04, 'frame'));
  }
  // 'solid': no extra primitives.

  // ---- Optional accessories -----------------------------------------------
  if (opts.hasGlasses) {
    parts.push(
      glassesLensPart('glasses-left',  -0.038),
      glassesLensPart('glasses-right',  0.038),
      glassesBridgePart(),
    );
  }
  if (opts.hasBottle) parts.push(waterBottlePart());

  return parts;
}

// ---- Animation constants --------------------------------------------------

/** Maximum head yaw in radians (~5°). */
const HEAD_YAW_MAX = (5 * Math.PI) / 180;

/** Additional forward pitch when climbing out of saddle (~5°). */
const CLIMB_FORWARD_TILT_RAD = (5 * Math.PI) / 180;

/** Maximum hip sway during climb-mode (~8°). */
const CLIMB_SWAY_MAX_RAD = (8 * Math.PI) / 180;

// ===========================================================================
// Pure-numeric animation helpers — exported for unit tests
// ===========================================================================

/**
 * Returns the current crank phase in radians (unbounded accumulation; use in sin/cos)
 * given a cadence and an elapsed wall-clock time in milliseconds.
 *
 * At 60 RPM = 1 rev/sec → 1000 ms → exactly 2π.
 */
export function pedalPhaseFromCadence(cadenceRpm: number, elapsedMs: number): number {
  if (cadenceRpm <= 0) return 0;
  return (cadenceRpm / 60000) * elapsedMs * 2 * Math.PI;
}

/**
 * Returns the new accumulated wheel rotation (radians) after dtMs milliseconds
 * at speedMs m/s with a wheel of radius wheelRadius m.
 *
 * ω = v / r  (rad/s); Δθ = ω · dt
 *
 * No wrapping — caller uses result in sin/cos.
 */
export function wheelRotationFromSpeed(
  speedMs: number,
  wheelRadius: number,
  prevRotation: number,
  dtMs: number,
): number {
  if (speedMs <= 0 || wheelRadius <= 0 || dtMs <= 0) return prevRotation;
  const omega = speedMs / wheelRadius;
  return prevRotation + omega * (dtMs / 1000);
}

/**
 * Returns the target body lean angle (radians) for a corner.
 *
 * Centripetal acceleration: a_c = v · |Δheading| / dt.
 * Lean θ = atan2(a_c, g).
 * Sign: right turn (positive Δheading) → lean right → negative Cesium roll.
 *
 * Smooth this result with smoothLean() before applying.
 */
export function cornerLeanAngle(
  headingDeltaRad: number,
  speedMs: number,
  dtSec: number,
): number {
  const G = 9.80665;
  if (dtSec <= 0 || speedMs <= 0 || headingDeltaRad === 0) return 0;
  const turnRateAbs = Math.abs(headingDeltaRad) / dtSec;
  const centripetal = speedMs * turnRateAbs;
  const magnitude = Math.atan2(centripetal, G);
  return Math.sign(headingDeltaRad) * -magnitude;
}

/**
 * Exponential-smoothing helper for lean angle.
 * alpha ∈ [0, 1]: 0 = no movement, 1 = instant.
 */
export function smoothLean(prev: number, target: number, alpha: number): number {
  return prev + (target - prev) * Math.max(0, Math.min(1, alpha));
}

/**
 * Returns hip sway oscillation angle (radians) during climb-out-of-saddle.
 *
 * Returns 0 when grade ≤ 8 % or cadence = 0 (not in climb mode).
 * Oscillates at half-cadence (one body-swing per two pedal strokes).
 * Amplitude scales from 0 at 8 % to CLIMB_SWAY_MAX_RAD at 20 % grade.
 */
export function climbingSwayAngle(
  gradePct: number,
  cadenceRpm: number,
  elapsedMs: number,
): number {
  if (gradePct <= 8 || cadenceRpm <= 0) return 0;
  const halfCadence = cadenceRpm / 2;
  const phase = pedalPhaseFromCadence(halfCadence, elapsedMs);
  const normalizedGrade = Math.min(1, (gradePct - 8) / 12);
  return Math.sin(phase) * normalizedGrade * CLIMB_SWAY_MAX_RAD;
}

/**
 * Clamp an effort level to [0, 1].
 * Exported for unit-testing the clamp behaviour.
 */
export function clampEffortLevel(level: number): number {
  return Math.max(0, Math.min(1, level));
}

/**
 * Derive the effective skin color from a base color and an effort level.
 *
 * At level=0: base skin color unchanged.
 * At level=1: skin is brightened (+15 % luminance) and shifted toward a
 *             cool blue tint (simulated perspiration sheen).
 *
 * Pure function — exported for unit testing.
 */
export function effortSkinColor(baseCss: string, level01: number): Cesium.Color {
  const t = clampEffortLevel(level01);
  const base = Cesium.Color.fromCssColorString(baseCss);
  // Lerp toward a desaturated cool tint (simulate wet skin highlight).
  const wetR = Math.min(1, base.red   * 1.15 - 0.04 * t);
  const wetG = Math.min(1, base.green * 1.12 + 0.02 * t);
  const wetB = Math.min(1, base.blue  * 1.10 + 0.10 * t);
  return new Cesium.Color(
    base.red   + (wetR - base.red)   * t,
    base.green + (wetG - base.green) * t,
    base.blue  + (wetB - base.blue)  * t,
    1,
  );
}

// ---- Avatar construction --------------------------------------------------

/**
 * Every live avatar's part primitives. Ground sampling excludes them all, so
 * no rider (or a ghost / bot parked on the same spot) is ever "ground".
 */
const liveAvatarParts = new Set<Cesium.Primitive>();
/** Each live avatar's part collection — hidden for the instant of a ground pick. */
const liveAvatarCollections = new Set<Cesium.PrimitiveCollection>();
let excludeCache: Cesium.Primitive[] | null = null;
export function groundSampleExclusions(): Cesium.Primitive[] {
  if (!excludeCache) excludeCache = [...liveAvatarParts];
  return excludeCache;
}

/** Fewer facets than Cesium's 64×64 entity default: parts are centimetres wide. */
const ELLIPSOID_PARTITIONS = 20;
const CYLINDER_SLICES = 16;

function partGeometry(part: PartSpec): Cesium.BoxGeometry | Cesium.CylinderGeometry | Cesium.EllipsoidGeometry {
  const vertexFormat = Cesium.PerInstanceColorAppearance.VERTEX_FORMAT;
  if (part.kind === 'box') {
    return Cesium.BoxGeometry.fromDimensions({
      dimensions: new Cesium.Cartesian3(part.dims[0], part.dims[1], part.dims[2]),
      vertexFormat,
    });
  }
  if (part.kind === 'cylinder') {
    return new Cesium.CylinderGeometry({
      length: part.dims[1],
      topRadius: part.dims[0],
      bottomRadius: part.dims[2],
      slices: CYLINDER_SLICES,
      vertexFormat,
    });
  }
  return new Cesium.EllipsoidGeometry({
    radii: new Cesium.Cartesian3(part.dims[0], part.dims[1], part.dims[2]),
    stackPartitions: ELLIPSOID_PARTITIONS,
    slicePartitions: ELLIPSOID_PARTITIONS,
    vertexFormat,
  });
}

const scratchLocal = new Cesium.Cartesian3();
const scratchRot = new Cesium.Matrix3();

/**
 * Build the procedural cyclist into `viewer`. Call `update()` each frame from
 * the render loop; `setColors()` to restyle; `dispose()` to remove it.
 *
 * Each part is a Primitive whose geometry is built once; `update()` only
 * rewrites the parts' model matrices in place. (Entity box / cylinder /
 * ellipsoid graphics with a time-varying position are re-tessellated, given
 * new vertex buffers and re-linked shaders every frame — that was most of the
 * ride view's frame time on the laptop iGPU.)
 */
export function createAvatar(viewer: Cesium.Viewer, options?: AvatarOptions): Avatar {
  const scene = viewer.scene;

  // Resolve options with defaults.
  const opts: ResolvedAvatarOptions = {
    colors:      options?.colors      ?? { ...DEFAULT_AVATAR_COLORS },
    posture:     options?.posture     ?? 'hoods',
    helmetStyle: options?.helmetStyle ?? 'road',
    hasGlasses:  options?.hasGlasses  ?? false,
    hasBottle:   options?.hasBottle   ?? false,
    bikeShape:   options?.bikeShape   ?? 'roadAllRounder',
    kitPattern:  options?.kitPattern  ?? 'solid',
    kitAccent:   options?.kitAccent   ?? undefined,
    shoeStyle:   options?.shoeStyle   ?? 'roadClip',
  };

  let colors: AvatarColors = { ...opts.colors };
  const effortLevel = 0;

  // Build the per-instance part list (helmet style, accessories vary).
  const PARTS = buildParts(opts);

  let bodyToWorld = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
  let bodyQuat = Cesium.Quaternion.clone(Cesium.Quaternion.IDENTITY);
  const dyn: RigDynamics = {
    wheelAngle: 0,
    crankAngle: 0,
    headYaw: 0,
    climbSway: 0,
    climbing: false,
    riderPosition: opts.posture,
  };

  const world: { pos: Cesium.Cartesian3; rot: Cesium.Quaternion }[] = PARTS.map(() => ({
    pos: new Cesium.Cartesian3(),
    rot: new Cesium.Quaternion(),
  }));

  let smoothedEle: number | null = null;
  let lean = 0;
  let pitch = 0;
  let lastHeading: number | null = null;
  let smoothedHeadYaw = 0;
  let elapsedMs = 0;
  let shown = true;

  /** Skin color, potentially tinted by effort level. */
  const skinColor = (): Cesium.Color =>
    effortLevel > 0
      ? effortSkinColor(colors.skin, effortLevel)
      : Cesium.Color.fromCssColorString(colors.skin);

  const roleColor = (role: ColorRole): Cesium.Color =>
    role === 'skin' ? skinColor() : Cesium.Color.fromCssColorString(colors[role]);

  // Colours are baked into each part's instance, so a recolour rebuilds the
  // primitives (rare: Garage changes). The collection owns and destroys them.
  const collection = scene.primitives.add(new Cesium.PrimitiveCollection()) as Cesium.PrimitiveCollection;
  liveAvatarCollections.add(collection);
  const groundSampler = createGroundSampler(scene);

  function writeModelMatrix(primitive: Cesium.Primitive, i: number): void {
    Cesium.Matrix4.fromRotationTranslation(
      Cesium.Matrix3.fromQuaternion(world[i].rot, scratchRot),
      world[i].pos,
      primitive.modelMatrix,
    );
  }

  function buildPart(part: PartSpec, i: number): Cesium.Primitive {
    const alpha = part.alpha ?? 1.0;
    const color = alpha < 1 ? roleColor(part.role).withAlpha(alpha) : roleColor(part.role);
    const primitive = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: partGeometry(part),
        id: `rider-part-${part.name}`,
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
      }),
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: alpha < 1, closed: true }),
      modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      // Built on the main thread at its first render — once — so the part
      // exists the frame the rider appears.
      asynchronous: false,
      shadows: Cesium.ShadowMode.ENABLED,
    });
    writeModelMatrix(primitive, i);
    collection.add(primitive);
    return primitive;
  }

  let parts: Cesium.Primitive[] = PARTS.map(buildPart);
  for (const p of parts) liveAvatarParts.add(p);
  excludeCache = null;

  function recomputeParts(): void {
    for (let i = 0; i < PARTS.length; i++) {
      const part = PARTS[i];
      const local = typeof part.place === 'function' ? part.place(dyn) : part.place;
      scratchLocal.x = local.pos[0];
      scratchLocal.y = local.pos[1];
      scratchLocal.z = local.pos[2];
      Cesium.Matrix4.multiplyByPoint(bodyToWorld, scratchLocal, world[i].pos);
      Cesium.Quaternion.multiply(bodyQuat, local.rot, world[i].rot);
      writeModelMatrix(parts[i], i);
    }
  }

  function update(u: AvatarUpdate): void {
    // Defensive: if any positional input is NaN/non-finite, skip this frame
    // rather than letting degenerate values corrupt Cesium matrix math.
    if (
      !Number.isFinite(u.lon) ||
      !Number.isFinite(u.lat) ||
      !Number.isFinite(u.ele) ||
      !Number.isFinite(u.heading)
    ) {
      if (import.meta.env.DEV) {
        console.warn('[avatar] update() skipped — non-finite position input', {
          lon: u.lon, lat: u.lat, ele: u.ele, heading: u.heading,
        });
      }
      return;
    }

    const dt = Math.min(0.1, Math.max(0, u.dt));
    elapsedMs += dt * 1000;

    // Ground height: whatever is drawn right now (never waits on streaming
    // tiles); it rises at once and eases down (see followGround). The camera follows
    // this same height via groundEle().
    const ground = groundSampler.sample(u.lon, u.lat, u.ele, performance.now());
    const targetEle = ground ?? fallbackSceneEle(scene, u.ele);
    smoothedEle = followGround(smoothedEle, targetEle, dt);

    // Corner lean — centripetal tilt, smoothed.
    const headingDelta = lastHeading === null ? 0 : shortestAngle(lastHeading, u.heading);
    lastHeading = u.heading;
    const targetLean = cornerLeanAngle(headingDelta, u.speed, dt || 1 / 60);
    lean += (targetLean - lean) * (1 - Math.exp(-5 * dt));

    // Pitch from gradient.
    const targetPitch = Math.atan(u.grade / 100);
    pitch += (targetPitch - pitch) * (1 - Math.exp(-4 * dt));

    dyn.wheelAngle = wheelRotationFromSpeed(u.speed, WHEEL_R, dyn.wheelAngle, dt * 1000);

    // Crank phase from cadence (estimated if no sensor reports it).
    const rpm = u.cadence > 0 ? u.cadence : estimateCadence(u.speed);
    dyn.crankAngle = pedalPhaseFromCadence(rpm, elapsedMs);

    // Head yaw toward turn, capped at ±5°, smoothed.
    const turnRate = headingDelta / (dt || 1 / 60);
    const targetHeadYaw = Math.max(-HEAD_YAW_MAX, Math.min(HEAD_YAW_MAX, turnRate * 0.12));
    smoothedHeadYaw += (targetHeadYaw - smoothedHeadYaw) * (1 - Math.exp(-8 * dt));
    dyn.headYaw = smoothedHeadYaw;

    // Climb-mode: out-of-saddle sway + extra forward tilt above 8 % grade.
    const climbing = u.grade > 8;
    dyn.climbing = climbing;
    dyn.climbSway = climbing ? climbingSwayAngle(u.grade, rpm, elapsedMs) : 0;

    dyn.riderPosition = u.riderPosition ?? 'hoods';

    // Globe transform: heading + pitch (+ climb tilt) + lean.
    const climbTilt = climbing ? CLIMB_FORWARD_TILT_RAD : 0;
    const origin = Cesium.Cartesian3.fromDegrees(u.lon, u.lat, smoothedEle);
    const hpr = new Cesium.HeadingPitchRoll(u.heading, pitch + climbTilt, lean);
    bodyToWorld = Cesium.Transforms.headingPitchRollToFixedFrame(origin, hpr, Cesium.Ellipsoid.WGS84, undefined, bodyToWorld);
    bodyQuat = Cesium.Transforms.headingPitchRollQuaternion(origin, hpr, Cesium.Ellipsoid.WGS84, undefined, bodyQuat);

    recomputeParts();
  }

  function setColors(next: AvatarColors): void {
    const same = (Object.keys(next) as (keyof AvatarColors)[]).every((k) => next[k] === colors[k]);
    if (same) return;
    colors = { ...next };
    if (viewer.isDestroyed() || collection.isDestroyed()) return;
    for (const p of parts) {
      liveAvatarParts.delete(p);
      collection.remove(p);
    }
    parts = PARTS.map(buildPart);
    for (const p of parts) liveAvatarParts.add(p);
    excludeCache = null;
    avatar.parts = parts;
  }

  function setShow(show: boolean): void {
    if (show === shown) return;
    shown = show;
    if (!collection.isDestroyed()) collection.show = show;
  }

  function dispose(): void {
    for (const p of parts) liveAvatarParts.delete(p);
    liveAvatarCollections.delete(collection);
    excludeCache = null;
    if (!viewer.isDestroyed() && !collection.isDestroyed()) scene.primitives.remove(collection);
  }

  const avatar: Avatar = {
    parts,
    setShow,
    update,
    groundEle: () => smoothedEle,
    meshGround: () => groundSampler.meshGround(),
    ground: () => groundSampler.ground(),
    setColors,
    dispose,
    _effortLevel: 0,
  };

  return avatar;
}

/** Re-sample the rendered ground at most this often (ms)… */
export const GROUND_SAMPLE_INTERVAL_MS = 250;
/** …or as soon as the rider has moved this far (m) since the last sample. */
export const GROUND_SAMPLE_MOVE_M = 5;
/**
 * …or every frame while the drawn globe is more than this (m) over the mesh
 * reading: the rider stands on the globe, not on the mesh (createGroundSampler).
 */
export const GLOBE_OVER_MESH_M = 0.25;

/**
 * The avatar's ground height one frame on: up at once (a rider eased up onto
 * a rising surface spends that time inside it, under the road: a photoreal
 * tile loading 4 m over the globe left the old smoothing 1 m under it),
 * down eased so a tile refining lower doesn't drop the rider in a jump.
 * Overhangs never get here (createMeshRoadFilter).
 */
export function followGround(current: number | null, target: number, dt: number): number {
  if (current === null || target >= current) return target;
  return current + (target - current) * (1 - Math.exp(-6 * dt));
}

/** Highest a mesh reading may sit over the bare terrain (or the route) and be the road. */
export const MESH_OVER_TERRAIN_MAX_M = 60;
/**
 * Lowest a mesh reading may sit under the route's own elevation and be the
 * road. Below that it is a coarse tile's chord: at the Lugano–Melide start the
 * mesh read −27 979 m for ~4 s while only the root tiles were selected (the
 * street is at 322 m); taken as the road, it hid the globe and the rider stood
 * over nothing drawn at all.
 */
export const MESH_UNDER_ROUTE_MAX_M = 60;
/** A mesh reading may rise this much over the last road reading … */
export const OVERHANG_RISE_M = 1.5;
/** … plus this grade times the distance since; more is something over the road. */
export const OVERHANG_GRADE = 0.25;
/** Past this much travel from the last road spot a higher reading is taken anyway. */
export const OVERHANG_GIVE_UP_M = 100;
/**
 * Nothing lower than this over the road is ridden under, unless the mesh has
 * a surface under it nearer the road (a crown's edge over the towpath): the
 * chase camera sits 2.5 m over the road, so held under a solid step it would
 * be inside it. A rise up to this much with nothing under it is ridden over,
 * whatever its grade (Lugano–Melide at 5 km: the route comes off the
 * lakeside path onto the road edge 3.6 m up for a few metres; held under it,
 * the rider and the camera were inside the mesh, the frame 60 % dark wall).
 */
export const OVERHANG_MIN_M = 4;
/**
 * A rise refused between two readings further apart than this (m) is read
 * again in steps of at most this length from the last road spot …
 */
export const OVERHANG_STEP_M = 1;
/**
 * … up to this far from it (m): the sampler reads every ~5 m of travel, so
 * this covers the gap between two samples and bounds the extra reads (9).
 */
export const OVERHANG_STEP_SPAN_M = 10;
/**
 * Steepest a re-read step may rise (m per m): a ramp of ground the rider is
 * lifted along. Per 1 m step this is half of {@link OVERHANG_MIN_M}, what the
 * filter allows a rider read every metre. The bounds come from the mesh along
 * the routes, read every half metre (linear in between):
 * - ramps: on Lugano–Melide the route climbs an embankment at 4.93 km at up to
 *   1.46 and clips a mound at 5 km at up to 1.2. Under 1.46 the rider stays in
 *   the embankment;
 * - crown edges: over the Cuyahoga towpath they rise 4 m within half a metre.
 *   At 2.07 km, read 4–10 m short of one, 2.15 or more lets steps that split
 *   the edge in two climb it, 4.2 m onto the crown.
 * Tests pin both, and the rate itself (1.9 m per m ridden, 2.1 not).
 *
 * The re-read does lift the rider onto some crowns the filter alone left it
 * under: ones whose near side slopes up gently, which a rider read every
 * metre climbs too. Replayed over the mesh at every sample spacing from 2 to
 * 8 m and every phase, with the road taken as the lowest reading within 50 m:
 * none on Santa Monica (palms), Chengdu or Trasimeno; on Cuyahoga 1.5–4.5 km,
 * 4–8 of ~6,000 samples per spacing at 5, 6 and 8 m put the rider more than
 * 3 m over the towpath where the filter alone kept it within 3 m.
 */
export const OVERHANG_STEP_GRADE = 2;

/**
 * How far under a surface the next read down starts (m): a mesh read from
 * `under` ({@link sampleGroundHeight}) answers an up-facing surface at or
 * under where it starts (see {@link MeshRead}), so the next read starts just
 * under the last one found.
 */
export const UNDER_GAP_M = 0.05;
/**
 * Most reads down one vertical to find the road under what stands over it.
 * The first starts at the highest the road can be, so the crowns or the deck
 * above are skipped in one read; on the Cuyahoga towpath the ground is the
 * first or second surface under that (up to six surfaces down the vertical).
 */
export const UNDER_READS = 3;
/**
 * Under something over the road, the road is looked for within
 * {@link OVERHANG_MIN_M} of the last road spot, or {@link OVERHANG_RISE_M}
 * plus this grade times the distance since if more: a steep path's climb
 * (the Cuyahoga towpath climbs 6 m in 40 m under the crowns and the railway
 * at 9.4 km). Not the filter's own {@link OVERHANG_GRADE}: 40 m on under
 * crowns with no ground drawn under them, that would reach a lower crown
 * 10.5 m over the towpath (Cuyahoga 3011 m).
 */
export const UNDER_GRADE = 0.15;
/**
 * Only something at least this far over a surface is ridden under (m): a
 * rider is ~1.8 m tall. Two copies of the road a few centimetres to half a
 * metre apart (tiles of two levels overlapping, Cuyahoga 4.74 km) are one
 * road, and the top one is the one drawn.
 */
export const UNDER_CLEARANCE_M = 2;
/**
 * A rise over the last road spot of more than this between two readings is
 * looked under (m): the read every 250 ms is 2 m apart at 30 km/h, so a crown
 * sloping up from the towpath (Cuyahoga 10.55 km: 0.48 m per m for 35 m)
 * rises under {@link OVERHANG_RISE_M} each time.
 */
export const UNDER_RISE_M = 0.5;
/**
 * A surface read under what stands over the road is the road only if it is
 * at most this far under the bare terrain (the globe's World Terrain, m).
 * The towpath under the Cuyahoga crowns is within ±3 m of it (p5–p95 over
 * 11.5 km), the Santa Monica Strand under its palms 4 m under it. One tile
 * can also draw a second layer under the road with nothing facing down
 * between (Lugano–Melide 4.29, 4.51 and 4.93 km: 1–8 m under the road, flat
 * while the road climbs onto the embankment); ridden as "the road under
 * something" it put the rider up to 8 m inside the mesh. There the bare
 * terrain is 10–20 m over both layers (coarse World Terrain on the steep
 * shore), so nothing is looked under and the rider rides what is drawn on
 * top, as before. With no terrain to go by, nothing is looked under either.
 */
export const UNDER_BARE_M = 5;
/**
 * Steepest a road climbs over {@link CLIMB_SPAN_M} (m per m). A steeper rise
 * with a road under it that climbs no steeper is something over that road.
 * Only checked where the mesh has a surface {@link UNDER_CLEARANCE_M} under
 * the top: an embankment or a mound the route climbs (Lugano–Melide 4.93 and
 * 5 km, up to 1.46 m per m) is solid, with nothing under it.
 */
export const CLIMB_GRADE = 0.3;
/**
 * A climb that looks like nothing a road climbs to (createMeshRoadFilter's
 * `climbsOnto`) is still a road's ramp if, read again every metre from the
 * last road spot, no step rises more than this (m per m): the mesh draws the
 * ramps onto the Chengdu bridges at 1.21 and 9.52 km at up to 0.58 m per m.
 * A crown's edge rises more within a metre.
 */
export const RAMP_GRADE = 0.75;
/** How far back the road taken is remembered for {@link CLIMB_GRADE} (m). */
export const CLIMB_SPAN_M = 20;
/**
 * A reading more than this over the bare terrain is on a structure (m): a
 * tree crown or a deck. With no road to go on from (the first reading, a
 * jump, {@link OVERHANG_GIVE_UP_M} under something) the road is the ground
 * under it near the terrain where the mesh has one, and nothing here
 * otherwise; nor is a structure the road a rider held near the terrain climbs
 * to. Over the Cuyahoga towpath the crowns stand 9–32 m over the globe's
 * terrain and the towpath within ±3 m of it (p5–p95 over 11.5 km).
 */
export const STRUCTURE_M = 6;
/**
 * Over the bare terrain by more than this, it is the terrain reading that is
 * suspect, not the mesh (m): a hidden globe's stale coarse tile can sit 60 m
 * under a street, while the crowns and decks over the Cuyahoga towpath stand
 * at most 32 m over the terrain. The reading is then judged as before this
 * filter knew the terrain.
 */
export const STRUCTURE_MAX_M = 40;
/**
 * With no road to go on from, structure tops read one after another along the
 * route (at most {@link DECK_GAP_M} apart, each within {@link DECK_STEP_M}
 * plus {@link DECK_GRADE} times the distance of the last) for this far are a
 * deck the route runs on (m): the Melide causeway is one smooth surface 8–10 m
 * over the lake for 800 m. Crown tops over the Cuyahoga towpath jump metres
 * from one reading to the next, and the I-80 deck overhead is 15 m across.
 */
export const DECK_RUN_M = 30;
/** Farthest apart two readings of one deck run may be (m). */
export const DECK_GAP_M = 12;
/** Most a deck run's top may step between two readings (m)… */
export const DECK_STEP_M = 0.5;
/** …plus this grade times the distance between them. */
export const DECK_GRADE = 0.1;

function metresBetween(lon: number, lat: number, fromLon: number, fromLat: number): number {
  if (Number.isNaN(fromLon)) return Infinity;
  return Math.hypot((lon - fromLon) * 111_320 * Math.cos((lat * Math.PI) / 180), (lat - fromLat) * 110_540);
}

/**
 * What the last mesh reading under a rider was ({@link createMeshRoadFilter}):
 * - 'road': the mesh road, taken (the top, or a surface under a crown or a
 *   deck that the road goes on along);
 * - 'overhang': mesh is there, but only over the road (canopy, deck), with
 *   no surface near the road under it; the rider keeps the road it has;
 * - 'coarse': only a coarse tile far over or under the ground (one sat 610 m
 *   up for ~4 s at the Cuyahoga start, the root tile's chord 28 km under the
 *   Lugano shore); not the road;
 * - 'none': no mesh tile under the rider.
 */
export type MeshRoadStatus = 'road' | 'overhang' | 'coarse' | 'none';

/**
 * Reads the mesh at lon/lat: from the top (`under` undefined), or down the
 * vertical from `under`: the highest up-facing surface at or under it, over
 * every tile drawn there (undefined if none, or if this reader can't look
 * under anything; cesiumUtils.meshHeightAt). Where the reader falls back on
 * Cesium3DTileset.pick, the first tile with any hit answers instead, and that
 * can be a lower surface; the filter reads down from each surface it finds
 * ({@link UNDER_READS}), so a surface skipped that way is a candidate missed,
 * never a surface over `under`.
 */
export type MeshRead = (lon: number, lat: number, under?: number) => number | undefined;

/**
 * Which photoreal mesh readings are the road. A vertical ray reads the TOP
 * of whatever is there: a palm canopy 10 m over the Santa Monica Strand, tree
 * crowns 10–30 m over the Cuyahoga towpath, a road deck 28 m over it (I-271),
 * a coarse tile 600 m up. The road is continuous, so:
 * - a reading within a road's climb of the last road spot is the road, but a
 *   rise of more than {@link OVERHANG_RISE_M} is looked under once: a surface
 *   under it nearer the road (the towpath under a crown's edge) is the road;
 * - a higher reading is over the road: the mesh is read down from the highest
 *   the road can be, and the surface nearest the road within a climb of it is
 *   the road (the towpath under the crowns, where the mesh has it: about half
 *   the spots on the Cuyahoga towpath). With none, the reading is the road
 *   only if the mesh at that last road spot rose too (a tile refined under
 *   the rider; never from the ground up onto a structure) or it is a ramp
 *   (below); otherwise the rider keeps the road it has ('overhang');
 * - with no road to go on from, a reading over the bare terrain is looked
 *   under for the ground near the terrain.
 * A surface found under something is the road only within
 * {@link UNDER_BARE_M} of the bare terrain: a tile can draw a second layer
 * under the road with nothing between (Lugano–Melide 4.93 km), and where the
 * terrain can't tell them apart the top is ridden, as before. One that climbs
 * steeper than a road is taken but unproven (the edge of a crown closed down
 * onto the towpath): until the road goes on from it, a further climb is
 * measured from the road before it.
 * Falls are always taken (the rider eases down).
 *
 * A rise refused across a gap longer than {@link OVERHANG_STEP_M} is read
 * again every metre on the way, and it is the road if it is a ramp: no step
 * steeper than {@link OVERHANG_STEP_GRADE}. Lugano–Melide 5 km: a mound the
 * route clips rises 4.7 m in 6 m; read 4 m apart (two rises under the floor)
 * the rider rode over it, read 6 m apart (one 4.67 m rise) the rider was kept
 * inside it for as long as it stood there.
 */
export function createMeshRoadFilter() {
  let base: number | undefined;
  let baseLon = NaN;
  let baseLat = NaN;
  let status: MeshRoadStatus = 'none';
  /** The bare terrain where the road was last taken (undefined if unknown). */
  let baseBare: number | undefined;
  /** Road spots taken within {@link CLIMB_SPAN_M} of the last one. */
  let recent: { h: number; lon: number; lat: number; bare: number | undefined }[] = [];
  let bareNow: number | undefined;
  /**
   * A road found under something that climbs from a road spot taken in the
   * last {@link CLIMB_SPAN_M} steeper than a road climbs (tooSteep) is
   * unproven: it can be the edge where the mesh closes a crown down onto the
   * ground (Cuyahoga 4.696 km: 1.7 m over the towpath, 1.3 m a metre), not
   * the road. Until the road is taken again without such a climb, climbsOnto
   * measures from the lowest road spot it climbed from (and that spot's bare
   * terrain), here; undefined otherwise.
   */
  let stepFrom: { h: number; bare: number | undefined } | undefined;
  /** With no road to go on from: the smooth run of structure tops read so far. */
  let deck: { h: number; lon: number; lat: number; fromLon: number; fromLat: number } | undefined;
  const take = (h: number, lon: number, lat: number, underSomething = false) => {
    const steepFrom = recent.filter((r) => climbsSteep(h, lon, lat, r));
    if (!steepFrom.length) stepFrom = undefined;
    else if (!stepFrom && underSomething) {
      const low = steepFrom.reduce((a, b) => (b.h < a.h ? b : a));
      stepFrom = { h: low.h, bare: low.bare };
    }
    base = h;
    baseLon = lon;
    baseLat = lat;
    baseBare = bareNow;
    status = 'road';
    deck = undefined;
    recent = recent.filter((r) => metresBetween(lon, lat, r.lon, r.lat) < CLIMB_SPAN_M);
    recent.push({ h, lon, lat, bare: bareNow });
    return h;
  };
  /** Whether h at lon/lat climbs from road spot r steeper than a road. */
  const climbsSteep = (h: number, lon: number, lat: number, r: { h: number; lon: number; lat: number }) => {
    const d = metresBetween(lon, lat, r.lon, r.lat);
    return d < CLIMB_SPAN_M && h - r.h > Math.max(OVERHANG_RISE_M, CLIMB_GRADE * d);
  };
  /** Whether h at lon/lat climbs from a road spot taken nearby steeper than a road. */
  const tooSteep = (h: number, lon: number, lat: number) => recent.some((r) => climbsSteep(h, lon, lat, r));
  return {
    /**
     * The road height from one reading (undefined: no mesh road here, the
     * globe decides). `ceiling` / `floor`: highest / lowest plausible road
     * height here; `readAt` re-reads the mesh now (at another spot, or under
     * something); `terrain`: the bare terrain here (the globe), if known.
     */
    next(
      reading: number | undefined,
      lon: number,
      lat: number,
      ceiling: number,
      readMesh: MeshRead,
      floor = -Infinity,
      terrain?: number,
    ): number | undefined {
      if (reading === undefined || !Number.isFinite(reading)) {
        status = 'none';
        return undefined;
      }
      if (reading > ceiling || reading < floor) {
        status = 'coarse';
        return base;
      }
      // One reading's checks can ask for the same spot twice (a ramp re-read
      // at two grades): each spot is read once.
      const reads = new Map<string, number | undefined>();
      const readAt: MeshRead = (lo, la, under) => {
        const key = `${lo},${la},${under}`;
        if (!reads.has(key)) reads.set(key, readMesh(lo, la, under));
        return reads.get(key);
      };
      const top = reading;
      const usable = (h: number | undefined): h is number =>
        h !== undefined && Number.isFinite(h) && h >= floor && h <= ceiling;
      const bare = terrain !== undefined && Number.isFinite(terrain) ? terrain : undefined;
      bareNow = bare;
      const onStructure = (h: number) => bare !== undefined && h > bare + STRUCTURE_M && h <= bare + STRUCTURE_MAX_M;
      const moved = metresBetween(lon, lat, baseLon, baseLat);
      if (base === undefined || moved >= OVERHANG_GIVE_UP_M) {
        // No road to go on from. A crown or a deck over the terrain isn't the
        // road where the mesh has ground under it near the terrain; high over
        // it with none, it is the road only once it runs on smooth along the
        // route like a deck the route crosses on (the Melide causeway, 8–10 m
        // over the lake): crown tops jump metres from one reading to the next,
        // and a deck overhead is crossed in a few readings (I-80 at Cuyahoga
        // 3 km).
        recent = [];
        if (bare !== undefined && top > bare + OVERHANG_RISE_M) {
          const from = Math.min(top - UNDER_CLEARANCE_M, bare + OVERHANG_MIN_M);
          const under = surfaceNear(readAt, lon, lat, from, bare, OVERHANG_MIN_M, usable);
          if (under !== undefined && Math.abs(under - bare) < top - bare) return take(under, lon, lat);
        }
        if (onStructure(top)) {
          const step = deck ? metresBetween(lon, lat, deck.lon, deck.lat) : Infinity;
          if (deck && step <= DECK_GAP_M && Math.abs(top - deck.h) <= DECK_STEP_M + DECK_GRADE * step) {
            // A rider standing still runs along nothing: it stands on the
            // globe until it rides on (a crown read again at the same spot is
            // the same top, so standing still proves no deck).
            if (metresBetween(lon, lat, deck.fromLon, deck.fromLat) >= DECK_RUN_M) return take(top, lon, lat);
            deck = { ...deck, h: top, lon, lat };
          } else {
            deck = { h: top, lon, lat, fromLon: lon, fromLat: lat };
          }
          status = 'overhang';
          return base;
        }
        return take(top, lon, lat);
      }
      const from = base;
      // Climbing onto something no road climbs to: from near the terrain onto
      // a structure faster than a road climbs (a crown in steps under
      // OVERHANG_MIN_M), or more than OVERHANG_MIN_M over the terrain the
      // road was on, within reach only because the rider has been held a
      // while (the allowance grows with the distance; bushes 4–8 m over the
      // towpath at Cuyahoga 1.2 km, no ground drawn under them). Only from a
      // road taken near that terrain: a coarse globe chord 40 m over the
      // Lugano–Melide shore road (2.74 km) is no terrain to measure from. A
      // ramp is no such climb: read every metre from the road, it rises
      // RAMP_GRADE or less each metre (the Chengdu ramps at 1.21 and 9.52 km
      // leave the terrain at up to 0.58 m per m). After an unproven road
      // (stepFrom) a climb over the road is measured from the road before it:
      // the edge of a crown taken at Cuyahoga 4.696 km left the lowest layer
      // of the next crown (4.73 km, 5.6 m over the towpath, nothing under it)
      // within OVERHANG_MIN_M, and the rider rode it for 24 m. A fall is never
      // such a climb.
      const climbFrom = stepFrom ?? { h: from, bare: baseBare };
      const climbsOnto = (h: number) =>
        ((onStructure(h) && !onStructure(from) && tooSteep(h, lon, lat)) ||
          (h > Math.max(from, climbFrom.h + OVERHANG_MIN_M) &&
            bare !== undefined &&
            climbFrom.bare !== undefined &&
            Math.abs(climbFrom.h - climbFrom.bare) <= STRUCTURE_M &&
            h - bare > climbFrom.h - climbFrom.bare + OVERHANG_MIN_M)) &&
        !climbsInSteps(from, baseLon, baseLat, h, lon, lat, moved, readAt, RAMP_GRADE);
      // Looked under only near the bare terrain (UNDER_BARE_M).
      const nearBare = (h: number) => bare !== undefined && h >= bare - UNDER_BARE_M;
      // A tile refined higher under the rider (roseAt) is taken, but not one
      // that rose from the ground to a structure's height at the road spot:
      // that is something drawn over the road there. At Cuyahoga 4.724 km the
      // towpath read under a crown (162.8 m) was gone from the next read at
      // the same spot, a tile with the crown top (176.6 m, 13 m over the
      // terrain) and nothing under it, and the rider rode the crown down for
      // 20 m (from 169.1 m, 5.8 m over the terrain, 10 m on). At 4.740 km the
      // crown edge taken at 4.696 km was gone the same way (a coarser tile,
      // its top 18 m over the terrain).
      const atStructure = (h: number | undefined) =>
        h !== undefined && baseBare !== undefined && h > baseBare + STRUCTURE_M && h <= baseBare + STRUCTURE_MAX_M;
      const refined = () => roseAt(readAt, from, baseLon, baseLat) && (atStructure(from) || !atStructure(readAt(baseLon, baseLat)));
      const allow = Math.max(OVERHANG_MIN_M, OVERHANG_RISE_M + OVERHANG_GRADE * moved);
      if (top <= base + allow) {
        let road = top;
        if (top > base + UNDER_RISE_M) {
          // A rise: something over the road it goes on under? The road under
          // it is nearer the last road spot, or climbs like a road where the
          // top climbs steeper (a crown sloping up from the towpath). Read
          // down to the surface nearest the road: under the I-80 viaduct
          // (Cuyahoga 3020 m) a bush 4 m over the towpath is the first one.
          const under = surfaceNear(readAt, lon, lat, top - UNDER_CLEARANCE_M, base, allow, usable, nearBare);
          if (
            usable(under) &&
            (Math.abs(under - base) < top - base ||
              (under >= base - allow && tooSteep(top, lon, lat) && !tooSteep(under, lon, lat)))
          ) {
            road = under;
          }
        }
        if (climbsOnto(road) && !refined()) {
          status = 'overhang';
          return base;
        }
        return take(road, lon, lat, road !== top);
      }
      // Over the road: the road goes on under it where the mesh has it, read
      // down from the highest it can have climbed to. With the road held
      // unproven (stepFrom), near the road before it first: on the Cuyahoga
      // towpath at 5.835 km a bush 3.7 m up, taken from under a crown, held
      // the rider 4 m over the towpath drawn again under the next crowns
      // (out of reach under the bush, or a crown layer nearer it) for 30 m.
      const near = Math.max(OVERHANG_MIN_M, OVERHANG_RISE_M + UNDER_GRADE * moved);
      const nearRoad = (h: number) => surfaceNear(readAt, lon, lat, Math.min(h + near, top - UNDER_CLEARANCE_M), h, near, usable, nearBare);
      const under = (stepFrom ? nearRoad(stepFrom.h) : undefined) ?? nearRoad(base);
      if (under !== undefined && !climbsOnto(under)) return take(under, lon, lat, true);
      if (refined() || (climbsInSteps(base, baseLon, baseLat, top, lon, lat, moved, readAt) && !climbsOnto(top))) {
        return take(top, lon, lat);
      }
      status = 'overhang';
      return base;
    },
    /** The last road height taken (undefined before the first). */
    road(): number | undefined {
      return base;
    },
    /** What the last reading was. */
    status(): MeshRoadStatus {
      return status;
    },
    /** Metres from where the road was last taken to lon/lat (Infinity before the first). */
    metresFrom(lon: number, lat: number): number {
      return metresBetween(lon, lat, baseLon, baseLat);
    },
    reset() {
      base = undefined;
      baseLon = NaN;
      baseLat = NaN;
      status = 'none';
      recent = [];
      baseBare = undefined;
      deck = undefined;
      stepFrom = undefined;
    },
  };
}

/**
 * Down the vertical at lon/lat from `from`, the up-facing surface nearest
 * `near` within `within` of it that `ok` accepts (undefined if none). At most
 * {@link UNDER_READS} reads, each from {@link UNDER_GAP_M} under the last
 * surface; it stops at the first surface at or under `near` (anything further
 * down is further from it) or past `near - within`. A reader that can't look
 * under anything answers no surface, or the top (over `from`): none.
 */
function surfaceNear(
  readAt: MeshRead,
  lon: number,
  lat: number,
  from: number,
  near: number,
  within: number,
  usable: (h: number | undefined) => h is number,
  ok: (h: number) => boolean = () => true,
): number | undefined {
  let best: number | undefined;
  let top = from;
  for (let i = 0; i < UNDER_READS; i++) {
    const h = readAt(lon, lat, top);
    if (h === undefined || !Number.isFinite(h) || h > top || h < near - within) break;
    if (
      usable(h) &&
      Math.abs(h - near) <= within &&
      (best === undefined || Math.abs(h - near) < Math.abs(best - near)) &&
      ok(h)
    ) {
      best = h;
    }
    if (h <= near) break;
    top = h - UNDER_GAP_M;
  }
  return best;
}

/**
 * Whether the mesh at the last road spot rose over the road taken there (a
 * tile refined under the rider): its top is higher, and the road is no longer
 * drawn there under it. A crown over the towpath where the road was taken
 * from under it is still a crown, not a refined tile.
 */
function roseAt(readAt: MeshRead, base: number, baseLon: number, baseLat: number): boolean {
  const top = readAt(baseLon, baseLat);
  if (top === undefined || top <= base + OVERHANG_RISE_M) return false;
  const still = readAt(baseLon, baseLat, base + OVERHANG_RISE_M);
  return !(still !== undefined && Number.isFinite(still) && Math.abs(still - base) <= OVERHANG_RISE_M);
}

/**
 * Whether the mesh rises from `from` (the road at fromLon/fromLat) to
 * `reading` (at lon/lat, `moved` metres on) as a ramp: read again every
 * {@link OVERHANG_STEP_M} or less on the way, no step steeper than
 * {@link OVERHANG_STEP_GRADE}. Not for a gap of one step or less (nothing to
 * read in between) or over {@link OVERHANG_STEP_SPAN_M}. A spot with no
 * reading breaks the chain; so does a coarse one, as the chain only climbs a
 * few metres a step from the road and back to `reading`. A dip on the way
 * counts: the next step is measured from it.
 *
 * Each read is a vertical tile pick, run in the frame that samples: 3.7–5.9 ms
 * a pick on cat-bed (median of a burst of 10 picks a metre apart along the
 * route at Cuyahoga 3 and 3.1 km and Lugano–Melide 5 km: 37–59 ms). The chain
 * stops reading as soon as `reading` is out of reach of the steps left, which
 * gives the same answer on every replayed sample and cuts Cuyahoga's re-reads
 * by 50–70 % (27–50 a km instead of 81–162; a ramp is still read to its end).
 * The worst sample still re-reads 8 times (Cuyahoga read 4 or 8 m apart):
 * ~30–47 ms in one frame.
 */
function climbsInSteps(
  from: number,
  fromLon: number,
  fromLat: number,
  reading: number,
  lon: number,
  lat: number,
  moved: number,
  readAt: (lon: number, lat: number) => number | undefined,
  grade = OVERHANG_STEP_GRADE,
): boolean {
  if (!(moved > OVERHANG_STEP_M && moved <= OVERHANG_STEP_SPAN_M)) return false;
  const steps = Math.ceil(moved / OVERHANG_STEP_M);
  const rise = grade * (moved / steps);
  let h = from;
  for (let i = 1; i <= steps; i++) {
    // Out of reach of the steps left even if each rose all it may: no read
    // can make it a ramp (a deck, a crown far up).
    if (reading > h + rise * (steps - i + 1)) return false;
    const r = i === steps ? reading : readAt(fromLon + ((lon - fromLon) * i) / steps, fromLat + ((lat - fromLat) * i) / steps);
    if (r === undefined || !Number.isFinite(r) || r > h + rise) return false;
    h = r;
  }
  return true;
}

/**
 * Held under something with nothing drawn near the road under it, the globe
 * is drawn instead when its terrain there is at most this far OVER the road
 * (m), and at most {@link GLOBE_STANDIN_UNDER_M} under it: see
 * createGroundSampler. The drawn ground is the higher of the two, so this
 * bounds how far it can lift the rider; a globe drawn over the road also
 * buries the mesh street around it (26 m on the steep Lugano shore). Its
 * terrain is the finest the globe has there (lib/finestTerrain), which it
 * draws once shown, not the tile a hidden globe last loaded (Lugano–Melide
 * 7.6 km: 4.4 m under the road or 2 m over it, the finest within 0.25 m).
 */
export const GLOBE_STANDIN_M = 1.5;
/**
 * How far UNDER the road held the globe's terrain may be and still stand in
 * for the ground (m). A globe under the road buries nothing (the mesh is
 * drawn over it wherever the mesh has ground), and the rider stands on it, so
 * this bounds how far the rider sinks under the road it held. Under the
 * Cuyahoga crowns the towpath was held 1.3–2.0 m over the terrain (3.11–3.16,
 * 4.08–4.10 and 4.70–4.73 km): at the symmetric 1.5 m bound the decision
 * flipped from one sample to the next, the globe's one-second show wait
 * (renderers/cesium/globeGate) never ran out, and the rider rode over a black
 * void. Kept under the chase camera's height over the rider (1.9 m close,
 * 2.6 m standard), so a camera behind a sunken rider stays over the road it
 * held.
 */
export const GLOBE_STANDIN_UNDER_M = 2.5;

/** Whether the globe's terrain `globe` stands in under the road held at `held` (see {@link GLOBE_STANDIN_M}). */
export function globeStandsIn(globe: number | undefined, held: number | undefined): boolean {
  return globe !== undefined && held !== undefined && globe <= held + GLOBE_STANDIN_M && globe >= held - GLOBE_STANDIN_UNDER_M;
}

/**
 * What the rider's last ground sample stood it on ({@link createGroundSampler}):
 * - 'mesh': the photoreal mesh road (or the road held under something over it,
 *   with the globe hidden);
 * - 'standIn': the mesh is there, but only over the road (tree crowns, a deck)
 *   with nothing drawn near the road under it, so the globe is drawn under it
 *   in the mesh's place: held there with the globe's terrain near the road, or
 *   under a structure with no road to go on from (a jump, the start);
 * - 'globe': no mesh road here (no tile, a coarse one, the mesh not shown):
 *   the globe is the ground.
 * The globe is drawn for both of the last two; the painted road only for
 * 'globe' (renderers/cesium/globeGate GroundGate): it is a ground
 * classification, so with the mesh there it paints the crowns, piers and the
 * deck in its footprint.
 */
export type GroundKind = 'mesh' | 'standIn' | 'globe';

/**
 * Throttled {@link sceneGroundHeight}.
 *
 * On terrain (no photoreal mesh shown) the rendered ground is the globe's
 * loaded terrain tiles, so the CPU height lookup is exact and runs every call.
 * Over the photoreal mesh only a GPU pick can measure the ground: a pick pass
 * plus a synchronous readback that stalls the whole pipeline. That runs a few
 * times a second (or after a few metres of travel), reusing the last reading
 * in between — avatars smooth the height anyway — and with every rider hidden
 * for the pick, so the ray doesn't hit helmets and re-render the scene once
 * per excluded part (Cesium's drill pick). Mesh readings pass the overhang
 * filter ({@link createMeshRoadFilter}) first.
 *
 * While the globe is hidden (the mesh is the only ground drawn near the
 * rider, see renderers/cesium/globeGate) a missing reading keeps the road the
 * rider is on: there is no other drawn surface to stand on, and the hidden
 * globe's stale tiles are not what anyone sees.
 *
 * That holds only near where the road was taken. A rider
 * {@link OVERHANG_GIVE_UP_M} or more away from it (a jump: Ride again puts the
 * rider back on the start line, the probes place it; or a long hole) is on
 * another road, so a missing reading there is a fresh start: the globe's
 * terrain decides, drawn or not, until the mesh road there is read (the gate
 * brings the globe back if none turns up).
 *
 * `finest`: the finest terrain heights fetched along the way (default: the
 * scene's terrain provider, cesiumUtils sceneFinestTerrain), for the globe
 * stand-in ({@link GLOBE_STANDIN_M}).
 */
export function createGroundSampler(scene: Cesium.Scene, finest: FinestTerrain = sceneFinestTerrain(scene)) {
  let lastMs = -Infinity;
  let lastLon = NaN;
  let lastLat = NaN;
  let last: number | undefined;
  let ground: GroundKind = 'globe';
  /** The route's elevation where the road was last taken. */
  let roadEle = 0;
  const road = createMeshRoadFilter();
  const meshAt: MeshRead = (lon, lat, under) =>
    withRidersHidden(() => sampleGroundHeight(scene, lon, lat, groundSampleExclusions(), under));
  return {
    sample(lon: number, lat: number, ele: number, nowMs: number): number | undefined {
      const expect = sceneEle(ele);
      if (!photorealGroundShown(scene)) {
        last = undefined;
        ground = 'globe';
        road.reset();
        return sceneGroundHeight(scene, lon, lat, undefined, expect, { terrainOnly: true });
      }
      const movedM = metresBetween(lon, lat, lastLon, lastLat);
      // No mesh road under the rider yet: look again every frame, so a tile
      // that loads over the globe is stood on at once (as before). The same
      // while the rider stands on the drawn globe over a mesh reading under
      // it: a coarse tile, which a finer one replaces any frame (at the Santa
      // Monica start one read 11 m under the globe, then the street landed
      // 4 m over it and the rider stood under it until the next sample, with
      // the camera under the road). Once a reading is the road (or something
      // over it), it lasts until the mesh is the ground or, 750 ms on, the
      // globe gate hides the globe (renderers/cesium/globeGate), which then no
      // longer counts as drawn. While the readings are only coarse tiles
      // (createMeshRoadFilter's 'coarse': the last road is held), it has no
      // bound: meshGround stays false, so the gate keeps the globe drawn, and
      // the mesh is read every frame for as long as that lasts, as with no
      // mesh road at all. Not while the mesh there is only something over
      // the road (its reads look under it, several a sample): at the usual
      // pace.
      const drawn = drawnGroundHeight(scene, lon, lat, last, expect);
      const onGlobe = last !== undefined && drawn !== undefined && drawn > last + GLOBE_OVER_MESH_M;
      const waiting = road.status() !== 'overhang' && (last === undefined || onGlobe);
      const fresh = waiting || nowMs - lastMs >= GROUND_SAMPLE_INTERVAL_MS || movedM >= GROUND_SAMPLE_MOVE_M;
      if (fresh) {
        const fromLon = lastLon;
        const fromLat = lastLat;
        lastMs = nowMs;
        lastLon = lon;
        lastLat = lat;
        const globe = (scene.globe as Cesium.Globe | undefined)?.getHeight?.(Cesium.Cartographic.fromDegrees(lon, lat));
        const terrain = globe !== undefined && Number.isFinite(globe) ? Math.max(globe, expect) : expect;
        // The road the rider is on. Far from where it was taken it isn't the
        // road here; carried along the route's own climb since, it is the
        // best guess at it (within ~20 m on the five photoreal routes).
        const held = road.road();
        const away = held !== undefined && road.metresFrom(lon, lat) >= OVERHANG_GIVE_UP_M;
        const heldHere = held !== undefined && away ? held + (expect - roadEle) : held;
        // It also bounds the ceiling: a hidden globe's tiles stop refining,
        // and with them the terrain reading here.
        const floor = heldHere !== undefined ? Math.max(terrain, heldHere) : terrain;
        // The bare terrain here (World Terrain as loaded), unless a chord (far
        // from the route, or far under the road carried here): what a crown
        // or a deck is told apart from with no road to go on from.
        const bare =
          globe !== undefined &&
          Number.isFinite(globe) &&
          Math.abs(globe - expect) <= MESH_UNDER_ROUTE_MAX_M &&
          (heldHere === undefined || globe >= heldHere - MESH_UNDER_ROUTE_MAX_M)
            ? globe
            : undefined;
        // Every read of this sample is in the same few tiles: copied back
        // from the GPU once (cesiumUtils.withMeshReadCache).
        last = withMeshReadCache(() =>
          road.next(meshAt(lon, lat), lon, lat, floor + MESH_OVER_TERRAIN_MAX_M, meshAt, expect - MESH_UNDER_ROUTE_MAX_M, bare),
        );
        const status = road.status();
        if (status === 'road') roadEle = expect;
        // Under a structure with no road to go on from (a jump, the start)
        // the rider stands on the globe, so the globe stays drawn. Held under
        // one, the mesh drew nothing near the road under it (else the filter
        // took that): where the bare terrain is near the road held (at most
        // GLOBE_STANDIN_M over it, GLOBE_STANDIN_UNDER_M under it), the globe
        // is drawn to stand in for the ground (the towpath under the I-80
        // deck, Cuyahoga 2.98–3.01 km: the mesh has a hole there, the globe
        // 0.2 m under the towpath). Where it is far over the road (26 m over
        // the Lugano shore street) it would lift the rider and bury the
        // street, so the rider holds the road with the globe hidden. Under the
        // road it lifts nothing: the rider sinks onto it, so it may be
        // further off that way (the Cuyahoga towpath held 1.3–2 m over the
        // terrain under the crowns at 3.1, 4.1 and 4.7 km). Near or far is
        // judged by the finest terrain the globe has here, fetched (ahead)
        // while the rider is held: what it draws once shown. A hidden globe's
        // loaded tile is whatever coarse one it last loaded along the way: at
        // Lugano–Melide 7.6 km, under a 54 m slab with no ground drawn under
        // it, that read 4.4 m under the road (the finest 0.25 m), so the
        // rider rode on over a black void. Until the finest lands, the loaded
        // tile decides.
        if (status === 'overhang' && held !== undefined && !away) finest.want(lon, lat, fromLon, fromLat, nowMs);
        const globeHere = finest.near(lon, lat) ?? bare;
        const standsIn = globeStandsIn(globeHere, held);
        const onMesh = status === 'road' || (status === 'overhang' && held !== undefined && !away && !standsIn);
        // Not on the mesh road, but the mesh is there over the road: the
        // globe is drawn in its place, without the painted road (GroundKind).
        ground = onMesh ? 'mesh' : status === 'overhang' ? 'standIn' : 'globe';
        // Where the globe stands in, the rider stands on it once it is drawn
        // (below: held while it is still hidden), not on the road held over
        // it: under the I-80 deck the globe was drawn 0.75 m under the road
        // held, and the rider floated over it.
        if (status === 'overhang' && standsIn && !away) last = undefined;
        if (away && status !== 'road') {
          // Somewhere else and no mesh road yet: the globe's terrain decides,
          // as at a fresh start, drawn or not. Holding the old road here kept
          // the rider 41 m under the Lugano–Melide mesh for a second after a
          // 2 km jump. A coarse globe chord far under the road (a globe hidden
          // for kilometres: 780 m under at Chengdu) isn't stood on; the road
          // carried along the route's climb is.
          const chord = globe === undefined || !Number.isFinite(globe) || globe < (heldHere as number) - MESH_UNDER_ROUTE_MAX_M;
          last = chord ? heldHere : undefined;
        } else if (last === undefined && (globeHidden(scene) || globeStreaming(scene))) {
          // No mesh road here: keep the road the rider is on while the globe
          // is hidden (nothing else is drawn to stand on) or still streaming
          // back in. A globe hidden for kilometres comes back with coarse
          // tiles: at Chengdu 5 km one read 780 m under the road, and the
          // rider sank towards it. The drawn globe still wins where it is
          // higher. Where it stands in and is drawn, still streaming, the
          // rider stands where it refines to (its terrain here, near the
          // road by GLOBE_STANDIN_M), not on the road held over it: 1.3–2 m
          // over it under the Cuyahoga crowns, the rider rose to the road on
          // every sample the globe was still streaming, then eased back down.
          last =
            status === 'overhang' && standsIn && !away && !globeHidden(scene) && globeHere !== undefined
              ? globeHere
              : road.road();
        }
      }
      // The mesh reading is reused between samples; the globe (drawn over the
      // mesh wherever its terrain is higher) is read fresh every call.
      return fresh ? drawnGroundHeight(scene, lon, lat, last, expect) : drawn;
    },
    /** The photoreal mesh is loaded at road level under the last spot sampled. */
    meshGround(): boolean {
      return ground === 'mesh';
    },
    /** What the last sample stood the rider on (see {@link GroundKind}). */
    ground(): GroundKind {
      return ground;
    },
  };
}

function globeHidden(scene: Cesium.Scene): boolean {
  return (scene.globe as { show?: boolean } | undefined)?.show === false;
}

function globeStreaming(scene: Cesium.Scene): boolean {
  return (scene.globe as { tilesLoaded?: boolean } | undefined)?.tilesLoaded === false;
}

function withRidersHidden<T>(fn: () => T): T {
  const hidden: Cesium.PrimitiveCollection[] = [];
  for (const c of liveAvatarCollections) {
    if (!c.isDestroyed() && c.show) {
      c.show = false;
      hidden.push(c);
    }
  }
  try {
    return fn();
  } finally {
    for (const c of hidden) c.show = true;
  }
}

/**
 * Set the sweat/effort tint on a live avatar.
 *
 * level01 is clamped to [0, 1]:
 *   0 = fresh, no tint
 *   1 = maximum effort — skin brightens with a blue-cool highlight
 *
 * Only the skin-role entities are updated; all other roles are unaffected.
 * Allocation-free: mutates existing ColorMaterialProperty instances in-place.
 */
export function setAvatarEffortLevel(avatar: Avatar, level01: number): void {
  // Reflect clamped value onto the opaque handle field so tests can verify.
  avatar._effortLevel = clampEffortLevel(level01);
}

// ---- Test-surface export --------------------------------------

/**
 * Returns the number of primitives that would be built for a given set of
 * AvatarOptions. Cesium-free — safe to call in unit tests.
 *
 * This is the only allocation `buildParts` makes; it is exported purely for
 * test assertions and must never be called in the hot render path.
 */
export function avatarPrimitiveCount(options?: AvatarOptions): number {
  return buildParts(resolveTestOptions(options)).length;
}

function resolveTestOptions(options?: AvatarOptions): ResolvedAvatarOptions {
  return {
    colors:      options?.colors      ?? DEFAULT_AVATAR_COLORS,
    posture:     options?.posture     ?? 'hoods',
    helmetStyle: options?.helmetStyle ?? 'road',
    hasGlasses:  options?.hasGlasses  ?? false,
    hasBottle:   options?.hasBottle   ?? false,
    bikeShape:   options?.bikeShape   ?? 'roadAllRounder',
    kitPattern:  options?.kitPattern  ?? 'solid',
    kitAccent:   options?.kitAccent,
    shoeStyle:   options?.shoeStyle   ?? 'roadClip',
  };
}

/**
 * Points on the surface of every part, body-local metres (+X right, +Y
 * forward, +Z up; origin on the ground between the wheels), at crank angle
 * `crankAngle` and the given posture: the rider's silhouette as drawn, for
 * tests that project it through a camera (rendering never calls this).
 * Boxes give their corners, cylinders `n` points round each end, ellipsoids
 * an `n` × `n` latitude/longitude grid.
 */
export function avatarSurfacePoints(
  options?: AvatarOptions,
  pose: { crankAngle?: number; riderPosition?: RiderPosition } = {},
  n = 24,
): V3[] {
  const opts = resolveTestOptions(options);
  const dyn: RigDynamics = {
    wheelAngle: 0,
    crankAngle: pose.crankAngle ?? 0,
    headYaw: 0,
    climbSway: 0,
    climbing: false,
    riderPosition: pose.riderPosition ?? opts.posture,
  };
  const out: V3[] = [];
  const m = new Cesium.Matrix3();
  const p = new Cesium.Cartesian3();
  for (const part of buildParts(opts)) {
    const local = typeof part.place === 'function' ? part.place(dyn) : part.place;
    Cesium.Matrix3.fromQuaternion(local.rot, m);
    const [a, b, c] = part.dims;
    const raw: V3[] = [];
    if (part.kind === 'box') {
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) raw.push(v3((sx * a) / 2, (sy * b) / 2, (sz * c) / 2));
    } else if (part.kind === 'cylinder') {
      // Cesium.CylinderGeometry: length dims[1] along z, top radius dims[0], bottom dims[2].
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        raw.push(v3(Math.cos(t) * a, Math.sin(t) * a, b / 2));
        raw.push(v3(Math.cos(t) * c, Math.sin(t) * c, -b / 2));
      }
    } else {
      for (let i = 0; i <= n; i++) {
        const lat = -Math.PI / 2 + (i / n) * Math.PI;
        for (let j = 0; j < n; j++) {
          const lon = (j / n) * Math.PI * 2;
          raw.push(v3(Math.cos(lat) * Math.cos(lon) * a, Math.cos(lat) * Math.sin(lon) * b, Math.sin(lat) * c));
        }
      }
    }
    for (const q of raw) {
      Cesium.Matrix3.multiplyByVector(m, Cesium.Cartesian3.fromElements(q[0], q[1], q[2], p), p);
      out.push(v3(p.x + local.pos[0], p.y + local.pos[1], p.z + local.pos[2]));
    }
  }
  return out;
}

// ---- Private helpers ------------------------------------------------------

/** Shortest signed angular delta a→b, radians, in (-π, π]. */
function shortestAngle(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Plausible cadence from speed when no sensor reports it (~70 GI gearing). */
function estimateCadence(speedMs: number): number {
  if (speedMs < 0.5) return 0;
  return Math.max(55, Math.min(105, (speedMs / 7.4) * 60));
}

// Suppress unused-variable warnings for nominal geometry constants that exist
// for documentation / future use.
void KNEE_LEFT; void KNEE_RIGHT; void HIP_LEFT; void HIP_RIGHT;
