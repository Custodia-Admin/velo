/**
 * The world renderer's drawn roads for the ride line (lib/ride/rideLine,
 * LineRoads): the ribbons Roads.tsx paints (worldScene roadBuckets, read via
 * roadSpan.gatherRoadSegments). With them the line keeps the drawn rider on
 * a 1.5 m path through its corners: cutting a corner by up to
 * LINE_MAX_OFFSET_M against the route alone put it 0.5 m out on the grass
 * at Tiber park and Assisi (PR #109 review).
 */

import { LINE_ROAD_REACH_M, rideLineFor, type LineRoads, type RideLine, type RoadEdgeTest } from '@/lib/ride/rideLine';
import type { Route } from '@/types';
import { gatherRoadSegments } from './roadSpan';
import type { SceneWorld } from './worldScene';

/** Ribbon segments are gathered round one route point and reused until the route moves this far from it, metres. */
const REGATHER_M = 20;

/**
 * The ribbon segments round one route point (every one whose surface comes
 * within LINE_ROAD_REACH_M of a point within REGATHER_M of it), with the
 * world projection linearised there: over tens of metres the transverse
 * Mercator is affine to well under a micrometre, and the line build asks
 * hundreds of thousands of points.
 */
interface Block {
  lat0: number;
  lon0: number;
  x0: number;
  y0: number;
  /** World metres per degree of latitude / longitude, east (x) and north (y). */
  xLat: number;
  xLon: number;
  yLat: number;
  yLon: number;
  /** Per segment: start x, y, run dx, dy, 1 / length², half-width. */
  segs: Float64Array;
}

/** Floats per Block segment. */
const SEG = 6;

/** Degrees between the points the projection is linearised from. */
const DLL = 1e-4;

function gatherBlock(sw: SceneWorld, lat: number, lon: number): Block {
  const [x0, y0] = sw.projection.forward(lat, lon);
  const [x1, y1] = sw.projection.forward(lat + DLL, lon);
  const [x2, y2] = sw.projection.forward(lat, lon + DLL);
  return {
    lat0: lat,
    lon0: lon,
    x0,
    y0,
    xLat: (x1 - x0) / DLL,
    xLon: (x2 - x0) / DLL,
    yLat: (y1 - y0) / DLL,
    yLon: (y2 - y0) / DLL,
    segs: blockSegments(gatherRoadSegments(sw, x0, y0, REGATHER_M + LINE_ROAD_REACH_M)),
  };
}

/** gatherRoadSegments' [ax, ay, bx, by, halfWidth] as Block segments (zero-length ones dropped). */
function blockSegments(g: Float64Array): Float64Array {
  const out = new Float64Array((g.length / 5) * SEG);
  let o = 0;
  for (let i = 0; i + 4 < g.length; i += 5) {
    const dx = g[i + 2] - g[i];
    const dy = g[i + 3] - g[i + 1];
    const l2 = dx * dx + dy * dy;
    if (!(l2 > 0)) continue;
    out[o] = g[i];
    out[o + 1] = g[i + 1];
    out[o + 2] = dx;
    out[o + 3] = dy;
    out[o + 4] = 1 / l2;
    out[o + 5] = g[i + 4];
    o += SEG;
  }
  return out.subarray(0, o);
}

/** How far (lat, lon) lies beyond the edge of every segment of `b`, metres. */
function blockBeyond(b: Block, lat: number, lon: number): number {
  const x = b.x0 + b.xLat * (lat - b.lat0) + b.xLon * (lon - b.lon0);
  const y = b.y0 + b.yLat * (lat - b.lat0) + b.yLon * (lon - b.lon0);
  const s = b.segs;
  let best = Infinity;
  for (let o = 0; o < s.length; o += SEG) {
    const px = x - s[o];
    const py = y - s[o + 1];
    const t = Math.max(0, Math.min(1, (px * s[o + 2] + py * s[o + 3]) * s[o + 4]));
    const ex = px - t * s[o + 2];
    const ey = py - t * s[o + 3];
    const out = Math.sqrt(ex * ex + ey * ey) - s[o + 5];
    if (out < best) best = out;
  }
  return best;
}

const byScene = new WeakMap<SceneWorld, LineRoads>();

/** `sw`'s drawn roads as the ride line reads them (one per scene, so a rebuilt view reuses the cached line). */
export function lineRoads(sw: SceneWorld): LineRoads {
  let roads = byScene.get(sw);
  if (roads) return roads;
  let block: Block | null = null;
  roads = {
    near(lat: number, lon: number): RoadEdgeTest | null {
      let b = block;
      if (b) {
        const x = b.xLat * (lat - b.lat0) + b.xLon * (lon - b.lon0);
        const y = b.yLat * (lat - b.lat0) + b.yLon * (lon - b.lon0);
        if (Math.hypot(x, y) > REGATHER_M) b = null;
      }
      if (!b) block = b = gatherBlock(sw, lat, lon);
      if (blockBeyond(b, lat, lon) > 0) return null;
      const at = b;
      return (la: number, lo: number) => blockBeyond(at, la, lo);
    },
  };
  byScene.set(sw, roads);
  return roads;
}

/** The line the riders are drawn on along `route`, kept on `sw`'s drawn roads (rideLineFor, cached). */
export function worldRideLine(route: Route, sw: SceneWorld): RideLine {
  return rideLineFor(route, lineRoads(sw));
}
