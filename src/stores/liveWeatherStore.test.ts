import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useLiveWeatherStore,
  liveWeatherForRoute,
  routeWeatherPoint,
  weatherEntryFor,
} from '@/stores/liveWeatherStore';
import { DEFAULT_SETTINGS } from '@/stores/settingsStore';
import { comfortDefaults } from '@/stores/riderRosterStore';

const LUGANO = {
  current: {
    time: '2026-10-30T00:45', temperature_2m: 9.3, is_day: 0, precipitation: 0, snowfall: 0,
    weather_code: 45, cloud_cover: 64, wind_speed_10m: 0.72, wind_direction_10m: 304,
    wind_gusts_10m: 1.5, visibility: 1820,
  },
};
const route = { points: [{ lat: 46.0037, lon: 8.9511, ele: 273, distance: 0 }] };

beforeEach(() => {
  useLiveWeatherStore.setState({ entries: {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('liveWeatherStore', () => {
  it('reads weather at the route start', () => {
    expect(routeWeatherPoint(route)).toEqual({ lat: 46.0037, lon: 8.9511 });
    expect(routeWeatherPoint(null)).toBeNull();
    expect(routeWeatherPoint({ points: [] })).toBeNull();
  });

  it('loads, then serves the ride loop without another request', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => LUGANO }));
    vi.stubGlobal('fetch', fetchMock);
    const p = useLiveWeatherStore.getState().request([routeWeatherPoint(route)!]);
    expect(weatherEntryFor(routeWeatherPoint(route))?.status).toBe('loading');
    await p;
    expect(liveWeatherForRoute(route)?.weatherCode).toBe(45);
    await useLiveWeatherStore.getState().request([routeWeatherPoint(route)!]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marks a place unavailable when offline (canned moods take over)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    // Use a place no other test cached.
    const far = { lat: -33.9, lon: 151.2 };
    await useLiveWeatherStore.getState().request([far]);
    expect(weatherEntryFor(far)?.status).toBe('unavailable');
    expect(liveWeatherForRoute({ points: [{ ...far, ele: 0, distance: 0 }] })).toBeNull();
  });
});

describe('settings defaults for live weather', () => {
  it('live weather on, wind feel subtle, wind feel is per rider', () => {
    expect(DEFAULT_SETTINGS.liveWeatherEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.windFeel).toBe('subtle');
    expect(comfortDefaults().windFeel).toBe('subtle');
  });
});
