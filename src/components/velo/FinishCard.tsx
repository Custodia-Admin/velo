/**
 * Velo v2 finish page (docs/design/mockups/v2-finish.html): a full-screen
 * paper page over the finished ride. A photo plate of where the ride ended
 * (map plate for routes without a baked world), the place name, four plain
 * figures, the full profile, and Back to Home as the only filled button.
 * No scores, PRs or training load (v2-identity §5).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Download, Image } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Figure } from '@/components/velo/Figure';
import { MapPlate } from '@/components/velo/MapPlate';
import { Plate } from '@/components/velo/Plate';
import { RouteProfile } from '@/components/velo/RouteProfile';
import { COLUMN, DISPLAY, KICKER, PAGE_X, WORDMARK } from '@/components/velo/v2';
import { useRideExport } from '@/hooks/useRideExport';
import { computeAscentM, listRides } from '@/lib/rideHistory';
import { SCENIC_ROUTES, todaysScenicRoute, type ScenicRouteInfo } from '@/lib/scenicRoutes';
import { cn, formatDuration } from '@/lib/utils';
import { postersFor } from '@/lib/world/posters';
import { usePlayStore } from '@/stores/playStore';
import { useRideStore } from '@/stores/rideStore';
import { selectActiveRider, useRiderRosterStore } from '@/stores/riderRosterStore';
import { useSettingsStore, type UnitSystem } from '@/stores/settingsStore';

const TITLE_ID = 'finish-title';

/** Distance as a figure value + unit. */
export function distanceFigure(meters: number, units: UnitSystem): { value: string; unit: string } {
  return units === 'imperial'
    ? { value: (meters / 1609.344).toFixed(1), unit: 'mi' }
    : { value: (meters / 1000).toFixed(1), unit: 'km' };
}

/** Average speed over the whole ride (distance / elapsed time). */
export function averageFigure(meters: number, seconds: number, units: UnitSystem): { value: string; unit: string } {
  const mps = seconds > 0 ? meters / seconds : 0;
  return units === 'imperial'
    ? { value: (mps * 2.236936).toFixed(1), unit: 'mph' }
    : { value: (mps * 3.6).toFixed(1), unit: 'km/h' };
}

/** Elevation gained, from the ride's own samples. */
export function climbedFigure(ascentM: number, units: UnitSystem): { value: string; unit: string } {
  return units === 'imperial'
    ? { value: String(Math.round(ascentM * 3.28084)), unit: 'ft' }
    : { value: String(Math.round(ascentM)), unit: 'm' };
}

/**
 * "Tomorrow, maybe": the near-home route after this one in catalogue order
 * (never the route just ridden). Rides away from home get tomorrow's
 * featured near-home route instead.
 */
export function nextScenicRoute(currentId: string | undefined, now: Date): ScenicRouteInfo | null {
  const near = SCENIC_ROUTES.filter((r) => r.area === 'near-home');
  const pool = near.length > 1 ? near : SCENIC_ROUTES;
  if (pool.length < 2) return null;
  const at = pool.findIndex((r) => r.route.id === currentId);
  if (at >= 0) return pool[(at + 1) % pool.length];
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12);
  const pick = todaysScenicRoute(tomorrow);
  return pick.route.id === currentId ? pool[(pool.indexOf(pick) + 1) % pool.length] : pick;
}

/** Polls ride history (the recorder saves asynchronously) for this ride. */
function useSavedOnDevice(startedAt: number | null): boolean {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!startedAt) return;
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      listRides()
        .then((rides) => {
          if (cancelled) return;
          if (rides.some((r) => r.startedAt === startedAt)) setSaved(true);
          else if (++tries < 6) timer = setTimeout(check, 500);
        })
        .catch(() => {});
    };
    check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [startedAt]);
  return saved;
}

export function FinishCard() {
  const navigate = useNavigate();
  const route = useRideStore((s) => s.route);
  const distance = useRideStore((s) => s.distance);
  const elapsedMs = useRideStore((s) => s.elapsedMs);
  const samples = useRideStore((s) => s.samples);
  const startedAt = useRideStore((s) => s.startedAt);
  const units = useSettingsStore((s) => s.units);
  const riderName = useRiderRosterStore((s) => selectActiveRider(s).name);
  const postcardsTotal = usePlayStore((s) => s.total);
  const postcardsFound = usePlayStore((s) => s.collected);

  const exp = useRideExport();
  const saved = useSavedOnDevice(startedAt);

  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  const ascentM = useMemo(() => computeAscentM(samples), [samples]);
  const next = useMemo(() => nextScenicRoute(route?.id, new Date()), [route?.id]);
  const posters = postersFor(route?.id);

  const seconds = elapsedMs / 1000;
  const dist = distanceFigure(distance, units);
  const climbed = climbedFigure(ascentM, units);
  const avg = averageFigure(distance, seconds, units);
  const time = formatDuration(seconds);

  const rideNext = (info: ScenicRouteInfo) => {
    const store = useRideStore.getState();
    store.clearWorkout();
    store.setRoute(info.route);
    navigate('/app');
  };

  const page = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
      className="fixed inset-0 z-50 overflow-y-auto bg-background text-foreground"
    >
      <header className={PAGE_X}>
        <div className={cn(COLUMN, 'flex h-16 items-center justify-between gap-4')}>
          <span className={WORDMARK}>Velo</span>
          <span className="text-sm text-muted-foreground">{riderName}</span>
        </div>
      </header>

      <main className={PAGE_X}>
        <div className={COLUMN}>
          {posters ? (
            <Plate
              src={posters.finish}
              portraitSrc={posters.finishPortrait}
              alt={posters.alt}
              priority
              className="mt-2 aspect-4/3 w-full sm:aspect-21/9 sm:max-h-finish-fit"
            />
          ) : route ? (
            <>
              <MapPlate route={route} aspect={4 / 3} className="mt-2 aspect-4/3 w-full sm:hidden" />
              <MapPlate
                route={route}
                aspect={21 / 9}
                className="mt-2 hidden aspect-21/9 max-h-finish-fit w-full sm:block"
              />
            </>
          ) : null}

          <section aria-labelledby={TITLE_ID} className="mt-6 flex flex-col gap-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:gap-10">
              <div className="min-w-0 lg:flex-1">
                <span className={cn(KICKER, 'block leading-6')}>
                  {saved ? 'Ride finished · saved on this device' : 'Ride finished'}
                </span>
                <h1
                  id={TITLE_ID}
                  ref={titleRef}
                  tabIndex={-1}
                  className={cn(DISPLAY, 'mt-1.5 text-3xl focus:outline-none sm:text-4xl')}
                >
                  {route?.name ?? 'Your ride'}
                </h1>
                <div className="mt-4 grid grid-cols-2 gap-4 sm:flex sm:gap-10">
                  <Figure
                    value={dist.value}
                    unit={dist.unit}
                    label="Distance"
                    ariaLabel={`Distance: ${dist.value} ${dist.unit}`}
                  />
                  <Figure value={time} label="Time" ariaLabel={`Time: ${time}`} />
                  <Figure
                    value={climbed.value}
                    unit={climbed.unit}
                    label="Climbed"
                    ariaLabel={`Climbed: ${climbed.value} ${climbed.unit}`}
                  />
                  <Figure
                    value={avg.value}
                    unit={avg.unit}
                    label="Average"
                    ariaLabel={`Average: ${avg.value} ${avg.unit}`}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap lg:shrink-0 lg:justify-end">
                <Button
                  variant="outline"
                  size="lg"
                  className="w-full text-base sm:w-auto"
                  onClick={exp.downloadFit}
                  disabled={!exp.canExport}
                >
                  <Download className="h-5 w-5" aria-hidden="true" />
                  Download FIT
                </Button>
                <Button variant="primary" size="lg" className="w-full text-base sm:w-auto" onClick={() => navigate('/app')}>
                  Back to Home
                </Button>
              </div>
            </div>

            {route && (
              <div className="mt-2">
                <RouteProfile route={route} at={1} className="h-10" />
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-3 text-sm">
              {postcardsTotal > 0 ? (
                <span className="flex items-center gap-2">
                  <Image className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {postcardsFound} of {postcardsTotal} postcards found
                </span>
              ) : (
                <span aria-hidden="true" />
              )}
              {next && (
                <span className="flex items-center gap-2 text-muted-foreground">
                  Tomorrow, maybe:
                  <Button variant="textlink" className="px-2" onClick={() => rideNext(next)}>
                    {next.name} · {distanceFigure(next.route.totalDistance, units).value}{' '}
                    {distanceFigure(next.route.totalDistance, units).unit} · {next.character}
                  </Button>
                </span>
              )}
            </div>
          </section>

          <div className="pb-10" />
        </div>
      </main>
    </div>
  );

  // Portal to body: a fixed z-50 page inside the ride tree can paint under
  // later same-z HUD siblings.
  return typeof document === 'undefined' ? page : createPortal(page, document.body);
}
