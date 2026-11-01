import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CONTROLLER_RETRY_DELAYS_MS,
  TRAINER_RETRY_DELAYS_MS,
  backoffDelays,
  canWatchForWake,
  findGrantedDevice,
  forgetDevice,
  rememberDevice,
  rememberedDevice,
  retryWithBackoff,
  watchForWake,
  type KeyValueStore,
} from './reconnect';
import { __resetRideSessionForTests, onRideSession, retainRideSession, rideSessionActive } from './rideSession';

const noSleep = () => Promise.resolve();

describe('backoff', () => {
  it('doubles from base and caps', () => {
    expect(backoffDelays(600, 4000, 5)).toEqual([600, 1200, 2400, 4000, 4000]);
    expect(TRAINER_RETRY_DELAYS_MS).toEqual([600, 1200, 2400, 4000]);
    expect(CONTROLLER_RETRY_DELAYS_MS).toEqual([1000, 2000, 4000, 8000, 15000]);
  });
});

describe('retryWithBackoff', () => {
  it('succeeds on the third attempt, after the first three waits', async () => {
    const waits: number[] = [];
    const events: string[] = [];
    let n = 0;
    const r = await retryWithBackoff({
      delays: [10, 20, 40, 80],
      sleep: async (ms) => {
        waits.push(ms);
      },
      onWait: (i, total) => events.push(`wait ${i}/${total}`),
      onAttempt: (i) => events.push(`try ${i}`),
      attempt: async () => {
        if (++n < 3) throw new Error('not yet');
      },
    });
    expect(r).toEqual({ ok: true, attempts: 3 });
    expect(waits).toEqual([10, 20, 40]);
    expect(events).toEqual(['wait 1/4', 'try 1', 'wait 2/4', 'try 2', 'wait 3/4', 'try 3']);
  });

  it('runs out: not ok, every attempt made, last error kept', async () => {
    const boom = new Error('gone');
    const r = await retryWithBackoff({ delays: [1, 1], sleep: noSleep, attempt: async () => Promise.reject(boom) });
    expect(r).toEqual({ ok: false, attempts: 2, cancelled: false, error: boom });
  });

  it('a fatal error stops at once', async () => {
    let tries = 0;
    const locked = Object.assign(new Error('locked'), { name: 'ControllerLocked' });
    const r = await retryWithBackoff({
      delays: [1, 1, 1],
      sleep: noSleep,
      fatal: (e) => (e as Error).name === 'ControllerLocked',
      attempt: async () => {
        tries++;
        throw locked;
      },
    });
    expect(tries).toBe(1);
    expect(r).toMatchObject({ ok: false, attempts: 1, cancelled: false, error: locked });
  });

  it('cancellation is checked after the wait, after a failure and after a success', async () => {
    let cancel = true;
    const before = await retryWithBackoff({ delays: [1], sleep: noSleep, cancelled: () => cancel, attempt: async () => undefined });
    expect(before).toMatchObject({ ok: false, attempts: 0, cancelled: true });

    let calls = 0;
    cancel = false;
    const afterFail = await retryWithBackoff({
      delays: [1, 1],
      sleep: noSleep,
      cancelled: () => cancel,
      attempt: async () => {
        calls++;
        cancel = true;
        throw new Error('x');
      },
    });
    expect(calls).toBe(1);
    expect(afterFail).toMatchObject({ ok: false, attempts: 1, cancelled: true });

    cancel = false;
    const afterOk = await retryWithBackoff({
      delays: [1],
      sleep: noSleep,
      cancelled: () => cancel,
      attempt: async () => {
        cancel = true;
      },
    });
    expect(afterOk).toMatchObject({ ok: false, attempts: 1, cancelled: true, error: null });
  });

  it('defaults to real timers', async () => {
    vi.useFakeTimers();
    let done = false;
    const p = retryWithBackoff({ delays: [500], attempt: async () => undefined }).then((r) => {
      done = r.ok;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
    vi.useRealTimers();
  });
});

// ---- wake -------------------------------------------------------------------

function advertiser(opts: { reject?: boolean; throwSync?: boolean; noAbort?: boolean } = {}) {
  const dev = new EventTarget() as EventTarget & {
    watchAdvertisements?: (o?: { signal?: AbortSignal }) => Promise<void>;
    unwatchAdvertisements?: () => void;
    watched: number;
    aborted: boolean;
    unwatched: number;
    advert: () => void;
  };
  dev.watched = 0;
  dev.aborted = false;
  dev.unwatched = 0;
  dev.watchAdvertisements = (o) => {
    dev.watched++;
    if (opts.throwSync) throw new Error('flag off');
    o?.signal?.addEventListener('abort', () => {
      dev.aborted = true;
    });
    return opts.reject ? Promise.reject(new Error('denied')) : Promise.resolve();
  };
  dev.unwatchAdvertisements = () => {
    dev.unwatched++;
  };
  dev.advert = () => dev.dispatchEvent(new Event('advertisementreceived'));
  return dev;
}

describe('watchForWake', () => {
  it('fires once on the first advert and stops watching', async () => {
    const dev = advertiser();
    let woke = 0;
    const stop = watchForWake(dev as unknown as BluetoothDevice, () => woke++);
    expect(stop).toBeTypeOf('function');
    expect(canWatchForWake(dev as unknown as BluetoothDevice)).toBe(true);
    dev.advert();
    dev.advert();
    expect(woke).toBe(1);
    expect(dev.aborted).toBe(true);
    stop!(); // idempotent
  });

  it('stop() before an advert: never fires', () => {
    const dev = advertiser();
    let woke = 0;
    const stop = watchForWake(dev as unknown as BluetoothDevice, () => woke++);
    stop!();
    dev.advert();
    expect(woke).toBe(0);
  });

  it('no watchAdvertisements: null (no wake reconnect on this browser)', () => {
    const plain = new EventTarget() as unknown as BluetoothDevice;
    expect(canWatchForWake(plain)).toBe(false);
    expect(watchForWake(plain, () => undefined)).toBeNull();
  });

  it('a throwing or refused watch never fires', async () => {
    const sync = advertiser({ throwSync: true });
    expect(watchForWake(sync as unknown as BluetoothDevice, () => undefined)).toBeNull();
    const refused = advertiser({ reject: true });
    let woke = 0;
    watchForWake(refused as unknown as BluetoothDevice, () => woke++);
    await Promise.resolve();
    await Promise.resolve();
    refused.advert();
    expect(woke).toBe(0);
  });

  it('an abort that throws is swallowed', () => {
    vi.stubGlobal(
      'AbortController',
      class {
        signal = new EventTarget();
        abort() {
          throw new Error('already aborted');
        }
      },
    );
    const dev = advertiser();
    let woke = 0;
    watchForWake(dev as unknown as BluetoothDevice, () => woke++);
    expect(() => dev.advert()).not.toThrow();
    expect(woke).toBe(1);
    vi.unstubAllGlobals();
  });

  it('without AbortController it unwatches instead', () => {
    vi.stubGlobal('AbortController', undefined);
    const dev = advertiser();
    watchForWake(dev as unknown as BluetoothDevice, () => undefined);
    dev.advert();
    expect(dev.unwatched).toBe(1);
    vi.unstubAllGlobals();
  });
});

// ---- remembered + granted ---------------------------------------------------

function memStore(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const dev = (id: string, name: string) => ({ id, name }) as unknown as BluetoothDevice;

describe('remembered devices', () => {
  it('round-trips id and name; forget clears', () => {
    const s = memStore();
    rememberDevice('k', dev('a', 'Zwift Ride'), s);
    expect(rememberedDevice('k', s)).toEqual({ id: 'a', name: 'Zwift Ride' });
    forgetDevice('k', s);
    expect(rememberedDevice('k', s)).toBeNull();
  });

  it('bad or missing records read as nothing; broken storage never throws', () => {
    const s = memStore();
    s.map.set('k', '{not json');
    expect(rememberedDevice('k', s)).toBeNull();
    s.map.set('k', 'null');
    expect(rememberedDevice('k', s)).toBeNull();
    s.map.set('k', JSON.stringify({ id: 5 }));
    expect(rememberedDevice('k', s)).toBeNull();
    s.map.set('k', JSON.stringify({ id: 'x', name: 7 }));
    expect(rememberedDevice('k', s)).toEqual({ id: 'x', name: null });
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(() => rememberDevice('k', dev('a', 'b'), broken)).not.toThrow();
    expect(() => forgetDevice('k', broken)).not.toThrow();
    expect(rememberedDevice('k', broken)).toBeNull();
    expect(rememberedDevice('k', null)).toBeNull();
    rememberDevice('k', { id: 'n', name: undefined } as unknown as BluetoothDevice, s);
    expect(rememberedDevice('k', s)).toEqual({ id: 'n', name: null });
  });
});

describe('findGrantedDevice', () => {
  const s = memStore();
  beforeEach(() => s.map.clear());

  it('by id first, then by name', async () => {
    rememberDevice('ctl', dev('left-id', 'Zwift Ride'), s);
    const left = dev('left-id', 'Zwift Ride');
    const right = dev('right-id', 'Zwift Ride');
    expect(await findGrantedDevice('ctl', { getDevices: async () => [right, left] }, s)).toBe(left);
    rememberDevice('ctl', dev('rotated', 'Zwift Ride'), s);
    expect(await findGrantedDevice('ctl', { getDevices: async () => [right, left] }, s)).toBe(right);
  });

  it('nothing when getDevices is missing, nothing was paired, the grant is gone, or getDevices throws', async () => {
    expect(await findGrantedDevice('ctl', null, s)).toBeNull();
    expect(await findGrantedDevice('ctl', {}, s)).toBeNull();
    expect(await findGrantedDevice('ctl', { getDevices: async () => [dev('a', 'b')] }, s)).toBeNull();
    s.map.set('ctl', JSON.stringify({ id: 'a', name: null }));
    expect(await findGrantedDevice('ctl', { getDevices: async () => [dev('z', 'b')] }, s)).toBeNull();
    expect(
      await findGrantedDevice('ctl', { getDevices: () => Promise.reject(new Error('flag off')) }, s),
    ).toBeNull();
  });

  it('no navigator, no Web Bluetooth, or storage that throws: nothing, no throw', async () => {
    vi.stubGlobal('navigator', undefined);
    expect(await findGrantedDevice('t')).toBeNull();
    vi.stubGlobal('navigator', {});
    expect(await findGrantedDevice('t')).toBeNull();
    vi.unstubAllGlobals();
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    expect(rememberedDevice('t')).toBeNull();
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('uses navigator.bluetooth and localStorage by default', async () => {
    const g = memStore();
    const d = dev('kickr', 'KICKR CORE 78C1');
    vi.stubGlobal('localStorage', g);
    vi.stubGlobal('navigator', { bluetooth: { getDevices: async () => [d] } });
    rememberDevice('t', d);
    expect(await findGrantedDevice('t')).toBe(d);
    vi.unstubAllGlobals();
  });
});

describe('ride session', () => {
  afterEach(() => __resetRideSessionForTests());

  it('open while any ride view is mounted; StrictMode replay never closes it', () => {
    const seen: boolean[] = [];
    onRideSession((a) => seen.push(a));
    expect(rideSessionActive()).toBe(false);
    const a = retainRideSession();
    const b = retainRideSession();
    a();
    a(); // double release is harmless
    expect(rideSessionActive()).toBe(true);
    b();
    expect(rideSessionActive()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('unsubscribe stops notifications', () => {
    const seen: boolean[] = [];
    const off = onRideSession((a) => seen.push(a));
    off();
    retainRideSession()();
    expect(seen).toEqual([]);
  });
});
