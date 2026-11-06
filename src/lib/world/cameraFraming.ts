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
  /** The camera aims at a point this far ahead along the route, {@link AIM_HEIGHT_M} up. */
  lookAheadM: number;
}

/** Height of the aim point above the road: roughly the rider's hips. */
export const AIM_HEIGHT_M = 1.0;

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
