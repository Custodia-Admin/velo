/**
 * The ride start waits for the world under the rider: a renderer that streams
 * its ground (Cesium tiles, the world renderer's near terrain) reports
 * `groundReady()`, and the start holds until it is true or a cap runs out, so
 * the rider never sets off on a coarse level of detail that is metres (on
 * Cesium's first tiles, up to 200 m) off the ground it will ride on.
 */

import type { WorldRenderer } from '@/lib/world/renderer';

/** Longest a start waits for the ground (ms); after that it starts anyway (offline, stalled tiles). */
export const START_HOLD_MAX_MS = 20_000;
/** How often a held start checks the ground again (ms). */
export const START_HOLD_POLL_MS = 200;

/** Whether a start that has waited `heldMs` keeps waiting for the ground. */
export function holdStart(renderer: Pick<WorldRenderer, 'groundReady'> | null, heldMs: number): boolean {
  if (!renderer?.groundReady || heldMs >= START_HOLD_MAX_MS) return false;
  return !renderer.groundReady();
}
