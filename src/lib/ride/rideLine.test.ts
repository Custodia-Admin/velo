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
  type LineRoads,
  type RideLine,
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

/** Drawn roads in local (east, north) metres: centrelines with a half-width, as LineRoads. */
function drawnRoads(roads: { pts: [number, number][]; halfWidth: number }[]): LineRoads & { beyond(p: { lat: number; lon: number }): number } {
  const beyond = (p: { lat: number; lon: number }) => {
    const [x, y] = en(p);
    let best = Infinity;
    for (const r of roads) {
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const [ax, ay] = r.pts[i];
        const [bx, by] = r.pts[i + 1];
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
        best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy) - r.halfWidth);
      }
    }
    return best;
  };
  return {
    beyond,
    near: (lat, lon) => (beyond({ lat, lon }) <= 0 ? (la, lo) => beyond({ lat: la, lon: lo }) : null),
  };
}

describe('the drawn line on drawn roads (LineRoads: the world renderer)', () => {
  // A 1.5 m path, 100 m north then 100 m east, and a route 0.3 m inside its centreline (where the
  // shipped routes sit on Tiber park's paths): measured at PR #109's head, a 1 m cut put the drawn
  // rider up to 0.5 m out on the grass at corners like this one.
  const path = [{ pts: [[0, 0], [0, 100], [100, 100]] as [number, number][], halfWidth: 0.75 }];
  const routeOnPath = () =>
    local('path', [
      [0.3, 0],
      [0.3, 50],
      [0.3, 99.7],
      [50, 99.7],
      [100, 99.7],
    ]);

  /** Worst metres beyond the drawn edge at 5 cm steps, where the route point there is on a drawn road; and the worst heading vs travel and turn per 10 cm. */
  function ride(line: RideLine, r: Route, roads: ReturnType<typeof drawnRoads>) {
    const p = createLinePoint();
    const q = createLinePoint();
    let out = -Infinity;
    let crab = 0;
    let snap = 0;
    for (let d = 0; d + 0.1 <= r.totalDistance; d += 0.05) {
      lineSample(line, d, p);
      if (roads.beyond(sampleRouteAtDistance(r, d)) <= 0) out = Math.max(out, roads.beyond(p));
      lineSample(line, d + 0.1, q);
      crab = Math.max(crab, Math.abs(headingDelta(lineSample(line, d + 0.05).heading, bearing(p, q))));
      snap = Math.max(snap, Math.abs(headingDelta(q.heading, p.heading)));
    }
    return { out, crab: crab * DEG, snap: snap * DEG };
  }

  it('keeps a 1.5 m path through its corner, turning the right way and facing the way it moves', () => {
    const r = routeOnPath();
    const roads = drawnRoads(path);
    // Against the route alone the line leaves the path on the inside of the bend.
    expect(ride(buildRideLine(r), r, roads).out).toBeGreaterThan(0.2);
    const line = buildRideLine(r, { roads });
    const on = ride(line, r, roads);
    expect(on.out, 'metres beyond the drawn edge').toBeLessThanOrEqual(0.005);
    expect(on.crab, 'heading vs travel, °').toBeLessThan(1);
    expect(on.snap, 'turn per 10 cm, °').toBeLessThan(12);
    // Still a rounded right turn: turning from before the vertex (99.7 m) to after it.
    const at = createLinePoint();
    expect(lineSample(line, 99, at).heading * DEG).toBeGreaterThan(1);
    expect(lineSample(line, 100.4, at).heading * DEG).toBeLessThan(89);
    expect(lineSample(line, 99.7, at).curvature).toBeGreaterThan(0);
    expect(Math.abs(lineSample(line, 90, at).heading * DEG)).toBeLessThan(0.5);
    expect(Math.abs(lineSample(line, 110, at).heading * DEG - 90)).toBeLessThan(0.5);
  });

  it('keeps on a path it crosses wherever the route is on it, up to the route’s own edges', () => {
    // The route turns right at (0, 100). A 1.5 m path crosses its first leg 31° off square at
    // 98.5 m, where the line already cuts towards the corner. The route runs onto and off the
    // path between the quarter-step checks: before the edge checks the line left it 1.6 cm out
    // (3.3 cm walked every centimetre) while the route was still on it (Lake Annecy: 7.4 cm).
    const r = local('crossing', [
      [0, 0],
      [0, 50],
      [0, 100],
      [50, 100],
      [100, 100],
    ]);
    const roads = drawnRoads([{ pts: [[-3, 100.3], [3, 96.7]], halfWidth: 0.75 }]);
    const on = ride(buildRideLine(r, { roads }), r, roads);
    expect(on.out, 'metres beyond the drawn edge').toBeLessThanOrEqual(0.005);
    expect(on.crab, 'heading vs travel, °').toBeLessThan(1);
    expect(on.snap, 'turn per 10 cm, °').toBeLessThan(12);
  });

  it('is the same line as without roads where the roads are wide (a 7 m road) or the route is on none', () => {
    const r = routeOnPath();
    const plain = buildRideLine(r);
    for (const roads of [drawnRoads([{ ...path[0], halfWidth: 3.5 }]), drawnRoads([{ pts: [[500, 0], [500, 100]], halfWidth: 0.75 }])]) {
      const line = buildRideLine(r, { roads });
      expect(Array.from(line.lat)).toEqual(Array.from(plain.lat));
      expect(Array.from(line.lon)).toEqual(Array.from(plain.lon));
      expect(Array.from(line.heading)).toEqual(Array.from(plain.heading));
    }
  });

  it('caches one line per route: rebuilt for other roads, read as cached without them', () => {
    const r = routeOnPath();
    const roads = drawnRoads(path);
    const plain = rideLineFor(r);
    const kept = rideLineFor(r, roads);
    expect(kept).not.toBe(plain);
    expect(rideLineFor(r, roads)).toBe(kept);
    // The per-frame readers get the line the renderer built.
    expect(rideLineFor(r)).toBe(kept);
    expect(lineAt(r, 99.7).lat).toBe(lineSample(kept, 99.7).lat);
    // Photoreal (no drawn roads) gets the line against the route alone again.
    const again = rideLineFor(r, null);
    expect(again).not.toBe(kept);
    expect(Array.from(again.lat)).toEqual(Array.from(plain.lat));
    expect(rideLineFor(r, null)).toBe(again);
  });
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
