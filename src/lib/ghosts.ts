/**
 * Ghost rider logic — replays past ride telemetry as a shadow position on the
 * current route, so the rider races their previous attempts.
 *
 * Matching: past rides are considered "same route" when both the route name
 * AND the recorded total distance are within 2 % of the current route. This
 * works because the ride recorder stores route.name and the last sample's
 * distance which equals route.totalDistance at finish.
 *
 * Playback is driven by the live rider's ride clock (pauses excluded): the
 * ghost at ride time T is where the past ride was after T seconds of its own
 * riding (lib/play/ghostReplay).
 */

import type { Route, TelemetrySample } from '@/types';
import { listRides } from '@/lib/rideHistory';
import type { RideRecord } from '@/lib/rideHistory';
import { buildGhostReplay } from '@/lib/play/ghostReplay';
import { useRiderRosterStore } from '@/stores/riderRosterStore';

// Max ghosts rendered simultaneously.
export const MAX_GHOSTS = 3;

// Two routes are considered the same when distances are within this fraction.
const DISTANCE_TOLERANCE = 0.02; // 2 %

// ---- Public types ------------------------------------------------------------

/** A resolved ghost: the past ride record + a fast lookup function. */
export interface GhostRide {
  /** Display label for the UI (ride name + date). */
  label: string;
  /** Total duration of the past ride, seconds. */
  durationSec: number;
  /**
   * Given the live rider's ride seconds (pauses excluded), returns the
   * ghost's cumulative distance along the route in metres, clamped to
   * [0, route.totalDistance]. The renderers hide a ghost on null.
   */
  distanceAt: (elapsedSec: number) => number | null;
}

// ---- Internal helpers -------------------------------------------------------

/**
 * Wall-clock interpolation over the sample array (the Cesium riding buddy's
 * pace, lib/play/buddy). Ghosts use lib/play/ghostReplay, which runs on the
 * ride clock instead.
 */
export function buildInterpolator(
  samples: TelemetrySample[],
  startedAt: number,
): (elapsedSec: number) => number | null {
  if (samples.length === 0) return () => null;

  // Pre-compute offsets in seconds from ride start.
  const times = samples.map((s) => (s.t - startedAt) / 1000);
  const distances = samples.map((s) => s.distance);

  const first = times[0];
  const last = times[times.length - 1];

  return (elapsedSec: number): number | null => {
    if (elapsedSec < first) return null;
    if (elapsedSec >= last) return distances[distances.length - 1];

    // Binary search for the bracket [lo, hi] around elapsedSec.
    let lo = 0;
    let hi = times.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= elapsedSec) lo = mid;
      else hi = mid;
    }

    // Linear interpolation between lo and hi.
    const t0 = times[lo];
    const t1 = times[hi];
    const span = t1 - t0;
    if (span <= 0) return distances[lo];
    const frac = (elapsedSec - t0) / span;
    return distances[lo] + frac * (distances[hi] - distances[lo]);
  };
}

/**
 * Decide if a recorded ride matches the current route well enough to ghost.
 * Matching criteria:
 *   - Same route name (case-insensitive, trimmed).
 *   - Recorded distance within DISTANCE_TOLERANCE of route.totalDistance.
 *   - Has at least 2 samples (enough to interpolate).
 *   - Not a replay or workout-only ride (source !== 'replay').
 */
function isEligible(record: RideRecord, route: Route): boolean {
  if (record.source === 'replay') return false;
  if (record.sampleCount < 2 || record.samples.length < 2) return false;
  const nameMismatch =
    record.name.toLowerCase().split('—')[0].trim() !==
    route.name.toLowerCase().trim();
  if (nameMismatch) {
    // Also accept if the ride name starts with the route name (common when
    // workout name is prepended) or the route name starts with the ride name.
    const ridePart = record.name.toLowerCase().split('—')[0].trim();
    const routePart = route.name.toLowerCase().trim();
    if (!ridePart.includes(routePart) && !routePart.includes(ridePart)) {
      return false;
    }
  }
  const recordedDist = record.distanceM;
  const routeDist = route.totalDistance;
  if (routeDist === 0) return false;
  const ratio = Math.abs(recordedDist - routeDist) / routeDist;
  return ratio <= DISTANCE_TOLERANCE;
}

// ---- Public API -------------------------------------------------------------

/**
 * Load up to MAX_GHOSTS ghost rides for the given route from IndexedDB.
 * Selects the best past attempts (fastest average speed) and returns them
 * sorted fastest-first. Returns an empty array when no eligible rides exist.
 *
 * Only `riderId`'s own rides (default: the active rider) and records saved
 * before rides carried a rider count: the other rider's ride is the couple
 * ghost (lib/play/coupleGhost), not an anonymous one. Playback runs on the
 * ride clock and through the recorded positions (lib/play/ghostReplay).
 */
export async function loadGhosts(
  route: Route,
  riderId: string = useRiderRosterStore.getState().activeRiderId,
): Promise<GhostRide[]> {
  let all: RideRecord[];
  try {
    all = await listRides();
  } catch {
    return [];
  }
  return pastGhosts(all, route, riderId);
}

/** The ghosts `loadGhosts` returns, from a list of records (pure). */
export function pastGhosts(all: readonly RideRecord[], route: Route, riderId: string): GhostRide[] {
  const eligible = all.filter(
    (r) => (r.riderId === undefined || r.riderId === riderId) && isEligible(r, route),
  );
  if (eligible.length === 0) return [];

  // Sort by average speed descending (fastest first) — pick up to MAX_GHOSTS.
  eligible.sort((a, b) => b.avgSpeed - a.avgSpeed);
  return eligible.slice(0, MAX_GHOSTS).flatMap((record): GhostRide[] => {
    const replay = buildGhostReplay(record.samples, record.startedAt, route);
    if (!replay) return [];
    const date = new Date(record.startedAt).toLocaleDateString();
    return [
      {
        label: `${record.name} · ${date}`,
        durationSec: record.durationSec,
        distanceAt: replay.distanceAt,
      },
    ];
  });
}
