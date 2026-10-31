/**
 * WorldRenderer adapter over a live Cesium Viewer (the 'photoreal' renderer).
 *
 * CesiumWorldView owns the viewer's lifetime (React mount/unmount); this
 * adapter is the handle the ride view gets back through `onReady`. It
 * forwards rider/mood overrides into the view and camera changes into the
 * persisted camera setting, which the view's frame handler already follows.
 */

import type * as Cesium from 'cesium';

import { MOODS, type MoodId } from '@/lib/cesiumUtils';
import type { RiderPose, WorldCameraMode, WorldRenderer } from '@/lib/world/renderer';
import { useSettingsStore } from '@/stores/settingsStore';

export interface CesiumRendererHooks {
  setRiderOverride: (pose: RiderPose | null) => void;
  setMoodOverride: (mood: MoodId | null) => void;
}

export function isMoodId(value: unknown): value is MoodId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MOODS, value);
}

export function createCesiumWorldRenderer(
  viewer: Cesium.Viewer,
  hooks: CesiumRendererHooks,
): WorldRenderer {
  let disposed = false;
  const live = () => !disposed && !viewer.isDestroyed();

  return {
    kind: 'photoreal',
    native: viewer,
    setRider(pose) {
      if (live()) hooks.setRiderOverride(pose);
    },
    setCamera(mode: WorldCameraMode) {
      if (live()) useSettingsStore.getState().setCameraMode(mode);
    },
    setMood(mood) {
      if (!live()) return;
      // Unknown ids fall back to the route's own mood instead of a blank sky.
      hooks.setMoodOverride(isMoodId(mood) ? mood : null);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Hand the rider and sky back; the viewer itself is destroyed when
      // CesiumWorldView unmounts.
      hooks.setRiderOverride(null);
      if (!viewer.isDestroyed()) hooks.setMoodOverride(null);
    },
  };
}
