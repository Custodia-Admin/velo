/**
 * Ghost replay: a recorded ride played back on the ride clock.
 *
 * A ghost at ride time T is where the recorded rider was after T seconds of
 * their own riding (pauses excluded), so a race against it is fair: the live
 * ride clock (`rideStore.elapsedMs`) excludes pauses too.
 *
 * Positions: every recorded sample's lat/lon is projected back onto the
 * route near its recorded distance, so the replay passes through the
 * recorded positions themselves. (A sample's `distance` is the distance
 * after that tick's step, its lat/lon the point before it: up to a metre
 * apart at 40 km/h on a slow frame.)
 *
 * Time: samples recorded since P3.2 carry `rideMs`, the ride clock at the
 * recorded position. Older samples only have the wall clock (`t`), which
 * runs on through pauses and slow frames; for them the ride clock is
 * rebuilt from the gaps between samples.
 *
 * Pure and renderer-free.
 */

import type { Route, TelemetrySample } from '@/types';

/** The recorder samples once a second; a longer gap between two samples is a pause. */
const PAUSE_GAP_S = 2;
/** How far from its recorded distance a sample's position may project, metres. */
const PROJECT_WINDOW_M = 60;
/** A recorded position further than this from the route keeps its recorded distance, metres. */
const PROJECT_MAX_OFF_M = 25;

export interface GhostReplay {
  /** Ride seconds of the last recorded sample. */
  durationSec: number;
  /** Route distance of the last recorded sample, metres. */
  endM: number;
  /**
   * Distance along the route after `rideSec` seconds of riding, metres:
   * the first recorded spot before the ride starts, the last one after.
   */
  distanceAt: (rideSec: number) => number;
  /** Ride seconds at which the ghost reached `distanceM`, or null if it never did. */
  timeAt: (distanceM: number) => number | null;
}

const M_PER_DEG = 111_320;

/**
 * The route distance of the point on the route nearest (lat, lon), searched
 * within PROJECT_WINDOW_M of `nearM`. Falls back to `nearM` when nothing on
 * the route is within PROJECT_MAX_OFF_M.
 */
export function projectOntoRoute(route: Route, lat: number, lon: number, nearM: number): number {
  const pts = route.points;
  if (pts.length < 2) return nearM;
  const lo = Math.max(0, nearM - PROJECT_WINDOW_M);
  const hi = nearM + PROJECT_WINDOW_M;
  // First segment that ends after `lo`.
  let a = 0;
  let b = pts.length - 1;
  while (a < b - 1) {
    const mid = (a + b) >> 1;
    if (pts[mid].distance <= lo) a = mid;
    else b = mid;
  }
  const kx = M_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const ky = M_PER_DEG;
  let best = Infinity;
  let at = nearM;
  for (let i = a; i < pts.length - 1 && pts[i].distance <= hi; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    const ax = (p.lon - lon) * kx;
    const ay = (p.lat - lat) * ky;
    const dx = (q.lon - p.lon) * kx;
    const dy = (q.lat - p.lat) * ky;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    if (off < best) {
      best = off;
      at = p.distance + t * (q.distance - p.distance);
    }
  }
  return best <= PROJECT_MAX_OFF_M ? at : nearM;
}

/**
 * Ride seconds of every sample: `rideMs` where recorded, otherwise rebuilt
 * from the wall clock, a gap over PAUSE_GAP_S counting only the riding it
 * held (distance over speed, at most one sample interval).
 */
export function rideSecondsOf(samples: readonly TelemetrySample[], startedAt: number): number[] {
  if (samples.every((s) => typeof s.rideMs === 'number')) return samples.map((s) => (s.rideMs as number) / 1000);
  const out: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (i === 0) {
      out.push(Math.max(0, Math.min(1, (s.t - startedAt) / 1000)));
      continue;
    }
    const prev = samples[i - 1];
    const gap = Math.max(0, (s.t - prev.t) / 1000);
    if (gap <= PAUSE_GAP_S) {
      out.push(out[i - 1] + gap);
      continue;
    }
    const speed = Math.max(0.5, (s.speed + prev.speed) / 2);
    out.push(out[i - 1] + Math.min(1, Math.max(0, s.distance - prev.distance) / speed));
  }
  return out;
}

export function buildGhostReplay(
  samples: readonly TelemetrySample[],
  startedAt: number,
  route: Route,
): GhostReplay | null {
  if (samples.length < 2) return null;
  const secs = rideSecondsOf(samples, startedAt);
  const dist: number[] = [];
  let maxM = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const m = Math.max(0, Math.min(route.totalDistance, projectOntoRoute(route, s.lat, s.lon, s.distance)));
    // A ride only goes forward: projection noise never walks the ghost back.
    maxM = Math.max(maxM, m);
    dist.push(maxM);
  }
  // Ride time is non-decreasing too (a clock never runs back).
  for (let i = 1; i < secs.length; i++) if (secs[i] < secs[i - 1]) secs[i] = secs[i - 1];
  const n = secs.length;

  const distanceAt = (rideSec: number): number => {
    if (!(rideSec > secs[0])) return dist[0];
    if (rideSec >= secs[n - 1]) return dist[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (secs[mid] <= rideSec) lo = mid;
      else hi = mid;
    }
    const span = secs[hi] - secs[lo];
    const f = span > 0 ? (rideSec - secs[lo]) / span : 0;
    return dist[lo] + f * (dist[hi] - dist[lo]);
  };

  const timeAt = (distanceM: number): number | null => {
    if (distanceM <= dist[0]) return secs[0];
    if (distanceM > dist[n - 1]) return null;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (dist[mid] < distanceM) lo = mid;
      else hi = mid;
    }
    const span = dist[hi] - dist[lo];
    const f = span > 0 ? (distanceM - dist[lo]) / span : 0;
    return secs[lo] + f * (secs[hi] - secs[lo]);
  };

  return { durationSec: secs[n - 1], endM: dist[n - 1], distanceAt, timeAt };
}
