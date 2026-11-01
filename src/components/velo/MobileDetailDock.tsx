import { useCallback, useEffect, useState } from 'react';
import { Map, Mountain } from 'lucide-react';

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
 * rider and the road ahead. The dock keeps the scene clear by default:
 * two h-10 HUD toggles sit above the ride strip, and the panel a
 * rider asks for opens upward, compact enough (128 px map, 112 px chart)
 * to stay below the rider band. One panel at a time; tap again or press
 * Escape to close.
 *
 * Mounted from Ride.tsx (`sm:hidden`) in the bottom column right above
 * the phone ride strip, so the two never collide. From sm the route panel
 * carries the profile and the map opens from the HUD's "More" menu.
 */

export type DockPanel = 'map' | 'profile';

/** Pure toggle rule: clicking the open panel closes it; otherwise switch. */
export function toggleDockPanel(
  current: DockPanel | null,
  clicked: DockPanel,
): DockPanel | null {
  return current === clicked ? null : clicked;
}

export function MobileDetailDock({ className }: { className?: string }) {
  const [open, setOpen] = useState<DockPanel | null>(null);

  const toggle = useCallback((panel: DockPanel) => {
    setOpen((current) => toggleDockPanel(current, panel));
  }, []);

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

  return (
    <div className={cn('flex flex-col items-center gap-2 pointer-events-none', className)}>
      {open && (
        <div
          id="ride-detail-panel"
          data-dock-panel={open}
          role="region"
          aria-label={open === 'map' ? 'Route map' : 'Elevation profile'}
          className="w-full flex justify-center animate-scaleIn pointer-events-auto"
        >
          {open === 'map' ? (
            <Minimap className="h-32 w-32" />
          ) : (
            <div className={cn(HUD_PANEL, 'w-full p-2')}>
              <ElevationProfile />
            </div>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 pointer-events-auto">
        <Button
          variant="hud"
          data-dock-toggle="map"
          aria-expanded={open === 'map'}
          aria-controls="ride-detail-panel"
          aria-label="Route map"
          onClick={() => toggle('map')}
          className={cn(
            'h-10 px-3.5 text-sm font-semibold',
            open === 'map' && 'border-primary bg-primary/15 text-primary',
          )}
        >
          <Map className="h-4 w-4" aria-hidden="true" />
          Map
        </Button>
        <Button
          variant="hud"
          data-dock-toggle="profile"
          aria-expanded={open === 'profile'}
          aria-controls="ride-detail-panel"
          aria-label="Elevation profile"
          onClick={() => toggle('profile')}
          className={cn(
            'h-10 px-3.5 text-sm font-semibold',
            open === 'profile' && 'border-primary bg-primary/15 text-primary',
          )}
        >
          <Mountain className="h-4 w-4" aria-hidden="true" />
          Profile
        </Button>
      </div>
    </div>
  );
}
