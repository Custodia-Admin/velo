import { describe, it, expect } from 'vitest';
import {
  ACTION_LEGEND,
  BUTTON_ACTIONS,
  SHOW_BUTTON_ACTIONS,
  SHOW_LEGEND,
  actionFor,
  cycleCamera,
  runControllerAction,
  stepDifficulty,
  stepDistance,
  type ActionTarget,
  type ControllerAction,
} from './controllerActions';
import { BUTTON_MASKS } from './rideProtocol';
import { CAMERA_MODES, type CameraDistance, type CameraMode } from '@/lib/cesiumCameras';

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
    expect(cycleCamera('bogus' as CameraMode, 1)).toBe(CAMERA_MODES[1]); // unknown → from the first
  });
});

describe('show mode button map', () => {
  it('letter buttons drive the player only in show mode', () => {
    expect(actionFor('y')).toBeNull();
    expect(actionFor('z')).toBeNull();
    expect(actionFor('b')).toBeNull();
    expect(actionFor('y', { show: true })).toBe('showPlayPause');
    expect(actionFor('z', { show: true })).toBe('showNext');
    expect(actionFor('b', { show: true })).toBe('showAutoCamera');
  });

  it('everything else keeps its ride meaning in show mode; on/off stay unmapped', () => {
    for (const [button] of BUTTON_MASKS) {
      if (button in SHOW_BUTTON_ACTIONS) continue;
      expect(actionFor(button, { show: true })).toBe(actionFor(button));
    }
    expect(actionFor('powerL', { show: true })).toBeNull();
    expect(actionFor('powerR', { show: true })).toBeNull();
  });

  it('hood buttons move the camera closer / further', () => {
    expect(actionFor('hoodL')).toBe('cameraCloser');
    expect(actionFor('hoodR')).toBe('cameraFurther');
  });

  it('every mapped action has a legend row; the legend names no brand', () => {
    const text = [...ACTION_LEGEND, ...SHOW_LEGEND].map((r) => `${r.controls} ${r.action}`).join(' ');
    expect(text).toMatch(/Hood buttons/);
    expect(SHOW_LEGEND.map((r) => r.controls)).toEqual(['Y', 'Z', 'B']);
    expect(text.toLowerCase()).not.toContain('zwift');
  });
});

describe('stepDistance', () => {
  it('steps through close → overview and stops at the ends', () => {
    expect(stepDistance('standard', 1)).toBe('far');
    expect(stepDistance('standard', -1)).toBe('close');
    expect(stepDistance('close', -1)).toBe('close');
    expect(stepDistance('overview', 1)).toBe('overview');
    expect(stepDistance('bogus' as CameraDistance, 1)).toBe('far'); // unknown → from standard
  });
});

function target(over: Partial<{ show: boolean; auto: boolean; state: string; shifts: boolean }> = {}) {
  const log: string[] = [];
  const s = {
    difficulty: 0.5,
    camera: 'chase' as CameraMode,
    distance: 'standard' as CameraDistance,
    auto: over.auto ?? true,
  };
  const t: ActionTarget = {
    shift: (d) => {
      log.push(`shift ${d}`);
      return over.shifts ?? true;
    },
    buzzGear: () => log.push('buzz'),
    difficulty: () => s.difficulty,
    setDifficulty: (v) => {
      s.difficulty = v;
    },
    cameraMode: () => s.camera,
    setCameraMode: (m) => {
      s.camera = m;
    },
    cameraDistance: () => s.distance,
    setCameraDistance: (d) => {
      s.distance = d;
    },
    rideState: () => over.state ?? 'running',
    pause: () => log.push('pause'),
    resume: () => log.push('resume'),
    showActive: () => over.show ?? false,
    autoCamera: () => s.auto,
    setAutoCamera: (on) => {
      s.auto = on;
      log.push(`auto ${on}`);
    },
    showCommand: (c) => log.push(`show ${c}`),
  };
  return { t, s, log };
}

describe('runControllerAction', () => {
  const run = (a: ControllerAction, t: ActionTarget) => runControllerAction(a, t);

  it('a gear change buzzes; hitting the end of the range does not', () => {
    const ok = target();
    run('gearHarder', ok.t);
    run('gearEasier', ok.t);
    expect(ok.log).toEqual(['shift 1', 'buzz', 'shift -1', 'buzz']);
    const end = target({ shifts: false });
    run('gearHarder', end.t);
    expect(end.log).toEqual(['shift 1']);
  });

  it('hills, camera and distance', () => {
    const { t, s } = target();
    run('hillsHarder', t);
    expect(s.difficulty).toBe(0.55);
    run('hillsEasier', t);
    run('hillsEasier', t);
    expect(s.difficulty).toBe(0.45);
    run('cameraNext', t);
    expect(s.camera).toBe(CAMERA_MODES[1]);
    run('cameraPrev', t);
    expect(s.camera).toBe('chase');
    run('cameraFurther', t);
    expect(s.distance).toBe('far');
    run('cameraCloser', t);
    run('cameraCloser', t);
    expect(s.distance).toBe('close');
    expect(s.auto).toBe(true); // outside show mode the auto camera is untouched
  });

  it('pause / resume only from running / paused', () => {
    const running = target({ state: 'running' });
    run('pauseResume', running.t);
    const paused = target({ state: 'paused' });
    run('pauseResume', paused.t);
    const ready = target({ state: 'ready' });
    run('pauseResume', ready.t);
    expect([running.log, paused.log, ready.log]).toEqual([['pause'], ['resume'], []]);
  });

  it('show mode: player commands, auto camera toggle, and a manual camera takes over', () => {
    const { t, s, log } = target({ show: true });
    run('showPlayPause', t);
    run('showNext', t);
    run('showAutoCamera', t);
    run('showAutoCamera', t);
    expect(log).toEqual(['show togglePlay', 'show next', 'auto false', 'auto true']);
    run('cameraNext', t);
    expect(s.auto).toBe(false);
    expect(s.camera).toBe(CAMERA_MODES[1]);
    run('cameraNext', t); // already manual: no second toggle
    expect(log.filter((l) => l.startsWith('auto'))).toEqual(['auto false', 'auto true', 'auto false']);
  });

  it('show actions do nothing when show mode is off', () => {
    const { t, log } = target({ show: false });
    run('showPlayPause', t);
    run('showNext', t);
    run('showAutoCamera', t);
    expect(log).toEqual([]);
  });
});
