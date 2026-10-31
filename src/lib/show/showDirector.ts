/**
 * Auto camera for show mode: cycles chase → drone → orbit shots on a fixed
 * schedule so the world looks alive in the corner of your eye while you
 * watch something, with no taps needed mid-ride.
 *
 * Pure (no Cesium, no stores) so it is testable in node.
 */

import type { CameraMode } from '@/lib/cesiumCameras';

export interface DirectorShot {
  mode: CameraMode;
  durationMs: number;
}

/**
 * Long, calm shots. Side tracking and first person are left out: both sit at
 * road height and clip into terrain on rolling routes.
 */
export const SHOW_DIRECTOR_SHOTS: ReadonlyArray<DirectorShot> = [
  { mode: 'chase', durationMs: 45_000 },
  { mode: 'drone', durationMs: 35_000 },
  { mode: 'cinematic', durationMs: 25_000 },
  { mode: 'chase', durationMs: 35_000 },
  { mode: 'drone', durationMs: 30_000 },
];

/** Camera mode for a point in time, measured from when show mode started. */
export function directorShotAt(
  elapsedMs: number,
  shots: ReadonlyArray<DirectorShot> = SHOW_DIRECTOR_SHOTS,
): CameraMode {
  if (shots.length === 0) return 'chase';
  const total = shots.reduce((sum, s) => sum + s.durationMs, 0);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || total <= 0) return shots[0].mode;
  let t = elapsedMs % total;
  for (const shot of shots) {
    if (t < shot.durationMs) return shot.mode;
    t -= shot.durationMs;
  }
  return shots[shots.length - 1].mode;
}

export interface DirectorInput {
  /** Show mode is on (panel open or a picture-in-picture show elsewhere). */
  active: boolean;
  /** The rider has not taken manual control of the camera. */
  autoCamera: boolean;
  /** performance.now() when show mode started. */
  startedAtMs: number | null;
}

/** The camera mode the ride view should use this frame. */
export function effectiveCameraMode(
  riderMode: CameraMode,
  show: DirectorInput,
  nowMs: number,
): CameraMode {
  if (!show.active || !show.autoCamera || show.startedAtMs === null) return riderMode;
  return directorShotAt(nowMs - show.startedAtMs);
}
