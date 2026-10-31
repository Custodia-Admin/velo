/**
 * Home's scenic content: Today's ride, then one section per area
 * (Near home, Hometown, Further afield, Travels).
 * Lazy-loaded by Home so the route geometry stays off the critical path.
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  SCENIC_AREAS,
  SCENIC_ROUTES,
  todaysScenicRoute,
  type ScenicRouteInfo,
} from '@/lib/scenicRoutes';
import { useRideStore } from '@/stores/rideStore';
import { retryRouteWeather, useRoutesWeather } from '@/hooks/useLiveWeather';
import {
  FeaturedScenicRide,
  ScenicRouteGrid,
  ScenicSectionHeading,
} from '@/components/velo/ScenicRoutes';

/** Stable list for the weather hook (module-level, so one identity). */
const ALL_ROUTES = SCENIC_ROUTES.map((r) => r.route);

/** One-tap journey: load the route, drop any attached workout, ride. */
export function useRideScenic(): (info: ScenicRouteInfo) => void {
  const navigate = useNavigate();
  return (info) => {
    const store = useRideStore.getState();
    store.clearWorkout();
    store.setRoute(info.route);
    navigate('/ride', { state: { autoStart: true } });
  };
}

export function ScenicHomeSections() {
  const ride = useRideScenic();
  const activeRouteId = useRideStore((s) => s.route?.id ?? null);
  const today = useMemo(() => todaysScenicRoute(), []);
  // One batched Open-Meteo request for every card on the page.
  const weatherById = useRoutesWeather(ALL_ROUTES);
  // Today's pick is featured above, so its own section skips it.
  const sections = SCENIC_AREAS.map((area) => ({
    ...area,
    routes: SCENIC_ROUTES.filter((r) => r.area === area.id && r.route.id !== today.route.id),
  })).filter((s) => s.routes.length > 0);

  return (
    <>
      <FeaturedScenicRide
        info={today}
        onRide={ride}
        weather={weatherById[today.route.id]}
        onRetryWeather={() => retryRouteWeather(today.route)}
      />
      {sections.map((s) => (
        <section key={s.id} className="flex flex-col gap-4" aria-label={s.title}>
          <ScenicSectionHeading title={s.title} detail={s.detail} />
          <ScenicRouteGrid routes={s.routes} activeRouteId={activeRouteId} onRide={ride} weatherById={weatherById} />
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
