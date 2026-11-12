import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PagesDist {
  publicEnvProblems: (env: Record<string, string | undefined>, rootFiles: string[]) => string[];
  householdBundleFiles: (dist: string) => string[];
  pagesPattern: (source: string) => string;
  pagesHeaders: (vercel: unknown) => string;
}

const load = async () => (await import('../../scripts/pages-dist.mjs')) as PagesDist;
const vercel = JSON.parse(readFileSync(fileURLToPath(new URL('../../vercel.json', import.meta.url)), 'utf8'));

/** The header block for one `_headers` URL pattern, as `{ name: value }`. */
function block(headers: string, pattern: string): Record<string, string> {
  const lines = headers.split('\n');
  const start = lines.indexOf(pattern);
  expect(start, `no ${pattern} block`).toBeGreaterThanOrEqual(0);
  const out: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) break;
    const i = line.indexOf(':');
    out[line.slice(2, i)] = line.slice(i + 1).trim();
  }
  return out;
}

describe('Cloudflare Pages dist (scripts/pages-dist.mjs)', () => {
  it('sends the CSP vercel.json sends, with the world bucket and the OSM map tiles allowed', async () => {
    const { pagesHeaders } = await load();
    const headers = pagesHeaders(vercel);
    const all = block(headers, '/*');
    const csp = vercel.headers[0].headers.find((h: { key: string }) => h.key === 'Content-Security-Policy').value;
    expect(all['Content-Security-Policy']).toBe(csp);
    expect(all['X-Frame-Options']).toBe('DENY');
    const connect = csp.split(';').find((d: string) => d.trim().startsWith('connect-src')).trim().split(/\s+/);
    // Remote worlds (catalog.ts) and the map under routes no world covers (cesiumUtils.ts OSM_TILE_URL).
    expect(connect).toContain('https://pub-26367e714cf944b59b97a34ecb76922b.r2.dev');
    expect(connect).toContain('https://tile.openstreetmap.org');
    expect(connect).toContain('https://api.open-meteo.com');
  });

  it('keeps hashed assets immutable, the service worker uncached and previews out of search', async () => {
    const { pagesHeaders } = await load();
    const headers = pagesHeaders(vercel);
    expect(block(headers, '/assets/*')['Cache-Control']).toBe('public, max-age=31536000, immutable');
    expect(block(headers, '/sw.js')['Cache-Control']).toBe('no-cache');
    expect(block(headers, 'https://:version.:project.pages.dev/*')['X-Robots-Tag']).toBe('noindex');
    // Pages ignores _headers lines over 2,000 characters.
    for (const line of headers.split('\n')) expect(line.length).toBeLessThan(2000);
  });

  it('maps vercel.json sources to _headers patterns and refuses ones it cannot map', async () => {
    const { pagesPattern } = await load();
    expect(pagesPattern('/(.*)')).toBe('/*');
    expect(pagesPattern('/assets/(.*)')).toBe('/assets/*');
    expect(pagesPattern('/sw.js')).toBe('/sw.js');
    expect(() => pagesPattern('/(a|b)/x')).toThrow();
  });

  it('refuses a household or token-carrying build environment', async () => {
    const { publicEnvProblems } = await load();
    expect(publicEnvProblems({ VITE_CESIUM_ION_TOKEN: '', PATH: '/bin' }, ['.env.example', '.env.local.example', 'src'])).toEqual([]);
    expect(publicEnvProblems({}, ['.env.local'])).toEqual(['env file in the repo root: .env.local']);
    expect(publicEnvProblems({}, ['.env.production.local'])).toHaveLength(1);
    expect(publicEnvProblems({}, ['.env'])).toHaveLength(1);
    expect(publicEnvProblems({ VITE_CESIUM_ION_TOKEN: 'abc' }, [])).toEqual(['VITE_CESIUM_ION_TOKEN is set']);
    expect(publicEnvProblems({ VITE_XAI_API_KEY: 'k', VITE_STRAVA_CLIENT_SECRET: 's' }, [])).toHaveLength(2);
    expect(publicEnvProblems({ VITE_HOUSEHOLD_LABELS: 'true' }, [])).toEqual(['VITE_HOUSEHOLD_LABELS is on']);
    expect(publicEnvProblems({ VITE_HOUSEHOLD_LABELS: '0' }, [])).toEqual([]);
  });

  it('finds the household labels flag in a built bundle', async () => {
    const { householdBundleFiles } = await load();
    const dist = mkdtempSync(join(tmpdir(), 'pages-dist-'));
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'assets', 'index-a.js'), 'XA={BASE_URL:"/",DEV:!1,MODE:"production",PROD:!0,SSR:!1}');
    expect(householdBundleFiles(dist)).toEqual([]);
    writeFileSync(join(dist, 'assets', 'index-b.js'), 'XA={BASE_URL:"/",VITE_HOUSEHOLD_LABELS:"1"}');
    expect(householdBundleFiles(dist)).toEqual([join('assets', 'index-b.js')]);
  });
});
