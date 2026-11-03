import type { RideState } from '@/types';

/**
 * Whether the Cesium scene can render on demand (scene.requestRenderMode)
 * instead of every display frame.
 *
 * Paused or finished, nothing in the scene moves by itself: the rider, the
 * chase camera, pace bots, ghosts and the sun clock all stand still, so
 * re-drawing an identical frame 60 times a second only heats the iGPU and
 * drains the battery. Cesium still renders on camera input, tile arrivals and
 * explicit requestRender() calls (settings changes, resize).
 *
 * Riders connected over multiplayer keep moving while we're paused, so their
 * avatars need continuous frames.
 */
export function shouldRenderOnDemand(rideState: RideState, connectedPeers: number): boolean {
  if (connectedPeers > 0) return false;
  return rideState === 'paused' || rideState === 'finished';
}
