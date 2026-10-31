/**
 * Riding buddy: the other rider from the roster rides beside you.
 *
 * When they've ridden this route before, their recorded pace decides whether
 * they're a little ahead or a little behind, but the gap is clamped so they
 * never drop you and you never drop them. Without a recording they ride level
 * with a gentle drift. Pure and renderer-free.
 */

import type { Route } from '@/types';
import type { RideRecord } from '@/lib/rideHistory';
import { buildInterpolator } from '@/lib/ghosts';

/** Largest gap either way, metres. */
export const BUDDY_MAX_GAP_M = 12;
/** Drift amplitude and period when there's no recording to follow. */
const DRIFT_M = 3;
const DRIFT_PERIOD_S = 45;
/** Side offset from the rider's line, metres (positive = left). */
export const BUDDY_SIDE_M = 1.5;

export interface BuddyRide {
  startedAt: number;
  /** Recorded distance at a given ride-clock second, or null before start. */
  distanceAt: (elapsedSec: number) => number | null;
}

function sameRoute(record: RideRecord, route: Route): boolean {
  if (record.routeRef?.id) return record.routeRef.id === route.id;
  return record.name.toLowerCase().split('—')[0].trim() === route.name.toLowerCase().trim();
}

/**
 * The buddy's most recent ride on this route, or null. Only rides recorded
 * by `buddyRiderId` count; older records without a rider id never match.
 */
export function pickBuddyRide(
  records: readonly RideRecord[],
  route: Route,
  buddyRiderId: string,
): BuddyRide | null {
  let best: RideRecord | null = null;
  for (const r of records) {
    if (r.riderId !== buddyRiderId) continue;
    if (r.source === 'replay') continue;
    if (!r.samples || r.samples.length < 2) continue;
    if (!sameRoute(r, route)) continue;
    if (!best || r.startedAt > best.startedAt) best = r;
  }
  if (!best) return null;
  return { startedAt: best.startedAt, distanceAt: buildInterpolator(best.samples, best.startedAt) };
}

/**
 * Where the buddy wants to be relative to the rider, metres (positive =
 * ahead). Clamped to ±BUDDY_MAX_GAP_M.
 */
export function buddyTargetGap(
  elapsedSec: number,
  riderDistanceM: number,
  ride: BuddyRide | null,
): number {
  if (ride) {
    const d = ride.distanceAt(elapsedSec);
    if (d !== null) {
      return Math.max(-BUDDY_MAX_GAP_M, Math.min(BUDDY_MAX_GAP_M, d - riderDistanceM));
    }
  }
  return DRIFT_M * Math.sin((2 * Math.PI * elapsedSec) / DRIFT_PERIOD_S);
}

/** Ease the current gap toward the target (time constant ~2 s). */
export function easeGap(current: number, target: number, dt: number): number {
  const k = 1 - Math.exp(-Math.max(0, dt) / 2);
  return current + (target - current) * k;
}

/** The buddy's one-line status for the Play panel. */
export function buddyLine(name: string, ride: BuddyRide | null): string {
  if (!ride) return `${name} rides with you`;
  const date = new Date(ride.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${name} rides with you · pace from ${date}`;
}

/**
 * Shift a lon/lat sideways from the direction of travel. Positive metres go
 * to the rider's left. Heading is radians clockwise from north.
 */
export function offsetSideways(
  lat: number,
  lon: number,
  headingRad: number,
  metres: number,
): { lat: number; lon: number } {
  const left = headingRad - Math.PI / 2;
  const R = 6_378_137;
  const dNorth = metres * Math.cos(left);
  const dEast = metres * Math.sin(left);
  return {
    lat: lat + (dNorth / R) * (180 / Math.PI),
    lon: lon + (dEast / (R * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI),
  };
}
