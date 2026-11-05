/**
 * Show mode's auto camera: the cinematic director (src/lib/world/director.ts)
 * driven by the ride. Both renderers call `showDirectorFrame` once per frame
 * while show mode is on; it returns null when the rider's own camera applies
 * (show mode off, or the rider took the camera over).
 *
 * One director per show session (route + the moment show mode started), so
 * the edit carries on when the ride moves between the tab and the floating
 * window, and starts afresh with a new show. Seeded from the route id: the
 * same route gets the same edit for the same ride.
 *
 * Pure apart from that one session; the renderers read the stores.
 */

import type { CameraMode } from '@/lib/cesiumCameras';
import {
  createDirector,
  seedFromString,
  type Director,
  type DirectorFrame,
  type DirectorLandmark,
  type DirectorShot,
} from '@/lib/world/director';

export interface DirectorGate {
  /** Show mode is on (a video panel, or the ride floating over another tab). */
  active: boolean;
  /** The rider has not taken manual control of the camera. */
  autoCamera: boolean;
  /** performance.now() when show mode started. */
  startedAtMs: number | null;
}

export interface DirectorRide {
  routeId: string | null;
  /** Route distance, metres. */
  distance: number;
  /** m/s. */
  speed: number;
  /** Shaped handlebar steering (controllerStore.activeSteer). */
  steer: number;
}

let session: { key: string; director: Director } | null = null;

/** The director's shot for this frame, or null when the rider's own camera applies. */
export function showDirectorFrame(
  gate: DirectorGate,
  ride: DirectorRide,
  nowMs: number,
  landmarks: readonly DirectorLandmark[] = [],
): DirectorFrame | null {
  if (!gate.active || !gate.autoCamera || gate.startedAtMs === null) return null;
  const key = `${ride.routeId ?? ''}@${gate.startedAtMs}`;
  if (!session || session.key !== key) {
    session = { key, director: createDirector({ seed: seedFromString(ride.routeId ?? 'velo') }) };
  }
  return session.director.update({
    t: nowMs / 1000,
    distance: ride.distance,
    speed: ride.speed,
    steer: ride.steer,
    landmarks,
  });
}

/** Forget the session (tests). */
export function resetShowDirector(): void {
  session = null;
}

/**
 * The photoreal (Cesium) renderer has no front, dolly or landmark orbit, and
 * its road-height cameras clip into streamed terrain on rolling routes: it
 * films the director's edit with its calm modes.
 */
export const CESIUM_SHOT_MODE: Readonly<Record<DirectorShot, CameraMode>> = {
  chase: 'chase',
  side: 'drone',
  orbit: 'cinematic',
  front: 'cinematic',
  pov: 'chase',
};

/** The camera mode the photoreal ride view should use this frame. */
export function effectiveCameraMode(
  riderMode: CameraMode,
  gate: DirectorGate,
  ride: DirectorRide,
  nowMs: number,
): CameraMode {
  const frame = showDirectorFrame(gate, ride, nowMs);
  return frame ? CESIUM_SHOT_MODE[frame.shot] : riderMode;
}
