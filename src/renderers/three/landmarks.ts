/**
 * Which place names to show in the world (pure): the bundle's POIs scored by
 * prominence (manifest `rank`) and distance, kept in front of the camera,
 * near-duplicates dropped (Assisi's upper and lower basilica are one label),
 * capped to the tier's label count.
 */

import type { WorldPoi } from '@/lib/world/manifest';

/** Farthest a label shows, by rank (3 towns, 2 notable places, 1 the rest), metres. */
export const LABEL_RANGE_M: Readonly<Record<number, number>> = { 3: 9000, 2: 3200, 1: 900 };
/** Labels within this distance of a stronger one are dropped, metres. */
export const LABEL_DEDUPE_M = 220;

export interface LabelPick {
  poi: WorldPoi;
  /** Index into the manifest's pois. */
  index: number;
  distance: number;
  rank: number;
}

export function poiRank(p: WorldPoi): number {
  if (typeof p.rank === 'number') return p.rank;
  return p.kind === 'town' ? 3 : p.kind === 'village' ? 1 : 2;
}

/**
 * Pick up to `max` labels for a camera at world (x, y) looking along the
 * world-space unit vector (fx, fy). Stable: ties break by POI index.
 */
export function pickLabels(pois: readonly WorldPoi[], camX: number, camY: number, fx: number, fy: number, max: number): LabelPick[] {
  const cands: LabelPick[] = [];
  pois.forEach((poi, index) => {
    const rank = poiRank(poi);
    const dx = poi.x - camX;
    const dy = poi.y - camY;
    const distance = Math.hypot(dx, dy);
    if (distance > (LABEL_RANGE_M[rank] ?? 900) || distance < 40) return;
    // In front of the camera (within ~65° of the view direction).
    if ((dx * fx + dy * fy) / distance < 0.42) return;
    cands.push({ poi, index, distance, rank });
  });
  cands.sort((a, b) => b.rank - a.rank || a.distance - b.distance || a.index - b.index);
  const out: LabelPick[] = [];
  for (const c of cands) {
    if (out.length >= max) break;
    if (out.some((o) => Math.hypot(o.poi.x - c.poi.x, o.poi.y - c.poi.y) < LABEL_DEDUPE_M)) continue;
    out.push(c);
  }
  return out;
}

/** Shorter display names: drop leading "Chiesa di", "Basilica di", etc. only when long. */
export function labelText(p: WorldPoi): string {
  const name = p.name.trim();
  if (name.length <= 26) return name;
  return name.replace(/^(Chiesa|Basilica( (inferiore|superiore))?|Oratorio|Castello|Cattedrale|Santuario) (di |del |della |dei |d')?/i, '');
}
