/**
 * v2 route panel (top-left of the ride HUD, docs/design/mockups/v2-ride-hud.html):
 * the place name in the book serif, "6.7 km to go · about 20 min", the
 * elevation profile with a "you are here" dot (sm+), and the next named
 * landmark when the route has one (detected climbs; nothing is invented).
 *
 * Quantised reads (10 m, 10 s) keep it at display-change rate.
 */

import { useMemo } from 'react';
import { Flag } from 'lucide-react';
import { cn } from '@/lib/utils';
import { findClimbs } from '@/lib/climbDetection';
import { quantizedMeters } from '@/lib/hudThrottle';
import { scenicRouteById } from '@/lib/scenicRoutes';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { RouteProfile } from './RouteProfile';
import { DISPLAY, HUD_PANEL } from './v2';
import { nextLandmarkText, remainingText } from './rideHudText';

export function RideRoutePanel({ className }: { className?: string }) {
  const route = useRideStore((s) => s.route);
  const distance = useRideStore((s) => quantizedMeters(s.distance, 10));
  // 10 s steps: only the "about N min" projection reads it.
  const elapsedS = useRideStore((s) => Math.floor(s.elapsedMs / 10_000) * 10);
  const units = useSettingsStore((s) => s.units);

  const estMinutes = route ? scenicRouteById(route.id)?.estMinutes ?? null : null;
  const climbs = useMemo(() => (route && !route.isLive ? findClimbs(route) : []), [route]);

  if (!route) return null;
  const total = route.isLive ? 0 : route.totalDistance;
  const left = remainingText({ distanceM: distance, totalM: total, elapsedS, estMinutes, units });
  const next = nextLandmarkText(climbs, distance, units);
  const at = total > 0 ? Math.min(1, distance / total) : undefined;

  return (
    <section
      aria-label="Route progress"
      className={cn(
        HUD_PANEL,
        'pointer-events-auto flex min-w-0 flex-col px-3 py-2 sm:w-80 sm:gap-1 sm:px-4 sm:py-3',
        className,
      )}
    >
      <h1 className={cn(DISPLAY, 'truncate text-base sm:text-xl')}>{route.name}</h1>
      {left && <p className="num truncate text-sm text-muted-foreground">{left}</p>}
      {total > 0 && route.points.length > 1 && (
        <RouteProfile route={route} at={at} className="hidden h-8 sm:block" />
      )}
      {next && (
        <p className="hidden items-center gap-1.5 text-sm sm:flex">
          <Flag className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate">{next}</span>
        </p>
      )}
    </section>
  );
}
