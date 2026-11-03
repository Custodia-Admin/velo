/**
 * A shared tileable noise texture (256², RGBA, mipmapped): four independent
 * smooth value-noise channels at 8, 16, 32 and 64 cells per tile. World
 * materials sample it instead of evaluating hash noise per pixel — one
 * fetch gives four octaves, and the mip chain anti-aliases detail for free
 * as it shrinks toward a pixel (the iGPU frame budget is fill-rate bound).
 */

import * as THREE from 'three';

export const NOISE_SIZE = 256;
/** Lattice cells per tile, per channel (R, G, B, A). */
export const NOISE_CELLS = [8, 16, 32, 64] as const;

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Channel values 0–255 for one tile (pure; exported for tests). */
export function buildNoiseData(size = NOISE_SIZE): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  NOISE_CELLS.forEach((cells, ch) => {
    const step = size / cells;
    for (let y = 0; y < size; y++) {
      const fy = y / step;
      const iy = Math.floor(fy);
      let ty = fy - iy;
      ty = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = x / step;
        const ix = Math.floor(fx);
        let tx = fx - ix;
        tx = tx * tx * (3 - 2 * tx);
        const x0 = ix % cells;
        const x1 = (ix + 1) % cells;
        const y0 = iy % cells;
        const y1 = (iy + 1) % cells;
        const a = hash(x0, y0, ch + 1);
        const b = hash(x1, y0, ch + 1);
        const c = hash(x0, y1, ch + 1);
        const d = hash(x1, y1, ch + 1);
        const v = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
        data[(y * size + x) * 4 + ch] = Math.round(v * 255);
      }
    }
  });
  return data;
}

let shared: THREE.DataTexture | null = null;

/** The shared noise texture (created once; never disposed — 256 KB). */
export function worldNoiseTexture(): THREE.DataTexture {
  if (shared) return shared;
  const t = new THREE.DataTexture(buildNoiseData(), NOISE_SIZE, NOISE_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  shared = t;
  return t;
}
