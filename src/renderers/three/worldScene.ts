/**
 * Per-scene shared state for the world renderer: the loaded world plus what
 * the components derive from it once (chunk plan, road buckets), and the
 * mutable per-frame ride state the driver writes and the rider, camera and
 * sky read. No React here; three.js only for types.
 */

import type { Heightfield } from '@/lib/world/heightfield';
import type { LoadedWorld } from '@/lib/world/loadWorld';
import type { RiderPose } from '@/lib/world/renderer';
import type { RideState } from '@/types';
import type { Vec3 } from './chaseRig';
import { bucketLines, chunkLocator, roadLines, type RibbonLine } from './roadRibbons';
import type { RiderPlacement, WorldGround } from './riderRig';
import { planChunks, type ChunkInfo } from './terrainMesh';
import { waterDepression } from './waterMesh';

/** Road ribbons are densified to this spacing (≈ half a heightfield cell). */
export const ROAD_MAX_SEG_M = 6;

export interface SceneWorld extends WorldGround {
  world: LoadedWorld;
  heightfield: Heightfield;
  chunks: ChunkInfo[];
  locate: (x: number, y: number) => number;
  roadBuckets: RibbonLine[][];
  /** Terrain depression under water polygons, per heightfield node (metres). */
  waterBed: Float32Array;
}

export function createSceneWorld(world: LoadedWorld): SceneWorld {
  const heightfield = world.heightfield;
  const chunks = planChunks(heightfield);
  const locate = chunkLocator(heightfield, chunks);
  const roadBuckets = bucketLines(roadLines(world.roads), locate, chunks.length, ROAD_MAX_SEG_M);
  const waterBed = waterDepression(world.water, heightfield);
  return { world, heightfield, projection: world.projection, chunks, locate, roadBuckets, waterBed };
}

/** Which chunks currently draw their near-LOD terrain (roads follow it). */
export class ChunkVisibility {
  readonly near: Uint8Array;
  version = 0;
  constructor(count: number) {
    this.near = new Uint8Array(count);
  }
  set(i: number, near: boolean) {
    const v = near ? 1 : 0;
    if (this.near[i] !== v) {
      this.near[i] = v;
      this.version++;
    }
  }
  count(): number {
    let n = 0;
    for (const v of this.near) n += v;
    return n;
  }
}

/** What the driver computed for this frame. */
export interface RideFrame {
  valid: boolean;
  pose: RiderPose | null;
  placement: RiderPlacement | null;
  /** Ground point the chase camera aims at (look-ahead along the route). */
  ahead: Vec3;
  /** Smoothed corner lean, radians (+ = right). */
  lean: number;
  cadence: number;
  speed: number;
  rideState: RideState;
  /** Seconds since the previous frame (clamped). */
  dt: number;
  /** Monotonic seconds. */
  timeS: number;
}

export function createRideFrame(): RideFrame {
  return {
    valid: false,
    pose: null,
    placement: null,
    ahead: { x: 0, y: 0, z: 0 },
    lean: 0,
    cadence: 0,
    speed: 0,
    rideState: 'idle',
    dt: 0,
    timeS: 0,
  };
}

/** Ground height under a three.js (x, z) point. */
export function groundAtThree(hf: Heightfield, x: number, z: number): number {
  return hf.sampleHeight(x, -z);
}
