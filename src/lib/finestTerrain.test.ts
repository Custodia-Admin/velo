/**
 * lib/finestTerrain: the finest terrain heights fetched along the ride for the
 * photoreal globe stand-in (lib/avatar createGroundSampler).
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createFinestTerrain,
  FINEST_AHEAD_M,
  FINEST_KEEP,
  FINEST_NEAR_M,
  FINEST_RETRY_MS,
  FINEST_STEP_M,
  NO_FINEST_TERRAIN,
} from '@/lib/finestTerrain';

// Lugano–Melide 7.59 km, riding south-south-east.
const LON = 8.9453;
const LAT0 = 45.9689;
const M_LAT = 110_540;
const mLon = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
/** The spot `n` m north and `e` m east of the origin. */
const at = (n: number, e = 0): [number, number] => [LON + e / mLon, LAT0 + n / M_LAT];
const metres = (a: [number, number], b: [number, number]) =>
  Math.hypot((a[0] - b[0]) * mLon, (a[1] - b[1]) * M_LAT);
const flush = () => new Promise((r) => setTimeout(r, 0));

function fetcher(answer: (p: [number, number]) => number | undefined = () => 321.3) {
  const batches: [number, number][][] = [];
  let fail = false;
  const fetch = vi.fn(async (points: [number, number][]) => {
    batches.push(points);
    if (fail) throw new Error('tile failed');
    return points.map(answer);
  });
  return { fetch, batches, failNext: (v: boolean) => (fail = v) };
}

describe('finest terrain along the ride', () => {
  it('fetches the spot and FINEST_AHEAD_M ahead, every FINEST_STEP_M, the way the rider moves', async () => {
    const f = fetcher();
    const finest = createFinestTerrain(f.fetch);
    expect(finest.near(...at(0))).toBeUndefined();
    // Moving south-east (from 3 m north-west of here).
    const from = at(3 / Math.SQRT2, -3 / Math.SQRT2);
    finest.want(...at(0), ...from, 0);
    expect(f.batches).toHaveLength(1);
    const pts = f.batches[0];
    expect(pts).toHaveLength(FINEST_AHEAD_M / FINEST_STEP_M + 1);
    expect(metres(pts[0], at(0))).toBeLessThan(1e-6);
    pts.forEach((p, i) => {
      expect(metres(p, at(0)), `point ${i}`).toBeCloseTo(i * FINEST_STEP_M, 3);
      // Ahead: away from where the rider came from, along the same line.
      expect(metres(p, from), `point ${i}`).toBeCloseTo(3 + i * FINEST_STEP_M, 3);
    });
    await flush();
    // Answers within FINEST_NEAR_M of a point fetched, not further.
    expect(finest.near(...at(-(FINEST_STEP_M * 3) / Math.SQRT2, (FINEST_STEP_M * 3) / Math.SQRT2))).toBe(321.3);
    expect(finest.near(...at(0, FINEST_NEAR_M - 0.1))).toBe(321.3);
    expect(finest.near(...at(FINEST_NEAR_M + 0.1, -FINEST_NEAR_M - 0.1))).toBeUndefined();
    expect(finest.near(...at(-40, 40))).toBeUndefined();
  });

  it('answers with the nearest height fetched', async () => {
    const f = fetcher((p) => 300 + metres(p, at(0)));
    const finest = createFinestTerrain(f.fetch);
    finest.want(...at(0), ...at(2), 0); // moving south
    await flush();
    expect(finest.near(...at(-4.4))).toBeCloseTo(304, 6);
    expect(finest.near(...at(-6.4))).toBeCloseTo(308, 6);
  });

  it('standing still (or no spot before): only the spot itself', () => {
    const f = fetcher();
    createFinestTerrain(f.fetch).want(...at(0), ...at(0.2), 0);
    createFinestTerrain(f.fetch).want(...at(0), NaN, NaN, 0);
    expect(f.batches.map((b) => b.length)).toEqual([1, 1]);
  });

  it('one batch at a time, and none where a height is already near', async () => {
    const f = fetcher();
    const finest = createFinestTerrain(f.fetch);
    finest.want(...at(0), ...at(2), 0);
    finest.want(...at(-10), ...at(-8), 10);
    expect(f.batches).toHaveLength(1);
    await flush();
    finest.want(...at(-10), ...at(-8), 20);
    expect(f.batches).toHaveLength(1);
    // Past the batch: the next one.
    finest.want(...at(-40), ...at(-38), 30);
    expect(f.batches).toHaveLength(2);
  });

  it('a batch that failed (or found nothing) is tried again only FINEST_RETRY_MS later', async () => {
    const f = fetcher();
    const finest = createFinestTerrain(f.fetch);
    f.failNext(true);
    finest.want(...at(0), ...at(2), 1_000);
    await flush();
    f.failNext(false);
    finest.want(...at(0), ...at(2), 1_000 + FINEST_RETRY_MS - 1);
    expect(f.batches).toHaveLength(1);
    finest.want(...at(0), ...at(2), 1_000 + FINEST_RETRY_MS);
    expect(f.batches).toHaveLength(2);
    await flush();
    expect(finest.near(...at(0))).toBe(321.3);

    const none = fetcher(() => undefined);
    const empty = createFinestTerrain(none.fetch);
    empty.want(...at(0), ...at(2), 0);
    await flush();
    expect(empty.near(...at(0))).toBeUndefined();
    empty.want(...at(0), ...at(2), FINEST_RETRY_MS - 1);
    expect(none.batches).toHaveLength(1);
    empty.want(...at(0), ...at(2), FINEST_RETRY_MS);
    expect(none.batches).toHaveLength(2);
  });

  it(`keeps the last ${FINEST_KEEP} heights`, async () => {
    const f = fetcher();
    const finest = createFinestTerrain(f.fetch);
    const batches = Math.ceil(FINEST_KEEP / (FINEST_AHEAD_M / FINEST_STEP_M + 1)) + 1;
    for (let b = 0; b < batches; b++) {
      finest.want(...at(-100 * b), ...at(-100 * b + 2), b);
      await flush();
    }
    expect(finest.near(...at(-100 * (batches - 1)))).toBe(321.3);
    expect(finest.near(...at(0))).toBeUndefined();
  });

  it('nothing to fetch from: no height, no fetch', () => {
    NO_FINEST_TERRAIN.want(...at(0), ...at(2), 0);
    expect(NO_FINEST_TERRAIN.near(...at(0))).toBeUndefined();
  });
});
