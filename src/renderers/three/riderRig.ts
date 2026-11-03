/**
 * Rider placement on a baked world and the pedalling rig — pure math shared
 * by Rider.tsx, ChaseCamera.tsx and the tests.
 *
 * The ground is `Heightfield.sampleHeight` (the same function the bake used
 * to snap every route), never the route's GPX elevation: the rider's wheels
 * touch the heightfield exactly, whatever the route file says.
 */

import type { Heightfield } from '@/lib/world/heightfield';
import type { WorldProjection } from '@/lib/world/projection';
import type { RiderPose } from '@/lib/world/renderer';
import type { Vec3 } from './chaseRig';

/** Geometry of public/models/velo-rider.glb (scripts/gen-rider-glb.mjs RIG). */
export const RIDER_RIG = {
  wheelRadius: 0.34,
  bb: [-0.09, 0.27] as const,
  crankLength: 0.1725,
  hip: [-0.27, 1.05] as const,
  thigh: 0.46,
  shin: 0.46,
  ankleAbovePedal: 0.07,
  /** Wheel contact points ahead/behind the origin, metres. */
  halfWheelbase: 0.5,
};

export interface WorldGround {
  heightfield: Heightfield;
  projection: WorldProjection;
}

export interface RiderPlacement {
  /** Ground contact in three.js coordinates (x east, y up, z = −north). */
  position: Vec3;
  /** World metres (x east, y north) of the contact point. */
  worldX: number;
  worldY: number;
  heading: number;
  /** Nose-up pitch from the ground slope under the wheels, radians. */
  pitch: number;
}

/** Where a pose sits on the world's ground. */
export function placeRider(ground: WorldGround, pose: Pick<RiderPose, 'lat' | 'lon' | 'heading'>): RiderPlacement {
  const [x, y] = ground.projection.forward(pose.lat, pose.lon);
  const hf = ground.heightfield;
  const h = hf.sampleHeight(x, y);
  const fx = Math.sin(pose.heading);
  const fy = Math.cos(pose.heading);
  const w = RIDER_RIG.halfWheelbase;
  const front = hf.sampleHeight(x + fx * w, y + fy * w);
  const back = hf.sampleHeight(x - fx * w, y - fy * w);
  return {
    position: { x, y: h, z: -y },
    worldX: x,
    worldY: y,
    heading: pose.heading,
    pitch: Math.atan2(front - back, 2 * w),
  };
}

/** Model yaw (three.js, about +Y) for a compass heading: the model faces +X. */
export function modelYaw(heading: number): number {
  return Math.PI / 2 - heading;
}

/** Signed smallest difference a − b of two angles, radians. */
export function angleDelta(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const G = 9.81;
export const MAX_LEAN_RAD = (25 * Math.PI) / 180;

/** Steady-turn lean (+ = right) for speed v and yaw rate ω (rad/s, clockwise +). */
export function leanAngle(speed: number, yawRate: number): number {
  const lean = Math.atan((speed * yawRate) / G);
  return Math.max(-MAX_LEAN_RAD, Math.min(MAX_LEAN_RAD, Number.isFinite(lean) ? lean : 0));
}

/** Crank rpm estimated from road speed when no cadence sensor reports (50×17-ish). */
export function estimatedCadence(speed: number): number {
  return speed > 0.5 ? Math.min(110, speed * 9.7) : 0;
}

/**
 * Two-bone IK in the bike's side plane: knee position for a hip and an
 * ankle, with the knee bent forward (+x). Out-of-reach targets straighten.
 */
export function legIK(
  hip: readonly [number, number],
  ankle: readonly [number, number],
  thigh: number,
  shin: number,
): [number, number] {
  const dx = ankle[0] - hip[0];
  const dy = ankle[1] - hip[1];
  const d = Math.max(1e-6, Math.min(thigh + shin - 1e-6, Math.hypot(dx, dy)));
  // Distance along hip→ankle to the foot of the knee's perpendicular.
  const a = (thigh * thigh - shin * shin + d * d) / (2 * d);
  const hgt = Math.sqrt(Math.max(0, thigh * thigh - a * a));
  const ux = dx / Math.hypot(dx, dy || 1e-9);
  const uy = dy / Math.hypot(dx, dy || 1e-9);
  const px = hip[0] + ux * a;
  const py = hip[1] + uy * a;
  // Two candidates ±perpendicular; take the forward one.
  const k1: [number, number] = [px - uy * hgt, py + ux * hgt];
  const k2: [number, number] = [px + uy * hgt, py - ux * hgt];
  return k1[0] >= k2[0] ? k1 : k2;
}

/** Rotation about +Z that points a segment hanging along −Y from `from` to `to`. */
export function hangAngle(from: readonly [number, number], to: readonly [number, number]): number {
  return Math.atan2(to[0] - from[0], -(to[1] - from[1]));
}

export interface LegPose {
  thighAngle: number;
  knee: [number, number];
  shinAngle: number;
  ankle: [number, number];
}

/**
 * Leg pose for a crank angle (radians about +Z; 0 = right arm pointing
 * forward). `side` −1 = left leg (arm opposite the right one).
 */
export function legPose(crankAngle: number, side: 1 | -1): LegPose {
  const R = RIDER_RIG;
  const a = side === 1 ? crankAngle : crankAngle + Math.PI;
  const pedal: [number, number] = [R.bb[0] + Math.cos(a) * R.crankLength, R.bb[1] + Math.sin(a) * R.crankLength];
  let ankle: [number, number] = [pedal[0] - 0.02, pedal[1] + R.ankleAbovePedal];
  // Out of reach: the foot stays on the leg (it lifts off the pedal a touch).
  const dx = ankle[0] - R.hip[0];
  const dy = ankle[1] - R.hip[1];
  const reach = Math.hypot(dx, dy);
  const max = R.thigh + R.shin - 1e-4;
  if (reach > max) ankle = [R.hip[0] + (dx / reach) * max, R.hip[1] + (dy / reach) * max];
  const knee = legIK(R.hip, ankle, R.thigh, R.shin);
  return { thighAngle: hangAngle(R.hip, knee), knee, shinAngle: hangAngle(knee, ankle), ankle };
}
