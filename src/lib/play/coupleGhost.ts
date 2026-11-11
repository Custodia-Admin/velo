/**
 * The couple ghost: ride against the other rider's ride on this route.
 *
 * Two riders share one trainer. The ghost is the other rider's last ride
 * here (or their best, or none: the rider picks on the setup step), played
 * back on the ride clock (./ghostReplay) and drawn as a stylized rider in
 * their colours. Rides come from rideHistory (`riderId` + `routeRef`), the
 * rider from the roster (./otherRider).
 *
 * Pure apart from `loadCoupleGhost`, which reads IndexedDB.
 */

import type { AvatarColors } from '@/lib/avatarConfig';
import { listRides, type RideRecord } from '@/lib/rideHistory';
import type { Route } from '@/types';
import { buildGhostReplay, type GhostReplay } from './ghostReplay';
import type { OtherRider } from './otherRider';

export type CoupleGhostChoice = 'last' | 'best' | 'off';

/** A ride counts as complete (a candidate for "best") from this share of the route. */
export const COMPLETE_SHARE = 0.98;

/** Does a saved ride belong to this route? By route id, or by name for records saved without one. */
export function rideOnRoute(record: Pick<RideRecord, 'name' | 'routeRef'>, route: Pick<Route, 'id' | 'name'>): boolean {
  if (record.routeRef?.id) return record.routeRef.id === route.id;
  return record.name.toLowerCase().split('—')[0].trim() === route.name.toLowerCase().trim();
}

export interface CoupleGhostOptions {
  /** Their most recent ride here. */
  last: RideRecord | null;
  /** Their fastest complete ride here (may be the same ride as `last`). */
  best: RideRecord | null;
}

/** The other rider's rides on this route that can be replayed. */
export function coupleGhostOptions(
  records: readonly RideRecord[],
  route: Route,
  riderId: string,
): CoupleGhostOptions {
  let last: RideRecord | null = null;
  let best: RideRecord | null = null;
  for (const r of records) {
    if (r.riderId !== riderId || r.source === 'replay') continue;
    if (!r.samples || r.samples.length < 2 || !rideOnRoute(r, route)) continue;
    if (!last || r.startedAt > last.startedAt) last = r;
    const complete = route.totalDistance > 0 && r.distanceM >= route.totalDistance * COMPLETE_SHARE;
    if (complete && (!best || r.durationSec < best.durationSec || (r.durationSec === best.durationSec && r.startedAt > best.startedAt))) {
      best = r;
    }
  }
  return { last, best };
}

/** The ride the choice stands for; "best" without a complete ride falls back to the last one. */
export function pickCoupleGhost(options: CoupleGhostOptions, choice: CoupleGhostChoice): RideRecord | null {
  if (choice === 'off') return null;
  if (choice === 'best') return options.best ?? options.last;
  return options.last;
}

export interface CoupleGhost {
  riderId: string;
  riderName: string;
  colors: AvatarColors;
  /** Which of their rides it is. */
  kind: 'last' | 'best';
  rideId: string;
  startedAt: number;
  replay: GhostReplay;
}

/** Build the ghost for a picked ride (null when it can't be replayed). */
export function coupleGhostFrom(
  record: RideRecord,
  options: CoupleGhostOptions,
  rider: OtherRider,
  route: Route,
): CoupleGhost | null {
  const replay = buildGhostReplay(record.samples, record.startedAt, route);
  if (!replay) return null;
  return {
    riderId: rider.id,
    riderName: rider.name,
    colors: rider.colors,
    kind: options.best?.id === record.id && options.last?.id !== record.id ? 'best' : 'last',
    rideId: record.id,
    startedAt: record.startedAt,
    replay,
  };
}

/** Load the couple ghost for this route from ride history (null: none, off, or no history). */
export async function loadCoupleGhost(
  route: Route,
  choice: CoupleGhostChoice,
  rider: OtherRider | null,
  records?: readonly RideRecord[],
): Promise<CoupleGhost | null> {
  if (!rider || choice === 'off') return null;
  let all = records;
  if (!all) {
    try {
      all = await listRides();
    } catch {
      return null;
    }
  }
  const options = coupleGhostOptions(all, route, rider.id);
  const record = pickCoupleGhost(options, choice);
  return record ? coupleGhostFrom(record, options, rider, route) : null;
}

export interface GhostVerdict {
  /** 'ahead': the live rider got there first; 'behind': the ghost did; 'further': the ghost stopped before this point. */
  kind: 'ahead' | 'behind' | 'level' | 'further';
  /** Seconds between the two at `atM` (0 for 'further'). */
  seconds: number;
  /** Where they are compared: the live rider's distance, metres. */
  atM: number;
  /** True when the live rider reached the end of the route. */
  finished: boolean;
}

/**
 * How the live ride compares with the ghost at the live rider's distance:
 * the ghost's ride time to that point against the live ride time.
 */
export function ghostVerdict(replay: GhostReplay, liveDistanceM: number, liveSec: number, routeLengthM: number): GhostVerdict | null {
  if (!(liveDistanceM > 0) || !(liveSec > 0)) return null;
  const finished = routeLengthM > 0 && liveDistanceM >= routeLengthM - 1;
  const ghostSec = replay.timeAt(liveDistanceM);
  if (ghostSec === null) return { kind: 'further', seconds: 0, atM: liveDistanceM, finished };
  const delta = Math.round(ghostSec - liveSec);
  if (delta === 0) return { kind: 'level', seconds: 0, atM: liveDistanceM, finished };
  return { kind: delta > 0 ? 'ahead' : 'behind', seconds: Math.abs(delta), atM: liveDistanceM, finished };
}
