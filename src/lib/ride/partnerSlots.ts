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
 * target frame by frame (stepPartnerSlot), so it never jumps sideways.
 *
 * The rider steers up to 1.6 m off the line (steerFeel), so the slots also
 * give way to it (stepPartnerYield): a partner beside the rider keeps 0.9 m
 * from where the rider is or is heading, moving further out where the drawn
 * road leaves room, dropping back behind the rider where it doesn't, and
 * coming back only once the rider has kept clear of its slot for a second.
 * The renderers hand it the drawn geometry (where the rider is drawn, seen
 * from the partner), so the 0.9 m holds in the scene, bends included.
 * Pure: no stores, no engines.
 */

import { stepLane, type LaneState } from '@/lib/controllers/steerFeel';
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
 *
 * `riderLateral` is where a rider level with the partner rides, metres right
 * of the line (its lane offset; 0 = on the line, which gives the slot above,
 * the partner's home). A partner on the side the rider has moved toward
 * moves further out, to PARTNER_SLOT_FLOOR_M beyond the rider, but no
 * further than the drawn road's edge (less the margin) or
 * PARTNER_YIELD_VERGE_M past its home, whichever is further out: on a road
 * too narrow for that the slot stays short of the floor, and
 * partnerClearsRider says so (the partner then drops back:
 * stepPartnerYield). The partner two indices before it moving out takes
 * this one out with it. A partner never moves in from its home, so it
 * never changes sides. Without a span the road has no edge.
 */
export function partnerSlotM(index: number, span?: RoadSpan | null, riderLateral = 0): number {
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
  // Out to the floor beyond the rider, as far as the road edge allows (no move while already clear).
  out = Math.max(out, Math.min(side * riderLateral + PARTNER_SLOT_FLOOR_M, roadEdgeOutM(side, span, out)));
  if (i >= 2) out = Math.max(out, side * partnerSlotM(i - 2, span, riderLateral) + PARTNER_SLOT_FLOOR_M);
  return side * out;
}

/**
 * How far past its home slot a partner may move out for the rider, metres,
 * wherever the road is: on a 1.5 m path its home is already the verge,
 * 0.9 m from the line, and a rider a few centimetres off the line (the
 * levers just let go, the spring's last 5 mm) would otherwise send it back
 * behind the rider. It moves out onto the verge for that instead; only a
 * rider more than this far toward it makes it drop back.
 */
export const PARTNER_YIELD_VERGE_M = 0.15;

/**
 * How far out a partner on `side` (+1 right, −1 left) with home slot
 * `homeOut` (side metres) may ride for the rider, metres from the line on
 * its side: the road edge less the margin (Infinity without a span), or
 * PARTNER_YIELD_VERGE_M past its home, whichever is further out.
 */
function roadEdgeOutM(side: number, span: RoadSpan | null | undefined, homeOut: number): number {
  if (!span) return Infinity;
  const edge = side > 0 ? span.rightM - PARTNER_EDGE_MARGIN_M : -(span.leftM + PARTNER_EDGE_MARGIN_M);
  return Math.max(edge, homeOut + PARTNER_YIELD_VERGE_M);
}

/**
 * Whether partner `index`'s slot (partnerSlotM with the same rider) keeps
 * PARTNER_SLOT_FLOOR_M from a rider level with it at `riderLateral`: false
 * where the drawn road is too narrow to ride beside the rider.
 */
export function partnerClearsRider(index: number, span: RoadSpan | null | undefined, riderLateral: number): boolean {
  const side = Math.sign(baseSlotM(index));
  return side * (partnerSlotM(index, span, riderLateral) - riderLateral) >= PARTNER_SLOT_FLOOR_M - 1e-9;
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
  return easeToward(m, target, dt, PARTNER_SLOT_TAU_S, PARTNER_SLOT_MAX_RATE_MPS);
}

/** A damped approach of `m` toward `target` (time constant `tauS`), capped at `rateMps`; never overshoots. */
function easeToward(m: number, target: number, dt: number, tauS: number, rateMps: number): number {
  if (!(dt > 0)) return m;
  const step = (target - m) * (1 - Math.exp(-dt / tauS));
  const cap = rateMps * dt;
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

// ---------------------------------------------------------------------------
// Giving way to a steering rider
// ---------------------------------------------------------------------------

/** How far ahead the rider's lane is foreseen (laneReach), seconds. */
export const LANE_REACH_S = 2;
const LANE_REACH_STEP_S = 0.05;

/** The furthest left and right the rider rides or is heading, metres right of the line. */
export interface LaneReach {
  leftM: number;
  rightM: number;
}

const reachLane: LaneState = { offsetM: 0, velMs: 0 };

/**
 * The furthest left and right the rider is, or will be with the levers held
 * as they are, over the next LANE_REACH_S, metres right of the line: its
 * lane state run forward through the same spring (steerFeel.stepLane), not
 * a copy of it. Partners keep clear of this reach, so they start to move as
 * the levers move, before the rider gets there: from full lock one way to
 * full lock the other the rider crosses the lane at up to 5.9 m/s, more
 * than twice as fast as a partner drifts over (PARTNER_SLOT_MAX_RATE_MPS).
 */
export function laneReach(lane: LaneState, steer: number, out: LaneReach = { leftM: 0, rightM: 0 }): LaneReach {
  const x0 = Number.isFinite(lane.offsetM) ? lane.offsetM : 0;
  let lo = x0;
  let hi = x0;
  reachLane.offsetM = x0;
  reachLane.velMs = Number.isFinite(lane.velMs) ? lane.velMs : 0;
  for (let t = LANE_REACH_STEP_S; t <= LANE_REACH_S + 1e-9; t += LANE_REACH_STEP_S) {
    const x = stepLane(reachLane, steer, LANE_REACH_STEP_S).offsetM;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  out.leftM = lo;
  out.rightM = hi;
  return out;
}

/** The rider as its pace partners see it. */
export interface RiderBeside extends LaneReach {
  /** Distance along the route, metres. */
  distance: number;
  /** m/s. */
  speed: number;
  /** Where the rider rides now, metres right of the line (its lane offset; leftM ≤ laneOffsetM ≤ rightM). */
  laneOffsetM: number;
}

/**
 * Where the rider is drawn as seen from a partner's drawn point on the
 * route line, in that partner's drawn heading: metres ahead along it and
 * right across it.
 */
export interface RiderLocal {
  alongM: number;
  acrossM: number;
}

/**
 * How long a partner keeps giving way after the rider has moved clear of
 * its slot, seconds: it moves back only once the rider has kept clear this
 * long, so a rider weaving on the levers does not make it twitch.
 */
export const PARTNER_YIELD_HOLD_S = 1;
const HOLD_BUCKET_S = 0.1;
const HOLD_BUCKETS = Math.round(PARTNER_YIELD_HOLD_S / HOLD_BUCKET_S) + 1;

/** Where the road leaves no room beside the rider, how far behind it the partner rides, metres. */
export const PARTNER_DROP_GAP_M = 2;
/**
 * The furthest a partner is drawn behind its own distance along the route,
 * metres: drafting and the HUD use that distance, so a faster partner held
 * behind the rider overtakes once it is this far ahead of where it is drawn.
 */
export const PARTNER_DROP_MAX_M = 4;
/** How fast a partner drops back or moves up again, m/s (along the route, relative to its own distance). */
export const PARTNER_DROP_MAX_RATE_MPS = 4;
/** Time constant of dropping back and moving up, seconds. */
export const PARTNER_DROP_TAU_S = 0.25;
/**
 * How close to clearing the rider across the road a dropped-back partner
 * must be before it moves up again, metres: the last few centimetres of its
 * eased drift take the longest, and the stand-off covers them as it closes.
 */
const PARTNER_UP_SLACK_M = 0.05;
/**
 * How much further than PARTNER_SLOT_FLOOR_M a partner standing off across
 * the road aims for, metres: the solver measures in the partner's heading
 * at its own point, the scene in projected metres (≤ 0.5 % apart).
 */
export const PARTNER_YIELD_MARGIN_M = 0.02;
/**
 * The furthest a partner is drawn ahead of its own point, metres: held clear
 * of a rider closing on it from behind (holdOff) while it moves across.
 */
export const PARTNER_SURGE_MAX_M = 2;
/** How far ahead a closing gap along the route is foreseen, seconds. */
export const PARTNER_LOOK_AHEAD_S = 1;

/**
 * The room across the road a partner `gapM` metres ahead of (or behind) the
 * rider along the route needs to stay PARTNER_SLOT_FLOOR_M from it, metres:
 * the whole floor when level, none once 0.9 m ahead or behind.
 */
export function besideClearanceM(gapM: number): number {
  const g = Math.abs(gapM);
  return g >= PARTNER_SLOT_FLOOR_M ? 0 : Math.sqrt(PARTNER_SLOT_FLOOR_M * PARTNER_SLOT_FLOOR_M - g * g);
}

/** The closest a gap along the route closing at `closingMps` comes within PARTNER_LOOK_AHEAD_S, metres (≥ 0). */
function foreseenGapM(gapM: number, closingMps: number): number {
  return Math.max(0, Math.abs(gapM) - Math.max(0, closingMps) * PARTNER_LOOK_AHEAD_S);
}

/** What one partner's giving way carries between frames. */
export interface PartnerYieldState {
  /** The drawn lateral slot, eased. */
  slot: PartnerSlotState;
  /** How far behind its own point the partner is drawn, metres, eased (NaN until the first frame). */
  back: number;
  /**
   * The furthest out from the line the partner has needed to be to clear
   * the rider, per HOLD_BUCKET_S of the last PARTNER_YIELD_HOLD_S (side
   * metres: + = out on its own side).
   */
  hold: Float64Array;
  holdAt: number;
  holdT: number;
  /** |drawn gap to the rider along the partner's heading| at the last step, metres (NaN unknown). */
  gap: number;
  /** The same, signed: + = the rider ahead of the partner (NaN unknown). */
  along: number;
  /** The same to partner index − 2, signed (NaN unknown). */
  innerAlong: number;
  /** Whether the last step held the partner off the rider (or partner index − 2) along the road (holdOff). */
  pressed: boolean;
  /** The signed drawn gap to each earlier partner at the last step (peersAt; NaN unknown). */
  peerAlong: number[];
}

export function createPartnerYieldState(): PartnerYieldState {
  return { slot: createPartnerSlotState(), back: NaN, hold: new Float64Array(HOLD_BUCKETS).fill(-Infinity), holdAt: 0, holdT: 0, gap: NaN, along: NaN, innerAlong: NaN, pressed: false, peerAlong: [] };
}

/** Record `value` at the current time and return the largest value of the last PARTNER_YIELD_HOLD_S (at least that long). */
function holdNeed(state: PartnerYieldState, value: number, dt: number): number {
  if (dt > 0) {
    state.holdT += dt;
    for (let n = 0; state.holdT >= HOLD_BUCKET_S && n < HOLD_BUCKETS; n++) {
      state.holdT -= HOLD_BUCKET_S;
      state.holdAt = (state.holdAt + 1) % HOLD_BUCKETS;
      state.hold[state.holdAt] = -Infinity;
    }
    // A frame longer than the whole hold has cleared every bucket.
    state.holdT %= HOLD_BUCKET_S;
  }
  if (value > state.hold[state.holdAt]) state.hold[state.holdAt] = value;
  let held = -Infinity;
  for (let k = 0; k < HOLD_BUCKETS; k++) if (state.hold[k] > held) held = state.hold[k];
  return held;
}

/** One partner's drawing this frame (stepPartnerYield). */
export interface PartnerYield {
  /** The lateral offset to draw, metres right of the line. */
  slotM: number;
  /**
   * How far behind its own point to draw the partner, metres: the
   * renderers move it back along the rider's drawn heading, so a dropped
   * partner holds its place behind the rider through a bend. Negative (at
   * most PARTNER_SURGE_MAX_M) while it is held ahead of a rider closing on it.
   */
  backM: number;
  /** This frame's lateral target, metres right of the line: the next partner out on this side keeps 0.9 m beyond it. */
  targetM: number;
  /** Whether the road leaves it no room beside the rider (it drops back); the next partner out drops back with it. */
  blocked: boolean;
}

/** Options of stepPartnerYield. */
export interface PartnerYieldOptions {
  /** This frame's targetM of partner index − 2, the next one in on the same side: the partner keeps 0.9 m beyond it. */
  innerTargetM?: number;
  /**
   * Whether partner index − 2 is dropping back this frame: then this one
   * drops back with it, level with it behind the rider, rather than riding
   * on beside the rider past it.
   */
  innerBlocked?: boolean;
  /**
   * The rider as drawn, seen from the partner's point on the route line
   * moved `backM` back the way the renderer draws it, in the partner's drawn
   * heading. Without it the rider is taken `gap − backM` metres away along a
   * straight road, at its lane offset. At a bend the partner's heading (its
   * own smoothed chord, at its own distance) is off the rider's, so the
   * straight-road picture is off by tens of centimetres across: only the
   * drawn geometry keeps the partner 0.9 m clear there.
   */
  riderAt?: (backM: number) => RiderLocal;
  /**
   * Partner index − 2 as drawn this frame, seen the same way: the partner
   * keeps 0.9 m from it too, wherever along the route either one is drawn
   * (one dropped back and the other not, at a bend).
   */
  innerAt?: (backM: number) => RiderLocal;
  /**
   * The partners before this one in roster order, as drawn this frame, seen
   * the same way: the partner is held 0.9 m off each along the road where it
   * is less than that across (holdOff). Partners riding past each other meet
   * like that at bends and hairpins, one dropped back or held ahead.
   */
  peersAt?: readonly ((backM: number) => RiderLocal)[];
}

/**
 * Advance pace partner `index` one frame: where across the road and how far
 * behind its own point it is drawn, giving way to `rider` (null: no rider
 * to give way to; the partner rides its slot, stepPartnerSlot).
 *
 * - Beside the rider (level, or closing to level within
 *   PARTNER_LOOK_AHEAD_S) the partner keeps PARTNER_SLOT_FLOOR_M from the
 *   rider's reach (laneReach: where it rides or is heading), measured from
 *   the rider's drawn position, not from the line. It holds that for
 *   PARTNER_YIELD_HOLD_S after the rider has moved clear, then eases home.
 *   Partners away from the rider, and partners the rider steers away from,
 *   stay in their slots.
 * - It moves further out on its own side (partnerSlotM with the rider's
 *   lateral), never in, so sides never swap. Where the drawn road is too
 *   narrow for that (partnerClearsRider), it drops back to
 *   PARTNER_DROP_GAP_M behind the rider instead, at most PARTNER_DROP_MAX_M
 *   behind its own point; partner index − 2 dropping back takes this one
 *   back with it. It moves up again once it has moved out clear of the
 *   rider's reach (the road widened, or the rider moved away).
 * - While its drawn position is within 0.9 m of the rider along its heading
 *   (dropping back, moving up, or overtaking a rider it can't ride beside),
 *   it stands off across the road as far as that gap needs
 *   (besideClearanceM), off the drawn road if it must; the same from
 *   partner index − 2 (innerAt).
 * - Where that is not enough this frame (the rider swerved or a bend turned
 *   it toward the partner faster than the partner moves across), the
 *   partner is held on its side of the rider along the road, 0.9 m away
 *   (holdOff): it is drawn up to PARTNER_SURGE_MAX_M ahead of its own point
 *   or further back, and pulls out to get past. No frame draws it inside
 *   0.9 m of the rider.
 * - Across the road it moves at PARTNER_SLOT_MAX_RATE_MPS at most, eased;
 *   along it at PARTNER_DROP_MAX_RATE_MPS, eased, except while held off,
 *   when it keeps its gap to the rider.
 */
export function stepPartnerYield(
  state: PartnerYieldState,
  index: number,
  span: RoadSpan | null | undefined,
  partner: { distance: number; speed: number },
  rider: RiderBeside | null | undefined,
  dt: number,
  opts: PartnerYieldOptions = {},
): PartnerYield {
  const i = Math.max(0, Math.floor(index));
  const side = Math.sign(baseSlotM(i));
  const home = side * partnerSlotM(i, span);
  const jumped = !Number.isFinite(state.slot.distance) || Math.abs(partner.distance - state.slot.distance) > YAW_SNAP_M;
  if (jumped) {
    state.hold.fill(-Infinity);
    state.holdAt = 0;
    state.holdT = 0;
    state.back = NaN;
    state.gap = NaN;
    state.along = NaN;
    state.innerAlong = NaN;
    state.pressed = false;
    state.peerAlong.length = 0;
  }

  // How far ahead of the rider along the route the partner's own point is.
  const gap = rider ? partner.distance - rider.distance : 0;
  // How much further toward this side the rider is heading than where it rides.
  const reachExtra = rider ? Math.max(0, side > 0 ? rider.rightM - rider.laneOffsetM : rider.laneOffsetM - rider.leftM) : 0;
  const riderAt = (backM: number): RiderLocal =>
    opts.riderAt ? opts.riderAt(backM) : { alongM: backM - gap, acrossM: rider ? rider.laneOffsetM : 0 };
  let needNow = -Infinity;
  // How far out the partner must ride to clear the rider's reach level with it.
  let levelNeed = -Infinity;
  if (rider) {
    levelNeed = side * riderAt(0).acrossM + reachExtra + PARTNER_SLOT_FLOOR_M;
    const closing = -Math.sign(gap) * (partner.speed - rider.speed);
    const clear = besideClearanceM(foreseenGapM(gap, closing));
    if (clear > 0) needNow = levelNeed - PARTNER_SLOT_FLOOR_M + clear;
  }
  // How far out (side metres) it must be to clear the rider beside it, held for PARTNER_YIELD_HOLD_S.
  const need = holdNeed(state, needNow, jumped ? 0 : dt);

  let target = side * home;
  let blocked = false;
  if (need > home) {
    const riderLateral = side * (need - PARTNER_SLOT_FLOOR_M);
    target = partnerSlotM(i, span, riderLateral);
    blocked = !partnerClearsRider(i, span, riderLateral) || (i >= 2 && !!opts.innerBlocked);
  }
  // A dropped-back partner moves up again only once it rides clear of the
  // rider across the road: where the road widens under it, it first moves
  // out, then up, never up faster than it can move out.
  const stayBack = state.back > 0 && !(side * state.slot.m >= levelNeed - PARTNER_UP_SLACK_M);
  // A partner drawn ahead of the rider stays ahead (it would pass through
  // the rider to get behind it): the stand-off below moves it across instead.
  const ahead = state.along < 0;
  const wantBack = (blocked || stayBack) && !ahead ? gap + PARTNER_DROP_GAP_M : 0;
  // Faster than the rider and PARTNER_DROP_MAX_M behind its own point, a
  // blocked partner overtakes: it pulls out level with the rider's reach,
  // off the drawn road if it must, and passes 0.9 m from it.
  const overtaking = blocked && wantBack > PARTNER_DROP_MAX_M;
  const backTarget = Math.max(0, Math.min(PARTNER_DROP_MAX_M, wantBack));
  let back = Number.isFinite(state.back) ? easeToward(state.back, backTarget, dt, PARTNER_DROP_TAU_S, PARTNER_DROP_MAX_RATE_MPS) : backTarget;
  // The eased approach never quite arrives: the last millimetre is snapped, so a partner that has moved up is level again.
  if (Math.abs(back - backTarget) < 1e-3) back = backTarget;
  state.back = back;

  // Standing off across the road while the drawn gap along it is under the floor.
  let floor = -Infinity;
  if (rider) {
    const at = riderAt(back);
    const drawnGap = Math.abs(at.alongM);
    const closing = Number.isFinite(state.gap) && dt > 0 ? (state.gap - drawnGap) / dt : 0;
    state.gap = drawnGap;
    const clear = besideClearanceM(foreseenGapM(drawnGap, closing));
    // Off its own point along the road (dropping back, moving up, held off), it aims a little wider.
    const margin = back !== 0 || overtaking || state.pressed ? PARTNER_YIELD_MARGIN_M : 0;
    if (clear > 0) target = side * Math.max(side * target, side * at.acrossM + reachExtra + clear + margin);
    // Overtaking, or held off the rider last frame: out to the full clearance, so it gets past.
    if (overtaking) target = side * Math.max(side * target, levelNeed + margin);
    if (state.pressed) target = side * Math.max(side * target, side * at.acrossM + reachExtra + PARTNER_SLOT_FLOOR_M + margin);
    // This frame's own clearance, from where the rider is drawn now.
    const now = besideClearanceM(drawnGap);
    if (now > 0) floor = side * at.acrossM + now;
  }
  if (i >= 2 && opts.innerTargetM !== undefined) {
    target = side * Math.max(side * target, side * opts.innerTargetM + PARTNER_SLOT_FLOOR_M);
  }
  if (i >= 2 && opts.innerAt) {
    const inner = opts.innerAt(back);
    const innerGap = Math.abs(inner.alongM);
    const closing = Number.isFinite(state.innerAlong) && dt > 0 ? (Math.abs(state.innerAlong) - innerGap) / dt : 0;
    const clear = besideClearanceM(foreseenGapM(innerGap, closing));
    if (clear > 0) target = side * Math.max(side * target, side * inner.acrossM + clear + (state.pressed ? PARTNER_YIELD_MARGIN_M : 0));
    const now = besideClearanceM(innerGap);
    if (now > 0) floor = Math.max(floor, side * inner.acrossM + now);
  } else {
    state.innerAlong = NaN;
  }
  if (floor > side * target) target = side * floor;

  const from = state.slot.m;
  let slotM = stepPartnerSlot(state.slot, target, partner.distance, dt);
  // Short of this frame's clearance (the target itself is further out), the
  // partner closes on it at the full drift rate rather than the eased tail:
  // a bend can turn the rider toward a dropping partner faster than the tail moves.
  if (side * slotM < floor && Number.isFinite(from) && !jumped) {
    slotM = side * Math.min(floor, side * from + PARTNER_SLOT_MAX_RATE_MPS * dt, side * target);
    state.slot.m = slotM;
  }
  // Still short of 0.9 m across (the rider turned or closed faster than it
  // could move over), the partner is held on its side of the partners drawn
  // before it, of partner index − 2 and then of the rider along the road,
  // 0.9 m away: never drawn through any. The rider has the last word.
  let pressed = false;
  const peers = opts.peersAt ?? [];
  for (let k = 0; k < peers.length; k++) {
    const held = holdOff(peers[k], back, slotM, state.peerAlong[k] ?? NaN);
    back = held.back;
    state.peerAlong[k] = held.along;
  }
  state.peerAlong.length = peers.length;
  if (i >= 2 && opts.innerAt) {
    const held = holdOff(opts.innerAt, back, slotM, state.innerAlong);
    back = held.back;
    state.innerAlong = held.along;
    pressed = held.pressed;
  }
  if (rider) {
    const held = holdOff(riderAt, back, slotM, state.along);
    back = held.back;
    state.along = held.along;
    pressed ||= held.pressed;
  }
  state.back = back;
  state.pressed = pressed;
  return { slotM, backM: back, targetM: target, blocked };
}

/**
 * Keep a partner drawn at lateral `slotM`, `back` metres behind its own
 * point, PARTNER_SLOT_FLOOR_M from what `seen` shows: where it is less than
 * that across, move `back` (ahead or behind, the side along the road it was
 * on last frame, `prevAlong`) until it is that far. Returns the new back,
 * the drawn gap along the road, and whether it had to move.
 */
function holdOff(
  seen: (backM: number) => RiderLocal,
  back: number,
  slotM: number,
  prevAlong: number,
): { back: number; along: number; pressed: boolean } {
  let at = seen(back);
  const sgn = (Number.isFinite(prevAlong) ? prevAlong : at.alongM) >= 0 ? 1 : -1;
  const lo = -PARTNER_SURGE_MAX_M;
  // Held behind while it pulls out to overtake, it may fall a little further than a drop-back goes.
  const hi = PARTNER_DROP_MAX_M + 2 * PARTNER_DROP_GAP_M;
  let pressed = false;
  // Moving back along the rider's heading also moves it across the partner's
  // own heading at a bend: re-solve with the new gap across, a few times.
  for (let n = 0; n < 8; n++) {
    const sep = Math.abs(slotM - at.acrossM);
    if (!(sep < PARTNER_SLOT_FLOOR_M - 1e-9)) break;
    const q = Math.sqrt(PARTNER_SLOT_FLOOR_M * PARTNER_SLOT_FLOOR_M - sep * sep);
    if (sgn * at.alongM >= q - 1e-9) break;
    pressed = true;
    // How the drawn gap moves with `back` (1 along a straight road).
    const k = seen(back + 1).alongM - at.alongM;
    if (!(k > 0.5)) break;
    const next = Math.max(lo, Math.min(hi, back + (sgn * q - at.alongM) / k));
    if (next === back) break;
    back = next;
    at = seen(back);
  }
  return { back, along: at.alongM, pressed };
}

/**
 * Move a point `m` metres across a travel heading (radians clockwise from
 * north): + = right of travel. The same shift the rider's lane offset uses.
 */
export function offsetLatLon(lat: number, lon: number, heading: number, m: number): { lat: number; lon: number } {
  return offsetSideways(lat, lon, heading, m);
}
