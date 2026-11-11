/**
 * Play mode on the world renderer (lib/play/threePlayLayer): one postcard per
 * named place the route passes, from the real bundles' POIs, collected when
 * passed, named for the Finish screen; evenly spaced ones on a route that
 * passes too few places. The layer only writes playStore.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';

import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { WORLD_CATALOG } from '@/lib/world/catalog';
import type { WorldManifest } from '@/lib/world/manifest';
import type { RideFrame } from '@/lib/world/worldLayer';
import { usePlayStore } from '@/stores/playStore';
import { useRideStore } from '@/stores/rideStore';
import type { Route } from '@/types';
import { worldBundle } from '../../../tools/worldbake/worldBundles.mjs';
import { placePostcards, POSTCARD_MIN, POSTCARD_PICKUP_M, type Postcard } from './postcards';
import { createThreePlayLayer, postcardsAtPlaces, worldPostcards, type PlacePostcard, type ThreePlayLayer } from './threePlayLayer';

/**
 * A world's committed manifest by id: public/worlds/<id>/ for a world shipped
 * with the app, tools/worldbake/remote/<id>/ for a remote one (its catalog
 * `dir` is the `<id>/<hash>/` it is served under, not a path on disk). The
 * manifest is all these tests read, so no remote layer files are needed.
 */
const manifestOf = (id: string): WorldManifest => JSON.parse(readFileSync(worldBundle(id)!.manifestPath, 'utf8'));
const scenic = (id: string): Route => routeFromGeometry(id, id, SCENIC_ROUTE_GEOMETRY[id]);
const perugia = manifestOf('perugia');
const chengdu = manifestOf('chengdu-luxelakes');
const ID = 'scenic-perugia-tiber-park';
const route = routeFromGeometry(ID, 'Tiber park', SCENIC_ROUTE_GEOMETRY[ID]);
const LUXE = scenic('scenic-chengdu-luxe-lakes');

function frame(distanceM: number, elapsedMs = distanceM * 125, r: Route = route): RideFrame {
  return { elapsedMs, dt: 1 / 60, distanceM, routeLengthM: r.totalDistance, speedMs: 8, powerW: 180, cadenceRpm: 85, gradePct: 0 };
}

/** The layer's postcards, which these Perugia tests expect at places. */
function placeCards(layer: ThreePlayLayer): PlacePostcard[] {
  const set = layer.postcards;
  if (!set.atPlaces) throw new Error('expected postcards at named places');
  return set.cards;
}

/** One postcard each, in route order, strictly inside the route. */
function expectInRouteOrder(cards: readonly Postcard[], r: Route, id: string) {
  cards.forEach((c, i) => {
    expect(c.index, id).toBe(i + 1);
    expect(c.distanceM, id).toBeGreaterThanOrEqual(0);
    expect(c.distanceM, id).toBeLessThanOrEqual(r.totalDistance);
    if (i > 0) expect(c.distanceM, id).toBeGreaterThan(cards[i - 1].distanceM);
  });
}

beforeEach(() => usePlayStore.getState().reset());

describe('postcards at the places on the route', () => {
  it('every world route has postcards to collect: its named places (each a POI of its bundle), or evenly spaced ones when it passes too few', () => {
    expect(WORLD_CATALOG.some((w) => w.remote)).toBe(true);
    for (const w of WORLD_CATALOG) {
      const m = manifestOf(w.id);
      for (const id of w.routeIds) {
        const r = scenic(id);
        const places = postcardsAtPlaces(r, m);
        const set = worldPostcards(r, m);
        expect(set.cards.length, id).toBeGreaterThanOrEqual(POSTCARD_MIN);
        expectInRouteOrder(set.cards, r, id);
        if (places.length >= POSTCARD_MIN) {
          // Named places wherever the route passes enough of them: never spaced cards over them.
          expect(set, id).toEqual({ atPlaces: true, cards: places });
          for (const c of places) expect(m.pois[c.poi].name, id).toBe(c.name);
        } else {
          expect(set, id).toEqual({ atPlaces: false, cards: placePostcards(r.totalDistance) });
        }
      }
    }
  });

  it('the shipped worlds: every Perugia and Lugano route at 4+ named places; Chengdu, whose places are districts off its loops, evenly spaced', () => {
    const local = WORLD_CATALOG.filter((w) => !w.remote);
    expect(local.map((w) => w.id)).toEqual(['perugia', 'lugano']);
    for (const w of local) {
      for (const id of w.routeIds) {
        const set = worldPostcards(scenic(id), manifestOf(w.id));
        expect(set.atPlaces, id).toBe(true);
        expect(set.cards.length, id).toBeGreaterThanOrEqual(4);
      }
    }
    const cd = WORLD_CATALOG.find((w) => w.id === 'chengdu-luxelakes')!;
    expect(cd.routeIds).toEqual(['scenic-chengdu-luxe-lakes', 'scenic-chengdu-xinglong-lake']);
    for (const id of cd.routeIds) {
      const r = scenic(id);
      expect(postcardsAtPlaces(r, chengdu), id).toEqual([]);
      const set = worldPostcards(r, chengdu);
      expect(set.atPlaces, id).toBe(false);
      // 11.2 km and 8.2 km loops: a card every ~800 m, as on photoreal.
      expect(set.cards.length, id).toBeGreaterThanOrEqual(10);
    }
  });

  it('spaced postcards take over below POSTCARD_MIN named places, never at or above it', () => {
    const passed = postcardsAtPlaces(route, perugia);
    expect(passed.length).toBeGreaterThan(POSTCARD_MIN);
    // The same world with only the first n of the places this route passes.
    const withPlaces = (n: number) => ({ ...perugia, pois: passed.slice(0, n).map((c) => perugia.pois[c.poi]) });
    const atMin = worldPostcards(route, withPlaces(POSTCARD_MIN));
    expect(atMin.atPlaces).toBe(true);
    expect(atMin.cards.map((c) => c.distanceM)).toEqual(passed.slice(0, POSTCARD_MIN).map((c) => c.distanceM));
    for (const n of [POSTCARD_MIN - 1, 1, 0]) {
      expect(worldPostcards(route, withPlaces(n)), `${n} places`).toEqual({ atPlaces: false, cards: placePostcards(route.totalDistance) });
    }
  });

  it('Tiber park: from Ponte San Giovanni to Ponte Felcino', () => {
    const names = postcardsAtPlaces(route, perugia).map((c) => c.name);
    expect(names[0]).toBe('Ponte San Giovanni');
    expect(names[names.length - 1]).toBe('Ponte Felcino');
    expect(names).toContain('Torre di Pretola');
  });

  it('a live (GPS) route has no postcards', () => {
    expect(postcardsAtPlaces({ ...route, isLive: true }, perugia)).toEqual([]);
    expect(worldPostcards({ ...LUXE, isLive: true }, chengdu).cards).toEqual([]);
  });
});

describe('the world play layer', () => {
  it('starts the Play panel with every postcard named, none collected', () => {
    const layer = createThreePlayLayer(route, perugia);
    const cards = placeCards(layer);
    const s = usePlayStore.getState();
    expect(s.active).toBe(true);
    expect(s.total).toBe(cards.length);
    expect(s.names).toEqual(cards.map((c) => c.name));
    expect(s.collected).toBe(0);
    layer.dispose();
    // Disposing keeps the count for the Finish screen.
    expect(usePlayStore.getState()).toMatchObject({ active: false, total: cards.length });
  });

  it('collects a postcard when the rider passes its place, with one pickup each, and marks its pin', () => {
    const layer = createThreePlayLayer(route, perugia);
    const cards = placeCards(layer);
    layer.update(frame(0));
    // Standing on the start line collects nothing, even with a place at the start.
    expect(usePlayStore.getState().collected).toBe(0);
    const third = cards[2];
    expect(layer.pending(third.poi)).toBe(true);
    layer.update(frame(third.distanceM - POSTCARD_PICKUP_M - 1));
    expect(usePlayStore.getState().collected).toBe(2);
    const before = usePlayStore.getState().lastPickupAt;
    expect(before).toBeGreaterThan(0);
    layer.update(frame(third.distanceM));
    expect(usePlayStore.getState().collected).toBe(3);
    expect(layer.pending(third.poi)).toBe(false);
    expect(layer.pending(cards[3].poi)).toBe(true);
    // Not a postcard: never pending.
    expect(layer.pending(-1)).toBe(false);
    layer.update(frame(route.totalDistance));
    expect(usePlayStore.getState()).toMatchObject({ collected: cards.length, toNextM: null });
    layer.dispose();
  });

  it('a layer rebuilt mid-ride (remounted canvas) takes back the passed postcards without a pickup', () => {
    const first = createThreePlayLayer(route, perugia);
    first.update(frame(0));
    first.dispose();
    usePlayStore.setState({ lastPickupAt: 0 });
    const again = createThreePlayLayer(route, perugia);
    again.update(frame(7000));
    expect(usePlayStore.getState().collected).toBeGreaterThan(2);
    expect(usePlayStore.getState().lastPickupAt).toBe(0);
    again.dispose();
  });

  it('Ride again (the ride clock back to 0) starts a fresh set', () => {
    const layer = createThreePlayLayer(route, perugia);
    const cards = placeCards(layer);
    layer.update(frame(0));
    layer.update(frame(route.totalDistance));
    expect(usePlayStore.getState().collected).toBe(cards.length);
    layer.update(frame(0, 0));
    expect(usePlayStore.getState().collected).toBe(0);
    expect(layer.pending(cards[0].poi)).toBe(true);
    layer.dispose();
  });

  it('on a route with too few places (Chengdu) the spaced postcards count down and collect, unnamed, with no pin marked', () => {
    const layer = createThreePlayLayer(LUXE, chengdu);
    const set = layer.postcards;
    expect(set).toEqual({ atPlaces: false, cards: placePostcards(LUXE.totalDistance) });
    const cards = set.cards;
    // The Play panel shows (it hides with no postcards), its notes and Finish go without place names.
    expect(usePlayStore.getState()).toMatchObject({ active: true, total: cards.length, names: [], collected: 0 });
    // No place is a postcard: every pin stays plain, the district towns included.
    chengdu.pois.forEach((_, i) => expect(layer.pending(i), chengdu.pois[i].name).toBe(false));
    layer.update(frame(0, undefined, LUXE));
    expect(usePlayStore.getState()).toMatchObject({ collected: 0, toNextM: Math.ceil(cards[0].distanceM / 50) * 50, lastPickupAt: 0 });
    layer.update(frame(cards[1].distanceM - POSTCARD_PICKUP_M, undefined, LUXE));
    expect(usePlayStore.getState().collected).toBe(2);
    expect(usePlayStore.getState().lastPickupAt).toBeGreaterThan(0);
    layer.update(frame(LUXE.totalDistance, undefined, LUXE));
    expect(usePlayStore.getState()).toMatchObject({ collected: cards.length, toNextM: null, names: [] });
    layer.dispose();
    expect(usePlayStore.getState()).toMatchObject({ active: false, total: cards.length, collected: cards.length });
  });

  it('never touches the ride store', () => {
    const before = useRideStore.getState();
    const layer = createThreePlayLayer(route, perugia);
    layer.update(frame(0));
    layer.update(frame(5000));
    layer.dispose();
    expect(useRideStore.getState()).toBe(before);
  });
});
