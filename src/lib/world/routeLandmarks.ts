/**
 * Named places along a route, from the world bundle's OSM points of interest
 * (manifest.pois): the ride HUD's "Ponte Valleceppi in 1.2 km" line.
 *
 * A POI counts when the road passes close to it: villages and towns within
 * a few hundred metres (the road runs through or beside them), single
 * features (a church, a tower, a viewpoint) only when the road goes right
 * past. Each one is pinned to the route distance of its nearest point.
 * Nothing is invented: no world bundle, no landmarks.
 *
 * Engine-free (src/lib/world rule): no Cesium, three.js or React.
 */

import type { RoutePoint } from '@/types';
import type { ProjectionParams } from './projection';
import { createProjection } from './projection';
import type { WorldPoi, WorldPoiKind } from './manifest';

export interface RouteLandmark {
  name: string;
  kind: WorldPoiKind;
  /** Distance along the route of the road's closest approach, metres. */
  distance: number;
  /** How far the POI is from the road there, metres. */
  offset: number;
}

/** Furthest a POI may sit from the road and still be "on the route", metres. */
export const MAX_OFFSET_M: Record<WorldPoiKind, number> = {
  town: 400,
  village: 400,
  landmark: 150,
  church: 150,
  viewpoint: 150,
  // Summits beside a valley road are scenery, not a place you ride to.
  peak: 0,
};

/** Two landmarks closer than this along the route are one stop: keep the nearer one. */
export const MERGE_M = 150;

export function routeLandmarks(
  points: readonly Pick<RoutePoint, 'lat' | 'lon' | 'distance'>[],
  world: { projection: ProjectionParams; pois: readonly WorldPoi[] },
): RouteLandmark[] {
  if (points.length < 2 || world.pois.length === 0) return [];
  const proj = createProjection(world.projection);
  const xy = points.map((p) => proj.forward(p.lat, p.lon));

  const found: RouteLandmark[] = [];
  for (const poi of world.pois) {
    const max = MAX_OFFSET_M[poi.kind] ?? 0;
    if (!(max > 0)) continue;
    let best = Infinity;
    let at = 0;
    for (let i = 0; i < xy.length - 1; i++) {
      const [ax, ay] = xy[i];
      const [bx, by] = xy[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.min(1, Math.max(0, ((poi.x - ax) * dx + (poi.y - ay) * dy) / len2)) : 0;
      const d = Math.hypot(ax + t * dx - poi.x, ay + t * dy - poi.y);
      if (d < best) {
        best = d;
        at = points[i].distance + t * (points[i + 1].distance - points[i].distance);
      }
    }
    if (best <= max) found.push({ name: poi.name, kind: poi.kind, distance: at, offset: best });
  }

  found.sort((a, b) => a.distance - b.distance);
  const out: RouteLandmark[] = [];
  for (const l of found) {
    const prev = out[out.length - 1];
    if (prev && (prev.name === l.name || l.distance - prev.distance < MERGE_M)) {
      if (l.offset < prev.offset) out[out.length - 1] = l;
      continue;
    }
    out.push(l);
  }
  return out;
}
