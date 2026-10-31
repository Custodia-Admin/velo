/**
 * routeSurface.test.ts — Unit tests for helper functions in routeSurface.ts.
 *
 * The pure helpers accept plain data and return plain data; the
 * createRoadEntity tests use a thin viewer mock and real Cesium data classes.
 * No WebGL context is required for any of them.
 */

import { describe, it, expect } from 'vitest';
import * as Cesium from 'cesium';
import {
  closestRouteIndex,
  kmMarkDistances,
  climbCategory,
  routeExtentMeters,
  createRoadEntity,
} from './routeSurface';
import { AsphaltMaterialProperty } from './asphaltMaterial';
import type { Route } from '@/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoute(
  points: Array<{ distance: number; ele: number; lat?: number; lon?: number }>,
): Route {
  const pts = points.map((p, i) => ({
    lat: p.lat ?? 0,
    lon: p.lon ?? i * 0.001,
    ele: p.ele,
    distance: p.distance,
  }));
  return {
    id: 'test',
    name: 'Test route',
    totalDistance: pts[pts.length - 1]?.distance ?? 0,
    ascent: 0,
    descent: 0,
    minElevation: 0,
    maxElevation: 100,
    loadedAt: 0,
    points: pts,
  } as Route;
}

// ---------------------------------------------------------------------------
// closestRouteIndex
// ---------------------------------------------------------------------------

describe('closestRouteIndex', () => {
  const route = makeRoute([
    { distance: 0, ele: 0 },
    { distance: 500, ele: 10 },
    { distance: 1000, ele: 20 },
    { distance: 2000, ele: 40 },
  ]);

  it('returns 0 when target distance is before the first point', () => {
    expect(closestRouteIndex(route.points, -10)).toBe(0);
  });

  it('returns last index when target is beyond the route', () => {
    expect(closestRouteIndex(route.points, 99999)).toBe(route.points.length - 1);
  });

  it('finds the exact point at distance 500', () => {
    expect(closestRouteIndex(route.points, 500)).toBe(1);
  });

  it('finds the nearest point when distance is between two points', () => {
    // 750 is halfway between index 1 (500) and index 2 (1000); both equidistant,
    // binary search returns the lower bound.
    const idx = closestRouteIndex(route.points, 750);
    expect(idx).toBeGreaterThanOrEqual(1);
    expect(idx).toBeLessThanOrEqual(2);
  });

  it('handles an empty points array gracefully', () => {
    expect(closestRouteIndex([], 500)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// kmMarkDistances
// ---------------------------------------------------------------------------

describe('kmMarkDistances', () => {
  it('returns 0.5 km steps for routes shorter than 5 km', () => {
    const marks = kmMarkDistances(4000); // 4 km
    expect(marks[0]).toBe(500);
    expect(marks[1]).toBe(1000);
    // All gaps should be 500 m
    for (let i = 1; i < marks.length; i++) {
      expect(marks[i] - marks[i - 1]).toBeCloseTo(500);
    }
  });

  it('returns 1 km steps for routes ≥ 5 km', () => {
    const marks = kmMarkDistances(10_000); // 10 km
    expect(marks[0]).toBe(1000);
    expect(marks[1]).toBe(2000);
    for (let i = 1; i < marks.length; i++) {
      expect(marks[i] - marks[i - 1]).toBeCloseTo(1000);
    }
  });

  it('does not include a mark at or beyond the finish', () => {
    const marks = kmMarkDistances(5000); // exactly 5 km
    // Last mark should be < 5000 - 150 m threshold
    for (const m of marks) {
      expect(m).toBeLessThan(5000 - 100);
    }
  });

  it('returns an empty array for a zero-length route', () => {
    expect(kmMarkDistances(0)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// climbCategory
// ---------------------------------------------------------------------------

describe('climbCategory', () => {
  it('returns HC for a long steep climb', () => {
    // 10 km at 10% → score = 100_000 > 80_000
    expect(climbCategory(10, 10_000)).toBe('HC');
  });

  it('returns Cat 1 for a score between 64k and 80k', () => {
    // 8 km at 9% → score = 72_000
    expect(climbCategory(9, 8_000)).toBe('Cat 1');
  });

  it('returns Cat 4 for a short mild climb', () => {
    // 1 km at 4% → score = 4_000 < 16_000
    expect(climbCategory(4, 1_000)).toBe('Cat 4');
  });

  it('returns Cat 3 for a moderate climb', () => {
    // 2 km at 9% → score = 18_000
    expect(climbCategory(9, 2_000)).toBe('Cat 3');
  });
});

// ---------------------------------------------------------------------------
// routeExtentMeters
// ---------------------------------------------------------------------------

describe('routeExtentMeters', () => {
  it('returns ≥1 m spans for an empty route', () => {
    const route = { points: [] } as unknown as Route;
    const ext = routeExtentMeters(route);
    expect(ext.eastMeters).toBeGreaterThanOrEqual(1);
    expect(ext.northMeters).toBeGreaterThanOrEqual(1);
  });

  it('measures east–west and north–south spans of the bounding box', () => {
    // ~0.01° lon and ~0.01° lat near 46°N.
    const route = makeRoute([
      { distance: 0, ele: 0, lat: 46.0, lon: 8.0 },
      { distance: 500, ele: 10, lat: 46.01, lon: 8.01 },
    ]);
    const ext = routeExtentMeters(route);
    // 0.01° latitude ≈ 1105 m; 0.01° longitude at 46°N ≈ 770 m.
    expect(ext.northMeters).toBeGreaterThan(1000);
    expect(ext.northMeters).toBeLessThan(1200);
    expect(ext.eastMeters).toBeGreaterThan(650);
    expect(ext.eastMeters).toBeLessThan(900);
  });

  it('clamps a single-point route to ≥1 m', () => {
    const route = makeRoute([{ distance: 0, ele: 0, lat: 46.0, lon: 8.0 }]);
    const ext = routeExtentMeters(route);
    expect(ext.eastMeters).toBeGreaterThanOrEqual(1);
    expect(ext.northMeters).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// createRoadEntity — material must be a MaterialProperty, not a raw Material
// ---------------------------------------------------------------------------

/**
 * Minimal EntityCollection stand-in.  `createRoadEntity` only calls
 * `entities.add(options)`, `entities.remove(entity)` and `viewer.isDestroyed()`,
 * so a thin mock keeps the test free of a WebGL context while still
 * constructing real Cesium.Entity/CorridorGraphics objects (which is where the
 * material-type validation happens).
 */
function makeMockViewer() {
  const entities: Cesium.Entity[] = [];
  const viewer = {
    entities: {
      add(options: Cesium.Entity.ConstructorOptions): Cesium.Entity {
        const e = new Cesium.Entity(options);
        entities.push(e);
        return e;
      },
      remove(entity: Cesium.Entity): boolean {
        const i = entities.indexOf(entity);
        if (i >= 0) entities.splice(i, 1);
        return i >= 0;
      },
    },
    isDestroyed: () => false,
  } as unknown as Cesium.Viewer;
  return { viewer, entities };
}

describe('createRoadEntity', () => {
  const route = makeRoute([
    { distance: 0, ele: 200, lat: 46.0, lon: 8.0 },
    { distance: 1000, ele: 240, lat: 46.005, lon: 8.008 },
    { distance: 2000, ele: 260, lat: 46.012, lon: 8.002 },
  ]);
  const cartesians = route.points.map((p) =>
    Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.ele),
  );

  it('assigns an AsphaltMaterialProperty to the corridor (no raw Material crash)', () => {
    const { viewer } = makeMockViewer();
    // Constructing the entity must not throw "Unable to infer material type".
    const handle = createRoadEntity(viewer, route, cartesians);
    expect(handle.entity.corridor?.material).toBeInstanceOf(AsphaltMaterialProperty);
  });

  it('creates a corridor and a dashed centre-line polyline', () => {
    const { viewer } = makeMockViewer();
    const handle = createRoadEntity(viewer, route, cartesians);
    expect(handle.entity.corridor).toBeDefined();
    expect(handle.centerline.polyline).toBeDefined();
    expect(handle.centerline.polyline?.clampToGround).toBeDefined();
  });

  it('destroy() removes both entities', () => {
    const { viewer, entities } = makeMockViewer();
    const handle = createRoadEntity(viewer, route, cartesians);
    expect(entities).toHaveLength(2);
    handle.destroy();
    expect(entities).toHaveLength(0);
  });
});
