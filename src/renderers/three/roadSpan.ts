/**
 * The drawn road under a point on the route, for pace partners' lateral
 * slots (lib/ride/partnerSlots): which ribbon the renderer draws there
 * (worldScene roadBuckets, the same lines Roads.tsx paints) and how far it
 * reaches either side of the point across the travel heading.
 */

import type { RoadSpan } from '@/lib/ride/partnerSlots';
import type { RibbonLine } from './roadRibbons';
import type { SceneWorld } from './worldScene';

/** A ribbon counts as the road under the point within this distance of its centreline, metres (the bake's ROUTE_ROAD_SNAP_M). */
export const ROAD_SPAN_SNAP_M = 4;

/**
 * Only a ribbon running within 45° of the travel heading is the road the
 * partner rides along. At a junction the crossing road's centreline passes
 * through the route point too, and measured across the heading its width
 * is a length along the road: it pulled a partner 0.7 m from the rider at
 * the Tiber start's first side road.
 */
export const ROAD_SPAN_MAX_ANGLE_COS = Math.SQRT1_2;

/** The nearest ribbon segment to a point: its centreline and half-width. */
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

/**
 * Gather the ribbon segments any part of which lies within `radius` of world
 * (x, y): [ax, ay, bx, by, halfWidth] each. A chunk's road bucket holds
 * whole lines (10k segments in a Perugia city chunk), so a line whose box is
 * out of reach is skipped before its segments.
 */
export function gatherRoadSegments(sw: SceneWorld, x: number, y: number, radius: number): Float64Array {
  const chunks: number[] = [];
  for (const [dx, dy] of [[0, 0], [-radius, -radius], [radius, -radius], [-radius, radius], [radius, radius]]) {
    const k = sw.locate(x + dx, y + dy);
    if (k >= 0 && !chunks.includes(k)) chunks.push(k);
  }
  const seen = new Set<RibbonLine>();
  const out: number[] = [];
  for (const k of chunks) {
    for (const line of sw.roadBuckets[k]) {
      const b = boxOf(line);
      if (x < b[0] - radius || x > b[2] + radius || y < b[1] - radius || y > b[3] + radius) continue;
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
        if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= radius) out.push(ax, ay, p[i + 2], p[i + 3], line.width / 2);
      }
    }
  }
  return Float64Array.from(out);
}

/** Nearest of `segs` (gatherRoadSegments) within ROAD_SPAN_SNAP_M of (x, y) running along `heading`, or null. */
function nearestOf(segs: Float64Array, x: number, y: number, heading: number): RoadSegment | null {
  const fx = Math.sin(heading);
  const fy = Math.cos(heading);
  let best = ROAD_SPAN_SNAP_M;
  let at = -1;
  for (let o = 0; o + 4 < segs.length; o += 5) {
    const ax = segs[o];
    const ay = segs[o + 1];
    const dx = segs[o + 2] - ax;
    const dy = segs[o + 3] - ay;
    const l2 = dx * dx + dy * dy;
    if (Math.abs(dx * fx + dy * fy) < ROAD_SPAN_MAX_ANGLE_COS * Math.sqrt(l2)) continue;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
    if (d < best || (d === best && at >= 0 && segs[o + 4] > segs[at + 4])) {
      best = d;
      at = o;
    }
  }
  if (at < 0) return null;
  return { ax: segs[at], ay: segs[at + 1], bx: segs[at + 2], by: segs[at + 3], halfWidth: segs[at + 4] };
}

/**
 * Nearest drawn ribbon segment within ROAD_SPAN_SNAP_M of world (x, y) that
 * runs along `heading` (radians clockwise from north), or null.
 */
export function nearestRoadSegment(sw: SceneWorld, x: number, y: number, heading: number): RoadSegment | null {
  return nearestOf(gatherRoadSegments(sw, x, y, ROAD_SPAN_SNAP_M), x, y, heading);
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

/** Segments a partner keeps at hand: everything within this distance of where they were gathered, metres. */
export const ROAD_GATHER_M = 30;

/** Per-partner cache: where the segments around it were gathered, and those segments. */
export interface RoadSpanMemo {
  x: number;
  y: number;
  segs: Float64Array;
}

/**
 * The drawn road around world (x, y) across `heading`, or null off every
 * drawn road running that way. With a `memo` (one per partner), the
 * segments within ROAD_GATHER_M are gathered once and searched every frame
 * until the point is about to leave them.
 */
export function roadSpanAt(sw: SceneWorld, x: number, y: number, heading: number, memo?: { road?: RoadSpanMemo }): RoadSpan | null {
  let segs: Float64Array;
  if (memo) {
    let m = memo.road;
    if (!m || Math.hypot(x - m.x, y - m.y) > ROAD_GATHER_M - ROAD_SPAN_SNAP_M) {
      m = { x, y, segs: gatherRoadSegments(sw, x, y, ROAD_GATHER_M) };
      memo.road = m;
    }
    segs = m.segs;
  } else {
    segs = gatherRoadSegments(sw, x, y, ROAD_SPAN_SNAP_M);
  }
  const seg = nearestOf(segs, x, y, heading);
  return seg ? spanAcross(seg, x, y, heading) : null;
}
