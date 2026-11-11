// Standing water newer than the DEM. GLO-30 was flown in 2011–2015 and
// flattens the water of that epoch only: a lake dug since (Chengdu's
// Xinglong Lake, Luxe Lakes) still carries the hills it was dug from, and
// the water mesh, which follows the terrain, would draw it as a tilted,
// bulging sheet. With the recipe's `"flatLakes": true` the bake lowers the
// terrain under every OSM lake and pond to one level before the routes are
// carved:
//
// - the level is the lowest point of the area's shore (every ring, sampled
//   every half cell), so the water never stands above the land around it;
// - every node inside the area (islands excluded) is set to that level, and
//   every node within one cell outside it is lowered to it at most (a beach
//   one cell wide, so the shoreline's bilinear samples stay at the level);
// - beyond that the banks are capped at `bankSlope` (rise over run): a node
//   d metres out is lowered to at most level + bankSlope · (d − cell). Land
//   already lower than the cap is never raised.
//
// Rivers keep the DEM: they fall along their course.

import { WATER_AREA_KINDS } from './buildVectors.mjs';

/** Kinds of water areas the step flattens. */
export const FLAT_LAKE_KINDS = ['lake', 'pond'];
export const FLAT_LAKE_BANK_SLOPE = 0.5;

const ringMetres = (ring) => {
  const out = [];
  for (let i = 0; i < ring.length; i += 2) out.push([ring[i] / 10, ring[i + 1] / 10]);
  return out;
};

function inside(x, y, rings) {
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

function distToRings(x, y, rings) {
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j];
      const [bx, by] = ring[i];
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
      if (d < best) best = d;
    }
  }
  return best;
}

function sample(grid, heights, x, y) {
  const { cols, rows, cellSize, xMin, yMax } = grid;
  const fx = Math.min(cols - 1, Math.max(0, (x - xMin) / cellSize));
  const fy = Math.min(rows - 1, Math.max(0, (yMax - y) / cellSize));
  const c = Math.min(cols - 2, Math.floor(fx));
  const r = Math.min(rows - 2, Math.floor(fy));
  const tx = fx - c;
  const ty = fy - r;
  const i = r * cols + c;
  const a = heights[i] + (heights[i + 1] - heights[i]) * tx;
  const b = heights[i + cols] + (heights[i + cols + 1] - heights[i + cols]) * tx;
  return a + (b - a) * ty;
}

/** The lowest point of the rings, sampled every half cell. */
export function shoreLevel(grid, heights, rings) {
  const step = grid.cellSize / 2;
  let min = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j];
      const [bx, by] = ring[i];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
      for (let k = 0; k < n; k++) {
        const h = sample(grid, heights, ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n);
        if (h < min) min = h;
      }
    }
  }
  return min;
}

/**
 * Flatten every lake and pond of `water` (buildWater's layer, decimetres) in
 * `heights` (the float grid, row-major from the north edge), in place, in
 * three passes so the result never depends on area order: every level from
 * the DEM, then every bank cap, then every lake's own nodes to its level
 * (terraced ponds keep their own levels; a neighbour's bank never cuts into
 * them). Returns `lakes`, one entry per flattened area with `nodes` (the
 * indices of its own nodes, for relevelLakes), and `changedNodes`.
 */
export function flattenLakes({ grid, heights, water, bankSlope = FLAT_LAKE_BANK_SLOPE }) {
  const { cols, rows, cellSize, xMin, yMax } = grid;
  const kinds = new Set(FLAT_LAKE_KINDS.map((k) => WATER_AREA_KINDS.indexOf(k)));
  let topH = -Infinity;
  for (const h of heights) if (h > topH) topH = h;
  const lakes = [];
  water.areas.forEach((area, index) => {
    if (!kinds.has(area.k)) return;
    const rings = area.r.map(ringMetres);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of rings[0]) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    lakes.push({ index, kind: WATER_AREA_KINDS[area.k], rings, level: shoreLevel(grid, heights, rings), box: [x0, x1, y0, y1] });
  });
  const cut = new Float64Array(heights.length).fill(Infinity);
  const own = [];
  for (const lake of lakes) {
    const [x0, x1, y0, y1] = lake.box;
    // Beyond this distance the bank cap can't bind: it would exceed every node.
    const reach = cellSize + Math.max(0, topH - lake.level) / bankSlope;
    const c0 = Math.max(0, Math.floor((x0 - reach - xMin) / cellSize));
    const c1 = Math.min(cols - 1, Math.ceil((x1 + reach - xMin) / cellSize));
    const r0 = Math.max(0, Math.floor((yMax - y1 - reach) / cellSize));
    const r1 = Math.min(rows - 1, Math.ceil((yMax - y0 + reach) / cellSize));
    const nodes = [];
    let before = { min: Infinity, max: -Infinity };
    for (let r = r0; r <= r1; r++) {
      const y = yMax - r * cellSize;
      for (let c = c0; c <= c1; c++) {
        const x = xMin + c * cellSize;
        const i = r * cols + c;
        if (inside(x, y, lake.rings)) {
          nodes.push(i);
          before = { min: Math.min(before.min, heights[i]), max: Math.max(before.max, heights[i]) };
          continue;
        }
        const d = distToRings(x, y, lake.rings);
        if (d > reach) continue;
        const cap = lake.level + bankSlope * Math.max(0, d - cellSize);
        if (cap < cut[i]) cut[i] = cap;
      }
    }
    own.push({ lake, nodes: Int32Array.from(nodes), before });
  }
  const changed = new Uint8Array(heights.length);
  const maxCut = new Float64Array(lakes.length);
  for (let i = 0; i < heights.length; i++) {
    if (heights[i] > cut[i]) {
      heights[i] = cut[i];
      changed[i] = 1;
    }
  }
  const out = [];
  own.forEach(({ lake, nodes, before }, k) => {
    for (const i of nodes) {
      if (heights[i] !== lake.level) changed[i] = 1;
      maxCut[k] = Math.max(maxCut[k], before.max - lake.level);
      heights[i] = lake.level;
    }
    if (nodes.length) out.push({ index: lake.index, kind: lake.kind, level: lake.level, inNodes: nodes.length, before, maxCutM: Math.max(0, maxCut[k]), nodes });
  });
  let changedNodes = 0;
  for (const v of changed) changedNodes += v;
  return { lakes: out, changedNodes };
}

/**
 * After the routes are carved: put every lake's own nodes back at its level,
 * except the nodes `keep(i)` names (the route's core corridor, which the
 * rider stands on). The carve's falloff must not lift a pond's edge.
 * Returns the number of nodes re-levelled.
 */
export function relevelLakes({ heights, lakes, keep }) {
  let n = 0;
  for (const lake of lakes) {
    for (const i of lake.nodes) {
      if (heights[i] === lake.level || keep(i)) continue;
      heights[i] = lake.level;
      n++;
    }
  }
  return n;
}

/** Indices of the grid nodes within `core` metres of any carved route polyline (carveRoutes' `prepared`). */
export function routeCoreNodes(grid, prepared, core) {
  const { cols, rows, cellSize, xMin, yMax } = grid;
  const out = new Set();
  for (const p of prepared) {
    for (let k = 0; k + 1 < p.x.length; k++) {
      const ax = p.x[k], ay = p.y[k], bx = p.x[k + 1], by = p.y[k + 1];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - core - xMin) / cellSize));
      const c1 = Math.min(cols - 1, Math.ceil((Math.max(ax, bx) + core - xMin) / cellSize));
      const r0 = Math.max(0, Math.floor((yMax - Math.max(ay, by) - core) / cellSize));
      const r1 = Math.min(rows - 1, Math.ceil((yMax - Math.min(ay, by) + core) / cellSize));
      for (let r = r0; r <= r1; r++) {
        const ny = yMax - r * cellSize;
        for (let c = c0; c <= c1; c++) {
          const nx = xMin + c * cellSize;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((nx - ax) * dx + (ny - ay) * dy) / l2)) : 0;
          if (Math.hypot(ax + dx * t - nx, ay + dy * t - ny) <= core) out.add(r * cols + c);
        }
      }
    }
  }
  return out;
}
