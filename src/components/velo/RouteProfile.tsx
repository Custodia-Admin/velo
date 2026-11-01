/**
 * v2 route profile: a soft area under a terracotta line; with `at`, the
 * ridden part is filled deeper and a round "you are here" dot sits on the
 * line (v2-identity §5, ride HUD + finish). The line stretches with the box
 * (preserveAspectRatio none) while the dot stays round: it lives in the
 * outer, unscaled SVG and is placed in percent.
 */

import { useMemo } from 'react';
import type { Route } from '@/types';
import { cn } from '@/lib/utils';
import { profileGeometry } from '@/lib/routePlate';

const W = 1000;
const H = 40;

export interface RouteProfileProps {
  route: Pick<Route, 'points' | 'totalDistance' | 'ascent'>;
  /** Fraction ridden (0..1): fills the ridden part and draws the dot. */
  at?: number;
  /** Height class, e.g. "h-8". */
  className?: string;
}

export function RouteProfile({ route, at, className }: RouteProfileProps) {
  // Quantise so the profile path is not rebuilt on every ride tick.
  const atQ = at == null ? undefined : Math.round(Math.min(1, Math.max(0, at)) * 500) / 500;
  const g = useMemo(() => profileGeometry(route, { W, H, at: atQ }), [route, atQ]);
  if (!g) return null;
  return (
    <svg
      className={cn('block w-full overflow-visible text-primary', className)}
      role="img"
      aria-label={`Elevation profile, ${Math.round(route.ascent)} metres of climbing`}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height="100%" overflow="visible">
        <path d={g.area} fill="currentColor" fillOpacity={0.12} />
        {g.done && <path d={g.done} fill="currentColor" fillOpacity={0.28} />}
        <polyline
          points={g.line}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {g.here && (
        <circle
          cx={`${(g.here.x * 100).toFixed(2)}%`}
          cy={`${(g.here.y * 100).toFixed(2)}%`}
          r="0.375em"
          fill="currentColor"
          className="stroke-hud"
          strokeWidth={2}
        />
      )}
    </svg>
  );
}
