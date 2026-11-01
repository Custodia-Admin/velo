import { describe, expect, it } from 'vitest';
import {
  ASLEEP_TEXT,
  COULDNT_FIND,
  HR_EMPTY_HELP,
  TRAINER_EMPTY_HELP,
  WAITING_TEXT,
  handlebarName,
  handlebarRow,
  heartRateRow,
  rideLine,
  stepForErrorCode,
  stepForReport,
  trainerErrorTitle,
  trainerRow,
  type HandlebarRowInput,
  type TrainerRowInput,
} from './devicesView';
import {
  LOCKED_INTRO,
  MAYBE_RIGHT_TEXT,
  PAIR_OTHER_LABEL,
  RIGHT_SIDE_TEXT,
  UNLOCK_INTRO,
} from '@/lib/controllers/controllerView';

const usable = { apiPresent: true, secureContext: true, usable: true, reason: null };

function trainer(over: Partial<TrainerRowInput> = {}): TrainerRowInput {
  return {
    connection: 'disconnected',
    deviceName: null,
    error: null,
    errorCode: null,
    report: usable,
    reconnectPhase: 'none',
    reconnectName: null,
    controlMode: 'sim',
    targetPowerW: null,
    ...over,
  };
}

const ids = (v: { action: { id: string } | null; extras: { id: string }[] }) => ({
  action: v.action?.id ?? null,
  extras: v.extras.map((x) => x.id),
});

describe('trainerRow', () => {
  it('without Web Bluetooth: a plain sentence, no pairing button', () => {
    const v = trainerRow(
      trainer({ report: { apiPresent: false, secureContext: true, usable: false, reason: 'Safari cannot pair Bluetooth.' } }),
    );
    expect(v.state).toBe('Safari cannot pair Bluetooth.');
    expect(v.action).toBeNull();
    expect(ids(v).extras).toEqual(['guide']);
  });

  it('insecure context counts as no Bluetooth', () => {
    const v = trainerRow(trainer({ report: { apiPresent: true, secureContext: false, usable: false, reason: 'Needs HTTPS.' } }));
    expect(v.action).toBeNull();
  });

  it('not paired: Pair + pairing guide', () => {
    const v = trainerRow(trainer());
    expect(v.state).toBe('Not paired');
    expect(ids(v)).toEqual({ action: 'pair', extras: ['guide'] });
  });

  it('adapter reads off: still offers Pair, explains with the probe sentence', () => {
    const reason = 'Bluetooth looks off or busy. Turn it on, close other apps using it, then retry.';
    const v = trainerRow(trainer({ report: { apiPresent: true, secureContext: true, usable: false, reason } }));
    expect(v.action?.id).toBe('pair');
    expect(v.help).toBe(reason);
  });

  it('granted earlier: one-tap reconnect, chooser as the lesser action', () => {
    const v = trainerRow(trainer({ reconnectPhase: 'available', reconnectName: 'KICKR CORE 78C1' }));
    expect(v.name).toBe('Trainer · KICKR CORE 78C1');
    expect(ids(v)).toEqual({ action: 'reconnect', extras: ['pair'] });
    expect(v.action?.ariaLabel).toBe('Reconnect KICKR CORE 78C1');
  });

  it('reconnect failed: says so and keeps both paths', () => {
    const v = trainerRow(trainer({ reconnectPhase: 'failed', reconnectName: 'KICKR CORE 78C1' }));
    expect(v.help).toMatch(/Pedal once/);
    expect(ids(v)).toEqual({ action: 'reconnect', extras: ['pair'] });
  });

  it('connecting / reconnecting: busy, no second attempt', () => {
    for (const connection of ['connecting', 'reconnecting'] as const) {
      const v = trainerRow(trainer({ connection }));
      expect(v.tone).toBe('busy');
      expect(v.action?.busy).toBe(true);
    }
  });

  it('connected in SIM: the road sets the resistance, Disconnect', () => {
    const v = trainerRow(trainer({ connection: 'connected', deviceName: 'KICKR CORE 78C1' }));
    expect(v.name).toBe('Trainer · KICKR CORE 78C1');
    expect(v.state).toBe('Connected · the road sets the resistance');
    expect(v.tone).toBe('ok');
    expect(ids(v)).toEqual({ action: 'disconnect', extras: [] });
  });

  it('connected in ERG: names the target', () => {
    expect(trainerRow(trainer({ connection: 'connected', controlMode: 'erg', targetPowerW: 200 })).state).toBe(
      'Connected · ERG holds 200 W',
    );
    expect(trainerRow(trainer({ connection: 'connected', controlMode: 'erg' })).state).toMatch(/waiting/);
  });

  it("empty chooser: Couldn't find it, wake advice, try again / show all / guide", () => {
    const v = trainerRow(trainer({ connection: 'error', errorCode: 'no-device-found', error: 'x' }));
    expect(v.tone).toBe('error');
    expect(v.state).toBe(COULDNT_FIND);
    expect(v.help).toBe(TRAINER_EMPTY_HELP);
    expect(ids(v)).toEqual({ action: 'pair', extras: ['pairAll', 'guide'] });
    expect(v.action?.label).toBe('Try again');
  });

  it('other errors: the real title and message, no show-all', () => {
    const v = trainerRow(trainer({ connection: 'error', errorCode: 'already-paired-elsewhere', error: 'Close Zwift.' }));
    expect(v.state).toBe('Trainer is paired with another app');
    expect(v.help).toBe('Close Zwift.');
    expect(ids(v)).toEqual({ action: 'pair', extras: ['guide'] });
  });

  it('guide steps follow TrainerConnect', () => {
    expect(stepForReport('ios-unsupported')).toBe('browser');
    expect(stepForReport('insecure-context')).toBe('https');
    expect(stepForReport('adapter-unavailable')).toBe('wake');
    expect(stepForErrorCode('permission-denied')).toBe('permission');
    expect(stepForErrorCode('no-device-selected')).toBe('empty');
    expect(stepForErrorCode('control-point-failed')).toBe('others');
    expect(stepForErrorCode(null)).toBe('chooser');
    expect(trainerErrorTitle('gatt-connect-failed')).toBe("Couldn't open a GATT connection");
  });
});

function bars(over: Partial<HandlebarRowInput> = {}): HandlebarRowInput {
  return {
    status: 'idle',
    silent: false,
    side: null,
    inputSeen: false,
    buzz: null,
    deviceName: null,
    errorMessage: null,
    tried: false,
    ...over,
  };
}

describe('handlebarRow (every ControllerPanel state keeps its actions)', () => {
  it('names the side when known', () => {
    expect(handlebarName('left', 'Zwift Ride')).toBe('Left handlebar · Zwift Ride');
    expect(handlebarName('right', 'Zwift Ride')).toBe('Right handlebar · Zwift Ride');
    expect(handlebarName('unknown', 'Zwift Ride')).toBe('Handlebar controls');
    expect(handlebarName(null, null)).toBe('Handlebar controls');
  });

  it('idle: Pair; after a try that did not connect, Try again + Show all devices', () => {
    expect(ids(handlebarRow(bars()))).toEqual({ action: 'pair', extras: [] });
    const v = handlebarRow(bars({ tried: true }));
    expect(v.action?.label).toBe('Try again');
    expect(ids(v)).toEqual({ action: 'pair', extras: ['pairAll'] });
  });

  it('error: the store sentence, Try again', () => {
    const v = handlebarRow(bars({ status: 'error', errorMessage: 'Bluetooth went away.', tried: true }));
    expect(v.tone).toBe('error');
    expect(v.help).toBe('Bluetooth went away.');
    expect(ids(v)).toEqual({ action: 'pair', extras: ['pairAll'] });
  });

  it('pairing: busy', () => {
    const v = handlebarRow(bars({ status: 'connecting' }));
    expect(v.action?.busy).toBe(true);
    expect(v.settings).toBe(false);
  });

  it('live left: gears and buttons, battery, Test buzz + Disconnect, settings', () => {
    const v = handlebarRow(bars({ status: 'connected', side: 'left', inputSeen: true, buzz: 'ok', deviceName: 'Zwift Ride' }));
    expect(v.name).toBe('Left handlebar · Zwift Ride');
    expect(v.state).toBe('Connected · gears and buttons');
    expect(v.tone).toBe('ok');
    expect(v.showBattery).toBe(true);
    expect(v.settings).toBe(true);
    expect(ids(v)).toEqual({ action: 'buzz', extras: ['disconnect'] });
    expect(v.action?.disabled).toBe(false);
  });

  it('waiting: asks for a paddle press', () => {
    const v = handlebarRow(bars({ status: 'connected', side: 'left', buzz: 'ok' }));
    expect(v.phase).toBe('waiting');
    expect(v.state).toBe('Connected · buzzed');
    expect(v.help).toBe(WAITING_TEXT);
    expect(ids(v)).toEqual({ action: 'buzz', extras: ['disconnect'] });
  });

  it('right side: explains, offers the other controller + Disconnect', () => {
    const v = handlebarRow(bars({ status: 'connected', side: 'right', deviceName: 'Zwift Ride' }));
    expect(v.name).toBe('Right handlebar · Zwift Ride');
    expect(v.tone).toBe('warn');
    expect(v.help).toBe(RIGHT_SIDE_TEXT);
    expect(v.action?.label).toBe(PAIR_OTHER_LABEL);
    expect(ids(v)).toEqual({ action: 'pairOther', extras: ['disconnect'] });
  });

  it('silent: unlock recipe, Reconnect; pair-other only when the side is not known to be left', () => {
    const unknown = handlebarRow(bars({ status: 'connected', silent: true, side: 'unknown' }));
    expect(unknown.unlockIntro).toBe(UNLOCK_INTRO);
    expect(unknown.help).toBe(MAYBE_RIGHT_TEXT);
    expect(ids(unknown)).toEqual({ action: 'reconnect', extras: ['pairOther', 'disconnect'] });
    const left = handlebarRow(bars({ status: 'connected', silent: true, side: 'left' }));
    expect(left.help).toBeNull();
    expect(ids(left)).toEqual({ action: 'reconnect', extras: ['disconnect'] });
  });

  it('reconnecting: Test buzz disabled, Disconnect, settings stay', () => {
    const v = handlebarRow(bars({ status: 'reconnecting', side: 'left', inputSeen: true }));
    expect(v.tone).toBe('busy');
    expect(v.action?.disabled).toBe(true);
    expect(v.settings).toBe(true);
    expect(ids(v)).toEqual({ action: 'buzz', extras: ['disconnect'] });
  });

  it('locked: recipe, Try again (reconnect) + Forget', () => {
    const v = handlebarRow(bars({ status: 'locked' }));
    expect(v.unlockIntro).toBe(LOCKED_INTRO);
    expect(v.action?.label).toBe('Try again');
    expect(ids(v)).toEqual({ action: 'reconnect', extras: ['forget'] });
  });

  it('asleep: sentence, Reconnect + Forget', () => {
    const v = handlebarRow(bars({ status: 'asleep' }));
    expect(v.help).toBe(ASLEEP_TEXT);
    expect(ids(v)).toEqual({ action: 'reconnect', extras: ['forget'] });
  });
});

describe('heartRateRow', () => {
  const hr = (over: Partial<Parameters<typeof heartRateRow>[0]> = {}) =>
    heartRateRow({ status: 'disconnected', deviceName: null, bpm: null, error: null, errorCode: null, ...over });

  it('not paired: optional, Pair', () => {
    const v = hr();
    expect(v.state).toBe('Optional · not paired');
    expect(ids(v)).toEqual({ action: 'pair', extras: [] });
  });

  it('connected: name + bpm, Disconnect', () => {
    const v = hr({ status: 'connected', deviceName: 'TICKR', bpm: 128.4 });
    expect(v.name).toBe('Heart rate · TICKR');
    expect(v.state).toBe('Connected · 128 bpm');
    expect(ids(v)).toEqual({ action: 'disconnect', extras: [] });
  });

  it("empty chooser: Couldn't find it + strap advice; other errors keep the message", () => {
    const empty = hr({ status: 'error', errorCode: 'no-device-found', error: 'No compatible sensor was found.' });
    expect(empty.state).toBe(COULDNT_FIND);
    expect(empty.help).toBe(HR_EMPTY_HELP);
    expect(empty.action?.label).toBe('Try again');
    const other = hr({ status: 'error', errorCode: 'gatt-connect-failed', error: 'Sensor dropped.' });
    expect(other.help).toBe('Sensor dropped.');
  });
});

describe('rideLine', () => {
  it('route · distance · minutes, and the handlebar note only when true', () => {
    const base = { name: 'Tiber river park', distanceM: 10_900, minutes: 35, units: 'metric' as const };
    expect(rideLine({ ...base, handlebarsCanJoin: false })).toBe('Tiber river park · 10.9 km · about 35 min.');
    expect(rideLine({ ...base, handlebarsCanJoin: true })).toBe(
      'Tiber river park · 10.9 km · about 35 min. The handlebar controls can join later.',
    );
    expect(rideLine({ ...base, units: 'imperial', handlebarsCanJoin: false })).toBe(
      'Tiber river park · 6.8 mi · about 35 min.',
    );
  });
});
