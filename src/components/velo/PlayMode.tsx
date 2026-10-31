/**
 * Play mode UI: the Home switch, the in-ride panel and the finish-card line.
 *
 * The panel is one glanceable card: postcard count as the figure, and a
 * single note line that briefly says "Postcard N collected" after a pickup,
 * otherwise how far the next one is. The buddy line sits under it.
 */

import { useEffect, useId, useState } from 'react';
import { Mail, Users } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { playAchievementSound } from '@/lib/rideAudio';
import { useSettingsStore } from '@/stores/settingsStore';
import { useRiderRosterStore } from '@/stores/riderRosterStore';
import { usePlayStore } from '@/stores/playStore';
import { useAudioStore } from '@/stores/audioStore';

/** How long the "collected" note stays up, ms. */
export const PICKUP_NOTE_MS = 6000;

export function PlayModeSwitch() {
  const playMode = useSettingsStore((s) => s.playMode);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const buddyName = useRiderRosterStore(
    (s) => s.riders.find((r) => r.id !== s.activeRiderId)?.name ?? null,
  );
  const labelId = useId();
  const hintId = useId();
  const withBuddy = buddyName ? `, and ${buddyName} rides beside you` : '';
  return (
    <div className="flex max-w-xl items-center justify-between gap-4">
      <div className="flex flex-col gap-1">
        <span id={labelId} className="text-sm font-semibold text-foreground">
          Play mode
        </span>
        <span id={hintId} className="text-sm text-muted-foreground">
          {playMode ? `Postcards to collect on the road${withBuddy}.` : 'Off: just you and the view.'}
        </span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={playMode}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        onClick={() => setSettings({ playMode: !playMode })}
        className={cn(
          'relative inline-flex h-10 w-16 shrink-0 items-center rounded-pill border transition-colors duration-150',
          playMode ? 'border-primary bg-primary' : 'border-muted-foreground/50 bg-muted',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'absolute h-8 w-8 rounded-full shadow-sm transition-transform duration-150',
            playMode ? 'translate-x-7 bg-primary-foreground' : 'translate-x-1 bg-muted-foreground',
          )}
        />
      </button>
    </div>
  );
}

/** "400 m" / "1.2 km", or miles for imperial riders. */
export function formatNextDistance(m: number, units: string): string {
  if (units === 'imperial') return `${(m / 1609.344).toFixed(1)} mi`;
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/** True for PICKUP_NOTE_MS after each pickup. Chimes when ride sound is on. */
function useRecentPickup(): boolean {
  const lastPickupAt = usePlayStore((s) => s.lastPickupAt);
  const [recent, setRecent] = useState(false);
  useEffect(() => {
    if (!lastPickupAt) {
      setRecent(false);
      return;
    }
    setRecent(true);
    if (useAudioStore.getState().enabled) playAchievementSound();
    const t = setTimeout(() => setRecent(false), PICKUP_NOTE_MS);
    return () => clearTimeout(t);
  }, [lastPickupAt]);
  return recent;
}

export function PlayPanel({ className, compact = false }: { className?: string; compact?: boolean }) {
  const active = usePlayStore((s) => s.active);
  const total = usePlayStore((s) => s.total);
  const collected = usePlayStore((s) => s.collected);
  const toNextM = usePlayStore((s) => s.toNextM);
  const buddyLine = usePlayStore((s) => s.buddyLine);
  const units = useSettingsStore((s) => s.units);
  const recent = useRecentPickup();

  if (!active || total === 0) return null;

  const note = recent
    ? `Postcard ${collected} collected`
    : toNextM === null
      ? 'All postcards collected'
      : `Next one in ${formatNextDistance(toNextM, units)}`;

  const count = (
    <span className="num shrink-0 text-2xl font-bold text-foreground">
      {collected} <span className="text-base font-medium">of {total}</span>
    </span>
  );

  // Phones: one row, so the mobile HUD stack doesn't run into the ride
  // controls. The buddy is visible in the scene; their line is dropped here.
  if (compact) {
    return (
      <Card className={cn('pointer-events-auto px-4 py-2', className)}>
        <section aria-label="Play mode" className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <Mail className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
            <span
              aria-live="polite"
              className={cn('text-sm font-medium', recent ? 'text-accent' : 'text-foreground')}
            >
              {note}
            </span>
          </span>
          {count}
        </section>
      </Card>
    );
  }

  return (
    <Card className={cn('pointer-events-auto flex flex-col gap-2 p-4', className)}>
      <section aria-label="Play mode" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            <Mail className="h-4 w-4 text-accent" aria-hidden="true" />
            Postcards
          </span>
          {count}
        </div>
        <p
          aria-live="polite"
          className={cn('text-base font-medium', recent ? 'text-accent' : 'text-foreground')}
        >
          {note}
        </p>
        {buddyLine && (
          <p className="flex items-center gap-2 text-base text-foreground">
            <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {buddyLine}
          </p>
        )}
      </section>
    </Card>
  );
}

/** Finish-card line: how many postcards this ride collected. */
export function PlayFinishLine() {
  const total = usePlayStore((s) => s.total);
  const collected = usePlayStore((s) => s.collected);
  if (total === 0) return null;
  return (
    <Card className="flex items-center justify-between gap-3 p-4">
      <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Mail className="h-4 w-4 text-accent" aria-hidden="true" />
        Postcards
      </span>
      <span className="num text-2xl font-bold text-foreground">
        {collected} <span className="text-base font-medium">of {total}</span>
      </span>
    </Card>
  );
}
