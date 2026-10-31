import { describe, it, expect } from 'vitest';
import {
  SCENIC_AREAS,
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
import { HOME, HOMETOWN } from '@/lib/home';

const startKm = (r: (typeof SCENIC_ROUTES)[number], to: { lat: number; lon: number }) =>
  haversine(r.route.points[0].lat, r.route.points[0].lon, to.lat, to.lon) / 1000;

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

  it('has three easy rides near home in Perugia', () => {
    const near = SCENIC_ROUTES.filter((r) => r.area === 'near-home');
    expect(near.length).toBeGreaterThanOrEqual(3);
    expect(HOME.name).toBe('Perugia');
    // Each starts within an easy drive of home.
    for (const r of near) expect(startKm(r, HOME)).toBeLessThan(40);
  });

  it('keeps the Ticino and Lombardy rides as hometown', () => {
    const home = SCENIC_ROUTES.filter((r) => r.area === 'hometown');
    expect(home.length).toBeGreaterThanOrEqual(6);
    expect(home.some((r) => r.place.startsWith('Ticino'))).toBe(true);
    expect(home.some((r) => r.place.startsWith('Lombardy'))).toBe(true);
    for (const r of home) expect(startKm(r, HOMETOWN)).toBeLessThan(60);
    expect(scenicRouteById('scenic-lugano-melide')?.area).toBe('hometown');
  });

  it('has the travel wishlist routes', () => {
    const travels = SCENIC_ROUTES.filter((r) => r.area === 'travels').map((r) => r.route.id);
    expect(travels).toEqual(
      expect.arrayContaining([
        'scenic-chengdu-luxe-lakes',
        'scenic-hangzhou-west-lake',
        'scenic-cuyahoga-towpath',
        'scenic-cleveland-lakefront',
        'scenic-berkeley-bay-trail',
        'scenic-santa-monica-strand',
        'scenic-puerto-vallarta-malecon',
      ]),
    );
  });

  it('gives every route an area that has a home section', () => {
    const ids = SCENIC_AREAS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of SCENIC_ROUTES) expect(ids).toContain(r.area);
    for (const a of SCENIC_AREAS) {
      expect(SCENIC_ROUTES.some((r) => r.area === a.id)).toBe(true);
      expect(a.title.length).toBeGreaterThan(0);
      expect(a.detail.length).toBeGreaterThan(0);
    }
  });

  it.each(
    SCENIC_ROUTES.filter((r) => r.area === 'near-home' || r.area === 'travels').map(
      (r) => [r.route.id, r] as const,
    ),
  )('%s fits the comfort brief (8–25 km, ≤ 5 %)', (_id, info) => {
    const km = info.route.totalDistance / 1000;
    expect(km).toBeGreaterThanOrEqual(8);
    expect(km).toBeLessThanOrEqual(25);
    expect(info.maxGradePct).toBeLessThanOrEqual(5);
  });

  it('keeps descriptions to one sentence', () => {
    for (const r of SCENIC_ROUTES) {
      expect(r.description.trim().endsWith('.')).toBe(true);
      // "St. Moritz" is not a sentence break.
      expect(r.description.slice(0, -1).replace(/\bSt\. /g, 'St ')).not.toMatch(/[.!?]\s/);
    }
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

  it('random pick stays near home (Perugia) and lookups work', () => {
    for (const x of [0, 0.4, 0.999]) {
      const pick = randomScenicRoute(() => x);
      expect(pick.area).toBe('near-home');
      expect(startKm(pick, HOME)).toBeLessThan(40);
    }
    expect(scenicRouteById('scenic-lugano-melide')?.name).toContain('Lugano');
    expect(scenicRouteById('nope')).toBeUndefined();
  });
});
