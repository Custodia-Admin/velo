/**
 * The next landmark on the road, one line with a flag: "Bastia Umbra in 6.5 km".
 * When the line is too narrow the place name shortens ("Bastia Um… in 6.5 km");
 * the distance stays whole, since it is the part the rider uses.
 *
 * Review of PR #36 @61defbb (F2): the whole line was one truncating span, so a
 * 640 px floating window showed "Bastia Umbra in 6…" and the show strip
 * "Chiesa di Santa Maria in 3.9 …".
 *
 * Only when the line can't hold even the flag and the distance (the floating
 * window's 640 px bar at the widest figures, or a long "· 1.2 km to the top")
 * does the line itself clip at its edge: it never runs under Pause or out of
 * the bar.
 *
 * Used by the floating window's bar and pill (JourneyBar), the show strip
 * (ShowRideStrip) and the ride details' route card (RideRoutePanel). The caller
 * sets the display (`flex`, `hidden sm:flex`…) and the width through className.
 */

import { Flag } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { NextLandmarkParts } from './rideHudText';

export function NextLandmark({
  next,
  className,
  testId,
}: {
  next: NextLandmarkParts;
  className?: string;
  testId?: string;
}) {
  return (
    <p className={cn('items-center gap-1.5 overflow-x-clip text-sm', className)} data-testid={testId}>
      <Flag className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex min-w-0">
        <span className="truncate" data-testid="landmark-name">
          {next.name}
        </span>
        {/* whitespace-pre keeps the leading space and the distance on one line. */}
        <span className="shrink-0 whitespace-pre tabular-nums" data-testid="landmark-distance">
          {` ${next.distance}`}
        </span>
      </span>
    </p>
  );
}
