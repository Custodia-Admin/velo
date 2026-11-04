/**
 * Water tessellation (waterMesh.ts): every triangle edge ≤ WATER_EDGE_M, the
 * polygons' area kept, and a triangle count that grows with the water's area
 * and shoreline, not with earcut's slivers. Pinned on the shipped bundles:
 * the 4-way midpoint split made Lugano 5.19 M water triangles (415 MB of
 * vertex buffers, half the frame rate).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadWorld, type LoadedWorld, type WaterLayer } from '@/lib/world/loadWorld';
import { buildWaterGeometry, tessellateWaterPolygon, WATER_EDGE_M } from './waterMesh';

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

const WORLDS = fileURLToPath(new URL('../../../public/worlds', import.meta.url));

/**
 * Shipped water budgets, triangles (polygons + stream ribbons). Lugano was
 * 5.19 M; Perugia 80 k before, when the 4-way split also over-cut its rivers
 * (edges down to 11 m where 45 m holds).
 */
const BUDGET: Record<string, { max?: number; expected?: number }> = {
  lugano: { max: 400_000 },
  perugia: { expected: 26_752 },
};

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

describe.each(Object.keys(BUDGET).filter((id) => existsSync(join(WORLDS, id, 'manifest.json'))))('shipped world %s water mesh', (id) => {
  let world: LoadedWorld;
  beforeAll(async () => {
    const dir = join(WORLDS, id);
    world = await loadWorld(`/worlds/${id}/`, {
      fetch: async (url: string) => new Response(readFileSync(join(dir, url.replace(/^.*\//, ''))), { status: 200 }),
    });
  }, 60_000);

  it('stays within its triangle budget, every edge ≤ WATER_EDGE_M, the lakes whole', () => {
    const data = buildWaterGeometry(world.water, world.heightfield, WATER_EDGE_M);
    const tris = data.positions.length / 9;
    const b = BUDGET[id];
    if (b.max !== undefined) expect(tris).toBeLessThanOrEqual(b.max);
    if (b.expected !== undefined) {
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
  }, 60_000);
});
