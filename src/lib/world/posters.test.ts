import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { postersFor, routesWithPosters } from './posters';
import { SCENIC_ROUTES } from '@/lib/scenicRoutes';
import { worldForRoute } from './catalog';

const PUBLIC = resolve(__dirname, '../../../public/posters');

describe('route posters', () => {
  it('every poster file ships under public/posters and stays small', () => {
    for (const { files } of routesWithPosters()) {
      for (const f of files) {
        const p = join(PUBLIC, f);
        expect(existsSync(p), f).toBe(true);
        expect(statSync(p).size, f).toBeLessThanOrEqual(350 * 1024);
      }
    }
  });

  it('only routes inside a baked world have posters', () => {
    for (const { routeId } of routesWithPosters()) {
      const info = SCENIC_ROUTES.find((r) => r.route.id === routeId);
      expect(info, routeId).toBeDefined();
      expect(worldForRoute(info!.route), routeId).not.toBeNull();
    }
  });

  it('falls back to the plate for the finish still and to null for unknown routes', () => {
    const assisi = postersFor('scenic-assisi-valley')!;
    expect(assisi.finish).toBe(assisi.plate);
    expect(assisi.plateNight).toBeUndefined();
    expect(postersFor('scenic-lugano-melide')).toBeNull();
    expect(postersFor(null)).toBeNull();
    expect(postersFor('scenic-perugia-tiber-park')!.plate).toMatch(/\/posters\/perugia\/home-hero-tiber\.jpg$/);
  });
});
