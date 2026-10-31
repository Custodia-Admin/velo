/**
 * controllerStore — live state of the handlebar controls.
 *
 * Connection state, battery, the current virtual gear and the steering
 * input. Only `steeringEnabled` is persisted; gears start neutral every ride.
 * Without paired controls everything stays at its neutral value, so the ride
 * loop behaves exactly as with the trainer alone.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { NEUTRAL_GEAR, clampGear } from '@/lib/virtualGears';

export type ControllerStatus =
  | 'idle' // never paired this session
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'asleep' // dropped and did not come back
  | 'locked' // controller service hidden (needs the daily unlock)
  | 'error';

interface ControllerState {
  status: ControllerStatus;
  deviceName: string | null;
  battery: number | null;
  /** Paired, but not a single message after the handshake. */
  silent: boolean;
  /** Plain sentence for status 'error'. */
  errorMessage: string | null;
  gear: number;
  /** -1 (left) .. 1 (right), 0 at rest. */
  steer: number;
  steeringEnabled: boolean;

  setStatus: (status: ControllerStatus, errorMessage?: string | null) => void;
  setDevice: (name: string | null) => void;
  setBattery: (pct: number | null) => void;
  setSilent: (silent: boolean) => void;
  setSteer: (steer: number) => void;
  setSteeringEnabled: (on: boolean) => void;
  /** Change gear by `delta`; returns true if the gear actually changed. */
  shift: (delta: number) => boolean;
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
      gear: NEUTRAL_GEAR,
      steer: 0,
      steeringEnabled: true,

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
      setSteer: (steer) => set({ steer: Number.isFinite(steer) ? Math.max(-1, Math.min(1, steer)) : 0 }),
      setSteeringEnabled: (steeringEnabled) => set({ steeringEnabled }),
      shift: (delta) => {
        const before = get().gear;
        const after = clampGear(before + delta);
        if (after === before) return false;
        set({ gear: after });
        return true;
      },
      resetGear: () => set({ gear: NEUTRAL_GEAR }),
    }),
    {
      name: 'globeride.controllers',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ steeringEnabled: s.steeringEnabled }),
    },
  ),
);

/** Gear to use for trainer resistance right now (neutral unless controls are live). */
export function activeGear(): number {
  const s = useControllerStore.getState();
  // A short drop keeps the gear so resistance does not jump; once the
  // controls are given up on (asleep) the trainer goes back to neutral.
  return s.status === 'connected' || s.status === 'reconnecting' ? s.gear : NEUTRAL_GEAR;
}

/** Steering input to apply right now (0 unless enabled and connected). */
export function activeSteer(): number {
  const s = useControllerStore.getState();
  return s.steeringEnabled && s.status === 'connected' ? s.steer : 0;
}
