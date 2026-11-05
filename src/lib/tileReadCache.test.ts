/**
 * tileReadCache: the side camera's sight reuses the tile geometry its reads
 * copy back from the GPU, and nothing else in Cesium sees the cache.
 */
import { describe, expect, it } from 'vitest';

import { TILE_READ_CACHE_BYTES, tileReadCacheFor, type TileReadHost } from '@/lib/tileReadCache';

/** A GPU-backed source: a buffer to copy from, no CPU copy. */
function gpuSource(bytes: number) {
  const buffer = { destroyed: false, isDestroyed() { return this.destroyed; } };
  return { buffer, typedArray: undefined as Uint8Array | undefined, bytes };
}
type Src = ReturnType<typeof gpuSource>;

/** A ModelReader-like host counting the copies it makes. */
function host() {
  const copies: Array<{ name: string; source: unknown }> = [];
  const h = {
    tag: 'reader',
    readAttributeAsTypedArray(this: { tag: string }, source: unknown) {
      copies.push({ name: `attr:${this.tag}`, source });
      const s = source as Src;
      return s.typedArray ?? new Uint8Array(s.bytes);
    },
    readIndicesAsTypedArray(this: { tag: string }, source: unknown) {
      copies.push({ name: `idx:${this.tag}`, source });
      const s = source as Src;
      return s.typedArray ?? new Uint16Array(s.bytes / 2);
    },
  };
  return { h, copies };
}

describe('tileReadCacheFor', () => {
  it('outside run() every read copies (no other Cesium code sees a shared array)', () => {
    const { h, copies } = host();
    const cache = tileReadCacheFor(h)!;
    const s = gpuSource(64);
    const a = h.readAttributeAsTypedArray(s);
    const b = h.readAttributeAsTypedArray(s);
    expect(copies).toHaveLength(2);
    expect(a).not.toBe(b);
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, bytes: 0, entries: 0 });
  });

  it('inside run() a tile primitive is copied once, then served from the cache', () => {
    const { h, copies } = host();
    const cache = tileReadCacheFor(h)!;
    const pos = gpuSource(1200);
    const idx = gpuSource(600);
    const first = cache.run(() => [h.readAttributeAsTypedArray(pos), h.readIndicesAsTypedArray(idx)]);
    const again = cache.run(() => [h.readAttributeAsTypedArray(pos), h.readIndicesAsTypedArray(idx)]);
    expect(copies.map((c) => c.name)).toEqual(['attr:reader', 'idx:reader']);
    expect(again[0]).toBe(first[0]);
    expect(again[1]).toBe(first[1]);
    expect(cache.stats()).toEqual({ hits: 2, misses: 2, bytes: 1800, entries: 2 });
  });

  it('a CPU copy (typedArray) or a source without a buffer is read as before', () => {
    const { h, copies } = host();
    const cache = tileReadCacheFor(h)!;
    const cpu = { buffer: {}, typedArray: new Uint8Array(8), bytes: 8 };
    const bare = { buffer: null, typedArray: undefined, bytes: 8 };
    cache.run(() => {
      h.readAttributeAsTypedArray(cpu);
      h.readAttributeAsTypedArray(cpu);
      h.readAttributeAsTypedArray(bare);
      h.readAttributeAsTypedArray(bare);
    });
    expect(copies).toHaveLength(4);
    expect(cache.stats().entries).toBe(0);
  });

  it('a reloaded tile (new buffer) or a destroyed buffer is copied again', () => {
    const { h, copies } = host();
    const cache = tileReadCacheFor(h)!;
    const s = gpuSource(100);
    cache.run(() => h.readAttributeAsTypedArray(s));
    s.buffer = { destroyed: false, isDestroyed() { return this.destroyed; } };
    cache.run(() => h.readAttributeAsTypedArray(s));
    expect(copies).toHaveLength(2);
    s.buffer.destroyed = true;
    cache.run(() => h.readAttributeAsTypedArray(s));
    expect(copies).toHaveLength(3);
    expect(cache.stats()).toMatchObject({ entries: 1, bytes: 100 });
  });

  it('keeps at most maxBytes, dropping the copy used longest ago', () => {
    const { h, copies } = host();
    const cache = tileReadCacheFor(h, 100)!;
    const [a, b, c] = [gpuSource(40), gpuSource(40), gpuSource(40)];
    cache.run(() => {
      h.readAttributeAsTypedArray(a);
      h.readAttributeAsTypedArray(b);
      h.readAttributeAsTypedArray(a); // a used again: b is now the oldest
      h.readAttributeAsTypedArray(c); // 120 bytes: b goes
    });
    expect(cache.stats()).toMatchObject({ bytes: 80, entries: 2 });
    copies.length = 0;
    cache.run(() => {
      h.readAttributeAsTypedArray(a);
      h.readAttributeAsTypedArray(c);
    });
    expect(copies).toHaveLength(0);
    cache.run(() => h.readAttributeAsTypedArray(b));
    expect(copies).toHaveLength(1);
    // One copy bigger than the whole budget is not kept (and pushes nothing out).
    cache.run(() => h.readAttributeAsTypedArray(gpuSource(101)));
    expect(cache.stats()).toMatchObject({ bytes: 80, entries: 2 });
    expect(TILE_READ_CACHE_BYTES).toBe(16 * 1024 * 1024);
  });

  it('is installed once per host, keeps `this`, and a throw inside run() ends the cached stretch', () => {
    const { h, copies } = host();
    const cache = tileReadCacheFor(h)!;
    expect(tileReadCacheFor(h)).toBe(cache);
    const s = gpuSource(16);
    cache.run(() => h.readAttributeAsTypedArray(s));
    expect(copies).toEqual([{ name: 'attr:reader', source: s }]);
    expect(() =>
      cache.run(() => {
        throw new Error('pick failed');
      }),
    ).toThrow('pick failed');
    h.readAttributeAsTypedArray(s);
    h.readAttributeAsTypedArray(s);
    expect(copies).toHaveLength(3);
    // Nested runs stay cached until the outer one ends.
    cache.run(() => {
      cache.run(() => h.readAttributeAsTypedArray(s));
      h.readAttributeAsTypedArray(s);
    });
    expect(copies).toHaveLength(3);
  });

  it('clear() drops every copy', () => {
    const { h, copies } = host();
    const cache = tileReadCacheFor(h)!;
    const s = gpuSource(16);
    cache.run(() => h.readAttributeAsTypedArray(s));
    cache.clear();
    expect(cache.stats()).toMatchObject({ bytes: 0, entries: 0 });
    cache.run(() => h.readAttributeAsTypedArray(s));
    expect(copies).toHaveLength(2);
  });

  it('no cache without both reads', () => {
    expect(tileReadCacheFor(undefined)).toBeNull();
    expect(tileReadCacheFor({ readAttributeAsTypedArray() {} })).toBeNull();
    const h: TileReadHost = { readAttributeAsTypedArray: () => 1, readIndicesAsTypedArray: () => 2 };
    expect(tileReadCacheFor(h)).not.toBeNull();
  });
});
