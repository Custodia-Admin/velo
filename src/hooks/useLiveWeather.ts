import { useEffect, useMemo } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  routeWeatherPoint,
  useLiveWeatherStore,
  type WeatherEntry,
} from '@/stores/liveWeatherStore';
import { weatherKey } from '@/lib/meteo/openMeteo';
import type { Route } from '@/types';

/**
 * Live weather entries for a set of routes (their start points), fetched in
 * one batched request. Returns undefined entries while live weather is off.
 */
export function useRoutesWeather(
  routes: Pick<Route, 'id' | 'points'>[],
): Record<string, WeatherEntry | undefined> {
  const enabled = useSettingsStore((s) => s.liveWeatherEnabled);
  const entries = useLiveWeatherStore((s) => s.entries);
  const request = useLiveWeatherStore((s) => s.request);

  const points = useMemo(
    () =>
      routes.map((r) => ({ id: r.id, point: routeWeatherPoint(r) })),
    [routes],
  );
  const pointsSig = points.map((p) => (p.point ? weatherKey(p.point) : '-')).join('|');

  useEffect(() => {
    if (!enabled) return;
    const list = points.flatMap((p) => (p.point ? [p.point] : []));
    if (list.length > 0) void request(list);
    // pointsSig captures the identity of the requested places.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, pointsSig, request]);

  const out: Record<string, WeatherEntry | undefined> = {};
  for (const p of points) out[p.id] = enabled && p.point ? entries[weatherKey(p.point)] : undefined;
  return out;
}

/** Live weather entry for one route. */
export function useRouteWeather(route: Pick<Route, 'id' | 'points'> | null | undefined): WeatherEntry | undefined {
  const list = useMemo(() => (route ? [route] : []), [route]);
  const map = useRoutesWeather(list);
  return route ? map[route.id] : undefined;
}

/** Retry a failed fetch for a route right now. */
export function retryRouteWeather(route: Pick<Route, 'points'>): void {
  const p = routeWeatherPoint(route);
  if (p) void useLiveWeatherStore.getState().request([p], { force: true });
}
