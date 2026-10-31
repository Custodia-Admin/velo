import { describe, it, expect } from 'vitest';
import { MAX_LANE_OFFSET_M, offsetSideways, stepLaneOffset } from './laneOffset';

describe('stepLaneOffset', () => {
  it('stays on the line with no input', () => {
    expect(stepLaneOffset(0, 0, 0.016)).toBe(0);
  });

  it('moves toward the steered side and never past the lane edge', () => {
    let x = 0;
    for (let i = 0; i < 600; i++) x = stepLaneOffset(x, 1, 1 / 60);
    expect(x).toBeGreaterThan(MAX_LANE_OFFSET_M * 0.99);
    expect(x).toBeLessThanOrEqual(MAX_LANE_OFFSET_M);
    let y = 0;
    for (let i = 0; i < 600; i++) y = stepLaneOffset(y, -0.5, 1 / 60);
    expect(y).toBeCloseTo(-MAX_LANE_OFFSET_M / 2, 2);
  });

  it('drifts back to the line when released, more slowly than it steers', () => {
    let x = MAX_LANE_OFFSET_M;
    const afterHalfSecond = (() => {
      let v = x;
      for (let i = 0; i < 30; i++) v = stepLaneOffset(v, 0, 1 / 60);
      return v;
    })();
    expect(afterHalfSecond).toBeGreaterThan(MAX_LANE_OFFSET_M * 0.7);
    for (let i = 0; i < 60 * 20; i++) x = stepLaneOffset(x, 0, 1 / 60);
    expect(x).toBe(0);
  });

  it('ignores bad input and huge frame gaps', () => {
    expect(stepLaneOffset(Number.NaN, Number.NaN, 0.016)).toBe(0);
    const jump = stepLaneOffset(0, 1, 30);
    expect(jump).toBeLessThan(MAX_LANE_OFFSET_M);
  });
});

describe('offsetSideways', () => {
  const m = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
    const dLat = (b.lat - a.lat) * 111_195;
    const dLon = (b.lon - a.lon) * 111_195 * Math.cos((a.lat * Math.PI) / 180);
    return { east: dLon, north: dLat };
  };
  const p = { lat: 46.0, lon: 8.95 };

  it('riding north, right is east', () => {
    const d = m(p, offsetSideways(p.lat, p.lon, 0, 1.5));
    expect(d.east).toBeCloseTo(1.5, 2);
    expect(d.north).toBeCloseTo(0, 3);
  });

  it('riding east, right is south', () => {
    const d = m(p, offsetSideways(p.lat, p.lon, Math.PI / 2, 1));
    expect(d.north).toBeCloseTo(-1, 2);
    expect(d.east).toBeCloseTo(0, 3);
  });

  it('zero offset returns the same point', () => {
    expect(offsetSideways(p.lat, p.lon, 1, 0)).toEqual(p);
  });
});
