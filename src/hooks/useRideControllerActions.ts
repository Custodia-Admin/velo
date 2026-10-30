/**
 * Handlebar buttons during a ride. Mounted by the Ride page only, so presses
 * on Home do nothing. Gears start neutral every ride.
 */

import { useEffect } from 'react';
import { onControllerButton, buzzRideController } from '@/lib/controllers/rideController';
import { actionFor, cycleCamera, stepDifficulty } from '@/lib/controllers/controllerActions';
import { useControllerStore } from '@/stores/controllerStore';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';

export function useRideControllerActions(): void {
  useEffect(() => {
    useControllerStore.getState().resetGear();

    return onControllerButton((button) => {
      const action = actionFor(button);
      if (!action) return;
      const settings = useSettingsStore.getState();
      switch (action) {
        case 'gearHarder':
        case 'gearEasier':
          if (useControllerStore.getState().shift(action === 'gearHarder' ? 1 : -1)) buzzRideController();
          return;
        case 'hillsHarder':
        case 'hillsEasier':
          settings.setSettings({
            trainerDifficulty: stepDifficulty(settings.trainerDifficulty, action === 'hillsHarder' ? 1 : -1),
          });
          return;
        case 'cameraPrev':
        case 'cameraNext':
          settings.setCameraMode(cycleCamera(settings.cameraMode, action === 'cameraNext' ? 1 : -1));
          return;
        case 'pauseResume': {
          const ride = useRideStore.getState();
          if (ride.rideState === 'running') ride.pause();
          else if (ride.rideState === 'paused') ride.resume();
          return;
        }
      }
    });
  }, []);
}
