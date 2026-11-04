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
    // The wizard's setRoute lands late: rideState flips, the effect re-runs.
    AutoStartHost({ worldRenderer: r, rideState: 'idle' });
    vi.advanceTimersByTime(START_DELAY_MS);
    expect(running()).toBe(true);
  });

  it('a renderer with nothing to stream starts after the short beat', () => {
    AutoStartHost({ worldRenderer: renderer(undefined) });
    vi.advanceTimersByTime(START_DELAY_MS - 1);
    expect(running()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(running()).toBe(true);
  });

  it('never starts without autoStart or a renderer, and fires only once', () => {
    AutoStartHost({ worldRenderer: renderer(() => true), wantsAutoStart: false });
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
