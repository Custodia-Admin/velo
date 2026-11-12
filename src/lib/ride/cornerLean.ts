/**
 * How far the drawn rider leans into a corner: the steady-turn lean of a
 * bicycle, atan(v² · κ / g), for its speed along the drawn path (rideLine)
 * and that path's curvature. Into the turn (+ = right), capped at
 * CORNER_LEAN_MAX_RAD, faded out below walking speed, and eased so it
 * builds and unwinds with the bend instead of snapping.
 *
 * Shared by every renderer, for the rider, the pace partners and the ghosts.
 * Engine-free (src/lib/ride rule).
 */

import type { LinePoint } from './rideLine';

/** Steepest corner lean drawn, radians (20°). */
export const CORNER_LEAN_MAX_RAD = (20 * Math.PI) / 180;
/** No lean at or below this speed, m/s (walking pace). */
export const LEAN_WALK_SPEED_MS = 1.5;
/** Full lean from this speed up, m/s. */
export const LEAN_FULL_SPEED_MS = 3;
/** Easing time constant of the drawn lean, seconds. */
export const LEAN_TAU_S = 0.25;
/** Read the bend this far ahead (seconds of travel), so the eased lean peaks where the bend does. */
export const LEAN_LEAD_S = LEAN_TAU_S;

const G = 9.81;

/**
 * Target lean, radians (+ = right), at route speed `speed` (m/s) on the
 * drawn line at `point` (its curvature per metre of path, and the metres of
 * path per metre of route that turn route speed into path speed).
 */
export function cornerLeanTarget(speed: number, point: Pick<LinePoint, 'curvature' | 'stretch'>): number {
  if (!(speed > LEAN_WALK_SPEED_MS)) return 0;
  const v = speed * (Number.isFinite(point.stretch) ? point.stretch : 1);
  const lean = Math.atan((v * v * point.curvature) / G);
  if (!Number.isFinite(lean)) return 0;
  const fade = Math.min(1, (speed - LEAN_WALK_SPEED_MS) / (LEAN_FULL_SPEED_MS - LEAN_WALK_SPEED_MS));
  const f = fade * fade * (3 - 2 * fade);
  return Math.max(-CORNER_LEAN_MAX_RAD, Math.min(CORNER_LEAN_MAX_RAD, lean)) * f;
}

/** One frame of the eased lean toward `target` (frame-rate independent). */
export function stepCornerLean(lean: number, target: number, dt: number): number {
  if (!Number.isFinite(lean)) return target;
  if (!(dt > 0)) return lean;
  return lean + (target - lean) * (1 - Math.exp(-dt / LEAN_TAU_S));
}
