// Shared helpers for the world bake: cached fetches, hashing, deterministic
// gzip, a seeded RNG and a minimal PNG decoder (terrarium tiles are 8-bit RGB).
// No npm dependencies: the bake runs with plain `node` on the bake host.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync, inflateSync, constants as zc, brotliCompressSync } from 'node:zlib';

export const USER_AGENT = 'velo-worldbake/1 (+https://github.com/Custodia-Admin/velo)';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

/** Write atomically so an interrupted bake never leaves half a cache entry. */
export function writeFileAtomic(path, data) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/**
 * GET/POST with an on-disk cache keyed by `key` (stable across runs).
 * Returns a Buffer. Retries 429/5xx and network errors with backoff.
 */
export async function cachedFetch(cacheDir, key, url, init = {}, { retries = 6, label = url } = {}) {
  const file = join(cacheDir, key);
  if (existsSync(file)) return { body: readFileSync(file), cached: true };
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) },
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${label}: HTTP ${res.status}`);
      } else if (!res.ok) {
        throw Object.assign(new Error(`${label}: HTTP ${res.status}`), { fatal: true });
      } else {
        const body = Buffer.from(await res.arrayBuffer());
        writeFileAtomic(file, body);
        return { body, cached: false };
      }
    } catch (err) {
      if (err.fatal) throw err;
      lastErr = err;
    }
    await sleep(Math.min(60_000, 2000 * 2 ** attempt));
  }
  throw lastErr;
}

/** gzip with fixed settings; Node writes mtime 0, so equal input → equal bytes. */
export function gzip(buf) {
  return gzipSync(buf, { level: 9, memLevel: 9, strategy: zc.Z_DEFAULT_STRATEGY });
}

export function brotliSize(buf) {
  return brotliCompressSync(buf, {
    params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_SIZE_HINT]: buf.length },
  }).length;
}

/** mulberry32: tiny seeded PRNG, identical on every platform. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit integer hash (for per-lattice-cell jitter). */
export function hash32(a, b, seed = 0) {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Stable JSON: object keys in insertion order (we build objects deterministically). */
export function stableJson(value) {
  return Buffer.from(JSON.stringify(value));
}

/** Decode an 8-bit, non-interlaced RGB/RGBA PNG → { width, height, channels, pixels }. */
export function decodePng(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('not a PNG');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG (depth ${bitDepth}, colour ${colorType}, interlace ${interlace})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= channels ? pixels[dst + x - channels] : 0;
      const b = y > 0 ? pixels[dst - stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[dst - stride + x - channels] : 0;
      let p;
      switch (filter) {
        case 0: p = v; break;
        case 1: p = v + a; break;
        case 2: p = v + b; break;
        case 3: p = v + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      pixels[dst + x] = p & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/** Douglas–Peucker on a flat [x0,y0,x1,y1,...] array (metres). */
export function simplifyLine(flat, tol) {
  const n = flat.length / 2;
  if (n <= 2) return flat.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = flat[2 * a], ay = flat[2 * a + 1];
    const dx = flat[2 * b] - ax, dy = flat[2 * b + 1] - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = flat[2 * i] - ax, py = flat[2 * i + 1] - ay;
      let d2;
      if (len2 === 0) d2 = px * px + py * py;
      else {
        const cross = px * dy - py * dx;
        d2 = (cross * cross) / len2;
      }
      if (d2 > maxD) { maxD = d2; idx = i; }
    }
    if (maxD > tol2 && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(flat[2 * i], flat[2 * i + 1]);
  return out;
}

export const here = (url) => dirname(new URL(url).pathname);
