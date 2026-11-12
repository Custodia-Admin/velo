import { describe, expect, it } from 'vitest';

import type { BuildingsLayer } from '@/lib/world/loadWorld';
import { createAtmosphere } from './materials/atmosphere';
import { buildingTriangles, createBuildings, updateBuildings } from './Buildings';
import { footprintBox } from './buildingMesh';
import type { SceneWorld } from './worldScene';

/** An L-shaped house surveyed to the corner: 12 vertices, counter-clockwise, at (x, y). */
const surveyed = (x: number, y: number) => [
  [0, 0], [10, 0], [10.2, 0.4], [20, 0.4], [20, 10], [12, 10], [12, 20], [6, 20], [5.8, 19.6], [0.2, 19.6], [0, 19.6], [0, 10],
].flatMap(([a, b]) => [x + a, y + b]);

/** Three 100 m chunks in a row along x, one 20 m house in the middle of each (squares, or surveyed L's). */
function world(shape: 'square' | 'surveyed' = 'square'): SceneWorld {
  const xy: number[] = [];
  const start = [0];
  for (let c = 0; c < 3; c++) {
    const x = c * 100 + 40;
    const ring = shape === 'square' ? [x, -60, x + 20, -60, x + 20, -40, x, -40] : surveyed(x, -60);
    xy.push(...ring);
    start.push(xy.length / 2);
  }
  const buildings: BuildingsLayer = {
    count: 3,
    start: new Uint32Array(start),
    xy: new Float32Array(xy),
    height: new Float32Array([7, 7, 7]),
    kind: new Uint8Array(3),
    district: new Uint8Array(3),
  };
  const chunks = [0, 1, 2].map((c) => ({ minX: c * 100, maxX: c * 100 + 100, minZ: 0, maxZ: 100, centerX: c * 100 + 50, centerZ: 50 }));
  return {
    world: { buildings },
    chunks,
    locate: (x: number) => Math.min(2, Math.max(0, Math.floor(x / 100))),
    heightfield: { sampleHeight: () => 0 },
  } as unknown as SceneWorld;
}

const shown = (h: ReturnType<typeof createBuildings>) => h.meshes.map((m) => (m ? m.visible : null));
const shownBoxes = (h: ReturnType<typeof createBuildings>) => h.boxes.map((m) => (m ? m.visible : null));

describe('buildings: nearest chunks first, out to buildingM and up to buildingTris', () => {
  it('estimates a chunk at the most its footprints can extrude to, then counts it exactly once built', () => {
    const sw = world();
    const h = createBuildings(sw, createAtmosphere());
    expect(h.tris).toEqual([buildingTriangles(4), buildingTriangles(4), buildingTriangles(4)]);
    updateBuildings(h, sw, 50, 50, 1000, 3, false);
    expect(shown(h)).toEqual([true, true, true]);
    for (const [i, m] of h.meshes.entries()) {
      expect(h.tris[i]).toBe(m!.geometry.getAttribute('position').count / 3);
      expect(h.tris[i]).toBeLessThanOrEqual(buildingTriangles(4));
    }
  });

  it('without a triangle cap it builds everything in range, as before', () => {
    const sw = world();
    const h = createBuildings(sw, createAtmosphere());
    expect(updateBuildings(h, sw, 50, 50, 120, 3, false)).toBe(2);
    expect(shown(h)).toEqual([true, true, null]);
  });

  it('stops at the cap, and hands the share to the chunks the camera rides towards', () => {
    const sw = world();
    const h = createBuildings(sw, createAtmosphere());
    const one = buildingTriangles(4);
    updateBuildings(h, sw, 50, 50, 1000, 3, false, Infinity, one);
    expect(shown(h)).toEqual([true, null, null]);
    // Over chunk 2 now: it builds and shows, chunk 0 hides (kept for the way back).
    h.pendingCheck = 0;
    updateBuildings(h, sw, 250, 50, 1000, 3, false, Infinity, one);
    expect(shown(h)).toEqual([false, null, true]);
    h.pendingCheck = 0;
    updateBuildings(h, sw, 50, 50, 1000, 3, false, Infinity, one);
    expect(shown(h)).toEqual([true, null, false]);
    expect(h.group.children).toHaveLength(2);
  });

  it('always shows the nearest chunk, even one over the cap on its own', () => {
    const sw = world();
    const h = createBuildings(sw, createAtmosphere());
    updateBuildings(h, sw, 150, 50, 1000, 3, false, Infinity, 1);
    expect(shown(h)).toEqual([null, true, null]);
  });
});

describe('buildings: as surveyed near the camera, as boxes past buildingDetailM', () => {
  it("a footprint's box is the rectangle along its longest wall, counter-clockwise, around every corner", () => {
    const pts = [] as [number, number][];
    const ring = surveyed(0, 0);
    for (let i = 0; i < ring.length; i += 2) pts.push([ring[i], ring[i + 1]]);
    const box = footprintBox(pts);
    expect(box).toHaveLength(4);
    const area = box.reduce((a, p, k) => a + p[0] * box[(k + 1) % 4][1] - box[(k + 1) % 4][0] * p[1], 0) / 2;
    expect(area).toBeGreaterThan(0);
    // The longest wall runs along x (10.2 → 20 is 9.8 m; 0 → 10 is 10 m), so the box is the 20 × 20 bounds.
    expect(area).toBeCloseTo(400, 6);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(20 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(20 + 1e-9);
    }
  });

  it('far chunks draw boxes (fewer triangles), near ones the survey, and they swap as the camera rides', () => {
    const sw = world('surveyed');
    const h = createBuildings(sw, createAtmosphere());
    expect(h.tris[0]).toBe(buildingTriangles(12));
    expect(h.boxTris[0]).toBe(buildingTriangles(4));
    updateBuildings(h, sw, 50, 50, 1000, 3, false, Infinity, Infinity, 60);
    expect(shown(h)).toEqual([true, true, null]);
    expect(shownBoxes(h)).toEqual([null, null, true]);
    expect(h.boxTris[2]).toBeLessThan(h.tris[0]);
    expect(h.boxTris[2]).toBeLessThanOrEqual(buildingTriangles(4));
    // Ride to chunk 2: it gets its survey, chunk 0 its boxes.
    h.pendingCheck = 0;
    updateBuildings(h, sw, 250, 50, 1000, 3, false, Infinity, Infinity, 60);
    expect(shown(h)).toEqual([false, true, true]);
    expect(shownBoxes(h)).toEqual([true, null, false]);
  });

  it('while the wanted mesh waits its turn to be built, the chunk keeps showing the one it has', () => {
    const sw = world('surveyed');
    const h = createBuildings(sw, createAtmosphere());
    updateBuildings(h, sw, 250, 50, 1000, 3, false, Infinity, Infinity, 60);
    expect(shownBoxes(h)).toEqual([true, null, null]);
    expect(shown(h)).toEqual([null, true, true]);
    // Back at chunk 0, one build per call: chunk 0's survey comes first (nearest),
    // so chunk 2 shows its survey until its boxes are built on the next call.
    h.pendingCheck = 0;
    updateBuildings(h, sw, 50, 50, 1000, 1, false, Infinity, Infinity, 60);
    expect(shown(h)).toEqual([true, true, true]);
    expect(shownBoxes(h)).toEqual([false, null, null]);
    h.pendingCheck = 0;
    updateBuildings(h, sw, 50, 50, 1000, 1, false, Infinity, Infinity, 60);
    expect(shown(h)).toEqual([true, true, false]);
    expect(shownBoxes(h)).toEqual([false, null, true]);
  });

  it('boxes take the plain far material and stay out of the shadow map; surveyed chunks keep both', () => {
    const sw = world('surveyed');
    const h = createBuildings(sw, createAtmosphere());
    updateBuildings(h, sw, 50, 50, 1000, 3, true, Infinity, Infinity, 60);
    for (const m of [h.meshes[0], h.meshes[1]]) {
      expect(m!.material).toBe(h.material);
      expect([m!.castShadow, m!.receiveShadow]).toEqual([true, true]);
    }
    const box = h.boxes[2]!;
    expect(box.material).toBe(h.farMaterial);
    expect(h.farMaterial).not.toBe(h.material);
    expect([box.castShadow, box.receiveShadow]).toEqual([false, false]);
    // Distinct programs: the far one carries none of the wall detail.
    expect(h.farMaterial.customProgramCacheKey()).not.toBe(h.material.customProgramCacheKey());
  });
});
