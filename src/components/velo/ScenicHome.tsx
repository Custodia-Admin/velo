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
import {
  FeaturedScenicRide,
  ScenicRouteGrid,
  ScenicSectionHeading,
} from '@/components/velo/ScenicRoutes';

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
  // Today's pick is featured above, so its own section skips it.
  const sections = SCENIC_AREAS.map((area) => ({
    ...area,
    routes: SCENIC_ROUTES.filter((r) => r.area === area.id && r.route.id !== today.route.id),
  })).filter((s) => s.routes.length > 0);

  return (
    <>
      <FeaturedScenicRide info={today} onRide={ride} />
      {sections.map((s) => (
        <section key={s.id} className="flex flex-col gap-4" aria-label={s.title}>
          <ScenicSectionHeading title={s.title} detail={s.detail} />
          <ScenicRouteGrid routes={s.routes} activeRouteId={activeRouteId} onRide={ride} />
        </section>
      ))}
    </>
  );
}

/** Routes-tab / wizard variant: every scenic route, picking just loads it. */
export function ScenicRoutesPanel({ onPicked }: { onPicked?: () => void }) {
  const activeRouteId = useRideStore((s) => s.route?.id ?? null);
  const setRoute = useRideStore((s) => s.setRoute);
  return (
    <ScenicRouteGrid
      routes={SCENIC_ROUTES}
      activeRouteId={activeRouteId}
      onRide={(info) => {
        setRoute(info.route);
        onPicked?.();
      }}
    />
  );
}
