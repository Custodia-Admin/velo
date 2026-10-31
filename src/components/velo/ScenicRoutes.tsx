/**
 * Easy & Scenic route surfaces: the featured "Today's ride" card and the
 * route grid. On-system per docs/design/UI-RULES.md (tokens only).
 */

import { Play, Tv } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useSettingsStore, type UnitSystem } from '@/stores/settingsStore';
import type { ScenicRouteInfo } from '@/lib/scenicRoutes';
import { ElevationLine } from '@/components/velo/ElevationLine';
import { WeatherLine } from '@/components/velo/WeatherLine';
import type { WeatherEntry } from '@/stores/liveWeatherStore';
import { cardWeatherText } from '@/lib/meteo/weatherText';

function characterText(info: ScenicRouteInfo): string {
  if (info.character === 'flat') return 'flat';
  return info.route.ascent / Math.max(info.route.totalDistance / 1000, 1) > 8
    ? 'gentle climb'
    : 'gently rolling';
}

function distanceText(meters: number, units: UnitSystem): string {
  return units === 'imperial'
    ? `${(meters / 1609.344).toFixed(1)} mi`
    : `${(meters / 1000).toFixed(1)} km`;
}

function figures(info: ScenicRouteInfo, units: UnitSystem): string {
  return `${distanceText(info.route.totalDistance, units)} · ${characterText(info)} · about ${info.estMinutes} min`;
}

export interface ScenicPickProps {
  /** Route currently loaded in the ride store, to mark it as selected. */
  activeRouteId?: string | null;
  onRide: (info: ScenicRouteInfo) => void;
  /** Live weather per route id; omitted or undefined entries hide the line. */
  weatherById?: Record<string, WeatherEntry | undefined>;
}

/** The one big card: today's suggested ride and the page's primary action. */
export function FeaturedScenicRide({
  info,
  onRide,
  onRideWithShow,
  weather,
  onRetryWeather,
}: {
  info: ScenicRouteInfo;
  onRide: (info: ScenicRouteInfo) => void;
  /** Pick videos, then ride with them playing (show mode). */
  onRideWithShow?: (info: ScenicRouteInfo) => void;
  weather?: WeatherEntry;
  onRetryWeather?: () => void;
}) {
  const units = useSettingsStore((s) => s.units);
  return (
    <article
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:p-6"
      aria-labelledby="todays-ride-title"
      data-testid="featured-scenic-ride"
    >
      <div className="flex flex-col gap-1">
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">Today’s ride</p>
        <h2 id="todays-ride-title" className="text-2xl sm:text-4xl font-bold text-foreground">
          {info.name}
        </h2>
        <p className="text-sm text-muted-foreground">{info.place}</p>
      </div>
      <p className="max-w-prose text-base text-muted-foreground">{info.description}</p>
      <ElevationLine route={info.route} className="h-12 sm:h-16" />
      <WeatherLine entry={weather} size="base" prefix="Now" onRetry={onRetryWeather} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="num text-lg font-semibold text-foreground">{figures(info, units)}</p>
        <div className="flex flex-col gap-3 sm:flex-row-reverse">
          <Button
            size="lg"
            variant="accent"
            className="w-full shadow-glow-accent sm:w-auto"
            onClick={() => onRide(info)}
            aria-label={`Ride ${info.name}`}
          >
            <Play className="h-5 w-5" />
            Ride
          </Button>
          {onRideWithShow && (
            <Button
              size="lg"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => onRideWithShow(info)}
              aria-label={`Ride ${info.name} and watch your videos`}
              data-testid="ride-and-watch"
            >
              <Tv className="h-5 w-5" />
              Ride and watch
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

function ScenicRouteCard({
  info,
  isActive,
  onRide,
  weather,
}: {
  info: ScenicRouteInfo;
  isActive: boolean;
  onRide: (info: ScenicRouteInfo) => void;
  weather?: WeatherEntry;
}) {
  const units = useSettingsStore((s) => s.units);
  const text = figures(info, units);
  const weatherText = weather?.status === 'ready' ? `, now ${cardWeatherText(weather.weather, units)}` : '';
  // The whole card is the button: one big target from the sofa or the bars.
  return (
    <button
      type="button"
      onClick={() => onRide(info)}
      aria-label={`Ride ${info.name}, ${text}${weatherText}`}
      aria-pressed={isActive}
      data-scenic-route={info.route.id}
      className={cn(
        'group flex flex-col gap-3 rounded-lg border bg-card p-4 text-left transition-colors duration-150',
        isActive ? 'border-primary' : 'border-border hover:border-primary/60',
      )}
    >
      <div className="flex w-full items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-lg font-semibold text-foreground">{info.name}</h3>
          <p className="text-sm text-muted-foreground">{info.place}</p>
        </div>
        <span
          aria-hidden
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition-colors duration-150',
            isActive
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border text-foreground group-hover:border-primary group-hover:text-primary',
          )}
        >
          <Play className="h-4 w-4" />
        </span>
      </div>
      <ElevationLine route={info.route} className="h-10" />
      {/* Offline is said once, on the featured card; the grid just omits the line. */}
      {weather?.status !== 'unavailable' && <WeatherLine entry={weather} />}
      <p className="num text-sm text-foreground">{text}</p>
    </button>
  );
}

/** Grid of scenic route cards, 1 / 2 / 3 columns at 390 / sm / lg. */
export function ScenicRouteGrid({
  routes,
  activeRouteId,
  onRide,
  weatherById,
  className,
}: ScenicPickProps & { routes: ScenicRouteInfo[]; className?: string }) {
  return (
    <div className={cn('grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {routes.map((info) => (
        <ScenicRouteCard
          key={info.route.id}
          info={info}
          isActive={info.route.id === activeRouteId}
          onRide={onRide}
          weather={weatherById?.[info.route.id]}
        />
      ))}
    </div>
  );
}

/** Section heading used above each scenic group. */
export function ScenicSectionHeading({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 className="text-2xl font-bold text-foreground">{title}</h2>
      <p className="text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}

/** Loading placeholder with the final grid layout. */
export function ScenicRouteGridSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex h-40 flex-col gap-3 rounded-lg border border-border bg-card p-4">
          <div className="h-5 w-2/3 animate-pulse rounded-sm bg-muted" />
          <div className="h-4 w-1/3 animate-pulse rounded-sm bg-muted" />
          <div className="mt-auto h-10 animate-pulse rounded-sm bg-muted" />
        </div>
      ))}
    </div>
  );
}
