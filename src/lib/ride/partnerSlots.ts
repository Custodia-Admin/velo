/**
 * Where pace partners ride across the road. A partner's BotState is a point
 * on the route line, the same line the rider follows, so partners seated on
 * the start line (or riding level with the rider) would be drawn inside the
 * rider. Each partner is drawn in a fixed lateral slot by roster index
 * instead: index 0 rides 1.2 m right of the line, 1 rides 1.2 m left, 2 rides
 * 2.4 m right (then 2.4 m left, 3.6 m right, …).
 *
 * The renderers apply the slot; the ride sim, drafting and the store keep the
 * on-line distance. Pure: no stores, no engines.
 */

import { offsetSideways } from '@/lib/laneOffset';

/** Lateral step between partner slots, metres. */
export const PARTNER_SLOT_STEP_M = 1.2;

/**
 * How far a partner's wheels stay inside the edge of the road it rides on,
 * metres: the tyre stays on the drawn surface. Kept small on purpose: on the
 * 1.5 m paths most of the Tiber route rides, a 0.3 m margin left a partner
 * level with the rider 0.45 m from them, elbow into elbow.
 */
export const PARTNER_EDGE_MARGIN_M = 0.1;

/**
 * The paved surface around a point on the route line, measured across the
 * travel heading: metres from the point, + = right of travel. `leftM` is
 * negative when the road extends to the left of the point.
 */
export interface RoadSpan {
  leftM: number;
  rightM: number;
}

/** The unclamped slot for roster index `index`: +1.2, −1.2, +2.4, −2.4, … metres (+ = right). */
export function baseSlotM(index: number): number {
  const i = Math.max(0, Math.floor(index));
  const side = i % 2 === 0 ? 1 : -1;
  return side * PARTNER_SLOT_STEP_M * (Math.floor(i / 2) + 1);
}

/**
 * The lateral offset partner `index` is drawn at, metres right of the route
 * line. With a `span` (the road the renderer draws there), the slot is
 * clamped so the partner keeps PARTNER_EDGE_MARGIN_M inside its edges; a
 * road narrower than twice the margin puts the partner on its middle.
 */
export function partnerSlotM(index: number, span?: RoadSpan | null): number {
  const slot = baseSlotM(index);
  if (!span) return slot;
  const lo = span.leftM + PARTNER_EDGE_MARGIN_M;
  const hi = span.rightM - PARTNER_EDGE_MARGIN_M;
  if (lo > hi) return (span.leftM + span.rightM) / 2;
  return Math.min(hi, Math.max(lo, slot));
}

/**
 * Move a point `m` metres across a travel heading (radians clockwise from
 * north): + = right of travel. The same shift the rider's lane offset uses.
 */
export function offsetLatLon(lat: number, lon: number, heading: number, m: number): { lat: number; lon: number } {
  return offsetSideways(lat, lon, heading, m);
}
