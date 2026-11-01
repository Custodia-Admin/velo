/**
 * Who's riding (the rider pills beside the Home title) and how a ride feels
 * (the comfort line under Today's ride, with its Change panel). The rider
 * switch swaps every per-rider setting (weight, FTP, gear, comfort) via
 * riderRosterStore.
 */

import { useId, useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useRiderRosterStore, MAX_NAME_LENGTH, type RosterRider } from '@/stores/riderRosterStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { difficultyLabel } from '@/lib/trainerComfort';
import { LiveWeatherSwitch, WindFeelPicker } from '@/components/velo/WeatherControls';
import { PlayModeSwitch } from '@/components/velo/PlayMode';

function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

function RiderChip({
  rider,
  active,
  onSelect,
}: {
  rider: RosterRider;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        'inline-flex h-10 items-center gap-2 rounded-pill border pl-1 pr-4 text-sm font-semibold text-foreground transition-colors duration-150',
        active ? 'border-primary bg-primary/10' : 'border-border bg-card hover:border-primary/40',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold',
          active ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
        )}
      >
        {initial(rider.name)}
      </span>
      {rider.name}
    </button>
  );
}

function RenameForm({ rider, onDone }: { rider: RosterRider; onDone: () => void }) {
  const renameRider = useRiderRosterStore((s) => s.renameRider);
  const [value, setValue] = useState(rider.name);
  const inputId = useId();
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        renameRider(rider.id, value);
        onDone();
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        Rider name
      </label>
      <input
        id={inputId}
        value={value}
        maxLength={MAX_NAME_LENGTH}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDone();
        }}
        // Focus is the point of opening the rename form.
        autoFocus
        className="h-10 w-48 rounded-md border border-border bg-card px-3 text-base text-foreground"
      />
      <Button type="submit" size="icon" variant="outline" aria-label="Save name">
        <Check className="h-4 w-4" />
      </Button>
      <Button type="button" size="icon" variant="ghost" aria-label="Cancel rename" onClick={onDone}>
        <X className="h-4 w-4" />
      </Button>
    </form>
  );
}

/** Rider pills ("Who's riding") + rename. */
export function RiderSwitch({ className }: { className?: string }) {
  const riders = useRiderRosterStore((s) => s.riders);
  const activeRiderId = useRiderRosterStore((s) => s.activeRiderId);
  const switchRider = useRiderRosterStore((s) => s.switchRider);
  const [renaming, setRenaming] = useState(false);

  const active = riders.find((r) => r.id === activeRiderId) ?? riders[0];

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <div role="radiogroup" aria-label="Who's riding" className="flex flex-wrap gap-2">
        {riders.map((r) => (
          <RiderChip
            key={r.id}
            rider={r}
            active={r.id === activeRiderId}
            onSelect={() => {
              setRenaming(false);
              switchRider(r.id);
            }}
          />
        ))}
      </div>
      {renaming ? (
        <RenameForm rider={active} onDone={() => setRenaming(false)} />
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground"
          aria-label={`Rename ${active.name}`}
          onClick={() => setRenaming(true)}
        >
          <Pencil className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

/** Hills feel slider (per rider). */
function HillsFeelSlider() {
  const difficulty = useSettingsStore((s) => s.trainerDifficulty);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const sliderId = useId();
  const pct = Math.round(difficulty * 100);
  return (
    <div className="flex max-w-xl flex-wrap items-center gap-x-4 gap-y-2">
      <label htmlFor={sliderId} className="w-24 text-sm font-semibold text-foreground">
        Hills feel
      </label>
      <input
        id={sliderId}
        type="range"
        min={0}
        max={100}
        step={5}
        value={pct}
        onChange={(e) => setSettings({ trainerDifficulty: Number(e.target.value) / 100 })}
        aria-valuetext={`${pct}%, ${difficultyLabel(difficulty)}`}
        className="h-10 min-w-0 flex-1 basis-48"
      />
      <span className="num w-28 text-sm text-muted-foreground" aria-hidden>
        {pct}% · {difficultyLabel(difficulty)}
      </span>
    </div>
  );
}

/**
 * The comfort line: "Hills feel 35 % · easy · Wind feel subtle  Change".
 * Change opens the controls inline (closed by default).
 */
export function ComfortControls({ className }: { className?: string }) {
  const difficulty = useSettingsStore((s) => s.trainerDifficulty);
  const windFeel = useSettingsStore((s) => s.windFeel);
  const liveWeather = useSettingsStore((s) => s.liveWeatherEnabled);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const pct = Math.round(difficulty * 100);

  return (
    <div className={className}>
      <p className="flex flex-wrap items-center gap-3 text-sm text-foreground">
        <span>
          Hills feel <b className="num font-semibold">{pct} %</b> · {difficultyLabel(difficulty)}
        </span>
        <span className="text-muted-foreground" aria-hidden>
          ·
        </span>
        <span>
          Wind feel <b className="font-semibold">{liveWeather ? windFeel : 'off'}</b>
        </span>
        <Button
          variant="textlink"
          className="px-2"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
        >
          Change
        </Button>
      </p>
      {open && (
        <div
          id={panelId}
          className="mt-3 flex flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:p-6"
        >
          <HillsFeelSlider />
          <WindFeelPicker />
          <div className="border-t border-border pt-4">
            <LiveWeatherSwitch />
          </div>
          <div className="border-t border-border pt-4">
            <PlayModeSwitch />
          </div>
        </div>
      )}
    </div>
  );
}

/** Rider switch + comfort controls together (legacy layout; Home uses the two parts). */
export function RiderPanel() {
  return (
    <div className="flex flex-col gap-4">
      <RiderSwitch />
      <ComfortControls />
    </div>
  );
}
