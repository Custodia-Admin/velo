/**
 * Home's scenic content: Today's ride, then one section per area
 * (Near home, Hometown, Further afield, Travels).
 * Lazy-loaded by Home so the route geometry stays off the critical path.
 */

import { useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  SCENIC_AREAS,
  SCENIC_ROUTES,
  todaysScenicRoute,
  type ScenicRouteInfo,
} from '@/lib/scenicRoutes';
import { useRideStore } from '@/stores/rideStore';
import { worldForRoute } from '@/lib/world/catalog';
import { useShowStore } from '@/stores/showStore';
import { pickVideos } from '@/lib/show/pickVideos';
import { retryRouteWeather, useRoutesWeather } from '@/hooks/useLiveWeather';
import {
  FeaturedScenicRide,
  ScenicRouteGrid,
  ScenicSectionHeading,
} from '@/components/velo/ScenicRoutes';

/** Places with a baked 3D world (photographed plates) lead each area; map-view routes follow. */
function withWorldsFirst(routes: ScenicRouteInfo[]): ScenicRouteInfo[] {
  const world = routes.filter((r) => worldForRoute(r.route) !== null);
  return [...world, ...routes.filter((r) => !world.includes(r))];
}

/** Stable list for the weather hook (module-level, so one identity). */
const ALL_ROUTES = SCENIC_ROUTES.map((r) => r.route);

/** One-tap journey: load the route, drop any attached workout, ride. */
export function useRideScenic(): (info: ScenicRouteInfo, opts?: { show?: boolean }) => void {
  const navigate = useNavigate();
  return (info, opts) => {
    const store = useRideStore.getState();
    store.clearWorkout();
    store.setRoute(info.route);
    navigate('/ride', { state: { autoStart: true, show: opts?.show === true } });
  };
}

/**
 * Journey + show: pick the videos first (one picker), then ride with them
 * playing. Cancelling the picker stays on Home.
 */
export function useRideWithShow(): (info: ScenicRouteInfo) => void {
  const ride = useRideScenic();
  return (info) => {
    void (async () => {
      let files: File[] = [];
      try {
        files = await pickVideos();
      } catch {
        files = [];
      }
      if (files.length === 0) return;
      useShowStore.getState().loadFiles(files);
      ride(info, { show: true });
    })();
  };
}

/**
 * Today's ride, then `afterFeatured` (Home's comfort line), then one section
 * per area with routes.
 */
export function ScenicHomeSections({ afterFeatured }: { afterFeatured?: ReactNode } = {}) {
  const ride = useRideScenic();
  const rideWithShow = useRideWithShow();
  const activeRouteId = useRideStore((s) => s.route?.id ?? null);
  const today = useMemo(() => todaysScenicRoute(), []);
  // One batched Open-Meteo request for every tile on the page.
  const weatherById = useRoutesWeather(ALL_ROUTES);
  // Today's pick is featured above, so its own section skips it.
  const sections = SCENIC_AREAS.map((area) => ({
    ...area,
    routes: withWorldsFirst(
      SCENIC_ROUTES.filter((r) => r.area === area.id && r.route.id !== today.route.id),
    ),
  })).filter((s) => s.routes.length > 0);

  return (
    <>
      <FeaturedScenicRide
        className="mt-6"
        info={today}
        onRide={(info) => ride(info)}
        onRideWithShow={rideWithShow}
        weather={weatherById[today.route.id]}
        onRetryWeather={() => retryRouteWeather(today.route)}
      />
      {afterFeatured}
      {sections.map((s) => (
        <section key={s.id} className="mt-10 sm:mt-12" aria-labelledby={`area-${s.id}`}>
          <ScenicSectionHeading id={`area-${s.id}`} title={s.title} detail={s.detail} />
          <ScenicRouteGrid
            className="mt-5"
            routes={s.routes}
            activeRouteId={activeRouteId}
            onRide={(info) => ride(info)}
            weatherById={weatherById}
          />
        </section>
      ))}
    </>
  );
}

/** Routes-tab / wizard variant: every scenic route, picking just loads it. */
export function ScenicRoutesPanel({ onPicked }: { onPicked?: () => void }) {
  const activeRouteId = useRideStore((s) => s.route?.id ?? null);
  const setRoute = useRideStore((s) => s.setRoute);
  const weatherById = useRoutesWeather(ALL_ROUTES);
  return (
    <ScenicRouteGrid
      routes={SCENIC_ROUTES}
      activeRouteId={activeRouteId}
      weatherById={weatherById}
      onRide={(info) => {
        setRoute(info.route);
        onPicked?.();
      }}
    />
  );
}
