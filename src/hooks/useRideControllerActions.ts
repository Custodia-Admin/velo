/**
 * Handlebar buttons during a ride. Mounted by the Ride page only, so presses
 * on Home do nothing. Gears start neutral every ride. The button map and
 * what each action does live in src/lib/controllers/controllerActions.ts.
 */

import { useEffect } from 'react';
import { onControllerButton, buzzRideController } from '@/lib/controllers/rideController';
import { actionFor, runControllerAction, type ActionTarget } from '@/lib/controllers/controllerActions';
import { useControllerStore } from '@/stores/controllerStore';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { sendShowPlayerCommand, useShowStore } from '@/stores/showStore';

/** The stores, as the action runner sees them. */
export const storeActionTarget: ActionTarget = {
  shift: (delta) => useControllerStore.getState().shift(delta),
  buzzGear: () => void buzzRideController('gear'),
  difficulty: () => useSettingsStore.getState().trainerDifficulty,
  setDifficulty: (trainerDifficulty) => useSettingsStore.getState().setSettings({ trainerDifficulty }),
  cameraMode: () => useSettingsStore.getState().cameraMode,
  setCameraMode: (mode) => useSettingsStore.getState().setCameraMode(mode),
  cameraDistance: () => useSettingsStore.getState().cameraDistance,
  setCameraDistance: (cameraDistance) => useSettingsStore.getState().setSettings({ cameraDistance }),
  rideState: () => useRideStore.getState().rideState,
  pause: () => useRideStore.getState().pause(),
  resume: () => useRideStore.getState().resume(),
  showActive: () => useShowStore.getState().active,
  autoCamera: () => useShowStore.getState().autoCamera,
  setAutoCamera: (on) => useShowStore.getState().setAutoCamera(on),
  showCommand: (cmd) => void sendShowPlayerCommand(cmd),
};

export function useRideControllerActions(): void {
  useEffect(() => {
    useControllerStore.getState().resetGear();

    return onControllerButton((button) => {
      const action = actionFor(button, { show: useShowStore.getState().active });
      if (action) runControllerAction(action, storeActionTarget);
    });
  }, []);
}
