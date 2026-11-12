/**
 * Water tessellation (waterMesh.ts): every triangle edge ≤ WATER_EDGE_M, the
 * polygons' area kept, and a triangle count that grows with the water's area
 * and shoreline, not with earcut's slivers. Pinned on the shipped bundles:
 * the 4-way midpoint split made Lugano 5.19 M water triangles (415 MB of
 * vertex buffers, half the frame rate).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { readableWorldBundles, worldBundles } from '../../../tools/worldbake/worldBundles.mjs';

import { Heightfield } from '@/lib/world/heightfield';
import { loadWorld, type LoadedWorld, type WaterLayer } from '@/lib/world/loadWorld';
import { buildWaterGeometry, lakeLevel, levelLakes, LEVEL_LAKE_MIN_NODES, LEVEL_LAKE_TOL_M, ROUTE_DRY_CELLS, tessellateWaterPolygon, WATER_EDGE_M, waterDepression } from './waterMesh';

/** Float32 positions of ~10 km coordinates round to ~1 mm. */
const EPS_M = 0.01;

const area2 = (t: ArrayLike<number>, o = 0) =>
  ((t[o + 2] - t[o]) * (t[o + 5] - t[o + 1]) - (t[o + 4] - t[o]) * (t[o + 3] - t[o + 1])) / 2;

function edgeStats(flat: number[]) {
  let max = 0;
  let area = 0;
  let cw = 0;
  for (let i = 0; i < flat.length; i += 6) {
    for (const [p, q] of [[0, 2], [2, 4], [4, 0]]) max = Math.max(max, Math.hypot(flat[i + p] - flat[i + q], flat[i + p + 1] - flat[i + q + 1]));
    const a = area2(flat, i);
    area += Math.abs(a);
    if (a < 0) cw++;
  }
  return { max, area, cw, count: flat.length / 6 };
}

describe('tessellateWaterPolygon', () => {
  it('cuts a 5 km sliver into a count linear in its length, edges ≤ maxEdge, area kept', () => {
    // An earcut sliver across a lake: 5 km long, 3 m wide at the far end.
    const tri = [0, 0, 5000, 0, 5000, 3];
    const out: number[] = [];
    tessellateWaterPolygon([tri], WATER_EDGE_M, out);
    const s = edgeStats(out);
    expect(s.max).toBeLessThanOrEqual(WATER_EDGE_M + 1e-9);
    expect(s.area).toBeCloseTo(7500, 6);
    expect(s.cw).toBe(0);
    // Four-way splitting gave 4^8 = 65,536 triangles here.
    expect(s.count).toBeLessThan((4 * 5000) / WATER_EDGE_M);
  });

  it('covers a 1 km lake with an island in cell-sized triangles, wound like the input', () => {
    // Earcut triangles of a square 1 km lake minus a 200 m island, clockwise.
    const tris = [
      [0, 0, 0, 1000, 400, 600],
      [0, 0, 400, 600, 400, 400],
      [0, 0, 400, 400, 1000, 0],
      [0, 1000, 1000, 1000, 600, 600],
      [0, 1000, 600, 600, 400, 600],
      [1000, 1000, 1000, 0, 600, 400],
      [1000, 1000, 600, 400, 600, 600],
      [1000, 0, 400, 400, 600, 400],
    ];
    expect(tris.reduce((a, t) => a + area2(t), 0)).toBeCloseTo(-(1e6 - 4e4), 6);
    const out: number[] = [];
    tessellateWaterPolygon(tris, WATER_EDGE_M, out);
    const s = edgeStats(out);
    expect(s.max).toBeLessThanOrEqual(WATER_EDGE_M + 1e-9);
    expect(s.area).toBeCloseTo(1e6 - 4e4, 3);
    expect(s.cw).toBe(s.count);
    const cell = (WATER_EDGE_M * WATER_EDGE_M * Math.sqrt(3)) / 4;
    expect(s.count).toBeLessThan(((1e6 - 4e4) / cell) * 1.25);
    for (let i = 0; i < out.length; i += 2) {
      const inIsland = out[i] > 400 + 1e-6 && out[i] < 600 - 1e-6 && out[i + 1] > 400 + 1e-6 && out[i + 1] < 600 - 1e-6;
      expect(inIsland).toBe(false);
    }
  });
});

/** Every bundle in public/worlds, plus each remote one whose files are on disk (worldBundles.mjs). */
const BUNDLE_DIRS = new Map<string, string>(readableWorldBundles().map((b: { id: string; dir: string }) => [b.id, b.dir]));
const SHIPPED = [...BUNDLE_DIRS.keys()].sort();
/** Every world that ships, remote ones included even before their files are fetched. */
const ALL_WORLDS = worldBundles().map((b: { id: string }) => b.id);

/**
 * Shipped water budgets, triangles (polygons + stream ribbons). Lugano was
 * 5.19 M; Perugia 80 k before, when the 4-way split also over-cut its rivers
 * (edges down to 11 m where 45 m holds). Every bundle under public/worlds
 * needs an entry: a new world fails until its measured count is pinned here.
 */
const BUDGET: Record<string, { max?: number; expected?: number }> = {
  'chengdu-luxelakes': { expected: 36_767 },
  'cleveland-lakefront': { expected: 77_580 },
  lugano: { max: 400_000 },
  'ohio-erie-towpath': { expected: 57_161 },
  perugia: { expected: 26_752 },
};

/**
 * The most triangles a world's water should take, from its own water layer,
 * whatever its budget entry says:
 * - polygons: a lattice cell the water covers whole is one triangle
 *   (≤ area / cell area). A shore cell is its loop's vertices − 2: the
 *   ring's own vertices inside it, two crossing points per lattice line the
 *   shore crosses and the cell's corners under water. The three lattice line
 *   families are h = s·√3/2 apart, so a shore of length L crosses them about
 *   (6/π)·L/h times, and there are about as many shore cells as crossings
 *   (a shore enters and leaves a cell; each crossing bounds two cells): at
 *   most V + 3·(6/π)·L/h triangles over all shore cells.
 * - stream ribbons: two triangles per step of one terrain cell (never more
 *   than s), so ≤ 2·(len / step + 1) per line segment.
 */
function waterCeiling(water: WaterLayer, cellSize: number) {
  const s = WATER_EDGE_M;
  const cellArea = (s * s * Math.sqrt(3)) / 4;
  const h = (s * Math.sqrt(3)) / 2;
  let vertices = 0;
  let shore = 0;
  for (const a of water.areas) {
    for (const r of a.rings) {
      const n = r.length / 2;
      vertices += n;
      for (let i = 0, j = n - 1; i < n; j = i++) shore += Math.hypot(r[2 * i] - r[2 * j], r[2 * i + 1] - r[2 * j + 1]);
    }
  }
  const step = Math.min(s, cellSize);
  let ribbons = 0;
  for (const l of water.lines) {
    const p = l.points;
    for (let i = 0; i + 3 < p.length; i += 2) ribbons += 2 * (Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]) / step + 1);
  }
  return { polygons: polygonArea(water) / cellArea + vertices + (3 * (6 / Math.PI) * shore) / h, ribbons };
}

function polygonArea(water: WaterLayer) {
  let total = 0;
  for (const a of water.areas) {
    a.rings.forEach((r, k) => {
      let s = 0;
      const n = r.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) s += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
      total += (k === 0 ? 1 : -1) * Math.abs(s / 2);
    });
  }
  return total;
}

describe('shipped water budgets', () => {
  it('has an entry for every world that ships, and only for those', () => {
    expect(SHIPPED.length).toBeGreaterThan(0);
    expect(ALL_WORLDS.filter((id: string) => !(id in BUDGET)), 'shipped worlds without a water BUDGET entry').toEqual([]);
    expect(Object.keys(BUDGET).filter((id) => !ALL_WORLDS.includes(id)), 'BUDGET entries for worlds that do not ship').toEqual([]);
  });
});

describe('level lakes are drawn flat; ground standing above them stays dry', () => {
  // 21 × 21 nodes at 10 m, heights in 1/64 m steps from 100 m.
  const spec = { cols: 21, rows: 21, cellSize: 10, xMin: 0, yMax: 200, heightOffset: 100, heightScale: 1 / 64 };
  const field = (h: (x: number, y: number) => number) => {
    const q = new Uint16Array(spec.cols * spec.rows);
    for (let r = 0; r < spec.rows; r++) for (let c = 0; c < spec.cols; c++) q[r * spec.cols + c] = Math.round((h(c * 10, 200 - r * 10) - 100) * 64);
    return new Heightfield(spec, q);
  };
  const lake = (kind: string): WaterLayer => ({
    areas: [{ kind, rings: [new Float32Array([25, 25, 175, 25, 175, 175, 25, 175])] }],
    lines: [],
  });
  // A level lake at 110 m with a route embankment at 118 m crossing it along y = 100.
  const embanked = field((x, y) => (Math.abs(y - 100) <= 10 && x > 20 && x < 180 ? 118 : x > 20 && x < 180 && y > 20 && y < 180 ? 110 : 125));

  it('finds the level most nodes share', () => {
    expect(lakeLevel(lake('lake').areas[0], embanked)).toBe(110);
    expect(lakeLevel(lake('pond').areas[0], embanked)).toBe(110);
    expect(lakeLevel(lake('river').areas[0], embanked)).toBeNull();
    // A lake the DEM left tilted keeps following the terrain.
    expect(lakeLevel(lake('lake').areas[0], field((x) => 100 + x / 10))).toBeNull();
  });

  it('draws the surface flat at the level, even over the embankment', () => {
    const g = buildWaterGeometry(lake('lake'), embanked, WATER_EDGE_M, { levelLakes: true });
    const ys = new Set<number>();
    for (let i = 1; i < g.positions.length; i += 3) ys.add(Math.round(g.positions[i] * 1000) / 1000);
    expect([...ys]).toEqual([110 - 0.5]);
    // A tilted lake still follows the terrain.
    const tilted = buildWaterGeometry(lake('lake'), field((x) => 100 + x / 10), WATER_EDGE_M, { levelLakes: true });
    const ty = [...tilted.positions].filter((_, i) => i % 3 === 1);
    expect(Math.max(...ty) - Math.min(...ty)).toBeGreaterThan(10);
  });

  it('presses down only the level nodes: the embankment stays dry and at its height', () => {
    const bed = waterDepression(lake('lake'), embanked, true);
    const at = (x: number, y: number) => bed[((200 - y) / 10) * spec.cols + x / 10];
    expect(at(50, 50)).toBeGreaterThan(0);
    expect(at(50, 100)).toBe(0);
    expect(at(100, 110)).toBe(0);
    expect(at(100, 150)).toBeGreaterThan(0);
    // Under a tilted lake every node is pressed down, as before.
    const tilted = waterDepression(lake('lake'), field((x) => 100 + x / 10), true);
    expect(tilted[((200 - 100) / 10) * spec.cols + 10]).toBeGreaterThan(0);
  });

  it('never draws a stream or river ribbon on a route\'s core corridor (the waterway passes under its bridge)', () => {
    const flatField = field(() => 110);
    const river: WaterLayer = { areas: [], lines: [{ kind: 'river', width: 15, points: new Float32Array([100, 10, 100, 190]) }] };
    const route = { x: Float64Array.from({ length: 21 }, (_, i) => i * 10), y: new Float64Array(21).fill(100), stepM: 10 };
    const all = buildWaterGeometry(river, flatField);
    const dry = buildWaterGeometry(river, flatField, WATER_EDGE_M, { dryRoutes: [route] });
    const zs = (g: { positions: Float32Array }) => [...g.positions].filter((_, i) => i % 3 === 2).map((z) => -z);
    // Without the route the ribbon runs straight across y = 100.
    expect(zs(all).some((y) => Math.abs(y - 100) < 5)).toBe(true);
    // With it, nothing within the core (1.5 cells) of the route; the rest of the river stays.
    const core = ROUTE_DRY_CELLS * 10;
    expect(Math.min(...zs(dry).map((y) => Math.abs(y - 100)))).toBeGreaterThanOrEqual(core - 10);
    expect(dry.positions.length).toBeGreaterThan(all.positions.length * 0.6);
    expect(dry.positions.length).toBeLessThan(all.positions.length);
    // A river running beside the route, inside its core, is left alone (Perugia's Tiber park).
    const beside: WaterLayer = { areas: [], lines: [{ kind: 'river', width: 15, points: new Float32Array([10, 110, 190, 110]) }] };
    expect(buildWaterGeometry(beside, flatField, WATER_EDGE_M, { dryRoutes: [route] }).positions).toEqual(buildWaterGeometry(beside, flatField).positions);
  });

  it('is off unless the bake levelled the lakes: other worlds keep draped water and a full bed', () => {
    const g = buildWaterGeometry(lake('lake'), embanked, WATER_EDGE_M);
    const ys = [...g.positions].filter((_, i) => i % 3 === 1);
    expect(Math.max(...ys)).toBeGreaterThan(117);
    expect(waterDepression(lake('lake'), embanked)[((200 - 100) / 10) * spec.cols + 5]).toBeGreaterThan(0);
    const manifest = (flatLakes?: true) => ({ manifest: { generator: { tool: 't', version: 1, recipeSha256: '', osmDate: '', demSource: '', demTiles: 1, ...(flatLakes ? { flatLakes } : {}) } } }) as Parameters<typeof levelLakes>[0];
    expect(levelLakes(manifest(true))).toBe(true);
    expect(levelLakes(manifest())).toBe(false);
  });
});

describe.each(SHIPPED)('shipped world %s water mesh', (id) => {
  let world: LoadedWorld;
  beforeAll(async () => {
    const dir = BUNDLE_DIRS.get(id)!;
    world = await loadWorld(`/worlds/${id}/`, {
      fetch: async (url: string) => new Response(readFileSync(join(dir, url.replace(/^.*\//, ''))), { status: 200 }),
    });
  }, 60_000);

  it('stays within its triangle budget, every edge ≤ WATER_EDGE_M, the lakes whole', () => {
    const data = buildWaterGeometry(world.water, world.heightfield, WATER_EDGE_M);
    const tris = data.positions.length / 9;
    let polygons = 0;
    for (let i = 0; i < data.kinds.length; i += 3) if (data.kinds[i] === 1) polygons++;
    const ceiling = waterCeiling(world.water, world.heightfield.spec.cellSize);
    expect(polygons, `${id} polygon triangles`).toBeLessThanOrEqual(ceiling.polygons);
    expect(tris - polygons, `${id} stream ribbon triangles`).toBeLessThanOrEqual(ceiling.ribbons);
    const b: { max?: number; expected?: number } | undefined = BUDGET[id];
    expect(b, `${id} has no water BUDGET entry: it draws ${tris} triangles, pin that as { expected: ${tris} }`).toBeDefined();
    if (b?.max !== undefined) expect(tris).toBeLessThanOrEqual(b.max);
    if (b?.expected !== undefined) {
      expect(tris).toBeGreaterThanOrEqual(b.expected * 0.9);
      expect(tris).toBeLessThanOrEqual(b.expected * 1.1);
    }
    const P = data.positions;
    let maxEdge = 0;
    let polyArea = 0;
    for (let i = 0; i < P.length; i += 9) {
      for (const [p, q] of [[0, 3], [3, 6], [6, 0]]) {
        maxEdge = Math.max(maxEdge, Math.hypot(P[i + p] - P[i + q], P[i + p + 2] - P[i + q + 2]));
      }
      // Polygon triangles (kind 1), in plan: x and −z.
      if (data.kinds[i / 3] === 1) {
        polyArea += Math.abs(area2([P[i], -P[i + 2], P[i + 3], -P[i + 5], P[i + 6], -P[i + 8]]));
      }
    }
    expect(maxEdge).toBeLessThanOrEqual(WATER_EDGE_M + EPS_M);
    // The tessellation neither drops water nor doubles it.
    expect(polyArea / polygonArea(world.water)).toBeGreaterThan(0.995);
    expect(polyArea / polygonArea(world.water)).toBeLessThan(1.005);
    // Only a world baked with flatLakes draws its lakes level.
    expect(levelLakes(world)).toBe(recipeOf(id).flatLakes === true);
  }, 60_000);

  // Lakes dug after the DEM (recipe "flatLakes", tools/worldbake/flatLakes.mjs;
  // Chengdu: Xinglong Lake spanned 456-484 m before the step). Every lake and
  // pond is level apart from the route's carved core where it crosses a lake
  // arm, so the renderer draws each one flat (lakeLevel) and keeps that core
  // dry and undepressed: the rider never rides through draped water.
  const recipe = recipeOf(id);
  it.runIf(recipe.flatLakes === true)('every lake and pond is drawn level; only the route core stands above it, dry', () => {
    const hf = world.heightfield;
    const { cols, cellSize, xMin, yMax } = hf.spec;
    const core = recipe.snap.coreCells * cellSize + 1;
    const nearRoute = (x: number, y: number) =>
      world.routes.some((r) => {
        for (let i = 0; i < r.x.length; i++) if (Math.hypot(r.x[i] - x, r.y[i] - y) <= core + r.stepM / 2) return true;
        return false;
      });
    expect(levelLakes(world)).toBe(true);
    const bed = waterDepression(world.water, hf, true);
    let level = 0;
    let dryCore = 0;
    for (const area of world.water.areas) {
      if (area.kind !== 'lake' && area.kind !== 'pond') continue;
      const rings = area.rings.map((r) => {
        const out: [number, number][] = [];
        for (let i = 0; i < r.length; i += 2) out.push([r[i], r[i + 1]]);
        return out;
      });
      const nodes: [number, number, number][] = [];
      const [x0, x1] = [Math.min(...rings[0].map((p) => p[0])), Math.max(...rings[0].map((p) => p[0]))];
      const [y0, y1] = [Math.min(...rings[0].map((p) => p[1])), Math.max(...rings[0].map((p) => p[1]))];
      for (let row = Math.max(0, Math.floor((yMax - y1) / cellSize)); row <= Math.ceil((yMax - y0) / cellSize); row++) {
        for (let c = Math.max(0, Math.floor((x0 - xMin) / cellSize)); c <= Math.min(cols - 1, Math.ceil((x1 - xMin) / cellSize)); c++) {
          const x = xMin + c * cellSize;
          const y = yMax - row * cellSize;
          if (insideRings(x, y, rings)) nodes.push([c, row, hf.nodeHeight(c, row)]);
        }
      }
      if (nodes.length < LEVEL_LAKE_MIN_NODES) continue;
      const at = lakeLevel(area, hf);
      expect(at, `${id} lake at ${rings[0][0].map(Math.round).join(',')} is not level`).not.toBeNull();
      level++;
      for (const [c, row, h] of nodes) {
        if (h <= at! + LEVEL_LAKE_TOL_M) continue;
        const x = xMin + c * cellSize;
        const y = yMax - row * cellSize;
        expect(nearRoute(x, y), `${id}: node ${x},${y} stands ${(h - at!).toFixed(1)} m above its lake, away from every route`).toBe(true);
        expect(bed[row * cols + c], `${id}: the dry route core at ${x},${y} is pressed down`).toBe(0);
        dryCore++;
      }
    }
    expect(level).toBeGreaterThan(100);
    // The routes cross lake arms in a few places (Chengdu: 5); their core stays dry.
    expect(dryCore).toBeGreaterThan(0);
  });
});

function recipeOf(id: string) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../../tools/worldbake/worlds/${id}.json`, import.meta.url)), 'utf8'));
}

function insideRings(x: number, y: number, rings: [number, number][][]): boolean {
  let c = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}
