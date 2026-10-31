/**
 * Postcards: collectibles spaced along the route, picked up by riding past.
 *
 * Nothing can be missed: a postcard counts once the rider's distance passes
 * it (minus a small pickup radius), so riding the whole route collects them
 * all. Pure and renderer-free; the Cesium layer only draws them.
 */

export interface Postcard {
  /** 1-based, in route order. */
  index: number;
  /** Distance along the route, metres. */
  distanceM: number;
}

export const POSTCARD_SPACING_M = 800;
export const POSTCARD_MIN = 3;
export const POSTCARD_MAX = 12;
/** None in the first stretch, so the first one isn't on the start line. */
export const POSTCARD_START_GAP_M = 300;
/** None right on the finish line. */
export const POSTCARD_END_GAP_M = 150;
/** Picked up when the rider is within this many metres of it. */
export const POSTCARD_PICKUP_M = 8;

/**
 * Evenly spaced postcards for a route of `lengthM` metres. Short routes get
 * fewer (never less than POSTCARD_MIN when there's room), long routes are
 * capped at POSTCARD_MAX and spread out. Returns [] when the route is too
 * short to place any.
 */
export function placePostcards(lengthM: number): Postcard[] {
  if (!Number.isFinite(lengthM)) return [];
  const usable = lengthM - POSTCARD_START_GAP_M - POSTCARD_END_GAP_M;
  if (usable <= 0) return [];
  const byLength = Math.floor(usable / POSTCARD_SPACING_M) + 1;
  const count = Math.max(POSTCARD_MIN, Math.min(POSTCARD_MAX, byLength));
  if (count === 1) return [{ index: 1, distanceM: POSTCARD_START_GAP_M }];
  const step = usable / (count - 1);
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    distanceM: Math.round(POSTCARD_START_GAP_M + i * step),
  }));
}

/**
 * How many postcards are collected at `distanceM`. Monotonic in distance,
 * so the caller can keep the max it has seen.
 */
export function collectedAt(cards: readonly Postcard[], distanceM: number): number {
  let n = 0;
  for (const c of cards) {
    if (distanceM >= c.distanceM - POSTCARD_PICKUP_M) n++;
    else break;
  }
  return n;
}

/** Metres to the next uncollected postcard, or null when all are collected. */
export function metresToNext(
  cards: readonly Postcard[],
  collected: number,
  distanceM: number,
): number | null {
  const next = cards[collected];
  if (!next) return null;
  return Math.max(0, next.distanceM - distanceM);
}
