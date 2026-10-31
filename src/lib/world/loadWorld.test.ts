import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { encodeHeightDeltas } from './heightfield';
import { loadWorld, WorldLoadError, type WorldLoadProgress } from './loadWorld';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

/** A tiny but complete bundle: 9×5 heightfield, one of everything. */
function makeBundle() {
  const cols = 9;
  const rows = 5;
  const q = new Uint16Array(cols * rows);
  for (let i = 0; i < q.length; i++) q[i] = 1000 + (i % cols) * 4 + Math.floor(i / cols) * 2;

  const building = Buffer.alloc(12 + 5 + 3 + 8 + 3 * 4);
  building.write('VWB1', 0, 'latin1');
  building.writeUInt32LE(1, 4);
  building.writeUInt32LE(4, 8);
  building.writeUInt16LE(4, 12); // 4 vertices
  building.writeUInt16LE(75, 14); // 7.5 m
  building.writeUInt8(1, 16); // house
  building.writeInt32LE(100, 20); // x0 = 10.0 m
  building.writeInt32LE(-50, 24); // y0 = −5.0 m
  [[100, 0], [0, 80], [-100, 0]].forEach(([dx, dy], i) => {
    building.writeInt16LE(dx, 28 + i * 4);
    building.writeInt16LE(dy, 30 + i * 4);
  });

  const veg = Buffer.alloc(16 + 2 * 6);
  veg.write('VWV1', 0, 'latin1');
  veg.writeUInt32LE(2, 4);
  veg.writeFloatLE(0.5, 8);
  veg.writeUInt16LE(20, 16); // x quanta
  veg.writeUInt16LE(40, 18);
  veg.writeUInt16LE(10, 20); // y quanta
  veg.writeUInt16LE(30, 22);
  veg[24] = 0;
  veg[25] = 3;
  veg[26] = 7;
  veg[27] = 200;

  const contents: Record<string, Uint8Array> = {
    'height.bin.gz': encodeHeightDeltas(q, cols, rows),
    'roads.json.gz': json({
      version: 1,
      units: 'dm',
      classes: ['primary', 'path'],
      widths: [8, 1.5],
      flags: { bridge: 1, tunnel: 2, unpaved: 4, oneway: 8 },
      names: ['Via Test'],
      roads: [
        { c: 0, n: 0, p: [0, 0, 100, 50] },
        { c: 1, f: 4, w: 2, p: [10, 10, 20, 20, 30, 10] },
      ],
    }),
    'water.json.gz': json({
      version: 1,
      units: 'dm',
      areaKinds: ['lake', 'river', 'pond'],
      lineKinds: ['river', 'canal', 'stream'],
      lineWidths: [15, 6, 2.5],
      areas: [{ k: 0, r: [[0, 0, 100, 0, 100, 100]] }],
      lines: [{ k: 2, p: [0, 0, 50, 50] }],
    }),
    'landcover.json.gz': json({ version: 1, units: 'dm', kinds: ['forest', 'grass'], areas: [{ k: 1, r: [[0, 0, 30, 0, 30, 30]] }] }),
    'buildings.bin.gz': new Uint8Array(building),
    'vegetation.bin.gz': new Uint8Array(veg),
    'routes.json.gz': json({
      version: 1,
      routes: [{ id: 'r1', name: 'Test route', lengthM: 20, stepM: 10, s: [0, 10, 20], x: [0, 10, 20], y: [0, 0, 0], h: [1, 2, 3] }],
    }),
  };
  const stored: Record<string, Uint8Array> = {};
  const files = Object.entries(contents).map(([path, content]) => {
    const gz = new Uint8Array(gzipSync(content));
    stored[path] = gz;
    return { path, bytes: gz.length, sha256: sha(gz), compression: 'gzip', contentBytes: content.length, contentSha256: sha(content) };
  });
  const manifest = {
    format: 'velo-world',
    version: 1,
    id: 'test',
    name: 'Test world',
    origin: { lat: 43.1, lon: 12.4 },
    projection: { type: 'tmerc', ellipsoid: 'WGS84', lat0: 43.1, lon0: 12.4, k0: 1 },
    extent: { xMin: -40, xMax: 40, yMin: -20, yMax: 20 },
    bbox: { south: 43.0998, west: 12.3995, north: 43.1002, east: 12.4005 },
    heightfield: {
      file: 'height.bin.gz',
      cols,
      rows,
      cellSize: 10,
      encoding: 'u16-delta',
      heightOffset: 100,
      heightScale: 0.25,
      minHeight: 350,
      maxHeight: 360,
    },
    layers: {
      roads: 'roads.json.gz',
      water: 'water.json.gz',
      landcover: 'landcover.json.gz',
      buildings: 'buildings.bin.gz',
      vegetation: 'vegetation.bin.gz',
      routes: 'routes.json.gz',
    },
    files,
    moods: ['clear-noon'],
    defaultMood: 'clear-noon',
    pois: [{ name: 'Test peak', kind: 'peak', x: 1, y: 2, h: 355, osm: 'node/1' }],
    routes: [{ id: 'r1', name: 'Test route', lengthM: 20, maxGapM: 0, gradeMeanAbsDiffPct: 0 }],
    stats: { buildings: 1 },
    credits: [{ id: 'osm', name: 'OpenStreetMap', licence: 'ODbL-1.0', url: 'https://osm.org/copyright', attribution: '© OSM' }],
    generator: {
      tool: 'test',
      version: 1,
      recipeSha256: sha(new Uint8Array([1])),
      osmDate: '2026-10-01T00:00:00Z',
      demSource: 'test',
      demZoom: 13,
      demTiles: 1,
    },
  };
  return { manifest, stored, contents, q };
}

type Bundle = ReturnType<typeof makeBundle>;

/** In-memory host: `files` maps bundle paths to bytes; anything absent is a 404. */
function hostFor(bundle: Bundle, override: Partial<Record<string, Uint8Array | 'throw' | number>> = {}) {
  const requested: string[] = [];
  const fetchFn = async (url: string) => {
    const path = url.replace(/^\/worlds\/test\//, '');
    requested.push(path);
    const o = override[path];
    if (o === 'throw') throw new TypeError('Failed to fetch');
    if (typeof o === 'number') return new Response(null, { status: o });
    const body = o ?? (path === 'manifest.json' ? json(bundle.manifest) : bundle.stored[path]);
    if (!body) return new Response(null, { status: 404 });
    return new Response(body as BodyInit, { status: 200 });
  };
  return { fetchFn, requested };
}

async function expectWorldError(p: Promise<unknown>, code: string, file?: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(WorldLoadError);
  expect((err as WorldLoadError).code).toBe(code);
  if (file) expect((err as WorldLoadError).file).toBe(file);
}

describe('loadWorld', () => {
  it('decodes every layer of a valid bundle', async () => {
    const b = makeBundle();
    const { fetchFn } = hostFor(b);
    const w = await loadWorld('/worlds/test/', { fetch: fetchFn });

    expect(w.manifest.id).toBe('test');
    expect(Array.from(w.heightfield.data)).toEqual(Array.from(b.q));
    expect(w.heightfield.sampleHeight(-40, 20)).toBe(100 + 1000 * 0.25);
    expect(w.projection.forward(43.1, 12.4)).toEqual([0, 0]);

    expect(w.roads.roads).toHaveLength(2);
    expect(w.roads.roads[0]).toMatchObject({ cls: 0, width: 8, flags: 0, name: 'Via Test' });
    expect(Array.from(w.roads.roads[0].points)).toEqual([0, 0, 10, 5]);
    expect(w.roads.roads[1]).toMatchObject({ cls: 1, width: 2, flags: 4 });

    expect(w.water.areas[0].kind).toBe('lake');
    expect(w.water.lines[0]).toMatchObject({ kind: 'stream', width: 2.5 });
    expect(w.landcover.areas[0].kind).toBe('grass');
    expect(Array.from(w.landcover.areas[0].rings[0])).toEqual([0, 0, 3, 0, 3, 3]);

    expect(w.buildings.count).toBe(1);
    expect(Array.from(w.buildings.start)).toEqual([0, 4]);
    expect(Array.from(w.buildings.xy)).toEqual([10, -5, 20, -5, 20, 3, 10, 3]);
    expect(w.buildings.height[0]).toBeCloseTo(7.5, 6);
    expect(w.buildings.kind[0]).toBe(1);

    expect(w.vegetation.count).toBe(2);
    expect(Array.from(w.vegetation.x)).toEqual([-30, -20]);
    expect(Array.from(w.vegetation.y)).toEqual([-15, -5]);
    expect(Array.from(w.vegetation.kind)).toEqual([0, 3]);
    expect(Array.from(w.vegetation.seed)).toEqual([7, 200]);

    expect(w.routes[0].id).toBe('r1');
    expect(Array.from(w.routes[0].h)).toEqual([1, 2, 3]);
  });

  it('emits progress: manifest, one event per file with growing byte counts, then done', async () => {
    const b = makeBundle();
    const events: WorldLoadProgress[] = [];
    await loadWorld('/worlds/test', { fetch: hostFor(b).fetchFn, onProgress: (e) => events.push({ ...e }) });

    const totalBytes = b.manifest.files.reduce((a, f) => a + f.bytes, 0);
    expect(events[0]).toMatchObject({ phase: 'manifest', loadedFiles: 0, totalFiles: 7, totalBytes });
    const fileEvents = events.filter((e) => e.phase === 'file');
    expect(fileEvents.map((e) => e.file).sort()).toEqual(b.manifest.files.map((f) => f.path).sort());
    for (let i = 1; i < events.length; i++) {
      expect(events[i].loadedFiles).toBeGreaterThanOrEqual(events[i - 1].loadedFiles);
      expect(events[i].loadedBytes).toBeGreaterThanOrEqual(events[i - 1].loadedBytes);
    }
    expect(events[events.length - 1]).toMatchObject({ phase: 'done', loadedFiles: 7, loadedBytes: totalBytes });
  });

  it('accepts files the host already un-gzipped (Content-Encoding passthrough)', async () => {
    const b = makeBundle();
    const { fetchFn } = hostFor(b, { 'roads.json.gz': b.contents['roads.json.gz'] });
    const w = await loadWorld('/worlds/test/', { fetch: fetchFn });
    expect(w.roads.roads).toHaveLength(2);
  });

  it('missing manifest or layer → code "missing" naming the file', async () => {
    const b = makeBundle();
    await expectWorldError(loadWorld('/worlds/test/', { fetch: hostFor(b, { 'manifest.json': 404 }).fetchFn }), 'missing', 'manifest.json');
    await expectWorldError(loadWorld('/worlds/test/', { fetch: hostFor(b, { 'buildings.bin.gz': 404 }).fetchFn }), 'missing', 'buildings.bin.gz');
  });

  it('corrupt bytes → code "corrupt" (bad gzip, hash mismatch, truncation, bad JSON, bad magic)', async () => {
    const b = makeBundle();
    const flipped = b.stored['height.bin.gz'].slice();
    flipped[flipped.length - 12] ^= 0xff; // deflate payload damage
    await expectWorldError(loadWorld('/worlds/test/', { fetch: hostFor(b, { 'height.bin.gz': flipped }).fetchFn }), 'corrupt', 'height.bin.gz');

    // Valid gzip of the wrong content: caught by size/hash.
    const otherRoads = new Uint8Array(gzipSync(json({ version: 1, classes: [], widths: [], names: [], roads: [], flags: {}, pad: 'x'.repeat(200) })));
    await expectWorldError(loadWorld('/worlds/test/', { fetch: hostFor(b, { 'roads.json.gz': otherRoads }).fetchFn }), 'corrupt', 'roads.json.gz');

    await expectWorldError(
      loadWorld('/worlds/test/', { fetch: hostFor(b, { 'manifest.json': new TextEncoder().encode('{"format":') }).fetchFn }),
      'corrupt',
      'manifest.json',
    );

    // Same size, same hash check disabled: structure checks still catch it.
    const badMagic = b.contents['buildings.bin.gz'].slice();
    badMagic[0] = 0x58;
    const m = structuredClone(b.manifest);
    const entry = m.files.find((f) => f.path === 'buildings.bin.gz')!;
    const gz = new Uint8Array(gzipSync(badMagic));
    Object.assign(entry, { bytes: gz.length, sha256: sha(gz), contentSha256: sha(badMagic) });
    const host = hostFor({ ...b, manifest: m, stored: { ...b.stored, 'buildings.bin.gz': gz } });
    await expectWorldError(loadWorld('/worlds/test/', { fetch: host.fetchFn }), 'corrupt', 'buildings.bin.gz');
  });

  it('a manifest that lies about the grid or lists unknown files → "corrupt"', async () => {
    const b = makeBundle();
    const m1 = structuredClone(b.manifest);
    m1.heightfield.cols = 10;
    await expectWorldError(loadWorld('/worlds/test/', { fetch: hostFor(b, { 'manifest.json': json(m1) }).fetchFn }), 'corrupt', 'manifest.json');
    const m2 = structuredClone(b.manifest);
    m2.files = m2.files.filter((f) => f.path !== 'water.json.gz');
    await expectWorldError(loadWorld('/worlds/test/', { fetch: hostFor(b, { 'manifest.json': json(m2) }).fetchFn }), 'corrupt', 'manifest.json');
  });

  it('a newer format version → "unsupported"', async () => {
    const b = makeBundle();
    await expectWorldError(
      loadWorld('/worlds/test/', { fetch: hostFor(b, { 'manifest.json': json({ ...b.manifest, version: 2 }) }).fetchFn }),
      'unsupported',
    );
  });

  it('transport failures → "network"; HTTP 500 → "network"', async () => {
    const b = makeBundle();
    await expectWorldError(loadWorld('/worlds/test/', { fetch: hostFor(b, { 'routes.json.gz': 'throw' }).fetchFn }), 'network', 'routes.json.gz');
    await expectWorldError(loadWorld('/worlds/test/', { fetch: hostFor(b, { 'water.json.gz': 500 }).fetchFn }), 'network', 'water.json.gz');
  });

  it('an aborted signal → "aborted" without fetching layers', async () => {
    const b = makeBundle();
    const ctrl = new AbortController();
    ctrl.abort();
    const host = hostFor(b);
    await expectWorldError(loadWorld('/worlds/test/', { fetch: host.fetchFn, signal: ctrl.signal }), 'aborted');
    expect(host.requested).toEqual([]);
  });
});
