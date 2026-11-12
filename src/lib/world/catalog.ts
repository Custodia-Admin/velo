/**
 * The world bundles this build ships, and which routes each one can draw.
 *
 * The world renderer only draws a route that lies inside a baked world; any
 * other route (a GPX upload elsewhere, a destination ride without a world
 * yet, an outdoor GPS ride) falls back to the photoreal renderer. The list is
 * derived from the destination manifests (`destinations.ts`): every world a
 * destination links (its `world` and any `extraWorlds`) contributes one
 * entry, with the bbox and routes its manifest mirrors from the bundle
 * (destinations.test.ts keeps them in step), so deciding needs no download.
 *
 * Engine-free (src/lib/world rule): no Cesium, three.js or React.
 */

import type { Route } from '@/types';
import type { WorldBbox } from './manifest';
import { DESTINATIONS, destinationWorlds, type Destination } from './destinations';

export interface WorldCatalogEntry {
  id: string;
  name: string;
  /** Directory under the worlds base URL that holds manifest.json. */
  dir: string;
  /**
   * Published off-repo (`world.host: "remote"`): served from the remote
   * worlds base URL under a content-hashed dir, so its files never change and
   * the loader keeps them in the Cache API (offline after the first ride).
   */
  remote: boolean;
  /** Geographic bounds of the heightfield (manifest.bbox). */
  bbox: WorldBbox;
  /** Scenic routes snapped into the bundle (manifest.routes[].id). */
  routeIds: readonly string[];
}

/** One catalog entry per baked world a destination links (`world`, then `extraWorlds`). */
export function worldCatalogFrom(destinations: readonly Destination[]): WorldCatalogEntry[] {
  return destinations.flatMap((d) =>
    destinationWorlds(d).map((w) => ({ id: w.id, name: d.name, dir: w.dir, remote: w.host === 'remote', bbox: w.bbox, routeIds: w.routes })),
  );
}

export const WORLD_CATALOG: readonly WorldCatalogEntry[] = worldCatalogFrom(DESTINATIONS);

/** Keep this far inside the bbox edge so the chase camera has ground under it. */
const EDGE_MARGIN_DEG = 0.0025;

/**
 * The public R2 bucket (`velo-worlds`) the remote worlds are published to by
 * `tools/worldbake/publish.mjs`, as served by its r2.dev URL. Every key is
 * `worlds/<id>/<hash>/<file>`; nothing under a hash ever changes.
 */
export const DEFAULT_REMOTE_WORLDS_URL = 'https://pub-26367e714cf944b59b97a34ecb76922b.r2.dev/worlds/';

type Env = Record<string, string | undefined>;
const viteEnv = (): Env => (import.meta as { env?: Env }).env ?? {};
const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);

/**
 * Base URL of the world bundles shipped with the app: `VITE_WORLDS_BASE_URL`
 * when set, else `<app base>/worlds/`.
 */
export function worldsBaseUrl(env: Env = viteEnv()): string {
  const fromEnv = env.VITE_WORLDS_BASE_URL;
  if (fromEnv) return withSlash(fromEnv);
  return `${withSlash(env.BASE_URL ?? '/')}worlds/`;
}

/**
 * Base URL of the remote (off-repo) world bundles: `VITE_WORLDS_REMOTE_URL`
 * when set (another bucket, or a household server with the same
 * `<id>/<hash>/` layout), else the public R2 bucket.
 */
export function remoteWorldsBaseUrl(env: Env = viteEnv()): string {
  return withSlash(env.VITE_WORLDS_REMOTE_URL || DEFAULT_REMOTE_WORLDS_URL);
}

export function worldUrl(entry: Pick<WorldCatalogEntry, 'dir' | 'remote'>, env: Env = viteEnv()): string {
  return (entry.remote ? remoteWorldsBaseUrl(env) : worldsBaseUrl(env)) + entry.dir;
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
