import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  INITIAL_RECONNECT,
  RECONNECT_FAILED_TEXT,
  __resetTrainerReconnectForTests,
  checkGrantedTrainer,
  reconnectGrantedTrainer,
  reconnectLabel,
  reconnectReducer,
  useTrainerReconnectStore,
  type ReconnectState,
} from './trainerReconnect';
import { disconnect as ftmsDisconnect, isConnected } from './ftms';
import { useRideStore } from '@/stores/rideStore';

// ---- pure state machine ----------------------------------------------------

describe('reconnectReducer', () => {
  const avail: ReconnectState = { phase: 'available', name: 'KICKR CORE 78C1' };

  it('unchecked → available when a granted trainer exists, none otherwise', () => {
    expect(reconnectReducer(INITIAL_RECONNECT, { type: 'checked', found: true, name: 'KICKR CORE 78C1' })).toEqual(avail);
    expect(reconnectReducer(INITIAL_RECONNECT, { type: 'checked', found: false, name: null })).toEqual({ phase: 'none', name: null });
  });

  it('available → reconnecting → connected', () => {
    const r = reconnectReducer(avail, { type: 'start' });
    expect(r.phase).toBe('reconnecting');
    expect(reconnectReducer(r, { type: 'success' })).toEqual({ phase: 'connected', name: 'KICKR CORE 78C1' });
  });

  it('reconnecting → failed, and failed can retry', () => {
    const failed = reconnectReducer(reconnectReducer(avail, { type: 'start' }), { type: 'fail' });
    expect(failed.phase).toBe('failed');
    expect(reconnectReducer(failed, { type: 'start' }).phase).toBe('reconnecting');
  });

  it('start is ignored without a granted trainer', () => {
    const none: ReconnectState = { phase: 'none', name: null };
    expect(reconnectReducer(none, { type: 'start' })).toBe(none);
  });

  it('a late check never overrides a live link or an attempt in flight', () => {
    const live: ReconnectState = { phase: 'connected', name: 'KICKR CORE 78C1' };
    expect(reconnectReducer(live, { type: 'checked', found: false, name: null })).toBe(live);
    const busy: ReconnectState = { phase: 'reconnecting', name: 'KICKR CORE 78C1' };
    expect(reconnectReducer(busy, { type: 'checked', found: false, name: null })).toBe(busy);
  });

  it('chooser pairing counts as connected; a user disconnect offers reconnect again', () => {
    const paired = reconnectReducer({ phase: 'none', name: null }, { type: 'paired' });
    expect(paired.phase).toBe('connected');
    expect(reconnectReducer(avail, { type: 'disconnected' })).toEqual(avail);
    expect(reconnectReducer({ phase: 'connected', name: null }, { type: 'disconnected' }).phase).toBe('none');
  });

  it('copy', () => {
    expect(reconnectLabel('KICKR CORE 78C1')).toBe('Reconnect KICKR CORE 78C1');
    expect(reconnectLabel(null)).toBe('Reconnect trainer');
    expect(RECONNECT_FAILED_TEXT).toMatch(/Pair trainer/);
  });
});

// ---- orchestration against a fake granted trainer -------------------------

class FakeChar extends EventTarget {
  value: DataView | undefined;
  writes: number[][] = [];
  async startNotifications() {
    return this;
  }
  async writeValueWithResponse(b: BufferSource) {
    this.writes.push(Array.from(new Uint8Array(b as ArrayBuffer)));
  }
  async writeValue(b: BufferSource) {
    return this.writeValueWithResponse(b);
  }
  async readValue() {
    return new DataView(Uint8Array.of(90).buffer);
  }
}

function fakeTrainer(opts: { id?: string; name?: string; failConnects?: number } = {}) {
  let fails = opts.failConnects ?? 0;
  const chars = new Map<string, FakeChar>();
  const char = (u: string) => {
    if (!chars.has(u)) chars.set(u, new FakeChar());
    return chars.get(u)!;
  };
  const service = { getCharacteristic: async (u: string) => char(u) };
  const dev = new EventTarget() as EventTarget & {
    id: string;
    name: string;
    gatt: unknown;
    watchAdvertisements?: () => Promise<void>;
  };
  const gatt = {
    connected: false,
    connect: async () => {
      if (fails > 0) {
        fails--;
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
  dev.id = opts.id ?? 'kickr-id';
  dev.name = opts.name ?? 'KICKR CORE 78C1';
  dev.gatt = gatt;
  return { dev, gatt, chars };
}

const storage = new Map<string, string>();

function stubBrowser(devices: unknown[] | null) {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal('navigator', {
    bluetooth: devices === null ? { requestDevice: async () => undefined } : { getDevices: async () => devices },
  });
}

beforeEach(() => {
  storage.clear();
  __resetTrainerReconnectForTests();
  useRideStore.getState().setConnection('disconnected', { deviceName: null });
});

afterEach(async () => {
  await ftmsDisconnect().catch(() => undefined);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const phase = () => useTrainerReconnectStore.getState().phase;

describe('reconnectGrantedTrainer', () => {
  it('no getDevices (flag off): nothing offered, chooser only', async () => {
    stubBrowser(null);
    storage.set('velo.lastTrainer', JSON.stringify({ id: 'kickr-id', name: 'KICKR CORE 78C1' }));
    await checkGrantedTrainer();
    expect(phase()).toBe('none');
    expect(await reconnectGrantedTrainer({ silent: true })).toBe(false);
  });

  it('nothing paired before: nothing offered even if other devices are granted', async () => {
    stubBrowser([fakeTrainer({ id: 'ride-left', name: 'Zwift Ride' }).dev]);
    await checkGrantedTrainer();
    expect(phase()).toBe('none');
  });

  it('offers the trainer paired last, then reconnects it silently on ride start', async () => {
    const { dev } = fakeTrainer();
    stubBrowser([fakeTrainer({ id: 'ride-left', name: 'Zwift Ride' }).dev, dev]);
    storage.set('velo.lastTrainer', JSON.stringify({ id: 'kickr-id', name: 'KICKR CORE 78C1' }));
    await checkGrantedTrainer();
    expect(useTrainerReconnectStore.getState()).toMatchObject({ phase: 'available', name: 'KICKR CORE 78C1' });

    expect(await reconnectGrantedTrainer({ silent: true })).toBe(true);
    expect(phase()).toBe('connected');
    expect(isConnected()).toBe(true);
    const ride = useRideStore.getState();
    expect(ride.connection).toBe('connected');
    expect(ride.deviceName).toBe('KICKR CORE 78C1');
    expect(ride.mode).toBe('trainer');
  });

  it('first GATT attempt fails: waits for an advert and retries once', async () => {
    const { dev } = fakeTrainer({ failConnects: 1 });
    let watched = 0;
    dev.watchAdvertisements = async () => {
      watched++;
      setTimeout(() => dev.dispatchEvent(new Event('advertisementreceived')), 10);
    };
    stubBrowser([dev]);
    storage.set('velo.lastTrainer', JSON.stringify({ id: 'kickr-id', name: 'KICKR CORE 78C1' }));
    expect(await reconnectGrantedTrainer()).toBe(true);
    expect(watched).toBe(1);
    expect(phase()).toBe('connected');
  });

  it('trainer out of reach: failed, panel back to a clean chooser fallback', async () => {
    const { dev } = fakeTrainer({ failConnects: 5 });
    stubBrowser([dev]);
    storage.set('velo.lastTrainer', JSON.stringify({ id: 'kickr-id', name: 'KICKR CORE 78C1' }));
    expect(await reconnectGrantedTrainer()).toBe(false);
    expect(phase()).toBe('failed');
    expect(useRideStore.getState().connection).toBe('disconnected');
    expect(isConnected()).toBe(false);
    // A silent ride-start attempt does not hammer it again; the rider can tap.
    expect(await reconnectGrantedTrainer({ silent: true })).toBe(false);
  });

  it('does nothing when the trainer is already connected', async () => {
    const { dev } = fakeTrainer();
    stubBrowser([dev]);
    storage.set('velo.lastTrainer', JSON.stringify({ id: 'kickr-id', name: 'KICKR CORE 78C1' }));
    useRideStore.getState().setConnection('connected', { deviceName: 'KICKR CORE 78C1' });
    expect(await reconnectGrantedTrainer({ silent: true })).toBe(true);
    expect(phase()).toBe('available');
  });
});
