import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import type { Route } from '@/types';
import { worldBundle } from '../../../tools/worldbake/worldBundles.mjs';
import { DEFAULT_REMOTE_WORLDS_URL, remoteWorldsBaseUrl, WORLD_CATALOG, worldForRoute, worldsBaseUrl, worldUrl } from './catalog';

const manifestOf = (id: string) =>
  JSON.parse(readFileSync(worldBundle(id)!.manifestPath, 'utf8')) as { id: string; bbox: unknown; routes: { id: string }[] };

const scenic = (id: string): Route => routeFromGeometry(id, id, SCENIC_ROUTE_GEOMETRY[id]);

const line = (id: string, pts: [number, number][]): Route => ({
  id,
  name: id,
  points: pts.map(([lat, lon], i) => ({ lat, lon, ele: 200, distance: i * 100 })),
  totalDistance: (pts.length - 1) * 100,
  ascent: 0,
  descent: 0,
  minElevation: 200,
  maxElevation: 200,
  loadedAt: 0,
});

describe('world catalog', () => {
  it('mirrors every shipped manifest (id, bbox, baked routes)', () => {
    for (const entry of WORLD_CATALOG) {
      const m = manifestOf(entry.id);
      expect(m.id).toBe(entry.id);
      expect(entry.bbox).toEqual(m.bbox);
      expect([...entry.routeIds].sort()).toEqual(m.routes.map((r) => r.id).sort());
    }
  });

  it('draws both Perugia scenic routes in the Perugia world', () => {
    expect(worldForRoute(scenic('scenic-perugia-tiber-park'))?.id).toBe('perugia');
    expect(worldForRoute(scenic('scenic-assisi-valley'))?.id).toBe('perugia');
  });

  it('draws Lugano–Melide and Locarno–Brissago in the Lugano world, not the routes beyond it', () => {
    expect(worldForRoute(scenic('scenic-lugano-melide'))?.id).toBe('lugano');
    expect(worldForRoute(scenic('scenic-locarno-brissago'))?.id).toBe('lugano');
    expect(worldForRoute(scenic('scenic-magadino-plain'))).toBeNull();
    expect(worldForRoute(scenic('scenic-lake-como-menaggio'))).toBeNull();
    expect(worldForRoute(line('gpx-lugano', [[46.0, 8.95], [46.01, 8.96]]))?.id).toBe('lugano');
  });

  it('takes any route that lies inside a world, e.g. a GPX upload around Perugia', () => {
    expect(worldForRoute(line('gpx-1', [[43.11, 12.39], [43.12, 12.41], [43.1, 12.45]]))?.id).toBe('perugia');
  });

  it('declines routes that leave the world, live GPS routes and empty routes', () => {
    expect(worldForRoute(line('trasimeno', [[43.11, 12.39], [43.13, 12.1]]))).toBeNull();
    expect(worldForRoute(line('zurich', [[47.37, 8.54], [47.38, 8.55]]))).toBeNull();
    expect(worldForRoute({ ...line('gps', [[43.11, 12.39], [43.12, 12.4]]), isLive: true })).toBeNull();
    expect(worldForRoute(line('one', [[43.11, 12.39]]))).toBeNull();
    expect(worldForRoute(null)).toBeNull();
  });

  it('resolves bundle URLs under the app base', () => {
    expect(worldsBaseUrl().endsWith('/worlds/')).toBe(true);
    expect(worldUrl(WORLD_CATALOG[0])).toMatch(/\/worlds\/perugia\/$/);
    expect(worldsBaseUrl({ BASE_URL: '/velo' })).toBe('/velo/worlds/');
    expect(worldsBaseUrl({ VITE_WORLDS_BASE_URL: 'https://cdn.example/w' })).toBe('https://cdn.example/w/');
  });

  it('draws both Chengdu routes in the Chengdu world, a remote world loaded from the R2 bucket', () => {
    const chengdu = worldForRoute(scenic('scenic-chengdu-luxe-lakes'));
    expect(chengdu?.id).toBe('chengdu-luxelakes');
    expect(worldForRoute(scenic('scenic-chengdu-xinglong-lake'))?.id).toBe('chengdu-luxelakes');
    expect(chengdu!.remote).toBe(true);
    expect(worldUrl(chengdu!, {})).toBe(`${DEFAULT_REMOTE_WORLDS_URL}${chengdu!.dir}`);
    expect(worldUrl(chengdu!, {})).toMatch(/^https:\/\/pub-[0-9a-f]{32}\.r2\.dev\/worlds\/chengdu-luxelakes\/[0-9a-f]{16}\/$/);
    // Perugia and Lugano stay in public/worlds.
    expect(WORLD_CATALOG.filter((w) => !w.remote).map((w) => w.id)).toEqual(['perugia', 'lugano']);
  });

  it('VITE_WORLDS_REMOTE_URL moves only the remote worlds (a household mirror with the same layout)', () => {
    const env = { VITE_WORLDS_REMOTE_URL: 'https://worlds.example/worlds' };
    expect(remoteWorldsBaseUrl(env)).toBe('https://worlds.example/worlds/');
    expect(remoteWorldsBaseUrl({})).toBe(DEFAULT_REMOTE_WORLDS_URL);
    const chengdu = WORLD_CATALOG.find((w) => w.id === 'chengdu-luxelakes')!;
    expect(worldUrl(chengdu, env)).toBe(`https://worlds.example/worlds/${chengdu.dir}`);
    expect(worldUrl(WORLD_CATALOG[0], env)).toBe('/worlds/perugia/');
  });
});
