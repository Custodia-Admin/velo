// Heightfield accuracy check against an independent DEM: Copernicus GLO-90
// via the Open-Meteo elevation API (key-free, CC-BY 4.0). Sample points are
// drawn from a seeded RNG, so the same recipe always checks the same places.
// Not part of the bundle; the result lands in tools/worldbake/reports/.

import { join } from 'node:path';
import { cachedFetch, ensureDir, rng, sha256 } from './util.mjs';

export async function validateHeightfield({ hf, projection, extent, recipe, cacheDir, routeMask }) {
  const { seed, samples } = recipe.validation;
  const rand = rng(seed);
  const pts = [];
  for (let i = 0; i < samples; i++) {
    const x = extent.xMin + rand() * (extent.xMax - extent.xMin);
    const y = extent.yMin + rand() * (extent.yMax - extent.yMin);
    const [lat, lon] = projection.inverse(x, y);
    pts.push({ lat: +lat.toFixed(5), lon: +lon.toFixed(5) });
  }
  const url =
    'https://api.open-meteo.com/v1/elevation?latitude=' +
    pts.map((p) => p.lat.toFixed(5)).join(',') +
    '&longitude=' +
    pts.map((p) => p.lon.toFixed(5)).join(',');
  const dir = join(cacheDir, 'open-meteo');
  ensureDir(dir);
  const { body } = await cachedFetch(dir, `${sha256(url).slice(0, 16)}.json`, url, {}, { label: 'open-meteo elevation' });
  const ref = JSON.parse(body.toString('utf8')).elevation;
  if (!Array.isArray(ref) || ref.length !== pts.length) throw new Error('open-meteo: unexpected elevation response');
  let sum = 0;
  let max = 0;
  let bias = 0;
  const rows = [];
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = projection.forward(pts[i].lat, pts[i].lon);
    const h = hf.sampleHeight(x, y);
    const d = h - ref[i];
    sum += d * d;
    bias += d;
    max = Math.max(max, Math.abs(d));
    rows.push({ lat: pts[i].lat, lon: pts[i].lon, heightfield: Math.round(h * 100) / 100, openMeteo: ref[i], onRouteCorridor: routeMask?.(x, y) ?? false });
  }
  const rms = Math.sqrt(sum / pts.length);
  return {
    reference: 'Copernicus GLO-90 via api.open-meteo.com/v1/elevation',
    seed,
    samples: pts.length,
    rmsM: Math.round(rms * 100) / 100,
    meanBiasM: Math.round((bias / pts.length) * 100) / 100,
    maxAbsM: Math.round(max * 100) / 100,
    pass: rms <= recipe.validation.maxRmsM,
    points: rows,
  };
}
