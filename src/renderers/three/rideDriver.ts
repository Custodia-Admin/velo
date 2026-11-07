/**
 * The world renderer's per-frame ride step, pure: ride-store numbers in →
 * the RideFrame the rider, camera and sky read. ThreeWorldView's RideDriver
 * calls this every frame; the corner-framing tests call the same function.
 */

import { createLaneState, stepLane, type LaneState } from '@/lib/controllers/steerFeel';
import {
  createPartnerYieldState,
  laneReach,
  offsetLatLon,
  stepPartnerYield,
  type PartnerYieldState,
  type RiderBeside,
} from '@/lib/ride/partnerSlots';
import { routeBearingAt, smoothHeadingAt, stepDrawnHeading, YawFilter } from '@/lib/ride/rideHeading';
import { ridePose } from '@/lib/ride/rideSim';
import type { RiderPose } from '@/lib/world/renderer';
import type { RideState, Route } from '@/types';
import { dampFactor } from './chaseRig';
import { roadSpanAt, type RoadSpanMemo } from './roadSpan';
import { estimatedCadence, leanAngle, placeRider, type RiderPlacement } from './riderRig';
import type { RideFrame, SceneWorld } from './worldScene';

/** State the driver carries between frames. */
export interface RideDriverMemo {
  lane: LaneState;
  yaw: YawFilter;
}

export function createRideDriverMemo(): RideDriverMemo {
  return { lane: createLaneState(), yaw: new YawFilter() };
}

export interface RideDriverInput {
  route: Route | null;
  distance: number;
  speed: number;
  grade: number;
  cadence: number;
  power: number;
  rideState: RideState;
  /** Handlebar steer input (controllerStore.activeSteer). */
  steer: number;
  /** A pose from outside the ride loop (replays, previews), or null. */
  override: RiderPose | null;
  lookAheadM: number;
  /** Seconds since the previous frame (clamped by the caller). */
  dt: number;
  timeS: number;
  /** The drawn ground (worldScene.drawnGround); the heightfield when absent. */
  ground?: (x: number, y: number) => number;
}

export function driveRideFrame(frame: RideFrame, memo: RideDriverMemo, sceneWorld: SceneWorld, input: RideDriverInput): void {
  const { route, dt } = input;
  frame.dt = dt;
  frame.timeS = input.timeS;
  frame.rideState = input.rideState;
  if (!route || route.points.length < 2) {
    frame.valid = false;
    memo.yaw.reset();
    return;
  }
  const laneOffsetM = stepLane(memo.lane, input.steer, dt).offsetM;
  const raw = input.override;
  // Where the rider rides or is heading across the road: what the pace partners give way to.
  if (raw) frame.reach.leftM = frame.reach.rightM = raw.laneOffsetM ?? 0;
  else laneReach(memo.lane, input.steer, frame.reach);
  const distance = raw ? raw.distance : input.distance;
  // The drawn heading is the damped wide-chord heading (lib/ride/rideHeading):
  // the raw route bearing swings 114–163° within metres at sharp vertices.
  // The lane offset turns with that same filtered heading: the chord folds onto
  // itself at an out-and-back U-turn, and a steered rider would jump across the road.
  const heading = stepDrawnHeading(memo.yaw, route, distance, dt, raw?.heading);
  const pose: RiderPose = raw
    ? { ...raw, heading }
    : {
        ...ridePose(route, distance, { laneOffsetM, offsetHeading: heading, grade: input.grade, speed: input.speed }),
        heading,
      };
  const placement = placeRider(sceneWorld, pose, input.ground);
  const aheadPose = ridePose(route, Math.min(route.totalDistance, pose.distance + input.lookAheadM), {
    laneOffsetM: pose.laneOffsetM,
    offsetHeading: heading,
  });
  const ahead = placeRider(sceneWorld, aheadPose, input.ground).position;
  const speed = raw ? pose.speed : input.speed;
  frame.lean += (leanAngle(speed, memo.yaw.rate) - frame.lean) * dampFactor(0.35, dt);
  frame.pose = pose;
  frame.placement = placement;
  frame.ahead.x = ahead.x;
  frame.ahead.y = ahead.y;
  frame.ahead.z = ahead.z;
  frame.speed = speed;
  frame.cadence = input.cadence > 0 ? input.cadence : input.power > 0 ? estimatedCadence(speed) : 0;
  frame.valid = true;
}

/** State one pace bot's drawing carries between frames. */
export interface BotDriverMemo {
  yaw: YawFilter;
  lean: number;
  /** The drawn road segments around the bot (roadSpan.roadSpanAt). */
  road?: RoadSpanMemo;
  /** Its lateral slot and drop-back as drawn, eased, giving way to the rider (partnerSlots.stepPartnerYield). */
  giveWay: PartnerYieldState;
}

export function createBotDriverMemo(): BotDriverMemo {
  return { yaw: new YawFilter(), lean: 0, giveWay: createPartnerYieldState() };
}

/** Forget a partner's drawn heading and slot (it left the roster): it is seated afresh when it comes back. */
export function resetBotDriverMemo(memo: BotDriverMemo): void {
  memo.yaw.reset();
  memo.giveWay = createPartnerYieldState();
}

/**
 * The rider as the world renderer's pace partners give way to it:
 * RiderBeside plus where it is drawn (world metres east, north) and its
 * drawn heading.
 */
export interface WorldRider extends RiderBeside {
  worldX: number;
  worldY: number;
  heading: number;
}

export function createWorldRider(): WorldRider {
  return { distance: 0, speed: 0, leftM: 0, rightM: 0, laneOffsetM: 0, worldX: 0, worldY: 0, heading: 0 };
}

/**
 * The rider as the pace partners give way to it, from this frame's
 * RideFrame (written into `out`); null while the frame has no rider.
 */
export function riderBeside(frame: RideFrame, out: WorldRider = createWorldRider()): WorldRider | null {
  if (!frame.valid || !frame.pose || !frame.placement) return null;
  out.distance = frame.pose.distance;
  out.speed = frame.speed;
  out.laneOffsetM = frame.pose.laneOffsetM;
  out.leftM = Math.min(frame.reach.leftM, out.laneOffsetM);
  out.rightM = Math.max(frame.reach.rightM, out.laneOffsetM);
  out.worldX = frame.placement.worldX;
  out.worldY = frame.placement.worldY;
  out.heading = frame.pose.heading;
  return out;
}

/**
 * A pace bot's drawn heading and lean, through the same wide chord and
 * YawFilter as the rider: the bot's own `heading` is the raw ±4 m route
 * bearing, which pivots the model on the spot at sharp corners.
 */
export function driveBotPose(
  memo: BotDriverMemo,
  route: Route | null,
  bot: { distance: number; speed: number; heading: number },
  dt: number,
): { heading: number; lean: number } {
  const target = route && route.points.length >= 2 ? smoothHeadingAt(route, bot.distance, undefined, bot.heading) : bot.heading;
  const heading = memo.yaw.step(target, bot.distance, dt);
  memo.lean += (leanAngle(bot.speed, memo.yaw.rate) - memo.lean) * dampFactor(0.4, dt);
  return { heading, lean: memo.lean };
}

/** Where a pace partner is drawn this frame (placeBot). */
export interface BotPlacement {
  placement: RiderPlacement;
  lean: number;
  /** Lateral offset, metres right of the line. */
  slotM: number;
  /** How far it is drawn behind its own point, along the rider's heading, metres. */
  backM: number;
  /** This frame's lateral target (partnerSlots.PartnerYield.targetM). */
  targetM: number;
  /** Whether it is dropping back behind the rider (partnerSlots.PartnerYield.blocked). */
  blocked: boolean;
}

/**
 * Where pace partner `index` is drawn this frame: its point on the route
 * line moved into its lateral slot (lib/ride/partnerSlots) across the
 * filtered heading. Without the slot every partner stands inside the rider
 * on the start line.
 *
 * The slot is clamped to the drawn ribbon the route runs on there (the one
 * under the route point, along the route's own bearing: roadSpan.roadSpanAt),
 * but never closer than 0.9 m to the line or to the next partner in on its
 * side (partnerSlotM): on a 1.5 m path the partner rides the verge. It is
 * eased toward that target over time (stepPartnerSlot), so a partner drifts
 * over where the road narrows or a junction changes the ribbon instead of
 * jumping sideways.
 *
 * With a `rider`, the partner also gives way to it (stepPartnerYield): it
 * keeps 0.9 m from where the rider rides or is heading across the road,
 * further out on its own side where the ribbon leaves room, otherwise drawn
 * behind the rider. A dropped-back partner is drawn behind its own point
 * along the RIDER's drawn heading, not back along the route: level partners
 * then hold their formation with the rider exactly, through every bend. Back
 * along the route, a 2 m drop at a sharp vertex (Tiber 9,675 m, Assisi
 * 1,985 m, Locarno 3,416 m) put the partner 0.2–0.4 m from the rider.
 * `peers` are this frame's placements of the partners before it in roster
 * order (placeBots): it keeps 0.9 m beyond the target of partner index − 2
 * and 0.9 m from where each is drawn.
 */
export function placeBot(
  sceneWorld: SceneWorld,
  route: Route | null,
  bot: { distance: number; speed: number; heading: number; lat: number; lon: number },
  index: number,
  memo: BotDriverMemo,
  dt: number,
  ground?: (x: number, y: number) => number,
  rider?: WorldRider | null,
  peers: readonly BotPlacement[] = [],
): BotPlacement {
  const inner = index >= 2 ? peers[index - 2] : undefined;
  const { heading, lean } = driveBotPose(memo, route, bot, dt);
  const [x, y] = sceneWorld.projection.forward(bot.lat, bot.lon);
  const bearing = route && route.points.length >= 2 ? routeBearingAt(route, bot.distance, bot.heading) : bot.heading;
  const span = roadSpanAt(sceneWorld, x, y, heading, bearing, memo);
  const giveWay = route && route.points.length >= 2 ? rider : null;
  // A drawn point seen from the partner's point moved `backM` back along the rider's heading, in the partner's
  // heading. The axes are the scene's image of the slot's own shift (offsetLatLon across `heading`), not
  // sin/cos of the bearing: the world's grid north is up to ~0.2° off true north, and offsetLatLon's sphere
  // differs from the projected ellipsoid by up to 0.3 %, which 4 m back puts a centimetre off. Along is in
  // scene metres, across in slot metres.
  const unit = giveWay ? offsetLatLon(bot.lat, bot.lon, heading, 1) : null;
  const [ux, uy] = unit ? sceneWorld.projection.forward(unit.lat, unit.lon) : [x + 1, y];
  const acrossScale = Math.hypot(ux - x, uy - y) || 1;
  const rx = (ux - x) / acrossScale;
  const ry = (uy - y) / acrossScale;
  const seen = (wx: number, wy: number) => (backM: number) => {
    let px = x;
    let py = y;
    if (backM !== 0 && giveWay) {
      const p = offsetLatLon(bot.lat, bot.lon, giveWay.heading - Math.PI / 2, -backM);
      [px, py] = sceneWorld.projection.forward(p.lat, p.lon);
    }
    const ex = wx - px;
    const ey = wy - py;
    return { alongM: ey * rx - ex * ry, acrossM: (ex * rx + ey * ry) / acrossScale };
  };
  const step = stepPartnerYield(memo.giveWay, index, span, bot, giveWay, dt, {
    innerTargetM: inner?.targetM,
    innerBlocked: inner?.blocked,
    riderAt: giveWay ? seen(giveWay.worldX, giveWay.worldY) : undefined,
    innerAt: giveWay && inner ? seen(inner.placement.worldX, inner.placement.worldY) : undefined,
    peersAt: giveWay ? peers.slice(0, index).map((p) => seen(p.placement.worldX, p.placement.worldY)) : undefined,
  });
  let at = offsetLatLon(bot.lat, bot.lon, heading, step.slotM);
  if (giveWay && step.backM !== 0) at = offsetLatLon(at.lat, at.lon, giveWay.heading - Math.PI / 2, -step.backM);
  const placement = placeRider(sceneWorld, { lat: at.lat, lon: at.lon, heading }, ground);
  return { placement, lean, slotM: step.slotM, backM: step.backM, targetM: step.targetM, blocked: step.blocked };
}

/**
 * Every pace partner this frame, in roster order (placeBot each, with its
 * own memo): each partner keeps 0.9 m beyond this frame's target of the one
 * in on its side, so partners 0 and 2 never close up while one gives way,
 * and is held off the partners drawn before it.
 */
export function placeBots(
  sceneWorld: SceneWorld,
  route: Route | null,
  bots: readonly { distance: number; speed: number; heading: number; lat: number; lon: number }[],
  memos: BotDriverMemo[],
  dt: number,
  ground?: (x: number, y: number) => number,
  rider?: WorldRider | null,
): BotPlacement[] {
  const out: BotPlacement[] = [];
  for (let i = 0; i < bots.length; i++) {
    memos[i] ??= createBotDriverMemo();
    out.push(placeBot(sceneWorld, route, bots[i], i, memos[i], dt, ground, rider, out));
  }
  for (let i = bots.length; i < memos.length; i++) resetBotDriverMemo(memos[i]);
  return out;
}
