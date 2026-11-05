/**
 * The next landmark on the road, one line with a flag: "Bastia Umbra in 6.5 km".
 *
 * The line never cuts a word off at its edge (review of PR #48 @dfd7071, N3).
 * When it is too narrow it gives things up in this order, and the distance,
 * the part the rider uses, is always whole when it shows:
 *   1. the place name shortens ("Bastia Um… in 6.5 km"), down to about two
 *      characters (`min-w-8`);
 *   2. the name goes: "⚑ in 6.5 km" ("⚑ 300 m to the top" inside a climb);
 *   3. the flag goes: "in 6.5 km";
 *   4. the line shows nothing, like a ride with no named place ahead.
 * The floating window's 640 px bar at the widest figures (1:18:05, 42.2 km,
 * −12.5 %) leaves 79–111 px for the line, so steps 2–4 happen there.
 *
 * How, with no measuring script: each row is one text line high (`h-lh`,
 * overflow hidden) and wraps, so whatever doesn't fit drops, whole, onto a
 * second line that is never seen. A row is laid out right to left
 * (`flex-row-reverse`; `order-last` puts the part drawn leftmost at the end)
 * so the part to keep is placed first, after a full-height, zero-width
 * sentinel (first child) that keeps even the first part off the visible line
 * when it doesn't fit. The outer row places the name + distance group, then
 * the flag; the group places the distance, then the name. The group's
 * narrowest is the distance alone (`min-w-min`; the name's `break-all` lets
 * it shrink to a letter in that sum), so the group holds the line whenever the
 * distance fits. The DOM keeps reading order (flag, name, distance), so screen
 * readers always get the whole sentence.
 *
 * Review of PR #36 @61defbb (F2): the whole line was one truncating span, so a
 * 640 px floating window showed "Bastia Umbra in 6…" and the show strip
 * "Chiesa di Santa Maria in 3.9 …".
 *
 * Used by the floating window's bar and pill (JourneyBar), the show strip
 * (ShowRideStrip) and the ride details' route card (RideRoutePanel). The caller
 * sets the display (`flex`, `hidden sm:flex`…) and the width through className.
 */

import { Flag } from 'lucide-react';
import { cn } from '@/lib/utils';
import { landmarkJoiner, type NextLandmarkParts } from './rideHudText';

/** One text line high, laid out right to left; what doesn't fit wraps out of sight. */
const FIT_ROW = 'flex h-lh flex-row-reverse flex-wrap content-start items-center justify-end overflow-hidden';

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
    <p className={cn('items-center text-sm', className)} data-testid={testId}>
      <span className={cn(FIT_ROW, 'min-w-0')} data-testid="landmark-fit">
        <span className="h-lh" aria-hidden="true" />
        <Flag className="order-last mr-1.5 h-4 w-4 shrink-0" aria-hidden="true" data-testid="landmark-flag" />
        <span className={cn(FIT_ROW, 'min-w-min flex-1')} data-testid="landmark-group">
          <span className="h-lh" aria-hidden="true" />
          <span className="order-last flex min-w-8 max-w-max flex-1">
            <span className="line-clamp-1 break-all" data-testid="landmark-name">
              {next.name}
            </span>
            {/* whitespace-pre keeps the spaces around "·". */}
            <span className="shrink-0 whitespace-pre" data-testid="landmark-joiner">
              {landmarkJoiner(next)}
            </span>
          </span>
          <span className="shrink-0 whitespace-pre" data-testid="landmark-distance">
            {next.distance}
          </span>
        </span>
      </span>
    </p>
  );
}
