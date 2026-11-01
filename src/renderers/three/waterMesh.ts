/**
 * Water surfaces for the world renderer (geometry only): lake/river/pond
 * polygons triangulated with their holes and subdivided to ≤ `maxEdgeM`
 * edges so the surface follows the valley's fall; waterways without a
 * polygon become ribbons. The terrain under water polygons is pressed down
 * (`waterDepression`) so the river has a bed and banks, and bridges keep
 * their clearance.
 */

import * as THREE from 'three';

import type { Heightfield } from '@/lib/world/heightfield';
import type { WaterLayer } from '@/lib/world/loadWorld';

/** Water surface below the (undepressed) ground, metres. */
export const WATER_SURFACE_DROP_M = 0.5;
/** How far terrain nodes inside water are pressed down, metres. */
export const WATER_BED_DEPTH_M = 2.6;

export interface WaterGeometryData {
  positions: Float32Array;
  /** 1 for polygons (lakes/rivers), 0.5 for line ribbons (streams). */
  kinds: Float32Array;
}

type V2 = [number, number];

/** Split triangles until every edge is ≤ maxEdge (midpoint subdivision, 4-way). */
function subdivide(a: V2, b: V2, c: V2, maxEdge: number, out: V2[], depth = 0): void {
  const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
  if (Math.max(ab, bc, ca) <= maxEdge || depth > 7) {
    out.push(a, b, c);
    return;
  }
  const m = (p: V2, q: V2): V2 => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const mab = m(a, b);
  const mbc = m(b, c);
  const mca = m(c, a);
  subdivide(a, mab, mca, maxEdge, out, depth + 1);
  subdivide(mab, b, mbc, maxEdge, out, depth + 1);
  subdivide(mca, mbc, c, maxEdge, out, depth + 1);
  subdivide(mab, mbc, mca, maxEdge, out, depth + 1);
}

function ringPoints(r: Float32Array): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i + 1 < r.length; i += 2) pts.push(new THREE.Vector2(r[i], r[i + 1]));
  return pts;
}

/** All water as one triangle soup in three.js coordinates (x, h, −y). */
export function buildWaterGeometry(water: WaterLayer, hf: Heightfield, maxEdgeM = 12): WaterGeometryData {
  const P: number[] = [];
  const K: number[] = [];
  const put = (p: V2, lift: number, kind: number) => {
    P.push(p[0], hf.sampleHeight(p[0], p[1]) - WATER_SURFACE_DROP_M + lift, -p[1]);
    K.push(kind);
  };
  for (const area of water.areas) {
    if (!area.rings.length) continue;
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
    for (const t of tris) {
      const soup: V2[] = [];
      subdivide([all[t[0]].x, all[t[0]].y], [all[t[1]].x, all[t[1]].y], [all[t[2]].x, all[t[2]].y], maxEdgeM, soup);
      for (const p of soup) put(p, 0, 1);
    }
  }
  // Streams and rivers without polygons: flat ribbons following the terrain.
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
      const steps = Math.max(1, Math.ceil(len / 8));
      const nx = (-(by - ay) / len) * hw;
      const ny = ((bx - ax) / len) * hw;
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps;
        const t1 = (s + 1) / steps;
        const x0 = ax + (bx - ax) * t0;
        const y0 = ay + (by - ay) * t0;
        const x1 = ax + (bx - ax) * t1;
        const y1 = ay + (by - ay) * t1;
        const l0: V2 = [x0 + nx, y0 + ny];
        const r0: V2 = [x0 - nx, y0 - ny];
        const l1: V2 = [x1 + nx, y1 + ny];
        const r1: V2 = [x1 - nx, y1 - ny];
        // Streams sit just above the ground (no carved bed under a 2 m stream).
        for (const q of [l0, r0, r1, l0, r1, l1]) put(q, WATER_SURFACE_DROP_M + 0.06, 0.5);
      }
    }
  }
  return { positions: new Float32Array(P), kinds: new Float32Array(K) };
}

/**
 * Per-node depression of the terrain under water polygons (metres, ≥ 0),
 * cols × rows like the heightfield. Scanline fill at node centres.
 */
export function waterDepression(water: WaterLayer, hf: Heightfield): Float32Array {
  const { cols, rows, cellSize, xMin, yMax } = hf.spec;
  const out = new Float32Array(cols * rows);
  for (const area of water.areas) {
    if (!area.rings.length) continue;
    let y0 = Infinity;
    let y1 = -Infinity;
    const outer = area.rings[0];
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
        for (let c = c0; c <= c1; c++) out[r * cols + c] = WATER_BED_DEPTH_M;
      }
    }
  }
  return out;
}
