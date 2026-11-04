/**
 * Battery level of a paired device (handlebar controls, trainer), read from
 * the standard Battery Service. Icon + "76 %", as in the v2 Devices mockup
 * (docs/design/mockups/v2-devices.html). Low (≤ 20 %) turns destructive and
 * says so in its accessible name.
 */

import { BatteryFull, BatteryLow, BatteryMedium } from 'lucide-react';
import { cn } from '@/lib/utils';
import { batteryBand, batteryLabel, formatBattery } from '@/lib/controllers/battery';

const ICON = { low: BatteryLow, medium: BatteryMedium, full: BatteryFull } as const;

export function BatteryReading({ pct, className }: { pct: number; className?: string }) {
  const band = batteryBand(pct);
  const Icon = ICON[band];
  return (
    <span
      role="img"
      aria-label={batteryLabel(pct)}
      data-testid="battery-reading"
      data-band={band}
      className={cn(
        'num inline-flex shrink-0 items-center gap-1 text-sm',
        band === 'low' ? 'font-semibold text-destructive' : 'text-muted-foreground',
        className,
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
      {formatBattery(pct)}
    </span>
  );
}
