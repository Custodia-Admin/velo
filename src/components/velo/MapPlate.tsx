/**
 * Map plate: for places whose 3D world is not baked yet, the real route on a
 * 1 km graticule (v2-identity §5). Same footprint as a photographic plate.
 */

import { useMemo, type ReactNode } from 'react';
import type { Route } from '@/types';
import { cn } from '@/lib/utils';
import { mapPlateGeometry } from '@/lib/routePlate';

export interface MapPlateProps {
  route: Pick<Route, 'points'>;
  /** Width / height of the plate, so the graticule fills it (3/2 tiles, 16/9 hero). */
  aspect: number;
  /** Aspect / size classes, e.g. "aspect-3/2" (tailwind.config aspectRatio). */
  className?: string;
  /** Overlay content (e.g. the "Map view" badge). */
  children?: ReactNode;
}

export function MapPlate({ route, aspect, className, children }: MapPlateProps) {
  const g = useMemo(() => mapPlateGeometry(route, aspect), [route, aspect]);
  return (
    <div className={cn('relative overflow-hidden rounded-lg bg-muted/60 text-primary', className)}>
      {g && (
        <svg viewBox={g.viewBox} preserveAspectRatio="xMidYMid slice" className="block h-full w-full" aria-hidden>
          <path d={g.graticule} className="fill-none stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <polyline
            points={g.points}
            fill="none"
            stroke="currentColor"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {[g.start, g.end].map(([cx, cy], i) => (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={g.endRadius}
              className="fill-background"
              stroke="currentColor"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      )}
      {children}
    </div>
  );
}
