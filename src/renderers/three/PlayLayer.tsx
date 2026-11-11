/**
 * Play mode on the world renderer: mounts the postcard layer
 * (lib/play/threePlayLayer) while the active rider has Play mode on, steps
 * it once per frame from the ride store, and hands the Landmarks pins which
 * places are postcards still to collect. Draws nothing itself: a postcard is
 * the place's own plain pin.
 */

import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';

import { createThreePlayLayer, type ThreePlayLayer } from '@/lib/play/threePlayLayer';
import { usePlayStore } from '@/stores/playStore';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Route } from '@/types';
import type { SceneWorld } from './worldScene';

/** What the pins read: is the place with this POI index a postcard still to collect? */
export interface PostcardPins {
  pending: (poi: number) => boolean;
}

export function createPostcardPins(): PostcardPins {
  return { pending: () => false };
}

export function PlayLayer({ sceneWorld, route, pins }: { sceneWorld: SceneWorld; route: Route; pins: PostcardPins }) {
  const playMode = useSettingsStore((s) => s.playMode);
  const layerRef = useRef<ThreePlayLayer | null>(null);

  useEffect(() => {
    if (!playMode) {
      usePlayStore.getState().reset();
      return;
    }
    const { manifest } = sceneWorld.world;
    const layer = createThreePlayLayer(route, { projection: manifest.projection, pois: manifest.pois });
    layerRef.current = layer;
    pins.pending = (poi) => layer.pending(poi);
    return () => {
      if (layerRef.current === layer) layerRef.current = null;
      pins.pending = () => false;
      layer.dispose();
    };
  }, [playMode, route, sceneWorld, pins]);

  useFrame((_, delta) => {
    const layer = layerRef.current;
    if (!layer) return;
    const s = useRideStore.getState();
    if (s.route !== route) return;
    layer.update({
      elapsedMs: s.elapsedMs,
      dt: Math.min(0.25, Math.max(0, delta)),
      distanceM: s.distance,
      routeLengthM: route.totalDistance,
      speedMs: s.speed,
      powerW: s.power,
      cadenceRpm: s.cadence,
      gradePct: s.grade,
    });
  });

  return null;
}
