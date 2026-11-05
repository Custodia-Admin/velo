/**
 * tileReadCache.ts: lets the side camera's sight reuse the photoreal tile
 * geometry it reads back from the GPU.
 *
 * Cesium3DTileset.getHeight is a CPU ray pick. For every tile under the ray it
 * copies the tile's vertex and index buffers back from the GPU (pickModel ->
 * ModelReader.readAttributeAsTypedArray / readIndicesAsTypedArray ->
 * Buffer.getBufferData; on WebGL 2 the tileset keeps no CPU copy) and then
 * walks the triangles. The copies are three quarters of a read's cost (about
 * 7 ms on cat-bed's iGPU), and the sight reads spots a few metres apart in the
 * same few tiles ten times a second: on the Lugano shore 98.6 % of the copies
 * were of a tile primitive copied before.
 *
 * `run(fn)` serves those copies from a small cache while `fn` runs: an LRU by
 * bytes, keyed by the tile's attribute / indices object and checked against
 * its GPU buffer (a reloaded tile gets new objects). Outside `run` the reads
 * are untouched, so no other Cesium code sees a shared array.
 *
 * Pure and engine-free: the caller hands in Cesium's ModelReader (a private
 * Cesium class; without the two functions there is simply no cache).
 */

type Readback = (this: unknown, source: unknown, ...rest: unknown[]) => unknown;

/** The two reads pickModel makes per tile primitive (Cesium's Scene/Model/ModelReader). */
export interface TileReadHost {
  readAttributeAsTypedArray: Readback;
  readIndicesAsTypedArray: Readback;
}

/** Most bytes of tile geometry kept (a 120 s Lugano ride held 7.8 MB in 238 copies). */
export const TILE_READ_CACHE_BYTES = 16 * 1024 * 1024;

export interface TileReadCache {
  /** Run `fn` with the tile reads it makes served from the cache. */
  run<T>(fn: () => T): T;
  /** Drop every copy (the view is gone). */
  clear(): void;
  stats(): { hits: number; misses: number; bytes: number; entries: number };
}

interface Entry {
  buffer: unknown;
  data: ArrayBufferView;
}

/** A GPU-backed source: no CPU copy (typedArray) and a buffer to copy from. */
interface Source {
  typedArray?: unknown;
  buffer?: { isDestroyed?: () => boolean } | null;
}

function isHost(h: unknown): h is TileReadHost {
  const o = h as Partial<TileReadHost> | null | undefined;
  return !!o && typeof o.readAttributeAsTypedArray === 'function' && typeof o.readIndicesAsTypedArray === 'function';
}

const caches = new WeakMap<object, TileReadCache>();

/**
 * The read cache for a ModelReader-like host, installed on it once (later
 * calls return the same cache). Null when the host lacks the two reads.
 */
export function tileReadCacheFor(host: unknown, maxBytes: number = TILE_READ_CACHE_BYTES): TileReadCache | null {
  if (!isHost(host)) return null;
  const known = caches.get(host);
  if (known) return known;
  let depth = 0;
  let bytes = 0;
  let hits = 0;
  let misses = 0;
  const lru = new Map<object, Entry>();
  const drop = (key: object, e: Entry) => {
    lru.delete(key);
    bytes -= e.data.byteLength;
  };
  const wrap = (name: keyof TileReadHost) => {
    const read = host[name];
    host[name] = function (this: unknown, source: unknown, ...rest: unknown[]) {
      const s = source as Source | null | undefined;
      if (depth === 0 || !s || typeof s !== 'object' || s.typedArray !== undefined || !s.buffer) {
        return read.call(this, source, ...rest);
      }
      const e = lru.get(s);
      if (e && e.buffer === s.buffer && s.buffer.isDestroyed?.() !== true) {
        lru.delete(s);
        lru.set(s, e);
        hits++;
        return e.data;
      }
      if (e) drop(s, e);
      const data = read.call(this, source, ...rest);
      misses++;
      if (ArrayBuffer.isView(data) && data.byteLength <= maxBytes) {
        lru.set(s, { buffer: s.buffer, data });
        bytes += data.byteLength;
        while (bytes > maxBytes) {
          const [key, oldest] = lru.entries().next().value as [object, Entry];
          drop(key, oldest);
        }
      }
      return data;
    };
  };
  wrap('readAttributeAsTypedArray');
  wrap('readIndicesAsTypedArray');
  const cache: TileReadCache = {
    run<T>(fn: () => T): T {
      depth++;
      try {
        return fn();
      } finally {
        depth--;
      }
    },
    clear() {
      lru.clear();
      bytes = 0;
    },
    stats() {
      return { hits, misses, bytes, entries: lru.size };
    },
  };
  caches.set(host, cache);
  return cache;
}
