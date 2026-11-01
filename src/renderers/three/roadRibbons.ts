/**
 * Road ribbons: OSM road centrelines → triangle strips draped on the
 * heightfield, bucketed by terrain chunk so a bucket is built, shown and
 * dropped together with its near-LOD terrain chunk. Pure typed-array math.
 *
 * Each ribbon is the road's real carriageway width (WorldRoad.width: the OSM
 * width tag, else the class default from the bake). Vertices follow the
 * ground every `maxSegM` metres; bridges span straight between their ends;
 * tunnels are not drawn.
 */

import type { Heightfield } from '@/lib/world/heightfield';
import type { RoadsLayer } from '@/lib/world/loadWorld';
import type { ChunkInfo } from './terrainMesh';

export interface RibbonLine {
  /** Flat [x0, y0, x1, y1, …] world metres. */
  points: ArrayLike<number>;
  width: number;
  /** Linear rgb 0–1. */
  color: readonly [number, number, number];
  /** 1 = centre dashes + edge lines in the road shader. */
  marking: number;
  /** Straight span between the end heights instead of following the ground. */
  bridge?: boolean;
}

export interface RibbonGeometryData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** u across (0 left edge → 1 right edge), v along (metres). */
  uvs: Float32Array;
  markings: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
}

export interface RibbonOptions {
  /** Longest segment before subdividing, metres. */
  maxSegM: number;
  /** Lift above the heightfield, metres. */
  lift: number;
  /** Positions are written relative to this three.js (x, z) origin. */
  originX: number;
  originZ: number;
  /** Only segments whose midpoint passes this test are emitted (bucketing). */
  keepSegment?: (mx: number, my: number) => boolean;
}

/** Road classes that are not drawn as surfaces. */
const SKIP_CLASSES = new Set(['steps']);

const srgb = (hex: number): [number, number, number] => {
  const c = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return [c[0], c[1], c[2]];
};

/** Surface colour per road class (warm Umbrian asphalt, white gravel, paving). */
export const ROAD_CLASS_COLORS: Readonly<Record<string, [number, number, number]>> = {
  motorway: srgb(0x48484a),
  trunk: srgb(0x4a4a4c),
  primary: srgb(0x4e4d4e),
  secondary: srgb(0x535252),
  tertiary: srgb(0x585755),
  unclassified: srgb(0x5d5b58),
  residential: srgb(0x5f5d5a),
  living_street: srgb(0x8a8174),
  pedestrian: srgb(0x958a7b),
  service: srgb(0x67635e),
  track: srgb(0xa58e6e),
  cycleway: srgb(0x7c5e54),
  bridleway: srgb(0x9c8a6c),
  path: srgb(0x9c8a6c),
  footway: srgb(0x9a8f80),
};
const UNPAVED = srgb(0xa58e6e);
const FALLBACK = srgb(0x5d5b58);

/** Classes that get painted lines (centre dashes + edges). */
const MARKED = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);

export function roadLines(roads: RoadsLayer): RibbonLine[] {
  const out: RibbonLine[] = [];
  for (const r of roads.roads) {
    const cls = roads.classes[r.cls] ?? '';
    if (SKIP_CLASSES.has(cls) || r.flags & roads.flags.tunnel || r.points.length < 4) continue;
    const unpaved = (r.flags & roads.flags.unpaved) !== 0;
    out.push({
      points: r.points,
      width: Math.max(1, r.width),
      color: unpaved ? UNPAVED : (ROAD_CLASS_COLORS[cls] ?? FALLBACK),
      marking: !unpaved && MARKED.has(cls) ? 1 : 0,
      bridge: (r.flags & roads.flags.bridge) !== 0,
    });
  }
  return out;
}

/** Densify a polyline so no segment is longer than `maxSegM`. Returns flat [x, y, …] and cumulative distance. */
export function densify(points: ArrayLike<number>, maxSegM: number): { xy: Float64Array; s: Float64Array } {
  const n = Math.floor(points.length / 2);
  const xs: number[] = [];
  const ss: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    if (i > 0) {
      const px = points[i * 2 - 2];
      const py = points[i * 2 - 1];
      const len = Math.hypot(x - px, y - py);
      if (len < 1e-3) continue;
      const k = Math.max(1, Math.ceil(len / maxSegM));
      for (let j = 1; j <= k; j++) {
        const t = j / k;
        xs.push(px + (x - px) * t, py + (y - py) * t);
        ss.push(acc + len * t);
      }
      acc += len;
    } else {
      xs.push(x, y);
      ss.push(0);
    }
  }
  return { xy: Float64Array.from(xs), s: Float64Array.from(ss) };
}

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  mark: number[] = [];
  idx: number[] = [];

  get count() {
    return this.pos.length / 3;
  }

  finish(): RibbonGeometryData {
    return {
      positions: Float32Array.from(this.pos),
      normals: Float32Array.from(this.nrm),
      colors: Float32Array.from(this.col),
      uvs: Float32Array.from(this.uv),
      markings: Float32Array.from(this.mark),
      indices: Uint32Array.from(this.idx),
      vertexCount: this.count,
    };
  }
}

/** Build one geometry from `lines`. */
export function buildRibbons(hf: Heightfield, lines: readonly RibbonLine[], opts: RibbonOptions): RibbonGeometryData {
  const b = new Builder();
  for (const line of lines) addLine(b, hf, line, opts);
  return b.finish();
}

function addLine(b: Builder, hf: Heightfield, line: RibbonLine, opts: RibbonOptions) {
  const { xy, s } = densify(line.points, opts.maxSegM);
  const n = s.length;
  if (n < 2) return;
  const half = line.width / 2;
  const total = s[n - 1];
  const hStart = hf.sampleHeight(xy[0], xy[1]);
  const hEnd = hf.sampleHeight(xy[(n - 1) * 2], xy[(n - 1) * 2 + 1]);
  const heightAt = (x: number, y: number, k: number) =>
    (line.bridge && total > 0 ? hStart + ((hEnd - hStart) * s[k]) / total : hf.sampleHeight(x, y)) + opts.lift;

  // Runs of consecutive kept segments become separate strips.
  let prevVertex = -1;
  for (let k = 0; k < n; k++) {
    const x = xy[k * 2];
    const y = xy[k * 2 + 1];
    const keepNext =
      k < n - 1 &&
      (!opts.keepSegment || opts.keepSegment((x + xy[k * 2 + 2]) / 2, (y + xy[k * 2 + 3]) / 2));
    const keepPrev =
      k > 0 && (!opts.keepSegment || opts.keepSegment((x + xy[k * 2 - 2]) / 2, (y + xy[k * 2 - 1]) / 2));
    if (!keepNext && !keepPrev) {
      prevVertex = -1;
      continue;
    }
    // Tangent: average of the adjacent segment directions (miter join).
    const ax = k > 0 ? x - xy[k * 2 - 2] : xy[k * 2 + 2] - x;
    const ay = k > 0 ? y - xy[k * 2 - 1] : xy[k * 2 + 3] - y;
    const bx = k < n - 1 ? xy[k * 2 + 2] - x : ax;
    const by = k < n - 1 ? xy[k * 2 + 3] - y : ay;
    const la = Math.hypot(ax, ay) || 1;
    const lb = Math.hypot(bx, by) || 1;
    let tx = ax / la + bx / lb;
    let ty = ay / la + by / lb;
    const lt = Math.hypot(tx, ty);
    if (lt < 1e-6) {
      tx = bx / lb;
      ty = by / lb;
    } else {
      tx /= lt;
      ty /= lt;
    }
    // Right of travel in (east, north) and the miter stretch, capped at 2×.
    const rx = ty;
    const ry = -tx;
    const segRx = by / lb;
    const segRy = -bx / lb;
    const miter = Math.min(2, 1 / Math.max(0.5, rx * segRx + ry * segRy));
    const w = half * miter;
    const lx = x - rx * w;
    const ly = y - ry * w;
    const qx = x + rx * w;
    const qy = y + ry * w;
    const v0 = b.count;
    for (const [px, py, u] of [
      [lx, ly, 0],
      [qx, qy, 1],
    ] as const) {
      const h = heightAt(px, py, k);
      b.pos.push(px - opts.originX, h, -py - opts.originZ);
      const [nx, ny, nz] = line.bridge ? [0, 0, 1] : hf.normal(px, py);
      b.nrm.push(nx, nz, -ny);
      b.col.push(line.color[0], line.color[1], line.color[2]);
      b.uv.push(u, s[k]);
      b.mark.push(line.marking);
    }
    if (prevVertex >= 0 && keepPrev) {
      const l0 = prevVertex;
      const r0 = prevVertex + 1;
      const l1 = v0;
      const r1 = v0 + 1;
      // Front faces up: (l0, l1, r0) is counter-clockwise from above for travel +y.
      pushTri(b, l0, l1, r0);
      pushTri(b, r0, l1, r1);
    }
    prevVertex = keepNext ? v0 : -1;
  }
}

function pushTri(b: Builder, i: number, j: number, k: number) {
  const p = b.pos;
  const ax = p[j * 3] - p[i * 3];
  const az = p[j * 3 + 2] - p[i * 3 + 2];
  const bx = p[k * 3] - p[i * 3];
  const bz = p[k * 3 + 2] - p[i * 3 + 2];
  // y of (j − i) × (k − i): positive means the face points up.
  const upY = az * bx - ax * bz;
  if (upY >= 0) b.idx.push(i, j, k);
  else b.idx.push(i, k, j);
}

/** Chunk index (planChunks order) holding world (x, y), or −1 off the grid. */
export function chunkLocator(hf: Heightfield, chunks: readonly ChunkInfo[]): (x: number, y: number) => number {
  const cols = [...new Set(chunks.map((c) => c.range.c0))].sort((a, b) => a - b);
  const rows = [...new Set(chunks.map((c) => c.range.r0))].sort((a, b) => a - b);
  const nx = cols.length;
  const { cellSize, xMin, yMax } = hf.spec;
  const find = (edges: number[], v: number) => {
    let i = 0;
    while (i + 1 < edges.length && edges[i + 1] <= v) i++;
    return i;
  };
  return (x, y) => {
    if (!hf.contains(x, y)) return -1;
    const c = (x - xMin) / cellSize;
    const r = (yMax - y) / cellSize;
    return find(rows, r) * nx + find(cols, c);
  };
}

/**
 * For each chunk, the lines with at least one (densified) segment midpoint
 * inside it — the same test `buildRibbons` applies through `keepSegment`, so
 * every piece of every line lands in exactly one bucket.
 */
export function bucketLines(
  lines: readonly RibbonLine[],
  locate: (x: number, y: number) => number,
  bucketCount: number,
  maxSegM: number,
): RibbonLine[][] {
  const buckets: RibbonLine[][] = Array.from({ length: bucketCount }, () => []);
  for (const line of lines) {
    const seen = new Set<number>();
    const { xy } = densify(line.points, maxSegM);
    for (let i = 2; i + 1 < xy.length; i += 2) {
      const k = locate((xy[i] + xy[i - 2]) / 2, (xy[i + 1] + xy[i - 1]) / 2);
      if (k >= 0 && !seen.has(k)) {
        seen.add(k);
        buckets[k].push(line);
      }
    }
  }
  return buckets;
}
