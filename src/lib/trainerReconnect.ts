/**
 * Reconnect the trainer paired in an earlier session without the chooser.
 *
 * Chrome keeps the Bluetooth grant across reloads; navigator.bluetooth
 * .getDevices() hands the device back and gatt.connect() works without a
 * user gesture. The Trainer panel offers a one-tap "Reconnect <name>", and
 * the Ride page tries it silently on start. Any failure falls back to the
 * normal chooser ("Pair trainer").
 *
 * A trainer that dropped mid-ride and did not come back within its retries
 * (it went to sleep) reconnects by itself when it wakes up: the first
 * pedal stroke makes it advertise again. Only inside the ride session, and
 * only while it is not connected: the wake watch stops the moment the
 * trainer is back, so nothing scans through a connected ride.
 *
 * The phase logic is a pure reducer so it is unit-tested without Bluetooth.
 */

import { create } from 'zustand';
import { findGrantedTrainer, getDeviceName, reconnectGranted, retainedTrainer } from '@/lib/ftms';
import { watchForWake, type AdvertWatch } from '@/lib/controllers/reconnect';
import { onRideSession, rideSessionActive } from '@/lib/controllers/rideSession';
import { useRideStore } from '@/stores/rideStore';

export type ReconnectPhase =
  | 'unchecked' // getDevices not asked yet
  | 'none' // no API, nothing granted, or the grant is gone: chooser only
  | 'available' // a granted trainer is known: offer one-tap reconnect
  | 'reconnecting'
  | 'connected'
  | 'failed'; // reconnect did not work: chooser fallback, with a sentence

export interface ReconnectState {
  phase: ReconnectPhase;
  /** Name of the granted trainer, e.g. "KICKR CORE 78C1". */
  name: string | null;
}

export type ReconnectEvent =
  | { type: 'checked'; name: string | null; found: boolean }
  | { type: 'start' }
  | { type: 'success' }
  | { type: 'fail' }
  /** The trainer got connected some other way (chooser), or dropped by the user. */
  | { type: 'paired' }
  | { type: 'disconnected' }
  /** The automatic reconnect after a drop gave up; the device handle is kept. */
  | { type: 'lost'; name: string | null };

export const INITIAL_RECONNECT: ReconnectState = { phase: 'unchecked', name: null };

export function reconnectReducer(state: ReconnectState, ev: ReconnectEvent): ReconnectState {
  switch (ev.type) {
    case 'checked':
      // A check never overrides a live link or an attempt in flight.
      if (state.phase === 'connected' || state.phase === 'reconnecting') return state;
      return ev.found ? { phase: 'available', name: ev.name } : { phase: 'none', name: null };
    case 'start':
      return state.phase === 'available' || state.phase === 'failed' ? { ...state, phase: 'reconnecting' } : state;
    case 'success':
      return state.phase === 'reconnecting' ? { ...state, phase: 'connected' } : state;
    case 'fail':
      return state.phase === 'reconnecting' ? { ...state, phase: 'failed' } : state;
    case 'paired':
      return { ...state, phase: 'connected' };
    case 'disconnected':
      // Grant is still there: the panel can offer reconnect again.
      return state.name ? { ...state, phase: 'available' } : { phase: 'none', name: null };
    case 'lost':
      return { phase: 'available', name: ev.name ?? state.name };
  }
}

/** Sentence under the button when the one-tap reconnect failed. */
export const RECONNECT_FAILED_TEXT = 'Could not reach it. Pedal once to wake it, then tap Pair trainer.';

export function reconnectLabel(name: string | null): string {
  return `Reconnect ${name ?? 'trainer'}`;
}

interface ReconnectStore extends ReconnectState {
  dispatch: (ev: ReconnectEvent) => void;
}

export const useTrainerReconnectStore = create<ReconnectStore>()((set) => ({
  ...INITIAL_RECONNECT,
  dispatch: (ev) => set((s) => reconnectReducer({ phase: s.phase, name: s.name }, ev)),
}));

function dispatch(ev: ReconnectEvent): void {
  useTrainerReconnectStore.getState().dispatch(ev);
}

let granted: BluetoothDevice | null = null;
let checking: Promise<void> | null = null;

/** Ask the browser once per page load whether a trainer is already granted. */
export function checkGrantedTrainer(): Promise<void> {
  if (!checking) {
    checking = findGrantedTrainer().then(
      (dev) => {
        granted = dev;
        dispatch({ type: 'checked', found: dev !== null, name: dev?.name ?? null });
      },
      () => dispatch({ type: 'checked', found: false, name: null }),
    );
  }
  return checking;
}

/**
 * Reconnect the granted trainer. `silent`: started by the Ride page or a
 * wake, so a failure only updates the panel state (no error toast mid-ride
 * start), and it writes nothing once the ride has closed. Without `silent`
 * it is a tap on Reconnect. Resolves true when connected. A failure inside
 * the ride session goes back to waiting for the trainer to wake.
 */
export async function reconnectGrantedTrainer(opts: { silent?: boolean; wake?: boolean } = {}): Promise<boolean> {
  await checkGrantedTrainer();
  const ride = useRideStore.getState();
  if (ride.connection === 'connected' || ride.connection === 'connecting') return ride.connection === 'connected';
  // Nobody tapped: only inside a ride the rider opened.
  if (opts.silent && !rideSessionActive()) return false;
  // The handle kept after a mid-ride drop works even where getDevices doesn't.
  const dev = granted ?? retainedTrainer();
  const phase = useTrainerReconnectStore.getState().phase;
  if (!dev || (phase !== 'available' && phase !== 'failed')) return false;
  // Already tried: wait for the rider (or for the trainer to wake up).
  if (opts.silent && !opts.wake && phase === 'failed') return false;
  dispatch({ type: 'start' });
  ride.setConnection('connecting');
  try {
    await reconnectGranted(dev, opts.silent ? { allowWrites: rideSessionActive } : {});
    const name = getDeviceName() ?? dev.name ?? null;
    const st = useRideStore.getState();
    st.setConnection('connected', { deviceName: name });
    st.setMode('trainer');
    st.pushToast({ kind: 'success', title: 'Trainer reconnected', message: name ?? undefined, durationMs: 3_000 });
    dispatch({ type: 'success' });
    return true;
  } catch {
    // Back to a clean "not paired" panel: the chooser is the fallback.
    useRideStore.getState().setConnection('disconnected', { deviceName: null });
    dispatch({ type: 'fail' });
    if (rideSessionActive()) void armTrainerWake();
    return false;
  }
}

// ---- wake ------------------------------------------------------------------

let wake: AdvertWatch | null = null;

function disarmWake(): void {
  const w = wake;
  wake = null;
  w?.stop();
}

/**
 * The automatic reconnect after a drop gave up, or the trainer dropped
 * outside a ride: remember it as reconnectable and, during a ride, wait for
 * it to wake (TrainerEventBridge calls this on the 'failed' and 'held'
 * reconnect phases). Resolves true only when the browser is actually
 * watching, so the rider is never told it will come back by itself when it
 * cannot.
 */
export async function trainerLost(name: string | null): Promise<boolean> {
  // After the grant check, so a late "nothing granted" cannot undo it.
  await checkGrantedTrainer();
  dispatch({ type: 'lost', name });
  return armTrainerWake();
}

/**
 * Reconnect the trainer the moment it advertises again (first pedal stroke
 * after it slept). Inside the ride session only, so nothing is ever sent to
 * the trainer outside a ride the rider opened, and only while it is not
 * connected. Resolves true when the browser accepted the watch; false
 * without watchAdvertisements, or when the browser refused it (then nothing
 * is kept armed).
 */
export async function armTrainerWake(): Promise<boolean> {
  if (!rideSessionActive()) return false;
  const conn = useRideStore.getState().connection;
  if (conn === 'connected' || conn === 'connecting' || conn === 'reconnecting') return false;
  if (wake) {
    const w = wake;
    return (await w.started) && wake === w;
  }
  const dev = retainedTrainer() ?? granted;
  if (!dev) return false;
  const phase = useTrainerReconnectStore.getState().phase;
  if (phase !== 'available' && phase !== 'failed') return false;
  const w = watchForWake(dev, () => {
    if (wake === w) wake = null;
    if (!rideSessionActive()) return;
    // A failure re-arms from reconnectGrantedTrainer.
    void reconnectGrantedTrainer({ silent: true, wake: true });
  });
  if (!w) return false;
  wake = w;
  const ok = await w.started;
  if (!ok && wake === w) wake = null;
  return ok && wake === w;
}

/** True while a wake watch is armed (tests and diagnostics). */
export function trainerWakeArmed(): boolean {
  return wake !== null;
}

onRideSession((active) => {
  if (active) void armTrainerWake();
  else disarmWake();
});

// Back by any route (retry loop, chooser, tap): stop scanning for it.
useRideStore.subscribe((s, prev) => {
  if (s.connection === 'connected' && prev.connection !== 'connected') disarmWake();
});

/** Tests only. */
export function __resetTrainerReconnectForTests(): void {
  granted = null;
  checking = null;
  disarmWake();
  useTrainerReconnectStore.setState({ ...INITIAL_RECONNECT });
}
