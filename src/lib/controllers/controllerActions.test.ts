import { describe, it, expect } from 'vitest';
import { BUTTON_ACTIONS, actionFor, cycleCamera, stepDifficulty } from './controllerActions';
import { CAMERA_MODES } from '@/lib/cesiumCameras';

describe('button mapping', () => {
  it('shift paddles on both sides change gear', () => {
    expect(actionFor('shiftUpL')).toBe('gearHarder');
    expect(actionFor('shiftUpR')).toBe('gearHarder');
    expect(actionFor('shiftDownL')).toBe('gearEasier');
    expect(actionFor('shiftDownR')).toBe('gearEasier');
  });

  it('D-pad: up/down hills, left/right camera; A pauses', () => {
    expect(actionFor('up')).toBe('hillsHarder');
    expect(actionFor('down')).toBe('hillsEasier');
    expect(actionFor('left')).toBe('cameraPrev');
    expect(actionFor('right')).toBe('cameraNext');
    expect(actionFor('a')).toBe('pauseResume');
  });

  it('leaves the on/off buttons unmapped (they power the controllers)', () => {
    expect(actionFor('powerL')).toBeNull();
    expect(actionFor('powerR')).toBeNull();
    expect(Object.keys(BUTTON_ACTIONS)).not.toContain('powerL');
  });
});

describe('stepDifficulty', () => {
  it('moves in 5 % steps and clamps to 0..100 %', () => {
    expect(stepDifficulty(0.35, 1)).toBe(0.4);
    expect(stepDifficulty(0.35, -1)).toBe(0.3);
    expect(stepDifficulty(1, 1)).toBe(1);
    expect(stepDifficulty(0, -1)).toBe(0);
  });
  it('has no float drift after many presses', () => {
    let d = 0.35;
    for (let i = 0; i < 7; i++) d = stepDifficulty(d, 1);
    expect(d).toBe(0.7);
  });
});

describe('cycleCamera', () => {
  it('wraps both ways', () => {
    const last = CAMERA_MODES[CAMERA_MODES.length - 1];
    expect(cycleCamera(CAMERA_MODES[0], -1)).toBe(last);
    expect(cycleCamera(last, 1)).toBe(CAMERA_MODES[0]);
    expect(cycleCamera(CAMERA_MODES[0], 1)).toBe(CAMERA_MODES[1]);
  });
});
