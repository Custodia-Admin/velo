/**
 * Destination manifests (src/lib/world/destinations/*.json): the validator,
 * the Home sections generated from them, and the link to each baked world.
 * The world-derived fields must match the shipped bundle's manifest.json
 * (re-run `node tools/worldbake/syncDestinations.mjs` after a bake).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SCENIC_ROUTES } from '@/lib/scenicRoutes';
import {
  DESTINATIONS,
  DestinationError,
  destinationForRoute,
  destinationLabel,
  homeSections,
  loadDestinations,
  validateDestination,
  type Destination,
} from './destinations';
import { WORLD_CATALOG, worldCatalogFrom, worldForRoute } from './catalog';
import { destinationFromWorld, serialize } from '../../../tools/worldbake/syncDestinations.mjs';

const DIR = fileURLToPath(new URL('./destinations/', import.meta.url));
const WORLDS = fileURLToPath(new URL('../../../public/worlds/', import.meta.url));
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

const base = (over: Record<string, unknown> = {}) => ({
  format: 'velo-destination',
  version: 1,
  id: 'testville',
  name: 'Testville',
  role: 'wishlist',
  order: 1,
  place: 'Somewhere, Nowhere',
  detail: 'A test place',
  world: null,
  routes: ['scenic-test'],
  moods: ['clear-noon'],
  defaultMood: 'clear-noon',
  pois: [],
  credits: [{ id: 'osm', name: 'OpenStreetMap', licence: 'ODbL-1.0', url: 'https://www.openstreetmap.org/copyright', attribution: '© OpenStreetMap contributors' }],
  ...over,
});

describe('destination manifests on disk', () => {
  it('every manifest file is loaded, valid and named after its id', () => {
    expect(files.length).toBe(DESTINATIONS.length);
    for (const f of files) expect(validateDestination(readJson(DIR + f), f).id).toBe(f.replace(/\.json$/, ''));
  });

  it('puts every scenic route in exactly one destination, and only real routes', () => {
    const ids = new Set(SCENIC_ROUTES.map((r) => r.route.id));
    const listed = DESTINATIONS.flatMap((d) => d.routes);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...ids].sort());
  });

  it('has Perugia as home and Lugano as hometown, both with a baked world', () => {
    const home = DESTINATIONS.filter((d) => d.role === 'home');
    const hometown = DESTINATIONS.filter((d) => d.role === 'hometown');
    expect(home.map((d) => d.id)).toEqual(['perugia']);
    expect(hometown.map((d) => d.id)).toEqual(['lugano']);
    expect(home[0].world?.routes).toEqual(['scenic-perugia-tiber-park', 'scenic-assisi-valley']);
    expect(hometown[0].world?.routes).toEqual(['scenic-lugano-melide', 'scenic-locarno-brissago']);
  });

  it('wishlist destinations without a world use their routes’ own moods and the route data credits', () => {
    for (const d of DESTINATIONS.filter((x) => x.world === null)) {
      const moods = new Set(d.routes.map((id) => SCENIC_ROUTES.find((r) => r.route.id === id)!.mood));
      expect(new Set(d.moods), d.id).toEqual(moods);
      expect(d.credits.map((c) => c.id).sort(), d.id).toEqual(['copernicus-glo90', 'osm', 'osrm-fossgis']);
      expect(d.pois, d.id).toEqual([]);
    }
  });

  it('uses one text per credit id across all manifests', () => {
    const byId = new Map<string, string>();
    for (const d of DESTINATIONS) {
      for (const c of d.credits) {
        const s = JSON.stringify(c);
        expect(byId.get(c.id) ?? s, `${d.id} ${c.id}`).toBe(s);
        byId.set(c.id, s);
      }
    }
  });
});

describe('destinations ↔ baked worlds', () => {
  const linked = DESTINATIONS.filter((d): d is Destination & { world: NonNullable<Destination['world']> } => d.world !== null);

  it('links only worlds that ship, with a bake recipe', () => {
    for (const d of linked) {
      expect(existsSync(`${WORLDS}${d.world.dir}manifest.json`), d.id).toBe(true);
      expect(existsSync(fileURLToPath(new URL(`../../../tools/worldbake/worlds/${d.world.id}.json`, import.meta.url))), d.id).toBe(true);
    }
  });

  it('every shipped world is linked by a destination (Home can reach it)', () => {
    const shipped = readdirSync(WORLDS).filter((f) => existsSync(`${WORLDS}${f}/manifest.json`)).sort();
    expect(linked.map((d) => d.world.id).sort()).toEqual(shipped);
  });

  it('world-derived fields equal the bundle manifest (syncDestinations is a no-op)', () => {
    for (const d of linked) {
      const world = readJson(`${WORLDS}${d.world.dir}manifest.json`);
      const onDisk = readFileSync(`${DIR}${d.id}.json`, 'utf8');
      expect(serialize(destinationFromWorld(JSON.parse(onDisk), world)), `${d.id}: run node tools/worldbake/syncDestinations.mjs`).toBe(onDisk);
    }
  });

  it('the world catalog is exactly the linked worlds', () => {
    expect(WORLD_CATALOG.map((w) => w.id)).toEqual(linked.map((d) => d.world.id));
    expect(worldCatalogFrom([])).toEqual([]);
  });

  it('every route a world bakes rides on it; every other route rides on the map', () => {
    for (const r of SCENIC_ROUTES) {
      const d = destinationForRoute(r.route.id)!;
      const w = worldForRoute(r.route);
      if (d.world?.routes.includes(r.route.id)) expect(w?.id, r.route.id).toBe(d.world.id);
      else expect(w, r.route.id).toBeNull();
    }
  });
});

describe('Home sections are generated from the manifests', () => {
  it('Home · Perugia, Hometown · Lugano, then Places we want to go', () => {
    const s = homeSections();
    expect(s.map((x) => x.title)).toEqual(['Home · Perugia', 'Hometown · Lugano', 'Places we want to go']);
    expect(s.map((x) => x.role)).toEqual(['home', 'hometown', 'wishlist']);
    // Every route is on Home once; world routes lead their section.
    const all = s.flatMap((x) => x.entries.map((e) => e.routeId));
    expect([...all].sort()).toEqual(SCENIC_ROUTES.map((r) => r.route.id).sort());
    for (const sec of s) {
      const flags = sec.entries.map((e) => e.hasWorld);
      expect(flags, sec.id).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));
    }
  });

  it('the wishlist follows manifest order and says once that it rides on the map', () => {
    const wish = homeSections().find((x) => x.role === 'wishlist')!;
    const order = DESTINATIONS.filter((d) => d.role === 'wishlist');
    expect(wish.entries.map((e) => e.destination.id)).toEqual(order.flatMap((d) => d.routes.map(() => d.id)));
    expect(wish.detail).toBe('3D worlds coming; these ride on the map today');
  });

  it('a new manifest becomes a new section or tile, with no code change', () => {
    const extra = validateDestination(base({ id: 'zz', name: 'Zed', routes: ['scenic-zz'] }));
    const s = homeSections([...DESTINATIONS, extra]);
    expect(s.at(-1)!.entries.at(-1)).toMatchObject({ routeId: 'scenic-zz', hasWorld: false });
    const hometown2 = validateDestination(base({ id: 'como', name: 'Como', role: 'hometown', order: 2, routes: ['scenic-como'] }));
    expect(homeSections([...DESTINATIONS, hometown2]).map((x) => x.title)).toContain('Hometown · Como');
    // Once a wishlist place gets a world, the section line stops saying "map".
    const baked = validateDestination(
      base({ id: 'w', world: { id: 'w', dir: 'w/', bbox: { south: 0, west: 0, north: 1, east: 1 }, routes: ['scenic-test'] } }),
    );
    expect(homeSections([baked]).at(-1)!.detail).not.toContain('map');
  });

  it('labels Today’s ride with its destination', () => {
    expect(destinationLabel('scenic-perugia-tiber-park')).toBe('Perugia');
    expect(destinationLabel('scenic-lugano-melide')).toBe('Lugano');
    expect(destinationLabel('nope')).toBeNull();
    expect(destinationLabel(null)).toBeNull();
  });
});

describe('validateDestination / loadDestinations', () => {
  it('accepts a minimal manifest', () => {
    expect(validateDestination(base())).toMatchObject({ id: 'testville', world: null, role: 'wishlist' });
  });

  it.each([
    ['format', { format: 'velo-world' }],
    ['id', { id: 'Bad Id' }],
    ['role', { role: 'travels' }],
    ['routes', { routes: [] }],
    ['dup routes', { routes: ['a', 'a'] }],
    ['defaultMood', { defaultMood: 'foggy' }],
    ['world.dir', { world: { id: 'w', dir: 'x/', bbox: { south: 0, west: 0, north: 1, east: 1 }, routes: ['scenic-test'] } }],
    ['world bbox', { world: { id: 'w', dir: 'w/', bbox: { south: 1, west: 0, north: 0, east: 1 }, routes: ['scenic-test'] } }],
    ['world route not in routes', { world: { id: 'w', dir: 'w/', bbox: { south: 0, west: 0, north: 1, east: 1 }, routes: ['other'] } }],
    ['poi kind', { pois: [{ name: 'X', kind: 'pub', lat: 1, lon: 1 }] }],
    ['credits', { credits: [] }],
  ])('rejects a bad %s with a typed error', (_, over) => {
    let err: unknown;
    try {
      validateDestination(base(over));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DestinationError);
    expect((err as DestinationError).code).toBe('invalid');
  });

  it('reports an unknown version as unsupported', () => {
    expect(() => validateDestination(base({ version: 2 }))).toThrow(expect.objectContaining({ code: 'unsupported' }));
  });

  it('rejects duplicate ids, worlds and routes, and file names that differ from the id', () => {
    const w = { id: 'w', dir: 'w/', bbox: { south: 0, west: 0, north: 1, east: 1 }, routes: ['r1'] };
    expect(() => loadDestinations({ 'a/x.json': base({ id: 'x' }), 'b/x.json': base({ id: 'x', routes: ['r2'] }) })).toThrow(
      expect.objectContaining({ code: 'duplicate' }),
    );
    expect(() =>
      loadDestinations({ 'x.json': base({ id: 'x', routes: ['r1'], world: w }), 'y.json': base({ id: 'y', routes: ['r1'] }) }),
    ).toThrow(expect.objectContaining({ code: 'duplicate' }));
    expect(() =>
      loadDestinations({ 'x.json': base({ id: 'x', routes: ['r1'], world: w }), 'y.json': base({ id: 'y', routes: ['r1b', 'r1'], world: { ...w, routes: ['r1b'] } }) }),
    ).toThrow(expect.objectContaining({ code: 'duplicate' }));
    expect(() => loadDestinations({ 'other.json': base() })).toThrow(expect.objectContaining({ code: 'invalid' }));
  });

  it('orders by role, then order, then id', () => {
    const list = loadDestinations({
      'b.json': base({ id: 'b', order: 2, routes: ['b'] }),
      'a.json': base({ id: 'a', order: 2, routes: ['a'] }),
      'h.json': base({ id: 'h', role: 'home', order: 9, routes: ['h'] }),
      'c.json': base({ id: 'c', order: 1, routes: ['c'] }),
    });
    expect(list.map((d) => d.id)).toEqual(['h', 'c', 'a', 'b']);
  });
});
