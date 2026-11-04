/**
 * What each handlebar button does in a Velo ride. Pure mapping + the small
 * pure helpers the ride hook uses, so it can be tested without React.
 *
 * Two maps: the ride map, and show mode on top of it (watching your own
 * videos), which gives the letter buttons to the player. The on/off buttons
 * are never mapped: they power the controllers.
 */

import type { RideButton } from '@/lib/controllers/rideProtocol';
import { CAMERA_DISTANCES, CAMERA_MODES, type CameraDistance, type CameraMode } from '@/lib/cesiumCameras';
import { clampDifficulty } from '@/lib/trainerComfort';

export type ControllerAction =
  | 'gearHarder'
  | 'gearEasier'
  | 'hillsHarder'
  | 'hillsEasier'
  | 'cameraPrev'
  | 'cameraNext'
  | 'cameraCloser'
  | 'cameraFurther'
  | 'pauseResume'
  | 'showPlayPause'
  | 'showNext'
  | 'showAutoCamera';

export const BUTTON_ACTIONS: Readonly<Partial<Record<RideButton, ControllerAction>>> = {
  shiftUpL: 'gearHarder',
  shiftUpR: 'gearHarder',
  shiftDownL: 'gearEasier',
  shiftDownR: 'gearEasier',
  up: 'hillsHarder',
  down: 'hillsEasier',
  left: 'cameraPrev',
  right: 'cameraNext',
  hoodL: 'cameraCloser',
  hoodR: 'cameraFurther',
  a: 'pauseResume',
};

/** Show mode adds these on top of the ride map. */
export const SHOW_BUTTON_ACTIONS: Readonly<Partial<Record<RideButton, ControllerAction>>> = {
  y: 'showPlayPause',
  z: 'showNext',
  b: 'showAutoCamera',
};

export interface ActionContext {
  /** Show mode is on. */
  show?: boolean;
}

export function actionFor(button: RideButton, ctx: ActionContext = {}): ControllerAction | null {
  if (ctx.show) {
    const showAction = SHOW_BUTTON_ACTIONS[button];
    if (showAction) return showAction;
  }
  return BUTTON_ACTIONS[button] ?? null;
}

export interface LegendRow {
  controls: string;
  action: string;
}

/** Legend rows for the pairing panel, in reading order. */
export const ACTION_LEGEND: ReadonlyArray<LegendRow> = [
  { controls: 'Shift paddles', action: 'Gears: up is harder, down is easier' },
  { controls: 'Up / down', action: 'How hard the hills feel' },
  { controls: 'Left / right', action: 'Change camera' },
  { controls: 'Hood buttons', action: 'Camera closer (left) or further (right)' },
  { controls: 'A', action: 'Pause or carry on' },
  { controls: 'Orange levers', action: 'Steer across the lane' },
];

/** Extra rows while show mode is on. */
export const SHOW_LEGEND: ReadonlyArray<LegendRow> = [
  { controls: 'Y', action: 'Play or pause the video' },
  { controls: 'Z', action: 'Next video' },
  { controls: 'B', action: 'Auto camera on or off' },
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

/** One distance step closer (-1) or further (+1); stops at the ends. */
export function stepDistance(current: CameraDistance, direction: 1 | -1): CameraDistance {
  const i = CAMERA_DISTANCES.indexOf(current);
  const from = i < 0 ? CAMERA_DISTANCES.indexOf('standard') : i;
  const to = Math.max(0, Math.min(CAMERA_DISTANCES.length - 1, from + direction));
  return CAMERA_DISTANCES[to];
}

export type ShowCommand = 'togglePlay' | 'next';

/** Everything an action may touch. The ride hook wires it to the stores. */
export interface ActionTarget {
  /** Change gear; true when it actually changed. */
  shift(delta: 1 | -1): boolean;
  /** The gear-change buzz (gated on the rider's setting by the controller). */
  buzzGear(): void;
  difficulty(): number;
  setDifficulty(value: number): void;
  cameraMode(): CameraMode;
  setCameraMode(mode: CameraMode): void;
  cameraDistance(): CameraDistance;
  setCameraDistance(d: CameraDistance): void;
  rideState(): string;
  pause(): void;
  resume(): void;
  showActive(): boolean;
  autoCamera(): boolean;
  setAutoCamera(on: boolean): void;
  showCommand(cmd: ShowCommand): void;
}

/** Run one button action. Pure apart from the target it is handed. */
export function runControllerAction(action: ControllerAction, t: ActionTarget): void {
  switch (action) {
    case 'gearHarder':
    case 'gearEasier':
      if (t.shift(action === 'gearHarder' ? 1 : -1)) t.buzzGear();
      return;
    case 'hillsHarder':
    case 'hillsEasier':
      t.setDifficulty(stepDifficulty(t.difficulty(), action === 'hillsHarder' ? 1 : -1));
      return;
    case 'cameraPrev':
    case 'cameraNext':
      // Choosing a camera in show mode takes it over from the auto camera.
      if (t.showActive() && t.autoCamera()) t.setAutoCamera(false);
      t.setCameraMode(cycleCamera(t.cameraMode(), action === 'cameraNext' ? 1 : -1));
      return;
    case 'cameraCloser':
    case 'cameraFurther':
      t.setCameraDistance(stepDistance(t.cameraDistance(), action === 'cameraFurther' ? 1 : -1));
      return;
    case 'pauseResume': {
      const state = t.rideState();
      if (state === 'running') t.pause();
      else if (state === 'paused') t.resume();
      return;
    }
    case 'showPlayPause':
      if (t.showActive()) t.showCommand('togglePlay');
      return;
    case 'showNext':
      if (t.showActive()) t.showCommand('next');
      return;
    case 'showAutoCamera':
      if (t.showActive()) t.setAutoCamera(!t.autoCamera());
      return;
  }
}
