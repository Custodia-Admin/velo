/**
 * The world renderer's pace partner component (Rider.tsx BotRider) draws its
 * partner in the partner's lateral slot, not on the route line where the
 * rider stands (review of PR #45 @4ea2ff0: seated partners covered the
 * rider's own model). BotRider is called as a function under a react mock
 * whose useMemo runs at once; the RiderModel element it returns carries the
 * per-frame `drive` the model calls.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useMemo: <T,>(f: () => T) => f() };
});

const { BotRider, RiderModel } = await import('./Rider');
const { useRideStore } = await import('@/stores/rideStore');
const { BOT_COLORWAYS, BOT_PRESETS, createPaceBot } = await import('@/lib/paceBots');
const { routeFromGeometry } = await import('@/lib/scenicRoutes');
const { syntheticSceneWorld } = await import('./syntheticWorld');
const { createRideDriverMemo, driveRideFrame } = await import('./rideDriver');
const { createRideFrame, createSceneWorld } = await import('./worldScene');
const { headingAt, sampleRouteAtDistance } = await import('@/lib/gpxParser');
const { PARTNER_SLOT_MAX_RATE_MPS } = await import('@/lib/ride/partnerSlots');

type Drive = (dt: number) => {
  placement: { worldX: number; worldY: number; heading: number; position: { x: number; y: number; z: number } };
  lean: number;
} | null;
type PaceBot = import('@/lib/paceBots').PaceBot;
type Route = import('@/types').Route;
type SceneWorld = import('./worldScene').SceneWorld;

const sw = syntheticSceneWorld();
/** An eastbound route north of the synthetic roads (off every ribbon: unclamped slots). */
const route = (() => {
  const pts: [number, number, number][] = [];
  for (let x = -300; x <= 300; x += 10) {
    const [lat, lon] = sw.projection.inverse(x, 60);
    pts.push([lat, lon, 0]);
  }
  return routeFromGeometry('east', 'east', { distanceM: 600, ascentM: 0, maxGradePct: 0, points: pts });
})();

function botElement(index: number, world: SceneWorld = sw, r: Route = route, ground?: (x: number, y: number) => number) {
  const el = BotRider({ sceneWorld: world, route: r, index, ground }) as unknown as { type: unknown; props: { colors: unknown; drive: Drive } };
  expect(el.type).toBe(RiderModel);
  return el;
}

/** A route through world points (x, y), sampled every 10 m. */
function routeVia(world: SceneWorld, ...via: [number, number][]): Route {
  const pts: [number, number, number][] = [];
  for (let k = 0; k + 1 < via.length; k++) {
    const [[x0, y0], [x1, y1]] = [via[k], via[k + 1]];
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 10));
    for (let i = k === 0 ? 0 : 1; i <= n; i++) {
      const [lat, lon] = world.projection.inverse(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n);
      pts.push([lat, lon, 0]);
    }
  }
  return routeFromGeometry('via', 'via', { distanceM: 0, ascentM: 0, maxGradePct: 0, points: pts });
}

/** Three partners all at distance `d` on `r`, as tickPaceBot leaves them riding at `speed`. */
function rosterAt(bots: PaceBot[], r: Route, d: number, speed = 8): PaceBot[] {
  const at = sampleRouteAtDistance(r, d);
  return bots.map((b) => ({ ...b, state: { ...b.state, distance: d, lat: at.lat, lon: at.lon, heading: headingAt(r, d), speed } }));
}

describe('BotRider', () => {
  it('draws each seated partner in its slot beside the start line, in its roster colours', () => {
    useRideStore.setState({ paceBots: BOT_PRESETS.slice(0, 3).map((p, i) => createPaceBot(`b${i}`, p, route)) });
    const at = [0, 1, 2].map((i) => {
      const el = botElement(i);
      expect(el.props.colors).toBe(BOT_COLORWAYS[i]);
      return el.props.drive(1 / 60)!.placement;
    });
    // Eastbound: right of travel is south (world −y).
    expect(at[0].worldY).toBeCloseTo(60 - 1.2, 2);
    expect(at[1].worldY).toBeCloseTo(60 + 1.2, 2);
    expect(at[2].worldY).toBeCloseTo(60 - 2.4, 2);
    for (const p of at) expect(p.worldX).toBeCloseTo(-300, 1);
  });

  it('keeps every partner at least 0.9 m from the rider standing on the line', () => {
    useRideStore.setState({ paceBots: BOT_PRESETS.slice(0, 3).map((p, i) => createPaceBot(`b${i}`, p, route)) });
    const frame = createRideFrame();
    driveRideFrame(frame, createRideDriverMemo(), sw, {
      route, distance: 0, speed: 0, grade: 0, cadence: 0, power: 0, rideState: 'ready',
      steer: 0, override: null, lookAheadM: 12, dt: 1 / 60, timeS: 0,
    });
    const rider = frame.placement!.position;
    for (const i of [0, 1, 2]) {
      const p = botElement(i).props.drive(1 / 60)!.placement.position;
      expect(Math.hypot(p.x - rider.x, p.z - rider.z)).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('follows the live bot state frame by frame, and hides a partner that left the roster', () => {
    const bot = createPaceBot('b0', BOT_PRESETS[0], route);
    useRideStore.setState({ paceBots: [bot] });
    const drive = botElement(0).props.drive;
    expect(drive(1 / 60)!.placement.worldX).toBeCloseTo(-300, 1);
    const [lat, lon] = sw.projection.inverse(-200, 60);
    useRideStore.setState({ paceBots: [{ ...bot, state: { ...bot.state, distance: 100, lat, lon } }] });
    const p = drive(1 / 60)!.placement;
    expect(p.worldX).toBeCloseTo(-200, 1);
    expect(p.worldY).toBeCloseTo(60 - 1.2, 2);
    useRideStore.setState({ paceBots: [] });
    expect(drive(1 / 60)).toBeNull();
  });

  it('keeps one driver memo per partner across frames: where the road narrows the partner drifts over, never jumps', () => {
    // A 7 m road along y = 60 that becomes a 1.5 m path at x = 0.
    const narrows = createSceneWorld({
      ...sw.world,
      roads: {
        ...sw.world.roads,
        roads: [
          { cls: 0, width: 7, flags: 0, points: Float32Array.from([-390, 60, 0, 60]) },
          { cls: 2, width: 1.5, flags: 0, points: Float32Array.from([0, 60, 390, 60]) },
        ],
      },
    } as typeof sw.world);
    const r = routeVia(narrows, [-200, 60], [300, 60]);
    const bots = BOT_PRESETS.slice(0, 3).map((p, i) => createPaceBot(`b${i}`, p, r));
    const drive = botElement(2, narrows, r).props.drive;
    const lateral: number[] = [];
    for (let d = 150; d <= 260; d += 8 / 60) {
      useRideStore.setState({ paceBots: rosterAt(bots, r, d) });
      lateral.push(60 - drive(1 / 60)!.placement.worldY);
    }
    expect(lateral[0]).toBeCloseTo(2.4, 2);
    expect(lateral[lateral.length - 1]).toBeCloseTo(0.65, 2);
    for (let i = 1; i < lateral.length; i++) expect(Math.abs(lateral[i] - lateral[i - 1])).toBeLessThanOrEqual(PARTNER_SLOT_MAX_RATE_MPS / 60 + 0.002);
  });

  it('seats a partner afresh when it comes back to the roster', () => {
    const narrow = createSceneWorld({
      ...sw.world,
      roads: { ...sw.world.roads, roads: [{ cls: 2, width: 1.5, flags: 0, points: Float32Array.from([0, 60, 390, 60]) }] },
    } as typeof sw.world);
    const r = routeVia(narrow, [-200, 60], [300, 60]);
    const bots = BOT_PRESETS.slice(0, 1).map((p, i) => createPaceBot(`b${i}`, p, r));
    const drive = botElement(0, narrow, r).props.drive;
    // Off the path (x < 0): the full 1.2 m slot.
    useRideStore.setState({ paceBots: rosterAt(bots, r, 190) });
    expect(60 - drive(1 / 60)!.placement.worldY).toBeCloseTo(1.2, 2);
    useRideStore.setState({ paceBots: [] });
    expect(drive(1 / 60)).toBeNull();
    // Back 20 m on, on the path: straight into its clamp, not drifting in from 1.2 m.
    useRideStore.setState({ paceBots: rosterAt(bots, r, 210) });
    expect(60 - drive(1 / 60)!.placement.worldY).toBeCloseTo(0.65, 2);
  });

  it('stands the partner on the ground it is given (the drawn ground, like the rider)', () => {
    useRideStore.setState({ paceBots: [createPaceBot('b0', BOT_PRESETS[0], route)] });
    const p = botElement(0, sw, route, () => 321.5).props.drive(1 / 60)!.placement;
    expect(p.position.y).toBe(321.5);
  });

  it('leans the partner into a corner and turns it at the heading filter rate', () => {
    // East, then a 90° turn right (south) at x = 0, off every road.
    const r = routeVia(sw, [-200, 60], [0, 60], [0, -150]);
    const bots = [createPaceBot('b0', BOT_PRESETS[0], r)];
    const drive = botElement(0, sw, r).props.drive;
    let maxLean = 0;
    let prev: number | null = null;
    for (let d = 150; d <= 260; d += 8 / 60) {
      useRideStore.setState({ paceBots: rosterAt(bots, r, d) });
      const out = drive(1 / 60)!;
      maxLean = Math.max(maxLean, Math.abs(out.lean));
      if (prev !== null) {
        let turn = out.placement.heading - prev;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        expect(Math.abs(turn)).toBeLessThanOrEqual((140 * Math.PI) / 180 / 60 + 1e-9);
      }
      prev = out.placement.heading;
    }
    expect(maxLean).toBeGreaterThan(0.05);
  });
});

