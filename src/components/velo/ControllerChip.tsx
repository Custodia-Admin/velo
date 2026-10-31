/**
 * In-ride readout for the handlebar controls: current gear and how hard the
 * hills feel. Only shown while controls are paired.
 */

import { Card } from '@/components/ui/card';
import { GEAR_COUNT, NEUTRAL_GEAR } from '@/lib/virtualGears';
import { useControllerStore } from '@/stores/controllerStore';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';

function Figure({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className="num text-2xl font-bold leading-none text-foreground">
        {value}
        <span className="text-sm font-semibold text-muted-foreground">{unit}</span>
      </span>
    </div>
  );
}

export function ControllerChip() {
  const status = useControllerStore((s) => s.status);
  const gear = useControllerStore((s) => s.gear);
  const battery = useControllerStore((s) => s.battery);
  const difficulty = useSettingsStore((s) => s.trainerDifficulty);
  const erg = useRideStore((s) => s.trainerControlMode === 'erg');

  if (status !== 'connected' && status !== 'reconnecting' && status !== 'asleep') return null;

  const note =
    status === 'reconnecting'
      ? 'Reconnecting the controls'
      : status === 'asleep'
        ? 'Controls asleep · gears neutral'
        : battery !== null && battery <= 20
          ? `Controls battery ${battery} %`
          : null;

  return (
    <Card className="pointer-events-auto flex flex-col gap-2 px-4 py-3" role="group" aria-label="Handlebar controls">
      <div className="flex items-end gap-6">
        {erg ? (
          <Figure label="Gear" value="–" unit=" ERG" />
        ) : (
          <Figure label="Gear" value={String(status === 'asleep' ? NEUTRAL_GEAR : gear)} unit={`/${GEAR_COUNT}`} />
        )}
        <Figure label="Hills" value={String(Math.round(difficulty * 100))} unit="%" />
      </div>
      {note && (
        <span className="text-sm font-semibold text-foreground" role="status">
          {note}
        </span>
      )}
    </Card>
  );
}
