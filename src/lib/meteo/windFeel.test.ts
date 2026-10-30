import { describe, it, expect } from 'vitest';
import {
  headwindComponent,
  relativeWindDeg,
  gustEnvelope,
  riderLevelWindMs,
  cwMultiplier,
  scaleCwByte,
  equivalentHeadwindMs,
  trainerWindFromWeather,
  windLabel,
  isWindFeel,
  FEEL_PROFILES,
  RIDER_HEIGHT_WIND_FACTOR,
  MIN_REFERENCE_SPEED_MS,
} from '@/lib/meteo/windFeel';
import { encodeSetSimulationParams } from '@/lib/ftms';
import { ftmsCw } from '@/lib/physics';

describe('headwindComponent / relativeWindDeg', () => {
  it('wind from where you are heading is a full headwind', () => {
    expect(headwindComponent(5, 0, 0)).toBeCloseTo(5);
    expect(headwindComponent(5, 270, 270)).toBeCloseTo(5);
  });

  it('wind from behind is a tailwind (negative); crosswind is zero', () => {
    expect(headwindComponent(5, 180, 0)).toBeCloseTo(-5);
    expect(headwindComponent(5, 90, 0)).toBe(0);
    expect(headwindComponent(5, 304, 214)).toBe(0);
  });

  it('projects oblique wind by the cosine', () => {
    expect(headwindComponent(10, 60, 0)).toBeCloseTo(5);
  });

  it('calm or invalid wind is zero', () => {
    expect(headwindComponent(0, 0, 0)).toBe(0);
    expect(headwindComponent(NaN, 0, 0)).toBe(0);
    expect(headwindComponent(-3, 0, 0)).toBe(0);
  });

  it('relative direction: 0 front, 90 right, 180 behind, wraps', () => {
    expect(relativeWindDeg(0, 0)).toBe(0);
    expect(relativeWindDeg(90, 0)).toBe(90);
    expect(relativeWindDeg(10, 350)).toBe(20);
    expect(relativeWindDeg(350, 10)).toBe(340);
  });
});

describe('rider-level wind and gusts', () => {
  it('gust envelope stays in [0, 1] and actually varies', () => {
    const vals = Array.from({ length: 400 }, (_, i) => gustEnvelope(i * 0.5));
    expect(Math.min(...vals)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...vals)).toBeLessThanOrEqual(1);
    expect(Math.max(...vals)).toBeGreaterThan(0.6);
    expect(vals.filter((v) => v === 0).length).toBeGreaterThan(0);
  });

  it('scales 10 m wind to rider height; gusts add their feel share', () => {
    const w = { windSpeedMs: 5, windGustMs: 5 };
    expect(riderLevelWindMs(w, 0, 'real')).toBeCloseTo(5 * RIDER_HEIGHT_WIND_FACTOR);
    const gusty = { windSpeedMs: 5, windGustMs: 9 };
    const t = Array.from({ length: 100 }, (_, i) => i).find((s) => gustEnvelope(s) > 0.5)!;
    const real = riderLevelWindMs(gusty, t, 'real');
    const subtle = riderLevelWindMs(gusty, t, 'subtle');
    expect(real).toBeGreaterThan(subtle);
    expect(subtle).toBeGreaterThan(5 * RIDER_HEIGHT_WIND_FACTOR);
    expect(riderLevelWindMs(gusty, t, 'off')).toBe(0);
  });
});

describe('cwMultiplier: wind → Cw', () => {
  it('real feel is the physical (v+h)|v+h|/v² ratio', () => {
    expect(cwMultiplier(4, 8, 'real')).toBeCloseTo(2.25);
    expect(cwMultiplier(1, 8, 'real')).toBeCloseTo(81 / 64);
    expect(cwMultiplier(-2, 8, 'real')).toBeCloseTo(36 / 64);
  });

  it('subtle feel applies a third of the change', () => {
    expect(cwMultiplier(1, 8, 'subtle')).toBeCloseTo(1 + (81 / 64 - 1) * 0.35);
    expect(cwMultiplier(-2, 8, 'subtle')).toBeCloseTo(1 + (36 / 64 - 1) * 0.35);
  });

  it('caps: subtle within +25 % / -20 %, real within 0.3x..2.5x', () => {
    expect(cwMultiplier(4, 8, 'subtle')).toBe(FEEL_PROFILES.subtle.max);
    expect(cwMultiplier(-10, 8, 'subtle')).toBe(FEEL_PROFILES.subtle.min);
    expect(cwMultiplier(20, 8, 'real')).toBe(2.5);
    // Tailwind faster than the rider would push; real feel floors at 0.3.
    expect(cwMultiplier(-10, 8, 'real')).toBe(0.3);
  });

  it('subtle never exceeds its cap anywhere (comfort guarantee)', () => {
    for (let h = -25; h <= 25; h += 0.5) {
      for (let v = 0; v <= 20; v += 0.5) {
        const m = cwMultiplier(h, v, 'subtle');
        expect(m).toBeLessThanOrEqual(1.25);
        expect(m).toBeGreaterThanOrEqual(0.8);
      }
    }
  });

  it('off, calm and garbage inputs leave Cw alone', () => {
    expect(cwMultiplier(6, 8, 'off')).toBe(1);
    expect(cwMultiplier(0, 8, 'real')).toBe(1);
    expect(cwMultiplier(NaN, 8, 'real')).toBe(1);
  });

  it('uses a reference speed floor so a standing start does not spike', () => {
    expect(cwMultiplier(1, 0, 'real')).toBeCloseTo(cwMultiplier(1, MIN_REFERENCE_SPEED_MS, 'real'));
    expect(cwMultiplier(1, NaN, 'real')).toBeCloseTo(36 / 25);
  });
});

describe('Cw byte and inverse', () => {
  it('scales the FTMS Cw byte within 1..255', () => {
    expect(scaleCwByte(51, 1)).toBe(51);
    expect(scaleCwByte(51, 1.25)).toBe(64);
    expect(scaleCwByte(51, 2.25)).toBe(115);
    expect(scaleCwByte(200, 2.5)).toBe(255);
    expect(scaleCwByte(51, 0)).toBe(1);
    expect(scaleCwByte(NaN, NaN)).toBe(51);
  });

  it('equivalentHeadwindMs inverts cwMultiplier (real feel)', () => {
    for (const h of [-3, -1, 0.5, 2, 4]) {
      const m = cwMultiplier(h, 8, 'real');
      expect(equivalentHeadwindMs(m, 8)).toBeCloseTo(h);
    }
    expect(equivalentHeadwindMs(1, 8)).toBe(0);
  });
});

describe('trainerWindFromWeather → FTMS 0x11', () => {
  const north10 = { windSpeedMs: 10, windGustMs: 10, windFromDeg: 0 };
  const base = ftmsCw({
    riderMassKg: 75, bikeMassKg: 8, bikeType: 'road', riderPosition: 'hoods',
    drivetrainEff: 0.97, rho: 1.225, windSpeedMs: 0, windDirectionDeg: 0,
  });

  it('headwind raises Cw, capped by feel; the wind field stays 0', () => {
    const real = trainerWindFromWeather(north10, 0, 8, base, 'real', 0);
    expect(real.headwindMs).toBeCloseTo(6);
    expect(real.multiplier).toBe(2.5);
    expect(real.cwByte).toBe(Math.round(base * 2.5));
    expect(real.windMs).toBe(0);

    const subtle = trainerWindFromWeather(north10, 0, 8, base, 'subtle', 0);
    expect(subtle.multiplier).toBe(1.25);
    expect(subtle.cwByte).toBe(Math.round(base * 1.25));
  });

  it('tailwind lowers Cw; crosswind leaves it; off ignores wind', () => {
    expect(trainerWindFromWeather(north10, 180, 8, base, 'subtle', 0).cwByte).toBe(Math.round(base * 0.8));
    expect(trainerWindFromWeather(north10, 90, 8, base, 'real', 0).cwByte).toBe(base);
    expect(trainerWindFromWeather(north10, 0, 8, base, 'off', 0).cwByte).toBe(base);
  });

  it('encodes into the 0x11 payload: wind 0, Cw byte at offset 6', () => {
    const tw = trainerWindFromWeather(north10, 0, 8, base, 'subtle', 0);
    const bytes = encodeSetSimulationParams(2.1, tw.windMs, 40, tw.cwByte);
    expect(bytes[0]).toBe(0x11);
    expect(bytes[1]).toBe(0);
    expect(bytes[2]).toBe(0);
    expect(bytes[6]).toBe(tw.cwByte);
    expect(bytes[6]).toBeGreaterThan(base);
  });
});

describe('labels and guards', () => {
  it('windLabel uses plain words', () => {
    expect(windLabel(0.7, 0)).toBe('Calm');
    expect(windLabel(3, 10)).toBe('Light headwind');
    expect(windLabel(6, 180)).toBe('Tailwind');
    expect(windLabel(12, 90)).toBe('Strong crosswind');
    expect(windLabel(NaN, 0)).toBe('Calm');
  });

  it('isWindFeel', () => {
    expect(isWindFeel('subtle')).toBe(true);
    expect(isWindFeel('hard')).toBe(false);
    expect(isWindFeel(undefined)).toBe(false);
  });
});
