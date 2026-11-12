/**
 * The per-frame ride step outside the camera (card t_84d635ff): the rider is
 * drawn on the drawn line (rideLine) facing the way it moves, its lane offset
 * across the line's sideways frame (a steered rider must not jump across the
 * road at an out-and-back U-turn or a sharp junction turn), and pace bots are
 * drawn by the same rule at their own distance instead of at the raw route
 * point and ±4 m route bearing.
 */
import { describe, expect, it } from 'vitest';

import { headingAt } from '@/lib/gpxParser';
import { MAX_LANE_OFFSET_M } from '@/lib/laneOffset';
import { CORNER_LEAN_MAX_RAD } from '@/lib/ride/cornerLean';
import { headingDelta } from '@/lib/ride/rideHeading';
import { LINE_FRAME_RADIUS_M, lineAt, lineHeadingAt } from '@/lib/ride/rideLine';
import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import type { Route } from '@/types';
import { createBotDriverMemo, createRideDriverMemo, driveBotPose, driveRideFrame } from './rideDriver';
import { syntheticSceneWorld } from './syntheticWorld';
import { createRideFrame } from './worldScene';

const DEG = 180 / Math.PI;
const DT = 1 / 60;
const route = (id: string) => routeFromGeometry(id, id, SCENIC_ROUTE_GEOMETRY[id]);
// Horizontal placement only needs the projection; the synthetic world shares Perugia's.
const sw = syntheticSceneWorld();
// The sharpest corners on the Perugia routes (no U-turns since the generator
// cuts them): Tiber's 123° junction turn at 9,672 m, Assisi's 82° at 4,369 m.
const CORNERS = [
  { id: 'scenic-perugia-tiber-park', from: 9590, to: 9760 },
  { id: 'scenic-assisi-valley', from: 4290, to: 4450 },
];

/**
 * An out-and-back in the synthetic world, independent of the shipped scenic
 * data (the generator cuts every U-turn there, but a GPX inside a world bbox
 * still has them): `outM` east, a `gapM` step north on the spot, then back
 * west along the same line.
 */
function outAndBack(outM: number, gapM: number): Route {
  const proj = sw.world.projection;
  const pts: [number, number, number][] = [];
  const at = (x: number, y: number) => {
    const [lat, lon] = proj.inverse(x, y);
    pts.push([lat, lon, 0]);
  };
  const x0 = -outM / 2;
  for (let x = x0; x <= x0 + outM; x += 10) at(x, 0);
  for (let x = x0 + outM; x >= x0; x -= 10) at(x, gapM);
  return routeFromGeometry('uturn', 'uturn', { distanceM: 2 * outM + gapM, ascentM: 0, maxGradePct: 0, points: pts });
}

/**
 * Rides a fully steered rider from `from` to `to` m: the worst per-frame jump
 * beyond travel plus the lane offset swinging round with the sideways frame
 * (metres), and the worst angle between its heading and the way it moved.
 */
function steeredRide(r: Route, from: number, to: number, speed: number): { excess: number; crab: number; crabAt: number } {
  const frame = createRideFrame();
  const memo = createRideDriverMemo();
  // Settle into the full right-hand lane before the corner.
  memo.lane = { offsetM: MAX_LANE_OFFSET_M, velMs: 0 };
  let prev: { x: number; z: number; h: number } | null = null;
  let excess = 0;
  let crab = 0;
  let crabAt = 0;
  for (let d = from; d <= to; d += speed * DT) {
    driveRideFrame(frame, memo, sw, {
      route: r, distance: d, speed, grade: 0, cadence: 85, power: 200, rideState: 'running',
      steer: 1, override: null, lookAheadM: 12, dt: DT, timeS: 0,
    });
    const p = frame.placement!.position;
    const h = frame.pose!.heading;
    if (prev) {
      // The offset path is at most (1 + offset / frame radius) times as long as the line.
      const allowed = speed * (1 + MAX_LANE_OFFSET_M / LINE_FRAME_RADIUS_M) * DT;
      excess = Math.max(excess, Math.hypot(p.x - prev.x, p.z - prev.z) - allowed);
      // Scene x is east, z is south: travel bearing clockwise from north.
      const travel = Math.atan2(p.x - prev.x, -(p.z - prev.z));
      const mid = prev.h + headingDelta(h, prev.h) / 2;
      const c = Math.abs(headingDelta(mid, travel));
      if (c > crab) [crab, crabAt] = [c, d];
    }
    prev = { x: p.x, z: p.z, h };
  }
  return { excess, crab, crabAt };
}

describe('driveRideFrame lane offset', () => {
  for (const gapM of [1, 0.3]) {
    it(`keeps a fully steered rider on its side of the road through an out-and-back U-turn (${gapM} m apart)`, () => {
      const r = outAndBack(200, gapM);
      // The drawn line turns round within a few metres here; the sideways frame takes ~16 m.
      const turnAt = 200;
      expect(Math.abs(headingDelta(lineHeadingAt(r, turnAt - 15), lineHeadingAt(r, turnAt + 15)))).toBeGreaterThan(3);
      for (const speed of [4, 8, 15]) {
        expect(steeredRide(r, turnAt - 60, turnAt + 60, speed).excess, `${speed} m/s: per-frame jump beyond travel + lane swing, m`).toBeLessThan(0.02);
      }
    });
  }

  it('keeps a fully steered rider on its side of the road through the Tiber 123° turn, facing the way it moves', () => {
    const r = route('scenic-perugia-tiber-park');
    for (const speed of [4, 8, 15]) {
      const w = steeredRide(r, 9590, 9760, speed);
      expect(w.excess, `${speed} m/s: per-frame jump beyond travel + lane swing, m`).toBeLessThan(0.02);
      // Facing its own path (to the frame step); a few degrees more only pivoting round the inside of the junction.
      expect(w.crab * DEG, `${speed} m/s: heading vs travel at ${w.crabAt.toFixed(1)} m, °`).toBeLessThan(10);
    }
  });
});

describe('driveBotPose', () => {
  for (const c of CORNERS) {
    it(`${c.id}: a pace bot is drawn as the rider is, at its own distance: on the line, facing along it, leaning alike`, () => {
      const r = route(c.id);
      for (const speed of [4, 8, 15]) {
        const memo = createBotDriverMemo();
        const frame = createRideFrame();
        const rider = createRideDriverMemo();
        let maxLean = 0;
        for (let d = c.from; d <= c.to; d += speed * DT) {
          const bot = driveBotPose(memo, r, { distance: d, speed, heading: headingAt(r, d) }, DT);
          driveRideFrame(frame, rider, sw, {
            route: r, distance: d, speed, grade: 0, cadence: 85, power: 200, rideState: 'running',
            steer: 0, override: null, lookAheadM: 12, dt: DT, timeS: 0,
          });
          const p = lineAt(r, d);
          expect(bot.lat).toBeCloseTo(p.lat, 10);
          expect(bot.lon).toBeCloseTo(p.lon, 10);
          expect(bot.heading).toBeCloseTo(frame.pose!.heading, 9);
          expect(bot.lean).toBeCloseTo(frame.lean, 9);
          maxLean = Math.max(maxLean, Math.abs(bot.lean));
        }
        expect(maxLean, `${speed} m/s: leans into the corner`).toBeGreaterThan(0.05);
        expect(maxLean).toBeLessThanOrEqual(CORNER_LEAN_MAX_RAD + 1e-9);
      }
    });
  }

  it('is on the line wherever a seek puts it, and falls back to the bot heading without a route', () => {
    const r = route('scenic-perugia-tiber-park');
    const memo = createBotDriverMemo();
    driveBotPose(memo, r, { distance: 100, speed: 8, heading: 0 }, DT);
    const after = driveBotPose(memo, r, { distance: 900, speed: 8, heading: 0 }, DT);
    expect(after.heading).toBe(lineHeadingAt(r, 900));
    const noRoute = createBotDriverMemo();
    const off = driveBotPose(noRoute, null, { distance: 0, speed: 8, heading: 1.25, lat: 43.1, lon: 12.4 }, DT);
    expect(off).toMatchObject({ heading: 1.25, lat: 43.1, lon: 12.4, lean: 0 });
  });
});
