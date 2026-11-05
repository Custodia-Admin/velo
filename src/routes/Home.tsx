import { useEffect, Suspense, lazy } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { RideSetupWizard } from '@/components/setup/RideSetupWizard';
import { useRideStore } from '@/stores/rideStore';
import { ComfortControls, RiderSwitch } from '@/components/velo/RiderPanel';
import { HomeHeader } from '@/components/velo/HomeHeader';
import { COLUMN, DISPLAY, PAGE_X } from '@/components/velo/v2';
import { cn } from '@/lib/utils';
import { ScenicRouteGridSkeleton } from '@/components/velo/ScenicRoutes';
// Lazy: scenic route geometry (~30 kB) stays off the critical path.
const ScenicHomeSections = lazy(() => import('@/components/velo/ScenicHome').then(m => ({ default: m.ScenicHomeSections })));

/**
 * Velo home (v2 "warm atlas", docs/design/mockups/v2-home.html): who's
 * riding, the scenic route library with today's featured ride, the comfort
 * controls, and "Build your own ride" (search a place, upload a GPX, pace
 * partners) folded away at the foot.
 */
export function Home() {
  const navigate = useNavigate();
  const location = useLocation();

  /** Picks an easy scenic route if none is loaded, then rides it. The scenic
   *  catalog is loaded on demand so it stays off the critical bundle path. */
  const handleStartRide = async () => {
    const store = useRideStore.getState();
    if (!store.route && store.rideMode !== 'outdoor') {
      const { randomScenicRoute } = await import('@/lib/scenicRoutes');
      store.setRoute(randomScenicRoute().route);
    }
    navigate('/ride', { state: { autoStart: true } });
  };

  // ?demo=1 deep link: ride a random scenic route in demo mode at once.
  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    if (sp.get('demo') !== '1') return;
    const url = new URL(window.location.href);
    url.searchParams.delete('demo');
    window.history.replaceState({}, '', url.toString());
    useRideStore.getState().setMode('demo');
    void handleStartRide();
    // handleStartRide intentionally uses latest store state and navigate only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  return (
    <div className="relative min-h-full w-full overflow-x-hidden">
      <HomeHeader />
      <main className={PAGE_X}>
        <div className={COLUMN}>
          <div className="flex flex-wrap items-end justify-between gap-4 pt-4 sm:gap-6 sm:pt-6">
            <h1 id="home-title" className={cn(DISPLAY, 'text-2xl text-foreground sm:text-3xl')}>
              Where to today?
            </h1>
            <RiderSwitch />
          </div>

          <Suspense fallback={<div className="mt-6"><ScenicRouteGridSkeleton /></div>}>
            <ScenicHomeSections afterFeatured={<ComfortControls className="mt-5" />} />
          </Suspense>

          <details className="group mt-12 border-t border-border pt-2" data-build-your-own>
            <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center gap-x-2 rounded-md px-2 text-base font-semibold text-foreground select-none hover:bg-muted/60">
              <span aria-hidden className="inline-block transition-transform duration-150 group-open:rotate-90">›</span>
              Build your own ride
              <span className="text-sm font-normal text-muted-foreground">search a place, upload a GPX, add pace partners</span>
            </summary>
            <div className="pt-4">
              <RideSetupWizard />
            </div>
          </details>

          <footer className="pb-10 pt-6 text-xs text-muted-foreground">
            World stills rendered from the Perugia world bake; map data © OpenStreetMap contributors.
          </footer>
        </div>
      </main>
    </div>
  );
}
