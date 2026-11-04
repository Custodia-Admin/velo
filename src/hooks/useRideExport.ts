/**
 * useRideExport — the finished ride's way out: a .FIT download (Strava,
 * Garmin Connect and every other training log import it).
 *
 * Used by the v2 finish page (src/components/velo/FinishCard.tsx).
 */

import { useCallback } from 'react';

import { useRideStore } from '@/stores/rideStore';
import { buildFit, downloadFit as saveFitFile } from '@/lib/fitExporter';

/** `<route>_<ISO time>.fit`, filesystem-safe. */
export function fitFileName(routeName: string | undefined, startedAt: number): string {
  const safe = (routeName ?? 'velo').replace(/[^a-z0-9-_]+/gi, '_');
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${safe}_${stamp}.fit`;
}

export interface RideExport {
  /** A ride with samples to export. */
  canExport: boolean;
  downloadFit: () => void;
}

export function useRideExport(): RideExport {
  const samples = useRideStore((s) => s.samples);
  const startedAt = useRideStore((s) => s.startedAt);
  const routeName = useRideStore((s) => s.route?.name);

  const downloadFit = useCallback(() => {
    if (!startedAt || samples.length === 0) return;
    saveFitFile(buildFit({ startTime: startedAt, samples }), fitFileName(routeName, startedAt));
  }, [startedAt, samples, routeName]);

  return {
    canExport: !!startedAt && samples.length > 0,
    downloadFit,
  };
}
