/**
 * Home's scenic content: Today's ride, Near home, Further afield.
 * Lazy-loaded by Home so the route geometry stays off the critical path.
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { SCENIC_ROUTES, todaysScenicRoute, type ScenicRouteInfo } from '@/lib/scenicRoutes';
import { useRideStore } from '@/stores/rideStore';
import { useShowStore } from '@/stores/showStore';
import { pickVideos } from '@/lib/show/pickVideos';
import {
  FeaturedScenicRide,
  ScenicRouteGrid,
  ScenicSectionHeading,
} from '@/components/velo/ScenicRoutes';

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

export function ScenicHomeSections() {
  const ride = useRideScenic();
  const rideWithShow = useRideWithShow();
  const activeRouteId = useRideStore((s) => s.route?.id ?? null);
  const today = useMemo(() => todaysScenicRoute(), []);
  const near = SCENIC_ROUTES.filter((r) => r.area === 'near-home' && r.route.id !== today.route.id);
  const further = SCENIC_ROUTES.filter((r) => r.area === 'further');

  return (
    <>
      <FeaturedScenicRide info={today} onRide={(info) => ride(info)} onRideWithShow={rideWithShow} />
      <section className="flex flex-col gap-4" aria-label="Near home">
        <ScenicSectionHeading title="Near home" detail="Ticino and Lombardy" />
        <ScenicRouteGrid routes={near} activeRouteId={activeRouteId} onRide={(info) => ride(info)} />
      </section>
      <section className="flex flex-col gap-4" aria-label="Further afield">
        <ScenicSectionHeading title="Further afield" detail="Alpine lakes and the Riviera" />
        <ScenicRouteGrid routes={further} activeRouteId={activeRouteId} onRide={(info) => ride(info)} />
      </section>
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
