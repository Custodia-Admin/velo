/**
 * How close the follow camera sits to the rider — the rider's "camera
 * distance" setting, shared by every renderer.
 *
 * `standard` is the default (owner, 31 Oct): the rider is prominent in the
 * lower middle of the frame and the road reads 10–20 m ahead. `overview` is
 * the original GlobeRide framing (45 m back, 9 m up).
 *
 * Engine-free (src/lib/world rule).
 */

export type CameraDistance = 'close' | 'standard' | 'far' | 'overview';

export const CAMERA_DISTANCES: readonly CameraDistance[] = ['close', 'standard', 'far', 'overview'];

export const DEFAULT_CAMERA_DISTANCE: CameraDistance = 'standard';

export const CAMERA_DISTANCE_LABELS: Readonly<Record<CameraDistance, string>> = {
  close: 'Close',
  standard: 'Standard',
  far: 'Far',
  overview: 'Overview',
};

export function isCameraDistance(value: unknown): value is CameraDistance {
  return typeof value === 'string' && (CAMERA_DISTANCES as readonly string[]).includes(value);
}

/** Chase framing: metres behind, metres up, and the aim point ahead of the rider. */
export interface ChaseFraming {
  backM: number;
  upM: number;
  /** The camera aims at a point this far ahead along the route, {@link chaseLookHeight} up. */
  lookAheadM: number;
}

/** Height of the aim point above the road: roughly the rider's hips. */
export const AIM_HEIGHT_M = 1.0;

/**
 * The rider model's rear axle, metres behind and above its ground contact:
 * the GLB rig's `RIG.rearAxle` (scripts/gen-rider-glb.mjs), which the Cesium
 * avatar shares (lib/avatar `AVATAR_RIG`).
 */
export const REAR_AXLE_M: Readonly<{ back: number; up: number }> = { back: 0.5, up: 0.34 };

/**
 * Height of the chase camera's look point above the rider's ground, metres,
 * when the route point `framing.lookAheadM` ahead is `riseM` above (+) or
 * below (−) the rider's ground.
 *
 * On the flat and downhill the camera looks at that point + {@link AIM_HEIGHT_M}:
 * on a descent it tips down and shows more of the road ahead.
 *
 * On a climb it does not tip up toward the road ahead. Tipping up dropped the
 * rider down the frame: at "close" on a 9 % climb the rear wheel went 21 px
 * (1440×900) to 45 px (390×844) under the ride HUD strip. Instead the camera
 * keeps its flat-road pitch, tipped down by as much as the bike's pitch up
 * the slope lowers the rear wheel. So the rear wheel is drawn where it is on
 * the flat, at every grade, distance and window shape. The slope is the
 * grade to the point ahead (both renderers pitch the bike with the ground).
 */
export function chaseLookHeight(framing: ChaseFraming, riseM: number): number {
  if (!(riseM > 0)) return riseM + AIM_HEIGHT_M;
  const slope = Math.atan2(riseM, framing.lookAheadM);
  const { back, up } = REAR_AXLE_M;
  // In the vertical plane along the heading: camera `backM` behind and `upM`
  // up; the rear axle turned nose-up by the slope about the ground contact.
  const axleBack = back * Math.cos(slope) + up * Math.sin(slope);
  const axleUp = up * Math.cos(slope) - back * Math.sin(slope);
  const lowered = Math.atan2(framing.upM - axleUp, framing.backM - axleBack) - Math.atan2(framing.upM - up, framing.backM - back);
  const run = framing.backM + framing.lookAheadM;
  const flatPitch = Math.atan2(AIM_HEIGHT_M - framing.upM, run);
  return framing.upM + run * Math.tan(flatPitch - lowered);
}

/**
 * The chase camera aims this far (radians) at most off the rider's heading
 * toward the route ahead. Aiming straight at a look-ahead point round a sharp
 * corner turns the view up to ~85° away from the rider (off-frame, worst in
 * portrait where half the horizontal field of view is ~15°); half the bend,
 * capped at 12°, still opens the view into the corner.
 */
export const MAX_AIM_OFFSET_RAD = (12 * Math.PI) / 180;

/**
 * Compass heading (radians clockwise from north) the chase camera looks
 * along: the rider's heading turned toward the route point ahead by half the
 * bend, at most {@link MAX_AIM_OFFSET_RAD}. `aheadEastM` / `aheadNorthM` are
 * that point's offset from the rider. Every renderer's chase camera aims by
 * this rule, so they frame the rider the same in corners.
 */
export function chaseAimHeading(heading: number, aheadEastM: number, aheadNorthM: number): number {
  if (!(Math.hypot(aheadEastM, aheadNorthM) > 0.5)) return heading;
  let bend = (Math.atan2(aheadEastM, aheadNorthM) - heading) % (Math.PI * 2);
  if (bend > Math.PI) bend -= Math.PI * 2;
  if (bend < -Math.PI) bend += Math.PI * 2;
  return heading + Math.max(-MAX_AIM_OFFSET_RAD, Math.min(MAX_AIM_OFFSET_RAD, bend * 0.5));
}

/**
 * Chase camera smoothing time constants, seconds: the camera's offset from
 * the rider and its look point's. Smoothing relative to the rider damps
 * turns and framing changes, never how far behind the camera falls at speed.
 */
export const CHASE_TAU_S: Readonly<{ pos: number; look: number }> = { pos: 0.12, look: 0.1 };
/** After a camera mode change the camera glides with this time constant… */
export const CAMERA_GLIDE_TAU_S = 0.55;
/** …for this long, seconds. */
export const CAMERA_GLIDE_S = 1.6;

/**
 * Vertical field of view of the ride camera, degrees, in every renderer and
 * every window shape. The three.js renderer's `fov` is vertical; Cesium's
 * spans the canvas's longer side, so photoreal converts it
 * (renderers/cesium/hudLensCrop `cesiumFov`). With the same framing, both
 * renderers then draw the rider the same size in the same place.
 */
export const RIDE_FOV_Y_DEG = 60;

export const CHASE_FRAMING: Readonly<Record<CameraDistance, ChaseFraming>> = {
  close: { backM: 4.5, upM: 1.9, lookAheadM: 10 },
  standard: { backM: 7, upM: 2.6, lookAheadM: 14 },
  far: { backM: 14, upM: 4.5, lookAheadM: 20 },
  // The original framing: 45 m back, 9 m up, -7° pitch.
  overview: { backM: 45, upM: 9, lookAheadM: 20.2 },
};

/** Framing for a setting value; unknown values get the default. */
export function chaseFraming(distance: CameraDistance | undefined): ChaseFraming {
  return CHASE_FRAMING[distance && isCameraDistance(distance) ? distance : DEFAULT_CAMERA_DISTANCE];
}
