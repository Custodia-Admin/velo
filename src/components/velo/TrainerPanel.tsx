/**
 * Trainer pairing, the ERG (fixed power) switch for the active rider, and the
 * household Live weather switch (sky and wind from the forecast).
 * Pairing itself is the existing TrainerConnect flow, unchanged.
 */

import { useId } from 'react';
import { TrainerConnect } from '@/components/trainer/TrainerConnect';
import { Switch } from '@/components/velo/Switch';
import { LiveWeatherSwitch } from '@/components/velo/WeatherControls';
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
      <Switch
        checked={ergEnabled}
        onChange={(next) => setSettings({ ergEnabled: next })}
        labelledBy={labelId}
        describedBy={hintId}
      />
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
        Trainer and weather
      </h2>
      <TrainerConnect />
      <div className="border-t border-border pt-4">
        <ErgSwitch />
      </div>
      <div className="border-t border-border pt-4">
        <LiveWeatherSwitch />
      </div>
    </section>
  );
}
