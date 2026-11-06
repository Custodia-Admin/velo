import { describe, expect, it } from 'vitest';

import { headingAt } from '@/lib/gpxParser';
import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import {
  HEADING_HALF_WINDOW_M,
  MAX_YAW_RATE,
  YawFilter,
  headingDelta,
  routeBearingAt,
  smoothHeadingAt,
  stepDrawnHeading,
} from './rideHeading';

const DEG = 180 / Math.PI;
const ROUTES = ['scenic-perugia-tiber-park', 'scenic-assisi-valley'];
const route = (id: string) => routeFromGeometry(id, id, SCENIC_ROUTE_GEOMETRY[id]);

/** Ride the whole route at `speed` m/s and `fps`, recording the filtered heading and its rate. */
function ride(id: string, speed: number, fps = 60) {
  const r = route(id);
  const yaw = new YawFilter();
  const dt = 1 / fps;
  const out: { d: number; h: number; rate: number }[] = [];
  for (let d = 0; d <= r.totalDistance; d += speed * dt) {
    const h = yaw.step(smoothHeadingAt(r, d), d, dt);
    out.push({ d, h, rate: yaw.rate });
  }
  return { r, out };
}

describe('smoothHeadingAt', () => {
  it('matches the route bearing on a straight line and spreads a sharp vertex over the chord', () => {
    const r = route('scenic-perugia-tiber-park');
    // The raw ±4 m heading turns ≥90° within 10 m at the 123° junction turn near
    // d≈9,672 m (the 114° vertex at d≈144 m of the review finding went with the
    // 1 m route simplification; this is now the sharpest corner)…
    let rawTurn = 0;
    let rawMax = 0;
    for (let d = 9645; d < 9695; d += 1) {
      rawTurn = Math.max(rawTurn, Math.abs(headingDelta(headingAt(r, d + 10), headingAt(r, d))));
      rawMax = Math.max(rawMax, Math.abs(headingDelta(headingAt(r, d + 1), headingAt(r, d))));
    }
    expect(rawTurn * DEG).toBeGreaterThanOrEqual(90);
    // …the wide chord never turns more than the bend allows per metre of a 2·W chord.
    let chordMax = 0;
    for (let d = 9645; d < 9695; d += 1) {
      chordMax = Math.max(chordMax, Math.abs(headingDelta(smoothHeadingAt(r, d + 1), smoothHeadingAt(r, d))));
    }
    expect(chordMax).toBeLessThan(rawMax);
    expect(HEADING_HALF_WINDOW_M).toBeGreaterThanOrEqual(8);
  });
});

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

describe('stepDrawnHeading (every renderer draws the rider and aims its cameras with it)', () => {
  it('steps the filter toward the wide chord, or toward an outside driver\'s own heading', () => {
    const r = route('scenic-perugia-tiber-park');
    const a = new YawFilter();
    const b = new YawFilter();
    for (let d = 9600; d < 9760; d += 0.2) {
      expect(stepDrawnHeading(a, r, d, 1 / 60)).toBe(b.step(smoothHeadingAt(r, d), d, 1 / 60));
    }
    const c = new YawFilter();
    stepDrawnHeading(c, r, 100, 1 / 60, 1.25);
    expect(c.heading).toBe(1.25);
    expect(stepDrawnHeading(c, r, 100.2, 1 / 60, 1.25)).toBe(1.25);
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
    // The ±4 m and ±12 m chords are only half way round there.
    expect(headingAt(ell, 100.1) * DEG).toBeLessThan(50);
    expect(smoothHeadingAt(ell, 100.1) * DEG).toBeLessThan(50);
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
