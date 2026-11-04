/**
 * The ride start waits for the world under the rider: a renderer that streams
 * its ground (Cesium tiles, the world renderer's near terrain) reports
 * `groundReady()`, and the start holds until it is true or a short cap runs
 * out, so the rider doesn't set off on a coarse level of detail that is
 * hundreds of metres off the ground it will ride on.
 *
 * The cap is short on purpose. On the owner's laptop (Intel Arc, loaded)
 * Cesium's globe takes 10-15 s to get within tens of metres of the real
 * ground and 15-25 s to the last half metre, so a long hold turned the
 * auto-start into "tap Start" (18-24 s measured with a 20 s cap). The rider
 * rides whatever is drawn in the meantime (never under it), so after the cap
 * a tile that lands later only moves the rider onto it.
 */

import type { WorldRenderer } from '@/lib/world/renderer';

/** The start waits this long after the world first paints (a beat to see the route and the chase angle). */
export const START_DELAY_MS = 600;
/** Longest a start waits for a plausible ground (ms, from the first paint); after that it starts anyway. */
export const START_HOLD_MAX_MS = 2_500;
/**
 * Longest a start waits while nothing real is drawn under the rider yet
 * (`groundPending`: Cesium's flat globe before World Terrain lands, 0.7-2.6 s
 * after the first paint on the owner's laptop); after that it starts anyway
 * (ion slow or unreachable).
 */
export const START_PENDING_MAX_MS = 6_000;
/** How often a held start checks the ground again (ms). */
export const START_HOLD_POLL_MS = 200;

/** Whether a start that has waited `heldMs` keeps waiting for the ground. */
export function holdStart(
  renderer: Pick<WorldRenderer, 'groundReady' | 'groundPending'> | null,
  heldMs: number,
): boolean {
  if (!renderer?.groundReady) return false;
  if (renderer.groundPending?.() === true) return heldMs < START_PENDING_MAX_MS;
  if (heldMs >= START_HOLD_MAX_MS) return false;
  return !renderer.groundReady();
}
