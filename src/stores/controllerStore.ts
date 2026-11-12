/**
 * controllerStore — live state of the handlebar controls.
 *
 * Connection state, battery, the current virtual gear and the steering
 * input. Only the rider's choices (steering, gear buzz, debug overlay) are
 * persisted; gears start
 * neutral every ride. Without paired controls everything stays at its
 * neutral value, so the ride loop behaves exactly as with the trainer alone.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { NEUTRAL_GEAR, clampGear } from '@/lib/virtualGears';
import { shapeSteer } from '@/lib/controllers/steerFeel';
import type { RideButton } from '@/lib/controllers/rideProtocol';

export type ControllerStatus =
  | 'idle' // never paired this session
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'asleep' // dropped and did not come back
  | 'locked' // controller service hidden (needs the daily unlock)
  | 'error';

/**
 * Which handlebar unit is paired, read from its advertisement.
 * 'unknown': the browser can watch adverts but none arrived in time;
 * 'unsupported': the browser cannot watch adverts at all.
 */
export type ControllerSideCheck = 'left' | 'right' | 'unknown' | 'unsupported';

/** One handlebar press as heard (seq changes on every press, even a repeat). */
export interface LastPress {
  button: RideButton;
  seq: number;
}

/** Result of the confirm buzz sent right after the handshake. */
export type BuzzResult = 'ok' | 'failed';

interface ControllerState {
  status: ControllerStatus;
  deviceName: string | null;
  battery: number | null;
  /** Paired, but not a single message after the handshake. */
  silent: boolean;
  /** Plain sentence for status 'error'. */
  errorMessage: string | null;
  /** Null until the side check after the chooser has run. */
  side: ControllerSideCheck | null;
  /** Null until the confirm buzz has been tried. */
  buzz: BuzzResult | null;
  /** At least one button/lever message arrived this session. */
  inputSeen: boolean;
  /** Asleep controls: the browser is watching for a button press to reconnect them. */
  wakeArmed: boolean;
  gear: number;
  /** -1 (left) .. 1 (right), 0 at rest. */
  steer: number;
  steeringEnabled: boolean;
  /** A short buzz on the bars at every gear change. */
  gearBuzz: boolean;
  /** Show the raw-message overlay in the ride view (field diagnostics). */
  debugOverlay: boolean;
  /**
   * The rider shifted with the keyboard or the on-screen gear buttons this
   * ride: the gear then applies even without live handlebar controls.
   */
  manualGear: boolean;
  /** The last handlebar button Velo heard (the Devices page readout). */
  lastPress: LastPress | null;

  setStatus: (status: ControllerStatus, errorMessage?: string | null) => void;
  setDevice: (name: string | null) => void;
  setBattery: (pct: number | null) => void;
  setSilent: (silent: boolean) => void;
  setSide: (side: ControllerSideCheck | null) => void;
  setBuzz: (buzz: BuzzResult | null) => void;
  setInputSeen: (seen: boolean) => void;
  setWakeArmed: (armed: boolean) => void;
  setSteer: (steer: number) => void;
  setSteeringEnabled: (on: boolean) => void;
  setGearBuzz: (on: boolean) => void;
  setDebugOverlay: (on: boolean) => void;
  setLastPress: (button: RideButton) => void;
  /** Change gear by `delta`; returns true if the gear actually changed. */
  shift: (delta: number) => boolean;
  /**
   * Keyboard / on-screen shift: one step from the gear the trainer uses
   * right now ({@link activeGear}), and the gear applies from then on even
   * without live handlebar controls. True if the gear changed.
   */
  shiftManual: (delta: 1 | -1) => boolean;
  resetGear: () => void;
}

export const useControllerStore = create<ControllerState>()(
  persist(
    (set, get) => ({
      status: 'idle',
      deviceName: null,
      battery: null,
      silent: false,
      errorMessage: null,
      side: null,
      buzz: null,
      inputSeen: false,
      wakeArmed: false,
      gear: NEUTRAL_GEAR,
      steer: 0,
      steeringEnabled: true,
      gearBuzz: true,
      debugOverlay: false,
      manualGear: false,
      lastPress: null,

      setStatus: (status, errorMessage = null) =>
        set({
          status,
          errorMessage: status === 'error' ? errorMessage : null,
          // Steering input means nothing once the link is gone.
          ...(status === 'connected' ? {} : { steer: 0 }),
        }),
      setDevice: (deviceName) => set({ deviceName }),
      setBattery: (battery) => set({ battery }),
      setSilent: (silent) => set({ silent }),
      setWakeArmed: (wakeArmed) => set({ wakeArmed }),
      setSide: (side) => set({ side }),
      setBuzz: (buzz) => set({ buzz }),
      setInputSeen: (inputSeen) => set({ inputSeen }),
      setSteer: (steer) => set({ steer: Number.isFinite(steer) ? Math.max(-1, Math.min(1, steer)) : 0 }),
      setSteeringEnabled: (steeringEnabled) => set({ steeringEnabled }),
      setGearBuzz: (gearBuzz) => set({ gearBuzz }),
      setDebugOverlay: (debugOverlay) => set({ debugOverlay }),
      shift: (delta) => {
        const before = get().gear;
        const after = clampGear(before + delta);
        if (after === before) return false;
        set({ gear: after });
        return true;
      },
      setLastPress: (button) => set({ lastPress: { button, seq: (get().lastPress?.seq ?? 0) + 1 } }),
      shiftManual: (delta) => {
        const before = activeGear();
        const after = clampGear(before + delta);
        const changed = after !== before;
        set({ gear: after, manualGear: true });
        return changed;
      },
      resetGear: () => set({ gear: NEUTRAL_GEAR, manualGear: false }),
    }),
    {
      name: 'globeride.controllers',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ steeringEnabled: s.steeringEnabled, gearBuzz: s.gearBuzz, debugOverlay: s.debugOverlay }),
    },
  ),
);

/**
 * Gear to use for trainer resistance right now: neutral unless the controls
 * are live or the rider shifted from the keyboard / screen this ride.
 */
export function activeGear(): number {
  const s = useControllerStore.getState();
  return gearInUse(s.status, s.gear, s.manualGear);
}

/** Pure rule behind {@link activeGear}. */
export function gearInUse(status: ControllerStatus, gear: number, manual: boolean): number {
  // A short drop keeps the gear so resistance does not jump; once the
  // controls are given up on (asleep) the trainer goes back to neutral,
  // unless the rider shifts by keyboard or screen, which always works.
  return manual || status === 'connected' || status === 'reconnecting' ? gear : NEUTRAL_GEAR;
}

/**
 * Steering input to apply right now, after the deadzone and expo curve
 * (src/lib/controllers/steerFeel.ts). 0 unless enabled and connected.
 */
export function activeSteer(): number {
  const s = useControllerStore.getState();
  return s.steeringEnabled && s.status === 'connected' ? shapeSteer(s.steer) : 0;
}
