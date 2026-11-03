/**
 * Live frame-rate and tile-streaming readout for a Cesium viewer.
 *
 * attachScenePerf() hooks scene.postRender (frame times) and the globe's tile
 * queue, samples the shown 3D tilesets twice a second, and publishes a
 * snapshot to:
 *   - subscribers (the `?perf=1` overlay, via useSyncExternalStore), and
 *   - `window.__veloPerf()` — what scripts/perf-ride.py records, so headless
 *     measurements and the overlay read the same numbers.
 */
import type * as Cesium from 'cesium';
import {
  EMPTY_SNAPSHOT,
  EMPTY_TILES,
  FrameStats,
  type FrameSnapshot,
  type TileLoadState,
} from '@/lib/perf/frameStats';

export interface ScenePerf extends FrameSnapshot {
  tiles: TileLoadState;
  /** Drawing-buffer size, px. */
  canvas: [number, number];
  /** viewer.resolutionScale. */
  resolutionScale: number;
  /** window.devicePixelRatio when sampled. */
  dpr: number;
  msaa: number;
  requestRenderMode: boolean;
}

export const EMPTY_PERF: ScenePerf = {
  ...EMPTY_SNAPSHOT,
  tiles: EMPTY_TILES,
  canvas: [0, 0],
  resolutionScale: 1,
  dpr: 1,
  msaa: 1,
  requestRenderMode: false,
};

/** How often the snapshot is rebuilt and published, ms. */
export const PUBLISH_MS = 500;
/**
 * A gap this long between renders is the scene idling (request-render mode,
 * hidden tab), not a slow frame — it's dropped instead of counted.
 */
export const IDLE_GAP_MS = 750;

let current: ScenePerf = EMPTY_PERF;
const listeners = new Set<() => void>();

export function subscribePerf(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getPerfSnapshot(): ScenePerf {
  return current;
}

function publish(next: ScenePerf): void {
  current = next;
  for (const cb of listeners) cb();
}

/**
 * Engine-neutral feed for renderers without a Cesium viewer (the three.js
 * world renderer): publish a snapshot and point `window.__veloPerf` at a
 * getter. `null` detaches and clears the readout.
 */
export function publishScenePerf(next: ScenePerf): void {
  publish(next);
}

export function exposeScenePerf(get: (() => ScenePerf) | null): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __veloPerf?: () => ScenePerf };
  if (get) w.__veloPerf = get;
  else {
    delete w.__veloPerf;
    publish(EMPTY_PERF);
  }
}

interface MinimalTileset {
  show: boolean;
  tilesLoaded?: boolean;
  statistics?: { numberOfPendingRequests?: number; numberOfTilesProcessing?: number };
}

function readTiles(scene: Cesium.Scene, globeQueued: number): TileLoadState {
  let pending = 0;
  let processing = 0;
  let settled = globeQueued === 0;
  const prims = scene.primitives as unknown as { length: number; get(i: number): unknown } | undefined;
  if (prims && typeof prims.length === 'number') {
    for (let i = 0; i < prims.length; i++) {
      const p = prims.get(i) as MinimalTileset | undefined;
      if (!p || !p.statistics || !p.show) continue;
      pending += p.statistics.numberOfPendingRequests ?? 0;
      processing += p.statistics.numberOfTilesProcessing ?? 0;
      if (p.tilesLoaded === false) settled = false;
    }
  }
  if (pending + processing > 0) settled = false;
  return { globeQueued, tilesetPending: pending, tilesetProcessing: processing, settled };
}

/**
 * Start measuring `viewer`. Returns a detach function (call it before the
 * viewer is destroyed). `now` is injectable for tests.
 */
export function attachScenePerf(
  viewer: Cesium.Viewer,
  now: () => number = () => performance.now(),
): () => void {
  const scene = viewer.scene;
  const stats = new FrameStats();
  let last = 0;
  let globeQueued = 0;
  let lastPublish = 0;

  const snapshot = (): ScenePerf => {
    const canvas = scene.canvas as HTMLCanvasElement | undefined;
    return {
      ...stats.snapshot(),
      tiles: readTiles(scene, globeQueued),
      canvas: [canvas?.width ?? 0, canvas?.height ?? 0],
      resolutionScale: viewer.resolutionScale ?? 1,
      dpr: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
      msaa: scene.msaaSamples ?? 1,
      requestRenderMode: scene.requestRenderMode ?? false,
    };
  };

  const onPostRender = () => {
    const t = now();
    if (last > 0) {
      const dt = t - last;
      if (dt < IDLE_GAP_MS) stats.push(dt);
    }
    last = t;
    if (t - lastPublish >= PUBLISH_MS) {
      lastPublish = t;
      publish(snapshot());
    }
  };
  const onTileQueue = (queued: number) => {
    globeQueued = queued;
  };

  scene.postRender.addEventListener(onPostRender);
  scene.globe?.tileLoadProgressEvent?.addEventListener(onTileQueue);

  const w = typeof window !== 'undefined' ? (window as unknown as { __veloPerf?: () => ScenePerf }) : null;
  if (w) w.__veloPerf = () => (viewer.isDestroyed() ? current : snapshot());

  return () => {
    if (!viewer.isDestroyed()) {
      scene.postRender.removeEventListener(onPostRender);
      scene.globe?.tileLoadProgressEvent?.removeEventListener(onTileQueue);
    }
    if (w) delete w.__veloPerf;
    publish(EMPTY_PERF);
  };
}
