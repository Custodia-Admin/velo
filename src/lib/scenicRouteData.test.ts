import { describe, it, expect } from 'vitest';
import { SCENIC_ROUTE_GEOMETRY, type ScenicRouteGeometry } from '@/lib/scenicRouteData';
import { haversine } from '@/lib/utils';

/** Same measure as scripts/build-scenic-routes.mjs: steepest ~200 m window. */
function maxGrade(points: ScenicRouteGeometry['points']): number {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + haversine(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]));
  }
  let best = 0;
  let j = 0;
  for (let i = 0; i < points.length; i++) {
    while (j < points.length - 1 && cum[j] - cum[i] < 200) j++;
    const run = cum[j] - cum[i];
    if (run >= 150) best = Math.max(best, (Math.abs(points[j][2] - points[i][2]) / run) * 100);
  }
  return best;
}

function lineLength(points: ScenicRouteGeometry['points']): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    d += haversine(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
  }
  return d;
}

const entries = Object.entries(SCENIC_ROUTE_GEOMETRY);

describe('scenic route geometry', () => {
  it.each(entries)('%s has enough real points', (_id, g) => {
    expect(g.points.length).toBeGreaterThanOrEqual(20);
    for (const [lat, lon, ele] of g.points) {
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(lon)).toBeLessThanOrEqual(180);
      // Every route is near water or on a valley floor; nothing is underwater
      // or up a mountain pass.
      expect(ele).toBeGreaterThan(-20);
      expect(ele).toBeLessThan(2500);
    }
  });

  it.each(entries)('%s distance matches its points within 5 %', (_id, g) => {
    expect(Math.abs(lineLength(g.points) - g.distanceM) / g.distanceM).toBeLessThan(0.05);
  });

  it.each(entries)('%s max grade matches its points', (_id, g) => {
    // The header figure is measured on the 50 m resampled profile; the
    // shipped polyline is simplified, so allow a small tolerance.
    expect(Math.abs(maxGrade(g.points) - g.maxGradePct)).toBeLessThan(1.5);
  });

  it.each(entries)('%s has no jumps between points', (_id, g) => {
    for (let i = 1; i < g.points.length; i++) {
      const [la0, lo0] = g.points[i - 1];
      const [la1, lo1] = g.points[i];
      // Simplified segments can be long on a straight plain road (Magadino
      // has a 2.8 km one); a hop past 5 km would mean a broken route.
      expect(haversine(la0, lo0, la1, lo1)).toBeLessThan(5000);
    }
  });
});
