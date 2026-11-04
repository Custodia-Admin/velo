/**
 * Journey mode — "ride over anything" (docs/design/mockups/v2-pip.html,
 * v2-pip-window.html): the ride floats in a Document Picture-in-Picture
 * window over a streaming site in another tab, or anything else on the
 * screen. Streaming services can't be embedded in a web app (DRM, frame
 * blocking), so Velo goes on top of them instead.
 *
 * - `ShowSurface` renders the ride into the open window through a portal:
 *   the world (RideView, the same renderer and director), the next-landmark
 *   pill (narrow windows), the S/M/L window size, "Back to the Velo tab",
 *   the status chip (problems only) and the JourneyBar.
 * - `RideFloatingNotice` is what the Velo tab shows meanwhile: one message
 *   and one action, "Bring the ride back". Ride.tsx mounts no second world
 *   view in the tab (one WebGL context at a time).
 * - The ride loop, recording and FIT export run in the tab as always: Chrome
 *   keeps a tab with an open picture-in-picture window running at full rate
 *   even when it is hidden (lib/show/pip.ts, e2e/show-mode.spec.ts).
 *
 * The window scales its own type with its width (`data-surface="pip"`,
 * index.css). Translucent HUD surfaces, no blur (`hud-flat`).
 */

import { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, PictureInPicture2 } from 'lucide-react';
import { RideView } from '@/components/ride/RideView';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { WorldRenderer } from '@/lib/world/renderer';
import {
  closeRidePip,
  currentRidePip,
  openRidePip,
  PIP_SIZES,
  PIP_SIZE_LABEL,
  resizeRidePip,
  subscribeRidePip,
  type PipSize,
} from '@/lib/show/pip';
import { useRideStore } from '@/stores/rideStore';
import { useShowStore } from '@/stores/showStore';
import { JourneyBar, JourneyLandmark } from './JourneyBar';
import { RideChip } from './RideChip';
import { HUD_PANEL } from './v2';

/** The open ride window, or null (re-renders when it opens or closes). */
export function useRidePipWindow(): Window | null {
  return useSyncExternalStore(subscribeRidePip, currentRidePip, () => null);
}

/** Opens the ride window at the rider's last size. Call from a click. */
export async function openRideWindow(): Promise<boolean> {
  const show = useShowStore.getState();
  const route = useRideStore.getState().route;
  const win = await openRidePip(show.pipSize, {
    title: route?.name ? `Velo · ${route.name}` : 'Velo ride',
    onClose: () => useShowStore.getState().setPipOpen(false),
  });
  useShowStore.getState().setPipOpen(win !== null);
  return win !== null;
}

/** Keeps the window's theme in step with the tab (night/day switched mid-ride). */
function useThemeSync(win: Window) {
  useEffect(() => {
    const src = document.documentElement;
    const copy = () => {
      const cls = src.getAttribute('class');
      if (cls !== null) win.document.documentElement.setAttribute('class', cls);
    };
    const mo = new MutationObserver(copy);
    mo.observe(src, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, [win]);
}

export function ShowSurface({
  ionToken,
  onRendererReady,
}: {
  ionToken: string | null;
  onRendererReady?: (renderer: WorldRenderer | null) => void;
}) {
  const win = useRidePipWindow();
  if (!win) return null;
  return createPortal(<FloatingRide win={win} ionToken={ionToken} onRendererReady={onRendererReady} />, win.document.body);
}

function FloatingRide({
  win,
  ionToken,
  onRendererReady,
}: {
  win: Window;
  ionToken: string | null;
  onRendererReady?: (renderer: WorldRenderer | null) => void;
}) {
  useThemeSync(win);
  return (
    <div className="hud-flat fixed inset-0 overflow-hidden bg-background text-foreground" data-testid="pip-ride">
      <RideView ionToken={ionToken} onRendererReady={onRendererReady} />
      <div className="pointer-events-none absolute inset-x-2 top-2 z-20 flex items-start gap-2">
        <JourneyLandmark />
        <div className="ml-auto flex shrink-0 gap-2">
          <PipSizePicker win={win} />
          <Button
            variant="hud"
            size="icon"
            className="pointer-events-auto"
            aria-label="Back to the Velo tab"
            title="Back to the Velo tab"
            onClick={closeRidePip}
          >
            <PictureInPicture2 className="h-5 w-5" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-2 bottom-2 z-20 flex flex-col items-start gap-2">
        <RideChip alertsOnly className="shrink-0" />
        <JourneyBar className="w-full" />
      </div>
    </div>
  );
}

const SIZE_LETTER: Record<PipSize, string> = { corner: 'S', third: 'M', half: 'L' };
const SIZE_ARIA: Record<PipSize, string> = {
  corner: `${PIP_SIZE_LABEL.corner}: a quarter of the screen`,
  third: `${PIP_SIZE_LABEL.third} of the screen`,
  half: `${PIP_SIZE_LABEL.half} the screen`,
};

function PipSizePicker({ win }: { win: Window }) {
  const size = useShowStore((s) => s.pipSize);
  const setPipSize = useShowStore((s) => s.setPipSize);
  return (
    <div role="radiogroup" aria-label="Window size" className={cn(HUD_PANEL, 'pointer-events-auto flex gap-1')}>
      {PIP_SIZES.map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={size === s}
          aria-label={SIZE_ARIA[s]}
          data-pip-size={s}
          onClick={() => {
            setPipSize(s);
            resizeRidePip(s, win);
          }}
          className={cn(
            'h-10 w-10 rounded-md text-sm font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            size === s ? 'bg-hud-foreground/10' : 'hover:bg-hud-foreground/5',
          )}
        >
          {SIZE_LETTER[s]}
        </button>
      ))}
    </div>
  );
}

/** The Velo tab while the ride floats: one message, one action. */
export function RideFloatingNotice({ className }: { className?: string }) {
  return (
    <div
      className={cn('absolute inset-0 z-10 grid place-items-center bg-background p-6', className)}
      data-testid="ride-floating-notice"
    >
      <div className="flex max-w-lg flex-col items-center gap-4 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary">
          <PictureInPicture2 className="h-5 w-5" aria-hidden="true" />
        </span>
        <h2 className="text-2xl font-semibold">Your ride is in the floating window</h2>
        <p className="text-base text-muted-foreground">It keeps recording while you watch something else.</p>
        <Button variant="primary" size="lg" onClick={closeRidePip}>
          <Maximize2 className="h-5 w-5" aria-hidden="true" />
          Bring the ride back
        </Button>
      </div>
    </div>
  );
}
