/**
 * One ride figure: a big tabular value, an optional small unit, and an
 * uppercase label (ride band, show strip, finish summary).
 * `major` = text-3xl (text-2xl below sm); `minor` = text-2xl. In-ride figures
 * never go below text-2xl (UI-RULES §5).
 *
 * `unitAsLabelBelowSm`: on phones the unit replaces the label ("24.6" over
 * "KM/H" instead of "24.6 km/h" over "SPEED"), so the compact ride band's
 * three figures and its buttons fit one row.
 */

import { cn } from '@/lib/utils';

export interface FigureProps {
  value: string;
  unit?: string;
  label: string;
  size?: 'major' | 'minor';
  /** Full spoken value, e.g. "Speed: 24.6 km/h" (tests and screen readers). */
  ariaLabel?: string;
  unitAsLabelBelowSm?: boolean;
  className?: string;
}

export function Figure({ value, unit, label, size = 'major', ariaLabel, unitAsLabelBelowSm = false, className }: FigureProps) {
  const swap = unitAsLabelBelowSm && !!unit;
  return (
    <div className={cn('flex flex-col', className)} role={ariaLabel ? 'group' : undefined} aria-label={ariaLabel}>
      <span
        className={cn('num whitespace-nowrap font-bold', size === 'major' ? 'text-2xl sm:text-3xl' : 'text-2xl')}
        aria-hidden={ariaLabel ? true : undefined}
      >
        {value}
        {/* leading-none: the unit sits on the value's baseline inside the
            value's own line box, so a figure with a unit is exactly as tall
            as one without and every label shares one baseline. */}
        {unit && (
          <small
            className={cn(
              'ml-1 text-sm font-semibold leading-none tracking-normal text-muted-foreground',
              swap && 'hidden sm:inline',
            )}
          >
            {unit}
          </small>
        )}
      </span>
      <span
        className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        aria-hidden={ariaLabel ? true : undefined}
      >
        {swap ? (
          <>
            <span className="sm:hidden">{unit}</span>
            <span className="hidden sm:inline">{label}</span>
          </>
        ) : (
          label
        )}
      </span>
    </div>
  );
}
