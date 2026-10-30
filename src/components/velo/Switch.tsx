/**
 * On/off switch used across Velo settings rows. role="switch", h-10 target.
 */

import { cn } from '@/lib/utils';

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  labelledBy: string;
  describedBy?: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, labelledBy, describedBy, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-10 w-16 shrink-0 items-center rounded-pill border transition-colors duration-150 disabled:opacity-40',
        checked ? 'border-primary bg-primary' : 'border-muted-foreground/50 bg-muted',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute h-8 w-8 rounded-full shadow-sm transition-transform duration-150',
          checked ? 'translate-x-7 bg-primary-foreground' : 'translate-x-1 bg-muted-foreground',
        )}
      />
    </button>
  );
}
