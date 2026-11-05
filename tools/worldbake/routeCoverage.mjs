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
  return (x, y, accept = null) => {
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
          const ax = l[i], ay = l[i + 1], bx = l[i + 2], by = l[i + 3];
          if (accept && !accept(list[k], ax, ay, bx, by)) continue;
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
          if (e < best.edge || (e === best.edge && list[k] < best.index)) best = { edge: e, index: list[k], seg: i, t, qx, qy };
        }
      }
    }
    return best;
  };
}

/** Every road in the layer (metres), with what the renderer does with it. */
function roadEntries(roads) {
  const steps = roads.classes.indexOf('steps');
  return roads.roads.map((r) => {
    const f = r.f ?? 0;
    return {
      road: r,
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
 * exceeds `margin`. With `paintHalf`, a metre counts only when the points that
 * far either side of the centreline are within `margin` too (each may lie on
 * a different road: a junction). With `inTunnel`, metres within a tunnel's
 * half-width + COVERAGE_MARGIN_M count as tunnel, not as misses.
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
    let e = near(mx, my).edge;
    if (paintHalf > 0 && len > 0) {
      const nx = (-(r.y[i] - r.y[i - 1]) / len) * paintHalf, ny = ((r.x[i] - r.x[i - 1]) / len) * paintHalf;
      e = Math.max(e, near(mx + nx, my + ny).edge, near(mx - nx, my - ny).edge);
    }
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
    misses: misses.map((m) => ({ fromS: round1(m.fromS), toS: round1(m.toS), lengthM: round1(m.toS - m.fromS), maxOffM: round1(m.maxOffM) })),
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
 * Shift polyline `p` (metres) by `demands` ({ u: metres along it, dx, dy })
 * and return the new polyline. Each point moves by the strongest weighted
 * demand; every original vertex stays a vertex, points every metre are added
 * only where the line moves, and each run between two original vertices is
 * simplified back to few points. Vertices beyond every demand's taper keep
 * their exact place.
 */
function easeLine(p, demands) {
  const n = p.length / 2;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]));
  const reach = 1 + ROUTE_EASE_TAPER_M;
  const lo = Math.min(...demands.map((d) => d.u)) - reach;
  const hi = Math.max(...demands.map((d) => d.u)) + reach;
  const shift = (u) => {
    let best = 0, sx = 0, sy = 0;
    for (const d of demands) {
      const w = easeWeight(Math.abs(u - d.u));
      if (w === 0) continue;
      const m = Math.hypot(d.dx, d.dy) * w;
      if (m > best) { best = m; sx = d.dx * w; sy = d.dy * w; }
    }
    return [sx, sy];
  };
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
        const [sx, sy] = shift(u);
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

/**
 * Fit the drawn roads to every scenic route so its whole painted guide (centre
 * line ± ROUTE_PAINT_HALF_M) lies on them, with ONE surface under it:
 *
 * - Where the paint leaves the road the route runs along (a path mapped a
 *   metre to the side, a corner the route cuts), that road is bent toward the
 *   route just far enough to hold the paint ROUTE_EASE_SLACK_M inside it,
 *   easing back to its mapped line over ROUTE_EASE_TAPER_M either side. It
 *   keeps its class, width and surface; nothing is laid beside it.
 * - Where no road runs along the route within ROUTE_EASE_MAX_M (a way the OSM
 *   snapshot lacks, the join where an out-and-back was cut), the bake adds that
 *   way: a `routeFill` piece along the route, a metre into the drawn roads at
 *   either end like any mapped junction, never alongside one (it is at most
 *   2 × ROUTE_EASE_MAX_M wide). Renderers draw it under the mapped roads.
 *
 * Throws when the fitted roads still miss the paint. Mutates `roads` (dm
 * encoding; only bent roads get new points, join pieces are appended).
 * Returns the bent and joined route length per route, the largest bend and
 * the number of roads bent and pieces added.
 */
export function easeRoadsOntoRoutes(routes, roads) {
  const all = roadEntries(roads);
  const drawn = all.filter((e) => e.drawn);
  for (const e of drawn) e.cum = cumulative(e.p);
  const tunnels = all.filter((e) => e.tunnel);
  const inTunnel = tunnels.length ? roadIndex(tunnels) : null;
  const easedM = Object.fromEntries(routes.map((r) => [r.id, 0]));
  const joinedM = Object.fromEntries(routes.map((r) => [r.id, 0]));
  const touched = new Set();
  const joins = [];
  let maxShiftM = 0;
  // Checked where routeRoadCoverage checks: the midpoint of each sample step, across that step.
  const mid = (r, i) => [(r.x[i] + r.x[i - 1]) / 2, (r.y[i] + r.y[i - 1]) / 2];
  const underground = routes.map((r) => r.s.map((_, i) => i > 0 && !!inTunnel && inTunnel(...mid(r, i)).edge <= COVERAGE_MARGIN_M));
  for (let pass = 0; pass < 6; pass++) {
    const near = roadIndex(drawn);
    const demands = new Map();
    const gaps = routes.map(() => []);
    routes.forEach((r, ri) => {
      for (let i = 1; i < r.s.length; i++) {
        if (underground[ri][i]) continue;
        const [x, y] = mid(r, i);
        const tx = r.x[i] - r.x[i - 1], ty = r.y[i] - r.y[i - 1];
        const tl = Math.hypot(tx, ty);
        if (tl === 0) continue;
        const nx = (-ty / tl) * ROUTE_PAINT_HALF_M, ny = (tx / tl) * ROUTE_PAINT_HALF_M;
        const pts = [[x, y], [x + nx, y + ny], [x - nx, y - ny]];
        const along = (k, ax, ay, bx, by) => {
          if (drawn[k].join) return false;
          const dx = bx - ax, dy = by - ay;
          return Math.abs(dx * tx + dy * ty) >= ALONG_COS * Math.hypot(dx, dy) * tl;
        };
        let need = false;
        let gap = false;
        for (const [px, py] of pts) {
          if (near(px, py).edge <= -ROUTE_EASE_SLACK_M + 1e-6) continue;
          // Bend the road the route runs along here (within 60° of its heading),
          // never one it crosses: shifting a crossing road would only slide it
          // along the route. Pulling it toward the uncovered point also stretches
          // a road's flat end round a corner.
          const b = near(px, py, along);
          const m = b.edge + ROUTE_EASE_SLACK_M;
          if (m <= 0) continue;
          if (b.edge - ROUTE_PAINT_HALF_M > ROUTE_EASE_MAX_M) {
            gap = true;
            continue;
          }
          const c = Math.hypot(px - b.qx, py - b.qy);
          if (c < 1e-6) continue;
          const e = drawn[b.index];
          const u = e.cum[b.seg / 2] + b.t * (e.cum[b.seg / 2 + 1] - e.cum[b.seg / 2]);
          let list = demands.get(b.index);
          if (!list) demands.set(b.index, (list = []));
          list.push({ u, dx: ((px - b.qx) / c) * m, dy: ((py - b.qy) / c) * m });
          need = true;
          if (pass === 0) maxShiftM = Math.max(maxShiftM, m);
        }
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
    if (!demands.size) {
      if (pass === 0 && joins.length) continue;
      break;
    }
    // Each pass sees the roads as they will ship (decimetres), so the next
    // pass repairs what rounding cost.
    for (const [k, list] of demands) {
      const e = drawn[k];
      e.road.p = toDm(easeLine(e.p, list));
      e.p = e.road.p.map((v) => v / 10);
      e.cum = cumulative(e.p);
      touched.add(e);
    }
  }
  const short = routePaintCoverage(routes, roads).filter((c) => c.misses.length);
  if (short.length) {
    throw new Error(`fitted roads still miss the route's paint: ${short.map((c) => `${c.id} ${c.misses.slice(0, 3).map((m) => `${m.fromS}–${m.toS} m`).join(', ')}`).join('; ')}`);
  }
  return {
    easedM: Object.fromEntries(Object.entries(easedM).map(([k, v]) => [k, round1(v)])),
    joinedM: Object.fromEntries(Object.entries(joinedM).map(([k, v]) => [k, round1(v)])),
    maxShiftM: Math.round(maxShiftM * 100) / 100,
    roadsEased: touched.size,
    joins: joins.length,
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
  const dir = resolve(bi >= 0 ? args[bi + 1] : join(ROOT, 'public/worlds', world));
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const recipe = JSON.parse(readFileSync(join(ROOT, 'tools/worldbake/worlds', `${world}.json`), 'utf8'));
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
