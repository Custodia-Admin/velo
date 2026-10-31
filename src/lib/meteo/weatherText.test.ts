import { describe, it, expect } from 'vitest';
import {
  cardWeatherText,
  hudConditionText,
  hudWindText,
  observedTimeText,
  temperatureText,
  windSpeedText,
} from '@/lib/meteo/weatherText';
import type { LiveWeather } from '@/lib/meteo/openMeteo';

const fog: LiveWeather = {
  lat: 46, lon: 8.95, observedAt: '2026-10-30T00:45', temperatureC: 9.3, weatherCode: 45,
  cloudCoverPct: 64, precipitationMm: 0, snowfallCm: 0, windSpeedMs: 0.72, windFromDeg: 304,
  windGustMs: 1.5, visibilityM: 1820, isDay: false,
};

describe('weather text', () => {
  it('card line', () => {
    expect(cardWeatherText(fog, 'metric')).toBe('Fog · 9° · calm');
    expect(cardWeatherText({ ...fog, weatherCode: 0, isDay: true, windSpeedMs: 4 }, 'metric')).toBe(
      'Sunny · 9° · wind 14 km/h',
    );
    expect(cardWeatherText({ ...fog, weatherCode: 0, windSpeedMs: 4 }, 'imperial')).toBe(
      'Clear · 49° · wind 9 mph',
    );
  });

  it('units and rounding', () => {
    expect(windSpeedText(10, 'metric')).toBe('36 km/h');
    expect(windSpeedText(-1, 'metric')).toBe('0 km/h');
    expect(temperatureText(-0.3, 'metric')).toBe('0°');
    expect(temperatureText(0, 'imperial')).toBe('32°');
  });

  it('HUD parts', () => {
    expect(hudConditionText(fog, 'metric')).toBe('Fog · 9°');
    expect(hudWindText(0.72, 0, 'metric')).toBe('Calm');
    expect(hudWindText(3, 0, 'metric')).toBe('Light headwind 11 km/h');
  });

  it('observed time', () => {
    expect(observedTimeText('2026-10-30T14:05')).toBe('14:05');
    expect(observedTimeText('')).toBe('');
  });
});
