/**
 * The floating ride window's condensed HUD (journey mode;
 * docs/design/mockups/v2-pip-window.html): a thin route-progress track, time,
 * distance and grade (text-3xl at every window size: 30 px at the corner
 * size, readable from the sofa), the next landmark, and one Pause button.
 *
 * In a window narrower than sm (the corner size) the next landmark moves to
 * its own pill at the top left (`JourneyLandmark`), so the bar stays one row,
 * and the gaps tighten from 6 to 3. The window is never narrower than
 * lib/show/pip PIP_MIN_WIDTH.corner (448 px), where the figures and Pause fit
 * at h:mm:ss with room to spare in wide system fonts (Ubuntu's DejaVu Sans
 * needed 435 px of the bar's 432 with gap 4). Same numbers as the show strip
 * (`useShowRideNumbers`).
 */

import { Flag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Figure } from './Figure';
import { useShowRideNumbers, type ShowRideNumbers } from './ShowRideStrip';
import { HUD_PANEL } from './v2';

/** Progress width on a 0..1000 viewBox, so the track needs no inline style. */
const TRACK_W = 1000;

export function JourneyBar({ numbers, className }: { numbers?: ShowRideNumbers; className?: string }) {
  const live = useShowRideNumbers();
  const n = numbers ?? live;
  const { action } = n;
  return (
    <section
      aria-label="Ride numbers"
      data-testid="journey-bar"
      className={cn(HUD_PANEL, 'pointer-events-auto relative flex items-center gap-3 overflow-hidden py-2 pl-4 pr-2 sm:gap-6', className)}
    >
      <svg
        className="absolute inset-x-0 top-0 block h-1 w-full text-primary"
        viewBox={`0 0 ${TRACK_W} 4`}
        preserveAspectRatio="none"
        aria-hidden="true"
        data-testid="journey-progress"
      >
        <rect width={TRACK_W} height="4" className="fill-hud-foreground/10" />
        <rect width={Math.round(n.progress * TRACK_W)} height="4" fill="currentColor" />
      </svg>
      <div className="flex shrink-0 gap-3 sm:gap-6">
        <Figure size="large" value={n.time} label="Time" ariaLabel={`Time: ${n.time}`} />
        <Figure size="large" value={n.distanceValue} unit={n.distanceUnit} label="Distance" ariaLabel={n.distanceAria} />
        <Figure size="large" value={n.gradeText} unit="%" label="Grade" ariaLabel={`Grade: ${n.gradeText} %`} />
      </div>
      {n.next && <NextLine text={n.next} className="hidden min-w-0 flex-1 sm:flex" />}
      {action && (
        <Button variant="hud" size="icon" className="ml-auto shrink-0" aria-label={action.label} onClick={action.run}>
          <action.icon className="h-5 w-5" aria-hidden="true" />
        </Button>
      )}
    </section>
  );
}

/** The next landmark as its own pill (windows narrower than sm). */
export function JourneyLandmark({ numbers, className }: { numbers?: ShowRideNumbers; className?: string }) {
  const live = useShowRideNumbers();
  const n = numbers ?? live;
  if (!n.next) return null;
  return (
    <NextLine
      text={n.next}
      className={cn(HUD_PANEL, 'pointer-events-auto flex h-10 min-w-0 px-3 sm:hidden', className)}
    />
  );
}

function NextLine({ text, className }: { text: string; className?: string }) {
  return (
    <p className={cn('items-center gap-1.5 text-sm', className)} data-testid="journey-next">
      <Flag className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{text}</span>
    </p>
  );
}
