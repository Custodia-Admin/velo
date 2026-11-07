/**
 * Pace partners on the photoreal globe: one avatar per bot, built when the
 * route loads (CesiumWorldView) and moved every frame. Engine-free apart from
 * the avatar handle it is given, so it runs in the node test env.
 *
 * Each partner rides in its lateral slot beside the route line
 * (lib/ride/partnerSlots), clamped to the road corridor this renderer draws:
 * the bots' own lat/lon is the line the rider follows, so unshifted they
 * stand inside the rider on the start line. The photoreal rider steers off
 * the line too (CesiumWorldView applies the lane offset), so the partners
 * give way to it by the same rule as the world renderer's
 * (partnerSlots.stepPartnerYield).
 */
import type { Avatar } from '@/lib/avatar';
import { CORRIDOR_HALF_WIDTH_M } from '@/lib/cesiumCameras';
import { headingAt, sampleRouteAtDistance } from '@/lib/gpxParser';
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
    const at = sampleRouteAtDistance(route, d);
    const heading = headingAt(route, d);
    const slot = botSlotLatLon(i, at.lat, at.lon, heading);
    avatar.update({
      lon: slot.lon,
      lat: slot.lat,
      ele: at.ele,
      heading,
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
  /** The route, for a dropped-back partner's elevation. */
  route: Route;
  /** The rider this frame (partnerSlots.laneReach for its reach), or null. */
  rider: RiderBeside | null;
  /** Where the rider is drawn (its lane offset applied) and its drawn heading. */
  riderLat: number;
  riderLon: number;
  riderHeading: number;
}

const EARTH_RADIUS_M = 6_371_000;
const DEG = Math.PI / 180;

/**
 * Move each bot avatar to its bot's live state, in its slot across the
 * bot's heading. With `giveWay`, each partner also gives way to the rider
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
  // Partners i − 2 and i − 1 as drawn this frame (target, lat/lon): each keeps clear of the one in on its side.
  let innerTwo: { targetM: number; blocked: boolean; lat: number; lon: number } | undefined;
  let innerOne: { targetM: number; blocked: boolean; lat: number; lon: number } | undefined;
  for (let i = 0; i < bots.length; i++) {
    const bs = bots[i].state;
    let lat = bs.lat;
    let lon = bs.lon;
    let ele = bs.ele;
    const heading = bs.heading;
    let slotM: number;
    let targetM = NaN;
    let blocked = false;
    if (giveWay) {
      const state = (giveWay.states[i] ??= createPartnerYieldState());
      const { riderLat, riderLon, riderHeading } = giveWay;
      // A drawn point seen from the partner's point moved `backM` back along the rider's heading, in the partner's heading.
      const h = bs.heading;
      const seen = (lat2: number, lon2: number) => (backM: number) => {
        const ex = (lon2 - bs.lon) * DEG * EARTH_RADIUS_M * Math.cos(bs.lat * DEG) + backM * Math.sin(riderHeading);
        const ey = (lat2 - bs.lat) * DEG * EARTH_RADIUS_M + backM * Math.cos(riderHeading);
        return { alongM: ex * Math.sin(h) + ey * Math.cos(h), acrossM: ex * Math.cos(h) - ey * Math.sin(h) };
      };
      const inner = i >= 2 ? innerTwo : undefined;
      const step = stepPartnerYield(state, i, CORRIDOR_SPAN, bs, giveWay.rider, dt, {
        innerTargetM: inner?.targetM,
        innerBlocked: inner?.blocked,
        riderAt: seen(riderLat, riderLon),
        innerAt: inner ? seen(inner.lat, inner.lon) : undefined,
      });
      slotM = step.slotM;
      targetM = step.targetM;
      blocked = step.blocked;
      if (step.backM !== 0) {
        const at = offsetLatLon(lat, lon, riderHeading - Math.PI / 2, -step.backM);
        lat = at.lat;
        lon = at.lon;
        const { route } = giveWay;
        ele = sampleRouteAtDistance(route, Math.max(0, Math.min(route.totalDistance, bs.distance - step.backM))).ele;
      }
    } else {
      slotM = partnerSlotM(i, CORRIDOR_SPAN);
    }
    const slot = offsetLatLon(lat, lon, bs.heading, slotM);
    if (giveWay) [innerTwo, innerOne] = [innerOne, { targetM, blocked, lat: slot.lat, lon: slot.lon }];
    avatars[i].update({
      lon: slot.lon,
      lat: slot.lat,
      ele,
      heading,
      speed: bs.speed,
      // cadence: 0 → avatar estimates from speed (cadence ≈ speed / 0.12 rev/s * 60 rpm)
      cadence: 0,
      grade: 0,
      dt,
      riderPosition: 'hoods', // bots always ride hoods position
    });
  }
  return true;
}
