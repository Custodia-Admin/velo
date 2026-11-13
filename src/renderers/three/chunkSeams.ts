/**
 * Test support for chunk seams: the vertices two per-chunk pieces (road
 * buckets, route-line pieces, bridge structures) both draw, and the height
 * each piece gives them. Never imported by the app.
 */

import type { ChunkInfo } from './terrainMesh';

export interface ChunkPiece {
  chunk: ChunkInfo;
  /** Chunk-relative three.js positions (x, h, z), as the piece's mesh holds them. */
  positions: ArrayLike<number>;
}

export interface SharedVertex {
  /** World metres (x east, y north). */
  x: number;
  y: number;
  /** Indices into the pieces passed in. */
  a: number;
  b: number;
  /** Height piece `a` draws there, and the nearest height piece `b` draws there. */
  ha: number;
  hb: number;
}

/** Positions match within this, metres (chunk-relative float32 rounds to ~0.1 mm). */
const SAME_POINT_M = 0.002;

/**
 * Every vertex of a piece that another piece also draws at the same world
 * (x, y), with both heights. Walls stack several vertices on one (x, y), so
 * `hb` is the height piece `b` draws there nearest to `ha`.
 */
export function sharedVertices(pieces: readonly ChunkPiece[]): SharedVertex[] {
  // 1 cm cells, keyed by number (worlds span well under ±40 km).
  const cell = (v: number) => Math.round(v * 100);
  const key = (cx: number, cy: number) => cx * 8_388_608 + cy;
  const grid = new Map<number, { p: number; x: number; y: number; h: number }[]>();
  const all: { p: number; x: number; y: number; h: number }[] = [];
  pieces.forEach((piece, p) => {
    const pos = piece.positions;
    for (let v = 0; v + 2 < pos.length; v += 3) {
      const w = { p, x: pos[v] + piece.chunk.centerX, y: -(pos[v + 2] + piece.chunk.centerZ), h: pos[v + 1] };
      all.push(w);
      const k = key(cell(w.x), cell(w.y));
      const list = grid.get(k);
      if (list) list.push(w);
      else grid.set(k, [w]);
    }
  });
  const out: SharedVertex[] = [];
  for (const w of all) {
    const nearest = new Map<number, number>();
    const cx = cell(w.x);
    const cy = cell(w.y);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const o of grid.get(key(cx + i, cy + j)) ?? []) {
          if (o.p === w.p || Math.hypot(o.x - w.x, o.y - w.y) > SAME_POINT_M) continue;
          const prev = nearest.get(o.p);
          if (prev === undefined || Math.abs(o.h - w.h) < Math.abs(prev - w.h)) nearest.set(o.p, o.h);
        }
    for (const [b, hb] of nearest) out.push({ x: w.x, y: w.y, a: w.p, b, ha: w.h, hb });
  }
  return out;
}

export interface SeamCrack {
  x: number;
  y: number;
  /** The two pieces, and the smaller of the two one-way gaps (metres). */
  a: number;
  b: number;
  gap: number;
}

/**
 * Where two pieces draw a point apart (more than `tolM`): a vertex of `a`
 * whose nearest height in `b` is off AND a vertex of `b` there whose nearest
 * height in `a` is off. A piece that draws a subset of the other's heights
 * at a point is whole with it: a bridge's at-grade segment (deck top and
 * parapets) meeting its raised neighbour (the same, plus the slab
 * underside), as it does inside one chunk too. `gap` is the smaller one-way
 * worst, so a shifted piece reads its shift.
 */
export function seamCracks(shared: readonly SharedVertex[], tolM = 0.001): SeamCrack[] {
  const off = shared.filter((s) => Math.abs(s.ha - s.hb) > tolM);
  const cell = (v: number) => Math.round(v * 100);
  const key = (cx: number, cy: number) => cx * 8_388_608 + cy;
  const grid = new Map<number, SharedVertex[]>();
  for (const s of off) {
    const k = key(cell(s.x), cell(s.y));
    const list = grid.get(k);
    if (list) list.push(s);
    else grid.set(k, [s]);
  }
  const out: SeamCrack[] = [];
  for (const s of off) {
    if (s.a > s.b) continue;
    let back = -1;
    const cx = cell(s.x);
    const cy = cell(s.y);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const o of grid.get(key(cx + i, cy + j)) ?? []) {
          if (o.a !== s.b || o.b !== s.a || Math.hypot(o.x - s.x, o.y - s.y) > SAME_POINT_M) continue;
          back = Math.max(back, Math.abs(o.ha - o.hb));
        }
    if (back >= 0) out.push({ x: s.x, y: s.y, a: s.a, b: s.b, gap: Math.min(Math.abs(s.ha - s.hb), back) });
  }
  return out;
}
