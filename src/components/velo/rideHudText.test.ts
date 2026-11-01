/**
 * The v2 ride HUD's plain-words copy (rideHudText): remaining distance and
 * time, the next landmark, and the status chip. The HUD must say only what
 * it knows: no invented minutes, no invented landmarks, and a dropped
 * trainer reads as a warning (the chip is the one place phones see it).
 */
import { describe, it, expect } from 'vitest';
import {
  aboutMinutes,
  formatLeft,
  nextLandmarkText,
  remainingMinutes,
  remainingText,
  statusChip,
  type ChipInput,
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

  it('names the next climb ahead with the distance to it', () => {
    expect(nextLandmarkText(climbs, 800, 'metric')).toBe('Climb 1 in 1.2 km');
  });

  it('inside a climb, says how far to the top', () => {
    expect(nextLandmarkText(climbs, 2300, 'metric')).toBe('Climb 1 · 300 m to the top');
  });

  it('moves on after a climb and is silent past the last one (or with none)', () => {
    expect(nextLandmarkText(climbs, 3000, 'metric')).toBe('Climb 2 in 2.0 km');
    expect(nextLandmarkText(climbs, 6000, 'metric')).toBeNull();
    expect(nextLandmarkText([], 0, 'metric')).toBeNull();
  });
});

describe('status chip', () => {
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
    expect(v.label).toBe('KICKR CORE 78C1 · hills 35 %');
    expect(v.tone).toBe('ok');
    expect(v.alert).toBe(false);
    expect(v.aria).toContain('hills feel 35 percent');
  });

  it('ERG mode shows the target instead of hills', () => {
    expect(statusChip({ ...base, erg: true, targetPowerW: 180 }).label).toBe('KICKR CORE 78C1 · ERG 180 W');
  });

  it('a low trainer battery turns it into a warning', () => {
    const v = statusChip({ ...base, battery: 9 });
    expect(v.label).toBe('KICKR CORE 78C1 · hills 35 % · battery 9 %');
    expect(v.tone).toBe('warn');
    expect(v.alert).toBe(true);
  });

  it('reconnecting: plain warning copy, pulsing dot, shown on phones', () => {
    const v = statusChip({ ...base, connection: 'reconnecting', reconnectAttempt: 2, reconnectMaxAttempts: 5 });
    expect(v.label).toBe('KICKR CORE 78C1 lost · reconnecting 2 of 5');
    expect(v).toMatchObject({ tone: 'warn', pulse: true, alert: true });
  });

  it('a failed trainer says the ride continues on demo power', () => {
    const v = statusChip({ ...base, connection: 'error' });
    expect(v.label).toBe('Trainer lost · demo power');
    expect(v.alert).toBe(true);
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
