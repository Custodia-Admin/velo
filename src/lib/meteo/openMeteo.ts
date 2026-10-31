/**
 * Live weather from Open-Meteo (https://open-meteo.com).
 *
 * Free, keyless, no account: one GET per batch of coordinates. Results are
 * cached in localStorage so a ride that starts offline still gets the last
 * conditions we saw, and a page of route cards costs a single request.
 * When nothing usable is cached and the network fails, callers fall back to
 * the route's canned mood.
 */

export const OPEN_METEO_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

/** Variables requested from the `current` block. */
export const CURRENT_FIELDS = [
  'temperature_2m',
  'is_day',
  'precipitation',
  'snowfall',
  'weather_code',
  'cloud_cover',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'visibility',
] as const;

/** Re-fetch after this long. Open-Meteo's current block updates every 15 min. */
export const FRESH_MS = 20 * 60 * 1000;
/** Cached data older than this is not used, even offline. */
export const STALE_MAX_MS = 3 * 60 * 60 * 1000;

export const CACHE_STORAGE_KEY = 'globeride.velo.weather.v1';

export interface LatLon {
  lat: number;
  lon: number;
}

/** Current conditions at one place, normalised to SI units. */
export interface LiveWeather {
  lat: number;
  lon: number;
  /** Local observation time as Open-Meteo reports it (ISO, no zone). */
  observedAt: string;
  temperatureC: number;
  /** WMO weather interpretation code (0–99). */
  weatherCode: number;
  cloudCoverPct: number;
  /** Precipitation in the last interval, mm. */
  precipitationMm: number;
  /** Snowfall in the last interval, cm. */
  snowfallCm: number;
  /** Mean wind at 10 m, m/s. */
  windSpeedMs: number;
  /** Direction the wind blows FROM, degrees clockwise from north. */
  windFromDeg: number;
  /** Gusts at 10 m, m/s. Never below windSpeedMs. */
  windGustMs: number;
  /** Horizontal visibility, m. Null when the model doesn't provide it. */
  visibilityM: number | null;
  isDay: boolean;
}

export type WeatherSource = 'live' | 'cached' | 'stale';

export interface WeatherResult {
  /** `live` = just fetched; `cached` = fresh from cache; `stale` = old cache used because the fetch failed. */
  source: WeatherSource;
  weather: LiveWeather;
  fetchedAt: number;
}

/** Cache key: ~1 km grid, plenty for a start-of-route reading. */
export function weatherKey(p: LatLon): string {
  return `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
}

/** Build the request URL for one or more coordinates (Open-Meteo accepts comma lists). */
export function buildOpenMeteoUrl(points: LatLon[]): string {
  if (points.length === 0) throw new Error('buildOpenMeteoUrl: no points');
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat.toFixed(4)).join(','),
    longitude: points.map((p) => p.lon.toFixed(4)).join(','),
    current: CURRENT_FIELDS.join(','),
    wind_speed_unit: 'ms',
    timezone: 'auto',
  });
  return `${OPEN_METEO_ENDPOINT}?${params.toString()}`;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Map one Open-Meteo location object to LiveWeather. Returns null when the
 * fields we can't do without (code, temperature, wind) are missing.
 */
export function parseOpenMeteoLocation(json: unknown, requested?: LatLon): LiveWeather | null {
  if (!json || typeof json !== 'object') return null;
  const root = json as Record<string, unknown>;
  const cur = root.current as Record<string, unknown> | undefined;
  if (!cur || typeof cur !== 'object') return null;

  const code = num(cur.weather_code);
  const temp = num(cur.temperature_2m);
  const wind = num(cur.wind_speed_10m);
  const dir = num(cur.wind_direction_10m);
  if (code === null || temp === null || wind === null || dir === null) return null;

  const windSpeedMs = Math.max(0, wind);
  const gust = num(cur.wind_gusts_10m);
  return {
    lat: requested?.lat ?? num(root.latitude) ?? 0,
    lon: requested?.lon ?? num(root.longitude) ?? 0,
    observedAt: typeof cur.time === 'string' ? cur.time : '',
    temperatureC: temp,
    weatherCode: Math.round(code),
    cloudCoverPct: Math.min(100, Math.max(0, num(cur.cloud_cover) ?? 0)),
    precipitationMm: Math.max(0, num(cur.precipitation) ?? 0),
    snowfallCm: Math.max(0, num(cur.snowfall) ?? 0),
    windSpeedMs,
    windFromDeg: ((dir % 360) + 360) % 360,
    windGustMs: Math.max(windSpeedMs, gust ?? windSpeedMs),
    visibilityM: num(cur.visibility),
    isDay: num(cur.is_day) !== 0,
  };
}

/**
 * Map a full response. Single-location requests return an object, multi-
 * location requests an array in request order.
 */
export function parseOpenMeteoResponse(json: unknown, requested: LatLon[]): (LiveWeather | null)[] {
  const list = Array.isArray(json) ? json : [json];
  return requested.map((p, i) => parseOpenMeteoLocation(list[i], p));
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  fetchedAt: number;
  weather: LiveWeather;
}

type CacheShape = Record<string, CacheEntry>;

/** Minimal Storage subset so tests can pass a Map-backed fake. */
export type WeatherStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): WeatherStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readWeatherCache(storage: WeatherStorage | null = defaultStorage()): CacheShape {
  if (!storage) return {};
  try {
    const raw = storage.getItem(CACHE_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as CacheShape) : {};
  } catch {
    return {};
  }
}

function writeWeatherCache(cache: CacheShape, now: number, storage: WeatherStorage | null): void {
  if (!storage) return;
  // Drop anything too old to ever be used again so the entry stays small.
  const pruned: CacheShape = {};
  for (const [k, v] of Object.entries(cache)) {
    if (v && now - v.fetchedAt <= STALE_MAX_MS) pruned[k] = v;
  }
  try {
    storage.setItem(CACHE_STORAGE_KEY, JSON.stringify(pruned));
  } catch {
    /* quota or private mode: the cache is an optimisation only */
  }
}

export interface FetchWeatherOptions {
  fetchImpl?: typeof fetch;
  now?: number;
  storage?: WeatherStorage | null;
  signal?: AbortSignal;
  /** Skip fresh cache entries and always hit the network. */
  force?: boolean;
}

/**
 * Current weather for each point, in order. Fresh cache entries are reused;
 * everything else goes out in ONE batched request. If that request fails,
 * cached entries younger than STALE_MAX_MS are returned as `stale`; points
 * with nothing usable come back as null (caller uses canned moods).
 */
export async function fetchLiveWeather(
  points: LatLon[],
  opts: FetchWeatherOptions = {},
): Promise<(WeatherResult | null)[]> {
  const now = opts.now ?? Date.now();
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const fetchImpl = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  const cache = readWeatherCache(storage);

  const results: (WeatherResult | null)[] = points.map(() => null);
  const missing: { index: number; point: LatLon }[] = [];

  points.forEach((p, i) => {
    const hit = cache[weatherKey(p)];
    if (!opts.force && hit && now - hit.fetchedAt < FRESH_MS) {
      results[i] = { source: 'cached', weather: hit.weather, fetchedAt: hit.fetchedAt };
    } else {
      missing.push({ index: i, point: p });
    }
  });
  if (missing.length === 0) return results;

  // De-duplicate points that share a cache cell.
  const unique = new Map<string, LatLon>();
  for (const m of missing) {
    const key = weatherKey(m.point);
    if (!unique.has(key)) unique.set(key, m.point);
  }
  const uniquePoints = [...unique.values()];

  let fetched: (LiveWeather | null)[] | null = null;
  if (fetchImpl) {
    try {
      const res = await fetchImpl(buildOpenMeteoUrl(uniquePoints), { signal: opts.signal });
      if (res.ok) fetched = parseOpenMeteoResponse(await res.json(), uniquePoints);
    } catch {
      fetched = null;
    }
  }

  const byKey = new Map<string, LiveWeather>();
  if (fetched) {
    uniquePoints.forEach((p, i) => {
      const w = fetched?.[i];
      if (w) {
        const key = weatherKey(p);
        byKey.set(key, w);
        cache[key] = { fetchedAt: now, weather: w };
      }
    });
    writeWeatherCache(cache, now, storage);
  }

  for (const { index, point } of missing) {
    const key = weatherKey(point);
    const fresh = byKey.get(key);
    if (fresh) {
      results[index] = { source: 'live', weather: fresh, fetchedAt: now };
      continue;
    }
    const old = cache[key];
    if (old && now - old.fetchedAt <= STALE_MAX_MS) {
      results[index] = { source: 'stale', weather: old.weather, fetchedAt: old.fetchedAt };
    }
  }
  return results;
}
