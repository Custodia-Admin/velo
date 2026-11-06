/**
 * RoutePreview — preview card shown between route generation and commit.
 *
 * Draws the real polyline on a map plate (velo/MapPlate, as Home draws a
 * route with no baked world) beside one figures line: distance, climbing
 * and an estimated ride time at a conservative 25 km/h average. Two
 * buttons commit the route or re-generate with the same params.
 *
 * Lives in src/components/setup/ so it's used only inside the wizard.
 * Local-first by design — pure presentation, no network calls. On-system
 * (UI-RULES §2, checked by src/test/uiRules.test.ts).
 */

import { Check, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MapPlate } from '@/components/velo/MapPlate';
import { DISPLAY } from '@/components/velo/v2';
import { cn } from '@/lib/utils';
import type { Route } from '@/types';

interface RoutePreviewProps {
  route: Route;
  onCommit: () => void;
  onRegenerate: () => void;
  regenerating?: boolean;
}

/** Conservative steady-state average for time estimates. */
const ESTIMATE_AVG_KMH = 25;

/** Format an estimated ride time at a fixed average speed. */
export function estimateRideTime(distanceM: number, avgKmh = ESTIMATE_AVG_KMH): string {
  if (!Number.isFinite(distanceM) || distanceM <= 0) return '—';
  const hours = distanceM / 1000 / avgKmh;
  const totalMin = Math.round(hours * 60);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function RoutePreview({ route, onCommit, onRegenerate, regenerating }: RoutePreviewProps) {
  const distanceKm = (route.totalDistance / 1000).toFixed(1);
  const ascentM = Math.round(route.ascent);
  const eta = estimateRideTime(route.totalDistance);
  const figures = [
    `${distanceKm} km`,
    ascentM > 0 ? `${ascentM} m climbing` : null,
    eta === '—' ? null : `about ${eta}`,
  ].filter(Boolean).join(' · ');

  // The real route on a map plate, as Home draws routes whose world is not
  // baked yet; the text and the two actions beside it from sm up.
  return (
    <div className="flex flex-col gap-4 border-t border-border pt-4 animate-fadeUp sm:flex-row sm:items-start" data-route-preview>
      <MapPlate
        route={route}
        aspect={3 / 2}
        className="aspect-3/2 w-full shrink-0 border border-border bg-card sm:w-48"
      />
      <div className="flex min-w-0 flex-col gap-3">
        <div>
          <p className={cn(DISPLAY, 'text-lg text-foreground')}>{route.name}</p>
          <p className="num text-sm text-muted-foreground">
            {figures}
            <span className="sr-only">, at an easy {ESTIMATE_AVG_KMH} km/h</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={onCommit}>
            <Check className="h-4 w-4" aria-hidden />
            Use this route
          </Button>
          <Button variant="outline" onClick={onRegenerate} disabled={regenerating}>
            <RotateCcw className="h-4 w-4" aria-hidden />
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
