/**
 * Tree instances for the world renderer (pure data, no three.js): every
 * vegetation seed of the bundle becomes an instance record (position on the
 * heightfield, rotation, size, kind, seed) with a crown shape picked per kind,
 * binned into square cells so the renderer can gather the trees around the
 * camera into a near ring (detailed meshes) and a far ring (low-poly) by
 * copying contiguous slices, never touching individual trees per frame.
 */

import type { Heightfield } from '@/lib/world/heightfield';
import { VEGETATION_KINDS, type VegetationLayer } from '@/lib/world/loadWorld';

/** Crown shapes; one mesh (per LOD) each. */
export const TREE_SHAPES = ['round', 'column', 'poplar', 'umbrella', 'olive', 'bush', 'cone'] as const;
export type TreeShape = (typeof TREE_SHAPES)[number];
const S = Object.fromEntries(TREE_SHAPES.map((s, i) => [s, i])) as Record<TreeShape, number>;

/** Floats per instance: x, groundY, z, rotation, height, crownRadius, kind, seed (0–1). */
export const TREE_STRIDE = 8;

export const TREE_CELL_M = 128;

/** Species palette index per instance (the shader's colour table), beyond the bundle kinds. */
export const TREE_PALETTE = [
  'oak',
  'conifer',
  'scrub',
  'olive',
  'park',
  'cypress',
  'poplar',
  'hedgerow',
  'garden',
  'willow',
  'stone-pine',
] as const;
const P = Object.fromEntries(TREE_PALETTE.map((s, i) => [s, i])) as Record<(typeof TREE_PALETTE)[number], number>;

interface Species {
  shape: number;
  palette: number;
  /** Height range, metres. */
  h: readonly [number, number];
  /** Crown radius as a share of height. */
  r: number;
}

/** Kind + seed byte → species. Deterministic: the same bundle always grows the same trees. */
export function speciesFor(kind: string, seed: number): Species {
  const u = (seed & 0xff) / 255;
  switch (kind) {
    case 'broadleaf':
      return { shape: S.round, palette: P.oak, h: [9, 15], r: 0.36 };
    case 'conifer':
      return { shape: S.cone, palette: P.conifer, h: [10, 18], r: 0.26 };
    case 'scrub':
      return { shape: S.bush, palette: P.scrub, h: [1.6, 3.4], r: 0.75 };
    case 'olive':
      return { shape: S.olive, palette: P.olive, h: [4, 6.2], r: 0.56 };
    case 'park':
      return u < 0.4
        ? { shape: S.umbrella, palette: P['stone-pine'], h: [11, 16], r: 0.42 }
        : { shape: S.round, palette: P.park, h: [9, 15], r: 0.38 };
    case 'cypress':
      return { shape: S.column, palette: P.cypress, h: [11, 19], r: 0.085 };
    case 'riparian':
      return u < 0.65
        ? { shape: S.poplar, palette: P.poplar, h: [16, 25], r: 0.15 }
        : { shape: S.round, palette: P.willow, h: [8, 13], r: 0.42 };
    case 'hedgerow':
      return u < 0.8
        ? { shape: S.round, palette: P.hedgerow, h: [6, 11], r: 0.38 }
        : { shape: S.bush, palette: P.hedgerow, h: [2, 3.6], r: 0.8 };
    case 'garden':
      if (u < 0.45) return { shape: S.round, palette: P.garden, h: [5, 10], r: 0.38 };
      if (u < 0.7) return { shape: S.column, palette: P.cypress, h: [7, 14], r: 0.09 };
      if (u < 0.9) return { shape: S.olive, palette: P.olive, h: [3.5, 5.5], r: 0.55 };
      return { shape: S.umbrella, palette: P['stone-pine'], h: [9, 14], r: 0.42 };
    default:
      return { shape: S.round, palette: P.oak, h: [8, 13], r: 0.36 };
  }
}

/** Cheap integer hash → [0, 1). */
function rnd(i: number, salt: number): number {
  let h = Math.imul(i ^ salt, 0x9e3779b1);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return ((h >>> 0) % 100000) / 100000;
}

export interface TreeField {
  /** Instance records, sorted by (cell, shape), TREE_STRIDE floats each. */
  data: Float32Array;
  count: number;
  cols: number;
  rows: number;
  /** World x / y of the grid's south-west corner. */
  x0: number;
  y0: number;
  /** start[(cell · shapes) + shape] … start[… + 1]: instance range. Length cells·shapes + 1. */
  start: Uint32Array;
  /** Instances per shape over the whole world. */
  perShape: number[];
}

/** Build the instance records and cell index (one pass over the bundle's seeds). */
export function buildTreeField(veg: VegetationLayer, hf: Heightfield, extent: { xMin: number; xMax: number; yMin: number; yMax: number }): TreeField {
  const shapes = TREE_SHAPES.length;
  const cols = Math.max(1, Math.ceil((extent.xMax - extent.xMin) / TREE_CELL_M));
  const rows = Math.max(1, Math.ceil((extent.yMax - extent.yMin) / TREE_CELL_M));
  const n = veg.count;
  const key = new Uint32Array(n);
  const species: Species[] = new Array(n);
  const counts = new Uint32Array(cols * rows * shapes + 1);
  const perShape = new Array(shapes).fill(0);
  for (let i = 0; i < n; i++) {
    const kind = VEGETATION_KINDS[veg.kind[i]] ?? 'broadleaf';
    const sp = speciesFor(kind, veg.seed[i] * 7 + (i & 7));
    species[i] = sp;
    const cx = Math.min(cols - 1, Math.max(0, Math.floor((veg.x[i] - extent.xMin) / TREE_CELL_M)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor((veg.y[i] - extent.yMin) / TREE_CELL_M)));
    const k = (cy * cols + cx) * shapes + sp.shape;
    key[i] = k;
    counts[k + 1]++;
    perShape[sp.shape]++;
  }
  const start = new Uint32Array(cols * rows * shapes + 1);
  for (let k = 1; k < start.length; k++) start[k] = start[k - 1] + counts[k];
  const fill = start.slice(0, start.length - 1);
  const data = new Float32Array(n * TREE_STRIDE);
  for (let i = 0; i < n; i++) {
    const sp = species[i];
    const o = fill[key[i]]++ * TREE_STRIDE;
    const x = veg.x[i];
    const y = veg.y[i];
    const u = rnd(i, 0x51ed);
    const height = sp.h[0] + (sp.h[1] - sp.h[0]) * (0.25 * u + 0.75 * rnd(i, 0x7a3));
    const radius = height * sp.r * (0.82 + 0.36 * rnd(i, 0x2c9));
    data[o] = x;
    // Sink the base a little so trunks never float on slopes.
    data[o + 1] = hf.sampleHeight(x, y) - 0.15 - 0.04 * height;
    data[o + 2] = -y;
    data[o + 3] = rnd(i, 0x1f3) * Math.PI * 2;
    data[o + 4] = height;
    data[o + 5] = radius;
    data[o + 6] = sp.palette;
    data[o + 7] = u;
  }
  return { data, count: n, cols, rows, x0: extent.xMin, y0: extent.yMin, start, perShape };
}

export interface TreeRingSelection {
  /** Cells (index) drawn with the detailed meshes, nearest first. */
  near: number[];
  /** Cells drawn with the low-poly meshes, nearest first. */
  far: number[];
  /** Instances selected per shape: [near, far]. */
  counts: [number, number][];
  total: number;
}

/**
 * Cells around the camera (three.js x/z): cells whose nearest point is within
 * `nearM` go near, within `farM` far, nearest first, stopping once `maxTrees`
 * instances are selected (the far edge shrinks first).
 */
export function selectTreeRings(field: TreeField, camX: number, camZ: number, nearM: number, farM: number, maxTrees: number): TreeRingSelection {
  const shapes = TREE_SHAPES.length;
  const wx = camX;
  const wy = -camZ;
  const c0 = Math.max(0, Math.floor((wx - farM - field.x0) / TREE_CELL_M));
  const c1 = Math.min(field.cols - 1, Math.floor((wx + farM - field.x0) / TREE_CELL_M));
  const r0 = Math.max(0, Math.floor((wy - farM - field.y0) / TREE_CELL_M));
  const r1 = Math.min(field.rows - 1, Math.floor((wy + farM - field.y0) / TREE_CELL_M));
  const cand: { cell: number; d: number }[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const ax = field.x0 + c * TREE_CELL_M;
      const ay = field.y0 + r * TREE_CELL_M;
      const dx = Math.max(ax - wx, 0, wx - (ax + TREE_CELL_M));
      const dy = Math.max(ay - wy, 0, wy - (ay + TREE_CELL_M));
      const d = Math.hypot(dx, dy);
      if (d <= farM) cand.push({ cell: r * field.cols + c, d });
    }
  }
  cand.sort((a, b) => a.d - b.d || a.cell - b.cell);
  const near: number[] = [];
  const far: number[] = [];
  const counts: [number, number][] = TREE_SHAPES.map(() => [0, 0]);
  let total = 0;
  for (const { cell, d } of cand) {
    const base = cell * shapes;
    const inCell = field.start[base + shapes] - field.start[base];
    if (inCell === 0) continue;
    if (total + inCell > maxTrees) break;
    const ring = d <= nearM ? 0 : 1;
    (ring === 0 ? near : far).push(cell);
    for (let s = 0; s < shapes; s++) counts[s][ring] += field.start[base + s + 1] - field.start[base + s];
    total += inCell;
  }
  return { near, far, counts, total };
}

/** Copy one shape's instances of the given cells into `out` (TREE_STRIDE floats each). Returns the count. */
export function gatherShape(field: TreeField, cells: readonly number[], shape: number, out: Float32Array): number {
  const shapes = TREE_SHAPES.length;
  let n = 0;
  for (const cell of cells) {
    const a = field.start[cell * shapes + shape];
    const b = field.start[cell * shapes + shape + 1];
    if (b <= a) continue;
    const len = (b - a) * TREE_STRIDE;
    if ((n * TREE_STRIDE) + len > out.length) break;
    out.set(field.data.subarray(a * TREE_STRIDE, b * TREE_STRIDE), n * TREE_STRIDE);
    n += b - a;
  }
  return n;
}
