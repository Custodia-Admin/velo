/**
 * The drawn line (rideLine): the rider, the pace partners and the ghosts are
 * drawn on it and face along it, so the way they face is the way they move.
 *
 * Card t_84d635ff, measured on the shipped worlds before this line existed
 * (the rider drawn on the route polyline at a ±12 m chord heading, then
 * YawFilter): at real corners the drawn rider pointed 29–76° off its own
 * direction of travel ("crabbing"), on 6–41 % of the frames through them.
 */
import { describe, expect, it } from 'vitest';

import { sampleRouteAtDistance } from '@/lib/gpxParser';
import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import type { Route } from '@/types';
import { headingDelta } from './rideHeading';
import {
  LINE_FRAME_RADIUS_M,
  LINE_FRAME_REACH_M,
  buildRideLine,
  createLinePoint,
  lineAt,
  lineHeadingAt,
  lineSample,
  offsetFacing,
  rideLineFor,
} from './rideLine';

const DEG = 180 / Math.PI;
const K = 111_195;
const COS43 = Math.cos((43 * Math.PI) / 180);
/** A route through local (east, north) metre points around 43° N, 12° E. */
function local(id: string, pts: [number, number][]): Route {
  return routeFromGeometry(id, id, {
    distanceM: 0,
    ascentM: 0,
    maxGradePct: 0,
    points: pts.map(([e, n]) => [43 + n / K, 12 + e / (K * COS43), 0] as [number, number, number]),
  });
}
/** Local (east, north) metres of a lat/lon. */
const en = (p: { lat: number; lon: number }): [number, number] => [(p.lon - 12) * K * COS43, (p.lat - 43) * K];
/** Bearing from a to b, radians clockwise from north (local metres at their latitude). */
const bearing = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.atan2((b.lon - a.lon) * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180), b.lat - a.lat);
/** Shift a line point `o` metres right across `h`. */
const across = (p: { lat: number; lon: number }, h: number, o: number) => ({
  lat: p.lat + (-Math.sin(h) * o) / K,
  lon: p.lon + (Math.cos(h) * o) / (K * Math.cos((p.lat * Math.PI) / 180)),
});

const SHIPPED = Object.keys(SCENIC_ROUTE_GEOMETRY).map((id) => routeFromGeometry(id, id, SCENIC_ROUTE_GEOMETRY[id]));

describe('the drawn line', () => {
  it('is the route itself along a straight road, end to end', () => {
    const r = local('straight', [
      [0, 0],
      [0, 50],
      [0, 100],
      [0, 150],
    ]);
    const p = createLinePoint();
    for (const d of [0, 0.4, 37, 75.5, 149.6, 150]) {
      lineAt(r, d, p);
      const on = sampleRouteAtDistance(r, d);
      const [e, n] = en(p);
      const [oe, on_] = en(on);
      expect(Math.hypot(e - oe, n - on_), `at ${d} m`).toBeLessThan(0.01);
      expect(p.heading).toBeCloseTo(0, 6);
      expect(p.curvature).toBeCloseTo(0, 6);
      expect(p.stretch).toBeCloseTo(1, 4);
    }
  });

  it('rounds a right-angle corner: starts turning before the vertex, stays within reach, turns right', () => {
    // 100 m north, then 100 m east: a right turn (clockwise) at d = 100 m.
    const r = local('ell', [
      [0, 0],
      [0, 50],
      [0, 100],
      [50, 100],
      [100, 100],
    ]);
    const line = rideLineFor(r);
    expect(Math.max(...line.offset)).toBeLessThan(1.2);
    // It turns into the bend from a few metres before the vertex, and out of it a few after.
    expect(lineHeadingAt(r, 98) * DEG).toBeGreaterThan(4);
    expect(lineHeadingAt(r, 100) * DEG).toBeGreaterThan(30);
    expect(lineHeadingAt(r, 100) * DEG).toBeLessThan(60);
    expect(lineHeadingAt(r, 102) * DEG).toBeGreaterThan(75);
    expect(lineHeadingAt(r, 104) * DEG).toBeGreaterThan(85);
    // Straight again away from the corner.
    expect(Math.abs(lineHeadingAt(r, 80) * DEG)).toBeLessThan(0.5);
    expect(Math.abs(lineHeadingAt(r, 120) * DEG - 90)).toBeLessThan(0.5);
    // Clockwise all the way round, never back (by more than a few hundredths of a degree).
    let prev = lineHeadingAt(r, 90);
    for (let d = 90; d <= 110; d += 0.1) {
      const h = lineHeadingAt(r, d);
      expect(headingDelta(h, prev) * DEG).toBeGreaterThan(-0.05);
      prev = h;
    }
    expect(lineAt(r, 100).curvature).toBeGreaterThan(0);
  });

  it('turns left the other way round (negative curvature)', () => {
    const r = local('left', [
      [0, 0],
      [0, 100],
      [-100, 100],
    ]);
    expect(Math.abs(lineHeadingAt(r, 120) * DEG + 90)).toBeLessThan(0.5);
    expect(lineAt(r, 100).curvature).toBeLessThan(0);
  });

  it('builds once per route and reads without allocating', () => {
    const r = SHIPPED[0];
    expect(rideLineFor(r)).toBe(rideLineFor(r));
    const out = createLinePoint();
    expect(lineAt(r, 123, out)).toBe(out);
    // Clamped to the route, and safe on a non-finite distance.
    expect(lineAt(r, -50).heading).toBe(lineAt(r, 0).heading);
    expect(lineAt(r, r.totalDistance + 50).lat).toBeCloseTo(lineAt(r, r.totalDistance).lat, 9);
    expect(Number.isFinite(lineAt(r, NaN).lat)).toBe(true);
  });

  for (const r of SHIPPED) {
    it(`${r.id}: faces the way it moves, never snaps, stays on the road`, () => {
      const line = rideLineFor(r);
      // Cuts no corner by more than ~1.4 m (a hairpin smoothed at the narrowest width).
      expect(Math.max(...line.offset)).toBeLessThan(1.45);
      const p = createLinePoint();
      const q = createLinePoint();
      let crab = 0;
      let crabAt = 0;
      let snap = 0;
      let snapAt = 0;
      for (let d = 0; d + 0.1 <= r.totalDistance; d += 0.1) {
        lineSample(line, d, p);
        lineSample(line, d + 0.1, q);
        // The heading midway is the direction of travel over the 10 cm step.
        const mid = lineSample(line, d + 0.05).heading;
        const c = Math.abs(headingDelta(mid, bearing(p, q)));
        if (c > crab) [crab, crabAt] = [c, d];
        // No snap: it turns at most 12° over any 10 cm (sharpest junction kinks: ~10°).
        const s = Math.abs(headingDelta(q.heading, p.heading));
        if (s > snap) [snap, snapAt] = [s, d];
      }
      expect(crab * DEG, `crab at ${crabAt.toFixed(1)} m`).toBeLessThan(1);
      expect(snap * DEG, `turn per 10 cm at ${snapAt.toFixed(1)} m`).toBeLessThan(12);
    });
  }
});

describe("the line's sideways frame (steered rider, pace partner slots)", () => {
  /** Ride `o` metres right of the line across its frame: the worst facing error, and the fastest the facing turns. */
  function rideOffset(r: Route, o: number) {
    const line = rideLineFor(r);
    const p = createLinePoint();
    const q = createLinePoint();
    let err = 0;
    let errAt = 0;
    let spin = 0;
    let spinAt = 0;
    let prevFacing = NaN;
    let rate = 0;
    for (let d = 0; d + 0.1 <= r.totalDistance; d += 0.1) {
      lineSample(line, d, p);
      lineSample(line, d + 0.1, q);
      rate = Math.max(rate, Math.abs(p.frameRate));
      const a = across(p, p.frameHeading, o);
      const b = across(q, q.frameHeading, o);
      const travel = bearing(a, b);
      const m = lineSample(line, d + 0.05);
      const facing = offsetFacing(m, o);
      const e = Math.abs(headingDelta(facing, travel));
      if (e > err) [err, errAt] = [e, d];
      const turn = Number.isFinite(prevFacing) ? Math.abs(headingDelta(facing, prevFacing)) : 0;
      if (turn > spin) [spin, spinAt] = [turn, d];
      prevFacing = facing;
    }
    return { err, errAt, spin, spinAt, rate };
  }

  it('turns no tighter than LINE_FRAME_RADIUS_M, beyond the farthest offset', () => {
    expect(LINE_FRAME_RADIUS_M).toBeGreaterThan(LINE_FRAME_REACH_M);
    for (const r of SHIPPED.slice(0, 6)) expect(rideOffset(r, 0).rate * LINE_FRAME_RADIUS_M, r.id).toBeLessThan(1.02);
  });

  // The farthest a steered rider rides (MAX_LANE_OFFSET_M) and a pace partner giving way to it.
  for (const r of SHIPPED.slice(0, 6)) {
    for (const o of [-2.5, -1.6, 1.6, 2.5]) {
      it(`${r.id}, ${o} m off the line: faces the way it moves and never spins round`, () => {
        const onLine = rideOffset(r, 0);
        const w = rideOffset(r, o);
        // Within a few degrees of its own path; more only where it pivots round the inside of a junction.
        expect(w.err * DEG, `facing error at ${w.errAt.toFixed(1)} m`).toBeLessThan(25);
        // Turning no faster than 2.5 times the line itself does at its sharpest (inside a junction, pivoting).
        expect(w.spin, `facing turn per 10 cm at ${w.spinAt.toFixed(1)} m`).toBeLessThan(2.5 * onLine.spin);
      });
    }
  }

  it('turns round a GPX out-and-back (legs 1 m apart) without looping, at every offset', () => {
    const uTurn = local('u', [
      [0, 0],
      [0, 100],
      [0, 200],
      [1, 200],
      [1, 100],
      [1, 0],
    ]);
    const onLine = rideOffset(uTurn, 0);
    for (const o of [-LINE_FRAME_REACH_M, -1.6, 1.6, LINE_FRAME_REACH_M]) {
      const w = rideOffset(uTurn, o);
      // Never moving against its facing, and turning round no faster than three times the line itself does.
      expect(w.err * DEG, `${o} m: facing error at ${w.errAt.toFixed(1)} m`).toBeLessThan(60);
      expect(w.spin, `${o} m: facing turn per 10 cm at ${w.spinAt.toFixed(1)} m`).toBeLessThan(3 * onLine.spin);
    }
  });

  it("is the line's own heading wherever the line turns no tighter than the frame", () => {
    const r = SCENIC_ROUTE_GEOMETRY['scenic-chengdu-xinglong-lake'] ? routeFromGeometry('x', 'x', SCENIC_ROUTE_GEOMETRY['scenic-chengdu-xinglong-lake']) : SHIPPED[0];
    const line = buildRideLine(r);
    let worst = 0;
    for (let k = 0; k < line.n; k++) {
      if (Math.abs(line.curvature[k]) > 0.5 / LINE_FRAME_RADIUS_M) continue;
      worst = Math.max(worst, Math.abs(headingDelta(line.frameHeading[k], line.heading[k])));
    }
    expect(worst * DEG).toBeLessThan(2);
  });
});
