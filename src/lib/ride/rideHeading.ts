/**
 * The heading the cameras aim by, and the plain route bearing.
 *
 * The rider is drawn on the drawn line (rideLine) and faces along it: its
 * heading is that line's tangent, exact, with no filter (rideSim.drawnPose).
 * The chase cameras turn with the same line, but through `YawFilter`: a
 * frame-rate independent damper with a turn-rate cap. The line turns a
 * hairpin or an acute junction within a few metres; the cap bounds how fast
 * the camera behind the rider can ever swing round, and the rider is then
 * seen turning into the bend.
 *
 * Physics, the trainer and lane steering keep using the route as it is; this
 * only changes where the cameras look.
 *
 * Engine-free (src/lib/ride rule).
 */

import { sampleRouteAtDistance } from '@/lib/gpxParser';
import type { Route } from '@/types';
import { lineHeadingAt } from './rideLine';

/** Fastest the chase camera turns, radians per second (140°/s). */
export const MAX_YAW_RATE = (140 * Math.PI) / 180;
/** Damping time constant of the camera's heading, seconds. */
export const YAW_TAU_S = 0.15;
/** A distance jump bigger than this (seek, route change) snaps the heading. */
export const YAW_SNAP_M = 40;

/** Signed smallest difference a − b of two angles, radians. */
export function headingDelta(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Damped, turn-rate-capped heading carried across frames. */
export class YawFilter {
  heading = NaN;
  /** Last turn rate, radians per second (clockwise +). */
  rate = 0;
  private distance = NaN;

  reset() {
    this.heading = NaN;
    this.rate = 0;
    this.distance = NaN;
  }

  /** Advance toward `target` (radians) at route `distance`; returns the filtered heading. */
  step(target: number, distance: number, dt: number): number {
    const jumped = !Number.isFinite(this.distance) || Math.abs(distance - this.distance) > YAW_SNAP_M;
    this.distance = distance;
    if (!Number.isFinite(this.heading) || jumped || !Number.isFinite(target)) {
      this.heading = Number.isFinite(target) ? target : 0;
      this.rate = 0;
      return this.heading;
    }
    if (!(dt > 0)) return this.heading;
    const delta = headingDelta(target, this.heading);
    const cap = MAX_YAW_RATE * dt;
    const turn = Math.max(-cap, Math.min(cap, delta * (1 - Math.exp(-dt / YAW_TAU_S))));
    this.heading = headingDelta(this.heading + turn, 0);
    this.rate = turn / dt;
    return this.heading;
  }
}

/**
 * One frame of the heading the chase cameras aim by, in every renderer: the
 * drawn line's tangent (rideLine) through `yaw`. The tangent is read
 * `speed · YAW_TAU_S` metres ahead, which cancels the damper's lag through a
 * steady bend, so the camera sits square behind the rider unless the cap
 * holds it back. An outside driver's heading (`overrideHeading`, e.g. the
 * probe hooks' held pose) is damped as it is.
 */
export function stepCameraHeading(
  yaw: YawFilter,
  route: Route,
  distance: number,
  dt: number,
  speed = 0,
  overrideHeading?: number,
): number {
  const lead = Number.isFinite(speed) && speed > 0 ? speed * YAW_TAU_S : 0;
  return yaw.step(overrideHeading ?? lineHeadingAt(route, distance + lead), distance, dt);
}

/**
 * Compass bearing (radians clockwise from north) of the route segment under
 * `distance`: the direction the route itself runs at that point, with no
 * chord and no lag. At a vertex it is the segment that starts there. Falls
 * back to `fallback` on a segment with no length.
 */
export function routeBearingAt(route: Route, distance: number, fallback = 0): number {
  const pts = route.points;
  if (pts.length < 2) return fallback;
  const { index } = sampleRouteAtDistance(route, distance);
  const a = pts[Math.min(index, pts.length - 2)];
  const b = pts[Math.min(index, pts.length - 2) + 1];
  const dEast = (b.lon - a.lon) * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const dNorth = b.lat - a.lat;
  if (dEast === 0 && dNorth === 0) return fallback;
  return Math.atan2(dEast, dNorth);
}
