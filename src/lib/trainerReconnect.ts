/**
 * Reconnect the trainer paired in an earlier session without the chooser.
 *
 * Chrome keeps the Bluetooth grant across reloads; navigator.bluetooth
 * .getDevices() hands the device back and gatt.connect() works without a
 * user gesture. The Trainer panel offers a one-tap "Reconnect <name>", and
 * the Ride page tries it silently on start. Any failure falls back to the
 * normal chooser ("Pair trainer").
 *
 * The phase logic is a pure reducer so it is unit-tested without Bluetooth.
 */

import { create } from 'zustand';
import { findGrantedTrainer, getDeviceName, reconnectGranted } from '@/lib/ftms';
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
  | { type: 'disconnected' };

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
 * Reconnect the granted trainer. `silent`: started by the Ride page, so a
 * failure only updates the panel state (no error toast mid-ride start).
 * Resolves true when connected.
 */
export async function reconnectGrantedTrainer(opts: { silent?: boolean } = {}): Promise<boolean> {
  await checkGrantedTrainer();
  const ride = useRideStore.getState();
  if (ride.connection === 'connected' || ride.connection === 'connecting') return ride.connection === 'connected';
  const dev = granted;
  const phase = useTrainerReconnectStore.getState().phase;
  if (!dev || (phase !== 'available' && phase !== 'failed')) return false;
  if (opts.silent && phase === 'failed') return false; // already tried: wait for the rider
  dispatch({ type: 'start' });
  ride.setConnection('connecting');
  try {
    await reconnectGranted(dev);
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
    return false;
  }
}

/** Tests only. */
export function __resetTrainerReconnectForTests(): void {
  granted = null;
  checking = null;
  useTrainerReconnectStore.setState({ ...INITIAL_RECONNECT });
}
