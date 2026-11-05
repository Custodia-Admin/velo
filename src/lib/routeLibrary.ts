import type { Route, SavedRoute } from '@/types';
import { getDb, ROUTES_STORE } from '@/lib/db';

// All three persistence modules share one 'globeride' IDB opened by
// @/lib/db at a single version — see that file for why this can't be local.
const STORE = ROUTES_STORE;

/** Format a coordinate pair as "46.59°N, 7.91°E" for display. */
function formatLocation(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}°${ns}, ${Math.abs(lon).toFixed(2)}°${ew}`;
}

/** Build a SavedRoute envelope from a Route (adds savedAt + derived location). */
export function toSavedRoute(route: Route, source: SavedRoute['source'] = 'gpx'): SavedRoute {
  const first = route.points[0];
  return {
    ...route,
    savedAt: Date.now(),
    location: formatLocation(first.lat, first.lon),
    source,
  };
}

/** Persist a route to the library. Overwrites any existing entry with the same id. */
export async function saveRoute(route: Route, source: SavedRoute['source'] = 'gpx'): Promise<SavedRoute> {
  const db = await getDb();
  const saved = toSavedRoute(route, source);
  await db.put(STORE, saved);
  return saved;
}

/** List every saved route, newest first. */
export async function listRoutes(): Promise<SavedRoute[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex(STORE, 'by-savedAt');
  return all.reverse();
}

/** Check whether a route id already exists in the library. */
export async function hasRoute(id: string): Promise<boolean> {
  const db = await getDb();
  const key = await db.getKey(STORE, id);
  return key !== undefined;
}

/** Total number of saved routes — cheap, uses the store's key count. */
export async function countRoutes(): Promise<number> {
  const db = await getDb();
  return db.count(STORE);
}
