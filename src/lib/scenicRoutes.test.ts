import { describe, it, expect } from 'vitest';
import {
  SCENIC_ROUTES,
  characterFor,
  estimateEasyMinutes,
  randomScenicRoute,
  scenicRouteById,
  todaysScenicRoute,
} from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { ICONIC_ROUTES } from '@/lib/iconicRoutes';
import { MOODS } from '@/lib/cesiumUtils';
import { haversine } from '@/lib/utils';

describe('Easy & Scenic collection', () => {
  it('has unique ids that do not collide with the iconic catalogue', () => {
    const ids = SCENIC_ROUTES.map((r) => r.route.id);
    expect(new Set(ids).size).toBe(ids.length);
    const iconic = new Set(ICONIC_ROUTES.map((r) => r.route.id));
    for (const id of ids) expect(iconic.has(id)).toBe(false);
  });

  it('ships geometry for every route and nothing extra', () => {
    expect(Object.keys(SCENIC_ROUTE_GEOMETRY).sort()).toEqual(
      SCENIC_ROUTES.map((r) => r.route.id).sort(),
    );
  });

  it('includes at least four Ticino / Lombardy rides near home', () => {
    const near = SCENIC_ROUTES.filter((r) => r.area === 'near-home');
    expect(near.length).toBeGreaterThanOrEqual(4);
    expect(near.some((r) => r.place.startsWith('Ticino'))).toBe(true);
    expect(near.some((r) => r.place.startsWith('Lombardy'))).toBe(true);
  });

  it.each(SCENIC_ROUTES.map((r) => [r.route.id, r] as const))('%s is easy', (_id, info) => {
    const km = info.route.totalDistance / 1000;
    expect(km).toBeGreaterThan(5);
    expect(km).toBeLessThan(40);
    // Average climbing stays gentle: under 15 m per km.
    expect(info.route.ascent / km).toBeLessThan(15);
    // No real ramps: steepest 200 m under 7 %.
    expect(info.maxGradePct).toBeLessThan(7);
  });

  it.each(SCENIC_ROUTES.map((r) => [r.route.id, r] as const))('%s has a valid mood and dense points', (_id, info) => {
    expect(Object.keys(MOODS)).toContain(info.mood);
    const pts = info.route.points;
    expect(pts[0].distance).toBe(0);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i].distance).toBeGreaterThan(pts[i - 1].distance);
      expect(haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon)).toBeLessThanOrEqual(51);
    }
    expect(info.route.totalDistance).toBeCloseTo(pts[pts.length - 1].distance, 5);
  });

  it('classifies flat vs gentle', () => {
    expect(characterFor(10_000, 30, 2)).toBe('flat');
    expect(characterFor(10_000, 30, 6)).toBe('gentle');
    expect(characterFor(10_000, 120, 3)).toBe('gentle');
  });

  it('estimates easy ride time in 5-minute steps', () => {
    expect(estimateEasyMinutes(10_000, 'flat')).toBe(30);
    expect(estimateEasyMinutes(17_000, 'gentle')).toBe(60);
    expect(estimateEasyMinutes(100, 'flat')).toBe(5);
  });

  it("picks the same near-home 'today' route all day, and a different one tomorrow", () => {
    const a = todaysScenicRoute(new Date(2026, 9, 29, 7));
    const b = todaysScenicRoute(new Date(2026, 9, 29, 22));
    const c = todaysScenicRoute(new Date(2026, 9, 30, 7));
    expect(a.route.id).toBe(b.route.id);
    expect(a.area).toBe('near-home');
    expect(c.route.id).not.toBe(a.route.id);
  });

  it('random pick stays near home and lookups work', () => {
    expect(randomScenicRoute(() => 0.999).area).toBe('near-home');
    expect(scenicRouteById('scenic-lugano-melide')?.name).toContain('Lugano');
    expect(scenicRouteById('nope')).toBeUndefined();
  });
});
