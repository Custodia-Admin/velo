import { describe, it, expect } from 'vitest';
import {
  CENTRE_OMEGA,
  MAX_LANE_OFFSET_M,
  STEER_DEADZONE,
  STEER_OMEGA,
  createLaneState,
  shapeSteer,
  stepLane,
  type LaneState,
} from './steerFeel';
import { MAX_LANE_OFFSET_M as REEXPORTED } from '@/lib/laneOffset';

/** Run `seconds` of frames at `fps` with constant input; returns the trace of offsets. */
function run(state: LaneState, steer: number, seconds: number, fps = 60): number[] {
  const out: number[] = [];
  const n = Math.round(seconds * fps);
  for (let i = 0; i < n; i++) out.push(stepLane(state, steer, 1 / fps).offsetM);
  return out;
}

describe('shapeSteer — deadzone and expo', () => {
  it('nothing inside the deadzone, both signs', () => {
    expect(shapeSteer(0)).toBe(0);
    expect(shapeSteer(STEER_DEADZONE)).toBe(0);
    expect(shapeSteer(-STEER_DEADZONE)).toBe(0);
    expect(shapeSteer(0.05)).toBe(0);
  });

  it('starts from 0 right at the deadzone edge (no jump)', () => {
    const justOut = shapeSteer(STEER_DEADZONE + 0.001);
    expect(justOut).toBeGreaterThan(0);
    expect(justOut).toBeLessThan(0.002);
  });

  it('full lever is full steer; symmetric', () => {
    expect(shapeSteer(1)).toBeCloseTo(1, 12);
    expect(shapeSteer(-1)).toBeCloseTo(-1, 12);
    expect(shapeSteer(0.6)).toBeCloseTo(-shapeSteer(-0.6), 12);
  });

  it('expo: half travel gives less than linear, still monotonic', () => {
    const lin = shapeSteer(0.56, STEER_DEADZONE, 0); // (0.56-0.12)/0.88 = 0.5
    expect(lin).toBeCloseTo(0.5, 9);
    expect(shapeSteer(0.56)).toBeLessThan(lin);
    let prev = 0;
    for (let x = 0; x <= 1.0001; x += 0.01) {
      const y = shapeSteer(x);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });

  it('clamps out-of-range input and ignores NaN; clamps silly parameters', () => {
    expect(shapeSteer(3)).toBeCloseTo(1, 12);
    expect(shapeSteer(-3)).toBeCloseTo(-1, 12);
    expect(shapeSteer(Number.NaN)).toBe(0);
    expect(shapeSteer(Number.POSITIVE_INFINITY)).toBe(0);
    expect(shapeSteer(0.5, -1, 2)).toBeCloseTo(0.125, 9); // deadzone 0, pure cubic
    expect(shapeSteer(0.99, 5, 0)).toBeGreaterThan(0); // deadzone capped at 0.95
  });
});

describe('stepLane — lane-centring spring', () => {
  it('stays exactly on the line with no input', () => {
    const s = createLaneState();
    expect(run(s, 0, 1).every((x) => x === 0)).toBe(true);
    expect(s.velMs).toBe(0);
  });

  it('full steer settles at the lane edge, never past it, without overshoot', () => {
    const s = createLaneState();
    const trace = run(s, 1, 3);
    expect(Math.max(...trace)).toBeLessThanOrEqual(MAX_LANE_OFFSET_M);
    for (let i = 1; i < trace.length; i++) expect(trace[i]).toBeGreaterThanOrEqual(trace[i - 1] - 1e-12);
    expect(trace[trace.length - 1]).toBeGreaterThan(MAX_LANE_OFFSET_M * 0.999);
    // ~95 % within ~0.95 s (4.74 / ω for a critically damped spring).
    expect(trace[Math.round(60 * (4.74 / STEER_OMEGA))]).toBeGreaterThan(MAX_LANE_OFFSET_M * 0.94);
  });

  it('starts softly: the first frame moves almost nothing (no snap)', () => {
    const s = createLaneState();
    stepLane(s, 1, 1 / 60);
    expect(s.offsetM).toBeLessThan(0.01);
    expect(s.velMs).toBeGreaterThan(0);
  });

  it('half steer holds half the lane', () => {
    const s = createLaneState();
    run(s, -0.5, 4);
    expect(s.offsetM).toBeCloseTo(-MAX_LANE_OFFSET_M / 2, 3);
  });

  it('released: springs back to the line, slower than it steered, no overshoot, then exactly 0', () => {
    const s = createLaneState();
    run(s, 1, 3);
    const back = run(s, 0, 6);
    expect(Math.min(...back)).toBeGreaterThanOrEqual(0); // never crosses to the other side
    const halfSecond = back[29];
    expect(halfSecond).toBeGreaterThan(MAX_LANE_OFFSET_M * 0.7); // gentler than steering
    // Back within 5 cm by ~2.4 s (4.74 / ω), exactly 0 a bit later.
    expect(back[Math.round(60 * (4.74 / CENTRE_OMEGA))]).toBeLessThan(0.1);
    expect(back[back.length - 1]).toBe(0);
    expect(s.velMs).toBe(0);
  });

  it('feels the same at 30, 60 and 144 fps (exact per-frame solution)', () => {
    const at = (fps: number) => {
      const s = createLaneState();
      run(s, 1, 0.5, fps);
      return s.offsetM;
    };
    expect(at(30)).toBeCloseTo(at(60), 9);
    expect(at(144)).toBeCloseTo(at(60), 9);
  });

  it('reversing mid-move keeps the velocity (smooth), and the edge clamp kills outward speed', () => {
    const s = createLaneState();
    run(s, 1, 0.3);
    const v = s.velMs;
    expect(v).toBeGreaterThan(0);
    stepLane(s, -1, 1 / 60);
    expect(s.velMs).toBeGreaterThan(0); // still moving right for a moment, no jerk
    const edge: LaneState = { offsetM: MAX_LANE_OFFSET_M, velMs: 5 };
    stepLane(edge, 1, 1 / 60);
    expect(edge.offsetM).toBe(MAX_LANE_OFFSET_M);
    expect(edge.velMs).toBeLessThanOrEqual(0);
    const left: LaneState = { offsetM: -MAX_LANE_OFFSET_M, velMs: -5 };
    stepLane(left, -1, 1 / 60);
    expect(left.offsetM).toBe(-MAX_LANE_OFFSET_M);
    expect(left.velMs).toBeGreaterThanOrEqual(0);
  });

  it('ignores bad input and caps huge frame gaps', () => {
    const s: LaneState = { offsetM: Number.NaN, velMs: Number.NaN };
    stepLane(s, Number.NaN, 0.016);
    expect(s).toEqual({ offsetM: 0, velMs: 0 });
    const jump = createLaneState();
    stepLane(jump, 1, 30); // tab back from the background
    expect(jump.offsetM).toBeLessThan(MAX_LANE_OFFSET_M);
    const capped = createLaneState();
    stepLane(capped, 1, 0.25);
    expect(jump.offsetM).toBe(capped.offsetM);
    const neg = createLaneState();
    stepLane(neg, 1, -1);
    stepLane(neg, 1, Number.NaN);
    expect(neg.offsetM).toBe(0);
  });

  it('laneOffset re-exports the same lane width', () => {
    expect(REEXPORTED).toBe(MAX_LANE_OFFSET_M);
  });
});
