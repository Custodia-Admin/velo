// Bare ground under the routes (recipe `bareGround`).
//
// Copernicus GLO-30 is a surface model: over a forest it reports the top of
// the canopy, over a town the roofs. The route fit (snapRoutes.mjs) takes its
// slow offset from that surface, so in a forested valley the route rides on
// the treetops: the Ohio & Erie towpath sat 10–21 m over the ground through
// the Cuyahoga Valley woods, and where it came out of them at Peninsula it
// still stood 6–11 m over the open ground, so the bridges step lifted Main
// Street 14.9 m onto a 298 m viaduct to clear it.
//
// Where an open bare-earth model (a DTM) covers a world, the bake swaps it in
// along the routes BEFORE the route fit: every grid node within `corridorM`
// of a route takes the DTM height, and the next `blendM` blend back to the
// surface model with a smoothstep. The fit and the carve then work on the
// ground, so the route keeps the profile's shape at ground level, and the
// trees, buildings and decks the bake places along the routes stand on the
// ground too. Further out the world stays on GLO-30: the P1.3 v2 gate checks
// the heightfield against Copernicus GLO-90, itself a surface model, and a
// world-wide swap would fail it in any forested world (Cuyahoga Valley:
// 60 % woodland, canopy 15–25 m).
//
// The DTM sits on its own vertical datum (NAVD 88 for 3DEP, LN02 for
// swissALTI3D), not GLO-30's EGM2008. `biasM` = the median of GLO-30 − DTM
// over flat, open corridor nodes (no woodland polygon within 30 m, DTM slope
// under 5 %) is added to the DTM, so open ground keeps GLO-30's level and the
// blend has no step there.
//
// Sources (recipe `bareGround.source`):
// - "usgs-3dep-13": USGS 3D Elevation Program 1/3 arc-second DEM (United
//   States), 1° × 1° Cloud Optimized GeoTIFFs on the prd-tnm S3 bucket, LZW +
//   floating-point predictor, float32, PixelIsArea, NAD83 geographic, a
//   6-pixel overlap round each tile, nodata −999999. Tile `n42w082` covers
//   41–42° N, 81–82° W. The recipe pins each tile's dated release
//   (`tiles: { "n42w082": "20230911" }`, the `historical/` copy, which never
//   changes), so a clean-cache bake downloads the same bytes. Read bilinear
//   at the node (pixels ≈ 8 × 10 m at 41° N, under the 12 m grid).
//   NAD83(2011) and WGS84 differ by about 1 m horizontally; not corrected.
// - "swissalti3d": swisstopo swissALTI3D 2 m (Switzerland), 1 km × 1 km
//   GeoTIFFs in LV95 (EPSG:2056) from data.geo.admin.ch, LZW, float32,
//   PixelIsArea, nodata −9999. The recipe pins the release year (`year`);
//   only the tiles the corridor touches are fetched. Grid nodes are put into
//   LV95 with swisstopo's approximate formulas (about 1 m), and each node takes
//   the mean of the k × k pixels round it (k = the odd number nearest half
//   the cell size in metres), so the 2 m model is averaged down to the grid
//   instead of point-sampled. Tiles outside Switzerland 404: no DTM there
//   (checked against the STAC catalogue: a tile that has releases, only not
//   the pinned year, stops the bake).
//
// A node without a DTM value (nodata, a 404 tile) keeps its GLO-30 height.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cachedFetch, ensureDir, writeFileAtomic } from './util.mjs';
import { geoReference, openRaster, parseTiff } from './geotiff.mjs';
import { appRoutePoints } from './snapRoutes.mjs';

export const BARE_GROUND_SOURCES = ['usgs-3dep-13', 'swissalti3d'];
/** Full DTM within this many metres of a route (default). */
export const BARE_GROUND_CORRIDOR_M = 150;
/** Then a smoothstep back to the surface model over this many metres (default). */
export const BARE_GROUND_BLEND_M = 300;
/** Open ground for the datum bias: no woodland polygon within this distance... */
export const BIAS_WOODLAND_CLEAR_M = 30;
/** ...and a DTM slope under this. */
export const BIAS_MAX_SLOPE = 0.05;
/** Landcover kinds that carry a canopy (buildVectors LANDCOVER_KINDS). */
export const WOODLAND_KINDS = ['forest', 'scrub', 'orchard'];

export const USGS_3DEP_BASE = 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF';
export const SWISSALTI3D_BASE = 'https://data.geo.admin.ch/ch.swisstopo.swissalti3d';

export const BARE_GROUND_CREDITS = {
  'usgs-3dep-13': {
    id: 'usgs-3dep',
    name: 'USGS 3D Elevation Program (3DEP) 1/3 arc-second DEM, bare earth, along the routes',
    licence: 'Public domain (U.S. Geological Survey); credit requested',
    url: 'https://www.usgs.gov/3d-elevation-program',
    attribution: 'U.S. Geological Survey, 3D Elevation Program 1/3 arc-second Digital Elevation Model',
  },
  swissalti3d: {
    id: 'swissalti3d',
    name: 'swissALTI3D 2 m, bare earth, along the routes',
    licence: 'Open Government Data of the Swiss Confederation, free use with source attribution (swisstopo terms of use)',
    url: 'https://www.swisstopo.admin.ch/en/height-model-swissalti3d',
    attribution: 'Source: Federal Office of Topography swisstopo',
  },
};

/** The recipe's `bareGround` with defaults, checked. Null when the recipe has none. */
export function bareGroundOptions(recipe) {
  const b = recipe.bareGround;
  if (b === undefined) return null;
  if (!b || typeof b !== 'object') throw new Error('recipe bareGround must be an object');
  if (!BARE_GROUND_SOURCES.includes(b.source)) throw new Error(`recipe bareGround.source must be one of ${BARE_GROUND_SOURCES.join(', ')}`);
  const corridorM = b.corridorM ?? BARE_GROUND_CORRIDOR_M;
  const blendM = b.blendM ?? BARE_GROUND_BLEND_M;
  if (!(corridorM >= 0) || !(blendM > 0)) throw new Error('recipe bareGround: corridorM must be ≥ 0 and blendM > 0');
  if (b.source === 'usgs-3dep-13') {
    if (!b.tiles || typeof b.tiles !== 'object') throw new Error('recipe bareGround "usgs-3dep-13" needs tiles: { "<n42w082>": "<yyyymmdd release>" }');
    for (const [k, v] of Object.entries(b.tiles)) {
      if (!/^[ns]\d{2}[ew]\d{3}$/.test(k) || !/^\d{8}$/.test(v)) throw new Error(`recipe bareGround.tiles: bad entry ${k}: ${v}`);
    }
  }
  if (b.source === 'swissalti3d' && !Number.isInteger(b.year)) throw new Error('recipe bareGround "swissalti3d" needs year (the swissALTI3D release, e.g. 2022)');
  return { ...b, corridorM, blendM };
}

// --- USGS 3DEP 1/3″ -----------------------------------------------------

const pad = (n, w) => String(n).padStart(w, '0');

/** 3DEP tile name for the 1° cell holding (lat, lon): n42w082 = 41–42° N, 82–81° W (NW corner). */
export function usgsTileName(lat, lon) {
  const top = Math.floor(lat) + 1;
  const west = Math.floor(lon);
  if (top <= 0) throw new Error('USGS 3DEP tiles south of the equator are not supported');
  return `n${pad(top, 2)}${west < 0 ? 'w' : 'e'}${pad(Math.abs(west), 3)}`;
}

export const usgsTileUrl = (name, release) => `${USGS_3DEP_BASE}/historical/${name}/USGS_13_${name}_${release}.tif`;

/** Check a decoded 3DEP tile against the cell it should cover; returns its georeference. */
export function checkUsgsTile(name, tiff, raster) {
  const geo = geoReference(tiff);
  const where = `USGS 3DEP ${name}`;
  if (geo.modelType !== 2) throw new Error(`${where}: GTModelType ${geo.modelType}, expected geographic (2)`);
  if (geo.geographicType !== 4269 && geo.geographicType !== 4326) throw new Error(`${where}: GeographicType ${geo.geographicType}, expected NAD83 (4269)`);
  const top = Number(name.slice(1, 3));
  const west = (name[3] === 'w' ? -1 : 1) * Number(name.slice(4, 7));
  // The tile's own 1° cell must lie inside its pixel centres with a pixel to spare (the overlap).
  const x1 = geo.x0 + (raster.width - 1) * geo.scaleX;
  const y1 = geo.y0 - (raster.height - 1) * geo.scaleY;
  if (!(geo.x0 < west - geo.scaleX && x1 > west + 1 + geo.scaleX && geo.y0 > top + geo.scaleY && y1 < top - 1 - geo.scaleY)) {
    throw new Error(`${where}: pixel centres ${geo.x0}…${x1}° E, ${y1}…${geo.y0}° N don't cover the tile's cell with its overlap`);
  }
  return geo;
}

/**
 * Bilinear reader over a set of decoded 3DEP tiles. Each read uses the tile
 * whose own 1° cell holds the point; the tiles' 6-pixel overlap holds the
 * 2 × 2 neighbourhood. NaN where a neighbour is nodata or no tile was loaded.
 */
export function usgsSampler(tiles) {
  return (lat, lon) => {
    const t = tiles.get(usgsTileName(lat, lon));
    if (!t) return NaN;
    const { raster, geo, noData } = t;
    const fi = (lon - geo.x0) / geo.scaleX;
    const fj = (geo.y0 - lat) / geo.scaleY;
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const a = raster.value(i, j), b = raster.value(i + 1, j), c = raster.value(i, j + 1), d = raster.value(i + 1, j + 1);
    if (a === noData || b === noData || c === noData || d === noData) return NaN;
    const tx = fi - i, ty = fj - j;
    const top = a + (b - a) * tx;
    return top + (c + (d - c) * tx - top) * ty;
  };
}

async function fetchUsgs({ opts, points, cacheDir, log }) {
  const dir = join(cacheDir, 'usgs-3dep-13');
  ensureDir(dir);
  const names = [...new Set(points.map(([lat, lon]) => usgsTileName(lat, lon)))].sort();
  const tiles = new Map();
  let fetched = 0;
  for (const name of names) {
    const release = opts.tiles[name];
    if (!release) {
      throw new Error(
        `bareGround: the corridor needs USGS 3DEP tile ${name}; pin its release in the recipe (bareGround.tiles.${name} = the date of the ${USGS_3DEP_BASE}/historical/${name}/USGS_13_${name}_<yyyymmdd>.tif whose ETag equals current/${name}/USGS_13_${name}.tif's; the <pubdate> in current/${name}/USGS_13_${name}.xml can be a day later)`,
      );
    }
    const res = await cachedFetch(dir, `USGS_13_${name}_${release}.tif`, usgsTileUrl(name, release), {}, { label: `USGS 3DEP ${name}` });
    if (!res.cached) fetched++;
    const tiff = parseTiff(res.body);
    const raster = openRaster(tiff);
    const geo = checkUsgsTile(name, tiff, raster);
    tiles.set(name, { raster, geo, noData: geo.noData === undefined ? NaN : Number(geo.noData) });
  }
  log(`bareGround: ${names.length} USGS 3DEP 1/3″ tile${names.length === 1 ? '' : 's'} (${fetched} downloaded): ${names.join(', ')}`);
  return { tiles: names.map((n) => `${n}@${opts.tiles[n]}`), sample: usgsSampler(tiles) };
}

// --- swissALTI3D --------------------------------------------------------

/**
 * WGS84 → LV95 (E, N), swisstopo's approximate formulas ("Approximate
 * formulas for the transformation between Swiss projection coordinates and
 * WGS84"), accurate to about 1 m.
 */
export function wgs84ToLv95(lat, lon) {
  const p = (lat * 3600 - 169028.66) / 10000;
  const l = (lon * 3600 - 26782.5) / 10000;
  const E = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l * l * l;
  const N = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p * p * p;
  return [E, N];
}

/** LV95 (E, N) → WGS84 [lat, lon], the same approximate formulas the other way (about 1 m). */
export function lv95ToWgs84(E, N) {
  const y = (E - 2600000) / 1e6;
  const x = (N - 1200000) / 1e6;
  const l = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
  const p = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x * x * x;
  return [(p * 100) / 36, (l * 100) / 36];
}

export const SWISSALTI3D_STAC = 'https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.swissalti3d/items';

/**
 * The swissALTI3D releases of 1 km tile `id` the STAC catalogue lists
 * (years, ascending). A tile 404s either outside the model's coverage (no
 * release at all) or because it has no release of the pinned year; only the
 * first may be read as "no DTM here".
 */
export async function swissTileYears(id, fetchJson = defaultFetchJson) {
  const [e, n] = id.split('-').map(Number);
  const [lat, lon] = lv95ToWgs84(e * 1000 + 500, n * 1000 + 500);
  const body = await fetchJson(`${SWISSALTI3D_STAC}?bbox=${lon},${lat},${lon},${lat}`);
  const years = [];
  for (const f of body.features ?? []) {
    const m = /^swissalti3d_(\d{4})_(\d+-\d+)$/.exec(f.id);
    if (m && m[2] === id) years.push(Number(m[1]));
  }
  return years.sort((a, b) => a - b);
}

async function defaultFetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export const swissTileId = (E, N) => `${Math.floor(E / 1000)}-${Math.floor(N / 1000)}`;
export const swissTileUrl = (id, year) => `${SWISSALTI3D_BASE}/swissalti3d_${year}_${id}/swissalti3d_${year}_${id}_2_2056_5728.tif`;

/** Box mean of k × k pixels round (E, N) over 1 km swissALTI3D tiles; NaN when any pixel is missing. */
export function swissSampler(tiles, k) {
  const half = (k - 1) / 2;
  const px = (E, N) => {
    const t = tiles.get(swissTileId(E, N));
    if (!t) return NaN;
    const i = Math.floor((E - t.e0) / 2);
    const j = Math.floor((t.n0 - N) / 2);
    const v = t.raster.value(Math.min(t.raster.width - 1, Math.max(0, i)), Math.min(t.raster.height - 1, Math.max(0, j)));
    return v === t.noData ? NaN : v;
  };
  return (lat, lon) => {
    const [E, N] = wgs84ToLv95(lat, lon);
    // Centre on the pixel holding the point (pixels are 2 m, centres on odd metres).
    const cE = Math.floor(E / 2) * 2 + 1;
    const cN = Math.floor(N / 2) * 2 + 1;
    let sum = 0;
    for (let a = -half; a <= half; a++) {
      for (let b = -half; b <= half; b++) {
        const v = px(cE + 2 * a, cN + 2 * b);
        if (Number.isNaN(v)) return NaN;
        sum += v;
      }
    }
    return sum / (k * k);
  };
}

async function fetchSwiss({ opts, points, cellSize, cacheDir, log }) {
  const dir = join(cacheDir, `swissalti3d-${opts.year}`);
  ensureDir(dir);
  const k = 2 * Math.floor(cellSize / 4) + 1;
  const reach = (k + 1) * 2;
  const ids = new Set();
  for (const [lat, lon] of points) {
    const [E, N] = wgs84ToLv95(lat, lon);
    for (const dE of [-reach, 0, reach]) for (const dN of [-reach, 0, reach]) ids.add(swissTileId(E + dE, N + dN));
  }
  const sorted = [...ids].sort();
  const tiles = new Map();
  const missing = [];
  let fetched = 0;
  for (const id of sorted) {
    const marker = join(dir, `${id}.404`);
    if (existsSync(marker)) {
      missing.push(id);
      continue;
    }
    let res;
    try {
      res = await cachedFetch(dir, `${id}.tif`, swissTileUrl(id, opts.year), {}, { label: `swissALTI3D ${opts.year} ${id}` });
    } catch (err) {
      if (err.status !== 404) throw err;
      const years = await swissTileYears(id);
      if (years.length) throw new Error(`bareGround: swissALTI3D tile ${id} has no ${opts.year} release (the catalogue lists ${years.join(', ')}); pin a year every corridor tile has`);
      writeFileAtomic(marker, `HTTP 404 ${swissTileUrl(id, opts.year)}, no release in ${SWISSALTI3D_STAC}\n`);
      missing.push(id);
      continue;
    }
    if (!res.cached) fetched++;
    const tiff = parseTiff(res.body);
    const raster = openRaster(tiff);
    const geo = geoReference(tiff);
    const [e, n] = id.split('-').map(Number);
    if (geo.scaleX !== 2 || geo.scaleY !== 2 || raster.width !== 500 || raster.height !== 500 || geo.x0 !== e * 1000 + 1 || geo.y0 !== n * 1000 + 999) {
      throw new Error(`swissALTI3D ${id}: unexpected grid (${raster.width}×${raster.height}, ${geo.scaleX} m, first centre ${geo.x0}, ${geo.y0})`);
    }
    tiles.set(id, { raster, e0: e * 1000, n0: n * 1000 + 1000, noData: geo.noData === undefined ? NaN : Number(geo.noData) });
  }
  log(`bareGround: ${sorted.length} swissALTI3D ${opts.year} tiles (${fetched} downloaded, ${missing.length} absent: outside Switzerland), ${k}×${k} px mean per node`);
  return { tiles: sorted.filter((id) => !missing.includes(id)).map((id) => `${id}@${opts.year}`), missing, sample: swissSampler(tiles, k) };
}

// --- corridor -----------------------------------------------------------

/**
 * Distance from every grid node to the nearest route line, for nodes within
 * `reach` (Infinity beyond). `lines` = flat [x0, y0, x1, y1, …] polylines in
 * world metres.
 */
export function routeDistances(grid, lines, reach) {
  const { cols, rows, cellSize, xMin, yMax } = grid;
  const dist = new Float64Array(cols * rows).fill(Infinity);
  for (const p of lines) {
    for (let k = 0; k + 3 < p.length; k += 2) {
      const ax = p[k], ay = p[k + 1], bx = p[k + 2], by = p[k + 3];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - xMin) / cellSize));
      const c1 = Math.min(cols - 1, Math.ceil((Math.max(ax, bx) + reach - xMin) / cellSize));
      const r0 = Math.max(0, Math.floor((yMax - Math.max(ay, by) - reach) / cellSize));
      const r1 = Math.min(rows - 1, Math.ceil((yMax - Math.min(ay, by) + reach) / cellSize));
      for (let r = r0; r <= r1; r++) {
        const ny = yMax - r * cellSize;
        for (let c = c0; c <= c1; c++) {
          const nx = xMin + c * cellSize;
          let t = len2 > 0 ? ((nx - ax) * dx + (ny - ay) * dy) / len2 : 0;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          const d = Math.hypot(ax + dx * t - nx, ay + dy * t - ny);
          const i = r * cols + c;
          if (d < dist[i] && d < reach) dist[i] = d;
        }
      }
    }
  }
  return dist;
}

/** Corridor weight: 1 within `corridorM`, smoothstep down to 0 at corridorM + blendM. */
export function corridorWeight(d, corridorM, blendM) {
  if (d <= corridorM) return 1;
  if (d >= corridorM + blendM) return 0;
  const u = 1 - (d - corridorM) / blendM;
  return u * u * (3 - 2 * u);
}

/** Rasterise polygons (rings in metres, even-odd) onto the grid as a 0/1 mask. */
export function polygonMask(grid, polys) {
  const { cols, rows, cellSize, xMin, yMax } = grid;
  const mask = new Uint8Array(cols * rows);
  for (const rings of polys) {
    const edges = [];
    let yLo = Infinity, yHi = -Infinity;
    for (const ring of rings) {
      const n = ring.length / 2;
      for (let k = 0; k < n; k++) {
        const x1 = ring[2 * k], y1 = ring[2 * k + 1];
        const x2 = ring[2 * ((k + 1) % n)], y2 = ring[2 * ((k + 1) % n) + 1];
        edges.push(x1, y1, x2, y2);
        if (y1 < yLo) yLo = y1;
        if (y1 > yHi) yHi = y1;
      }
    }
    const r0 = Math.max(0, Math.ceil((yMax - yHi) / cellSize));
    const r1 = Math.min(rows - 1, Math.floor((yMax - yLo) / cellSize));
    const xs = [];
    for (let r = r0; r <= r1; r++) {
      const y = yMax - r * cellSize;
      xs.length = 0;
      for (let e = 0; e < edges.length; e += 4) {
        const y1 = edges[e + 1], y2 = edges[e + 3];
        if (y1 <= y !== y2 <= y) xs.push(edges[e] + ((y - y1) / (y2 - y1)) * (edges[e + 2] - edges[e]));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - xMin) / cellSize));
        const c1 = Math.min(cols - 1, Math.floor((xs[k + 1] - xMin) / cellSize));
        for (let c = c0; c <= c1; c++) mask[r * cols + c] = 1;
      }
    }
  }
  return mask;
}

/** Grow a 0/1 mask by `radiusM` (disc). */
export function dilateMask(grid, mask, radiusM) {
  const { cols, rows, cellSize } = grid;
  const k = Math.floor(radiusM / cellSize);
  if (k <= 0) return mask;
  const out = new Uint8Array(mask.length);
  const offs = [];
  for (let dr = -k; dr <= k; dr++) for (let dc = -k; dc <= k; dc++) if (Math.hypot(dr, dc) * cellSize <= radiusM + 1e-9) offs.push([dr, dc]);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!mask[r * cols + c]) continue;
      for (const [dr, dc] of offs) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && cc >= 0 && rr < rows && cc < cols) out[rr * cols + cc] = 1;
      }
    }
  }
  return out;
}

const median = (values) => {
  const s = Float64Array.from(values).sort();
  if (s.length === 0) return NaN;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Swap the DTM in along the routes, in place. `dtm[i]` = the DTM at node i
 * (NaN = none), `dist` from routeDistances, `woodland` a 0/1 node mask of
 * canopy landcover. Returns the step's figures.
 */
export function applyBareGround({ grid, heights, dtm, dist, woodland, corridorM, blendM }) {
  const { cols, rows, cellSize } = grid;
  const n = cols * rows;
  const reach = corridorM + blendM;
  const clear = dilateMask(grid, woodland, BIAS_WOODLAND_CLEAR_M);
  // Datum bias over flat, open corridor nodes.
  const open = [];
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const i = r * cols + c;
      if (!(dist[i] < reach) || clear[i] || Number.isNaN(dtm[i])) continue;
      const gx = (dtm[i + 1] - dtm[i - 1]) / (2 * cellSize);
      const gy = (dtm[i + cols] - dtm[i - cols]) / (2 * cellSize);
      if (!(Math.hypot(gx, gy) < BIAS_MAX_SLOPE)) continue; // NaN neighbours fail too
      open.push(heights[i] - dtm[i]);
    }
  }
  if (open.length < 100) throw new Error(`bareGround: only ${open.length} flat open corridor nodes to tie the DTM's datum to GLO-30`);
  const biasM = median(open);
  let nodes = 0, nodata = 0, maxLower = 0, maxRaise = 0, sumLower = 0, lowered = 0, maxLowerAt = null, maxRaiseAt = null;
  const at = (i) => [grid.xMin + (i % cols) * cellSize, grid.yMax - Math.floor(i / cols) * cellSize];
  for (let i = 0; i < n; i++) {
    if (!(dist[i] < reach)) continue;
    if (Number.isNaN(dtm[i])) {
      nodata++;
      continue;
    }
    const w = corridorWeight(dist[i], corridorM, blendM);
    if (w <= 0) continue;
    const delta = (dtm[i] + biasM - heights[i]) * w;
    heights[i] += delta;
    nodes++;
    if (delta < 0) {
      lowered++;
      sumLower -= delta;
      if (-delta > maxLower) {
        maxLower = -delta;
        maxLowerAt = at(i);
      }
    } else if (delta > maxRaise) {
      maxRaise = delta;
      maxRaiseAt = at(i);
    }
  }
  return { biasM, openNodes: open.length, nodes, nodata, lowered, maxLowerM: maxLower, maxLowerAt, meanLowerM: lowered ? sumLower / lowered : 0, maxRaiseM: maxRaise, maxRaiseAt };
}

/** Route polylines (world metres) from the scenic geometry, the app's ≤ 50 m points. */
export function routeLines(routes, projection) {
  return routes.map((r) => {
    const app = appRoutePoints(r.points);
    const out = [];
    for (let i = 0; i < app.lat.length; i++) out.push(...projection.forward(app.lat[i], app.lon[i]));
    return out;
  });
}

/**
 * The whole step for bake.mjs: corridor, DTM fetch and sampling, the swap.
 * `woodlandPolys` = rings (metres) of the canopy landcover. Returns
 * `{ report, bare(x, y), woodlandAt(x, y) }`: bare = DTM + bias at a world
 * point (NaN = none), for the route-lift figures after the carve.
 */
export async function bareGroundStep({ recipe, grid, heights, projection, routes, woodlandPolys, cacheDir, log }) {
  const opts = bareGroundOptions(recipe);
  const reach = opts.corridorM + opts.blendM;
  const dist = routeDistances(grid, routeLines(routes, projection), reach);
  const { cols, rows, cellSize, xMin, yMax } = grid;
  const idx = [];
  const points = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (dist[r * cols + c] < reach) {
        idx.push(r * cols + c);
        points.push(projection.inverse(xMin + c * cellSize, yMax - r * cellSize));
      }
    }
  }
  const src = opts.source === 'usgs-3dep-13'
    ? await fetchUsgs({ opts, points, cacheDir, log })
    : await fetchSwiss({ opts, points, cellSize, cacheDir, log });
  const dtm = new Float64Array(cols * rows).fill(NaN);
  for (let k = 0; k < idx.length; k++) dtm[idx[k]] = src.sample(points[k][0], points[k][1]);
  const woodland = polygonMask(grid, woodlandPolys);
  const res = applyBareGround({ grid, heights, dtm, dist, woodland, corridorM: opts.corridorM, blendM: opts.blendM });
  log(
    `bareGround: ${opts.source}, ${res.nodes} nodes within ${opts.corridorM} + ${opts.blendM} m of the routes on the DTM ` +
      `(datum bias ${res.biasM.toFixed(2)} m over ${res.openNodes} flat open nodes; lowered up to ${res.maxLowerM.toFixed(1)} m at ${res.maxLowerAt?.map((v) => v.toFixed(0)).join(', ')}, mean ${res.meanLowerM.toFixed(1)} m; raised up to ${res.maxRaiseM.toFixed(1)} m at ${res.maxRaiseAt?.map((v) => v.toFixed(0)).join(', ')}; ${res.nodata} without DTM)`,
  );
  const bare = (x, y) => {
    const [lat, lon] = projection.inverse(x, y);
    return src.sample(lat, lon) + res.biasM;
  };
  const woodlandAt = (x, y) => {
    const c = Math.round((x - xMin) / cellSize);
    const r = Math.round((yMax - y) / cellSize);
    return c >= 0 && r >= 0 && c < cols && r < rows && woodland[r * cols + c] === 1;
  };
  return {
    bare,
    woodlandAt,
    report: {
      source: opts.source,
      tiles: src.tiles,
      ...(src.missing?.length ? { absentTiles: src.missing } : {}),
      corridorM: opts.corridorM,
      blendM: opts.blendM,
      biasM: res.biasM,
      openNodes: res.openNodes,
      nodes: res.nodes,
      nodata: res.nodata,
      maxLowerM: res.maxLowerM,
      maxLowerAt: res.maxLowerAt,
      meanLowerM: res.meanLowerM,
      maxRaiseM: res.maxRaiseM,
      maxRaiseAt: res.maxRaiseAt,
    },
  };
}

/**
 * How far each route stands over the bare ground: render height minus
 * `bare(x, y)` at every route sample, leaving out the stretches it rides on
 * a deck (`onDeck(routeIndex, s)`) and samples without a DTM.
 * `surface(routeIndex, i)` gives the height to judge (the render h).
 */
export function routeLift({ routes, bare, onDeck = () => false, woodlandAt = () => false }) {
  return routes.map((r, ri) => {
    const lift = [];
    const wood = [];
    let worst = -Infinity, worstS = null;
    for (let i = 0; i < r.s.length; i++) {
      if (onDeck(ri, r.s[i])) continue;
      const g = bare(r.x[i], r.y[i]);
      if (Number.isNaN(g)) continue;
      const v = r.h[i] - g;
      lift.push(v);
      if (woodlandAt(r.x[i], r.y[i])) wood.push(v);
      if (v > worst) {
        worst = v;
        worstS = r.s[i];
      }
    }
    const sorted = Float64Array.from(lift).sort();
    const q = (p) => (sorted.length ? sorted[Math.floor(p * (sorted.length - 1))] : null);
    const woodSorted = Float64Array.from(wood).sort();
    return {
      id: r.id,
      samples: lift.length,
      medianM: q(0.5),
      p95M: q(0.95),
      maxM: sorted.length ? sorted[sorted.length - 1] : null,
      maxAtS: worstS,
      minM: sorted.length ? sorted[0] : null,
      over3M: lift.filter((v) => v > 3).length,
      woodland: { samples: wood.length, p95M: woodSorted.length ? woodSorted[Math.floor(0.95 * (woodSorted.length - 1))] : null, maxM: woodSorted.length ? woodSorted[woodSorted.length - 1] : null },
    };
  });
}
