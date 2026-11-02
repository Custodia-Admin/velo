/**
 * Terrain chunk geometry from a world heightfield — pure typed-array math,
 * no three.js, so it is cheap to test and could move to a worker.
 *
 * Mapping (WORLD-FORMAT.md): world (x east, y north, h up) → three.js
 * (x, h, −y). Each chunk's vertices are local to its centre so float32
 * positions stay precise 20 km from the world origin.
 */

import type { ChunkRange, Heightfield } from '@/lib/world/heightfield';

export interface ChunkInfo {
  index: number;
  range: ChunkRange;
  /** Chunk centre in three.js coordinates (x, z); y is 0. */
  centerX: number;
  centerZ: number;
  /** Bounds in three.js x/z. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minH: number;
  maxH: number;
}

export interface ChunkGeometryData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array | Uint32Array;
  /** Grid vertices (before skirts). */
  gridVertices: number;
  /** Columns × rows of the sampled grid. */
  cols: number;
  rows: number;
  step: number;
}

export const CHUNKS_X = 8;
export const CHUNKS_Y = 8;

/** Node indices c0, c0+step, …, always ending on c1 (shared chunk edges). */
export function sampledNodes(n0: number, n1: number, step: number): number[] {
  const s = Math.max(1, Math.floor(step));
  const out: number[] = [];
  for (let n = n0; n < n1; n += s) out.push(n);
  out.push(n1);
  return out;
}

export function planChunks(hf: Heightfield, nx = CHUNKS_X, ny = CHUNKS_Y): ChunkInfo[] {
  return hf.chunks(nx, ny).map((range, index) => {
    const [x0, y0] = hf.nodePosition(range.c0, range.r0);
    const [x1, y1] = hf.nodePosition(range.c1, range.r1);
    let minH = Infinity;
    let maxH = -Infinity;
    for (let r = range.r0; r <= range.r1; r++) {
      for (let c = range.c0; c <= range.c1; c++) {
        const h = hf.nodeHeight(c, r);
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
    // Row 0 is the north edge: y0 > y1, so three z = −y runs −y0 … −y1.
    return {
      index,
      range,
      centerX: (x0 + x1) / 2,
      centerZ: -(y0 + y1) / 2,
      minX: x0,
      maxX: x1,
      minZ: -y0,
      maxZ: -y1,
      minH,
      maxH,
    };
  });
}

/**
 * Triangulate one chunk at `step` nodes per vertex, with skirts of
 * `skirtM` metres hanging from its edges so a neighbour drawn at another
 * step never shows a crack.
 */
export function buildChunkGeometry(
  hf: Heightfield,
  chunk: ChunkInfo,
  step: number,
  skirtM = step * hf.spec.cellSize * 0.6 + 1,
  /** Optional per-node depression (metres, cols × rows), e.g. river beds. */
  depress?: Float32Array,
): ChunkGeometryData {
  const { c0, c1, r0, r1 } = chunk.range;
  const cols = sampledNodes(c0, c1, step);
  const rows = sampledNodes(r0, r1, step);
  const nc = cols.length;
  const nr = rows.length;
  const grid = nc * nr;
  const edge = 2 * (nc - 1) + 2 * (nr - 1);
  const total = grid + edge;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const cs = hf.spec.cellSize;
  const d = Math.max(1, Math.floor(step));

  for (let j = 0; j < nr; j++) {
    const r = rows[j];
    for (let i = 0; i < nc; i++) {
      const c = cols[i];
      const v = (j * nc + i) * 3;
      const [x, y] = hf.nodePosition(c, r);
      positions[v] = x - chunk.centerX;
      positions[v + 1] = hf.nodeHeight(c, r) - (depress ? depress[r * hf.spec.cols + c] : 0);
      positions[v + 2] = -y - chunk.centerZ;
      // Central differences over the sampling step (smooth shading per LOD).
      const dhdx = (hf.nodeHeight(c + d, r) - hf.nodeHeight(c - d, r)) / (2 * d * cs);
      const dhdy = (hf.nodeHeight(c, r - d) - hf.nodeHeight(c, r + d)) / (2 * d * cs);
      // World normal (−dh/dx, −dh/dy, 1) → three (nx, nUp, −nNorth).
      const len = Math.sqrt(dhdx * dhdx + dhdy * dhdy + 1);
      normals[v] = -dhdx / len;
      normals[v + 1] = 1 / len;
      normals[v + 2] = dhdy / len;
    }
  }

  // Edge loop (clockwise around the grid as seen from above), each with a skirt vertex below it.
  const loop: number[] = [];
  for (let i = 0; i < nc - 1; i++) loop.push(i); // north edge, west → east
  for (let j = 0; j < nr - 1; j++) loop.push(j * nc + nc - 1); // east edge, north → south
  for (let i = nc - 1; i > 0; i--) loop.push((nr - 1) * nc + i); // south edge, east → west
  for (let j = nr - 1; j > 0; j--) loop.push(j * nc); // west edge, south → north
  loop.forEach((g, k) => {
    const s = (grid + k) * 3;
    positions[s] = positions[g * 3];
    positions[s + 1] = positions[g * 3 + 1] - skirtM;
    positions[s + 2] = positions[g * 3 + 2];
    normals[s] = normals[g * 3];
    normals[s + 1] = normals[g * 3 + 1];
    normals[s + 2] = normals[g * 3 + 2];
  });

  const triCount = (nc - 1) * (nr - 1) * 2 + edge * 4;
  const indices = total > 65535 ? new Uint32Array(triCount * 3) : new Uint16Array(triCount * 3);
  let t = 0;
  for (let j = 0; j < nr - 1; j++) {
    for (let i = 0; i < nc - 1; i++) {
      const a = j * nc + i;
      const b = a + 1;
      const c = a + nc;
      const e = c + 1;
      // Counter-clockwise seen from above (+y): front faces up.
      indices[t++] = a;
      indices[t++] = c;
      indices[t++] = b;
      indices[t++] = b;
      indices[t++] = c;
      indices[t++] = e;
    }
  }
  // Skirt quads, both windings (seen from either side through a crack).
  for (let k = 0; k < edge; k++) {
    const top0 = loop[k];
    const top1 = loop[(k + 1) % edge];
    const bot0 = grid + k;
    const bot1 = grid + ((k + 1) % edge);
    indices[t++] = top0;
    indices[t++] = bot0;
    indices[t++] = top1;
    indices[t++] = top1;
    indices[t++] = bot0;
    indices[t++] = bot1;
    indices[t++] = top0;
    indices[t++] = top1;
    indices[t++] = bot0;
    indices[t++] = top1;
    indices[t++] = bot1;
    indices[t++] = bot0;
  }
  return { positions, normals, indices, gridVertices: grid, cols: nc, rows: nr, step: d };
}

/** Horizontal distance (three.js x/z) from a point to a chunk's bounds; 0 inside. */
export function distanceToChunk(chunk: ChunkInfo, x: number, z: number): number {
  const dx = x < chunk.minX ? chunk.minX - x : x > chunk.maxX ? x - chunk.maxX : 0;
  const dz = z < chunk.minZ ? chunk.minZ - z : z > chunk.maxZ ? z - chunk.maxZ : 0;
  return Math.sqrt(dx * dx + dz * dz);
}

export type ChunkLod = 'near' | 'far';

/** Hysteresis band so a chunk on the boundary does not flip LOD every frame. */
export const LOD_HYSTERESIS_M = 150;

export function chunkLod(
  chunk: ChunkInfo,
  x: number,
  z: number,
  nearRadiusM: number,
  current?: ChunkLod,
): ChunkLod {
  const dist = distanceToChunk(chunk, x, z);
  if (current === 'near') return dist > nearRadiusM + LOD_HYSTERESIS_M ? 'far' : 'near';
  return dist <= nearRadiusM ? 'near' : 'far';
}

/**
 * Height of the triangulated near-LOD surface at three.js (x, z), the way
 * the GPU draws it (same diagonal split as `buildChunkGeometry`, step 1).
 * Tests compare it with `Heightfield.sampleHeight` to bound the mesh-vs-
 * bilinear gap.
 */
export function meshHeightAt(hf: Heightfield, x: number, z: number): number {
  const { cols, rows, cellSize, xMin, yMax } = hf.spec;
  const y = -z;
  const fx = Math.min(cols - 1, Math.max(0, (x - xMin) / cellSize));
  const fy = Math.min(rows - 1, Math.max(0, (yMax - y) / cellSize));
  const c = Math.min(cols - 2, Math.floor(fx));
  const r = Math.min(rows - 2, Math.floor(fy));
  const tx = fx - c;
  const ty = fy - r;
  const ha = hf.nodeHeight(c, r);
  const hb = hf.nodeHeight(c + 1, r);
  const hc = hf.nodeHeight(c, r + 1);
  const he = hf.nodeHeight(c + 1, r + 1);
  // Diagonal b–c: triangle (a, c, b) when tx + ty ≤ 1, else (b, c, e).
  if (tx + ty <= 1) return ha + (hb - ha) * tx + (hc - ha) * ty;
  return he + (hc - he) * (1 - tx) + (hb - he) * (1 - ty);
}
