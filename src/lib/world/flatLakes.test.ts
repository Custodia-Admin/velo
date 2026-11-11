import { describe, expect, it } from 'vitest';

import { flattenLakes, relevelLakes, routeCoreNodes, shoreLevel } from '../../../tools/worldbake/flatLakes.mjs';

const cell = 10;
const grid = { cols: 41, rows: 41, cellSize: cell, xMin: -200, yMax: 200 };
const dm = (pts: [number, number][]) => pts.flatMap(([x, y]) => [x * 10, y * 10]);
/** A square lake 100 m a side round the origin, with an optional square island. */
const square = (h: number) => dm([[-h, -h], [h, -h], [h, h], [-h, h]]);
const lakeLayer = (rings: number[][], k = 0) => ({ areaKinds: ['lake', 'river', 'pond'], areas: [{ k, r: rings }] });
const node = (c: number, r: number) => [grid.xMin + c * cell, grid.yMax - r * cell] as const;

/** Terrain rising 0.2 m per metre to the east: the pre-lake hillside. */
function slope() {
  const h = new Float64Array(grid.cols * grid.rows);
  for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) h[r * grid.cols + c] = 500 + 0.2 * node(c, r)[0];
  return h;
}

describe('flatLakes: standing water newer than the DEM', () => {
  it('levels the lake at the lowest point of its shore, and only lowers the land round it', () => {
    const h = slope();
    const before = Float64Array.from(h);
    const water = lakeLayer([square(50)]);
    const level = shoreLevel(grid, h, [[[-50, -50], [50, -50], [50, 50], [-50, 50]]]);
    expect(level).toBeCloseTo(490, 6); // the west shore, x = −50
    const [lake] = flattenLakes({ grid, heights: h, water }).lakes;
    expect(lake).toMatchObject({ kind: 'lake', level: 490 });
    expect(lake.before.max - lake.before.min).toBeGreaterThan(15); // the hillside under the lake
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        const [x, y] = node(c, r);
        const i = r * grid.cols + c;
        const d = Math.hypot(Math.max(0, Math.abs(x) - 50), Math.max(0, Math.abs(y) - 50)); // to the square, outside
        if (Math.abs(x) < 50 && Math.abs(y) < 50) expect(h[i], `inside ${x},${y}`).toBe(490);
        else if (d <= cell) expect(h[i], `beach ${x},${y}`).toBeLessThanOrEqual(490);
        // Never raised; banks no steeper than 1:2 beyond the beach.
        expect(h[i]).toBeLessThanOrEqual(before[i]);
        if (d > cell) expect(h[i], `bank ${x},${y}`).toBeLessThanOrEqual(490 + 0.5 * (d - cell) + 1e-9);
      }
    }
    // Far land and the low west side keep the DEM.
    expect(h[20 * grid.cols + 0]).toBe(before[20 * grid.cols + 0]);
    expect(h[0]).toBe(before[0]);
  });

  it('keeps an island as land, banked down to the water like the shore', () => {
    const h = slope();
    const water = lakeLayer([square(80), square(20)]);
    flattenLakes({ grid, heights: h, water });
    const at = (x: number, y: number) => h[((grid.yMax - y) / cell) * grid.cols + (x - grid.xMin) / cell];
    const level = 500 + 0.2 * -80;
    expect(at(-50, 0)).toBe(level);
    expect(at(50, 50)).toBe(level);
    // The island's middle stays above the water but no higher than its bank allows.
    expect(at(0, 0)).toBeGreaterThan(level);
    expect(at(0, 0)).toBeLessThanOrEqual(level + 0.5 * (20 - cell));
  });

  it('keeps terraced ponds at their own levels, whatever the order', () => {
    for (const order of [0, 1]) {
      const h = slope();
      const west = dm([[-150, -30], [-90, -30], [-90, 30], [-150, 30]]);
      const east = dm([[-70, -30], [-10, -30], [-10, 30], [-70, 30]]);
      const areas = [{ k: 2, r: [west] }, { k: 2, r: [east] }];
      const { lakes } = flattenLakes({ grid, heights: h, water: { areaKinds: ['lake', 'river', 'pond'], areas: order ? areas.reverse() : areas } });
      const level = (x: number) => h[(grid.yMax - 0) / cell * grid.cols + (x - grid.xMin) / cell];
      expect(level(-120), `order ${order}`).toBe(500 + 0.2 * -150);
      expect(level(-40), `order ${order}`).toBe(500 + 0.2 * -70);
      expect(lakes.map((l) => l.level).sort()).toEqual([470, 486]);
    }
  });

  it('re-levels a lake after the route carve, except the route core', () => {
    const h = slope();
    const { lakes } = flattenLakes({ grid, heights: h, water: lakeLayer([square(50)]) });
    // A route along y = 40 inside the lake's north edge (a causeway), carved 3 m up with a falloff.
    const route = [{ x: [-60, 60], y: [40, 40] }];
    for (const i of lakes[0].nodes) h[i] += 3;
    const core = routeCoreNodes(grid, route, 5);
    expect(relevelLakes({ heights: h, lakes, keep: (i) => core.has(i) })).toBeGreaterThan(0);
    const at = (x: number, y: number) => h[((grid.yMax - y) / cell) * grid.cols + (x - grid.xMin) / cell];
    expect(at(0, 40)).toBe(493); // the causeway keeps the carve
    expect(at(0, 30)).toBe(490); // 10 m off it the lake is level again
    expect(at(0, 0)).toBe(490);
  });

  it('leaves rivers on the DEM (they fall along their course)', () => {
    const h = slope();
    const before = Float64Array.from(h);
    expect(flattenLakes({ grid, heights: h, water: lakeLayer([square(50)], 1) })).toEqual({ lakes: [], changedNodes: 0 });
    expect(h).toEqual(before);
  });
});
