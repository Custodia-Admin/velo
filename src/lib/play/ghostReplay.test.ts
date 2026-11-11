/**
 * Ghost replay accuracy (blueprint §P3.2: "ghost from history replays within
 * 1 m of recorded positions"). Rides are recorded through the real
 * rideStore.tick with the ride loop's own sampling (recordedRideFixture),
 * including a pause and a slow-frame stretch, on a real scenic route.
 */
import { describe, expect, it } from 'vitest';

import { sampleRouteAtDistance } from '@/lib/gpxParser';
import { buildInterpolator } from '@/lib/ghosts';
import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { buildGhostReplay, projectOntoRoute, rideSecondsOf } from './ghostReplay';
import { metresBetween, recordRide, type RecordedRide } from './recordedRideFixture';

const ID = 'scenic-assisi-valley';
const route = routeFromGeometry(ID, ID, SCENIC_ROUTE_GEOMETRY[ID]);

/** 4 km with a 90 s stop at 1.5 km and a 6 fps stretch (frame step capped at 0.1 s) from wall 320–380 s. */
function plannedRide(): RecordedRide {
  return recordRide(route, {
    lengthM: 4000,
    pauses: [[1500, 90]],
    frameMs: (wall) => (wall > 320 && wall < 380 ? 160 : 1000 / 60),
  });
}

const at = (m: number) => sampleRouteAtDistance(route, m);

describe('ghost replay (lib/play/ghostReplay)', () => {
  const ride = plannedRide();
  const replay = buildGhostReplay(ride.samples, ride.startedAt, route)!;

  it('records what the app records: a sample a second on the ride clock, positions before the step', () => {
    expect(ride.samples.length).toBeGreaterThan(300);
    expect(ride.samples.every((s) => typeof s.rideMs === 'number')).toBe(true);
    // The pause and the slow stretch make the wall clock run well ahead of the ride clock.
    const last = ride.samples[ride.samples.length - 1];
    expect(ride.wallSec - (last.rideMs as number) / 1000).toBeGreaterThan(100);
  });

  it('passes through every recorded position (within 1 m) at its ride time', () => {
    let worst = 0;
    for (const s of ride.samples) {
      const p = at(replay.distanceAt((s.rideMs as number) / 1000));
      worst = Math.max(worst, metresBetween(p, s));
    }
    expect(worst).toBeLessThan(1);
    // In practice it is exact: the projection recovers the recorded point.
    expect(worst).toBeLessThan(0.05);
  });

  it('is within 1 m of where the rider was at every frame of the ride, on their ride clock', () => {
    let worst = 0;
    for (const f of ride.frames) {
      worst = Math.max(worst, metresBetween(at(replay.distanceAt(f.rideSec)), f));
    }
    expect(worst).toBeLessThan(1);
  });

  it('runs on the ride clock: the wall-clock interpolator is tens of metres off after the stop', () => {
    const old = buildInterpolator(ride.samples, ride.startedAt);
    const after = ride.frames.filter((f) => f.distance > 2000);
    const f = after[Math.floor(after.length / 2)];
    expect(metresBetween(at(replay.distanceAt(f.rideSec)), f)).toBeLessThan(1);
    expect(Math.abs((old(f.rideSec) ?? 0) - f.distance)).toBeGreaterThan(50);
  });

  it('stands at its first spot before the start and at its last spot after its end', () => {
    expect(replay.distanceAt(-5)).toBe(replay.distanceAt(0));
    expect(replay.distanceAt(0)).toBeLessThan(1);
    expect(replay.distanceAt(replay.durationSec + 600)).toBe(replay.endM);
    // The closing sample: it ends where the ride ended, not at the last once-a-second sample.
    expect(replay.endM).toBeGreaterThanOrEqual(4000);
  });

  it('timeAt inverts distanceAt (Finish comparison), null past where the ride stopped', () => {
    for (const m of [10, 800, 1500, 2600, 3900]) {
      const t = replay.timeAt(m)!;
      expect(Math.abs(replay.distanceAt(t) - m)).toBeLessThan(0.01);
    }
    expect(replay.timeAt(replay.endM + 5)).toBeNull();
  });

  it('never runs backwards', () => {
    let prev = -Infinity;
    let backSteps = 0;
    for (let t = 0; t <= replay.durationSec; t += 0.25) {
      const d = replay.distanceAt(t);
      if (d < prev) backSteps++;
      prev = d;
    }
    expect(backSteps).toBe(0);
  });

  it('replays rides saved before rideMs existed: positions still on the recorded points, the stop taken out', () => {
    const legacy = ride.samples.map(({ rideMs: _drop, ...s }) => s);
    const secs = rideSecondsOf(legacy, ride.startedAt);
    const old = buildGhostReplay(legacy, ride.startedAt, route)!;
    let worst = 0;
    legacy.forEach((s, i) => {
      worst = Math.max(worst, metresBetween(at(old.distanceAt(secs[i])), s));
    });
    expect(worst).toBeLessThan(1);
    // The 90 s stop is not riding time; the slow stretch (wall clock > ride clock) is the only drift left.
    const trueSec = (ride.samples[ride.samples.length - 1].rideMs as number) / 1000;
    expect(old.durationSec).toBeLessThan(ride.wallSec - 80);
    expect(Math.abs(old.durationSec - trueSec)).toBeLessThan(30);
  });

  it('projects a recorded point back onto the route near its recorded distance', () => {
    const p = at(1234.5);
    expect(projectOntoRoute(route, p.lat, p.lon, 1240)).toBeCloseTo(1234.5, 2);
    // A point far off the route keeps its recorded distance.
    expect(projectOntoRoute(route, p.lat + 0.01, p.lon, 1240)).toBe(1240);
  });

  it('has nothing to replay with fewer than two samples', () => {
    expect(buildGhostReplay(ride.samples.slice(0, 1), ride.startedAt, route)).toBeNull();
  });
});
