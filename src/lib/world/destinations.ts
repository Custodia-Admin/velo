/**
 * Destinations: the places Home offers, one JSON manifest each.
 *
 * A destination is a place (Perugia, Lugano, Hangzhou…) with its scenic
 * routes, the 3D world that draws them (when one is baked), the moods that
 * suit it, its headline places and the data credits, all in one manifest:
 * `src/lib/world/destinations/<id>.json` (format `velo-destination`, spec in
 * docs/worlds/DESTINATIONS.md). Home is generated from these manifests;
 * components hold no lists of places or routes. Adding a place = adding a
 * manifest.
 *
 * For a destination with a baked world, the world-derived fields (`world`,
 * `moods`, `defaultMood`, `pois`, `credits`) are copied from the bundle's
 * manifest.json by `tools/worldbake/syncDestinations.mjs` (the bake runs it),
 * and destinations.test.ts fails when they drift. A destination without a
 * world (`world: null`) still shows its routes; they ride on the map
 * (photoreal renderer) until its world is baked.
 *
 * Engine-free and geometry-free (src/lib/world rule): no Cesium, three.js,
 * React or route geometry, so the ride shell can import the world catalog
 * derived from it without pulling the scenic route data along.
 */

import type { WorldBbox, WorldCredit, WorldPoiKind } from './manifest';

export const DESTINATION_FORMAT = 'velo-destination';
export const DESTINATION_FORMAT_VERSION = 1;

/**
 * Where a place sits on Home: `home` and `hometown` are the featured worlds
 * (one Home section each, home first), `wishlist` places share one
 * "Places we want to go" section. The public build titles a featured section
 * with the place name alone; a private deploy can show the roles as labels
 * ("Home · Perugia", "Hometown · Lugano") with VITE_HOUSEHOLD_LABELS=1.
 */
export type DestinationRole = 'home' | 'hometown' | 'wishlist';
export const DESTINATION_ROLES: readonly DestinationRole[] = ['home', 'hometown', 'wishlist'];

/**
 * Where a world bundle is served from. Absent: shipped with the app under
 * `public/worlds/<id>/`. `remote`: published off-repo, content-hashed, under
 * the remote worlds base URL (`VITE_WORLDS_REMOTE_URL`, a public R2 bucket by
 * default) at `<id>/<hash>/`, and kept in the Cache API after the first ride.
 */
export type DestinationWorldHost = 'remote';

/** `<id>/<hash>/`: hash = the first 16 hex digits of the bundle manifest's SHA-256. */
export const REMOTE_WORLD_DIR = /^([a-z0-9-]+)\/([0-9a-f]{16})\/$/;

/** The world bundle that draws a destination (mirrors its manifest.json). */
export interface DestinationWorld {
  /** World id: folder under the worlds base URL and `tools/worldbake/worlds/<id>.json`. */
  id: string;
  /** Directory under the worlds base URL that holds manifest.json: "lugano/", or "<id>/<hash>/" when remote. */
  dir: string;
  /** 'remote' for a world published off-repo; absent for one shipped in public/worlds. */
  host?: DestinationWorldHost;
  /** manifest.bbox: deciding whether a route is inside needs no download. */
  bbox: WorldBbox;
  /** manifest.routes[].id: the scenic routes snapped into the bundle. */
  routes: string[];
}

/** A headline place of the destination (towns, from the world's POIs). */
export interface DestinationPoi {
  name: string;
  kind: WorldPoiKind;
  lat: number;
  lon: number;
}

export interface Destination {
  id: string;
  /** Place name, e.g. "Lugano". Section title on Home, tile title in the wishlist. */
  name: string;
  role: DestinationRole;
  /** Order within its role (ascending). */
  order: number;
  /** Region and country, e.g. "Ticino, Switzerland". */
  place: string;
  /** One line beside the section title, e.g. "Ticino and the Lombardy lakes". */
  detail: string;
  /** The baked world, or null while the destination rides on the map. */
  world: DestinationWorld | null;
  /** Scenic route ids (src/lib/scenicRoutes.ts) in display order. */
  routes: string[];
  /** Scene moods that suit the place (the world's, or the routes' own). */
  moods: string[];
  defaultMood: string;
  pois: DestinationPoi[];
  /** Data sources to credit wherever the destination is shown. */
  credits: WorldCredit[];
}

export type DestinationErrorCode = 'invalid' | 'unsupported' | 'duplicate';

export class DestinationError extends Error {
  readonly code: DestinationErrorCode;
  readonly source: string | undefined;

  constructor(code: DestinationErrorCode, message: string, source?: string) {
    super(source ? `${source}: ${message}` : message);
    this.name = 'DestinationError';
    this.code = code;
    this.source = source;
  }
}

const POI_KINDS: readonly WorldPoiKind[] = ['town', 'village', 'peak', 'viewpoint', 'landmark', 'church'];
const ID = /^[a-z0-9-]+$/;

type Obj = Record<string, unknown>;

/** Validate one parsed manifest; throws DestinationError. */
export function validateDestination(json: unknown, source?: string): Destination {
  const fail = (msg: string): never => {
    throw new DestinationError('invalid', msg, source);
  };
  const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
  const str = (o: Obj, k: string): string => {
    const v = o[k];
    if (typeof v !== 'string' || v.trim() === '') fail(`${k} must be a non-empty string`);
    return v as string;
  };
  const num = (o: Obj, k: string): number => {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${k} must be a finite number`);
    return v as number;
  };
  const strings = (o: Obj, k: string, { nonEmpty = false } = {}): string[] => {
    const v = o[k];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x !== '')) fail(`${k} must be an array of strings`);
    const a = v as string[];
    if (nonEmpty && a.length === 0) fail(`${k} must not be empty`);
    if (new Set(a).size !== a.length) fail(`${k} has duplicates`);
    return a;
  };

  if (!isObj(json)) return fail('manifest must be an object');
  const m = json;
  if (m.format !== DESTINATION_FORMAT) fail(`format must be "${DESTINATION_FORMAT}"`);
  if (m.version !== DESTINATION_FORMAT_VERSION) {
    throw new DestinationError('unsupported', `version ${String(m.version)} is not supported`, source);
  }
  const id = str(m, 'id');
  if (!ID.test(id)) fail('id must match [a-z0-9-]+');
  const role = str(m, 'role') as DestinationRole;
  if (!DESTINATION_ROLES.includes(role)) fail(`role ${role} unknown`);
  const routes = strings(m, 'routes', { nonEmpty: true });
  const moods = strings(m, 'moods', { nonEmpty: true });
  const defaultMood = str(m, 'defaultMood');
  if (!moods.includes(defaultMood)) fail('defaultMood must be one of moods');

  let world: DestinationWorld | null = null;
  if (m.world !== null) {
    if (!isObj(m.world)) return fail('world must be an object or null');
    const w = m.world;
    const wid = str(w, 'id');
    if (!ID.test(wid)) fail('world.id must match [a-z0-9-]+');
    const dir = str(w, 'dir');
    const host = w.host;
    if (host !== undefined && host !== 'remote') fail('world.host must be "remote" or absent');
    if (host === 'remote') {
      if (REMOTE_WORLD_DIR.exec(dir)?.[1] !== wid) fail('a remote world.dir must be "<world.id>/<16 hex digit hash>/"');
    } else if (dir !== `${wid}/`) fail('world.dir must be "<world.id>/"');
    if (!isObj(w.bbox)) return fail('world.bbox must be an object');
    const b = w.bbox;
    const bbox: WorldBbox = { south: num(b, 'south'), west: num(b, 'west'), north: num(b, 'north'), east: num(b, 'east') };
    if (!(bbox.south < bbox.north && bbox.west < bbox.east)) fail('world.bbox is empty');
    const wroutes = strings(w, 'routes', { nonEmpty: true });
    for (const r of wroutes) if (!routes.includes(r)) fail(`world route ${r} is not in routes`);
    world = host === 'remote' ? { id: wid, dir, host, bbox, routes: wroutes } : { id: wid, dir, bbox, routes: wroutes };
  }

  const poisRaw = m.pois;
  if (!Array.isArray(poisRaw)) return fail('pois must be an array');
  const pois = poisRaw.map((p, i): DestinationPoi => {
    if (!isObj(p)) return fail(`pois[${i}] must be an object`);
    const kind = str(p, 'kind') as WorldPoiKind;
    if (!POI_KINDS.includes(kind)) fail(`pois[${i}].kind ${kind} unknown`);
    const lat = num(p, 'lat');
    const lon = num(p, 'lon');
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) fail(`pois[${i}] is off the globe`);
    return { name: str(p, 'name'), kind, lat, lon };
  });

  const creditsRaw = m.credits;
  if (!Array.isArray(creditsRaw) || creditsRaw.length === 0) return fail('credits must be a non-empty array');
  const credits = creditsRaw.map((c, i): WorldCredit => {
    if (!isObj(c)) return fail(`credits[${i}] must be an object`);
    return { id: str(c, 'id'), name: str(c, 'name'), licence: str(c, 'licence'), url: str(c, 'url'), attribution: str(c, 'attribution') };
  });

  return {
    id,
    name: str(m, 'name'),
    role,
    order: num(m, 'order'),
    place: str(m, 'place'),
    detail: str(m, 'detail'),
    world,
    routes,
    moods,
    defaultMood,
    pois,
    credits,
  };
}

/**
 * Validate a set of manifests (path → parsed JSON, e.g. from import.meta.glob)
 * and return them in Home order: role, then `order`, then id. Ids, world ids
 * and route ids must each be unique across the set, and a manifest's file
 * name must be its id.
 */
export function loadDestinations(modules: Record<string, unknown>): Destination[] {
  const out: Destination[] = [];
  const ids = new Set<string>();
  const worlds = new Set<string>();
  const routeOwner = new Map<string, string>();
  for (const path of Object.keys(modules).sort()) {
    const d = validateDestination(modules[path], path);
    const file = path.split('/').pop()?.replace(/\.json$/, '');
    if (file !== d.id) throw new DestinationError('invalid', `file name must be ${d.id}.json`, path);
    if (ids.has(d.id)) throw new DestinationError('duplicate', `destination ${d.id} defined twice`, path);
    ids.add(d.id);
    if (d.world) {
      if (worlds.has(d.world.id)) throw new DestinationError('duplicate', `world ${d.world.id} linked twice`, path);
      worlds.add(d.world.id);
    }
    for (const r of d.routes) {
      const owner = routeOwner.get(r);
      if (owner) throw new DestinationError('duplicate', `route ${r} already belongs to ${owner}`, path);
      routeOwner.set(r, d.id);
    }
    out.push(d);
  }
  const rank = (d: Destination) => DESTINATION_ROLES.indexOf(d.role);
  return out.sort((a, b) => rank(a) - rank(b) || a.order - b.order || a.id.localeCompare(b.id));
}

/** Every destination this build ships, in Home order. */
export const DESTINATIONS: readonly Destination[] = loadDestinations(
  import.meta.glob('./destinations/*.json', { eager: true, import: 'default' }),
);

export function destinationById(id: string, list: readonly Destination[] = DESTINATIONS): Destination | null {
  return list.find((d) => d.id === id) ?? null;
}

/** The destination a scenic route belongs to. */
export function destinationForRoute(
  routeId: string | null | undefined,
  list: readonly Destination[] = DESTINATIONS,
): Destination | null {
  if (!routeId) return null;
  return list.find((d) => d.routes.includes(routeId)) ?? null;
}

/** True when the destination's world draws this route (else it rides on the map). */
export function routeHasWorld(d: Destination, routeId: string): boolean {
  return d.world?.routes.includes(routeId) ?? false;
}

/** Labels a private deploy puts before a featured place's name (VITE_HOUSEHOLD_LABELS=1). */
const HOUSEHOLD_LABEL: Record<Exclude<DestinationRole, 'wishlist'>, string> = {
  home: 'Home',
  hometown: 'Hometown',
};
const WISHLIST_TITLE = 'Places we want to go';

/**
 * True when this build labels the featured worlds for a household
 * ("Home · Perugia"). Off unless the build sets VITE_HOUSEHOLD_LABELS to "1"
 * or "true": the public build and CI never do (ADR-002).
 */
export function householdLabels(env: { readonly VITE_HOUSEHOLD_LABELS?: string } = import.meta.env): boolean {
  const v = env.VITE_HOUSEHOLD_LABELS?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** One Home section, generated from the manifests. */
export interface DestinationSection {
  /** Stable id for anchors and tests: the destination id, or the role for the wishlist. */
  id: string;
  role: DestinationRole;
  /** "Perugia", "Lugano", "Places we want to go" ("Home · Perugia"… with household labels). */
  title: string;
  detail: string;
  /** One entry per route, in display order. */
  entries: { destination: Destination; routeId: string; hasWorld: boolean }[];
}

/**
 * The wishlist line. Which places still ride in the classic view is said on
 * their own tiles (the "Classic view" tag), so the line never repeats it.
 */
const WISHLIST_DETAIL = 'Lakes, coasts and cities on our list';

/**
 * Home's sections: one per home and hometown destination ("Perugia",
 * "Lugano"; "Home · Perugia", "Hometown · Lugano" with household labels),
 * then "Places we want to go" with every wishlist destination. Inside a
 * section, routes drawn by a 3D world come first (in the wishlist: the places
 * with a world, in manifest order, then the places that ride on the map, in
 * manifest order).
 */
export function homeSections(list: readonly Destination[] = DESTINATIONS, labels: boolean = householdLabels()): DestinationSection[] {
  type Entry = DestinationSection['entries'][number];
  const worldFirst = (all: Entry[]) => [...all.filter((e) => e.hasWorld), ...all.filter((e) => !e.hasWorld)];
  const entriesOf = (d: Destination): Entry[] =>
    d.routes.map((routeId) => ({ destination: d, routeId, hasWorld: routeHasWorld(d, routeId) }));
  const sections: DestinationSection[] = [];
  for (const d of list) {
    if (d.role === 'wishlist') continue;
    const title = labels ? `${HOUSEHOLD_LABEL[d.role]} · ${d.name}` : d.name;
    sections.push({ id: d.id, role: d.role, title, detail: d.detail, entries: worldFirst(entriesOf(d)) });
  }
  const wish = list.filter((d) => d.role === 'wishlist');
  if (wish.length > 0) {
    sections.push({
      id: 'wishlist',
      role: 'wishlist',
      title: WISHLIST_TITLE,
      detail: WISHLIST_DETAIL,
      entries: worldFirst(wish.flatMap(entriesOf)),
    });
  }
  return sections;
}

/** Short label for "Today's ride · …": the destination's name. */
export function destinationLabel(routeId: string | null | undefined, list: readonly Destination[] = DESTINATIONS): string | null {
  return destinationForRoute(routeId, list)?.name ?? null;
}
