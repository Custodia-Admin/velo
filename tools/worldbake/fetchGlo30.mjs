// Elevation source (opt-in): Copernicus DEM GLO-30, the public Cloud
// Optimized GeoTIFFs in the copernicus-dem-30m bucket on the AWS Open Data
// Registry, fetched whole over plain HTTPS and decoded by geotiff.mjs (no npm
// dependencies). A recipe selects it with `"dem": { "source": "copernicus-glo30" }`;
// see docs/worlds/WORLD-FORMAT.md "DEM source" and docs/worlds/CREDITS.md.
//
// Tile grid, checked against the bucket and the tiles' own GeoTIFF tags
// (4 Nov 2026):
// - One 1°×1° tile per whole-degree south-west corner (S, W):
//   https://copernicus-dem-30m.s3.amazonaws.com/<name>/<name>.tif with
//   <name> = Copernicus_DSM_COG_10_<N|S>dd_00_<E|W>ddd_00_DEM. Ocean-only
//   tiles don't exist: the bucket answers 404 and the bake reads them as 0 m.
//   GLO-30 *Public* also lacks a few land tiles the Copernicus programme hasn't
//   released (e.g. N40_00_E044_00, Armenia), which 404 too. GLO-90 covers all
//   land, so a GLO-30 404 is checked against the copernicus-dem-90m bucket:
//   404 there as well → ocean; 200 → land without public GLO-30 → the bake stops.
// - GTRasterTypeGeoKey = PixelIsPoint and the tiepoint is the tile's NW corner,
//   so pixel CENTRES sit on whole arc-seconds: row j at lat S+1 − j/R, column i
//   at lon W + i/C. A tile owns latitudes (S, S+1] and longitudes [W, W+1).
// - R = 3600 rows per degree everywhere. Columns per degree C drop with
//   latitude (3600 below 50°, 2400 to 60°, 1800 to 70°, 1200 to 80°, 720 to
//   85°, 360 beyond). The sampler takes R and C from ModelPixelScale; the
//   table only picks tiles before they are downloaded.
// - DEFLATE + floating-point predictor, float32, little-endian, 1024² internal
//   tiles plus three overviews (the bake reads IFD 0, full resolution).
// - Heights are metres above the EGM2008 geoid.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cachedFetch, ensureDir, sleep, USER_AGENT, writeFileAtomic } from './util.mjs';
import { fullResolutionIfd, geoReference, openRaster, parseTiff } from './geotiff.mjs';

export const GLO30_SOURCE = 'copernicus-dem-30m/glo30-cog';
export const GLO30_BUCKET = 'https://copernicus-dem-30m.s3.amazonaws.com';
export const GLO90_BUCKET = 'https://copernicus-dem-90m.s3.amazonaws.com';
export const GLO30_URL_TEMPLATE = `${GLO30_BUCKET}/Copernicus_DSM_COG_10_{N|S}dd_00_{E|W}ddd_00_DEM/Copernicus_DSM_COG_10_{N|S}dd_00_{E|W}ddd_00_DEM.tif`;

// Notice wording from the Copernicus DEM page (Copernicus Data Space Ecosystem,
// "Licensing and citation guidelines"), the variant for adapted or modified
// data: the bake resamples and quantises it.
export const GLO30_CREDIT = {
  id: 'copernicus-glo30',
  name: 'Copernicus DEM GLO-30 Public (copernicus-dem-30m COGs, AWS Open Data Registry)',
  licence: 'Copernicus DEM licence (GLO-30 Public, free for the general public, notice required)',
  url: 'https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM',
  attribution:
    'produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved',
};

/** Columns per degree of longitude for the tile whose SW corner is at latitude `south`. */
export function glo30ColsPerDegree(south) {
  const a = south >= 0 ? south : -south - 1; // lower |lat| bound of the tile
  if (a < 50) return 3600;
  if (a < 60) return 2400;
  if (a < 70) return 1800;
  if (a < 80) return 1200;
  if (a < 85) return 720;
  return 360;
}

/** The nominal GLO-30 lattice. Tests pass a smaller one with the same shape. */
export const GLO30_GRID = { rowsPerDegree: 3600, colsPerDegree: glo30ColsPerDegree };

const pad = (n, w) => String(n).padStart(w, '0');

/** Short tile id for a SW corner, e.g. (46, 8) → "N46_00_E008_00", (−1, −1) → "S01_00_W001_00". */
export function glo30TileId(south, west) {
  return `${south < 0 ? 'S' : 'N'}${pad(Math.abs(south), 2)}_00_${west < 0 ? 'W' : 'E'}${pad(Math.abs(west), 3)}_00`;
}

export const glo30TileName = (south, west) => `Copernicus_DSM_COG_10_${glo30TileId(south, west)}_DEM`;

export function glo30TileUrl(south, west) {
  const name = glo30TileName(south, west);
  return `${GLO30_BUCKET}/${name}/${name}.tif`;
}

/** The same tile in the GLO-90 bucket (only HEAD-checked, to tell ocean from unreleased land). */
export function glo90TileUrl(south, west) {
  const name = `Copernicus_DSM_COG_30_${glo30TileId(south, west)}_DEM`;
  return `${GLO90_BUCKET}/${name}/${name}.tif`;
}

/** HTTP status of a HEAD request, retrying 429/5xx and network errors. */
async function headStatus(url, retries = 5) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } });
      if (res.status !== 429 && res.status < 500) return res.status;
      lastErr = new Error(`HEAD ${url}: HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(Math.min(30_000, 1000 * 2 ** attempt));
  }
  throw lastErr;
}

/** The tile band (SW-corner latitude) that owns lattice row k (lat k/R): tiles own (S, S+1]. */
const bandOfRow = (k, R) => Math.ceil(k / R) - 1;

/**
 * The tiles a bilinear read anywhere inside `bbox` touches: every tile holding
 * one of the lattice rows/columns that bracket the box. Ordered north → south,
 * west → east. Also returns the lattice ranges the sampler clamps to.
 */
export function glo30TilesForBbox(bbox, grid = GLO30_GRID) {
  if (!(bbox.south < bbox.north) || !(bbox.west < bbox.east)) throw new Error(`bad bbox ${JSON.stringify(bbox)}`);
  if (bbox.west < -180 || bbox.east > 180 || bbox.south < -90 || bbox.north > 90) throw new Error('bbox must lie inside ±180° / ±90° (no antimeridian wrap)');
  const R = grid.rowsPerDegree;
  const kMin = Math.floor(bbox.south * R);
  const kMax = Math.max(Math.ceil(bbox.north * R), kMin + 1);
  const tiles = [];
  for (let s = bandOfRow(kMax, R); s >= bandOfRow(kMin, R); s--) {
    const C = grid.colsPerDegree(s);
    const mMin = Math.floor(bbox.west * C);
    const mMax = Math.max(Math.ceil(bbox.east * C), mMin + 1);
    for (let w = Math.floor(mMin / C); w <= Math.floor(mMax / C); w++) tiles.push({ south: s, west: w, id: glo30TileId(s, w) });
  }
  return { kMin, kMax, tiles };
}

/**
 * Check a decoded tile against the grid it should sit on, and return its
 * lattice (rows/columns per degree from ModelPixelScale).
 */
export function checkGlo30Tile(tile, tiff, raster) {
  const ifd = fullResolutionIfd(tiff);
  const geo = geoReference(tiff, ifd);
  const where = `GLO-30 ${tile.id}`;
  if (geo.modelType !== undefined && geo.modelType !== 2) throw new Error(`${where}: GTModelType ${geo.modelType}, expected geographic (2)`);
  if (geo.geographicType !== undefined && geo.geographicType !== 4326) throw new Error(`${where}: GeographicType ${geo.geographicType}, expected WGS 84 (4326)`);
  if (geo.noData !== undefined) throw new Error(`${where}: declares nodata ${geo.noData}; void filling is not implemented`);
  const C = Math.round(1 / geo.scaleX);
  const R = Math.round(1 / geo.scaleY);
  const eps = 1e-9;
  if (Math.abs(C * geo.scaleX - 1) > 1e-6 || Math.abs(R * geo.scaleY - 1) > 1e-6) {
    throw new Error(`${where}: pixel scale ${geo.scaleX}×${geo.scaleY}° is not a whole fraction of a degree`);
  }
  if (raster.width !== C || raster.height !== R) throw new Error(`${where}: ${raster.width}×${raster.height} pixels, but its pixel scale gives ${C}×${R} per degree`);
  // Pixel (0, 0) is centred on the tile's NW corner (PixelIsPoint) — see the header.
  if (Math.abs(geo.x0 - tile.west) > eps || Math.abs(geo.y0 - (tile.south + 1)) > eps) {
    throw new Error(`${where}: first pixel centre at (${geo.y0}, ${geo.x0}), expected (${tile.south + 1}, ${tile.west}) (raster type ${geo.rasterType})`);
  }
  return { rowsPerDegree: R, colsPerDegree: C };
}

/**
 * Bilinear sampler over a set of decoded tiles on the whole-arc-second lattice.
 * `tiles`: Map<id, { raster, rowsPerDegree, colsPerDegree } | null> (null = no
 * tile there, ocean, reads 0 m). Rows are interpolated along longitude with
 * their own band's column spacing, then the two rows along latitude, so the
 * read stays bilinear across tile seams and across the 50°/60°/… bands.
 * Reads outside the box clamp to its edge lattice nodes, like fetchDem.
 */
export function glo30Sampler({ bbox, tiles, grid = GLO30_GRID }) {
  const sel = glo30TilesForBbox(bbox, grid);
  const R = grid.rowsPerDegree;
  for (const t of tiles.values()) {
    if (t && t.rowsPerDegree !== R) throw new Error(`GLO-30 tile has ${t.rowsPerDegree} rows per degree, expected ${R}`);
  }
  // Per band: column spacing (from the band's tiles, else the table) and clamp range.
  const bands = new Map();
  for (const tile of sel.tiles) {
    const t = tiles.get(tile.id);
    if (t === undefined) throw new Error(`GLO-30 tile ${tile.id} was not loaded`);
    let band = bands.get(tile.south);
    if (!band) {
      band = { C: null, tiles: new Map() };
      bands.set(tile.south, band);
    }
    if (t) {
      if (band.C !== null && band.C !== t.colsPerDegree) throw new Error(`GLO-30 band ${tile.south}: tiles disagree on columns per degree`);
      band.C = t.colsPerDegree;
    }
    band.tiles.set(tile.west, t ? t.raster : null);
  }
  for (const [s, band] of bands) {
    if (band.C === null) band.C = grid.colsPerDegree(s);
    band.mMin = Math.floor(bbox.west * band.C);
    band.mMax = Math.max(Math.ceil(bbox.east * band.C), band.mMin + 1);
  }

  const node = (band, s, k, m) => {
    const w = Math.floor(m / band.C);
    const raster = band.tiles.get(w);
    if (raster === undefined) throw new Error(`GLO-30 read outside the selected tiles (band ${s}, column tile ${w})`);
    if (raster === null) return 0;
    return raster.value(m - w * band.C, (s + 1) * R - k);
  };
  const row = (k, lon) => {
    const s = bandOfRow(k, R);
    const band = bands.get(s);
    let mf = lon * band.C;
    if (mf < band.mMin) mf = band.mMin;
    if (mf > band.mMax) mf = band.mMax;
    let m = Math.floor(mf);
    if (m > band.mMax - 1) m = band.mMax - 1;
    const t = mf - m;
    const a = node(band, s, k, m);
    return a + (node(band, s, k, m + 1) - a) * t;
  };
  /** sample(lat, lon) → metres, bilinear on the pixel-centre lattice. */
  const sample = (lat, lon) => {
    let kf = lat * R;
    if (kf < sel.kMin) kf = sel.kMin;
    if (kf > sel.kMax) kf = sel.kMax;
    let k = Math.floor(kf);
    if (k > sel.kMax - 1) k = sel.kMax - 1;
    const t = kf - k;
    const south = row(k, lon);
    return south + (row(k + 1, lon) - south) * t;
  };
  return sample;
}

/**
 * Fetch (or read from cache) every GLO-30 tile over `bbox` and return
 * `{ source, tiles, missing, sample }` with sample(lat, lon) → metres.
 * Tiles are cached whole as `<cacheDir>/copernicus-glo30/<name>.tif`; an
 * ocean tile (404 in both the GLO-30 and GLO-90 buckets) is cached as
 * `<name>.404`, so a warm cache never touches the network.
 */
export async function fetchGlo30({ bbox, cacheDir, concurrency = 4, log = () => {}, grid = GLO30_GRID }) {
  const dir = join(cacheDir, 'copernicus-glo30');
  ensureDir(dir);
  const sel = glo30TilesForBbox(bbox, grid);
  const loaded = new Map();
  let fetched = 0;
  let next = 0;
  const work = async () => {
    while (next < sel.tiles.length) {
      const tile = sel.tiles[next++];
      const name = glo30TileName(tile.south, tile.west);
      const marker = join(dir, `${name}.404`);
      if (existsSync(marker)) {
        loaded.set(tile.id, null);
        continue;
      }
      let res;
      try {
        res = await cachedFetch(dir, `${name}.tif`, glo30TileUrl(tile.south, tile.west), {}, { label: `GLO-30 ${tile.id}` });
      } catch (err) {
        if (err.status !== 404) throw err;
        const glo90 = await headStatus(glo90TileUrl(tile.south, tile.west));
        if (glo90 !== 404) {
          throw new Error(
            `GLO-30 ${tile.id} is not public (HTTP 404) but GLO-90 has it (HTTP ${glo90}), so it is land, not ocean: ` +
              'bake this world from the default aws-terrain-tiles source',
          );
        }
        writeFileAtomic(marker, `HTTP 404 ${glo30TileUrl(tile.south, tile.west)}\nHTTP 404 ${glo90TileUrl(tile.south, tile.west)}\nocean: reads 0 m\n`);
        fetched++;
        loaded.set(tile.id, null);
        continue;
      }
      if (!res.cached) fetched++;
      const tiff = parseTiff(res.body);
      const raster = openRaster(tiff);
      loaded.set(tile.id, { raster, ...checkGlo30Tile(tile, tiff, raster) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, sel.tiles.length) }, work));
  const missing = sel.tiles.filter((t) => loaded.get(t.id) === null).map((t) => t.id);
  if (missing.length === sel.tiles.length) throw new Error('GLO-30: every tile over the bbox is missing (open ocean?)');
  log(`dem: ${sel.tiles.length} Copernicus GLO-30 tiles (${fetched} downloaded, ${missing.length} missing → 0 m${missing.length ? `: ${missing.join(', ')}` : ''})`);
  return {
    source: GLO30_SOURCE,
    tiles: sel.tiles.map((t) => t.id),
    missing,
    sample: glo30Sampler({ bbox, tiles: loaded, grid }),
  };
}
