import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectRideFsm, useRideStore } from '@/stores/rideStore';
import { IllegalRideTransition } from '@/lib/ride/rideFsm';
import type { Route } from '@/types';

const route: Route = {
  id: 'r',
  name: 'r',
  points: [
    { lat: 0, lon: 0, ele: 0, distance: 0 },
    { lat: 0, lon: 0, ele: 0, distance: 1000 },
  ],
  totalDistance: 1000,
  ascent: 0,
  descent: 0,
  minElevation: 0,
  maxElevation: 0,
  loadedAt: 0,
};

const initial = useRideStore.getState();
const fsm = () => selectRideFsm(useRideStore.getState());

beforeEach(() => {
  useRideStore.setState(initial, true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('rideStore delegates lifecycle transitions to the ride FSM', () => {
  it('mirrors the store fields as FSM state', () => {
    expect(fsm()).toEqual({ phase: 'idle', source: 'trainer', trainer: 'disconnected' });
    useRideStore.getState().setRoute(route);
    useRideStore.getState().start();
    expect(useRideStore.getState().rideState).toBe('running'); // HUD string unchanged
    expect(fsm().phase).toBe('riding');
  });

  it('ignores pause/resume/start requests that do not apply (toggles from many inputs)', () => {
    const st = useRideStore.getState();
    st.setRoute(route);
    expect(() => st.pause()).not.toThrow();
    expect(() => st.resume()).not.toThrow();
    expect(useRideStore.getState().rideState).toBe('ready');
    st.start();
    expect(() => useRideStore.getState().start()).not.toThrow();
    expect(useRideStore.getState().rideState).toBe('running');
  });

  it('finishing a ride that never started throws in dev and leaves the state', () => {
    useRideStore.getState().setRoute(route);
    expect(() => useRideStore.getState().finish()).toThrow(IllegalRideTransition);
    expect(useRideStore.getState().rideState).toBe('ready');
  });

  it('in production an illegal transition is a no-op', () => {
    vi.stubEnv('DEV', false);
    useRideStore.getState().setRoute(route);
    expect(() => useRideStore.getState().finish()).not.toThrow();
    expect(useRideStore.getState().rideState).toBe('ready');
    useRideStore.getState().start();
    expect(() => useRideStore.getState().setRideMode('outdoor')).not.toThrow();
    expect(useRideStore.getState().rideMode).toBe('trainer');
  });

  it('finish is idempotent once finished (route end + a Finish request)', () => {
    const st = useRideStore.getState();
    st.setRoute(route);
    st.start();
    st.finish();
    expect(() => useRideStore.getState().finish()).not.toThrow();
    expect(useRideStore.getState().rideState).toBe('finished');
  });

  it('reaching the route end finishes through the FSM', () => {
    const st = useRideStore.getState();
    st.setRoute(route);
    st.start();
    useRideStore.getState().tick({
      now: 0, dt: 1, gradeNow: 0, elevationNow: 0, speedNow: 2000,
      positionNow: { lat: 0, lon: 0 }, recordSample: false,
      cadenceNow: null, powerNow: null, heartRateNow: null,
    });
    expect(useRideStore.getState().rideState).toBe('finished');
  });

  it('an outdoor GPS ride cannot become a trainer ride half way (dev throws)', () => {
    const st = useRideStore.getState();
    st.setRoute(route);
    st.start();
    expect(() => useRideStore.getState().setRideMode('outdoor')).toThrow(IllegalRideTransition);
    expect(useRideStore.getState().rideMode).toBe('trainer');
  });

  it('trainer ↔ demo may swap mid-ride', () => {
    const st = useRideStore.getState();
    st.setRoute(route);
    st.start();
    useRideStore.getState().setMode('demo');
    expect(fsm()).toMatchObject({ phase: 'riding', source: 'demo' });
    useRideStore.getState().setMode('trainer');
    expect(fsm()).toMatchObject({ phase: 'riding', source: 'trainer' });
  });

  it('auto-reconnect failing mid-ride falls back to demo without ending the ride', () => {
    const st = useRideStore.getState();
    st.setRoute(route);
    st.setConnection('connected', { deviceName: 'KICKR' });
    st.start();
    useRideStore.getState().setConnection('reconnecting');
    expect(fsm()).toEqual({ phase: 'riding', source: 'trainer', trainer: 'lost' });
    // TrainerEventBridge 'failed' phase.
    useRideStore.getState().setConnection('disconnected', { deviceName: null, code: 'reconnect-failed' });
    useRideStore.getState().setMode('demo');
    expect(fsm()).toEqual({ phase: 'riding', source: 'demo', trainer: 'disconnected' });
    expect(useRideStore.getState().rideState).toBe('running');
  });

  it('loading or clearing a route abandons a ride in any phase', () => {
    for (const phase of ['ready', 'running', 'paused', 'finished'] as const) {
      useRideStore.setState(initial, true);
      const st = useRideStore.getState();
      st.setRoute(route);
      if (phase !== 'ready') st.start();
      if (phase === 'paused') useRideStore.getState().pause();
      if (phase === 'finished') useRideStore.getState().finish();
      expect(useRideStore.getState().rideState).toBe(phase);
      useRideStore.getState().setRoute(route);
      expect(fsm().phase).toBe('ready');
      useRideStore.getState().setRoute(null);
      expect(fsm().phase).toBe('idle');
    }
  });

  it('prepare re-arms a finished ride', () => {
    const st = useRideStore.getState();
    st.setRoute(route);
    st.start();
    useRideStore.getState().finish();
    useRideStore.getState().prepare();
    expect(useRideStore.getState().rideState).toBe('ready');
  });

  it('demo → trainer swap while ready stays ready', () => {
    const st = useRideStore.getState();
    st.setMode('demo');
    st.setRoute(route);
    useRideStore.getState().setConnection('connecting');
    useRideStore.getState().setConnection('connected', { deviceName: 'KICKR' });
    useRideStore.getState().setMode('trainer');
    expect(fsm()).toEqual({ phase: 'ready', source: 'trainer', trainer: 'connected' });
    expect(useRideStore.getState().startedAt).toBeNull();
  });
});
