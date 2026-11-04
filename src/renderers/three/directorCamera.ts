/**
 * The director's shots for the world renderer (src/lib/world/director.ts
 * picks them; this places the camera): chase, side dolly, drone orbit at a
 * landmark, front and POV, plus the eased blend between two shots. Pure
 * geometry in three.js world coordinates (x east, y up, z south), no
 * three.js objects.
 */

import type { DirectorLandmark, DirectorShot } from '@/lib/world/director';
import type { CameraDistance, ChaseFraming } from '@/lib/world/cameraFraming';
import type { WorldCameraMode } from '@/lib/world/renderer';
import { routeLandmarks } from '@/lib/world/routeLandmarks';
import type { Route } from '@/types';
import { cameraTarget, forwardXZ, type CameraTarget, type RigInput, type Vec3 } from './chaseRig';
import type { SceneWorld } from './worldScene';

/** A landmark along the route with its place in the scene (three.js coordinates). */
export interface SceneLandmark extends DirectorLandmark {
  position: Vec3;
}

/**
 * The named places the route passes (manifest POIs, lib/world/routeLandmarks),
 * placed in the scene: what the director can orbit. Empty for live routes.
 */
export function sceneLandmarks(route: Route | null, sw: SceneWorld): SceneLandmark[] {
  if (!route || route.isLive) return [];
  const { manifest } = sw.world;
  const byName = new Map(manifest.pois.map((p) => [p.name, p]));
  return routeLandmarks(route.points, manifest).flatMap((l) => {
    const poi = byName.get(l.name);
    if (!poi) return [];
    const y = sw.heightfield.sampleHeight(poi.x, poi.y);
    return [{ name: l.name, distance: l.distance, offset: l.offset, position: { x: poi.x, y: y + 10, z: -poi.y } }];
  });
}

/** Smoothing family per shot (CameraRig MODE_TAU). */
export const SHOT_RIG_MODE: Readonly<Record<DirectorShot, WorldCameraMode>> = {
  chase: 'chase',
  side: 'sideTracking',
  orbit: 'drone',
  front: 'cinematic',
  pov: 'firstPerson',
};

/** Side dolly: beside the road, sliding from behind the rider to ahead of them over the shot. */
export const SIDE_DOLLY = { outM: 7, upM: 2.4, fromM: -6, toM: 6, overS: 30 };
/** Front: on the road ahead, a little to one side, looking back at the rider. */
export const FRONT_SHOT = { sideM: 1.6, upM: 1.9, lookUpM: 1.1 };
/** Drone orbit round the rider while a landmark is near, the place behind them mid-shot. */
export const ORBIT_SHOT = { radiusM: 34, upM: 20, degPerS: 5, midS: 12, towardPoi: 0.15 };

export interface ShotContext {
  framing: ChaseFraming;
  distance: CameraDistance;
  /** Seconds since the shot started. */
  shotT: number;
  /** The orbited landmark (orbit only). */
  poi: Vec3 | null;
  /**
   * Compass bearing from the rider to the landmark when the orbit started
   * (radians clockwise from north), so the orbit is a true orbit rather than
   * a swing that follows the place round.
   */
  poiBearing: number | null;
}

const add = (a: Vec3, dx: number, dy: number, dz: number): Vec3 => ({ x: a.x + dx, y: a.y + dy, z: a.z + dz });

/** Where `shot` wants the camera this frame (before smoothing and ground clearance). */
export function shotTarget(shot: DirectorShot, input: RigInput, ctx: ShotContext): CameraTarget {
  const { rider, heading } = input;
  const [fx, fz] = forwardXZ(heading);
  // Right of travel.
  const rx = -fz;
  const rz = fx;

  switch (shot) {
    case 'pov':
      return cameraTarget('firstPerson', input, ctx.framing, ctx.distance);
    case 'side': {
      const k = Math.min(1, Math.max(0, ctx.shotT / SIDE_DOLLY.overS));
      const along = SIDE_DOLLY.fromM + (SIDE_DOLLY.toM - SIDE_DOLLY.fromM) * k;
      return {
        position: add(rider, rx * SIDE_DOLLY.outM + fx * along, SIDE_DOLLY.upM, rz * SIDE_DOLLY.outM + fz * along),
        look: add(rider, fx * 1.5, 1, fz * 1.5),
      };
    }
    case 'front': {
      // On the route ahead (the road, not straight ahead into a wall on a bend).
      const a = input.ahead;
      return {
        position: { x: a.x + rx * FRONT_SHOT.sideM, y: a.y + FRONT_SHOT.upM, z: a.z + rz * FRONT_SHOT.sideM },
        look: add(rider, 0, FRONT_SHOT.lookUpM, 0),
      };
    }
    case 'orbit': {
      // Opposite the landmark at mid-shot, so the place sits behind the rider.
      const start = ctx.poiBearing ?? heading + Math.PI;
      const az = start + Math.PI + ((ORBIT_SHOT.degPerS * Math.PI) / 180) * (ctx.shotT - ORBIT_SHOT.midS);
      const [ox, oz] = forwardXZ(az);
      let look = add(rider, 0, 1.2, 0);
      if (ctx.poi) {
        const k = ORBIT_SHOT.towardPoi;
        look = { x: look.x + (ctx.poi.x - rider.x) * k, y: look.y + (ctx.poi.y - rider.y) * k, z: look.z + (ctx.poi.z - rider.z) * k };
      }
      return { position: add(rider, ox * ORBIT_SHOT.radiusM, ORBIT_SHOT.upM, oz * ORBIT_SHOT.radiusM), look };
    }
    case 'chase':
    default:
      return cameraTarget('chase', input, ctx.framing, ctx.distance);
  }
}

/** Compass bearing (radians clockwise from north) from `from` to `to` in three.js x/z. */
export function bearingXZ(from: Vec3, to: Vec3): number {
  return Math.atan2(to.x - from.x, -(to.z - from.z));
}

/** A target `k` of the way from `a` to `b` (k already eased by the director). */
export function blendTargets(a: CameraTarget, b: CameraTarget, k: number): CameraTarget {
  const t = Math.min(1, Math.max(0, k));
  const mix = (p: Vec3, q: Vec3): Vec3 => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, z: p.z + (q.z - p.z) * t });
  return { position: mix(a.position, b.position), look: mix(a.look, b.look) };
}
