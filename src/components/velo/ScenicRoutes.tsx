/**
 * Easy & Scenic route surfaces (v2 "warm atlas", docs/design/mockups/v2-home.html):
 * Today's ride (a plate with a paper label) and the area grids of tiles.
 * On-system per docs/design/UI-RULES.md (tokens only).
 */

import { Clapperboard, Map as MapIcon, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useSettingsStore, type UnitSystem } from '@/stores/settingsStore';
import { SCENIC_AREAS, type ScenicRouteInfo } from '@/lib/scenicRoutes';
import { WeatherLine } from '@/components/velo/WeatherLine';
import type { WeatherEntry } from '@/stores/liveWeatherStore';
import { cardWeatherText } from '@/lib/meteo/weatherText';
import { postersFor } from '@/lib/world/posters';
import { worldForRoute } from '@/lib/world/catalog';
import { Plate } from '@/components/velo/Plate';
import { MapPlate } from '@/components/velo/MapPlate';
import { RouteProfile } from '@/components/velo/RouteProfile';
import { DISPLAY, KICKER } from '@/components/velo/v2';

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

function areaTitle(info: ScenicRouteInfo): string | undefined {
  return SCENIC_AREAS.find((a) => a.id === info.area)?.title;
}

export interface ScenicPickProps {
  /** Route currently loaded in the ride store, to mark it as selected. */
  activeRouteId?: string | null;
  onRide: (info: ScenicRouteInfo) => void;
  /** Live weather per route id; omitted or undefined entries hide the line. */
  weatherById?: Record<string, WeatherEntry | undefined>;
}

/**
 * Today's ride: the world still (or the route on a map plate) with a paper
 * label holding the page's primary action. Below sm the label sits under the
 * plate and the buttons stack full width.
 */
export function FeaturedScenicRide({
  info,
  onRide,
  onRideWithShow,
  weather,
  onRetryWeather,
  className,
}: {
  info: ScenicRouteInfo;
  onRide: (info: ScenicRouteInfo) => void;
  /** Pick videos, then ride with them playing (show mode). */
  onRideWithShow?: (info: ScenicRouteInfo) => void;
  weather?: WeatherEntry;
  onRetryWeather?: () => void;
  className?: string;
}) {
  const units = useSettingsStore((s) => s.units);
  const posters = postersFor(info.route.id);
  const area = areaTitle(info);
  const plateClass = 'aspect-4/3 w-full sm:aspect-video sm:max-h-hero-fit';
  return (
    <figure
      className={cn('relative', className)}
      aria-labelledby="todays-ride-title"
      data-testid="featured-scenic-ride"
    >
      {posters ? (
        <Plate src={posters.plate} nightSrc={posters.plateNight} alt={posters.alt} priority className={plateClass} />
      ) : (
        <MapPlate route={info.route} aspect={16 / 9} className={plateClass} />
      )}
      <figcaption className="flex flex-col gap-2 pt-4 sm:absolute sm:bottom-6 sm:left-6 sm:w-full sm:max-w-md sm:rounded-lg sm:bg-background sm:p-6 sm:shadow-md">
        <span className={KICKER}>Today’s ride{area ? ` · ${area}` : ''}</span>
        <h2 id="todays-ride-title" className={cn(DISPLAY, 'text-3xl text-foreground sm:text-4xl')}>
          {info.name}
        </h2>
        <span className="text-sm text-muted-foreground">{info.description}</span>
        <RouteProfile route={info.route} className="mt-1 h-8" />
        <span className="num text-base font-semibold text-foreground">{figures(info, units)}</span>
        <WeatherLine entry={weather} prefix="Now" onRetry={onRetryWeather} />
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <Button
            size="lg"
            variant="primary"
            className="w-full text-base sm:w-auto"
            onClick={() => onRide(info)}
            aria-label={`Ride ${info.name}`}
          >
            <Play className="h-5 w-5" />
            Ride
          </Button>
          {onRideWithShow && (
            <Button
              size="lg"
              variant="quiet"
              className="w-full px-3 text-base sm:w-auto"
              onClick={() => onRideWithShow(info)}
              aria-label={`Ride ${info.name} and watch your videos`}
              data-testid="ride-and-watch"
            >
              <Clapperboard className="h-5 w-5" />
              Ride and watch
            </Button>
          )}
        </div>
      </figcaption>
    </figure>
  );
}

const ACTIVE_RING = 'ring-2 ring-primary ring-offset-2 ring-offset-background';
const TILE_PLATE = 'mb-2 aspect-3/2 w-full transition-opacity duration-150 group-hover:opacity-90';

function ScenicRouteTile({
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
  const posters = postersFor(info.route.id);
  const hasWorld = worldForRoute(info.route) !== null;
  const weatherText =
    hasWorld && weather?.status === 'ready' ? `, now ${cardWeatherText(weather.weather, units)}` : '';
  const plateClass = cn(TILE_PLATE, isActive && ACTIVE_RING);
  // The whole tile is the button: one big target from the sofa or the bars.
  return (
    <button
      type="button"
      onClick={() => onRide(info)}
      aria-label={`Ride ${info.name}, ${text}${weatherText}${hasWorld ? '' : ', map view'}`}
      aria-pressed={isActive}
      data-scenic-route={info.route.id}
      className="group flex flex-col gap-1 rounded-lg text-left"
    >
      {posters ? (
        <Plate src={posters.plate} nightSrc={posters.plateNight} alt="" className={plateClass} />
      ) : (
        <MapPlate route={info.route} aspect={3 / 2} className={plateClass} />
      )}
      <h4
        className={cn(
          DISPLAY,
          'text-xl text-foreground decoration-muted-foreground underline-offset-4 group-hover:underline',
        )}
      >
        {info.name}
      </h4>
      <span className="flex flex-wrap items-center gap-2 text-sm">
        <span className="num font-semibold text-foreground">{text}</span>
        {!hasWorld && (
          <span className="inline-flex h-6 items-center gap-1 rounded-pill bg-muted px-2 text-xs font-semibold text-foreground">
            <MapIcon className="h-4 w-4" aria-hidden />
            Map view
          </span>
        )}
      </span>
      {hasWorld ? (
        // Offline is said once, on Today's ride; tiles just omit the line.
        weather?.status !== 'unavailable' && <WeatherLine entry={weather} prefix="Now" />
      ) : (
        <span className="text-sm text-muted-foreground">3D world coming; rides on the map today</span>
      )}
    </button>
  );
}

/** Columns: 1 below sm, 2 at sm, and at lg 2 for two or four routes, else 3. */
function gridCols(count: number): string {
  return cn('grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-2', count !== 2 && count !== 4 && 'lg:grid-cols-3');
}

/** Grid of scenic route tiles. */
export function ScenicRouteGrid({
  routes,
  activeRouteId,
  onRide,
  weatherById,
  className,
}: ScenicPickProps & { routes: ScenicRouteInfo[]; className?: string }) {
  return (
    <div className={cn(gridCols(routes.length), className)}>
      {routes.map((info) => (
        <ScenicRouteTile
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

/** Area heading: serif title, muted detail on the same baseline. */
export function ScenicSectionHeading({ id, title, detail }: { id?: string; title: string; detail: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h3 id={id} className={cn(DISPLAY, 'text-2xl text-foreground')}>
        {title}
      </h3>
      <p className="text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}

/** Loading placeholder with the final tile shape. */
export function ScenicRouteGridSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className={gridCols(count)} aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="aspect-3/2 w-full animate-pulse rounded-lg bg-muted" />
          <div className="h-6 w-2/3 animate-pulse rounded-sm bg-muted" />
          <div className="h-4 w-1/2 animate-pulse rounded-sm bg-muted" />
        </div>
      ))}
    </div>
  );
}
