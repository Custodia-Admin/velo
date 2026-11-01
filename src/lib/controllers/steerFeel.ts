/**
 * How the handlebar levers feel when steering.
 *
 *   1. Deadzone: a lever resting slightly off zero does nothing, and the
 *      response starts at 0 right at the deadzone edge (no jump).
 *   2. Expo curve: small pushes give fine lane changes, a full push still
 *      reaches the full lane width.
 *   3. Lane-centring spring: the rider moves across the lane on a critically
 *      damped spring, so lane changes start and stop softly and never
 *      overshoot; let go and the same spring, softer, brings the bike back
 *      to the line.
 *
 * The bike always follows the route; steering only shifts it within the
 * lane. Pure math, used by both renderers once per frame. The spring step is
 * the exact solution for one frame, so the feel does not change with the
 * frame rate.
 */

/** Furthest the rider moves off the route line, metres. */
export const MAX_LANE_OFFSET_M = 1.6;

/** Share of lever travel (0..1) that does nothing. */
export const STEER_DEADZONE = 0.12;
/** 0 = linear, 1 = pure cubic. */
export const STEER_EXPO = 0.45;

/** Spring stiffness while steering, rad/s: about 0.9 s to settle. */
export const STEER_OMEGA = 5;
/** Spring stiffness when the levers are released, rad/s: back on the line in about 2.4 s. */
export const CENTRE_OMEGA = 2;

/** Lever input (-1..1) after the deadzone and the expo curve. */
export function shapeSteer(raw: number, deadzone = STEER_DEADZONE, expo = STEER_EXPO): number {
  if (!Number.isFinite(raw)) return 0;
  const x = Math.max(-1, Math.min(1, raw));
  const mag = Math.abs(x);
  const dz = Math.max(0, Math.min(0.95, deadzone));
  if (mag <= dz) return 0;
  const u = (mag - dz) / (1 - dz);
  const e = Math.max(0, Math.min(1, expo));
  const y = (1 - e) * u + e * u * u * u;
  return Math.sign(x) * y;
}

/** Lane position carried between frames. */
export interface LaneState {
  /** Metres, + = right of travel. */
  offsetM: number;
  /** Metres per second across the lane. */
  velMs: number;
}

export function createLaneState(): LaneState {
  return { offsetM: 0, velMs: 0 };
}

/** Longest frame step accepted, seconds (a tab coming back from the background). */
const MAX_DT_S = 0.25;

/**
 * Advance the lane position by `dtS` seconds with (already shaped) steering
 * input `steer` in -1..1. Mutates and returns `state`, so the per-frame
 * caller allocates nothing.
 */
export function stepLane(state: LaneState, steer: number, dtS: number): LaneState {
  const s = Number.isFinite(steer) ? Math.max(-1, Math.min(1, steer)) : 0;
  const dt = Math.max(0, Math.min(MAX_DT_S, Number.isFinite(dtS) ? dtS : 0));
  const x0 = Number.isFinite(state.offsetM) ? state.offsetM : 0;
  const v0 = Number.isFinite(state.velMs) ? state.velMs : 0;
  const target = s * MAX_LANE_OFFSET_M;
  const w = s === 0 ? CENTRE_OMEGA : STEER_OMEGA;
  // Critically damped: e(t) = (e0 + (v0 + w·e0)·t)·exp(-w·t).
  const e0 = x0 - target;
  const c = v0 + w * e0;
  const k = Math.exp(-w * dt);
  let x = target + (e0 + c * dt) * k;
  let v = (v0 - w * c * dt) * k;
  if (x > MAX_LANE_OFFSET_M) {
    x = MAX_LANE_OFFSET_M;
    v = Math.min(0, v);
  } else if (x < -MAX_LANE_OFFSET_M) {
    x = -MAX_LANE_OFFSET_M;
    v = Math.max(0, v);
  }
  // Snap tiny residuals so the rider sits exactly on the line at rest.
  if (s === 0 && Math.abs(x) < 0.005 && Math.abs(v) < 0.02) {
    x = 0;
    v = 0;
  }
  state.offsetM = x;
  state.velMs = v;
  return state;
}
