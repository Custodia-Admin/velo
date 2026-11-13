/**
 * The regional bare-earth models added for the wishlist worlds
 * (tools/worldbake/bareGround.mjs): IGN's RGE ALTI from the Géoplateforme
 * WMS (1 km Lambert-93 tiles, Lake Annecy) and the Regione del Veneto's DTM
 * LiDAR 5 m (2 km ESRI ASCII grids in RDN2008 / Fuso 12, named by a WFS tile
 * index, Lake Garda). Tiles are written here as small uncompressed GeoTIFFs
 * and zipped ASCII grids; fetch is stubbed throughout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { crc32 } from 'node:zlib';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { geoKeyAny, openRaster, parseTiff } from '../../../tools/worldbake/geotiff.mjs';
import {
  BARE_GROUND_CREDITS,
  BARE_GROUND_SOURCES,
  IGN_RGE_ALTI,
  VENETO_LIDAR5,
  bareGroundCreditLine,
  bareGroundOptions,
  bareGroundStep,
  checkRgeAltiTile,
  checkVenetoTile,
  lambert93Code,
  parseAsciiGrid,
  rgeAltiSampler,
  rgeAltiTileId,
  rgeAltiTileUrl,
  venetoGridCell,
  venetoIndexUrl,
  venetoSampler,
  venetoTileCell,
  wgs84ToLambert93,
  wgs84ToVenetoZone12,
} from '../../../tools/worldbake/bareGround.mjs';

/** The projections as typed pairs (the .mjs modules carry no types). */
const toL93 = (lat: number, lon: number): [number, number] => wgs84ToLambert93(lat, lon);
const toZ12 = (lat: number, lon: number): [number, number] => wgs84ToVenetoZone12(lat, lon);
import { createProjection } from './projection';

type Key = [number, number | number[] | string];

/**
 * A little-endian, single-strip, uncompressed float32 GeoTIFF: `value(i, j)`
 * per pixel, tiepoint (0, 0) → (x, y), pixel scale, GeoKeys (SHORT values in
 * the directory, number arrays as GeoDoubleParams, strings as GeoAsciiParams),
 * GDAL nodata.
 */
function makeTiff({ width, height, value, x, y, scale, keys, noData = '-99999' }: {
  width: number; height: number; value: (i: number, j: number) => number; x: number; y: number; scale: number; keys: Key[]; noData?: string;
}): Buffer {
  type Entry = { tag: number; type: number; values: number[] | string };
  const doubles: number[] = [];
  let ascii = '';
  const dirKeys: number[] = [];
  for (const [k, v] of keys) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 65536) dirKeys.push(k, 0, 1, v);
    else if (typeof v === 'string') {
      dirKeys.push(k, 34737, v.length + 1, ascii.length);
      ascii += `${v}|`;
    } else {
      const arr = Array.isArray(v) ? v : [v];
      dirKeys.push(k, 34736, arr.length, doubles.length);
      doubles.push(...arr);
    }
  }
  const geoDir = [1, 1, 0, keys.length, ...dirKeys];
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
    ...(doubles.length ? [{ tag: 34736, type: 12, values: doubles }] : []),
    ...(ascii ? [{ tag: 34737, type: 2, values: `${ascii}\0` }] : []),
    { tag: 42113, type: 2, values: `${noData}\0` },
  ];
  const dataIdx = 4;
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
  (entries[dataIdx].values as number[])[0] = dataAt;
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
    buf.writeUInt32LE(e.values.length, p + 4);
    if (extraAt.has(e)) {
      buf.writeUInt32LE(extraAt.get(e)!, p + 8);
      put(e, extraAt.get(e)!);
    } else put(e, p + 8);
  });
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) buf.writeFloatLE(value(i, j), dataAt + 4 * (j * width + i));
  return buf;
}

/** A zip of `files`, stored (the Veneto service deflates; readZip takes both). */
function makeZip(files: [string, Buffer][]): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, n, data);
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
  return Buffer.concat([...parts, cd, end]);
}

/** The keys the Géoplateforme WMS writes: a user-defined Lambert conic 2SP with Lambert-93's parameters. */
const WMS_L93_KEYS: Key[] = [
  [1024, 1], [1025, 1], [1026, 'EPSG:2154'], [2048, 32767], [3072, 32767], [3074, 32767], [3075, 8], [3076, 9001],
  [3078, 49], [3079, 44], [3084, 3], [3085, 46.5], [3086, 700000], [3087, 6600000],
];

describe('bareGround: the regional sources are known to the recipe', () => {
  it('lists them and takes them with the default corridor', () => {
    expect(BARE_GROUND_SOURCES).toEqual(expect.arrayContaining(['ign-rge-alti', 'veneto-lidar5']));
    expect(bareGroundOptions({ bareGround: { source: 'ign-rge-alti' } })).toMatchObject({ corridorM: 150, blendM: 300, biasFrom: 'open' });
    expect(bareGroundOptions({ bareGround: { source: 'veneto-lidar5', blendM: 200 } })).toMatchObject({ corridorM: 150, blendM: 200 });
  });

  it('credits each with its licence and names it in CREDITS.md', () => {
    expect(BARE_GROUND_CREDITS['ign-rge-alti']).toMatchObject({ id: 'ign-rge-alti', licence: expect.stringContaining('Licence Ouverte') });
    expect(BARE_GROUND_CREDITS['ign-rge-alti'].attribution).toContain('© IGN');
    expect(BARE_GROUND_CREDITS['veneto-lidar5']).toMatchObject({ id: 'veneto-lidar5', licence: expect.stringContaining('IODL 2.0') });
    expect(BARE_GROUND_CREDITS['veneto-lidar5'].attribution).toContain('© Regione del Veneto');
    expect(bareGroundCreditLine({ bareGround: { source: 'ign-rge-alti' } })).toMatch(/RGE ALTI®.*ELEVATION\.ELEVATIONGRIDCOVERAGE\.HIGHRES.*Licence Ouverte/);
    expect(bareGroundCreditLine({ bareGround: { source: 'veneto-lidar5' } })).toMatch(/Veneto DTM LiDAR 5 m.*Fuso 12.*rv:c0101071_lidar5m/);
  });
});

describe('bareGround: IGN RGE ALTI (Géoplateforme WMS)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('puts WGS84 into Lambert-93 exactly as PROJ does', () => {
    // pyproj 3 (EPSG:4326 → EPSG:2154), to the millimetre.
    const cases: [number, number, number, number][] = [
      [45.864, 6.144, 943860.3259, 6534226.4698],
      [45.78, 6.218, 949976.9533, 6525137.1925],
      [45.899, 6.129, 942543.5024, 6538063.9671],
      [46.5, 3.0, 700000.0, 6600000.0],
    ];
    for (const [lat, lon, E, N] of cases) {
      const [e, n] = wgs84ToLambert93(lat, lon);
      expect(Math.abs(e - E)).toBeLessThan(0.002);
      expect(Math.abs(n - N)).toBeLessThan(0.002);
    }
  });

  it('cuts 1 km Lambert-93 tiles and asks the WMS for 2 m pixels of each', () => {
    expect(rgeAltiTileId(943860.3, 6534226.5)).toBe('943-6534');
    expect(rgeAltiTileId(944000, 6534999.99)).toBe('944-6534');
    expect(rgeAltiTileUrl('943-6534')).toBe(
      'https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES&STYLES=&CRS=EPSG:2154' +
        '&BBOX=943000,6534000,944000,6535000&WIDTH=500&HEIGHT=500&FORMAT=image/geotiff',
    );
    // A 1 km tile at 2 m: the 500 × 500 pixels the URL asks for.
    expect(IGN_RGE_ALTI.tileM / IGN_RGE_ALTI.pixelM).toBe(500);
  });

  const tile = (x: number, y: number, keys = WMS_L93_KEYS, width = 500, scale = 2) => {
    const tiff = parseTiff(makeTiff({ width, height: width, value: () => 450, x, y, scale, keys }));
    return [tiff, openRaster(tiff)] as const;
  };

  it('reads Lambert-93 from the WMS user-defined keys or from EPSG 2154, nothing else', () => {
    const [wms] = tile(943000, 6535000);
    expect(geoKeyAny(wms, 0, 1026)).toBe('EPSG:2154');
    expect(geoKeyAny(wms, 0, 3085)).toBe(46.5);
    expect(lambert93Code(wms)).toBe(2154);
    expect(lambert93Code(tile(943000, 6535000, [[1024, 1], [1025, 1], [3072, 2154]])[0])).toBe(2154);
    // Another conic with the same citation, a wrong parallel, or no citation.
    const swap = (k: number, v: Key[1]) => WMS_L93_KEYS.map(([a, b]): Key => [a, a === k ? v : b]);
    expect(lambert93Code(tile(943000, 6535000, swap(3078, 47))[0])).toBe(0);
    expect(lambert93Code(tile(943000, 6535000, swap(1026, 'EPSG:27572'))[0])).toBe(0);
    expect(lambert93Code(tile(943000, 6535000, swap(3075, 1))[0])).toBe(0);
    expect(lambert93Code(tile(943000, 6535000, WMS_L93_KEYS.filter(([k]) => k !== 1026))[0])).toBe(0);
  });

  it('accepts a tile that is its 1 km at 2 m, refuses any other', () => {
    expect(checkRgeAltiTile('943-6534', ...tile(943000, 6535000)).x0).toBe(943001);
    expect(() => checkRgeAltiTile('943-6534', ...tile(943001, 6535000))).toThrow(/unexpected grid/); // half a pixel off
    expect(() => checkRgeAltiTile('944-6534', ...tile(943000, 6535000))).toThrow(/unexpected grid/);
    expect(() => checkRgeAltiTile('943-6534', ...tile(943000, 6535000, WMS_L93_KEYS, 1000, 1))).toThrow(/1000×1000, 1 m/);
    expect(() => checkRgeAltiTile('943-6534', ...tile(943000, 6535000, [[1024, 1], [1025, 1], [3072, 2056]]))).toThrow(/EPSG 2056/);
  });

  /** Tiles 943-6534 and 944-6534 of a tilted plane in Lambert-93 metres, nodata over the east half of 944-6534. */
  function planeTiles() {
    const plane = (E: number, N: number) => 450 + 0.05 * (E - 943000) - 0.02 * (N - 6534000);
    const tiles = new Map<string, { raster: { width: number; height: number; value: (i: number, j: number) => number }; noData: number }>();
    for (const e of [943, 944]) {
      tiles.set(`${e}-6534`, {
        noData: -99999,
        raster: { width: 500, height: 500, value: (i, j) => (e === 944 && i >= 250 ? -99999 : plane(e * 1000 + 1 + 2 * i, 6535000 - 1 - 2 * j)) },
      });
    }
    return { plane, tiles };
  }

  it('averages k × k pixels round a node, across the tile seam, NaN out where the model has none', () => {
    const { plane, tiles } = planeTiles();
    const proj = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 45.86, lon0: 6.14, k0: 1 });
    // Lambert-93 → WGS84 by Newton on the forward formulas (good to well under a millimetre).
    const at = (E: number, N: number): [number, number] => {
      let [lat, lon] = [45.86, 6.14];
      for (let k = 0; k < 8; k++) {
        const [e0, n0] = wgs84ToLambert93(lat, lon);
        const [e1] = wgs84ToLambert93(lat, lon + 1e-6);
        const [, n1] = wgs84ToLambert93(lat + 1e-6, lon);
        lon += ((E - e0) / (e1 - e0)) * 1e-6;
        lat += ((N - n0) / (n1 - n0)) * 1e-6;
      }
      return [lat, lon];
    };
    expect(proj).toBeTruthy();
    const sample = rgeAltiSampler(tiles, 7);
    // A pixel centre: the 7 × 7 mean of a plane is the plane there.
    expect(sample(...at(943501, 6534501))).toBeCloseTo(plane(943501, 6534501), 3);
    // On the seam (last column of 943-6534, first of 944-6534).
    expect(sample(...at(943999, 6534501))).toBeCloseTo(plane(943999, 6534501), 3);
    // Beside the nodata edge: 5 of the box's 7 columns have a value → their mean; two columns further, 3 of 7 → none.
    const Ew = 944000 + 1 + 2 * 248;
    const land = [-3, -2, -1, 0, 1].flatMap((a) => [-3, -2, -1, 0, 1, 2, 3].map((b) => plane(Ew + 2 * a, 6534501 + 2 * b)));
    expect(sample(...at(Ew, 6534501))).toBeCloseTo(land.reduce((s, v) => s + v, 0) / land.length, 3);
    expect(sample(...at(Ew + 4, 6534501))).toBeNaN();
    expect(sample(...at(946500, 6534501))).toBeNaN(); // tile not loaded
  });

  it('bakes from the WMS once, then from the cache; an exception report is not cached', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'rgealti-'));
    try {
      const projection = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 45.864, lon0: 6.144, k0: 1 });
      const grid = { cols: 41, rows: 41, cellSize: 12, xMin: -240, yMax: 240 };
      const [la0, lo0] = projection.inverse(-200, 0);
      const [la1, lo1] = projection.inverse(200, 0);
      const routes = [{ id: 'r', points: [[la0, lo0, 0], [la1, lo1, 0]] }];
      const groundAt = (E: number, N: number) => 450 + 0.002 * (E - 943000) + 0.001 * (N - 6534000);
      const urls: string[] = [];
      let broken = true;
      const fetchMock = vi.fn(async (url: string) => {
        urls.push(String(url));
        if (broken) {
          broken = false;
          return new Response('<?xml version="1.0"?><ServiceExceptionReport><ServiceException>Too many requests</ServiceException></ServiceExceptionReport>', { status: 200 });
        }
        const m = /BBOX=(\d+),(\d+),(\d+),(\d+)/.exec(String(url))!;
        const x0 = Number(m[1]);
        const y1 = Number(m[4]);
        const tif = makeTiff({ width: 500, height: 500, x: x0, y: y1, scale: 2, keys: WMS_L93_KEYS, value: (i, j) => groundAt(x0 + 1 + 2 * i, y1 - 1 - 2 * j) });
        return new Response(new Uint8Array(tif));
      });
      vi.stubGlobal('fetch', fetchMock);
      const heights = new Float64Array(41 * 41);
      for (let r = 0; r < 41; r++) {
        for (let c = 0; c < 41; c++) {
          const [lat, lon] = projection.inverse(-240 + 12 * c, 240 - 12 * r);
          heights[r * 41 + c] = groundAt(...toL93(lat, lon)) + 1.2;
        }
      }
      const recipe = { bareGround: { source: 'ign-rge-alti', corridorM: 200, blendM: 100 } };
      const step = () => bareGroundStep({ recipe, grid, heights: Float64Array.from(heights), projection, routes, woodlandPolys: [], cacheDir, log: () => {} });
      await expect(step()).rejects.toThrow(/not a GeoTIFF \(<\?xml/);
      const first = await step();
      expect(first.report.source).toBe('ign-rge-alti');
      // The grid reaches 240 m round (943860, 6534226): across the 944 km easting and the 6534 km northing.
      expect(first.report.tiles).toEqual(['943-6533', '943-6534', '944-6533', '944-6534']);
      expect(first.report.biasM).toBeCloseTo(1.2, 2);
      expect(first.bare(0, 0)).toBeCloseTo(groundAt(...toL93(45.864, 6.144)) + 1.2, 1);
      expect(existsSync(join(cacheDir, 'ign-rge-alti', '943-6534.tif'))).toBe(true);
      const calls = fetchMock.mock.calls.length;
      await step();
      expect(fetchMock.mock.calls.length).toBe(calls); // all from the cache
      expect(urls).toHaveLength(5); // the exception report, then each of the 4 tiles once
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

describe('bareGround: Regione del Veneto DTM LiDAR 5 m', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('puts WGS84 into RDN2008 / Fuso 12 (EPSG:7795) exactly as PROJ does', () => {
    // pyproj 3 (EPSG:4326 → EPSG:7795), to the millimetre.
    const cases: [number, number, number, number][] = [
      [45.439, 10.692, 2897659.0425, 5034565.5062],
      [45.5052, 10.733, 2900982.9789, 5041871.6437],
      [45.4734, 10.7158, 2899582.2896, 5038358.7133],
    ];
    for (const [lat, lon, E, N] of cases) {
      const [e, n] = wgs84ToVenetoZone12(lat, lon);
      expect(Math.abs(e - E)).toBeLessThan(0.002);
      expect(Math.abs(n - N)).toBeLessThan(0.002);
    }
    expect(venetoTileCell(2897659.04, 5034565.51)).toBe('1448-2517');
  });

  it('asks the WFS index for the tiles that meet a WGS84 box, lat/lon order', () => {
    const u = new URL(venetoIndexUrl(45.41, 10.66, 45.54, 10.76));
    expect(`${u.origin}${u.pathname}`).toBe(VENETO_LIDAR5.index);
    expect(u.searchParams.get('typeNames')).toBe('rv:c0101071_lidar5m');
    expect(u.searchParams.get('srsName')).toBe('EPSG:4326');
    expect(u.searchParams.get('bbox')).toBe('45.4100,10.6600,45.5400,10.7600,urn:ogc:def:crs:EPSG::4326');
  });

  /** One 2 km tile's ASCII grid as the region ships it (CRLF, pixel centres in the header). */
  const asc = (cE: number, cN: number, value: (E: number, N: number) => number, header = 'center') => {
    const rows: string[] = [];
    for (let j = 0; j < 400; j++) {
      const N = cN * 2000 + 2000 - 2.5 - 5 * j;
      const row: string[] = [];
      for (let i = 0; i < 400; i++) row.push(value(cE * 2000 + 2.5 + 5 * i, N).toFixed(3));
      rows.push(` ${row.join(' ')}`);
    }
    const ll = header === 'center' ? [`xllcenter     ${cE * 2000 + 2.5}`, `yllcenter     ${cN * 2000 + 2.5}`] : [`xllcorner     ${cE * 2000}`, `yllcorner     ${cN * 2000}`];
    return Buffer.from([`ncols         400`, `nrows         400`, ...ll, `cellsize      5.000`, `nodata_value  -9999.0`, ...rows].join('\r\n'), 'latin1');
  };

  it('parses an ESRI ASCII grid: pixel centres from either header, rows north to south', () => {
    const plane = (E: number, N: number) => 60 + 0.001 * (E - 2897000) + 0.002 * (N - 5034000);
    for (const header of ['center', 'corner']) {
      const g = parseAsciiGrid(asc(1448, 2517, plane, header).toString('latin1'));
      expect([g.width, g.height, g.dx, g.noData]).toEqual([400, 400, 5, -9999]);
      expect(g.x0).toBe(2896002.5);
      expect(g.y0).toBe(5035997.5);
      expect(g.value(0, 0)).toBeCloseTo(plane(2896002.5, 5035997.5), 1);
      expect(g.value(399, 399)).toBeCloseTo(plane(2897997.5, 5034002.5), 1);
      expect(venetoGridCell(g)).toBe('1448-2517');
      expect(() => checkVenetoTile('12_2K_3228', '1448-2517', g)).not.toThrow();
      expect(() => checkVenetoTile('12_2K_3228', '1449-2517', g)).toThrow(/unexpected grid/);
    }
    expect(() => parseAsciiGrid('ncols 2\nnrows 2\nxllcenter 0\nyllcenter 0\ncellsize 5\nnodata_value -9999\n1 2 3')).toThrow(/3 values for 2×2/);
    expect(() => parseAsciiGrid('nrows 2\n1 2')).toThrow(/bad header/);
  });

  it('averages k × k pixels round a node, across the tile seam, NaN out on the lake', () => {
    const plane = (E: number, N: number) => 70 + 0.01 * (E - 2897000) - 0.004 * (N - 5034000);
    const west = parseAsciiGrid(asc(1448, 2517, plane).toString('latin1'));
    // The east tile's west half is lake (nodata).
    const east = parseAsciiGrid(asc(1449, 2517, (E, N) => (E < 2899000 ? -9999 : plane(E, N))).toString('latin1'));
    const tiles = new Map([['1448-2517', west], ['1449-2517', east]]);
    const sample = venetoSampler(tiles, 3);
    const proj = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 0, lon0: 12, k0: 1 });
    const at = (E: number, N: number) => proj.inverse(E - 3000000, N);
    expect(sample(...at(2897002.5, 5035002.5))).toBeCloseTo(plane(2897002.5, 5035002.5), 3);
    // The last column of the west tile: its box reaches one column into the lake → the 6 land pixels.
    const Es = 2897997.5;
    const land = [-1, 0].flatMap((a) => [-1, 0, 1].map((b) => plane(Es + 5 * a, 5035002.5 + 5 * b)));
    expect(sample(...at(Es, 5035002.5))).toBeCloseTo(land.reduce((s, v) => s + v, 0) / land.length, 3);
    expect(sample(...at(2898502.5, 5035002.5))).toBeNaN(); // out on the lake
    expect(sample(...at(2899502.5, 5035002.5))).toBeCloseTo(plane(2899502.5, 5035002.5), 3); // the east tile's land
    expect(sample(...at(2905002.5, 5035002.5))).toBeNaN(); // tile not loaded
  });

  it('names tiles from the WFS index (polygons ~80 m off), places them by their own header, caches, refuses a non-zip', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'veneto-'));
    try {
      const projection = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 45.4734, lon0: 10.7158, k0: 1 });
      const grid = { cols: 41, rows: 41, cellSize: 12, xMin: -240, yMax: 240 };
      const [la0, lo0] = projection.inverse(-200, 0);
      const [la1, lo1] = projection.inverse(200, 0);
      const routes = [{ id: 'r', points: [[la0, lo0, 0], [la1, lo1, 0]] }];
      const z12 = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 0, lon0: 12, k0: 1 });
      const ground = (E: number, N: number) => 75 + 0.003 * (E - 2899000) + 0.002 * (N - 5038000);
      // Tile names → cells; the route point (2899582, 5038359) lies in cell 1449-2519.
      const named: Record<string, [number, number]> = { '12_2K_3075': [1449, 2519], '12_2K_3076': [1450, 2519], '12_2K_3153': [1449, 2518], '12_2K_2994': [1449, 2520] };
      const ids: Record<string, string> = { '12_2K_3075': '2970', '12_2K_3076': '2971', '12_2K_3153': '3040', '12_2K_2994': '2898' };
      // Index polygons as the geoportal returns them: each tile square shifted 19 m east and 75 m north.
      const ring = ([cE, cN]: [number, number]) =>
        [[0, 0], [2000, 0], [2000, 2000], [0, 2000], [0, 0]].map(([dx, dy]) => {
          const [lat, lon] = z12.inverse(cE * 2000 + dx - 3000000 - 19, cN * 2000 + dy + 75);
          return [lon, lat];
        });
      const index = {
        type: 'FeatureCollection',
        features: Object.entries(named).map(([nome, cell]) => ({ type: 'Feature', properties: { id_pol: ids[nome], nome, fuso: 'Fuso 12', tipologia: 'DTM LIDAR 5M' }, geometry: { type: 'MultiPolygon', coordinates: [[ring(cell)]] } })),
      };
      const downloads: string[] = [];
      let broken = true;
      const fetchMock = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.startsWith(VENETO_LIDAR5.index)) return new Response(JSON.stringify(index));
        const m = /dataDtmLidarId=(\d+)$/.exec(u);
        if (!u.startsWith(VENETO_LIDAR5.download) || !m) return new Response('unexpected', { status: 404 });
        downloads.push(m[1]);
        if (broken && m[1] === '2970') {
          broken = false;
          return new Response('<html>Sessione scaduta</html>', { status: 200 });
        }
        const nome = Object.keys(ids).find((k) => ids[k] === m[1])!;
        const [cE, cN] = named[nome];
        return new Response(new Uint8Array(makeZip([[`${nome}.asc`, asc(cE, cN, ground)]])));
      });
      vi.stubGlobal('fetch', fetchMock);
      const heights = new Float64Array(41 * 41);
      for (let r = 0; r < 41; r++) {
        for (let c = 0; c < 41; c++) {
          const [lat, lon] = projection.inverse(-240 + 12 * c, 240 - 12 * r);
          heights[r * 41 + c] = ground(...toZ12(lat, lon)) - 66.2;
        }
      }
      const recipe = { bareGround: { source: 'veneto-lidar5', corridorM: 200, blendM: 100 } };
      const logs: string[] = [];
      const step = () => bareGroundStep({ recipe, grid, heights: Float64Array.from(heights), projection, routes, woodlandPolys: [], cacheDir, log: (s: string) => logs.push(s) });
      await expect(step()).rejects.toThrow(/12_2K_3075: not a zip \(<html>/);
      expect(existsSync(join(cacheDir, 'veneto-lidar5', '12_2K_3075.asc.zip'))).toBe(false);
      const first = await step();
      expect(first.report).toMatchObject({ source: 'veneto-lidar5', tiles: ['12_2K_3075'] });
      expect(first.report.biasM).toBeCloseTo(-66.2, 2);
      expect(first.bare(0, 0)).toBeCloseTo(ground(...toZ12(45.4734, 10.7158)) - 66.2, 1);
      // Every index polygon that, give or take the slack, meets the wanted cell is a candidate: the
      // neighbours too. Each is placed by its own header, and only the tile of the route's cell is used.
      expect([...new Set(downloads)].sort()).toEqual(['2898', '2970', '2971', '3040']);
      expect(logs.join('\n')).toMatch(/1 Veneto DTM LiDAR 5 m tiles of 1 cells \(4 read, 3 downloaded\), 3×3 px mean per node/);
      const calls = fetchMock.mock.calls.length;
      await step();
      expect(fetchMock.mock.calls.length).toBe(calls); // index and tiles from the cache
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
