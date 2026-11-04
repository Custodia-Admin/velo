/**
 * Acceptance checks on the shipped Lugano bundle (public/worlds/lugano),
 * loaded through the real loader from disk. Re-bake with
 * `node tools/worldbake/bake.mjs lugano` on the bake host if these fail
 * (docs/worlds/WORLD-FORMAT.md, "Baking").
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadWorld, type LoadedWorld } from './loadWorld';
import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { sampleRouteAtDistance } from '@/lib/gpxParser';

const DIR = fileURLToPath(new URL('../../../public/worlds/lugano', import.meta.url));
const REPORT = fileURLToPath(new URL('../../../tools/worldbake/reports/lugano.json', import.meta.url));

/**
 * Routes whose geometry still has a retraced out-and-back stub (the same road
 * ridden twice with two different profiles), so the corridor cannot follow
 * both passes: Lugano–Melide rides ~1.6 km up and back down the same street
 * at 1.9–3.5 km. The route generator fix (card t_9dd599d7) removes it; after
 * that lands, re-bake Lugano and drop the entry.
 */
const RETRACED_STUB_GRADE_PCT: Record<string, number> = { 'scenic-lugano-melide': 1.2 };

const diskFetch = async (url: string) => {
  try {
    return new Response(readFileSync(join(DIR, url.replace(/^.*\//, ''))), { status: 200 });
  } catch {
    return new Response(null, { status: 404 });
  }
};

/** Centred ±100 m grade, percent — same window as tools/worldbake/snapRoutes.mjs. */
function grade(s: ArrayLike<number>, h: ArrayLike<number>, i: number, half: number) {
  const a = Math.max(0, i - half);
  const b = Math.min(s.length - 1, i + half);
  return ((h[b] - h[a]) / (s[b] - s[a])) * 100;
}

describe('Lugano world bundle', () => {
  let world: LoadedWorld;
  beforeAll(async () => {
    world = await loadWorld('/worlds/lugano/', { fetch: diskFetch });
  });

  it('verifies every file hash, fits 8 MB brotli and the 2048² grid cap', () => {
    const report = JSON.parse(readFileSync(REPORT, 'utf8')) as {
      totals: { brotli: number };
      hashes: Record<string, string>;
    };
    expect(report.totals.brotli).toBeLessThanOrEqual(8_000_000);
    for (const f of world.manifest.files) expect(report.hashes[f.path], f.path).toBe(f.sha256);
    expect(world.manifest.files.map((f) => f.path).sort()).toEqual(readdirSync(DIR).filter((f) => f !== 'manifest.json').sort());
    expect(world.heightfield.spec.cols).toBeLessThanOrEqual(2048);
    expect(world.heightfield.spec.rows).toBeLessThanOrEqual(2048);
  });

  it('covers Lugano and Locarno with plausible terrain and lakes', () => {
    const at = (lat: number, lon: number) => world.heightfield.sampleHeight(...world.projection.forward(lat, lon));
    expect(at(46.0047, 8.9512)).toBeGreaterThan(268); // Piazza della Riforma, Lugano
    expect(at(46.0047, 8.9512)).toBeLessThan(300);
    expect(Math.abs(at(45.99, 8.965) - 271)).toBeLessThan(4); // Lake Lugano
    expect(Math.abs(at(46.14, 8.77) - 193)).toBeLessThan(5); // Lago Maggiore
    expect(at(46.1035, 8.8661)).toBeGreaterThan(1500); // Monte Tamaro
    expect(world.manifest.pois.some((p) => p.name === 'Lugano' && p.kind === 'town')).toBe(true);
    expect(world.manifest.pois.some((p) => p.name === 'Locarno' && p.kind === 'town')).toBe(true);
    expect(world.water.areas.length).toBeGreaterThan(10);
    expect(world.roads.roads.length).toBeGreaterThan(10000);
    expect(world.buildings.count).toBeGreaterThan(10000);
    expect(world.vegetation.count).toBeGreaterThan(10000);
  });

  it('ships Lugano–Melide and Locarno–Brissago inside the world', () => {
    expect(world.routes.map((r) => r.id).sort()).toEqual(['scenic-locarno-brissago', 'scenic-lugano-melide']);
  });

  it('puts each route exactly on the ground: max vertical gap 0', () => {
    for (const r of world.routes) {
      let maxGap = 0;
      for (let i = 0; i < r.h.length; i++) {
        maxGap = Math.max(maxGap, Math.abs(r.h[i] - world.heightfield.sampleHeight(r.x[i], r.y[i])));
      }
      expect(maxGap, r.id).toBe(0);
      expect(world.manifest.routes.find((m) => m.id === r.id)?.maxGapM).toBe(0);
    }
  });

  it('follows the app route geometry and distance scale', () => {
    for (const r of world.routes) {
      const app = routeFromGeometry(r.id, r.name, SCENIC_ROUTE_GEOMETRY[r.id]);
      expect(Math.abs(app.totalDistance - r.lengthM), r.id).toBeLessThan(0.01);
      for (let i = 0; i < r.s.length; i += 37) {
        const p = sampleRouteAtDistance(app, r.s[i]);
        const [x, y] = world.projection.forward(p.lat, p.lon);
        expect(Math.hypot(x - r.x[i], y - r.y[i]), `${r.id} @ ${r.s[i]}`).toBeLessThan(0.05);
      }
    }
  });

  it("keeps the rendered grade within 1 % (mean abs) of the route's FTMS profile", () => {
    for (const r of world.routes) {
      const app = routeFromGeometry(r.id, r.name, SCENIC_ROUTE_GEOMETRY[r.id]);
      const profile = Array.from(r.s, (s) => sampleRouteAtDistance(app, s).ele);
      const half = Math.round(100 / r.stepM);
      let sum = 0;
      for (let i = 0; i < r.s.length; i++) sum += Math.abs(grade(r.s, r.h, i, half) - grade(r.s, profile, i, half));
      const meanAbs = sum / r.s.length;
      expect(meanAbs, r.id).toBeLessThanOrEqual(RETRACED_STUB_GRADE_PCT[r.id] ?? 1);
      expect(Math.abs(meanAbs - (world.manifest.routes.find((m) => m.id === r.id)?.gradeMeanAbsDiffPct ?? NaN))).toBeLessThan(0.01);
    }
  });
});
