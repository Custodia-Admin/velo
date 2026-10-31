import { describe, expect, it, vi } from 'vitest';
import type * as Cesium from 'cesium';

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
