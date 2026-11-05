/**
 * The ride's auto-start, driven render by render against the real ride store
 * with React's useRef/useEffect replaced by a tiny hooks runtime (refs kept by
 * call order, effects re-run only when their deps change, cleanup first).
 * Pins the wiring of the start hold: a renderer whose ground is not ready
 * holds the start, the cap counts from the first paint, leaving cancels it.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorldRenderer } from '@/lib/world/renderer';
import type { Route } from '@/types';

const h = vi.hoisted(() => ({
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void } | undefined>,
  ref: 0,
  effect: 0,
}));

vi.mock('react', async (orig) => {
  const react = await orig<typeof import('react')>();
  return {
    ...react,
    useRef: <T,>(v: T) => {
      const i = h.ref++;
      h.refs[i] ??= { current: v };
      return h.refs[i] as { current: T };
    },
    useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
      const i = h.effect++;
      const prev = h.effects[i];
      if (prev && deps && prev.deps && deps.length === prev.deps.length && deps.every((d, k) => Object.is(d, prev.deps![k]))) return;
      prev?.cleanup?.();
      const c = fn();
      h.effects[i] = { deps, cleanup: typeof c === 'function' ? c : undefined };
    },
  };
});

import { START_DELAY_MS, START_HOLD_MAX_MS, START_HOLD_POLL_MS, START_PENDING_MAX_MS } from '@/lib/ride/startHold';
import { START_STABLE_MS, StartGroundWatch } from '@/renderers/cesium/startGround';
import { useRideStore } from '@/stores/rideStore';
import { useRideAutoStart, type RideAutoStartInput } from './useRideAutoStart';

const route: Route = {
  id: 'flat',
  name: 'flat',
  points: [
    { lat: 0, lon: 0, ele: 0, distance: 0 },
    { lat: 0.0899, lon: 0, ele: 0, distance: 10_000 },
  ],
  totalDistance: 10_000,
  ascent: 0,
  descent: 0,
  minElevation: 0,
  maxElevation: 0,
  loadedAt: 0,
};

const initialRide = useRideStore.getState();

function renderer(groundReady?: () => boolean): WorldRenderer {
  return { groundReady } as unknown as WorldRenderer;
}

/** One render of a component that only runs the hook. */
function AutoStartHost(input: Partial<RideAutoStartInput> & Pick<RideAutoStartInput, 'worldRenderer'>): void {
  h.ref = 0;
  h.effect = 0;
  const s = useRideStore.getState();
  useRideAutoStart({ wantsAutoStart: true, route: s.route, rideMode: s.rideMode, rideState: s.rideState, ...input });
}

function unmount(): void {
  for (const e of h.effects) e?.cleanup?.();
  h.effects = [];
  h.refs = [];
}

const running = () => useRideStore.getState().rideState === 'running';

beforeEach(() => {
  vi.useFakeTimers();
  useRideStore.setState(initialRide, true);
  useRideStore.getState().setRoute(route);
  expect(useRideStore.getState().rideState).toBe('ready');
});

afterEach(() => {
  unmount();
  vi.useRealTimers();
  useRideStore.setState(initialRide, true);
});

describe('ride auto-start: the start hold is wired in', () => {
  it('holds while the renderer says the ground under the rider is not ready, then starts within one poll', () => {
    let ready = false;
    const groundReady = vi.fn(() => ready);
    AutoStartHost({ worldRenderer: renderer(groundReady) });
    vi.advanceTimersByTime(START_DELAY_MS);
    expect(groundReady).toHaveBeenCalled();
    expect(running()).toBe(false);
    vi.advanceTimersByTime(2 * START_HOLD_POLL_MS);
    expect(running()).toBe(false);
    ready = true;
    vi.advanceTimersByTime(START_HOLD_POLL_MS);
    // Well inside the cap: it was the ground that let it go.
    expect(START_DELAY_MS + 3 * START_HOLD_POLL_MS).toBeLessThan(START_HOLD_MAX_MS);
    expect(running()).toBe(true);
  });

  it('starts anyway once the hold cap runs out (tiles stalled, offline)', () => {
    AutoStartHost({ worldRenderer: renderer(() => false) });
    vi.advanceTimersByTime(START_HOLD_MAX_MS - 1);
    expect(running()).toBe(false);
    vi.advanceTimersByTime(START_HOLD_POLL_MS + 1);
    expect(running()).toBe(true);
  });

  it('waits longer while nothing real is drawn under the rider (World Terrain not assigned yet)', () => {
    let pending = true;
    const r = { groundReady: () => false, groundPending: () => pending } as unknown as WorldRenderer;
    AutoStartHost({ worldRenderer: r });
    vi.advanceTimersByTime(START_HOLD_MAX_MS + 1000);
    expect(running()).toBe(false);
    pending = false; // terrain landed; the coarse-ground cap has long run out
    vi.advanceTimersByTime(START_HOLD_POLL_MS);
    expect(running()).toBe(true);
    unmount();
    useRideStore.setState(initialRide, true);
    useRideStore.getState().setRoute(route);
    AutoStartHost({ worldRenderer: { groundReady: () => false, groundPending: () => true } as unknown as WorldRenderer });
    vi.advanceTimersByTime(START_PENDING_MAX_MS - 1);
    expect(running()).toBe(false);
    vi.advanceTimersByTime(START_HOLD_POLL_MS + 1);
    expect(running()).toBe(true);
  });

  it('the cap counts from the first paint, not from each re-run of the effect', () => {
    const r = renderer(() => false);
    AutoStartHost({ worldRenderer: r });
    vi.advanceTimersByTime(START_HOLD_MAX_MS - 500);
    // The wizard's setRoute lands late: the store drops to 'idle', the effect re-runs.
    useRideStore.setState({ rideState: 'idle' });
    AutoStartHost({ worldRenderer: r });
    vi.advanceTimersByTime(START_DELAY_MS);
    expect(running()).toBe(true);
  });

  it("an idle store (the wizard's setRoute landed first) is re-set to the route's start, then started", () => {
    // rideFsm lets START leave 'idle' directly, so reaching 'running' alone doesn't show the
    // re-set; numbers left in the store do: the ride must start from 0 m, 0:00.
    useRideStore.setState({ rideState: 'idle', distance: 1_234, elapsedMs: 99_000 });
    expect(useRideStore.getState().route).toBe(route);
    AutoStartHost({ worldRenderer: renderer(() => true) });
    vi.advanceTimersByTime(START_DELAY_MS);
    const s = useRideStore.getState();
    expect(s.rideState).toBe('running');
    expect(s.distance).toBe(0);
    expect(s.elapsedMs).toBe(0);
  });

  it('a renderer with nothing to stream starts after the short beat', () => {
    AutoStartHost({ worldRenderer: renderer(undefined) });
    vi.advanceTimersByTime(START_DELAY_MS - 1);
    expect(running()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(running()).toBe(true);
  });

  it('never starts without autoStart, even with a painted renderer whose ground is ready', () => {
    AutoStartHost({ worldRenderer: renderer(() => true), wantsAutoStart: false });
    vi.advanceTimersByTime(30_000);
    expect(running()).toBe(false);
    AutoStartHost({ worldRenderer: renderer(undefined), wantsAutoStart: false });
    vi.advanceTimersByTime(30_000);
    expect(running()).toBe(false);
  });

  it('never starts without a renderer, and fires only once', () => {
    AutoStartHost({ worldRenderer: null });
    vi.advanceTimersByTime(30_000);
    expect(running()).toBe(false);
    unmount();
    AutoStartHost({ worldRenderer: renderer(() => true) });
    vi.advanceTimersByTime(START_DELAY_MS);
    expect(running()).toBe(true);
    useRideStore.getState().pause();
    AutoStartHost({ worldRenderer: renderer(() => true), rideState: 'paused' });
    AutoStartHost({ worldRenderer: renderer(() => true), rideState: 'ready' });
    vi.advanceTimersByTime(30_000);
    expect(useRideStore.getState().rideState).toBe('paused');
  });

  it('pace partners picked on Home ride along when the start re-sets an idle ride\'s route', async () => {
    const { BOT_PRESETS, createPaceBot } = await import('@/lib/paceBots');
    useRideStore.getState().setPaceBots([createPaceBot('pace-steady', BOT_PRESETS[0])]);
    // The wizard's setRoute landed before /ride's own and left 'idle'.
    useRideStore.setState({ rideState: 'idle' });
    AutoStartHost({ worldRenderer: renderer() });
    vi.advanceTimersByTime(START_DELAY_MS + START_HOLD_POLL_MS);
    expect(running()).toBe(true);
    const bots = useRideStore.getState().paceBots;
    expect(bots.map((b) => b.id)).toEqual(['pace-steady']);
    expect(bots[0].state.distance).toBe(0);
  });

  it('leaving the ride view cancels a held start', () => {
    AutoStartHost({ worldRenderer: renderer(() => false) });
    vi.advanceTimersByTime(1000);
    unmount();
    vi.advanceTimersByTime(30_000);
    expect(running()).toBe(false);
  });

  it('Ride.tsx drives its auto-start through the hook with the renderer and the autoStart flag', () => {
    const src = readFileSync(join(resolve(__dirname, '../..'), 'src/routes/Ride.tsx'), 'utf8');
    const call = src.slice(src.indexOf('useRideAutoStart({'), src.indexOf('});', src.indexOf('useRideAutoStart({')));
    expect(call).toContain('useRideAutoStart({');
    expect(call).toContain('?.autoStart === true');
    expect(call).toMatch(/\n\s+worldRenderer,\n/);
    expect(src).not.toMatch(/getState\(\)\.start\(\)/);
  });
});

describe('ride auto-start timing: the tuning the start hold was measured for', () => {
  // World Terrain is assigned 0.7-2.6 s after the first paint on the owner's
  // loaded laptop (first paint ~2.9 s after /ride, target ~5 s to rolling),
  // and the ground there never gets plausible inside the cap.
  it.each([
    { terrainMs: 700, runningBy: 2_000 },
    { terrainMs: 1_600, runningBy: 2_000 },
    { terrainMs: 2_600, runningBy: 2_800 },
  ])(
    'laptop: World Terrain lands $terrainMs ms after the first paint, the ground never ready: rolling by $runningBy ms',
    ({ terrainMs, runningBy }) => {
      const paint = Date.now();
      const r = { groundReady: () => false, groundPending: () => Date.now() - paint < terrainMs } as unknown as WorldRenderer;
      AutoStartHost({ worldRenderer: r });
      vi.advanceTimersByTime(terrainMs - 1);
      // Nothing real drawn under the rider yet: it waits for the terrain.
      expect(running()).toBe(false);
      vi.advanceTimersByTime(runningBy - (terrainMs - 1));
      expect(running()).toBe(true);
    },
  );

  it('the held window fits between the first look and the cap, so a plausible ground can release the start', () => {
    expect(START_DELAY_MS + START_STABLE_MS + START_HOLD_POLL_MS).toBeLessThanOrEqual(START_HOLD_MAX_MS);
  });

  /**
   * The real StartGroundWatch fed every 16 ms frame (drawn globe = rider
   * ground, Trasimeno heights measured on the laptop) behind the renderer's
   * groundReady, as CesiumWorldView wires it. Returns when the ride started
   * (ms after the first paint) and whether the watch had released it.
   */
  async function rideOnWatch(drawnAt: (ms: number) => number): Promise<{ startedAt: number | null; byGround: boolean }> {
    const finest = 307.2;
    const watch = new StartGroundWatch(async () => finest);
    const paint = Date.now();
    const frame = () => {
      const ms = Date.now() - paint;
      const drawn = drawnAt(ms);
      watch.update(12.1, 43.2, drawn, drawn, ms);
    };
    frame();
    const frames = setInterval(frame, 16);
    let startedAt: number | null = null;
    let byGround = false;
    const unsubscribe = useRideStore.subscribe((s) => {
      if (startedAt !== null || s.rideState !== 'running') return;
      startedAt = Date.now() - paint;
      byGround = watch.ready;
    });
    const r = { groundReady: () => watch.ready, groundPending: () => false } as unknown as WorldRenderer;
    try {
      AutoStartHost({ worldRenderer: r });
      await vi.advanceTimersByTimeAsync(5_000);
    } finally {
      clearInterval(frames);
      unsubscribe();
    }
    return { startedAt, byGround };
  }

  it('fast machine, plausible ground from the first paint: the watch releases the start within a poll of the beat', async () => {
    // World Terrain is asked for before the Viewer is built, so it is the globe's terrain at the first paint.
    const { startedAt, byGround } = await rideOnWatch(() => 303.4); // 3.8 m under the finest: plausible
    expect(byGround).toBe(true);
    expect(startedAt).not.toBeNull();
    expect(startedAt!).toBeGreaterThanOrEqual(START_DELAY_MS);
    expect(startedAt!).toBeLessThanOrEqual(START_DELAY_MS + START_HOLD_POLL_MS);
  });

  it('a globe that refines into the window at the first look still releases the start before the cap', async () => {
    // A coarse chord (Trasimeno, 333.0 m over 307.2 m measured) until the beat ends, then in the window.
    const { startedAt, byGround } = await rideOnWatch((ms) => (ms < START_DELAY_MS ? 333.0 : 303.4));
    expect(byGround).toBe(true);
    expect(startedAt).not.toBeNull();
    expect(startedAt!).toBeLessThan(START_HOLD_MAX_MS);
  });
});
