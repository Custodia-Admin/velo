/**
 * WorldRenderer adapter for the three.js world renderer ('world'). The view
 * owns the canvas (React mount/unmount); this is the handle the ride view
 * gets back through `onReady`.
 */

import type { RiderPose, WorldCameraMode, WorldRenderer } from '@/lib/world/renderer';
import { useSettingsStore } from '@/stores/settingsStore';
import { isWorldMood } from './skyModel';

export interface ThreeRendererHooks {
  setRiderOverride: (pose: RiderPose | null) => void;
  setMoodOverride: (mood: string | null) => void;
}

export function createThreeWorldRenderer(hooks: ThreeRendererHooks): WorldRenderer {
  let disposed = false;
  return {
    kind: 'world',
    setRider(pose) {
      if (!disposed) hooks.setRiderOverride(pose);
    },
    setCamera(mode: WorldCameraMode) {
      if (!disposed) useSettingsStore.getState().setCameraMode(mode);
    },
    setMood(mood) {
      if (disposed) return;
      // Unknown ids fall back to the route's own mood instead of a blank sky.
      hooks.setMoodOverride(isWorldMood(mood) ? mood : null);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      hooks.setRiderOverride(null);
      hooks.setMoodOverride(null);
    },
  };
}
