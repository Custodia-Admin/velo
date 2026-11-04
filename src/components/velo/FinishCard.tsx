/**
 * Velo v2 finish screen (docs/design/mockups/v2-finish.html): its own
 * full-screen paper page over the finished ride. Nothing of the ride HUD or
 * the 3D scene shows through it.
 *
 * Built to fit the viewport with no page scroll at every gate viewport,
 * 1280×648 @2 (the owner's laptop) included: the page is a flex column of
 * the viewport's height, the summary keeps its natural height, and the plate
 * of where the ride ended takes whatever is left (never taller than 21:9).
 *
 * Hierarchy: the place name; distance, time and average power as the three
 * big figures; climbed, average speed, NP, IF and TSS as one quiet line
 * (power figures only when the ride had power); then the profile. Actions sit
 * inline with the figures: Save .FIT, Ride again, and Home (the one filled
 * button).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Download, Home, Image, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Figure } from '@/components/velo/Figure';
import { MapPlate } from '@/components/velo/MapPlate';
import { Plate } from '@/components/velo/Plate';
import { RouteProfile } from '@/components/velo/RouteProfile';
import { COLUMN, DISPLAY, KICKER, PAGE_X, WORDMARK } from '@/components/velo/v2';
import { useRideExport } from '@/hooks/useRideExport';
import { computeMetrics } from '@/lib/metrics';
import { computeAscentM, listRides } from '@/lib/rideHistory';
import { SCENIC_ROUTES, todaysScenicRoute, type ScenicRouteInfo } from '@/lib/scenicRoutes';
import { cn, formatDuration } from '@/lib/utils';
import { postersFor } from '@/lib/world/posters';
import { usePlayStore } from '@/stores/playStore';
import { useRideStore } from '@/stores/rideStore';
import { selectActiveRider, useRiderRosterStore } from '@/stores/riderRosterStore';
import { useSettingsStore, type UnitSystem } from '@/stores/settingsStore';
import type { TelemetrySample } from '@/types';

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

/** What the finish screen shows about power. `null` when the ride recorded none. */
export interface PowerSummary {
  avgW: number;
  npW: number;
  /** Intensity factor; null without an FTP. */
  if: number | null;
  /** Training stress score; null without an FTP. */
  tss: number | null;
}

export function powerSummary(samples: TelemetrySample[], ftpW: number): PowerSummary | null {
  const m = computeMetrics(samples, ftpW);
  if (!(m.avgPowerW > 0)) return null;
  const hasFtp = ftpW > 0;
  return {
    avgW: Math.round(m.avgPowerW),
    npW: Math.round(m.normalizedPowerW),
    if: hasFtp ? Math.round(m.intensityFactor * 100) / 100 : null,
    tss: hasFtp ? Math.round(m.tss) : null,
  };
}

/** The quiet line under the big figures, in reading order. */
export function secondaryStats(
  climbed: { value: string; unit: string },
  average: { value: string; unit: string },
  power: PowerSummary | null,
): { label: string; value: string }[] {
  const out = [
    { label: 'Climbed', value: `${climbed.value} ${climbed.unit}` },
    { label: 'Avg speed', value: `${average.value} ${average.unit}` },
  ];
  if (power) {
    // A steady ride's NP equals its average power: saying 190 W twice reads as a bug.
    if (power.npW !== power.avgW) out.push({ label: 'NP', value: `${power.npW} W` });
    if (power.if !== null) out.push({ label: 'IF', value: power.if.toFixed(2) });
    if (power.tss !== null) out.push({ label: 'TSS', value: String(power.tss) });
  }
  return out;
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

/**
 * Ride the same route again from the start, without leaving /ride: reset the
 * finished ride (back to 'ready' on the same route) and start it.
 */
export function rideAgain(): void {
  const store = useRideStore.getState();
  if (!store.route) return;
  store.reset();
  useRideStore.getState().start();
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
  const ftpW = useSettingsStore((s) => s.ftpW);
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
  const power = useMemo(() => powerSummary(samples, ftpW), [samples, ftpW]);
  const next = useMemo(() => nextScenicRoute(route?.id, new Date()), [route?.id]);
  const posters = postersFor(route?.id);

  const seconds = elapsedMs / 1000;
  const dist = distanceFigure(distance, units);
  const time = formatDuration(seconds);
  const secondary = secondaryStats(climbedFigure(ascentM, units), averageFigure(distance, seconds, units), power);

  const rideNext = (info: ScenicRouteInfo) => {
    const store = useRideStore.getState();
    store.clearWorkout();
    store.setRoute(info.route);
    navigate('/app');
  };

  // The plate is a flex item that keeps 4:3 (phones) / 21:9 and shrinks, down
  // to h-32, when the viewport is short: the summary below never moves off
  // screen. A taller viewport leaves the slack under the summary.
  const plateClass = 'mt-2 aspect-4/3 min-h-32 w-full sm:aspect-21/9';

  const page = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
      data-testid="finish-screen"
      className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-background text-foreground"
    >
      <header className={cn(PAGE_X, 'shrink-0')}>
        <div className={cn(COLUMN, 'flex h-16 items-center justify-between gap-4')}>
          <span className={WORDMARK}>Velo</span>
          <span className="text-sm text-muted-foreground">{riderName}</span>
        </div>
      </header>

      <main className={cn(PAGE_X, 'flex min-h-0 flex-1 flex-col pb-4 sm:pb-6')}>
        <div className={cn(COLUMN, 'flex min-h-0 flex-1 flex-col')}>
          {posters ? (
            <Plate
              src={posters.finish}
              portraitSrc={posters.finishPortrait}
              alt={posters.alt}
              priority
              className={plateClass}
            />
          ) : route ? (
            <>
              <MapPlate route={route} aspect={4 / 3} className={cn(plateClass, 'sm:hidden')} />
              <MapPlate route={route} aspect={21 / 9} className={cn(plateClass, 'hidden sm:block')} />
            </>
          ) : null}

          {/* One wrapping flex box, so the order can differ by width: on
              phones the ride data stays together (figures, quiet line,
              profile) and the actions follow; from lg the actions sit beside
              the figures and the profile spans the column under both. */}
          <section
            aria-labelledby={TITLE_ID}
            className="mt-4 flex shrink-0 flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end lg:gap-x-10"
          >
            <div className="order-1 min-w-0 lg:flex-1">
              <span className={cn(KICKER, 'block leading-6')}>
                {saved ? 'Ride finished · saved on this device' : 'Ride finished'}
              </span>
              <h1
                id={TITLE_ID}
                ref={titleRef}
                tabIndex={-1}
                className={cn(DISPLAY, 'mt-1 text-3xl focus:outline-none sm:text-4xl')}
              >
                {route?.name ?? 'Your ride'}
              </h1>
              <div className="mt-3 grid grid-cols-3 gap-4 sm:flex sm:gap-10" data-testid="finish-figures">
                <Figure
                  value={dist.value}
                  unit={dist.unit}
                  label="Distance"
                  ariaLabel={`Distance: ${dist.value} ${dist.unit}`}
                />
                <Figure value={time} label="Time" ariaLabel={`Time: ${time}`} />
                {power ? (
                  <Figure
                    value={String(power.avgW)}
                    unit="W"
                    label="Avg power"
                    ariaLabel={`Average power: ${power.avgW} W`}
                  />
                ) : (
                  <Figure value="–" label="Avg power" ariaLabel="Average power: none recorded" />
                )}
              </div>
              <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm" data-testid="finish-secondary">
                {secondary.map((s) => (
                  <div key={s.label} className="flex items-baseline gap-1.5">
                    <dt className="text-muted-foreground">{s.label}</dt>
                    <dd className="num font-semibold">{s.value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div
              className="order-3 grid shrink-0 grid-cols-2 gap-3 sm:flex sm:flex-wrap lg:order-2 lg:justify-end"
              data-testid="finish-actions"
            >
              <Button
                variant="outline"
                size="lg"
                className="text-base"
                onClick={exp.downloadFit}
                disabled={!exp.canExport}
              >
                <Download className="h-5 w-5" aria-hidden="true" />
                Save .FIT
              </Button>
              <Button variant="outline" size="lg" className="text-base" onClick={rideAgain} disabled={!route}>
                <RotateCcw className="h-5 w-5" aria-hidden="true" />
                Ride again
              </Button>
              <Button variant="primary" size="lg" className="col-span-2 text-base" onClick={() => navigate('/app')}>
                <Home className="h-5 w-5" aria-hidden="true" />
                Home
              </Button>
            </div>

            {route && (
              <div className="order-2 lg:order-3 lg:basis-full">
                <RouteProfile route={route} at={1} className="h-10" />
              </div>
            )}

            <div className="order-4 mt-1 flex flex-wrap items-center justify-between gap-x-4 border-t border-border pt-2 text-sm lg:basis-full">
              {postcardsTotal > 0 ? (
                <span className="flex items-center gap-2">
                  <Image className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {postcardsFound} of {postcardsTotal} postcards found
                </span>
              ) : (
                <span aria-hidden="true" />
              )}
              {next && (
                <span className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                  Tomorrow, maybe:
                  <Button variant="textlink" className="px-0" onClick={() => rideNext(next)}>
                    {next.name} · {distanceFigure(next.route.totalDistance, units).value}{' '}
                    {distanceFigure(next.route.totalDistance, units).unit} · {next.character}
                  </Button>
                </span>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );

  // Portal to body: a fixed z-50 page inside the ride tree can paint under
  // later same-z HUD siblings.
  return typeof document === 'undefined' ? page : createPortal(page, document.body);
}
