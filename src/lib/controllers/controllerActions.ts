/**
 * What each handlebar button does in a Velo ride. Pure mapping + the small
 * pure helpers the ride hook uses, so it can be tested without React.
 */

import type { RideButton } from '@/lib/controllers/rideProtocol';
import { CAMERA_MODES, type CameraMode } from '@/lib/cesiumCameras';
import { clampDifficulty } from '@/lib/trainerComfort';

export type ControllerAction =
  | 'gearHarder'
  | 'gearEasier'
  | 'hillsHarder'
  | 'hillsEasier'
  | 'cameraPrev'
  | 'cameraNext'
  | 'pauseResume';

export const BUTTON_ACTIONS: Readonly<Partial<Record<RideButton, ControllerAction>>> = {
  shiftUpL: 'gearHarder',
  shiftUpR: 'gearHarder',
  shiftDownL: 'gearEasier',
  shiftDownR: 'gearEasier',
  up: 'hillsHarder',
  down: 'hillsEasier',
  left: 'cameraPrev',
  right: 'cameraNext',
  a: 'pauseResume',
};

export function actionFor(button: RideButton): ControllerAction | null {
  return BUTTON_ACTIONS[button] ?? null;
}

/** Legend rows for the pairing panel, in reading order. */
export const ACTION_LEGEND: ReadonlyArray<{ controls: string; action: string }> = [
  { controls: 'Shift paddles', action: 'Gears: up is harder, down is easier' },
  { controls: 'Up / down', action: 'How hard the hills feel' },
  { controls: 'Left / right', action: 'Change camera' },
  { controls: 'A', action: 'Pause or carry on' },
  { controls: 'Orange levers', action: 'Steer across the lane' },
];

/** Hills-feel step for one D-pad press. */
export const HILLS_STEP = 0.05;

export function stepDifficulty(current: number, direction: 1 | -1): number {
  const next = clampDifficulty(current + direction * HILLS_STEP);
  return Math.round(next * 100) / 100;
}

export function cycleCamera(current: CameraMode, direction: 1 | -1): CameraMode {
  const i = CAMERA_MODES.indexOf(current);
  const n = CAMERA_MODES.length;
  const from = i < 0 ? 0 : i;
  return CAMERA_MODES[(from + direction + n) % n];
}
