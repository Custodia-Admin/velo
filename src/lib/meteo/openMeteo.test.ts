import { describe, it, expect } from 'vitest';
import {
  buildOpenMeteoUrl,
  parseOpenMeteoLocation,
  parseOpenMeteoResponse,
  fetchLiveWeather,
  weatherKey,
  readWeatherCache,
  CACHE_STORAGE_KEY,
  FRESH_MS,
  STALE_MAX_MS,
  type WeatherStorage,
} from '@/lib/meteo/openMeteo';

// Real response shape captured from api.open-meteo.com for Lugano, 30 Oct 2026.
const LUGANO = {
  latitude: 45.99724,
  longitude: 8.945581,
  timezone: 'Europe/Zurich',
  current_units: { wind_speed_10m: 'm/s' },
  current: {
    time: '2026-10-30T00:45',
    interval: 900,
    temperature_2m: 9.3,
    is_day: 0,
    precipitation: 0.0,
    snowfall: 0.0,
    weather_code: 45,
    cloud_cover: 64,
    wind_speed_10m: 0.72,
    wind_direction_10m: 304,
    wind_gusts_10m: 1.5,
    visibility: 1820.0,
  },
};
const P_LUGANO = { lat: 46.0037, lon: 8.9511 };
const P_LOCARNO = { lat: 46.1670, lon: 8.7943 };

function memStorage(init: Record<string, string> = {}): WeatherStorage & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

function okFetch(body: unknown, calls: string[] = []): typeof fetch {
  return (async (url: string) => {
    calls.push(url);
    return { ok: true, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

const failFetch = (async () => {
  throw new TypeError('Failed to fetch');
}) as unknown as typeof fetch;

describe('buildOpenMeteoUrl', () => {
  it('asks for current conditions in m/s, keyless', () => {
    const url = new URL(buildOpenMeteoUrl([P_LUGANO]));
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast');
    expect(url.searchParams.get('latitude')).toBe('46.0037');
    expect(url.searchParams.get('longitude')).toBe('8.9511');
    expect(url.searchParams.get('wind_speed_unit')).toBe('ms');
    expect(url.searchParams.get('current')).toContain('weather_code');
    expect(url.searchParams.get('current')).toContain('wind_gusts_10m');
    expect(url.search).not.toMatch(/apikey|key=/i);
  });

  it('batches several places into one request', () => {
    const url = new URL(buildOpenMeteoUrl([P_LUGANO, P_LOCARNO]));
    expect(url.searchParams.get('latitude')).toBe('46.0037,46.1670');
    expect(url.searchParams.get('longitude')).toBe('8.9511,8.7943');
  });

  it('refuses an empty batch', () => {
    expect(() => buildOpenMeteoUrl([])).toThrow();
  });
});

describe('parseOpenMeteoLocation', () => {
  it('maps the real response to SI LiveWeather', () => {
    const w = parseOpenMeteoLocation(LUGANO, P_LUGANO)!;
    expect(w).toEqual({
      lat: P_LUGANO.lat,
      lon: P_LUGANO.lon,
      observedAt: '2026-10-30T00:45',
      temperatureC: 9.3,
      weatherCode: 45,
      cloudCoverPct: 64,
      precipitationMm: 0,
      snowfallCm: 0,
      windSpeedMs: 0.72,
      windFromDeg: 304,
      windGustMs: 1.5,
      visibilityM: 1820,
      isDay: false,
    });
  });

  it('returns null without the fields it cannot do without', () => {
    expect(parseOpenMeteoLocation(null)).toBeNull();
    expect(parseOpenMeteoLocation({})).toBeNull();
    expect(parseOpenMeteoLocation({ current: { ...LUGANO.current, weather_code: null } })).toBeNull();
    expect(parseOpenMeteoLocation({ current: { ...LUGANO.current, wind_speed_10m: 'x' } })).toBeNull();
    expect(parseOpenMeteoLocation({ error: true, reason: 'bad' })).toBeNull();
  });

  it('normalises direction, clamps gusts to at least the mean, tolerates missing extras', () => {
    const w = parseOpenMeteoLocation({
      current: {
        temperature_2m: -2,
        weather_code: 3,
        wind_speed_10m: 5,
        wind_direction_10m: 370,
        wind_gusts_10m: 2,
      },
    })!;
    expect(w.windFromDeg).toBe(10);
    expect(w.windGustMs).toBe(5);
    expect(w.visibilityM).toBeNull();
    expect(w.cloudCoverPct).toBe(0);
    expect(w.isDay).toBe(true);
  });

  it('parses multi-location arrays in request order', () => {
    const second = { ...LUGANO, current: { ...LUGANO.current, weather_code: 61 } };
    const out = parseOpenMeteoResponse([LUGANO, second], [P_LUGANO, P_LOCARNO]);
    expect(out.map((w) => w?.weatherCode)).toEqual([45, 61]);
    expect(out[1]?.lat).toBe(P_LOCARNO.lat);
  });
});

describe('fetchLiveWeather: cache and offline fallback', () => {
  const NOW = 1_800_000_000_000;

  it('fetches, returns live and writes the cache', async () => {
    const storage = memStorage();
    const calls: string[] = [];
    const [r] = await fetchLiveWeather([P_LUGANO], { fetchImpl: okFetch(LUGANO, calls), now: NOW, storage });
    expect(calls).toHaveLength(1);
    expect(r?.source).toBe('live');
    expect(r?.weather.weatherCode).toBe(45);
    expect(readWeatherCache(storage)[weatherKey(P_LUGANO)].fetchedAt).toBe(NOW);
  });

  it('serves fresh cache without touching the network', async () => {
    const storage = memStorage();
    await fetchLiveWeather([P_LUGANO], { fetchImpl: okFetch(LUGANO), now: NOW, storage });
    const calls: string[] = [];
    const [r] = await fetchLiveWeather([P_LUGANO], {
      fetchImpl: okFetch(LUGANO, calls),
      now: NOW + FRESH_MS - 1,
      storage,
    });
    expect(calls).toHaveLength(0);
    expect(r?.source).toBe('cached');
  });

  it('falls back to stale cache when offline, then to null once too old', async () => {
    const storage = memStorage();
    await fetchLiveWeather([P_LUGANO], { fetchImpl: okFetch(LUGANO), now: NOW, storage });

    const [stale] = await fetchLiveWeather([P_LUGANO], { fetchImpl: failFetch, now: NOW + FRESH_MS + 1, storage });
    expect(stale?.source).toBe('stale');
    expect(stale?.fetchedAt).toBe(NOW);

    const [gone] = await fetchLiveWeather([P_LUGANO], { fetchImpl: failFetch, now: NOW + STALE_MAX_MS + 1, storage });
    expect(gone).toBeNull();
  });

  it('returns null (canned moods) with no cache and no network, or a non-OK reply', async () => {
    const [a] = await fetchLiveWeather([P_LUGANO], { fetchImpl: failFetch, now: NOW, storage: memStorage() });
    expect(a).toBeNull();
    const notOk = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    const [b] = await fetchLiveWeather([P_LUGANO], { fetchImpl: notOk, now: NOW, storage: memStorage() });
    expect(b).toBeNull();
  });

  it('batches only the missing places and de-duplicates shared cells', async () => {
    const storage = memStorage();
    await fetchLiveWeather([P_LUGANO], { fetchImpl: okFetch(LUGANO), now: NOW, storage });
    const calls: string[] = [];
    const nearLocarno = { lat: P_LOCARNO.lat + 0.001, lon: P_LOCARNO.lon };
    const out = await fetchLiveWeather([P_LUGANO, P_LOCARNO, nearLocarno], {
      fetchImpl: okFetch({ ...LUGANO, current: { ...LUGANO.current, weather_code: 0 } }, calls),
      now: NOW + 1000,
      storage,
    });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]).searchParams.get('latitude')).toBe(P_LOCARNO.lat.toFixed(4));
    expect(out.map((r) => r?.source)).toEqual(['cached', 'live', 'live']);
  });

  it('survives corrupt cache JSON and a storage that throws', async () => {
    const corrupt = memStorage({ [CACHE_STORAGE_KEY]: '{not json' });
    const [r] = await fetchLiveWeather([P_LUGANO], { fetchImpl: okFetch(LUGANO), now: NOW, storage: corrupt });
    expect(r?.source).toBe('live');
    const throwing: WeatherStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('quota'); },
    };
    const [r2] = await fetchLiveWeather([P_LUGANO], { fetchImpl: okFetch(LUGANO), now: NOW, storage: throwing });
    expect(r2?.source).toBe('live');
  });
});
