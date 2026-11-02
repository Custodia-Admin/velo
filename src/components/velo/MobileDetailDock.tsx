import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';

import { Minimap } from '@/components/ride/Minimap';
import { ElevationProfile } from '@/components/ride/ElevationProfile';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { HUD_PANEL } from './v2';

/**
 * MobileDetailDock — on-demand minimap + elevation profile for phones.
 *
 * The standard chase camera puts the rider in the middle of a 390-wide
 * viewport (y≈360–532 of 844). The old always-on mobile HUD stack painted
 * the minimap and the elevation graph right over that band, hiding the
 * rider and the road ahead. The dock keeps the scene clear: nothing shows
 * until the rider asks for a panel from the ride Settings menu ("Route map",
 * "Elevation profile" — the v2 mockup has no toggles above the strip). The
 * panel opens compact (128 px map, 112 px chart) right above the ride strip,
 * below the rider band. One panel at a time; its close button, choosing it
 * again or Escape closes it.
 *
 * Mounted from Ride.tsx (`sm:hidden`) in the bottom column right above the
 * phone ride strip, so the two never collide. From sm the route panel
 * carries the profile and the map opens from the same Settings menu.
 */

export type DockPanel = 'map' | 'profile';

/** Window event that toggles a dock panel: detail `{ panel: DockPanel }`. */
export const TOGGLE_DOCK_EVENT = 'velo:toggle-ride-detail';

/** Open (or, when it is the open one, close) a phone dock panel. */
export function toggleRideDetail(panel: DockPanel): void {
  window.dispatchEvent(new CustomEvent(TOGGLE_DOCK_EVENT, { detail: { panel } }));
}

/** Pure toggle rule: clicking the open panel closes it; otherwise switch. */
export function toggleDockPanel(current: DockPanel | null, clicked: DockPanel): DockPanel | null {
  return current === clicked ? null : clicked;
}

export function MobileDetailDock({ className }: { className?: string }) {
  const [open, setOpen] = useState<DockPanel | null>(null);

  const toggle = useCallback((panel: DockPanel) => {
    setOpen((current) => toggleDockPanel(current, panel));
  }, []);

  useEffect(() => {
    const onToggle = (e: Event) => {
      const panel = (e as CustomEvent<{ panel?: DockPanel }>).detail?.panel;
      if (panel === 'map' || panel === 'profile') toggle(panel);
    };
    window.addEventListener(TOGGLE_DOCK_EVENT, onToggle);
    return () => window.removeEventListener(TOGGLE_DOCK_EVENT, onToggle);
  }, [toggle]);

  // Escape closes whichever panel is open, and stops there: on the window
  // it is the ride's pause / finish shortcut.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  const label = open === 'map' ? 'Route map' : 'Elevation profile';

  return (
    <div className={cn('flex flex-col items-center gap-2 pointer-events-none', className)}>
      <div
        id="ride-detail-panel"
        data-dock-panel={open}
        role="region"
        aria-label={label}
        className="relative w-full flex justify-center animate-scaleIn pointer-events-auto"
      >
        {open === 'map' ? (
          <Minimap className="h-32 w-32" />
        ) : (
          <div className={cn(HUD_PANEL, 'w-full p-2')}>
            <ElevationProfile />
          </div>
        )}
        <Button
          variant="hud"
          size="icon"
          className="absolute right-0 top-0"
          aria-label={`Close ${label.toLowerCase()}`}
          onClick={() => setOpen(null)}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
