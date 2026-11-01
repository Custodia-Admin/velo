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
  describeMessage,
  encodeHaptic,
  pressedButtons,
  risingEdges,
  sideFromManufacturerData,
  steerFrom,
  toHex,
  type RideButton,
} from '@/lib/controllers/rideProtocol';
import { actionFor } from '@/lib/controllers/controllerActions';
import { watchBattery, type BatteryWatch } from '@/lib/controllers/battery';
import {
  CONTROLLER_RETRY_DELAYS_MS,
  findGrantedDevice,
  forgetDevice,
  rememberDevice,
  retryWithBackoff,
  watchForWake,
  type GrantedDevices,
} from '@/lib/controllers/reconnect';
import { onRideSession, rideSessionActive } from '@/lib/controllers/rideSession';
import { useControllerStore, type ControllerSideCheck } from '@/stores/controllerStore';
import { useShowStore } from '@/stores/showStore';

export const LOCKED_MESSAGE =
  'The handlebar controls are locked. Connect them once today in their own app, close that app, then pair again.';
export const TAKEN_OVER_MESSAGE = 'Another app took over the handlebar controls. Close it, then reconnect.';

/** No message at all this long after the handshake → probably locked or asleep. */
export const SILENT_AFTER_MS = 10000;
/** How long to listen for the controller's advert to tell left from right. */
export const SIDE_WATCH_MS = 2500;
/** Lines kept for the in-ride debug overlay. */
export const DEBUG_LINES = 8;
const WRITE_TIMEOUT_MS = 3000;
const LOG_SIZE = 300;
/** Gear buzzes closer together than this are dropped (fast double shifts). */
export const BUZZ_MIN_GAP_MS = 150;
/** localStorage key of the controller paired last (reconnect after a reload). */
export const LAST_CONTROLLER_KEY = 'velo.lastController';

type ButtonListener = (button: RideButton) => void;

/** The parts of navigator.bluetooth we use (injectable for tests). */
export interface BluetoothLike extends GrantedDevices {
  requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
}

interface Link {
  device: BluetoothDevice;
  rx: BluetoothRemoteGATTCharacteristic | null;
  pressed: Set<RideButton>;
  queue: Promise<unknown>;
  silentTimer: ReturnType<typeof setTimeout> | null;
  /** A retry run is in flight. */
  retrying: boolean;
  /** Stops the wake watch (asleep controls coming back on a button press). */
  stopWake: (() => void) | null;
  battery: BatteryWatch | null;
  /** performance.now()-ish time of the last buzz written. */
  lastBuzzMs: number;
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

/** One line of the in-ride debug overlay. */
export interface DebugEntry {
  id: number;
  time: string;
  dir: 'in' | 'out';
  hex: string;
  /** Parsed reading, plus the button actions and resulting gear for presses. */
  note: string;
  /** Identical consecutive lines are folded into one (idle ticks). */
  count: number;
}

let debugEntries: readonly DebugEntry[] = [];
let debugSeq = 0;
const debugListeners = new Set<() => void>();

function pushDebug(dir: 'in' | 'out', time: string, hex: string, note: string): void {
  const last = debugEntries[debugEntries.length - 1];
  if (last && last.dir === dir && last.hex === hex && last.note === note) {
    debugEntries = [...debugEntries.slice(0, -1), { ...last, time, count: last.count + 1 }];
  } else {
    debugEntries = [...debugEntries, { id: ++debugSeq, time, dir, hex, note, count: 1 }].slice(-DEBUG_LINES);
  }
  for (const fn of [...debugListeners]) fn();
}

/** Latest overlay lines (stable reference until something new arrives). */
export function getDebugEntries(): readonly DebugEntry[] {
  return debugEntries;
}

export function subscribeDebug(listener: () => void): () => void {
  debugListeners.add(listener);
  return () => debugListeners.delete(listener);
}

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

function record(dir: 'in' | 'out', bytes: Uint8Array, note?: string): void {
  const time = new Date().toISOString().slice(11, 23);
  const hex = toHex(bytes);
  const reading = note ?? describeMessage(dir, bytes);
  const line = `${time} ${dir} ${hex}`;
  log.push(line);
  if (log.length > LOG_SIZE) log.shift();
  if (liveLog) console.info('[controls]', line, '·', reading);
  pushDebug(dir, time, hex, reading);
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
  const id = msg[0];
  // Keypad lines are recorded after the listeners ran, with the gear they caused.
  if (id !== MSG_KEYPAD) record('in', msg);
  if (!l.gotMessage) {
    l.gotMessage = true;
    if (l.silentTimer) clearTimeout(l.silentTimer);
    l.silentTimer = null;
    store().setSilent(false);
  }
  if (id === MSG_KEYPAD) {
    const status = decodeKeypad(msg)!; // non-null: id is MSG_KEYPAD
    if (!store().inputSeen) store().setInputSeen(true);
    const now = pressedButtons(status);
    const fired = risingEdges(l.pressed, now);
    l.pressed = now;
    const steer = steerFrom(status.levers);
    if (Math.abs(steer - store().steer) >= 0.02 || (steer === 0 && store().steer !== 0)) {
      store().setSteer(steer);
    }
    const gearBefore = store().gear;
    for (const b of fired) for (const fn of [...buttonListeners]) fn(b);
    let note = describeMessage('in', msg);
    if (fired.length > 0) {
      const show = useShowStore.getState().active;
      note += ` · press ${fired.map((b) => `${b}→${actionFor(b, { show }) ?? 'none'}`).join(' ')}`;
      const gearAfter = store().gear;
      if (gearAfter !== gearBefore) note += ` · gear ${gearBefore}→${gearAfter}`;
    }
    record('in', msg, note);
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
  store().setSilent(false);

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

  // Standard Battery Service (0x180F): first reading + notifications; the
  // controller's own 0x19 messages keep it fresh too.
  l.battery?.stop();
  l.battery = await watchBattery(server, (pct) => {
    if (link === l && pct !== store().battery) store().setBattery(pct);
  });

  if (l.silentTimer) clearTimeout(l.silentTimer);
  l.silentTimer = setTimeout(() => {
    if (link === l && !l.gotMessage) store().setSilent(true);
  }, SILENT_AFTER_MS);
}

function clearTimers(l: Link): void {
  if (l.silentTimer) clearTimeout(l.silentTimer);
  l.silentTimer = null;
  l.stopWake?.();
  l.stopWake = null;
}

/** The link was given up on or torn down: nothing of it may act any more. */
function gone(l: Link): boolean {
  return link !== l || l.intentional;
}

function isLockedError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ControllerLocked';
}

function onGattDisconnected(l: Link): void {
  if (gone(l) || l.locked || store().status === 'asleep') return;
  l.rx = null;
  clearTimers(l);
  void retryLink(l);
}

/**
 * Retry an unexpected drop with backoff (1, 2, 4, 8, 15 s). The gear is
 * kept meanwhile so resistance does not jump. Out of retries → asleep, and
 * during a ride the controls come back by themselves on the next button
 * press (wake watch).
 */
async function retryLink(l: Link): Promise<void> {
  if (l.retrying) return;
  l.retrying = true;
  store().setStatus('reconnecting');
  const result = await retryWithBackoff({
    delays: CONTROLLER_RETRY_DELAYS_MS,
    attempt: () => setupSession(l),
    cancelled: () => gone(l),
    fatal: isLockedError,
  });
  l.retrying = false;
  if (gone(l)) return;
  if (result.ok) {
    store().setStatus('connected');
    return;
  }
  if (isLockedError(result.error)) {
    markLocked(l);
    return;
  }
  goAsleep(l);
}

function goAsleep(l: Link): void {
  // Status first: the disconnect below may fire gattserverdisconnected,
  // which must not start another retry run.
  store().setStatus('asleep');
  try {
    l.device.gatt?.disconnect();
  } catch {
    /* already gone */
  }
  armWake(l);
}

/**
 * Asleep controls wake when a button is pressed: they advertise again and
 * Velo reconnects without a tap. Only during a ride (no Bluetooth write
 * outside a rider-started ride); onRideSession re-arms it when one opens.
 */
function armWake(l: Link): void {
  if (gone(l) || l.locked || l.stopWake || store().status !== 'asleep' || !rideSessionActive()) return;
  l.stopWake = watchForWake(l.device, () => {
    l.stopWake = null;
    if (gone(l) || store().status !== 'asleep' || !rideSessionActive()) return;
    void wakeReconnect(l);
  });
}

async function wakeReconnect(l: Link): Promise<void> {
  store().setStatus('connecting');
  try {
    await setupSession(l);
    if (gone(l)) return;
    store().setStatus('connected');
    await confirmBuzz(l);
  } catch (err) {
    if (gone(l)) return;
    if (isLockedError(err)) markLocked(l);
    else goAsleep(l);
  }
}

onRideSession((active) => {
  const l = link;
  if (!l) return;
  if (active) armWake(l);
  else {
    l.stopWake?.();
    l.stopWake = null;
  }
});

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

type AdvertisingDevice = BluetoothDevice & {
  watchAdvertisements?: (options?: { signal?: AbortSignal }) => Promise<void>;
  unwatchAdvertisements?: () => void;
};

/**
 * Tell the left controller from the right one by its advert (manufacturer
 * byte 0x08 / 0x07). Must run before connecting: a connected controller
 * stops advertising. Needs watchAdvertisements (Chrome 85+, some builds
 * behind a flag); without it the side stays 'unsupported'. Never throws.
 */
export async function detectControllerSide(
  device: BluetoothDevice,
  timeoutMs = SIDE_WATCH_MS,
): Promise<ControllerSideCheck> {
  const d = device as AdvertisingDevice;
  if (typeof d.watchAdvertisements !== 'function') return 'unsupported';
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  return new Promise<ControllerSideCheck>((resolve) => {
    let done = false;
    const onAdvert = (ev: Event) => {
      const data = (ev as Event & { manufacturerData?: Map<number, DataView> }).manufacturerData;
      const side = sideFromManufacturerData(data?.get(RIDE_COMPANY_ID));
      if (side) finish(side);
    };
    const timer = setTimeout(() => finish('unknown'), timeoutMs);
    function finish(result: ControllerSideCheck): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      device.removeEventListener('advertisementreceived', onAdvert);
      try {
        abort?.abort();
        if (!abort) d.unwatchAdvertisements?.();
      } catch {
        /* already stopped */
      }
      resolve(result);
    }
    device.addEventListener('advertisementreceived', onAdvert);
    try {
      void d.watchAdvertisements!(abort ? { signal: abort.signal } : undefined).catch(() => finish('unsupported'));
    } catch {
      finish('unsupported');
    }
  });
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** One buzz right after the handshake so the rider feels which unit paired. Non-fatal. */
async function confirmBuzz(l: Link): Promise<void> {
  if (link !== l || !l.rx) return;
  try {
    l.lastBuzzMs = nowMs();
    await write(l, encodeHaptic());
    if (link === l) store().setBuzz('ok');
  } catch {
    if (link === l) store().setBuzz('failed');
  }
}

function newLink(device: BluetoothDevice): Link {
  const l: Link = {
    device,
    rx: null,
    pressed: new Set(),
    queue: Promise.resolve(),
    silentTimer: null,
    retrying: false,
    stopWake: null,
    battery: null,
    lastBuzzMs: Number.NEGATIVE_INFINITY,
    intentional: false,
    locked: false,
    gotMessage: false,
    wired: new WeakSet(),
  };
  device.addEventListener('gattserverdisconnected', () => onGattDisconnected(l));
  return l;
}

function teardown(l: Link): void {
  l.intentional = true;
  clearTimers(l);
  l.battery?.stop();
  l.battery = null;
  try {
    l.device.gatt?.disconnect();
  } catch {
    /* already gone */
  }
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
          : ({
              filters: [{ namePrefix: RIDE_NAME_PREFIX }, { manufacturerData: [{ companyIdentifier: RIDE_COMPANY_ID }] }],
              optionalServices,
              // Lets the side check read the left/right byte from adverts.
              optionalManufacturerData: [RIDE_COMPANY_ID],
            } as RequestDeviceOptions),
      );
    } catch (err) {
      // Older Chrome rejects manufacturerData filters with a TypeError.
      if (!(err instanceof TypeError)) throw err;
      device = await b.requestDevice({
        filters: [{ namePrefix: RIDE_NAME_PREFIX }],
        optionalServices,
        optionalManufacturerData: [RIDE_COMPANY_ID],
      } as RequestDeviceOptions);
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

  const l = newLink(device);
  link = l;
  const st = store();
  st.setDevice(device.name ?? 'Handlebar controls');
  st.setSide(null);
  st.setBuzz(null);
  st.setInputSeen(false);

  try {
    const side = await detectControllerSide(device);
    if (link !== l) return;
    store().setSide(side);
    await setupSession(l);
    if (link !== l) return;
    rememberDevice(LAST_CONTROLLER_KEY, device);
    store().setStatus('connected');
    await confirmBuzz(l);
  } catch (err) {
    if (link !== l) return;
    if (isLockedError(err)) {
      // Keep the link so "Try again" can reconnect without the chooser.
      rememberDevice(LAST_CONTROLLER_KEY, device);
      markLocked(l);
      return;
    }
    teardown(l);
    link = null;
    store().setStatus('error', friendlyError(err));
  }
}

/** The controls this browser may use without the chooser (paired in an earlier session), or null. */
export function findGrantedController(): Promise<BluetoothDevice | null> {
  return findGrantedDevice(LAST_CONTROLLER_KEY, bt());
}

/**
 * Reconnect the controls paired in an earlier session, without the chooser
 * and without a tap: the Ride page calls it when a ride opens, the panel's
 * "Reconnect" button too. Resolves true when connected. Never throws; on
 * failure the panel is back to "Pair handlebar controls".
 */
let grantedInFlight: Promise<boolean> | null = null;

export function reconnectGrantedController(): Promise<boolean> {
  // StrictMode mounts the Ride page twice: one attempt at a time.
  if (!grantedInFlight) {
    grantedInFlight = reconnectGranted().finally(() => {
      grantedInFlight = null;
    });
  }
  return grantedInFlight;
}

async function reconnectGranted(): Promise<boolean> {
  if (link) {
    const status = store().status;
    if (status === 'connected' || status === 'connecting' || status === 'reconnecting') return status === 'connected';
  }
  const device = await findGrantedController();
  if (!device) return false;
  if (link) await disconnectRideController({ forget: false });
  const l = newLink(device);
  link = l;
  const st = store();
  st.setStatus('connecting');
  st.setDevice(device.name ?? 'Handlebar controls');
  st.setSide(null);
  st.setBuzz(null);
  st.setInputSeen(false);
  try {
    const side = await detectControllerSide(device);
    if (link !== l) return false;
    store().setSide(side);
    await setupSession(l);
    if (link !== l) return false;
    store().setStatus('connected');
    await confirmBuzz(l);
    return true;
  } catch (err) {
    if (link !== l) return false;
    if (isLockedError(err)) {
      markLocked(l);
      return false;
    }
    teardown(l);
    link = null;
    const s = store();
    s.setStatus('idle');
    s.setDevice(null);
    s.setSide(null);
    return false;
  }
}

/** Reconnect the last paired controls without the chooser (asleep / locked). */
export async function reconnectRideController(): Promise<void> {
  const l = link;
  if (!l) return;
  clearTimers(l);
  l.intentional = false;
  l.locked = false;
  store().setStatus('connecting');
  try {
    await setupSession(l);
    if (link !== l) return;
    store().setStatus('connected');
    await confirmBuzz(l);
  } catch (err) {
    if (link !== l) return;
    if (isLockedError(err)) markLocked(l);
    else goAsleep(l);
  }
}

/**
 * Drop the controls. `forget` also drops the memory of them, so the next
 * ride does not reconnect them by itself ("Forget" in the panel).
 */
export async function disconnectRideController(opts: { forget?: boolean } = {}): Promise<void> {
  const l = link;
  link = null;
  if (l) teardown(l);
  if (opts.forget) forgetDevice(LAST_CONTROLLER_KEY);
  const s = store();
  s.setStatus('idle');
  s.setDevice(null);
  s.setBattery(null);
  s.setSilent(false);
  s.setSide(null);
  s.setBuzz(null);
  s.setInputSeen(false);
  s.setSteer(0);
}

export type BuzzReason = 'test' | 'gear';

/**
 * Short buzz on the controls. Never throws. Returns true when a buzz was sent.
 *   'test'  the rider tapped "Test buzz".
 *   'gear'  a gear change: only during a ride, only with "Buzz on gear
 *           change" on, and at most one per BUZZ_MIN_GAP_MS so a fast
 *           double shift does not queue a string of buzzes.
 * The buzz is the documented short pattern (docs/devices/zwift-ride-v2.md):
 * the only haptic write Velo knows to be safe, so "subtle" means short and
 * rare, not a guessed weaker pattern.
 */
export function buzzRideController(reason: BuzzReason = 'test'): boolean {
  const l = link;
  if (!l || !l.rx || store().status !== 'connected') return false;
  if (reason === 'gear') {
    if (!store().gearBuzz || !rideSessionActive()) return false;
    const t = nowMs();
    if (t - l.lastBuzzMs < BUZZ_MIN_GAP_MS) return false;
  }
  l.lastBuzzMs = nowMs();
  void write(l, encodeHaptic()).catch(() => undefined);
  return true;
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
