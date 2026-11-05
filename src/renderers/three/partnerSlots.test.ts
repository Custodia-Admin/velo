/**
 * The drawn road under a pace partner (roadSpan.ts) and where the world
 * renderer draws each partner (rideDriver.placeBot): in its lateral slot
 * (lib/ride/partnerSlots) across the filtered heading, clamped to the
 * ribbon Roads.tsx draws there. Review of PR #45 @4ea2ff0: seated partners
 * stood 0.0–0.1 m from the rider and covered the rider's own model.
 */
import { describe, expect, it } from 'vitest';

import { BOT_PRESETS, createPaceBot } from '@/lib/paceBots';
import { PARTNER_EDGE_MARGIN_M } from '@/lib/ride/partnerSlots';
import { routeFromGeometry } from '@/lib/scenicRoutes';
import type { LoadedWorld, RoadsLayer } from '@/lib/world/loadWorld';
import type { Route } from '@/types';
import { createBotDriverMemo, createRideDriverMemo, driveRideFrame, placeBot } from './rideDriver';
import { nearestRoadSegment, ROAD_GATHER_M, ROAD_SPAN_SNAP_M, roadSpanAt, spanAcross, type RoadSpanMemo } from './roadSpan';
import { syntheticSceneWorld } from './syntheticWorld';
import { createRideFrame, createSceneWorld, type SceneWorld } from './worldScene';

const DT = 1 / 60;
const sw = syntheticSceneWorld();

/** The synthetic world with its roads swapped (same terrain and projection). */
function withRoads(roads: RoadsLayer['roads']): SceneWorld {
  return createSceneWorld({ ...sw.world, roads: { ...sw.world.roads, roads } } as LoadedWorld);
}

/** A straight route through world points (x, y), sampled every 10 m. */
function routeThrough(world: SceneWorld, from: [number, number], to: [number, number]): Route {
  const n = Math.round(Math.hypot(to[0] - from[0], to[1] - from[1]) / 10);
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const [lat, lon] = world.projection.inverse(from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n);
    pts.push([lat, lon, 0]);
  }
  return routeFromGeometry('t', 't', { distanceM: n * 10, ascentM: 0, maxGradePct: 0, points: pts });
}

/** The partners seated on the start line (rideStore.reseatPaceBots does this on a route load). */
const seat = (r: Route, n: number) => BOT_PRESETS.slice(0, n).map((p, i) => createPaceBot(`b${i}`, p, r));

describe('roadSpan', () => {
  const EAST = Math.PI / 2;

  it('finds the ribbon under a point and measures it across the travel heading', () => {
    // The synthetic E–W road: 7 m wide along y = 0.
    const seg = nearestRoadSegment(sw, 10, 1, EAST)!;
    expect(seg.halfWidth).toBe(3.5);
    // Eastbound, 1 m north of the centre = 1 m left of it: 4.5 m of road to the right.
    const east = spanAcross(seg, 10, 1, EAST);
    expect(east.leftM).toBeCloseTo(-2.5, 6);
    expect(east.rightM).toBeCloseTo(4.5, 6);
    // Westbound, the same point is right of the centre.
    const west = spanAcross(seg, 10, 1, -EAST);
    expect(west.leftM).toBeCloseTo(-4.5, 6);
    expect(west.rightM).toBeCloseTo(2.5, 6);
    expect(roadSpanAt(sw, 10, 1, -EAST)).toEqual(west);
  });

  it('knows no road off every drawn ribbon, in a tunnel or on steps', () => {
    expect(roadSpanAt(sw, 0, 60, EAST)).toBeNull();
    // Within 4 m of a centreline counts; 4.5 m off it (1 m outside the 7 m road) does not.
    expect(roadSpanAt(sw, 10, 3.9, EAST)).not.toBeNull();
    expect(roadSpanAt(sw, 10, 4.5, EAST)).toBeNull();
    // The synthetic tunnel (y = 150, x −300…−200) and steps (0,100)–(10,110) aren't drawn.
    expect(nearestRoadSegment(sw, -250, 150, EAST)).toBeNull();
    expect(nearestRoadSegment(sw, 5, 105, Math.PI / 4)).toBeNull();
  });

  it('takes the road running along the heading, never a side road crossing it', () => {
    // A 7 m road along y = 0 and a 3 m side road along x = 0. Eastbound at
    // (0.2, 1): the side road's centreline is 0.2 m away, the road's 1 m.
    const cross = withRoads([
      { cls: 0, width: 7, flags: 0, points: Float32Array.from([-390, 0, 390, 0]) },
      { cls: 1, width: 3, flags: 0, points: Float32Array.from([0, -190, 0, 190]) },
    ]);
    expect(nearestRoadSegment(cross, 0.2, 1, EAST)!.halfWidth).toBe(3.5);
    expect(roadSpanAt(cross, 0.2, 1, EAST)).toEqual({ leftM: expect.closeTo(-2.5, 6), rightM: expect.closeTo(4.5, 6) });
    // Northbound on the side road, the main road is the crossing.
    expect(nearestRoadSegment(cross, 0.2, 1, 0)!.halfWidth).toBe(1.5);
    // Up to 45° off the heading still counts as along it; past that it is a crossing.
    expect(nearestRoadSegment(cross, 0.2, 1, EAST - (40 * Math.PI) / 180)!.halfWidth).toBe(3.5);
    expect(nearestRoadSegment(cross, 0.2, 1, EAST - (50 * Math.PI) / 180)!.halfWidth).toBe(1.5);
  });

  it('with a memo, gathers the segments around a partner once and again only before it leaves them', () => {
    const memo: { road?: RoadSpanMemo } = {};
    const at = (x: number, y: number) => roadSpanAt(sw, x, y, EAST, memo);
    expect(at(-300, 1)).toEqual(roadSpanAt(sw, -300, 1, EAST));
    const first = memo.road!;
    expect(first.segs.length).toBeGreaterThan(0);
    // Riding east along the road: the same gather serves the next 26 m.
    for (let x = -300; x <= -300 + ROAD_GATHER_M - ROAD_SPAN_SNAP_M; x += 0.5) {
      expect(at(x, 1)).toEqual(roadSpanAt(sw, x, 1, EAST));
    }
    expect(memo.road).toBe(first);
    at(-300 + ROAD_GATHER_M - ROAD_SPAN_SNAP_M + 0.5, 1);
    expect(memo.road).not.toBe(first);
    // 60 m north of the road: nothing there.
    expect(at(-270, 60)).toBeNull();
  });

  it('with a memo, still finds the next segment of a road that was out of snap reach at the gather', () => {
    // A road that bends 3° at x = −10: from (−30, 1) its second segment is 20 m away.
    const bend = withRoads([{ cls: 0, width: 7, flags: 0, points: Float32Array.from([-390, 0, -10, 0, 390, 20]) }]);
    const memo: { road?: RoadSpanMemo } = {};
    roadSpanAt(bend, -30, 1, EAST, memo);
    // At x = −5 only the second segment is within 4 m of the line point.
    expect(roadSpanAt(bend, -5, 1.2, EAST, memo)).toEqual(roadSpanAt(bend, -5, 1.2, EAST));
    expect(roadSpanAt(bend, -5, 1.2, EAST)).not.toBeNull();
  });
});

describe('placeBot', () => {
  const east = routeThrough(sw, [-300, 0], [300, 0]);

  it('stands seated partners in their slots across an east-facing start: 1.2 m right, 1.2 m left, 2.4 m right', () => {
    const at = seat(east, 3).map((b, i) => placeBot(sw, east, b.state, i, createBotDriverMemo(), DT));
    expect(at.map((p) => p.slotM)).toEqual([1.2, -1.2, 2.4]);
    // Right of an eastbound rider is south (world −y; three z = −y).
    expect(at[0].placement.worldY).toBeCloseTo(-1.2, 2);
    expect(at[1].placement.worldY).toBeCloseTo(1.2, 2);
    expect(at[2].placement.worldY).toBeCloseTo(-2.4, 2);
    for (const p of at) expect(p.placement.worldX).toBeCloseTo(-300, 1);
  });

  it('turns the slot with the heading: a north-facing partner sits east (right) or west (left)', () => {
    const north = routeThrough(sw, [0, -150], [0, 150]);
    // No road along x = 0 there: the slots are unclamped.
    const [b0, b1] = seat(north, 2);
    const r = placeBot(sw, north, b0.state, 0, createBotDriverMemo(), DT).placement;
    const l = placeBot(sw, north, b1.state, 1, createBotDriverMemo(), DT).placement;
    expect(r.worldX).toBeCloseTo(1.2, 2);
    expect(r.worldY).toBeCloseTo(-150, 1);
    expect(l.worldX).toBeCloseTo(-1.2, 2);
    expect(l.worldY).toBeCloseTo(-150, 1);
  });

  it('keeps every seated partner at least 0.9 m from the rider and from each other', () => {
    const frame = createRideFrame();
    driveRideFrame(frame, createRideDriverMemo(), sw, {
      route: east, distance: 0, speed: 0, grade: 0, cadence: 0, power: 0, rideState: 'ready',
      steer: 0, override: null, lookAheadM: 12, dt: DT, timeS: 0,
    });
    const rider = frame.placement!.position;
    const bots = seat(east, 3).map((b, i) => placeBot(sw, east, b.state, i, createBotDriverMemo(), DT).placement.position);
    for (const p of bots) expect(Math.hypot(p.x - rider.x, p.z - rider.z)).toBeGreaterThanOrEqual(0.9);
    for (let i = 0; i < bots.length; i++) {
      for (let j = i + 1; j < bots.length; j++) {
        expect(Math.hypot(bots[i].x - bots[j].x, bots[i].z - bots[j].z)).toBeGreaterThanOrEqual(0.9);
      }
    }
  });

  it('clamps a slot to the drawn ribbon so a partner never rides off it', () => {
    // A 3 m track along y = 0, with the route 0.5 m north of its centre:
    // 2.0 m of road right of the line, 1.0 m left of it.
    const narrow = withRoads([{ cls: 1, width: 3, flags: 0, points: Float32Array.from([-390, 0, 390, 0]) }]);
    const r = routeThrough(narrow, [-300, 0.5], [300, 0.5]);
    const at = seat(r, 3).map((b, i) => placeBot(narrow, r, b.state, i, createBotDriverMemo(), DT));
    expect(at[0].slotM).toBeCloseTo(1.2, 4);
    expect(at[1].slotM).toBeCloseTo(-0.9, 4);
    expect(at[2].slotM).toBeCloseTo(1.9, 4);
    // Within the drawn ribbon (±1.5 m) less the margin; the spherical lane
    // shift and the ellipsoidal projection differ by ~0.1 %.
    for (const p of at) expect(Math.abs(p.placement.worldY)).toBeLessThanOrEqual(1.5 - PARTNER_EDGE_MARGIN_M + 0.01);
  });

  it('keeps its slot where a side road crosses the route (the Tiber start, 8.5 m in)', () => {
    // A 1.5 m side path along x = 0 crossing a 7 m road along y = 0; the
    // route runs east 1 m north of the road's centre, starting 0.5 m past
    // the path. The path's centreline is nearer the start than the road's:
    // measured across the heading it would leave 0.25 m right of the line.
    const cross = withRoads([
      { cls: 0, width: 7, flags: 0, points: Float32Array.from([-390, 0, 390, 0]) },
      { cls: 2, width: 1.5, flags: 0, points: Float32Array.from([0, -190, 0, 190]) },
    ]);
    const r = routeThrough(cross, [0.5, 1], [300, 1]);
    const at = seat(r, 2).map((b, i) => placeBot(cross, r, b.state, i, createBotDriverMemo(), DT));
    expect(at[0].slotM).toBeCloseTo(1.2, 6);
    expect(at[1].slotM).toBeCloseTo(-1.2, 6);
  });

  it('measures the slot across the FILTERED heading, not the raw route bearing', () => {
    // A bot whose raw heading points north on an eastbound route: the filter
    // starts from the route's wide-chord heading, so the slot stays south.
    const [b0] = seat(east, 1);
    const p = placeBot(sw, east, { ...b0.state, heading: 0 }, 0, createBotDriverMemo(), DT).placement;
    expect(p.worldY).toBeCloseTo(-1.2, 2);
    expect(p.heading).toBeCloseTo(Math.PI / 2, 2);
  });
});
