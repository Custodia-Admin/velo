/**
 * The route's painted guide sits on ONE drawn surface (PR #33 review N3).
 *
 * The bake used to lay a full-width `routeFill` road piece under every route
 * stretch whose centreline was off the mapped roads, padded 2 m into them: a
 * second coplanar surface beside the path, read on screen as a widened path
 * with a square step where each piece began. Now it bends the road the route
 * runs along just far enough to hold the whole guide (centre line ± 0.29 m)
 * on it, and adds a piece only where no road runs along the route at all (a
 * way the OSM snapshot lacks), joining the roads at its two ends like any
 * mapped junction and never alongside one.
 *
 * PR #42 review: a bend never drags a leg that turns off the route onto the
 * road beside it (Locarno 2,072 m), a road end that lay in another road stays
 * in it (no junction notches), the paint check samples every 0.1 m across the
 * whole band (corner overhangs), the fill probe sees short pieces, and the
 * bake reports the final shift.
 *
 * - synthetic: what the bake's fit does (tools/worldbake/routeCoverage.mjs);
 * - shipped: every bundle in public/worlds, measured the way the renderer
 *   draws roads (flat ends, real widths), against the mapped line of every
 *   road the fit bent (tools/worldbake/reports/<id>.json routeFit.bent).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { createProjection } from './projection';
import { ROAD_CLASSES, ROAD_FLAGS } from '../../../tools/worldbake/buildVectors.mjs';
import {
  ROUTE_EASE_CORNER_M,
  ROUTE_EASE_MAX_M,
  ROUTE_EASE_TAPER_M,
  ROUTE_PAINT_HALF_M,
  easeRoadsOntoRoutes,
  routePaintCoverage,
  routeRoadCoverage,
  sampleAppRoute,
} from '../../../tools/worldbake/routeCoverage.mjs';

interface Road { c: number; f?: number; w?: number; n?: number; p: number[] }
interface Layer { classes: string[]; widths: number[]; flags: Record<string, number>; names: string[]; roads: Road[] }
interface Sampled { id: string; x: number[]; y: number[]; s: number[] }

const CLS = Object.fromEntries(ROAD_CLASSES.map(([c]: [string, number], i: number) => [c, i])) as Record<string, number>;
const dm = (pts: [number, number][]) => pts.flatMap(([x, y]) => [Math.round(x * 10), Math.round(y * 10)]);

function layer(roads: Road[]): Layer {
  return {
    classes: ROAD_CLASSES.map(([c]: [string, number]) => c),
    widths: ROAD_CLASSES.map(([, w]: [string, number]) => w),
    flags: ROAD_FLAGS,
    names: [],
    roads,
  };
}

/** A route through `pts` (metres), sampled every metre like the bake samples the app route. */
function route(id: string, pts: [number, number][]): Sampled {
  const out: Sampled = { id, x: [pts[0][0]], y: [pts[0][1]], s: [0] };
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const len = Math.hypot(bx - ax, by - ay);
    const k = Math.max(1, Math.ceil(len));
    const s0 = out.s[out.s.length - 1];
    for (let j = 1; j <= k; j++) {
      out.x.push(ax + ((bx - ax) * j) / k);
      out.y.push(ay + ((by - ay) * j) / k);
      out.s.push(s0 + (len * j) / k);
    }
  }
  return out;
}

const metres = (r: Road) => r.p.map((v) => v / 10);
const isFill = (r: Road) => ((r.f ?? 0) & ROAD_FLAGS.routeFill) !== 0;

/** [xMin, yMin, xMax, yMax] of a polyline grown by `pad` metres. */
function bbox(p: number[], pad: number): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 1 < p.length; i += 2) {
    b[0] = Math.min(b[0], p[i]); b[1] = Math.min(b[1], p[i + 1]);
    b[2] = Math.max(b[2], p[i]); b[3] = Math.max(b[3], p[i + 1]);
  }
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

/** Distance past a road's drawn edge (flat ends, as roadRibbons draws it), metres. */
function edgeOf(x: number, y: number, p: number[], half: number) {
  let best = Infinity;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], ay = p[i + 1], dx = p[i + 2] - ax, dy = p[i + 3] - ay;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) continue;
    const len = Math.sqrt(l2);
    const raw = ((x - ax) * dx + (y - ay) * dy) / l2;
    const past = i === 0 && raw < 0 ? -raw * len : i + 4 >= p.length && raw > 1 ? (raw - 1) * len : 0;
    let e: number;
    if (past > 0) {
      const lat = Math.abs((x - ax) * dy - (y - ay) * dx) / len;
      e = lat <= half ? past : Math.hypot(lat - half, past);
    } else {
      const t = Math.max(0, Math.min(1, raw));
      e = Math.hypot(x - ax - t * dx, y - ay - t * dy) - half;
    }
    best = Math.min(best, e);
  }
  return best;
}

const steps = (roads: Layer) => roads.classes.indexOf('steps');
/** A road the renderer draws as a ribbon (not steps, not in a tunnel). */
const drawn = (roads: Layer, r: Road) => r.c !== steps(roads) && !((r.f ?? 0) & ROAD_FLAGS.tunnel) && r.p.length >= 4;
const halfOf = (roads: Layer, r: Road) => Math.max(1, r.w ?? roads.widths[r.c]) / 2;
const overlaps = (a: number[], b: number[]) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function cumulative(p: number[]) {
  const cum = [0];
  for (let i = 2; i < p.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]));
  return cum;
}

/** Points every `step` metres along each segment of a polyline, every vertex included, with the distance along it. */
function along(p: number[], step: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  const cum = cumulative(p);
  for (let i = 1; i < cum.length; i++) {
    const seg = cum[i] - cum[i - 1];
    for (let u = 0; u < seg; u += step) {
      const f = u / seg;
      out.push([p[2 * i - 2] + (p[2 * i] - p[2 * i - 2]) * f, p[2 * i - 1] + (p[2 * i + 1] - p[2 * i - 1]) * f, cum[i - 1] + u]);
    }
  }
  out.push([p[p.length - 2], p[p.length - 1], cum[cum.length - 1]]);
  return out;
}

/** The point of polyline `p` nearest (x, y), and the unit direction of its segment there. */
function nearest(x: number, y: number, p: number[]) {
  let best = { d: Infinity, x: 0, y: 0, ux: 1, uy: 0 };
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], ay = p[i + 1], dx = p[i + 2] - ax, dy = p[i + 3] - ay;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    const qx = ax + t * dx, qy = ay + t * dy;
    const d = Math.hypot(x - qx, y - qy);
    const l = Math.sqrt(l2);
    if (d < best.d) best = { d, x: qx, y: qy, ux: dx / l, uy: dy / l };
  }
  return best;
}

/** Largest distance from either polyline to the other, metres (both densified to 0.1 m). */
function hausdorff(a: number[], b: number[]) {
  let h = 0;
  for (const [x, y] of along(a, 0.1)) h = Math.max(h, nearest(x, y, b).d);
  for (const [x, y] of along(b, 0.1)) h = Math.max(h, nearest(x, y, a).d);
  return h;
}

/** A road's flat end: its centre and both corners, and the road's direction out of it. */
function endPoints(p: number[], end: 0 | 1, half: number) {
  const n = p.length;
  const [x, y, px, py] = end === 0 ? [p[0], p[1], p[2], p[3]] : [p[n - 2], p[n - 1], p[n - 4], p[n - 3]];
  const l = Math.hypot(x - px, y - py) || 1;
  const ux = (x - px) / l, uy = (y - py) / l;
  return { pts: [[x, y], [x - uy * half, y + ux * half], [x + uy * half, y - ux * half]] as [number, number][], ux, uy };
}

interface Drawn { i: number; p: number[]; half: number; box: number[] }

/**
 * The mapped roads (fills left out) as drawn, before and after the fit:
 * `before` puts back the mapped line of every road in `mapped` (index →
 * polyline in decimetres).
 */
function drawnPair(roads: Layer, mapped: Map<number, number[]>) {
  const before: (Drawn | null)[] = [];
  const after: (Drawn | null)[] = [];
  roads.roads.forEach((r, i) => {
    if (isFill(r) || !drawn(roads, r)) { before.push(null); after.push(null); return; }
    const half = halfOf(roads, r);
    const pa = metres(r);
    const pb = mapped.has(i) ? mapped.get(i)!.map((v) => v / 10) : pa;
    before.push({ i, p: pb, half, box: bbox(pb, half) });
    after.push({ i, p: pa, half, box: bbox(pa, half) });
  });
  return { before, after };
}

/**
 * Where a road the fit moved newly lies over another drawn road along its
 * length, metres deep (its drawn width reaching past the other's edge) and
 * long, compared with the mapped lines. Points within reach of a junction the
 * two roads already had (an end of either inside the other) don't count: a
 * fork's arms run within reach of each other there.
 */
function newOverlaps(roads: Layer, mapped: Map<number, number[]>, minDepth = 0.1) {
  const { before, after } = drawnPair(roads, mapped);
  const found: { road: number; other: number; depthM: number; lengthM: number; at: string }[] = [];
  for (const i of mapped.keys()) {
    const A = after[i], B = before[i];
    if (!A || !B) continue;
    const others = after.filter((o): o is Drawn => !!o && o.i !== i && (overlaps(o.box, bbox(A.p, A.half)) || overlaps(before[o.i]!.box, bbox(B.p, B.half))));
    // The junctions the two had as mapped, each with the reach of its fork.
    const zones = new Map<number, { x: number; y: number; r: number }[]>();
    for (const o of others) {
      const O = before[o.i]!;
      const z: { x: number; y: number; r: number }[] = [];
      for (const [a, b] of [[B, O], [O, B]]) {
        for (const end of [0, 1] as const) {
          const { pts, ux, uy } = endPoints(a.p, end, a.half);
          for (const [x, y] of pts) {
            if (edgeOf(x, y, b.p, b.half) > 0.05) continue;
            const q = nearest(x, y, b.p);
            const sin = Math.abs(ux * q.uy - uy * q.ux);
            const hh = a.half + b.half;
            z.push({ x, y, r: hh + Math.min(10, hh / Math.max(sin, 0.1)) });
          }
        }
      }
      zones.set(o.i, z);
    }
    for (const o of others) {
      let depth = 0, length = 0, at = '';
      for (const [x, y] of along(A.p, 0.1)) {
        const deep = A.half - edgeOf(x, y, o.p, o.half);
        if (deep <= minDepth) continue;
        const q = nearest(x, y, B.p);
        if (A.half - edgeOf(q.x, q.y, before[o.i]!.p, o.half) > 0) continue;
        if (zones.get(o.i)!.some((z) => Math.hypot(q.x - z.x, q.y - z.y) <= z.r)) continue;
        length += 0.1;
        if (deep > depth) { depth = deep; at = `(${x.toFixed(1)}, ${y.toFixed(1)})`; }
      }
      if (length > 0) found.push({ road: i, other: o.i, depthM: Math.round(depth * 100) / 100, lengthM: Math.round(length * 10) / 10, at });
    }
  }
  return found;
}

/**
 * Road ends (centre or a corner of the flat end) that lay in another drawn
 * road as mapped and no longer lie in any (beyond `tol` metres) as fitted: a
 * notch opened at a junction.
 */
function openedEnds(roads: Layer, mapped: Map<number, number[]>, tol = 0.05) {
  const { before, after } = drawnPair(roads, mapped);
  const moved = [...mapped.keys()].filter((i) => after[i]).map((i) => [bbox(before[i]!.p, 3), bbox(after[i]!.p, 3)]).flat();
  const cover = (set: (Drawn | null)[], j: number, x: number, y: number) => {
    let best = Infinity;
    for (const o of set) if (o && o.i !== j && x >= o.box[0] && x <= o.box[2] && y >= o.box[1] && y <= o.box[3]) best = Math.min(best, edgeOf(x, y, o.p, o.half));
    return best;
  };
  const found: { road: number; end: number; point: string; pastEdgeM: number; at: string }[] = [];
  for (const B of before) {
    if (!B || !moved.some((m) => overlaps(m, B.box))) continue;
    const A = after[B.i]!;
    for (const end of [0, 1] as const) {
      const pb = endPoints(B.p, end, B.half).pts;
      const pa = endPoints(A.p, end, A.half).pts;
      pb.forEach(([x, y], k) => {
        if (cover(before, B.i, x, y) > tol) return;
        const e = cover(after, B.i, pa[k][0], pa[k][1]);
        if (e > tol) found.push({ road: B.i, end, point: k ? 'corner' : 'centre', pastEdgeM: Math.round(e * 100) / 100, at: `(${pa[k][0].toFixed(1)}, ${pa[k][1].toFixed(1)})` });
      });
    }
  }
  return found;
}

/**
 * How far a route-fill piece reaches into the mapped roads away from its two
 * ends (its junctions), metres; ≤ 0 means it never lies over one there. At
 * each end only the roads that end lies in are excused, and only up to where
 * the piece's centre line leaves them plus its half-width; its middle is
 * always probed, so a piece lying along a road (inside it end to end) counts
 * however short.
 */
function fillOverlapM(roads: Layer): { worst: number; at: string } {
  const mapped = roads.roads
    .filter((r) => !isFill(r) && drawn(roads, r))
    .map((r) => ({ p: metres(r), half: halfOf(roads, r) }))
    .map((m) => ({ ...m, box: bbox(m.p, m.half) }));
  let worst = -Infinity;
  let at = '';
  const probe = (x: number, y: number, half: number, near: typeof mapped, excused: (m: (typeof mapped)[number]) => boolean) => {
    for (const m of near) {
      if (excused(m)) continue;
      const reach = half - edgeOf(x, y, m.p, m.half);
      if (reach > worst) { worst = reach; at = `(${x.toFixed(1)}, ${y.toFixed(1)})`; }
    }
  };
  for (const f of roads.roads.filter(isFill)) {
    const p = metres(f);
    const half = halfOf(roads, f);
    const near = mapped.filter((m) => overlaps(m.box, bbox(p, half)));
    const pts = along(p, 0.05);
    const total = pts[pts.length - 1][2];
    // At each end: the roads it lies in are excused while the piece is still
    // inside them or moving away from them (its reach into them shrinking).
    const ends = ([0, 1] as const).map((end) => {
      const [ex, ey] = end === 0 ? [p[0], p[1]] : [p[p.length - 2], p[p.length - 1]];
      const joined = near.filter((m) => edgeOf(ex, ey, m.p, m.half) <= 0.05);
      const seq = end === 0 ? pts : [...pts].reverse();
      let until = total;
      let prev = Infinity;
      for (const [x, y, d] of seq) {
        const inside = joined.some((m) => edgeOf(x, y, m.p, m.half) <= 0);
        const reach = Math.max(-Infinity, ...joined.map((m) => half - edgeOf(x, y, m.p, m.half)));
        if (!inside && reach >= prev - 1e-6) { until = end === 0 ? d : total - d; break; }
        prev = reach;
      }
      return { joined, until };
    });
    for (const [x, y, d] of pts) {
      probe(x, y, half, near, (m) => (d < ends[0].until && ends[0].joined.includes(m)) || (d > total - ends[1].until && ends[1].joined.includes(m)));
    }
    // The middle: its centre line must be off every mapped road.
    const [mx, my] = pts[Math.floor(pts.length / 2)];
    for (const m of near) {
      const reach = half - Math.max(0, edgeOf(mx, my, m.p, m.half));
      if (edgeOf(mx, my, m.p, m.half) <= 0 && reach > worst) { worst = reach; at = `(${mx.toFixed(1)}, ${my.toFixed(1)}) mid`; }
    }
  }
  return { worst, at };
}

const clone = (roads: Layer): Layer => JSON.parse(JSON.stringify(roads));
/** The mapped line (dm) of every road the fit changed, from a copy taken before it. */
function changedFrom(before: Layer, after: Layer) {
  const m = new Map<number, number[]>();
  before.roads.forEach((r, i) => { if (r.p.join() !== after.roads[i].p.join()) m.set(i, r.p); });
  return m;
}

describe('bake: fit the drawn roads to a route (one surface under the guide)', () => {
  it('bends a path mapped beside the route onto it, and adds nothing', () => {
    // A 1.5 m path along y = 0; the route leaves it for 20 m, 1.2 m to the side (0.45 m past its edge).
    const path: [number, number][] = [];
    for (let x = -100; x <= 100; x += 25) path.push([x, 0]);
    const roads = layer([{ c: CLS.path, p: dm(path) }]);
    const r = route('r', [[-100, 0], [-16, 0], [-10, 1.2], [10, 1.2], [16, 0], [100, 0]]);
    expect(routePaintCoverage([r], roads)[0].pct).toBeLessThan(100);

    const fit = easeRoadsOntoRoutes([r], roads);
    expect(roads.roads).toHaveLength(1);
    expect(roads.roads.some(isFill)).toBe(false);
    expect(fit.joins).toBe(0);
    expect(routePaintCoverage([r], roads)[0].pct).toBe(100);
    expect(routeRoadCoverage([r], roads, 0)[0].pct).toBe(100);

    const p = metres(roads.roads[0]);
    // Far from the stretch the path keeps its mapped points exactly.
    for (const x of [-100, -75, -50, 50, 75, 100]) expect(p.some((v, i) => i % 2 === 0 && v === x && p[i + 1] === 0)).toBe(true);
    // It bends gently: back on its mapped line within the taper, no kink.
    const reach = 16 + 1 + ROUTE_EASE_TAPER_M + 1;
    let slope = 0;
    for (let i = 0; i + 3 < p.length; i += 2) {
      if (Math.abs(p[i]) > reach || Math.abs(p[i + 2]) > reach) {
        expect(p[i + 1]).toBe(0);
        continue;
      }
      if (p[i + 2] !== p[i]) slope = Math.max(slope, Math.abs((p[i + 3] - p[i + 1]) / (p[i + 2] - p[i])));
    }
    expect(slope).toBeGreaterThan(0);
    expect(slope).toBeLessThan(0.3);
    expect(ROUTE_EASE_TAPER_M).toBeGreaterThanOrEqual(5);
  });

  it('never bends a road the route crosses: it stretches the path it runs along instead', () => {
    // The route runs east on a path that stops 1 m short of a 6 m road it crosses,
    // and carries on along a second path that starts 1 m past the far edge.
    const roads = layer([
      { c: CLS.path, p: dm([[-60, 0], [-4, 0]]) },
      { c: CLS.tertiary, p: dm([[0, -60], [0, 60]]) },
      { c: CLS.path, p: dm([[4, 0], [60, 0]]) },
    ]);
    const crossing = [...roads.roads[1].p];
    const r = route('r', [[-60, 0], [60, 0]]);
    expect(routePaintCoverage([r], roads)[0].pct).toBeLessThan(100);

    easeRoadsOntoRoutes([r], roads);
    expect(roads.roads[1].p).toEqual(crossing);
    expect(roads.roads.some(isFill)).toBe(false);
    expect(routePaintCoverage([r], roads)[0].pct).toBe(100);
  });

  it('adds the way the snapshot lacks where no road runs along the route, joining the roads at its ends only', () => {
    // Two paths 30 m apart end to end; the route crosses the grass between them.
    const roads = layer([
      { c: CLS.path, p: dm([[-80, 0], [-15, 0]]) },
      { c: CLS.path, p: dm([[15, 0], [80, 0]]) },
      // A track running alongside, farther than ROUTE_EASE_MAX_M from the route: left alone.
      { c: CLS.track, p: dm([[-80, ROUTE_EASE_MAX_M + 3], [80, ROUTE_EASE_MAX_M + 3]]) },
    ]);
    const track = [...roads.roads[2].p];
    const r = route('r', [[-80, 0], [80, 0]]);
    const fit = easeRoadsOntoRoutes([r], roads);

    expect(fit.joins).toBe(1);
    const fills = roads.roads.filter(isFill);
    expect(fills).toHaveLength(1);
    expect(roads.roads[2].p).toEqual(track);
    expect(routePaintCoverage([r], roads)[0].pct).toBe(100);
    // It reaches into each path at its ends (as fitted) and lies over no road in between.
    const p = metres(fills[0]);
    const westEnd = Math.max(...metres(roads.roads[0]).filter((_, i) => i % 2 === 0));
    const eastStart = Math.min(...metres(roads.roads[1]).filter((_, i) => i % 2 === 0));
    expect(Math.min(p[0], p[p.length - 2])).toBeLessThan(westEnd);
    expect(Math.max(p[0], p[p.length - 2])).toBeGreaterThan(eastStart);
    expect(fillOverlapM(roads).worst).toBeLessThanOrEqual(0.05);
  });

  it("measures road ends the way they are drawn: flat, not round", () => {
    const roads = layer([{ c: CLS.path, p: dm([[0, 0], [10, 0]]) }]);
    const r = route('r', [[0, 0], [12, 0]]);
    const c = routeRoadCoverage([r], roads, 0)[0];
    expect(c.misses).toHaveLength(1);
    expect(c.misses[0].fromS).toBe(10);
  });

  it('the overlap probe catches a full-width piece laid beside a path (the old route fill)', () => {
    // What the old bake laid at Tiber 4,160 m: a 1.5 m piece on the route, 0.6 m past a 1.5 m path's edge.
    const roads = layer([
      { c: CLS.path, p: dm([[0, 0], [60, 0]]) },
      { c: CLS.path, f: ROAD_FLAGS.routeFill, p: dm([[10, 1.35], [50, 1.35]]) },
    ]);
    expect(fillOverlapM(roads).worst).toBeGreaterThan(0.1);
  });

  it('the overlap probe sees a short piece too: 3 m laid along a path, inside it or just beside it (review X3b)', () => {
    for (const y of [0.6, 0.9]) {
      const roads = layer([
        { c: CLS.path, p: dm([[0, 0], [60, 0]]) },
        { c: CLS.path, f: ROAD_FLAGS.routeFill, p: dm([[20, y], [23, y]]) },
      ]);
      expect(fillOverlapM(roads).worst, `piece ${y} m off the path`).toBeGreaterThan(0.1);
    }
  });

  it('bends a corner the route runs past by at most ROUTE_EASE_CORNER_M, never down the leg that turns away (Locarno 2,072 m)', () => {
    // A 1.5 m path runs west along y = 0, turns south at (-3, 0), steps 1 m and runs on
    // south; a 6 m road runs beside that leg, 0.15 m past its edge.
    const path = { c: CLS.path, p: dm([[40, 0], [-3, 0], [-3, -1], [-3, -40]]) };
    const roads = layer([path, { c: CLS.tertiary, p: dm([[-6.9, -2.5], [-6.9, -40]]) }]);
    const before = clone(roads);
    // The route runs on 1 m past the corner: its paint ends 0.29 m past the path's edge.
    const r = route('r', [[40, 0], [-4, 0]]);
    expect(routePaintCoverage([r], roads)[0].pct).toBeLessThan(100);
    const fit = easeRoadsOntoRoutes([r], roads);
    expect(fit.joins).toBe(0);
    expect(routePaintCoverage([r], roads)[0].pct).toBe(100);
    // The corner moved; the leg from its next vertex on kept its mapped line.
    const p = metres(roads.roads[0]);
    expect(p.slice(0, 2)).toEqual([40, 0]);
    expect(p.slice(-4)).toEqual([-3, -1, -3, -40]);
    expect(newOverlaps(roads, changedFrom(before, roads))).toEqual([]);
    expect(fit.roadsEased).toBe(1);
    expect(fit.maxShiftM).toBe(Math.round(hausdorff(metres(before.roads[0]), p) * 100) / 100);
    expect(fit.maxShiftM).toBeGreaterThan(0.2);
    expect(fit.maxShiftM).toBeLessThanOrEqual(ROUTE_EASE_CORNER_M);

    // The route crosses 2.25 m of grass from that corner to a road: a join, not a 2.3 m bend.
    const roads2 = layer([{ ...path }, { c: CLS.tertiary, p: dm([[-9, -20], [-9, 20]]) }]);
    const before2 = clone(roads2);
    const r2 = route('r2', [[40, 0], [-9, 0]]);
    const fit2 = easeRoadsOntoRoutes([r2], roads2);
    expect(fit2.joins).toBe(1);
    expect(routePaintCoverage([r2], roads2)[0].pct).toBe(100);
    expect(hausdorff(metres(before2.roads[0]), metres(roads2.roads[0]))).toBeLessThanOrEqual(ROUTE_EASE_CORNER_M + 0.05);
    expect(fillOverlapM(roads2).worst).toBeLessThanOrEqual(0.05);
  });

  it('moves the end of a road that met a bent one with it: no notch opens at the junction', () => {
    // Two paths meet end to end at (0, 0); the route runs 0.8 m south of the first one
    // for 14 m, back on it 2 m before the junction.
    const roads = layer([
      { c: CLS.path, p: dm([[-40, 0], [0, 0]]) },
      { c: CLS.path, p: dm([[0, 0], [40, 2]]) },
    ]);
    const before = clone(roads);
    const r = route('r', [[-40, 0], [-24, 0], [-20, -0.8], [-6, -0.8], [-2, 0], [0, 0], [40, 2]]);
    const fit = easeRoadsOntoRoutes([r], roads);
    expect(fit.roadsEased).toBe(2);
    expect(routePaintCoverage([r], roads)[0].pct).toBe(100);
    const moved = changedFrom(before, roads);
    expect([...moved.keys()]).toEqual([0, 1]);
    expect(openedEnds(roads, moved)).toEqual([]);
    expect(newOverlaps(roads, moved)).toEqual([]);
  });

  it('bends only the road the route runs along: never two paths either side of it at once', () => {
    // Paths 0.9 m north and 1.3 m south of the route's 28 m dip: its paint falls between them.
    const roads = layer([
      { c: CLS.path, p: dm([[-60, 0.9], [60, 0.9]]) },
      { c: CLS.path, p: dm([[-60, -1.3], [60, -1.3]]) },
    ]);
    const before = clone(roads);
    const r = route('r', [[-60, 0.9], [-20, 0.9], [-14, 0], [14, 0], [20, 0.9], [60, 0.9]]);
    expect(routePaintCoverage([r], roads)[0].pct).toBeLessThan(100);
    const fit = easeRoadsOntoRoutes([r], roads);
    expect(routePaintCoverage([r], roads)[0].pct).toBe(100);
    expect([...changedFrom(before, roads).keys()]).toEqual([0]);
    expect(fit.roadsEased).toBe(1);
    expect(fit.maxShiftM).toBe(Math.round(hausdorff(metres(before.roads[0]), metres(roads.roads[0])) * 100) / 100);
  });

  it('a road ending on the side of another drags that side along when the route bends its end across it', () => {
    // A path ends obliquely on another path's centre line; the route runs 0.9 m to its
    // north-east and stops a metre short of the junction.
    const roads = layer([
      { c: CLS.path, p: dm([[-40, 0], [40, 0]]) },
      { c: CLS.path, p: dm([[-20, 20], [0, 0]]) },
    ]);
    const before = clone(roads);
    const off = 0.9 / Math.SQRT2;
    const r = route('r', [[-20 + off, 20 + off], [-1 + off, 1 + off]]);
    expect(routePaintCoverage([r], roads)[0].pct).toBeLessThan(100);
    const fit = easeRoadsOntoRoutes([r], roads);
    expect(routePaintCoverage([r], roads)[0].pct).toBe(100);
    const moved = changedFrom(before, roads);
    expect([...moved.keys()]).toEqual([0, 1]);
    expect(fit.roadsEased).toBe(2);
    expect(openedEnds(roads, moved)).toEqual([]);
  });

  it('straightens a path that crosses the route at a slant: the nearer pull wins, so no bump (Locarno 2,066 m)', () => {
    // A path crosses the route at 17°; the route runs straight along y = 0 for 16 m over it.
    const roads = layer([{ c: CLS.path, p: dm([[-30, -9.2], [30, 9.2]]) }]);
    const r = route('r', [[-8, 0], [8, 0]]);
    easeRoadsOntoRoutes([r], roads);
    expect(routePaintCoverage([r], roads)[0].pct).toBe(100);
    // Along the route the path climbs steadily from its south edge to its north one: it never
    // turns back (a bump the next pass would have to patch around).
    const p = metres(roads.roads[0]);
    for (let i = 0; i + 3 < p.length; i += 2) {
      expect(p[i + 2]).toBeGreaterThan(p[i]);
      if (p[i + 2] > -9 && p[i] < 9) expect(p[i + 3], `at x ${p[i + 2]}`).toBeGreaterThanOrEqual(p[i + 1] - 0.01);
    }
  });

  it('checks the paint edge to edge across the band: a 0.1 m crack between two roads under it counts', () => {
    const roads = layer([
      { c: CLS.path, p: dm([[-50, -0.6], [50, -0.6]]) },
      { c: CLS.path, p: dm([[-50, 1], [50, 1]]) },
    ]);
    const r = route('r', [[-40, 0], [40, 0]]);
    const c = routePaintCoverage([r], roads)[0];
    expect(c.pct).toBe(0);
    expect(c.misses[0].maxOffM).toBeGreaterThan(0.02);
    easeRoadsOntoRoutes([r], roads);
    expect(routePaintCoverage([r], roads)[0].pct).toBe(100);
  });

  it('checks the paint every 0.1 m: a corner overhang shorter than a metre counts (Locarno 2,060 m), and the fit closes it', () => {
    // Two paths meet at a right angle, flat end to flat end at (0, 0); the route turns 0.2 m past the corner.
    const roads = layer([
      { c: CLS.path, p: dm([[-30, 0], [0, 0]]) },
      { c: CLS.path, p: dm([[0, 0], [0, 30]]) },
    ]);
    const r = route('r', [[-30, 0], [0.2, 0], [0.2, 30]]);
    const c = routePaintCoverage([r], roads)[0];
    expect(c.misses).toHaveLength(1);
    expect(c.misses[0].maxOffM).toBeGreaterThanOrEqual(0.19);
    expect(c.misses[0].lengthM).toBeLessThanOrEqual(2);
    const before = clone(roads);
    easeRoadsOntoRoutes([r], roads);
    expect(routePaintCoverage([r], roads)[0].pct).toBe(100);
    expect(openedEnds(roads, changedFrom(before, roads))).toEqual([]);
  });
});

const WORLDS = fileURLToPath(new URL('../../../public/worlds', import.meta.url));
const RECIPES = fileURLToPath(new URL('../../../tools/worldbake/worlds', import.meta.url));
const REPORTS = fileURLToPath(new URL('../../../tools/worldbake/reports', import.meta.url));

interface RouteFitReport { roadsBent: number; maxShiftM: number; joins: number; bent: { road: number; shiftM: number; mapped: string }[] }

function shippedWorlds() {
  return readdirSync(WORLDS)
    .filter((id) => existsSync(join(WORLDS, id, 'manifest.json')) && existsSync(join(RECIPES, `${id}.json`)))
    .map((id) => {
      const manifest = JSON.parse(readFileSync(join(WORLDS, id, 'manifest.json'), 'utf8'));
      const recipe = JSON.parse(readFileSync(join(RECIPES, `${id}.json`), 'utf8'));
      const roads: Layer = JSON.parse(gunzipSync(readFileSync(join(WORLDS, id, manifest.layers.roads))).toString('utf8'));
      const projection = createProjection(manifest.projection);
      const routes: Sampled[] = recipe.routes.map((rid: string) => ({ id: rid, ...sampleAppRoute(SCENIC_ROUTE_GEOMETRY[rid].points, projection) }));
      const fit: RouteFitReport | undefined = JSON.parse(readFileSync(join(REPORTS, `${id}.json`), 'utf8')).routeFit;
      const mapped = new Map<number, number[]>((fit?.bent ?? []).map((b) => [b.road, b.mapped.split(' ').flatMap((xy) => xy.split(',').map(Number))]));
      return { id, roads, routes, fit, mapped };
    });
}

describe('shipped worlds: the guide sits on one drawn surface', () => {
  const worlds = shippedWorlds();

  it('finds the shipped worlds', () => {
    expect(worlds.map((w) => w.id)).toContain('perugia');
  });

  for (const w of worlds) {
    it(`${w.id}: the whole painted guide (centre line ± ${ROUTE_PAINT_HALF_M} m) lies on drawn roads`, () => {
      for (const c of routePaintCoverage(w.routes, w.roads)) {
        expect(c.misses, `${c.id}: ${c.misses.slice(0, 4).map((m: { fromS: number; toS: number }) => `${m.fromS}–${m.toS} m`).join(', ')}`).toEqual([]);
        expect(c.pct).toBe(100);
      }
    });

    it(`${w.id}: no route-fill piece lies over a mapped road except where it joins one`, () => {
      const { worst, at } = fillOverlapM(w.roads);
      expect(worst, `reaches ${worst.toFixed(2)} m into a mapped road at ${at}`).toBeLessThanOrEqual(0.05);
    });

    it(`${w.id}: the bake reports every road it bent with its final shift (mapped vs shipped)`, () => {
      expect(w.fit, 'tools/worldbake/reports routeFit').toBeDefined();
      const fit = w.fit!;
      expect(fit.roadsBent).toBe(fit.bent.length);
      expect(fit.joins).toBe(w.roads.roads.filter(isFill).length);
      for (const b of fit.bent) {
        const shipped = metres(w.roads.roads[b.road]);
        const mapped = w.mapped.get(b.road)!.map((v) => v / 10);
        expect(mapped.join(), `road ${b.road}`).not.toBe(shipped.join());
        expect(Math.abs(hausdorff(mapped, shipped) - b.shiftM), `road ${b.road}`).toBeLessThanOrEqual(0.011);
      }
      expect(fit.maxShiftM).toBe(Math.max(0, ...fit.bent.map((b) => b.shiftM)));
    });

    it(`${w.id}: no road the fit bent newly lies over another drawn road (beyond 0.1 m, outside their junctions)`, () => {
      expect(newOverlaps(w.roads, w.mapped)).toEqual([]);
    });

    it(`${w.id}: every road end that lay in another drawn road as mapped still does (within 0.05 m)`, () => {
      expect(openedEnds(w.roads, w.mapped)).toEqual([]);
    });
  }

  it('perugia: no route fill at all (every stretch was a path mapped beside the route, now bent onto it)', () => {
    const perugia = worlds.find((w) => w.id === 'perugia')!;
    expect(perugia.roads.roads.filter(isFill)).toEqual([]);
  });
});
