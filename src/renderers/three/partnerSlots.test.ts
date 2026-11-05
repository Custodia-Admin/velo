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
import { nearestRoadSegment, roadSpanAt, spanAcross } from './roadSpan';
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
  it('finds the ribbon under a point and measures it across the travel heading', () => {
    // The synthetic E–W road: 7 m wide along y = 0.
    const seg = nearestRoadSegment(sw, 10, 1)!;
    expect(seg.halfWidth).toBe(3.5);
    // Eastbound, 1 m north of the centre = 1 m left of it: 4.5 m of road to the right.
    const east = spanAcross(seg, 10, 1, Math.PI / 2);
    expect(east.leftM).toBeCloseTo(-2.5, 6);
    expect(east.rightM).toBeCloseTo(4.5, 6);
    // Westbound, the same point is right of the centre.
    const west = spanAcross(seg, 10, 1, -Math.PI / 2);
    expect(west.leftM).toBeCloseTo(-4.5, 6);
    expect(west.rightM).toBeCloseTo(2.5, 6);
  });

  it('knows no road off every drawn ribbon, in a tunnel or on steps', () => {
    expect(nearestRoadSegment(sw, 0, 60)).toBeNull();
    // The synthetic tunnel (y = 150, x −300…−200) and steps (0,100)–(10,110) aren't drawn.
    expect(nearestRoadSegment(sw, -250, 150)).toBeNull();
    expect(nearestRoadSegment(sw, 5, 105)).toBeNull();
  });

  it('searches again once the point has moved on, and only then', () => {
    const memo: Parameters<typeof roadSpanAt>[4] = {};
    expect(roadSpanAt(sw, 10, 0, Math.PI / 2, memo)).not.toBeNull();
    const first = memo.road;
    roadSpanAt(sw, 11, 0, Math.PI / 2, memo);
    expect(memo.road).toBe(first);
    // 60 m north of the road: off every ribbon now.
    expect(roadSpanAt(sw, 10, 60, Math.PI / 2, memo)).toBeNull();
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
    expect(at[1].slotM).toBeCloseTo(-1 + PARTNER_EDGE_MARGIN_M, 4);
    expect(at[2].slotM).toBeCloseTo(2 - PARTNER_EDGE_MARGIN_M, 4);
    // Within the drawn ribbon (±1.5 m) less the margin; the spherical lane
    // shift and the ellipsoidal projection differ by ~0.1 %.
    for (const p of at) expect(Math.abs(p.placement.worldY)).toBeLessThanOrEqual(1.5 - PARTNER_EDGE_MARGIN_M + 0.01);
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
