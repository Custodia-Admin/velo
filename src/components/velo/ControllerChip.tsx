/**
 * In-ride readout for the handlebar controls: whether presses can arrive at
 * all (state + battery), the current gear and how hard the hills feel, and
 * one action when something needs fixing (pair the left unit, reconnect).
 * Shown whenever this browser can pair the controls.
 */

import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { HUD_PANEL } from './v2';
import { GEAR_COUNT, NEUTRAL_GEAR } from '@/lib/virtualGears';
import {
  isRideControllerSupported,
  pairRideController,
  reconnectRideController,
} from '@/lib/controllers/rideController';
import {
  UNLOCK_ONE_LINE,
  chipView,
  controllerPhase,
  type ChipTone,
} from '@/lib/controllers/controllerView';
import { useControllerStore } from '@/stores/controllerStore';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';

const noopSubscribe = () => () => undefined;

const DOT: Record<ChipTone, string> = {
  ok: 'bg-accent',
  busy: 'bg-primary animate-pulse',
  warn: 'bg-destructive',
  off: 'bg-muted-foreground',
};

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
  const supported = useSyncExternalStore(noopSubscribe, isRideControllerSupported, () => false);
  const status = useControllerStore((s) => s.status);
  const silent = useControllerStore((s) => s.silent);
  const side = useControllerStore((s) => s.side);
  const inputSeen = useControllerStore((s) => s.inputSeen);
  const gear = useControllerStore((s) => s.gear);
  const battery = useControllerStore((s) => s.battery);
  const difficulty = useSettingsStore((s) => s.trainerDifficulty);
  const erg = useRideStore((s) => s.trainerControlMode === 'erg');

  if (!supported) return null;

  const phase = controllerPhase({ status, silent, side, inputSeen });
  const view = chipView(phase, battery);
  const gearLive = status === 'connected' || status === 'reconnecting';

  const act = () => {
    if (view.action === 'reconnect') void reconnectRideController();
    else if (view.action) void pairRideController();
  };

  return (
    <div
      className={cn(HUD_PANEL, 'pointer-events-auto flex max-w-sm flex-col gap-2 px-4 py-3')}
      role="group"
      aria-label="Handlebar controls"
    >
      <span className="inline-flex items-center gap-2 text-sm font-semibold text-foreground" role="status">
        <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', DOT[view.tone])} />
        {view.label}
      </span>
      {view.figures && (
        <div className="flex items-end gap-6">
          {erg ? (
            <Figure label="Gear" value="–" unit=" ERG" />
          ) : (
            <Figure label="Gear" value={String(gearLive ? gear : NEUTRAL_GEAR)} unit={`/${GEAR_COUNT}`} />
          )}
          <Figure label="Hills" value={String(Math.round(difficulty * 100))} unit="%" />
        </div>
      )}
      {view.note && <p className="text-sm text-foreground">{view.note}</p>}
      {view.unlock && (
        <details className="text-sm">
          <summary className="flex h-10 cursor-pointer items-center font-semibold text-foreground">How to unlock</summary>
          <p className="max-w-prose text-sm text-foreground">{UNLOCK_ONE_LINE}</p>
        </details>
      )}
      {view.action && (
        <Button variant="outline" className="self-start" onClick={act}>
          {view.actionLabel}
        </Button>
      )}
    </div>
  );
}
