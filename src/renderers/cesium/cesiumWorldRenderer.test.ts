import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Cesium from 'cesium';

import { setIonToken } from '@/lib/cesiumUtils';
import type { RiderPose } from '@/lib/world/renderer';
import { useSettingsStore } from '@/stores/settingsStore';
import { createCesiumWorldRenderer, isMoodId } from './cesiumWorldRenderer';

function mockViewer() {
  let destroyed = false;
  return {
    viewer: { isDestroyed: () => destroyed } as unknown as Cesium.Viewer,
    destroy: () => {
      destroyed = true;
    },
  };
}

const pose: RiderPose = {
  lat: 43.1, lon: 12.39, ele: 300, heading: 1, grade: 3, speed: 8, distance: 1200, laneOffsetM: 0.5,
};

describe('Cesium WorldRenderer adapter', () => {
  it("is the 'photoreal' renderer and exposes the viewer as native", () => {
    const { viewer } = mockViewer();
    const r = createCesiumWorldRenderer(viewer, { setRiderOverride: vi.fn(), setMoodOverride: vi.fn() });
    expect(r.kind).toBe('photoreal');
    expect(r.native).toBe(viewer);
  });

  it('setRider forwards the pose; null hands the rider back to the ride', () => {
    const { viewer } = mockViewer();
    const setRiderOverride = vi.fn();
    const r = createCesiumWorldRenderer(viewer, { setRiderOverride, setMoodOverride: vi.fn() });
    r.setRider(pose);
    r.setRider(null);
    expect(setRiderOverride.mock.calls).toEqual([[pose], [null]]);
  });

  it('setMood pins known moods and ignores unknown ids', () => {
    const { viewer } = mockViewer();
    const setMoodOverride = vi.fn();
    const r = createCesiumWorldRenderer(viewer, { setRiderOverride: vi.fn(), setMoodOverride });
    r.setMood('golden-hour');
    r.setMood('not-a-mood');
    r.setMood(null);
    expect(setMoodOverride.mock.calls).toEqual([['golden-hour'], [null], [null]]);
    expect(isMoodId('golden-hour')).toBe(true);
    expect(isMoodId('toString')).toBe(false);
  });

  it('setCamera follows the persisted camera setting', () => {
    const { viewer } = mockViewer();
    const r = createCesiumWorldRenderer(viewer, { setRiderOverride: vi.fn(), setMoodOverride: vi.fn() });
    const before = useSettingsStore.getState().cameraMode;
    r.setCamera('overhead');
    expect(useSettingsStore.getState().cameraMode).toBe('overhead');
    useSettingsStore.getState().setCameraMode(before);
  });

  it('dispose releases overrides once and turns every later call into a no-op', () => {
    const { viewer } = mockViewer();
    const setRiderOverride = vi.fn();
    const setMoodOverride = vi.fn();
    const r = createCesiumWorldRenderer(viewer, { setRiderOverride, setMoodOverride });
    r.dispose();
    r.dispose();
    r.setRider(pose);
    r.setMood('golden-hour');
    expect(setRiderOverride.mock.calls).toEqual([[null]]);
    expect(setMoodOverride.mock.calls).toEqual([[null]]);
  });

  it('a destroyed viewer ignores calls', () => {
    const { viewer, destroy } = mockViewer();
    const setRiderOverride = vi.fn();
    const r = createCesiumWorldRenderer(viewer, { setRiderOverride, setMoodOverride: vi.fn() });
    destroy();
    r.setRider(pose);
    expect(setRiderOverride).not.toHaveBeenCalled();
  });
});

describe('Cesium WorldRenderer groundReady (the ride start holds on it)', () => {
  /** A viewer whose globe keeps streaming (tilesLoaded never turns true while the horizon loads). */
  function streamingViewer(terrain: object = { worldTerrain: true }) {
    let destroyed = false;
    const scene = { terrainProvider: terrain, globe: { tilesLoaded: false }, primitives: { length: 0, get: () => undefined } };
    return {
      viewer: { isDestroyed: () => destroyed, scene } as unknown as Cesium.Viewer,
      destroy: () => {
        destroyed = true;
      },
    };
  }

  afterEach(() => setIonToken(null));

  it('follows the start-ground watch while World Terrain streams', () => {
    setIonToken('eyJ_test');
    const { viewer } = streamingViewer();
    let stable = false;
    const r = createCesiumWorldRenderer(viewer, { setRiderOverride: vi.fn(), setMoodOverride: vi.fn(), groundStable: () => stable });
    expect(r.groundReady?.()).toBe(false);
    stable = true;
    expect(r.groundReady?.()).toBe(true);
  });

  it('never ready on the flat globe before World Terrain is assigned, even when the watch says still', () => {
    setIonToken('eyJ_test');
    const { viewer } = streamingViewer(new Cesium.EllipsoidTerrainProvider());
    const r = createCesiumWorldRenderer(viewer, { setRiderOverride: vi.fn(), setMoodOverride: vi.fn(), groundStable: () => true });
    expect(r.groundReady?.()).toBe(false);
    // Nothing real is drawn there yet: the start waits longer for that.
    expect(r.groundPending?.()).toBe(true);
    (viewer.scene as unknown as { terrainProvider: object }).terrainProvider = { worldTerrain: true };
    expect(r.groundPending?.()).toBe(false);
    expect(r.groundReady?.()).toBe(true);
  });

  it('nothing to wait for without a token, or once the viewer is gone', () => {
    const { viewer, destroy } = streamingViewer(new Cesium.EllipsoidTerrainProvider());
    const r = createCesiumWorldRenderer(viewer, { setRiderOverride: vi.fn(), setMoodOverride: vi.fn(), groundStable: () => false });
    expect(r.groundReady?.()).toBe(true);
    expect(r.groundPending?.()).toBe(false);
    setIonToken('eyJ_test');
    expect(r.groundReady?.()).toBe(false);
    expect(r.groundPending?.()).toBe(true);
    destroy();
    expect(r.groundReady?.()).toBe(true);
    expect(r.groundPending?.()).toBe(false);
  });

  it('the view asks for World Terrain before it builds the Viewer, and never in an idle callback', () => {
    // The start waits for World Terrain (groundPending); on the owner's laptop
    // the Viewer constructor and the idle wait each cost seconds before it.
    const src = readFileSync(join(__dirname, 'CesiumWorldView.tsx'), 'utf8');
    const ask = src.indexOf('const worldTerrain = getTerrainProvider();');
    expect(ask).toBeGreaterThan(src.indexOf('setIonToken(ionToken);'));
    expect(ask).toBeLessThan(src.indexOf('await waitForContainerSize(container);'));
    expect(src.indexOf('await waitForContainerSize(container);')).toBeLessThan(src.indexOf('new Cesium.Viewer('));
    expect(src.match(/getTerrainProvider\(\)/g)).toHaveLength(1);
    expect(src).toMatch(/worldTerrain\s*\.then\(\(terrain\) => \{\s*if \(viewer\.isDestroyed\(\)\) return;\s*viewer\.scene\.terrainProvider = terrain;/);
  });
});
