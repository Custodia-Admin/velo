/**
 * World bundle manifest: types and a dependency-free validator.
 *
 * The JSON Schema twin lives in tools/worldbake/manifest.schema.json and the
 * prose spec in docs/worlds/WORLD-FORMAT.md; `manifest.test.ts` keeps the
 * three in step. The bake imports this file (Node type stripping) to validate
 * what it writes, so keep it import-free apart from types.
 */

import type { ProjectionParams } from './projection';

export const WORLD_FORMAT = 'velo-world';
export const WORLD_FORMAT_VERSION = 1;

export type WorldErrorCode =
  /** A file is absent (HTTP 404, ENOENT). */
  | 'missing'
  /** A file exists but its bytes or structure are wrong (hash, size, JSON, magic). */
  | 'corrupt'
  /** Valid bundle in a format version this build cannot read. */
  | 'unsupported'
  /** Transport failure other than a 404. */
  | 'network'
  /** The caller's AbortSignal fired. */
  | 'aborted';

/** Every failure while loading or validating a world surfaces as this. */
export class WorldLoadError extends Error {
  readonly code: WorldErrorCode;
  /** Bundle-relative file the error is about, when there is one. */
  readonly file: string | undefined;

  constructor(code: WorldErrorCode, message: string, file?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorldLoadError';
    this.code = code;
    this.file = file;
  }
}

export interface WorldFileEntry {
  /** Bundle-relative path, e.g. "height.bin". */
  path: string;
  /** Size of the file as stored, bytes. */
  bytes: number;
  /** SHA-256 (hex) of the file as stored. Bake determinism is judged on this. */
  sha256: string;
  compression: 'gzip' | 'none';
  /** Size after decompression, bytes. */
  contentBytes: number;
  /** SHA-256 (hex) after decompression. The loader verifies this one. */
  contentSha256: string;
}

export interface WorldExtent {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface WorldBbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface WorldHeightfieldInfo {
  file: string;
  cols: number;
  rows: number;
  cellSize: number;
  encoding: 'u16-delta';
  heightOffset: number;
  heightScale: number;
  minHeight: number;
  maxHeight: number;
}

export interface WorldLayers {
  roads: string;
  water: string;
  landcover: string;
  buildings: string;
  vegetation: string;
  routes: string;
}

export type WorldPoiKind = 'town' | 'village' | 'peak' | 'viewpoint' | 'landmark' | 'church';

export interface WorldPoi {
  name: string;
  kind: WorldPoiKind;
  x: number;
  y: number;
  /** Ground height at the POI from the heightfield, metres. */
  h: number;
  /** OSM element, e.g. "node/123". */
  osm: string;
}

export interface WorldRouteInfo {
  /** Scenic route id (src/lib/scenicRoutes.ts). */
  id: string;
  name: string;
  /** Route length on the app's own distance scale (haversine), metres. */
  lengthM: number;
  /** max |render ele − sampleHeight| over the snapped samples; 0 by construction. */
  maxGapM: number;
  /** Mean |render grade − route profile grade|, percentage points. */
  gradeMeanAbsDiffPct: number;
}

export interface WorldCredit {
  id: string;
  name: string;
  licence: string;
  url: string;
  attribution: string;
}

export interface WorldManifest {
  format: typeof WORLD_FORMAT;
  version: number;
  id: string;
  name: string;
  origin: { lat: number; lon: number };
  projection: ProjectionParams;
  extent: WorldExtent;
  bbox: WorldBbox;
  heightfield: WorldHeightfieldInfo;
  layers: WorldLayers;
  files: WorldFileEntry[];
  moods: string[];
  defaultMood: string;
  pois: WorldPoi[];
  routes: WorldRouteInfo[];
  stats: Record<string, number>;
  credits: WorldCredit[];
  generator: {
    tool: string;
    version: number;
    recipeSha256: string;
    osmDate: string;
    demSource: string;
    demZoom: number;
    demTiles: number;
  };
}

const LAYER_KEYS: (keyof WorldLayers)[] = ['roads', 'water', 'landcover', 'buildings', 'vegetation', 'routes'];
const POI_KINDS: WorldPoiKind[] = ['town', 'village', 'peak', 'viewpoint', 'landmark', 'church'];

/** Top-level manifest keys, in schema order (manifest.test.ts compares with the JSON Schema). */
export const MANIFEST_KEYS = [
  'format',
  'version',
  'id',
  'name',
  'origin',
  'projection',
  'extent',
  'bbox',
  'heightfield',
  'layers',
  'files',
  'moods',
  'defaultMood',
  'pois',
  'routes',
  'stats',
  'credits',
  'generator',
] as const;

type Obj = Record<string, unknown>;

function fail(msg: string): never {
  throw new WorldLoadError('corrupt', `manifest.json: ${msg}`, 'manifest.json');
}
function obj(v: unknown, at: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`${at} must be an object`);
  return v as Obj;
}
function num(o: Obj, k: string, at: string): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${at}.${k} must be a finite number`);
  return v;
}
function str(o: Obj, k: string, at: string): string {
  const v = o[k];
  if (typeof v !== 'string' || v.length === 0) fail(`${at}.${k} must be a non-empty string`);
  return v;
}
function arr(o: Obj, k: string, at: string): unknown[] {
  const v = o[k];
  if (!Array.isArray(v)) fail(`${at}.${k} must be an array`);
  return v;
}
function int(o: Obj, k: string, at: string, min = 0): number {
  const v = num(o, k, at);
  if (!Number.isInteger(v) || v < min) fail(`${at}.${k} must be an integer ≥ ${min}`);
  return v;
}

const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_PATH = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Check a parsed manifest. Returns it typed, or throws `WorldLoadError`
 * ('unsupported' for another format/version, 'corrupt' for anything else).
 */
export function validateManifest(input: unknown): WorldManifest {
  const m = obj(input, 'manifest');
  if (m.format !== WORLD_FORMAT) {
    throw new WorldLoadError('unsupported', `manifest.json: format ${String(m.format)} is not ${WORLD_FORMAT}`, 'manifest.json');
  }
  if (m.version !== WORLD_FORMAT_VERSION) {
    throw new WorldLoadError(
      'unsupported',
      `manifest.json: format version ${String(m.version)}, this build reads ${WORLD_FORMAT_VERSION}`,
      'manifest.json',
    );
  }
  for (const k of MANIFEST_KEYS) if (!(k in m)) fail(`missing ${k}`);
  str(m, 'id', 'manifest');
  str(m, 'name', 'manifest');
  const origin = obj(m.origin, 'origin');
  num(origin, 'lat', 'origin');
  num(origin, 'lon', 'origin');
  const proj = obj(m.projection, 'projection');
  if (proj.type !== 'tmerc' || proj.ellipsoid !== 'WGS84') fail('projection must be tmerc/WGS84');
  num(proj, 'lat0', 'projection');
  num(proj, 'lon0', 'projection');
  num(proj, 'k0', 'projection');
  const ext = obj(m.extent, 'extent');
  const xMin = num(ext, 'xMin', 'extent');
  const xMax = num(ext, 'xMax', 'extent');
  const yMin = num(ext, 'yMin', 'extent');
  const yMax = num(ext, 'yMax', 'extent');
  if (!(xMax > xMin && yMax > yMin)) fail('extent is empty');
  const bbox = obj(m.bbox, 'bbox');
  for (const k of ['south', 'west', 'north', 'east']) num(bbox, k, 'bbox');

  const hf = obj(m.heightfield, 'heightfield');
  str(hf, 'file', 'heightfield');
  const cols = int(hf, 'cols', 'heightfield', 2);
  const rows = int(hf, 'rows', 'heightfield', 2);
  if (cols > 4096 || rows > 4096) fail('heightfield larger than 4096²');
  const cell = num(hf, 'cellSize', 'heightfield');
  if (!(cell > 0)) fail('heightfield.cellSize must be positive');
  if (hf.encoding !== 'u16-delta') {
    throw new WorldLoadError('unsupported', `manifest.json: heightfield encoding ${String(hf.encoding)}`, 'manifest.json');
  }
  num(hf, 'heightOffset', 'heightfield');
  if (!(num(hf, 'heightScale', 'heightfield') > 0)) fail('heightfield.heightScale must be positive');
  num(hf, 'minHeight', 'heightfield');
  num(hf, 'maxHeight', 'heightfield');
  if (Math.abs(xMin + (cols - 1) * cell - xMax) > 1e-6 || Math.abs(yMax - (rows - 1) * cell - yMin) > 1e-6) {
    fail('heightfield grid does not span the extent');
  }

  const layers = obj(m.layers, 'layers');
  for (const k of LAYER_KEYS) str(layers, k, 'layers');

  const files = arr(m, 'files', 'manifest');
  const paths = new Set<string>();
  files.forEach((f, i) => {
    const e = obj(f, `files[${i}]`);
    const p = str(e, 'path', `files[${i}]`);
    if (!SAFE_PATH.test(p) || p === 'manifest.json') fail(`files[${i}].path ${p} is not a bundle file name`);
    if (paths.has(p)) fail(`files[${i}].path ${p} listed twice`);
    paths.add(p);
    int(e, 'bytes', `files[${i}]`);
    int(e, 'contentBytes', `files[${i}]`);
    if (e.compression !== 'gzip' && e.compression !== 'none') fail(`files[${i}].compression must be gzip or none`);
    for (const k of ['sha256', 'contentSha256']) {
      if (!HEX64.test(str(e, k, `files[${i}]`))) fail(`files[${i}].${k} must be 64 hex chars`);
    }
  });
  for (const p of [hf.file as string, ...LAYER_KEYS.map((k) => layers[k] as string)]) {
    if (!paths.has(p)) fail(`${p} is referenced but not listed in files`);
  }

  const moods = arr(m, 'moods', 'manifest');
  if (!moods.every((x) => typeof x === 'string')) fail('moods must be strings');
  if (!moods.includes(str(m, 'defaultMood', 'manifest'))) fail('defaultMood must be one of moods');

  arr(m, 'pois', 'manifest').forEach((p, i) => {
    const o = obj(p, `pois[${i}]`);
    str(o, 'name', `pois[${i}]`);
    str(o, 'osm', `pois[${i}]`);
    if (!POI_KINDS.includes(o.kind as WorldPoiKind)) fail(`pois[${i}].kind ${String(o.kind)} unknown`);
    for (const k of ['x', 'y', 'h']) num(o, k, `pois[${i}]`);
  });
  arr(m, 'routes', 'manifest').forEach((r, i) => {
    const o = obj(r, `routes[${i}]`);
    str(o, 'id', `routes[${i}]`);
    str(o, 'name', `routes[${i}]`);
    for (const k of ['lengthM', 'maxGapM', 'gradeMeanAbsDiffPct']) num(o, k, `routes[${i}]`);
  });
  const stats = obj(m.stats, 'stats');
  for (const k of Object.keys(stats)) num(stats, k, 'stats');
  const credits = arr(m, 'credits', 'manifest');
  if (credits.length === 0) fail('credits must not be empty');
  credits.forEach((c, i) => {
    const o = obj(c, `credits[${i}]`);
    for (const k of ['id', 'name', 'licence', 'url', 'attribution']) str(o, k, `credits[${i}]`);
  });
  const gen = obj(m.generator, 'generator');
  str(gen, 'tool', 'generator');
  int(gen, 'version', 'generator', 1);
  if (!HEX64.test(str(gen, 'recipeSha256', 'generator'))) fail('generator.recipeSha256 must be 64 hex chars');
  str(gen, 'osmDate', 'generator');
  str(gen, 'demSource', 'generator');
  int(gen, 'demZoom', 'generator');
  int(gen, 'demTiles', 'generator', 1);

  return m as unknown as WorldManifest;
}
