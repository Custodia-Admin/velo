/**
 * Unit tests for the bake's pure helpers (tools/worldbake/*.mjs). The bake
 * itself runs on the bake host; these keep its geometry honest in CI.
 */
import { describe, expect, it } from 'vitest';
import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { createProjection } from './projection';
import { Heightfield } from './heightfield';
import { appRoutePoints, carveRoutes, finishRoutes } from '../../../tools/worldbake/snapRoutes.mjs';
import { clipLine, clipRing } from '../../../tools/worldbake/buildVectors.mjs';
import { quantize } from '../../../tools/worldbake/buildHeightfield.mjs';
import { tilesForBbox } from '../../../tools/worldbake/fetchDem.mjs';

describe('worldbake: snapRoutes', () => {
  it('replicates scenicRoutes.routeFromGeometry distances for every scenic route', () => {
    for (const [id, geom] of Object.entries(SCENIC_ROUTE_GEOMETRY)) {
      const app = routeFromGeometry(id, id, geom);
      const bake = appRoutePoints(geom.points);
      expect(bake.d.length, id).toBe(app.points.length);
      expect(bake.total, id).toBe(app.totalDistance);
      expect(bake.lat[17], id).toBe(app.points[17].lat);
    }
  });

  it('carves a corridor that follows the profile shape and leaves zero gap', () => {
    const proj = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 43, lon0: 12, k0: 1 });
    const grid = { cols: 121, rows: 61, cellSize: 10, xMin: -600, yMax: 300 };
    // Bumpy terrain: a 3 m ripple every 40 m on a gentle tilt.
    const heights = new Float64Array(grid.cols * grid.rows);
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) heights[r * grid.cols + c] = 200 + c * 0.05 + 3 * Math.sin(c * 1.6);
    }
    // A straight 800 m eastward route whose profile climbs 1 %.
    const [la0, lo0] = proj.inverse(-400, 0);
    const [la1, lo1] = proj.inverse(400, 0);
    const route = { id: 'r', name: 'R', points: [[la0, lo0, 100], [la1, lo1, 108]] };
    const snap = { stepM: 10, offsetMedianM: 200, offsetMeanM: 400, coreCells: 1.5, falloffM: 30 };
    const before = heights.slice();
    const carved = carveRoutes({ grid, heights, projection: proj, routes: [route], snap });
    expect(carved.carvedNodes).toBeGreaterThan(0);
    // Far from the route the terrain is untouched.
    expect(heights[0]).toBe(before[0]);

    const { q, heightOffset, heightScale } = quantize(heights);
    const hf = new Heightfield({ ...grid, heightOffset, heightScale }, q);
    const { routes, info } = finishRoutes({ prepared: carved.prepared, hf, snap });
    expect(info[0].maxGapM).toBe(0);
    for (let i = 0; i < routes[0].h.length; i++) expect(routes[0].h[i]).toBe(hf.sampleHeight(routes[0].x[i], routes[0].y[i]));
    // Raw terrain ripples ±3 m every 40 m; the carved road climbs smoothly with the 1 % profile.
    expect(info[0].report.rawDemGradeMeanAbsDiffPct).toBeGreaterThan(info[0].gradeMeanAbsDiffPct);
    expect(info[0].gradeMeanAbsDiffPct).toBeLessThan(0.5);
  });

  it('refuses a route that leaves the world', () => {
    const proj = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 43, lon0: 12, k0: 1 });
    const grid = { cols: 11, rows: 11, cellSize: 10, xMin: -50, yMax: 50 };
    const [la, lo] = proj.inverse(0, 0);
    const [la1, lo1] = proj.inverse(400, 0);
    expect(() =>
      carveRoutes({
        grid,
        heights: new Float64Array(121),
        projection: proj,
        routes: [{ id: 'far', name: 'Far', points: [[la, lo, 0], [la1, lo1, 0]] }],
        snap: { stepM: 10, offsetMedianM: 100, offsetMeanM: 100, coreCells: 1, falloffM: 5 },
      }),
    ).toThrow(/leaves the world/);
  });
});

describe('worldbake: vectors and tiles', () => {
  const ext = { xMin: 0, xMax: 100, yMin: 0, yMax: 100 };

  it('clips polylines to the extent, splitting where they leave', () => {
    expect(clipLine([-50, 50, 150, 50], ext)).toEqual([[0, 50, 100, 50]]);
    const pieces = clipLine([10, 10, 10, 200, 20, 200, 20, 10], ext);
    expect(pieces).toEqual([
      [10, 10, 10, 100],
      [20, 100, 20, 10],
    ]);
    expect(clipLine([200, 200, 300, 300], ext)).toEqual([]);
  });

  it('clips polygons to the extent', () => {
    const clipped = clipRing([-50, -50, 50, -50, 50, 50, -50, 50], ext);
    const xs = clipped.filter((_: number, i: number) => i % 2 === 0);
    const ys = clipped.filter((_: number, i: number) => i % 2 === 1);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(50);
    expect(Math.min(...ys)).toBe(0);
    expect(clipRing([200, 200, 300, 200, 300, 300], ext)).toEqual([]);
  });

  it('lists the terrarium tiles covering a bbox', () => {
    const { tiles } = tilesForBbox({ south: 43.03391, west: 12.31702, north: 43.16021, east: 12.63672 }, 13);
    // x = floor((lon+180)/360·2^13), y from the Web Mercator latitude of the north edge.
    expect(tiles[0]).toEqual({ z: 13, x: 4376, y: 3005 });
    expect(tiles.length).toBeGreaterThan(20);
  });
});
