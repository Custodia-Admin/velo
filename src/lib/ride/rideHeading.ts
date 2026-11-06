/**
 * Smoothed direction of travel for drawing the rider and aiming the camera.
 *
 * `gpxParser.headingAt` is a ±4 m chord, so at a sharp route vertex the
 * heading swings by over 100° within a few metres (Tiber park's 123° junction
 * turn at 9,672 m): the drawn rider pivots on the spot and a chase
 * camera keyed to it swings the rider out of frame. Two stages fix that:
 *
 * 1. `smoothHeadingAt` — a wider chord (±12 m), a pure function of distance,
 *    spreads an ordinary corner over ~24 m of travel.
 * 2. `YawFilter` — a frame-rate independent damper with a turn-rate cap.
 *    A hairpin or an out-and-back folds the chord onto itself, so the chord
 *    alone can still flip quickly there; the cap bounds how fast the drawn
 *    rider (and the camera behind it) can ever turn.
 *
 * Physics, the trainer and lane steering keep using the route as it is; this
 * only changes where the rider faces on screen.
 *
 * Engine-free (src/lib/ride rule).
 */

import { sampleRouteAtDistance } from '@/lib/gpxParser';
import type { Route } from '@/types';

/** Half the chord, metres: a 114° vertex turns over ~24 m (≈2 s at 40 km/h). */
export const HEADING_HALF_WINDOW_M = 12;
/** Fastest the drawn rider turns, radians per second (140°/s). */
export const MAX_YAW_RATE = (140 * Math.PI) / 180;
/** Damping time constant toward the chord heading, seconds. */
export const YAW_TAU_S = 0.15;
/** A distance jump bigger than this (seek, route change) snaps the heading. */
export const YAW_SNAP_M = 40;

/**
 * Compass heading (radians clockwise from north) of the chord from
 * `distance − halfWindowM` to `distance + halfWindowM`, clamped to the route.
 * Falls back to `fallback` when the chord has no length.
 */
export function smoothHeadingAt(
  route: Route,
  distance: number,
  halfWindowM: number = HEADING_HALF_WINDOW_M,
  fallback = 0,
): number {
  const total = route.totalDistance;
  const a = sampleRouteAtDistance(route, Math.max(0, Math.min(total, distance - halfWindowM)));
  const b = sampleRouteAtDistance(route, Math.max(0, Math.min(total, distance + halfWindowM)));
  const dEast = (b.lon - a.lon) * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const dNorth = b.lat - a.lat;
  if (dEast === 0 && dNorth === 0) return fallback;
  return Math.atan2(dEast, dNorth);
}

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
 * One frame of the heading the rider is drawn at and the cameras aim by, in
 * every renderer: the wide chord at `distance` (or an outside driver's own
 * heading, `overrideHeading`) through `yaw`.
 */
export function stepDrawnHeading(
  yaw: YawFilter,
  route: Route,
  distance: number,
  dt: number,
  overrideHeading?: number,
): number {
  return yaw.step(overrideHeading ?? smoothHeadingAt(route, distance), distance, dt);
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
