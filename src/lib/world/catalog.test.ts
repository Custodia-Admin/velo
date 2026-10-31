import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import type { Route } from '@/types';
import { WORLD_CATALOG, worldForRoute, worldsBaseUrl, worldUrl } from './catalog';

const manifestOf = (dir: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../public/worlds/${dir}manifest.json`, import.meta.url)), 'utf8'),
  ) as { id: string; bbox: unknown; routes: { id: string }[] };

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
      const m = manifestOf(entry.dir);
      expect(m.id).toBe(entry.id);
      expect(entry.bbox).toEqual(m.bbox);
      expect([...entry.routeIds].sort()).toEqual(m.routes.map((r) => r.id).sort());
    }
  });

  it('draws both Perugia scenic routes in the Perugia world', () => {
    expect(worldForRoute(scenic('scenic-perugia-tiber-park'))?.id).toBe('perugia');
    expect(worldForRoute(scenic('scenic-assisi-valley'))?.id).toBe('perugia');
  });

  it('takes any route that lies inside a world, e.g. a GPX upload around Perugia', () => {
    expect(worldForRoute(line('gpx-1', [[43.11, 12.39], [43.12, 12.41], [43.1, 12.45]]))?.id).toBe('perugia');
  });

  it('declines routes that leave the world, live GPS routes and empty routes', () => {
    expect(worldForRoute(line('trasimeno', [[43.11, 12.39], [43.13, 12.1]]))).toBeNull();
    expect(worldForRoute(line('lugano', [[46.0, 8.95], [46.01, 8.96]]))).toBeNull();
    expect(worldForRoute({ ...line('gps', [[43.11, 12.39], [43.12, 12.4]]), isLive: true })).toBeNull();
    expect(worldForRoute(line('one', [[43.11, 12.39]]))).toBeNull();
    expect(worldForRoute(null)).toBeNull();
  });

  it('resolves bundle URLs under the app base', () => {
    expect(worldsBaseUrl().endsWith('/worlds/')).toBe(true);
    expect(worldUrl(WORLD_CATALOG[0])).toMatch(/\/worlds\/perugia\/$/);
  });
});
