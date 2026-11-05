/**
 * Show mode's ride strip (docs/design/mockups/v2-show.html): time, distance
 * and grade, the next landmark when the route has one, and one Pause button.
 * Replaces the full HUD while a video plays. Bottom-right from sm; full width
 * (two rows) on phones.
 *
 * The numbers come from `useShowRideNumbers`, shared with the floating ride
 * window's JourneyBar. Quantised reads (whole seconds, 5 m, 0.1 %) keep
 * re-renders at display rate.
 */

import { Pause, Play, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn, formatDistance, formatDuration } from '@/lib/utils';
import { useNextLandmark } from '@/hooks/useRouteLandmarks';
import { quantizedMeters } from '@/lib/hudThrottle';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { Figure } from './Figure';
import { NextLandmark } from './NextLandmark';
import type { NextLandmarkParts } from './rideHudText';
import { HUD_PANEL } from './v2';

const M_PER_MI = 1609.344;

export interface ShowRideNumbers {
  time: string;
  distanceValue: string;
  distanceUnit: string;
  distanceAria: string;
  gradeText: string;
  /** "Rivotorto" + "in 900 m", or null when nothing named is ahead. */
  next: NextLandmarkParts | null;
  /** Share of the route ridden, 0..1 (0 on live/outdoor routes). */
  progress: number;
  action: { label: string; icon: LucideIcon; run: () => void } | null;
}

export function useShowRideNumbers(): ShowRideNumbers {
  const elapsedS = useRideStore((s) => Math.floor(s.elapsedMs / 1000));
  const distance = useRideStore((s) => quantizedMeters(s.distance, 5));
  const grade = useRideStore((s) => Math.round(s.grade * 10) / 10);
  const route = useRideStore((s) => s.route);
  const rideState = useRideStore((s) => s.rideState);
  const start = useRideStore((s) => s.start);
  const pause = useRideStore((s) => s.pause);
  const resume = useRideStore((s) => s.resume);
  const units = useSettingsStore((s) => s.units);
  const imperial = units === 'imperial';

  const next = useNextLandmark(route, distance, units);

  const total = route && !route.isLive ? route.totalDistance : 0;
  const fmt = (m: number) => (imperial ? `${(m / M_PER_MI).toFixed(2)} mi` : formatDistance(m));
  const time = formatDuration(elapsedS);

  const action =
    rideState === 'running'
      ? { label: 'Pause ride', icon: Pause, run: pause }
      : rideState === 'paused'
        ? { label: 'Resume ride', icon: Play, run: resume }
        : rideState === 'ready'
          ? { label: 'Start ride', icon: Play, run: start }
          : null;

  return {
    time,
    distanceValue: (distance / (imperial ? M_PER_MI : 1000)).toFixed(1),
    distanceUnit: imperial ? 'mi' : 'km',
    distanceAria: total > 0 ? `${fmt(distance)} of ${fmt(total)}` : `Distance: ${fmt(distance)}`,
    gradeText: (Number.isFinite(grade) ? grade : 0).toFixed(1),
    next,
    progress: total > 0 ? Math.min(1, Math.max(0, distance / total)) : 0,
    action,
  };
}

export function ShowRideStrip({ dimmed, className }: { dimmed: boolean; className?: string }) {
  return <ShowRideStripView numbers={useShowRideNumbers()} dimmed={dimmed} className={className} />;
}

/** The strip for a set of numbers (what ShowRideStrip renders; tests call it directly). */
export function ShowRideStripView({
  numbers: n,
  dimmed,
  className,
}: {
  numbers: ShowRideNumbers;
  dimmed: boolean;
  className?: string;
}) {
  const { next, action } = n;

  return (
    <section
      aria-label="Ride numbers"
      data-testid="show-ride-strip"
      className={cn(
        HUD_PANEL,
        'pointer-events-auto flex flex-col gap-2 p-3 transition-opacity duration-300 sm:flex-row sm:items-center sm:gap-6 sm:py-3 sm:pl-5 sm:pr-3',
        dimmed && 'opacity-70',
        className,
      )}
    >
      <div className="flex justify-between gap-3 sm:justify-start sm:gap-6">
        <Figure value={n.time} label="Time" ariaLabel={`Time: ${n.time}`} />
        <Figure value={n.distanceValue} unit={n.distanceUnit} label="Distance" ariaLabel={n.distanceAria} />
        <Figure value={n.gradeText} unit="%" label="Grade" ariaLabel={`Grade: ${n.gradeText} %`} />
      </div>
      {(next || action) && (
        <div className="flex items-center justify-between gap-3">
          {next ? (
            <NextLandmark next={next} testId="show-next" className="flex min-w-0 max-w-56" />
          ) : (
            <span aria-hidden="true" />
          )}
          {action && (
            <Button variant="hud" size="lg" className="w-12 px-0" aria-label={action.label} onClick={action.run}>
              <action.icon className="h-5 w-5" aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
