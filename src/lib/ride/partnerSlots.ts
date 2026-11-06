/**
 * Where pace partners ride across the road. A partner's BotState is a point
 * on the route line, the same line the rider follows, so partners seated on
 * the start line (or riding level with the rider) would be drawn inside the
 * rider. Each partner is drawn in a fixed lateral slot by roster index
 * instead: index 0 rides 1.2 m right of the line, 1 rides 1.2 m left, 2 rides
 * 2.4 m right (then 2.4 m left, 3.6 m right, …).
 *
 * The renderers apply the slot; the ride sim, drafting and the store keep the
 * on-line distance. Where the renderer knows the drawn road, the slot is
 * clamped to it (partnerSlotM), but never closer than PARTNER_SLOT_FLOOR_M to
 * the line or to the partner beside it: on a 1.5 m path a partner rides the
 * verge rather than inside the rider. The drawn slot is eased toward that
 * target frame by frame (stepPartnerSlot), so it never jumps sideways. Pure:
 * no stores, no engines.
 */

import { offsetSideways } from '@/lib/laneOffset';
import { YAW_SNAP_M } from './rideHeading';

/** Lateral step between partner slots, metres. */
export const PARTNER_SLOT_STEP_M = 1.2;

/**
 * How far a partner's wheels stay inside the edge of the road it rides on,
 * metres, wherever the road leaves room for PARTNER_SLOT_FLOOR_M: the tyre
 * stays on the drawn surface.
 */
export const PARTNER_EDGE_MARGIN_M = 0.1;

/**
 * The closest a partner is drawn to the route line (where the rider rides)
 * and to the next partner out on the same side, metres. Most of the Tiber
 * route rides 1.5 m paths with the line up to 0.4 m off their centre: the
 * road clamp alone put a partner level with the rider 0.13–0.65 m from them
 * on two thirds of the route (rider model half-width ≈ 0.25 m, elbows into
 * elbows), and partners 0 and 2 on the same edge, inside each other. Past
 * the clamp the partner rides the verge: the bake keeps buildings 3.5 m or
 * more from every scenic route, and the rider's own steering already takes
 * it up to 1.6 m off the line whatever the road's width.
 */
export const PARTNER_SLOT_FLOOR_M = 0.9;

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
 * line:
 * - With a `span` (the road the renderer draws there), the slot is clamped
 *   so the partner keeps PARTNER_EDGE_MARGIN_M inside its edges; a road
 *   narrower than twice the margin clamps it to its middle.
 * - Then it is kept on its own side, at least PARTNER_SLOT_FLOOR_M from the
 *   line, and at least that far beyond the partner two indices before it
 *   (the next one in on the same side). Only these push a partner off the
 *   drawn road; where the clamp leaves room, the clamp stands.
 * Continuous in the span's edges (a move of either edge by ε moves the
 * result by at most ε), so the eased slot inherits no new jumps. Wide roads
 * and no road give the base slots: ±1.2 m, +2.4 m.
 */
export function partnerSlotM(index: number, span?: RoadSpan | null): number {
  const i = Math.max(0, Math.floor(index));
  const slot = baseSlotM(i);
  const side = Math.sign(slot);
  let m = slot;
  if (span) {
    const lo = span.leftM + PARTNER_EDGE_MARGIN_M;
    const hi = span.rightM - PARTNER_EDGE_MARGIN_M;
    m = lo > hi ? (span.leftM + span.rightM) / 2 : Math.min(hi, Math.max(lo, slot));
  }
  let out = Math.max(side * m, PARTNER_SLOT_FLOOR_M);
  if (i >= 2) out = Math.max(out, side * partnerSlotM(i - 2, span) + PARTNER_SLOT_FLOOR_M);
  return side * out;
}

/**
 * How fast a partner drifts across the road to a new slot. The clamped slot
 * changes in steps: where the road under the line narrows, widens or ends,
 * or a junction swaps the ribbon under it. Drawn as is, the partner jumps
 * sideways in one frame (up to 3.8 m on the Tiber route before this eased
 * it). The drift is a damped approach (PARTNER_SLOT_TAU_S) capped at
 * PARTNER_SLOT_MAX_RATE_MPS: at most 0.042 m a frame at 60 fps, a cyclist
 * moving over, never a teleport.
 */
export const PARTNER_SLOT_MAX_RATE_MPS = 2.5;
/** Time constant of the drift toward a new slot, seconds. */
export const PARTNER_SLOT_TAU_S = 0.15;

/**
 * One step of a partner's lateral offset `m` toward `target` over `dt`
 * seconds, metres. Never overshoots: the offset stays between where it was
 * and the target, so it never leaves the range the clamped slots span.
 */
export function easeSlotM(m: number, target: number, dt: number): number {
  if (!(dt > 0)) return m;
  const step = (target - m) * (1 - Math.exp(-dt / PARTNER_SLOT_TAU_S));
  const cap = PARTNER_SLOT_MAX_RATE_MPS * dt;
  return m + Math.max(-cap, Math.min(cap, step));
}

/** A partner's drawn lateral offset carried between frames (NaN until the first frame). */
export interface PartnerSlotState {
  m: number;
  /** Route distance at the last step, metres. */
  distance: number;
}

export function createPartnerSlotState(): PartnerSlotState {
  return { m: NaN, distance: NaN };
}

/**
 * Advance `state` toward `target` (partnerSlotM) at route `distance` and
 * return the offset to draw, metres right of the line. The first frame, and
 * a jump along the route the heading filter snaps on too (a seek, Ride
 * again), seat the partner in its slot at once.
 */
export function stepPartnerSlot(state: PartnerSlotState, target: number, distance: number, dt: number): number {
  const jumped = !Number.isFinite(state.distance) || Math.abs(distance - state.distance) > YAW_SNAP_M;
  state.distance = distance;
  state.m = jumped || !Number.isFinite(state.m) ? target : easeSlotM(state.m, target, dt);
  return state.m;
}

/**
 * Move a point `m` metres across a travel heading (radians clockwise from
 * north): + = right of travel. The same shift the rider's lane offset uses.
 */
export function offsetLatLon(lat: number, lon: number, heading: number, m: number): { lat: number; lon: number } {
  return offsetSideways(lat, lon, heading, m);
}
