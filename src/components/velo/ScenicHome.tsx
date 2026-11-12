/**
 * Home's scenic content: Today's ride, then the sections generated from the
 * destination manifests (src/lib/world/destinations/*.json): "Perugia",
 * "Lugano" (labelled "Home · …"/"Hometown · …" in a household build), then
 * "Places we want to go". This file holds no list
 * of places or routes; adding a destination manifest adds its section/tiles.
 * Lazy-loaded by Home so the route geometry stays off the critical path.
 */

import { useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { SCENIC_ROUTES, scenicRouteById, todaysScenicRoute, type ScenicRouteInfo } from '@/lib/scenicRoutes';
import { useRideStore } from '@/stores/rideStore';
import { destinationLabel, homeSections, type DestinationSection } from '@/lib/world/destinations';
import { useShowStore } from '@/stores/showStore';
import { continueLastShow } from '@/lib/show/continueShow';
import { pickVideos } from '@/lib/show/pickVideos';
import { retryRouteWeather, useRoutesWeather } from '@/hooks/useLiveWeather';
import {
  FeaturedScenicRide,
  ScenicRouteGrid,
  ScenicSectionHeading,
  type TilePlace,
} from '@/components/velo/ScenicRoutes';

/** Stable list for the weather hook (module-level, so one identity). */
const ALL_ROUTES = SCENIC_ROUTES.map((r) => r.route);

/** One-tap journey: load the route, ride. */
export function useRideScenic(): (info: ScenicRouteInfo, opts?: { show?: boolean }) => void {
  const navigate = useNavigate();
  return (info, opts) => {
    useRideStore.getState().setRoute(info.route);
    navigate('/ride', { state: { autoStart: true, show: opts?.show === true } });
  };
}

/**
 * Journey + show: carry on with last time's videos (the next episode,
 * re-opened without a picker; Chrome may ask once to allow access again),
 * or pick the videos first (one picker), then ride with them playing.
 * Cancelling the picker stays on Home.
 */
export function useRideWithShow(): (info: ScenicRouteInfo) => void {
  const ride = useRideScenic();
  return (info) => {
    void (async () => {
      const result = await continueLastShow({ ask: true }).catch(() => null);
      if (result?.ok) {
        const { plan } = result;
        useShowStore.getState().loadFiles(plan.files, { startKey: plan.startKey });
        ride(info, { show: true });
        return;
      }
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

export interface HomeSectionView {
  id: string;
  title: string;
  detail: string;
  routes: ScenicRouteInfo[];
  /** Wishlist tiles lead with the place (destination name, then route · region). */
  placeById: Record<string, TilePlace>;
}

/**
 * The manifest-generated sections resolved to scenic routes, without the
 * route featured as Today's ride. Sections left empty are dropped.
 */
export function homeSectionViews(
  todayRouteId: string | null,
  sections: readonly DestinationSection[] = homeSections(),
): HomeSectionView[] {
  return sections
    .map((s) => {
      const routes: ScenicRouteInfo[] = [];
      const placeById: Record<string, TilePlace> = {};
      for (const e of s.entries) {
        if (e.routeId === todayRouteId) continue;
        const info = scenicRouteById(e.routeId);
        if (!info) continue;
        routes.push(info);
        if (s.role === 'wishlist') {
          // "Peschiera to Lazise · Veneto, Italy"; a place's only route named
          // after it ("Berkeley shoreline") would only repeat the title, so just
          // the region. A place with two rides names both, to tell them apart.
          const d = e.destination;
          const alone = s.entries.filter((x) => x.destination === d).length === 1;
          const repeats = alone && info.name.toLowerCase().includes(d.name.toLowerCase());
          placeById[e.routeId] = { title: d.name, line: repeats ? d.place : `${info.name} · ${d.place}` };
        }
      }
      return { id: s.id, title: s.title, detail: s.detail, routes, placeById };
    })
    .filter((s) => s.routes.length > 0);
}

/**
 * Today's ride, then `afterFeatured` (Home's comfort line), then the
 * destination sections.
 */
export function ScenicHomeSections({ afterFeatured }: { afterFeatured?: ReactNode } = {}) {
  const ride = useRideScenic();
  const rideWithShow = useRideWithShow();
  const activeRouteId = useRideStore((s) => s.route?.id ?? null);
  const today = useMemo(() => todaysScenicRoute(), []);
  // One batched Open-Meteo request for every tile on the page.
  const weatherById = useRoutesWeather(ALL_ROUTES);
  // Today's pick is featured above, so its own section skips it.
  const sections = useMemo(() => homeSectionViews(today.route.id), [today]);

  return (
    <>
      <FeaturedScenicRide
        className="mt-6"
        info={today}
        place={destinationLabel(today.route.id)}
        onRide={(info) => ride(info)}
        onRideWithShow={rideWithShow}
        weather={weatherById[today.route.id]}
        onRetryWeather={() => retryRouteWeather(today.route)}
      />
      {afterFeatured}
      {sections.map((s) => (
        <section
          key={s.id}
          className="mt-10 sm:mt-12"
          aria-labelledby={`destination-${s.id}`}
          data-destination-section={s.id}
        >
          <ScenicSectionHeading id={`destination-${s.id}`} title={s.title} detail={s.detail} />
          <ScenicRouteGrid
            className="mt-5"
            routes={s.routes}
            placeById={s.placeById}
            activeRouteId={activeRouteId}
            onRide={(info) => ride(info)}
            weatherById={weatherById}
          />
        </section>
      ))}
    </>
  );
}
