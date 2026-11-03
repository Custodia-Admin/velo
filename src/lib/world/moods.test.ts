import { describe, expect, it } from 'vitest';

import type { LiveWeather } from '@/lib/meteo/openMeteo';
import { sunAzimuthAndAltitude } from '@/lib/sunPosition';

import {
  CLEAR_KEYS,
  cannedCondition,
  clearSkyAt,
  presetInstant,
  TIME_PRESETS,
  worldLight,
  worldLightKey,
  type WorldLightInput,
} from './moods';

// Perugia, a late-spring day. Instants are absolute (UTC); CEST = UTC+2.
const LAT = 43.1107;
const LON = 12.3908;
const at = (iso: string) => new Date(iso);

const base = (over: Partial<WorldLightInput> = {}): WorldLightInput => ({
  date: at('2026-05-20T10:00:00Z'),
  lat: LAT,
  lon: LON,
  mood: 'clear-afternoon',
  live: null,
  liveEnabled: true,
  groundMinM: 168,
  ...over,
});

const live = (over: Partial<LiveWeather> = {}): LiveWeather => ({
  lat: LAT,
  lon: LON,
  observedAt: '2026-05-20T12:00',
  temperatureC: 18,
  weatherCode: 0,
  cloudCoverPct: 5,
  precipitationMm: 0,
  snowfallCm: 0,
  windSpeedMs: 3,
  windFromDeg: 250,
  windGustMs: 5,
  visibilityM: 30000,
  isDay: true,
  ...over,
});

const luminance = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

describe('world light: time of day follows the clock', () => {
  it('is day at noon and night at midnight', () => {
    const noon = worldLight(base({ date: at('2026-05-20T11:00:00Z') }));
    expect(noon.timeSource).toBe('clock');
    expect(noon.phase).toBe('day');
    expect(noon.sun.altitudeDeg).toBeGreaterThan(55);
    expect(noon.night).toBe(0);
    expect(noon.key.castsShadow).toBe(true);

    const midnight = worldLight(base({ date: at('2026-05-20T22:30:00Z') }));
    expect(midnight.phase).toBe('night');
    expect(midnight.sun.altitudeDeg).toBeLessThan(-18);
    expect(midnight.night).toBe(1);
    // Moonlight is the key light: dim, cool, from high up opposite the sun.
    expect(midnight.key.intensity).toBeLessThan(noon.key.intensity * 0.35);
    expect(midnight.key.altitudeDeg).toBeGreaterThan(20);
    expect(midnight.key.color[2]).toBeGreaterThan(midnight.key.color[0]);
  });

  it('never follows a clamped sun: the light is computed for the real instant', () => {
    const d = at('2026-05-20T17:30:00Z');
    const l = worldLight(base({ date: d }));
    const s = sunAzimuthAndAltitude(d, LAT, LON);
    expect(l.sun.altitudeDeg).toBeCloseTo(s.altitude, 6);
    expect(l.at.getTime()).toBe(d.getTime());
  });

  it('changes smoothly over a whole day (no jumps between consecutive minutes)', () => {
    let prev = worldLight(base({ date: at('2026-05-20T00:00:00Z') }));
    for (let m = 1; m <= 24 * 60; m += 1) {
      const l = worldLight(base({ date: new Date(at('2026-05-20T00:00:00Z').getTime() + m * 60_000) }));
      expect(Math.abs(l.key.intensity - prev.key.intensity), `minute ${m}`).toBeLessThan(0.3);
      expect(Math.abs(l.exposure - prev.exposure), `minute ${m}`).toBeLessThan(0.03);
      expect(Math.abs(luminance(l.hemi.sky) - luminance(prev.hemi.sky)), `minute ${m}`).toBeLessThan(0.03);
      prev = l;
    }
  });

  it('warms and lowers the light toward sunset', () => {
    const noon = clearSkyAt(55);
    const golden = clearSkyAt(5);
    expect(golden.sunColor[2]).toBeLessThan(noon.sunColor[2] - 0.3);
    expect(golden.sunHaze).toBeGreaterThan(noon.sunHaze);
    expect(golden.exposure).toBeGreaterThan(noon.exposure);
    // Keys are in ascending altitude.
    for (let i = 1; i < CLEAR_KEYS.length; i++) expect(CLEAR_KEYS[i].alt).toBeGreaterThan(CLEAR_KEYS[i - 1].alt);
  });

  it('gives a misty, pinker dawn than the matching evening altitude', () => {
    const dawn = worldLight(base({ time: 'dawn' }));
    const golden = worldLight(base({ time: 'golden' }));
    expect(dawn.sun.azimuthDeg).toBeLessThan(180);
    expect(golden.sun.azimuthDeg).toBeGreaterThan(180);
    expect(dawn.atmosphere.fogDensity).toBeGreaterThan(golden.atmosphere.fogDensity);
  });
});

describe('world light: presets and the golden-hour route mood', () => {
  it('lands each preset at its sun altitude on the right side of the day', () => {
    const d = at('2026-05-20T10:00:00Z');
    const alt = (p: (typeof TIME_PRESETS)[number]) => sunAzimuthAndAltitude(presetInstant(p, d, LAT, LON), LAT, LON);
    expect(alt('dawn').altitude).toBeCloseTo(3, 0);
    expect(alt('dawn').azimuth).toBeLessThan(180);
    expect(alt('golden').altitude).toBeCloseTo(6, 0);
    expect(alt('golden').azimuth).toBeGreaterThan(180);
    expect(alt('noon').altitude).toBeGreaterThan(65);
    expect(alt('night').altitude).toBeLessThan(-20);
    expect(alt('dusk').altitude).toBeCloseTo(-3, 0);
    // All on the same solar day as the input.
    for (const p of TIME_PRESETS) expect(Math.abs(presetInstant(p, d, LAT, LON).getTime() - d.getTime())).toBeLessThan(86_400_000);
  });

  it('pins a golden-hour route to this evening, whatever the clock says', () => {
    for (const iso of ['2026-05-20T06:00:00Z', '2026-05-20T11:00:00Z', '2026-05-20T21:30:00Z']) {
      const l = worldLight(base({ date: at(iso), mood: 'golden-hour' }));
      expect(l.timeSource).toBe('mood');
      expect(l.phase).toBe('golden');
      expect(l.sun.altitudeDeg).toBeGreaterThan(4);
      expect(l.sun.altitudeDeg).toBeLessThan(8);
    }
  });

  it('lets an explicit preset win over the route mood', () => {
    const l = worldLight(base({ mood: 'golden-hour', time: 'noon' }));
    expect(l.timeSource).toBe('override');
    expect(l.phase).toBe('day');
  });

  it('works in winter (short day) and keeps every number finite', () => {
    for (const p of TIME_PRESETS) {
      const l = worldLight(base({ date: at('2026-12-21T12:00:00Z'), time: p }));
      for (const v of [l.key.intensity, l.exposure, l.atmosphere.haze, l.atmosphere.fogDensity, l.hemi.intensity]) {
        expect(Number.isFinite(v), p).toBe(true);
      }
    }
  });
});

describe('world light: weather', () => {
  it('uses live cloud cover: more cloud, more sky cloud and moving shadows, a dimmer sun', () => {
    const clear = worldLight(base({ date: at('2026-05-20T11:00:00Z'), live: live({ cloudCoverPct: 5 }) }));
    const cloudy = worldLight(base({ date: at('2026-05-20T11:00:00Z'), live: live({ weatherCode: 2, cloudCoverPct: 70 }) }));
    expect(cloudy.weather.source).toBe('live');
    expect(cloudy.sky.clouds).toBeGreaterThan(clear.sky.clouds);
    expect(cloudy.weather.cloudShadow).toBeGreaterThan(clear.weather.cloudShadow);
    expect(cloudy.key.intensity).toBeLessThan(clear.key.intensity);
    expect(cloudy.sky.overcast).toBe(0);
  });

  it('turns overcast into a closed deck with flat light and no sharp shadows', () => {
    const l = worldLight(base({ date: at('2026-05-20T11:00:00Z'), live: live({ weatherCode: 3, cloudCoverPct: 100 }) }));
    expect(l.weather.condition).toBe('overcast');
    expect(l.sky.overcast).toBe(1);
    expect(l.key.castsShadow).toBe(false);
    expect(l.hemi.intensity).toBeGreaterThan(l.key.intensity);
    expect(l.weather.rain).toBe(0);
  });

  it('rains, wets the road and thickens the haze in rain', () => {
    const dry = worldLight(base({ date: at('2026-05-20T11:00:00Z'), live: live() }));
    const rain = worldLight(base({ date: at('2026-05-20T11:00:00Z'), live: live({ weatherCode: 63, cloudCoverPct: 100, precipitationMm: 2 }) }));
    expect(rain.weather.condition).toBe('rain');
    expect(rain.weather.rain).toBe(1);
    expect(rain.weather.wet).toBeGreaterThan(0.9);
    expect(rain.atmosphere.haze).toBeGreaterThan(dry.atmosphere.haze * 2);
    const drizzle = worldLight(base({ live: live({ weatherCode: 53, cloudCoverPct: 100 }) }));
    expect(drizzle.weather.rain).toBeGreaterThan(0);
    expect(drizzle.weather.rain).toBeLessThan(1);
  });

  it('pools fog in the valley above the lowest ground', () => {
    const l = worldLight(base({ live: live({ weatherCode: 45, visibilityM: 400 }) }));
    expect(l.weather.condition).toBe('fog');
    expect(l.atmosphere.fogBaseM).toBeGreaterThan(168);
    expect(l.atmosphere.fogBaseM).toBeLessThan(260);
    expect(l.atmosphere.fogDensity).toBeGreaterThan(1 / 100);
    // Reported visibility drives the haze: ~3/visibility.
    expect(l.atmosphere.haze).toBeCloseTo(3 / 400, 6);
  });

  it('falls back to the canned mood when live weather is off or missing', () => {
    const rainy = live({ weatherCode: 63, cloudCoverPct: 100, precipitationMm: 2 });
    expect(worldLight(base({ live: rainy, liveEnabled: false })).weather.condition).toBe('clear');
    expect(worldLight(base({ live: null, mood: 'overcast' })).weather).toMatchObject({ condition: 'overcast', source: 'canned' });
    expect(cannedCondition('valley-fog')).toBe('fog');
    expect(cannedCondition('fjord-rain')).toBe('rain');
    expect(cannedCondition('alpine-storm')).toBe('storm');
    expect(cannedCondition('clear-noon')).toBe('clear');
  });

  it('lets a pinned weather override live conditions', () => {
    const l = worldLight(base({ live: live(), weather: 'rain' }));
    expect(l.weather).toMatchObject({ condition: 'rain', source: 'override' });
  });

  it('takes the live wind for sway and rain slant', () => {
    const l = worldLight(base({ live: live({ windSpeedMs: 7.5, windFromDeg: 30 }) }));
    expect(l.weather.windMs).toBe(7.5);
    expect(l.weather.windFromDeg).toBe(30);
  });

  it('keys the light every four minutes and on what changes it', () => {
    const a = worldLightKey(base({ date: at('2026-05-20T10:00:10Z') }));
    expect(worldLightKey(base({ date: at('2026-05-20T10:03:50Z') }))).toBe(a);
    expect(worldLightKey(base({ date: at('2026-05-20T10:04:00Z') }))).not.toBe(a);
    expect(worldLightKey(base({ weather: 'rain' }))).not.toBe(worldLightKey(base()));
  });
});
