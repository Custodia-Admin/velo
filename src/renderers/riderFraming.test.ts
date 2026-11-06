/**
 * Both renderers draw the rider the same size in the same place.
 *
 * The world renderer draws the GLB rider (scripts/gen-rider-glb.mjs) through
 * its chase rig (three/chaseRig); photoreal draws the procedural Cesium
 * avatar (lib/avatar) through its chase pose (lib/cesiumCameras). Each puts
 * its model's origin on the ground point the camera and `riderScreen` anchor
 * on, and both cameras draw RIDE_FOV_Y_DEG vertically. This projects each
 * renderer's own model through its own chase camera at the gate viewports and
 * holds the two silhouettes' boxes together.
 *
 * Before the avatar took the GLB's proportions its helmet topped out at
 * 1.36 m (the GLB's at 1.645 m): the photoreal box's top sat 22–55 px under
 * the world rider's while the wheels matched to 0.4 px. Live check (cat-bed,
 * every rider material painted magenta): ~/.hermes/handoffs/velo/t_dfa07725/tabframe2.py.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';

import type { RiderPosition } from '@/lib/physics';
import { AVATAR_RIG, avatarSurfacePoints } from '@/lib/avatar';
import { computeCameraPose } from '@/lib/cesiumCameras';
import { CHASE_FRAMING, RIDE_FOV_Y_DEG, type CameraDistance } from '@/lib/world/cameraFraming';
import { cameraTarget } from './three/chaseRig';
import { legPose } from './three/riderRig';

type P3 = [number, number, number];
/** Box in CSS px: left, top, right, bottom. */
type Box = [number, number, number, number];

/** The gate viewports (CSS px). */
const VIEWPORTS: Record<string, [number, number]> = {
  '1440x900': [1440, 900],
  '1280x648': [1280, 648],
  tv: [1920, 1080],
  '390x844': [390, 844],
};
const DISTANCES: CameraDistance[] = ['standard', 'close'];
const POSTURES: RiderPosition[] = ['hoods', 'drops', 'tops'];
/** One pedal stroke: the box covers the legs wherever the cranks are. */
const CRANKS = Array.from({ length: 8 }, (_, i) => (i / 8) * Math.PI * 2);
/** Most any box edge may differ between the renderers, CSS px. */
const TOLERANCE_PX = 2;

interface Cam {
  pos: P3;
  fwd: P3;
}

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: P3): P3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Pinhole projection with the ride's vertical field, no roll (frame: x right, y forward, z up). */
function boxOf(points: P3[], cam: Cam, [w, h]: [number, number]): Box {
  const f = norm(cam.fwd);
  const r = norm(cross(f, [0, 0, 1]));
  const u = cross(r, f);
  const focal = h / 2 / Math.tan(((RIDE_FOV_Y_DEG / 2) * Math.PI) / 180);
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of points) {
    const d = sub(p, cam.pos);
    const z = dot(d, f);
    const x = w / 2 + (focal * dot(d, r)) / z;
    const y = h / 2 - (focal * dot(d, u)) / z;
    box[0] = Math.min(box[0], x);
    box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x);
    box[3] = Math.max(box[3], y);
  }
  return box;
}

/** Photoreal: the chase pose lib/cesiumCameras gives, rider at the origin heading north (ENU). */
function photorealCam(distance: CameraDistance): Cam {
  const pose = computeCameraPose('chase', { lat: 0, lon: 0, ele: 0, heading: 0, cadence: 0, speed: 0 }, 0, distance);
  const { x, y, z } = pose.offsetENU;
  const cp = Math.cos(pose.pitch);
  return { pos: [x, y, z], fwd: [Math.sin(pose.heading) * cp, Math.cos(pose.heading) * cp, Math.sin(pose.pitch)] };
}

/** World: the chase target three/chaseRig gives on a flat, straight road (three.js x east, y up, z south). */
function worldCam(distance: CameraDistance): Cam {
  const framing = CHASE_FRAMING[distance];
  const t = cameraTarget(
    'chase',
    { rider: { x: 0, y: 0, z: 0 }, heading: 0, ahead: { x: 0, y: 0, z: -framing.lookAheadM }, speed: 0, cadence: 0, timeS: 0 },
    framing,
    distance,
  );
  const enu = (v: { x: number; y: number; z: number }): P3 => [v.x, -v.z, v.y];
  const pos = enu(t.position);
  return { pos, fwd: sub(enu(t.look), pos) };
}

/** The Cesium avatar's surface over a pedal stroke (body frame = ENU at heading 0). */
function avatarPoints(riderPosition: RiderPosition = 'hoods'): P3[] {
  return CRANKS.flatMap((crankAngle) => avatarSurfacePoints(undefined, { crankAngle, riderPosition }) as P3[]);
}

/** The GLB rider's vertices over a pedal stroke, posed as Rider.tsx poseRider poses it (GLB: +X forward, +Y up, +Z right). */
async function glbPoints(): Promise<P3[]> {
  const { build } = (await import('../../scripts/gen-rider-glb.mjs')) as { build: () => THREE.Object3D };
  const root = build();
  const find = (name: string) => root.getObjectByName(name);
  const out: P3[] = [];
  const v = new THREE.Vector3();
  for (const crank of CRANKS) {
    for (const [side, s] of [
      [1, 'R'],
      [-1, 'L'],
    ] as const) {
      const p = legPose(crank, side);
      find(`thigh${s}`)?.rotation.set(0, 0, p.thighAngle);
      find(`shin${s}`)?.position.set(p.knee[0], p.knee[1], 0);
      find(`shin${s}`)?.rotation.set(0, 0, p.shinAngle);
      find(`foot${s}`)?.position.set(p.ankle[0], p.ankle[1], 0);
      find(`foot${s}`)?.rotation.set(0, 0, -0.12 + 0.18 * Math.sin(crank + (side === 1 ? 0 : Math.PI)));
    }
    find('crank')?.rotation.set(0, 0, crank);
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const a = mesh.geometry.attributes.position;
      for (let i = 0; i < a.count; i++) {
        v.fromBufferAttribute(a, i).applyMatrix4(mesh.matrixWorld);
        out.push([v.z, v.x, v.y]);
      }
    });
  }
  return out;
}

const extent = (pts: P3[], axis: 0 | 1 | 2) => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    lo = Math.min(lo, p[axis]);
    hi = Math.max(hi, p[axis]);
  }
  return [lo, hi];
};

describe('rider framing: photoreal draws the rider where the world renderer does', () => {
  let glb: P3[];
  beforeAll(async () => {
    glb = await glbPoints();
  });

  it('the Cesium avatar shares the GLB rig: wheels, bottom bracket, cranks, hips, legs', async () => {
    const { RIG } = (await import('../../scripts/gen-rider-glb.mjs')) as {
      RIG: {
        wheelRadius: number;
        rearAxle: number[];
        frontAxle: number[];
        bb: number[];
        crankLength: number;
        hip: number[];
        thigh: number;
        shin: number;
        ankleAbovePedal: number;
      };
    };
    expect(AVATAR_RIG.wheelRadius).toBe(RIG.wheelRadius);
    expect(AVATAR_RIG.halfWheelbase).toBe(RIG.frontAxle[0]);
    expect(-AVATAR_RIG.halfWheelbase).toBe(RIG.rearAxle[0]);
    expect([...AVATAR_RIG.bb]).toEqual(RIG.bb);
    expect(AVATAR_RIG.crankLength).toBe(RIG.crankLength);
    expect([...AVATAR_RIG.hip]).toEqual(RIG.hip);
    expect(AVATAR_RIG.thigh).toBe(RIG.thigh);
    // The avatar's shin runs knee → pedal: the GLB's shin plus its ankle over the pedal.
    expect(AVATAR_RIG.shin).toBeCloseTo(RIG.shin + RIG.ankleAbovePedal, 6);
  });

  it('the legs reach the pedals all the way round (the knee IK never clamps)', () => {
    const { bb, crankLength, hip, thigh, shin } = AVATAR_RIG;
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const reach = Math.hypot(bb[0] + Math.sin(a) * crankLength - hip[0], bb[1] - Math.cos(a) * crankLength - hip[1]);
      expect(reach).toBeLessThan(thigh + shin - 0.005);
      expect(reach).toBeGreaterThan(Math.abs(thigh - shin) + 0.005);
    }
  });

  it('the two models stand on the same ground and reach the same height', () => {
    const av = avatarPoints();
    const [avLo, avHi] = extent(av, 2);
    const [glbLo, glbHi] = extent(glb, 2);
    // Tyres on the ground (the origin both renderers place on the drawn ground).
    expect(avLo).toBeCloseTo(0, 2);
    expect(glbLo).toBeCloseTo(0, 2);
    // Helmet tops within 1 cm (the GLB's: 1.645 m).
    expect(glbHi).toBeCloseTo(1.645, 2);
    expect(Math.abs(avHi - glbHi)).toBeLessThan(0.01);
  });

  for (const distance of DISTANCES) {
    for (const [name, vp] of Object.entries(VIEWPORTS)) {
      it(`${distance} chase at ${name}: boxes within ${TOLERANCE_PX} px in every posture`, () => {
        const world = boxOf(glb, worldCam(distance), vp);
        for (const posture of POSTURES) {
          const photoreal = boxOf(avatarPoints(posture), photorealCam(distance), vp);
          for (let i = 0; i < 4; i++) {
            expect(Math.abs(photoreal[i] - world[i]), `${posture} edge ${i}: ${photoreal[i]} vs ${world[i]}`).toBeLessThanOrEqual(
              TOLERANCE_PX,
            );
          }
        }
      });
    }
  }

  it('both chase cameras put the 1 m point over the rider at the same pixel', () => {
    // Placement: both models stand at the origin; the cameras must agree on where that is drawn.
    for (const distance of DISTANCES) {
      for (const vp of Object.values(VIEWPORTS)) {
        const pt: P3[] = [[0, 0, 1]];
        const w = boxOf(pt, worldCam(distance), vp);
        const p = boxOf(pt, photorealCam(distance), vp);
        expect(Math.abs(p[0] - w[0])).toBeLessThan(0.5);
        expect(Math.abs(p[1] - w[1])).toBeLessThan(0.5);
      }
    }
  });
});
