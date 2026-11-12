/**
 * Pace partners on the photoreal globe: one avatar per bot, built when the
 * route loads (CesiumWorldView) and moved every frame. Engine-free apart from
 * the avatar handle it is given, so it runs in the node test env.
 *
 * Each partner is drawn by the rider's own rule (lib/ride/rideLine,
 * cornerLean): on the drawn line at its distance, facing along it, leaning
 * into the bend. It rides in its lateral slot beside that line
 * (lib/ride/partnerSlots), clamped to the road corridor this renderer draws:
 * unshifted, partners stand inside the rider on the start line. The photoreal rider steers off
 * the line too (CesiumWorldView applies the lane offset), so the partners
 * give way to it by the same rule as the world renderer's
 * (partnerSlots.stepPartnerYield).
 */
import type { Avatar } from '@/lib/avatar';
import { CORRIDOR_HALF_WIDTH_M } from '@/lib/cesiumCameras';
import { sampleRouteAtDistance } from '@/lib/gpxParser';
import { BOT_COLORWAYS, type PaceBot } from '@/lib/paceBots';
import {
  createPartnerYieldState,
  offsetLatLon,
  partnerSlotM,
  stepPartnerYield,
  type PartnerYieldState,
  type RiderBeside,
  type RoadSpan,
} from '@/lib/ride/partnerSlots';
import { cornerLeanTarget, LEAN_LEAD_S, stepCornerLean } from '@/lib/ride/cornerLean';
import { createLinePoint, lineAt, offsetFacing } from '@/lib/ride/rideLine';
import type { Route } from '@/types';

/** The road corridor the photoreal view lays along the route (routeSurface.createRoadEntity), across the heading. */
export const CORRIDOR_SPAN: RoadSpan = { leftM: -CORRIDOR_HALF_WIDTH_M, rightM: CORRIDOR_HALF_WIDTH_M };

/** Where partner `index` stands, given its point on the route line and its heading. */
export function botSlotLatLon(index: number, lat: number, lon: number, heading: number): { lat: number; lon: number } {
  return offsetLatLon(lat, lon, heading, partnerSlotM(index, CORRIDOR_SPAN));
}

/**
 * One avatar per pace partner, in BOT_COLORWAYS order, each placed with an
 * `update()` as soon as it exists: at the partner's distance along `route`
 * (the start line after a route load), in its slot, standing still. An
 * avatar that is unplaced when the first frame renders can crash Cesium's
 * render loop, and the per-frame bot updates only take over once the ride
 * loop runs them.
 */
export function placeBotAvatars(bots: readonly PaceBot[], route: Route, make: () => Avatar): Avatar[] {
  return bots.map((bot, i) => {
    const avatar = make();
    avatar.setColors(BOT_COLORWAYS[i % BOT_COLORWAYS.length]);
    const d = Math.max(0, Math.min(route.totalDistance, bot.state.distance));
    const on = lineAt(route, d, point);
    const slot = botSlotLatLon(i, on.lat, on.lon, on.frameHeading);
    avatar.update({
      lon: slot.lon,
      lat: slot.lat,
      ele: sampleRouteAtDistance(route, d).ele,
      heading: offsetFacing(on, partnerSlotM(i, CORRIDOR_SPAN)),
      speed: 0,
      cadence: 0,
      grade: 0,
      dt: 0,
      riderPosition: 'hoods',
    });
    return avatar;
  });
}

/** What the photoreal partners need to give way to the rider (updateBotAvatars). */
export interface BotGiveWay {
  /** One state per partner, carried between frames (created as needed). */
  states: PartnerYieldState[];
  /** Each partner's eased corner lean, carried between frames (created as needed). */
  leans?: number[];
  /** The route: the drawn line the partners ride on, and a dropped-back partner's elevation. */
  route: Route;
  /** The rider this frame (partnerSlots.laneReach for its reach), or null. */
  rider: RiderBeside | null;
  /** Where the rider is drawn (its lane offset applied), and the line's sideways frame there (RideLine.frameHeading). */
  riderLat: number;
  riderLon: number;
  riderHeading: number;
}

const EARTH_RADIUS_M = 6_371_000;
const DEG = Math.PI / 180;
const point = createLinePoint();
const leanPoint = createLinePoint();

/**
 * Move each bot avatar to its bot's live state, in its slot across its
 * heading. With `giveWay`, each partner is drawn on the drawn line at its
 * distance, facing along it and leaning into the bend, as the rider is (the
 * bot's own lat/lon and ±4 m chord heading otherwise), and gives way to the rider
 * (partnerSlots.stepPartnerYield, on the corridor): eased into its slot,
 * further out when the rider steers toward it, and, where the corridor
 * leaves no room, drawn behind its own point along the rider's heading, as
 * the world renderer does (rideDriver.placeBot). The 3.5 m corridor holds a
 * full-lock rider and partners 0–3 beyond it, so only a fifth partner
 * would ever drop back here. Does nothing
 * when the roster and the avatars disagree (bots added after the route
 * loaded get no avatar until a route loads again). Returns whether it moved
 * them.
 */
export function updateBotAvatars(bots: readonly PaceBot[], avatars: readonly Avatar[], dt: number, giveWay?: BotGiveWay): boolean {
  if (bots.length !== avatars.length || bots.length === 0) return false;
  // The partners drawn so far this frame (target, lat/lon): each keeps clear of them, and beyond the one in on its side.
  const drawn: { targetM: number; blocked: boolean; lat: number; lon: number }[] = [];
  for (let i = 0; i < bots.length; i++) {
    const bs = bots[i].state;
    let lat = bs.lat;
    let lon = bs.lon;
    let ele = bs.ele;
    let heading = bs.heading;
    let facing = bs.heading;
    let lean = 0;
    let onLine = false;
    let slotM: number;
    let targetM = NaN;
    let blocked = false;
    if (giveWay) {
      const { route } = giveWay;
      const on = lineAt(route, bs.distance, point);
      onLine = true;
      lat = on.lat;
      lon = on.lon;
      // The slot goes across the line's sideways frame, which turns with the line but never loops a tight inside corner.
      heading = on.frameHeading;
      const leans = (giveWay.leans ??= []);
      lean = stepCornerLean(leans[i] ?? 0, cornerLeanTarget(bs.speed, lineAt(route, bs.distance + bs.speed * LEAN_LEAD_S, leanPoint)), dt);
      leans[i] = lean;
      const state = (giveWay.states[i] ??= createPartnerYieldState());
      const { riderLat, riderLon, riderHeading } = giveWay;
      // A drawn point seen from the partner's point moved `backM` back along the rider's heading, in the partner's heading.
      const pLat = lat;
      const pLon = lon;
      const h = heading;
      const seen = (lat2: number, lon2: number) => (backM: number) => {
        const ex = (lon2 - pLon) * DEG * EARTH_RADIUS_M * Math.cos(pLat * DEG) + backM * Math.sin(riderHeading);
        const ey = (lat2 - pLat) * DEG * EARTH_RADIUS_M + backM * Math.cos(riderHeading);
        return { alongM: ex * Math.sin(h) + ey * Math.cos(h), acrossM: ex * Math.cos(h) - ey * Math.sin(h) };
      };
      const inner = i >= 2 ? drawn[i - 2] : undefined;
      const step = stepPartnerYield(state, i, CORRIDOR_SPAN, bs, giveWay.rider, dt, {
        innerTargetM: inner?.targetM,
        innerBlocked: inner?.blocked,
        riderAt: seen(riderLat, riderLon),
        innerAt: inner ? seen(inner.lat, inner.lon) : undefined,
        peersAt: drawn.map((p) => seen(p.lat, p.lon)),
      });
      slotM = step.slotM;
      targetM = step.targetM;
      blocked = step.blocked;
      if (step.backM !== 0) {
        const at = offsetLatLon(lat, lon, riderHeading - Math.PI / 2, -step.backM);
        lat = at.lat;
        lon = at.lon;
        ele = sampleRouteAtDistance(route, Math.max(0, Math.min(route.totalDistance, bs.distance - step.backM))).ele;
      }
    } else {
      slotM = partnerSlotM(i, CORRIDOR_SPAN);
    }
    const slot = offsetLatLon(lat, lon, heading, slotM);
    if (onLine) facing = offsetFacing(point, slotM);
    if (giveWay) drawn.push({ targetM, blocked, lat: slot.lat, lon: slot.lon });
    avatars[i].update({
      lon: slot.lon,
      lat: slot.lat,
      ele,
      heading: facing,
      speed: bs.speed,
      // cadence: 0 → avatar estimates from speed (cadence ≈ speed / 0.12 rev/s * 60 rpm)
      cadence: 0,
      grade: 0,
      dt,
      riderPosition: 'hoods', // bots always ride hoods position
      lean,
    });
  }
  return true;
}
