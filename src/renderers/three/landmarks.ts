/**
 * Which places get a pin in the world (pure): the bundle's POIs scored by
 * prominence (manifest `rank`) and distance, kept in front of the camera,
 * near-duplicates dropped (Assisi's upper and lower basilica are one pin),
 * capped to the tier's pin count, then decluttered on screen so no two
 * pins ever overlap. Pins carry no text: place names belong to the minimap,
 * finish card and postcards, never floating in the world.
 */

import type { WorldPoi } from '@/lib/world/manifest';

/** Farthest a pin shows, by rank (3 towns, 2 notable places, 1 the rest), metres. */
export const PIN_RANGE_M: Readonly<Record<number, number>> = { 3: 9000, 2: 3200, 1: 900 };
/** Pins within this distance of a stronger one are dropped, metres. */
export const PIN_DEDUPE_M = 220;
/** Pin height on screen in CSS pixels, by rank. */
export const PIN_PX: Readonly<Record<number, number>> = { 3: 26, 2: 21, 1: 17 };
/** Pin width as a share of its height (the head's diameter). */
export const PIN_ASPECT = 0.72;
/** Clear space kept between two pins on screen, CSS pixels. */
export const PIN_GAP_PX = 4;

export interface PinPick {
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

/** Pick order: stronger first, then nearer, then by POI index (stable). */
export function pinPriority(a: PinPick, b: PinPick): number {
  return b.rank - a.rank || a.distance - b.distance || a.index - b.index;
}

/**
 * Pick up to `max` pins for a camera at world (x, y) looking along the
 * world-space unit vector (fx, fy). Stable: ties break by POI index.
 */
export function pickPins(pois: readonly WorldPoi[], camX: number, camY: number, fx: number, fy: number, max: number): PinPick[] {
  const cands: PinPick[] = [];
  pois.forEach((poi, index) => {
    const rank = poiRank(poi);
    const dx = poi.x - camX;
    const dy = poi.y - camY;
    const distance = Math.hypot(dx, dy);
    if (distance > (PIN_RANGE_M[rank] ?? 900) || distance < 40) return;
    // In front of the camera (within ~65° of the view direction).
    if ((dx * fx + dy * fy) / distance < 0.42) return;
    cands.push({ poi, index, distance, rank });
  });
  cands.sort(pinPriority);
  const out: PinPick[] = [];
  for (const c of cands) {
    if (out.length >= max) break;
    if (out.some((o) => Math.hypot(o.poi.x - c.poi.x, o.poi.y - c.poi.y) < PIN_DEDUPE_M)) continue;
    out.push(c);
  }
  return out;
}

/** A pin's screen box (CSS pixels): tip at the bottom centre, head above. */
export interface PinRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function pinRect(tipX: number, tipY: number, rank: number): PinRect {
  const h = PIN_PX[rank] ?? PIN_PX[1];
  const w = h * PIN_ASPECT;
  return { x0: tipX - w / 2, y0: tipY - h, x1: tipX + w / 2, y1: tipY };
}

/** Do two pin boxes come closer than `gap` pixels? */
export function pinsOverlap(a: PinRect, b: PinRect, gap = PIN_GAP_PX): boolean {
  return a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;
}

/**
 * Which of `rects` (in priority order; null = off screen or hidden) may
 * show: each only if it keeps clear of every stronger pin that shows. The
 * shown set never overlaps, by construction.
 */
export function declutterPins(rects: readonly (PinRect | null)[], gap = PIN_GAP_PX): boolean[] {
  const shown: PinRect[] = [];
  return rects.map((r) => {
    if (!r || shown.some((s) => pinsOverlap(s, r, gap))) return false;
    shown.push(r);
    return true;
  });
}
