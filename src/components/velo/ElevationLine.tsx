import { useMemo } from 'react';
import type { Route } from '@/types';
import { cn } from '@/lib/utils';

/**
 * Minimum vertical span drawn, metres. A flat lakeside ride must LOOK flat,
 * so small wobbles are not stretched to fill the box.
 */
const MIN_SPAN_M = 150;
const SAMPLES = 64;

export function elevationPolyline(route: Route, samples = SAMPLES): string {
  const pts = route.points;
  if (pts.length < 2) return '';
  const total = route.totalDistance || pts[pts.length - 1].distance || 1;
  const span = Math.max(route.maxElevation - route.minElevation, MIN_SPAN_M);
  const base = route.minElevation;
  const out: string[] = [];
  let j = 0;
  for (let i = 0; i < samples; i++) {
    const d = (i / (samples - 1)) * total;
    while (j < pts.length - 2 && pts[j + 1].distance < d) j++;
    const a = pts[j];
    const b = pts[j + 1];
    const f = b.distance > a.distance ? (d - a.distance) / (b.distance - a.distance) : 0;
    const ele = a.ele + (b.ele - a.ele) * Math.min(1, Math.max(0, f));
    const x = (i / (samples - 1)) * 100;
    // 2..18 of a 20-unit box, inverted (SVG y grows downward).
    const y = 18 - ((ele - base) / span) * 16;
    out.push(`${x.toFixed(1)},${y.toFixed(2)}`);
  }
  return out.join(' ');
}

/** Elevation sparkline drawn in the current text colour. */
export function ElevationLine({ route, className }: { route: Route; className?: string }) {
  const points = useMemo(() => elevationPolyline(route), [route]);
  return (
    <svg
      viewBox="0 0 100 20"
      preserveAspectRatio="none"
      className={cn('w-full text-primary', className)}
      role="img"
      aria-label={`Elevation profile, ${Math.round(route.ascent)} metres of climbing`}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
