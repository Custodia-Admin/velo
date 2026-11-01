/**
 * The world renderer's per-frame ride step, pure: ride-store numbers in →
 * the RideFrame the rider, camera and sky read. ThreeWorldView's RideDriver
 * calls this every frame; the corner-framing tests call the same function.
 */

import { createLaneState, stepLane, type LaneState } from '@/lib/controllers/steerFeel';
import { smoothHeadingAt, YawFilter } from '@/lib/ride/rideHeading';
import { ridePose } from '@/lib/ride/rideSim';
import type { RiderPose } from '@/lib/world/renderer';
import type { RideState, Route } from '@/types';
import { dampFactor } from './chaseRig';
import { estimatedCadence, leanAngle, placeRider } from './riderRig';
import type { RideFrame, SceneWorld } from './worldScene';

/** State the driver carries between frames. */
export interface RideDriverMemo {
  lane: LaneState;
  yaw: YawFilter;
}

export function createRideDriverMemo(): RideDriverMemo {
  return { lane: createLaneState(), yaw: new YawFilter() };
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
  const laneOffsetM = stepLane(memo.lane, input.steer, dt).offsetM;
  const raw = input.override;
  const distance = raw ? raw.distance : input.distance;
  // The drawn heading is the damped wide-chord heading (lib/ride/rideHeading):
  // the raw route bearing swings 114–163° within metres at sharp vertices.
  // The lane offset follows the chord (continuous, no lag) so the rider stays on the road.
  const chord = raw ? raw.heading : smoothHeadingAt(route, distance);
  const heading = memo.yaw.step(chord, distance, dt);
  const pose: RiderPose = raw
    ? { ...raw, heading }
    : {
        ...ridePose(route, distance, { laneOffsetM, offsetHeading: chord, grade: input.grade, speed: input.speed }),
        heading,
      };
  const placement = placeRider(sceneWorld, pose);
  const aheadPose = ridePose(route, Math.min(route.totalDistance, pose.distance + input.lookAheadM), {
    laneOffsetM: pose.laneOffsetM,
    offsetHeading: chord,
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
