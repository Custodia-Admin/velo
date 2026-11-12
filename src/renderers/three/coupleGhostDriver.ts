/**
 * The couple ghost's per-frame pose on the world renderer, pure: where the
 * other rider was after this many seconds of their own ride
 * (lib/play/ghostReplay), drawn the way the rider is (rideDriver.driveBotPose:
 * on the drawn line at that distance, facing along it, leaning into the
 * bend) on the drawn ground.
 *
 * The ghost rides the line itself, not a lateral slot, so it passes through
 * the recorded positions (the replay test holds it to the line's reach:
 * rideLine cuts a corner by at most ~1.35 m).
 * It fades as it comes level with the live rider, so the live rider always
 * reads through it, and fades out after its ride ends.
 */

import type { GhostReplay } from '@/lib/play/ghostReplay';
import type { Route } from '@/types';
import { createBotDriverMemo, driveBotPose, type BotDriverMemo } from './rideDriver';
import { estimatedCadence, placeRider, type RiderPlacement } from './riderRig';
import type { SceneWorld } from './worldScene';

/** Ghost opacity well clear of the live rider. */
export const GHOST_OPACITY = 0.55;
/** Ghost opacity when level with the live rider. */
export const GHOST_NEAR_OPACITY = 0.18;
/** Along-route gap below which the ghost is at its faintest, metres. */
export const GHOST_NEAR_M = 2.5;
/** Along-route gap from which it is at full ghost opacity, metres. */
export const GHOST_CLEAR_M = 8;
/** After its ride ends, the ghost fades out over this many seconds. */
export const GHOST_FADE_S = 4;

export interface CoupleGhostMemo {
  bot: BotDriverMemo;
  lastSec: number;
}

export function createCoupleGhostMemo(): CoupleGhostMemo {
  return { bot: createBotDriverMemo(), lastSec: NaN };
}

export interface CoupleGhostDrive {
  placement: RiderPlacement;
  distanceM: number;
  speed: number;
  cadence: number;
  lean: number;
  opacity: number;
}

/** Opacity for an along-route gap to the live rider (null: no live rider). */
export function ghostOpacity(gapM: number | null): number {
  if (gapM === null) return GHOST_OPACITY;
  const g = Math.abs(gapM);
  if (g <= GHOST_NEAR_M) return GHOST_NEAR_OPACITY;
  if (g >= GHOST_CLEAR_M) return GHOST_OPACITY;
  const f = (g - GHOST_NEAR_M) / (GHOST_CLEAR_M - GHOST_NEAR_M);
  return GHOST_NEAR_OPACITY + f * (GHOST_OPACITY - GHOST_NEAR_OPACITY);
}

/**
 * The ghost this frame, at `rideSec` seconds of the live ride clock, with the
 * live rider at `riderDistanceM` along the route (null: not riding yet).
 * Returns null once it has faded out after its ride.
 */
export function driveCoupleGhost(
  sceneWorld: SceneWorld,
  route: Route,
  replay: GhostReplay,
  rideSec: number,
  riderDistanceM: number | null,
  memo: CoupleGhostMemo,
  dt: number,
  ground?: (x: number, y: number) => number,
): CoupleGhostDrive | null {
  const over = rideSec - replay.durationSec;
  const fade = over > 0 ? Math.max(0, 1 - over / GHOST_FADE_S) : 1;
  if (fade <= 0) {
    memo.lastSec = rideSec;
    return null;
  }
  const d = replay.distanceAt(rideSec);
  // The ride clock stands still while the ride is paused or not started: so does the ghost.
  const moving = rideSec > memo.lastSec && over < 0;
  memo.lastSec = rideSec;
  const speed = moving ? Math.max(0, d - replay.distanceAt(rideSec - 1)) : 0;
  const { lat, lon, heading, lean } = driveBotPose(memo.bot, route, { distance: d, speed, heading: 0 }, dt);
  const placement = placeRider(sceneWorld, { lat, lon, heading }, ground);
  return {
    placement,
    distanceM: d,
    speed,
    cadence: estimatedCadence(speed),
    lean,
    opacity: ghostOpacity(riderDistanceM === null ? null : d - riderDistanceM) * fade,
  };
}
