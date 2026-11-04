/**
 * The per-frame ride step's heading smoothing, outside the camera: the lane
 * offset turns with the filtered heading (a steered rider must not jump across
 * the road at an out-and-back U-turn or a sharp junction turn), and pace bots get the same wide chord
 * and YawFilter as the rider instead of the raw ±4 m route bearing.
 */
import { describe, expect, it } from 'vitest';

import { headingAt } from '@/lib/gpxParser';
import { MAX_LANE_OFFSET_M } from '@/lib/laneOffset';
import { MAX_YAW_RATE, headingDelta, smoothHeadingAt } from '@/lib/ride/rideHeading';
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
// `pivotFromMs`: speed from which the raw ±4 m bearing turns faster than the cap.
const CORNERS = [
  { id: 'scenic-perugia-tiber-park', from: 9590, to: 9760, maxYawRate: MAX_YAW_RATE, pivotFromMs: 8 },
  { id: 'scenic-assisi-valley', from: 4290, to: 4450, maxYawRate: 0.9 * MAX_YAW_RATE, pivotFromMs: 11 },
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
 * Rides a fully steered rider from `from` to `to` m and returns the worst
 * per-frame jump beyond travel plus the lane offset swinging round with the
 * rate-capped heading, metres.
 */
function worstLaneJump(r: Route, from: number, to: number, speed: number): number {
  const frame = createRideFrame();
  const memo = createRideDriverMemo();
  // Settle into the full right-hand lane before the corner.
  memo.lane = { offsetM: MAX_LANE_OFFSET_M, velMs: 0 };
  let prev: { x: number; z: number } | null = null;
  let worstExcess = 0;
  for (let d = from; d <= to; d += speed * DT) {
    driveRideFrame(frame, memo, sw, {
      route: r, distance: d, speed, grade: 0, cadence: 85, power: 200, rideState: 'running',
      steer: 1, override: null, lookAheadM: 12, dt: DT, timeS: 0,
    });
    const p = frame.placement!.position;
    if (prev) {
      const allowed = (speed + MAX_LANE_OFFSET_M * MAX_YAW_RATE) * DT;
      worstExcess = Math.max(worstExcess, Math.hypot(p.x - prev.x, p.z - prev.z) - allowed);
    }
    prev = { x: p.x, z: p.z };
  }
  return worstExcess;
}

describe('driveRideFrame lane offset', () => {
  for (const gapM of [1, 0.3]) {
    it(`keeps a fully steered rider on its side of the road through an out-and-back U-turn (${gapM} m apart)`, () => {
      const r = outAndBack(200, gapM);
      // The wide chord folds onto itself here: it swings through 180° within
      // a few metres, which is what the filtered heading must absorb.
      const turnAt = 200;
      expect(Math.abs(headingDelta(smoothHeadingAt(r, turnAt - 15), smoothHeadingAt(r, turnAt + 15)))).toBeGreaterThan(3);
      for (const speed of [4, 8, 15]) {
        expect(worstLaneJump(r, turnAt - 60, turnAt + 60, speed), `${speed} m/s: per-frame jump beyond travel + lane swing, m`).toBeLessThan(0.02);
      }
    });
  }

  it('keeps a fully steered rider on its side of the road through the Tiber 123° turn', () => {
    const r = route('scenic-perugia-tiber-park');
    for (const speed of [4, 8, 15]) {
      expect(worstLaneJump(r, 9590, 9760, speed), `${speed} m/s: per-frame jump beyond travel + lane swing, m`).toBeLessThan(0.02);
    }
  });
});

describe('driveBotPose', () => {
  for (const c of CORNERS) {
    it(`${c.id}: a pace bot turns no faster than the rider would (≤ ${(c.maxYawRate * DEG).toFixed(0)}°/s)`, () => {
      const r = route(c.id);
      for (const speed of [4, 8, 11, 15]) {
        const memo = createBotDriverMemo();
        let rate = 0;
        let rawRate = 0;
        let prev = NaN;
        let prevRaw = NaN;
        let maxLean = 0;
        for (let d = c.from; d <= c.to; d += speed * DT) {
          const raw = headingAt(r, d);
          const { heading, lean } = driveBotPose(memo, r, { distance: d, speed, heading: raw }, DT);
          if (Number.isFinite(prev)) rate = Math.max(rate, Math.abs(headingDelta(heading, prev)) / DT);
          if (Number.isFinite(prevRaw)) rawRate = Math.max(rawRate, Math.abs(headingDelta(raw, prevRaw)) / DT);
          prev = heading;
          prevRaw = raw;
          maxLean = Math.max(maxLean, Math.abs(lean));
        }
        // The raw route bearing (what bots used to draw) pivots on the spot here.
        if (speed >= c.pivotFromMs) expect(rawRate, `${speed} m/s raw bearing rate`).toBeGreaterThan(MAX_YAW_RATE);
        expect(rate, `${speed} m/s bot vs raw bearing rate`).toBeLessThan(rawRate / 2);
        expect(rate * DEG, `${speed} m/s bot yaw rate, °/s`).toBeLessThanOrEqual(c.maxYawRate * DEG + 1e-6);
        expect(maxLean, `${speed} m/s bot leans into the corner`).toBeGreaterThan(0);
      }
    });
  }

  it('snaps to the route on a seek and falls back to the bot heading without a route', () => {
    const r = route('scenic-perugia-tiber-park');
    const memo = createBotDriverMemo();
    driveBotPose(memo, r, { distance: 100, speed: 8, heading: 0 }, DT);
    const after = driveBotPose(memo, r, { distance: 900, speed: 8, heading: 0 }, DT);
    expect(after.heading).toBeCloseTo(headingDelta(memo.yaw.heading, 0), 9);
    expect(Math.abs(headingDelta(after.heading, headingAt(r, 900)))).toBeLessThan(0.2);
    const noRoute = createBotDriverMemo();
    expect(driveBotPose(noRoute, null, { distance: 0, speed: 8, heading: 1.25 }, DT).heading).toBe(1.25);
  });
});

describe('driveRideFrame ground (one height source)', () => {
  it('stands the rider and the camera look-ahead on the drawn ground it is given', () => {
    const r = route('scenic-perugia-tiber-park');
    const frame = createRideFrame();
    const drawn = (x: number, y: number) => 200 + x * 0.001 + y * 0.002;
    driveRideFrame(frame, createRideDriverMemo(), sw, {
      route: r, distance: 500, speed: 8, grade: 0, cadence: 85, power: 200, rideState: 'running',
      steer: 0, override: null, lookAheadM: 12, dt: DT, timeS: 0, ground: drawn,
    });
    const p = frame.placement!;
    expect(p.position.y).toBeCloseTo(drawn(p.worldX, p.worldY), 9);
    expect(frame.ahead.y).toBeCloseTo(drawn(frame.ahead.x, -frame.ahead.z), 9);
  });
});
