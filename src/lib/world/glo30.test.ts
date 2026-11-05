/**
 * Copernicus GLO-30 DEM source for the world bake (tools/worldbake/
 * geotiff.mjs + fetchGlo30.mjs): TIFF/BigTIFF parsing, DEFLATE + floating-point
 * predictor decoding, tile/bbox selection and the bilinear sampler. The
 * fixtures in tools/worldbake/fixtures/ were written by tifffile +
 * imagecodecs (make_glo30_fixtures.py), so the decoder is checked against an
 * independent encoder. No network: fetch is stubbed throughout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFloatPredictor, geoReference, openRaster, parseTiff } from '../../../tools/worldbake/geotiff.mjs';
import {
  GLO30_CREDIT,
  checkGlo30Tile,
  fetchGlo30,
  glo30ColsPerDegree,
  glo30TileId,
  glo30TileName,
  glo30TileUrl,
  glo30TilesForBbox,
  glo90TileUrl,
} from '../../../tools/worldbake/fetchGlo30.mjs';
import { DEFAULT_DEM_SOURCE, DEM_SOURCES, demSourceOf } from '../../../tools/worldbake/demSource.mjs';
import { CREDITS, creditsFor } from '../../../tools/worldbake/bake.mjs';

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
  const cases = [
    { file: 'glo30-N46_00_E008_00.tif', west: 8, littleEndian: true, bigTiff: false, block: [16, 16] },
    { file: 'glo30-N46_00_E009_00-bigtiff.tif', west: 9, littleEndian: true, bigTiff: true, block: [16, 16] },
    { file: 'glo30-strips-be.tif', west: 8, littleEndian: false, bigTiff: false, block: [24, 10] },
  ];
  for (const c of cases) {
    it(`decodes every pixel of ${c.file} exactly`, () => {
      const tiff = parseTiff(fixture(c.file));
      expect(tiff.littleEndian).toBe(c.littleEndian);
      expect(tiff.bigTiff).toBe(c.bigTiff);
      const raster = openRaster(tiff);
      expect([raster.width, raster.height]).toEqual([C, R]);
      expect([raster.blockWidth, raster.blockHeight]).toEqual(c.block);
      expect([raster.compression, raster.predictor]).toEqual([8, 3]);
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
    });
  }

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
});
