import { describe, expect, it } from 'vitest';

import { buildRibbons, bucketLines, chunkLocator, densify, roadLines, ROAD_CLASS_COLORS, type RibbonLine } from './roadRibbons';
import { SYNTHETIC_ROADS, syntheticHeightfield, syntheticSceneWorld } from './syntheticWorld';
import { planChunks } from './terrainMesh';

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
