#!/usr/bin/env node
// How much of each scenic route sits on a drawn road or path, and how the
// bake bends a mapped road under the route where it doesn't.
//
//   node tools/worldbake/routeCoverage.mjs <world> [--bundle dir] [--json]
//
// For every route in the world's recipe, the app's own polyline (the line the
// rider follows, from src/lib/scenicRouteData.ts) is walked every metre and
// each metre counts as "on a road" when it lies within that road's half-width
// + a margin of a road the renderer draws (roadRibbons.roadLines: every class
// but steps, no tunnels, width at least 1 m). Roads are measured the way the
// renderer draws them: a strip of the road's width with flat ends at the
// polyline's first and last points. Metres inside a mapped tunnel or
// underpass are counted apart (`tunnelM`): nothing is drawn there on purpose.
// The bake report carries the numbers (`routes[].roadCoverage`).

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createProjection } from '../../src/lib/world/projection.ts';
import { appRoutePoints, loadScenicGeometry } from './snapRoutes.mjs';
import { ROAD_FLAGS } from './buildVectors.mjs';
import { here, simplifyLine } from './util.mjs';

/** Extra reach past a road's half-width that still counts as on it, m. */
export const COVERAGE_MARGIN_M = 1;
/**
 * Half-width of the painted guide, m: its chevron arms reach 0.24 m either
 * side of the centre line and their strokes are 0.045 m half-wide
 * (ROUTE_GUIDE in src/renderers/three/materials/routeGuide.ts; routeFit.test
 * pins this to cover both). The paint is on a drawn road when the centreline
 * and both points this far either side of it are.
 */
export const ROUTE_PAINT_HALF_M = 0.29;
/**
 * How far inside the road the bake puts the paint's edges, m: room for
 * rounding the eased road to the bundle's decimetres and simplifying it, so
 * the shipped paint is still on the road.
 */
export const ROUTE_EASE_SLACK_M = 0.12;
/**
 * A route stretch farther than this past every drawn road's edge has no road
 * to bend under it: the bake stops (a waypoint off the mapped roads, or a way
 * newer than the recipe's osmDate), m.
 */
export const ROUTE_EASE_MAX_M = 2.5;
/** An eased road bends back to its mapped line over this length either side of the stretch, m. */
export const ROUTE_EASE_TAPER_M = 8;
/** Tolerance when simplifying an eased stretch back to few points, m. */
const EASE_SIMPLIFY_M = 0.03;
/** A road runs along the route when their headings are within 60° (cos 0.5). */
const ALONG_COS = 0.5;
/** A road stretch within 30° of the route's heading runs beside it: the bake may bend it up to ROUTE_EASE_MAX_M. */
const PARALLEL_COS = Math.cos(Math.PI / 6);
/**
 * The most the bake bends a road where the route leaves the road's line:
 * round the outside of one of its corners, or beside a stretch more than 30°
 * off the route's heading, m. Past this the route has left that road and the
 * bake adds a join instead: bending further drags the road's turn-off leg
 * onto whatever runs beside it (Locarno 2,072 m).
 */
export const ROUTE_EASE_CORNER_M = 0.6;
/** Most passes easeRoadsOntoRoutes makes before it gives up (it stops once nothing moves). */
export const ROUTE_FIT_MAX_PASSES = 16;

/**
 * Distance from (x, y) past the drawn edge of segment `i` (vertex offset) of
 * road entry `d` (negative inside): a strip of the road's width, with a flat
 * end at the polyline's first and last points and round joins between
 * segments. Also the nearest centreline point (`t` along the segment, `qx`,
 * `qy`). The region {edge ≤ m} of one segment is convex.
 */
function segEdge(d, i, x, y) {
  const l = d.p;
  const ax = l[i], ay = l[i + 1], bx = l[i + 2], by = l[i + 3];
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const raw = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
  const t = Math.max(0, Math.min(1, raw));
  const qx = ax + t * dx, qy = ay + t * dy;
  let e;
  // Past a flat end (the polyline's first or last point): the strip stops there.
  const len = Math.sqrt(l2);
  const past = l2 > 0 ? (i === 0 && raw < 0 ? -raw * len : i + 4 >= l.length && raw > 1 ? (raw - 1) * len : 0) : 0;
  if (past > 0) {
    const lat = Math.abs((x - ax) * dy - (y - ay) * dx) / len;
    e = lat <= d.half ? past : Math.hypot(lat - d.half, past);
  } else {
    e = Math.hypot(x - qx, y - qy) - d.half;
  }
  return { e, t, qx, qy };
}

/**
 * Segment index over road polylines (metres), queried by point: the nearest
 * road by distance past its drawn edge.
 */
function roadIndex(entries) {
  const reach = Math.max(1, ...entries.map((d) => d.half));
  const cell = Math.max(20, Math.ceil(reach + ROUTE_EASE_MAX_M + COVERAGE_MARGIN_M));
  const map = new Map();
  entries.forEach((d, li) => {
    const p = d.p;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x0 = Math.min(p[i], p[i + 2]), x1 = Math.max(p[i], p[i + 2]);
      const y0 = Math.min(p[i + 1], p[i + 3]), y1 = Math.max(p[i + 1], p[i + 3]);
      for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
        for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) {
          const key = `${gx},${gy}`;
          let list = map.get(key);
          if (!list) map.set(key, (list = []));
          list.push(li, i);
        }
      }
    }
  });
  /**
   * Nearest road to (x, y): `edge` = distance past its drawn edge (negative
   * inside), `index` into `entries`, and the nearest centreline point
   * (`seg` = vertex offset of its segment, `t` along it, `qx`, `qy`).
   * `accept(index, ax, ay, bx, by)`, when given, limits the search to the
   * segments it returns true for.
   */
  const query = (x, y, accept = null) => {
    let best = { edge: Infinity, index: -1, seg: -1, t: 0, qx: 0, qy: 0 };
    const gx0 = Math.floor(x / cell), gy0 = Math.floor(y / cell);
    for (let gy = gy0 - 1; gy <= gy0 + 1; gy++) {
      for (let gx = gx0 - 1; gx <= gx0 + 1; gx++) {
        const list = map.get(`${gx},${gy}`);
        if (!list) continue;
        for (let k = 0; k < list.length; k += 2) {
          const d = entries[list[k]];
          const l = d.p;
          const i = list[k + 1];
          if (accept && !accept(list[k], l[i], l[i + 1], l[i + 2], l[i + 3])) continue;
          const { e, t, qx, qy } = segEdge(d, i, x, y);
          if (e < best.edge || (e === best.edge && list[k] < best.index)) best = { edge: e, index: list[k], seg: i, t, qx, qy };
        }
      }
    }
    return best;
  };
  /** Indices of every entry whose drawn strip reaches within `tol` of (x, y). */
  query.within = (x, y, tol) => {
    const out = new Set();
    const gx0 = Math.floor(x / cell), gy0 = Math.floor(y / cell);
    for (let gy = gy0 - 1; gy <= gy0 + 1; gy++) {
      for (let gx = gx0 - 1; gx <= gx0 + 1; gx++) {
        const list = map.get(`${gx},${gy}`);
        if (!list) continue;
        for (let k = 0; k < list.length; k += 2) {
          if (!out.has(list[k]) && segEdge(entries[list[k]], list[k + 1], x, y).e <= tol) out.add(list[k]);
        }
      }
    }
    return out;
  };
  query.entries = entries;
  return query;
}

/** Spacing of the paint check along the route, m: corners and road ends are thinner than a 1 m step. */
export const PAINT_SAMPLE_M = 0.1;
/** The paint check looks at 2 × PAINT_ACROSS + 1 points across the band, edge to edge. */
const PAINT_ACROSS = 6;

/**
 * The painted band (centre line ± `half`) over one route step a → b against
 * a road index: the largest distance past every drawn road's edge over the
 * band (negative inside). When the band's four corners all lie within
 * `margin` of one road segment, the whole band does (that region is convex)
 * and the corners decide; otherwise the band is sampled every PAINT_SAMPLE_M
 * along the step, ends included, at 2 × PAINT_ACROSS + 1 points across, and
 * `visit(x, y, edge)` sees each sample farther past the edges than `margin`.
 */
function bandStep(near, ax, ay, bx, by, half, margin, visit = null) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0) return near(ax, ay).edge;
  const nx = (-dy / len) * half, ny = (dx / len) * half;
  const q = near((ax + bx) / 2, (ay + by) / 2);
  if (q.index >= 0) {
    const d = near.entries[q.index];
    let worst = -Infinity;
    for (const [x, y] of [[ax + nx, ay + ny], [ax - nx, ay - ny], [bx + nx, by + ny], [bx - nx, by - ny]]) {
      worst = Math.max(worst, segEdge(d, q.seg, x, y).e);
      if (worst > margin) break;
    }
    if (worst <= margin) return worst;
  }
  const k = Math.ceil(len / PAINT_SAMPLE_M);
  let worst = -Infinity;
  for (let j = 0; j <= k; j++) {
    const cx = ax + (dx * j) / k, cy = ay + (dy * j) / k;
    for (let o = -PAINT_ACROSS; o <= PAINT_ACROSS; o++) {
      const x = cx + (nx * o) / PAINT_ACROSS, y = cy + (ny * o) / PAINT_ACROSS;
      const e = near(x, y).edge;
      if (e > worst) worst = e;
      if (visit && e > margin) visit(x, y, e);
    }
  }
  return worst;
}

/** Every road in the layer (metres), with what the renderer does with it. */
function roadEntries(roads) {
  const steps = roads.classes.indexOf('steps');
  return roads.roads.map((r, index) => {
    const f = r.f ?? 0;
    return {
      road: r,
      index,
      p: r.p.map((v) => v / 10),
      half: Math.max(1, r.w ?? roads.widths[r.c]) / 2,
      drawn: r.c !== steps && !(f & ROAD_FLAGS.tunnel) && r.p.length >= 4,
      tunnel: (f & ROAD_FLAGS.tunnel) !== 0,
    };
  });
}

/** Roads the renderer draws (see src/renderers/three/roadRibbons.ts roadLines), metres. */
export function drawnRoads(roads) {
  return roadEntries(roads).filter((e) => e.drawn).map((e) => ({ p: e.p, half: e.half, cls: roads.classes[e.road.c], f: e.road.f ?? 0 }));
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * Walk one sampled route against an index; misses where the edge distance
 * exceeds `margin`. With `paintHalf`, a step counts only when the whole band
 * that far either side of the centreline is within `margin` too, checked
 * every PAINT_SAMPLE_M along it and edge to edge across it (each point may
 * lie on a different road: a junction). With `inTunnel`, steps within a
 * tunnel's half-width + COVERAGE_MARGIN_M count as tunnel, not as misses.
 */
function walk(r, near, margin, inTunnel = null, paintHalf = 0) {
  let covered = 0;
  let total = 0;
  let tunnel = 0;
  const misses = [];
  let open = null;
  for (let i = 1; i < r.s.length; i++) {
    const len = r.s[i] - r.s[i - 1];
    const mx = (r.x[i] + r.x[i - 1]) / 2, my = (r.y[i] + r.y[i - 1]) / 2;
    const e = paintHalf > 0 ? bandStep(near, r.x[i - 1], r.y[i - 1], r.x[i], r.y[i], paintHalf, margin) : near(mx, my).edge;
    total += len;
    if (e <= margin || (inTunnel && inTunnel(mx, my).edge <= COVERAGE_MARGIN_M)) {
      if (e <= margin) covered += len;
      else tunnel += len;
      if (open) { misses.push(open); open = null; }
    } else if (open) {
      open.toS = r.s[i];
      open.maxOffM = Math.max(open.maxOffM, e);
    } else {
      open = { fromS: r.s[i - 1], toS: r.s[i], maxOffM: e };
    }
  }
  if (open) misses.push(open);
  return {
    id: r.id,
    lengthM: round1(total),
    coveredM: round1(covered),
    tunnelM: round1(tunnel),
    /** Share of the open-air length (outside tunnels) on a drawn road. */
    pct: Math.round((covered / (total - tunnel || 1)) * 10000) / 100,
    misses: misses.map((m) => ({ fromS: round1(m.fromS), toS: round1(m.toS), lengthM: round1(m.toS - m.fromS), maxOffM: Math.round(m.maxOffM * 100) / 100 })),
  };
}

/**
 * Per route: share of its length within half-width + `margin` of a drawn
 * road (a negative margin asks for that much inside the edge), and the
 * uncovered stretches (route distance from/to, metres). With `paintHalf`, the
 * points that far either side of the centreline must be covered too (the
 * painted guide's width). `routes` = [{ id, x: number[], y: number[],
 * s: number[] }] sampled densely (≤ 1 m); `roads` = the roads layer as baked
 * (dm).
 */
export function routeRoadCoverage(routes, roads, margin = COVERAGE_MARGIN_M, paintHalf = 0) {
  const all = roadEntries(roads);
  const near = roadIndex(all.filter((e) => e.drawn));
  const tunnels = all.filter((e) => e.tunnel);
  const inTunnel = tunnels.length ? roadIndex(tunnels) : null;
  return routes.map((r) => walk(r, near, margin, inTunnel, paintHalf));
}

/** Per route: the share of its painted guide (centre line and chevrons) that lies on drawn roads. */
export function routePaintCoverage(routes, roads) {
  return routeRoadCoverage(routes, roads, 0, ROUTE_PAINT_HALF_M);
}

/** Weight of a stretch's shift at `d` metres along the road from it: 1 on it, easing to 0 over ROUTE_EASE_TAPER_M. */
export function easeWeight(d) {
  if (d <= 1) return 1;
  if (d >= 1 + ROUTE_EASE_TAPER_M) return 0;
  const t = (d - 1) / ROUTE_EASE_TAPER_M;
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Distance along a polyline (metres) to the point nearest (x, y): `u`, the
 * unit normal of the segment it lies on (`nx`, `ny`) and its distance from
 * the line's nearer end (`fromEnd`).
 */
function nearestOn(p, cum, x, y) {
  let best = { d: Infinity, u: 0, nx: 0, ny: 0 };
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], ay = p[i + 1], dx = p[i + 2] - ax, dy = p[i + 3] - ay;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
    if (d < best.d) {
      const l = Math.sqrt(l2);
      best = { d, u: cum[i / 2] + t * l, nx: -dy / l, ny: dx / l };
    }
  }
  const total = cum[cum.length - 1];
  return { ...best, fromEnd: Math.min(best.u, total - best.u) };
}

/**
 * The shift of road polyline `p` (metres; `cum` = distance to each vertex) as
 * a function of distance along it, for route `demands` ({ u, dx, dy, seg =
 * the segment it sits on, tx, ty = the route's unit heading there }) and
 * junction `pins` ({ u, dx, dy }).
 *
 * Demands closer than ROUTE_EASE_TAPER_M along the road, with no turn away
 * from the route between them, form one stretch: inside it the shift runs
 * linearly from demand to demand, so a nearer demand is never overruled by a
 * stronger one farther off (which bent the road the wrong way at a corner).
 * Past a stretch's ends its end demands ease out over ROUTE_EASE_TAPER_M; where
 * two stretches' tails meet, the stronger weighted shift wins. A demand never
 * carries past the first vertex either side where the road turns more than
 * 60° off the route's heading: that vertex moves, the segment beyond it pivots
 * on its far end (it stays straight), and the rest of the road keeps its
 * mapped line. So a bend never drags a leg that leaves the route sideways
 * onto whatever runs beside it.
 *
 * Pins (a junction whose roads must move together) override the field near
 * them: see below.
 */
function shiftField(p, cum, demands, pins) {
  const nSeg = cum.length - 1;
  const reach = 1 + ROUTE_EASE_TAPER_M;
  const alongSeg = (k, tx, ty) => {
    const dx = p[2 * k + 2] - p[2 * k], dy = p[2 * k + 3] - p[2 * k + 1];
    const l = Math.hypot(dx, dy);
    return l === 0 || Math.abs(dx * tx + dy * ty) >= ALONG_COS * l;
  };
  const ds = demands.map((d) => {
    let hi = Infinity, hiEnd = Infinity, lo = -Infinity, loEnd = -Infinity;
    for (let k = d.seg + 1; k < nSeg; k++) if (!alongSeg(k, d.tx, d.ty)) { hi = cum[k]; hiEnd = cum[k + 1]; break; }
    for (let k = d.seg - 1; k >= 0; k--) if (!alongSeg(k, d.tx, d.ty)) { lo = cum[k + 1]; loEnd = cum[k]; break; }
    return { ...d, m: Math.hypot(d.dx, d.dy), lo, hi, loEnd, hiEnd };
  });
  const weight = (d, u) => {
    if (u > d.hi) return u >= d.hiEnd ? 0 : (easeWeight(d.hi - d.u) * (d.hiEnd - u)) / (d.hiEnd - d.hi);
    if (u < d.lo) return u <= d.loEnd ? 0 : (easeWeight(d.u - d.lo) * (u - d.loEnd)) / (d.lo - d.loEnd);
    return easeWeight(Math.abs(u - d.u));
  };
  ds.sort((a, b) => a.u - b.u);
  const stretches = [];
  for (const d of ds) {
    const s = stretches[stretches.length - 1];
    const prev = s?.[s.length - 1];
    if (prev && d.u - prev.u <= ROUTE_EASE_TAPER_M && d.u <= prev.hi && prev.u >= d.lo) s.push(d);
    else stretches.push([d]);
  }
  const base = (u) => {
    let best = 0, sx = 0, sy = 0;
    for (const s of stretches) {
      const first = s[0], last = s[s.length - 1];
      if (u > first.u && u < last.u) {
        let k = 1;
        while (s[k].u < u) k++;
        const a = s[k - 1], b = s[k];
        const f = b.u > a.u ? (u - a.u) / (b.u - a.u) : 0;
        const x = a.dx + (b.dx - a.dx) * f, y = a.dy + (b.dy - a.dy) * f;
        const m = Math.hypot(x, y);
        if (m > best) { best = m; sx = x; sy = y; }
        continue;
      }
      const d = u <= first.u ? first : last;
      const w = weight(d, u);
      if (w > 0 && d.m * w > best) { best = d.m * w; sx = d.dx * w; sy = d.dy * w; }
    }
    return [sx, sy];
  };
  // Within a metre of a pin the road moves exactly by the pin's vector (so a
  // pinned end keeps its direction and its flat end's corners stay put),
  // blending back to the demands' field over ROUTE_EASE_TAPER_M; where pins'
  // reaches overlap, their vectors blend.
  const shift = (u) => {
    let w = 0, sx = 0, sy = 0;
    for (const q of pins) {
      const k = easeWeight(Math.abs(u - q.u));
      if (k <= 0) continue;
      w += k;
      sx += q.dx * k;
      sy += q.dy * k;
    }
    if (w >= 1) return [sx / w, sy / w];
    const [bx, by] = base(u);
    return [bx * (1 - w) + sx, by * (1 - w) + sy];
  };
  // Where the line can move at all.
  let lo = Infinity, hi = -Infinity;
  for (const d of ds) {
    lo = Math.min(lo, d.lo >= d.u - reach ? d.loEnd : d.u - reach);
    hi = Math.max(hi, d.hi <= d.u + reach ? d.hiEnd : d.u + reach);
  }
  for (const q of pins) { lo = Math.min(lo, q.u - reach); hi = Math.max(hi, q.u + reach); }
  shift.lo = lo;
  shift.hi = hi;
  return shift;
}

/**
 * Shift polyline `p` (metres) by `demands` and `pins` (see shiftField) and
 * return the new polyline. Every original vertex stays a vertex, points every
 * metre are added only where the line moves, and each run between two
 * original vertices is simplified back to few points. Vertices the field
 * doesn't reach keep their exact place.
 */
function easeLine(p, cum, demands, pins = []) {
  const n = p.length / 2;
  const shift = shiftField(p, cum, demands, pins);
  const { lo, hi } = shift;
  const at = (i) => {
    const [sx, sy] = cum[i] >= lo && cum[i] <= hi ? shift(cum[i]) : [0, 0];
    return [p[2 * i] + sx, p[2 * i + 1] + sy];
  };
  const out = [...at(0)];
  for (let i = 1; i < n; i++) {
    const a = cum[i - 1], b = cum[i];
    const end = at(i);
    if (b > lo && a < hi && b - a > 1) {
      const run = [out[out.length - 2], out[out.length - 1]];
      for (let u = Math.floor(a) + 1; u < b; u++) {
        const f = (u - a) / (b - a);
        const [sx, sy] = u >= lo && u <= hi ? shift(u) : [0, 0];
        run.push(p[2 * i - 2] + (p[2 * i] - p[2 * i - 2]) * f + sx, p[2 * i - 1] + (p[2 * i + 1] - p[2 * i - 1]) * f + sy);
      }
      run.push(end[0], end[1]);
      out.push(...simplifyLine(run, EASE_SIMPLIFY_M).slice(2));
    } else {
      out.push(end[0], end[1]);
    }
  }
  return out;
}

/** Tolerance for "this road end lies in that road" when finding junctions, m. */
const JUNCTION_TOL_M = 0.05;
/** A road end this close to another road's end vertex meets it end to end (one node), m. */
const NODE_TOL_M = 0.5;
/** A covered road-end point closer than this to the other road's edge counts as leaving it once it drifts outward (rounding to dm moves points ~0.05 m), m. */
const LEAVE_MARGIN_M = 0.03;

/** A road's flat end (metres, current geometry): its centre and both corners. */
function endPoints(e, end) {
  const p = e.p;
  const n = p.length;
  const [x, y, px, py] = end === 0 ? [p[0], p[1], p[2], p[3]] : [p[n - 2], p[n - 1], p[n - 4], p[n - 3]];
  const l = Math.hypot(x - px, y - py) || 1;
  const nx = (-(y - py) / l) * e.half, ny = ((x - px) / l) * e.half;
  return [[x, y], [x + nx, y + ny], [x - nx, y - ny]];
}

/** The point `u` metres along a polyline (metres; `cum` = distance to each vertex). */
function pointAt(p, cum, u) {
  let i = 1;
  while (i < cum.length - 1 && cum[i] < u) i++;
  const f = cum[i] > cum[i - 1] ? Math.max(0, Math.min(1, (u - cum[i - 1]) / (cum[i] - cum[i - 1]))) : 0;
  return [p[2 * i - 2] + (p[2 * i] - p[2 * i - 2]) * f, p[2 * i - 1] + (p[2 * i + 1] - p[2 * i - 1]) * f];
}

/** Distance past one road's drawn edge (metres, negative inside). */
function roadEdge(e, x, y) {
  let best = Infinity;
  for (let i = 0; i + 3 < e.p.length; i += 2) best = Math.min(best, segEdge(e, i, x, y).e);
  return best;
}

/**
 * The junctions among the drawn roads, as mapped: for every road end, each
 * other road its flat end lies in, and which of the end's three points
 * (centre, corners) that road covers, with how far inside it each lies. The fit
 * keeps every one of them covered (resolveJunctions).
 */
function junctionGroups(drawn) {
  const mapped = drawn.map((e, k) => ({ e, k })).filter(({ e }) => !e.join);
  const idx = roadIndex(mapped.map(({ e }) => e));
  const groups = [];
  mapped.forEach(({ e, k }, mi) => {
    for (const end of [0, 1]) {
      const pts = endPoints(e, end);
      const cover = new Map();
      pts.forEach(([qx, qy], j) => {
        for (const m of idx.within(qx, qy, JUNCTION_TOL_M)) {
          if (m === mi) continue;
          const s = mapped[m].k;
          if (!cover.has(s)) cover.set(s, [null, null, null]);
          cover.get(s)[j] = roadEdge(drawn[s], qx, qy);
        }
      });
      if (cover.size) groups.push({ id: groups.length, r: k, end, partners: [...cover].sort((a, b) => a[0] - b[0]) });
    }
  });
  return groups;
}

/**
 * Pins that keep every junction joined. For each road end and each road it
 * lay in as mapped, the planned moves (route demands, earlier pins) are
 * checked: if any point of the end that road covered would leave it, one
 * road follows the other there. Two roads of one width meeting end to end
 * both take the larger move; otherwise the road the route bends there leads
 * (else the wider one), and where a road ends on another's side only the move
 * across that road is matched, so the end may still slide along it. `lists` =
 * route demands per drawn road; returns pins per drawn road.
 */
function resolveJunctions(drawn, groups, lists) {
  const pins = new Map();
  const fields = new Map();
  const field = (k) => {
    if (!fields.has(k)) {
      const e = drawn[k];
      const ds = lists.get(k) ?? [];
      const ps = pins.has(k) ? [...pins.get(k).values()] : [];
      fields.set(k, ds.length || ps.length ? shiftField(e.p, e.cum, ds, ps) : null);
    }
    return fields.get(k);
  };
  const shiftAt = (k, u) => field(k)?.(u) ?? [0, 0];
  const demandFields = new Map();
  const demandAt = (k, u) => {
    if (!lists.has(k)) return [0, 0];
    if (!demandFields.has(k)) demandFields.set(k, shiftField(drawn[k].p, drawn[k].cum, lists.get(k), []));
    return demandFields.get(k)(u);
  };
  /** Set a pin; true when it is new or moved. */
  const pin = (k, key, u, v) => {
    if (!pins.has(k)) pins.set(k, new Map());
    const was = pins.get(k).get(key);
    if (was && Math.abs(was.u - u) < 1e-6 && Math.hypot(was.dx - v[0], was.dy - v[1]) <= 0.005) return false;
    pins.get(k).set(key, { u, dx: v[0], dy: v[1] });
    fields.delete(k);
    return true;
  };
  const moving = (k) => lists.has(k) || pins.has(k);
  const far = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.005;
  for (let it = 0; it < 16; it++) {
    let changed = false;
    for (const g of groups) {
      if (!moving(g.r) && !g.partners.some(([k]) => moving(k))) continue;
      const R = drawn[g.r];
      const uR = g.end === 0 ? 0 : R.cum[R.cum.length - 1];
      const pts = endPoints(R, g.end);
      const total = R.cum[R.cum.length - 1];
      const uIn = g.end === 0 ? Math.min(1, total) : Math.max(0, total - 1);
      const inner = pointAt(R.p, R.cum, uIn);
      for (const [k, cover] of g.partners) {
        const S = drawn[k];
        const vR = shiftAt(g.r, uR);
        // Where the end's three points go: the end moves by vR and turns with
        // the road's last metre.
        const vIn = shiftAt(g.r, uIn);
        const ex = pts[0][0] + vR[0], ey = pts[0][1] + vR[1];
        const lx = ex - inner[0] - vIn[0], ly = ey - inner[1] - vIn[1];
        const ll = Math.hypot(lx, ly) || 1;
        const nx = (-ly / ll) * R.half, ny = (lx / ll) * R.half;
        const moved = [[ex, ey], [ex + nx, ey + ny], [ex - nx, ey - ny]];
        let leaves = false;
        pts.forEach(([x, y], j) => {
          if (cover[j] === null || leaves) return;
          // The point drifts out of S and ends within rounding reach of its edge.
          const vS = shiftAt(k, nearestOn(S.p, S.cum, x, y).u);
          const e = roadEdge(S, moved[j][0] - vS[0], moved[j][1] - vS[1]);
          leaves = e > cover[j] + 0.005 && e > -LEAVE_MARGIN_M;
        });
        if (!leaves) continue;
        const q = nearestOn(S.p, S.cum, pts[0][0], pts[0][1]);
        const vS = shiftAt(k, q.u);
        const node = q.fromEnd <= NODE_TOL_M;
        let tR = vR, tS = vS;
        if (node && Math.abs(R.half - S.half) < 0.25) {
          tR = tS = Math.hypot(...vR) >= Math.hypot(...vS) ? vR : vS;
        } else {
          // The road the route bends here leads; otherwise the narrower follows
          // the wider. Across a road's side only the move across it matters.
          const rLeads = Math.hypot(...demandAt(g.r, uR)) > Math.hypot(...demandAt(k, q.u)) + 1e-3 || (R.half > S.half && !lists.has(k));
          const dx = (rLeads ? vR[0] - vS[0] : vS[0] - vR[0]), dy = (rLeads ? vR[1] - vS[1] : vS[1] - vR[1]);
          const d = node ? [dx, dy] : [(dx * q.nx + dy * q.ny) * q.nx, (dx * q.nx + dy * q.ny) * q.ny];
          if (rLeads) tS = [vS[0] + d[0], vS[1] + d[1]];
          else tR = [vR[0] + d[0], vR[1] + d[1]];
        }
        // R's end always gets a pin: it moves rigidly over its last metre, so
        // its flat end turns with the road it meets rather than with its own bend.
        if (far(tS, vS) && pin(k, `g${g.id}`, q.u, tS)) changed = true;
        if (pin(g.r, `end${g.end}`, uR, tR)) changed = true;
      }
    }
    if (!changed) break;
  }
  return new Map([...pins].map(([k, m]) => [k, [...m.values()]]));
}

/**
 * Largest distance from either polyline (metres) to the other, over every
 * vertex and a point every 0.1 m along each segment (the nearest feature of
 * the other line can switch mid-segment, so vertices alone under-report).
 */
function hausdorff(a, b) {
  const one = (p, q) => {
    let worst = 0;
    for (let i = 0; i < p.length; i += 2) {
      const pts = [[p[i], p[i + 1]]];
      if (i + 3 < p.length) {
        const len = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
        for (let u = 0.1; u < len; u += 0.1) pts.push([p[i] + ((p[i + 2] - p[i]) * u) / len, p[i + 1] + ((p[i + 3] - p[i + 1]) * u) / len]);
      }
      for (const [x, y] of pts) {
        let d = Infinity;
        for (let j = 0; j + 3 < q.length; j += 2) {
          const ax = q[j], ay = q[j + 1], dx = q[j + 2] - ax, dy = q[j + 3] - ay;
          const l2 = dx * dx + dy * dy;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
          d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
        }
        worst = Math.max(worst, d);
      }
    }
    return worst;
  };
  return Math.max(one(a, b), one(b, a));
}

/**
 * Fit the drawn roads to every scenic route so its whole painted guide (centre
 * line ± ROUTE_PAINT_HALF_M) lies on them, with ONE surface under it:
 *
 * - Where the paint leaves the road the route runs along (a path mapped a
 *   metre to the side, a corner the route cuts), that road is bent toward the
 *   route just far enough to hold the paint ROUTE_EASE_SLACK_M inside it,
 *   easing back to its mapped line over ROUTE_EASE_TAPER_M either side, but
 *   never past a vertex where the road turns off the route's line (see
 *   shiftField). It keeps its class, width and surface; nothing is laid
 *   beside it. Every road that met it at a moved junction moves with it.
 * - Where no road runs along the route within ROUTE_EASE_MAX_M (a way the OSM
 *   snapshot lacks, the join where an out-and-back was cut), or the route has
 *   left the road's line (more than ROUTE_EASE_CORNER_M round the outside of
 *   a corner or beside a stretch more than 30° off its heading), the bake
 *   adds that way: a `routeFill` piece along the route, a metre into the
 *   drawn roads at either end like any mapped junction, never alongside one.
 *   Renderers draw it under the mapped roads.
 *
 * Throws when the fitted roads still miss the paint. Mutates `roads` (dm
 * encoding; only bent roads get new points, join pieces are appended).
 * Returns the bent and joined route length per route, how many mapped roads
 * the fit changed and by how much at most (Hausdorff distance, mapped vs
 * fitted), the join count, and each changed road's index, shift and mapped
 * points (dm), so a test can compare the shipped roads with the mapped ones.
 */
export function easeRoadsOntoRoutes(routes, roads) {
  const all = roadEntries(roads);
  const drawn = all.filter((e) => e.drawn);
  for (const e of drawn) e.cum = cumulative(e.p);
  const mappedP = new Map(drawn.map((e) => [e, e.road.p]));
  const groups = junctionGroups(drawn);
  const tunnels = all.filter((e) => e.tunnel);
  const inTunnel = tunnels.length ? roadIndex(tunnels) : null;
  const easedM = Object.fromEntries(routes.map((r) => [r.id, 0]));
  const joinedM = Object.fromEntries(routes.map((r) => [r.id, 0]));
  const joins = [];
  const mid = (r, i) => [(r.x[i] + r.x[i - 1]) / 2, (r.y[i] + r.y[i - 1]) / 2];
  const underground = routes.map((r) => r.s.map((_, i) => i > 0 && !!inTunnel && inTunnel(...mid(r, i)).edge <= COVERAGE_MARGIN_M));
  // Most fits settle in a few passes. Rounding to decimetres can leave a
  // centimetre on a tight corner that takes a few more (Santa Monica's Strand
  // at Hermosa needs 10). A fit that settles stops early, so the cap only
  // changes a fit that would otherwise throw.
  for (let pass = 0; pass < ROUTE_FIT_MAX_PASSES; pass++) {
    const near = roadIndex(drawn);
    const demands = new Map();
    const exts = new Map();
    const gaps = routes.map(() => []);
    routes.forEach((r, ri) => {
      for (let i = 1; i < r.s.length; i++) {
        if (underground[ri][i]) continue;
        const ax = r.x[i - 1], ay = r.y[i - 1], bx = r.x[i], by = r.y[i];
        const tl = Math.hypot(bx - ax, by - ay);
        if (tl === 0) continue;
        const tx = (bx - ax) / tl, ty = (by - ay) / tl;
        const heading = (sdx, sdy) => Math.abs(sdx * tx + sdy * ty) / (Math.hypot(sdx, sdy) || 1);
        const along = (k, sax, say, sbx, sby) => !drawn[k].join && heading(sbx - sax, sby - say) >= ALONG_COS;
        // The road this step runs along: the one nearest its middle within 60°
        // of its heading. Every uncovered point of the step bends that road,
        // so two paths mapped either side of the route never both bend in
        // over each other there.
        const host = near((ax + bx) / 2, (ay + by) / 2, along).index;
        const onHost = (k, sax, say, sbx, sby) => k === host && along(k, sax, say, sbx, sby);
        let need = false;
        let gap = false;
        // Checked where routePaintCoverage checks: the whole band over the step.
        bandStep(near, ax, ay, bx, by, ROUTE_PAINT_HALF_M, 0, (px, py) => {
          // Bend the road the route runs along here, never one it crosses:
          // shifting a crossing road would only slide it along the route.
          const b = host < 0 ? { index: -1, edge: Infinity } : near(px, py, onHost);
          if (b.index < 0 || b.edge - ROUTE_PAINT_HALF_M > ROUTE_EASE_MAX_M) {
            gap = true;
            return;
          }
          const m = b.edge + ROUTE_EASE_SLACK_M;
          const e = drawn[b.index];
          const seg = b.seg / 2;
          const last = e.cum.length - 2;
          const segHeading = (k) => heading(e.p[2 * k + 2] - e.p[2 * k], e.p[2 * k + 3] - e.p[2 * k + 1]);
          // Past the road's flat end it may stretch on; round the outside of one
          // of its corners, or beside a stretch more than 30° off the route's
          // heading, the route is leaving the road's line: only a small bend.
          const flatEnd = (b.t === 0 && seg === 0) || (b.t === 1 && seg === last);
          const corner = !flatEnd && (b.t === 0 || b.t === 1);
          const parallel = segHeading(seg) >= PARALLEL_COS && (!corner || segHeading(b.t === 0 ? seg - 1 : seg + 1) >= PARALLEL_COS);
          if (pass === 0 && !flatEnd && !parallel && m > ROUTE_EASE_CORNER_M) {
            gap = true;
            return;
          }
          let dx, dy;
          if (flatEnd) {
            // A point past the flat end: the road's last segment grows along
            // its own line (nothing bends), and the end shifts sideways only if
            // the point is also beside it.
            const i0 = b.t === 0 ? 0 : 2 * last + 2, i1 = b.t === 0 ? 2 : 2 * last;
            const al = Math.hypot(e.p[i0] - e.p[i1], e.p[i0 + 1] - e.p[i1 + 1]) || 1;
            const ux = (e.p[i0] - e.p[i1]) / al, uy = (e.p[i0 + 1] - e.p[i1 + 1]) / al;
            const rx = px - e.p[i0], ry = py - e.p[i0 + 1];
            const past = rx * ux + ry * uy, lat = -rx * uy + ry * ux;
            const out = Math.max(0, Math.abs(lat) - e.half + ROUTE_EASE_SLACK_M) * Math.sign(lat);
            const grow = exts.get(b.index) ?? [0, 0];
            const end = b.t === 0 ? 0 : 1;
            grow[end] = Math.max(grow[end], past + ROUTE_EASE_SLACK_M);
            exts.set(b.index, grow);
            need = true;
            dx = -uy * out;
            dy = ux * out;
          } else {
            const c = Math.hypot(px - b.qx, py - b.qy);
            if (c < 1e-6) return;
            dx = ((px - b.qx) / c) * m;
            dy = ((py - b.qy) / c) * m;
          }
          const mag = Math.hypot(dx, dy);
          if (mag < 1e-6) return;
          const u = e.cum[seg] + b.t * (e.cum[seg + 1] - e.cum[seg]);
          let bucket = demands.get(b.index);
          if (!bucket) demands.set(b.index, (bucket = new Map()));
          const key = Math.round(u * 4);
          const prev = bucket.get(key);
          if (!prev || mag > prev.m) bucket.set(key, { u, dx, dy, m: mag, seg, tx, ty });
          need = true;
        });
        if (gap) gaps[ri].push(i);
        else if (need && pass === 0) easedM[r.id] += r.s[i] - r.s[i - 1];
      }
    });
    if (pass > 0 && gaps.some((g) => g.length)) {
      const where = routes.flatMap((r, ri) => gaps[ri].slice(0, 3).map((i) => `${r.id} at ${Math.round(r.s[i])} m`));
      throw new Error(`bending roads opened a gap under the route: ${where.join('; ')}`);
    }
    if (pass === 0) {
      routes.forEach((r, ri) => {
        for (const piece of joinPieces(r, gaps[ri], roads, drawn, near)) {
          joins.push(piece.road);
          roads.roads.push(piece.road);
          joinedM[r.id] += piece.lengthM;
          const p = piece.road.p.map((v) => v / 10);
          drawn.push({ road: piece.road, p, half: Math.max(1, piece.road.w ?? roads.widths[piece.road.c]) / 2, drawn: true, tunnel: false, join: true, cum: cumulative(p) });
        }
      });
    }
    if (!demands.size && !exts.size) {
      if (pass === 0 && joins.length) continue;
      break;
    }
    const lists = new Map([...demands].map(([k, bucket]) => [k, [...bucket.values()]]));
    const pins = resolveJunctions(drawn, groups, lists);
    // Each pass sees the roads as they will ship (decimetres), so the next
    // pass repairs what rounding cost.
    for (const k of new Set([...lists.keys(), ...pins.keys(), ...exts.keys()])) {
      const e = drawn[k];
      const ds = lists.get(k) ?? [], ps = pins.get(k) ?? [];
      e.road.p = toDm(extendEnds(ds.length || ps.length ? easeLine(e.p, e.cum, ds, ps) : e.p, exts.get(k)));
      e.p = e.road.p.map((v) => v / 10);
      e.cum = cumulative(e.p);
    }
  }
  const short = routePaintCoverage(routes, roads).filter((c) => c.misses.length);
  if (short.length) {
    throw new Error(`fitted roads still miss the route's paint: ${short.map((c) => `${c.id} ${c.misses.slice(0, 3).map((m) => `${m.fromS}–${m.toS} m (${m.maxOffM} m)`).join(', ')}`).join('; ')}`);
  }
  // What the fit changed, measured on the roads as shipped.
  const bent = [];
  for (const e of drawn) {
    const was = mappedP.get(e);
    if (!was || (was.length === e.road.p.length && was.every((v, i) => v === e.road.p[i]))) continue;
    bent.push({ i: e.index, shiftM: Math.round(hausdorff(was.map((v) => v / 10), e.p) * 100) / 100, mapped: was });
  }
  bent.sort((a, b) => a.i - b.i);
  return {
    easedM: Object.fromEntries(Object.entries(easedM).map(([k, v]) => [k, round1(v)])),
    joinedM: Object.fromEntries(Object.entries(joinedM).map(([k, v]) => [k, round1(v)])),
    maxShiftM: bent.reduce((a, b) => Math.max(a, b.shiftM), 0),
    roadsEased: bent.length,
    joins: joins.length,
    bent,
  };
}

/**
 * What the fit changed, for the bake report: per bent road its index, final
 * shift (Hausdorff between the mapped and shipped lines, m) and its mapped
 * polyline in the bundle's decimetres as "x,y x,y …", so the shipped-bundle
 * tests can compare every bent road with the line OSM mapped
 * (src/lib/world/routeFit.test.ts).
 */
export function routeFitReport(fit) {
  return {
    roadsBent: fit.roadsEased,
    maxShiftM: fit.maxShiftM,
    joins: fit.joins,
    bent: fit.bent.map((b) => ({
      road: b.i,
      shiftM: b.shiftM,
      mapped: b.mapped.reduce((a, v, k) => (k % 2 ? a : [...a, `${v},${b.mapped[k + 1]}`]), []).join(' '),
    })),
  };
}

/**
 * The ways the snapshot lacks under one route: each run of route samples
 * `gap` (indices, no road along them) becomes a road piece along the route,
 * reaching a metre (one sample) past the run at either end into the drawn
 * roads it joins. It takes the class and surface of the drawn road at its
 * start (else an unpaved path) and is at most 2 × ROUTE_EASE_MAX_M wide, so
 * it can't reach a road running alongside (those are farther than that).
 */
function joinPieces(r, gap, roads, drawn, near) {
  const out = [];
  const pathCls = roads.classes.indexOf('path');
  let k = 0;
  while (k < gap.length) {
    let e = k;
    while (e + 1 < gap.length && gap[e + 1] - gap[e] <= 3) e++;
    const i0 = Math.max(0, gap[k] - 2), i1 = Math.min(r.s.length - 1, gap[e] + 1);
    const flat = [];
    for (let i = i0; i <= i1; i++) flat.push(r.x[i], r.y[i]);
    if (flat.length >= 4) {
      const at = near(r.x[i0], r.y[i0], (j) => !drawn[j].join);
      const src = at.index >= 0 && at.edge <= 0 ? drawn[at.index].road : null;
      const road = { c: src ? src.c : pathCls };
      road.f = ROAD_FLAGS.routeFill | (src ? (src.f ?? 0) & ROAD_FLAGS.unpaved : ROAD_FLAGS.unpaved);
      const w = Math.min(src ? (src.w ?? roads.widths[src.c]) : roads.widths[pathCls], 2 * ROUTE_EASE_MAX_M);
      if (w !== roads.widths[road.c]) road.w = w;
      if (src && src.n !== undefined) road.n = src.n;
      road.p = simplifyLine(flat, 0.05).map((v) => Math.round(v * 10));
      out.push({ road, lengthM: r.s[i1] - r.s[i0] });
    }
    k = e + 1;
  }
  return out;
}

/** Grow a polyline's first and last segments along their own lines by `grow` = [start, end] metres. */
function extendEnds(p, grow) {
  if (!grow || (grow[0] <= 0 && grow[1] <= 0)) return p;
  const out = p.slice();
  const n = out.length;
  const push = (i, j, d) => {
    if (d <= 0) return;
    const l = Math.hypot(out[i] - out[j], out[i + 1] - out[j + 1]) || 1;
    out[i] += ((out[i] - out[j]) / l) * d;
    out[i + 1] += ((out[i + 1] - out[j + 1]) / l) * d;
  };
  push(0, 2, grow[0]);
  push(n - 2, n - 4, grow[1]);
  return out;
}

/** Metres → the bundle's decimetres, without repeated points. */
function toDm(m) {
  const q = m.map((v) => Math.round(v * 10));
  const p = [q[0], q[1]];
  for (let i = 2; i < q.length; i += 2) if (q[i] !== p[p.length - 2] || q[i + 1] !== p[p.length - 1]) p.push(q[i], q[i + 1]);
  return p;
}

function cumulative(p) {
  const cum = [0];
  for (let i = 2; i < p.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]));
  return cum;
}

/** The app route (scenicRoutes.routeFromGeometry's points), projected and sampled every `step` m. */
export function sampleAppRoute(points, projection, step = 1) {
  const app = appRoutePoints(points);
  const x = [], y = [], s = [];
  for (let i = 0; i < app.d.length; i++) {
    if (i > 0) {
      const span = app.d[i] - app.d[i - 1];
      const k = Math.ceil(span / step);
      for (let j = 1; j < k; j++) {
        const f = j / k;
        const [px, py] = projection.forward(app.lat[i - 1] + (app.lat[i] - app.lat[i - 1]) * f, app.lon[i - 1] + (app.lon[i] - app.lon[i - 1]) * f);
        x.push(px); y.push(py); s.push(app.d[i - 1] + span * f);
      }
    }
    const [px, py] = projection.forward(app.lat[i], app.lon[i]);
    x.push(px); y.push(py); s.push(app.d[i]);
  }
  return { x, y, s };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ROOT = resolve(here(import.meta.url), '../..');
  const args = process.argv.slice(2);
  const world = args.find((a) => !a.startsWith('-'));
  const bi = args.indexOf('--bundle');
  const recipe = JSON.parse(readFileSync(join(ROOT, 'tools/worldbake/worlds', `${world}.json`), 'utf8'));
  const dir = resolve(bi >= 0 ? args[bi + 1] : join(ROOT, recipe.host === 'remote' ? 'tools/worldbake/remote' : 'public/worlds', world));
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const roads = JSON.parse(gunzipSync(readFileSync(join(dir, manifest.layers.roads))).toString('utf8'));
  const projection = createProjection(manifest.projection);
  const geometry = loadScenicGeometry(join(ROOT, 'src/lib/scenicRouteData.ts'));
  const routes = recipe.routes.map((id) => ({ id, ...sampleAppRoute(geometry[id].points, projection) }));
  const levels = [
    ['near', `Within ${COVERAGE_MARGIN_M} m of a drawn road's edge:`, COVERAGE_MARGIN_M, 0],
    ['strict', 'Centreline on a drawn road:', 0, 0],
    ['paint', `Painted guide (centreline ± ${ROUTE_PAINT_HALF_M} m) on drawn roads:`, 0, ROUTE_PAINT_HALF_M],
  ];
  const out = Object.fromEntries(levels.map(([k, , m, half]) => [k, routeRoadCoverage(routes, roads, m, half)]));
  if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else {
    for (const [k, label] of levels) {
      console.log(label);
      for (const r of out[k]) {
        console.log(`  ${r.id}: ${r.pct}% of ${(r.lengthM / 1000).toFixed(2)} km (${r.misses.length} gaps, ${(r.lengthM - r.coveredM - r.tunnelM).toFixed(0)} m off${r.tunnelM ? `, ${r.tunnelM.toFixed(0)} m in tunnels` : ''})`);
        for (const m of r.misses.filter((m) => m.lengthM >= 5)) console.log(`     ${m.fromS}–${m.toS} m (${m.lengthM} m, up to ${m.maxOffM} m past the edge)`);
      }
    }
  }
}
