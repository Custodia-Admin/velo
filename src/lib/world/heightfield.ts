/**
 * World heightfield: a node-registered grid of 16-bit heights.
 *
 * Grid layout (see docs/worlds/WORLD-FORMAT.md): `cols × rows` nodes, node
 * (c, r) sits at x = xMin + c·cellSize, y = yMax − r·cellSize (row 0 is the
 * north edge). Height in metres = heightOffset + q·heightScale.
 *
 * `sampleHeight` is THE ground: the bake computes every route's render
 * elevation with this exact function, so the rider sits on the terrain to
 * the last bit. Renderers that triangulate the grid should split each cell so
 * the mesh matches bilinear sampling closely, or sample this for the rider.
 *
 * Shared with the bake via Node type stripping: no imports, erasable syntax.
 */

export interface HeightfieldSpec {
  cols: number;
  rows: number;
  /** Node spacing, metres. */
  cellSize: number;
  /** World x of column 0, metres. */
  xMin: number;
  /** World y of row 0 (north edge), metres. */
  yMax: number;
  heightOffset: number;
  heightScale: number;
}

export interface ChunkRange {
  /** First node column/row (inclusive). Neighbouring chunks share their edge nodes. */
  c0: number;
  r0: number;
  /** Last node column/row (inclusive). */
  c1: number;
  r1: number;
}

export class Heightfield {
  readonly spec: Readonly<HeightfieldSpec>;
  readonly data: Uint16Array;
  readonly xMax: number;
  readonly yMin: number;

  constructor(spec: HeightfieldSpec, data: Uint16Array) {
    if (!Number.isInteger(spec.cols) || !Number.isInteger(spec.rows) || spec.cols < 2 || spec.rows < 2) {
      throw new RangeError(`heightfield needs at least 2×2 nodes, got ${spec.cols}×${spec.rows}`);
    }
    if (data.length !== spec.cols * spec.rows) {
      throw new RangeError(`heightfield data has ${data.length} nodes, expected ${spec.cols * spec.rows}`);
    }
    if (!(spec.cellSize > 0) || !(spec.heightScale > 0)) {
      throw new RangeError('heightfield cellSize and heightScale must be positive');
    }
    this.spec = { ...spec };
    this.data = data;
    this.xMax = spec.xMin + (spec.cols - 1) * spec.cellSize;
    this.yMin = spec.yMax - (spec.rows - 1) * spec.cellSize;
  }

  /** Height of node (c, r), metres. */
  nodeHeight(c: number, r: number): number {
    const { cols, rows, heightOffset, heightScale } = this.spec;
    const cc = c < 0 ? 0 : c >= cols ? cols - 1 : c;
    const rr = r < 0 ? 0 : r >= rows ? rows - 1 : r;
    return heightOffset + this.data[rr * cols + cc] * heightScale;
  }

  /** World position of node (c, r). */
  nodePosition(c: number, r: number): [number, number] {
    return [this.spec.xMin + c * this.spec.cellSize, this.spec.yMax - r * this.spec.cellSize];
  }

  /** True when (x, y) lies on the grid (edges included). */
  contains(x: number, y: number): boolean {
    return x >= this.spec.xMin && x <= this.xMax && y >= this.yMin && y <= this.spec.yMax;
  }

  /**
   * Bilinear ground height at world (x, y), metres. Positions off the grid
   * clamp to the nearest edge.
   */
  sampleHeight(x: number, y: number): number {
    const { cols, rows, cellSize, xMin, yMax, heightOffset, heightScale } = this.spec;
    let fx = (x - xMin) / cellSize;
    let fy = (yMax - y) / cellSize;
    if (fx < 0) fx = 0;
    else if (fx > cols - 1) fx = cols - 1;
    if (fy < 0) fy = 0;
    else if (fy > rows - 1) fy = rows - 1;
    let c = Math.floor(fx);
    let r = Math.floor(fy);
    if (c > cols - 2) c = cols - 2;
    if (r > rows - 2) r = rows - 2;
    const tx = fx - c;
    const ty = fy - r;
    const i = r * cols + c;
    const d = this.data;
    const top = d[i] + (d[i + 1] - d[i]) * tx;
    const bottom = d[i + cols] + (d[i + cols + 1] - d[i + cols]) * tx;
    return heightOffset + (top + (bottom - top) * ty) * heightScale;
  }

  /** Unit surface normal at (x, y) as [nx east, ny north, nz up] (central differences). */
  normal(x: number, y: number): [number, number, number] {
    const h = this.spec.cellSize;
    const dx = (this.sampleHeight(x + h, y) - this.sampleHeight(x - h, y)) / (2 * h);
    const dy = (this.sampleHeight(x, y + h) - this.sampleHeight(x, y - h)) / (2 * h);
    const len = Math.sqrt(dx * dx + dy * dy + 1);
    return [-dx / len, -dy / len, 1 / len];
  }

  /**
   * Split the grid into `nx × ny` chunks of near-equal size. Chunks share
   * their boundary nodes so neighbouring meshes meet without cracks.
   */
  chunks(nx: number, ny: number): ChunkRange[] {
    const { cols, rows } = this.spec;
    if (nx < 1 || ny < 1 || nx > cols - 1 || ny > rows - 1) {
      throw new RangeError(`cannot split ${cols}×${rows} nodes into ${nx}×${ny} chunks`);
    }
    const out: ChunkRange[] = [];
    for (let j = 0; j < ny; j++) {
      const r0 = Math.round((j * (rows - 1)) / ny);
      const r1 = Math.round(((j + 1) * (rows - 1)) / ny);
      for (let i = 0; i < nx; i++) {
        const c0 = Math.round((i * (cols - 1)) / nx);
        const c1 = Math.round(((i + 1) * (cols - 1)) / nx);
        out.push({ c0, r0, c1, r1 });
      }
    }
    return out;
  }
}

/**
 * `u16-delta` decoding: each row stores its first node as a delta from the
 * previous row's first node, every other node as a delta from its left
 * neighbour, all modulo 2^16, little-endian. Prefix sums restore the grid.
 */
export function decodeHeightDeltas(bytes: Uint8Array, cols: number, rows: number): Uint16Array {
  const n = cols * rows;
  if (bytes.byteLength !== n * 2) {
    throw new RangeError(`height payload is ${bytes.byteLength} bytes, expected ${n * 2}`);
  }
  const out = new Uint16Array(n);
  let rowStart = 0;
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    let o = base * 2;
    rowStart = (rowStart + (bytes[o] | (bytes[o + 1] << 8))) & 0xffff;
    let v = rowStart;
    out[base] = v;
    for (let c = 1; c < cols; c++) {
      o += 2;
      v = (v + (bytes[o] | (bytes[o + 1] << 8))) & 0xffff;
      out[base + c] = v;
    }
  }
  return out;
}

/** Inverse of `decodeHeightDeltas` (used by the bake and by tests). */
export function encodeHeightDeltas(q: Uint16Array, cols: number, rows: number): Uint8Array {
  if (q.length !== cols * rows) throw new RangeError('grid size mismatch');
  const out = new Uint8Array(q.length * 2);
  let prevRowStart = 0;
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    for (let c = 0; c < cols; c++) {
      const prev = c === 0 ? prevRowStart : q[base + c - 1];
      const d = (q[base + c] - prev) & 0xffff;
      out[(base + c) * 2] = d & 0xff;
      out[(base + c) * 2 + 1] = d >> 8;
    }
    prevRowStart = q[base];
  }
  return out;
}
