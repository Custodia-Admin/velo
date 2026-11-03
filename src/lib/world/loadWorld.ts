/**
 * Fetch, verify and decode a baked world bundle (docs/worlds/WORLD-FORMAT.md).
 *
 *   const world = await loadWorld('/worlds/perugia/', { onProgress });
 *   world.heightfield.sampleHeight(x, y);
 *
 * Every failure is a `WorldLoadError` with a `code` ('missing' | 'corrupt' |
 * 'unsupported' | 'network' | 'aborted') and the offending file, so the ride
 * view can tell "world not shipped" from "download broke" from "bad bake".
 *
 * Engine-free (no three.js/Cesium/React): renderers consume the decoded data.
 */

import { Heightfield, decodeHeightDeltas } from './heightfield';
import { createProjection, type WorldProjection } from './projection';
import { validateManifest, WorldLoadError, type WorldFileEntry, type WorldManifest } from './manifest';

export { WorldLoadError } from './manifest';
export type { WorldErrorCode } from './manifest';

export const BUILDING_KINDS = ['generic', 'house', 'apartments', 'church', 'industrial', 'shed', 'civic'] as const;
export const VEGETATION_KINDS = [
  'broadleaf',
  'conifer',
  'scrub',
  'olive',
  'park',
  'cypress',
  'riparian',
  'hedgerow',
  'garden',
] as const;
/** Where a building stands (buildings.bin VWB2); VWB1 bundles read as all 'suburb'. */
export const BUILDING_DISTRICTS = ['suburb', 'old-town', 'rural', 'industrial'] as const;

export interface WorldLoadProgress {
  /** 'manifest' once the manifest is read, 'file' per finished file, 'done' at the end. */
  phase: 'manifest' | 'file' | 'done';
  /** The file that just finished (phase 'file'). */
  file?: string;
  loadedFiles: number;
  totalFiles: number;
  /** Stored (transfer) bytes received so far, out of `totalBytes` from the manifest. */
  loadedBytes: number;
  totalBytes: number;
}

export interface LoadWorldOptions {
  /** Defaults to the global fetch. Tests pass a file-system backed one. */
  fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  onProgress?: (p: WorldLoadProgress) => void;
  signal?: AbortSignal;
  /** Check each file's SHA-256 (needs crypto.subtle; skipped where unavailable). Default true. */
  verifyHashes?: boolean;
}

export interface WorldRoad {
  /** Index into `RoadsLayer.classes`. */
  cls: number;
  /** Carriageway width, metres (OSM width tag, else the class default). */
  width: number;
  /** Bit set of `RoadsLayer.flags`. */
  flags: number;
  name?: string;
  /** Flat [x0, y0, x1, y1, …] world metres. */
  points: Float32Array;
}

export interface RoadsLayer {
  classes: string[];
  flags: Record<'bridge' | 'tunnel' | 'unpaved' | 'oneway', number>;
  roads: WorldRoad[];
}

export interface WorldArea {
  kind: string;
  /** Outer ring first, then holes; open rings of flat [x, y, …] metres. */
  rings: Float32Array[];
}

export interface WaterLayer {
  areas: WorldArea[];
  lines: { kind: string; width: number; points: Float32Array }[];
}

export interface LandcoverLayer {
  areas: WorldArea[];
}

export interface BuildingsLayer {
  count: number;
  /** Building i's vertices are xy[2·start[i] … 2·start[i+1]) (counter-clockwise outer ring, open). */
  start: Uint32Array;
  xy: Float32Array;
  /** Metres above ground. */
  height: Float32Array;
  /** Index into BUILDING_KINDS. */
  kind: Uint8Array;
  /** Index into BUILDING_DISTRICTS. */
  district: Uint8Array;
}

export interface VegetationLayer {
  count: number;
  x: Float32Array;
  y: Float32Array;
  /** Index into VEGETATION_KINDS. */
  kind: Uint8Array;
  /** Per-instance random byte (scale/rotation/variant). */
  seed: Uint8Array;
}

export interface WorldRoute {
  id: string;
  name: string;
  /** Route length on the app's distance scale, metres. */
  lengthM: number;
  stepM: number;
  /** Distance along the route of each sample, metres. */
  s: Float64Array;
  x: Float64Array;
  y: Float64Array;
  /** Render elevation: exactly heightfield.sampleHeight(x[i], y[i]). */
  h: Float64Array;
}

export interface LoadedWorld {
  manifest: WorldManifest;
  projection: WorldProjection;
  heightfield: Heightfield;
  roads: RoadsLayer;
  water: WaterLayer;
  landcover: LandcoverLayer;
  buildings: BuildingsLayer;
  vegetation: VegetationLayer;
  routes: WorldRoute[];
}

function joinUrl(base: string, file: string): string {
  return base.endsWith('/') ? base + file : `${base}/${file}`;
}

function rethrow(err: unknown, file: string, signal?: AbortSignal): never {
  if (err instanceof WorldLoadError) throw err;
  if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
    throw new WorldLoadError('aborted', `loading ${file} was aborted`, file, { cause: err });
  }
  throw new WorldLoadError('network', `could not fetch ${file}: ${err instanceof Error ? err.message : String(err)}`, file, {
    cause: err,
  });
}

async function fetchBytes(
  fetchFn: NonNullable<LoadWorldOptions['fetch']>,
  url: string,
  file: string,
  signal: AbortSignal | undefined,
  onChunk: (n: number) => void,
): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetchFn(url, { signal });
  } catch (err) {
    rethrow(err, file, signal);
  }
  if (res.status === 404 || res.status === 410) throw new WorldLoadError('missing', `${file} is missing (HTTP ${res.status})`, file);
  if (!res.ok) throw new WorldLoadError('network', `${file}: HTTP ${res.status}`, file);
  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        total += value.byteLength;
        onChunk(value.byteLength);
      }
      const out = new Uint8Array(total);
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.byteLength;
      }
      return out;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    onChunk(buf.byteLength);
    return buf;
  } catch (err) {
    rethrow(err, file, signal);
  }
}

async function gunzip(bytes: Uint8Array, file: string): Promise<Uint8Array> {
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (err) {
    throw new WorldLoadError('corrupt', `${file} is not valid gzip`, file, { cause: err });
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null; // insecure context (plain-http LAN): sizes + structure still checked
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes as BufferSource));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Stored bytes → verified content bytes. Hosts that already un-gzipped the file are accepted. */
async function decodeFile(entry: WorldFileEntry, stored: Uint8Array, verify: boolean): Promise<Uint8Array> {
  const gz = stored.length >= 2 && stored[0] === 0x1f && stored[1] === 0x8b;
  if (entry.compression === 'gzip' && !gz && stored.length !== entry.contentBytes) {
    throw new WorldLoadError('corrupt', `${entry.path} is neither gzip nor the expected content`, entry.path);
  }
  const content = entry.compression === 'gzip' && gz ? await gunzip(stored, entry.path) : stored;
  if (content.length !== entry.contentBytes) {
    throw new WorldLoadError('corrupt', `${entry.path} is ${content.length} bytes, expected ${entry.contentBytes}`, entry.path);
  }
  if (verify) {
    const hex = await sha256Hex(content);
    if (hex !== null && hex !== entry.contentSha256) {
      throw new WorldLoadError('corrupt', `${entry.path} failed its SHA-256 check`, entry.path);
    }
  }
  return content;
}

type Json = Record<string, unknown>;

function parseJson(bytes: Uint8Array, file: string): Json {
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
    if ((v as Json).version !== 1) {
      throw new WorldLoadError('unsupported', `${file}: layer version ${String((v as Json).version)}`, file);
    }
    return v as Json;
  } catch (err) {
    if (err instanceof WorldLoadError) throw err;
    throw new WorldLoadError('corrupt', `${file} is not valid JSON`, file, { cause: err });
  }
}

function expectArray(v: unknown, file: string, what: string): unknown[] {
  if (!Array.isArray(v)) throw new WorldLoadError('corrupt', `${file}: ${what} must be an array`, file);
  return v;
}

/** Integer decimetres (flat array) → Float32 metres. */
function dmToMetres(v: unknown, file: string): Float32Array {
  const a = expectArray(v, file, 'coordinates');
  if (a.length % 2 !== 0) throw new WorldLoadError('corrupt', `${file}: odd coordinate count`, file);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const n = a[i];
    if (typeof n !== 'number') throw new WorldLoadError('corrupt', `${file}: non-numeric coordinate`, file);
    out[i] = n / 10;
  }
  return out;
}

function decodeRoads(json: Json, file: string): RoadsLayer {
  const classes = expectArray(json.classes, file, 'classes') as string[];
  const widths = expectArray(json.widths, file, 'widths') as number[];
  const names = expectArray(json.names, file, 'names') as string[];
  const roads = expectArray(json.roads, file, 'roads').map((r) => {
    const o = r as Json;
    const cls = o.c as number;
    if (!Number.isInteger(cls) || cls < 0 || cls >= classes.length) {
      throw new WorldLoadError('corrupt', `${file}: road class ${String(cls)} out of range`, file);
    }
    const road: WorldRoad = {
      cls,
      width: typeof o.w === 'number' ? o.w : widths[cls],
      flags: typeof o.f === 'number' ? o.f : 0,
      points: dmToMetres(o.p, file),
    };
    if (typeof o.n === 'number') road.name = names[o.n];
    return road;
  });
  return { classes, flags: json.flags as RoadsLayer['flags'], roads };
}

function decodeAreas(list: unknown, kinds: string[], file: string): WorldArea[] {
  return expectArray(list, file, 'areas').map((a) => {
    const o = a as Json;
    const kind = kinds[o.k as number];
    if (kind === undefined) throw new WorldLoadError('corrupt', `${file}: area kind ${String(o.k)} unknown`, file);
    return { kind, rings: expectArray(o.r, file, 'rings').map((r) => dmToMetres(r, file)) };
  });
}

function decodeWater(json: Json, file: string): WaterLayer {
  const lineKinds = expectArray(json.lineKinds, file, 'lineKinds') as string[];
  const lineWidths = expectArray(json.lineWidths, file, 'lineWidths') as number[];
  return {
    areas: decodeAreas(json.areas, expectArray(json.areaKinds, file, 'areaKinds') as string[], file),
    lines: expectArray(json.lines, file, 'lines').map((l) => {
      const o = l as Json;
      const k = o.k as number;
      if (lineKinds[k] === undefined) throw new WorldLoadError('corrupt', `${file}: line kind ${String(k)} unknown`, file);
      return { kind: lineKinds[k], width: typeof o.w === 'number' ? o.w : lineWidths[k], points: dmToMetres(o.p, file) };
    }),
  };
}

function magic(bytes: Uint8Array, expect: string, file: string): DataView {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const got = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (bytes.length < 12 || got !== expect) throw new WorldLoadError('corrupt', `${file}: bad magic ${JSON.stringify(got)}`, file);
  return view;
}

function decodeBuildings(bytes: Uint8Array, file: string): BuildingsLayer {
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const v = magic(bytes, tag === 'VWB2' ? 'VWB2' : 'VWB1', file);
  const hasDistrict = tag === 'VWB2';
  const count = v.getUint32(4, true);
  const totalVerts = v.getUint32(8, true);
  const head = 12;
  const meta = count * (hasDistrict ? 6 : 5);
  const pad = (4 - ((head + meta) % 4)) % 4;
  const expected = head + meta + pad + count * 8 + (totalVerts - count) * 4;
  if (totalVerts < count * 3 || bytes.length !== expected) {
    throw new WorldLoadError('corrupt', `${file}: ${bytes.length} bytes, expected ${expected}`, file);
  }
  const start = new Uint32Array(count + 1);
  const height = new Float32Array(count);
  const kind = new Uint8Array(count);
  let o = head;
  for (let i = 0; i < count; i++, o += 2) start[i + 1] = start[i] + v.getUint16(o, true);
  if (start[count] !== totalVerts) throw new WorldLoadError('corrupt', `${file}: vertex counts do not add up`, file);
  for (let i = 0; i < count; i++, o += 2) height[i] = v.getUint16(o, true) / 10;
  for (let i = 0; i < count; i++, o += 1) kind[i] = bytes[o];
  const district = new Uint8Array(count);
  if (hasDistrict) for (let i = 0; i < count; i++, o += 1) district[i] = bytes[o];
  o += pad;
  const xy = new Float32Array(totalVerts * 2);
  let d = head + meta + pad + count * 8;
  for (let i = 0; i < count; i++, o += 8) {
    let x = v.getInt32(o, true);
    let y = v.getInt32(o + 4, true);
    let k = start[i] * 2;
    xy[k++] = x / 10;
    xy[k++] = y / 10;
    for (let j = start[i] + 1; j < start[i + 1]; j++, d += 4) {
      x += v.getInt16(d, true);
      y += v.getInt16(d + 2, true);
      xy[k++] = x / 10;
      xy[k++] = y / 10;
    }
  }
  return { count, start, xy, height, kind, district };
}

function decodeVegetation(bytes: Uint8Array, file: string, manifest: WorldManifest): VegetationLayer {
  const v = magic(bytes, 'VWV1', file);
  const count = v.getUint32(4, true);
  const quantum = v.getFloat32(8, true);
  if (bytes.length !== 16 + count * 6 || !(quantum > 0)) {
    throw new WorldLoadError('corrupt', `${file}: ${bytes.length} bytes for ${count} instances`, file);
  }
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const { xMin, yMin } = manifest.extent;
  let o = 16;
  for (let i = 0; i < count; i++, o += 2) x[i] = xMin + v.getUint16(o, true) * quantum;
  for (let i = 0; i < count; i++, o += 2) y[i] = yMin + v.getUint16(o, true) * quantum;
  const kind = bytes.slice(o, o + count);
  const seed = bytes.slice(o + count, o + 2 * count);
  return { count, x, y, kind, seed };
}

function decodeRoutes(json: Json, file: string): WorldRoute[] {
  return expectArray(json.routes, file, 'routes').map((r) => {
    const o = r as Json;
    const s = Float64Array.from(expectArray(o.s, file, 's') as number[]);
    const x = Float64Array.from(expectArray(o.x, file, 'x') as number[]);
    const y = Float64Array.from(expectArray(o.y, file, 'y') as number[]);
    const h = Float64Array.from(expectArray(o.h, file, 'h') as number[]);
    if (s.length < 2 || x.length !== s.length || y.length !== s.length || h.length !== s.length) {
      throw new WorldLoadError('corrupt', `${file}: route ${String(o.id)} arrays differ in length`, file);
    }
    return {
      id: String(o.id),
      name: String(o.name),
      lengthM: Number(o.lengthM),
      stepM: Number(o.stepM),
      s,
      x,
      y,
      h,
    };
  });
}

/**
 * Load the world bundle at `baseUrl` (directory URL containing manifest.json).
 */
export async function loadWorld(baseUrl: string, opts: LoadWorldOptions = {}): Promise<LoadedWorld> {
  const fetchFn = opts.fetch ?? ((url: string, init?: { signal?: AbortSignal }) => fetch(url, init));
  const { signal, onProgress } = opts;
  const verify = opts.verifyHashes ?? true;
  const check = (file: string) => {
    if (signal?.aborted) throw new WorldLoadError('aborted', `loading ${file} was aborted`, file);
  };

  check('manifest.json');
  const manifestBytes = await fetchBytes(fetchFn, joinUrl(baseUrl, 'manifest.json'), 'manifest.json', signal, () => {});
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch (err) {
    throw new WorldLoadError('corrupt', 'manifest.json is not valid JSON', 'manifest.json', { cause: err });
  }
  const manifest = validateManifest(manifestJson);
  const files = manifest.files;
  const totalBytes = files.reduce((a, f) => a + f.bytes, 0);
  let loadedBytes = 0;
  let loadedFiles = 0;
  const emit = (phase: WorldLoadProgress['phase'], file?: string) =>
    onProgress?.({ phase, file, loadedFiles, totalFiles: files.length, loadedBytes, totalBytes });
  emit('manifest');

  const contents = new Map<string, Uint8Array>();
  await Promise.all(
    files.map(async (entry) => {
      check(entry.path);
      const stored = await fetchBytes(fetchFn, joinUrl(baseUrl, entry.path), entry.path, signal, (n) => {
        loadedBytes += n;
      });
      check(entry.path);
      contents.set(entry.path, await decodeFile(entry, stored, verify));
      loadedFiles++;
      emit('file', entry.path);
    }),
  );

  const get = (path: string) => contents.get(path) as Uint8Array;
  const hfInfo = manifest.heightfield;
  let heightfield: Heightfield;
  try {
    const data = decodeHeightDeltas(get(hfInfo.file), hfInfo.cols, hfInfo.rows);
    heightfield = new Heightfield(
      {
        cols: hfInfo.cols,
        rows: hfInfo.rows,
        cellSize: hfInfo.cellSize,
        xMin: manifest.extent.xMin,
        yMax: manifest.extent.yMax,
        heightOffset: hfInfo.heightOffset,
        heightScale: hfInfo.heightScale,
      },
      data,
    );
  } catch (err) {
    throw new WorldLoadError('corrupt', `${hfInfo.file}: ${err instanceof Error ? err.message : String(err)}`, hfInfo.file, {
      cause: err,
    });
  }
  const L = manifest.layers;
  const landcoverJson = parseJson(get(L.landcover), L.landcover);
  const world: LoadedWorld = {
    manifest,
    projection: createProjection(manifest.projection),
    heightfield,
    roads: decodeRoads(parseJson(get(L.roads), L.roads), L.roads),
    water: decodeWater(parseJson(get(L.water), L.water), L.water),
    landcover: {
      areas: decodeAreas(
        landcoverJson.areas,
        expectArray(landcoverJson.kinds, L.landcover, 'kinds') as string[],
        L.landcover,
      ),
    },
    buildings: decodeBuildings(get(L.buildings), L.buildings),
    vegetation: decodeVegetation(get(L.vegetation), L.vegetation, manifest),
    routes: decodeRoutes(parseJson(get(L.routes), L.routes), L.routes),
  };
  emit('done');
  return world;
}
