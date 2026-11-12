/**
 * The ride band (compact ride HUD, owner-directed revision 2 Nov 2026,
 * docs/design/mockups/v2-ride-hud.html): the ONE always-on in-ride panel,
 * centred at the bottom edge. Speed, time, distance, grade, power and the
 * virtual gear (cadence and heart rate join only when a sensor delivers
 * them), then a modest Pause / Finish pair and the one "ride details"
 * toggle that opens the route card, map and ride tools above the band.
 * Exit sits at the band's start from sm; below sm it lives in the details.
 *
 * Below sm the band spans the screen: the big three figures (unit as the
 * label) beside icon-only Pause / Finish / details buttons, then one row of
 * grade, power and gear at figure size ("1.2 %  142 W  − gear 6 +").
 *
 * The gear always has an easier / harder pair beside it (and the - [ = ]
 * keys), with or without handlebar controls: a rider is never stuck in a
 * gear because a button on the bars does something else.
 *
 * Re-renders at display-change rate, not every frame: every store read is
 * quantised to what the band shows (0.1 km/h, 5 m, whole seconds, 0.1 %,
 * 1 W), the same contract as the legacy RideHUD (lib/hudThrottle).
 */

import { useEffect, useRef } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp, Flag, Minus, Pause, Play, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn, formatDistance, formatDuration } from '@/lib/utils';
import { quantizedMeters } from '@/lib/hudThrottle';
import { trainerDrivesRide } from '@/lib/rideDrive';
import { GEAR_COUNT } from '@/lib/virtualGears';
import { gearInUse, useControllerStore, type ControllerStatus } from '@/stores/controllerStore';
import { useRideHudStore } from '@/stores/rideHudStore';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { remoteFirst } from '@/hooks/useNavPrimary';
import { shiftFromScreen } from '@/hooks/useRideKeyboardShortcuts';
import { focusedControl, NAV_PRIMARY_ATTR } from '@/lib/tv/remoteNav';
import { Figure } from './Figure';
import { HUD_PANEL } from './v2';

const M_PER_MI = 1609.344;

/**
 * The virtual gear the trainer resistance uses right now (controllerStore
 * activeGear): the live gear while handlebar controls are connected, else
 * neutral (6 / 11). Null only in ERG, where the trainer holds the power and
 * gears do nothing.
 */
export function useLiveGear(): number | null {
  const status = useControllerStore((s) => s.status);
  const gear = useControllerStore((s) => s.gear);
  const manual = useControllerStore((s) => s.manualGear);
  const erg = useRideStore((s) => s.trainerControlMode === 'erg');
  return shownGear(status, gear, erg, manual);
}

/** Pure part of {@link useLiveGear} (same rule as controllerStore.activeGear). */
export function shownGear(status: ControllerStatus, gear: number, erg: boolean, manual = false): number | null {
  if (erg) return null;
  return gearInUse(status, gear, manual);
}

/** What a tap on an on-screen gear button does (same as the gear keys). */
export function tapGear(delta: 1 | -1): void {
  shiftFromScreen(delta);
}

/** One gear easier (-1) or harder (+1); disabled at the end of the range. */
export function GearButton({ delta, gear }: { delta: 1 | -1; gear: number }) {
  const easier = delta < 0;
  const Icon = easier ? Minus : Plus;
  return (
    <Button
      variant="quiet"
      size="icon"
      className="shrink-0"
      aria-label={easier ? 'Easier gear' : 'Harder gear'}
      title={easier ? 'Easier gear (- or [)' : 'Harder gear (= or ])'}
      disabled={easier ? gear <= 1 : gear >= GEAR_COUNT}
      onClick={() => tapGear(delta)}
    >
      <Icon className="h-5 w-5" aria-hidden="true" />
    </Button>
  );
}

interface CompactFigure {
  key: string;
  value: string;
  unit?: string;
  /** A word before the value ("gear 6"). */
  prefix?: string;
}

export function RideStrip({ onExit, className }: { onExit?: () => void; className?: string }) {
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

  // Phones: the rest of the figures in one row under the big three, at
  // figure size (UI-RULES §5: in-ride figures at least text-2xl).
  const compact: CompactFigure[] = [
    { key: 'grade', value: gradeText, unit: '%' },
    { key: 'power', value: String(power), unit: 'W' },
    ...(gear !== null ? [{ key: 'gear', value: String(gear), prefix: 'gear' }] : []),
    ...(cadence > 0 ? [{ key: 'cadence', value: String(cadence), unit: 'rpm' }] : []),
    ...(heartRate ? [{ key: 'heart', value: String(heartRate), unit: 'bpm' }] : []),
  ];

  return (
    <section
      aria-label="Ride numbers"
      data-testid="ride-strip"
      className={cn(
        HUD_PANEL,
        'pointer-events-auto flex flex-wrap items-center gap-x-2 gap-y-0 p-2 sm:flex-nowrap sm:gap-3',
        className,
      )}
    >
      {onExit && (
        <Button
          variant="quiet"
          size="icon"
          className="hidden shrink-0 sm:inline-flex"
          aria-label="Exit ride and return to setup"
          title="Exit ride"
          onClick={onExit}
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
        </Button>
      )}
      <div className="flex min-w-0 flex-1 justify-between gap-3 px-1 sm:flex-none sm:justify-start sm:gap-6 sm:border-l sm:border-border sm:px-4">
        <Figure value={speedValue} unit={speedUnit} label="Speed" size="minor" unitAsLabelBelowSm ariaLabel={`Speed: ${speedValue} ${speedUnit}`} />
        <Figure value={time} label="Time" size="minor" ariaLabel={`Time: ${time}`} />
        <Figure value={distValue} unit={distUnit} label="Distance" size="minor" unitAsLabelBelowSm ariaLabel={distAria} />
        <Figure className="hidden sm:flex" size="minor" value={gradeText} unit="%" label="Grade" ariaLabel={`Grade: ${gradeText} %`} />
        <Figure className="hidden sm:flex" size="minor" value={String(power)} unit="W" label="Power" ariaLabel={`Power: ${power} W`} />
        {gear !== null && (
          <div className="hidden items-center gap-1 sm:flex" data-testid="ride-gear">
            <GearButton delta={-1} gear={gear} />
            <Figure size="minor" value={String(gear)} unit={`/ ${GEAR_COUNT}`} label="Gear" ariaLabel={`Gear ${gear} of ${GEAR_COUNT}`} />
            <GearButton delta={1} gear={gear} />
          </div>
        )}
        {cadence > 0 && (
          <Figure className="hidden sm:flex" size="minor" value={String(cadence)} unit="rpm" label="Cadence" ariaLabel={`Cadence: ${cadence} rpm`} />
        )}
        {heartRate ? (
          <Figure className="hidden sm:flex" size="minor" value={String(heartRate)} unit="bpm" label="Heart" ariaLabel={`Heart rate: ${heartRate} bpm`} />
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1 sm:border-l sm:border-border sm:pl-3">
        <Transport />
        <DetailsToggle />
      </div>
      {/* Phones: grade, power and gear in one row under the big three, at
          figure size (cadence and heart rate wrap to a second row only if
          both join). */}
      <div
        className="flex min-w-0 basis-full flex-wrap items-center justify-between gap-x-3 px-1 sm:hidden"
        data-testid="ride-strip-compact"
      >
        {compact.map((f) => {
          const figure = (
            <span key={f.key} className="num whitespace-nowrap">
              {f.prefix && <small className="mr-1 text-sm font-semibold text-muted-foreground">{f.prefix}</small>}
              <span className="text-2xl font-bold">{f.value}</span>
              {f.unit && <small className="ml-1 text-sm font-semibold text-muted-foreground">{f.unit}</small>}
            </span>
          );
          if (f.key !== 'gear' || gear === null) return figure;
          return (
            <span key={f.key} className="inline-flex items-center gap-1" data-testid="ride-gear-compact">
              <GearButton delta={-1} gear={gear} />
              {figure}
              <GearButton delta={1} gear={gear} />
            </span>
          );
        })}
      </div>
    </section>
  );
}

/** The one tap that opens or closes the ride details above the band. */
export function DetailsToggle() {
  const expanded = useRideHudStore((s) => s.expanded);
  const toggle = useRideHudStore((s) => s.toggleExpanded);
  return (
    <Button
      variant="quiet"
      size="icon"
      aria-expanded={expanded}
      aria-controls="ride-details"
      aria-label={expanded ? 'Hide ride details' : 'Show ride details: route, map and ride tools'}
      title={expanded ? 'Hide details' : 'Route, map and tools'}
      onClick={toggle}
      data-testid="ride-details-toggle"
    >
      {expanded ? <ChevronDown className="h-5 w-5" aria-hidden="true" /> : <ChevronUp className="h-5 w-5" aria-hidden="true" />}
    </Button>
  );
}

/**
 * Pause / Resume / Start + Finish for the current ride state: modest h-10
 * buttons, labelled from lg, icon-only below.
 *
 * Remote navigation (P3.3): Pause / Resume is one button (the same element
 * across the toggle, so a ring on it stays), the HUD's primary control (the
 * first arrow press rings it). When the ride pauses on a TV or under remote
 * input with nothing ringed, the ring lands on Resume, so OK carries on and
 * the D-pad reaches Finish right beside it.
 */
export function Transport() {
  const rideState = useRideStore((s) => s.rideState);
  const start = useRideStore((s) => s.start);
  const pause = useRideStore((s) => s.pause);
  const resume = useRideStore((s) => s.resume);
  const finish = useRideStore((s) => s.finish);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const primary = { [NAV_PRIMARY_ATTR]: '' };

  useEffect(() => {
    if (rideState === 'paused' && remoteFirst() && !focusedControl()) toggleRef.current?.focus({ preventScroll: true });
  }, [rideState]);

  const label = 'hidden lg:inline';
  const btn = 'w-10 px-0 lg:w-auto lg:px-3';

  if (rideState === 'ready') {
    return (
      <Button variant="primary" className="px-3" aria-label="Start ride" onClick={start} {...primary}>
        <Play className="h-5 w-5" aria-hidden="true" />
        Start
      </Button>
    );
  }
  if (rideState !== 'running' && rideState !== 'paused') return null;
  return (
    <>
      {rideState === 'running' ? (
        <Button ref={toggleRef} variant="outline" className={btn} aria-label="Pause ride" title="Pause" onClick={pause} {...primary}>
          <Pause className="h-5 w-5" aria-hidden="true" />
          <span className={label}>Pause</span>
        </Button>
      ) : (
        <Button ref={toggleRef} variant="primary" className={btn} aria-label="Resume ride" title="Resume" onClick={resume} {...primary}>
          <Play className="h-5 w-5" aria-hidden="true" />
          <span className={label}>Resume</span>
        </Button>
      )}
      <Button variant="quiet" className={btn} aria-label="Finish ride" title="Finish" onClick={finish}>
        <Flag className="h-5 w-5" aria-hidden="true" />
        <span className={label}>Finish</span>
      </Button>
    </>
  );
}
