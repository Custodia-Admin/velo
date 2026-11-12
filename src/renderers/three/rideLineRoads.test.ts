/**
 * The drawn rider rides the roads the world paints (card t_d47bab84, PR #109
 * review). The drawn line (lib/ride/rideLine) cuts corners by up to
 * LINE_MAX_OFFSET_M against the route; on a 1.5 m path, where the route
 * already runs ~0.3 m off the painted centreline, that put the rider up to
 * 0.52 m out on the grass: 223 m of Tiber park in 75 stretches, 130 m of
 * Assisi, 10 m of Locarno–Brissago, 4 m of Chengdu Luxe Lakes, 12 m of the
 * Cuyahoga towpath (main: 0 m). With the world's ribbons (rideLineRoads) the
 * line keeps on them.
 *
 * Over every shipped world bundle, through the real per-frame step
 * (driveRideFrame), against the ribbons Roads.tsx paints (gathered here with
 * gatherRoadSegments and the exact projection, not rideLineRoads' blocks):
 * wherever the route point is on a ribbon, the drawn rider at lane offset 0
 * is within ROAD_EDGE_TOLERANCE_M of one. And the line still faces the way
 * it moves and never snaps round.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readableWorldBundles } from '../../../tools/worldbake/worldBundles.mjs';

import { sampleRouteAtDistance } from '@/lib/gpxParser';
import { headingDelta } from '@/lib/ride/rideHeading';
import { createLinePoint, lineSample, rideLineFor } from '@/lib/ride/rideLine';
import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { loadWorld } from '@/lib/world/loadWorld';
import { createRideDriverMemo, driveRideFrame } from './rideDriver';
import { worldRideLine } from './rideLineRoads';
import { gatherRoadSegments } from './roadSpan';
import { createRideFrame, createSceneWorld, type SceneWorld } from './worldScene';

/** Farthest beyond a painted edge the drawn rider may be where the route is on the road, metres. */
const ROAD_EDGE_TOLERANCE_M = 0.05;
/** Spacing of the walk, metres (a frame at 36 km/h is 0.17 m). */
const WALK_M = 0.25;
const DEG = 180 / Math.PI;

const BUNDLE_DIRS = new Map<string, string>(readableWorldBundles().map((b: { id: string; dir: string }) => [b.id, b.dir]));
const SHIPPED = [...BUNDLE_DIRS.keys()];

/** Metres world (x, y) lies beyond the edge of every ribbon in `segs` ([ax, ay, bx, by, halfWidth] each). */
function beyond(segs: Float64Array, x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i + 4 < segs.length; i += 5) {
    const dx = segs[i + 2] - segs[i];
    const dy = segs[i + 3] - segs[i + 1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - segs[i]) * dx + (y - segs[i + 1]) * dy) / l2)) : 0;
    const ex = x - segs[i] - t * dx;
    const ey = y - segs[i + 1] - t * dy;
    best = Math.min(best, Math.sqrt(ex * ex + ey * ey) - segs[i + 4]);
  }
  return best;
}

/** The ribbons near a walk, gathered every 10 m: every one whose surface comes within 1 m of a point within 10 m of the centre. */
function ribbonsAlong(sw: SceneWorld) {
  let cx = NaN;
  let cy = NaN;
  let segs: Float64Array = new Float64Array(0);
  return (x: number, y: number) => {
    if (!(Math.hypot(x - cx, y - cy) <= 10)) {
      cx = x;
      cy = y;
      segs = gatherRoadSegments(sw, x, y, 11);
    }
    return segs;
  };
}

describe.each(SHIPPED)('shipped world %s: the drawn rider rides its drawn roads', (id) => {
  const dir = BUNDLE_DIRS.get(id)!;
  const diskFetch = async (url: string) => {
    try {
      return new Response(readFileSync(join(dir, url.replace(/^.*\//, ''))), { status: 200 });
    } catch {
      return new Response(null, { status: 404 });
    }
  };

  it('stays on a painted road wherever the route is on one, facing the way it moves', async () => {
    const world = await loadWorld(`/worlds/${id}/`, { fetch: diskFetch, verifyHashes: false });
    const sw = createSceneWorld(world);
    const ids = world.manifest.routes.map((r: { id: string }) => r.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const routeId of ids) {
      const route = routeFromGeometry(routeId, routeId, SCENIC_ROUTE_GEOMETRY[routeId]);
      const frame = createRideFrame();
      const memo = createRideDriverMemo();
      const riderRibbons = ribbonsAlong(sw);
      const routeRibbons = ribbonsAlong(sw);
      let worst = -Infinity;
      let worstAt = 0;
      let offM = 0;
      let checked = 0;
      for (let d = 0; d <= route.totalDistance; d += WALK_M) {
        driveRideFrame(frame, memo, sw, {
          route,
          distance: d,
          speed: 10,
          grade: 0,
          cadence: 85,
          power: 200,
          rideState: 'running',
          steer: 0,
          override: null,
          lookAheadM: 7,
          dt: WALK_M / 10,
          timeS: d / 10,
        });
        const r = sampleRouteAtDistance(route, d);
        const [rx, ry] = sw.projection.forward(r.lat, r.lon);
        if (beyond(routeRibbons(rx, ry), rx, ry) > 0) continue;
        checked++;
        const pose = frame.pose!;
        expect(pose.laneOffsetM).toBe(0);
        const [x, y] = sw.projection.forward(pose.lat, pose.lon);
        const out = beyond(riderRibbons(x, y), x, y);
        if (out > 0) offM += WALK_M;
        if (out > worst) [worst, worstAt] = [out, d];
      }
      // Most of every route is on a painted road (routeSurface.test bounds the rest).
      expect(checked * WALK_M, routeId).toBeGreaterThan(route.totalDistance * 0.5);
      expect(worst, `${routeId}: drawn rider beyond the painted edge at ${worstAt.toFixed(1)} m (${offM} m off in all)`).toBeLessThanOrEqual(ROAD_EDGE_TOLERANCE_M);

      // The line the rider was drawn on is the world's (rideLineRoads), and it still faces the
      // way it moves and turns gradually: at most 12° per 10 cm (rideLine.test's bound).
      const line = rideLineFor(route);
      expect(line).toBe(worldRideLine(route, sw));
      const p = createLinePoint();
      const q = createLinePoint();
      const m = createLinePoint();
      let crab = 0;
      let crabAt = 0;
      let snap = 0;
      let snapAt = 0;
      for (let d = 0; d + 0.1 <= route.totalDistance; d += 0.1) {
        lineSample(line, d, p);
        lineSample(line, d + 0.1, q);
        lineSample(line, d + 0.05, m);
        const travel = Math.atan2((q.lon - p.lon) * Math.cos((p.lat * Math.PI) / 180), q.lat - p.lat);
        const c = Math.abs(headingDelta(m.heading, travel));
        if (c > crab) [crab, crabAt] = [c, d];
        const s = Math.abs(headingDelta(q.heading, p.heading));
        if (s > snap) [snap, snapAt] = [s, d];
      }
      expect(crab * DEG, `${routeId}: heading vs travel at ${crabAt.toFixed(1)} m`).toBeLessThan(1);
      expect(snap * DEG, `${routeId}: turn per 10 cm at ${snapAt.toFixed(1)} m`).toBeLessThan(12);
    }
  }, 180_000);
});
