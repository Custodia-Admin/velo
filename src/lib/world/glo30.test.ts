/**
 * Copernicus GLO-30 DEM source for the world bake (tools/worldbake/
 * geotiff.mjs + fetchGlo30.mjs): TIFF/BigTIFF parsing, DEFLATE + floating-point
 * predictor decoding, tile/bbox selection and the bilinear sampler. The
 * fixtures in tools/worldbake/fixtures/ were written by tifffile +
 * imagecodecs (make_glo30_fixtures.py), so the decoder is checked against an
 * independent encoder. No network: fetch is stubbed throughout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TAG, decodeFloatPredictor, fullResolutionIfd, geoReference, openRaster, parseTiff } from '../../../tools/worldbake/geotiff.mjs';
import {
  GLO30_CREDIT,
  GLO30_DISCLAIMER,
  GLO30_SOURCE,
  checkGlo30Tile,
  fetchGlo30,
  glo30ColsPerDegree,
  glo30Sampler,
  glo30TileId,
  glo30TileName,
  glo30TileUrl,
  glo30TilesForBbox,
  glo90TileUrl,
} from '../../../tools/worldbake/fetchGlo30.mjs';
import { DEFAULT_DEM_SOURCE, DEM_SOURCES, demSourceOf } from '../../../tools/worldbake/demSource.mjs';
import { CREDITS, MAX_BUNDLE_BROTLI_BYTES, checkBundleBudget, creditsFor, generatorFor, recipeBundleBytes } from '../../../tools/worldbake/bake.mjs';

const FIXTURES = fileURLToPath(new URL('../../../tools/worldbake/fixtures/', import.meta.url));
const fixture = (name: string) => readFileSync(join(FIXTURES, name));

// The fixtures' scaled-down lattice: 36 rows and 24 columns per degree.
const R = 36;
const C = 24;
const GRID = { rowsPerDegree: R, colsPerDegree: () => C };
/** What make_glo30_fixtures.py wrote at column i, row j of the tile at `west`. */
const expected = (i: number, j: number, west: number) => (west - 8) * 100 + 10 + 1.5 * i - 2.25 * j + ((7 * i + 3 * j) % 5) * 0.125;

/** Reference predictor-3 encoder (libtiff fpDiff) for round-trip checks. */
function encodeFloatPredictor(values: Float32Array, width: number) {
  const rows = values.length / width;
  const out = new Uint8Array(values.length * 4);
  const word = new DataView(new ArrayBuffer(4));
  for (let r = 0; r < rows; r++) {
    const planes = new Uint8Array(width * 4);
    for (let s = 0; s < width; s++) {
      word.setFloat32(0, values[r * width + s], false);
      for (let b = 0; b < 4; b++) planes[b * width + s] = word.getUint8(b);
    }
    for (let k = 0; k < planes.length; k++) out[r * width * 4 + k] = (planes[k] - (k > 0 ? planes[k - 1] : 0)) & 0xff;
  }
  return out;
}

describe('geotiff: floating-point predictor (3)', () => {
  it('undoes the byte differencing, then the big-endian byte planes', () => {
    // [1.0, −2.5] = 3F800000, C0200000 → planes 3F C0 | 80 20 | 00 00 | 00 00 → deltas.
    const raw = Uint8Array.from([0x3f, 0x81, 0xc0, 0xa0, 0xe0, 0x00, 0x00, 0x00]);
    expect(Array.from(decodeFloatPredictor(raw, 2, 1))).toEqual([1, -2.5]);
  });

  it('restarts the running sum on every row', () => {
    const raw = Uint8Array.from([0x3f, 0x81, 0xc0, 0xa0, 0xe0, 0x00, 0x00, 0x00, 0x3f, 0x81, 0xc0, 0xa0, 0xe0, 0x00, 0x00, 0x00]);
    expect(Array.from(decodeFloatPredictor(raw, 2, 2))).toEqual([1, -2.5, 1, -2.5]);
  });

  it('round-trips arbitrary float32 bit patterns', () => {
    const width = 7;
    const bits = new Uint32Array(width * 5);
    let seed = 12345;
    for (let i = 0; i < bits.length; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      bits[i] = seed;
    }
    bits[3] = 0x7fc00000; // NaN
    bits[4] = 0x80000000; // −0
    const values = new Float32Array(bits.buffer);
    const back = decodeFloatPredictor(encodeFloatPredictor(values, width), width, 5);
    expect(Array.from(new Uint32Array(back.buffer))).toEqual(Array.from(bits));
  });

  it('rejects a block shorter than the rows it should hold', () => {
    expect(() => decodeFloatPredictor(new Uint8Array(7), 2, 1)).toThrow(/expected 8/);
  });
});

describe('geotiff: TIFF/BigTIFF tiles from an independent encoder', () => {
  // codec = [Compression, Predictor]: 8/3 is what the real GLO-30 tiles use.
  const cases = [
    { file: 'glo30-N46_00_E008_00.tif', west: 8, littleEndian: true, bigTiff: false, block: [16, 16], codec: [8, 3] },
    { file: 'glo30-N46_00_E009_00-bigtiff.tif', west: 9, littleEndian: true, bigTiff: true, block: [16, 16], codec: [8, 3] },
    { file: 'glo30-strips-be.tif', west: 8, littleEndian: false, bigTiff: false, block: [24, 10], codec: [8, 3] },
    // Plain float32 in the file's byte order: big-endian, so reading it little-endian scrambles every sample.
    { file: 'glo30-none-be.tif', west: 8, littleEndian: false, bigTiff: false, block: [16, 16], codec: [1, 1] },
    { file: 'glo30-pred1-be.tif', west: 8, littleEndian: false, bigTiff: false, block: [24, 10], codec: [8, 1] },
    // Full resolution followed by two overviews: the reader must stay on IFD 0.
    { file: 'glo30-overviews.tif', west: 8, littleEndian: true, bigTiff: false, block: [16, 16], codec: [8, 3] },
    { file: 'glo30-nodata.tif', west: 8, littleEndian: true, bigTiff: false, block: [16, 16], codec: [8, 3], noData: '-32767' },
  ];
  for (const c of cases) {
    it(`decodes every pixel of ${c.file} exactly`, () => {
      const tiff = parseTiff(fixture(c.file));
      expect(tiff.littleEndian).toBe(c.littleEndian);
      expect(tiff.bigTiff).toBe(c.bigTiff);
      const raster = openRaster(tiff);
      expect([raster.width, raster.height]).toEqual([C, R]);
      expect([raster.blockWidth, raster.blockHeight]).toEqual(c.block);
      expect([raster.compression, raster.predictor]).toEqual(c.codec);
      const all = raster.readAll();
      let worst = 0;
      for (let j = 0; j < R; j++) for (let i = 0; i < C; i++) worst = Math.max(worst, Math.abs(all[j * C + i] - expected(i, j, c.west)));
      expect(worst).toBe(0);
      // Padded edge tiles and the short last strip still map to the right pixels.
      expect(raster.value(C - 1, R - 1)).toBe(expected(C - 1, R - 1, c.west));
      expect(() => raster.value(C, 0)).toThrow(/outside/);
    });

    it(`reads ModelTiepoint/ModelPixelScale and PixelIsPoint from ${c.file}`, () => {
      const geo = geoReference(parseTiff(fixture(c.file)));
      expect(geo.rasterType).toBe('point');
      expect(geo.modelType).toBe(2);
      expect(geo.geographicType).toBe(4326);
      expect(geo.scaleX).toBeCloseTo(1 / C, 15);
      expect(geo.scaleY).toBeCloseTo(1 / R, 15);
      expect(geo.x0).toBe(c.west); // pixel (0, 0) centred on the NW corner
      expect(geo.y0).toBe(47);
      expect(geo.noData).toBe(c.noData);
    });
  }

  it('picks the full-resolution IFD of a file with overviews, wherever it sits', () => {
    const tiff = parseTiff(fixture('glo30-overviews.tif'));
    expect(tiff.ifds.map((ifd: { tags: Map<number, number[]> }) => ifd.tags.get(TAG.NewSubfileType)?.[0] ?? 0)).toEqual([0, 1, 1]);
    expect(fullResolutionIfd(tiff)).toBe(0);
    // The overviews decode too (2× and 4× reductions), and carry no georeferencing.
    const half = openRaster(tiff, 1);
    expect([half.width, half.height]).toEqual([C / 2, R / 2]);
    expect(half.value(5, 7)).toBe(expected(10, 14, 8));
    expect(() => geoReference(tiff, 2)).toThrow(/no ModelPixelScale/);
    // A reduced-resolution image ahead of the full one is skipped; a file of overviews only is refused.
    const reduced = { tags: new Map([[TAG.NewSubfileType, [1]]]) };
    expect(fullResolutionIfd({ ifds: [reduced, { tags: new Map() }, reduced] })).toBe(1);
    expect(() => fullResolutionIfd({ ifds: [reduced] })).toThrow(/no full-resolution image/);
  });

  it('places pixel centres from the tiepoint pixel (I, J) and the raster type', () => {
    const tiff = parseTiff(fixture('glo30-N46_00_E008_00.tif'));
    // The same grid tied at pixel (3, 2) instead of (0, 0).
    tiff.ifds[0].tags.set(TAG.ModelTiepoint, [3, 2, 0, 8 + 3 / C, 47 - 2 / R, 0]);
    let geo = geoReference(tiff);
    expect(geo.x0).toBeCloseTo(8, 12);
    expect(geo.y0).toBeCloseTo(47, 12);
    // PixelIsArea: the tiepoint names the pixel's NW corner, so centres sit half a pixel in.
    const keys = [...tiff.ifds[0].tags.get(TAG.GeoKeyDirectory)];
    keys[4 + 1 * 4 + 3] = 1; // GTRasterTypeGeoKey (second key) → PixelIsArea
    tiff.ifds[0].tags.set(TAG.GeoKeyDirectory, keys);
    geo = geoReference(tiff);
    expect(geo.rasterType).toBe('area');
    expect(geo.x0).toBeCloseTo(8 + 0.5 / C, 12);
    expect(geo.y0).toBeCloseTo(47 - 0.5 / R, 12);
  });

  it('rejects files that are not TIFF', () => {
    expect(() => parseTiff(Buffer.from('GIF89a, not a tiff'))).toThrow(/not a TIFF/);
  });
});

describe('glo30: tile names and bbox selection', () => {
  it('names tiles by their SW corner like the bucket does', () => {
    expect(glo30TileId(46, 8)).toBe('N46_00_E008_00');
    expect(glo30TileId(-1, -1)).toBe('S01_00_W001_00');
    expect(glo30TileId(0, -180)).toBe('N00_00_W180_00');
    expect(glo30TileName(45, 9)).toBe('Copernicus_DSM_COG_10_N45_00_E009_00_DEM');
    expect(glo30TileUrl(46, 8)).toBe(
      'https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N46_00_E008_00_DEM/Copernicus_DSM_COG_10_N46_00_E008_00_DEM.tif',
    );
    expect(glo90TileUrl(40, 44)).toBe(
      'https://copernicus-dem-90m.s3.amazonaws.com/Copernicus_DSM_COG_30_N40_00_E044_00_DEM/Copernicus_DSM_COG_30_N40_00_E044_00_DEM.tif',
    );
  });

  it('narrows the longitude spacing above 50°, symmetric about the equator', () => {
    expect([46, 49, 50, 59, 60, 69, 70, 79, 80, 84, 85, 89].map(glo30ColsPerDegree)).toEqual([
      3600, 3600, 2400, 2400, 1800, 1800, 1200, 1200, 720, 720, 360, 360,
    ]);
    // S50 spans 50°S–49°S (finer), S51 spans 51°S–50°S.
    expect([-50, -51, -61].map(glo30ColsPerDegree)).toEqual([3600, 2400, 1800]);
  });

  const ids = (bbox: { south: number; west: number; north: number; east: number }, grid?: typeof GRID) =>
    glo30TilesForBbox(bbox, grid).tiles.map((t: { id: string }) => t.id);

  it('picks one tile for a world inside it (Perugia)', () => {
    expect(ids({ south: 43.02891, west: 12.31202, north: 43.16521, east: 12.64172 })).toEqual(['N43_00_E012_00']);
  });

  it('picks four tiles, north → south then west → east, for a box across 46°N and 9°E (Lugano)', () => {
    expect(ids({ south: 45.95, west: 8.85, north: 46.08, east: 9.05 })).toEqual([
      'N46_00_E008_00',
      'N46_00_E009_00',
      'N45_00_E008_00',
      'N45_00_E009_00',
    ]);
  });

  it('follows pixel-centre ownership on whole-degree edges', () => {
    // Row 46.0°N is the first row of N45; row 47.0°N is the first row of N46 (not N47).
    expect(ids({ south: 46, west: 8.1, north: 47, east: 8.5 })).toEqual(['N46_00_E008_00', 'N45_00_E008_00']);
    // Column 9.0°E is the first column of E009.
    expect(ids({ south: 46.2, west: 8.2, north: 46.7, east: 9 })).toEqual(['N46_00_E008_00', 'N46_00_E009_00']);
  });

  it('uses the band spacing above 50° to reach the neighbour column', () => {
    // 4.9999° × 2400 columns/degree = 11999.76 → column 11999 is the last of E004.
    expect(ids({ south: 52.1, west: 4.9999, north: 52.4, east: 5.2 })).toEqual(['N52_00_E004_00', 'N52_00_E005_00']);
    expect(ids({ south: 52.1, west: 5.0001, north: 52.4, east: 5.2 })).toEqual(['N52_00_E005_00']);
    // Only the east edge depends on the spacing: 4.99965° × 2400 = 11999.16 → ceil 12000, the first column of E005.
    // At 3600 columns/degree it would be 17998.74 → 17999, still inside E004.
    expect(ids({ south: 52.1, west: 4.9, north: 52.4, east: 4.99965 })).toEqual(['N52_00_E004_00', 'N52_00_E005_00']);
    // Below 50° the same east edge stays inside E004.
    expect(ids({ south: 46.1, west: 4.9, north: 46.4, east: 4.99965 })).toEqual(['N46_00_E004_00']);
  });

  it('handles the equator and the prime meridian', () => {
    expect(ids({ south: -0.5, west: -0.5, north: 0.5, east: 0.5 })).toEqual([
      'N00_00_W001_00',
      'N00_00_E000_00',
      'S01_00_W001_00',
      'S01_00_E000_00',
    ]);
  });

  it('refuses an empty or wrapped box', () => {
    expect(() => ids({ south: 46, west: 9, north: 46, east: 9.5 })).toThrow(/bad bbox/);
    expect(() => ids({ south: 46, west: 179, north: 46.5, east: -179 })).toThrow(/bad bbox/);
  });
});

describe('glo30: fetch, cache and bilinear sampling', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmpCache = () => {
    const d = mkdtempSync(join(tmpdir(), 'glo30-test-'));
    dirs.push(d);
    mkdirSync(join(d, 'copernicus-glo30'));
    return d;
  };
  const noNetwork = () => {
    const f = vi.fn(async () => {
      throw new Error('network touched');
    });
    vi.stubGlobal('fetch', f);
    return f;
  };
  // Crosses 46°N (N45 below is ocean in this test) and 9°E.
  const bbox = { south: 45.99, west: 8.5, north: 46.5, east: 9.3 };
  const warmCache = () => {
    const cache = tmpCache();
    const dir = join(cache, 'copernicus-glo30');
    copyFileSync(join(FIXTURES, 'glo30-N46_00_E008_00.tif'), join(dir, `${glo30TileName(46, 8)}.tif`));
    copyFileSync(join(FIXTURES, 'glo30-N46_00_E009_00-bigtiff.tif'), join(dir, `${glo30TileName(46, 9)}.tif`));
    writeFileSync(join(dir, `${glo30TileName(45, 8)}.404`), 'ocean\n');
    writeFileSync(join(dir, `${glo30TileName(45, 9)}.404`), 'ocean\n');
    return cache;
  };
  const latOfRow = (j: number) => 47 - j / R;
  const lonOfCol = (i: number, west: number) => west + i / C;

  it('reads a warm cache without touching the network', async () => {
    const fetchSpy = noNetwork();
    const dem = await fetchGlo30({ bbox, cacheDir: warmCache(), grid: GRID });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dem.tiles).toEqual(['N46_00_E008_00', 'N46_00_E009_00', 'N45_00_E008_00', 'N45_00_E009_00']);
    expect(dem.missing).toEqual(['N45_00_E008_00', 'N45_00_E009_00']);
    expect(dem.source).toBe('copernicus-dem-30m/glo30-cog');
  });

  it('returns the pixel at a pixel centre and the bilinear blend between them', async () => {
    noNetwork();
    const { sample } = await fetchGlo30({ bbox, cacheDir: warmCache(), grid: GRID });
    expect(sample(latOfRow(20), lonOfCol(13, 8))).toBeCloseTo(expected(13, 20, 8), 9);
    expect(sample(latOfRow(20.5), lonOfCol(13.5, 8))).toBeCloseTo(
      (expected(13, 20, 8) + expected(14, 20, 8) + expected(13, 21, 8) + expected(14, 21, 8)) / 4,
      9,
    );
    // Arbitrary points against a direct bilinear of the known values.
    let seed = 7;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    for (let n = 0; n < 50; n++) {
      const lat = 46.03 + rnd() * 0.45;
      const lon = 8.5 + rnd() * 0.45;
      const fx = (lon - 8) * C, fy = (47 - lat) * R;
      const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
      const top = expected(i, j, 8) * (1 - tx) + expected(i + 1, j, 8) * tx;
      const bottom = expected(i, j + 1, 8) * (1 - tx) + expected(i + 1, j + 1, 8) * tx;
      expect(sample(lat, lon)).toBeCloseTo(top * (1 - ty) + bottom * ty, 6);
    }
  });

  it('stays bilinear across a tile seam and reads an ocean tile as 0 m', async () => {
    noNetwork();
    const { sample } = await fetchGlo30({ bbox, cacheDir: warmCache(), grid: GRID });
    // Halfway between E008's last column and E009's first (the BigTIFF).
    expect(sample(latOfRow(20), 9 - 0.5 / C)).toBeCloseTo((expected(C - 1, 20, 8) + expected(0, 20, 9)) / 2, 9);
    // Row 46.0°N belongs to N45: ocean.
    expect(sample(46, lonOfCol(13, 8))).toBe(0);
    expect(sample(46 + 0.5 / R, lonOfCol(13, 8))).toBeCloseTo(expected(13, R - 1, 8) / 2, 9);
    // Outside the box it clamps to the nearest lattice node inside (NE corner: lat 46.5, lon 9 + 8/24).
    expect(sample(50, 20)).toBeCloseTo(expected(8, 18, 9), 9);
  });

  it('downloads into the cache, records ocean 404s, then never fetches again', async () => {
    const box = { south: 45.99, west: 8.5, north: 46.5, east: 8.9 };
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string }) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url === glo30TileUrl(46, 8)) return new Response(new Uint8Array(fixture('glo30-N46_00_E008_00.tif')), { status: 200 });
        return new Response(null, { status: 404 });
      }),
    );
    const cache = tmpCache();
    const cold = await fetchGlo30({ bbox: box, cacheDir: cache, grid: GRID });
    expect(calls).toEqual([`GET ${glo30TileUrl(46, 8)}`, `GET ${glo30TileUrl(45, 8)}`, `HEAD ${glo90TileUrl(45, 8)}`]);
    expect(existsSync(join(cache, 'copernicus-glo30', `${glo30TileName(46, 8)}.tif`))).toBe(true);
    expect(existsSync(join(cache, 'copernicus-glo30', `${glo30TileName(45, 8)}.404`))).toBe(true);
    expect(cold.missing).toEqual(['N45_00_E008_00']);

    const fetchSpy = noNetwork();
    const warm = await fetchGlo30({ bbox: box, cacheDir: cache, grid: GRID });
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const [lat, lon] of [[46.2, 8.6], [46.01, 8.77], [46.49, 8.51]]) expect(warm.sample(lat, lon)).toBe(cold.sample(lat, lon));
  });

  it('stops on land the public GLO-30 lacks (404 there, 200 in GLO-90)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === glo30TileUrl(46, 8)) return new Response(new Uint8Array(fixture('glo30-N46_00_E008_00.tif')), { status: 200 });
        if (url === glo90TileUrl(45, 8)) return new Response(null, { status: 200 });
        return new Response(null, { status: 404 });
      }),
    );
    const cache = tmpCache();
    await expect(fetchGlo30({ bbox: { south: 45.99, west: 8.5, north: 46.5, east: 8.9 }, cacheDir: cache, grid: GRID })).rejects.toThrow(/not public/);
    expect(existsSync(join(cache, 'copernicus-glo30', `${glo30TileName(45, 8)}.404`))).toBe(false);
  });

  it('refuses a box where every tile is missing from both buckets (open ocean)', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string }) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        return new Response(null, { status: 404 });
      }),
    );
    const cache = tmpCache();
    await expect(fetchGlo30({ bbox: { south: 45.99, west: 8.5, north: 46.5, east: 8.9 }, cacheDir: cache, grid: GRID })).rejects.toThrow(
      /every tile over the bbox is missing/,
    );
    expect([...calls].sort()).toEqual(
      [`GET ${glo30TileUrl(46, 8)}`, `HEAD ${glo90TileUrl(46, 8)}`, `GET ${glo30TileUrl(45, 8)}`, `HEAD ${glo90TileUrl(45, 8)}`].sort(),
    );
  });

  it('refuses a tile that declares nodata (voids would bake as heights)', () => {
    const tiff = parseTiff(fixture('glo30-nodata.tif'));
    expect(() => checkGlo30Tile({ south: 46, west: 8, id: 'N46_00_E008_00' }, tiff, openRaster(tiff))).toThrow(/declares nodata -32767/);
  });

  it('refuses a raster whose size disagrees with its pixel scale', () => {
    const tiff = parseTiff(fixture('glo30-overviews.tif'));
    const tile = { south: 46, west: 8, id: 'N46_00_E008_00' };
    expect(checkGlo30Tile(tile, tiff, openRaster(tiff))).toEqual({ rowsPerDegree: R, colsPerDegree: C });
    // The 2× overview with IFD 0's georeferencing: 12×18 pixels where the scale says 24×36.
    expect(() => checkGlo30Tile(tile, tiff, openRaster(tiff, 1))).toThrow(/12×18 pixels, but its pixel scale gives 24×36/);
  });

  it('refuses tiles whose rows per degree differ from the grid', () => {
    const raster = openRaster(parseTiff(fixture('glo30-N46_00_E008_00.tif')));
    const box = { south: 46.2, west: 8.2, north: 46.7, east: 8.8 };
    const tiles = (rowsPerDegree: number) => new Map([['N46_00_E008_00', { raster, rowsPerDegree, colsPerDegree: C }]]);
    expect(() => glo30Sampler({ bbox: box, tiles: tiles(3600), grid: GRID })).toThrow(/3600 rows per degree, expected 36/);
    expect(glo30Sampler({ bbox: box, tiles: tiles(R), grid: GRID })(latOfRow(20), lonOfCol(13, 8))).toBeCloseTo(expected(13, 20, 8), 9);
  });

  describe('clamps reads outside the box to its edge nodes where the edge meets a tile boundary', () => {
    const raster = openRaster(parseTiff(fixture('glo30-N46_00_E008_00.tif')));
    const tiles = new Map([['N46_00_E008_00', { raster, rowsPerDegree: R, colsPerDegree: C }]]);

    it('north: the ceil lattice row is a whole degree (46.99 × 36 → 1692 = 47 × 36), so the row above is the next tile', () => {
      const sample = glo30Sampler({ bbox: { south: 46.2, west: 8.2, north: 46.99, east: 8.8 }, tiles, grid: GRID });
      // 8.5°E = column 12; the box's top node is row 0 of N46.
      expect(sample(47.5, 8.5)).toBeCloseTo(expected(12, 0, 8), 9);
      expect(sample(47, 8.5)).toBeCloseTo(expected(12, 0, 8), 9);
    });

    it('north: a box whose north edge is exactly 47°N, read on the edge', () => {
      const sample = glo30Sampler({ bbox: { south: 46.2, west: 8.2, north: 47, east: 8.8 }, tiles, grid: GRID });
      expect(sample(47, 8.5)).toBeCloseTo(expected(12, 0, 8), 9);
      expect(sample(48, 8.5)).toBeCloseTo(expected(12, 0, 8), 9);
    });

    it('east: the ceil lattice column is the last of a tile (8.95 × 24 → 215 = 9 × 24 − 1), so the column after it is the next tile', () => {
      const sample = glo30Sampler({ bbox: { south: 46.2, west: 8.2, north: 46.5, east: 8.95 }, tiles, grid: GRID });
      // Row 20, east of the box: clamps to the tile's last column (23).
      expect(sample(latOfRow(20), 9.5)).toBeCloseTo(expected(C - 1, 20, 8), 9);
      expect(sample(latOfRow(20), 9)).toBeCloseTo(expected(C - 1, 20, 8), 9);
    });
  });

  it('refuses a tile whose tiepoint is not where its name says', () => {
    const tiff = parseTiff(fixture('glo30-N46_00_E008_00.tif'));
    expect(() => checkGlo30Tile({ south: 46, west: 9, id: 'N46_00_E009_00' }, tiff, openRaster(tiff))).toThrow(/first pixel centre/);
    expect(checkGlo30Tile({ south: 46, west: 8, id: 'N46_00_E008_00' }, tiff, openRaster(tiff))).toEqual({ rowsPerDegree: R, colsPerDegree: C });
  });
});

describe('glo30: recipe option and credits', () => {
  it('defaults to the Terrain Tiles source and checks dem fields per source', () => {
    expect(demSourceOf({ dem: { zoom: 13 } })).toBe(DEFAULT_DEM_SOURCE);
    expect(demSourceOf({ dem: { source: 'copernicus-glo30' } })).toBe('copernicus-glo30');
    expect(() => demSourceOf({ dem: { source: 'srtm' } })).toThrow(/not one of/);
    expect(() => demSourceOf({ dem: {} })).toThrow(/zoom/);
    expect(() => demSourceOf({ dem: { source: 'copernicus-glo30', zoom: 13 } })).toThrow(/only applies/);
    const perugia = JSON.parse(readFileSync(fileURLToPath(new URL('../../../tools/worldbake/worlds/perugia.json', import.meta.url)), 'utf8'));
    expect(demSourceOf(perugia)).toBe(DEFAULT_DEM_SOURCE);
  });

  it('documents the same sources in tools/worldbake/recipe.schema.json', () => {
    const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../../../tools/worldbake/recipe.schema.json', import.meta.url)), 'utf8'));
    const branches = schema.properties.dem.oneOf;
    expect(branches.map((b: { properties: { source: { const: string } } }) => b.properties.source.const)).toEqual(DEM_SOURCES);
    expect(branches[0].required).toEqual(['zoom']);
    expect(branches[1].required).toEqual(['source']);
    const perugia = JSON.parse(readFileSync(fileURLToPath(new URL('../../../tools/worldbake/worlds/perugia.json', import.meta.url)), 'utf8'));
    for (const key of schema.required) expect(perugia).toHaveProperty(key);
  });

  it('keeps the default credits byte-for-byte and swaps in the Copernicus GLO-30 credit', () => {
    expect(creditsFor(DEFAULT_DEM_SOURCE)).toBe(CREDITS);
    const glo30 = creditsFor('copernicus-glo30');
    expect(glo30.map((c: { id: string }) => c.id)).toEqual(['osm', 'copernicus-glo30', 'copernicus-glo90', 'osrm-fossgis']);
    expect(GLO30_CREDIT.attribution).toContain(
      '© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved',
    );
  });

  // GLO-30 licence Art. 6(c): whoever distributes the data, modified or not, puts this sentence in the licence or
  // legal notice covering the distribution. The bundle's credit and docs/worlds/CREDITS.md both carry it.
  const ART_6C =
    'The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30';

  it('carries the licence\'s liability disclaimer, verbatim, in the GLO-30 credit and CREDITS.md', () => {
    expect(GLO30_DISCLAIMER).toBe(ART_6C);
    expect(GLO30_CREDIT.licence).toContain(ART_6C);
    expect(creditsFor('copernicus-glo30').find((c: { id: string }) => c.id === 'copernicus-glo30')).toBe(GLO30_CREDIT);
    const doc = readFileSync(fileURLToPath(new URL('../../../docs/worlds/CREDITS.md', import.meta.url)), 'utf8');
    const section = doc.slice(doc.indexOf('### Copernicus DEM GLO-30 Public'), doc.indexOf('### Copernicus DEM GLO-90'));
    const prose = section.replace(/\n\s*>\s*/g, ' ').replace(/\s+/g, ' ');
    expect(prose).toContain(ART_6C);
    // The default credits don't mention GLO-30 at all.
    expect(JSON.stringify(CREDITS)).not.toContain('WorldDEM-30');
  });
});

describe('worldbake: manifest generator and bundle budget', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)));
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

  it('writes the committed bundles\' generator block, key order included, for each source', () => {
    // Perugia bakes from the default source, Lugano from GLO-30 (card t_49b58e90).
    const sources: Record<string, string> = { perugia: DEFAULT_DEM_SOURCE, lugano: 'copernicus-glo30' };
    for (const [id, source] of Object.entries(sources)) {
      const recipe = JSON.parse(read(`tools/worldbake/worlds/${id}.json`).toString('utf8'));
      const shipped = JSON.parse(read(`public/worlds/${id}/manifest.json`).toString('utf8')).generator;
      const bundleBytes = recipeBundleBytes(recipe);
      expect(demSourceOf(recipe), id).toBe(source);
      const glo30 = source === 'copernicus-glo30';
      const gen = generatorFor(source, recipe, { source: glo30 ? GLO30_SOURCE : 'unused', tiles: new Array(shipped.demTiles) });
      expect(Object.keys(gen)).toEqual(['tool', 'version', 'recipeSha256', 'osmDate', 'demSource', ...(glo30 ? [] : ['demZoom']), 'demTiles']);
      // recipeSha256 covers the recipe minus its P1.3 `validation` block, so the shipped bundle
      // names the recipe that built it even after the bake writes its check back into the recipe.
      expect(gen.recipeSha256).toBe(sha(bundleBytes));
      expect(JSON.stringify(gen)).toBe(JSON.stringify(shipped));
      if (glo30) expect(shipped.demSource).toBe('copernicus-dem-30m/glo30-cog');
      else expect(gen.demZoom).toBe(recipe.dem.zoom);
    }
  });

  it('leaves the P1.3 validation block out of recipeSha256, and nothing else', () => {
    const recipe = JSON.parse(read('tools/worldbake/worlds/perugia.json').toString('utf8'));
    const bytes = recipeBundleBytes(recipe);
    expect(recipeBundleBytes({ ...recipe, validation: { sample_seed: 1, pass: false } })).toEqual(bytes);
    expect(JSON.parse(bytes.toString('utf8'))).not.toHaveProperty('validation');
    expect(recipeBundleBytes({ ...recipe, osmDate: '2026-10-02T00:00:00Z' })).not.toEqual(bytes);
    expect(recipeBundleBytes({ ...recipe, grid: { ...recipe.grid, cellSize: recipe.grid.cellSize + 1 } })).not.toEqual(bytes);
  });

  it('hashes the recipe without its validation block in the generator, never the recipe file', () => {
    // The bake writes its P1.3 block back into the recipe file, so a hash of
    // the file would name a recipe the bundle wasn't baked from.
    const file = read('tools/worldbake/worlds/lugano.json');
    const recipe = JSON.parse(file.toString('utf8'));
    const dem = { source: 'unused', tiles: [] };
    const gen = generatorFor(demSourceOf(recipe), recipe, dem);
    expect(gen.recipeSha256).toBe(sha(recipeBundleBytes(recipe)));
    expect(gen.recipeSha256).not.toBe(sha(file));
    expect(gen.recipeSha256).not.toBe(sha(Buffer.from(JSON.stringify(recipe))));
    const rewritten = { ...recipe, validation: { ...recipe.validation, registered_rms_m: 1, pass: true } };
    expect(generatorFor(demSourceOf(rewritten), rewritten, dem).recipeSha256).toBe(gen.recipeSha256);
    const moved = { ...recipe, osmDate: '2026-10-02T00:00:00Z' };
    expect(generatorFor(demSourceOf(moved), moved, dem).recipeSha256).not.toBe(gen.recipeSha256);
  });

  it('names the GLO-30 source and drops demZoom for a GLO-30 recipe', () => {
    const recipeBytes = Buffer.from('{"osmDate":"2026-10-01T00:00:00Z","dem":{"source":"copernicus-glo30"}}');
    const recipe = JSON.parse(recipeBytes.toString('utf8'));
    const gen = generatorFor(demSourceOf(recipe), recipe, { source: GLO30_SOURCE, tiles: ['N46_00_E008_00', 'N45_00_E008_00'] });
    expect(gen).toEqual({
      tool: 'velo-worldbake',
      version: 1,
      recipeSha256: sha(recipeBytes),
      osmDate: '2026-10-01T00:00:00Z',
      demSource: 'copernicus-dem-30m/glo30-cog',
      demTiles: 2,
    });
    expect(Object.keys(gen)).toEqual(['tool', 'version', 'recipeSha256', 'osmDate', 'demSource', 'demTiles']);
  });

  it('stops the bake above the brotli budget and passes at it', () => {
    expect(MAX_BUNDLE_BROTLI_BYTES).toBe(8e6);
    expect(() => checkBundleBudget({ stored: 0, content: 0, brotli: MAX_BUNDLE_BROTLI_BYTES })).not.toThrow();
    expect(() => checkBundleBudget({ stored: 0, content: 0, brotli: MAX_BUNDLE_BROTLI_BYTES + 1 })).toThrow(/8\.00 MB brotli, over the 8 MB budget/);
  });
});
