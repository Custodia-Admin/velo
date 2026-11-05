/**
 * Pace partners on the photoreal globe: one avatar per bot, built when the
 * route loads (CesiumWorldView) and moved every frame. Engine-free apart from
 * the avatar handle it is given, so it runs in the node test env.
 *
 * Each partner rides in its lateral slot beside the route line
 * (lib/ride/partnerSlots), clamped to the road corridor this renderer draws:
 * the bots' own lat/lon is the line the rider follows, so unshifted they
 * stand inside the rider on the start line.
 */
import type { Avatar } from '@/lib/avatar';
import { CORRIDOR_HALF_WIDTH_M } from '@/lib/cesiumCameras';
import { headingAt, sampleRouteAtDistance } from '@/lib/gpxParser';
import { BOT_COLORWAYS, type PaceBot } from '@/lib/paceBots';
import { offsetLatLon, partnerSlotM, type RoadSpan } from '@/lib/ride/partnerSlots';
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

/**
 * Move each bot avatar to its bot's live state, in its slot across the
 * bot's heading. Does nothing when the roster and the avatars disagree (bots
 * added after the route loaded get no avatar until a route loads again).
 * Returns whether it moved them.
 */
export function updateBotAvatars(bots: readonly PaceBot[], avatars: readonly Avatar[], dt: number): boolean {
  if (bots.length !== avatars.length || bots.length === 0) return false;
  for (let i = 0; i < bots.length; i++) {
    const bs = bots[i].state;
    const slot = botSlotLatLon(i, bs.lat, bs.lon, bs.heading);
    avatars[i].update({
      lon: slot.lon,
      lat: slot.lat,
      ele: bs.ele,
      heading: bs.heading,
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
