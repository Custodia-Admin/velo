/**
 * v2 ride strip (docs/design/mockups/v2-ride-hud.html): one solid HUD panel,
 * centred at the bottom. Speed, time and distance are the big figures; grade,
 * power and the virtual gear are minor; cadence and heart rate join only when
 * a sensor delivers them. The transport (Pause / Resume / Start + Finish)
 * sits after a hairline. Below sm the strip spans the screen: big figures in
 * a row, then a compact "1.2 % · 142 W · gear 6" line beside the buttons.
 *
 * Re-renders at display-change rate, not every frame: every store read is
 * quantised to what the strip shows (0.1 km/h, 5 m, whole seconds, 0.1 %,
 * 1 W), the same contract as the legacy RideHUD (lib/hudThrottle).
 */

import { Flag, Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn, formatDistance, formatDuration } from '@/lib/utils';
import { quantizedMeters } from '@/lib/hudThrottle';
import { trainerDrivesRide } from '@/lib/rideDrive';
import { GEAR_COUNT } from '@/lib/virtualGears';
import { useControllerStore } from '@/stores/controllerStore';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { Figure } from './Figure';
import { HUD_PANEL } from './v2';

const M_PER_MI = 1609.344;

/** The live virtual gear, or null when no handlebar controls drive one (or ERG holds the power). */
export function useLiveGear(): number | null {
  const status = useControllerStore((s) => s.status);
  const gear = useControllerStore((s) => s.gear);
  const erg = useRideStore((s) => s.trainerControlMode === 'erg');
  const live = status === 'connected' || status === 'reconnecting';
  return live && !erg ? gear : null;
}

export function RideStrip({ className }: { className?: string }) {
  const speed = useRideStore((s) => Math.round(s.speed * 36) / 36); // 0.1 km/h steps
  const power = useRideStore((s) => Math.round(s.power));
  const grade = useRideStore((s) => Math.round(s.grade * 10) / 10);
  const distance = useRideStore((s) => quantizedMeters(s.distance, 5));
  const elapsedS = useRideStore((s) => Math.floor(s.elapsedMs / 1000));
  const total = useRideStore((s) => s.route?.totalDistance ?? 0);
  const liveRoute = useRideStore((s) => s.route?.isLive === true);
  const cadence = useRideStore((s) =>
    s.cadenceSensorStatus === 'connected' || trainerDrivesRide(s.mode, s.connection) ? Math.round(s.cadence) : 0,
  );
  const heartRate = useRideStore((s) => (s.heartRate === null ? null : Math.round(s.heartRate)));
  const imperial = useSettingsStore((s) => s.units) === 'imperial';
  const gear = useLiveGear();

  const speedUnit = imperial ? 'mph' : 'km/h';
  const speedValue = (imperial ? speed * 2.236936 : speed * 3.6).toFixed(1);
  const distUnit = imperial ? 'mi' : 'km';
  const distValue = (distance / (imperial ? M_PER_MI : 1000)).toFixed(1);
  const fmt = (m: number) => (imperial ? `${(m / M_PER_MI).toFixed(2)} mi` : formatDistance(m));
  const distAria = total > 0 && !liveRoute ? `${fmt(distance)} of ${fmt(total)}` : `Distance: ${fmt(distance)}`;
  const time = formatDuration(elapsedS);
  const gradeText = (Number.isFinite(grade) ? grade : 0).toFixed(1);

  const compact = [
    `${gradeText} %`,
    `${power} W`,
    gear !== null ? `gear ${gear}` : null,
    cadence > 0 ? `${cadence} rpm` : null,
    heartRate ? `${heartRate} bpm` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <section
      aria-label="Ride numbers"
      data-testid="ride-strip"
      className={cn(
        HUD_PANEL,
        'pointer-events-auto flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-8 sm:py-3 sm:pl-6 sm:pr-4',
        className,
      )}
    >
      <div className="flex justify-between gap-3 sm:justify-start sm:gap-8">
        <Figure value={speedValue} unit={speedUnit} label="Speed" ariaLabel={`Speed: ${speedValue} ${speedUnit}`} />
        <Figure value={time} label="Time" ariaLabel={`Time: ${time}`} />
        <Figure value={distValue} unit={distUnit} label="Distance" ariaLabel={distAria} />
        <Figure className="hidden sm:flex" size="minor" value={gradeText} unit="%" label="Grade" ariaLabel={`Grade: ${gradeText} %`} />
        <Figure className="hidden sm:flex" size="minor" value={String(power)} unit="W" label="Power" ariaLabel={`Power: ${power} W`} />
        {gear !== null && (
          <Figure
            className="hidden sm:flex"
            size="minor"
            value={String(gear)}
            unit={`/ ${GEAR_COUNT}`}
            label="Gear"
            ariaLabel={`Gear ${gear} of ${GEAR_COUNT}`}
          />
        )}
        {cadence > 0 && (
          <Figure className="hidden sm:flex" size="minor" value={String(cadence)} unit="rpm" label="Cadence" ariaLabel={`Cadence: ${cadence} rpm`} />
        )}
        {heartRate ? (
          <Figure className="hidden sm:flex" size="minor" value={String(heartRate)} unit="bpm" label="Heart" ariaLabel={`Heart rate: ${heartRate} bpm`} />
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3 sm:border-l sm:border-border sm:pl-6">
        <span className="num min-w-0 text-sm text-muted-foreground sm:hidden">{compact}</span>
        <Transport />
      </div>
    </section>
  );
}

/** Pause / Resume / Start + Finish for the current ride state. */
export function Transport() {
  const rideState = useRideStore((s) => s.rideState);
  const start = useRideStore((s) => s.start);
  const pause = useRideStore((s) => s.pause);
  const resume = useRideStore((s) => s.resume);
  const finish = useRideStore((s) => s.finish);

  if (rideState === 'ready') {
    return (
      <div className="flex shrink-0 gap-2">
        <Button variant="primary" size="lg" aria-label="Start ride" onClick={start}>
          <Play className="h-5 w-5" aria-hidden="true" />
          Start ride
        </Button>
      </div>
    );
  }
  if (rideState !== 'running' && rideState !== 'paused') return null;
  return (
    <div className="flex shrink-0 gap-2">
      {rideState === 'running' ? (
        <Button variant="outline" size="lg" aria-label="Pause ride" onClick={pause}>
          <Pause className="h-5 w-5" aria-hidden="true" />
          Pause
        </Button>
      ) : (
        <Button variant="primary" size="lg" aria-label="Resume ride" onClick={resume}>
          <Play className="h-5 w-5" aria-hidden="true" />
          Resume
        </Button>
      )}
      <Button variant="quiet" size="lg" className="px-3" aria-label="Finish ride" onClick={finish}>
        <Flag className="h-5 w-5" aria-hidden="true" />
        Finish
      </Button>
    </div>
  );
}
