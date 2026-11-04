/**
 * In-ride devices sheet (compact ride HUD, owner-directed revision 2 Nov
 * 2026): the status chip opens it, so a dropped trainer or locked controls
 * never put a large red box on the ride. The same rows as the Devices
 * screen (/devices): trainer, handlebar controls, heart-rate strap, each
 * with its one action. Sits in the ride details column above the band (it
 * takes the details' place while open), closes on its button, a second
 * chip tap or Escape.
 */

import { useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { detectBluetoothSupport } from '@/lib/bluetoothSupport';
import { useRideHudStore } from '@/stores/rideHudStore';
import { DEVICE_PANEL } from './DeviceRow';
import { TrainerRow } from './TrainerPanel';
import { HandlebarRow } from './ControllerPanel';
import { HeartRateRow } from './HeartRateRow';
import { KICKER } from './v2';

/** Mounted by RideHud only while `devicesOpen`. */
export function RideDevicesSheet({ className }: { className?: string }) {
  const setOpen = useRideHudStore((s) => s.setDevicesOpen);
  const titleId = useId();
  const [canPair] = useState(() => {
    const bt = detectBluetoothSupport();
    return bt.apiPresent && bt.secureContext;
  });

  // Escape closes the sheet and stops there: on the window it is the ride's
  // pause / finish shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setOpen]);

  return (
    <section
      id="ride-devices-sheet"
      aria-labelledby={titleId}
      className={cn(DEVICE_PANEL, 'pointer-events-auto min-h-0 overflow-y-auto animate-scaleIn text-foreground', className)}
      data-testid="ride-devices-sheet"
    >
      <div className="flex items-center justify-between gap-3 py-1 pl-4 pr-1">
        <h2 id={titleId} className={KICKER}>
          Devices
        </h2>
        <Button variant="quiet" size="icon" aria-label="Close devices" onClick={() => setOpen(false)}>
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      <TrainerRow />
      {canPair && <HandlebarRow />}
      {canPair && <HeartRateRow />}
    </section>
  );
}
