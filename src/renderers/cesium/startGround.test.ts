import { describe, expect, it, vi } from 'vitest';

import { START_FETCH_RETRY_MS, START_PLAUSIBLE_M, START_STABLE_M, START_STABLE_MS, StartGroundWatch } from './startGround';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('StartGroundWatch: the ride starts on a plausible ground, not on a coarse chord', () => {
  it('waits while the drawn globe is a coarse tile (948 m over a 329 m shore)', async () => {
    const w = new StartGroundWatch(async () => 329.2);
    w.update(8.95, 45.97, undefined, 281, 0); // no tile: route-elevation fallback
    await flush();
    for (let t = 0; t <= 5000; t += 100) w.update(8.95, 45.97, 948.4, 948.4, t);
    expect(w.ready).toBe(false);
  });

  // Chords measured on the owner's laptop while World Terrain refined (absolute heights, not
  // offsets from START_PLAUSIBLE_M, so a wider window that would accept them fails here).
  it.each([
    { spot: 'Lugano shore', lon: 8.95, lat: 45.97, finest: 329.2, chord: 355.3 }, // 26.1 m over
    { spot: 'Trasimeno shore', lon: 12.1, lat: 43.2, finest: 307.2, chord: 333.0 }, // 25.8 m over
  ])('waits on the measured $spot chord ($chord m drawn over $finest m finest)', async ({ lon, lat, finest, chord }) => {
    const w = new StartGroundWatch(async () => finest);
    w.update(lon, lat, chord, chord, 0);
    await flush();
    for (let t = 0; t <= 5000; t += 100) w.update(lon, lat, chord, chord, t);
    expect(w.ready).toBe(false);
  });

  it('waits on a chord just outside the window', async () => {
    const over = 329.2 + START_PLAUSIBLE_M + 0.5;
    const w = new StartGroundWatch(async () => 329.2);
    w.update(8.95, 45.97, over, over, 0);
    await flush();
    for (let t = 0; t <= 5000; t += 100) w.update(8.95, 45.97, over, over, t);
    expect(w.ready).toBe(false);
    // The same below the finest height.
    const under = 329.2 - START_PLAUSIBLE_M - 0.5;
    for (let t = 5000; t <= 10_000; t += 100) w.update(8.95, 45.97, under, under, t);
    expect(w.ready).toBe(false);
  });

  it('starts once the drawn globe is within the window of the finest terrain and the rider has settled on it', async () => {
    const w = new StartGroundWatch(async () => 307.2);
    w.update(12.1, 43.2, 518.8, 518.8, 0);
    await flush();
    // Trasimeno on the laptop: the globe sat 3.8 m under the finest for seconds. Close enough.
    w.update(12.1, 43.2, 303.4, 345, 100); // drawn globe in, rider still easing down onto it
    w.update(12.1, 43.2, 303.4, 303.4, 400);
    expect(w.ready).toBe(false);
    w.update(12.1, 43.2, 303.4, 303.4, 400 + START_STABLE_MS - 1);
    expect(w.ready).toBe(false);
    w.update(12.1, 43.2, 303.4, 303.4, 400 + START_STABLE_MS);
    expect(w.ready).toBe(true);
  });

  it("the rider's own ground counts too: a drawn globe in the window doesn't start a rider still far up", async () => {
    const w = new StartGroundWatch(async () => 307.2);
    w.update(12.1, 43.2, 307.2, 355, 0);
    await flush();
    for (let t = 0; t <= 5000; t += 100) w.update(12.1, 43.2, 307.2, 355, t);
    expect(w.ready).toBe(false);
  });

  it('the drawn globe counts too: a rider on the mesh waits while the globe under it is still a coarse chord', async () => {
    // Lugano shore: the rider already stands on the photoreal mesh (in the window), but the globe
    // drawn there is a chord 79 m under it that will refine up, possibly over the mesh.
    const w = new StartGroundWatch(async () => 329.2);
    w.update(8.95, 45.97, 250, 329.5, 0);
    await flush();
    for (let t = 0; t <= 5000; t += 100) w.update(8.95, 45.97, 250, 329.5, t);
    expect(w.ready).toBe(false);
    // No globe tile drawn there at all: still waiting.
    for (let t = 5000; t <= 10_000; t += 100) w.update(8.95, 45.97, undefined, 329.5, t);
    expect(w.ready).toBe(false);
  });

  it('an unknown finest height is never plausible, even at sea level (heights near 0 m)', async () => {
    // Santa Monica: route ele 3 m, drawn 2.5 m; the finest height never arrives.
    const w = new StartGroundWatch(async () => undefined);
    w.update(-118.5, 34, 2.5, 3, 0);
    await flush();
    for (let t = 0; t <= 5000; t += 100) {
      w.update(-118.5, 34, 2.5, 3, t);
      await flush();
    }
    expect(w.ready).toBe(false);
  });

  it("doesn't wait for the photoreal tile under the rider (it lands later; the rider rises onto it)", async () => {
    const w = new StartGroundWatch(async () => -32.37);
    w.update(-118.5, 34, -32.37, -32.37, 0);
    await flush();
    w.update(-118.5, 34, -32.37, -32.37, 100);
    w.update(-118.5, 34, -32.37, -32.37, 100 + START_STABLE_MS);
    expect(w.ready).toBe(true);
  });

  it('a ground still moving (a tile refining under the rider) restarts the wait', async () => {
    const w = new StartGroundWatch(async () => 303);
    w.update(12.1, 43.2, 303, 306, 0);
    await flush();
    w.update(12.1, 43.2, 303, 306, 100);
    const moved = 306 + START_STABLE_M + 0.1;
    w.update(12.1, 43.2, 303, moved, 400); // mesh tile refined higher
    w.update(12.1, 43.2, 303, moved, 400 + START_STABLE_MS - 1);
    expect(w.ready).toBe(false);
    w.update(12.1, 43.2, 303, moved, 400 + START_STABLE_MS);
    expect(w.ready).toBe(true);
    // A wobble inside the band keeps it ready.
    w.update(12.1, 43.2, 303, moved - START_STABLE_M + 0.05, 400 + START_STABLE_MS + 100);
    expect(w.ready).toBe(true);
  });

  it('a new spot fetches its own finest height; an unknown or failed one is retried, never ready', async () => {
    const fetch = vi.fn(async (lon: number) => (lon > 9 ? undefined : 300));
    const w = new StartGroundWatch(fetch);
    w.update(8.9, 45, 300, 300, 0);
    w.update(8.9, 45, 300, 300, 10);
    expect(fetch).toHaveBeenCalledTimes(1);
    w.update(9.1, 45, 300, 300, 20);
    await flush();
    for (let t = 20; t <= 5000; t += 100) {
      w.update(9.1, 45, 300, 300, t);
      await flush();
    }
    // Unknown there: retried about once a second, never ready.
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(7);
    expect(w.ready).toBe(false);
    const failing = new StartGroundWatch(() => Promise.reject(new Error('offline')));
    failing.update(8.9, 45, 300, 300, 0);
    await flush();
    failing.update(8.9, 45, 300, 300, 5000);
    expect(failing.ready).toBe(false);
  });

  it('retries a fetch that failed (asked before World Terrain was assigned: no tile availability)', async () => {
    let assigned = false;
    const fetch = vi.fn(async () => {
      if (!assigned) throw new Error('requires a terrain provider that has tile availability');
      return 303;
    });
    const w = new StartGroundWatch(fetch);
    w.update(12.1, 43.2, undefined, 0, 0);
    await flush();
    assigned = true;
    w.update(12.1, 43.2, 303.1, 303.1, START_FETCH_RETRY_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    w.update(12.1, 43.2, 303.1, 303.1, START_FETCH_RETRY_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    await flush();
    w.update(12.1, 43.2, 303.1, 303.1, START_FETCH_RETRY_MS + 10);
    w.update(12.1, 43.2, 303.1, 303.1, START_FETCH_RETRY_MS + 10 + START_STABLE_MS);
    expect(w.ready).toBe(true);
  });
});
