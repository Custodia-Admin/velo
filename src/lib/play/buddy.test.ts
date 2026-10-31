import { describe, it, expect } from 'vitest';
import type { Route, TelemetrySample } from '@/types';
import type { RideRecord } from '@/lib/rideHistory';
import {
  BUDDY_MAX_GAP_M,
  buddyLine,
  buddyTargetGap,
  easeGap,
  offsetSideways,
  pickBuddyRide,
} from '@/lib/play/buddy';

const route = { id: 'scenic-lugano-melide', name: 'Lugano lakefront to Melide', totalDistance: 9709 } as Route;

function record(over: Partial<RideRecord>): RideRecord {
  const startedAt = over.startedAt ?? Date.UTC(2026, 9, 28, 17);
  // 5 m/s for 100 s.
  const samples = Array.from({ length: 11 }, (_, i) => ({ t: startedAt + i * 10_000, distance: i * 50 })) as TelemetrySample[];
  return {
    id: 'r', name: route.name, startedAt, durationSec: 100, distanceM: 500, ascentM: 0,
    avgPower: 120, avgSpeed: 5, sampleCount: samples.length, samples, source: 'route',
    routeRef: { id: route.id, name: route.name }, riderId: 'rider-2',
    ...over,
  };
}

describe('pickBuddyRide', () => {
  it("picks the buddy's latest ride on this route", () => {
    const older = record({ id: 'a', startedAt: Date.UTC(2026, 9, 20) });
    const newer = record({ id: 'b', startedAt: Date.UTC(2026, 9, 28) });
    const ride = pickBuddyRide([older, newer], route, 'rider-2');
    expect(ride?.startedAt).toBe(newer.startedAt);
  });

  it('ignores other riders, legacy records, replays and other routes', () => {
    const records = [
      record({ riderId: 'rider-1' }),
      record({ riderId: undefined }),
      record({ source: 'replay' }),
      record({ routeRef: { id: 'scenic-other', name: 'Other' } }),
    ];
    expect(pickBuddyRide(records, route, 'rider-2')).toBeNull();
  });
});

describe('buddy gap', () => {
  const ride = pickBuddyRide([record({})], route, 'rider-2');

  it('follows the recorded pace but never drops you', () => {
    // Recorded 250 m at 50 s.
    expect(buddyTargetGap(50, 245, ride)).toBeCloseTo(5);
    expect(buddyTargetGap(50, 0, ride)).toBe(BUDDY_MAX_GAP_M);
    expect(buddyTargetGap(50, 900, ride)).toBe(-BUDDY_MAX_GAP_M);
  });

  it('drifts gently when there is no recording', () => {
    for (let t = 0; t < 120; t += 7) {
      expect(Math.abs(buddyTargetGap(t, 1000, null))).toBeLessThanOrEqual(3);
    }
  });

  it('eases toward the target', () => {
    const next = easeGap(0, 10, 0.5);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(10);
    expect(easeGap(4, 10, 0)).toBe(4);
  });
});

describe('buddy helpers', () => {
  it('names the buddy and the date of the pace', () => {
    expect(buddyLine('Anna', null)).toBe('Anna rides with you');
    expect(buddyLine('Anna', pickBuddyRide([record({})], route, 'rider-2'))).toBe('Anna rides with you · pace from 28 Oct');
  });

  it('offsets to the left of travel', () => {
    // Heading north: left is west.
    const p = offsetSideways(46, 9, 0, 1.5);
    expect(p.lon).toBeLessThan(9);
    expect(p.lat).toBeCloseTo(46, 9);
    // Heading east: left is north.
    const q = offsetSideways(46, 9, Math.PI / 2, 1.5);
    expect(q.lat).toBeGreaterThan(46);
  });
});
