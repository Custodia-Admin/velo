/**
 * Route card in the ride details (compact ride HUD, owner-directed revision
 * 2 Nov 2026, docs/design/mockups/v2-ride-hud.html; collapsed by default):
 * the place name in the book serif, "6.7 km to go · about 20 min", the
 * elevation profile with a "you are here" dot, the next named place on the
 * road (sm+): a village, church or tower the route passes (the world
 * bundle's OSM points of interest) or a detected climb, and the weather
 * line. Nothing is invented: routes with neither show no line.
 *
 * Quantised reads (10 m, 10 s) keep it at display-change rate.
 */

import { cn } from '@/lib/utils';
import { quantizedMeters } from '@/lib/hudThrottle';
import { scenicRouteById } from '@/lib/scenicRoutes';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useNextLandmark } from '@/hooks/useRouteLandmarks';
import { NextLandmark } from './NextLandmark';
import { RideWeatherChip } from './RideWeatherChip';
import { RouteProfile } from './RouteProfile';
import { DISPLAY, HUD_PANEL } from './v2';
import { remainingText } from './rideHudText';

export function RideRoutePanel({ className }: { className?: string }) {
  const route = useRideStore((s) => s.route);
  const distance = useRideStore((s) => quantizedMeters(s.distance, 10));
  // 10 s steps: only the "about N min" projection reads it.
  const elapsedS = useRideStore((s) => Math.floor(s.elapsedMs / 10_000) * 10);
  const units = useSettingsStore((s) => s.units);

  const estMinutes = route ? scenicRouteById(route.id)?.estMinutes ?? null : null;
  const next = useNextLandmark(route, distance, units);

  if (!route) return null;
  const total = route.isLive ? 0 : route.totalDistance;
  const left = remainingText({ distanceM: distance, totalM: total, elapsedS, estMinutes, units });
  const at = total > 0 ? Math.min(1, distance / total) : undefined;

  return (
    <section
      aria-label="Route progress"
      className={cn(
        HUD_PANEL,
        'pointer-events-auto flex min-w-0 flex-col gap-1 px-3 py-2 sm:px-4 sm:py-3',
        className,
      )}
    >
      <h1 className={cn(DISPLAY, 'truncate text-base sm:text-xl')}>{route.name}</h1>
      {left && <p className="num truncate text-sm text-muted-foreground">{left}</p>}
      {total > 0 && route.points.length > 1 && (
        <RouteProfile route={route} at={at} className="h-8" />
      )}
      {next && <NextLandmark next={next} testId="route-next" className="hidden sm:flex" />}
      <RideWeatherChip inline />
    </section>
  );
}
