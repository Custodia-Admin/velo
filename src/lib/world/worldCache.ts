/**
 * The Cache API store for world bundles published off-repo (remote worlds).
 *
 * A remote world lives under a content-hashed directory
 * (`<base>/<id>/<hash>/`), so a file at a given URL never changes: the
 * loader reads it from this cache first and, after the file passes its
 * SHA-256 check, stores it for next time. The second ride of a destination
 * then needs no network at all (offline included). The service worker's
 * runtimeCaching (vite.config.ts) uses the same cache name, so whichever of
 * the two fetched a file first, the other finds it.
 *
 * Worlds shipped in public/worlds keep fixed URLs that a re-bake rewrites in
 * place, so they never go through this cache (a stale copy would win).
 *
 * Engine-free (src/lib/world rule).
 */

/** Shared with the service worker's runtimeCaching in vite.config.ts (a test pins both). */
export const WORLD_CACHE_NAME = 'velo-worlds-v1';

/** What loadWorld needs from a cache: bytes in, bytes out, keyed by URL. */
export interface WorldFileCache {
  match(url: string): Promise<Uint8Array | undefined>;
  put(url: string, bytes: Uint8Array): Promise<void>;
  delete(url: string): Promise<void>;
}

interface CacheLike {
  match(request: string, options?: { ignoreVary?: boolean; ignoreSearch?: boolean }): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
  delete(request: string, options?: { ignoreVary?: boolean }): Promise<boolean>;
}

interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
}

/**
 * Wrap a Cache API cache. Every failure (quota, a private window without
 * storage, an entry evicted mid-read) reads as a miss or a no-op: the cache
 * must never be the reason a ride doesn't start.
 */
export function worldFileCache(cache: CacheLike): WorldFileCache {
  return {
    async match(url) {
      try {
        // ignoreVary: the service worker may have stored the network response,
        // whose `Vary: Origin` would otherwise never match the loader's request.
        const res = await cache.match(url, { ignoreVary: true });
        if (!res || !res.ok) return undefined;
        return new Uint8Array(await res.arrayBuffer());
      } catch {
        return undefined;
      }
    },
    async put(url, bytes) {
      try {
        await cache.put(
          url,
          new Response(bytes as BodyInit, {
            status: 200,
            headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength) },
          }),
        );
      } catch {
        // Quota or storage refused: the ride goes on from the network copy.
      }
    },
    async delete(url) {
      try {
        await cache.delete(url, { ignoreVary: true });
      } catch {
        // nothing to do
      }
    },
  };
}

/**
 * The world cache, or null where the Cache API is missing (insecure
 * contexts such as plain-http LAN addresses, old browsers, tests).
 */
export async function openWorldCache(
  storage: CacheStorageLike | undefined = (globalThis as { caches?: CacheStorageLike }).caches,
  name: string = WORLD_CACHE_NAME,
): Promise<WorldFileCache | null> {
  if (!storage) return null;
  try {
    return worldFileCache(await storage.open(name));
  } catch {
    return null;
  }
}
