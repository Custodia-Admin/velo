/**
 * The world bundles this build ships, and which routes each one can draw.
 *
 * The world renderer only draws a route that lies inside a baked world; any
 * other route (a GPX upload elsewhere, a destination ride without a world
 * yet, an outdoor GPS ride) falls back to the photoreal renderer. The bbox
 * mirrors the bundle's manifest (catalog.test.ts keeps them in step), so
 * deciding needs no download.
 *
 * Engine-free (src/lib/world rule): no Cesium, three.js or React.
 */

import type { Route } from '@/types';
import type { WorldBbox } from './manifest';

export interface WorldCatalogEntry {
  id: string;
  name: string;
  /** Directory under the worlds base URL that holds manifest.json. */
  dir: string;
  /** Geographic bounds of the heightfield (manifest.bbox). */
  bbox: WorldBbox;
  /** Scenic routes snapped into the bundle (manifest.routes[].id). */
  routeIds: readonly string[];
}

export const WORLD_CATALOG: readonly WorldCatalogEntry[] = [
  {
    id: 'perugia',
    name: 'Perugia',
    dir: 'perugia/',
    bbox: { south: 43.03391, west: 12.31702, north: 43.16021, east: 12.63672 },
    routeIds: ['scenic-perugia-tiber-park', 'scenic-assisi-valley'],
  },
];

/** Keep this far inside the bbox edge so the chase camera has ground under it. */
const EDGE_MARGIN_DEG = 0.0025;

/**
 * Base URL of the world bundles: `VITE_WORLDS_BASE_URL` (e.g. an R2 bucket)
 * when set, else `<app base>/worlds/`.
 */
export function worldsBaseUrl(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  const fromEnv = env.VITE_WORLDS_BASE_URL;
  if (fromEnv) return fromEnv.endsWith('/') ? fromEnv : `${fromEnv}/`;
  const base = env.BASE_URL ?? '/';
  return `${base.endsWith('/') ? base : `${base}/`}worlds/`;
}

export function worldUrl(entry: WorldCatalogEntry): string {
  return worldsBaseUrl() + entry.dir;
}

function inside(b: WorldBbox, lat: number, lon: number): boolean {
  return (
    lat >= b.south + EDGE_MARGIN_DEG &&
    lat <= b.north - EDGE_MARGIN_DEG &&
    lon >= b.west + EDGE_MARGIN_DEG &&
    lon <= b.east - EDGE_MARGIN_DEG
  );
}

/**
 * The world that can draw `route`: one that baked it by id, else one whose
 * bounds hold every route point. Null for live (outdoor GPS) routes, which
 * grow as you ride.
 */
export function worldForRoute(
  route: Pick<Route, 'id' | 'points' | 'isLive'> | null | undefined,
  catalog: readonly WorldCatalogEntry[] = WORLD_CATALOG,
): WorldCatalogEntry | null {
  if (!route || route.isLive || route.points.length < 2) return null;
  const byId = catalog.find((w) => w.routeIds.includes(route.id));
  if (byId) return byId;
  return catalog.find((w) => route.points.every((p) => inside(w.bbox, p.lat, p.lon))) ?? null;
}
