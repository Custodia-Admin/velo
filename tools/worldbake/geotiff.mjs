// Minimal GeoTIFF / Cloud Optimized GeoTIFF reader for the bake's Copernicus
// GLO-30 source (fetchGlo30.mjs). No npm dependencies: node:zlib inflates
// DEFLATE blocks and DataView reads everything else.
//
// Covers what single-band float elevation COGs use:
// - classic TIFF and BigTIFF headers, either byte order ("II" little-endian,
//   "MM" big-endian), the whole IFD chain (full resolution + overviews);
// - tiled or stripped layout via TileOffsets/TileByteCounts or
//   StripOffsets/StripByteCounts;
// - compression none (1), LZW (5) or DEFLATE (8, and the old 32946);
// - predictor none (1) or floating point (3) on 32-bit IEEE float samples;
// - ModelTiepoint + ModelPixelScale + the GeoKey raster type (PixelIsArea or
//   PixelIsPoint).
// Anything else throws with the tag that didn't fit, so a dataset change fails
// loudly instead of baking garbage.

import { inflateSync } from 'node:zlib';

export const TAG = {
  NewSubfileType: 254,
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  StripOffsets: 273,
  SamplesPerPixel: 277,
  RowsPerStrip: 278,
  StripByteCounts: 279,
  PlanarConfiguration: 284,
  Predictor: 317,
  TileWidth: 322,
  TileLength: 323,
  TileOffsets: 324,
  TileByteCounts: 325,
  SampleFormat: 339,
  ModelPixelScale: 33550,
  ModelTiepoint: 33922,
  GeoKeyDirectory: 34735,
  GdalNoData: 42113,
};

const GEOKEY = { GTModelType: 1024, GTRasterType: 1025, GeographicType: 2048 };

// TIFF field type → bytes per value.
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };

const HOST_LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function u64(dv, at, le) {
  const v = dv.getBigUint64(at, le);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('TIFF offset beyond 2^53');
  return Number(v);
}

function readValues(dv, at, type, count, le) {
  const size = TYPE_SIZE[type];
  if (at + count * size > dv.byteLength) throw new Error('TIFF tag value runs past the end of the file');
  if (type === 2) {
    let s = '';
    for (let i = 0; i < count; i++) s += String.fromCharCode(dv.getUint8(at + i));
    return s.replace(/\0+$/, '');
  }
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const p = at + i * size;
    switch (type) {
      case 1: case 7: out[i] = dv.getUint8(p); break;
      case 6: out[i] = dv.getInt8(p); break;
      case 3: out[i] = dv.getUint16(p, le); break;
      case 8: out[i] = dv.getInt16(p, le); break;
      case 4: out[i] = dv.getUint32(p, le); break;
      case 9: out[i] = dv.getInt32(p, le); break;
      case 5: out[i] = dv.getUint32(p, le) / dv.getUint32(p + 4, le); break;
      case 10: out[i] = dv.getInt32(p, le) / dv.getInt32(p + 4, le); break;
      case 11: out[i] = dv.getFloat32(p, le); break;
      case 12: out[i] = dv.getFloat64(p, le); break;
      case 16: case 18: out[i] = u64(dv, p, le); break;
      case 17: out[i] = Number(dv.getBigInt64(p, le)); break;
    }
  }
  return out;
}

/**
 * Parse the header and every IFD. Returns `{ littleEndian, bigTiff, ifds, bytes }`;
 * each IFD is `{ tags: Map<tag, value[] | string> }`.
 */
export function parseTiff(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length < 8) throw new Error('not a TIFF (too short)');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mark = String.fromCharCode(bytes[0], bytes[1]);
  if (mark !== 'II' && mark !== 'MM') throw new Error('not a TIFF (no II/MM byte-order mark)');
  const le = mark === 'II';
  const magic = dv.getUint16(2, le);
  let bigTiff;
  let ifdAt;
  if (magic === 42) {
    bigTiff = false;
    ifdAt = dv.getUint32(4, le);
  } else if (magic === 43) {
    if (bytes.length < 16 || dv.getUint16(4, le) !== 8 || dv.getUint16(6, le) !== 0) throw new Error('bad BigTIFF header');
    bigTiff = true;
    ifdAt = u64(dv, 8, le);
  } else {
    throw new Error(`not a TIFF (magic ${magic})`);
  }
  const entrySize = bigTiff ? 20 : 12;
  const inlineBytes = bigTiff ? 8 : 4;
  const ifds = [];
  const seen = new Set();
  while (ifdAt !== 0) {
    if (seen.has(ifdAt) || ifdAt + (bigTiff ? 8 : 2) > bytes.length) throw new Error('corrupt TIFF IFD chain');
    seen.add(ifdAt);
    const n = bigTiff ? u64(dv, ifdAt, le) : dv.getUint16(ifdAt, le);
    const entries = ifdAt + (bigTiff ? 8 : 2);
    if (entries + n * entrySize + (bigTiff ? 8 : 4) > bytes.length) throw new Error('TIFF IFD runs past the end of the file');
    const tags = new Map();
    for (let e = 0; e < n; e++) {
      const p = entries + e * entrySize;
      const tag = dv.getUint16(p, le);
      const type = dv.getUint16(p + 2, le);
      const count = bigTiff ? u64(dv, p + 4, le) : dv.getUint32(p + 4, le);
      if (!TYPE_SIZE[type]) continue; // unknown field type: readers must skip it
      const field = p + (bigTiff ? 12 : 8);
      const at = count * TYPE_SIZE[type] <= inlineBytes ? field : bigTiff ? u64(dv, field, le) : dv.getUint32(field, le);
      tags.set(tag, readValues(dv, at, type, count, le));
    }
    ifds.push({ tags });
    const next = entries + n * entrySize;
    ifdAt = bigTiff ? u64(dv, next, le) : dv.getUint32(next, le);
  }
  if (ifds.length === 0) throw new Error('TIFF has no IFD');
  return { littleEndian: le, bigTiff, ifds, bytes };
}

const first = (tags, tag, fallback) => {
  const v = tags.get(tag);
  return v === undefined ? fallback : v[0];
};

/** Index of the first full-resolution image (NewSubfileType bit 0 clear): IFD 0 in a COG. */
export function fullResolutionIfd(tiff) {
  const i = tiff.ifds.findIndex((ifd) => (first(ifd.tags, TAG.NewSubfileType, 0) & 1) === 0);
  if (i < 0) throw new Error('TIFF has no full-resolution image');
  return i;
}

/**
 * Undo the TIFF floating-point predictor (Predictor = 3) on 32-bit samples, as
 * libtiff's fpAcc does, row by row:
 * 1. horizontal differencing: every byte of the row is a delta from the byte
 *    `samplesPerPixel` before it, so a running sum (mod 256) restores it;
 * 2. byte-plane de-interleave: the row holds all most-significant bytes first,
 *    then the next plane, … (big-endian plane order whatever the file's byte
 *    order), so sample s is bytes [s, s+n, s+2n, s+3n] with n samples per row.
 * `raw` is the inflated block, `width` its width in pixels (the full tile
 * width, padding included). Returns Float32Array(width · samplesPerPixel · rows).
 */
export function decodeFloatPredictor(raw, width, rows, samplesPerPixel = 1) {
  const n = width * samplesPerPixel;
  const rowBytes = n * 4;
  if (raw.length < rowBytes * rows) throw new Error(`predictor-3 block is ${raw.length} bytes, expected ${rowBytes * rows}`);
  const out = new Float32Array(n * rows);
  const outBytes = new Uint8Array(out.buffer);
  const row = new Uint8Array(rowBytes);
  const word = new DataView(new ArrayBuffer(4));
  for (let r = 0; r < rows; r++) {
    const base = r * rowBytes;
    for (let k = 0; k < samplesPerPixel; k++) row[k] = raw[base + k];
    for (let k = samplesPerPixel; k < rowBytes; k++) row[k] = row[k - samplesPerPixel] + raw[base + k]; // Uint8Array wraps mod 256
    const o = r * n;
    for (let s = 0; s < n; s++) {
      const b0 = row[s], b1 = row[n + s], b2 = row[2 * n + s], b3 = row[3 * n + s];
      if (HOST_LE) {
        const q = (o + s) * 4;
        outBytes[q] = b3; outBytes[q + 1] = b2; outBytes[q + 2] = b1; outBytes[q + 3] = b0;
      } else {
        word.setUint8(0, b0); word.setUint8(1, b1); word.setUint8(2, b2); word.setUint8(3, b3);
        out[o + s] = word.getFloat32(0, false);
      }
    }
  }
  return out;
}

/**
 * TIFF LZW (Compression = 5), as libtiff writes it: codes MSB first, 9 to 12
 * bits, ClearCode 256, EndOfInformation 257, and the code width growing one
 * code early (at 511, 1023 and 2047 table entries, not 512/1024/2048 as in
 * GIF). The USGS 3DEP DTMs (bareGround.mjs) use it. `expected` is the block's
 * decoded size; a stream that ends without EOI or overruns throws.
 */
export function decodeLzw(stored, expected) {
  if (stored.length >= 2 && stored[0] === 0 && (stored[1] & 1) === 1) throw new Error('old-style (pre-TIFF 6) LZW is not supported');
  const out = new Uint8Array(expected);
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const length = new Uint16Array(4096);
  for (let c = 0; c < 256; c++) {
    prefix[c] = -1;
    suffix[c] = c;
    first[c] = c;
    length[c] = 1;
  }
  let pos = 0;
  let bitBuf = 0;
  let bitCount = 0;
  let at = 0;
  let width = 9;
  let free = 258;
  let old = -1;
  const read = () => {
    while (bitCount < width) {
      if (at >= stored.length) return 257; // a stream may end without EOI once the block is full
      bitBuf = ((bitBuf << 8) | stored[at++]) >>> 0;
      bitCount += 8;
    }
    bitCount -= width;
    return (bitBuf >>> bitCount) & ((1 << width) - 1);
  };
  const emit = (code) => {
    const n = length[code];
    if (pos + n > expected) throw new Error(`LZW block decodes past its ${expected} bytes`);
    let c = code;
    for (let k = pos + n - 1; k >= pos; k--) {
      out[k] = suffix[c];
      c = prefix[c];
    }
    pos += n;
  };
  const add = (pre, byte) => {
    if (free >= 4096) throw new Error('LZW table overflow (no ClearCode)');
    prefix[free] = pre;
    suffix[free] = byte;
    first[free] = first[pre];
    length[free] = length[pre] + 1;
    free++;
    if (free + 1 >= 1 << width && width < 12) width++;
  };
  for (;;) {
    const code = read();
    if (code === 257) break;
    if (code === 256) {
      width = 9;
      free = 258;
      old = -1;
      continue;
    }
    if (old < 0) {
      if (code > 255) throw new Error(`LZW code ${code} right after a ClearCode`);
      emit(code);
    } else if (code < free) {
      emit(code);
      add(old, first[code]);
    } else if (code === free) {
      add(old, first[old]);
      emit(code);
    } else {
      throw new Error(`LZW code ${code} beyond the table (${free})`);
    }
    old = code;
    if (pos === expected) break;
  }
  if (pos !== expected) throw new Error(`LZW block decoded to ${pos} bytes, expected ${expected}`);
  return out;
}

/** Plain float32 samples in the file's byte order (Predictor = 1). */
function decodeFloat32(raw, count, le) {
  if (raw.length < count * 4) throw new Error(`float32 block is ${raw.length} bytes, expected ${count * 4}`);
  const dv = new DataView(raw.buffer, raw.byteOffset, count * 4);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = dv.getFloat32(i * 4, le);
  return out;
}

/**
 * Open one single-band float32 image of a parsed TIFF. Blocks (tiles or
 * strips) are inflated lazily on first access and kept, so sampling a small
 * window of a large COG only decodes the blocks it touches.
 * Returns `{ width, height, blockWidth, blockHeight, compression, predictor, value(i, j), readAll() }`.
 */
export function openRaster(tiff, ifdIndex = fullResolutionIfd(tiff)) {
  const tags = tiff.ifds[ifdIndex].tags;
  const width = first(tags, TAG.ImageWidth);
  const height = first(tags, TAG.ImageLength);
  if (!width || !height) throw new Error('TIFF image has no ImageWidth/ImageLength');
  const spp = first(tags, TAG.SamplesPerPixel, 1);
  const bits = tags.get(TAG.BitsPerSample) ?? [1];
  const format = first(tags, TAG.SampleFormat, 1);
  const compression = first(tags, TAG.Compression, 1);
  const predictor = first(tags, TAG.Predictor, 1);
  if (spp !== 1) throw new Error(`SamplesPerPixel ${spp}: only single-band rasters are supported`);
  if (bits.some((b) => b !== 32) || format !== 3) throw new Error(`BitsPerSample ${bits} / SampleFormat ${format}: only float32 is supported`);
  if (compression !== 1 && compression !== 5 && compression !== 8 && compression !== 32946) throw new Error(`Compression ${compression}: only none, LZW and DEFLATE are supported`);
  if (predictor !== 1 && predictor !== 3) throw new Error(`Predictor ${predictor}: only none and floating point (3) are supported`);

  const tiled = tags.has(TAG.TileWidth);
  const blockWidth = tiled ? first(tags, TAG.TileWidth) : width;
  const blockHeight = tiled ? first(tags, TAG.TileLength) : Math.min(first(tags, TAG.RowsPerStrip, height), height);
  const offsets = tags.get(tiled ? TAG.TileOffsets : TAG.StripOffsets);
  const counts = tags.get(tiled ? TAG.TileByteCounts : TAG.StripByteCounts);
  const across = Math.ceil(width / blockWidth);
  const down = Math.ceil(height / blockHeight);
  if (!offsets || !counts || offsets.length < across * down || counts.length < across * down) {
    throw new Error(`TIFF has ${offsets?.length ?? 0} block offsets for ${across}×${down} blocks`);
  }
  const blocks = new Array(across * down);

  const decodeBlock = (b) => {
    const at = offsets[b];
    const len = counts[b];
    if (at + len > tiff.bytes.length) throw new Error(`TIFF block ${b} runs past the end of the file`);
    const stored = tiff.bytes.subarray(at, at + len);
    // Tiles are always full size (edge tiles padded); the last strip may be short.
    const rows = tiled ? blockHeight : Math.min(blockHeight, height - Math.floor(b / across) * blockHeight);
    const raw = compression === 1 ? stored : compression === 5 ? decodeLzw(stored, blockWidth * rows * 4) : inflateSync(stored);
    const data = predictor === 3 ? decodeFloatPredictor(raw, blockWidth, rows) : decodeFloat32(raw, blockWidth * rows, tiff.littleEndian);
    blocks[b] = data;
    return data;
  };

  /** Sample at column i (0 = west), row j (0 = north). */
  const value = (i, j) => {
    if (i < 0 || j < 0 || i >= width || j >= height) throw new Error(`pixel (${i}, ${j}) outside ${width}×${height}`);
    const bx = Math.floor(i / blockWidth);
    const by = Math.floor(j / blockHeight);
    const b = by * across + bx;
    const data = blocks[b] ?? decodeBlock(b);
    return data[(j - by * blockHeight) * blockWidth + (i - bx * blockWidth)];
  };

  /** The whole image, row-major from the north-west pixel. */
  const readAll = () => {
    const out = new Float32Array(width * height);
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) out[j * width + i] = value(i, j);
    return out;
  };

  return { width, height, blockWidth, blockHeight, compression, predictor, value, readAll };
}

/** Value of one GeoKey (SHORT values stored in the directory itself), or undefined. */
export function geoKey(tiff, ifdIndex, key) {
  const dir = tiff.ifds[ifdIndex].tags.get(TAG.GeoKeyDirectory);
  if (!dir) return undefined;
  const n = dir[3];
  for (let k = 0; k < n; k++) {
    const [id, location, count, value] = dir.slice(4 + k * 4, 8 + k * 4);
    if (id === key) return location === 0 && count === 1 ? value : undefined;
  }
  return undefined;
}

/**
 * Georeferencing from ModelTiepoint + ModelPixelScale + GTRasterTypeGeoKey.
 * Returns the model coordinates of pixel CENTRES: column i is at
 * `x0 + i·scaleX`, row j at `y0 − j·scaleY`. With PixelIsArea (GeoTIFF's
 * default) the tiepoint names the corner of its pixel, so centres sit half a
 * pixel in; with PixelIsPoint the tiepoint IS the centre.
 */
export function geoReference(tiff, ifdIndex = fullResolutionIfd(tiff)) {
  const tags = tiff.ifds[ifdIndex].tags;
  const scale = tags.get(TAG.ModelPixelScale);
  const tie = tags.get(TAG.ModelTiepoint);
  if (!scale || scale.length < 2 || !tie || tie.length < 6) throw new Error('GeoTIFF has no ModelPixelScale/ModelTiepoint');
  if (tie.length > 6) throw new Error('GeoTIFF with several tiepoints is not supported');
  const rasterType = geoKey(tiff, ifdIndex, GEOKEY.GTRasterType) ?? 1;
  const [I, J, , X, Y] = tie;
  const [scaleX, scaleY] = scale;
  const half = rasterType === 2 ? 0 : 0.5;
  return {
    rasterType: rasterType === 2 ? 'point' : 'area',
    modelType: geoKey(tiff, ifdIndex, GEOKEY.GTModelType),
    geographicType: geoKey(tiff, ifdIndex, GEOKEY.GeographicType),
    scaleX,
    scaleY,
    x0: X + (half - I) * scaleX,
    y0: Y - (half - J) * scaleY,
    noData: tags.get(TAG.GdalNoData),
  };
}
