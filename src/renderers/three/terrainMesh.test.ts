import { describe, expect, it } from 'vitest';

import { syntheticHeightfield } from './syntheticWorld';
import {
  CHUNKS_X,
  CHUNKS_Y,
  LOD_HYSTERESIS_M,
  buildChunkGeometry,
  chunkLod,
  distanceToChunk,
  meshHeightAt,
  planChunks,
  sampledNodes,
} from './terrainMesh';

describe('terrain chunking', () => {
  const hf = syntheticHeightfield();
  const chunks = planChunks(hf);

  it('splits the grid into 8×8 chunks that tile it with shared edges', () => {
    expect(chunks).toHaveLength(CHUNKS_X * CHUNKS_Y);
    expect(chunks[0].range.c0).toBe(0);
    expect(chunks[0].range.r0).toBe(0);
    expect(chunks.at(-1)!.range.c1).toBe(hf.spec.cols - 1);
    expect(chunks.at(-1)!.range.r1).toBe(hf.spec.rows - 1);
    for (let j = 0; j < CHUNKS_Y; j++) {
      for (let i = 0; i < CHUNKS_X - 1; i++) {
        expect(chunks[j * CHUNKS_X + i].range.c1).toBe(chunks[j * CHUNKS_X + i + 1].range.c0);
      }
    }
  });

  it('chunk bounds are three.js x/z (z = −north) and hold every node height', () => {
    const c = chunks[0];
    const [x0, y0] = hf.nodePosition(c.range.c0, c.range.r0);
    expect(c.minX).toBe(x0);
    expect(c.minZ).toBe(-y0);
    expect(c.maxZ).toBeGreaterThan(c.minZ);
    for (let r = c.range.r0; r <= c.range.r1; r++) {
      for (let col = c.range.c0; col <= c.range.c1; col++) {
        const h = hf.nodeHeight(col, r);
        expect(h).toBeGreaterThanOrEqual(c.minH);
        expect(h).toBeLessThanOrEqual(c.maxH);
      }
    }
  });

  it('samples every step and always ends on the shared edge node', () => {
    expect(sampledNodes(0, 10, 4)).toEqual([0, 4, 8, 10]);
    expect(sampledNodes(5, 9, 1)).toEqual([5, 6, 7, 8, 9]);
    expect(sampledNodes(0, 8, 4)).toEqual([0, 4, 8]);
  });

  it('near and far LODs agree on the shared chunk edge (no cracks), skirts hang below', () => {
    const a = chunks[0];
    const b = chunks[1];
    const nearA = buildChunkGeometry(hf, a, 1);
    const farB = buildChunkGeometry(hf, b, 4);
    // East edge of A (local x + centre) vs west edge of B, at every far-LOD node.
    const edgeHeights = (g: typeof nearA, centerX: number, x: number) => {
      const out = new Map<number, number>();
      for (let v = 0; v < g.gridVertices; v++) {
        if (Math.abs(g.positions[v * 3] + centerX - x) < 1e-3) out.set(Math.round(g.positions[v * 3 + 2]), g.positions[v * 3 + 1]);
      }
      return out;
    };
    const ex = a.maxX;
    const ha = edgeHeights(nearA, a.centerX, ex);
    const hb = edgeHeights(farB, b.centerX, ex);
    expect(hb.size).toBeGreaterThan(1);
    for (const [z, h] of hb) expect(ha.get(z)).toBeCloseTo(h, 5);
    // Skirt vertices sit below their edge vertex.
    const skirt0 = nearA.gridVertices;
    expect(nearA.positions[skirt0 * 3 + 1]).toBeLessThan(nearA.positions[1]);
  });

  it('the near LOD has every node, the far LOD a quarter per axis; triangles face up', () => {
    const c = chunks[9];
    const near = buildChunkGeometry(hf, c, 1);
    const far = buildChunkGeometry(hf, c, 4);
    expect(near.cols).toBe(c.range.c1 - c.range.c0 + 1);
    expect(far.cols).toBe(Math.ceil((c.range.c1 - c.range.c0) / 4) + 1);
    expect(far.gridVertices).toBeLessThan(near.gridVertices);
    const p = near.positions;
    const surfaceTris = (near.cols - 1) * (near.rows - 1) * 2;
    for (let t = 0; t < surfaceTris; t++) {
      const [i, j, k] = [near.indices[t * 3], near.indices[t * 3 + 1], near.indices[t * 3 + 2]];
      const ax = p[j * 3] - p[i * 3];
      const az = p[j * 3 + 2] - p[i * 3 + 2];
      const bx = p[k * 3] - p[i * 3];
      const bz = p[k * 3 + 2] - p[i * 3 + 2];
      expect(az * bx - ax * bz).toBeGreaterThan(0);
    }
    for (let v = 0; v < near.gridVertices; v++) expect(near.normals[v * 3 + 1]).toBeGreaterThan(0.5);
  });

  it('the near mesh matches the bilinear ground at every node and stays close in between', () => {
    for (let k = 0; k < 200; k++) {
      const x = -400 + ((k * 37) % 800) + 0.37;
      const y = 200 - ((k * 53) % 400) - 0.61;
      const gap = Math.abs(meshHeightAt(hf, x, -y) - hf.sampleHeight(x, y));
      expect(gap).toBeLessThan(1.5);
    }
    const [nx, ny] = hf.nodePosition(12, 7);
    expect(meshHeightAt(hf, nx, -ny)).toBeCloseTo(hf.nodeHeight(12, 7), 6);
  });

  it('picks near within the radius, with hysteresis on the way out', () => {
    const c = chunks[0];
    const inside = { x: c.centerX, z: c.centerZ };
    expect(distanceToChunk(c, inside.x, inside.z)).toBe(0);
    expect(chunkLod(c, inside.x, inside.z, 100)).toBe('near');
    const justOut = c.maxX + 100 + LOD_HYSTERESIS_M / 2;
    expect(chunkLod(c, justOut, c.centerZ, 100)).toBe('far');
    expect(chunkLod(c, justOut, c.centerZ, 100, 'near')).toBe('near');
    expect(chunkLod(c, c.maxX + 100 + LOD_HYSTERESIS_M + 1, c.centerZ, 100, 'near')).toBe('far');
  });
});
