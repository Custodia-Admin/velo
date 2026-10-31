/**
 * Acceptance checks on the shipped Perugia bundle (public/worlds/perugia),
 * loaded through the real loader from disk. Re-bake with
 * `node tools/worldbake/bake.mjs perugia` on the bake host if these fail.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadWorld, type LoadedWorld } from './loadWorld';
import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { sampleRouteAtDistance } from '@/lib/gpxParser';

const DIR = fileURLToPath(new URL('../../../public/worlds/perugia', import.meta.url));

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

describe('Perugia world bundle', () => {
  let world: LoadedWorld;
  beforeAll(async () => {
    world = await loadWorld('/worlds/perugia/', { fetch: diskFetch });
  });

  it('verifies every file hash and fits the 8 MB budget as shipped', () => {
    const shipped = readdirSync(DIR).reduce((a, f) => a + statSync(join(DIR, f)).size, 0);
    expect(shipped).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(world.manifest.files.map((f) => f.path).sort()).toEqual(readdirSync(DIR).filter((f) => f !== 'manifest.json').sort());
    expect(world.heightfield.spec.cols).toBeLessThanOrEqual(2048);
    expect(world.heightfield.spec.rows).toBeLessThanOrEqual(2048);
  });

  it('covers Perugia with plausible terrain heights', () => {
    const [x, y] = world.projection.forward(43.1122, 12.3888); // Piazza IV Novembre
    expect(world.heightfield.sampleHeight(x, y)).toBeGreaterThan(420);
    expect(world.heightfield.sampleHeight(x, y)).toBeLessThan(520);
    const [tx, ty] = world.projection.forward(43.0826, 12.4458); // Tiber at Ponte San Giovanni
    expect(world.heightfield.sampleHeight(tx, ty)).toBeLessThan(220);
    expect(world.manifest.pois.some((p) => p.name === 'Perugia' && p.kind === 'town')).toBe(true);
    expect(world.roads.roads.length).toBeGreaterThan(10000);
    expect(world.buildings.count).toBeGreaterThan(10000);
    expect(world.vegetation.count).toBeGreaterThan(10000);
  });

  it('ships every Perugia scenic route inside the world', () => {
    expect(world.routes.map((r) => r.id).sort()).toEqual(['scenic-assisi-valley', 'scenic-perugia-tiber-park']);
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
      expect(meanAbs, r.id).toBeLessThanOrEqual(1);
      expect(Math.abs(meanAbs - (world.manifest.routes.find((m) => m.id === r.id)?.gradeMeanAbsDiffPct ?? NaN))).toBeLessThan(0.01);
    }
  });
});
