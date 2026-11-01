/**
 * The world renderer's per-frame ride step, pure: ride-store numbers in →
 * the RideFrame the rider, camera and sky read. ThreeWorldView's RideDriver
 * calls this every frame; the corner-framing tests call the same function.
 */

import { stepLaneOffset } from '@/lib/laneOffset';
import { smoothHeadingAt, YawFilter } from '@/lib/ride/rideHeading';
import { ridePose } from '@/lib/ride/rideSim';
import type { RiderPose } from '@/lib/world/renderer';
import type { RideState, Route } from '@/types';
import { dampFactor } from './chaseRig';
import { estimatedCadence, leanAngle, placeRider } from './riderRig';
import type { RideFrame, SceneWorld } from './worldScene';

/** State the driver carries between frames. */
export interface RideDriverMemo {
  lane: number;
  yaw: YawFilter;
}

export function createRideDriverMemo(): RideDriverMemo {
  return { lane: 0, yaw: new YawFilter() };
}

export interface RideDriverInput {
  route: Route | null;
  distance: number;
  speed: number;
  grade: number;
  cadence: number;
  power: number;
  rideState: RideState;
  /** Handlebar steer input (controllerStore.activeSteer). */
  steer: number;
  /** A pose from outside the ride loop (replays, previews), or null. */
  override: RiderPose | null;
  lookAheadM: number;
  /** Seconds since the previous frame (clamped by the caller). */
  dt: number;
  timeS: number;
}

export function driveRideFrame(frame: RideFrame, memo: RideDriverMemo, sceneWorld: SceneWorld, input: RideDriverInput): void {
  const { route, dt } = input;
  frame.dt = dt;
  frame.timeS = input.timeS;
  frame.rideState = input.rideState;
  if (!route || route.points.length < 2) {
    frame.valid = false;
    memo.yaw.reset();
    return;
  }
  memo.lane = stepLaneOffset(memo.lane, input.steer, dt);
  const raw = input.override;
  const distance = raw ? raw.distance : input.distance;
  // The drawn heading is the damped wide-chord heading (lib/ride/rideHeading):
  // the raw route bearing swings 114–163° within metres at sharp vertices.
  // The lane offset turns with that same filtered heading: the chord folds onto
  // itself at an out-and-back U-turn, and a steered rider would jump across the road.
  const chord = raw ? raw.heading : smoothHeadingAt(route, distance);
  const heading = memo.yaw.step(chord, distance, dt);
  const pose: RiderPose = raw
    ? { ...raw, heading }
    : {
        ...ridePose(route, distance, { laneOffsetM: memo.lane, offsetHeading: heading, grade: input.grade, speed: input.speed }),
        heading,
      };
  const placement = placeRider(sceneWorld, pose);
  const aheadPose = ridePose(route, Math.min(route.totalDistance, pose.distance + input.lookAheadM), {
    laneOffsetM: pose.laneOffsetM,
    offsetHeading: heading,
  });
  const ahead = placeRider(sceneWorld, aheadPose).position;
  const speed = raw ? pose.speed : input.speed;
  frame.lean += (leanAngle(speed, memo.yaw.rate) - frame.lean) * dampFactor(0.35, dt);
  frame.pose = pose;
  frame.placement = placement;
  frame.ahead.x = ahead.x;
  frame.ahead.y = ahead.y;
  frame.ahead.z = ahead.z;
  frame.speed = speed;
  frame.cadence = input.cadence > 0 ? input.cadence : input.power > 0 ? estimatedCadence(speed) : 0;
  frame.valid = true;
}

/** State one pace bot's drawing carries between frames. */
export interface BotDriverMemo {
  yaw: YawFilter;
  lean: number;
}

export function createBotDriverMemo(): BotDriverMemo {
  return { yaw: new YawFilter(), lean: 0 };
}

/**
 * A pace bot's drawn heading and lean, through the same wide chord and
 * YawFilter as the rider: the bot's own `heading` is the raw ±4 m route
 * bearing, which pivots the model on the spot at sharp corners.
 */
export function driveBotPose(
  memo: BotDriverMemo,
  route: Route | null,
  bot: { distance: number; speed: number; heading: number },
  dt: number,
): { heading: number; lean: number } {
  const target = route && route.points.length >= 2 ? smoothHeadingAt(route, bot.distance, undefined, bot.heading) : bot.heading;
  const heading = memo.yaw.step(target, bot.distance, dt);
  memo.lean += (leanAngle(bot.speed, memo.yaw.rate) - memo.lean) * dampFactor(0.4, dt);
  return { heading, lean: memo.lean };
}
