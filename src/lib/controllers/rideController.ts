/**
 * Web Bluetooth client for the Ride V2 handlebar controls.
 *
 * One module-level link, like the FTMS client. It never talks to the trainer:
 * every write goes to the controller (handshake, buzz), none changes
 * resistance. Gears reach the trainer through the existing FTMS writer.
 *
 * Protocol: src/lib/controllers/rideProtocol.ts, notes in
 * docs/devices/zwift-ride-v2.md.
 */

import {
  BATTERY_LEVEL,
  BATTERY_SERVICE,
  MSG_BATTERY,
  MSG_KEYPAD,
  MSG_TAKEN_OVER,
  RIDE_ASYNC,
  RIDE_COMPANY_ID,
  RIDE_NAME_PREFIX,
  RIDE_ON,
  RIDE_SERVICE,
  RIDE_SERVICE_LEGACY,
  RIDE_SYNC_RX,
  RIDE_SYNC_TX,
  decodeBattery,
  decodeKeypad,
  encodeHaptic,
  pressedButtons,
  risingEdges,
  steerFrom,
  toHex,
  type RideButton,
} from '@/lib/controllers/rideProtocol';
import { useControllerStore } from '@/stores/controllerStore';

export const LOCKED_MESSAGE =
  'The handlebar controls are locked. Connect them once today in their own app, close that app, then pair again.';
export const TAKEN_OVER_MESSAGE = 'Another app took over the handlebar controls. Close it, then reconnect.';

/** No message at all this long after the handshake → probably locked or asleep. */
export const SILENT_AFTER_MS = 8000;
const WRITE_TIMEOUT_MS = 3000;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
const LOG_SIZE = 300;

type ButtonListener = (button: RideButton) => void;

/** The parts of navigator.bluetooth we use (injectable for tests). */
export interface BluetoothLike {
  requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
}

interface Link {
  device: BluetoothDevice;
  rx: BluetoothRemoteGATTCharacteristic | null;
  pressed: Set<RideButton>;
  queue: Promise<unknown>;
  silentTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  intentional: boolean;
  /** Service missing: wait for the rider to unlock and press "Try again". */
  locked: boolean;
  gotMessage: boolean;
  /** Characteristics we already listen on (Chrome reuses them on reconnect). */
  wired: WeakSet<BluetoothRemoteGATTCharacteristic>;
}

let link: Link | null = null;
let bluetoothOverride: BluetoothLike | null = null;
const buttonListeners = new Set<ButtonListener>();
const log: string[] = [];
let liveLog = false;

function bt(): BluetoothLike | null {
  if (bluetoothOverride) return bluetoothOverride;
  if (typeof navigator === 'undefined') return null;
  return (navigator as Navigator & { bluetooth?: BluetoothLike }).bluetooth ?? null;
}

/** Tests only. */
export function __setBluetoothForTests(b: BluetoothLike | null): void {
  bluetoothOverride = b;
}

/** True when this browser can pair the handlebar controls at all. */
export function isRideControllerSupported(): boolean {
  if (typeof window !== 'undefined' && window.isSecureContext === false) return false;
  return bt() !== null;
}

export function onControllerButton(listener: ButtonListener): () => void {
  buttonListeners.add(listener);
  return () => buttonListeners.delete(listener);
}

function store() {
  return useControllerStore.getState();
}

function record(dir: 'in' | 'out', bytes: Uint8Array): void {
  const line = `${new Date().toISOString().slice(11, 23)} ${dir} ${toHex(bytes)}`;
  log.push(line);
  if (log.length > LOG_SIZE) log.shift();
  if (liveLog) console.info('[controls]', line);
}

function bytesOf(ch: BluetoothRemoteGATTCharacteristic): Uint8Array {
  const v = ch.value;
  return v ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice() : new Uint8Array();
}

async function tryGet<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('write timed out')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Serialised write to Sync RX; GATT allows one operation at a time. */
function write(l: Link, bytes: Uint8Array): Promise<void> {
  const run = async () => {
    const rx = l.rx;
    if (!rx) return;
    record('out', bytes);
    const payload = new Uint8Array(bytes); // own ArrayBuffer, as BufferSource wants
    const op = rx.properties?.writeWithoutResponse && !rx.properties?.write
      ? rx.writeValueWithoutResponse(payload)
      : rx.writeValue(payload);
    await withTimeout(op, WRITE_TIMEOUT_MS);
  };
  const next = l.queue.then(run, run);
  l.queue = next.catch(() => undefined);
  return next;
}

function handleMessage(l: Link, msg: Uint8Array): void {
  if (msg.length === 0) return;
  record('in', msg);
  if (!l.gotMessage) {
    l.gotMessage = true;
    if (l.silentTimer) clearTimeout(l.silentTimer);
    l.silentTimer = null;
    store().setSilent(false);
  }
  const id = msg[0];
  if (id === MSG_KEYPAD) {
    const status = decodeKeypad(msg);
    if (!status) return;
    const now = pressedButtons(status);
    const fired = risingEdges(l.pressed, now);
    l.pressed = now;
    const steer = steerFrom(status.levers);
    if (Math.abs(steer - store().steer) >= 0.02 || (steer === 0 && store().steer !== 0)) {
      store().setSteer(steer);
    }
    for (const b of fired) for (const fn of [...buttonListeners]) fn(b);
  } else if (id === MSG_BATTERY) {
    const pct = decodeBattery(msg);
    if (pct !== null && pct !== store().battery) store().setBattery(pct);
  } else if (id === MSG_TAKEN_OVER) {
    store().setStatus('error', TAKEN_OVER_MESSAGE);
  }
}

async function setupSession(l: Link): Promise<void> {
  const gatt = l.device.gatt;
  if (!gatt) throw new Error('This device has no Bluetooth services.');
  const server = gatt.connected ? gatt : await gatt.connect();
  l.rx = null;
  l.pressed = new Set();
  l.gotMessage = false;

  const svc =
    (await tryGet(() => server.getPrimaryService(RIDE_SERVICE))) ??
    (await tryGet(() => server.getPrimaryService(RIDE_SERVICE_LEGACY)));
  if (!svc) {
    const err = new Error(LOCKED_MESSAGE);
    err.name = 'ControllerLocked';
    throw err;
  }

  const asyncCh = await svc.getCharacteristic(RIDE_ASYNC);
  if (!l.wired.has(asyncCh)) {
    l.wired.add(asyncCh);
    asyncCh.addEventListener('characteristicvaluechanged', () => handleMessage(l, bytesOf(asyncCh)));
  }
  await asyncCh.startNotifications();

  const tx = await tryGet(() => svc.getCharacteristic(RIDE_SYNC_TX));
  if (tx) {
    if (!l.wired.has(tx)) {
      l.wired.add(tx);
      tx.addEventListener('characteristicvaluechanged', () => record('in', bytesOf(tx)));
    }
    await tryGet(() => tx.startNotifications());
  }

  l.rx = await svc.getCharacteristic(RIDE_SYNC_RX);
  await write(l, RIDE_ON);

  // Standard battery service as a first reading; 0x19 messages keep it fresh.
  const level = await tryGet(async () => {
    const bas = await server.getPrimaryService(BATTERY_SERVICE);
    const ch = await bas.getCharacteristic(BATTERY_LEVEL);
    return (await ch.readValue()).getUint8(0);
  });
  if (level !== null && level >= 0 && level <= 100) store().setBattery(level);

  if (l.silentTimer) clearTimeout(l.silentTimer);
  l.silentTimer = setTimeout(() => {
    if (link === l && !l.gotMessage) store().setSilent(true);
  }, SILENT_AFTER_MS);
}

function clearTimers(l: Link): void {
  if (l.silentTimer) clearTimeout(l.silentTimer);
  if (l.retryTimer) clearTimeout(l.retryTimer);
  l.silentTimer = null;
  l.retryTimer = null;
}

function onGattDisconnected(l: Link): void {
  if (link !== l || l.intentional || l.locked) return;
  l.rx = null;
  clearTimers(l);
  scheduleReconnect(l);
}

function scheduleReconnect(l: Link): void {
  if (l.attempt >= RECONNECT_DELAYS_MS.length) {
    store().setStatus('asleep');
    return;
  }
  store().setStatus('reconnecting');
  const delay = RECONNECT_DELAYS_MS[l.attempt++];
  l.retryTimer = setTimeout(() => {
    if (link !== l || l.intentional) return;
    void setupSession(l).then(
      () => {
        if (link !== l || l.intentional) return;
        l.attempt = 0;
        store().setStatus('connected');
      },
      (err: unknown) => {
        if (link !== l || l.intentional) return;
        if (err instanceof Error && err.name === 'ControllerLocked') {
          markLocked(l);
          return;
        }
        scheduleReconnect(l);
      },
    );
  }, delay);
}

function markLocked(l: Link): void {
  l.locked = true;
  clearTimers(l);
  try {
    l.device.gatt?.disconnect();
  } catch {
    /* already gone */
  }
  store().setStatus('locked');
}

function friendlyError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'NotFoundError') return 'No handlebar controls picked.';
    if (err.name === 'SecurityError') return 'The browser blocked Bluetooth here. Open Velo over https or localhost.';
    if (err.name === 'NetworkError') return 'Could not reach the handlebar controls. Press a button to wake them and try again.';
  }
  return 'Could not pair the handlebar controls. Press a button to wake them and try again.';
}

/**
 * Open the browser's chooser and pair the controls. Must run from a click.
 * Resolves when paired; on failure the store carries the reason.
 * `showAllDevices` lists every nearby device: a fallback for when the
 * filtered chooser comes up empty (pick the "Zwift Ride" entry).
 */
export async function pairRideController(opts: { showAllDevices?: boolean } = {}): Promise<void> {
  const b = bt();
  if (!b) {
    store().setStatus('error', 'This browser cannot use Bluetooth. Use Chrome or Edge on a computer.');
    return;
  }
  const s = store();
  s.setStatus('connecting');
  s.setSilent(false);

  let device: BluetoothDevice;
  const optionalServices: BluetoothServiceUUID[] = [RIDE_SERVICE, RIDE_SERVICE_LEGACY, BATTERY_SERVICE];
  try {
    try {
      device = await b.requestDevice(
        opts.showAllDevices
          ? { acceptAllDevices: true, optionalServices }
          : {
              filters: [{ namePrefix: RIDE_NAME_PREFIX }, { manufacturerData: [{ companyIdentifier: RIDE_COMPANY_ID }] }],
              optionalServices,
            },
      );
    } catch (err) {
      // Older Chrome rejects manufacturerData filters with a TypeError.
      if (!(err instanceof TypeError)) throw err;
      device = await b.requestDevice({ filters: [{ namePrefix: RIDE_NAME_PREFIX }], optionalServices });
    }
  } catch (err) {
    const cancelled = err instanceof Error && err.name === 'NotFoundError';
    if (cancelled && link) store().setStatus('connected');
    else if (cancelled) store().setStatus('idle');
    else store().setStatus('error', friendlyError(err));
    return;
  }

  // Replace any earlier link (one controller at a time).
  if (link) await disconnectRideController();

  const l: Link = {
    device,
    rx: null,
    pressed: new Set(),
    queue: Promise.resolve(),
    silentTimer: null,
    retryTimer: null,
    attempt: 0,
    intentional: false,
    locked: false,
    gotMessage: false,
    wired: new WeakSet(),
  };
  link = l;
  device.addEventListener('gattserverdisconnected', () => onGattDisconnected(l));
  store().setDevice(device.name ?? 'Handlebar controls');

  try {
    await setupSession(l);
    if (link !== l) return;
    store().setStatus('connected');
  } catch (err) {
    if (link !== l) return;
    if (err instanceof Error && err.name === 'ControllerLocked') {
      // Keep the link so "Try again" can reconnect without the chooser.
      markLocked(l);
      return;
    }
    l.intentional = true;
    clearTimers(l);
    try {
      device.gatt?.disconnect();
    } catch {
      /* already gone */
    }
    link = null;
    store().setStatus('error', friendlyError(err));
  }
}

/** Reconnect the last paired controls without the chooser (asleep / locked). */
export async function reconnectRideController(): Promise<void> {
  const l = link;
  if (!l) return;
  clearTimers(l);
  l.intentional = false;
  l.locked = false;
  l.attempt = 0;
  store().setStatus('connecting');
  try {
    await setupSession(l);
    if (link === l) store().setStatus('connected');
  } catch (err) {
    if (link !== l) return;
    if (err instanceof Error && err.name === 'ControllerLocked') markLocked(l);
    else store().setStatus('asleep');
  }
}

export async function disconnectRideController(): Promise<void> {
  const l = link;
  link = null;
  if (l) {
    l.intentional = true;
    clearTimers(l);
    try {
      l.device.gatt?.disconnect();
    } catch {
      /* already gone */
    }
  }
  const s = store();
  s.setStatus('idle');
  s.setDevice(null);
  s.setBattery(null);
  s.setSilent(false);
  s.setSteer(0);
}

/** Short buzz on the controls (shift feedback, "Test buzz"). Never throws. */
export function buzzRideController(): void {
  const l = link;
  if (!l || !l.rx || store().status !== 'connected') return;
  void write(l, encodeHaptic()).catch(() => undefined);
}

/** Debug hook for the hardware session: window.__veloController.log(). */
export const controllerDebug = {
  /** Print the last messages and keep printing new ones. */
  log(on = true): string[] {
    liveLog = on;
    if (on) for (const line of log) console.info('[controls]', line);
    return [...log];
  },
  lines(): string[] {
    return [...log];
  },
};

if (typeof window !== 'undefined') {
  (window as unknown as { __veloController?: typeof controllerDebug }).__veloController = controllerDebug;
}
