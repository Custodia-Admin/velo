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
const { createRideFrame } = await import('./worldScene');

type Drive = (dt: number) => { placement: { worldX: number; worldY: number; position: { x: number; z: number } } } | null;

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

function botElement(index: number) {
  const el = BotRider({ sceneWorld: sw, route, index }) as unknown as { type: unknown; props: { colors: unknown; drive: Drive } };
  expect(el.type).toBe(RiderModel);
  return el;
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
});
