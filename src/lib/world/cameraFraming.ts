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

export const CHASE_FRAMING: Readonly<Record<CameraDistance, ChaseFraming>> = {
  close: { backM: 4.5, upM: 1.9, lookAheadM: 10 },
  standard: { backM: 7, upM: 2.6, lookAheadM: 14 },
  far: { backM: 14, upM: 4.5, lookAheadM: 20 },
  overview: { backM: 45, upM: 9, lookAheadM: 20 },
};

/** Framing for a setting value; unknown values get the default. */
export function chaseFraming(distance: CameraDistance | undefined): ChaseFraming {
  return CHASE_FRAMING[distance && isCameraDistance(distance) ? distance : DEFAULT_CAMERA_DISTANCE];
}
