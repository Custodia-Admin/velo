/**
 * Camera rig for the world renderer: where each camera mode wants to be
 * (pure geometry over the rider's frame) and frame-rate independent
 * smoothing toward it. No three.js — plain {x, y, z} in three.js world
 * coordinates (x east, y up, z south).
 */

import { AIM_HEIGHT_M, type CameraDistance, type ChaseFraming } from '@/lib/world/cameraFraming';
import type { WorldCameraMode } from '@/lib/world/renderer';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Rider frame the camera is placed from. */
export interface RigInput {
  /** Rider ground contact, three.js world coordinates. */
  rider: Vec3;
  /** Direction of travel, radians clockwise from north. */
  heading: number;
  /** Point on the route `framing.lookAheadM` ahead, on the ground. */
  ahead: Vec3;
  speed: number;
  cadence: number;
  /** Seconds, monotonic (orbits, sway, head bob). */
  timeS: number;
}

export interface CameraTarget {
  position: Vec3;
  look: Vec3;
}

/** Scale of the non-chase modes per camera distance. */
export const MODE_SCALE: Readonly<Record<CameraDistance, number>> = {
  close: 0.7,
  standard: 1,
  far: 1.8,
  overview: 3.2,
};

export const FIRST_PERSON_EYE_M = 1.25;
export const FIRST_PERSON_FORWARD_M = 0.45;
/** Lowest the camera goes above the ground under it, metres. */
export const MIN_CLEARANCE_M = 0.8;
/** A target that jumps further than this in one frame is a teleport: cut, don't glide. */
export const SNAP_DISTANCE_M = 60;

/** Smoothing time constants (seconds) per mode: position, look point. */
export const MODE_TAU: Readonly<Record<WorldCameraMode, { pos: number; look: number }>> = {
  chase: { pos: 0.28, look: 0.14 },
  firstPerson: { pos: 0.04, look: 0.08 },
  overhead: { pos: 0.5, look: 0.25 },
  sideTracking: { pos: 0.45, look: 0.2 },
  cinematic: { pos: 0.6, look: 0.3 },
  drone: { pos: 0.9, look: 0.5 },
};
/** While switching modes the camera glides with this time constant. */
export const TRANSITION_TAU_S = 0.55;
export const TRANSITION_S = 1.6;

/** Forward unit vector in three.js x/z for a compass heading. */
export function forwardXZ(heading: number): [number, number] {
  return [Math.sin(heading), -Math.cos(heading)];
}

/** Where `mode` wants the camera this frame (before smoothing and ground clearance). */
export function cameraTarget(
  mode: WorldCameraMode,
  input: RigInput,
  framing: ChaseFraming,
  distance: CameraDistance,
): CameraTarget {
  const { rider, ahead, heading, timeS } = input;
  const [fx, fz] = forwardXZ(heading);
  // Right of travel in three.js x/z.
  const rx = -fz;
  const rz = fx;
  const k = MODE_SCALE[distance] ?? 1;
  const at = (dx: number, dy: number, dz: number): Vec3 => ({ x: rider.x + dx, y: rider.y + dy, z: rider.z + dz });

  switch (mode) {
    case 'firstPerson': {
      const bob = input.cadence > 0 ? Math.sin(timeS * (input.cadence / 60) * Math.PI * 2) * 0.02 : 0;
      return {
        position: at(fx * FIRST_PERSON_FORWARD_M, FIRST_PERSON_EYE_M + bob, fz * FIRST_PERSON_FORWARD_M),
        look: { x: ahead.x, y: ahead.y + AIM_HEIGHT_M * 0.4, z: ahead.z },
      };
    }
    case 'overhead':
      return {
        position: at(-fx * 4 * k, 30 * k, -fz * 4 * k),
        look: at(fx * 3, 0, fz * 3),
      };
    case 'sideTracking':
      return {
        position: at(rx * 9 * k + fx * 1.5, 3.2 * k, rz * 9 * k + fz * 1.5),
        look: at(fx * 2, 1, fz * 2),
      };
    case 'cinematic': {
      const a = timeS * ((6 * Math.PI) / 180);
      const ox = Math.cos(a) * 10 * k;
      const oz = Math.sin(a) * 10 * k;
      return { position: at(ox, 3.5 * k, oz), look: at(0, 1, 0) };
    }
    case 'drone': {
      const sway = Math.sin((timeS / 40) * Math.PI * 2) * 35;
      return {
        position: at(-fx * 120 + rx * sway, 60, -fz * 120 + rz * sway),
        look: at(fx * 40, 0, fz * 40),
      };
    }
    case 'chase':
    default:
      return {
        position: at(-fx * framing.backM, framing.upM, -fz * framing.backM),
        look: { x: ahead.x, y: ahead.y + AIM_HEIGHT_M, z: ahead.z },
      };
  }
}

/** Exponential smoothing factor for a time constant, independent of frame rate. */
export function dampFactor(tauS: number, dt: number): number {
  if (!(dt > 0)) return 0;
  if (!(tauS > 0)) return 1;
  return 1 - Math.exp(-dt / tauS);
}

function lerpInto(out: Vec3, to: Vec3, t: number) {
  out.x += (to.x - out.x) * t;
  out.y += (to.y - out.y) * t;
  out.z += (to.z - out.z) * t;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Smoothed camera state carried across frames. */
export class CameraRig {
  readonly position: Vec3 = { x: 0, y: 0, z: 0 };
  readonly look: Vec3 = { x: 0, y: 0, z: 1 };
  private initialized = false;
  private lastTarget: Vec3 = { x: 0, y: 0, z: 0 };
  private mode: WorldCameraMode | null = null;
  private transitionLeftS = 0;

  /** Forget the history: the next update cuts straight to its target. */
  reset() {
    this.initialized = false;
  }

  /**
   * Advance one frame toward `target`. `groundAt(x, z)` is the terrain height
   * under a point; the camera never goes below it plus MIN_CLEARANCE_M.
   */
  update(
    mode: WorldCameraMode,
    target: CameraTarget,
    dt: number,
    groundAt?: (x: number, z: number) => number,
  ): void {
    if (this.mode !== null && mode !== this.mode) this.transitionLeftS = TRANSITION_S;
    this.mode = mode;
    const teleport = this.initialized && dist(target.position, this.lastTarget) > SNAP_DISTANCE_M && this.transitionLeftS <= 0;
    if (!this.initialized || teleport) {
      Object.assign(this.position, target.position);
      Object.assign(this.look, target.look);
      this.initialized = true;
      this.transitionLeftS = 0;
    } else {
      const tau = MODE_TAU[mode] ?? MODE_TAU.chase;
      const gliding = this.transitionLeftS > 0;
      lerpInto(this.position, target.position, dampFactor(gliding ? Math.max(tau.pos, TRANSITION_TAU_S) : tau.pos, dt));
      lerpInto(this.look, target.look, dampFactor(gliding ? Math.max(tau.look, TRANSITION_TAU_S * 0.6) : tau.look, dt));
      this.transitionLeftS = Math.max(0, this.transitionLeftS - Math.max(0, dt));
    }
    Object.assign(this.lastTarget, target.position);
    if (groundAt) {
      const floor = groundAt(this.position.x, this.position.z) + MIN_CLEARANCE_M;
      if (this.position.y < floor) this.position.y = floor;
    }
  }
}
