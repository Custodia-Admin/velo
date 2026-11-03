import { describe, expect, it } from 'vitest';
import { Heightfield, decodeHeightDeltas, encodeHeightDeltas, type HeightfieldSpec } from './heightfield';

function makeField(cols: number, rows: number, fn: (c: number, r: number) => number, spec: Partial<HeightfieldSpec> = {}) {
  const data = new Uint16Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) data[r * cols + c] = fn(c, r);
  return new Heightfield({ cols, rows, cellSize: 10, xMin: 0, yMax: 100, heightOffset: 100, heightScale: 0.5, ...spec }, data);
}

describe('Heightfield', () => {
  it('returns node heights exactly at nodes (row 0 = north edge)', () => {
    const hf = makeField(4, 3, (c, r) => c + 10 * r);
    expect(hf.sampleHeight(0, 100)).toBe(100); // node (0,0)
    expect(hf.sampleHeight(30, 100)).toBe(100 + 3 * 0.5);
    expect(hf.sampleHeight(0, 80)).toBe(100 + 20 * 0.5); // node (0,2): south edge
    expect(hf.nodeHeight(2, 1)).toBe(100 + 12 * 0.5);
    expect(hf.nodePosition(2, 1)).toEqual([20, 90]);
    expect(hf.xMax).toBe(30);
    expect(hf.yMin).toBe(80);
  });

  it('interpolates bilinearly inside a cell', () => {
    const hf = makeField(2, 2, (c, r) => [0, 10, 20, 50][r * 2 + c]);
    // Cell centre = mean of the four corners.
    expect(hf.sampleHeight(5, 95)).toBeCloseTo(100 + ((0 + 10 + 20 + 50) / 4) * 0.5, 12);
    // Along the north edge only the top two nodes count.
    expect(hf.sampleHeight(2.5, 100)).toBeCloseTo(100 + 2.5 * 0.5, 12);
  });

  it('clamps positions outside the grid to the nearest edge', () => {
    const hf = makeField(3, 3, (c, r) => c * 2 + r);
    expect(hf.sampleHeight(-50, 100)).toBe(hf.sampleHeight(0, 100));
    expect(hf.sampleHeight(500, -500)).toBe(hf.nodeHeight(2, 2));
    expect(hf.contains(10, 90)).toBe(true);
    expect(hf.contains(-1, 90)).toBe(false);
  });

  it('gives an upward normal tilted against the slope', () => {
    // Height rises 1 m per 10 m eastward (2 units × 0.5 m per column).
    const hf = makeField(5, 5, (c) => c * 2);
    const [nx, ny, nz] = hf.normal(20, 80);
    expect(nx).toBeLessThan(0);
    expect(Math.abs(ny)).toBeLessThan(1e-12);
    expect(nz).toBeGreaterThan(0.99);
    expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 12);
    expect(-nx / nz).toBeCloseTo(0.1, 12);
  });

  it('splits into chunks that share edges and cover every node', () => {
    const hf = makeField(17, 9, () => 0);
    const chunks = hf.chunks(4, 2);
    expect(chunks).toHaveLength(8);
    expect(chunks[0]).toEqual({ c0: 0, r0: 0, c1: 4, r1: 4 });
    expect(chunks[1].c0).toBe(chunks[0].c1); // shared column
    expect(chunks[4].r0).toBe(chunks[0].r1); // shared row
    expect(chunks[7]).toMatchObject({ c1: 16, r1: 8 });
    expect(() => hf.chunks(17, 1)).toThrow(RangeError);
  });

  it('rejects mismatched data and degenerate grids', () => {
    expect(() => new Heightfield({ cols: 3, rows: 3, cellSize: 1, xMin: 0, yMax: 0, heightOffset: 0, heightScale: 1 }, new Uint16Array(8))).toThrow(
      /expected 9/,
    );
    expect(() => new Heightfield({ cols: 1, rows: 3, cellSize: 1, xMin: 0, yMax: 0, heightOffset: 0, heightScale: 1 }, new Uint16Array(3))).toThrow(
      /at least 2×2/,
    );
  });
});

describe('u16-delta encoding', () => {
  it('round-trips, including wrap-around deltas', () => {
    const cols = 7;
    const rows = 5;
    const q = new Uint16Array(cols * rows);
    for (let i = 0; i < q.length; i++) q[i] = (i * 40503 + (i % 3 ? 65535 : 0)) & 0xffff;
    q[0] = 65535;
    q[1] = 0;
    const bytes = encodeHeightDeltas(q, cols, rows);
    expect(bytes.length).toBe(q.length * 2);
    expect(decodeHeightDeltas(bytes, cols, rows)).toEqual(q);
  });

  it('turns smooth terrain into small deltas (what makes it compress)', () => {
    const cols = 64;
    const rows = 64;
    const q = new Uint16Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) q[r * cols + c] = 30000 + c * 3 + r * 2;
    const bytes = encodeHeightDeltas(q, cols, rows);
    let large = 0;
    for (let i = 2; i < bytes.length; i += 2) if (bytes[i + 1] !== 0) large++;
    expect(large).toBe(0);
  });

  it('rejects a payload of the wrong size', () => {
    expect(() => decodeHeightDeltas(new Uint8Array(10), 3, 3)).toThrow(/expected 18/);
  });
});
