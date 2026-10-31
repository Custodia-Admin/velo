/**
 * Show mode's ride strip: the four numbers that matter while you watch
 * something (time, distance, speed, power). Replaces the full HUD.
 */

import { cn, formatDuration } from '@/lib/utils';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="num text-2xl font-bold leading-none text-foreground lg:text-3xl">{value}</span>
      <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground lg:text-sm">
        {label}
      </span>
    </div>
  );
}

export function ShowRideStrip({ dimmed, className }: { dimmed: boolean; className?: string }) {
  const elapsedMs = useRideStore((s) => s.elapsedMs);
  const distance = useRideStore((s) => s.distance);
  const total = useRideStore((s) => s.route?.totalDistance ?? 0);
  const speed = useRideStore((s) => s.speed);
  const power = useRideStore((s) => s.power);
  const imperial = useSettingsStore((s) => s.units) === 'imperial';

  const perUnit = imperial ? 1609.344 : 1000;
  const unit = imperial ? 'mi' : 'km';
  const speedValue = imperial ? speed * 2.236936 : speed * 3.6;

  return (
    <section
      aria-label="Ride stats"
      data-testid="show-ride-strip"
      className={cn(
        'glass glass-hairline flex items-end justify-between gap-4 rounded-lg px-4 py-3 transition-opacity duration-300 sm:justify-start sm:gap-8 sm:px-6',
        dimmed && 'opacity-70',
        className,
      )}
    >
      <Figure value={formatDuration(elapsedMs / 1000)} label="Time" />
      <Figure
        value={(distance / perUnit).toFixed(1)}
        label={total > 0 ? `of ${(total / perUnit).toFixed(1)} ${unit}` : unit}
      />
      <Figure value={speedValue.toFixed(1)} label={imperial ? 'mph' : 'km/h'} />
      <Figure value={String(Math.round(power))} label="Watts" />
    </section>
  );
}
