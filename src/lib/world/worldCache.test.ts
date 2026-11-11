import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DEFAULT_REMOTE_WORLDS_URL as TOOLS_REMOTE_URL } from '../../../tools/worldbake/worldBundles.mjs';
import { DEFAULT_REMOTE_WORLDS_URL, WORLD_CATALOG, worldUrl } from './catalog';
import { openWorldCache, WORLD_CACHE_NAME, worldFileCache } from './worldCache';

/** A Cache API stand-in with the semantics the wrapper relies on (Vary-sensitive unless ignoreVary). */
function fakeCache() {
  const entries = new Map<string, { body: Uint8Array; vary: boolean; status: number }>();
  const calls: string[] = [];
  return {
    entries,
    calls,
    async match(url: string, opts?: { ignoreVary?: boolean }) {
      calls.push(`match ignoreVary=${String(opts?.ignoreVary)}`);
      const e = entries.get(url);
      if (!e || (e.vary && !opts?.ignoreVary)) return undefined;
      return new Response(e.body as BodyInit, { status: e.status });
    },
    async put(url: string, res: Response) {
      entries.set(url, { body: new Uint8Array(await res.arrayBuffer()), vary: res.headers.has('vary'), status: res.status });
    },
    async delete(url: string) {
      return entries.delete(url);
    },
  };
}

describe('world cache (Cache API wrapper)', () => {
  it('round-trips bytes by URL', async () => {
    const raw = fakeCache();
    const cache = worldFileCache(raw);
    expect(await cache.match('https://x/worlds/a/0123456789abcdef/height.bin.gz')).toBeUndefined();
    await cache.put('https://x/worlds/a/0123456789abcdef/height.bin.gz', new Uint8Array([1, 2, 3]));
    expect(await cache.match('https://x/worlds/a/0123456789abcdef/height.bin.gz')).toEqual(new Uint8Array([1, 2, 3]));
    await cache.delete('https://x/worlds/a/0123456789abcdef/height.bin.gz');
    expect(await cache.match('https://x/worlds/a/0123456789abcdef/height.bin.gz')).toBeUndefined();
  });

  it('finds what the service worker stored with `Vary: Origin` (ignoreVary)', async () => {
    const raw = fakeCache();
    raw.entries.set('u', { body: new Uint8Array([7]), vary: true, status: 200 });
    expect(await worldFileCache(raw).match('u')).toEqual(new Uint8Array([7]));
    expect(raw.calls).toEqual(['match ignoreVary=true']);
  });

  it('reads a stored error response as a miss', async () => {
    const raw = fakeCache();
    raw.entries.set('u', { body: new Uint8Array([7]), vary: false, status: 404 });
    expect(await worldFileCache(raw).match('u')).toBeUndefined();
  });

  it('never throws: storage failures read as a miss or a no-op', async () => {
    const boom = async () => {
      throw new DOMException('QuotaExceededError');
    };
    const cache = worldFileCache({ match: boom, put: boom, delete: boom });
    await expect(cache.match('u')).resolves.toBeUndefined();
    await expect(cache.put('u', new Uint8Array([1]))).resolves.toBeUndefined();
    await expect(cache.delete('u')).resolves.toBeUndefined();
  });

  it('opens the shared cache by name, or gives null without the Cache API', async () => {
    const opened: string[] = [];
    const storage = {
      async open(name: string) {
        opened.push(name);
        return fakeCache();
      },
    };
    expect(await openWorldCache(storage)).not.toBeNull();
    expect(opened).toEqual([WORLD_CACHE_NAME]);
    expect(await openWorldCache(undefined)).toBeNull();
    expect(
      await openWorldCache({
        open: async () => {
          throw new Error('SecurityError');
        },
      }),
    ).toBeNull();
  });
});

describe('service worker runtimeCaching for remote worlds (vite.config.ts)', () => {
  const config = readFileSync(fileURLToPath(new URL('../../../vite.config.ts', import.meta.url)), 'utf8');
  const block = config.slice(config.indexOf('runtimeCaching'));
  const pattern = new RegExp(block.match(/urlPattern: \/(.+)\/,\n/)![1]);

  it('caches into the loader’s cache, CacheFirst', () => {
    expect(block).toContain(`cacheName: '${WORLD_CACHE_NAME}'`);
    expect(block).toMatch(/handler: 'CacheFirst'/);
  });

  it('matches every file of a remote world at its published URL, and nothing shipped in public/worlds', () => {
    const remote = WORLD_CATALOG.filter((w) => w.remote);
    expect(remote.map((w) => w.id)).toContain('chengdu-luxelakes');
    for (const w of remote) {
      for (const f of ['manifest.json', 'height.bin.gz', 'routes.json.gz']) expect(worldUrl(w) + f).toMatch(pattern);
      // A household mirror under another host and path prefix works the same.
      expect(worldUrl(w, { VITE_WORLDS_REMOTE_URL: 'http://cat-bed:4180/velo/worlds' }) + 'roads.json.gz').toMatch(pattern);
    }
    for (const w of WORLD_CATALOG.filter((x) => !x.remote)) {
      expect(`https://velo.example${worldUrl(w)}manifest.json`).not.toMatch(pattern);
    }
  });

  it('precaches what a world ride needs besides the world: the rider model', () => {
    const globs = config.match(/globPatterns: \[([^\]]+)\]/)![1];
    const ext = globs.match(/\{([^}]+)\}/)![1].split(',');
    expect(ext).toEqual(expect.arrayContaining(['js', 'css', 'html', 'wasm', 'glb']));
  });

  it('the tools publish to the base URL the app reads', () => {
    expect(TOOLS_REMOTE_URL).toBe(DEFAULT_REMOTE_WORLDS_URL);
  });

  it('the deployed CSP lets the app fetch from the remote worlds origin', () => {
    const vercel = JSON.parse(readFileSync(fileURLToPath(new URL('../../../vercel.json', import.meta.url)), 'utf8'));
    const csp: string = vercel.headers
      .flatMap((h: { headers: { key: string; value: string }[] }) => h.headers)
      .find((h: { key: string }) => h.key === 'Content-Security-Policy').value;
    const connect = csp.split(';').find((d) => d.trim().startsWith('connect-src'))!.trim().split(/\s+/);
    expect(connect).toContain(new URL(DEFAULT_REMOTE_WORLDS_URL).origin);
  });
});
