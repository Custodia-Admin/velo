/**
 * Pace partners picker (Home → Build your own ride, step 3): up to
 * MAX_PARTNERS AI riders who ride the route with you. Each tile toggles a
 * real PaceBot in rideStore.paceBots (pacePartners.togglePartner); what
 * shows as picked is read back from the store, so it can't drift from what
 * rides. Design gate: docs/design/UI-RULES.md, mockup + compare in PR #37.
 */
import { Check, Flame, Gauge, TrendingUp, Zap } from 'lucide-react';
import type { Personality } from '@/lib/paceBots';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useRideStore } from '@/stores/rideStore';
import { MAX_PARTNERS, PARTNERS, partnersStatus, pickedPartnerIds, togglePartner } from './pacePartners';

const ICON: Record<Personality, typeof Gauge> = {
  steady: Gauge,
  climber: TrendingUp,
  sprinter: Zap,
  attacker: Flame,
};

export function PacePartners({ className }: { className?: string }) {
  const paceBots = useRideStore((s) => s.paceBots);
  const setPaceBots = useRideStore((s) => s.setPaceBots);
  const picked = pickedPartnerIds(paceBots);
  const full = paceBots.length >= MAX_PARTNERS;

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <p className="max-w-prose text-sm text-muted-foreground">
        AI riders on the route with you, up to {MAX_PARTNERS}. Ride close behind one to draft.
      </p>

      <div role="group" aria-label="Pace partner selection" className="grid gap-2 sm:grid-cols-2">
        {PARTNERS.map((p) => {
          const on = picked.has(p.id);
          const Icon = ICON[p.personality];
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={on}
              disabled={!on && full}
              data-partner={p.id}
              onClick={() => {
                const { paceBots: bots, route } = useRideStore.getState();
                setPaceBots(togglePartner(bots, p.id, route));
              }}
              className={cn(
                'flex min-h-16 items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors duration-150',
                'disabled:cursor-not-allowed disabled:opacity-60',
                on ? 'border-primary bg-primary/10' : 'border-border bg-card hover:border-primary/40',
              )}
            >
              <Icon className={cn('h-5 w-5 shrink-0', on ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold text-foreground">{p.name}</span>
                <span className="block text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{p.style}</span> · {p.blurb}
                </span>
              </span>
              <span
                aria-hidden
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border-2',
                  on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground',
                )}
              >
                {on && <Check className="h-4 w-4" />}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex min-h-10 flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground" aria-live="polite" aria-atomic="true" data-partners-status>
          {partnersStatus(paceBots.length)}
        </span>
        {paceBots.length > 0 && (
          <Button variant="outline" onClick={() => setPaceBots([])}>
            Remove partners
          </Button>
        )}
      </div>
    </div>
  );
}
