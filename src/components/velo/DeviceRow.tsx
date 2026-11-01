/**
 * One row of a Devices panel: glyph | name + state | one action, with a
 * hairline between rows (the panel draws it). Below sm the action drops
 * under the text. Renders a RowView from devicesView; the caller maps the
 * action ids to the real lib calls.
 */

import type { ReactNode } from 'react';
import { AlertCircle, BatteryMedium, Loader2, RefreshCw, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { RowAction, RowView } from '@/components/velo/devicesView';

/** Panel shell shared by the device rows and the Options rows. */
export const DEVICE_PANEL = 'rounded-lg border border-border bg-card divide-y divide-border';

/** Padding for a panel row (Options rows reuse it). */
export const ROW_PAD = 'p-4 sm:px-5';

export function StateDot({ tone }: { tone: RowView<string>['tone'] }) {
  if (tone === 'idle' || tone === 'error') return null;
  return (
    <span
      aria-hidden
      className={cn(
        'h-2 w-2 shrink-0 rounded-full',
        tone === 'ok' && 'bg-primary',
        tone === 'busy' && 'animate-pulse bg-primary',
        tone === 'warn' && 'bg-destructive',
      )}
    />
  );
}

export function Battery({ pct, label }: { pct: number; label: string }) {
  return (
    <span className="num inline-flex items-center gap-1" aria-label={`${label} battery: ${pct} %`}>
      <BatteryMedium className="h-4 w-4" aria-hidden />
      {pct} %
    </span>
  );
}

function ActionButton<A extends string>({
  action,
  variant,
  onAction,
  className,
}: {
  action: RowAction<A>;
  variant: 'outline' | 'quiet' | 'textlink';
  onAction: (id: A) => void;
  className?: string;
}) {
  const retry = action.label === 'Try again';
  return (
    <Button
      variant={variant}
      className={className}
      disabled={action.busy || action.disabled}
      aria-busy={action.busy || undefined}
      aria-label={action.ariaLabel}
      onClick={() => onAction(action.id)}
    >
      {action.busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {retry && variant === 'outline' && <RefreshCw className="h-4 w-4" aria-hidden />}
      {action.label}
    </Button>
  );
}

export interface DeviceRowProps<A extends string> {
  icon: LucideIcon;
  view: RowView<A>;
  onAction: (id: A) => void;
  /** Battery reading for the state line, when known. */
  battery?: number | null;
  /** Quiet variant for the action (e.g. Disconnect on a live trainer). */
  quietAction?: boolean;
  /** Extra content under the text (unlock recipe). */
  children?: ReactNode;
  /** First item on the text-link line (e.g. a details disclosure). */
  extrasLead?: ReactNode;
  testId?: string;
}

export function DeviceRow<A extends string>({
  icon: Icon,
  view,
  onAction,
  battery = null,
  quietAction = false,
  children,
  extrasLead,
  testId,
}: DeviceRowProps<A>) {
  const ok = view.tone === 'ok';
  return (
    <div
      className={cn('grid grid-cols-device-row-narrow items-center gap-4 sm:grid-cols-device-row', ROW_PAD)}
      data-testid={testId}
      data-tone={view.tone}
    >
      <span
        className={cn(
          'grid h-10 w-10 shrink-0 place-items-center rounded-full',
          ok ? 'bg-primary/10 text-primary' : 'bg-muted text-foreground',
        )}
      >
        <Icon className="h-5 w-5" aria-hidden />
      </span>

      <div className="min-w-0">
        <div className="text-base font-semibold text-foreground">{view.name}</div>
        <div
          className={cn(
            'flex flex-wrap items-center gap-2 text-sm',
            view.tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
          )}
          role="status"
        >
          {view.tone === 'error' ? (
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
              {view.state}
            </span>
          ) : (
            <>
              <StateDot tone={view.tone} />
              <span>{view.state}</span>
            </>
          )}
          {battery !== null && <Battery pct={battery} label={view.name} />}
        </div>
        {view.help && <p className="mt-1 max-w-prose text-sm text-muted-foreground">{view.help}</p>}
        {children}
        {(extrasLead || view.extras.length > 0) && (
          <div className="mt-1 flex flex-wrap items-start gap-x-4">
            {extrasLead}
            {view.extras.map((x) => (
              <ActionButton key={x.id} action={x} variant="textlink" className="px-0" onAction={onAction} />
            ))}
          </div>
        )}
      </div>

      {view.action && (
        <div className="col-start-2 justify-self-start sm:col-start-3 sm:justify-self-end">
          <ActionButton action={view.action} variant={quietAction ? 'quiet' : 'outline'} onAction={onAction} />
        </div>
      )}
    </div>
  );
}
