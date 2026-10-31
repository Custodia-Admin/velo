import { describe, it, expect } from 'vitest';
import {
  conditionFromWmo,
  conditionFor,
  conditionLabel,
  resolveSceneWeather,
  sceneForCondition,
  cannedScene,
  particlesForMood,
  sceneKey,
  cloudCountForCover,
  type WeatherCondition,
} from '@/lib/meteo/sceneWeather';
import { MOODS, type MoodId } from '@/lib/cesiumUtils';
import { shouldUseWetMaterial } from '@/lib/wetRoadMaterial';
import type { LiveWeather } from '@/lib/meteo/openMeteo';

const base: LiveWeather = {
  lat: 46,
  lon: 8.95,
  observedAt: '2026-10-30T10:00',
  temperatureC: 12,
  weatherCode: 0,
  cloudCoverPct: 0,
  precipitationMm: 0,
  snowfallCm: 0,
  windSpeedMs: 2,
  windFromDeg: 0,
  windGustMs: 4,
  visibilityM: 30000,
  isDay: true,
};

describe('conditionFromWmo', () => {
  it.each<[number, WeatherCondition]>([
    [0, 'clear'], [1, 'clear'], [2, 'partly-cloudy'], [3, 'overcast'],
    [45, 'fog'], [48, 'fog'], [51, 'drizzle'], [57, 'drizzle'],
    [61, 'rain'], [65, 'rain'], [67, 'rain'], [80, 'rain'], [82, 'rain'],
    [71, 'snow'], [77, 'snow'], [85, 'snow'], [86, 'snow'],
    [95, 'storm'], [96, 'storm'], [99, 'storm'],
  ])('WMO %i → %s', (code, cond) => {
    expect(conditionFromWmo(code)).toBe(cond);
  });

  it('treats unknown codes as fair weather', () => {
    expect(conditionFromWmo(42)).toBe('partly-cloudy');
  });
});

describe('conditionFor (code + measurements)', () => {
  it('upgrades a dry code with measured rain, snow, or very low visibility', () => {
    expect(conditionFor({ ...base, weatherCode: 3, precipitationMm: 0.6 })).toBe('rain');
    expect(conditionFor({ ...base, weatherCode: 2, snowfallCm: 0.3 })).toBe('snow');
    expect(conditionFor({ ...base, weatherCode: 3, visibilityM: 400 })).toBe('fog');
  });

  it('ignores trace precipitation and keeps wet codes as reported', () => {
    expect(conditionFor({ ...base, weatherCode: 1, precipitationMm: 0.1 })).toBe('clear');
    expect(conditionFor({ ...base, weatherCode: 95, visibilityM: 300 })).toBe('storm');
  });

  it('the real Lugano reading (code 45, 1.8 km visibility) is fog', () => {
    expect(conditionFor({ ...base, weatherCode: 45, visibilityM: 1820 })).toBe('fog');
  });
});

describe('scene mapping', () => {
  it('fair days keep the route mood; weathery canned moods are swapped for clear light', () => {
    expect(sceneForCondition('clear', 'golden-hour').mood).toBe('golden-hour');
    expect(sceneForCondition('partly-cloudy', 'clear-noon').mood).toBe('clear-noon');
    expect(sceneForCondition('clear', 'fjord-rain').mood).toBe('clear-afternoon');
    expect(sceneForCondition('clear', 'fjord-rain')).toMatchObject({ particles: 'none', wet: false });
  });

  it.each<[WeatherCondition, MoodId, string, boolean]>([
    ['overcast', 'overcast', 'none', false],
    ['fog', 'valley-fog', 'fog', false],
    ['drizzle', 'overcast', 'rain', true],
    ['rain', 'fjord-rain', 'rain', true],
    ['snow', 'overcast', 'snow', false],
    ['storm', 'alpine-storm', 'rain', true],
  ])('%s → mood %s, particles %s, wet %s', (cond, mood, particles, wet) => {
    const s = sceneForCondition(cond, 'golden-hour');
    expect(s).toEqual({ source: 'live', condition: cond, mood, particles, wet });
    expect(s.cloudCount).toBeUndefined();
    expect(Object.keys(MOODS)).toContain(s.mood);
  });

  it('fair-day clouds follow real cloud cover; weather moods keep their deck', () => {
    expect(cloudCountForCover(0)).toBe(4);
    expect(cloudCountForCover(50)).toBe(17);
    expect(cloudCountForCover(100)).toBe(30);
    expect(cloudCountForCover(250)).toBe(30);
    expect(cloudCountForCover(NaN)).toBe(4);
    expect(resolveSceneWeather('golden-hour', { ...base, cloudCoverPct: 64 }, true).cloudCount).toBe(21);
    expect(resolveSceneWeather('golden-hour', { ...base, weatherCode: 3 }, true).cloudCount).toBeUndefined();
    expect(sceneForCondition('clear', 'golden-hour').cloudCount).toBeUndefined();
  });

  it('falls back to the canned mood when live weather is off or missing', () => {
    const live = { ...base, weatherCode: 61 };
    expect(resolveSceneWeather('golden-hour', live, false)).toEqual(cannedScene('golden-hour'));
    expect(resolveSceneWeather('golden-hour', null, true)).toEqual(cannedScene('golden-hour'));
    expect(resolveSceneWeather('golden-hour', live, true).source).toBe('live');
    expect(resolveSceneWeather('golden-hour', live, true).mood).toBe('fjord-rain');
  });

  it('canned scenes keep the old particle and wet-road behaviour', () => {
    expect(particlesForMood('fjord-rain')).toBe('rain');
    expect(particlesForMood('alpine-storm')).toBe('rain');
    expect(particlesForMood('mediterranean-mist')).toBe('fog');
    expect(particlesForMood('golden-hour')).toBe('none');
    for (const mood of Object.keys(MOODS) as MoodId[]) {
      expect(cannedScene(mood).wet).toBe(shouldUseWetMaterial(mood));
    }
  });

  it('sceneKey changes only when what is rendered changes', () => {
    expect(sceneKey(sceneForCondition('rain', 'golden-hour'))).toBe(
      sceneKey(sceneForCondition('rain', 'clear-noon')),
    );
    expect(sceneKey(sceneForCondition('rain', 'golden-hour'))).not.toBe(
      sceneKey(sceneForCondition('fog', 'golden-hour')),
    );
  });

  it('labels in plain words; clear nights are not "sunny"', () => {
    expect(conditionLabel('clear')).toBe('Sunny');
    expect(conditionLabel('clear', false)).toBe('Clear');
    expect(conditionLabel('fog', false)).toBe('Fog');
    expect(conditionLabel('storm')).toBe('Thunderstorm');
  });
});
