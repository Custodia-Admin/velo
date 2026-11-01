/**
 * The per-frame ride step's heading smoothing, outside the camera: the lane
 * offset turns with the filtered heading (a steered rider must not jump across
 * the road at an out-and-back U-turn), and pace bots get the same wide chord
 * and YawFilter as the rider instead of the raw ±4 m route bearing.
 */
import { describe, expect, it } from 'vitest';

import { headingAt } from '@/lib/gpxParser';
import { MAX_LANE_OFFSET_M } from '@/lib/laneOffset';
import { MAX_YAW_RATE, headingDelta } from '@/lib/ride/rideHeading';
import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { createBotDriverMemo, createRideDriverMemo, driveBotPose, driveRideFrame } from './rideDriver';
import { syntheticSceneWorld } from './syntheticWorld';
import { createRideFrame } from './worldScene';

const DEG = 180 / Math.PI;
const DT = 1 / 60;
const route = (id: string) => routeFromGeometry(id, id, SCENIC_ROUTE_GEOMETRY[id]);
// Horizontal placement only needs the projection; the synthetic world shares Perugia's.
const sw = syntheticSceneWorld();
const CORNERS = [
  { id: 'scenic-perugia-tiber-park', from: 80, to: 240, maxYawRate: 0.9 * MAX_YAW_RATE },
  { id: 'scenic-assisi-valley', from: 3660, to: 3840, maxYawRate: MAX_YAW_RATE },
];

describe('driveRideFrame lane offset', () => {
  it('keeps a fully steered rider on its side of the road through the Assisi U-turn', () => {
    const r = route('scenic-assisi-valley');
    for (const speed of [4, 8, 15]) {
      const frame = createRideFrame();
      const memo = createRideDriverMemo();
      // Settle into the full right-hand lane before the corner.
      memo.lane = MAX_LANE_OFFSET_M;
      let prev: { x: number; z: number } | null = null;
      let worstExcess = 0;
      for (let d = 3660; d <= 3840; d += speed * DT) {
        driveRideFrame(frame, memo, sw, {
          route: r, distance: d, speed, grade: 0, cadence: 85, power: 200, rideState: 'running',
          steer: 1, override: null, lookAheadM: 12, dt: DT, timeS: 0,
        });
        const p = frame.placement!.position;
        if (prev) {
          // Travel plus the offset swinging round with the (rate-capped) heading.
          const allowed = (speed + MAX_LANE_OFFSET_M * MAX_YAW_RATE) * DT;
          worstExcess = Math.max(worstExcess, Math.hypot(p.x - prev.x, p.z - prev.z) - allowed);
        }
        prev = { x: p.x, z: p.z };
      }
      expect(worstExcess, `${speed} m/s: per-frame jump beyond travel + lane swing, m`).toBeLessThan(0.02);
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
        if (speed >= 8) expect(rawRate, `${speed} m/s raw bearing rate`).toBeGreaterThan(MAX_YAW_RATE);
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
