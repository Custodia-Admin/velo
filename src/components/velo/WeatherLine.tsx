/**
 * One line of live conditions at a route's start, for route cards and the
 * featured ride. Covers loading (skeleton the size of the line), ready,
 * stale-from-cache (shows the time it was observed) and offline.
 */

import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settingsStore';
import type { WeatherEntry } from '@/stores/liveWeatherStore';
import { conditionFor } from '@/lib/meteo/sceneWeather';
import { cardWeatherText, observedTimeText } from '@/lib/meteo/weatherText';
import { WeatherIcon } from '@/components/velo/WeatherIcon';

export interface WeatherLineProps {
  /** Undefined while live weather is off: renders nothing. */
  entry: WeatherEntry | undefined;
  size?: 'sm' | 'base';
  /** Shown before the conditions, e.g. "Now". */
  prefix?: string;
  /** Offers a Retry action when the forecast couldn't be reached. */
  onRetry?: () => void;
  className?: string;
}

export function WeatherLine({ entry, size = 'sm', prefix, onRetry, className }: WeatherLineProps) {
  const units = useSettingsStore((s) => s.units);
  if (!entry) return null;

  const text = size === 'base' ? 'text-base' : 'text-sm';
  const icon = size === 'base' ? 'h-5 w-5' : 'h-4 w-4';

  if (entry.status === 'loading') {
    return (
      <div className={cn('flex h-6 items-center gap-2', className)} aria-hidden>
        <span className={cn(icon, 'animate-pulse rounded-full bg-muted')} />
        <span className="h-4 w-40 animate-pulse rounded-sm bg-muted" />
      </div>
    );
  }

  if (entry.status === 'unavailable') {
    return (
      <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1', className)}>
        <p className={cn(text, 'text-muted-foreground')}>Weather offline, showing the usual scenery.</p>
        {onRetry && (
          <Button variant="ghost" onClick={onRetry} aria-label="Retry live weather">
            <RotateCw className="h-4 w-4" />
            Retry
          </Button>
        )}
      </div>
    );
  }

  const w = entry.weather;
  const conditions = cardWeatherText(w, units);
  const asOf = entry.source === 'stale' ? observedTimeText(w.observedAt) : '';
  const label = `${prefix ? `${prefix}: ` : ''}${conditions}${asOf ? ` (as of ${asOf})` : ''}`;
  return (
    // Featured card: full weight. Grid cards: muted, so the ride's own
    // figures stay the strongest line.
    <p
      className={cn('flex min-h-6 items-center gap-2', text, size === 'base' ? 'text-foreground' : 'text-muted-foreground', className)}
      aria-label={label}
    >
      <WeatherIcon condition={conditionFor(w)} isDay={w.isDay} className={cn(icon, 'shrink-0 text-primary')} />
      <span aria-hidden>
        {prefix && <span className="font-semibold">{prefix}: </span>}
        <span className="num">{conditions}</span>
        {asOf && <span className="text-muted-foreground"> · as of {asOf}</span>}
      </span>
    </p>
  );
}
