// INEGI's 1:10 000 "Modelo digital de elevación tipo terreno" (Mexico), the
// bare-ground source "inegi-mdt-10k" of recipe `bareGround` (bareGround.mjs).
//
// INEGI (Instituto Nacional de Estadística y Geografía) publishes a 5 m
// bare-earth model ("tipo terreno", derived from satellite and airborne
// sensors) on the 1:10 000 sheet grid, one product per sheet and edition, each
// a zip of an ESRI BIL raster (float32, little-endian) in UTM with its .hdr
// and .prj. Member paths inside the zips may use backslashes. The rasters of
// neighbouring sheets overlap by about 150 m and share one 5 m lattice.
// Heights are orthometric, by each sheet's metadata (<altdatum>): NAVD 88 on
// seven of the eight Puerto Vallarta sheets, the Mexican gravimetric geoid
// GGM10 on F13C58F4. In the overlaps the median difference is 0 (32–98 % of
// the pixels identical), but single pixels differ by metres where two sheets
// come from different source imagery (F13C69A4 / F13C69E1: median −2.0 m over
// their 3,380 shared pixels), so every point reads the sheet whose cell holds
// it, never a mix. bareGround.mjs ties the heights to GLO-30 with its datum
// bias.
//
// Terms: INEGI "Términos de Libre Uso de la Información del INEGI": free use,
// commercial included, crediting "Fuente: INEGI, <product>" and stating any
// transformation.
//
// Sheet names (INEGI's cartographic index, checked against its 1:10 000
// catalogue): F13C69A4 =
//   F13  the 1:1 000 000 sheet: a 4° band of latitude lettered from the
//        equator (F = 20–24° N) and a 6° zone numbered like UTM (13 = 108–102° W);
//   C    its 2° × 3° quarter: A north-west, B north-east, C south-west, D south-east;
//   69   the 1:50 000 sheet in it, 15′ × 20′: row 6 (of 8, from the north),
//        column 9 (of 9, from the west);
//   A    the 1:20 000 sheet, 7′30″ × 6′40″: A B C on top, D E F below;
//   4    the 1:10 000 sheet, 3′45″ × 3′20″: 1 north-west, 2 north-east,
//        3 south-west, 4 south-east.
//
// The recipe pins each sheet the corridor touches to its product (the UPC
// in the download name, which changes with every edition), or to null where
// INEGI has no product (open sea), so a clean-cache bake reads the same
// bytes. Each grid node takes the mean of the k × k pixels round it (k = the
// odd number nearest the cell size over the pixel size: 3 at 12 m on 5 m).

import { inflateRawSync, crc32 } from 'node:zlib';

export const INEGI_MDT_BASE =
  'https://www.inegi.org.mx/contenidos/productos/prod_serv/contenidos/espanol/bvinegi/productos/geografia/imagen_cartografica/1_10_000/lidar/Terreno_ASCII';
/** INEGI's catalogue of a sheet's products: POST res=5&mod=T&cve=<sheet>; the `_b.zip` entry's `upc`. */
export const INEGI_MDT_CATALOGUE = 'https://www.inegi.org.mx/app/geo2/elevacionesmex/getF10KDescarga.do';

export const inegiSheetUrl = (upc) => `${INEGI_MDT_BASE}/${upc}_b.zip`;

const SHEET_RE = /^([A-Z])(\d{1,2})([A-D])([1-8])([1-9])([A-F])([1-4])$/;

/** The 1:10 000 sheet holding (lat, lon), e.g. 'F13C69A4' (northern and western hemisphere: Mexico). */
export function inegiSheetName(lat, lon) {
  if (!(lat > 0 && lat < 36 && lon < 0 && lon > -120)) throw new Error(`INEGI sheets: ${lat}, ${lon} is outside Mexico's index (0–36° N, 120–0° W)`);
  const band = Math.floor(lat / 4);
  const zone = Math.floor((lon + 180) / 6) + 1;
  const lat0 = band * 4;
  const lon0 = (zone - 1) * 6 - 180;
  const north = lat - lat0 >= 2;
  const east = lon - lon0 >= 3;
  const qTop = lat0 + (north ? 4 : 2);
  const qWest = lon0 + (east ? 3 : 0);
  // Work in whole units of the 1:10 000 sheet (3′45″ of latitude, 3′20″ of longitude) from the quarter's NW corner.
  const r = Math.floor(((qTop - lat) * 60) / 3.75); // 0…31
  const c = Math.floor(((lon - qWest) * 60) / (10 / 3)); // 0…53
  const r50 = Math.floor(r / 4), c50 = Math.floor(c / 6);
  const r20 = Math.floor((r % 4) / 2), c20 = Math.floor((c % 6) / 2);
  const q10 = 1 + 2 * (r % 2) + (c % 2);
  return `${String.fromCharCode(65 + band)}${zone}${north ? (east ? 'B' : 'A') : east ? 'D' : 'C'}${r50 + 1}${c50 + 1}${'ABCDEF'[r20 * 3 + c20]}${q10}`;
}

/** A sheet's geographic cell: { south, north, west, east } in degrees. */
export function inegiSheetCell(name) {
  const m = SHEET_RE.exec(name);
  if (!m) throw new Error(`INEGI sheets: bad sheet name ${name}`);
  const [, band, zone, quarter, r50, c50, s20, q10] = m;
  const lat0 = (band.charCodeAt(0) - 65) * 4;
  const lon0 = (Number(zone) - 1) * 6 - 180;
  const qTop = lat0 + (quarter === 'A' || quarter === 'B' ? 4 : 2);
  const qWest = lon0 + (quarter === 'B' || quarter === 'D' ? 3 : 0);
  const i20 = 'ABCDEF'.indexOf(s20);
  const r = (Number(r50) - 1) * 4 + Math.floor(i20 / 3) * 2 + Math.floor((Number(q10) - 1) / 2);
  const c = (Number(c50) - 1) * 6 + (i20 % 3) * 2 + ((Number(q10) - 1) % 2);
  const north = qTop - (r * 3.75) / 60;
  const west = qWest + (c * (10 / 3)) / 60;
  return { south: north - 3.75 / 60, north, west, east: west + 10 / 3 / 60 };
}

// --- zip ------------------------------------------------------------------

/**
 * The members of a zip archive (stored or deflated, no zip64): a Map from the
 * member path, with backslashes turned into slashes, to its bytes. Each
 * member's CRC-32 is checked.
 */
export function readZip(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: no end-of-central-directory record');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('zip: zip64 archives are not supported');
  const out = new Map();
  for (let k = 0; k < count; k++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error(`zip: bad central directory entry ${k}`);
    const flags = b.readUInt16LE(p + 8);
    const method = b.readUInt16LE(p + 10);
    const crc = b.readUInt32LE(p + 16);
    const csize = b.readUInt32LE(p + 20);
    const size = b.readUInt32LE(p + 24);
    const nlen = b.readUInt16LE(p + 28), xlen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nlen).toString(flags & 0x800 ? 'utf8' : 'latin1').replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error(`zip: ${name} is encrypted`);
    if (b.readUInt32LE(local) !== 0x04034b50) throw new Error(`zip: bad local header for ${name}`);
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const raw = b.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`zip: ${name} uses compression method ${method}`);
    if (data.length !== size) throw new Error(`zip: ${name} inflated to ${data.length} bytes, expected ${size}`);
    if (crc32(data) >>> 0 !== crc) throw new Error(`zip: ${name} fails its CRC-32`);
    out.set(name, data);
  }
  return out;
}

// --- BIL + projection ------------------------------------------------------

/** An ESRI .hdr: keys upper-cased, values as strings. */
export function parseHdr(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\S+)\s+(.*?)\s*$/.exec(line);
    if (m) out[m[1].toUpperCase()] = m[2];
  }
  return out;
}

/** A UTM-style transverse Mercator .prj (ESRI WKT): spheroid and projection parameters. */
export function parseTmPrj(text) {
  const where = 'INEGI MDT .prj';
  const proj = /PROJECTION\["([^"]+)"\]/.exec(text)?.[1];
  if (proj !== 'Transverse_Mercator') throw new Error(`${where}: projection ${proj}, expected Transverse_Mercator`);
  const sph = /SPHEROID\["[^"]*",\s*([\d.eE+-]+),\s*([\d.eE+-]+)\]/.exec(text);
  if (!sph) throw new Error(`${where}: no SPHEROID`);
  const param = (k) => {
    const m = new RegExp(`PARAMETER\\["${k}",\\s*([\\d.eE+-]+)\\]`, 'i').exec(text);
    if (!m) throw new Error(`${where}: no ${k}`);
    return Number(m[1]);
  };
  const unit = /UNIT\["([^"]+)",\s*([\d.eE+-]+)\]\s*\]\s*$/.exec(text.trim());
  if (!unit || Number(unit[2]) !== 1) throw new Error(`${where}: linear unit ${unit?.[1]}, expected metres`);
  const out = { a: Number(sph[1]), f: 1 / Number(sph[2]), lon0: param('Central_Meridian'), lat0: param('Latitude_Of_Origin'), k0: param('Scale_Factor'), fe: param('False_Easting'), fn: param('False_Northing') };
  if (out.lat0 !== 0) throw new Error(`${where}: latitude of origin ${out.lat0}, expected 0`);
  return out;
}

/**
 * Geographic (lat, lon in degrees, on the .prj's ellipsoid) → transverse
 * Mercator [E, N]: Krüger's series to n⁴ (Karney 2011, eq. 7 and 35), under
 * a millimetre inside a UTM zone.
 */
export function tmForward(lat, lon, { a, f, lon0, k0, fe, fn }) {
  const n = f / (2 - f);
  const n2 = n * n, n3 = n2 * n, n4 = n3 * n;
  const A = (a / (1 + n)) * (1 + n2 / 4 + n4 / 64);
  const al = [
    n / 2 - (2 / 3) * n2 + (5 / 16) * n3 + (41 / 180) * n4,
    (13 / 48) * n2 - (3 / 5) * n3 + (557 / 1440) * n4,
    (61 / 240) * n3 - (103 / 140) * n4,
    (49561 / 161280) * n4,
  ];
  const e = (2 * Math.sqrt(n)) / (1 + n);
  const phi = (lat * Math.PI) / 180;
  const lam = ((lon - lon0) * Math.PI) / 180;
  const s = Math.sin(phi);
  const t = Math.sinh(Math.atanh(s) - e * Math.atanh(e * s));
  const xi1 = Math.atan2(t, Math.cos(lam));
  const eta1 = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let xi = xi1, eta = eta1;
  for (let j = 1; j <= 4; j++) {
    xi += al[j - 1] * Math.sin(2 * j * xi1) * Math.cosh(2 * j * eta1);
    eta += al[j - 1] * Math.cos(2 * j * xi1) * Math.sinh(2 * j * eta1);
  }
  return [fe + k0 * A * eta, fn + k0 * A * xi];
}

/**
 * One sheet's product zip → its raster: checks the member names (the sheet's
 * own `<sheet>_mt` terrain model), the BIL layout and the projection.
 * Returns { tm, x0, y0, dx, dy, cols, rows, noData, data: Float32Array }
 * (x0, y0 = centre of the upper-left pixel, as ULXMAP/ULYMAP).
 */
export function openInegiSheet(zipBytes, sheet) {
  const where = `INEGI MDT ${sheet}`;
  const files = readZip(zipBytes);
  const stem = `${sheet.toLowerCase()}_mt`;
  const find = (ext) => [...files.keys()].find((k) => k.split('/').pop().toLowerCase() === stem + ext);
  const [hdrName, prjName, bilName] = ['.hdr', '.prj', '.bil'].map(find);
  if (!hdrName || !prjName || !bilName) {
    const bils = [...files.keys()].filter((k) => k.toLowerCase().endsWith('.bil'));
    throw new Error(`${where}: the zip holds ${bils.join(', ') || 'no .bil'}, not ${stem}.bil (the pinned product is another sheet's or not the terrain model)`);
  }
  const hdr = parseHdr(files.get(hdrName).toString('latin1'));
  const need = { LAYOUT: 'BIL', NBANDS: '1', NBITS: '32', PIXELTYPE: 'FLOAT' };
  for (const [k, v] of Object.entries(need)) if ((hdr[k] ?? '').toUpperCase() !== v) throw new Error(`${where}: ${k} ${hdr[k]}, expected ${v}`);
  const order = (hdr.BYTEORDER ?? 'I').toUpperCase();
  if (order !== 'I' && order !== 'M') throw new Error(`${where}: BYTEORDER ${hdr.BYTEORDER}`);
  const cols = Number(hdr.NCOLS), rows = Number(hdr.NROWS);
  const dx = Number(hdr.XDIM), dy = Number(hdr.YDIM);
  const skip = Number(hdr.SKIPBYTES ?? 0);
  if (Number(hdr.BANDROWBYTES ?? cols * 4) !== cols * 4) throw new Error(`${where}: BANDROWBYTES ${hdr.BANDROWBYTES} for ${cols} columns`);
  if (!(dx > 0) || dx !== dy) throw new Error(`${where}: pixels ${dx} × ${dy} m, expected square`);
  const bil = files.get(bilName);
  if (bil.length !== skip + cols * rows * 4) throw new Error(`${where}: ${bilName} is ${bil.length} bytes, expected ${skip + cols * rows * 4}`);
  const data = new Float32Array(cols * rows);
  const view = new DataView(bil.buffer, bil.byteOffset + skip, cols * rows * 4);
  for (let i = 0; i < data.length; i++) data[i] = view.getFloat32(i * 4, order === 'I');
  return {
    tm: parseTmPrj(files.get(prjName).toString('latin1')),
    x0: Number(hdr.ULXMAP),
    y0: Number(hdr.ULYMAP),
    dx,
    dy,
    cols,
    rows,
    noData: hdr.NODATA === undefined ? NaN : Math.fround(Number(hdr.NODATA)),
    data,
  };
}

/** Throws unless the sheet's raster covers its own geographic cell (its four corners and edge midpoints). */
export function checkInegiCoverage(sheet, raster) {
  const c = inegiSheetCell(sheet);
  const pts = [];
  for (const la of [c.south, (c.south + c.north) / 2, c.north]) for (const lo of [c.west, (c.west + c.east) / 2, c.east]) pts.push([la, lo]);
  for (const [la, lo] of pts) {
    const [E, N] = tmForward(la, lo, raster.tm);
    const i = (E - raster.x0) / raster.dx, j = (raster.y0 - N) / raster.dy;
    if (!(i >= 0 && j >= 0 && i <= raster.cols - 1 && j <= raster.rows - 1)) {
      throw new Error(`INEGI MDT ${sheet}: the raster doesn't cover the sheet's cell (corner ${la.toFixed(5)}, ${lo.toFixed(5)} falls at pixel ${i.toFixed(1)}, ${j.toFixed(1)} of ${raster.cols} × ${raster.rows})`);
    }
  }
}

/**
 * Reader over the loaded sheets (name → openInegiSheet's raster plus `k`):
 * (lat, lon) → the mean of the k × k pixels round the pixel holding the
 * point, read from the sheet whose cell holds it. NaN where any of them is
 * nodata or off the raster, or no sheet was loaded for the cell (a sheet
 * without a product).
 */
export function inegiSampler(sheets) {
  return (lat, lon) => {
    const t = sheets.get(inegiSheetName(lat, lon));
    if (!t) return NaN;
    const half = (t.k - 1) / 2;
    const [E, N] = tmForward(lat, lon, t.tm);
    const ci = Math.floor((E - (t.x0 - t.dx / 2)) / t.dx);
    const cj = Math.floor((t.y0 + t.dy / 2 - N) / t.dy);
    let sum = 0;
    for (let b = -half; b <= half; b++) {
      const j = cj + b;
      if (j < 0 || j >= t.rows) return NaN;
      for (let a = -half; a <= half; a++) {
        const i = ci + a;
        if (i < 0 || i >= t.cols) return NaN;
        const v = t.data[j * t.cols + i];
        if (v === t.noData || Number.isNaN(v) || v < -1e30) return NaN;
        sum += v;
      }
    }
    return sum / (t.k * t.k);
  };
}

/** k for a grid cell over pixels of `pixelM`: the odd number nearest cellSize / pixelM (at least 1). */
export const inegiBoxSize = (cellSize, pixelM) => Math.max(1, 2 * Math.round((cellSize / pixelM - 1) / 2) + 1);
