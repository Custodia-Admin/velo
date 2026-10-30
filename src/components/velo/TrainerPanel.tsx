/**
 * Trainer pairing plus the ERG (fixed power) switch for the active rider.
 * Pairing itself is the existing TrainerConnect flow, unchanged. The optional
 * handlebar controls pair separately and never touch the trainer link.
 */

import { useId } from 'react';
import { TrainerConnect } from '@/components/trainer/TrainerConnect';
import { ControllerPanel } from '@/components/velo/ControllerPanel';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settingsStore';

export function ErgSwitch() {
  const ergEnabled = useSettingsStore((s) => s.ergEnabled);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const labelId = useId();
  const hintId = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col gap-1">
        <span id={labelId} className="text-sm font-semibold text-foreground">
          Fixed power (ERG) in workouts
        </span>
        <span id={hintId} className="text-sm text-muted-foreground">
          {ergEnabled
            ? 'Workouts hold the trainer at their target power.'
            : 'Off: workout targets are a guide, the trainer follows the road.'}
        </span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={ergEnabled}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        onClick={() => setSettings({ ergEnabled: !ergEnabled })}
        className={cn(
          'relative inline-flex h-10 w-16 shrink-0 items-center rounded-pill border transition-colors duration-150',
          ergEnabled ? 'border-primary bg-primary' : 'border-muted-foreground/50 bg-muted',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'absolute h-8 w-8 rounded-full shadow-sm transition-transform duration-150',
            ergEnabled ? 'translate-x-7 bg-primary-foreground' : 'translate-x-1 bg-muted-foreground',
          )}
        />
      </button>
    </div>
  );
}

/** Separator + handlebar controls; empty (no stray border) without Web Bluetooth. */
function ControllerSlot() {
  return (
    <div className="border-t border-border pt-4 empty:hidden">
      <ControllerPanel />
    </div>
  );
}

export function TrainerPanel() {
  return (
    <section
      aria-labelledby="trainer-panel-title"
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:p-6"
    >
      <h2 id="trainer-panel-title" className="text-lg font-semibold text-foreground">
        Trainer
      </h2>
      <TrainerConnect />
      <div className="border-t border-border pt-4">
        <ErgSwitch />
      </div>
      <ControllerSlot />
    </section>
  );
}
