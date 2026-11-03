/**
 * One pure ride step: ride state + inputs + route → where the rider is, how
 * fast they go and what grade they feel.
 *
 * This is the renderer-agnostic core every world renderer reads from (see
 * lib/world/renderer.ts). It wraps the same building blocks the live ride
 * loop uses — `gradientAt` + the 0.18 EMA, `rideDrive` (trainer vs demo
 * physics, virtual gears), the route-end rule of `rideStore.tick` — so a
 * step here and a frame of `useRideLoop` agree number for number
 * (rideSim.test.ts pins that).
 *
 * Pure: no stores, no clocks, no DOM, no Cesium/three/React. Inputs that the
 * loop reads from stores (settings, trainer telemetry, the active gear) come
 * in through `RideSimInputs`.
 */

import type { Route, RideState } from '@/types';
import { headingAt, sampleRouteAtDistance } from '@/lib/gpxParser';
import { gradientAt } from '@/lib/gradientCalculator';
import { offsetSideways } from '@/lib/laneOffset';
import { rideDrive, type RideDriveInput } from '@/lib/rideDrive';
import type { RiderPose } from '@/lib/world/renderer';

/** Grade smoothing, same factor as useRideLoop / useWorkoutEngine. */
export const GRADE_EMA_ALPHA = 0.18;

/** Longest step the sim integrates at once, seconds (matches the loop's clamp). */
export const MAX_STEP_S = 0.1;

export interface RideSimState {
  rideState: RideState;
  /** Distance along the route, metres. */
  distance: number;
  /** Speed the rider moves at, m/s. */
  speed: number;
  /** Ride clock, ms (pauses excluded). */
  elapsedMs: number;
  /** EMA of the route grade, percent; `null` before the first running step. */
  gradeEma: number | null;
}

export interface RideSimInputs {
  /** Seconds since the previous step; clamped to [0, MAX_STEP_S]. */
  dt: number;
  /** Trainer / demo inputs for `rideDrive` (the grade comes from the route). */
  drive: Omit<RideDriveInput, 'gradePct'>;
  /** Loop the route instead of finishing at its end (workouts). */
  loop?: boolean;
  /** Current handlebar lane offset, metres (+ = right). */
  laneOffsetM?: number;
}

export interface RideSimStep {
  state: RideSimState;
  pose: RiderPose;
  /** Power for this step, W (trainer reading or demo power). */
  power: number;
  /** Speed to show when it differs from `state.speed` (virtual gears). */
  displaySpeed?: number;
  /** True when this step reached the end of the route. */
  finished: boolean;
}

export function initialRideSimState(rideState: RideState = 'ready'): RideSimState {
  return { rideState, distance: 0, speed: 0, elapsedMs: 0, gradeEma: null };
}

/**
 * The rider's pose at a distance along the route. Lane offset moves the
 * rider sideways relative to `offsetHeading` (defaults to the route heading
 * at that distance; the chase camera offsets its look-ahead point with the
 * rider's heading, not the look-ahead's).
 */
export function ridePose(
  route: Route,
  distance: number,
  opts: { laneOffsetM?: number; offsetHeading?: number; grade?: number; speed?: number } = {},
): RiderPose {
  const onLine = sampleRouteAtDistance(route, distance);
  const heading = headingAt(route, distance);
  const lane = opts.laneOffsetM ?? 0;
  const { lat, lon } = lane
    ? offsetSideways(onLine.lat, onLine.lon, opts.offsetHeading ?? heading, lane)
    : onLine;
  return {
    lat,
    lon,
    ele: onLine.ele,
    heading,
    grade: opts.grade ?? gradientAt(route, distance),
    speed: opts.speed ?? 0,
    distance: Math.max(0, Math.min(distance, route.totalDistance)),
    laneOffsetM: lane,
  };
}

/**
 * Advance the ride by one step. Only a `running` ride moves; any other state
 * returns the same state and the pose where the rider stands.
 */
export function step(state: RideSimState, inputs: RideSimInputs, route: Route): RideSimStep {
  const lane = inputs.laneOffsetM ?? 0;
  const dt = Math.max(0, Math.min(MAX_STEP_S, Number.isFinite(inputs.dt) ? inputs.dt : 0));

  if (state.rideState !== 'running' || dt === 0) {
    return {
      state,
      pose: ridePose(route, state.distance, {
        laneOffsetM: lane,
        grade: state.gradeEma ?? gradientAt(route, state.distance),
        speed: state.rideState === 'running' ? state.speed : 0,
      }),
      power: 0,
      finished: false,
    };
  }

  // Grade at the rider's position before moving (what the loop sends the trainer).
  const raw = gradientAt(route, state.distance);
  const gradeEma =
    state.gradeEma === null ? raw : GRADE_EMA_ALPHA * raw + (1 - GRADE_EMA_ALPHA) * state.gradeEma;

  const drive = rideDrive({ ...inputs.drive, gradePct: gradeEma });

  let distance = state.distance + drive.speed * dt;
  let rideState: RideState = state.rideState;
  let finished = false;
  if (route.totalDistance > 0 && distance >= route.totalDistance) {
    if (inputs.loop) {
      distance %= route.totalDistance;
    } else {
      distance = route.totalDistance;
      rideState = 'finished';
      finished = true;
    }
  }

  const next: RideSimState = {
    rideState,
    distance,
    speed: drive.speed,
    elapsedMs: state.elapsedMs + dt * 1000,
    gradeEma,
  };

  return {
    state: next,
    pose: ridePose(route, distance, { laneOffsetM: lane, grade: gradeEma, speed: drive.speed }),
    power: drive.power,
    displaySpeed: drive.displaySpeed,
    finished,
  };
}
