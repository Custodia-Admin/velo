/**
 * usePlayLayer: mounts the Cesium Play mode layer (postcards + riding buddy)
 * on the current route while the active rider has Play mode on.
 *
 * Owns its own preRender listener so the viewer's main frame handler doesn't
 * change. The layer is rebuilt on route change and on toggle, and disposed on
 * unmount; dispose() guards a destroyed viewer.
 */

import { useEffect } from 'react';
import type * as Cesium from 'cesium';
import type { Route } from '@/types';
import { useSettingsStore } from '@/stores/settingsStore';
import { useRiderRosterStore } from '@/stores/riderRosterStore';
import { useRideStore } from '@/stores/rideStore';
import { usePlayStore } from '@/stores/playStore';
import { listRides } from '@/lib/rideHistory';
import { pickBuddyRide } from '@/lib/play/buddy';
import { createCesiumPlayLayer, type BuddyConfig } from '@/lib/play/cesiumPlayLayer';
import { AVATAR_PRESETS, type AvatarColors } from '@/lib/avatarConfig';

const sameColors = (a: AvatarColors, b: AvatarColors) => JSON.stringify(a) === JSON.stringify(b);

/** The other rider in the roster, in their own colours (never identical to yours). */
export function resolveBuddy(): { id: string; config: BuddyConfig } | null {
  const { riders, activeRiderId } = useRiderRosterStore.getState();
  const other = riders.find((r) => r.id !== activeRiderId);
  if (!other) return null;
  const mine = useSettingsStore.getState().avatar;
  let colors = other.settings?.avatar ?? AVATAR_PRESETS[0].colors;
  if (sameColors(colors, mine)) {
    colors = (AVATAR_PRESETS.find((p) => !sameColors(p.colors, mine)) ?? AVATAR_PRESETS[1]).colors;
  }
  return { id: other.id, config: { name: other.name, colors } };
}

export function usePlayLayer(viewer: Cesium.Viewer | null, route: Route | null): void {
  const playMode = useSettingsStore((s) => s.playMode);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !route || !playMode) {
      usePlayStore.getState().reset();
      return;
    }
    const buddy = resolveBuddy();
    const layer = createCesiumPlayLayer(viewer, route, buddy?.config ?? null);
    let cancelled = false;

    if (buddy) {
      listRides()
        .then((records) => {
          if (!cancelled) layer.setBuddyRide(pickBuddyRide(records, route, buddy.id));
        })
        .catch(() => {
          /* no history: the buddy rides level with you */
        });
    }

    let last = performance.now();
    const onFrame = () => {
      const now = performance.now();
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const s = useRideStore.getState();
      if (s.route !== route) return;
      layer.update({
        elapsedMs: s.elapsedMs,
        dt,
        distanceM: s.distance,
        routeLengthM: route.totalDistance,
        speedMs: s.speed,
        powerW: s.power,
        cadenceRpm: s.cadence,
        gradePct: s.grade,
      });
    };
    viewer.scene.preRender.addEventListener(onFrame);

    return () => {
      cancelled = true;
      if (!viewer.isDestroyed()) viewer.scene.preRender.removeEventListener(onFrame);
      layer.dispose();
    };
  }, [viewer, route, playMode]);
}
