import { describe, expect, it, vi } from 'vitest';

import { START_STABLE_MS, StartGroundWatch } from './startGround';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('StartGroundWatch: the ride starts on the finest ground, not on a coarse chord', () => {
  it('waits while the drawn globe is a coarse tile (948 m over a 329 m shore)', async () => {
    const w = new StartGroundWatch(async () => 329.2);
    w.update(8.95, 45.97, undefined, 281, 0); // no tile: route-elevation fallback
    await flush();
    for (let t = 0; t <= 5000; t += 100) w.update(8.95, 45.97, 948.4, 948.4, t);
    expect(w.ready).toBe(false);
  });

  it('starts once the drawn globe matches the finest terrain and the rider has settled on it', async () => {
    const w = new StartGroundWatch(async () => 329.2);
    w.update(8.95, 45.97, 948.4, 948.4, 0);
    await flush();
    w.update(8.95, 45.97, 329.3, 520, 100); // refined, rider still easing down
    w.update(8.95, 45.97, 329.3, 329.4, 400);
    expect(w.ready).toBe(false);
    w.update(8.95, 45.97, 329.3, 329.4, 400 + START_STABLE_MS - 1);
    expect(w.ready).toBe(false);
    w.update(8.95, 45.97, 329.3, 329.4, 400 + START_STABLE_MS);
    expect(w.ready).toBe(true);
  });

  it('a refining photoreal mesh moving the ground restarts the wait', async () => {
    const w = new StartGroundWatch(async () => 303);
    w.update(12.1, 43.2, 303, 306, 0);
    await flush();
    w.update(12.1, 43.2, 303, 306, 100);
    w.update(12.1, 43.2, 303, 308.5, 1000); // mesh tile refined 2.5 m higher
    w.update(12.1, 43.2, 303, 308.5, 1000 + START_STABLE_MS - 1);
    expect(w.ready).toBe(false);
    w.update(12.1, 43.2, 303, 308.5, 1000 + START_STABLE_MS);
    expect(w.ready).toBe(true);
  });

  it('a new spot fetches its own finest height; a failed fetch never reports ready', async () => {
    const fetch = vi.fn(async (lon: number) => (lon > 9 ? undefined : 300));
    const w = new StartGroundWatch(fetch);
    w.update(8.9, 45, 300, 300, 0);
    w.update(8.9, 45, 300, 300, 10);
    expect(fetch).toHaveBeenCalledTimes(1);
    w.update(9.1, 45, 300, 300, 20);
    await flush();
    for (let t = 20; t <= 5000; t += 100) w.update(9.1, 45, 300, 300, t);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(w.ready).toBe(false);
    const failing = new StartGroundWatch(() => Promise.reject(new Error('offline')));
    failing.update(8.9, 45, 300, 300, 0);
    await flush();
    failing.update(8.9, 45, 300, 300, 5000);
    expect(failing.ready).toBe(false);
  });
});
