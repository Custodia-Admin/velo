/**
 * The couple ghost on the setup step (Build your own ride, step 3): ride
 * against the other rider's last ride on this route, their best, or no
 * ghost. Rides come from ride history (lib/play/coupleGhost); the pick is
 * coupleGhostStore.choice, which the world renderer reads when the ride
 * starts. Only offered for routes the world renderer draws (the ghost rides
 * there). Design gate: docs/design/UI-RULES.md, mockup p3.2-play-layer.html.
 */
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { CircleSlash, History, Trophy } from 'lucide-react';

import { coupleGhostOptions, type CoupleGhostChoice, type CoupleGhostOptions } from '@/lib/play/coupleGhost';
import { otherRider } from '@/lib/play/otherRider';
import { listRides } from '@/lib/rideHistory';
import { cn } from '@/lib/utils';
import { worldForRoute } from '@/lib/world/catalog';
import { useCoupleGhostStore } from '@/stores/coupleGhostStore';
import { useRideStore } from '@/stores/rideStore';
import { useRiderRosterStore } from '@/stores/riderRosterStore';
import type { Route } from '@/types';
import { ghostTiles, pickedTile, type GhostTile } from './coupleGhostText';

export type GhostOfferStatus = 'alone' | 'no-route' | 'not-world' | 'loading' | 'no-rides' | 'ready';

export interface CoupleGhostOffer {
  status: GhostOfferStatus;
  /** The other rider's name ('' with no other rider). */
  name: string;
  routeName: string;
  tiles: GhostTile[];
  picked: CoupleGhostChoice;
  /** The name of the ghost that will ride, or null. */
  riding: string | null;
}

/** What the setup step can offer for `route`, given the other rider's rides and the pick. */
export function ghostOffer(
  route: Pick<Route, 'name'> | null,
  hasWorld: boolean,
  name: string | null,
  options: CoupleGhostOptions | null,
  choice: CoupleGhostChoice,
): CoupleGhostOffer {
  const base = { name: name ?? '', routeName: route?.name ?? '', tiles: [] as GhostTile[], picked: choice, riding: null };
  if (!name) return { ...base, status: 'alone' };
  if (!route) return { ...base, status: 'no-route' };
  if (!hasWorld) return { ...base, status: 'not-world' };
  if (!options) return { ...base, status: 'loading' };
  const tiles = ghostTiles(options, name);
  if (tiles.length === 0) return { ...base, status: 'no-rides' };
  const picked = pickedTile(tiles, choice);
  return { ...base, status: 'ready', tiles, picked, riding: picked === 'off' ? null : name };
}

/** The offer for the route in the ride store, kept up to date with ride history and the pick. */
export function useCoupleGhostOffer(): CoupleGhostOffer {
  const route = useRideStore((s) => s.route);
  const choice = useCoupleGhostStore((s) => s.choice);
  // Re-read when the roster changes (rename, switch rider).
  const rosterKey = useRiderRosterStore((s) => `${s.activeRiderId}|${s.riders.map((r) => r.name).join('|')}`);
  const other = otherRider();
  const hasWorld = route ? worldForRoute(route) !== null : false;
  const [loaded, setLoaded] = useState<{ key: string; options: CoupleGhostOptions } | null>(null);
  const key = route && other && hasWorld ? `${route.id}|${other.id}|${rosterKey}` : '';

  useEffect(() => {
    if (!key || !route || !other) return;
    let cancelled = false;
    listRides()
      .then((records) => {
        if (!cancelled) setLoaded({ key, options: coupleGhostOptions(records, route, other.id) });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key, options: { last: null, best: null } });
      });
    return () => {
      cancelled = true;
    };
    // `route` and `other` are captured with `key`, which names them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const options = loaded && loaded.key === key ? loaded.options : null;
  return ghostOffer(route, hasWorld, other?.name ?? null, options, choice);
}

const ICON: Record<CoupleGhostChoice, typeof History> = { last: History, best: Trophy, off: CircleSlash };

/** Sub-heading shared with the pace partners below it (step 3). */
export const SECTION_LABEL = 'text-sm font-semibold text-foreground';

export function CoupleGhostPicker({ offer, className }: { offer: CoupleGhostOffer; className?: string }) {
  const setChoice = useCoupleGhostStore((s) => s.setChoice);
  const labelId = useId();
  const { status, name, tiles, picked } = offer;
  if (status === 'alone' || status === 'not-world' || status === 'loading') return null;

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = tiles[(i + step + tiles.length) % tiles.length];
    setChoice(next.choice);
    const group = e.currentTarget.parentElement;
    (group?.querySelector(`[data-ghost-choice="${next.choice}"]`) as HTMLButtonElement | null)?.focus();
  };

  return (
    <section aria-labelledby={labelId} className={cn('flex flex-col gap-1', className)} data-couple-ghost={status}>
      <h3 id={labelId} className={SECTION_LABEL}>
        {name}&apos;s ghost
      </h3>
      {status === 'no-route' && (
        <p className="max-w-prose text-sm text-muted-foreground">Pick a route first, then you can ride against {name}&apos;s ride on it.</p>
      )}
      {status === 'no-rides' && (
        <p className="max-w-prose text-sm text-muted-foreground">
          No ride by {name} on {offer.routeName} yet. Once there is one, you can ride against it here.
        </p>
      )}
      {status === 'ready' && (
        <>
          <p className="max-w-prose text-sm text-muted-foreground">Ride against a replay of {name}&apos;s ride on this route.</p>
          <div role="radiogroup" aria-labelledby={labelId} className={cn('mt-3 grid gap-2', tiles.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
            {tiles.map((t, i) => {
              const on = t.choice === picked;
              const Icon = ICON[t.choice];
              return (
                <button
                  key={t.choice}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  data-ghost-choice={t.choice}
                  onClick={() => setChoice(t.choice)}
                  onKeyDown={(e) => onKey(e, i)}
                  className={cn(
                    'flex min-h-16 items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors duration-150',
                    on ? 'border-primary bg-primary/10' : 'border-border bg-card hover:border-primary/40',
                  )}
                >
                  <Icon className={cn('h-5 w-5 shrink-0', on ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-semibold text-foreground">{t.title}</span>
                    <span className="num block text-sm text-muted-foreground">{t.meta}</span>
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2',
                      on ? 'border-primary' : 'border-muted-foreground',
                    )}
                  >
                    {on && <span className="h-3 w-3 rounded-full bg-primary" />}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
