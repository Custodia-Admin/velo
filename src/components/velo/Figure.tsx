/**
 * One ride figure: a big tabular value, an optional small unit, and an
 * uppercase label (v2 ride strip, show strip, finish summary).
 * `major` = text-3xl (text-2xl below sm); `minor` = text-2xl. In-ride figures
 * never go below text-2xl (UI-RULES §5).
 */

import { cn } from '@/lib/utils';

export interface FigureProps {
  value: string;
  unit?: string;
  label: string;
  size?: 'major' | 'minor';
  /** Full spoken value, e.g. "Speed: 24.6 km/h" (tests and screen readers). */
  ariaLabel?: string;
  className?: string;
}

export function Figure({ value, unit, label, size = 'major', ariaLabel, className }: FigureProps) {
  return (
    <div className={cn('flex flex-col', className)} role={ariaLabel ? 'group' : undefined} aria-label={ariaLabel}>
      <span
        className={cn('num whitespace-nowrap font-bold', size === 'major' ? 'text-2xl sm:text-3xl' : 'text-2xl')}
        aria-hidden={ariaLabel ? true : undefined}
      >
        {value}
        {unit && <small className="ml-1 text-sm font-semibold tracking-normal text-muted-foreground">{unit}</small>}
      </span>
      <span
        className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        aria-hidden={ariaLabel ? true : undefined}
      >
        {label}
      </span>
    </div>
  );
}
