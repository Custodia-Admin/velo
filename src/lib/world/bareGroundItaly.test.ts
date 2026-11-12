/**
 * The two Italian bare-earth models (tools/worldbake/bareGround.mjs):
 * Regione Lombardia's DTM 5×5 (ArcGIS ImageServer tiles in UTM 32N) and the
 * MASE PST LiDAR DTM 1 m (0.01° tiles ordered from the PST download service
 * and delivered in a zip). Tiles are written here as small uncompressed
 * GeoTIFFs; fetch is stubbed throughout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRaster, parseTiff } from '../../../tools/worldbake/geotiff.mjs';
import {
  BARE_GROUND_CREDITS,
  LOMBARDIA_DTM5,
  MASE_PST,
  bareGroundCreditLine,
  bareGroundStep,
  boxMean,
  boxPixels,
  checkLombardiaService,
  checkLombardiaTile,
  checkMaseTile,
  lombardiaSampler,
  lombardiaTileId,
  lombardiaTileUrl,
  maseCellId,
  maseFeatureCell,
  maseSampler,
  unzip,
  wgs84ToUtm32,
} from '../../../tools/worldbake/bareGround.mjs';
import { createProjection } from './projection';

/**
 * A little-endian, single-strip, uncompressed float32 GeoTIFF:
 * `value(i, j)` per pixel, tiepoint (0, 0) → (x, y), pixel scale, GeoKeys
 * as [key, value] pairs, GDAL nodata.
 */
function makeTiff({ width, height, value, x, y, scale, keys, noData = '-9999' }: {
  width: number; height: number; value: (i: number, j: number) => number; x: number; y: number; scale: number; keys: [number, number][]; noData?: string;
}): Buffer {
  type Entry = { tag: number; type: number; values: number[] | string };
  const geoDir = [1, 1, 0, keys.length, ...keys.flatMap(([k, v]) => [k, 0, 1, v])];
  const entries: Entry[] = [
    { tag: 256, type: 4, values: [width] },
    { tag: 257, type: 4, values: [height] },
    { tag: 258, type: 3, values: [32] },
    { tag: 259, type: 3, values: [1] },
    { tag: 273, type: 4, values: [0] }, // patched below
    { tag: 277, type: 3, values: [1] },
    { tag: 278, type: 4, values: [height] },
    { tag: 279, type: 4, values: [width * height * 4] },
    { tag: 339, type: 3, values: [3] },
    { tag: 33550, type: 12, values: [scale, scale, 0] },
    { tag: 33922, type: 12, values: [0, 0, 0, x, y, 0] },
    { tag: 34735, type: 3, values: geoDir },
    { tag: 42113, type: 2, values: `${noData}\0` },
  ];
  const size = (e: Entry) => (typeof e.values === 'string' ? e.values.length : e.values.length * ({ 3: 2, 4: 4, 12: 8 } as Record<number, number>)[e.type]);
  const ifdAt = 8;
  const ifdLen = 2 + entries.length * 12 + 4;
  let extra = ifdAt + ifdLen;
  const extraAt = new Map<Entry, number>();
  for (const e of entries) {
    if (size(e) > 4) {
      extraAt.set(e, extra);
      extra += size(e) + (size(e) % 2);
    }
  }
  const dataAt = extra;
  (entries[4].values as number[])[0] = dataAt;
  const buf = Buffer.alloc(dataAt + width * height * 4);
  buf.write('II', 0, 'latin1');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifdAt, 4);
  buf.writeUInt16LE(entries.length, ifdAt);
  const put = (e: Entry, at: number) => {
    if (typeof e.values === 'string') buf.write(e.values, at, 'latin1');
    else e.values.forEach((v, k) => (e.type === 3 ? buf.writeUInt16LE(v, at + 2 * k) : e.type === 4 ? buf.writeUInt32LE(v, at + 4 * k) : buf.writeDoubleLE(v, at + 8 * k)));
  };
  entries.forEach((e, k) => {
    const p = ifdAt + 2 + k * 12;
    buf.writeUInt16LE(e.tag, p);
    buf.writeUInt16LE(e.type, p + 2);
    buf.writeUInt32LE(typeof e.values === 'string' ? e.values.length : e.values.length, p + 4);
    if (extraAt.has(e)) {
      buf.writeUInt32LE(extraAt.get(e)!, p + 8);
      put(e, extraAt.get(e)!);
    } else put(e, p + 8);
  });
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) buf.writeFloatLE(value(i, j), dataAt + 4 * (j * width + i));
  return buf;
}

/** A zip of `files` (stored, or deflated when `deflate`), as the PST service packs an order. */
function makeZip(files: [string, Buffer][], deflate = false): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, raw] of files) {
    const data = deflate ? deflateRawSync(raw) : raw;
    const n = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const UTM_KEYS: [number, number][] = [[1024, 1], [1025, 1], [3072, 32632]];
const GEO_KEYS: [number, number][] = [[1024, 2], [1025, 2], [2048, 4326]];

describe('bareGround: shared box mean', () => {
  it('averages the pixels that have a value when at least half the box does', () => {
    const px = (i: number, j: number) => (i < 0 ? NaN : 10 + i + 100 * j);
    expect(boxMean(px, 5, 5, 3, 3)).toBeCloseTo(515, 9); // a plane reads its centre
    // Box columns −1, 0, 1 round column 0: one column of three has no value.
    expect(boxMean(px, 0, 0, 3, 3)).toBeCloseTo(10.5, 9);
    // Column −1 round column −1: two of three columns missing → 3/9 < half.
    expect(boxMean(px, -1, 0, 3, 3)).toBeNaN();
    expect(boxMean(() => NaN, 0, 0, 1, 1)).toBeNaN();
    expect(boxPixels(12, 5)).toBe(3);
    expect(boxPixels(12, 2)).toBe(7); // swissALTI3D's own k at 12 m
    expect(boxPixels(12, 0.812)).toBe(15);
    expect(boxPixels(12, 1.106)).toBe(11);
  });
});

describe('bareGround: Regione Lombardia DTM 5×5', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('puts WGS84 into UTM 32N exactly as PROJ does', () => {
    // pyproj 3 (EPSG:4326 → EPSG:32632), to the millimetre.
    const cases: [number, number, number, number][] = [
      [46.08, 9.275, 521263.174, 5102972.8592],
      [45.788, 8.747, 480334.943, 5070524.3972],
      [46.0, 9.0, 500000.0, 5094047.4921],
    ];
    for (const [lat, lon, E, N] of cases) {
      const [e, n] = wgs84ToUtm32(lat, lon);
      expect(Math.abs(e - E)).toBeLessThan(0.002);
      expect(Math.abs(n - N)).toBeLessThan(0.002);
    }
  });

  it('cuts 2 km tiles on the service grid and asks for their stored pixels', () => {
    const { xMin, yMax } = LOMBARDIA_DTM5;
    expect(lombardiaTileId(xMin + 1, yMax - 1)).toBe('0-0');
    expect(lombardiaTileId(xMin + 61000, yMax - 64001)).toBe('30-32');
    expect(lombardiaTileId(...wgs84ToUtm32(46.08, 9.275))).toBe('30-31');
    expect(lombardiaTileUrl('30-31')).toBe(
      'https://www.cartografia.servizirl.it/arcgis2/rest/services/BaseMap/DTM5_RL_img/ImageServer/exportImage' +
        '?bbox=520001.8694,5102901.2481,522001.8694,5104901.2481&bboxSR=32632&imageSR=32632&size=400,400' +
        '&format=tiff&pixelType=F32&noData=-9999&interpolation=RSP_NearestNeighbor&compression=LZW&f=image',
    );
  });

  it('refuses a service whose grid moved, and a tile that is not the stored pixels', () => {
    const meta = { pixelSizeX: 5, pixelSizeY: 5, spatialReference: { wkid: 32632 }, extent: { xmin: 460001.8694, ymax: 5166901.2481 } };
    expect(() => checkLombardiaService(meta)).not.toThrow();
    expect(() => checkLombardiaService({ ...meta, pixelSizeX: 2.5 })).toThrow(/no longer serves/);
    expect(() => checkLombardiaService({ ...meta, extent: { xmin: 460000, ymax: 5166901.2481 } })).toThrow(/no longer serves/);
    expect(() => checkLombardiaService({ ...meta, spatialReference: { wkid: 3003 } })).toThrow(/no longer serves/);
    const tile = (x: number, y: number, keys = UTM_KEYS, width = 400) => {
      const tiff = parseTiff(makeTiff({ width, height: width, value: () => 200, x, y, scale: 5, keys }));
      return [tiff, openRaster(tiff)] as const;
    };
    const x0 = LOMBARDIA_DTM5.xMin + 30 * 2000;
    const y1 = LOMBARDIA_DTM5.yMax - 31 * 2000;
    expect(checkLombardiaTile('30-31', ...tile(x0, y1)).x0).toBeCloseTo(x0 + 2.5, 6);
    expect(() => checkLombardiaTile('30-31', ...tile(x0 + 2.5, y1))).toThrow(/unexpected grid/); // resampled half a pixel off
    expect(() => checkLombardiaTile('31-31', ...tile(x0, y1))).toThrow(/unexpected grid/);
    expect(() => checkLombardiaTile('30-31', ...tile(x0, y1, [[1024, 1], [1025, 1], [3072, 3003]]))).toThrow(/EPSG 3003/);
    expect(() => checkLombardiaTile('30-31', ...tile(x0, y1, UTM_KEYS, 200))).toThrow(/200×200/);
  });

  /** Tiles 30-31 and 31-31 of a tilted plane in UTM metres, nodata over a lake strip in 31-31. */
  function planeTiles() {
    const plane = (E: number, N: number) => 250 + 0.03 * (E - 520000) - 0.01 * (N - 5100000);
    const { xMin, yMax } = LOMBARDIA_DTM5;
    const tiles = new Map<string, { raster: { width: number; height: number; value: (i: number, j: number) => number }; noData: number }>();
    for (const c of [30, 31]) {
      tiles.set(`${c}-31`, {
        noData: -9999,
        raster: {
          width: 400,
          height: 400,
          value: (i, j) => (c === 31 && i >= 200 ? -9999 : plane(xMin + c * 2000 + 2.5 + 5 * i, yMax - 31 * 2000 - 2.5 - 5 * j)),
        },
      });
    }
    return { plane, tiles };
  }

  it('averages k × k stored pixels round a node, across tile seams, NaN out on the water', () => {
    const { plane, tiles } = planeTiles();
    const { xMin, yMax } = LOMBARDIA_DTM5;
    const proj = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 0, lon0: 9, k0: 0.9996 });
    const at = (E: number, N: number) => proj.inverse(E - 500000, N);
    const sample = lombardiaSampler(tiles, 3);
    // A pixel centre: the 3 × 3 mean of a plane is the plane there.
    const E = xMin + 30 * 2000 + 2.5 + 5 * 100;
    const N = yMax - 31 * 2000 - 2.5 - 5 * 100;
    expect(sample(...at(E, N))).toBeCloseTo(plane(E, N), 3);
    // On the seam between the tiles (last column of 30-31, first of 31-31).
    const Es = xMin + 31 * 2000 - 2.5;
    expect(sample(...at(Es, N))).toBeCloseTo(plane(Es, N), 3);
    // Beside the lake edge: one of three columns on the water → the land pixels' mean.
    const Ew = xMin + 31 * 2000 + 2.5 + 5 * 199;
    const land = [-1, 0].flatMap((a) => [-1, 0, 1].map((b) => plane(Ew + 5 * a, N + 5 * b)));
    expect(sample(...at(Ew, N))).toBeCloseTo(land.reduce((s, v) => s + v, 0) / land.length, 3);
    expect(sample(...at(Ew + 10, N))).toBeNaN();
    expect(sample(...at(xMin + 33 * 2000, N))).toBeNaN(); // tile not loaded
  });

  it('bakes from the ImageServer once, then from the cache; an error body is not cached', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'lombardia-'));
    try {
      const projection = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 46.08, lon0: 9.275, k0: 1 });
      const grid = { cols: 41, rows: 41, cellSize: 12, xMin: -240, yMax: 240 };
      const [la0, lo0] = projection.inverse(-200, 0);
      const [la1, lo1] = projection.inverse(200, 0);
      const routes = [{ id: 'r', points: [[la0, lo0, 0], [la1, lo1, 0]] }];
      const groundAt = (E: number, N: number) => 300 + 0.001 * (E - 521000) + 0.002 * (N - 5103000);
      const urls: string[] = [];
      let broken = true;
      const fetchMock = vi.fn(async (url: string) => {
        urls.push(String(url));
        if (String(url).endsWith('?f=json')) {
          return new Response(JSON.stringify({ pixelSizeX: 5, pixelSizeY: 5, spatialReference: { wkid: 32632 }, extent: { xmin: 460001.8694, ymax: 5166901.2481 } }));
        }
        if (broken) {
          broken = false;
          return new Response('{"error":{"code":400,"message":"The requested image exceeds the size limit."}}', { status: 200, headers: { 'Content-Type': 'image/tiff' } });
        }
        const m = /bbox=([\d.]+),([\d.]+),([\d.]+),([\d.]+)/.exec(String(url))!;
        const x0 = Number(m[1]);
        const y1 = Number(m[4]);
        const tif = makeTiff({ width: 400, height: 400, x: x0, y: y1, scale: 5, keys: UTM_KEYS, value: (i, j) => groundAt(x0 + 2.5 + 5 * i, y1 - 2.5 - 5 * j) });
        return new Response(new Uint8Array(tif));
      });
      vi.stubGlobal('fetch', fetchMock);
      // Surface 6 m over the ground plus a datum offset, open land.
      const heights = new Float64Array(41 * 41);
      for (let r = 0; r < 41; r++) {
        for (let c = 0; c < 41; c++) {
          const [lat, lon] = projection.inverse(-240 + 12 * c, 240 - 12 * r);
          heights[r * 41 + c] = groundAt(...(wgs84ToUtm32(lat, lon) as [number, number])) + 0.8;
        }
      }
      const recipe = { bareGround: { source: 'lombardia-dtm5', corridorM: 200, blendM: 100 } };
      const step = () => bareGroundStep({ recipe, grid, heights: Float64Array.from(heights), projection, routes, woodlandPolys: [], cacheDir, log: () => {} });
      await expect(step()).rejects.toThrow(/not a GeoTIFF \(\{"error"/);
      expect(readFileSync(join(cacheDir, 'lombardia-dtm5', 'service.json'), 'utf8')).toContain('32632');
      const first = await step();
      expect(first.report.source).toBe('lombardia-dtm5');
      expect(first.report.tiles).toEqual(['30-31', '30-32']); // the node is 71 m from the tiles' seam
      expect(first.report.biasM).toBeCloseTo(0.8, 2);
      expect(first.bare(0, 0)).toBeCloseTo(groundAt(...(wgs84ToUtm32(46.08, 9.275) as [number, number])) + 0.8, 1);
      const calls = fetchMock.mock.calls.length;
      await step();
      expect(fetchMock.mock.calls.length).toBe(calls); // all from the cache
      expect(urls.filter((u) => u.includes('exportImage'))).toHaveLength(3); // the error body, then each tile once
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

describe('bareGround: MASE PST LiDAR DTM 1 m', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names 0.01° cells by their south-west corner, from points and from the tile index', () => {
    expect(maseCellId(43.1300, 12.0550)).toBe('4313-1205');
    expect(maseCellId(43.13, 12.05)).toBe('4313-1205'); // exactly on the corner
    expect(maseCellId(43.1399999, 12.0599999)).toBe('4313-1205');
    const ring = [[12.05, 43.13], [12.06, 43.13], [12.06, 43.14], [12.05, 43.14], [12.05, 43.13]];
    expect(maseFeatureCell({ attributes: { tavola: 'D43131205_0101' }, geometry: { rings: [ring] } })).toBe('4313-1205');
    expect(() => maseFeatureCell({ attributes: { tavola: 'x' } })).toThrow(/no polygon/);
  });

  const tileOf = (cell: string, value: (i: number, j: number) => number = () => 256, keys = GEO_KEYS, size = 1000) => {
    const [la, lo] = cell.split('-').map(Number);
    return makeTiff({ width: size, height: size, value, x: lo / 100 + 5e-6, y: (la + 1) / 100 - 5e-6, scale: 1e-5, keys });
  };

  it('accepts a tile whose pixel centres sit on its cell, refuses any other', () => {
    const ok = parseTiff(tileOf('4313-1205'));
    expect(checkMaseTile('4313-1205', ok, openRaster(ok)).rasterType).toBe('point');
    expect(() => checkMaseTile('4313-1206', ok, openRaster(ok))).toThrow(/unexpected grid/);
    const area = parseTiff(tileOf('4313-1205', () => 256, [[1024, 2], [1025, 1], [2048, 4326]]));
    expect(() => checkMaseTile('4313-1205', area, openRaster(area))).toThrow(/area/); // PixelIsArea: half a pixel off
    const small = parseTiff(tileOf('4313-1205', () => 256, GEO_KEYS, 500));
    expect(() => checkMaseTile('4313-1205', small, openRaster(small))).toThrow(/500×500/);
  });

  it('averages the pixels within half a cell, across cells, NaN on the lake', () => {
    // Two cells side by side; heights rise 1 m per pixel east; the east cell's top half is lake.
    const raster = (lo: number, lake: boolean) => ({
      width: 1000,
      height: 1000,
      value: (i: number, j: number) => (lake && j < 500 ? -9999 : 256 + (lo * 1000 + i) * 0.001),
    });
    const tiles = new Map([
      ['4313-1205', { raster: raster(1205, false), noData: -9999 }],
      ['4313-1206', { raster: raster(1206, true), noData: -9999 }],
    ]);
    const sample = maseSampler(tiles, 12);
    const centre = (I: number, J: number) => [(J + 0.5) * 1e-5, (I + 0.5) * 1e-5] as const;
    expect(sample(...centre(1205500, 4313300))).toBeCloseTo(256 + 1205500 * 0.001, 6);
    // On the seam: the box spans both cells (the plane is the same across).
    expect(sample(...centre(1205999, 4313300))).toBeCloseTo(256 + 1205999 * 0.001, 6);
    // Well inside the lake half: no value. On the shore, 6 of the box's 11 rows are land: their mean;
    // one row further out, 5 of 11: no value.
    expect(sample(...centre(1206500, 4313800))).toBeNaN();
    expect(sample(...centre(1206500, 4313499))).toBeCloseTo(256 + 1206500 * 0.001, 6);
    expect(sample(...centre(1206500, 4313500))).toBeNaN();
    expect(sample(43.2, 12.2)).toBeNaN();
  });

  it('reads stored and deflated zip entries', () => {
    const a = Buffer.from('tile bytes');
    const b = Buffer.from('x'.repeat(5000));
    for (const deflate of [false, true]) {
      const files = unzip(makeZip([['umbria_145_D43131205_0101_DTM.tiff', a], ['quadro_unione/quadro.shp', b]], deflate));
      expect([...files.keys()]).toEqual(['umbria_145_D43131205_0101_DTM.tiff', 'quadro_unione/quadro.shp']);
      expect(Buffer.compare(files.get('quadro_unione/quadro.shp')!, b)).toBe(0);
    }
    expect(() => unzip(Buffer.alloc(100))).toThrow(/end of central directory/);
  });

  it('orders the tiles it lacks from the PST service, polls, unzips and caches them', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'mase-'));
    try {
      const projection = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 43.135, lon0: 12.055, k0: 1 });
      const grid = { cols: 31, rows: 31, cellSize: 12, xMin: -180, yMax: 180 };
      const [la0, lo0] = projection.inverse(-150, 0);
      const [la1, lo1] = projection.inverse(150, 0);
      const routes = [{ id: 'r', points: [[la0, lo0, 0], [la1, lo1, 0]] }];
      const cellRing = (la: number, lo: number) => [[lo / 100, la / 100], [(lo + 1) / 100, la / 100], [(lo + 1) / 100, (la + 1) / 100], [lo / 100, (la + 1) / 100]];
      const index = {
        features: [
          { attributes: { fid: 7, tavola: 'D43131205_0101', regione: 'Umbria', contratto: '145', data: '100313' }, geometry: { rings: [cellRing(4313, 1205)] } },
          { attributes: { fid: 8, tavola: 'D43131206_0101', regione: 'Umbria', contratto: ' ', data: '' }, geometry: { rings: [cellRing(4313, 1206)] } },
        ],
      };
      const posted: unknown[] = [];
      let polls = 0;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.startsWith(MASE_PST.index)) return new Response(JSON.stringify(index));
        if (u === MASE_PST.api && init?.method === 'POST') {
          posted.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ idSessione: 'abc', reason: 'OK' }), { status: 202 });
        }
        if (u === `${MASE_PST.api}/abc`) {
          polls++;
          return new Response(JSON.stringify(polls < 2 ? { status: 'pending' } : { status: 'ready', expected: 1, urls: [`${MASE_PST.internal}/api/v1/files/abc.zip`] }));
        }
        if (u === `${MASE_PST.external}/api/v1/files/abc.zip`) {
          return new Response(new Uint8Array(makeZip([['umbria_145_D43131205_0101_DTM.tiff', tileOf('4313-1205', () => 300)], ['area_selezionata/tile_selezionate.csv', Buffer.from('fid\n7\n')]])));
        }
        return new Response('unexpected', { status: 404 });
      });
      vi.stubGlobal('fetch', fetchMock);
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      const heights = new Float64Array(31 * 31).fill(301.5);
      const recipe = { bareGround: { source: 'mase-pst-lidar' } };
      const logs: string[] = [];
      const run = bareGroundStep({ recipe, grid, heights, projection, routes, woodlandPolys: [], cacheDir, log: (m: string) => logs.push(m) });
      await vi.runAllTimersAsync();
      const { report, bare } = await run;
      vi.useRealTimers();
      expect(posted).toEqual([{ canale: 'PST2', prodotto: 'LIDAR_2014', layer: 'dtm_1x1', tileList: [{ fid: '7', tavola: 'D43131205_0101', regione: 'Umbria', contratto: '145' }], metadataList: [] }]);
      expect(existsSync(join(cacheDir, 'mase-pst-lidar', 'D43131205_0101.tif'))).toBe(true);
      expect(report).toMatchObject({ source: 'mase-pst-lidar', tiles: ['D43131205_0101'] });
      expect(report.biasM).toBeCloseTo(1.5, 6);
      expect(bare(0, 0)).toBeCloseTo(301.5, 6);
      expect(logs.join('\n')).toMatch(/1 MASE PST LiDAR 1 m tiles \(1 downloaded, \d+ cells the survey left out\)/);
      // A second bake reads the index and the tile from the cache.
      const before = fetchMock.mock.calls.length;
      await bareGroundStep({ recipe, grid, heights: new Float64Array(31 * 31).fill(301.5), projection, routes, woodlandPolys: [], cacheDir, log: () => {} });
      expect(fetchMock.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

describe('bareGround: Italian credits', () => {
  it('credits each model with its licence and names it in CREDITS.md', () => {
    expect(BARE_GROUND_CREDITS['lombardia-dtm5']).toMatchObject({ id: 'lombardia-dtm5', licence: expect.stringContaining('CC BY 4.0') });
    expect(BARE_GROUND_CREDITS['mase-pst-lidar']).toMatchObject({ id: 'mase-pst-lidar', licence: expect.stringContaining('CC BY 4.0') });
    expect(bareGroundCreditLine({ source: 'lombardia-dtm5' })).toMatch(/Regione Lombardia DTM 5x5 \(ed\. 2015\).*CC BY 4\.0/);
    expect(bareGroundCreditLine({ source: 'mase-pst-lidar' })).toMatch(/Piano Straordinario di Telerilevamento Ambientale.*CC BY 4\.0/);
    expect(() => bareGroundCreditLine({ source: 'fabdem' })).toThrow(/no credit line/);
  });
});
