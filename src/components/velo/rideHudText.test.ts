/**
 * The v2 ride HUD's plain-words copy (rideHudText): remaining distance and
 * time, the next landmark, and the status chip. The HUD must say only what
 * it knows: no invented minutes, no invented landmarks, and a dropped
 * trainer reads as a warning (the chip is the one place phones see it).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  aboutMinutes,
  chipTap,
  formatLeft,
  landmarkJoiner,
  landmarkLine,
  LOW_BATTERY,
  nextLandmark,
  noticeMs,
  rideChip,
  type RideChipInput,
  remainingMinutes,
  remainingText,
  shortDeviceName,
  statusChip,
  type ChipInput,
  WORLD_STOPPED_LABEL,
} from './rideHudText';

describe('remaining distance and time', () => {
  it('formats what is left in the rider units', () => {
    expect(formatLeft(6720, 'metric')).toBe('6.7 km');
    expect(formatLeft(654, 'metric')).toBe('650 m');
    expect(formatLeft(1609.344 * 4.2, 'imperial')).toBe('4.2 mi');
    expect(formatLeft(-20, 'metric')).toBe('0 m');
  });

  it('says durations as "about N min"', () => {
    expect(aboutMinutes(19.6)).toBe('about 20 min');
    expect(aboutMinutes(0.2)).toBe('about 1 min');
    expect(aboutMinutes(70)).toBe('about 1 h 10 min');
    expect(aboutMinutes(120)).toBe('about 2 h');
  });

  it("projects from the rider's own average once there is enough ride", () => {
    // 3 km in 10 min = 5 m/s; 6 km left -> 20 min.
    expect(remainingMinutes({ distanceM: 3000, totalM: 9000, elapsedS: 600, estMinutes: 99, units: 'metric' })).toBeCloseTo(20);
  });

  it("falls back to the route's estimate pro rata early in the ride", () => {
    expect(remainingMinutes({ distanceM: 100, totalM: 10_000, elapsedS: 20, estMinutes: 40, units: 'metric' })).toBeCloseTo(39.6);
  });

  it('gives no minutes at all when nothing supports them', () => {
    expect(remainingMinutes({ distanceM: 100, totalM: 10_000, elapsedS: 20, estMinutes: null, units: 'metric' })).toBeNull();
    expect(remainingText({ distanceM: 100, totalM: 10_000, elapsedS: 20, units: 'metric' })).toBe('9.9 km to go');
  });

  it('builds the route panel line, and handles the finish and live routes', () => {
    expect(remainingText({ distanceM: 3000, totalM: 9700, elapsedS: 600, units: 'metric' })).toBe(
      '6.7 km to go · about 22 min',
    );
    expect(remainingText({ distanceM: 9998, totalM: 10_000, elapsedS: 600, units: 'metric' })).toBe('At the finish');
    expect(remainingText({ distanceM: 500, totalM: 0, elapsedS: 600, units: 'metric' })).toBeNull();
  });
});

describe('next landmark', () => {
  const climbs = [
    { name: 'Climb 1', startDistance: 2000, endDistance: 2600 },
    { name: 'Climb 2', startDistance: 5000, endDistance: 5400 },
  ];
  const line = (n: ReturnType<typeof nextLandmark>) => (n ? landmarkLine(n) : null);

  it('names the next climb ahead with the distance to it', () => {
    expect(nextLandmark(climbs, 800, 'metric')).toEqual({ name: 'Climb 1', distance: 'in 1.2 km', inClimb: false });
    expect(line(nextLandmark(climbs, 800, 'metric'))).toBe('Climb 1 in 1.2 km');
  });

  // Review of PR #48 @dfd7071, N3: with no room for the name, the distance
  // reads on its own ("300 m to the top", not "· 300 m to the top").
  it('inside a climb, says how far to the top; the separator belongs to the name', () => {
    expect(nextLandmark(climbs, 2300, 'metric')).toEqual({ name: 'Climb 1', distance: '300 m to the top', inClimb: true });
    expect(line(nextLandmark(climbs, 2300, 'metric'))).toBe('Climb 1 · 300 m to the top');
    expect(landmarkJoiner({ name: 'Climb 1', distance: '300 m to the top', inClimb: true })).toBe(' · ');
    expect(landmarkJoiner({ name: 'Rivotorto', distance: 'in 900 m', inClimb: false })).toBe(' ');
  });

  it('moves on after a climb and is silent past the last one (or with none)', () => {
    expect(line(nextLandmark(climbs, 3000, 'metric'))).toBe('Climb 2 in 2.0 km');
    expect(nextLandmark(climbs, 6000, 'metric')).toBeNull();
    expect(nextLandmark([], 0, 'metric')).toBeNull();
  });
});

describe('status chip', () => {
  it('shows the model name without the 4-hex unit suffix', () => {
    expect(shortDeviceName('KICKR CORE 78C1')).toBe('KICKR CORE');
    expect(shortDeviceName(' Elite Direto XR ')).toBe('Elite Direto XR');
    expect(shortDeviceName('78C1')).toBe('78C1');
  });
  const base: ChipInput = {
    connection: 'connected',
    mode: 'trainer',
    deviceName: 'KICKR CORE 78C1',
    difficulty: 0.35,
    erg: false,
    targetPowerW: null,
    battery: null,
    reconnectAttempt: 0,
    reconnectMaxAttempts: 0,
    replay: false,
  };

  it('connected trainer: name and how hard the hills feel, primary dot, quiet on phones', () => {
    const v = statusChip(base);
    expect(v.label).toBe('KICKR CORE · hills 35 %');
    expect(v.tone).toBe('ok');
    expect(v.alert).toBe(false);
    expect(v.aria).toContain('hills feel 35 percent');
  });

  it('ERG mode shows the target instead of hills', () => {
    expect(statusChip({ ...base, erg: true, targetPowerW: 180 }).label).toBe('KICKR CORE · ERG 180 W');
  });

  it('a low trainer battery turns it into a warning', () => {
    const v = statusChip({ ...base, battery: 9 });
    expect(v.label).toBe('KICKR CORE · hills 35 % · battery 9 %');
    expect(v.tone).toBe('warn');
    expect(v.alert).toBe(true);
  });

  it('reconnecting: plain warning copy, pulsing dot, shown on phones', () => {
    const v = statusChip({ ...base, connection: 'reconnecting', reconnectAttempt: 2, reconnectMaxAttempts: 5 });
    // The short name, like the calm chip ("KICKR CORE · hills 35 %").
    expect(v.label).toBe('KICKR CORE lost · reconnecting 2 of 5');
    expect(v).toMatchObject({ tone: 'warn', pulse: true, alert: true });
  });

  it('a failed pairing is "not connected", never "lost" (it never connected), in any mode', () => {
    for (const mode of ['trainer', 'demo'] as const) {
      const v = statusChip({ ...base, mode, connection: 'error', deviceName: null });
      expect(v.label, mode).toBe('Trainer not connected · tap for devices');
      expect(v.label).not.toContain('lost');
      expect(v, mode).toMatchObject({ tone: 'warn', alert: true });
    }
  });

  it('no trainer: an honest demo label, no hills figure (hills only shape a trainer)', () => {
    const v = statusChip({ ...base, connection: 'disconnected', mode: 'demo', deviceName: null });
    expect(v.label).toBe('Demo ride · no trainer');
    expect(v.label).not.toContain('hills');
    expect(v).toMatchObject({ tone: 'calm', alert: false });
  });

  it('outdoor and replay rides say so', () => {
    expect(statusChip({ ...base, mode: 'outdoor', connection: 'disconnected' }).label).toBe('Outdoor · GPS');
    expect(statusChip({ ...base, replay: true }).label).toBe('Replay');
  });
});

describe('the one ride chip (compact HUD: every device or error state in one pill)', () => {
  const ride: RideChipInput = {
    connection: 'connected',
    mode: 'trainer',
    deviceName: 'KICKR CORE 78C1',
    difficulty: 0.35,
    erg: false,
    targetPowerW: null,
    battery: null,
    reconnectAttempt: 0,
    reconnectMaxAttempts: 0,
    replay: false,
    trainerReconnectable: false,
    errorCode: null,
    controls: 'live',
    heartRate: 'connected',
    notice: null,
    worldStopped: false,
  };

  it('calm: the trainer line, tap opens the devices sheet, quiet on phones', () => {
    const v = rideChip(ride);
    expect(v).toMatchObject({ label: 'KICKR CORE · hills 35 %', tone: 'ok', alert: false, action: 'devices' });
    expect(v.aria).toContain('Tap for devices');
  });

  it('a lost trainer that can come back: one tap reconnects it', () => {
    const lost = rideChip({ ...ride, connection: 'disconnected', mode: 'demo', trainerReconnectable: true, errorCode: 'reconnect-failed' });
    expect(lost).toMatchObject({ label: 'Trainer lost · tap to reconnect', tone: 'warn', alert: true, action: 'reconnectTrainer' });
    // Never connected this ride (asleep at the start): honest "off".
    const off = rideChip({ ...ride, connection: 'disconnected', mode: 'demo', trainerReconnectable: true });
    expect(off.label).toBe('Trainer off · tap to reconnect');
    // A failed link in trainer mode also offers the one-tap reconnect.
    expect(rideChip({ ...ride, connection: 'error', trainerReconnectable: true }).action).toBe('reconnectTrainer');
  });

  // What #27 alone reaches after a real drop: TrainerEventBridge 'failed'
  // sets 'disconnected' + 'reconnect-failed' + mode demo, and nothing moves
  // the reconnect phase off 'connected', so there is no usable grant.
  const lostNoGrant: RideChipInput = {
    ...ride,
    connection: 'disconnected',
    mode: 'demo',
    deviceName: null,
    errorCode: 'reconnect-failed',
    trainerReconnectable: false,
  };

  it('a trainer lost mid-ride with no usable grant: an alert on every viewport that opens devices, never the calm demo chip', () => {
    const v = rideChip(lostNoGrant);
    expect(v).toMatchObject({ label: 'Trainer lost · tap for devices', tone: 'warn', alert: true, action: 'devices' });
    expect(v.label).not.toContain('Demo ride');
    // It holds the chip over a notice (the bridge's "Couldn't reconnect" toast) and over calm states.
    expect(rideChip({ ...lostNoGrant, notice: { title: "Couldn't reconnect after several attempts", kind: 'error' } }).label)
      .toBe('Trainer lost · tap for devices');
    // ... but not on outdoor or replay rides, which have no trainer.
    expect(rideChip({ ...lostNoGrant, mode: 'outdoor' }).label).toBe('Outdoor · GPS');
    expect(rideChip({ ...lostNoGrant, replay: true }).label).toBe('Replay');
    // Once the trainer is back (connected clears the error code), the calm line returns.
    expect(rideChip({ ...ride }).alert).toBe(false);
  });

  it('a failed pairing in the ride: "not connected", an alert that opens devices', () => {
    const v = rideChip({ ...ride, connection: 'error', errorCode: 'no-device-selected', deviceName: null });
    expect(v).toMatchObject({ label: 'Trainer not connected · tap for devices', alert: true, action: 'devices' });
  });

  it('no granted trainer: the demo label, calm', () => {
    const v = rideChip({ ...ride, connection: 'disconnected', mode: 'demo', deviceName: null });
    expect(v).toMatchObject({ label: 'Demo ride · no trainer', tone: 'calm', alert: false, action: 'devices' });
  });

  it('trainer problems beat everything else', () => {
    const v = rideChip({
      ...ride,
      connection: 'reconnecting',
      reconnectAttempt: 1,
      reconnectMaxAttempts: 5,
      controls: 'locked',
      heartRate: 'error',
      notice: { title: 'Voice control on', kind: 'info' },
    });
    expect(v.label).toBe('KICKR CORE lost · reconnecting 1 of 5');
    expect(v.action).toBe('devices');
  });

  it('the 3D view stopped (WebGL context lost): an alert on every viewport whose tap reloads the view', () => {
    const v = rideChip({ ...ride, worldStopped: true });
    expect(v).toMatchObject({ label: '3D view stopped · tap to reload', tone: 'warn', alert: true, action: 'reloadWorld' });
    expect(v.label).toBe(WORLD_STOPPED_LABEL);
    // The screen-reader sentence says it in full, and that the ride carries on.
    expect(v.aria).toBe('The 3D view stopped. Tap to reload the view. Your ride keeps going and recording.');
    // Demo rides, outdoor rides and replays too: the world view is the same.
    expect(rideChip({ ...ride, connection: 'disconnected', mode: 'demo', deviceName: null, worldStopped: true }).action).toBe('reloadWorld');
    expect(rideChip({ ...ride, mode: 'outdoor', worldStopped: true }).action).toBe('reloadWorld');
  });

  it('the stopped view comes after every trainer problem and before controls, heart rate and notices', () => {
    const stopped = { ...ride, worldStopped: true };
    // Trainer first: lost (with or without a grant), reconnecting, connecting, a failed pairing.
    expect(rideChip({ ...stopped, connection: 'disconnected', mode: 'demo', trainerReconnectable: true, errorCode: 'reconnect-failed' }).action)
      .toBe('reconnectTrainer');
    expect(rideChip({ ...stopped, connection: 'disconnected', mode: 'demo', deviceName: null, errorCode: 'reconnect-failed' }).label)
      .toBe('Trainer lost · tap for devices');
    expect(rideChip({ ...stopped, connection: 'reconnecting', reconnectAttempt: 1, reconnectMaxAttempts: 5 }).label)
      .toBe('KICKR CORE lost · reconnecting 1 of 5');
    expect(rideChip({ ...stopped, connection: 'connecting' }).label).toBe('Connecting to KICKR CORE…');
    expect(rideChip({ ...stopped, connection: 'error', deviceName: null }).label).toBe('Trainer not connected · tap for devices');
    // ... with a low battery too (the battery is not what is wrong then).
    expect(rideChip({ ...stopped, connection: 'reconnecting', battery: 15 }).action).toBe('devices');
    expect(rideChip({ ...stopped, connection: 'connecting', battery: 15 }).action).toBe('devices');
    // Then the view, over everything else.
    expect(rideChip({ ...stopped, controls: 'locked' }).action).toBe('reloadWorld');
    expect(rideChip({ ...stopped, heartRate: 'error' }).action).toBe('reloadWorld');
    expect(rideChip({ ...stopped, notice: { title: 'Trainer reconnected', kind: 'success' } }).action).toBe('reloadWorld');
    expect(rideChip({ ...stopped, notice: { title: 'FTP test suggested', kind: 'info', actionLabel: 'Start' } }).action).toBe('reloadWorld');
  });

  it('a low trainer battery does not hide the stopped view: the tap reloads it, and the battery note comes back after', () => {
    const v = rideChip({ ...ride, battery: 15, worldStopped: true });
    expect(v).toMatchObject({ label: WORLD_STOPPED_LABEL, tone: 'warn', alert: true, action: 'reloadWorld' });
    expect(rideChip({ ...ride, battery: LOW_BATTERY, worldStopped: true }).action).toBe('reloadWorld');
    // The world is live again: the battery note, unchanged, opens devices.
    const battery = rideChip({ ...ride, battery: 15 });
    expect(battery).toMatchObject({ label: 'KICKR CORE · hills 35 % · battery 15 %', tone: 'warn', alert: true, action: 'devices' });
    expect(battery.aria).toBe('Trainer connected: KICKR CORE 78C1, hills feel 35 percent, battery low at 15 percent');
    // ... and it still holds the chip over controls, heart rate and notices.
    expect(rideChip({ ...ride, battery: 15, controls: 'locked' }).label).toBe('KICKR CORE · hills 35 % · battery 15 %');
    expect(rideChip({ ...ride, battery: 15, heartRate: 'error' }).label).toBe('KICKR CORE · hills 35 % · battery 15 %');
    expect(rideChip({ ...ride, battery: 15, notice: { title: 'Voice control on', kind: 'info' } }).label)
      .toBe('KICKR CORE · hills 35 % · battery 15 %');
  });

  it('handlebar controls that cannot deliver presses: a warning that opens devices; never-paired controls say nothing', () => {
    expect(rideChip({ ...ride, controls: 'silent' })).toMatchObject({ label: 'Controls locked', tone: 'warn', alert: true, action: 'devices' });
    expect(rideChip({ ...ride, controls: 'rightSide' }).label).toBe('Controls: right unit paired');
    expect(rideChip({ ...ride, controls: 'asleep' }).label).toBe('Controls asleep');
    for (const phase of ['none', 'pairing', 'waiting', 'live', 'reconnecting'] as const) {
      expect(rideChip({ ...ride, controls: phase }).alert, phase).toBe(false);
    }
  });

  it('a dropped heart-rate strap comes after the controls', () => {
    expect(rideChip({ ...ride, heartRate: 'reconnecting' })).toMatchObject({ label: 'Heart rate lost · reconnecting', pulse: true, alert: true });
    expect(rideChip({ ...ride, heartRate: 'error', controls: 'locked' }).label).toBe('Controls locked');
    expect(rideChip({ ...ride, heartRate: 'disconnected' }).alert).toBe(false);
  });

  it('a passing notice (a toast) holds the chip when nothing is wrong; its action runs on tap', () => {
    const err = rideChip({ ...ride, notice: { title: 'Trainer rejected a command', kind: 'error' } });
    expect(err).toMatchObject({ label: 'Trainer rejected a command', tone: 'warn', alert: true, action: 'devices' });
    const ok = rideChip({ ...ride, notice: { title: 'Trainer reconnected', kind: 'success' } });
    expect(ok.tone).toBe('ok');
    const act = rideChip({ ...ride, notice: { title: 'FTP test suggested', kind: 'info', actionLabel: 'Start' } });
    expect(act).toMatchObject({ label: 'FTP test suggested · Start', tone: 'calm', action: 'notice' });
  });

  it('a notice holds the chip for its own duration, at most 5 s (sticky toasts too)', () => {
    expect(noticeMs(3000)).toBe(3000);
    expect(noticeMs(10_000)).toBe(5000);
    expect(noticeMs(null)).toBe(5000);
    expect(noticeMs(0)).toBe(5000);
  });
});

describe('a chip tap (chipTap: what RideChip runs on click)', () => {
  const effects = () => ({ reconnectTrainer: vi.fn(), reloadWorld: vi.fn(), dismissNotice: vi.fn(), toggleDevices: vi.fn() });

  it('"Trainer lost · tap to reconnect" reconnects the trainer, and only that', () => {
    const fx = effects();
    const run = vi.fn();
    expect(chipTap('reconnectTrainer', { id: 't1', run }, fx)).toBe('reconnectTrainer');
    expect(fx.reconnectTrainer).toHaveBeenCalledTimes(1);
    expect(fx.toggleDevices).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('"3D view stopped · tap to reload" reloads the view, and only that', () => {
    const fx = effects();
    const run = vi.fn();
    expect(chipTap('reloadWorld', { id: 'n1', run }, fx)).toBe('reloadWorld');
    expect(fx.reloadWorld).toHaveBeenCalledTimes(1);
    expect(fx.reconnectTrainer).not.toHaveBeenCalled();
    expect(fx.toggleDevices).not.toHaveBeenCalled();
    expect(fx.dismissNotice).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('a notice with an action runs it and dismisses that toast', () => {
    const fx = effects();
    const run = vi.fn();
    expect(chipTap('notice', { id: 'ftp', run }, fx)).toBe('notice');
    expect(run).toHaveBeenCalledTimes(1);
    expect(fx.dismissNotice).toHaveBeenCalledWith('ftp');
    expect(fx.reconnectTrainer).not.toHaveBeenCalled();
    expect(fx.toggleDevices).not.toHaveBeenCalled();
  });

  it('anything else opens or closes the devices sheet', () => {
    for (const [action, notice] of [
      ['devices', null],
      ['notice', null],
      ['notice', { id: 'x' }],
    ] as const) {
      const fx = effects();
      expect(chipTap(action, notice, fx)).toBe('devices');
      expect(fx.toggleDevices).toHaveBeenCalledTimes(1);
      expect(fx.reconnectTrainer).not.toHaveBeenCalled();
      expect(fx.dismissNotice).not.toHaveBeenCalled();
    }
  });
});
