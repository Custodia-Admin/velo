/**
 * The drawn road under a point on the route, for pace partners' lateral
 * slots (lib/ride/partnerSlots): which ribbon the renderer draws there
 * (worldScene roadBuckets, the same lines Roads.tsx paints) and how far it
 * reaches either side of the point across the travel heading.
 */

import type { RoadSpan } from '@/lib/ride/partnerSlots';
import type { SceneWorld } from './worldScene';

/** A ribbon counts as the road under the point within this distance of its centreline, metres (the bake's ROUTE_ROAD_SNAP_M). */
export const ROAD_SPAN_SNAP_M = 4;

/** The nearest ribbon segment to a point: its centreline and half-width. */
export interface RoadSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  halfWidth: number;
}

/** Nearest drawn ribbon segment within ROAD_SPAN_SNAP_M of world (x, y), or null. */
export function nearestRoadSegment(sw: SceneWorld, x: number, y: number): RoadSegment | null {
  const r = ROAD_SPAN_SNAP_M;
  const chunks = new Set<number>();
  for (const [dx, dy] of [[0, 0], [-r, -r], [r, -r], [-r, r], [r, r]]) {
    const k = sw.locate(x + dx, y + dy);
    if (k >= 0) chunks.add(k);
  }
  let best = r;
  let out: RoadSegment | null = null;
  for (const k of chunks) {
    for (const line of sw.roadBuckets[k]) {
      const p = line.points;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i];
        const ay = p[i + 1];
        const bx = p[i + 2];
        const by = p[i + 3];
        const dx = bx - ax;
        const dy = by - ay;
        const l2 = dx * dx + dy * dy;
        if (l2 === 0) continue;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
        const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
        if (d < best || (d === best && out && line.width / 2 > out.halfWidth)) {
          best = d;
          out = { ax, ay, bx, by, halfWidth: line.width / 2 };
        }
      }
    }
  }
  return out;
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

/** Re-search the nearest ribbon once the point has moved this far from the last search, metres. */
export const ROAD_SPAN_RESEARCH_M = 2;

/** Per-partner cache: the last search point and what it found. */
export interface RoadSpanMemo {
  x: number;
  y: number;
  seg: RoadSegment | null;
}

/**
 * The drawn road around world (x, y) across `heading`, or null off every
 * drawn road. Searches the ribbons again only after the point moves
 * ROAD_SPAN_RESEARCH_M; `memo` carries the last search between frames.
 */
export function roadSpanAt(
  sw: SceneWorld,
  x: number,
  y: number,
  heading: number,
  memo: { road?: RoadSpanMemo },
): RoadSpan | null {
  let m = memo.road;
  if (!m || Math.hypot(x - m.x, y - m.y) > ROAD_SPAN_RESEARCH_M) {
    m = { x, y, seg: nearestRoadSegment(sw, x, y) };
    memo.road = m;
  }
  return m.seg ? spanAcross(m.seg, x, y, heading) : null;
}
