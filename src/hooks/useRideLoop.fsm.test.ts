/**
 * useRideLoop driven frame by frame against the real store and FSM, with
 * React's hooks and requestAnimationFrame stubbed and the FTMS command
 * functions mocked. No Bluetooth is touched: setSimulationParams /
 * setTargetPower are vi.fn()s that only record their arguments.
 *
 * These are the loop-level regression tests for the 30 Oct ride.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Route } from '@/types';

const h = vi.hoisted(() => ({
  cleanups: [] as Array<() => void>,
  sim: vi.fn((..._args: unknown[]) => Promise.resolve()),
  erg: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));

vi.mock('react', async (orig) => {
  const react = await orig<typeof import('react')>();
  return {
    ...react,
    useRef: <T,>(v: T) => ({ current: v }),
    useEffect: (fn: () => void | (() => void)) => {
      const c = fn();
      if (typeof c === 'function') h.cleanups.push(c);
    },
  };
});

vi.mock('@/lib/ftms', async (orig) => ({
  ...(await orig<typeof import('@/lib/ftms')>()),
  setSimulationParams: h.sim,
  setTargetPower: h.erg,
}));

import { useRideLoop } from './useRideLoop';
import { selectRideFsm, useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';

// 10 km at a steady 3 %.
const route: Route = {
  id: 'climb',
  name: 'climb',
  points: [
    { lat: 0, lon: 0, ele: 0, distance: 0 },
    { lat: 0.0899, lon: 0, ele: 300, distance: 10_000 },
  ],
  totalDistance: 10_000,
  ascent: 300,
  descent: 0,
  minElevation: 0,
  maxElevation: 300,
  loadedAt: 0,
};

const initialRide = useRideStore.getState();
const initialSettings = useSettingsStore.getState();

let clock = 1_000_000;
let rafQueue: FrameRequestCallback[] = [];

/** Advance `seconds` of 100 ms frames; `before` runs ahead of each frame (trainer notifications). */
function frames(seconds: number, before?: (tSec: number) => void): void {
  const n = Math.round(seconds * 10);
  for (let i = 0; i < n; i++) {
    clock += 100;
    before?.(i / 10);
    const q = rafQueue;
    rafQueue = [];
    for (const cb of q) cb(clock);
  }
}

function connectTrainer(): void {
  const st = useRideStore.getState();
  st.setConnection('connecting');
  st.setConnection('connected', { deviceName: 'KICKR CORE 78C1' });
  st.setMode('trainer');
}

beforeEach(() => {
  clock = 1_000_000;
  rafQueue = [];
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    rafQueue = [];
  });
  useRideStore.setState(initialRide, true);
  useSettingsStore.setState(
    {
      ...initialSettings,
      liveWeatherEnabled: false,
      liveCommentaryEnabled: false,
      climbAnnouncementsEnabled: false,
      indoorAutoPause: false,
    },
    true,
  );
  h.sim.mockClear();
  h.erg.mockClear();
  useRideLoop();
});

afterEach(() => {
  for (const c of h.cleanups.splice(0)) c();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useRideLoop × rideFsm — 30 Oct regressions', () => {
  it('standstill: a paired trainer at 0 W for 5 s keeps riding, speed decays to 0, no demo power, no auto-pause', () => {
    useRideStore.getState().setRoute(route);
    connectTrainer();
    useRideStore.getState().start();

    // The rider stops pedalling: the flywheel spins down over 4 s, then 0.
    const speedAt = (t: number) => Math.max(0, 8 - 2 * t);
    let maxSpeed = 0;
    frames(4, (t) => useRideStore.getState().ingestTrainerData({ speed: speedAt(t), power: 0, cadence: 0 }));
    const distAfterSpinDown = useRideStore.getState().distance;
    frames(6, () => {
      useRideStore.getState().ingestTrainerData({ speed: 0, power: 0, cadence: 0 });
      maxSpeed = Math.max(maxSpeed, useRideStore.getState().speed);
    });

    const st = useRideStore.getState();
    expect(st.rideState).toBe('running');
    expect(selectRideFsm(st)).toEqual({ phase: 'riding', source: 'trainer', trainer: 'connected' });
    expect(st.speed).toBe(0);
    expect(maxSpeed).toBe(0);
    expect(st.power).toBe(0); // never the 190 W demo power
    expect(st.distance).toBeCloseTo(distAfterSpinDown, 6); // stopped means stopped
    expect(st.distance).toBeGreaterThan(0);
    // The trainer keeps getting the road while the rider stands on it.
    expect(h.sim).toHaveBeenCalled();
  });

  it('standstill with indoor auto-pause ON: pauses after 5 s stopped, resumes on pedalling', () => {
    useSettingsStore.setState({ indoorAutoPause: true });
    useRideStore.getState().setRoute(route);
    connectTrainer();
    useRideStore.getState().start();

    frames(4.8, () => useRideStore.getState().ingestTrainerData({ speed: 0, power: 0 }));
    expect(useRideStore.getState().rideState).toBe('running');
    frames(0.5, () => useRideStore.getState().ingestTrainerData({ speed: 0, power: 0 }));
    expect(useRideStore.getState().rideState).toBe('paused');

    frames(1, () => useRideStore.getState().ingestTrainerData({ speed: 2, power: 150 }));
    expect(useRideStore.getState().rideState).toBe('running');
  });

  it('pause/resume: FTMS resistance is held while paused and restored on the first frame after resume', () => {
    useRideStore.getState().setRoute(route);
    connectTrainer();
    useRideStore.getState().start();
    frames(3, () => useRideStore.getState().ingestTrainerData({ speed: 8, power: 220, cadence: 90 }));
    expect(h.sim).toHaveBeenCalled();
    const lastBeforePause = h.sim.mock.calls.at(-1)?.[0] as { gradePct: number };
    expect(lastBeforePause.gradePct).toBeGreaterThan(0);

    useRideStore.getState().pause();
    h.sim.mockClear();
    frames(5, () => useRideStore.getState().ingestTrainerData({ speed: 0, power: 0 }));
    expect(useRideStore.getState().rideState).toBe('paused');
    expect(h.sim).not.toHaveBeenCalled(); // held: no command, the trainer keeps its resistance
    expect(h.erg).not.toHaveBeenCalled();

    useRideStore.getState().resume();
    frames(0.1, () => useRideStore.getState().ingestTrainerData({ speed: 8, power: 220 }));
    expect(h.sim).toHaveBeenCalledTimes(1); // restored on the first riding frame
    const restored = h.sim.mock.calls[0][0] as { gradePct: number };
    expect(restored.gradePct).toBeCloseTo(lastBeforePause.gradePct, 1);
  });

  it('pause/resume inside the throttle window still restores resistance at once', () => {
    useRideStore.getState().setRoute(route);
    connectTrainer();
    useRideStore.getState().start();
    const pedal = () => useRideStore.getState().ingestTrainerData({ speed: 8, power: 220 });
    frames(3, pedal);
    // Wait for a command, then stop right after it.
    h.sim.mockClear();
    for (let i = 0; i < 20 && h.sim.mock.calls.length === 0; i++) frames(0.1, pedal);
    expect(h.sim).toHaveBeenCalledTimes(1);
    h.sim.mockClear();

    useRideStore.getState().pause(); // e.g. a quick double-tap on the bars
    frames(0.3);
    useRideStore.getState().resume();
    frames(0.1, pedal); // 0.4 s after the last command: the throttle alone would wait
    expect(h.sim).toHaveBeenCalledTimes(1);
  });

  it('trainer disconnect mid-ride → trainer:lost, ride keeps riding on physics with the HUD reconnecting; reconnect restores without a second start', () => {
    useRideStore.getState().setRoute(route);
    connectTrainer();
    useRideStore.getState().start();
    const startedAt = useRideStore.getState().startedAt;
    frames(2, () => useRideStore.getState().ingestTrainerData({ speed: 8, power: 200, cadence: 90 }));

    // What TrainerEventBridge does on an unexpected GATT drop.
    useRideStore.getState().setConnection('reconnecting', { error: 'Trainer dropped' });
    h.sim.mockClear();
    const d0 = useRideStore.getState().distance;
    const phases = new Set<string>();
    frames(3, () => phases.add(useRideStore.getState().rideState));

    let st = useRideStore.getState();
    expect(selectRideFsm(st)).toEqual({ phase: 'riding', source: 'trainer', trainer: 'lost' });
    expect([...phases]).toEqual(['running']);
    expect(st.connection).toBe('reconnecting'); // the HUD chip's state
    expect(st.distance).toBeGreaterThan(d0 + 5); // still moving…
    expect(st.power).toBe(200); // …on the trainer's last power, not 190 W demo
    expect(st.speed).toBeGreaterThan(1);
    expect(st.speed).toBeLessThan(8); // physics up a 3 % grade at 200 W, not the frozen 8 m/s
    expect(h.sim).not.toHaveBeenCalled(); // nothing to talk to

    // The reconnect loop succeeds.
    useRideStore.getState().setConnection('connected', { deviceName: st.deviceName });
    frames(0.1, () => useRideStore.getState().ingestTrainerData({ speed: 7, power: 200 }));
    st = useRideStore.getState();
    expect(selectRideFsm(st).trainer).toBe('connected');
    expect(st.rideState).toBe('running');
    expect(st.startedAt).toBe(startedAt); // no second start
    expect(h.sim).toHaveBeenCalledTimes(1); // resistance restored at once
  });

  it('a stopped rider whose trainer drops (KICKR sleeping) stays stopped — no creep, no demo power', () => {
    useRideStore.getState().setRoute(route);
    connectTrainer();
    useRideStore.getState().start();
    frames(2, () => useRideStore.getState().ingestTrainerData({ speed: 0, power: 0 }));
    useRideStore.getState().setConnection('reconnecting');
    const d0 = useRideStore.getState().distance;
    frames(5);
    const st = useRideStore.getState();
    expect(st.rideState).toBe('running');
    expect(st.speed).toBe(0);
    expect(st.distance).toBe(d0);
  });

  it('demo → trainer swap while ready: stays ready, no commands until the ride starts, then the trainer drives', () => {
    useRideStore.getState().setMode('demo');
    useRideStore.getState().setRoute(route);
    expect(selectRideFsm(useRideStore.getState())).toEqual({ phase: 'ready', source: 'demo', trainer: 'disconnected' });

    connectTrainer();
    expect(selectRideFsm(useRideStore.getState())).toEqual({ phase: 'ready', source: 'trainer', trainer: 'connected' });
    frames(2);
    expect(useRideStore.getState().rideState).toBe('ready');
    expect(h.sim).not.toHaveBeenCalled();

    useRideStore.getState().start();
    frames(1, () => useRideStore.getState().ingestTrainerData({ speed: 0, power: 0 }));
    expect(h.sim).toHaveBeenCalled();
    expect(useRideStore.getState().speed).toBe(0); // the trainer, not demo physics
  });

  it('Demo Mode ride with a paired trainer sends no trainer commands', () => {
    useRideStore.getState().setRoute(route);
    connectTrainer();
    useRideStore.getState().setMode('demo');
    useRideStore.getState().start();
    frames(2);
    expect(h.sim).not.toHaveBeenCalled();
    expect(useRideStore.getState().power).toBe(190);
  });
});
