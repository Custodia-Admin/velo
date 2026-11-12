/**
 * The shared corner lean (card t_84d635ff): the steady-turn lean of a
 * bicycle, into the bend, capped at 20°, none at walking pace, eased.
 */
import { describe, expect, it } from 'vitest';

import {
  CORNER_LEAN_MAX_RAD,
  LEAN_FULL_SPEED_MS,
  LEAN_TAU_S,
  LEAN_WALK_SPEED_MS,
  cornerLeanTarget,
  stepCornerLean,
} from './cornerLean';

const DEG = 180 / Math.PI;
const at = (curvature: number, stretch = 1) => ({ curvature, stretch });

describe('cornerLeanTarget', () => {
  it('is the steady-turn lean atan(v²/(g·r)), into the bend: right for a right-hand bend', () => {
    // 8 m/s round a 20 m radius: atan(64 / (9.81 · 20)) ≈ 18.1°.
    expect(cornerLeanTarget(8, at(1 / 20)) * DEG).toBeCloseTo(Math.atan(64 / (9.81 * 20)) * DEG, 6);
    expect(cornerLeanTarget(8, at(-1 / 20))).toBeCloseTo(-cornerLeanTarget(8, at(1 / 20)), 12);
    expect(cornerLeanTarget(8, at(0))).toBe(0);
  });

  it('uses the speed along the drawn path: slower where the line runs shorter than the route', () => {
    expect(cornerLeanTarget(8, at(1 / 40, 0.5))).toBeCloseTo(Math.atan(16 / (9.81 * 40)), 9);
  });

  it('is capped at 20° however fast or tight', () => {
    expect(CORNER_LEAN_MAX_RAD * DEG).toBeCloseTo(20, 9);
    expect(cornerLeanTarget(15, at(1 / 2))).toBe(CORNER_LEAN_MAX_RAD);
    expect(cornerLeanTarget(15, at(-1 / 2))).toBe(-CORNER_LEAN_MAX_RAD);
  });

  it('is upright at walking pace and below, and builds smoothly to full by 3 m/s', () => {
    const tight = at(1 / 2);
    expect(cornerLeanTarget(0, tight)).toBe(0);
    expect(cornerLeanTarget(LEAN_WALK_SPEED_MS, tight)).toBe(0);
    const mid = cornerLeanTarget((LEAN_WALK_SPEED_MS + LEAN_FULL_SPEED_MS) / 2, tight);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(cornerLeanTarget(LEAN_FULL_SPEED_MS, tight));
    let prev = 0;
    for (let v = LEAN_WALK_SPEED_MS; v <= LEAN_FULL_SPEED_MS + 1; v += 0.05) {
      const l = cornerLeanTarget(v, tight);
      expect(l).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(l - prev).toBeLessThan(0.05);
      prev = l;
    }
  });

  it('never returns a non-number (stopped on a straight, a degenerate point)', () => {
    expect(cornerLeanTarget(Number.NaN, at(0.1))).toBe(0);
    expect(cornerLeanTarget(8, at(Number.NaN))).toBe(0);
    expect(cornerLeanTarget(8, at(0.01, Number.NaN))).toBeCloseTo(Math.atan((64 * 0.01) / 9.81), 9);
  });
});

describe('stepCornerLean', () => {
  it('eases toward the target with a 0.25 s time constant, the same at any frame rate', () => {
    const target = 0.3;
    let at60 = 0;
    for (let i = 0; i < 60 * LEAN_TAU_S; i++) at60 = stepCornerLean(at60, target, 1 / 60);
    let at144 = 0;
    for (let i = 0; i < 144 * LEAN_TAU_S; i++) at144 = stepCornerLean(at144, target, 1 / 144);
    expect(at60).toBeCloseTo(target * (1 - Math.exp(-1)), 6);
    expect(at144).toBeCloseTo(at60, 6);
  });

  it('holds on a zero step and starts at the target from a non-number', () => {
    expect(stepCornerLean(0.2, 0.3, 0)).toBe(0.2);
    expect(stepCornerLean(Number.NaN, 0.3, 1 / 60)).toBe(0.3);
  });
});
