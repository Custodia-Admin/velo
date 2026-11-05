/**
 * Polyline resampling for generated routes (src/lib/routeGenerator.ts).
 */

import { haversine } from '@/lib/utils';

export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * Resample a polyline so consecutive points are at most `spacingM` meters
 * apart (default 30 m). This ensures gradient calc is smooth after elevation
 * lookup — coarse GPS points would otherwise produce jagged gradients.
 *
 * The first and last points are always preserved.
 */
export function resamplePolyline(
  pts: LatLon[],
  spacingM = 30,
): LatLon[] {
  if (pts.length < 2) return pts.slice();

  const out: LatLon[] = [pts[0]];

  for (let i = 1; i < pts.length; i++) {
    const prev = out[out.length - 1];
    const cur = pts[i];
    const segLen = haversine(prev.lat, prev.lon, cur.lat, cur.lon);

    if (segLen <= spacingM) {
      out.push(cur);
      continue;
    }

    // Insert intermediate points at `spacingM` spacing along this segment.
    const steps = Math.ceil(segLen / spacingM);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push({
        lat: prev.lat + (cur.lat - prev.lat) * t,
        lon: prev.lon + (cur.lon - prev.lon) * t,
      });
    }
  }

  return out;
}
