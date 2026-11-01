/**
 * v2 in-ride HUD top row (docs/design/mockups/v2-ride-hud.html): Exit and the
 * route panel on the left, the ride tools on the right, and a slot under the
 * tools (sm+) for the panels that come and go (handlebar controls, workout,
 * Strava segments, play mode, perf readout). The ride strip lives at the
 * bottom (RideStrip, placed by Ride.tsx).
 *
 * The row wrapper spans the screen, so it is click-through: only the panels
 * and buttons take pointer events. Solid HUD surfaces only (no blur over the
 * live canvas, PR #16).
 */

import { useState, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Minimap } from '@/components/ride/Minimap';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { RideRoutePanel } from './RideRoutePanel';
import { RideTools, type RideToolsProps } from './RideTools';

export interface RideHudProps extends Omit<RideToolsProps, 'mapOpen' | 'onToggleMap'> {
  onExit: () => void;
  /** Panels under the tools, sm+ (the right column). */
  side?: ReactNode;
  /** Extra classes for the row (idle fade). */
  className?: string;
}

export function RideHud({ onExit, side, className, ...tools }: RideHudProps) {
  const [mapOpen, setMapOpen] = useState(false);

  return (
    <div
      className={cn(
        'pointer-events-none absolute hud-inset-t hud-inset-x z-20 flex items-start justify-between gap-2 sm:gap-3',
        className,
      )}
      data-testid="ride-hud"
    >
      <div className="flex min-w-0 flex-1 items-start gap-2 sm:flex-none sm:gap-3">
        <Button
          variant="hud"
          className="pointer-events-auto w-10 shrink-0 px-0 sm:w-auto sm:px-4"
          aria-label="Exit ride and return to setup"
          onClick={onExit}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">Exit</span>
        </Button>
        <div className="flex min-w-0 flex-1 flex-col items-start gap-2 sm:flex-none">
          <RideRoutePanel className="w-full" />
          {mapOpen && (
            <div className="pointer-events-auto hidden sm:block" data-testid="ride-map">
              <Minimap />
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <RideTools {...tools} mapOpen={mapOpen} onToggleMap={() => setMapOpen((o) => !o)} />
        {side && <div className="hidden w-80 flex-col items-stretch gap-2 sm:flex">{side}</div>}
      </div>
    </div>
  );
}
