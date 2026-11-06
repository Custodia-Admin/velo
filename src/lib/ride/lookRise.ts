/**
 * How much the road rises from the rider to the chase camera's look point,
 * from the route profile low-passed over distance.
 *
 * The photoreal chase camera looks at the route point `lookAheadM` ahead, at
 * the rider's drawn ground plus the road's rise to that point
 * (lib/cesiumCameras `chaseCamTarget`). The raw stored profile is not a
 * usable rise:
 * - curated routes store elevation in whole metres at irregular spacing, so
 *   a 5 % descent reads as alternating 0 % and 11–17 % segments (Valle
 *   Maggia 8.1–8.4 km). The look point bobbed by up to ~1.4 m as the
 *   10–14 m look-ahead crossed each step (54 px at 1440×900 standard);
 * - GPX uploads carry raw GPS altitude, metres of noise, and the camera
 *   nodded all ride long.
 *
 * So the rise is the difference of the profile smoothed by a triangle window
 * {@link LOOK_RISE_HALF_WINDOW_M} metres each side. A whole-metre step
 * becomes an S-curve 240 m long; GPS noise averages out over ~30 samples;
 * a sustained grade (a climb, a descent) is kept exactly, and a change of
 * grade tilts the view over ~15–30 s of riding. Beyond the route's ends the
 * profile is held flat. Pure: no stores, no engine, no per-frame cache.
 */

import type { Route } from '@/types';

/**
 * Half-width of the triangle window the profile is smoothed with, metres.
 * At 8 m/s this holds the 1 m point within 10 px in any 2 s on a modelled
 * phone track (AR(1) σ 2 m, 1 m steps); 40 m left 30 px there.
 */
export const LOOK_RISE_HALF_WINDOW_M = 120;

type Pts = Route['points'];

/** Index of the segment holding distance `x`: −1 before the first point, n − 1 from the last on. */
function segmentAt(pts: Pts, x: number): number {
  const n = pts.length;
  if (x < pts[0].distance) return -1;
  if (x >= pts[n - 1].distance) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].distance <= x) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Profile elevation at `x` on segment `k` (flat beyond the ends). */
function eleOn(pts: Pts, k: number, x: number): number {
  if (k < 0) return pts[0].ele;
  if (k >= pts.length - 1) return pts[pts.length - 1].ele;
  const a = pts[k];
  const b = pts[k + 1];
  const span = b.distance - a.distance;
  return span > 0 ? a.ele + ((b.ele - a.ele) * (x - a.distance)) / span : b.ele;
}

/**
 * The route's elevation profile at distance `s`, smoothed by a triangle
 * window of half-width `halfWindowM` (weights fall linearly from the centre
 * to zero at ±halfWindowM). The profile is linear between route points and
 * flat beyond the ends; `halfWindowM` ≤ 0 reads it unsmoothed.
 *
 * Exact: with J the profile's double integral from s − h, the triangle mean
 * is (J(s + h) − 2·J(s) + J(s − h)) / h², and J is a cubic on each segment.
 * Walks only the route points inside the window.
 */
export function smoothedProfileEle(route: Route, s: number, halfWindowM: number = LOOK_RISE_HALF_WINDOW_M): number {
  const pts = route.points;
  if (!Number.isFinite(s)) return NaN;
  if (pts.length === 0) return 0;
  const h = halfWindowM;
  if (!(h > 0)) return eleOn(pts, segmentAt(pts, s), s);
  // Elevations relative to the first point's: smaller numbers, same mean.
  const base = pts[0].ele;
  let k = segmentAt(pts, s - h);
  let x = s - h;
  let I = 0; // ∫ (ele − base) from s − h to x
  let J = 0; // ∫ I from s − h to x
  let jMid = 0;
  for (const target of [s, s + h]) {
    while (x < target) {
      const segEnd = k < 0 ? pts[0].distance : k >= pts.length - 1 ? Infinity : pts[k + 1].distance;
      const x1 = Math.min(segEnd, target);
      if (x1 > x) {
        const e0 = eleOn(pts, k, x) - base;
        const e1 = eleOn(pts, k, x1) - base;
        const L = x1 - x;
        J += I * L + (L * L * (2 * e0 + e1)) / 6;
        I += (L * (e0 + e1)) / 2;
        x = x1;
      }
      if (x >= segEnd) k++;
    }
    if (target === s) jMid = J;
  }
  return base + (J - 2 * jMid) / (h * h);
}

/**
 * Rise of the road from distance `fromM` (the rider) to `toM` (the chase
 * camera's look point), metres (negative downhill), on the profile smoothed
 * by {@link smoothedProfileEle}.
 */
export function chaseLookRise(
  route: Route,
  fromM: number,
  toM: number,
  halfWindowM: number = LOOK_RISE_HALF_WINDOW_M,
): number {
  return smoothedProfileEle(route, toM, halfWindowM) - smoothedProfileEle(route, fromM, halfWindowM);
}
