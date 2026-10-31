/**
 * Wind feel (per rider) sits under "Hills feel" in the rider panel: together
 * they are how a ride feels. Live weather on/off (household, rarely changed)
 * sits in the Trainer and weather panel, laid out like the ERG switch.
 */

import { useId } from 'react';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settingsStore';
import { WIND_FEELS, type WindFeel } from '@/lib/meteo/windFeel';
import { Switch } from '@/components/velo/Switch';

const FEEL_TEXT: Record<WindFeel, { label: string; hint: string }> = {
  off: { label: 'Off', hint: 'Wind is only scenery.' },
  subtle: { label: 'Subtle', hint: 'A headwind adds a little resistance.' },
  real: { label: 'Real', hint: 'Headwinds push back like outdoors.' },
};

export function WindFeelPicker() {
  const windFeel = useSettingsStore((s) => s.windFeel);
  const liveWeather = useSettingsStore((s) => s.liveWeatherEnabled);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const labelId = useId();
  const hintId = useId();
  const hint = liveWeather ? FEEL_TEXT[windFeel].hint : 'Live weather is off, so there is no wind.';

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <span id={labelId} className="w-24 text-sm font-semibold text-foreground">
        Wind feel
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={hintId}
        className="flex gap-2"
      >
        {WIND_FEELS.map((feel) => {
          const active = feel === windFeel;
          return (
            <button
              key={feel}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={!liveWeather}
              onClick={() => setSettings({ windFeel: feel })}
              className={cn(
                'h-10 rounded-pill border px-4 text-sm font-semibold transition-colors duration-150 disabled:opacity-40',
                active
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground',
              )}
            >
              {FEEL_TEXT[feel].label}
            </button>
          );
        })}
      </div>
      <span id={hintId} className="text-sm text-muted-foreground">
        {hint}
      </span>
    </div>
  );
}

export function LiveWeatherSwitch() {
  const enabled = useSettingsStore((s) => s.liveWeatherEnabled);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const labelId = useId();
  const hintId = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col gap-1">
        <span id={labelId} className="text-sm font-semibold text-foreground">
          Live weather
        </span>
        <span id={hintId} className="text-sm text-muted-foreground">
          {enabled
            ? 'Sky, rain, fog and wind follow today’s forecast at each route.'
            : 'Off: every route keeps its usual look and no wind.'}
        </span>
      </div>
      <Switch
        checked={enabled}
        onChange={(next) => setSettings({ liveWeatherEnabled: next })}
        labelledBy={labelId}
        describedBy={hintId}
      />
    </div>
  );
}
