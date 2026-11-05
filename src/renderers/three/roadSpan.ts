/**
 * The drawn road under a point on the route, for pace partners' lateral
 * slots (lib/ride/partnerSlots): which ribbon the renderer draws there
 * (worldScene roadBuckets, the same lines Roads.tsx paints) and how far it
 * reaches either side of the point across the travel heading.
 */

import type { RoadSpan } from '@/lib/ride/partnerSlots';
import type { RibbonLine } from './roadRibbons';
import { ROAD_MAX_SEG_M, type SceneWorld } from './worldScene';

/**
 * Only a ribbon running within 45° of the route's own direction at the
 * point is the road the route rides along. At a junction the crossing
 * road's paved width covers the route point too, and measured across the
 * heading its width is a length along the road: it pulled a partner 0.7 m
 * from the rider at the Tiber start's first side road.
 */
export const ROAD_SPAN_MAX_ANGLE_COS = Math.SQRT1_2;

/** A ribbon segment: its centreline and half-width. */
export interface RoadSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  halfWidth: number;
}

/** Bounding box [xMin, yMin, xMax, yMax] of each ribbon line, filled the first time a gather meets it. */
const lineBoxes = new WeakMap<RibbonLine, Float64Array>();

function boxOf(line: RibbonLine): Float64Array {
  let b = lineBoxes.get(line);
  if (!b) {
    b = Float64Array.of(Infinity, Infinity, -Infinity, -Infinity);
    const p = line.points;
    for (let i = 0; i + 1 < p.length; i += 2) {
      if (p[i] < b[0]) b[0] = p[i];
      if (p[i] > b[2]) b[2] = p[i];
      if (p[i + 1] < b[1]) b[1] = p[i + 1];
      if (p[i + 1] > b[3]) b[3] = p[i + 1];
    }
    lineBoxes.set(line, b);
  }
  return b;
}

/** Half-width of the widest ribbon in each scene, metres. */
const widest = new WeakMap<SceneWorld, number>();

function widestHalfWidth(sw: SceneWorld): number {
  let w = widest.get(sw);
  if (w === undefined) {
    w = 0;
    for (const bucket of sw.roadBuckets) for (const line of bucket) w = Math.max(w, line.width / 2);
    widest.set(sw, w);
  }
  return w;
}

/**
 * Gather the ribbon segments whose paved surface comes within `radius` of
 * world (x, y) (radius 0: the ribbons the point lies on): [ax, ay, bx, by,
 * halfWidth] each. A chunk's road bucket holds whole lines (10k segments in
 * a Perugia city chunk), so a line whose box is out of reach is skipped
 * before its segments.
 */
export function gatherRoadSegments(sw: SceneWorld, x: number, y: number, radius: number): Float64Array {
  // A line sits in the bucket of each chunk holding one of its densified
  // segments' midpoints: up to half a segment along and a half-width across
  // from any point on its surface.
  const pad = radius + widestHalfWidth(sw) + ROAD_MAX_SEG_M / 2;
  const chunks: number[] = [];
  for (const [dx, dy] of [[0, 0], [-pad, -pad], [pad, -pad], [-pad, pad], [pad, pad]]) {
    const k = sw.locate(x + dx, y + dy);
    if (k >= 0 && !chunks.includes(k)) chunks.push(k);
  }
  const seen = new Set<RibbonLine>();
  const out: number[] = [];
  for (const k of chunks) {
    for (const line of sw.roadBuckets[k]) {
      const reach = radius + line.width / 2;
      const b = boxOf(line);
      if (x < b[0] - reach || x > b[2] + reach || y < b[1] - reach || y > b[3] + reach) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      const p = line.points;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i];
        const ay = p[i + 1];
        const dx = p[i + 2] - ax;
        const dy = p[i + 3] - ay;
        const l2 = dx * dx + dy * dy;
        if (l2 === 0) continue;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
        if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= reach) out.push(ax, ay, p[i + 2], p[i + 3], line.width / 2);
      }
    }
  }
  return Float64Array.from(out);
}

/**
 * The ribbon of `segs` (gatherRoadSegments) the route runs on at (x, y), or
 * null:
 * - Only a ribbon whose paved width reaches the point counts. The nearest
 *   centreline within a few metres was often a neighbouring path the route
 *   isn't on; its span lay wholly on one side of the line and clamped every
 *   partner onto that side.
 * - Of those, only ribbons running along the route's own `bearing` there
 *   (radians clockwise from north). That is the route segment's direction,
 *   which turns with the route at a bend; the drawn heading lags it and
 *   dropped the route's own ribbon at the Tiber and Assisi bends.
 * The nearest centreline of those wins; a tie goes to the wider ribbon.
 */
function roadUnder(segs: Float64Array, x: number, y: number, bearing: number): RoadSegment | null {
  const fx = Math.sin(bearing);
  const fy = Math.cos(bearing);
  let best = Infinity;
  let at = -1;
  for (let o = 0; o + 4 < segs.length; o += 5) {
    const ax = segs[o];
    const ay = segs[o + 1];
    const dx = segs[o + 2] - ax;
    const dy = segs[o + 3] - ay;
    const l2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
    if (d > segs[o + 4]) continue;
    if (Math.abs(dx * fx + dy * fy) < ROAD_SPAN_MAX_ANGLE_COS * Math.sqrt(l2)) continue;
    if (d < best || (d === best && at >= 0 && segs[o + 4] > segs[at + 4])) {
      best = d;
      at = o;
    }
  }
  if (at < 0) return null;
  return { ax: segs[at], ay: segs[at + 1], bx: segs[at + 2], by: segs[at + 3], halfWidth: segs[at + 4] };
}

/**
 * The drawn ribbon segment world (x, y) lies on that runs along `bearing`
 * (radians clockwise from north), or null.
 */
export function roadSegmentAt(sw: SceneWorld, x: number, y: number, bearing: number): RoadSegment | null {
  return roadUnder(gatherRoadSegments(sw, x, y, 0), x, y, bearing);
}

/**
 * The span of `seg`'s ribbon around world (x, y), across `heading` (radians
 * clockwise from north): metres from the point, + = right of travel.
 */
export function spanAcross(seg: RoadSegment, x: number, y: number, heading: number): RoadSpan {
  const dx = seg.bx - seg.ax;
  const dy = seg.by - seg.ay;
  const len = Math.hypot(dx, dy) || 1;
  // Right of the segment's own direction, then turned to the travel heading.
  let nx = dy / len;
  let ny = -dx / len;
  if (dx * Math.sin(heading) + dy * Math.cos(heading) < 0) {
    nx = -nx;
    ny = -ny;
  }
  // Signed distance of the point from the centreline, + = right of travel.
  const off = (x - seg.ax) * nx + (y - seg.ay) * ny;
  return { leftM: -seg.halfWidth - off, rightM: seg.halfWidth - off };
}

/** Segments a partner keeps at hand: every ribbon whose surface comes within this distance of where they were gathered, metres. */
export const ROAD_GATHER_M = 30;

/** Per-partner cache: where the segments around it were gathered, and those segments. */
export interface RoadSpanMemo {
  x: number;
  y: number;
  segs: Float64Array;
}

/**
 * The drawn road under world (x, y), measured across the drawn `heading`,
 * or null where the point lies on no drawn road running along the route's
 * `bearing` there (both radians clockwise from north; see roadUnder).
 * With a `memo` (one per partner), the segments within ROAD_GATHER_M are
 * gathered once and searched every frame until the point leaves that
 * circle: any ribbon under a point inside it comes within ROAD_GATHER_M of
 * the centre.
 */
export function roadSpanAt(
  sw: SceneWorld,
  x: number,
  y: number,
  heading: number,
  bearing: number,
  memo?: { road?: RoadSpanMemo },
): RoadSpan | null {
  let segs: Float64Array;
  if (memo) {
    let m = memo.road;
    if (!m || Math.hypot(x - m.x, y - m.y) > ROAD_GATHER_M) {
      m = { x, y, segs: gatherRoadSegments(sw, x, y, ROAD_GATHER_M) };
      memo.road = m;
    }
    segs = m.segs;
  } else {
    segs = gatherRoadSegments(sw, x, y, 0);
  }
  const seg = roadUnder(segs, x, y, bearing);
  return seg ? spanAcross(seg, x, y, heading) : null;
}
