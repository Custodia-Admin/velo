/**
 * Every route a shipped world draws stays on its drawn roads and off open
 * water (routeSurface.ts). Locarno–Brissago once rode 3.6 km across Lago
 * Maggiore on a boat line; this is the test that catches that at bake time.
 * Fixing a failure means moving a waypoint in scripts/build-scenic-routes.mjs
 * onto the road and re-baking the world, never loosening the bounds.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadWorld, type RoadsLayer, type WaterLayer, type WorldRoute } from './loadWorld';
import { longestRun, routeSurfaces } from './routeSurface';

/** Longest stretch a route may run over water off every drawn road, metres. */
const MAX_ON_WATER_M = 150;
/** Longest stretch a route may run more than 12 m from every drawn road (tunnels excepted), metres. */
const MAX_OFF_ROAD_M = 200;

const WORLDS = fileURLToPath(new URL('../../../public/worlds', import.meta.url));
const SHIPPED = readdirSync(WORLDS).filter((d) => existsSync(join(WORLDS, d, 'manifest.json')));

const FLAGS = { bridge: 1, tunnel: 2, unpaved: 4, oneway: 8 };

function roadsOf(...roads: { points: number[]; flags?: number; cls?: number }[]): RoadsLayer {
  return {
    classes: ['primary', 'steps'],
    flags: FLAGS,
    roads: roads.map((r) => ({ cls: r.cls ?? 0, width: 6, flags: r.flags ?? 0, points: Float32Array.from(r.points) })),
  };
}

/** A straight route along y = 0 from x0 to x1, sampled every 10 m. */
function routeAlongX(x0: number, x1: number): WorldRoute {
  const n = Math.round((x1 - x0) / 10) + 1;
  const s = Float64Array.from({ length: n }, (_, i) => i * 10);
  return {
    id: 'test',
    name: 'Test',
    lengthM: x1 - x0,
    stepM: 10,
    s,
    x: Float64Array.from(s, (d) => x0 + d),
    y: new Float64Array(n),
    h: new Float64Array(n),
  };
}

/** A square lake from x = a to x = b, straddling y = 0. */
const lake = (a: number, b: number): WaterLayer => ({
  areas: [{ kind: 'lake', rings: [Float32Array.from([a, -500, b, -500, b, 500, a, 500])] }],
  lines: [],
});

describe('routeSurfaces', () => {
  it('flags a route that leaves the shore road and crosses the lake', () => {
    // Road to the shore at x = 1000 and on from the far shore at x = 3000; nothing between.
    const roads = roadsOf({ points: [0, 0, 1000, 0] }, { points: [3000, 0, 4000, 0] });
    const [r] = routeSurfaces([routeAlongX(0, 4000)], roads, lake(1000, 3000));
    expect(longestRun(r.onWater)).toBeGreaterThan(1900);
    expect(longestRun(r.offRoad)).toBeGreaterThan(1900);
    expect(r.onWater[0].fromM).toBeGreaterThan(1000);
    expect(r.onWater[0].toM).toBeLessThan(3000);
  });

  it('lets a bridge or causeway carry the route over water', () => {
    const roads = roadsOf({ points: [0, 0, 1000, 0] }, { points: [1000, 0, 3000, 0], flags: FLAGS.bridge }, { points: [3000, 0, 4000, 0] });
    const [r] = routeSurfaces([routeAlongX(0, 4000)], roads, lake(1000, 3000));
    expect(r.onWater).toEqual([]);
    expect(r.offRoad).toEqual([]);
  });

  it('counts a tunnel as on the road but not steps', () => {
    const tunnel = roadsOf({ points: [0, 0, 1000, 0] }, { points: [1000, 0, 2000, 0], flags: FLAGS.tunnel });
    expect(routeSurfaces([routeAlongX(0, 2000)], tunnel, lake(5000, 6000))[0].offRoad).toEqual([]);
    const steps = roadsOf({ points: [0, 0, 1000, 0] }, { points: [1000, 0, 2000, 0], cls: 1 });
    expect(longestRun(routeSurfaces([routeAlongX(0, 2000)], steps, lake(5000, 6000))[0].offRoad)).toBeGreaterThan(900);
  });

  it('allows the 12 m of slack a simplified route line has beside its road', () => {
    const roads = roadsOf({ points: [0, 11, 2000, 11] });
    expect(routeSurfaces([routeAlongX(0, 2000)], roads, lake(500, 600))[0].offRoad).toEqual([]);
    const far = roadsOf({ points: [0, 13, 2000, 13] });
    expect(longestRun(routeSurfaces([routeAlongX(0, 2000)], far, lake(5000, 6000))[0].offRoad)).toBe(2010);
  });
});

describe.each(SHIPPED)('shipped world %s: routes ride its roads, never the lake', (id) => {
  const dir = join(WORLDS, id);
  const diskFetch = async (url: string) => {
    try {
      return new Response(readFileSync(join(dir, url.replace(/^.*\//, ''))), { status: 200 });
    } catch {
      return new Response(null, { status: 404 });
    }
  };

  it('has no route on open water or off its drawn roads', async () => {
    const world = await loadWorld(`/worlds/${id}/`, { fetch: diskFetch });
    expect(world.routes.length).toBeGreaterThan(0);
    for (const r of routeSurfaces(world.routes, world.roads, world.water)) {
      const show = (runs: typeof r.offRoad) => runs.map((x) => `${Math.round(x.fromM)}–${Math.round(x.toM)} m`).join(', ');
      expect(longestRun(r.onWater), `${r.id} on water at ${show(r.onWater)}`).toBeLessThanOrEqual(MAX_ON_WATER_M);
      expect(longestRun(r.offRoad), `${r.id} off every drawn road at ${show(r.offRoad)}`).toBeLessThanOrEqual(MAX_OFF_ROAD_M);
    }
  }, 60_000);
});
