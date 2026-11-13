/**
 * Bare ground along the routes (tools/worldbake/bareGround.mjs) and the LZW
 * decoder its DTMs need (tools/worldbake/geotiff.mjs). The LZW fixtures were
 * written by tifffile + imagecodecs (make_glo30_fixtures.py), libtiff's
 * encoder, so the decoder is checked against an independent implementation.
 * No network: fetch is stubbed throughout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeLzw, geoReference, openRaster, parseTiff } from '../../../tools/worldbake/geotiff.mjs';
import {
  BARE_GROUND_CREDITS,
  BARE_GROUND_SOURCES,
  BIAS_FROM,
  applyBareGround,
  bareGroundOptions,
  bareGroundStep,
  checkUsgsTile,
  corridorWeight,
  dilateMask,
  lv95ToWgs84,
  polygonMask,
  routeDistances,
  routeLift,
  swissSampler,
  swissTileId,
  swissTileYears,
  usgsSampler,
  usgsTileName,
  usgsTileUrl,
  wgs84ToLv95,
} from '../../../tools/worldbake/bareGround.mjs';
import {
  checkInegiCoverage,
  inegiBoxSize,
  inegiSampler,
  inegiSheetCell,
  inegiSheetName,
  inegiSheetUrl,
  openInegiSheet,
  parseTmPrj,
  readZip,
  tmForward,
} from '../../../tools/worldbake/inegiMdt.mjs';
import { bundleCredits, generatorFor } from '../../../tools/worldbake/bake.mjs';
import { createProjection } from './projection';

const FIXTURES = fileURLToPath(new URL('../../../tools/worldbake/fixtures/', import.meta.url));
const fixture = (name: string) => readFileSync(join(FIXTURES, name));

/** Pack codes MSB first at `width` bits (no width changes: short streams only). */
function packCodes(codes: number[], width = 9) {
  let bits = '';
  for (const c of codes) bits += c.toString(2).padStart(width, '0');
  while (bits.length % 8) bits += '0';
  return Uint8Array.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
}

describe('geotiff: LZW (Compression 5)', () => {
  it('decodes a hand-packed stream, KwKwK case included', () => {
    expect([...decodeLzw(packCodes([256, 65, 257]), 1)]).toEqual([65]);
    // A, B, then code 258 ("AB", defined by the pair before it).
    expect([...decodeLzw(packCodes([256, 65, 66, 258, 257]), 4)]).toEqual([65, 66, 65, 66]);
    // A then 258 before it exists in the table: "A" + "A" (code === free).
    expect([...decodeLzw(packCodes([256, 65, 258, 257]), 3)]).toEqual([65, 65, 65]);
  });

  it('refuses old-style LZW, overruns, short blocks and codes past the table', () => {
    expect(() => decodeLzw(Uint8Array.from([0x00, 0x01, 0x02]), 4)).toThrow(/old-style/);
    expect(() => decodeLzw(packCodes([256, 65, 66, 258, 257]), 3)).toThrow(/past its 3 bytes/);
    // A block that is full stops reading: trailing codes are ignored, as libtiff does.
    expect([...decodeLzw(packCodes([256, 65, 66, 257]), 1)]).toEqual([65]);
    expect(() => decodeLzw(packCodes([256, 65, 257]), 2)).toThrow(/decoded to 1 bytes, expected 2/);
    expect(() => decodeLzw(packCodes([256, 65, 300, 257]), 4)).toThrow(/beyond the table/);
    expect(() => decodeLzw(packCodes([256, 258, 257]), 4)).toThrow(/right after a ClearCode/);
  });

  it('decodes 32 KiB of noise exactly (the table fills and clears several times), big-endian', () => {
    const tiff = parseTiff(fixture('lzw-noise-be.tif'));
    const r = openRaster(tiff);
    expect([r.width, r.height, r.compression, r.predictor]).toEqual([64, 128, 5, 1]);
    const want = new Float32Array(new Uint8Array(fixture('lzw-noise-be.f32')).buffer);
    for (let j = 0; j < 128; j++) for (let i = 0; i < 64; i++) expect(r.value(i, j)).toBe(want[j * 64 + i]);
  });

  it('decodes a tiled LZW + floating-point predictor tile and its 3DEP georeference', () => {
    const tiff = parseTiff(fixture('lzw-n42w082.tif'));
    const r = openRaster(tiff);
    expect([r.width, r.height, r.compression, r.predictor, r.blockWidth]).toEqual([24, 24, 5, 3, 16]);
    for (let j = 0; j < 24; j++) {
      for (let i = 0; i < 24; i++) {
        const v = i === 10 && j === 10 ? -999999 : Math.fround(200 + 0.75 * i - 0.5 * j + ((5 * i + 11 * j) % 7) * 0.125);
        expect(r.value(i, j)).toBe(v);
      }
    }
    const geo = geoReference(tiff);
    expect(geo.rasterType).toBe('area');
    expect(geo.geographicType).toBe(4269);
    expect(geo.x0).toBeCloseTo(-82.5 + 0.5 / 12, 12);
    expect(geo.y0).toBeCloseTo(42.5 - 0.5 / 12, 12);
    expect(Number(geo.noData)).toBe(-999999);
  });
});

describe('bareGround: recipe block', () => {
  it('is off without the block, fills defaults, and checks each source', () => {
    expect(bareGroundOptions({})).toBeNull();
    expect(BARE_GROUND_SOURCES).toEqual(['usgs-3dep-13', 'swissalti3d', 'inegi-mdt-10k', 'lombardia-dtm5', 'mase-pst-lidar', 'ign-rge-alti', 'veneto-lidar5']);
    expect(bareGroundOptions({ bareGround: { source: 'usgs-3dep-13', tiles: { n42w082: '20230911' } } })).toMatchObject({ corridorM: 150, blendM: 300, biasFrom: 'open' });
    expect(bareGroundOptions({ bareGround: { source: 'swissalti3d', year: 2022, corridorM: 0, blendM: 50 } })).toMatchObject({ corridorM: 0, blendM: 50 });
    expect(() => bareGroundOptions({ bareGround: { source: 'fabdem' } })).toThrow(/source must be one of/);
    expect(() => bareGroundOptions({ bareGround: { source: 'usgs-3dep-13' } })).toThrow(/needs tiles/);
    expect(() => bareGroundOptions({ bareGround: { source: 'usgs-3dep-13', tiles: { n42w082: 'current' } } })).toThrow(/bad entry/);
    expect(() => bareGroundOptions({ bareGround: { source: 'swissalti3d' } })).toThrow(/needs year/);
    expect(() => bareGroundOptions({ bareGround: { source: 'swissalti3d', year: 2022, blendM: 0 } })).toThrow(/blendM > 0/);
    // The Italian models have no release to pin (bareGroundItaly.test.ts).
    expect(bareGroundOptions({ bareGround: { source: 'lombardia-dtm5' } })).toMatchObject({ corridorM: 150, blendM: 300 });
    expect(bareGroundOptions({ bareGround: { source: 'mase-pst-lidar', corridorM: 100 } })).toMatchObject({ corridorM: 100, blendM: 300 });
    const inegi = { source: 'inegi-mdt-10k', sheets: { F13C69A4: '702825005109', F13C68C1: null } };
    expect(bareGroundOptions({ bareGround: inegi })).toMatchObject({ sheets: inegi.sheets, corridorM: 150 });
    expect(() => bareGroundOptions({ bareGround: { source: 'inegi-mdt-10k' } })).toThrow(/needs sheets/);
    expect(() => bareGroundOptions({ bareGround: { source: 'inegi-mdt-10k', sheets: { F13C69A4: 702825005109 } } })).toThrow(/bad entry F13C69A4/);
    expect(() => bareGroundOptions({ bareGround: { source: 'inegi-mdt-10k', sheets: { F13C69G4: '702825005109' } } })).toThrow(/bad entry F13C69G4/);
    expect(() => bareGroundOptions({ bareGround: { source: 'inegi-mdt-10k', sheets: { F13C69A4: '70282500510' } } })).toThrow(/bad entry/);
  });

  it('measures the datum over open ground by default, over the beaches only on request and only in a coast world', () => {
    const b = { source: 'inegi-mdt-10k', sheets: {} };
    expect(bareGroundOptions({ coast: true, bareGround: { ...b, biasFrom: 'beach' } }).biasFrom).toBe('beach');
    expect(() => bareGroundOptions({ bareGround: { ...b, biasFrom: 'beach' } })).toThrow(/biasFrom "beach" needs coast: true/);
    expect(() => bareGroundOptions({ coast: true, bareGround: { ...b, biasFrom: 'sea' } })).toThrow(/biasFrom must be one of open, beach/);
    expect(BIAS_FROM).toEqual(['open', 'beach']);
  });

  it('documents the same block in tools/worldbake/recipe.schema.json and the manifest schema', () => {
    const read = (f: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../tools/worldbake/${f}`, import.meta.url)), 'utf8'));
    const schema = read('recipe.schema.json').properties.bareGround;
    expect(schema.oneOf.map((s: { properties: { source: { const: string } } }) => s.properties.source.const)).toEqual(BARE_GROUND_SOURCES);
    for (const s of schema.oneOf) expect(s.properties.biasFrom.enum).toEqual(BIAS_FROM);
    expect(read('manifest.schema.json').properties.generator.properties.bareGround.enum).toEqual(BARE_GROUND_SOURCES);
  });

  it('credits the DTM right after the DEM it corrects, and names it in the generator', () => {
    const recipe = { routes: [], bareGround: { source: 'usgs-3dep-13', tiles: { n42w082: '20230911' } } };
    const ids = bundleCredits(recipe, 'copernicus-glo30', {}).map((c: { id: string }) => c.id);
    const base = bundleCredits({ routes: [] }, 'copernicus-glo30', {}).map((c: { id: string }) => c.id);
    const at = base.indexOf('copernicus-glo30') + 1;
    expect(ids).toEqual([...base.slice(0, at), 'usgs-3dep', ...base.slice(at)]);
    const dem = { source: 'copernicus-dem-30m/glo30-cog', tiles: [1] };
    expect(generatorFor('copernicus-glo30', recipe, dem).bareGround).toBe('usgs-3dep-13');
    expect(generatorFor('copernicus-glo30', { routes: [] }, dem)).not.toHaveProperty('bareGround');
    for (const c of Object.values(BARE_GROUND_CREDITS)) {
      for (const k of ['id', 'name', 'licence', 'url', 'attribution']) expect(typeof (c as Record<string, string>)[k]).toBe('string');
    }
    // INEGI's free-use terms: "Fuente: INEGI, <product>" and the transformation stated.
    const inegi = BARE_GROUND_CREDITS['inegi-mdt-10k'];
    expect(inegi.id).toBe('inegi-mdt');
    expect(inegi.attribution).toMatch(/^Fuente: INEGI, Modelo Digital de Elevación tipo terreno con resolución de 5 m, escala 1:10 000\. Transformed by Velo, not by INEGI: /);
    expect(inegi.url).toBe('https://www.inegi.org.mx/inegi/terminos.html');
    const mx = { routes: [], coast: true, bareGround: { source: 'inegi-mdt-10k', sheets: { F13C69A4: '702825005109' } } };
    expect(bundleCredits(mx, 'copernicus-glo30', {}).map((c: { id: string }) => c.id)).toEqual([...base.slice(0, at), 'inegi-mdt', ...base.slice(at)]);
    expect(generatorFor('copernicus-glo30', mx, dem).bareGround).toBe('inegi-mdt-10k');
  });
});

describe('bareGround: USGS 3DEP 1/3″ tiles', () => {
  it('names the 1° cell by its NW corner and pins the dated release', () => {
    expect(usgsTileName(41.3, -81.6)).toBe('n42w082');
    expect(usgsTileName(41.0, -81.0)).toBe('n42w081');
    expect(usgsTileName(41.999, -81.001)).toBe('n42w082');
    expect(usgsTileName(46.0, 8.9)).toBe('n47e008');
    expect(usgsTileUrl('n42w082', '20230911')).toBe('https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/historical/n42w082/USGS_13_n42w082_20230911.tif');
  });

  const loaded = () => {
    const tiff = parseTiff(fixture('lzw-n42w082.tif'));
    const raster = openRaster(tiff);
    const geo = checkUsgsTile('n42w082', tiff, raster);
    return { tiff, raster, geo, sample: usgsSampler(new Map([['n42w082', { raster, geo, noData: Number(geo.noData) }]])) };
  };

  it('accepts a tile covering its cell with the overlap, refuses one that does not', () => {
    const { tiff, raster } = loaded();
    expect(() => checkUsgsTile('n43w082', tiff, raster)).toThrow(/don't cover the tile's cell/);
    expect(() => checkUsgsTile('n42w081', tiff, raster)).toThrow(/don't cover the tile's cell/);
  });

  it('samples bilinear from pixel centres, NaN beside nodata and off the loaded tiles', () => {
    const { raster, geo, sample } = loaded();
    const at = (i: number, j: number) => [geo.y0 - j * geo.scaleY, geo.x0 + i * geo.scaleX];
    const [lat, lon] = at(14, 12);
    expect(sample(lat, lon)).toBeCloseTo(raster.value(14, 12), 4);
    const [lat2, lon2] = at(14.5, 12.5);
    const mean = (raster.value(14, 12) + raster.value(15, 12) + raster.value(14, 13) + raster.value(15, 13)) / 4;
    expect(sample(lat2, lon2)).toBeCloseTo(mean, 4);
    const [lat3, lon3] = at(9.5, 9.5); // a neighbour is the nodata pixel (10, 10)
    expect(sample(lat3, lon3)).toBeNaN();
    expect(sample(41.5, -80.5)).toBeNaN(); // n42w081: not loaded
  });
});

describe('bareGround: swissALTI3D', () => {
  it("puts WGS84 into LV95 with swisstopo's approximate formulas, and back (their worked example)", () => {
    const lat = 46 + 2 / 60 + 38.87 / 3600;
    const lon = 8 + 43 / 60 + 49.79 / 3600;
    const [E, N] = wgs84ToLv95(lat, lon);
    expect(E).toBeCloseTo(2699999.76, 1);
    expect(N).toBeCloseTo(1099999.97, 1);
    const [la, lo] = lv95ToWgs84(2700000, 1100000);
    expect(Math.abs(la - lat) * 111000).toBeLessThan(1);
    expect(Math.abs(lo - lon) * 77000).toBeLessThan(1);
    expect(swissTileId(2717392.4, 1093274.9)).toBe('2717-1093');
  });

  /** Two 1 km tiles of a tilted plane, 2 m pixels, nodata in one corner pixel of the second. */
  const tiles = () => {
    const plane = (E: number, N: number) => 300 + 0.05 * (E - 2717000) - 0.02 * (N - 1093000);
    const tile = (e: number, n: number, hole = false) => ({
      e0: e * 1000,
      n0: n * 1000 + 1000,
      noData: -9999,
      raster: {
        width: 500,
        height: 500,
        value: (i: number, j: number) => (hole && i === 0 && j === 0 ? -9999 : plane(e * 1000 + 1 + 2 * i, n * 1000 + 999 - 2 * j)),
      },
    });
    return { plane, map: new Map([['2717-1093', tile(2717, 1093)], ['2718-1093', tile(2718, 1093, true)]]) };
  };

  it('averages k × k pixels round the point (a plane reads its value), NaN over nodata or a missing tile', () => {
    const { plane, map } = tiles();
    const sample = swissSampler(map, 5);
    const [lat, lon] = lv95ToWgs84(2717501, 1093501); // a pixel centre
    expect(sample(lat, lon)).toBeCloseTo(plane(...wgs84ToLv95(lat, lon).map((v) => Math.floor(v / 2) * 2 + 1) as [number, number]), 6);
    // Across the tile seam the box reads both tiles.
    const [la2, lo2] = lv95ToWgs84(2717999, 1093501);
    expect(sample(la2, lo2)).toBeCloseTo(plane(2717999, 1093501), 0);
    const [la3, lo3] = lv95ToWgs84(2718003, 1093997); // the box reaches the nodata pixel at (0, 0) of 2718-1093
    expect(sample(la3, lo3)).toBeNaN();
    const [la4, lo4] = lv95ToWgs84(2719500, 1093500);
    expect(sample(la4, lo4)).toBeNaN();
  });

  it('reads the releases of a tile from the STAC catalogue, only that tile', async () => {
    const fetchJson = vi.fn(async () => ({
      features: [{ id: 'swissalti3d_2019_2717-1093' }, { id: 'swissalti3d_2022_2717-1093' }, { id: 'swissalti3d_2022_2717-1092' }, { id: 'other' }],
    }));
    expect(await swissTileYears('2717-1093', fetchJson)).toEqual([2019, 2022]);
    expect(fetchJson.mock.calls[0][0]).toMatch(/collections\/ch\.swisstopo\.swissalti3d\/items\?bbox=8\.95\d*,45\.98\d*,8\.95\d*,45\.98\d*$/);
  });
});

describe('bareGround: INEGI MDT 1:10 000 (Mexico)', () => {
  // Sheet names and centres from INEGI's own 1:10 000 catalogue (getFormato10k.do res=5 mod=T,
  // web-Mercator centres converted to degrees): every letter band, zone, quarter, 1:20 000 letter
  // and 1:10 000 digit the catalogue holds, plus the eight Puerto Vallarta sheets.
  const CATALOGUE: [string, number, number][] = [
    ['D14B15C4', 15.906253, -97.361111], ['D14B16A3', 15.906253, -97.305556], ['D14B16B4', 15.906253, -97.138889],
    ['D14B16F2', 15.843753, -97.027778], ['D14B18E1', 15.843753, -96.527778], ['D15A11A1', 15.968753, -95.972222],
    ['E11B77F1', 18.343753, -114.75], ['E12A59F2', 18.843753, -111.027778], ['E13D18C1', 17.968753, -102.416667],
    ['E14C11A1', 17.968753, -101.972222], ['E16A11A1', 19.968753, -89.972222], ['F12B11A2', 23.968754, -110.916667],
    ['F13D11C1', 21.968754, -104.75], ['G12C36B2', 25.468754, -112.138889], ['H11C45C4', 29.156255, -118.361111],
    ['H11D14E4', 29.781255, -115.805556], ['I11C69E4', 32.531255, -117.138889], ['I11D61D3', 32.531255, -116.972222],
    ['F13C58F4', 20.78125, -105.361111], ['F13C59D3', 20.78125, -105.305556], ['F13C68C2', 20.71875, -105.361111],
    ['F13C69A1', 20.71875, -105.305556], ['F13C69A4', 20.65625, -105.25], ['F13C69B3', 20.65625, -105.194444],
    ['F13C69D2', 20.59375, -105.25], ['F13C69E1', 20.59375, -105.194444],
  ];

  it("names the 1:10 000 sheet holding a point the way INEGI's catalogue does, and gives its cell", () => {
    for (const [name, lat, lon] of CATALOGUE) {
      expect(inegiSheetName(lat, lon), name).toBe(name);
      const c = inegiSheetCell(name);
      expect(c.north - c.south).toBeCloseTo(3.75 / 60, 12);
      expect(c.east - c.west).toBeCloseTo(10 / 3 / 60, 12);
      expect((c.south + c.north) / 2).toBeCloseTo(lat, 4);
      expect((c.west + c.east) / 2).toBeCloseTo(lon, 4);
    }
    // A cell owns its south and west edges; the north and east edges are the next sheets'.
    const c = inegiSheetCell('F13C69A4');
    expect(inegiSheetName(c.south + 1e-9, c.west + 1e-9)).toBe('F13C69A4');
    expect(inegiSheetName(c.north + 1e-9, c.west + 1e-9)).toBe('F13C69A2');
    expect(inegiSheetName(c.south + 1e-9, c.east + 1e-9)).toBe('F13C69B3');
    expect(() => inegiSheetName(46, 9)).toThrow(/outside Mexico's index/);
    expect(() => inegiSheetCell('F13C69G4')).toThrow(/bad sheet name/);
    expect(inegiSheetUrl('702825005109')).toBe(
      'https://www.inegi.org.mx/contenidos/productos/prod_serv/contenidos/espanol/bvinegi/productos/geografia/imagen_cartografica/1_10_000/lidar/Terreno_ASCII/702825005109_b.zip',
    );
  });

  const POINTS = JSON.parse(fixture('inegi-F13C69A4-points.json').toString());
  const ZIP = fixture('inegi-F13C69A4-coarse_b.zip');

  it('projects to UTM within a millimetre of PROJ (pyproj), in zone 13 and away from it', () => {
    const tm = parseTmPrj(readZip(ZIP).get('conjunto_de_datos/f13c69a4_mt.prj')!.toString('latin1'));
    expect(tm).toMatchObject({ a: 6378137, lon0: -105, k0: 0.9996, fe: 500000, fn: 0, lat0: 0 });
    expect(1 / tm.f).toBeCloseTo(298.257223563, 9);
    for (const p of POINTS.points) {
      const [E, N] = tmForward(p.lat, p.lon, tm);
      expect(Math.abs(E - p.E)).toBeLessThan(1e-3);
      expect(Math.abs(N - p.N)).toBeLessThan(1e-3);
    }
    for (const p of POINTS.utm) {
      const [E, N] = tmForward(p.lat, p.lon, { ...tm, lon0: p.lon0 });
      expect(Math.abs(E - p.E), `zone ${p.zone}`).toBeLessThan(1e-3);
      expect(Math.abs(N - p.N), `zone ${p.zone}`).toBeLessThan(1e-3);
    }
    expect(() => parseTmPrj(tm && 'PROJCS["x",GEOGCS["y",DATUM["z",SPHEROID["w",6378137.0,298.257223563]]],PROJECTION["Lambert_Conformal_Conic"]]')).toThrow(/expected Transverse_Mercator/);
  });

  it("reads Python's zip (backslash paths, deflated and stored members) and refuses a corrupt one", () => {
    const files = readZip(ZIP);
    expect([...files.keys()].sort()).toEqual([
      'conjunto_de_datos/f13c69a4_mt.bil',
      'conjunto_de_datos/f13c69a4_mt.hdr',
      'conjunto_de_datos/f13c69a4_mt.prj',
      'metadatos/f13c69a4_mt_ntm_a.txt',
    ]);
    expect(files.get('conjunto_de_datos/f13c69a4_mt.bil')!.length).toBe(POINTS.cols * POINTS.rows * 4);
    expect(files.get('conjunto_de_datos/f13c69a4_mt.hdr')!.toString('latin1')).toMatch(/^BYTEORDER {6}I\r\n/);
    const bad = Buffer.from(ZIP);
    const at = bad.indexOf(Buffer.from('metadatos\\f13c69a4_mt_ntm_a.txt')) + 'metadatos\\f13c69a4_mt_ntm_a.txt'.length + 2; // inside its deflated data
    bad[at] ^= 0xff;
    expect(() => readZip(bad)).toThrow(/zip: metadatos\/f13c69a4_mt_ntm_a\.txt (fails its CRC-32|inflated to)|invalid|incorrect/);
    expect(() => readZip(Buffer.from('not a zip at all, just bytes that go on for a while.'))).toThrow(/no end-of-central-directory/);
  });

  it("opens the sheet's own terrain model only, and checks it covers the sheet's cell", () => {
    const r = openInegiSheet(ZIP, 'F13C69A4');
    expect([r.cols, r.rows, r.dx, r.dy, r.x0, r.y0]).toEqual([POINTS.cols, POINTS.rows, 100, 100, POINTS.x0, POINTS.y0]);
    expect(r.data[POINTS.nodata[1] * POINTS.cols + POINTS.nodata[0]]).toBe(r.noData);
    expect(() => checkInegiCoverage('F13C69A4', r)).not.toThrow();
    expect(() => checkInegiCoverage('F13C69A1', r)).toThrow(/doesn't cover the sheet's cell/);
    expect(() => openInegiSheet(ZIP, 'F13C69A1')).toThrow(/holds conjunto_de_datos\/f13c69a4_mt\.bil, not f13c69a1_mt\.bil/);
  });

  it('averages the k × k pixels round the point from the sheet holding it; NaN beside nodata or without a sheet', () => {
    const r = openInegiSheet(ZIP, 'F13C69A4');
    const one = inegiSampler(new Map([['F13C69A4', { ...r, k: 1 }]]));
    const three = inegiSampler(new Map([['F13C69A4', { ...r, k: 3 }]]));
    const px = (c: number, j: number) => r.data[j * r.cols + c];
    for (const p of POINTS.points) {
      expect(one(p.lat, p.lon)).toBe(p.value);
      let sum = 0;
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) sum += px(p.col + a, p.row + b);
      expect(three(p.lat, p.lon)).toBeCloseTo(sum / 9, 6);
    }
    // A point in the pixel next to the nodata one: k = 1 reads, k = 3 reaches the hole.
    const [E, N] = [POINTS.x0 + 100 * (POINTS.nodata[0] + 1), POINTS.y0 - 100 * POINTS.nodata[1]];
    const proj = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 0, lon0: -105, k0: 0.9996 });
    const [lat, lon] = proj.inverse(E - 500000, N);
    expect(one(lat, lon)).toBe(px(POINTS.nodata[0] + 1, POINTS.nodata[1]));
    expect(three(lat, lon)).toBeNaN();
    expect(one(20.70, -105.25)).toBeNaN(); // F13C69A2: no sheet loaded
    expect([inegiBoxSize(12, 5), inegiBoxSize(15, 5), inegiBoxSize(25, 5), inegiBoxSize(100, 100), inegiBoxSize(4, 5)]).toEqual([3, 3, 5, 1, 1]);
  });
});

describe('bareGround: corridor geometry', () => {
  const grid = { cols: 21, rows: 11, cellSize: 10, xMin: 0, yMax: 100 };

  it('measures each node to the nearest route line within reach', () => {
    const d = routeDistances(grid, [[0, 50, 200, 50]], 35);
    expect(d[5 * 21 + 3]).toBeCloseTo(0); // on the line (y = 50)
    expect(d[2 * 21 + 3]).toBeCloseTo(30); // y = 80
    expect(d[0]).toBe(Infinity); // y = 100: past reach
  });

  it('weighs the corridor 1, then a smoothstep to 0', () => {
    expect(corridorWeight(0, 150, 300)).toBe(1);
    expect(corridorWeight(150, 150, 300)).toBe(1);
    expect(corridorWeight(300, 150, 300)).toBeCloseTo(0.5);
    expect(corridorWeight(450, 150, 300)).toBe(0);
    const w = [160, 200, 260, 330, 400, 440].map((d) => corridorWeight(d, 150, 300));
    expect(w.every((v, i) => i === 0 || v < w[i - 1])).toBe(true);
  });

  it('rasterises polygons even-odd (a hole stays out) and grows a mask by a disc', () => {
    const outer = [20, 20, 120, 20, 120, 80, 20, 80];
    const hole = [60, 40, 80, 40, 80, 60, 60, 60];
    const mask = polygonMask(grid, [[outer, hole]]);
    const at = (x: number, y: number) => mask[((100 - y) / 10) * 21 + x / 10];
    expect([at(30, 30), at(110, 70), at(70, 50), at(10, 50), at(130, 50)]).toEqual([1, 1, 0, 0, 0]);
    const grown = dilateMask(grid, polygonMask(grid, [[[95, 45, 105, 45, 105, 55, 95, 55]]]), 20);
    const g = (x: number, y: number) => grown[((100 - y) / 10) * 21 + x / 10];
    expect([g(100, 50), g(120, 50), g(130, 50), g(110, 60), g(120, 70)]).toEqual([1, 1, 0, 1, 0]);
  });
});

describe('bareGround: the swap', () => {
  /**
   * A 600 m × 600 m world at 10 m on a 2 % slope. The surface model is the
   * DTM + 1.5 m (the datum), plus 18 m of canopy over a wood west of x = 250.
   * A route runs north–south at x = 300.
   */
  function world() {
    const grid = { cols: 61, rows: 61, cellSize: 10, xMin: 0, yMax: 600 };
    const n = 61 * 61;
    const dtm = new Float64Array(n);
    const heights = new Float64Array(n);
    const woodland = new Uint8Array(n);
    for (let r = 0; r < 61; r++) {
      for (let c = 0; c < 61; c++) {
        const i = r * 61 + c;
        const x = c * 10;
        dtm[i] = 200 + 0.02 * x;
        woodland[i] = x < 250 ? 1 : 0;
        heights[i] = dtm[i] + 1.5 + (woodland[i] ? 18 : 0);
      }
    }
    const dist = routeDistances(grid, [[300, -10, 300, 610]], 1000);
    return { grid, dtm, heights, woodland, dist };
  }

  it('ties the DTM to the surface datum over open ground, and puts the corridor on the ground under the trees', () => {
    const { grid, dtm, heights, woodland, dist } = world();
    const before = Float64Array.from(heights);
    const res = applyBareGround({ grid, heights, dtm, dist, woodland, corridorM: 60, blendM: 120 });
    expect(res.biasM).toBeCloseTo(1.5, 9);
    const at = (x: number, y = 300) => ((600 - y) / 10) * 61 + x / 10;
    // Inside the corridor: DTM + bias, canopy gone (x = 240 is wood, 60 m off the route).
    expect(heights[at(240)]).toBeCloseTo(dtm[at(240)] + 1.5, 9);
    expect(heights[at(300)]).toBeCloseTo(before[at(300)], 9); // open ground: unchanged
    // In the blend the canopy comes back gradually; past it the surface model stands.
    const canopyAt = (x: number) => heights[at(x)] - dtm[at(x)] - 1.5;
    expect(canopyAt(200)).toBeGreaterThan(0);
    expect(canopyAt(200)).toBeLessThan(18);
    expect(canopyAt(150)).toBeGreaterThan(canopyAt(200));
    expect(heights[at(100)]).toBe(before[at(100)]);
    expect(res.maxLowerM).toBeCloseTo(18, 9);
    expect(res.maxRaiseM).toBeLessThan(1e-9);
    expect(res.nodata).toBe(0);
  });

  it('keeps the surface where the DTM has no value, and refuses too little open ground to tie the datum', () => {
    const { grid, dtm, heights, woodland, dist } = world();
    const hole = ((600 - 300) / 10) * 61 + 29;
    dtm[hole] = NaN;
    const before = heights[hole];
    const res = applyBareGround({ grid, heights, dtm, dist, woodland, corridorM: 60, blendM: 120 });
    expect(heights[hole]).toBe(before);
    expect(res.nodata).toBe(1);
    const w2 = world();
    expect(() => applyBareGround({ ...w2, woodland: new Uint8Array(61 * 61).fill(1), corridorM: 60, blendM: 120 })).toThrow(/flat open corridor nodes/);
  });

  it('measures how far a route stands over the bare ground, decks and samples without a DTM left out', () => {
    const route = { id: 'r', s: [0, 10, 20, 30, 40], x: [0, 1, 2, 3, 4], y: [0, 0, 0, 0, 0], h: [101, 102, 110, 104, 100] };
    const bare = (x: number) => (x === 3 ? NaN : 100);
    const [l] = routeLift({ routes: [route], bare, onDeck: (_ri: number, s: number) => s === 20, woodlandAt: (x: number) => x === 1 });
    expect(l).toMatchObject({ id: 'r', samples: 3, maxM: 2, maxAtS: 10, minM: 0, over3M: 0, woodland: { samples: 1, maxM: 2 } });
  });
});

describe('bareGround: the bake step', () => {
  afterEach(() => vi.unstubAllGlobals());
  const tmp = () => mkdtempSync(join(tmpdir(), 'bareground-'));

  /** A 3 km world at 100 m round 41.5° N 81.5° W, inside the fixture tile; a route along its middle row. */
  function ohio() {
    const projection = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 41.5, lon0: -81.5, k0: 1 });
    const grid = { cols: 31, rows: 31, cellSize: 100, xMin: -1500, yMax: 1500 };
    const tiff = parseTiff(fixture('lzw-n42w082.tif'));
    const raster = openRaster(tiff);
    const dtmAt = usgsSampler(new Map([['n42w082', { raster, geo: geoReference(tiff), noData: -999999 }]]));
    const heights = new Float64Array(31 * 31);
    for (let r = 0; r < 31; r++) {
      for (let c = 0; c < 31; c++) {
        const [lat, lon] = projection.inverse(-1500 + c * 100, 1500 - r * 100);
        heights[r * 31 + c] = dtmAt(lat, lon) - 0.2 + (c < 12 ? 20 : 0); // canopy over the west part
      }
    }
    const [la0, lo0] = projection.inverse(-1400, 0);
    const [la1, lo1] = projection.inverse(1400, 0);
    const routes = [{ id: 'r', points: [[la0, lo0, 200], [la1, lo1, 200]] }];
    const woodlandPolys = [[[-1600, -1600, -350, -1600, -350, 1600, -1600, 1600]]];
    return { projection, grid, heights, routes, woodlandPolys, dtmAt };
  }

  it('swaps the cached, pinned 3DEP tile in along the route without touching the network', async () => {
    const cacheDir = tmp();
    try {
      mkdirSync(join(cacheDir, 'usgs-3dep-13'));
      copyFileSync(join(FIXTURES, 'lzw-n42w082.tif'), join(cacheDir, 'usgs-3dep-13', 'USGS_13_n42w082_20230911.tif'));
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const w = ohio();
      const recipe = { bareGround: { source: 'usgs-3dep-13', tiles: { n42w082: '20230911' }, corridorM: 300, blendM: 300 } };
      const logs: string[] = [];
      const { report, bare } = await bareGroundStep({ recipe, ...w, cacheDir, log: (m: string) => logs.push(m) });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(report).toMatchObject({ source: 'usgs-3dep-13', tiles: ['n42w082@20230911'], corridorM: 300, blendM: 300, nodata: 0 });
      expect(report.biasM).toBeCloseTo(-0.2, 6);
      expect(report.maxLowerM).toBeCloseTo(20, 6);
      // On the route under the wood (x = −1000): the ground, not the canopy.
      const node = (x: number, y: number) => ((1500 - y) / 100) * 31 + (x + 1500) / 100;
      const [lat, lon] = w.projection.inverse(-1000, 0);
      expect(w.heights[node(-1000, 0)]).toBeCloseTo(w.dtmAt(lat, lon) - 0.2, 6);
      expect(bare(-1000, 0)).toBeCloseTo(w.dtmAt(lat, lon) - 0.2, 6);
      // 1 km off the route the canopy stands.
      expect(w.heights[node(-1000, 1000)] - bare(-1000, 1000)).toBeCloseTo(20, 6);
      expect(logs.join('\n')).toMatch(/1 USGS 3DEP 1\/3″ tile \(0 downloaded\): n42w082/);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('stops when the corridor needs a tile the recipe has not pinned', async () => {
    const w = ohio();
    const recipe = { bareGround: { source: 'usgs-3dep-13', tiles: { n42w083: '20230911' } } };
    await expect(bareGroundStep({ recipe, ...w, cacheDir: tmp(), log: () => {} })).rejects.toThrow(/pin its release in the recipe \(bareGround\.tiles\.n42w082/);
  });

  /**
   * A 3 km world at 100 m round the middle of sheet F13C69A4 (the coarse
   * fixture: 100 m pixels, so k = 1), a route along its middle row. The
   * surface model is the DTM + 1 m (the datum), plus 5 m of roofs west of
   * x = 300 (18 of the 31 columns); a beach east of x = 250.
   */
  function vallarta() {
    const projection = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 20.65625, lon0: -105.25, k0: 1 });
    const grid = { cols: 31, rows: 31, cellSize: 100, xMin: -1500, yMax: 1500 };
    const r = openInegiSheet(fixture('inegi-F13C69A4-coarse_b.zip'), 'F13C69A4');
    const dtmAt = inegiSampler(new Map([['F13C69A4', { ...r, k: 1 }]]));
    const heights = new Float64Array(31 * 31);
    for (let j = 0; j < 31; j++) {
      for (let c = 0; c < 31; c++) {
        const [lat, lon] = projection.inverse(-1500 + c * 100, 1500 - j * 100);
        const d = dtmAt(lat, lon);
        heights[j * 31 + c] = (Number.isNaN(d) ? 10 : d) + 1 + (c < 18 ? 5 : 0);
      }
    }
    const [la0, lo0] = projection.inverse(-1400, 0);
    const [la1, lo1] = projection.inverse(1400, 0);
    const routes = [{ id: 'r', points: [[la0, lo0, 0], [la1, lo1, 0]] }];
    const beachPolys = [[[350, -1600, 1600, -1600, 1600, 1600, 350, 1600]]];
    return { projection, grid, heights, routes, woodlandPolys: [], beachPolys, dtmAt };
  }
  const SHEETS = { F13C69A4: '702825005109' };
  const withInegiCache = async (fn: (cacheDir: string) => Promise<void>) => {
    const cacheDir = tmp();
    try {
      mkdirSync(join(cacheDir, 'inegi-mdt-10k'));
      copyFileSync(join(FIXTURES, 'inegi-F13C69A4-coarse_b.zip'), join(cacheDir, 'inegi-mdt-10k', '702825005109_b.zip'));
      await fn(cacheDir);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  };

  it('swaps the cached, pinned INEGI sheet in along the route, its datum read off the beach, without touching the network', () =>
    withInegiCache(async (cacheDir) => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const w = vallarta();
      const before = Float64Array.from(w.heights);
      const recipe = { coast: true, bareGround: { source: 'inegi-mdt-10k', sheets: SHEETS, corridorM: 300, blendM: 300, biasFrom: 'beach' } };
      const logs: string[] = [];
      const { report, bare } = await bareGroundStep({ recipe, ...w, cacheDir, log: (m: string) => logs.push(m) });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(report).toMatchObject({ source: 'inegi-mdt-10k', tiles: ['F13C69A4@702825005109'], biasFrom: 'beach', corridorM: 300 });
      expect(report.biasM).toBeCloseTo(1, 6);
      expect(report.maxLowerM).toBeCloseTo(5, 6);
      expect(report.nodata).toBeLessThanOrEqual(1); // the fixture's one nodata pixel, if a node falls in it
      // In the corridor core every node is the DTM + bias, or keeps its surface where the DTM has a hole.
      let core = 0;
      for (let j = 12; j <= 18; j++) {
        for (let c = 0; c < 31; c++) {
          const [x, y] = [-1500 + c * 100, 1500 - j * 100];
          if (!(Math.hypot(Math.max(0, Math.abs(x) - 1400), y) < 300)) continue;
          core++;
          const [lat, lon] = w.projection.inverse(x, y);
          const d = w.dtmAt(lat, lon);
          expect(w.heights[j * 31 + c], `${x}, ${y}`).toBeCloseTo(Number.isNaN(d) ? before[j * 31 + c] : d + 1, 6);
          if (!Number.isNaN(d)) expect(bare(x, y)).toBeCloseTo(d + 1, 6);
        }
      }
      expect(core).toBe(5 * 31); // rows y = −200…200
      expect(logs.join('\n')).toMatch(/1 INEGI MDT 1:10 000 sheets \(0 downloaded\): F13C69A4@702825005109; 1×1 px of 100 m mean per node/);
      expect(logs.join('\n')).toMatch(/datum bias 1\.00 m over \d+ flat beach nodes/);
    }));

  it('reads the datum off the roofs too without biasFrom "beach" (why Puerto Vallarta sets it)', () =>
    withInegiCache(async (cacheDir) => {
      const w = vallarta();
      const recipe = { bareGround: { source: 'inegi-mdt-10k', sheets: SHEETS, corridorM: 300, blendM: 300 } };
      const { report } = await bareGroundStep({ recipe, ...w, cacheDir, log: () => {} });
      expect(report.biasM).toBeCloseTo(6, 6); // most open corridor nodes are under the roofs
      expect(report.biasFrom).toBeUndefined();
    }));

  it('stops when the corridor needs an INEGI sheet the recipe has not pinned, and keeps the surface on a sheet without a product', async () => {
    const w = vallarta();
    await expect(
      bareGroundStep({ recipe: { bareGround: { source: 'inegi-mdt-10k', sheets: { F13C69A1: '702825005106' } } }, ...w, cacheDir: tmp(), log: () => {} }),
    ).rejects.toThrow(/needs INEGI MDT sheet F13C69A4; pin its product in the recipe \(bareGround\.sheets\.F13C69A4 = the "upc"/);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      bareGroundStep({ recipe: { bareGround: { source: 'inegi-mdt-10k', sheets: { F13C69A4: null } } }, ...vallarta(), cacheDir: tmp(), log: () => {} }),
    ).rejects.toThrow(/only 0 flat open corridor nodes/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stops on a swissALTI3D tile that has releases, only not the pinned year', async () => {
    const cacheDir = tmp();
    try {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (String(url).includes('/api/stac/')) {
          const m = /bbox=([\d.]+),([\d.]+)/.exec(String(url))!;
          const [E, N] = wgs84ToLv95(Number(m[2]), Number(m[1]));
          return new Response(JSON.stringify({ features: [{ id: `swissalti3d_2019_${swissTileId(E, N)}` }] }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }));
      const projection = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 46.0, lon0: 8.95, k0: 1 });
      const grid = { cols: 5, rows: 5, cellSize: 15, xMin: -30, yMax: 30 };
      const [la0, lo0] = projection.inverse(-20, 0);
      const [la1, lo1] = projection.inverse(20, 0);
      const recipe = { bareGround: { source: 'swissalti3d', year: 2022 } };
      await expect(
        bareGroundStep({ recipe, grid, heights: new Float64Array(25), projection, routes: [{ id: 'r', points: [[la0, lo0, 0], [la1, lo1, 0]] }], woodlandPolys: [], cacheDir, log: () => {} }),
      ).rejects.toThrow(/has no 2022 release \(the catalogue lists 2019\)/);
      expect(existsSync(join(cacheDir, 'swissalti3d-2022'))).toBe(true);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
