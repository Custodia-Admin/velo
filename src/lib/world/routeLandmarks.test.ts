import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scenicRouteById } from '@/lib/scenicRoutes';
import { validateManifest } from './manifest';
import { routeLandmarks, MAX_OFFSET_M, MERGE_M } from './routeLandmarks';
import type { WorldPoi } from './manifest';

const MANIFEST = validateManifest(
  JSON.parse(readFileSync(fileURLToPath(new URL('../../../public/worlds/perugia/manifest.json', import.meta.url)), 'utf8')),
);

function route(id: string) {
  const r = scenicRouteById(id)?.route;
  if (!r) throw new Error(`no route ${id}`);
  return r;
}

describe('routeLandmarks on the shipped Perugia world', () => {
  const tiber = routeLandmarks(route('scenic-perugia-tiber-park').points, MANIFEST);

  it('finds the villages the Tiber path runs through, in route order', () => {
    const names = tiber.map((l) => l.name);
    expect(names).toContain('Ponte Valleceppi');
    expect(names).toContain('Pretola');
    expect(names.indexOf('Ponte Valleceppi')).toBeLessThan(names.indexOf('Pretola'));
    const pv = tiber.find((l) => l.name === 'Ponte Valleceppi')!;
    // The bake's own snapped route puts the village's closest approach at ~6.6 km.
    expect(pv.distance).toBeGreaterThan(6300);
    expect(pv.distance).toBeLessThan(6900);
    for (let i = 1; i < tiber.length; i++) expect(tiber[i].distance).toBeGreaterThan(tiber[i - 1].distance);
  });

  it('keeps only places close to the road, one per stop', () => {
    for (const l of tiber) expect(l.offset).toBeLessThanOrEqual(MAX_OFFSET_M[l.kind]);
    for (let i = 1; i < tiber.length; i++) expect(tiber[i].distance - tiber[i - 1].distance).toBeGreaterThanOrEqual(MERGE_M);
    // A hamlet 900 m off the path is scenery, not a waypoint.
    expect(tiber.map((l) => l.name)).not.toContain('Collestrada');
    expect(tiber.some((l) => l.kind === 'peak')).toBe(false);
  });

  it('returns nothing without a world or a route', () => {
    expect(routeLandmarks([], MANIFEST)).toEqual([]);
    expect(routeLandmarks(route('scenic-perugia-tiber-park').points, { ...MANIFEST, pois: [] })).toEqual([]);
  });

  it('merges two POIs at one stop and keeps the nearer', () => {
    const pts = [
      { lat: MANIFEST.origin.lat, lon: MANIFEST.origin.lon, distance: 0 },
      { lat: MANIFEST.origin.lat + 0.01, lon: MANIFEST.origin.lon, distance: 1112 },
    ];
    const poi = (name: string, x: number, y: number): WorldPoi => ({ name, kind: 'church', x, y, h: 0, osm: 'node/1' });
    const out = routeLandmarks(pts, { projection: MANIFEST.projection, pois: [poi('Far', 120, 500), poi('Near', 20, 540)] });
    expect(out.map((l) => l.name)).toEqual(['Near']);
  });
});
