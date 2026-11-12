import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { nextScenicRoute, powerSummary, rideAgain, secondaryStats } from '@/components/velo/FinishCard';
import { useRideStore } from '@/stores/rideStore';
import type { Route, TelemetrySample } from '@/types';

/** One sample per second at a fixed power. */
function steady(seconds: number, power: number): TelemetrySample[] {
  const t0 = 1_700_000_000_000;
  return Array.from({ length: seconds }, (_, i) => ({
    t: t0 + i * 1000,
    lat: 43,
    lon: 12,
    ele: 200,
    distance: i * 8,
    speed: 8,
    grade: 0,
    power,
  }));
}

describe('finish screen figures', () => {
  it('summarises power: average, NP, IF and TSS against the FTP', () => {
    const p = powerSummary(steady(1200, 190), 220);
    expect(p).not.toBeNull();
    expect(p!.avgW).toBe(190);
    expect(p!.npW).toBe(190);
    expect(p!.if).toBeCloseTo(0.86, 2);
    expect(p!.tss).toBe(25);
  });

  it('says nothing about power for a ride without any', () => {
    expect(powerSummary(steady(600, 0), 220)).toBeNull();
    expect(powerSummary([], 220)).toBeNull();
  });

  it('leaves IF and TSS out without an FTP', () => {
    const p = powerSummary(steady(600, 150), 0)!;
    expect(p.if).toBeNull();
    expect(p.tss).toBeNull();
  });

  it('puts climbed and average speed first, then power; NP only when it differs from the average', () => {
    const climbed = { value: '19', unit: 'm' };
    const avg = { value: '32.6', unit: 'km/h' };
    expect(secondaryStats(climbed, avg, null).map((s) => s.label)).toEqual(['Climbed', 'Avg speed']);
    expect(secondaryStats(climbed, avg, { avgW: 190, npW: 190, if: 0.86, tss: 25 })).toEqual([
      { label: 'Climbed', value: '19 m' },
      { label: 'Avg speed', value: '32.6 km/h' },
      { label: 'IF', value: '0.86' },
      { label: 'TSS', value: '25' },
    ]);
    expect(secondaryStats(climbed, avg, { avgW: 180, npW: 204, if: 0.93, tss: 41 }).map((s) => s.label)).toEqual([
      'Climbed',
      'Avg speed',
      'NP',
      'IF',
      'TSS',
    ]);
  });
});

describe('Tomorrow, maybe', () => {
  // The home routes in library order; Trasimeno has no baked world yet (it
  // rides in the classic view), so Velo never suggests it by itself.
  const TRASIMENO = 'scenic-trasimeno-shore';
  const TIBER = 'scenic-perugia-tiber-park';
  const ASSISI = 'scenic-assisi-valley';
  const next = (id: string | undefined, day: number) => nextScenicRoute(id, new Date(2026, 10, day, 9))?.route.id;

  it('offers the next home route a baked world draws after a home ride, never the same one', () => {
    expect([TIBER, ASSISI].map((id) => next(id, 1))).toEqual([ASSISI, TIBER]);
    // After the classic-view Trasimeno: tomorrow's featured route, as after any other ride.
    expect([1, 2, 3, 4].map((day) => next(TRASIMENO, day))).toEqual([ASSISI, TIBER, ASSISI, TIBER]);
  });

  it('offers tomorrow’s featured route after any other ride, never a classic-view one', () => {
    for (const id of [undefined, 'scenic-lugano-melide', 'scenic-hangzhou-west-lake', 'gpx-123']) {
      expect([1, 2, 3, 4].map((day) => next(id, day)), String(id)).toEqual([ASSISI, TIBER, ASSISI, TIBER]);
    }
    for (let day = 1; day <= 60; day++) {
      for (const id of [undefined, TRASIMENO, TIBER, ASSISI, 'scenic-lake-como-menaggio']) {
        expect(next(id, day), `${id} on day ${day}`).not.toBe(TRASIMENO);
        expect(next(id, day)).not.toBe(id);
      }
    }
  });
});

describe('Ride again', () => {
  const route: Route = {
    id: 'r1',
    name: 'Test loop',
    points: [
      { lat: 43, lon: 12, ele: 200, distance: 0 },
      { lat: 43.01, lon: 12, ele: 205, distance: 1112 },
    ],
    totalDistance: 1112,
    ascent: 5,
    descent: 0,
  } as unknown as Route;

  beforeEach(() => {
    useRideStore.getState().setRoute(route);
  });

  it('restarts the finished ride on the same route from the start', () => {
    const st = useRideStore.getState();
    st.start();
    useRideStore.setState({ distance: 1100, elapsedMs: 300_000 });
    useRideStore.getState().finish();
    expect(useRideStore.getState().rideState).toBe('finished');

    rideAgain();
    const after = useRideStore.getState();
    expect(after.rideState).toBe('running');
    expect(after.route?.id).toBe('r1');
    expect(after.distance).toBe(0);
    expect(after.elapsedMs).toBe(0);
  });
});

describe('finish screen layout contract', () => {
  const src = readFileSync(resolve(__dirname, 'FinishCard.tsx'), 'utf8');

  it('is its own opaque full-screen page that fits the viewport (flex column, shrinking plate)', () => {
    // Opaque: `bg-background` with no `/NN` alpha suffix (`bg-background/60`
    // would let the ride scene show through).
    expect(src).toMatch(/fixed inset-0 z-50 flex flex-col overflow-y-auto bg-background(?![/\w-])/);
    expect(src).toMatch(/flex min-h-0 flex-1 flex-col/);
    expect(src).toMatch(/aspect-4\/3 min-h-32 w-full sm:aspect-21\/9/);
    expect(src).not.toMatch(/max-h-finish-fit/);
  });

  it('offers exactly Save .FIT, Ride again and Home; Home is the one filled button', () => {
    expect(src).toMatch(/Save \.FIT/);
    expect(src).toMatch(/Ride again/);
    expect((src.match(/variant="primary"/g) ?? []).length).toBe(1);
    expect(src).not.toMatch(/Strava|Share|achievement/i);
  });

  it('names no upstream project', () => {
    expect(src).not.toMatch(/GlobeRide/);
  });
});
