/**
 * Velo v2 finish page (docs/design/mockups/v2-finish.html): a full-screen
 * paper page over the finished ride. A photo plate of where the ride ended
 * (map plate for routes without a baked world), the place name, four plain
 * figures, the full profile, and Back to Home as the only filled button.
 * No scores, PRs or training load (v2-identity §5).
 *
 * This page owns the Strava auto-upload for a finished ride (useRideExport
 * autoUpload); nothing else that is mounted then may opt in.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Download, Image, Loader2, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Figure } from '@/components/velo/Figure';
import { MapPlate } from '@/components/velo/MapPlate';
import { Plate } from '@/components/velo/Plate';
import { RouteProfile } from '@/components/velo/RouteProfile';
import { COLUMN, DISPLAY, KICKER, PAGE_X, WORDMARK } from '@/components/velo/v2';
import { useRideExport, type RideExport } from '@/hooks/useRideExport';
import { computeAscentM, listRides } from '@/lib/rideHistory';
import { SCENIC_ROUTES, todaysScenicRoute, type ScenicRouteInfo } from '@/lib/scenicRoutes';
import type { StravaErrorKind } from '@/lib/strava';
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

/** A plain sentence for each upload failure. */
export function stravaErrorSentence(kind: StravaErrorKind | undefined): string {
  switch (kind) {
    case 'creds_missing':      return "Strava isn't connected on this device yet. Connect it in Settings → Data.";
    case 'refresh_failed':     return 'Strava turned down the saved sign-in. Sign in again in Settings → Data.';
    case 'insufficient_scope': return 'Strava needs permission to add rides.';
    case 'duplicate_activity': return 'Strava already has this ride.';
    case 'processing_error':   return "Strava couldn't read the ride file.";
    case 'network_error':      return "Couldn't reach Strava. Check the connection.";
    case 'rate_limited':       return 'Strava is busy. Wait a few minutes.';
    case 'timeout':            return 'Strava is taking a long time to process the ride.';
    default:                   return "The ride didn't reach Strava.";
  }
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

  const exp = useRideExport({ autoUpload: true });
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
                <StravaButton exp={exp} />
                <Button variant="primary" size="lg" className="w-full text-base sm:w-auto" onClick={() => navigate('/app')}>
                  Back to Home
                </Button>
              </div>
            </div>

            <StravaStatus exp={exp} />

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

          <footer className="pb-10 pt-6 text-xs leading-6 text-muted-foreground">
            Velo is a fork of GlobeRide (MIT) by Mason Wyatt.
          </footer>
        </div>
      </main>
    </div>
  );

  // Portal to body: a fixed z-50 page inside the ride tree can paint under
  // later same-z HUD siblings.
  return typeof document === 'undefined' ? page : createPortal(page, document.body);
}

/**
 * Send to Strava. Upload/processing show a spinner; success becomes a link
 * to the activity. Without Strava set up the button still answers honestly:
 * pressing it reports "Strava isn't connected on this device yet" (the
 * upload fails before any network call) instead of a dead disabled button.
 */
function StravaButton({ exp }: { exp: RideExport }) {
  const { uploadState, isUploading } = exp;
  if (uploadState.phase === 'success' && uploadState.activityId) {
    return (
      <Button variant="outline" size="lg" className="w-full text-base sm:w-auto" asChild>
        <a
          href={`https://www.strava.com/activities/${uploadState.activityId}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View on Strava (opens in a new tab)"
        >
          <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
          View on Strava
        </a>
      </Button>
    );
  }
  return (
    <Button
      variant="outline"
      size="lg"
      className="w-full text-base sm:w-auto"
      onClick={() => void exp.uploadToStrava()}
      disabled={!exp.canExport || isUploading}
      aria-busy={isUploading || undefined}
    >
      {isUploading ? (
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
      ) : (
        <Upload className="h-5 w-5" aria-hidden="true" />
      )}
      {uploadState.phase === 'uploading'
        ? 'Sending to Strava…'
        : uploadState.phase === 'polling'
          ? 'Strava is processing…'
          : 'Send to Strava'}
    </Button>
  );
}

/**
 * Live status line: a plain sentence and the one action that fixes it.
 * Settings errors carry actionUrl '#settings-strava', which nothing in the
 * app handles yet, so the sentence names the place instead of a dead link.
 */
function StravaStatus({ exp }: { exp: RideExport }) {
  const { uploadState } = exp;
  let body: React.ReactNode = null;
  if (uploadState.phase === 'success') {
    body = 'Sent to Strava.';
  } else if (uploadState.phase === 'error') {
    const kind = uploadState.errorKind;
    body = (
      <>
        <span>{stravaErrorSentence(kind)}</span>
        {kind === 'insufficient_scope' ? (
          <Button variant="textlink" className="px-2" onClick={exp.reauthorizeStrava}>
            Give Strava permission
          </Button>
        ) : uploadState.actionUrl || kind === 'duplicate_activity' ? null : (
          <Button variant="textlink" className="px-2" onClick={() => void exp.uploadToStrava()}>
            Try again
          </Button>
        )}
      </>
    );
  }
  return (
    <p
      role="status"
      aria-live="polite"
      className={cn('flex flex-wrap items-center gap-2 text-sm', body ? 'lg:justify-end' : 'sr-only')}
    >
      {body}
    </p>
  );
}
