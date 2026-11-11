/**
 * The compact ride HUD (owner-directed revision, 2 Nov 2026,
 * docs/design/mockups/v2-ride-hud.html). Everything sits at the bottom edge
 * in ONE flow column, so no two panels can ever overlap and nothing is
 * crammed to the top of the screen:
 *
 *   - ride details (collapsed by default, persisted): the route card with
 *     the elevation profile and weather, the route map, and the ride tools
 *     (show, camera, ghosts, voice, settings). sm+: a 20rem column on the
 *     band's left edge, clear of the chase-camera rider; phones: route card
 *     | map at the top edge (the only room clear of the rider), the tools
 *     above the band.
 *   - the devices sheet, in the details' place while the chip has it open.
 *   - opt-in ride modes that are on (play).
 *   - the chip lane, right above the band: the status chip at its start,
 *     and while the chip is calm the photoreal notice at its end (no-token
 *     pitch or imagery fallback; photoreal rides, collapsed HUD only).
 *   - the ride band: Exit (sm+), the six figures, Pause / Finish and the
 *     one details toggle.
 *
 * The column spans the screen but is click-through: only the panels and
 * buttons take pointer events. Translucent HUD surfaces without blur (no
 * backdrop-filter over the live canvas, PR #16).
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useRideHudStore } from '@/stores/rideHudStore';
import { PhotorealNoticeView, type PhotorealNoticeState } from './PhotorealNotice';
import { RideChip } from './RideChip';
import { RideDevicesSheet } from './RideDevicesSheet';
import { RideMap } from './RideMap';
import { RideRoutePanel } from './RideRoutePanel';
import { RideStrip } from './RideStrip';
import { RideSettingsHost, RideTools, type RideToolsProps } from './RideTools';

export interface RideHudProps extends RideToolsProps {
  /** Opt-in ride modes that are on (workout, segments, play): always shown. */
  modes?: ReactNode;
  /** The photoreal notice (usePhotorealNotice), null on world rides. */
  notice?: PhotorealNoticeState | null;
  className?: string;
}

export function RideHud(props: RideHudProps) {
  const expanded = useRideHudStore((s) => s.expanded);
  const devicesOpen = useRideHudStore((s) => s.devicesOpen);
  return (
    <>
      <RideHudLayout {...props} expanded={expanded} devicesOpen={devicesOpen} />
      {/* Settings for 'globeride:open-settings' (the photoreal notice), with
          the details closed too: the tools' own menu is inside them. */}
      <RideSettingsHost />
    </>
  );
}

/** The column for a given details / devices state (RideHud reads the store). */
export function RideHudLayout({
  expanded,
  devicesOpen,
  modes,
  notice,
  className,
  ...tools
}: RideHudProps & { expanded: boolean; devicesOpen: boolean }) {
  // The notice rides in the chip lane, collapsed HUD only: with the details
  // or the devices sheet open the rider is busy there (and Settings is one
  // of the ride tools).
  const quiet = notice && !expanded && !devicesOpen ? <PhotorealNoticeView {...notice} /> : null;
  return (
    <div
      className={cn(
        'pointer-events-none absolute hud-inset-b hud-inset-x z-20 flex flex-col items-stretch sm:items-center',
        // An open devices sheet can be taller than the room above the band
        // (handlebar legend open): the column then reaches the top inset and
        // the sheet scrolls inside it instead of running off the screen.
        devicesOpen && 'hud-inset-t justify-end',
        className,
      )}
      data-testid="ride-hud"
    >
      {/* One group, as wide as the band and centred on the bottom edge from
          sm: details, modes and chip share the band's left edge. */}
      <div className="flex min-h-0 flex-col items-stretch gap-2 sm:w-max sm:max-w-hud-strip sm:items-start">
        {devicesOpen ? (
          <RideDevicesSheet className="sm:w-96" />
        ) : (
          expanded && <RideDetails {...tools} />
        )}
        {modes && <div className="flex shrink-0 flex-col gap-2 empty:hidden sm:w-80">{modes}</div>}
        {/* The chip lane spans the band while it holds the notice: chip at
            the band's left end, notice at its right end, the rider between. */}
        <RideChip className={quiet ? 'shrink-0 self-stretch' : 'shrink-0 self-start'} aside={quiet} />
        <RideStrip onExit={tools.onExit} className="shrink-0 sm:self-stretch" />
      </div>
    </div>
  );
}

/**
 * Route card (profile + weather), route map and ride tools: the expanded
 * details. From sm one wrapping 20rem column above the chip, on the band's
 * left edge (route card across, then the map with the tools in a grid
 * beside it), so nothing can overlap and the chase-camera rider in the
 * middle stays clear. Phones have no room above
 * the band without covering the rider (wheels at ~75 % of the height), so
 * there the route card and map go to the top edge and only the tools row
 * sits above the band. No transform on the details box: it would become
 * the containing block of the phones' fixed top row.
 */
function RideDetails(tools: RideToolsProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Escape (a remote's or the handlebars' Back) with the focus in the
  // details closes them and puts the ring back on the toggle. It stops here:
  // on the window Escape is the ride's pause / finish shortcut. An open
  // tools menu (its trigger is aria-expanded) closes itself first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = ref.current;
      if (e.key !== 'Escape' || !root || !root.contains(e.target as Node)) return;
      if (root.querySelector('[aria-expanded="true"]')) return;
      e.stopPropagation();
      useRideHudStore.getState().setExpanded(false);
      document.querySelector<HTMLElement>('[data-testid="ride-details-toggle"]')?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div
      ref={ref}
      id="ride-details"
      role="region"
      aria-label="Ride details"
      data-testid="ride-details"
      className="flex flex-wrap items-start gap-2 sm:w-80"
    >
      <div className="fixed hud-inset-t hud-inset-x flex items-start gap-2 sm:contents" data-testid="ride-details-route">
        <RideRoutePanel className="min-w-0 flex-1 animate-scaleIn sm:basis-full" />
        <div className="pointer-events-auto shrink-0 animate-scaleIn" data-testid="ride-map">
          <RideMap className="h-32 w-32 sm:h-44 sm:w-44" />
        </div>
      </div>
      {/* sm+: a 3-column grid beside the map, bottom-aligned with it, so the
          map, the tools and the route card share the column's right edge. */}
      <RideTools
        {...tools}
        className="basis-full animate-scaleIn justify-between sm:grid sm:flex-1 sm:basis-auto sm:grid-cols-3 sm:self-end"
      />
    </div>
  );
}
