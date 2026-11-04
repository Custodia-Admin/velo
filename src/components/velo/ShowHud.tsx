/**
 * Show mode's bottom column (docs/design/mockups/v2-show.html): the show
 * strip, with the ride's status chip above it. Over the video the chip
 * speaks up only for a problem or a passing notice (`alertsOnly`); it hosts
 * the toasts, so no toast card (and no red error box) is drawn over the
 * show either. A chip tap that asks for the devices opens the same in-ride
 * devices sheet as the ride HUD, above the chip.
 *
 * Bottom-right from sm; full width on phones (the strip wraps to two rows).
 * Click-through: only the chip, the sheet and the strip take pointer events.
 */

import { cn } from '@/lib/utils';
import { useRideHudStore } from '@/stores/rideHudStore';
import { RideChip } from './RideChip';
import { RideDevicesSheet } from './RideDevicesSheet';
import { ShowRideStrip } from './ShowRideStrip';

export function ShowHud({ dimmed, className }: { dimmed: boolean; className?: string }) {
  const devicesOpen = useRideHudStore((s) => s.devicesOpen);
  return (
    <div
      data-testid="show-hud"
      className={cn(
        'pointer-events-none absolute hud-inset-b show-inset-l show-inset-r z-20 flex flex-col gap-2 sm:left-auto sm:items-end',
        // A tall devices sheet scrolls inside the screen (as in RideHud).
        devicesOpen && 'show-inset-t justify-end',
        className,
      )}
    >
      {devicesOpen && <RideDevicesSheet className="sm:w-96" />}
      <RideChip alertsOnly className="shrink-0 self-start sm:self-end" />
      <ShowRideStrip dimmed={dimmed} className="shrink-0" />
    </div>
  );
}
