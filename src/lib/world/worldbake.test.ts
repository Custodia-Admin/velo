/**
 * Unit tests for the bake's pure helpers (tools/worldbake/*.mjs). The bake
 * itself runs on the bake host; these keep its geometry honest in CI.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { createProjection } from './projection';
import { Heightfield } from './heightfield';
import { appRoutePoints, carveRoutes, closeLoop, finishRoutes } from '../../../tools/worldbake/snapRoutes.mjs';
import {
  CHARACTER_DEFAULTS,
  ROUTE_CLEAR_MAX_M,
  ROUTE_CLEAR_MIN_M,
  ROUTE_TREE_HALF_M,
  buildBuildings,
  buildVegetation,
  buildingClearance,
  routeClearances,
  clipLine,
  clipRing,
  segmentRingDistance,
} from '../../../tools/worldbake/buildVectors.mjs';
import { quantize } from '../../../tools/worldbake/buildHeightfield.mjs';
import { tilesForBbox } from '../../../tools/worldbake/fetchDem.mjs';
import { loadBakedWorld } from '../../../tools/worldbake/validate.mjs';
import { readableWorldBundles } from '../../../tools/worldbake/worldBundles.mjs';

describe('worldbake: snapRoutes', () => {
  it('replicates scenicRoutes.routeFromGeometry distances for every scenic route', () => {
    for (const [id, geom] of Object.entries(SCENIC_ROUTE_GEOMETRY)) {
      const app = routeFromGeometry(id, id, geom);
      const bake = appRoutePoints(geom.points);
      expect(bake.d.length, id).toBe(app.points.length);
      expect(bake.total, id).toBe(app.totalDistance);
      expect(bake.lat[17], id).toBe(app.points[17].lat);
    }
  });

  it('carves a corridor that follows the profile shape and leaves zero gap', () => {
    const proj = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 43, lon0: 12, k0: 1 });
    const grid = { cols: 121, rows: 61, cellSize: 10, xMin: -600, yMax: 300 };
    // Bumpy terrain: a 3 m ripple every 40 m on a gentle tilt.
    const heights = new Float64Array(grid.cols * grid.rows);
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) heights[r * grid.cols + c] = 200 + c * 0.05 + 3 * Math.sin(c * 1.6);
    }
    // A straight 800 m eastward route whose profile climbs 1 %.
    const [la0, lo0] = proj.inverse(-400, 0);
    const [la1, lo1] = proj.inverse(400, 0);
    const route = { id: 'r', name: 'R', points: [[la0, lo0, 100], [la1, lo1, 108]] };
    const snap = { stepM: 10, offsetMedianM: 200, offsetMeanM: 400, coreCells: 1.5, falloffM: 30 };
    const before = heights.slice();
    const carved = carveRoutes({ grid, heights, projection: proj, routes: [route], snap });
    expect(carved.carvedNodes).toBeGreaterThan(0);
    // Far from the route the terrain is untouched.
    expect(heights[0]).toBe(before[0]);

    const { q, heightOffset, heightScale } = quantize(heights);
    const hf = new Heightfield({ ...grid, heightOffset, heightScale }, q);
    const { routes, info } = finishRoutes({ prepared: carved.prepared, hf, snap });
    expect(info[0].maxGapM).toBe(0);
    for (let i = 0; i < routes[0].h.length; i++) expect(routes[0].h[i]).toBe(hf.sampleHeight(routes[0].x[i], routes[0].y[i]));
    // Raw terrain ripples ±3 m every 40 m; the carved road climbs smoothly with the 1 % profile.
    expect(info[0].report.rawDemGradeMeanAbsDiffPct).toBeGreaterThan(info[0].gradeMeanAbsDiffPct);
    expect(info[0].gradeMeanAbsDiffPct).toBeLessThan(0.5);
  });

  it('a loop meets itself at one height; an open route keeps its target', () => {
    // A 1 km square loop sampled every 10 m whose profile ends 4.5 m above where it starts.
    const s = Array.from({ length: 101 }, (_, i) => i * 10);
    const at = (v: number): [number, number] => {
      const side = Math.min(3, Math.floor(v / 250));
      const t = v - side * 250;
      return ([[t, 0], [250, t], [250 - t, 250], [0, 250 - t]] as [number, number][])[side];
    };
    const x = s.map((v) => at(v)[0]);
    const y = s.map((v) => at(v)[1]);
    const target = s.map((v) => 466 + (4.5 * v) / 1000);
    const out = closeLoop(s, x, y, target, { stepM: 10, rampM: 400 });
    expect(out[0]).toBeCloseTo(468.25, 6);
    expect(out[100]).toBeCloseTo(468.25, 6);
    // The steepest step anywhere is the profile's own plus |Δ| / (2 · ramp), here 250 m (a quarter of the loop).
    let worst = 0;
    for (let i = 1; i < s.length; i++) worst = Math.max(worst, Math.abs(out[i] - out[i - 1]) / 10);
    expect(worst).toBeLessThan(0.0045 + 4.5 / 2 / 250 + 1e-9);
    // Away from the ends the target is untouched.
    expect(out[50]).toBe(target[50]);
    // An open route (ends 1 km apart) is returned as it is.
    const open = s.map((v) => v);
    expect(closeLoop(s, open, s.map(() => 0), target, { stepM: 10, rampM: 400 })).toBe(target);
  });

  it('refuses a route that leaves the world', () => {
    const proj = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 43, lon0: 12, k0: 1 });
    const grid = { cols: 11, rows: 11, cellSize: 10, xMin: -50, yMax: 50 };
    const [la, lo] = proj.inverse(0, 0);
    const [la1, lo1] = proj.inverse(400, 0);
    expect(() =>
      carveRoutes({
        grid,
        heights: new Float64Array(121),
        projection: proj,
        routes: [{ id: 'far', name: 'Far', points: [[la, lo, 0], [la1, lo1, 0]] }],
        snap: { stepM: 10, offsetMedianM: 100, offsetMeanM: 100, coreCells: 1, falloffM: 5 },
      }),
    ).toThrow(/leaves the world/);
  });
});

describe('worldbake: vectors and tiles', () => {
  const ext = { xMin: 0, xMax: 100, yMin: 0, yMax: 100 };

  it('clips polylines to the extent, splitting where they leave', () => {
    expect(clipLine([-50, 50, 150, 50], ext)).toEqual([[0, 50, 100, 50]]);
    const pieces = clipLine([10, 10, 10, 200, 20, 200, 20, 10], ext);
    expect(pieces).toEqual([
      [10, 10, 10, 100],
      [20, 100, 20, 10],
    ]);
    expect(clipLine([200, 200, 300, 300], ext)).toEqual([]);
  });

  it('clips polygons to the extent', () => {
    const clipped = clipRing([-50, -50, 50, -50, 50, 50, -50, 50], ext);
    const xs = clipped.filter((_: number, i: number) => i % 2 === 0);
    const ys = clipped.filter((_: number, i: number) => i % 2 === 1);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(50);
    expect(Math.min(...ys)).toBe(0);
    expect(clipRing([200, 200, 300, 200, 300, 300], ext)).toEqual([]);
  });

  it('lists the terrarium tiles covering a bbox', () => {
    const { tiles } = tilesForBbox({ south: 43.03391, west: 12.31702, north: 43.16021, east: 12.63672 }, 13);
    // x = floor((lon+180)/360·2^13), y from the Web Mercator latitude of the north edge.
    expect(tiles[0]).toEqual({ z: 13, x: 4376, y: 3005 });
    expect(tiles.length).toBeGreaterThan(20);
  });
});

describe('worldbake: nothing the rider follows runs through a building', () => {
  const square = (cx: number, cy: number, half = 4) => [cx - half, cy - half, cx + half, cy - half, cx + half, cy + half, cx - half, cy + half];

  it('measures segment-to-footprint distance (0 when it touches or crosses)', () => {
    const ring = square(0, 0);
    expect(segmentRingDistance(-20, 10, 20, 10, ring)).toBeCloseTo(6, 6);
    expect(segmentRingDistance(-20, 0, 20, 0, ring)).toBe(0);
    expect(segmentRingDistance(0, 0, 1, 1, ring)).toBe(0);
    expect(segmentRingDistance(10, 10, 20, 20, ring)).toBeCloseTo(Math.hypot(6, 6), 6);
  });

  it('drops footprints within the clearance of a route and ones a road passes right through', () => {
    // A route along y = 0 from x = -100 to 300.
    const routeLines = [[-100, 0, 100, 0, 300, 0]];
    // Roads: one straight through a house at (0, 60), a driveway ending inside a garage at (60, 60).
    const roadLines = [
      [-20, 60, 20, 60],
      [60, 80, 60, 61],
    ];
    const rings = [
      square(0, 30), // 26 m off the route: keep
      square(40, ROUTE_CLEAR_MAX_M - 1 + 4), // wall 5 m from the route: drop (route)
      square(80, 0), // straddles the route: drop (route)
      square(120, ROUTE_CLEAR_MAX_M + 0.5 + 4), // wall 6.5 m away: keep
      square(0, 60), // road crosses it twice: drop (road)
      square(60, 60), // driveway crosses once: keep
      square(250, -2, 1), // tiny shed right on the route's far end: drop (route)
    ];
    expect([...buildingClearance(rings, { routeLines, roadLines })]).toEqual([0, 1, 1, 0, 2, 0, 1]);
    // Per-segment clearances: a narrow street keeps its 4.5 m-off frontage.
    const narrow = routeClearances(routeLines, { roads: [{ c: 0, p: [-1000, 0, 3000, 0] }], widths: [5] });
    expect(narrow.clear[0].every((c: number) => c === ROUTE_CLEAR_MIN_M)).toBe(true);
    const kept = [...buildingClearance(rings, { routeLines: narrow.lines, routeClear: narrow.clear, roadLines })];
    expect(kept).toEqual([0, 0, 1, 0, 2, 0, 1]);
    // Without lines nothing goes.
    expect([...buildingClearance(rings)]).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('sizes the route clearance from the road under it', () => {
    const roads = {
      widths: [5, 10, 12],
      roads: [
        { c: 0, p: [0, 0, 1000, 0] }, // residential, 5 m
        { c: 1, p: [1000, 0, 2000, 0] }, // trunk, 10 m
        { c: 0, w: 8, p: [2000, 0, 3000, 0] }, // tagged 8 m wide
        { c: 2, f: 2, p: [3000, 0, 4000, 0] }, // motorway in a tunnel: not drawn
      ].map((r) => ({ ...r, p: r.p.map((v) => v * 10) })),
    };
    const { lines, clear } = routeClearances([[0, 1, 5000, 1]], roads);
    expect(lines[0].length / 2 - 1).toBe(clear[0].length);
    expect(clear[0].length).toBe(500);
    const at = (x: number) => clear[0][Math.floor(x / 10)];
    expect(at(500)).toBe(ROUTE_CLEAR_MIN_M); // 2.5 + 1 = 3.5
    expect(at(1500)).toBe(ROUTE_CLEAR_MAX_M); // 5 + 1 capped at 6
    expect(at(2500)).toBe(5); // 4 + 1
    expect(at(3500)).toBe(ROUTE_CLEAR_MAX_M); // tunnel: no drawn road under the route
    expect(at(4500)).toBe(ROUTE_CLEAR_MAX_M); // nothing mapped
  });

  it('buildBuildings drops them from the bundle and keeps the rest in order', () => {
    const proj = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 43, lon0: 12, k0: 1 });
    const ext = { xMin: -500, xMax: 500, yMin: -500, yMax: 500 };
    const way = (id: number, ring: number[]) => {
      const geometry = [];
      for (let i = 0; i <= ring.length; i += 2) {
        const [lat, lon] = proj.inverse(ring[i % ring.length], ring[(i + 1) % ring.length]);
        geometry.push({ lat, lon });
      }
      return { type: 'way', id, tags: { building: 'yes' }, geometry };
    };
    const els = [way(1, square(0, 40)), way(2, square(0, 3)), way(3, square(100, 40))];
    const all = buildBuildings(els, proj, ext);
    const cleared = buildBuildings(els, proj, ext, [], { routeLines: [[-200, 0, 200, 0]], roadLines: [] });
    expect(all.count).toBe(3);
    expect(cleared.count).toBe(2);
    expect(cleared.dropped).toEqual({ route: 1, road: 0 });
    expect(cleared.footprints.map((f: { cx: number }) => Math.round(f.cx) + 0)).toEqual([0, 100]);
    expect(cleared.bytes.subarray(0, 4).toString('latin1')).toBe('VWB2');
  });

  it('keeps trees off the route corridor too', () => {
    const ext = { xMin: -300, xMax: 300, yMin: -300, yMax: 300 };
    const park = { kind: 'park', tags: { leisure: 'park' }, rings: [[-200, -200, 200, -200, 200, 200, -200, 200]] };
    const recipe = { seed: 1, maxInstances: 100000, spacingM: { park: 4 } };
    const decode = (bytes: Uint8Array) => {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const n = dv.getUint32(4, true);
      const q = dv.getFloat32(8, true);
      const pts: [number, number][] = [];
      for (let i = 0; i < n; i++) pts.push([ext.xMin + dv.getUint16(16 + i * 2, true) * q, ext.yMin + dv.getUint16(16 + n * 2 + i * 2, true) * q]);
      return pts;
    };
    const open = decode(buildVegetation({ polys: [park], ext, recipe }).bytes);
    const cleared = decode(buildVegetation({ polys: [park], ext, recipe, routeLines: [[-250, 0, 250, 0]] }).bytes);
    const near = (pts: [number, number][]) => pts.filter(([, y]) => Math.abs(y) < ROUTE_TREE_HALF_M + CHARACTER_DEFAULTS.roadClearM - 0.3).length;
    expect(near(open)).toBeGreaterThan(20);
    expect(near(cleared)).toBe(0);
  });

  it('with a route corridor, the woods along the route keep their share and the rest share what is left', () => {
    const ext = { xMin: -1000, xMax: 1000, yMin: -1000, yMax: 1000 };
    const wood = { kind: 'forest', tags: { natural: 'wood' }, rings: [[-900, -900, 900, -900, 900, 900, -900, 900]] };
    const route = [[-900, 0, 900, 0]];
    const recipe = { seed: 7, maxInstances: 4000, spacingM: { wood: 10 }, corridor: { m: 100, keep: 0.5 } };
    const veg = buildVegetation({ polys: [wood], ext, recipe, routeLines: route });
    expect(veg.count).toBe(4000);
    expect(veg.corridor.kept).toBe(Math.round(veg.corridor.lattice * 0.5));
    expect(veg.corridor.farKept).toBe(4000 - veg.corridor.kept);
    // Far fewer kept per lattice point away from the route than along it.
    expect(veg.corridor.farKept / veg.corridor.farLattice).toBeLessThan(0.25);
    // Uniform thinning (no corridor) keeps the same share everywhere.
    const uniform = buildVegetation({ polys: [wood], ext, recipe: { ...recipe, corridor: undefined }, routeLines: route });
    expect(uniform.count).toBe(4000);
    expect(uniform.corridor).toBeUndefined();
    // Deterministic.
    expect(Buffer.compare(buildVegetation({ polys: [wood], ext, recipe, routeLines: route }).bytes, veg.bytes)).toBe(0);
  });
});

describe('shipped worlds: a loop route meets itself at one height', () => {
  // Every shipped world is baked with closeLoop. Before it, Perugia's Assisi
  // loop stepped 2.2 m in its first 10 m (24 % at 30 m).
  const MAX_JOIN_GRADE = 0.08;
  const recipes = fileURLToPath(new URL('../../../tools/worldbake/worlds', import.meta.url));
  const worlds = readableWorldBundles().filter((b: { id: string }) => existsSync(join(recipes, `${b.id}.json`)));

  it('finds the shipped worlds', () => {
    const ids = worlds.map((b: { id: string }) => b.id);
    expect(ids).toContain('perugia');
    expect(ids).toContain('lugano');
    // A remote world is read once its layers are on disk (fetchPublished.mjs).
    // CI fetches them and requires them; a fresh clone without them skips it.
    if (process.env.VELO_REQUIRE_REMOTE_WORLDS === '1') expect(ids).toContain('chengdu-luxelakes');
  });

  for (const { id, dir } of worlds as { id: string; dir: string }[]) {
    it(`${id}: no step steeper than ${MAX_JOIN_GRADE * 100} % where a loop closes`, () => {
      const recipe = JSON.parse(readFileSync(join(recipes, `${id}.json`), 'utf8'));
      const world = loadBakedWorld(dir, recipe);
      const stepped: string[] = [];
      for (const r of world.routes as { id: string; s: number[]; x: number[]; y: number[]; h: number[] }[]) {
        const n = r.s.length;
        if (Math.hypot(r.x[0] - r.x[n - 1], r.y[0] - r.y[n - 1]) > recipe.snap.stepM) continue;
        let worst = 0;
        for (const i of [1, 2, 3, n - 3, n - 2, n - 1]) worst = Math.max(worst, Math.abs(r.h[i] - r.h[i - 1]) / (r.s[i] - r.s[i - 1]));
        if (worst > MAX_JOIN_GRADE) stepped.push(r.id);
      }
      expect(stepped).toEqual([]);
    });
  }
});
