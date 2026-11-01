// World bundle loader (plain-JS port of src/lib/world/{heightfield,loadWorld}.ts
// decoding, without hash checks). World (x, y, h) maps to three.js (x, h, -y).

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  let bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return bytes;
}

async function fetchJson(url) {
  return JSON.parse(new TextDecoder().decode(await fetchBytes(url)));
}

export class Heightfield {
  constructor(hf, extent, heights) {
    this.cols = hf.cols;
    this.rows = hf.rows;
    this.cell = hf.cellSize;
    this.xMin = extent.xMin;
    this.yMax = extent.yMax;
    this.xMax = extent.xMin + (hf.cols - 1) * hf.cellSize;
    this.yMin = extent.yMax - (hf.rows - 1) * hf.cellSize;
    this.h = heights; // Float32Array, row 0 = north
  }
  node(c, r) {
    c = Math.max(0, Math.min(this.cols - 1, c));
    r = Math.max(0, Math.min(this.rows - 1, r));
    return this.h[r * this.cols + c];
  }
  sample(x, y) {
    let fc = (x - this.xMin) / this.cell;
    let fr = (this.yMax - y) / this.cell;
    fc = Math.max(0, Math.min(this.cols - 1, fc));
    fr = Math.max(0, Math.min(this.rows - 1, fr));
    const c0 = Math.min(this.cols - 2, Math.floor(fc));
    const r0 = Math.min(this.rows - 2, Math.floor(fr));
    const tx = fc - c0;
    const ty = fr - r0;
    const i = r0 * this.cols + c0;
    const a = this.h[i], b = this.h[i + 1], c = this.h[i + this.cols], d = this.h[i + this.cols + 1];
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
  }
  inside(x, y, m = 0) {
    return x >= this.xMin + m && x <= this.xMax - m && y >= this.yMin + m && y <= this.yMax - m;
  }
}

function decodeHeights(bytes, hf) {
  const { cols, rows, heightOffset, heightScale } = hf;
  const out = new Float32Array(cols * rows);
  let rowStart = 0;
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    let o = base * 2;
    rowStart = (rowStart + (bytes[o] | (bytes[o + 1] << 8))) & 0xffff;
    let v = rowStart;
    out[base] = heightOffset + v * heightScale;
    for (let c = 1; c < cols; c++) {
      o += 2;
      v = (v + (bytes[o] | (bytes[o + 1] << 8))) & 0xffff;
      out[base + c] = heightOffset + v * heightScale;
    }
  }
  return out;
}

function decodeBuildings(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = v.getUint32(4, true);
  const totalVerts = v.getUint32(8, true);
  const head = 12;
  const meta = count * 5;
  const pad = (4 - ((head + meta) % 4)) % 4;
  const start = new Uint32Array(count + 1);
  const height = new Float32Array(count);
  const kind = new Uint8Array(count);
  let o = head;
  for (let i = 0; i < count; i++, o += 2) start[i + 1] = start[i] + v.getUint16(o, true);
  for (let i = 0; i < count; i++, o += 2) height[i] = v.getUint16(o, true) / 10;
  for (let i = 0; i < count; i++, o += 1) kind[i] = bytes[o];
  o += pad;
  const xy = new Float32Array(totalVerts * 2);
  let d = head + meta + pad + count * 8;
  for (let i = 0; i < count; i++, o += 8) {
    let x = v.getInt32(o, true);
    let y = v.getInt32(o + 4, true);
    let k = start[i] * 2;
    xy[k++] = x / 10;
    xy[k++] = y / 10;
    for (let j = start[i] + 1; j < start[i + 1]; j++, d += 4) {
      x += v.getInt16(d, true);
      y += v.getInt16(d + 2, true);
      xy[k++] = x / 10;
      xy[k++] = y / 10;
    }
  }
  return { count, start, xy, height, kind };
}

function decodeVegetation(bytes, extent) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = v.getUint32(4, true);
  const quantum = v.getFloat32(8, true);
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  let o = 16;
  for (let i = 0; i < count; i++, o += 2) x[i] = extent.xMin + v.getUint16(o, true) * quantum;
  for (let i = 0; i < count; i++, o += 2) y[i] = extent.yMin + v.getUint16(o, true) * quantum;
  const kind = bytes.slice(o, o + count);
  const seed = bytes.slice(o + count, o + 2 * count);
  return { count, x, y, kind, seed };
}

export async function loadWorld(base) {
  const manifest = await fetchJson(base + 'manifest.json');
  const L = manifest.layers;
  const [hBytes, roads, water, landcover, bBytes, vBytes, routes] = await Promise.all([
    fetchBytes(base + manifest.heightfield.file),
    fetchJson(base + L.roads),
    fetchJson(base + L.water),
    fetchJson(base + L.landcover),
    fetchBytes(base + L.buildings),
    fetchBytes(base + L.vegetation),
    fetchJson(base + L.routes),
  ]);
  const hf = new Heightfield(manifest.heightfield, manifest.extent, decodeHeights(hBytes, manifest.heightfield));
  return {
    manifest,
    hf,
    roads,
    water,
    landcover,
    buildings: decodeBuildings(bBytes),
    vegetation: decodeVegetation(vBytes, manifest.extent),
    routes: routes.routes,
  };
}

/** Point + unit tangent on a route at distance s (metres). */
export function routeAt(route, s) {
  const n = route.s.length;
  const step = route.stepM;
  let i = Math.max(0, Math.min(n - 2, Math.floor(s / step)));
  while (i < n - 2 && route.s[i + 1] < s) i++;
  while (i > 0 && route.s[i] > s) i--;
  const t = Math.max(0, Math.min(1, (s - route.s[i]) / (route.s[i + 1] - route.s[i] || 1)));
  const x = route.x[i] + (route.x[i + 1] - route.x[i]) * t;
  const y = route.y[i] + (route.y[i + 1] - route.y[i]) * t;
  // smoothed tangent over +-15 m
  const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 3);
  let dx = route.x[b] - route.x[a], dy = route.y[b] - route.y[a];
  const l = Math.hypot(dx, dy) || 1;
  return { x, y, dx: dx / l, dy: dy / l };
}

/** Deterministic PRNG. */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cheap 2D value-noise hash in [0,1). */
export function hash2(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x, y, oct = 5) {
  let s = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) {
    s += amp * vnoise(x * f + i * 17.3, y * f - i * 9.1);
    f *= 2.03; amp *= 0.5;
  }
  return s / (1 - Math.pow(0.5, oct));
}
