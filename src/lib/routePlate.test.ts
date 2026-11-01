import { describe, expect, it } from 'vitest';
import { mapPlateGeometry, profileGeometry } from './routePlate';
import { SCENIC_ROUTES } from '@/lib/scenicRoutes';

const lugano = SCENIC_ROUTES.find((r) => r.route.id === 'scenic-lugano-melide')!.route;

describe('mapPlateGeometry', () => {
  it('frames the route at the plate aspect with a 1 km graticule', () => {
    const g = mapPlateGeometry(lugano, 3 / 2)!;
    const [, , w, h] = g.viewBox.split(' ').map(Number);
    expect(w / h).toBeCloseTo(1.5, 2);
    // Every route point lies inside the box.
    const [x0, y0] = g.viewBox.split(' ').map(Number);
    for (const p of g.points.split(' ')) {
      const [x, y] = p.split(',').map(Number);
      expect(x).toBeGreaterThanOrEqual(x0);
      expect(x).toBeLessThanOrEqual(x0 + w);
      expect(y).toBeGreaterThanOrEqual(y0);
      expect(y).toBeLessThanOrEqual(y0 + h);
    }
    // Lines every 1000 m: count ≈ box size in km.
    const vLines = (g.graticule.match(/ V/g) ?? []).length;
    expect(vLines).toBeGreaterThanOrEqual(Math.floor(w / 1000));
    expect(vLines).toBeLessThanOrEqual(Math.ceil(w / 1000) + 1);
  });

  it('puts north up (y grows south)', () => {
    const route = { points: [
      { lat: 46.0, lon: 9.0, ele: 0, distance: 0 },
      { lat: 46.01, lon: 9.0, ele: 0, distance: 1110 },
    ] } as Parameters<typeof mapPlateGeometry>[0];
    const g = mapPlateGeometry(route, 1)!;
    expect(g.end[1]).toBeLessThan(g.start[1]);
  });

  it('returns null for a route with fewer than two points', () => {
    expect(mapPlateGeometry({ points: [] }, 1)).toBeNull();
  });
});

describe('profileGeometry', () => {
  it('keeps a flat ride flat (at least 60 m of vertical range)', () => {
    const flat = { totalDistance: 1000, points: [
      { lat: 0, lon: 0, ele: 100, distance: 0 },
      { lat: 0, lon: 0, ele: 102, distance: 1000 },
    ] } as Parameters<typeof profileGeometry>[0];
    const g = profileGeometry(flat, { H: 40 })!;
    const ys = g.line.split(' ').map((p) => Number(p.split(',')[1]));
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(2);
  });

  it('marks where the rider is and fills the ridden part', () => {
    const g = profileGeometry(lugano, { at: 0.4 })!;
    expect(g.here!.x).toBeCloseTo(0.4);
    expect(g.here!.y).toBeGreaterThan(0);
    expect(g.here!.y).toBeLessThan(1);
    expect(g.done).toMatch(/Z$/);
    expect(profileGeometry(lugano)!.done).toBeUndefined();
  });
});
