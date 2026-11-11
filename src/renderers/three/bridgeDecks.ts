/**
 * Bridges as structures, for worlds baked with them (manifest
 * `generator.bridges`, the `bridges` layer: tools/worldbake/bridges.mjs).
 *
 * The bake decided every deck's height once: standing on the ground at its
 * abutments, with headroom over every route passing under it, the ground
 * under its middle kept below its underside. Here that becomes:
 *
 * - the deck's road ribbon at the baked heights (`deckRibbon`);
 * - the ride surface: on the decks the ridden route rides, the rider, the
 *   camera, the partners and the route line stand on the deck; everywhere
 *   else (under a deck too) on the drawn ground (`rideSurface`);
 * - the structure under the ribbon: slab, parapets and piers
 *   (`buildBridgeGeometry`, drawn by Bridges.tsx).
 *
 * Where a deck comes down to the ground (its abutments, a landed approach
 * ramp) it takes on the drawn terrain's offset from the bilinear
 * heightfield, fading out over AT_GRADE_BLEND_M of height, so it meets the
 * road on the ground exactly at whatever LOD that chunk draws, and it is
 * never drawn under the terrain.
 */

import type { Heightfield } from '@/lib/world/heightfield';
import type { BridgePier, LoadedWorld } from '@/lib/world/loadWorld';

/** Over this height above the heightfield a deck no longer follows the drawn terrain, metres. */
export const AT_GRADE_BLEND_M = 1;
/** A deck segment this close to the ground at both ends is at grade: no slab under it (bake: AT_GRADE_M). */
export const AT_GRADE_M = 0.3;
/** A point counts as on a ridden deck within its half-width plus this (bake: RIDE_SLACK_M). */
export const RIDE_SLACK_M = 1.5;
/** Parapet height over the deck top, metres. */
export const PARAPET_H_M = 1.0;
/** Parapet thickness, metres. */
export const PARAPET_W_M = 0.25;
/** The slab's top sits this far under the road ribbon (the ribbon is lifted ROAD_LIFT_M over it). */
export const SLAB_TOP_DROP_M = 0.02;

export interface DeckPiece {
  /** Index into the roads layer. */
  road: number;
  /** Flat [x, y, …] world metres (the road's own vertices). */
  xy: ArrayLike<number>;
  /** Arclength at each vertex, metres. */
  s: Float64Array;
  /** Deck top at each vertex, metres. */
  z: Float32Array;
  len: number;
  halfWidth: number;
  thickness: number;
  /** An approach ramp, not a bridge: nothing is drawn under it where it is at grade. */
  approach: boolean;
  /** [xMin, yMin, xMax, yMax] grown by halfWidth + RIDE_SLACK_M. */
  box: Float64Array;
}

/** Arclength at each vertex of a flat polyline. */
export function vertexArclength(xy: ArrayLike<number>): Float64Array {
  const n = Math.floor(xy.length / 2);
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(xy[i * 2] - xy[i * 2 - 2], xy[i * 2 + 1] - xy[i * 2 - 1]);
  return s;
}

/** Linear interpolation of per-vertex values `v` at arclength `at`. */
export function alongVertices(s: ArrayLike<number>, v: ArrayLike<number>, at: number): number {
  const n = s.length;
  if (at <= s[0]) return v[0];
  if (at >= s[n - 1]) return v[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= at) lo = mid;
    else hi = mid;
  }
  const t = s[hi] > s[lo] ? (at - s[lo]) / (s[hi] - s[lo]) : 0;
  return v[lo] + (v[hi] - v[lo]) * t;
}

/** Every deck of the world by road index; empty for a world baked without bridges. */
export function deckPieces(world: Pick<LoadedWorld, 'roads' | 'bridges'>): Map<number, DeckPiece> {
  const out = new Map<number, DeckPiece>();
  for (const d of world.bridges?.decks ?? []) {
    const road = world.roads.roads[d.road];
    if (!road) continue;
    const xy = road.points;
    const halfWidth = Math.max(1, road.width) / 2;
    const grow = halfWidth + RIDE_SLACK_M;
    const box = Float64Array.of(Infinity, Infinity, -Infinity, -Infinity);
    for (let i = 0; i + 1 < xy.length; i += 2) {
      box[0] = Math.min(box[0], xy[i] - grow);
      box[1] = Math.min(box[1], xy[i + 1] - grow);
      box[2] = Math.max(box[2], xy[i] + grow);
      box[3] = Math.max(box[3], xy[i + 1] + grow);
    }
    const s = vertexArclength(xy);
    out.set(d.road, {
      road: d.road,
      xy,
      s,
      z: d.z,
      len: s[s.length - 1],
      halfWidth,
      thickness: d.thickness,
      approach: d.approach,
      box,
    });
  }
  return out;
}

/** Nearest point of a piece's centreline to (x, y): distance and arclength. */
export function nearestOnPiece(p: DeckPiece, x: number, y: number): { d: number; s: number } {
  const { xy, s } = p;
  let bestD = Infinity;
  let bestS = 0;
  for (let k = 0; k + 1 < s.length; k++) {
    const ax = xy[k * 2];
    const ay = xy[k * 2 + 1];
    const dx = xy[k * 2 + 2] - ax;
    const dy = xy[k * 2 + 3] - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < bestD) {
      bestD = d;
      bestS = s[k] + (s[k + 1] - s[k]) * t;
    }
  }
  return { d: bestD, s: bestS };
}

/**
 * Deck top at arclength `s` of a piece, at (x, y) on it: the baked height,
 * except near the ground, where it blends into the drawn terrain (`ground`)
 * and never goes under it.
 */
export function deckTopAt(
  p: DeckPiece,
  s: number,
  x: number,
  y: number,
  hf: Heightfield,
  ground?: (x: number, y: number) => number,
): number {
  const z = alongVertices(p.s, p.z, s);
  const g = hf.sampleHeight(x, y);
  const drawn = ground ? ground(x, y) : g;
  const above = z - g;
  if (above <= 0) return drawn;
  const w = Math.max(0, 1 - above / AT_GRADE_BLEND_M);
  return Math.max(drawn, z + w * (drawn - g));
}

/** The pieces a route rides (manifest route id), from the bake's ridden spans. */
export function riddenPieces(world: Pick<LoadedWorld, 'bridges'>, routeId: string | undefined): number[] {
  if (!routeId) return [];
  const rides = world.bridges?.rides[routeId] ?? [];
  return [...new Set(rides.flatMap((r) => r.roads))].sort((a, b) => a - b);
}

/**
 * The surface a route is ridden on: the deck top on the decks that route
 * rides (within half-width + RIDE_SLACK_M of the piece), else `ground`.
 * Under a deck the route does not ride, it is the ground: the rider passes
 * under. Returns `ground` itself when the route rides no deck.
 */
export function rideSurface(
  world: Pick<LoadedWorld, 'roads' | 'bridges'>,
  hf: Heightfield,
  routeId: string | undefined,
  ground: (x: number, y: number) => number,
  pieces: Map<number, DeckPiece> = deckPieces(world),
): (x: number, y: number) => number {
  const ridden = riddenPieces(world, routeId)
    .map((r) => pieces.get(r))
    .filter((p): p is DeckPiece => p !== undefined);
  if (!ridden.length) return ground;
  return (x, y) => {
    let best: DeckPiece | null = null;
    let bestD = Infinity;
    let bestS = 0;
    for (const p of ridden) {
      if (x < p.box[0] || y < p.box[1] || x > p.box[2] || y > p.box[3]) continue;
      const q = nearestOnPiece(p, x, y);
      if (q.d <= p.halfWidth + RIDE_SLACK_M && q.d < bestD) {
        best = p;
        bestD = q.d;
        bestS = q.s;
      }
    }
    return best ? deckTopAt(best, bestS, x, y, hf, ground) : ground(x, y);
  };
}

export interface BridgeGeometryData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
}

export interface BridgeGeometryOptions {
  /** Longest segment before subdividing, metres. */
  maxSegM: number;
  /** Positions are written relative to this three.js (x, z) origin. */
  originX: number;
  originZ: number;
  /** Only segments whose midpoint passes this test are emitted (bucketing). */
  keepSegment?: (mx: number, my: number) => boolean;
  /** Only piers whose centre passes this test are emitted. */
  keepPier?: (x: number, y: number) => boolean;
  /** Drawn ground (for the abutment ends); default the heightfield. */
  groundAt?: (x: number, y: number) => number;
}

class Mesh {
  pos: number[] = [];
  nrm: number[] = [];
  idx: number[] = [];

  /** Quad a-b-c-d (counter-clockwise seen from `n`'s side), flat normal n (world x east, y north, z up). */
  quad(a: number[], b: number[], c: number[], d: number[], n: readonly [number, number, number], ox: number, oz: number) {
    const v0 = this.pos.length / 3;
    for (const p of [a, b, c, d]) {
      this.pos.push(p[0] - ox, p[2], -p[1] - oz);
      this.nrm.push(n[0], n[2], -n[1]);
    }
    this.idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
  }

  finish(): BridgeGeometryData {
    return {
      positions: Float32Array.from(this.pos),
      normals: Float32Array.from(this.nrm),
      indices: Uint32Array.from(this.idx),
      vertexCount: this.pos.length / 3,
    };
  }
}

/**
 * The structure of the given decks and piers: per deck segment a slab (top
 * just under the road ribbon, underside, two sides) and a parapet each side;
 * per pier a box. One geometry, positions relative to the origin. Normals
 * are flat; the material draws both faces.
 */
export function buildBridgeGeometry(
  hf: Heightfield,
  decks: readonly DeckPiece[],
  piers: readonly BridgePier[],
  opts: BridgeGeometryOptions,
): BridgeGeometryData {
  const m = new Mesh();
  const { originX: ox, originZ: oz } = opts;
  for (const p of decks) {
    const n = p.s.length;
    for (let k = 0; k + 1 < n; k++) {
      const ax = p.xy[k * 2];
      const ay = p.xy[k * 2 + 1];
      const bx = p.xy[k * 2 + 2];
      const by = p.xy[k * 2 + 3];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-3) continue;
      const ux = (bx - ax) / len;
      const uy = (by - ay) / len;
      // Right of travel.
      const rx = uy;
      const ry = -ux;
      const steps = Math.max(1, Math.ceil(len / opts.maxSegM));
      for (let j = 0; j < steps; j++) {
        const t0 = j / steps;
        const t1 = (j + 1) / steps;
        const x0 = ax + (bx - ax) * t0;
        const y0 = ay + (by - ay) * t0;
        const x1 = ax + (bx - ax) * t1;
        const y1 = ay + (by - ay) * t1;
        if (opts.keepSegment && !opts.keepSegment((x0 + x1) / 2, (y0 + y1) / 2)) continue;
        const s0 = p.s[k] + len * t0;
        const s1 = p.s[k] + len * t1;
        const atGrade =
          alongVertices(p.s, p.z, s0) - hf.sampleHeight(x0, y0) < AT_GRADE_M &&
          alongVertices(p.s, p.z, s1) - hf.sampleHeight(x1, y1) < AT_GRADE_M;
        // A landed approach is a road on the ground; a bridge at grade keeps its parapets.
        if (atGrade && p.approach) continue;
        const z0 = deckTopAt(p, s0, x0, y0, hf, opts.groundAt) - SLAB_TOP_DROP_M;
        const z1 = deckTopAt(p, s1, x1, y1, hf, opts.groundAt) - SLAB_TOP_DROP_M;
        const b0 = z0 - p.thickness;
        const b1 = z1 - p.thickness;
        const h = p.halfWidth;
        const w = h + PARAPET_W_M;
        const P = PARAPET_H_M;
        const pt = (x: number, y: number, side: number, off: number, z: number) => [x + rx * off * side, y + ry * off * side, z];
        if (!atGrade) {
          // Top (under the ribbon) and underside, spanning the parapets.
          m.quad(pt(x0, y0, -1, w, z0), pt(x0, y0, 1, w, z0), pt(x1, y1, 1, w, z1), pt(x1, y1, -1, w, z1), [0, 0, 1], ox, oz);
          m.quad(pt(x0, y0, 1, w, b0), pt(x0, y0, -1, w, b0), pt(x1, y1, -1, w, b1), pt(x1, y1, 1, w, b1), [0, 0, -1], ox, oz);
        }
        for (const side of [-1, 1]) {
          const nOut: [number, number, number] = [rx * side, ry * side, 0];
          const nIn: [number, number, number] = [-rx * side, -ry * side, 0];
          // Outer face: underside (or the ground, at grade) to the parapet top.
          m.quad(pt(x0, y0, side, w, atGrade ? z0 : b0), pt(x1, y1, side, w, atGrade ? z1 : b1), pt(x1, y1, side, w, z1 + P), pt(x0, y0, side, w, z0 + P), nOut, ox, oz);
          // Parapet cap and inner face.
          m.quad(pt(x0, y0, side, h, z0 + P), pt(x0, y0, side, w, z0 + P), pt(x1, y1, side, w, z1 + P), pt(x1, y1, side, h, z1 + P), [0, 0, 1], ox, oz);
          m.quad(pt(x0, y0, side, h, z0), pt(x0, y0, side, h, z0 + P), pt(x1, y1, side, h, z1 + P), pt(x1, y1, side, h, z1), nIn, ox, oz);
        }
      }
    }
  }
  for (const pr of piers) {
    if (opts.keepPier && !opts.keepPier(pr.x, pr.y)) continue;
    const ax = pr.ux * pr.halfAlong;
    const ay = pr.uy * pr.halfAlong;
    const cx = -pr.uy * pr.halfAcross;
    const cy = pr.ux * pr.halfAcross;
    const c = [
      [pr.x - ax - cx, pr.y - ay - cy],
      [pr.x + ax - cx, pr.y + ay - cy],
      [pr.x + ax + cx, pr.y + ay + cy],
      [pr.x - ax + cx, pr.y - ay + cy],
    ];
    for (let i = 0; i < 4; i++) {
      const a = c[i];
      const b = c[(i + 1) % 4];
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const el = Math.hypot(ex, ey) || 1;
      m.quad([a[0], a[1], pr.bottom], [b[0], b[1], pr.bottom], [b[0], b[1], pr.top], [a[0], a[1], pr.top], [ey / el, -ex / el, 0], ox, oz);
    }
  }
  return m.finish();
}
