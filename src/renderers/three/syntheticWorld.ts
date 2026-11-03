/**
 * A small synthetic world for unit tests (Terrain, Roads, ChaseCamera):
 * 81×41 nodes at 10 m with rolling hills, three roads, Perugia's projection.
 * Never imported by the app.
 */

import { Heightfield } from '@/lib/world/heightfield';
import type { LoadedWorld, RoadsLayer } from '@/lib/world/loadWorld';
import { createProjection } from '@/lib/world/projection';
import { createSceneWorld, type SceneWorld } from './worldScene';

export function syntheticHeightfield(cols = 81, rows = 41): Heightfield {
  const data = new Uint16Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const h = 40 + 25 * Math.sin(c / 9) + 15 * Math.cos(r / 6) + 0.4 * ((c * 7 + r * 13) % 5);
      data[r * cols + c] = Math.round(h * 64);
    }
  }
  return new Heightfield(
    { cols, rows, cellSize: 10, xMin: -400, yMax: 200, heightOffset: 100, heightScale: 1 / 64 },
    data,
  );
}

export const SYNTHETIC_ROADS: RoadsLayer = {
  classes: ['secondary', 'track', 'footway', 'steps'],
  flags: { bridge: 1, tunnel: 2, unpaved: 4, oneway: 8 },
  roads: [
    // East–west through the whole world (crosses every chunk column).
    { cls: 0, width: 7, flags: 0, points: Float32Array.from([-390, 0, 390, 0]) },
    // A gravel track with a bend.
    { cls: 1, width: 3, flags: 4, points: Float32Array.from([-100, -150, -50, -50, 60, 100]) },
    // A bridge.
    { cls: 0, width: 6, flags: 1, points: Float32Array.from([100, -100, 200, -100]) },
    // A tunnel and steps: not drawn.
    { cls: 0, width: 6, flags: 2, points: Float32Array.from([-300, 150, -200, 150]) },
    { cls: 3, width: 2, flags: 0, points: Float32Array.from([0, 100, 10, 110]) },
  ],
};

export function syntheticSceneWorld(): SceneWorld {
  const heightfield = syntheticHeightfield();
  const extent = { xMin: -400, xMax: 400, yMin: -200, yMax: 200 };
  const world = {
    manifest: { id: 'synthetic', extent, defaultMood: 'clear-afternoon' },
    projection: createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 43.1107, lon0: 12.3908, k0: 1 }),
    heightfield,
    roads: SYNTHETIC_ROADS,
    water: { areas: [], lines: [] },
    landcover: { areas: [] },
    buildings: { count: 0, start: new Uint32Array(1), xy: new Float32Array(0), height: new Float32Array(0), kind: new Uint8Array(0) },
    vegetation: { count: 0, x: new Float32Array(0), y: new Float32Array(0), kind: new Uint8Array(0), seed: new Uint8Array(0) },
    routes: [],
  } as unknown as LoadedWorld;
  return createSceneWorld(world);
}
