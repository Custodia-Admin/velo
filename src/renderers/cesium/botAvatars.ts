/**
 * Pace partners on the photoreal globe: one avatar per bot, built when the
 * route loads (CesiumWorldView). Engine-free apart from the avatar handle it
 * is given, so it runs in the node test env.
 */
import type { Avatar } from '@/lib/avatar';
import { headingAt, sampleRouteAtDistance } from '@/lib/gpxParser';
import { BOT_COLORWAYS, type PaceBot } from '@/lib/paceBots';
import type { Route } from '@/types';

/**
 * One avatar per pace partner, in BOT_COLORWAYS order, each placed with an
 * `update()` as soon as it exists: at the partner's distance along `route`
 * (the start line after a route load), standing still. An avatar that is
 * unplaced when the first frame renders can crash Cesium's render loop, and
 * the per-frame bot updates only take over once the ride loop runs them.
 */
export function placeBotAvatars(bots: readonly PaceBot[], route: Route, make: () => Avatar): Avatar[] {
  return bots.map((bot, i) => {
    const avatar = make();
    avatar.setColors(BOT_COLORWAYS[i % BOT_COLORWAYS.length]);
    const d = Math.max(0, Math.min(route.totalDistance, bot.state.distance));
    const at = sampleRouteAtDistance(route, d);
    avatar.update({
      lon: at.lon,
      lat: at.lat,
      ele: at.ele,
      heading: headingAt(route, d),
      speed: 0,
      cadence: 0,
      grade: 0,
      dt: 0,
      riderPosition: 'hoods',
    });
    return avatar;
  });
}
