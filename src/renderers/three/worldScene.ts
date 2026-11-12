/**
 * Per-scene shared state for the world renderer: the loaded world plus what
 * the components derive from it once (chunk plan, road buckets), and the
 * mutable per-frame ride state the driver writes and the rider, camera and
 * sky read. No React here; three.js only for types.
 */

import type { LaneReach } from '@/lib/ride/partnerSlots';
import type { Heightfield } from '@/lib/world/heightfield';
import type { LoadedWorld } from '@/lib/world/loadWorld';
import type { RiderPose } from '@/lib/world/renderer';
import type { RideState } from '@/types';
import type { Vec3 } from './chaseRig';
import { deckPieces, rideSurface, type DeckPiece } from './bridgeDecks';
import { bucketLines, chunkLocator, roadLines, type RibbonLine } from './roadRibbons';
import type { RiderPlacement, WorldGround } from './riderRig';
import { lodHeightAt, planChunks, type ChunkInfo } from './terrainMesh';
import { levelLakes, waterDepression } from './waterMesh';

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
  /** Bridge decks by road index (bridgeDecks.ts); empty unless the world was baked with bridges. */
  decks: Map<number, DeckPiece>;
}

export function createSceneWorld(world: LoadedWorld): SceneWorld {
  const heightfield = world.heightfield;
  const chunks = planChunks(heightfield);
  const locate = chunkLocator(heightfield, chunks);
  const decks = deckPieces(world);
  const roadBuckets = bucketLines(roadLines(world.roads, decks), locate, chunks.length, ROAD_MAX_SEG_M);
  const waterBed = waterDepression(world.water, heightfield, levelLakes(world));
  return { world, heightfield, projection: world.projection, chunks, locate, roadBuckets, waterBed, decks };
}

/**
 * What a route is ridden on: `ground` (the drawn terrain), except on the
 * bridge decks that route rides, where it is the deck (bridgeDecks.ts).
 */
export function routeSurface(
  sw: Pick<SceneWorld, 'world' | 'heightfield' | 'decks'>,
  routeId: string | undefined,
  ground: (x: number, y: number) => number,
): (x: number, y: number) => number {
  return rideSurface(sw.world, sw.heightfield, routeId, ground, sw.decks);
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
  /**
   * The furthest left and right the rider rides or is heading with the
   * levers as they are, metres right of the line (partnerSlots.laneReach):
   * what the pace partners give way to.
   */
  reach: LaneReach;
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
    reach: { leftM: 0, rightM: 0 },
  };
}

/** Ground height under a three.js (x, z) point. */
export function groundAtThree(hf: Heightfield, x: number, z: number): number {
  return hf.sampleHeight(x, -z);
}

/**
 * Height of the terrain the GPU draws at world (x east, y north): the
 * triangles of the chunk there, at the LOD that chunk shows right now
 * (`lodHeightAt`). The rider, the camera, the road ribbons and the route line
 * all stand on this one surface, so none of them can end up under the ground
 * you see (the bilinear heightfield is up to 0.7 m off the near triangles on
 * the Assisi corridor, and 2.4 m off the far ones). Off the grid it is the
 * heightfield.
 */
export function drawnGround(
  sw: Pick<SceneWorld, 'heightfield' | 'chunks' | 'locate'>,
  visibility: Pick<ChunkVisibility, 'near'>,
  steps: { near: number; far: number },
): (x: number, y: number) => number {
  const hf = sw.heightfield;
  return (x, y) => {
    const i = sw.locate(x, y);
    if (i < 0) return hf.sampleHeight(x, y);
    return lodHeightAt(hf, sw.chunks[i], visibility.near[i] === 1 ? steps.near : steps.far, x, y);
  };
}

/**
 * The terrain as every chunk draws it at LOD `step`: at world (x, y), the
 * triangles of the chunk holding that point (off the grid, the heightfield).
 * What a per-chunk bucket (road ribbons, route line, bridges) drapes on.
 *
 * A bucket draws whole segments, so the end of a segment that crosses a chunk
 * edge lies in the neighbour chunk, and the neighbour's bucket draws that
 * same vertex too. A height that depends only on the point gives it one
 * height in both. Clamping the point into the bucket's own chunk (as
 * `lodHeightAt` does) put it at the chunk-edge height in one bucket and at
 * its true height in the other: a crack across the road, 30 cm at Locarno
 * 3.18 km. Past the edge a vertex lies over the neighbour's triangles at
 * this LOD. A chunk is never further from the camera than any point in it,
 * so within the near radius both chunks at a seam draw `nearStep`.
 */
export function lodGround(
  sw: Pick<SceneWorld, 'heightfield' | 'chunks' | 'locate'>,
  step: number,
): (x: number, y: number) => number {
  const hf = sw.heightfield;
  return (x, y) => {
    const i = sw.locate(x, y);
    if (i < 0) return hf.sampleHeight(x, y);
    return lodHeightAt(hf, sw.chunks[i], step, x, y);
  };
}
