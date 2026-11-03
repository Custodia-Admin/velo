// DEM → world heightfield grid (float metres), then 16-bit quantisation and
// the `u16-delta` byte stream described in docs/worlds/WORLD-FORMAT.md.

import { encodeHeightDeltas, Heightfield } from '../../src/lib/world/heightfield.ts';

/** Sample the DEM at every grid node (node (c, r) = xMin + c·cell, yMax − r·cell). */
export function sampleGrid({ grid, projection, dem }) {
  const { cols, rows, cellSize, xMin, yMax } = grid;
  const heights = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const y = yMax - r * cellSize;
    for (let c = 0; c < cols; c++) {
      const [lat, lon] = projection.inverse(xMin + c * cellSize, y);
      heights[r * cols + c] = dem.sample(lat, lon);
    }
  }
  return heights;
}

/**
 * Pick a power-of-two height step (finest that fits the range in 16 bits)
 * and an integer offset, then round every node. Power-of-two steps keep the
 * decode arithmetic exact.
 */
export function quantize(heights) {
  let min = Infinity;
  let max = -Infinity;
  for (const h of heights) {
    if (h < min) min = h;
    if (h > max) max = h;
  }
  const heightOffset = Math.floor(min) - 1;
  let heightScale = 1 / 64;
  while ((max - heightOffset) / heightScale > 65000) heightScale *= 2;
  const q = new Uint16Array(heights.length);
  for (let i = 0; i < heights.length; i++) {
    q[i] = Math.round((heights[i] - heightOffset) / heightScale);
  }
  return { q, heightOffset, heightScale };
}

export function buildHeightfield({ grid, heights }) {
  const { q, heightOffset, heightScale } = quantize(heights);
  const hf = new Heightfield(
    { cols: grid.cols, rows: grid.rows, cellSize: grid.cellSize, xMin: grid.xMin, yMax: grid.yMax, heightOffset, heightScale },
    q,
  );
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (const v of q) {
    const h = heightOffset + v * heightScale;
    if (h < minHeight) minHeight = h;
    if (h > maxHeight) maxHeight = h;
  }
  return {
    hf,
    bytes: encodeHeightDeltas(q, grid.cols, grid.rows),
    info: {
      cols: grid.cols,
      rows: grid.rows,
      cellSize: grid.cellSize,
      encoding: 'u16-delta',
      heightOffset,
      heightScale,
      minHeight,
      maxHeight,
    },
  };
}
