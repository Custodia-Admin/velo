import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as Cesium from 'cesium';
import type { Route } from '@/types';
import { buildRoute } from '@/lib/gpxParser';
import { usePlayStore } from '@/stores/playStore';
import { DEFAULT_AVATAR_COLORS } from '@/lib/avatarConfig';

const avatar = { update: vi.fn(), dispose: vi.fn(), setColors: vi.fn(), entities: [], _effortLevel: 0 };
vi.mock('@/lib/avatar', () => ({
  createAvatar: vi.fn(() => avatar),
  groundSampleExclusions: vi.fn(() => []),
}));

const { setIonToken } = await import('@/lib/cesiumUtils');
const { createCesiumPlayLayer } = await import('@/lib/play/cesiumPlayLayer');

function straightRoute(lengthM: number): Route {
  // Due north from Lugano; 1e-5 deg lat ≈ 1.11 m.
  const n = 200;
  const dLat = lengthM / 111_195 / n;
  return buildRoute(
    'Test route',
    Array.from({ length: n + 1 }, (_, i) => ({ lat: 46 + i * dLat, lon: 8.95, ele: 280 })),
  );
}

function mockViewer(groundM?: number) {
  const added: unknown[] = [];
  let destroyed = false;
  const viewer = {
    scene: { sampleHeightSupported: groundM !== undefined, sampleHeight: vi.fn(() => groundM) },
    entities: {
      add: vi.fn((opts: Record<string, unknown>) => {
        const e = { ...opts, show: true };
        added.push(e);
        return e;
      }),
      remove: vi.fn((e: unknown) => {
        const i = added.indexOf(e);
        if (i >= 0) added.splice(i, 1);
        return i >= 0;
      }),
    },
    isDestroyed: () => destroyed,
  };
  return { viewer: viewer as unknown as Cesium.Viewer, added, destroy: () => (destroyed = true) };
}

const frame = (distanceM: number, routeLengthM: number, dt = 1 / 60) => ({
  elapsedMs: distanceM * 200, dt, distanceM, routeLengthM, speedMs: 5, powerW: 120, cadenceRpm: 80, gradePct: 0,
});

beforeEach(() => {
  usePlayStore.getState().reset();
  vi.clearAllMocks();
});

describe('createCesiumPlayLayer', () => {
  it('adds one entity per postcard and starts the HUD', () => {
    const route = straightRoute(5000);
    const { viewer, added } = mockViewer();
    const layer = createCesiumPlayLayer(viewer, route, null);
    expect(layer.postcards.length).toBeGreaterThan(0);
    expect(added).toHaveLength(layer.postcards.length);
    const s = usePlayStore.getState();
    expect(s.active).toBe(true);
    expect(s.total).toBe(layer.postcards.length);
    expect(s.buddyLine).toBeNull();
    layer.dispose();
  });

  it('collects postcards as the rider passes and hides them after the pickup', () => {
    const route = straightRoute(5000);
    const { viewer, added } = mockViewer();
    const layer = createCesiumPlayLayer(viewer, route, null);
    const second = layer.postcards[1].distanceM;
    layer.update(frame(second + 1, route.totalDistance));
    expect(usePlayStore.getState().collected).toBe(2);
    expect(usePlayStore.getState().lastPickupAt).toBeGreaterThan(0);
    // Animation runs ~0.7 s, then the cards hide.
    layer.update(frame(second + 2, route.totalDistance, 1));
    const shown = (added as { show: boolean }[]).map((e) => e.show);
    expect(shown.slice(0, 2)).toEqual([false, false]);
    expect(shown[2]).toBe(true);
    // Riding to the end collects everything.
    layer.update(frame(route.totalDistance, route.totalDistance));
    expect(usePlayStore.getState().collected).toBe(layer.postcards.length);
    expect(usePlayStore.getState().toNextM).toBeNull();
    layer.dispose();
  });

  it('re-seats upcoming cards on the rendered ground', async () => {
    const { Cartographic } = await import('cesium');
    // Re-seating samples the rendered surface, which only exists on real
    // terrain (ion token installed; tonight's guard in sampleGroundHeight).
    setIonToken('eyJ_test');
    try {
      const route = straightRoute(5000);
      const { viewer, added } = mockViewer(300);
      const layer = createCesiumPlayLayer(viewer, route, null);
      // The mock keeps the raw options: a Cartesian3 at first, a position
      // property once re-seated.
      const heightOf = (e: unknown) => {
        const pos = (e as { position: { getValue?: () => never } }).position;
        return Cartographic.fromCartesian(pos.getValue ? pos.getValue() : (pos as never)).height;
      };
      expect(heightOf(added[0])).toBeCloseTo(280 + 2.4, 1);
      layer.update(frame(0, route.totalDistance));
      // First card is within reach: on the sampled ground. Far ones untouched.
      expect(heightOf(added[0])).toBeCloseTo(300 + 2.4, 1);
      expect(heightOf(added.at(-1))).toBeCloseTo(280 + 2.4, 1);
      layer.dispose();
    } finally {
      setIonToken(null);
    }
  });

  it('keeps cards on the flat no-token globe instead of floating at route ele', async () => {
    const { Cartographic } = await import('cesium');
    const route = straightRoute(5000);
    const { viewer, added } = mockViewer(300);
    const layer = createCesiumPlayLayer(viewer, route, null);
    const heightOf = (e: unknown) => {
      const pos = (e as { position: { getValue?: () => never } }).position;
      return Cartographic.fromCartesian(pos.getValue ? pos.getValue() : (pos as never)).height;
    };
    // No token: scene height is 0 m, so cards sit just above the flat map...
    expect(heightOf(added[0])).toBeCloseTo(2.4, 1);
    layer.update(frame(0, route.totalDistance));
    // ...and re-seating on the rendered ground keeps them there (the mock's
    // sampleHeight is never trusted while the scene has no real terrain).
    expect(heightOf(added[0])).toBeCloseTo(2.4, 1);
    layer.dispose();
  });

  it('rides the buddy beside the rider and names them', () => {
    const route = straightRoute(5000);
    const { viewer } = mockViewer();
    const layer = createCesiumPlayLayer(viewer, route, { name: 'Anna', colors: DEFAULT_AVATAR_COLORS });
    expect(usePlayStore.getState().buddyLine).toBe('Anna rides with you');
    // Placed at the start before the first render: an unplaced avatar
    // crashes Cesium's render loop ("reading 'longitude'").
    expect(avatar.update).toHaveBeenCalledTimes(1);
    expect(Number.isFinite(avatar.update.mock.calls[0][0].lon)).toBe(true);
    layer.update(frame(1000, route.totalDistance));
    expect(avatar.update).toHaveBeenCalledTimes(2);
    const u = avatar.update.mock.calls[1][0];
    // Heading north, so the buddy sits to the west of the route line.
    expect(u.lon).toBeLessThan(8.95);
    layer.dispose();
    expect(avatar.dispose).toHaveBeenCalledTimes(1);
  });

  it('removes everything on dispose, once, and keeps the count for the finish card', () => {
    const route = straightRoute(5000);
    const { viewer, added } = mockViewer();
    const layer = createCesiumPlayLayer(viewer, route, { name: 'Anna', colors: DEFAULT_AVATAR_COLORS });
    layer.update(frame(layer.postcards[0].distanceM, route.totalDistance));
    layer.dispose();
    layer.dispose();
    expect(added).toHaveLength(0);
    expect(avatar.dispose).toHaveBeenCalledTimes(1);
    expect(usePlayStore.getState().active).toBe(false);
    expect(usePlayStore.getState().collected).toBe(1);
  });

  it('does not touch a destroyed viewer', () => {
    const route = straightRoute(5000);
    const { viewer, destroy } = mockViewer();
    const layer = createCesiumPlayLayer(viewer, route, { name: 'Anna', colors: DEFAULT_AVATAR_COLORS });
    destroy();
    layer.update(frame(2000, route.totalDistance));
    layer.dispose();
    expect(viewer.entities.remove).not.toHaveBeenCalled();
    // Only the initial placement; no per-frame updates after destroy.
    expect(avatar.update).toHaveBeenCalledTimes(1);
  });
});
