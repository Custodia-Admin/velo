/**
 * Water surfaces for the world renderer (geometry only): lake/river/pond
 * polygons triangulated with their holes and cut to ≤ `maxEdgeM` edges so
 * the surface follows the valley's fall; waterways without a polygon become
 * ribbons with a vertex every terrain cell. The terrain under water polygons
 * is pressed down (`waterDepression`) so the river has a bed and banks, and
 * bridges keep their clearance.
 *
 * In a world baked with `flatLakes` (manifest `generator.flatLakes`), a lake
 * or pond whose terrain is level (`lakeLevel`) is drawn flat at that level
 * instead, and only its level nodes are pressed down. Ground inside the
 * polygon that stands above the level (the carved embankment of a route
 * crossing a lake arm on a bridge, a causeway, an island) stays dry and
 * undepressed, so the rider never rides through a draped sheet of water.
 *
 * The sea (water areas of kind `sea`, coast worlds) is always drawn level:
 * the bake sets every node under it to sea level (tools/worldbake/coast.mjs).
 * Its vertices carry their distance to the coast (`shore`) for the surf, and
 * `seaApron` carries the sea on past the world's edge to the far plane.
 */

import * as THREE from 'three';

import type { Heightfield } from '@/lib/world/heightfield';
import type { LoadedWorld, WaterLayer, WorldArea, WorldRoute } from '@/lib/world/loadWorld';

/** Water surface below the (undepressed) ground, metres. */
export const WATER_SURFACE_DROP_M = 0.5;
/** How far terrain nodes inside water are pressed down, metres. */
export const WATER_BED_DEPTH_M = 2.6;
/** Longest water triangle edge: enough to follow a river's fall, cheap on triangles. */
export const WATER_EDGE_M = 45;
/** Area kind of the sea (coast worlds). */
export const SEA_KIND = 'sea';
/** `kinds` value of sea vertices (lakes and rivers 1, stream ribbons 0.5). */
export const SEA_VERTEX_KIND = 2;
/** `shore` beyond this many metres from the coast (and on every non-sea vertex). */
export const SHORE_FAR_M = 160;

/** Whether the bake levelled this world's lakes (recipe `flatLakes`), so the renderer may draw them level. */
export function levelLakes(world: Pick<LoadedWorld, 'manifest'>): boolean {
  // Hand-built test worlds may carry a partial manifest.
  return world.manifest?.generator?.flatLakes === true;
}

/**
 * Half-width of the ground a baked route stands on, in terrain cells: the
 * bake carves the route's core corridor `snap.coreCells` (1.5 in every
 * recipe) wide each side. Where a stream or river crosses the route (under
 * its bridge) the ribbon is left out there, or it would be painted across the
 * road (Chengdu, Xinglong loop at 1.1, 4.5 and 5.4 km).
 */
export const ROUTE_DRY_CELLS = 1.5;

/** A lake or pond needs this many nodes before its terrain counts as level (a few-cell pond stays draped). */
export const LEVEL_LAKE_MIN_NODES = 8;
/** Share of its nodes that must hold one height for a lake to count as level. */
export const LEVEL_LAKE_SHARE = 0.5;
/** Nodes within this of the level are the lake's own; higher ones are dry ground inside it. */
export const LEVEL_LAKE_TOL_M = 0.05;

/**
 * The sea's rings for node scans: vertices on the world's edge pushed a
 * metre past it, so the half-open scanline rule doesn't leave the sea's
 * nodes on the north edge out (the bake levels them the same way,
 * tools/worldbake/coast.mjs seaScanRings).
 */
export function seaScanRings(area: WorldArea, hf: Heightfield): WorldArea {
  const { cols, rows, cellSize, xMin, yMax } = hf.spec;
  const xMax = xMin + (cols - 1) * cellSize;
  const yMin = yMax - (rows - 1) * cellSize;
  const out = (v: number, lo: number, hi: number) => (Math.abs(v - lo) < 0.05 ? lo - 1 : Math.abs(v - hi) < 0.05 ? hi + 1 : v);
  return { ...area, rings: area.rings.map((r) => r.map((v, i) => (i % 2 === 0 ? out(v, xMin, xMax) : out(v, yMin, yMax)))) };
}

/** Visit every heightfield node inside `area` (holes excluded), scanline at node centres; the sea by its pushed-out rings. */
function forNodesInside(area0: WorldArea, hf: Heightfield, visit: (c: number, r: number) => void): void {
  const area = area0.kind === SEA_KIND ? seaScanRings(area0, hf) : area0;
  const { cols, rows, cellSize, xMin, yMax } = hf.spec;
  const outer = area.rings[0];
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 1; i < outer.length; i += 2) {
    y0 = Math.min(y0, outer[i]);
    y1 = Math.max(y1, outer[i]);
  }
  const r0 = Math.max(0, Math.floor((yMax - y1) / cellSize));
  const r1 = Math.min(rows - 1, Math.ceil((yMax - y0) / cellSize));
  for (let r = r0; r <= r1; r++) {
    const y = yMax - r * cellSize;
    const xs: number[] = [];
    for (const ring of area.rings) {
      const n = ring.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = ring[2 * i + 1];
        const yj = ring[2 * j + 1];
        if (yi > y !== yj > y) xs.push(ring[2 * i] + ((y - yi) / (yj - yi)) * (ring[2 * j] - ring[2 * i]));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - xMin) / cellSize));
      const c1 = Math.min(cols - 1, Math.floor((xs[k + 1] - xMin) / cellSize));
      for (let c = c0; c <= c1; c++) visit(c, r);
    }
  }
}

/**
 * The surface height of a lake or pond whose terrain is level: the height
 * most of its nodes share (at least LEVEL_LAKE_SHARE of them, within
 * LEVEL_LAKE_TOL_M, and at least LEVEL_LAKE_MIN_NODES nodes). Null for
 * rivers and for lakes the DEM left tilted, which keep following the terrain.
 * The sea counts too: its nodes are all at sea level.
 */
export function lakeLevel(area: WorldArea, hf: Heightfield): number | null {
  if (area.kind !== 'lake' && area.kind !== 'pond' && area.kind !== SEA_KIND) return null;
  if (!area.rings.length || area.rings[0].length < 6) return null;
  const step = hf.spec.heightScale;
  const counts = new Map<number, number>();
  let n = 0;
  forNodesInside(area, hf, (c, r) => {
    const key = Math.round(hf.nodeHeight(c, r) / step);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    n++;
  });
  if (n < LEVEL_LAKE_MIN_NODES) return null;
  let mode = 0;
  let best = -1;
  for (const [key, count] of counts) {
    if (count > best || (count === best && key < mode)) {
      best = count;
      mode = key;
    }
  }
  const tol = Math.round(LEVEL_LAKE_TOL_M / step);
  let near = 0;
  for (const [key, count] of counts) if (Math.abs(key - mode) <= tol) near += count;
  return near >= LEVEL_LAKE_SHARE * n ? mode * step : null;
}

export interface WaterGeometryData {
  positions: Float32Array;
  /** 1 for polygons (lakes/rivers), 0.5 for line ribbons (streams), SEA_VERTEX_KIND for the sea. */
  kinds: Float32Array;
  /** Per vertex: metres to the coast, capped at SHORE_FAR_M (SHORE_FAR_M off the sea). */
  shore: Float32Array;
}

/** Whether an area is drawn level: every sea, and with `levelLakes` every level lake. */
function areaLevel(area: WorldArea, hf: Heightfield, levelLakes: boolean): number | null {
  return levelLakes || area.kind === SEA_KIND ? lakeLevel(area, hf) : null;
}

/**
 * Distance to the coast for points on the sea: the sea rings' segments
 * except those along the world's edge (where the sea runs on, not the land).
 */
export function coastDistance(areas: readonly WorldArea[], hf: Heightfield, far = SHORE_FAR_M): (x: number, y: number) => number {
  const { xMin, yMax, cellSize, cols, rows } = hf.spec;
  const xMax = xMin + (cols - 1) * cellSize;
  const yMin = yMax - (rows - 1) * cellSize;
  const onEdge = (ax: number, ay: number, bx: number, by: number) =>
    (Math.abs(ax - xMin) < 0.5 && Math.abs(bx - xMin) < 0.5) ||
    (Math.abs(ax - xMax) < 0.5 && Math.abs(bx - xMax) < 0.5) ||
    (Math.abs(ay - yMin) < 0.5 && Math.abs(by - yMin) < 0.5) ||
    (Math.abs(ay - yMax) < 0.5 && Math.abs(by - yMax) < 0.5);
  const cell = far;
  const key = (cx: number, cy: number) => cx * 100003 + cy;
  const grid = new Map<number, number[]>();
  for (const area of areas) {
    if (area.kind !== SEA_KIND) continue;
    for (const ring of area.rings) {
      const n = ring.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ax = ring[2 * j], ay = ring[2 * j + 1], bx = ring[2 * i], by = ring[2 * i + 1];
        if (onEdge(ax, ay, bx, by)) continue;
        const c0 = Math.floor(Math.min(ax, bx) / cell), c1 = Math.floor(Math.max(ax, bx) / cell);
        const r0 = Math.floor(Math.min(ay, by) / cell), r1 = Math.floor(Math.max(ay, by) / cell);
        for (let cx = c0; cx <= c1; cx++) {
          for (let cy = r0; cy <= r1; cy++) {
            const list = grid.get(key(cx, cy));
            if (list) list.push(ax, ay, bx, by);
            else grid.set(key(cx, cy), [ax, ay, bx, by]);
          }
        }
      }
    }
  }
  return (x, y) => {
    let best = far;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = grid.get(key(cx + dx, cy + dy));
        if (!list) continue;
        for (let i = 0; i < list.length; i += 4) {
          const ax = list[i], ay = list[i + 1], ex = list[i + 2] - ax, ey = list[i + 3] - ay;
          const l2 = ex * ex + ey * ey;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2)) : 0;
          const d = Math.hypot(x - ax - t * ex, y - ay - t * ey);
          if (d < best) best = d;
        }
      }
    }
    return best;
  };
}

type V2 = [number, number];

/**
 * Clip a convex polygon (flat x, y list) to the half-plane a·x + b·y ≤ c
 * (Sutherland–Hodgman). Keeps the winding.
 */
function clipHalf(poly: number[], a: number, b: number, c: number): number[] {
  const out: number[] = [];
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const px = poly[2 * i];
    const py = poly[2 * i + 1];
    const qx = poly[2 * j];
    const qy = poly[2 * j + 1];
    const dp = a * px + b * py - c;
    const dq = a * qx + b * qy - c;
    if (dp <= 0) out.push(px, py);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const t = dp / (dp - dq);
      out.push(px + (qx - px) * t, py + (qy - py) * t);
    }
  }
  return out;
}

/** Signed area of a flat x, y polygon (positive = counter-clockwise). */
function signedArea(poly: number[]): number {
  const n = poly.length / 2;
  if (n < 3) return 0;
  // Relative to the first vertex: world coordinates are ~10 km, pieces ~10 m.
  const x0 = poly[0];
  const y0 = poly[1];
  let s = 0;
  for (let i = 1; i + 1 < n; i++) {
    s += (poly[2 * i] - x0) * (poly[2 * i + 3] - y0) - (poly[2 * i + 2] - x0) * (poly[2 * i + 1] - y0);
  }
  return s / 2;
}

const K3 = 1 / Math.sqrt(3);
/** Lattice rows are a few thousand at most; keys pack (row, cell) into one number. */
const KEY_ROW = 1 << 22;
const KEY_BIAS = 1 << 21;

/**
 * Visit the pieces of a triangle cut by a lattice of equilateral triangles
 * with side `s` (rows of height s·√3/2, every other row shifted by s/2).
 * Each piece is convex and lies inside one lattice cell, so no edge of it is
 * longer than `s`. `visit(key, piece, corners)` gets the cell key, the piece
 * (flat x, y, same winding as the triangle) and the cell's corners (CCW).
 */
function forEachLatticePiece(
  tri: number[],
  s: number,
  visit: (key: number, piece: number[], corners: number[]) => void,
): void {
  const h = (s * Math.sqrt(3)) / 2;
  const ys = [tri[1], tri[3], tri[5]];
  const r0 = Math.floor(Math.min(...ys) / h);
  const r1 = Math.floor(Math.max(...ys) / h);
  for (let r = r0; r <= r1; r++) {
    const y0 = r * h;
    const y1 = y0 + h;
    let strip = clipHalf(tri, 0, -1, -y0);
    if (strip.length < 6) continue;
    strip = clipHalf(strip, 0, 1, y1);
    if (strip.length < 6) continue;
    const o = (((r % 2) + 2) % 2) * (s / 2);
    // u = x − (y − y0)/√3 − o and v = x + (y − y0)/√3 − o: rising and
    // falling lattice lines are u = i·s and v = i·s.
    let uMin = Infinity;
    let vMax = -Infinity;
    for (let k = 0; k < strip.length; k += 2) {
      const dy = (strip[k + 1] - y0) * K3;
      uMin = Math.min(uMin, strip[k] - dy - o);
      vMax = Math.max(vMax, strip[k] + dy - o);
    }
    const iMin = Math.floor(uMin / s) - 1;
    const iMax = Math.floor(vMax / s);
    for (let i = iMin; i <= iMax; i++) {
      const xi = o + i * s;
      // Up cell i: u ≥ i·s and v ≤ (i+1)·s.
      let up = clipHalf(strip, -1, K3, K3 * y0 - xi);
      if (up.length >= 6) up = clipHalf(up, 1, K3, xi + s + K3 * y0);
      if (up.length >= 6) visit((r + KEY_BIAS) * KEY_ROW + 2 * i + KEY_BIAS, up, [xi, y0, xi + s, y0, xi + s / 2, y1]);
      // Down cell i: v ≥ (i+1)·s and u ≤ (i+1)·s.
      let down = clipHalf(strip, -1, -K3, -(xi + s + K3 * y0));
      if (down.length >= 6) down = clipHalf(down, 1, -K3, xi + s - K3 * y0);
      if (down.length >= 6) {
        visit((r + KEY_BIAS) * KEY_ROW + 2 * i + 1 + KEY_BIAS, down, [xi + s, y0, xi + 1.5 * s, y1, xi + s / 2, y1]);
      }
    }
  }
}

/**
 * The union of the convex pieces a polygon leaves in one lattice cell
 * (polygon ∩ cell), triangulated: edges two pieces share cancel, the rest
 * chain into the boundary loops, and earcut fills them. Every vertex lies in
 * the cell, so no edge is longer than its side. `null` when the pieces don't
 * chain into clean loops or the triangles miss area; the caller then keeps
 * the pieces.
 */
function mergeCellPieces(pieces: number[][], sign: number): number[] | null {
  // Vertices snapped to 0.1 mm: two pieces computed the same crossing
  // point with different rounding. A cell holds a few dozen edges, so plain
  // arrays and linear search beat hashing.
  const vx: number[] = [];
  const vy: number[] = [];
  const sx: number[] = [];
  const sy: number[] = [];
  const vertex = (x: number, y: number) => {
    const kx = Math.round(x * 1e4);
    const ky = Math.round(y * 1e4);
    for (let i = 0; i < sx.length; i++) if (sx[i] === kx && sy[i] === ky) return i;
    vx.push(x);
    vy.push(y);
    sx.push(kx);
    sy.push(ky);
    return sx.length - 1;
  };
  // Directed edges; an edge met in both directions is interior and cancels.
  const ea: number[] = [];
  const eb: number[] = [];
  let pieceArea = 0;
  for (const p of pieces) {
    pieceArea += Math.abs(signedArea(p));
    const n = p.length / 2;
    const first = vertex(p[0], p[1]);
    let prev = first;
    for (let i = 1; i <= n; i++) {
      const cur = i === n ? first : vertex(p[2 * i], p[2 * i + 1]);
      if (cur === prev) continue;
      let k = 0;
      while (k < ea.length && !(ea[k] === cur && eb[k] === prev)) k++;
      if (k < ea.length) {
        ea[k] = ea[ea.length - 1];
        eb[k] = eb[eb.length - 1];
        ea.pop();
        eb.pop();
      } else {
        ea.push(prev);
        eb.push(cur);
      }
      prev = cur;
    }
  }
  const used = new Uint8Array(ea.length);
  const loops: { pts: THREE.Vector2[]; area: number }[] = [];
  for (let e0 = 0; e0 < ea.length; e0++) {
    if (used[e0]) continue;
    const pts: THREE.Vector2[] = [];
    let e = e0;
    for (;;) {
      used[e] = 1;
      pts.push(new THREE.Vector2(vx[ea[e]], vy[ea[e]]));
      const end = eb[e];
      if (end === ea[e0]) break;
      let k = 0;
      while (k < ea.length && (used[k] || ea[k] !== end)) k++;
      if (k === ea.length) return null;
      e = k;
    }
    // Drop the points where cancelled edges met the loop on a straight run
    // (the cell's sides): the neighbour cell drops the same ones.
    for (let i = 0; pts.length > 3 && i < pts.length; ) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const ux = b.x - a.x;
      const uy = b.y - a.y;
      const wx = c.x - b.x;
      const wy = c.y - b.y;
      if (Math.abs(ux * wy - uy * wx) <= 1e-9 * Math.hypot(ux, uy) * Math.hypot(wx, wy) && ux * wx + uy * wy > 0) pts.splice(i, 1);
      else i++;
    }
    if (pts.length < 3) return null;
    const flat = pts.flatMap((q) => [q.x, q.y]);
    loops.push({ pts, area: signedArea(flat) });
  }
  const outers = loops.filter((l) => l.area * sign > 0);
  const holes = loops.filter((l) => l.area * sign < 0);
  const contains = (ring: THREE.Vector2[], q: THREE.Vector2) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a.y > q.y !== b.y > q.y && q.x < a.x + ((q.y - a.y) / (b.y - a.y)) * (b.x - a.x)) inside = !inside;
    }
    return inside;
  };
  const out: number[] = [];
  let triArea = 0;
  for (const o of outers) {
    const mine = holes.filter((hl) => contains(o.pts, hl.pts[0])).map((hl) => hl.pts);
    const all = [...o.pts, ...mine.flat()];
    let tris: number[][];
    try {
      tris = THREE.ShapeUtils.triangulateShape(o.pts, mine);
    } catch {
      return null;
    }
    for (const t of tris) {
      const a = all[t[0]];
      const b = all[t[1]];
      const c = all[t[2]];
      const tri = [a.x, a.y, b.x, b.y, c.x, c.y];
      const ar = signedArea(tri);
      if (Math.abs(ar) < 1e-6) continue;
      triArea += Math.abs(ar);
      if (ar * sign > 0) out.push(...tri);
      else out.push(a.x, a.y, c.x, c.y, b.x, b.y);
    }
  }
  return Math.abs(triArea - pieceArea) <= 1e-4 * Math.max(1, pieceArea) ? out : null;
}

/**
 * Tessellate a polygon (given as its earcut triangles, flat x, y each) so no
 * triangle edge is longer than `maxEdge`: the triangles are cut by an
 * equilateral lattice of side `maxEdge`. A lattice cell the polygon covers
 * whole becomes one triangle; a shore cell becomes the triangulated part of
 * the polygon inside it. The count therefore grows with the area
 * (≈ area / 0.43·maxEdge²) plus the shoreline, not with the length of the
 * earcut slivers: a 4-way midpoint split turned each km-long sliver across
 * a lake into ~65 k triangles, and longest-edge bisection still into
 * hundreds.
 */
export function tessellateWaterPolygon(tris: number[][], maxEdge: number, out: number[]): void {
  if (!(maxEdge > 0)) throw new Error(`maxEdge must be > 0 (got ${maxEdge})`);
  const cellArea = (maxEdge * maxEdge * Math.sqrt(3)) / 4;
  const covered = new Map<number, number>();
  for (const t of tris) {
    forEachLatticePiece(t, maxEdge, (key, piece) => {
      covered.set(key, (covered.get(key) ?? 0) + signedArea(piece));
    });
  }
  const emitted = new Set<number>();
  const shore = new Map<number, number[][]>();
  for (const t of tris) {
    forEachLatticePiece(t, maxEdge, (key, piece, corners) => {
      const a = covered.get(key)!;
      if (Math.abs(a) >= cellArea * (1 - 1e-6)) {
        if (emitted.has(key)) return;
        emitted.add(key);
        // The whole cell, wound like the polygon's triangles.
        if (a > 0) out.push(corners[0], corners[1], corners[2], corners[3], corners[4], corners[5]);
        else out.push(corners[0], corners[1], corners[4], corners[5], corners[2], corners[3]);
        return;
      }
      const list = shore.get(key);
      if (list) list.push(piece);
      else shore.set(key, [piece]);
    });
  }
  for (const [key, pieces] of shore) {
    const merged = pieces.length > 1 ? mergeCellPieces(pieces, Math.sign(covered.get(key)!)) : null;
    if (merged) {
      for (const v of merged) out.push(v);
      continue;
    }
    // Fan each convex piece, skipping slivers with no area.
    for (const piece of pieces) {
      for (let k = 2; k + 3 < piece.length; k += 2) {
        const tri = [piece[0], piece[1], piece[k], piece[k + 1], piece[k + 2], piece[k + 3]];
        if (Math.abs(signedArea(tri)) < 1e-6) continue;
        for (const v of tri) out.push(v);
      }
    }
  }
}

function ringPoints(r: Float32Array): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i + 1 < r.length; i += 2) pts.push(new THREE.Vector2(r[i], r[i + 1]));
  return pts;
}

/** All water as one triangle soup in three.js coordinates (x, h, −y). */
export interface WaterGeometryOptions {
  /** Draw level lakes flat (`levelLakes(world)`). */
  levelLakes?: boolean;
  /** Baked routes: no waterway ribbon draws on their core corridor where it crosses them. */
  dryRoutes?: readonly Pick<WorldRoute, 'x' | 'y' | 'stepM'>[];
}

type RouteLine = Pick<WorldRoute, 'x' | 'y' | 'stepM'>;

/** Points hashed into square cells, for "any point within r of (x, y)". */
function pointHash(cell: number) {
  const key = (cx: number, cy: number) => cx * 100003 + cy;
  const cells = new Map<number, number[]>();
  return {
    add(x: number, y: number) {
      const k = key(Math.floor(x / cell), Math.floor(y / cell));
      const list = cells.get(k);
      if (list) list.push(x, y);
      else cells.set(k, [x, y]);
    },
    /** Any point within `r` (≤ cell) of (x, y). */
    near(x: number, y: number, r: number): boolean {
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const list = cells.get(key(cx + dx, cy + dy));
          if (!list) continue;
          for (let i = 0; i < list.length; i += 2) if (Math.hypot(list[i] - x, list[i + 1] - y) <= r) return true;
        }
      }
      return false;
    },
  };
}

/** Where segment a–b crosses segment c–d, or null. */
function crossing(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): [number, number] | null {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [ax + t * rx, ay + t * ry] : null;
}

/**
 * A test for "on a route's core corridor, where a waterway crosses it": within
 * ROUTE_DRY_CELLS of the route and within three times that of a point where
 * one of `water.lines` crosses the route. A stream running beside a route
 * (Perugia's Tiber park) is left alone.
 */
function routeCrossingTest(routes: readonly RouteLine[], water: WaterLayer, hf: Heightfield): (x: number, y: number) => boolean {
  if (!routes.length || !water.lines.length) return () => false;
  const radius = ROUTE_DRY_CELLS * hf.spec.cellSize;
  const step = Math.max(...routes.map((r) => r.stepM));
  const reach = radius + step / 2;
  const samples = pointHash(3 * radius + step);
  for (const r of routes) for (let i = 0; i < r.x.length; i++) samples.add(r.x[i], r.y[i]);
  const crossings = pointHash(3 * radius + step);
  let any = false;
  for (const line of water.lines) {
    const p = line.points;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const mx = (p[i] + p[i + 2]) / 2;
      const my = (p[i + 1] + p[i + 3]) / 2;
      const half = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]) / 2;
      // A short segment can only cross the route if its midpoint is near a sample.
      if (half <= 3 * radius && !samples.near(mx, my, half + step)) continue;
      for (const r of routes) {
        for (let k = 0; k + 1 < r.x.length; k++) {
          const c = crossing(p[i], p[i + 1], p[i + 2], p[i + 3], r.x[k], r.y[k], r.x[k + 1], r.y[k + 1]);
          if (c) {
            crossings.add(c[0], c[1]);
            any = true;
          }
        }
      }
    }
  }
  if (!any) return () => false;
  return (x, y) => samples.near(x, y, reach) && crossings.near(x, y, 3 * radius);
}

export function buildWaterGeometry(water: WaterLayer, hf: Heightfield, maxEdgeM = WATER_EDGE_M, opts: WaterGeometryOptions = {}): WaterGeometryData {
  const levelLakes = opts.levelLakes === true;
  const onRoute = routeCrossingTest(opts.dryRoutes ?? [], water, hf);
  const P: number[] = [];
  const K: number[] = [];
  const S: number[] = [];
  const toCoast = water.areas.some((a) => a.kind === SEA_KIND) ? coastDistance(water.areas, hf) : null;
  let level: number | null = null;
  const put = (p: V2, lift: number, kind: number) => {
    P.push(p[0], (level ?? hf.sampleHeight(p[0], p[1])) - WATER_SURFACE_DROP_M + lift, -p[1]);
    K.push(kind);
    S.push(kind === SEA_VERTEX_KIND && toCoast ? toCoast(p[0], p[1]) : SHORE_FAR_M);
  };
  for (const area of water.areas) {
    if (!area.rings.length) continue;
    level = areaLevel(area, hf, levelLakes);
    const outer = ringPoints(area.rings[0]);
    const holes = area.rings.slice(1).map(ringPoints);
    if (outer.length < 3) continue;
    let tris: number[][] = [];
    try {
      tris = THREE.ShapeUtils.triangulateShape(outer, holes);
    } catch {
      continue;
    }
    const all = [...outer, ...holes.flat()];
    const flat: number[] = [];
    tessellateWaterPolygon(
      tris.map((t) => [all[t[0]].x, all[t[0]].y, all[t[1]].x, all[t[1]].y, all[t[2]].x, all[t[2]].y]),
      maxEdgeM,
      flat,
    );
    const kind = area.kind === SEA_KIND ? SEA_VERTEX_KIND : 1;
    for (let i = 0; i < flat.length; i += 2) put([flat[i], flat[i + 1]], 0, kind);
  }
  level = null;
  // Streams and rivers without polygons: flat ribbons following the terrain,
  // a vertex every terrain cell (finer only adds triangles the terrain mesh
  // under them can't show: Lugano has 1,000 km of mountain streams).
  const ribbonStep = Math.min(maxEdgeM, hf.spec.cellSize);
  for (const line of water.lines) {
    const p = line.points;
    const hw = line.width / 2;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i];
      const ay = p[i + 1];
      const bx = p[i + 2];
      const by = p[i + 3];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.1) continue;
      const steps = Math.max(1, Math.ceil(len / ribbonStep));
      const nx = (-(by - ay) / len) * hw;
      const ny = ((bx - ax) / len) * hw;
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps;
        const t1 = (s + 1) / steps;
        const x0 = ax + (bx - ax) * t0;
        const y0 = ay + (by - ay) * t0;
        const x1 = ax + (bx - ax) * t1;
        const y1 = ay + (by - ay) * t1;
        if (onRoute((x0 + x1) / 2, (y0 + y1) / 2)) continue;
        const l0: V2 = [x0 + nx, y0 + ny];
        const r0: V2 = [x0 - nx, y0 - ny];
        const l1: V2 = [x1 + nx, y1 + ny];
        const r1: V2 = [x1 - nx, y1 - ny];
        // Streams sit just above the ground (no carved bed under a 2 m stream).
        for (const q of [l0, r0, r1, l0, r1, l1]) put(q, WATER_SURFACE_DROP_M + 0.06, 0.5);
      }
    }
  }
  return { positions: new Float32Array(P), kinds: new Float32Array(K), shore: new Float32Array(S) };
}

/**
 * The sea past the world's edge, out to `reachM`: one quad outward from every
 * run of the sea's outline along the edge, and a corner square where the sea
 * covers a corner. Level with the sea, so the horizon is water, not sky
 * under the terrain's edge. Empty without a sea.
 */
export function seaApron(water: WaterLayer, hf: Heightfield, reachM: number): WaterGeometryData {
  const { xMin, yMax, cellSize, cols, rows } = hf.spec;
  const xMax = xMin + (cols - 1) * cellSize;
  const yMin = yMax - (rows - 1) * cellSize;
  const P: number[] = [];
  const quad = (x0: number, y0: number, x1: number, y1: number, h: number) => {
    // Counter-clockwise from above in world (x, y): (x0,y0) (x1,y0) (x1,y1) (x0,y1).
    for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y0], [x1, y1], [x0, y1]]) P.push(x, h, -y);
  };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  const corner = { nw: false, ne: false, se: false, sw: false };
  for (const area of water.areas) {
    if (area.kind !== SEA_KIND || !area.rings.length) continue;
    const level = lakeLevel(area, hf);
    const h = (level ?? 0) - WATER_SURFACE_DROP_M;
    const ring = area.rings[0];
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = ring[2 * j], ay = ring[2 * j + 1], bx = ring[2 * i], by = ring[2 * i + 1];
      if (near(ay, yMax) && near(by, yMax)) quad(Math.min(ax, bx), yMax, Math.max(ax, bx), yMax + reachM, h);
      else if (near(ay, yMin) && near(by, yMin)) quad(Math.min(ax, bx), yMin - reachM, Math.max(ax, bx), yMin, h);
      else if (near(ax, xMin) && near(bx, xMin)) quad(xMin - reachM, Math.min(ay, by), xMin, Math.max(ay, by), h);
      else if (near(ax, xMax) && near(bx, xMax)) quad(xMax, Math.min(ay, by), xMax + reachM, Math.max(ay, by), h);
    }
    for (let i = 0; i < n; i++) {
      const x = ring[2 * i], y = ring[2 * i + 1];
      if (near(x, xMin) && near(y, yMax) && !corner.nw) { corner.nw = true; quad(xMin - reachM, yMax, xMin, yMax + reachM, h); }
      if (near(x, xMax) && near(y, yMax) && !corner.ne) { corner.ne = true; quad(xMax, yMax, xMax + reachM, yMax + reachM, h); }
      if (near(x, xMax) && near(y, yMin) && !corner.se) { corner.se = true; quad(xMax, yMin - reachM, xMax + reachM, yMin, h); }
      if (near(x, xMin) && near(y, yMin) && !corner.sw) { corner.sw = true; quad(xMin - reachM, yMin - reachM, xMin, yMin, h); }
    }
  }
  const count = P.length / 3;
  return { positions: new Float32Array(P), kinds: new Float32Array(count).fill(SEA_VERTEX_KIND), shore: new Float32Array(count).fill(SHORE_FAR_M) };
}

/**
 * Per-node depression of the terrain under water polygons (metres, ≥ 0),
 * cols × rows like the heightfield. Scanline fill at node centres. With
 * `levelLakes`, under a level lake (`lakeLevel`) only the nodes at its level
 * are pressed down; under the sea always.
 */
export function waterDepression(water: WaterLayer, hf: Heightfield, levelLakes = false): Float32Array {
  const { cols, rows } = hf.spec;
  const out = new Float32Array(cols * rows);
  for (const area of water.areas) {
    if (!area.rings.length) continue;
    const level = areaLevel(area, hf, levelLakes);
    forNodesInside(area, hf, (c, r) => {
      if (level !== null && hf.nodeHeight(c, r) > level + LEVEL_LAKE_TOL_M) return;
      out[r * cols + c] = WATER_BED_DEPTH_M;
    });
  }
  return out;
}
