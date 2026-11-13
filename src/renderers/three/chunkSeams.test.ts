import { describe, expect, it } from 'vitest';
import { seamCracks, sharedVertices, type ChunkPiece } from './chunkSeams';
import type { ChunkInfo } from './terrainMesh';

const chunk = { centerX: 0, centerZ: 0 } as ChunkInfo;
/** A piece drawing these heights at world (10, 20) and one height at a point of its own. */
const piece = (hs: number[], own: number): ChunkPiece => ({ chunk, positions: [...hs.flatMap((h) => [10, h, -20]), own, 0, -own] });

describe('seam cracks', () => {
  it('none where both pieces draw the same heights', () => {
    expect(seamCracks(sharedVertices([piece([1, 2], 50), piece([1, 2], 60)]))).toEqual([]);
  });

  it('none where one piece draws a subset of the other’s heights (a deck at grade meeting a raised one: no slab underside)', () => {
    const shared = sharedVertices([piece([1, 2], 50), piece([0.4, 1, 2], 60)]);
    expect(shared.some((s) => Math.abs(s.ha - s.hb) > 0.5)).toBe(true);
    expect(seamCracks(shared)).toEqual([]);
    expect(seamCracks(sharedVertices([piece([0.4, 1, 2], 50), piece([1, 2], 60)]))).toEqual([]);
  });

  it('reads a shifted piece’s shift, at grade or raised', () => {
    const shifted = seamCracks(sharedVertices([piece([1, 2], 50), piece([1.5, 2.5], 60)]));
    expect(shifted.length).toBeGreaterThan(0);
    expect(Math.max(...shifted.map((c) => c.gap))).toBeCloseTo(0.5, 5);
    expect(shifted[0]).toMatchObject({ x: 10, y: 20, a: 0, b: 1 });
    const transition = seamCracks(sharedVertices([piece([1.1, 2.1], 50), piece([0.4, 1, 2], 60)]));
    expect(Math.max(...transition.map((c) => c.gap))).toBeCloseTo(0.1, 5);
  });
});
