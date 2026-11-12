import { describe, expect, it } from 'vitest';

import { headingAt } from '@/lib/gpxParser';
import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { MAX_YAW_RATE, YAW_TAU_S, YawFilter, headingDelta, routeBearingAt, stepCameraHeading } from './rideHeading';
import { lineHeadingAt } from './rideLine';

const DEG = 180 / Math.PI;
const ROUTES = ['scenic-perugia-tiber-park', 'scenic-assisi-valley'];
const route = (id: string) => routeFromGeometry(id, id, SCENIC_ROUTE_GEOMETRY[id]);

/** Ride the whole route at `speed` m/s and `fps`, recording the chase camera's heading and its rate. */
function ride(id: string, speed: number, fps = 60) {
  const r = route(id);
  const yaw = new YawFilter();
  const dt = 1 / fps;
  const out: { d: number; h: number; rate: number }[] = [];
  for (let d = 0; d <= r.totalDistance; d += speed * dt) {
    const h = stepCameraHeading(yaw, r, d, dt, speed);
    out.push({ d, h, rate: yaw.rate });
  }
  return { r, out };
}

describe('YawFilter', () => {
  it('snaps on the first frame and on a seek, then damps toward the target', () => {
    const f = new YawFilter();
    expect(f.step(1, 0, 1 / 60)).toBe(1);
    const h = f.step(2, 0.2, 1 / 60);
    expect(h).toBeGreaterThan(1);
    expect(h).toBeLessThan(1.2);
    expect(f.step(-2, 500, 1 / 60)).toBe(-2);
  });

  it('turns the short way round across ±π', () => {
    const f = new YawFilter();
    f.step(Math.PI - 0.05, 0, 1 / 60);
    for (let i = 0; i < 120; i++) f.step(-Math.PI + 0.05, 0.1 * i, 1 / 60);
    expect(Math.abs(headingDelta(f.heading, -Math.PI + 0.05))).toBeLessThan(1e-3);
  });

  it('is frame-rate independent below the rate cap', () => {
    const run = (fps: number) => {
      const f = new YawFilter();
      f.step(0, 0, 1 / fps);
      for (let i = 0; i < fps / 6; i++) f.step(0.3, 0, 1 / fps);
      return f.heading;
    };
    expect(run(60)).toBeCloseTo(run(120), 4);
    expect(run(60)).toBeCloseTo(run(30), 4);
  });

  for (const id of ROUTES) {
    it(`${id}: turn rate stays under the cap everywhere and the rider never wobbles on straights`, () => {
      for (const speed of [5, 11, 15]) {
        const { r, out } = ride(id, speed);
        let maxRate = 0;
        let straightMax = 0;
        let straightErr = 0;
        for (const s of out) {
          maxRate = Math.max(maxRate, Math.abs(s.rate));
          // Straight: the raw bearing varies < 2° over ±30 m around here.
          if (s.d < 40 || s.d > r.totalDistance - 40) continue;
          const h0 = headingAt(r, s.d);
          let straight = true;
          for (let k = -30; k <= 30 && straight; k += 3) straight = Math.abs(headingDelta(headingAt(r, s.d + k), h0)) < (2 / DEG);
          if (!straight) continue;
          straightMax = Math.max(straightMax, Math.abs(s.rate));
          straightErr = Math.max(straightErr, Math.abs(headingDelta(s.h, h0)));
        }
        expect(maxRate, `${speed} m/s max yaw rate`).toBeLessThanOrEqual(MAX_YAW_RATE + 1e-9);
        // No visible wobble: < 3°/s on straights, and pointing along the road.
        expect(straightMax * DEG, `${speed} m/s straight yaw rate`).toBeLessThan(3);
        expect(straightErr * DEG, `${speed} m/s straight heading error`).toBeLessThan(3);
      }
    });
  }
});

describe('stepCameraHeading (every renderer aims its chase cameras with it)', () => {
  it("steps the filter toward the drawn line's tangent speed·τ ahead, or toward an outside driver's own heading", () => {
    const r = route('scenic-perugia-tiber-park');
    const a = new YawFilter();
    const b = new YawFilter();
    for (let d = 9600; d < 9760; d += 0.2) {
      expect(stepCameraHeading(a, r, d, 1 / 60, 12)).toBe(b.step(lineHeadingAt(r, d + 12 * YAW_TAU_S), d, 1 / 60));
    }
    // Stopped, it reads the tangent where the rider is.
    const s = new YawFilter();
    expect(stepCameraHeading(s, r, 9672, 1 / 60, 0)).toBe(lineHeadingAt(r, 9672));
    const c = new YawFilter();
    stepCameraHeading(c, r, 100, 1 / 60, 8, 1.25);
    expect(c.heading).toBe(1.25);
    expect(stepCameraHeading(c, r, 100.2, 1 / 60, 8, 1.25)).toBe(1.25);
  });

  it('sits square behind the rider through a steady bend: the look-ahead cancels the damper lag', () => {
    // A 50 m-radius circle (a gentle bend no turn-rate cap touches), ridden at 10 m/s.
    const R = 50;
    const k = 111_195;
    const points: [number, number, number][] = [];
    for (let a = 0; a <= Math.PI; a += 0.02) points.push([43 + (R * Math.sin(a)) / k, 12 + (R * (1 - Math.cos(a))) / (k * Math.cos((43 * Math.PI) / 180)), 0]);
    const arc = routeFromGeometry('arc', 'arc', { distanceM: R * Math.PI, ascentM: 0, maxGradePct: 0, points });
    const yaw = new YawFilter();
    const lead = new YawFilter();
    let lagged = 0;
    let led = 0;
    for (let d = 0; d < 120; d += 10 / 60) {
      lagged = headingDelta(yaw.step(lineHeadingAt(arc, d), d, 1 / 60), lineHeadingAt(arc, d));
      led = headingDelta(stepCameraHeading(lead, arc, d, 1 / 60, 10), lineHeadingAt(arc, d));
    }
    // Without the look-ahead the camera trails the bend by ω·τ (10/50 rad/s · 0.15 s ≈ 1.7°).
    expect(Math.abs(lagged) * DEG).toBeGreaterThan(1.4);
    expect(Math.abs(led) * DEG).toBeLessThan(0.2);
  });
});

describe('routeBearingAt', () => {
  /** An L: 100 m north, then 100 m east (points every 50 m). */
  const ell = routeFromGeometry('l', 'l', {
    distanceM: 200,
    ascentM: 0,
    maxGradePct: 0,
    points: [
      [43, 12, 0],
      [43 + 50 / 111_195, 12, 0],
      [43 + 100 / 111_195, 12, 0],
      [43 + 100 / 111_195, 12 + 50 / (111_195 * Math.cos((43 * Math.PI) / 180)), 0],
      [43 + 100 / 111_195, 12 + 100 / (111_195 * Math.cos((43 * Math.PI) / 180)), 0],
    ],
  });

  it('is the direction of the route segment under the distance, with no chord to lag a corner', () => {
    expect(routeBearingAt(ell, 10) * DEG).toBeCloseTo(0, 3);
    expect(routeBearingAt(ell, 99.9) * DEG).toBeCloseTo(0, 3);
    // From the corner on, the next segment: east.
    expect(routeBearingAt(ell, 100.1) * DEG).toBeCloseTo(90, 1);
    expect(routeBearingAt(ell, 199) * DEG).toBeCloseTo(90, 1);
    // The ±4 m chord and the drawn line (which rounds the corner) are only half way round there.
    expect(headingAt(ell, 100.1) * DEG).toBeLessThan(50);
    expect(lineHeadingAt(ell, 100.1) * DEG).toBeLessThan(55);
  });

  it('measures the bearing in ground metres, not degrees (a NE segment at 43° N reads 45°)', () => {
    const k = 111_195;
    const ne = routeFromGeometry('ne', 'ne', {
      distanceM: 141,
      ascentM: 0,
      maxGradePct: 0,
      points: [
        [43, 12, 0],
        [43 + 100 / k, 12 + 100 / (k * Math.cos((43 * Math.PI) / 180)), 0],
      ],
    });
    expect(routeBearingAt(ne, 50) * DEG).toBeCloseTo(45, 1);
  });

  it('holds the last segment past either end, and falls back without one', () => {
    expect(routeBearingAt(ell, -5) * DEG).toBeCloseTo(0, 3);
    expect(routeBearingAt(ell, 250) * DEG).toBeCloseTo(90, 1);
    const dot = routeFromGeometry('p', 'p', { distanceM: 0, ascentM: 0, maxGradePct: 0, points: [[43, 12, 0]] });
    expect(routeBearingAt(dot, 0, 1.25)).toBe(1.25);
  });
});
