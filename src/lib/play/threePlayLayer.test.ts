/**
 * Play mode on the world renderer (lib/play/threePlayLayer): one postcard per
 * named place the route passes, from the real bundles' POIs, collected when
 * passed, named for the Finish screen. The layer only writes playStore.
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
import { POSTCARD_PICKUP_M } from './postcards';
import { createThreePlayLayer, postcardsAtPlaces } from './threePlayLayer';

const manifest = (dir: string): WorldManifest => JSON.parse(readFileSync(`public/worlds/${dir}/manifest.json`, 'utf8'));
const perugia = manifest('perugia');
const ID = 'scenic-perugia-tiber-park';
const route = routeFromGeometry(ID, 'Tiber park', SCENIC_ROUTE_GEOMETRY[ID]);

function frame(distanceM: number, elapsedMs = distanceM * 125): RideFrame {
  return { elapsedMs, dt: 1 / 60, distanceM, routeLengthM: route.totalDistance, speedMs: 8, powerW: 180, cadenceRpm: 85, gradePct: 0 };
}

beforeEach(() => usePlayStore.getState().reset());

describe('postcards at the places on the route', () => {
  it('every world route has named places to collect, in route order, each a POI of its bundle', () => {
    for (const w of WORLD_CATALOG) {
      const m = manifest(w.dir);
      for (const id of w.routeIds) {
        const cards = postcardsAtPlaces(routeFromGeometry(id, id, SCENIC_ROUTE_GEOMETRY[id]), m);
        expect(cards.length, id).toBeGreaterThanOrEqual(4);
        cards.forEach((c, i) => {
          expect(c.index).toBe(i + 1);
          expect(m.pois[c.poi].name).toBe(c.name);
          if (i > 0) expect(c.distanceM).toBeGreaterThan(cards[i - 1].distanceM);
        });
      }
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
  });
});

describe('the world play layer', () => {
  it('starts the Play panel with every postcard named, none collected', () => {
    const layer = createThreePlayLayer(route, perugia);
    const s = usePlayStore.getState();
    expect(s.active).toBe(true);
    expect(s.total).toBe(layer.postcards.length);
    expect(s.names).toEqual(layer.postcards.map((c) => c.name));
    expect(s.collected).toBe(0);
    layer.dispose();
    // Disposing keeps the count for the Finish screen.
    expect(usePlayStore.getState()).toMatchObject({ active: false, total: layer.postcards.length });
  });

  it('collects a postcard when the rider passes its place, with one pickup each, and marks its pin', () => {
    const layer = createThreePlayLayer(route, perugia);
    const cards = layer.postcards;
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
    layer.update(frame(0));
    layer.update(frame(route.totalDistance));
    expect(usePlayStore.getState().collected).toBe(layer.postcards.length);
    layer.update(frame(0, 0));
    expect(usePlayStore.getState().collected).toBe(0);
    expect(layer.pending(layer.postcards[0].poi)).toBe(true);
    layer.dispose();
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
