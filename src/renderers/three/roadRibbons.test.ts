import { describe, expect, it } from 'vitest';

import { sharedVertices } from './chunkSeams';
import { ROAD_LIFT_M, ROUTE_LIFT_M, ROUTE_WIDTH_M, buildBucket, buildRouteChunks } from './Roads';
import { buildRibbons, bucketLines, chunkLocator, densify, roadLines, ROAD_CLASS_COLORS, type RibbonLine } from './roadRibbons';
import { SYNTHETIC_ROADS, syntheticHeightfield, syntheticSceneWorld } from './syntheticWorld';
import { lodHeightAt, planChunks } from './terrainMesh';
import { ROAD_MAX_SEG_M } from './worldScene';

const hf = syntheticHeightfield();
const opts = { maxSegM: 6, lift: 0.03, originX: 0, originZ: 0 };

/** Ribbon width at vertex pair k (left, right). */
function widthAt(pos: Float32Array, k: number) {
  const l = k * 2;
  const r = l + 1;
  return Math.hypot(pos[r * 3] - pos[l * 3], pos[r * 3 + 2] - pos[l * 3 + 2]);
}

describe('road ribbons', () => {
  it('maps OSM roads to drawable lines: real widths, unpaved gravel, no tunnels or steps', () => {
    const lines = roadLines(SYNTHETIC_ROADS);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.width)).toEqual([7, 3, 6]);
    expect(lines[0].marking).toBe(1);
    expect(lines[1].marking).toBe(0);
    expect(lines[1].color).not.toEqual(ROAD_CLASS_COLORS.secondary);
    expect(lines[2].bridge).toBe(true);
  });

  it('densifies so no segment is longer than the step, keeping the end points', () => {
    const { xy, s } = densify([0, 0, 20, 0, 20, 13], 6);
    for (let i = 1; i < s.length; i++) expect(s[i] - s[i - 1]).toBeLessThanOrEqual(6 + 1e-9);
    expect(s.at(-1)).toBeCloseTo(33);
    expect([xy[xy.length - 2], xy[xy.length - 1]]).toEqual([20, 13]);
  });

  it('builds a strip at the real carriageway width, draped on the heightfield, faces up', () => {
    const line: RibbonLine = { points: [-200, 10, 200, 10], width: 7, color: [0.1, 0.1, 0.1], marking: 7 };
    const g = buildRibbons(hf, [line], opts);
    const pairs = g.vertexCount / 2;
    expect(pairs).toBe(Math.ceil(400 / 6) + 1);
    for (let k = 0; k < pairs; k++) expect(widthAt(g.positions, k)).toBeCloseTo(7, 4);
    for (let v = 0; v < g.vertexCount; v++) {
      const x = g.positions[v * 3];
      const y = -g.positions[v * 3 + 2];
      expect(g.positions[v * 3 + 1]).toBeCloseTo(hf.sampleHeight(x, y) + 0.03, 4);
    }
    expect(g.indices.length).toBe((pairs - 1) * 6);
    for (let t = 0; t < g.indices.length; t += 3) {
      const [i, j, k] = [g.indices[t], g.indices[t + 1], g.indices[t + 2]];
      const p = g.positions;
      const upY = (p[j * 3 + 2] - p[i * 3 + 2]) * (p[k * 3] - p[i * 3]) - (p[j * 3] - p[i * 3]) * (p[k * 3 + 2] - p[i * 3 + 2]);
      expect(upY).toBeGreaterThanOrEqual(0);
    }
    // u runs 0 → 1 across, v is metres along; markings carry the width.
    expect([g.uvs[0], g.uvs[2]]).toEqual([0, 1]);
    expect(g.uvs[g.uvs.length - 1]).toBeCloseTo(400, 3);
    expect(g.markings[0]).toBe(7);
  });

  it('keeps width through a bend (miter join) and spans bridges straight', () => {
    const bend = buildRibbons(hf, [{ points: [-100, -150, -50, -50, 60, 100], width: 3, color: [0, 0, 0], marking: 0 }], opts);
    for (let k = 0; k < bend.vertexCount / 2; k++) expect(widthAt(bend.positions, k)).toBeGreaterThanOrEqual(3 - 1e-3);
    const bridge = buildRibbons(hf, [{ points: [100, -100, 200, -100], width: 6, color: [0, 0, 0], marking: 0, bridge: true }], opts);
    const h0 = hf.sampleHeight(100, -100) + 0.03;
    const h1 = hf.sampleHeight(200, -100) + 0.03;
    const n = bridge.vertexCount / 2;
    for (let k = 0; k < n; k++) {
      const t = bridge.uvs[k * 4 + 1] / 100;
      expect(bridge.positions[k * 6 + 1]).toBeCloseTo(h0 + (h1 - h0) * t, 3);
    }
  });

  it('buckets by chunk so every densified segment is built exactly once', () => {
    const chunks = planChunks(hf);
    const locate = chunkLocator(hf, chunks);
    const lines = roadLines(SYNTHETIC_ROADS);
    const buckets = bucketLines(lines, locate, chunks.length, 6);
    // The east–west road crosses all 8 chunk columns of its row.
    expect(buckets.filter((b) => b.includes(lines[0])).length).toBe(8);
    let triangles = 0;
    buckets.forEach((b, i) => {
      triangles += buildRibbons(hf, b, { ...opts, keepSegment: (mx, my) => locate(mx, my) === i }).indices.length / 3;
    });
    const whole = buildRibbons(hf, lines, opts).indices.length / 3;
    expect(triangles).toBe(whole);
  });

  it('locates world points in planChunks order', () => {
    const sw = syntheticSceneWorld();
    for (const c of sw.chunks) {
      const x = c.centerX;
      const y = -c.centerZ;
      expect(sw.locate(x, y)).toBe(c.index);
    }
    expect(sw.locate(-10_000, 0)).toBe(-1);
  });
});

describe('chunk seams', () => {
  // A road climbing obliquely across the chunk edge x = −200, where the
  // synthetic hills fall ~17 % to the east. Each bucket draws whole segments,
  // so the vertices of the segments either side of the edge are drawn by
  // both the west and the east bucket, some of them metres past the edge.
  const sw = syntheticSceneWorld();
  const hf = sw.heightfield;
  const points = [-240, 12, -164, 38];
  const west = sw.locate(-210, 20);
  const east = sw.locate(-190, 20);
  const drawnAt = (step: number, x: number, y: number) => lodHeightAt(hf, sw.chunks[sw.locate(x, y)], step, x, y);
  /** The crack the shared vertices had while each bucket clamped them into its own chunk. */
  const clampedCrack = (shared: { x: number; y: number }[], step: number) =>
    Math.max(...shared.map((s) => Math.abs(lodHeightAt(hf, sw.chunks[west], step, s.x, s.y) - lodHeightAt(hf, sw.chunks[east], step, s.x, s.y))));

  it('a graded road straddling a chunk edge: both buckets give every vertex they share one height, on the drawn triangles', () => {
    const line: RibbonLine = { points, width: 7, color: [0.3, 0.3, 0.3], marking: 1 };
    const roadBuckets = bucketLines([line], sw.locate, sw.chunks.length, ROAD_MAX_SEG_M);
    expect(roadBuckets[west]).toContain(line);
    expect(roadBuckets[east]).toContain(line);
    const scene = { ...sw, roadBuckets };
    for (const step of [1, 2]) {
      const [a, b] = [west, east].map((i) => ({ chunk: sw.chunks[i], data: buildBucket(scene, i, step) }));
      const shared = sharedVertices([
        { chunk: a.chunk, positions: a.data.positions },
        { chunk: b.chunk, positions: b.data.positions },
      ]);
      // The vertex pair either side of the edge, at least one corner a metre or more past it.
      expect(shared.length, `step ${step}`).toBeGreaterThanOrEqual(2);
      expect(Math.max(...shared.map((s) => Math.abs(s.x + 200))), `step ${step}`).toBeGreaterThan(1);
      // The fixture is graded: clamped into each bucket's own chunk, these
      // vertices stood a crack apart (Locarno 3.19 km: 10–11 cm).
      expect(clampedCrack(shared, step), `step ${step}`).toBeGreaterThan(0.1);
      for (const s of shared) expect(Math.abs(s.ha - s.hb), `step ${step} at ${s.x.toFixed(2)}, ${s.y.toFixed(2)}`).toBeLessThanOrEqual(0.001);
      // Every vertex either bucket draws sits on the triangles drawn under it.
      for (const p of [a, b])
        for (let v = 0; v < p.data.vertexCount; v++) {
          const x = p.data.positions[v * 3] + p.chunk.centerX;
          const y = -(p.data.positions[v * 3 + 2] + p.chunk.centerZ);
          expect(p.data.positions[v * 3 + 1]).toBeCloseTo(drawnAt(step, x, y) + ROAD_LIFT_M, 4);
        }
    }
  });

  it('the route guide across the same edge: near and far pieces both agree on their shared vertices', () => {
    const line: RibbonLine = { points, width: ROUTE_WIDTH_M, color: [1, 0, 0], marking: 0 };
    for (const steps of [
      { near: 1, far: 4 },
      { near: 2, far: 8 },
    ]) {
      const pieces = buildRouteChunks(sw, line, steps);
      const [pw, pe] = [west, east].map((i) => pieces.find((p) => p.chunk === i)!);
      expect(pw && pe).toBeTruthy();
      for (const lod of ['near', 'far'] as const) {
        const shared = sharedVertices([
          { chunk: sw.chunks[west], positions: pw[lod].positions },
          { chunk: sw.chunks[east], positions: pe[lod].positions },
        ]);
        expect(shared.length, `${lod} ${steps[lod]}`).toBeGreaterThanOrEqual(2);
        expect(clampedCrack(shared, steps[lod]), `${lod} ${steps[lod]}`).toBeGreaterThan(0.05);
        for (const s of shared) expect(Math.abs(s.ha - s.hb), `${lod} ${steps[lod]}`).toBeLessThanOrEqual(0.001);
        for (const s of shared) expect(s.ha).toBeCloseTo(drawnAt(steps[lod], s.x, s.y) + ROUTE_LIFT_M, 4);
      }
    }
  });
});
