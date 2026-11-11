/**
 * The couple ghost's ride pick (lib/play/coupleGhost): the other rider's
 * last or best ride on this route from ride history, and how the live ride
 * compares with it on the Finish screen.
 */
import { describe, expect, it } from 'vitest';

import type { RideRecord } from '@/lib/rideHistory';
import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { AVATAR_PRESETS } from '@/lib/avatarConfig';
import {
  coupleGhostOptions,
  ghostVerdict,
  loadCoupleGhost,
  pickCoupleGhost,
  rideOnRoute,
} from './coupleGhost';
import { recordRide } from './recordedRideFixture';

const ID = 'scenic-perugia-tiber-park';
const route = routeFromGeometry(ID, 'Tiber park', SCENIC_ROUTE_GEOMETRY[ID]);
const other = { id: 'rider-2', name: 'Anna', colors: AVATAR_PRESETS[2].colors };

const ride = recordRide(route, { lengthM: 1500 });

function record(over: Partial<RideRecord>): RideRecord {
  return {
    id: 'r',
    name: 'Tiber park',
    startedAt: 1,
    durationSec: 2000,
    distanceM: route.totalDistance,
    ascentM: 0,
    avgPower: 0,
    avgSpeed: 8,
    sampleCount: ride.samples.length,
    samples: ride.samples,
    source: 'route',
    riderId: 'rider-2',
    routeRef: { id: ID, name: 'Tiber park' },
    ...over,
  };
}

describe('couple ghost: which ride', () => {
  const lastPartial = record({ id: 'last', startedAt: 300, distanceM: 1500, durationSec: 190 });
  const slow = record({ id: 'slow', startedAt: 200, durationSec: 1600 });
  const fast = record({ id: 'fast', startedAt: 100, durationSec: 1400 });
  const mine = record({ id: 'mine', startedAt: 400, riderId: 'rider-1', durationSec: 1000 });
  const elsewhere = record({ id: 'elsewhere', startedAt: 500, routeRef: { id: 'scenic-assisi-valley', name: 'Assisi' } });
  const all = [slow, mine, lastPartial, elsewhere, fast];

  it("takes only the other rider's rides on this route", () => {
    const o = coupleGhostOptions(all, route, 'rider-2');
    expect(o.last?.id).toBe('last');
    // Best = fastest COMPLETE ride: the partial one doesn't count.
    expect(o.best?.id).toBe('fast');
    expect(coupleGhostOptions(all, route, 'rider-3')).toEqual({ last: null, best: null });
  });

  it('picks by choice; best falls back to last when no ride was complete; off is none', () => {
    const o = coupleGhostOptions(all, route, 'rider-2');
    expect(pickCoupleGhost(o, 'last')?.id).toBe('last');
    expect(pickCoupleGhost(o, 'best')?.id).toBe('fast');
    expect(pickCoupleGhost(o, 'off')).toBeNull();
    const partialOnly = coupleGhostOptions([lastPartial], route, 'rider-2');
    expect(partialOnly.best).toBeNull();
    expect(pickCoupleGhost(partialOnly, 'best')?.id).toBe('last');
  });

  it('skips replays, rides without a track, and records of older builds with no rider', () => {
    const o = coupleGhostOptions(
      [
        record({ id: 'replay', source: 'replay', startedAt: 900 }),
        record({ id: 'empty', samples: ride.samples.slice(0, 1), startedAt: 800 }),
        record({ id: 'anon', riderId: undefined, startedAt: 700 }),
      ],
      route,
      'rider-2',
    );
    expect(o).toEqual({ last: null, best: null });
  });

  it('matches the route by id, or by name for records saved without a route ref', () => {
    expect(rideOnRoute({ name: 'x', routeRef: { id: ID, name: 'x' } }, route)).toBe(true);
    expect(rideOnRoute({ name: 'Tiber park — 3 Nov', routeRef: undefined }, route)).toBe(true);
    expect(rideOnRoute({ name: 'Tiber park', routeRef: { id: 'other', name: 'Tiber park' } }, route)).toBe(false);
  });

  it('loads the ghost in the rider\'s colours, labelled last or best', async () => {
    const g = await loadCoupleGhost(route, 'best', other, all);
    expect(g).toMatchObject({ riderName: 'Anna', rideId: 'fast', kind: 'best', colors: other.colors });
    expect((await loadCoupleGhost(route, 'last', other, all))?.kind).toBe('last');
    expect(await loadCoupleGhost(route, 'off', other, all)).toBeNull();
    expect(await loadCoupleGhost(route, 'last', null, all)).toBeNull();
    // A ride that is both the last and the best is the last.
    expect((await loadCoupleGhost(route, 'best', other, [fast]))?.kind).toBe('last');
  });
});

describe('couple ghost: the Finish comparison', () => {
  it('compares ride times at the live rider\'s distance', async () => {
    const g = (await loadCoupleGhost(route, 'last', other, [record({ id: 'last', distanceM: 1500 })]))!;
    const at1k = g.replay.timeAt(1000)!;
    expect(ghostVerdict(g.replay, 1000, at1k - 12, route.totalDistance)).toMatchObject({ kind: 'ahead', seconds: 12, finished: false });
    expect(ghostVerdict(g.replay, 1000, at1k + 30, route.totalDistance)).toMatchObject({ kind: 'behind', seconds: 30 });
    expect(ghostVerdict(g.replay, 1000, at1k + 0.2, route.totalDistance)).toMatchObject({ kind: 'level' });
    // Past where their ride stopped: you rode further.
    expect(ghostVerdict(g.replay, 1800, 400, route.totalDistance)).toMatchObject({ kind: 'further' });
    // Nothing ridden, nothing to compare.
    expect(ghostVerdict(g.replay, 0, 0, route.totalDistance)).toBeNull();
  });
});
