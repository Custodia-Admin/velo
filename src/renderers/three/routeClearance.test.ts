/**
 * Owner report (Assisi valley, 2 Nov): the route line ran through buildings
 * and up a wall. Regression on the shipped Perugia bundle, through the real
 * loader and the real route-line builder:
 *
 * - no baked building footprint comes closer to any route point (the app
 *   route densified to the line's 2 m vertices, and every baked 10 m
 *   sample) than the road it rides on is wide (half-width + 1 m, 3.5–6 m;
 *   6 m where no road is mapped), recomputed here from the roads layer;
 * - the drawn route line hugs the ground: at every vertex and segment
 *   midpoint, for both LODs of every quality tier, it sits on the drawn
 *   terrain triangles (never under them) and within a tight band of the
 *   heightfield the rider stands on;
 * - its depth bias can never pull it in front of a wall it is behind.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { loadWorld, type LoadedWorld } from '@/lib/world/loadWorld';
import {
  ROUTE_CLEAR_MARGIN_M,
  ROUTE_CLEAR_MAX_M,
  ROUTE_CLEAR_MIN_M,
  ROUTE_ROAD_SNAP_M,
} from '../../../tools/worldbake/buildVectors.mjs';
import { THREE_QUALITY } from './quality';
import { densify } from './roadRibbons';
import { ROUTE_LIFT_M, ROUTE_MAX_PULL_M, ROUTE_MAX_SEG_M, ROUTE_WIDTH_M, buildRouteChunks, routeLine } from './Roads';
import { lodHeightAt } from './terrainMesh';
import { createSceneWorld, type SceneWorld } from './worldScene';

const DIR = fileURLToPath(new URL('../../../public/worlds/perugia', import.meta.url));
const diskFetch = async (url: string) => {
  try {
    return new Response(readFileSync(join(DIR, url.replace(/^.*\//, ''))), { status: 200 });
  } catch {
    return new Response(null, { status: 404 });
  }
};

const ROUTES = ['scenic-perugia-tiber-park', 'scenic-assisi-valley'];

function pointSegDist(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

/** Signed-ish distance from a point to a footprint: −1 inside, else to its outline. */
function footprintDistance(x: number, y: number, ring: Float32Array | number[]) {
  let inside = false;
  let d = Infinity;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i];
    const yi = ring[2 * i + 1];
    const xj = ring[2 * j];
    const yj = ring[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    d = Math.min(d, pointSegDist(x, y, xj, yj, xi, yi));
  }
  return inside ? -1 : d;
}

describe('Perugia routes vs buildings and ground (route-line regression)', () => {
  let world: LoadedWorld;
  let sw: SceneWorld;
  /** Footprints bucketed on a 25 m grid by bbox. */
  let grid: Map<string, number[]>;
  let rings: Float32Array[];
  /** Drawn road segments [road, offset] per 25 m cell, each listed in every cell within ROUTE_ROAD_SNAP_M. */
  let roadGrid: Map<string, [number, number][]>;
  const CELL = 25;

  beforeAll(async () => {
    world = await loadWorld('/worlds/perugia/', { fetch: diskFetch, verifyHashes: false });
    sw = createSceneWorld(world);
    const b = world.buildings;
    rings = [];
    grid = new Map();
    for (let i = 0; i < b.count; i++) {
      const ring = b.xy.slice(b.start[i] * 2, b.start[i + 1] * 2);
      rings.push(ring);
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let k = 0; k < ring.length; k += 2) {
        x0 = Math.min(x0, ring[k]);
        x1 = Math.max(x1, ring[k]);
        y0 = Math.min(y0, ring[k + 1]);
        y1 = Math.max(y1, ring[k + 1]);
      }
      for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
        for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) {
          const key = `${gx},${gy}`;
          const list = grid.get(key);
          if (list) list.push(i);
          else grid.set(key, [i]);
        }
      }
    }
    roadGrid = new Map();
    world.roads.roads.forEach((r, ri) => {
      if (r.flags & world.roads.flags.tunnel) return;
      const p = r.points;
      for (let k = 0; k + 3 < p.length; k += 2) {
        const m = ROUTE_ROAD_SNAP_M;
        for (let gy = Math.floor((Math.min(p[k + 1], p[k + 3]) - m) / CELL); gy <= Math.floor((Math.max(p[k + 1], p[k + 3]) + m) / CELL); gy++) {
          for (let gx = Math.floor((Math.min(p[k], p[k + 2]) - m) / CELL); gx <= Math.floor((Math.max(p[k], p[k + 2]) + m) / CELL); gx++) {
            const key = `${gx},${gy}`;
            const list = roadGrid.get(key);
            if (list) list.push([ri, k]);
            else roadGrid.set(key, [[ri, k]]);
          }
        }
      }
    });
  }, 60_000);

  /** Nearest footprint distance from (x, y), looking ROUTE_CLEAR_MAX_M + 1 around. */
  const nearestFootprint = (x: number, y: number) => {
    let best = Infinity;
    const r = ROUTE_CLEAR_MAX_M + 1;
    for (let gy = Math.floor((y - r) / CELL); gy <= Math.floor((y + r) / CELL); gy++) {
      for (let gx = Math.floor((x - r) / CELL); gx <= Math.floor((x + r) / CELL); gx++) {
        for (const i of grid.get(`${gx},${gy}`) ?? []) best = Math.min(best, footprintDistance(x, y, rings[i]));
      }
    }
    return best;
  };

  /** Clearance the road under (x, y) asks for: its half-width + margin, clamped; max when none is mapped. */
  const wantedClearance = (x: number, y: number) => {
    let best = Infinity;
    let hw = 0;
    for (const [ri, k] of roadGrid.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) ?? []) {
      const r = world.roads.roads[ri];
      const p = r.points;
      const d = pointSegDist(x, y, p[k], p[k + 1], p[k + 2], p[k + 3]);
      if (d < best || (d === best && r.width / 2 > hw)) {
        best = d;
        hw = r.width / 2;
      }
    }
    return best <= ROUTE_ROAD_SNAP_M ? Math.min(ROUTE_CLEAR_MAX_M, Math.max(ROUTE_CLEAR_MIN_M, hw + ROUTE_CLEAR_MARGIN_M)) : ROUTE_CLEAR_MAX_M;
  };

  it('the depth bias can never pull the line in front of a building it is behind', () => {
    expect(ROUTE_MAX_PULL_M + ROUTE_WIDTH_M / 2).toBeLessThan(ROUTE_CLEAR_MIN_M - 0.5);
  });

  for (const id of ROUTES) {
    it(`${id}: no building within its road's clearance (≥ ${ROUTE_CLEAR_MIN_M} m) of any route point`, () => {
      const route = routeFromGeometry(id, id, SCENIC_ROUTE_GEOMETRY[id]);
      const { xy } = densify(routeLine(sw, route, [1, 1, 1]).points, ROUTE_MAX_SEG_M);
      const n = xy.length / 2;
      expect(n).toBeGreaterThan(route.totalDistance / ROUTE_MAX_SEG_M);
      const dist = new Float64Array(n);
      for (let k = 0; k < n; k++) dist[k] = nearestFootprint(xy[k * 2], xy[k * 2 + 1]);
      let failures = 0;
      let worstMin = Infinity;
      for (let k = 0; k < n; k++) {
        worstMin = Math.min(worstMin, dist[k]);
        if (dist[k] >= ROUTE_CLEAR_MAX_M) continue;
        // The bake sets one clearance per 10 m piece from its midpoint's road, so
        // near a junction take the smallest any road within ±12 m asks for.
        let want = Infinity;
        for (let j = Math.max(0, k - 6); j <= Math.min(n - 1, k + 6); j++) want = Math.min(want, wantedClearance(xy[j * 2], xy[j * 2 + 1]));
        // Footprints are stored to 1 dm; the clearance was applied to those same rings.
        if (dist[k] < want - 0.05) failures++;
      }
      expect(failures, `route points closer to a building than their road's clearance (closest ${worstMin.toFixed(2)} m)`).toBe(0);
      expect(worstMin).toBeGreaterThanOrEqual(ROUTE_CLEAR_MIN_M - 0.05);
      const baked = world.routes.find((r) => r.id === id)!;
      for (let i = 0; i < baked.s.length; i++) expect(nearestFootprint(baked.x[i], baked.y[i])).toBeGreaterThanOrEqual(ROUTE_CLEAR_MIN_M - 0.05);
    });

    it(`${id}: the drawn line hugs the ground at both LODs of every tier`, () => {
      const route = routeFromGeometry(id, id, SCENIC_ROUTE_GEOMETRY[id]);
      const line = routeLine(sw, route, [1, 1, 1]);
      const hf = world.heightfield;
      for (const tier of ['low', 'medium', 'high'] as const) {
        const q = THREE_QUALITY[tier];
        const pieces = buildRouteChunks(sw, line, { near: q.nearStep, far: q.farStep });
        for (const [lod, step] of [
          ['near', q.nearStep],
          ['far', q.farStep],
        ] as const) {
          let below = 0;
          let worstVsDrawn = 0;
          let vertices = 0;
          let worstSag = 0;
          for (const p of pieces) {
            const chunk = sw.chunks[p.chunk];
            const data = p[lod];
            const pos = data.positions;
            const at = (v: number) => [pos[v * 3] + chunk.centerX, -(pos[v * 3 + 2] + chunk.centerZ), pos[v * 3 + 1]] as const;
            // Every vertex and every triangle's centroid: points the GPU really draws.
            for (let t = 0; t < data.indices.length; t += 3) {
              const pts = [at(data.indices[t]), at(data.indices[t + 1]), at(data.indices[t + 2])];
              const centroid = [0, 1, 2].map((k) => (pts[0][k] + pts[1][k] + pts[2][k]) / 3) as unknown as readonly [number, number, number];
              for (const [x, y, h] of [...pts, centroid]) {
                vertices++;
                // The triangles drawn there: those of the chunk under the point
                // (a vertex past the piece's own chunk lies over the next one).
                const surface = lodHeightAt(hf, sw.chunks[sw.locate(x, y)], step, x, y);
                // On the drawn triangles: a 2 m chord (or a mitred corner) across a
                // terrain fold sags under the lift by < 10 cm, i.e. at most ~5 cm under
                // the triangles, inside the line's 12 cm minimum depth pull.
                if (surface - (h - ROUTE_LIFT_M) > 0.1) below++;
                worstSag = Math.max(worstSag, surface - (h - ROUTE_LIFT_M));
                worstVsDrawn = Math.max(worstVsDrawn, Math.abs(h - ROUTE_LIFT_M - surface));
              }
            }
          }
          expect(vertices, `${tier} ${lod}`).toBeGreaterThan(route.totalDistance / ROUTE_MAX_SEG_M);
          expect(below, `${tier} ${lod}: points under the drawn terrain (worst sag ${worstSag.toFixed(3)} m)`).toBe(0);
          // One height source: the line lies on the drawn triangles, which is
          // also the ground the rider stands on (worldScene.drawnGround), give
          // or take a 2 m chord across a fold. Before the hotfix it followed
          // max(bilinear, triangles) while the rider rode the bilinear ground:
          // 0.51 m apart at an Assisi fold, 1.6 m at the low tier's 26 m step.
          expect(worstVsDrawn, `${tier} ${lod} worst |line − drawn ground|`).toBeLessThan(0.1);
        }
      }
    });
  }
});
