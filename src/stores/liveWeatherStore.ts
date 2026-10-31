/**
 * Live weather per place, in memory. Persistence and offline fallback live in
 * lib/meteo/openMeteo (localStorage cache); this store only tracks what the
 * UI and ride loop have asked for and what came back.
 */

import { create } from 'zustand';
import {
  fetchLiveWeather,
  weatherKey,
  FRESH_MS,
  type LatLon,
  type LiveWeather,
  type WeatherSource,
} from '@/lib/meteo/openMeteo';
import type { Route } from '@/types';

export type WeatherEntry =
  | { status: 'loading' }
  | { status: 'ready'; weather: LiveWeather; source: WeatherSource; fetchedAt: number }
  | { status: 'unavailable'; checkedAt: number };

/** After a failed fetch, wait this long before trying the same place again. */
export const RETRY_AFTER_MS = 2 * 60 * 1000;

interface LiveWeatherState {
  entries: Record<string, WeatherEntry>;
  /** Fetch any of `points` that are missing or out of date. One request per call. */
  request: (points: LatLon[], opts?: { force?: boolean }) => Promise<void>;
}

/** Where a route's weather is read: its start, per the brief. */
export function routeWeatherPoint(route: Pick<Route, 'points'> | null | undefined): LatLon | null {
  const p = route?.points?.[0];
  if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return null;
  return { lat: p.lat, lon: p.lon };
}

function needsFetch(entry: WeatherEntry | undefined, now: number, force: boolean): boolean {
  if (!entry) return true;
  if (entry.status === 'loading') return false;
  if (force) return true;
  if (entry.status === 'unavailable') return now - entry.checkedAt > RETRY_AFTER_MS;
  return entry.source === 'stale' || now - entry.fetchedAt >= FRESH_MS;
}

export const useLiveWeatherStore = create<LiveWeatherState>()((set, get) => ({
  entries: {},

  request: async (points, opts = {}) => {
    const now = Date.now();
    const force = opts.force === true;
    const todo = new Map<string, LatLon>();
    for (const p of points) {
      const key = weatherKey(p);
      if (!todo.has(key) && needsFetch(get().entries[key], now, force)) todo.set(key, p);
    }
    if (todo.size === 0) return;

    const keys = [...todo.keys()];
    set((s) => {
      const entries = { ...s.entries };
      // Keep showing old data while refreshing; only blank entries show loading.
      for (const k of keys) if (!entries[k] || force) entries[k] = { status: 'loading' };
      return { entries };
    });

    const results = await fetchLiveWeather([...todo.values()], { force });
    set((s) => {
      const entries = { ...s.entries };
      keys.forEach((k, i) => {
        const r = results[i];
        entries[k] = r
          ? { status: 'ready', weather: r.weather, source: r.source, fetchedAt: r.fetchedAt }
          : { status: 'unavailable', checkedAt: Date.now() };
      });
      return { entries };
    });
  },
}));

/** Entry for a point, or undefined if never requested. */
export function weatherEntryFor(p: LatLon | null): WeatherEntry | undefined {
  if (!p) return undefined;
  return useLiveWeatherStore.getState().entries[weatherKey(p)];
}

/** Ready weather for a route's start point, or null. Non-reactive (ride loop). */
export function liveWeatherForRoute(route: Pick<Route, 'points'> | null | undefined): LiveWeather | null {
  const e = weatherEntryFor(routeWeatherPoint(route));
  return e?.status === 'ready' ? e.weather : null;
}
