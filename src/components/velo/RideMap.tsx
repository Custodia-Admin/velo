/**
 * In-ride route map (compact ride HUD details, owner-directed revision 2 Nov
 * 2026): the route on a 1 km graticule in the warm-atlas map-plate style
 * (MapPlate, v2-identity §5), drawn in the HUD ink, with the rider's
 * "you are here" dot in the accent. Tokens only, on the translucent in-ride
 * paper; the route name lives on the route card beside it, so the map
 * carries no label strip.
 *
 * Square, sized by the caller (h-32 w-32 on phones, h-44 w-44 from sm).
 * The dot moves in route-length / 600 steps (quantizedDistance), not per frame.
 */

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { quantizedDistance } from '@/lib/hudThrottle';
import { sampleRouteAtDistance } from '@/lib/gpxParser';
import { mapPlateGeometry, planXY } from '@/lib/routePlate';
import { useRideStore } from '@/stores/rideStore';
import { HUD_PANEL } from './v2';

export function RideMap({ className }: { className?: string }) {
  const route = useRideStore((s) => s.route);
  const distance = useRideStore((s) => quantizedDistance(s.distance, s.route?.totalDistance));
  const g = useMemo(() => (route ? mapPlateGeometry(route, 1) : null), [route]);
  const here = useMemo(() => {
    if (!route || route.points.length < 2) return null;
    const p = sampleRouteAtDistance(route, distance);
    return planXY(route, p.lat, p.lon);
  }, [route, distance]);

  if (!route || !g) return null;

  return (
    <div className={cn(HUD_PANEL, 'overflow-hidden', className)} role="img" aria-label="Route map">
      <svg viewBox={g.viewBox} preserveAspectRatio="xMidYMid meet" className="block h-full w-full" aria-hidden>
        <path d={g.graticule} className="fill-none stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <polyline
          points={g.points}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.7}
          strokeWidth={2.5}
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
            className="fill-hud"
            stroke="currentColor"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {here && (
          <circle
            cx={here[0]}
            cy={here[1]}
            r={g.endRadius * 1.6}
            className="fill-primary stroke-hud"
            strokeWidth={2.5}
            vectorEffect="non-scaling-stroke"
            data-testid="ride-map-here"
          />
        )}
      </svg>
    </div>
  );
}
