#!/usr/bin/env node
// How much of each scenic route sits on a drawn road or path, and the
// surface the bake adds where it doesn't.
//
//   node tools/worldbake/routeCoverage.mjs <world> [--bundle dir] [--json]
//
// For every route in the world's recipe, the app's own polyline (the line the
// rider follows, from src/lib/scenicRouteData.ts) is walked every metre and
// each metre counts as "on a road" when it lies within that road's half-width
// + 1 m of a road the renderer draws (roadRibbons.roadLines: every class but
// steps, no tunnels, width at least 1 m). Metres inside a mapped tunnel or
// underpass are counted apart (`tunnelM`): nothing is drawn there on purpose.
// The bake report carries the same numbers (`routes[].roadCoverage`), before
// and after the route fill.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createProjection } from '../../src/lib/world/projection.ts';
import { appRoutePoints, loadScenicGeometry } from './snapRoutes.mjs';
import { ROAD_FLAGS } from './buildVectors.mjs';
import { here, simplifyLine } from './util.mjs';

/** Extra reach past a road's half-width that still counts as on it, m. */
export const COVERAGE_MARGIN_M = 1;
/** A route fill reaches this far past each end of the gap it covers, m (joins the roads either side). */
export const ROUTE_FILL_PAD_M = 2;
/** The nearest road this close to a gap lends the fill its class and surface, m. */
export const ROUTE_FILL_MATCH_M = 12;

/** Segment index over road polylines (metres), queried by point. */
function roadIndex(entries) {
  const reach = Math.max(1, ...entries.map((d) => d.half));
  const cell = Math.max(20, Math.ceil(reach + ROUTE_FILL_MATCH_M));
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
   * Nearest road to (x, y): `edge` = distance past its half-width (negative
   * inside), `centre` = distance to its centreline, `index` into `entries`.
   * `rank` picks what "nearest" means ('edge' or 'centre').
   */
  return (x, y, rank = 'edge') => {
    let best = { edge: Infinity, centre: Infinity, index: -1 };
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
          const dx = bx - ax, dy = by - ay;
          const l2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
          const c = Math.hypot(x - ax - t * dx, y - ay - t * dy);
          const e = c - d.half;
          if (rank === 'edge' ? e < best.edge || (e === best.edge && list[k] < best.index) : c < best.centre || (c === best.centre && list[k] < best.index)) {
            best = { edge: e, centre: c, index: list[k] };
          }
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
 * exceeds `margin`. With `inTunnel`, metres within a tunnel's half-width +
 * margin count as tunnel, not as misses.
 */
function walk(r, near, margin, inTunnel = null) {
  let covered = 0;
  let total = 0;
  let tunnel = 0;
  const misses = [];
  let open = null;
  for (let i = 1; i < r.s.length; i++) {
    const len = r.s[i] - r.s[i - 1];
    const mx = (r.x[i] + r.x[i - 1]) / 2, my = (r.y[i] + r.y[i - 1]) / 2;
    const e = near(mx, my).edge;
    total += len;
    if (e <= margin || (inTunnel && inTunnel(mx, my).edge <= margin)) {
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
 * road, and the uncovered stretches (route distance from/to, metres).
 * `routes` = [{ id, x: number[], y: number[], s: number[] }] sampled densely
 * (≤ 1 m); `roads` = the roads layer as baked (dm).
 */
export function routeRoadCoverage(routes, roads, margin = COVERAGE_MARGIN_M) {
  const all = roadEntries(roads);
  const near = roadIndex(all.filter((e) => e.drawn));
  const tunnels = all.filter((e) => e.tunnel);
  const inTunnel = tunnels.length ? roadIndex(tunnels) : null;
  return routes.map((r) => walk(r, near, margin, inTunnel));
}

/**
 * The surface under every route stretch whose centreline is off every drawn
 * road (the route follows a way OSM's snapshot lacks, a join where an
 * out-and-back was cut, a path drawn a metre to the side): a road piece along
 * the route itself, padded ROUTE_FILL_PAD_M into the roads either side, with
 * the class, surface and width of the nearest mapped way (a gravel track
 * stays gravel), or an unpaved path when nothing is mapped nearby. Pieces
 * carry ROAD_FLAGS.routeFill; the renderer draws them under the mapped roads.
 * Stretches over a tunnel get no surface (the rider is underground).
 *
 * Returns road entries in the roads-layer encoding (dm) plus the filled length.
 */
export function routeSurfaceFill(routes, roads) {
  const all = roadEntries(roads);
  const drawn = all.filter((e) => e.drawn);
  const nearDrawn = roadIndex(drawn);
  const nearAny = roadIndex(all);
  const pathCls = roads.classes.indexOf('path');
  const pieces = [];
  const filled = {};
  for (const r of routes) {
    filled[r.id] = 0;
    for (const m of walk(r, nearDrawn, 0).misses) {
      const a = Math.max(0, m.fromS - ROUTE_FILL_PAD_M);
      const b = Math.min(r.s[r.s.length - 1], m.toS + ROUTE_FILL_PAD_M);
      const flat = [];
      let mid = -1;
      for (let i = 0; i < r.s.length; i++) {
        if (r.s[i] < a || r.s[i] > b) continue;
        flat.push(r.x[i], r.y[i]);
        if (mid < 0 && r.s[i] >= (m.fromS + m.toS) / 2) mid = i;
      }
      if (flat.length < 4 || mid < 0) continue;
      const under = nearAny(r.x[mid], r.y[mid], 'centre');
      if (under.index >= 0 && all[under.index].tunnel && under.centre <= all[under.index].half + 1) continue;
      const match = nearDrawn(r.x[mid], r.y[mid], 'centre');
      const src = match.index >= 0 && match.centre <= ROUTE_FILL_MATCH_M ? drawn[match.index].road : null;
      const piece = { c: src ? src.c : pathCls };
      const f = ROAD_FLAGS.routeFill | (src ? (src.f ?? 0) & ROAD_FLAGS.unpaved : ROAD_FLAGS.unpaved);
      piece.f = f;
      if (src?.w) piece.w = src.w;
      if (src && src.n !== undefined) piece.n = src.n;
      piece.p = simplifyLine(flat, 0.25).map((v) => Math.round(v * 10));
      pieces.push(piece);
      filled[r.id] += m.toS - m.fromS;
    }
    filled[r.id] = round1(filled[r.id]);
  }
  return { pieces, filledM: filled };
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
  const fillFlag = roads.flags?.routeFill ?? 0;
  const osmOnly = { ...roads, roads: roads.roads.filter((r) => !((r.f ?? 0) & fillFlag)) };
  const out = { mapped: routeRoadCoverage(routes, osmOnly), drawn: fillFlag ? routeRoadCoverage(routes, roads) : null };
  if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else {
    for (const [label, list] of Object.entries(out)) {
      if (!list) continue;
      console.log(label === 'mapped' ? 'On mapped OSM roads:' : 'On drawn surfaces (mapped roads + route fill):');
      for (const r of list) {
        console.log(`  ${r.id}: ${r.pct}% of ${(r.lengthM / 1000).toFixed(2)} km (${r.misses.length} gaps, ${(r.lengthM - r.coveredM - r.tunnelM).toFixed(0)} m off${r.tunnelM ? `, ${r.tunnelM.toFixed(0)} m in tunnels` : ''})`);
        for (const m of r.misses.filter((m) => m.lengthM >= 5)) console.log(`     ${m.fromS}–${m.toS} m (${m.lengthM} m, up to ${m.maxOffM} m past the edge)`);
      }
    }
  }
}
