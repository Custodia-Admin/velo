/**
 * Getting a Bluetooth device back without the chooser, shared by the
 * handlebar controls and the trainer.
 *
 *   - Retained device: after an unexpected drop the same BluetoothDevice
 *     reconnects with gatt.connect() (no user gesture), retried with backoff.
 *   - Granted device: after a reload, navigator.bluetooth.getDevices() hands
 *     back devices this site was allowed before; the one paired last is
 *     remembered by id (and name) in localStorage.
 *   - Wake: a sleeping device that gave up retrying comes back when it
 *     advertises again (a pedal stroke, a button press). watchAdvertisements
 *     tells us; browsers without it simply don't get wake reconnects.
 *
 * Retry and lookup logic is plain async code with injectable sleep/storage,
 * so it is tested in node without Bluetooth.
 */

/** Delays before each retry of a controller that dropped (1 + 2 + 4 + 8 + 15 s). */
export const CONTROLLER_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000, 15000];

/** Capped exponential backoff: base, 2·base, 4·base … never above max. */
export function backoffDelays(baseMs: number, maxMs: number, attempts: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < attempts; i++) out.push(Math.min(maxMs, baseMs * 2 ** i));
  return out;
}

/** Trainer drops: 0.6, 1.2, 2.4, 4 s. Short: a dropped trainer means no resistance. */
export const TRAINER_RETRY_DELAYS_MS: readonly number[] = backoffDelays(600, 4000, 4);

export type RetryResult =
  | { ok: true; attempts: number }
  | { ok: false; attempts: number; cancelled: boolean; error: unknown };

export interface RetryOptions {
  /** Wait before attempt n (1-based) is delays[n - 1]; the length is the number of attempts. */
  delays: readonly number[];
  /** One try. Resolves when connected, rejects to retry. */
  attempt: (n: number) => Promise<void>;
  /** Checked after every wait and failure: true stops at once. */
  cancelled?: () => boolean;
  /** A failure that retrying cannot fix (e.g. the controls are locked). */
  fatal?: (err: unknown) => boolean;
  /** Before the wait for attempt n. */
  onWait?: (n: number, total: number) => void;
  /** Right before attempt n runs (after its wait). */
  onAttempt?: (n: number, total: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry `attempt` after each delay until it works, is cancelled, or the delays run out. */
export async function retryWithBackoff(o: RetryOptions): Promise<RetryResult> {
  const sleep = o.sleep ?? defaultSleep;
  const total = o.delays.length;
  let error: unknown = null;
  for (let n = 1; n <= total; n++) {
    o.onWait?.(n, total);
    await sleep(o.delays[n - 1]);
    if (o.cancelled?.()) return { ok: false, attempts: n - 1, cancelled: true, error };
    o.onAttempt?.(n, total);
    try {
      await o.attempt(n);
      if (o.cancelled?.()) return { ok: false, attempts: n, cancelled: true, error: null };
      return { ok: true, attempts: n };
    } catch (err) {
      error = err;
      if (o.cancelled?.()) return { ok: false, attempts: n, cancelled: true, error };
      if (o.fatal?.(err)) return { ok: false, attempts: n, cancelled: false, error };
    }
  }
  return { ok: false, attempts: total, cancelled: false, error };
}

// ---- wake ------------------------------------------------------------------

type WatchableDevice = BluetoothDevice & {
  watchAdvertisements?: (options?: { signal?: AbortSignal }) => Promise<void>;
  unwatchAdvertisements?: () => void;
};

/** True when this browser can tell us a device woke up. */
export function canWatchForWake(device: BluetoothDevice): boolean {
  return typeof (device as WatchableDevice).watchAdvertisements === 'function';
}

/**
 * Call `onWake` once, on the device's first advertisement. Returns a stop
 * function, or null when the browser cannot watch adverts (or refused).
 */
export function watchForWake(device: BluetoothDevice, onWake: () => void): (() => void) | null {
  const d = device as WatchableDevice;
  if (typeof d.watchAdvertisements !== 'function') return null;
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    device.removeEventListener('advertisementreceived', onAdvert);
    try {
      if (abort) abort.abort();
      else d.unwatchAdvertisements?.();
    } catch {
      /* already stopped */
    }
  };
  function onAdvert(): void {
    stop(); // removes this listener, so a second advert never gets here
    onWake();
  }
  device.addEventListener('advertisementreceived', onAdvert);
  try {
    void d.watchAdvertisements(abort ? { signal: abort.signal } : undefined).catch(stop);
  } catch {
    stop();
    return null;
  }
  return stop;
}

// ---- remembered + granted devices -------------------------------------------

export interface RememberedDevice {
  id: string;
  name: string | null;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function storage(): KeyValueStore | null {
  try {
    return (globalThis as { localStorage?: KeyValueStore }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function rememberDevice(key: string, dev: Pick<BluetoothDevice, 'id' | 'name'>, store = storage()): void {
  try {
    store?.setItem(key, JSON.stringify({ id: dev.id, name: dev.name ?? null }));
  } catch {
    /* storage unavailable: reconnect just won't be offered */
  }
}

export function forgetDevice(key: string, store = storage()): void {
  try {
    store?.removeItem?.(key);
  } catch {
    /* nothing to forget */
  }
}

export function rememberedDevice(key: string, store = storage()): RememberedDevice | null {
  try {
    const raw = store?.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<RememberedDevice> | null;
    if (!v || typeof v.id !== 'string') return null;
    return { id: v.id, name: typeof v.name === 'string' ? v.name : null };
  } catch {
    return null;
  }
}

/** The parts of navigator.bluetooth a lookup needs. */
export interface GrantedDevices {
  getDevices?: () => Promise<BluetoothDevice[]>;
}

function bluetooth(): GrantedDevices | null {
  if (typeof navigator === 'undefined') return null;
  return ((navigator as Navigator & { bluetooth?: GrantedDevices }).bluetooth ?? null) as GrantedDevices | null;
}

/**
 * The device remembered under `key` among the ones this site may use
 * without the chooser: by id, then by name. Null when getDevices is missing
 * (some Chrome builds keep it behind a flag), nothing was paired, or the
 * grant is gone. Never throws.
 */
export async function findGrantedDevice(
  key: string,
  bt: GrantedDevices | null = bluetooth(),
  store = storage(),
): Promise<BluetoothDevice | null> {
  if (!bt || typeof bt.getDevices !== 'function') return null;
  const last = rememberedDevice(key, store);
  if (!last) return null;
  let devices: BluetoothDevice[];
  try {
    devices = await bt.getDevices();
  } catch {
    return null;
  }
  return devices.find((d) => d.id === last.id) ?? (last.name ? devices.find((d) => d.name === last.name) : undefined) ?? null;
}
