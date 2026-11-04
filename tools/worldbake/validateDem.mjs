// Heightfield accuracy check against an independent DEM: Copernicus GLO-90
// via the Open-Meteo elevation API (key-free, CC-BY 4.0). Sample points are
// drawn from a seeded RNG, so the same recipe always checks the same places.
// Not part of the bundle; the result lands in tools/worldbake/reports/.
//
// Two comparisons over the same samples:
//
//  - `rmsM` (the P1.3 criterion as written): the heightfield at the random
//    point vs Open-Meteo's answer for that point.
//  - `registered.rmsM`: each sample moved to the GLO-90 node Open-Meteo
//    answers with, and the heightfield read at that node. Open-Meteo returns
//    the nearest stored node, not an interpolation: on the Ticino slopes the
//    answer jumps 70 m between neighbouring 3″ cells (45.95159 → 450 m,
//    45.95168 → 380 m at 8.91634), so on steep ground the point comparison
//    mostly measures where in its 90 m cell a sample fell. The value belongs
//    to the node at the cell's north-west corner (latitude rounded up,
//    longitude rounded down to 1/1200°): of the registrations tried on the
//    Lugano samples (point, centre, SW, NW, cell mean) NW fits best by far,
//    both for this heightfield (10.9 m vs 13.2–22.6 m) and for Copernicus
//    GLO-30 itself (6.5 m vs 12.6–23.0 m).
//
// `pass` applies the recipe's `validation.maxRmsM` to the point comparison
// (the criterion as written); the registered figure is reported beside it.

import { join } from 'node:path';
import { cachedFetch, ensureDir, rng, sha256 } from './util.mjs';

/** Copernicus GLO-90 node spacing below 50° latitude: 3 arc-seconds. */
const NODE_DEG = 1 / 1200;

async function openMeteo(pts, cacheDir) {
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
  return ref;
}

function stats(diffs) {
  let sum = 0;
  let max = 0;
  let bias = 0;
  for (const d of diffs) {
    sum += d * d;
    bias += d;
    max = Math.max(max, Math.abs(d));
  }
  return {
    rmsM: Math.round(Math.sqrt(sum / diffs.length) * 100) / 100,
    meanBiasM: Math.round((bias / diffs.length) * 100) / 100,
    maxAbsM: Math.round(max * 100) / 100,
  };
}

/** The GLO-90 node Open-Meteo answers with for a point: the north-west corner of its 3″ cell. */
export function glo90Node(lat, lon) {
  return { lat: Math.ceil(lat / NODE_DEG) * NODE_DEG, lon: Math.floor(lon / NODE_DEG) * NODE_DEG };
}

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
  const ref = await openMeteo(pts, cacheDir);
  // Registered: query a quarter cell inside each node's cell so the nearest
  // node is unambiguous, and read the heightfield at the node itself.
  const nodes = pts.map((p) => glo90Node(p.lat, p.lon));
  const refNode = await openMeteo(
    nodes.map((n) => ({ lat: n.lat - NODE_DEG / 4, lon: n.lon + NODE_DEG / 4 })),
    cacheDir,
  );

  const rows = [];
  const diffs = [];
  const diffsNode = [];
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = projection.forward(pts[i].lat, pts[i].lon);
    const h = hf.sampleHeight(x, y);
    const [nx, ny] = projection.forward(nodes[i].lat, nodes[i].lon);
    const hn = hf.sampleHeight(nx, ny);
    diffs.push(h - ref[i]);
    diffsNode.push(hn - refNode[i]);
    rows.push({
      lat: pts[i].lat,
      lon: pts[i].lon,
      heightfield: Math.round(h * 100) / 100,
      openMeteo: ref[i],
      nodeHeightfield: Math.round(hn * 100) / 100,
      nodeOpenMeteo: refNode[i],
      onRouteCorridor: routeMask?.(x, y) ?? false,
    });
  }
  const point = stats(diffs);
  return {
    reference: 'Copernicus GLO-90 via api.open-meteo.com/v1/elevation',
    seed,
    samples: pts.length,
    ...point,
    pass: point.rmsM <= recipe.validation.maxRmsM,
    registered: { method: 'GLO-90 node at the north-west corner of each sample’s 3″ cell', ...stats(diffsNode) },
    points: rows,
  };
}
