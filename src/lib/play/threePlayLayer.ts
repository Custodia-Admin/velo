/**
 * Play mode on the world renderer: one postcard per named place the route
 * passes (the bundle's POIs, lib/world/routeLandmarks), collected when the
 * rider rides past it.
 *
 * The port of `cesiumPlayLayer` for the three.js worlds. Photoreal routes
 * have no POIs, so that layer spaces its cards evenly; here every postcard
 * is a real place, named on the Finish screen. In the world a postcard is
 * the place's own plain pin, in the accent colour until it is collected
 * (renderers/three/Landmarks reads `pending`): nothing floats as text.
 *
 * Engine-free: no three.js, no Cesium, no React. The renderer calls
 * `update` once per frame; the layer only reads the frame and writes
 * playStore, never the ride store or the trainer.
 */

import type { Route } from '@/types';
import type { WorldPoi } from '@/lib/world/manifest';
import type { ProjectionParams } from '@/lib/world/projection';
import { routeLandmarks } from '@/lib/world/routeLandmarks';
import type { RideFrame, WorldLayer } from '@/lib/world/worldLayer';
import { usePlayStore } from '@/stores/playStore';
import { collectedAt, metresToNext, type Postcard } from './postcards';

/** The "next in" figure updates in steps of this many metres (as on photoreal). */
const TO_NEXT_STEP_M = 50;

export interface PlacePostcard extends Postcard {
  name: string;
  /** Index of the place in the manifest's `pois`. */
  poi: number;
}

/** The postcards for a route: its named places in route order. */
export function postcardsAtPlaces(
  route: Pick<Route, 'points' | 'isLive'>,
  world: { projection: ProjectionParams; pois: readonly WorldPoi[] },
): PlacePostcard[] {
  if (route.isLive) return [];
  return routeLandmarks(route.points, world).map((l, i) => ({
    index: i + 1,
    distanceM: l.distance,
    name: l.name,
    poi: l.poi,
  }));
}

export interface ThreePlayLayer extends WorldLayer {
  readonly postcards: readonly PlacePostcard[];
  /** How many are collected. */
  readonly collected: number;
  /** Is the place with this POI index a postcard not yet collected? */
  pending(poi: number): boolean;
}

export function createThreePlayLayer(
  route: Route,
  world: { projection: ProjectionParams; pois: readonly WorldPoi[] },
): ThreePlayLayer {
  const postcards = postcardsAtPlaces(route, world);
  const byPoi = new Map(postcards.map((c, i) => [c.poi, i]));
  let collected = 0;
  let lastBucket = -1;
  let lastElapsedMs = 0;
  let restoring = true;
  let disposed = false;

  const start = () => {
    collected = 0;
    lastBucket = -1;
    restoring = true;
    const store = usePlayStore.getState();
    store.start(
      postcards.length,
      null,
      postcards.map((c) => c.name),
    );
    store.progress(0, metresToNext(postcards, 0, 0), false);
  };
  start();

  return {
    id: 'three-play',
    postcards,
    get collected() {
      return collected;
    },
    pending(poi) {
      const i = byPoi.get(poi);
      return i !== undefined && i >= collected;
    },
    update(frame: RideFrame) {
      if (disposed || postcards.length === 0) return;
      // The ride clock only runs back when the ride is reset (Ride again): a fresh set of postcards.
      if (frame.elapsedMs < lastElapsedMs) start();
      lastElapsedMs = frame.elapsedMs;
      // Riding past counts, standing on the start line doesn't (a place at 0 m).
      const now = frame.distanceM > 0 ? Math.max(collected, collectedAt(postcards, frame.distanceM)) : collected;
      // A layer rebuilt mid-ride (a remounted canvas) takes back what was already passed, without a pickup.
      const picked = now > collected && !restoring;
      restoring = false;
      collected = now;
      const toNext = metresToNext(postcards, collected, frame.distanceM);
      const bucket = toNext === null ? -2 : Math.ceil(toNext / TO_NEXT_STEP_M);
      if (picked || bucket !== lastBucket) {
        lastBucket = bucket;
        usePlayStore.getState().progress(collected, toNext === null ? null : bucket * TO_NEXT_STEP_M, picked);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      usePlayStore.getState().stop();
    },
  };
}
