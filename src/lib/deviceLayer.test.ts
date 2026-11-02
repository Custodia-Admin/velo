/**
 * Device layer, end to end on the real FTMS client: a fake KICKR (no
 * Bluetooth), the real ride loop, the real TrainerEventBridge wiring and the
 * real ride store / FSM. React's hooks and requestAnimationFrame are stubbed
 * as in useRideLoop.fsm.test.ts.
 *
 * Pins the two P2.5 device rules:
 *   - a gattserverdisconnected mid-ride reconnects within 3 attempts, FTMS
 *     control is requested again, and the SIM grade is re-applied;
 *   - no resistance command (FTMS 0x05 / 0x11) ever reaches the trainer
 *     outside a ride the rider started, and outside the ride session there
 *     is no autonomous write at all: a drop is held for a tap (no retries,
 *     no 0x00 / 0x07 handshake), and leaving a ride mid-retry stops it.
 * Plus the wake watch: one browser watch per device (Chromium semantics
 * faked below), stopped once the trainer is back, never reported armed
 * when the browser refused it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Route } from '@/types';

const h = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }));

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

import { useRideLoop } from '@/hooks/useRideLoop';
import { TrainerEventBridge } from '@/components/trainer/TrainerEventBridge';
import { disconnect as ftmsDisconnect, isConnected, reconnectGranted, retainedTrainer } from '@/lib/ftms';
import {
  __resetTrainerReconnectForTests,
  armTrainerWake,
  reconnectGrantedTrainer,
  trainerWakeArmed,
  useTrainerReconnectStore,
} from '@/lib/trainerReconnect';
import { __resetRideSessionForTests, retainRideSession } from '@/lib/controllers/rideSession';
import { selectRideFsm, useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';

const CONTROL_POINT = '00002ad9-0000-1000-8000-00805f9b34fb';
const OP_REQUEST_CONTROL = 0x00;
const OP_START = 0x07;
const OP_TARGET_POWER = 0x05;
const OP_SIM = 0x11;
/** Ops that change resistance: never outside a riding ride. */
const RESISTANCE_OPS = new Set([OP_TARGET_POWER, OP_SIM]);

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

/** While set, every startNotifications() waits for it (a slow characteristic setup). */
const notifyHold: { p: Promise<void> | null } = { p: null };

class FakeChar extends EventTarget {
  value: DataView | undefined;
  writes: number[][] = [];
  async startNotifications() {
    if (notifyHold.p) await notifyHold.p;
    return this;
  }
  async writeValueWithResponse(b: BufferSource) {
    this.writes.push(Array.from(new Uint8Array(b as ArrayBuffer)));
  }
  async writeValue(b: BufferSource) {
    return this.writeValueWithResponse(b);
  }
  async readValue() {
    return new DataView(Uint8Array.of(64).buffer);
  }
}

/** A KICKR that can drop and refuse the next `failConnects` connects. */
function fakeKickr() {
  const chars = new Map<string, FakeChar>();
  const char = (u: string) => {
    if (!chars.has(u)) chars.set(u, new FakeChar());
    return chars.get(u)!;
  };
  const service = { getCharacteristic: async (u: string) => char(u) };
  const state = { failConnects: 0, connects: 0, hold: null as Promise<void> | null };
  const dev = new EventTarget() as EventTarget & {
    id: string;
    name: string;
    gatt: unknown;
    watchAdvertisements?: (o?: { signal?: AbortSignal }) => Promise<void>;
  };
  const gatt = {
    connected: false,
    connect: async () => {
      state.connects++;
      if (state.hold) await state.hold;
      if (state.failConnects > 0) {
        state.failConnects--;
        throw Object.assign(new Error('out of range'), { name: 'NetworkError' });
      }
      gatt.connected = true;
      return gatt;
    },
    disconnect: () => {
      gatt.connected = false;
    },
    getPrimaryService: async () => service,
  };
  dev.id = 'kickr-id';
  dev.name = 'KICKR CORE 78C1';
  dev.gatt = gatt;
  const cp = () => char(CONTROL_POINT);
  return {
    dev,
    state,
    cp,
    drop() {
      gatt.connected = false;
      dev.dispatchEvent(new Event('gattserverdisconnected'));
    },
    opsSince(i: number) {
      return cp().writes.slice(i).map((w) => w[0]);
    },
  };
}

const initialRide = useRideStore.getState();
const initialSettings = useSettingsStore.getState();

let clock = 1_000_000;
let rafQueue: FrameRequestCallback[] = [];

function frames(seconds: number, before?: () => void): void {
  const n = Math.round(seconds * 10);
  for (let i = 0; i < n; i++) {
    clock += 100;
    before?.();
    const q = rafQueue;
    rafQueue = [];
    for (const cb of q) cb(clock);
  }
}

const pedal = () => useRideStore.getState().ingestTrainerData({ speed: 7, power: 200, cadence: 85 });

/** Pair the fake trainer the way the one-tap reconnect does (no chooser). */
async function pair(k: ReturnType<typeof fakeKickr>): Promise<void> {
  await reconnectGranted(k.dev as unknown as BluetoothDevice);
  const st = useRideStore.getState();
  st.setConnection('connecting');
  st.setConnection('connected', { deviceName: 'KICKR CORE 78C1' });
  st.setMode('trainer');
}

/**
 * Chromium's per-device advert watch (bluetooth_device.cc): one watch per
 * BluetoothDevice; a call while one is pending rejects, a call while one is
 * active shares it, and aborting ANY caller's signal stops it for everyone.
 * `advert()` is delivered only while the browser is watching.
 */
function chromiumWatch(k: ReturnType<typeof fakeKickr>, opts: { refuse?: boolean } = {}) {
  const w = { calls: 0, watching: false, pending: false };
  k.dev.watchAdvertisements = (o) => {
    w.calls++;
    if (opts.refuse) return Promise.reject(Object.assign(new Error('flag off'), { name: 'NotSupportedError' }));
    if (w.pending) return Promise.reject(Object.assign(new Error('in progress'), { name: 'InvalidStateError' }));
    o?.signal?.addEventListener('abort', () => {
      w.watching = false;
    });
    if (w.watching) return Promise.resolve();
    w.pending = true;
    return Promise.resolve().then(() => {
      w.pending = false;
      w.watching = true;
    });
  };
  return {
    w,
    advert(): boolean {
      if (!w.watching) return false;
      k.dev.dispatchEvent(new Event('advertisementreceived'));
      return true;
    },
  };
}

/** The grade (percent) carried by a 0x11 SIM write. */
function gradeOf(write: number[]): number {
  return new DataView(Uint8Array.from(write).buffer).getInt16(3, true) / 100;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  __resetTrainerReconnectForTests();
  __resetRideSessionForTests();
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
  TrainerEventBridge();
  useRideLoop();
});

afterEach(async () => {
  for (const c of h.cleanups.splice(0)) c();
  await ftmsDisconnect().catch(() => undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('trainer reconnect mid-ride', () => {
  it('gattserverdisconnected → back within 3 attempts, control re-requested, SIM grade re-applied', async () => {
    const k = fakeKickr();
    useRideStore.getState().setRoute(route);
    await pair(k);
    retainRideSession();
    useRideStore.getState().start();
    frames(2, pedal);
    const simBefore = k.cp().writes.filter((w) => w[0] === OP_SIM);
    expect(simBefore.length).toBeGreaterThan(0);
    const gradeBefore = gradeOf(simBefore[simBefore.length - 1]);
    expect(gradeBefore).toBeGreaterThan(0);

    // The KICKR drops; its first reconnect attempt fails too.
    k.state.failConnects = 1;
    const connectsBefore = k.state.connects;
    const mark = k.cp().writes.length;
    k.drop();
    expect(useRideStore.getState().connection).toBe('reconnecting');
    frames(1, pedal);
    expect(selectRideFsm(useRideStore.getState())).toMatchObject({ phase: 'riding', trainer: 'lost' });
    expect(k.opsSince(mark)).toEqual([]); // nothing to talk to while lost

    await vi.advanceTimersByTimeAsync(600 + 1200 + 50);
    const attempts = k.state.connects - connectsBefore;
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(attempts).toBeLessThanOrEqual(3);
    expect(isConnected()).toBe(true);
    expect(useRideStore.getState().connection).toBe('connected');
    // FTMS control requested again before anything else.
    expect(k.opsSince(mark)).toEqual([OP_REQUEST_CONTROL, OP_START]);

    // The next ride frame re-applies the road at once.
    const mark2 = k.cp().writes.length;
    frames(0.1, pedal);
    const after = k.cp().writes.slice(mark2);
    expect(after.map((w) => w[0])).toEqual([OP_SIM]);
    expect(gradeOf(after[0])).toBeCloseTo(gradeBefore, 1);
    expect(useRideStore.getState().rideState).toBe('running');
  });

  it('out of retries mid-ride: demo keeps the ride going, then the trainer comes back on wake', async () => {
    const k = fakeKickr();
    let watched = 0;
    k.dev.watchAdvertisements = async () => {
      watched++;
    };
    useRideStore.getState().setRoute(route);
    await pair(k);
    retainRideSession();
    useRideStore.getState().start();
    frames(1, pedal);

    k.state.failConnects = 99;
    k.drop();
    await vi.advanceTimersByTimeAsync(600 + 1200 + 2400 + 4000 + 50);
    let st = useRideStore.getState();
    expect(st.connection).toBe('disconnected');
    expect(st.mode).toBe('demo');
    expect(retainedTrainer()).toBe(k.dev);
    expect(useTrainerReconnectStore.getState()).toMatchObject({ phase: 'available', name: 'KICKR CORE 78C1' });
    expect(watched).toBe(1); // waiting for the first pedal stroke

    // Pedal stroke: the KICKR advertises again.
    k.state.failConnects = 0;
    const mark = k.cp().writes.length;
    k.dev.dispatchEvent(new Event('advertisementreceived'));
    await vi.advanceTimersByTimeAsync(10);
    st = useRideStore.getState();
    expect(st.connection).toBe('connected');
    expect(st.mode).toBe('trainer');
    expect(k.opsSince(mark)).toEqual([OP_REQUEST_CONTROL, OP_START]);
    frames(0.1, pedal);
    expect(k.opsSince(mark)).toEqual([OP_REQUEST_CONTROL, OP_START, OP_SIM]);
  });
});

describe('no resistance command outside a rider-started ride', () => {
  it('paired but not started, finished, or reconnected by a tap: never 0x05 / 0x11', async () => {
    const k = fakeKickr();
    useRideStore.getState().setRoute(route);
    await pair(k);
    expect(k.opsSince(0)).toEqual([OP_REQUEST_CONTROL, OP_START]); // the pairing handshake only

    // Ready, rider pedalling, nobody pressed Start.
    frames(5, pedal);
    expect(k.opsSince(0).filter((op) => RESISTANCE_OPS.has(op))).toEqual([]);

    // A drop while no ride is open is held for a tap; the tap reconnects.
    k.drop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(useRideStore.getState().connection).toBe('disconnected');
    expect(await reconnectGrantedTrainer()).toBe(true);
    expect(useRideStore.getState().connection).toBe('connected');
    frames(3, pedal);
    expect(k.opsSince(0).filter((op) => RESISTANCE_OPS.has(op))).toEqual([]);

    // Start → commands flow; finish → they stop.
    useRideStore.getState().start();
    frames(2, pedal);
    expect(k.opsSince(0).filter((op) => op === OP_SIM).length).toBeGreaterThan(0);
    useRideStore.getState().pause();
    useRideStore.getState().finish();
    const mark = k.cp().writes.length;
    frames(5, pedal);
    expect(k.opsSince(mark).filter((op) => RESISTANCE_OPS.has(op))).toEqual([]);
  });
});

describe('no autonomous write outside the ride session', () => {
  it('a drop with no ride open: zero reconnect attempts, zero writes; a tap on Reconnect still works', async () => {
    const k = fakeKickr();
    await pair(k);
    const connects = k.state.connects;
    const mark = k.cp().writes.length;
    k.drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(k.state.connects).toBe(connects); // no gatt.connect() at all
    expect(k.opsSince(mark)).toEqual([]); // no 0x00 / 0x07 handshake
    expect(useRideStore.getState().connection).toBe('disconnected');
    expect(retainedTrainer()).toBe(k.dev);
    expect(useTrainerReconnectStore.getState()).toMatchObject({ phase: 'available', name: 'KICKR CORE 78C1' });
    expect(useRideStore.getState().toasts.at(-1)).toMatchObject({ title: 'Trainer disconnected' });

    // The rider taps Reconnect: the handshake, nothing else.
    expect(await reconnectGrantedTrainer()).toBe(true);
    expect(k.opsSince(mark)).toEqual([OP_REQUEST_CONTROL, OP_START]);
    expect(isConnected()).toBe(true);
  });

  it('leaving the ride mid-retry stops the retries before their next attempt', async () => {
    const k = fakeKickr();
    await pair(k);
    const release = retainRideSession();
    k.state.failConnects = 1;
    k.drop();
    expect(useRideStore.getState().connection).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(600 + 50); // attempt 1 fails
    const connects = k.state.connects;
    const mark = k.cp().writes.length;
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(k.state.connects).toBe(connects);
    expect(k.opsSince(mark)).toEqual([]);
    expect(useRideStore.getState().connection).toBe('disconnected');
    expect(retainedTrainer()).toBe(k.dev);
  });

  it('leaving the ride while a retry is connecting: no 0x00 / 0x07 once it connects', async () => {
    const k = fakeKickr();
    await pair(k);
    const release = retainRideSession();
    let letConnect: () => void = () => undefined;
    k.state.hold = new Promise<void>((r) => {
      letConnect = r;
    });
    const mark = k.cp().writes.length;
    k.drop();
    await vi.advanceTimersByTimeAsync(600 + 50); // attempt 1 is waiting on gatt.connect()
    release();
    k.state.hold = null;
    letConnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(k.opsSince(mark)).toEqual([]);
    expect(isConnected()).toBe(false);
    expect(useRideStore.getState().connection).toBe('disconnected');
  });

  it('leaving the ride during the characteristic setup of a retry: still no 0x00 / 0x07', async () => {
    const k = fakeKickr();
    await pair(k);
    const release = retainRideSession();
    let letNotify: () => void = () => undefined;
    notifyHold.p = new Promise<void>((r) => {
      letNotify = r;
    });
    const mark = k.cp().writes.length;
    k.drop();
    await vi.advanceTimersByTimeAsync(600 + 50); // attempt 1: connected, subscribing
    release();
    notifyHold.p = null;
    letNotify();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(k.opsSince(mark)).toEqual([]);
    expect(isConnected()).toBe(false);
    expect(useRideStore.getState().connection).toBe('disconnected');
  });

  it('a trainer lost outside the ride session is not woken by itself', async () => {
    const k = fakeKickr();
    const chrome = chromiumWatch(k);
    await pair(k);
    k.drop();
    await vi.advanceTimersByTimeAsync(10);
    expect(useRideStore.getState().connection).toBe('disconnected');
    expect(chrome.w.calls).toBe(0);
    expect(await armTrainerWake()).toBe(false);

    // Opening a ride arms it; closing the ride disarms it.
    const release = retainRideSession();
    await vi.advanceTimersByTimeAsync(0);
    expect(chrome.w.watching).toBe(true);
    release();
    expect(chrome.w.watching).toBe(false);
    const mark = k.cp().writes.length;
    k.dev.dispatchEvent(new Event('advertisementreceived'));
    await vi.advanceTimersByTimeAsync(10);
    expect(k.opsSince(mark)).toEqual([]);
    expect(useRideStore.getState().connection).toBe('disconnected');
  });
});

describe('trainer wake watch', () => {
  it('asleep when the ride opens: the ride-start reconnect and the wake watch share one watch, and a pedal stroke brings it back', async () => {
    const k = fakeKickr();
    const chrome = chromiumWatch(k);
    useRideStore.getState().setRoute(route);
    await pair(k);
    k.drop(); // fell asleep on Home: held for a tap
    await vi.advanceTimersByTimeAsync(10);

    // The Ride page opens: session first, then the silent ride-start reconnect.
    k.state.failConnects = 2; // asleep: the direct try and the post-advert try fail
    retainRideSession();
    const rideStart = reconnectGrantedTrainer({ silent: true });
    await vi.advanceTimersByTimeAsync(6_000 + 50); // its advert wait runs out
    expect(await rideStart).toBe(false);
    expect(chrome.w.calls).toBe(1); // one browser watch, shared
    expect(chrome.w.watching).toBe(true); // the wait ending did not kill the wake watch
    expect(trainerWakeArmed()).toBe(true);

    // Pedal stroke.
    const mark = k.cp().writes.length;
    expect(chrome.advert()).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(useRideStore.getState().connection).toBe('connected');
    expect(k.opsSince(mark)).toEqual([OP_REQUEST_CONTROL, OP_START]);
    // Connected: no scanning through the ride.
    expect(chrome.w.watching).toBe(false);
    expect(trainerWakeArmed()).toBe(false);
  });

  it('found on Home, connected by the ride-start reconnect: the wake watch armed at ride open is stopped', async () => {
    const k = fakeKickr();
    const chrome = chromiumWatch(k);
    await pair(k);
    k.drop();
    await vi.advanceTimersByTimeAsync(10);
    retainRideSession();
    await vi.advanceTimersByTimeAsync(0);
    expect(chrome.w.watching).toBe(true);
    expect(await reconnectGrantedTrainer({ silent: true })).toBe(true);
    expect(chrome.w.watching).toBe(false);
    expect(trainerWakeArmed()).toBe(false);
  });

  it('the browser refuses the watch: not armed, and the rider is told to tap Reconnect', async () => {
    const k = fakeKickr();
    chromiumWatch(k, { refuse: true });
    useRideStore.getState().setRoute(route);
    await pair(k);
    retainRideSession();
    useRideStore.getState().start();
    frames(1, pedal);
    k.state.failConnects = 99;
    k.drop();
    await vi.advanceTimersByTimeAsync(600 + 1200 + 2400 + 4000 + 50);
    expect(useRideStore.getState().connection).toBe('disconnected');
    expect(trainerWakeArmed()).toBe(false);
    expect(await armTrainerWake()).toBe(false);
    const toast = useRideStore.getState().toasts.find((t) => t.id === 'trainer-connection');
    expect(toast?.message).toMatch(/tap Reconnect/);
    expect(toast?.message).not.toMatch(/by itself/);
  });
});
