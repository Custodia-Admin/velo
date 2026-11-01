import { describe, expect, it } from 'vitest';

import { headingAt } from '@/lib/gpxParser';
import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { HEADING_HALF_WINDOW_M, MAX_YAW_RATE, YawFilter, headingDelta, smoothHeadingAt } from './rideHeading';

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
    // The raw ±4 m heading turns ≥90° within 10 m near d≈144 m (review finding: 114°/6 m)…
    let rawTurn = 0;
    let rawMax = 0;
    for (let d = 120; d < 170; d += 1) {
      rawTurn = Math.max(rawTurn, Math.abs(headingDelta(headingAt(r, d + 10), headingAt(r, d))));
      rawMax = Math.max(rawMax, Math.abs(headingDelta(headingAt(r, d + 1), headingAt(r, d))));
    }
    expect(rawTurn * DEG).toBeGreaterThanOrEqual(90);
    // …the wide chord never turns more than the bend allows per metre of a 2·W chord.
    let chordMax = 0;
    for (let d = 120; d < 170; d += 1) {
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
