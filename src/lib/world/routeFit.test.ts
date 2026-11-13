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
 * PR #46 review: the paint check's shortcut (a band whose four corners lie in
 * ONE road segment is on it) is pinned where it must not apply (a turning
 * road's inner notch) and where it must not tolerate a few centimetres; the
 * shipped paint is also checked by this file's own edge model, so a bug in
 * routeCoverage.mjs's band check can't hide in the bake and its pin alike; and
 * the corner rule is pinned with the path mapped in either direction.
 *
 * - synthetic: what the bake's fit does (tools/worldbake/routeCoverage.mjs);
 * - shipped: every bundle in public/worlds, measured the way the renderer
 *   draws roads (flat ends, real widths), against the mapped line of every
 *   road the fit bent (tools/worldbake/reports/<id>.json routeFit.bent).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readableWorldBundles } from '../../../tools/worldbake/worldBundles.mjs';

import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { createProjection } from './projection';
import { ROAD_CLASSES, ROAD_FLAGS } from '../../../tools/worldbake/buildVectors.mjs';
import {
  COVERAGE_MARGIN_M,
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

/**
 * Distance past the drawn edge of segment `i` (vertex offset) of polyline `p`, metres: a strip
 * `half` either side of it, with a flat end at the polyline's first and last points.
 */
function segEdgeOf(x: number, y: number, p: number[], i: number, half: number) {
  const ax = p[i], ay = p[i + 1], dx = p[i + 2] - ax, dy = p[i + 3] - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Infinity;
  const len = Math.sqrt(l2);
  const raw = ((x - ax) * dx + (y - ay) * dy) / l2;
  const past = i === 0 && raw < 0 ? -raw * len : i + 4 >= p.length && raw > 1 ? (raw - 1) * len : 0;
  if (past > 0) {
    const lat = Math.abs((x - ax) * dy - (y - ay) * dx) / len;
    return lat <= half ? past : Math.hypot(lat - half, past);
  }
  const t = Math.max(0, Math.min(1, raw));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy) - half;
}

/** Distance past a road's drawn edge (flat ends, as roadRibbons draws it), metres. */
function edgeOf(x: number, y: number, p: number[], half: number) {
  let best = Infinity;
  for (let i = 0; i + 3 < p.length; i += 2) best = Math.min(best, segEdgeOf(x, y, p, i, half));
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

/** Where two segments [ax, ay, bx, by] cross (strictly inside both), with the sine of the angle between them. */
function crossing(a: number[], b: number[]) {
  const rx = a[2] - a[0], ry = a[3] - a[1], sx = b[2] - b[0], sy = b[3] - b[1];
  const den = rx * sy - ry * sx;
  const rl = Math.hypot(rx, ry), sl = Math.hypot(sx, sy);
  if (!rl || !sl || Math.abs(den) < 1e-9 * rl * sl) return null;
  const t = ((b[0] - a[0]) * sy - (b[1] - a[1]) * sx) / den;
  const u = ((b[0] - a[0]) * ry - (b[1] - a[1]) * rx) / den;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return { x: a[0] + t * rx, y: a[1] + t * ry, sin: Math.abs(den) / (rl * sl) };
}

/**
 * Where a road the fit moved newly lies over another drawn road along its
 * length, metres deep (its drawn width reaching past the other's edge) and
 * long, compared with the mapped lines. Points within reach of a junction the
 * two roads already had (an end of either inside the other, a vertex of one
 * on the other's centre line: a crossing, or centre lines that cross with no
 * shared vertex: a bridge or tunnel over the other) don't count: a fork's arms run
 * within reach of each other there, and so do a shallow crossing's, which
 * slides along both roads as either moves sideways (Magadino: a path the
 * route runs a metre beside crosses a track at 14°).
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
        // A crossing: the shallowest angle between a segment of either road
        // at the shared vertex and one of the other's within 10 m of it.
        for (let k = 2; k + 3 < a.p.length; k += 2) {
          const [x, y] = [a.p[k], a.p[k + 1]];
          if (nearest(x, y, b.p).d > 0.05) continue;
          let sin = 1;
          for (const j of [k - 2, k]) {
            const al = Math.hypot(a.p[j + 2] - a.p[j], a.p[j + 3] - a.p[j + 1]) || 1;
            for (let i = 0; i + 3 < b.p.length; i += 2) {
              if (nearest(x, y, b.p.slice(i, i + 4)).d > 10) continue;
              const bl = Math.hypot(b.p[i + 2] - b.p[i], b.p[i + 3] - b.p[i + 1]) || 1;
              sin = Math.min(sin, Math.abs(((a.p[j + 2] - a.p[j]) / al) * ((b.p[i + 3] - b.p[i + 1]) / bl) - ((a.p[j + 3] - a.p[j + 1]) / al) * ((b.p[i + 2] - b.p[i]) / bl)));
            }
          }
          const hh = a.half + b.half;
          z.push({ x, y, r: hh + Math.min(10, hh / Math.max(sin, 0.1)) });
        }
      }
      // A bridge or tunnel over the other road: the centre lines cross with
      // no shared vertex, so the strips overlap there and the overlap slides
      // along both as either moves sideways, as at a crossing (Riviera dei
      // Fiori: the cycleway's deck over Via al Mare at Arma di Taggia).
      for (let k = 0; k + 3 < B.p.length; k += 2) {
        for (let j = 0; j + 3 < O.p.length; j += 2) {
          const x = crossing(B.p.slice(k, k + 4), O.p.slice(j, j + 4));
          if (!x) continue;
          const hh = B.half + O.half;
          z.push({ x: x.x, y: x.y, r: hh + Math.min(10, hh / Math.max(x.sin, 0.1)) });
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
  // Mapped roads by 20 m cell, padded 5 m (past any fill's half-width), so a long piece stays cheap.
  const CELL = 20;
  const grid = new Map<string, typeof mapped>();
  for (const m of mapped) {
    for (let gx = Math.floor((m.box[0] - 5) / CELL); gx <= Math.floor((m.box[2] + 5) / CELL); gx++) {
      for (let gy = Math.floor((m.box[1] - 5) / CELL); gy <= Math.floor((m.box[3] + 5) / CELL); gy++) {
        const k = `${gx},${gy}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k)!.push(m);
      }
    }
  }
  const cellOf = (x: number, y: number) => grid.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) ?? [];
  let worst = -Infinity;
  let at = '';
  const probe = (x: number, y: number, half: number, excused: (m: (typeof mapped)[number]) => boolean) => {
    for (const m of cellOf(x, y)) {
      if (excused(m)) continue;
      const reach = half - edgeOf(x, y, m.p, m.half);
      if (reach > worst) { worst = reach; at = `(${x.toFixed(1)}, ${y.toFixed(1)})`; }
    }
  };
  for (const f of roads.roads.filter(isFill)) {
    const p = metres(f);
    const half = halfOf(roads, f);
    const near = [...new Set([[p[0], p[1]], [p[p.length - 2], p[p.length - 1]]].flatMap(([x, y]) => cellOf(x, y)))];
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
      probe(x, y, half, (m) => (d < ends[0].until && ends[0].joined.includes(m)) || (d > total - ends[1].until && ends[1].joined.includes(m)));
    }
    // The middle: its centre line must be off every mapped road.
    const [mx, my] = pts[Math.floor(pts.length / 2)];
    for (const m of cellOf(mx, my)) {
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

/** The paint check below looks every PAINT_STEP_M along a route step and at 2 × PAINT_ACROSS + 1 points across its band. */
const PAINT_STEP_M = 0.1;
const PAINT_ACROSS = 6;
/**
 * How far past the drawn roads a paint sample may lie on the shipped bundles, m: a corner sliver
 * between two samples. Sampling them every 0.02 m at 25 points across finds 0.020 m at most
 * (Locarno 2,858 m); this file's 0.1 m × 13 sampling sees 0.010 m. A band check that trusts its
 * corners over a turning road (review Y1) leaves 0.06 m; one loosened by 5 cm (Y11), 0.05 m.
 */
const PAINT_SLIVER_M = 0.025;

/**
 * Distance past the nearest drawn edge of `list` (metres), by segment from a grid of `cell`-metre
 * cells; only segments near a cell `keep` accepts are indexed. A lookup stops at the first
 * segment within `stop` of the point (it tries the last segment that answered first).
 */
function segmentGrid(roads: Layer, list: Road[], keep: (x0: number, y0: number, x1: number, y1: number) => boolean, cell = 4) {
  const grid = new Map<number, { p: number[]; i: number; half: number }[]>();
  const key = (x: number, y: number) => Math.floor(x / cell) * 1e6 + Math.floor(y / cell);
  for (const r of list) {
    const p = metres(r);
    const half = halfOf(roads, r);
    const [x0, y0, x1, y1] = bbox(p, half);
    if (!keep(x0, y0, x1, y1)) continue;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const sx0 = Math.min(p[i], p[i + 2]) - half, sx1 = Math.max(p[i], p[i + 2]) + half;
      const sy0 = Math.min(p[i + 1], p[i + 3]) - half, sy1 = Math.max(p[i + 1], p[i + 3]) + half;
      if (!keep(sx0, sy0, sx1, sy1)) continue;
      for (let gx = Math.floor(sx0 / cell); gx <= Math.floor(sx1 / cell); gx++) {
        for (let gy = Math.floor(sy0 / cell); gy <= Math.floor(sy1 / cell); gy++) {
          const k = gx * 1e6 + gy;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k)!.push({ p, i, half });
        }
      }
    }
  }
  let last: { p: number[]; i: number; half: number } | null = null;
  return (x: number, y: number, stop: number) => {
    if (last) {
      const e = segEdgeOf(x, y, last.p, last.i, last.half);
      if (e <= stop) return e;
    }
    let best = Infinity;
    for (const s of grid.get(key(x, y)) ?? []) {
      const e = segEdgeOf(x, y, s.p, s.i, s.half);
      if (e < best) {
        best = e;
        last = s;
        if (e <= stop) break;
      }
    }
    return best;
  };
}

/**
 * Where the painted guide lies more than `tol` past the drawn roads, measured with this file's
 * own edge model (segEdgeOf: a strip per segment, flat ends) and sampling, not with
 * routeCoverage.mjs: a bug in its band check would hide in the bake's fit and in
 * routePaintCoverage alike (PR #46 review N1). Each route step's band (centre line ±
 * ROUTE_PAINT_HALF_M) is sampled every PAINT_STEP_M along it, both ends included, edge to edge
 * across it, and every sample is held against every drawn road near it (each may lie on a
 * different road). A step whose middle lies within a tunnel's half-width + COVERAGE_MARGIN_M is
 * skipped: nothing is drawn there on purpose. Returns each off step: route, distance at its end
 * and its worst sample (m past the edge, where).
 */
function paintOffRoad(roads: Layer, routes: Sampled[], tol: number) {
  const CORRIDOR = 20;
  const corridor = new Set<number>();
  for (const r of routes) for (let i = 0; i < r.x.length; i++) corridor.add(Math.floor(r.x[i] / CORRIDOR) * 1e6 + Math.floor(r.y[i] / CORRIDOR));
  const nearRoute = (x0: number, y0: number, x1: number, y1: number) => {
    for (let gx = Math.floor(x0 / CORRIDOR) - 1; gx <= Math.floor(x1 / CORRIDOR) + 1; gx++) {
      for (let gy = Math.floor(y0 / CORRIDOR) - 1; gy <= Math.floor(y1 / CORRIDOR) + 1; gy++) if (corridor.has(gx * 1e6 + gy)) return true;
    }
    return false;
  };
  const edge = segmentGrid(roads, roads.roads.filter((r) => drawn(roads, r)), nearRoute);
  const tunnel = segmentGrid(roads, roads.roads.filter((r) => ((r.f ?? 0) & ROAD_FLAGS.tunnel) !== 0), nearRoute);
  const off: { id: string; s: number; offM: number; at: string }[] = [];
  for (const r of routes) {
    for (let i = 1; i < r.s.length; i++) {
      const ax = r.x[i - 1], ay = r.y[i - 1], bx = r.x[i], by = r.y[i];
      const len = Math.hypot(bx - ax, by - ay);
      if (len === 0) continue;
      const nx = (-(by - ay) / len) * ROUTE_PAINT_HALF_M, ny = ((bx - ax) / len) * ROUTE_PAINT_HALF_M;
      let worst = -Infinity, at = '';
      for (let u = 0; ; u = Math.min(u + PAINT_STEP_M, len)) {
        const cx = ax + ((bx - ax) * u) / len, cy = ay + ((by - ay) * u) / len;
        for (let o = -PAINT_ACROSS; o <= PAINT_ACROSS; o++) {
          const x = cx + (nx * o) / PAINT_ACROSS, y = cy + (ny * o) / PAINT_ACROSS;
          const e = edge(x, y, tol);
          if (e > worst) { worst = e; at = `(${x.toFixed(2)}, ${y.toFixed(2)})`; }
        }
        if (u >= len) break;
      }
      if (worst <= tol || tunnel((ax + bx) / 2, (ay + by) / 2, COVERAGE_MARGIN_M) <= COVERAGE_MARGIN_M) continue;
      off.push({ id: r.id, s: Math.round(r.s[i] * 10) / 10, offM: Math.round(worst * 1000) / 1000, at });
    }
  }
  return off;
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

  /** A polyline (flat x, y pairs) with its points in the opposite order. */
  const flip = (p: number[]) => p.flatMap((_, i) => (i % 2 ? [] : [p[p.length - 2 - i], p[p.length - 1 - i]]));

  // The path is mapped in both directions (review Y8): the turn-away leg lies after the bent
  // corner along the polyline, then before it, so the vertex rule is pinned on either side.
  for (const reversed of [false, true]) {
    it(`bends a corner the route runs past by at most ROUTE_EASE_CORNER_M, never down the leg that turns away (Locarno 2,072 m)${reversed ? ', path mapped from the leg' : ''}`, () => {
      // A 1.5 m path runs west along y = 0, turns south at (-3, 0), steps 1 m and runs on
      // south; a 6 m road runs beside that leg, 0.15 m past its edge.
      const mapped = dm([[40, 0], [-3, 0], [-3, -1], [-3, -40]]);
      const asMapped = (p: number[]) => (reversed ? flip(p) : p);
      const path = { c: CLS.path, p: asMapped(mapped) };
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
      const west = asMapped(p);
      expect(west.slice(0, 2)).toEqual([40, 0]);
      expect(west.slice(-4)).toEqual([-3, -1, -3, -40]);
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
  }

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

  it("checks the band between its corners where ONE road turns: an L-shaped path's corners don't vouch for its inner notch (PR #46 review Y1)", () => {
    // One 1.5 m path turns 90° at (0, 0). One route step, (1, 0.3) → (0.3, 1), cuts its inner
    // corner: all four corners of that step's band lie on the path, but the band's outer edge
    // crosses the notch between the two legs, 0.105 m past both edges at (0.855, 0.855). A single
    // segment's strip is convex, so its corners decide for the band; a turning road's is not.
    const roads = layer([{ c: CLS.path, p: dm([[10, 0], [0, 0], [0, 10]]) }]);
    const p = metres(roads.roads[0]);
    const r = route('r', [[9, 0.3], [1, 0.3], [0.3, 1], [0.3, 9]]);
    const i = 9;
    expect([r.x[i - 1], r.y[i - 1], r.x[i], r.y[i]].map((v) => Math.round(v * 1000) / 1000)).toEqual([1, 0.3, 0.3, 1]);
    const len = Math.hypot(r.x[i] - r.x[i - 1], r.y[i] - r.y[i - 1]);
    const nx = (-(r.y[i] - r.y[i - 1]) / len) * ROUTE_PAINT_HALF_M, ny = ((r.x[i] - r.x[i - 1]) / len) * ROUTE_PAINT_HALF_M;
    for (const [x, y] of [[r.x[i - 1], r.y[i - 1]], [r.x[i], r.y[i]]]) {
      for (const k of [1, -1]) expect(edgeOf(x + nx * k, y + ny * k, p, 0.75), 'band corner on the path').toBeLessThan(0);
    }
    const mx = (r.x[i - 1] + r.x[i]) / 2 - nx, my = (r.y[i - 1] + r.y[i]) / 2 - ny;
    expect(edgeOf(mx, my, p, 0.75), 'outer edge over the notch').toBeCloseTo(0.105, 3);

    const c = routePaintCoverage([r], roads)[0];
    expect(c.misses).toEqual([{ fromS: Math.round(r.s[i - 1] * 10) / 10, toS: Math.round(r.s[i] * 10) / 10, lengthM: 1, maxOffM: 0.11 }]);
    expect(paintOffRoad(roads, [r], 0).map((o) => o.s)).toEqual([Math.round(r.s[i] * 10) / 10]);

    const fit = easeRoadsOntoRoutes([r], roads);
    expect(fit.joins).toBe(0);
    expect(fit.roadsEased).toBe(1);
    expect(routePaintCoverage([r], roads)[0].pct).toBe(100);
    expect(paintOffRoad(roads, [r], PAINT_SLIVER_M)).toEqual([]);
  });

  it('counts a 3 cm overhang past one straight segment: its corners decide only when they are on the road (PR #46 review Y11)', () => {
    // A straight 1.5 m path; for 8 m the route runs 0.49 m north of its centre line, so the
    // paint's north edge lies 0.03 m past the path's.
    const roads = layer([{ c: CLS.path, p: dm([[-50, 0], [50, 0]]) }]);
    const y = 0.75 - ROUTE_PAINT_HALF_M + 0.03;
    const r = route('r', [[-40, 0], [-5, 0], [-4, y], [4, y], [5, 0], [40, 0]]);
    const c = routePaintCoverage([r], roads)[0];
    expect(c.misses).toHaveLength(1);
    expect(c.misses[0].maxOffM).toBe(0.03);
    expect(c.misses[0].fromS).toBeLessThanOrEqual(36);
    expect(c.misses[0].toS).toBeGreaterThanOrEqual(44);
    expect(paintOffRoad(roads, [r], 0.02).length).toBeGreaterThanOrEqual(8);

    easeRoadsOntoRoutes([r], roads);
    expect(routePaintCoverage([r], roads)[0].pct).toBe(100);
  });
});

const FIXTURES = fileURLToPath(new URL('../../../tools/worldbake/fixtures/route-fit', import.meta.url));

/** Pre-fit roads and app route samples within 60 m of a junction, cut from a bake (tools/worldbake/fixtures/route-fit). */
function fixture(name: string): { roads: Layer; routes: Sampled[] } {
  const fx = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
  return { roads: { ...layer(fx.roads), classes: fx.classes, widths: fx.widths }, routes: fx.routes };
}

describe('bake: junctions from the home-area worlds', () => {
  const fitted = (name: string) => {
    const { roads, routes } = fixture(name);
    const fit = easeRoadsOntoRoutes(routes, roads);
    const mapped = new Map<number, number[]>(fit.bent.map((b: { i: number; mapped: number[] }) => [b.i, b.mapped]));
    return { roads, routes, fit, mapped };
  };

  it('Lake Trasimeno: a cycleway, a footbridge and a cycleway in a row, each bent its own way, are joined again end to end', () => {
    const { roads, routes, fit, mapped } = fitted('trasimeno');
    // Without the repair the corners of three ends poke 0.05–0.07 m out of the road they met.
    expect(fit.endsClosed.map(([r, end]: number[]) => `${r}:${end}`)).toEqual(['2:0', '5:0']);
    expect(openedEnds(roads, mapped)).toEqual([]);
    expect(routePaintCoverage(routes, roads)[0].pct).toBe(100);
    expect(paintOffRoad(roads, routes, PAINT_SLIVER_M)).toEqual([]);
    expect(newOverlaps(roads, mapped)).toEqual([]);
  });

  it('Magadino: a path bent onto the route stays joined to the path it continues', () => {
    const { roads, routes, fit, mapped } = fitted('magadino-chain');
    expect(fit.endsClosed.map(([r, end]: number[]) => `${r}:${end}`)).toEqual(['1:0']);
    expect(openedEnds(roads, mapped)).toEqual([]);
    expect(routePaintCoverage(routes, roads)[0].pct).toBe(100);
  });

  it('Lake Varese: where the route cuts through a 1 m verge between two roads, a narrow join holds the paint and neither road is bent across the verge', () => {
    const { roads, routes, fit, mapped } = fitted('lake-varese');
    expect(fit.joins).toBe(1);
    const join = roads.roads[roads.roads.length - 1];
    expect(isFill(join)).toBe(true);
    // Narrowed from the primary road's 5 m: its far end would reach 1.5 m into the road its near end lies in.
    expect(join.w).toBe(2);
    expect(fillOverlapM(roads).worst).toBeLessThanOrEqual(0.05);
    // The steps left to the join bent nothing: before, both roads were bent 0.15 m into each other there.
    expect(newOverlaps(roads, mapped)).toEqual([]);
    expect(routePaintCoverage(routes, roads)[0].pct).toBe(100);
    expect(paintOffRoad(roads, routes, PAINT_SLIVER_M)).toEqual([]);
  });

  it('Magadino: a path the route runs a metre beside, crossing a track at 14°, may slide the crossing along the track', () => {
    const { roads, routes, mapped } = fitted('magadino-crossing');
    expect([...mapped.keys()].length).toBeGreaterThan(0);
    expect(newOverlaps(roads, mapped)).toEqual([]);
    expect(routePaintCoverage(routes, roads)[0].pct).toBe(100);
  });

  it('counts a bridge over a road (centre lines cross, no shared vertex) as a junction, and only where they cross', () => {
    // A residential road along y = 0 and a cycleway deck crossing it at 53° with no vertex on it.
    const road = { c: CLS.residential, p: dm([[-40, 0], [40, 0]]) };
    const c = Math.cos((53 * Math.PI) / 180), s = Math.sin((53 * Math.PI) / 180);
    const deck = { c: CLS.cycleway, f: ROAD_FLAGS.bridge, p: dm([[-16 * c, -16 * s], [16 * c, 16 * s]]) };
    // The deck moved 0.3 m sideways: where its strip overlaps the road's slides about 0.4 m along it.
    const moved = { ...deck, p: dm([[-16 * c - 0.3 * s, -16 * s + 0.3 * c], [16 * c - 0.3 * s, 16 * s + 0.3 * c]]) };
    expect(newOverlaps(layer([road, moved]), new Map([[1, deck.p]]))).toEqual([]);
    // A deck stopping short of the road (its centre line 3.8 m from the road's, so 0.05 m clear) moved 0.5 m toward it still counts.
    const short = { ...deck, p: dm([[-16 * c, -16 * s], [(-3.8 / s) * c, -3.8]]) };
    const closer = { ...short, p: dm([[-16 * c, -16 * s + 0.5], [(-3.8 / s) * c, -3.3]]) };
    expect(newOverlaps(layer([road, closer]), new Map([[1, short.p]])).map((o) => [o.road, o.other, o.depthM])).toEqual([[1, 0, 0.45]]);
  });

  it('counts a shallow crossing as a junction for the overlap check, and only a crossing', () => {
    // A track along y = 0 and a path crossing it at 14° through a shared vertex at (0, 0).
    const t = Math.tan((14 * Math.PI) / 180);
    const track = { c: CLS.track, p: dm([[-40, 0], [0, 0], [40, 0]]) };
    const path = { c: CLS.path, p: dm([[-40, -40 * t], [0, 0], [40, 40 * t]]) };
    // The path moved 0.5 m north: the crossing slides 2 m along the track.
    const moved = { ...path, p: dm([[-40, -40 * t + 0.5], [0, 0.5], [40, 40 * t + 0.5]]) };
    const roads = layer([track, moved]);
    expect(newOverlaps(roads, new Map([[1, path.p]]))).toEqual([]);
    // A path running 0.25 m clear of the track's edge, with no vertex on it, moved 0.6 m toward it still counts.
    const parallel = { c: CLS.path, p: dm([[-40, -2.5], [40, -2.5]]) };
    const closer = { ...parallel, p: dm([[-40, -1.9], [40, -1.9]]) };
    const found = newOverlaps(layer([track, closer]), new Map([[1, parallel.p]]));
    expect(found.map((o) => [o.road, o.other, o.depthM])).toEqual([[1, 0, 0.35]]);
  });
});

const RECIPES = fileURLToPath(new URL('../../../tools/worldbake/worlds', import.meta.url));
const REPORTS = fileURLToPath(new URL('../../../tools/worldbake/reports', import.meta.url));

interface RouteFitReport { roadsBent: number; maxShiftM: number; joins: number; bent: { road: number; shiftM: number; mapped: string }[] }

/** Every bundle in public/worlds, plus each remote one whose files are on disk (worldBundles.mjs). */
function shippedWorlds() {
  return readableWorldBundles()
    .filter((b: { id: string }) => existsSync(join(RECIPES, `${b.id}.json`)))
    .map(({ id, dir }: { id: string; dir: string }) => {
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      const recipe = JSON.parse(readFileSync(join(RECIPES, `${id}.json`), 'utf8'));
      const roads: Layer = JSON.parse(gunzipSync(readFileSync(join(dir, manifest.layers.roads))).toString('utf8'));
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

    it(`${w.id}: the painted guide lies on drawn roads by this file's own check too (0.1 m × 13 samples, within ${PAINT_SLIVER_M} m)`, () => {
      const off = paintOffRoad(w.roads, w.routes, PAINT_SLIVER_M);
      expect(off.slice(0, 6).map((o) => `${o.id} ${o.s} m: ${o.offM} m off at ${o.at}`)).toEqual([]);
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
