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
 * - synthetic: what the bake's fit does (tools/worldbake/routeCoverage.mjs);
 * - shipped: every bundle in public/worlds, measured the way the renderer
 *   draws roads (flat ends, real widths).
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

/**
 * How far a route-fill piece reaches into the mapped roads away from its two
 * ends (its junctions), metres; ≤ 0 means it never lies over one there.
 */
function fillOverlapM(roads: Layer): { worst: number; at: string } {
  const steps = roads.classes.indexOf('steps');
  const mapped = roads.roads
    .filter((r) => !isFill(r) && r.c !== steps && !((r.f ?? 0) & ROAD_FLAGS.tunnel) && r.p.length >= 4)
    .map((r) => ({ p: metres(r), half: Math.max(1, r.w ?? roads.widths[r.c]) / 2 }))
    .map((m) => ({ ...m, box: bbox(m.p, m.half) }));
  let worst = -Infinity;
  let at = '';
  for (const f of roads.roads.filter(isFill)) {
    const p = metres(f);
    const half = Math.max(1, f.w ?? roads.widths[f.c]) / 2;
    const fb = bbox(p, half);
    const near = mapped.filter((m) => m.box[0] <= fb[2] && m.box[2] >= fb[0] && m.box[1] <= fb[3] && m.box[3] >= fb[1]);
    const cum = [0];
    for (let i = 2; i < p.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]));
    const total = cum[cum.length - 1];
    // A join reaches a metre into the road at each end, plus its own width.
    const junction = 1 + 2 * half;
    for (let i = 1; i < cum.length; i++) {
      const seg = cum[i] - cum[i - 1];
      for (let u = 0; u <= seg; u += 0.25) {
        const d = cum[i - 1] + u;
        if (d < junction || d > total - junction) continue;
        const f2 = seg ? u / seg : 0;
        const x = p[2 * i - 2] + (p[2 * i] - p[2 * i - 2]) * f2;
        const y = p[2 * i - 1] + (p[2 * i + 1] - p[2 * i - 1]) * f2;
        for (const m of near) {
          const reach = half - edgeOf(x, y, m.p, m.half);
          if (reach > worst) { worst = reach; at = `(${x.toFixed(1)}, ${y.toFixed(1)})`; }
        }
      }
    }
  }
  return { worst, at };
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
});

const WORLDS = fileURLToPath(new URL('../../../public/worlds', import.meta.url));
const RECIPES = fileURLToPath(new URL('../../../tools/worldbake/worlds', import.meta.url));

function shippedWorlds() {
  return readdirSync(WORLDS)
    .filter((id) => existsSync(join(WORLDS, id, 'manifest.json')) && existsSync(join(RECIPES, `${id}.json`)))
    .map((id) => {
      const manifest = JSON.parse(readFileSync(join(WORLDS, id, 'manifest.json'), 'utf8'));
      const recipe = JSON.parse(readFileSync(join(RECIPES, `${id}.json`), 'utf8'));
      const roads: Layer = JSON.parse(gunzipSync(readFileSync(join(WORLDS, id, manifest.layers.roads))).toString('utf8'));
      const projection = createProjection(manifest.projection);
      const routes: Sampled[] = recipe.routes.map((rid: string) => ({ id: rid, ...sampleAppRoute(SCENIC_ROUTE_GEOMETRY[rid].points, projection) }));
      return { id, roads, routes };
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
  }

  it('perugia: no route fill at all (every stretch was a path mapped beside the route, now bent onto it)', () => {
    const perugia = worlds.find((w) => w.id === 'perugia')!;
    expect(perugia.roads.roads.filter(isFill)).toEqual([]);
  });
});
