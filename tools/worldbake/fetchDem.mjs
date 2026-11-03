// Elevation source: AWS Terrain Tiles (Tilezen/Mapzen "terrarium" encoding),
// s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png. Key-free,
// public dataset; see docs/worlds/CREDITS.md for the attribution list.
//
// terrarium: height = (R·256 + G + B/256) − 32768 metres.

import { join } from 'node:path';
import { cachedFetch, decodePng, ensureDir } from './util.mjs';

export const DEM_SOURCE = 'aws-terrain-tiles/terrarium';
const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const TILE = 256;

const lonToPx = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToPx = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};

/** Tiles covering a lat/lon bbox at zoom z, row-major north→south, west→east. */
export function tilesForBbox(bbox, z) {
  const x0 = Math.floor(lonToPx(bbox.west, z) / TILE);
  const x1 = Math.floor(lonToPx(bbox.east, z) / TILE);
  const y0 = Math.floor(latToPx(bbox.north, z) / TILE);
  const y1 = Math.floor(latToPx(bbox.south, z) / TILE);
  const tiles = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ z, x, y });
  return { x0, x1, y0, y1, tiles };
}

/**
 * Fetch (or read from cache) every tile over `bbox` and return a bilinear
 * sampler over the mosaic: sample(lat, lon) → metres.
 */
export async function fetchDem({ bbox, zoom, cacheDir, concurrency = 8, log = () => {} }) {
  const dir = join(cacheDir, 'terrarium');
  ensureDir(dir);
  const grid = tilesForBbox(bbox, zoom);
  const cols = grid.x1 - grid.x0 + 1;
  const rows = grid.y1 - grid.y0 + 1;
  const W = cols * TILE;
  const H = rows * TILE;
  const mosaic = new Float32Array(W * H);
  let fetched = 0;
  let next = 0;
  const work = async () => {
    while (next < grid.tiles.length) {
      const t = grid.tiles[next++];
      const { body, cached } = await cachedFetch(dir, `${t.z}-${t.x}-${t.y}.png`, TILE_URL(t.z, t.x, t.y), {}, {
        label: `terrarium ${t.z}/${t.x}/${t.y}`,
      });
      if (!cached) fetched++;
      const png = decodePng(body);
      if (png.width !== TILE || png.height !== TILE) throw new Error(`tile ${t.z}/${t.x}/${t.y} is not 256²`);
      const ox = (t.x - grid.x0) * TILE;
      const oy = (t.y - grid.y0) * TILE;
      const ch = png.channels;
      for (let py = 0; py < TILE; py++) {
        for (let px = 0; px < TILE; px++) {
          const i = (py * TILE + px) * ch;
          const p = png.pixels;
          mosaic[(oy + py) * W + ox + px] = p[i] * 256 + p[i + 1] + p[i + 2] / 256 - 32768;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, grid.tiles.length) }, work));
  log(`dem: ${grid.tiles.length} tiles z${zoom} (${fetched} downloaded)`);

  const originX = grid.x0 * TILE;
  const originY = grid.y0 * TILE;
  /** Bilinear on pixel centres. */
  const sample = (lat, lon) => {
    let fx = lonToPx(lon, zoom) - originX - 0.5;
    let fy = latToPx(lat, zoom) - originY - 0.5;
    if (fx < 0) fx = 0;
    if (fy < 0) fy = 0;
    if (fx > W - 1) fx = W - 1;
    if (fy > H - 1) fy = H - 1;
    let x = Math.floor(fx);
    let y = Math.floor(fy);
    if (x > W - 2) x = W - 2;
    if (y > H - 2) y = H - 2;
    const tx = fx - x;
    const ty = fy - y;
    const i = y * W + x;
    const a = mosaic[i] + (mosaic[i + 1] - mosaic[i]) * tx;
    const b = mosaic[i + W] + (mosaic[i + W + 1] - mosaic[i + W]) * tx;
    return a + (b - a) * ty;
  };
  return {
    zoom,
    tiles: grid.tiles.map((t) => `${t.z}/${t.x}/${t.y}`),
    sample,
  };
}
