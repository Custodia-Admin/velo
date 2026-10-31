/**
 * Who's riding + how hard the hills feel. The rider switch swaps every
 * per-rider setting (weight, FTP, gear, comfort) via riderRosterStore.
 */

import { useId, useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useRiderRosterStore, MAX_NAME_LENGTH, type RosterRider } from '@/stores/riderRosterStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { difficultyLabel } from '@/lib/trainerComfort';
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
        'inline-flex h-12 items-center gap-3 rounded-pill border pl-2 pr-5 text-base font-semibold transition-colors duration-150',
        active
          ? 'border-primary bg-primary/10 text-foreground'
          : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold',
          active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
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

export function RiderPanel() {
  const riders = useRiderRosterStore((s) => s.riders);
  const activeRiderId = useRiderRosterStore((s) => s.activeRiderId);
  const switchRider = useRiderRosterStore((s) => s.switchRider);
  const difficulty = useSettingsStore((s) => s.trainerDifficulty);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const [renaming, setRenaming] = useState(false);
  const sliderId = useId();

  const active = riders.find((r) => r.id === activeRiderId) ?? riders[0];
  const pct = Math.round(difficulty * 100);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label="Who's riding" className="flex flex-wrap gap-3">
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
            aria-label={`Rename ${active.name}`}
            onClick={() => setRenaming(true)}
          >
            <Pencil className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div className="flex max-w-xl flex-wrap items-center gap-x-4 gap-y-2">
        <label htmlFor={sliderId} className="text-sm font-semibold text-foreground">
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

      <PlayModeSwitch />
    </div>
  );
}
