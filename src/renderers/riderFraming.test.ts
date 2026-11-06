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
import { ChaseCamSmoother, chaseCamTarget, computeCameraPose, lookAtHeadingPitch } from '@/lib/cesiumCameras';
import {
  AIM_HEIGHT_M,
  CAMERA_GLIDE_S,
  CHASE_FRAMING,
  chaseAimHeading,
  chaseLookHeight,
  MAX_AIM_OFFSET_RAD,
  REAR_AXLE_M,
  RIDE_FOV_Y_DEG,
  type CameraDistance,
} from '@/lib/world/cameraFraming';
import { CameraRig, cameraTarget } from './three/chaseRig';
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
    // The chase camera's climb rule keeps this axle where it is drawn on the flat.
    expect(REAR_AXLE_M).toEqual({ back: -RIG.rearAxle[0], up: RIG.rearAxle[1] });
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

// Chase poses shared by the bend/slope and climb checks below.
const D2R = Math.PI / 180;

/** The route point `lookAheadM` ahead (ENU, rider ground at the origin). */
const aheadOf = (heading: number, bendDeg: number, grade: number, lookAheadM: number): P3 => [
  Math.sin(heading + bendDeg * D2R) * lookAheadM,
  Math.cos(heading + bendDeg * D2R) * lookAheadM,
  grade * lookAheadM,
];

/** Photoreal: chaseCamTarget, oriented the way applyFollowCam hands Cesium a heading and pitch. */
const photorealAt = (distance: CameraDistance, heading: number, ahead: P3): Cam => {
  const t = chaseCamTarget(heading, { x: ahead[0], y: ahead[1], z: ahead[2] }, CHASE_FRAMING[distance]);
  const o = lookAtHeadingPitch(t.position, t.look);
  const cp = Math.cos(o.pitch);
  return { pos: [t.position.x, t.position.y, t.position.z], fwd: [Math.sin(o.heading) * cp, Math.cos(o.heading) * cp, Math.sin(o.pitch)] };
};

/** World: three/chaseRig's chase target at the same pose (three.js x east, y up, z south). */
const worldAt = (distance: CameraDistance, heading: number, ahead: P3): Cam => {
  const framing = CHASE_FRAMING[distance];
  const t = cameraTarget(
    'chase',
    { rider: { x: 0, y: 0, z: 0 }, heading, ahead: { x: ahead[0], y: ahead[2], z: -ahead[1] }, speed: 8, cadence: 85, timeS: 0 },
    framing,
    distance,
  );
  const enu = (v: { x: number; y: number; z: number }): P3 => [v.x, -v.z, v.y];
  const pos = enu(t.position);
  return { pos, fwd: sub(enu(t.look), pos) };
};

/** The GLB rider turned to `heading` and pitched up the slope (both renderers draw one model; this pins the cameras). */
const posed = (pts: P3[], heading: number, grade: number): P3[] => {
  const p = Math.atan(grade);
  const [cp, sp, ch, sh] = [Math.cos(p), Math.sin(p), Math.cos(heading), Math.sin(heading)];
  return pts.map(([x, y, z]) => {
    const fy = y * cp - z * sp;
    const fz = y * sp + z * cp;
    return [x * ch + fy * sh, -x * sh + fy * ch, fz];
  });
};

/**
 * In a bend and on a slope both chase cameras frame the rider the same.
 *
 * Before t_215ac171 the photoreal chase camera turned toward the route point
 * 15 m ahead (the whole bend, eased) and trailed along that bearing at a
 * fixed, flat-road pitch, while the world rig sits square behind the rider's
 * drawn heading, aims half the bend (≤12°) toward the point `lookAheadM`
 * ahead and looks at that point's height + 1 m (on a climb, since t_54dc80e6,
 * at the shared look height `chaseLookHeight`). Live at Lugano–Melide 1200 m
 * the 1 m point sat 3–6 px apart in x and the 'close' box 5–9 px.
 */
describe('chase aim: photoreal frames a bend and a slope as the world rig does', () => {
  /** Rider pose: drawn heading, the bend to the route point ahead, and the grade to it. */
  const POSES = [
    { name: 'straight, level', heading: 0.4, bendDeg: 0, grade: 0 },
    { name: 'gentle left bend', heading: 0.4, bendDeg: -14, grade: 0 },
    { name: 'sharp right corner (aim capped)', heading: 2.2, bendDeg: 48, grade: 0 },
    { name: '8 % climb', heading: -1.1, bendDeg: 0, grade: 0.08 },
    { name: '6 % descent', heading: 3.0, bendDeg: 0, grade: -0.06 },
    { name: 'climbing right bend', heading: -2.6, bendDeg: 20, grade: 0.07 },
  ];
  const SWEEP: Array<[CameraDistance, string, [number, number]]> = (['standard', 'close', 'far'] as CameraDistance[]).flatMap(
    (d) => Object.entries(VIEWPORTS).map(([n, vp]) => [d, n, vp] as [CameraDistance, string, [number, number]]),
  );

  let glb: P3[];
  beforeAll(async () => {
    glb = (await glbPoints()).filter((_, i) => i % 7 === 0);
  });

  for (const pose of POSES) {
    it(`${pose.name}: the 1 m point and the rider's box land on the same pixels`, () => {
      for (const [distance, name, vp] of SWEEP) {
        const ahead = aheadOf(pose.heading, pose.bendDeg, pose.grade, CHASE_FRAMING[distance].lookAheadM);
        const w = worldAt(distance, pose.heading, ahead);
        const p = photorealAt(distance, pose.heading, ahead);
        const pt: P3[] = [[0, 0, 1]];
        const w1 = boxOf(pt, w, vp);
        const p1 = boxOf(pt, p, vp);
        expect(Math.abs(p1[0] - w1[0]), `${distance} ${name} 1 m x`).toBeLessThan(0.25);
        expect(Math.abs(p1[1] - w1[1]), `${distance} ${name} 1 m y`).toBeLessThan(0.25);
        const model = posed(glb, pose.heading, pose.grade);
        const wb = boxOf(model, w, vp);
        const pb = boxOf(model, p, vp);
        for (let i = 0; i < 4; i++) expect(Math.abs(pb[i] - wb[i]), `${distance} ${name} edge ${i}`).toBeLessThan(0.25);
      }
    });
  }

  it('the bends and slopes move the frame (a straight-road camera would miss them by pixels)', () => {
    // Guards the poses above: each non-straight one shifts the world rig's
    // 1 m point past the 2 px gate against the straight, level camera. The
    // straight climb shifts it least (5.4 px): the camera keeps its flat-road
    // pitch there, tipped down only by the bike's pitch (chaseLookHeight).
    const vp = VIEWPORTS['1440x900'];
    for (const pose of POSES.slice(1)) {
      const L = CHASE_FRAMING.standard.lookAheadM;
      const bent = boxOf([[0, 0, 1]], worldAt('standard', pose.heading, aheadOf(pose.heading, pose.bendDeg, pose.grade, L)), vp);
      const flat = boxOf([[0, 0, 1]], worldAt('standard', pose.heading, aheadOf(pose.heading, 0, 0, L)), vp);
      expect(Math.hypot(bent[0] - flat[0], bent[1] - flat[1]), pose.name).toBeGreaterThan(4);
    }
  });

  it('aims half the bend, never more than 12°, and looks at the point ahead + 1 m (flat-road pitch on a climb)', () => {
    const f = CHASE_FRAMING.standard;
    const look = (bendDeg: number, grade = 0) => chaseCamTarget(0, { x: Math.sin(bendDeg * D2R) * f.lookAheadM, y: Math.cos(bendDeg * D2R) * f.lookAheadM, z: grade * f.lookAheadM }, f).look;
    expect(Math.atan2(look(10).x, look(10).y)).toBeCloseTo(5 * D2R, 9);
    expect(Math.atan2(look(-16).x, look(-16).y)).toBeCloseTo(-8 * D2R, 9);
    expect(Math.atan2(look(60).x, look(60).y)).toBeCloseTo(MAX_AIM_OFFSET_RAD, 9);
    expect(Math.hypot(look(60).x, look(60).y)).toBeCloseTo(f.lookAheadM, 9);
    // Downhill (and on the flat) the point ahead + 1 m; on a climb the shared
    // look height, which never rises over the rider's + 1 m.
    expect(look(0, -0.06).z).toBeCloseTo(-0.06 * f.lookAheadM + 1, 9);
    expect(look(0, 0).z).toBeCloseTo(1, 9);
    expect(look(0, 0.08).z).toBeCloseTo(chaseLookHeight(f, 0.08 * f.lookAheadM), 9);
    expect(look(0, 0.08).z).toBeLessThan(1);
    // Riding south, a bend across ±180° turns the short way round (−20° here, not +340°).
    for (const [heading, bearing] of [
      [-3.0, 3.1],
      [3.0, -3.1],
    ]) {
      const bend = Math.atan2(Math.sin(bearing - heading), Math.cos(bearing - heading));
      expect(chaseAimHeading(heading, Math.sin(bearing) * 14, Math.cos(bearing) * 14)).toBeCloseTo(heading + bend / 2, 9);
    }
    // The camera stays square behind the drawn heading whatever the bend.
    const t = chaseCamTarget(0.7, { x: 9, y: -3, z: 2 }, f);
    expect(t.position.x).toBeCloseTo(-Math.sin(0.7) * f.backM, 9);
    expect(t.position.y).toBeCloseTo(-Math.cos(0.7) * f.backM, 9);
    expect(t.position.z).toBe(f.upM);
  });

  it('eases through a corner exactly as the world rig does (relative to the rider, no lag at speed)', () => {
    const smoother = new ChaseCamSmoother();
    const rig = new CameraRig();
    const f = CHASE_FRAMING.standard;
    const dt = 1 / 60;
    let worst = 0;
    for (let i = 0; i < 240; i++) {
      // The drawn heading sweeps 70° while the route ahead turns harder and starts to climb.
      const heading = 0.3 + Math.min(1, i / 120) * 70 * D2R;
      const ahead = aheadOf(heading, 30 * Math.sin((i / 240) * Math.PI), 0.06 * Math.min(1, i / 90), f.lookAheadM);
      // The world rider moves 12 m/s north-east; the rig smooths relative to it.
      const rider = { x: i * dt * 8, y: 0, z: -i * dt * 9 };
      const target = cameraTarget(
        'chase',
        { rider, heading, ahead: { x: rider.x + ahead[0], y: ahead[2], z: rider.z - ahead[1] }, speed: 12, cadence: 90, timeS: i * dt },
        f,
        'standard',
      );
      rig.update('chase', target, dt, undefined, rider);
      smoother.step(chaseCamTarget(heading, { x: ahead[0], y: ahead[1], z: ahead[2] }, f), dt);
      const wPos: P3 = [rig.position.x - rider.x, -(rig.position.z - rider.z), rig.position.y];
      const wLook: P3 = [rig.look.x - rider.x, -(rig.look.z - rider.z), rig.look.y];
      const p = smoother.position;
      const l = smoother.look;
      worst = Math.max(worst, Math.hypot(p.x - wPos[0], p.y - wPos[1], p.z - wPos[2]), Math.hypot(l.x - wLook[0], l.y - wLook[1], l.z - wLook[2]));
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it('ignores a non-finite target (an unset pose) and keeps the last framing', () => {
    const f = CHASE_FRAMING.standard;
    const smoother = new ChaseCamSmoother();
    const target = chaseCamTarget(0.5, { x: Math.sin(0.5) * f.lookAheadM, y: Math.cos(0.5) * f.lookAheadM, z: 0 }, f);
    smoother.step(target, 1 / 60);
    const before = { position: { ...smoother.position }, look: { ...smoother.look } };
    smoother.step(chaseCamTarget(NaN, { x: 0, y: 14, z: 0 }, f), 1 / 60);
    smoother.step({ position: target.position, look: { x: Infinity, y: 0, z: 0 } }, 1 / 60);
    expect(smoother.position).toEqual(before.position);
    expect(smoother.look).toEqual(before.look);
  });

  it('a handover from another camera starts where that camera is and glides in', () => {
    const f = CHASE_FRAMING.standard;
    const target = chaseCamTarget(0, { x: 0, y: f.lookAheadM, z: 0 }, f);
    const smoother = new ChaseCamSmoother();
    smoother.step(target, 1 / 60);
    // A side camera 9 m right, 3.2 m up, looking west at the rider.
    smoother.seed({ x: 9, y: 0, z: 3.2 }, -Math.PI / 2, -0.25);
    smoother.step(target, 1 / 60);
    expect(smoother.position).toEqual({ x: 9, y: 0, z: 3.2 });
    const o = lookAtHeadingPitch(smoother.position, smoother.look);
    expect(o.heading).toBeCloseTo(-Math.PI / 2, 9);
    expect(o.pitch).toBeCloseTo(-0.25, 9);
    // Glides (τ 0.55 s), not the 0.12 s chase easing…
    smoother.step(target, 0.1);
    expect(smoother.position.x).toBeGreaterThan(9 * Math.exp(-0.1 / 0.55) - 1e-9);
    // …and is on the chase framing a few seconds later.
    for (let t = 0; t < CAMERA_GLIDE_S + 2; t += 1 / 60) smoother.step(target, 1 / 60);
    expect(Math.hypot(smoother.position.x - target.position.x, smoother.position.y - target.position.y)).toBeLessThan(0.01);
  });
});

/**
 * Top of the ride HUD strip under the rider, CSS px, at each gate viewport:
 * `[data-testid=ride-strip]` measured live in the tab (tabframe2.py
 * `hudUnderRider`, ~/.hermes/handoffs/velo/t_215ac171/out/tab-*). The status
 * chip above it sits left of the rider.
 */
const HUD_STRIP_TOP: Record<string, number> = { '1440x900': 810, '1280x648': 558, tv: 923, '390x844': 734 };

/**
 * On a climb the chase camera keeps the rider's wheels where they are on the
 * flat, in both renderers (one shared rule, `chaseLookHeight`).
 *
 * Before t_54dc80e6 both cameras looked at the route point ahead + 1 m, so a
 * climb tipped the view up and the rider dropped down the frame: at "close"
 * on Valle Maggia's 9 % (5,205 m) the rear tyre contact was drawn 20.7 px
 * (1440×900) and 45.0 px (390×844) under the strip, from ~2.5 % up at 390.
 */
describe('climbs: the rear wheel stays clear of the ride HUD strip in both renderers', () => {
  const GRADES = [0.03, 0.06, 0.09, 0.12, 0.15];
  /** The rear tyre's ground contact with the bike pitched up the slope (ENU, rider heading `heading`). */
  const rearContact = (heading: number, grade: number): P3 => posed([[0, -REAR_AXLE_M.back, 0]], heading, grade)[0];
  const yOf = (pt: P3, cam: Cam, vp: [number, number]) => boxOf([pt], cam, vp)[3];
  const cams = (distance: CameraDistance, heading: number, bendDeg: number, grade: number) => {
    const ahead = aheadOf(heading, bendDeg, grade, CHASE_FRAMING[distance].lookAheadM);
    return { photoreal: photorealAt(distance, heading, ahead), world: worldAt(distance, heading, ahead) };
  };

  let rearWheel: P3[];
  beforeAll(async () => {
    // The GLB's rear wheel (behind the bottom bracket, under the saddle): its lowest pixel is the rider's.
    rearWheel = (await glbPoints()).filter(([, y, z]) => y < -0.15 && z < 0.75);
  });

  it('a 12 % climb at "close" on 390×844: the rear tyre contact is drawn above the strip (it was under it)', () => {
    const vp = VIEWPORTS['390x844'];
    const f = CHASE_FRAMING.close;
    for (const [name, cam] of Object.entries(cams('close', 0, 0, 0.12))) {
      const y = yOf(rearContact(0, 0.12), cam, vp);
      expect(y, name).toBeLessThan(HUD_STRIP_TOP['390x844']);
    }
    // The old rule (look at the point ahead + 1 m) drew it well under the strip.
    const old: Cam = { pos: [0, -f.backM, f.upM], fwd: [0, f.lookAheadM + f.backM, 0.12 * f.lookAheadM + AIM_HEIGHT_M - f.upM] };
    expect(yOf(rearContact(0, 0.12), old, vp)).toBeGreaterThan(HUD_STRIP_TOP['390x844'] + 40);
  });

  for (const distance of DISTANCES) {
    for (const [name, vp] of Object.entries(VIEWPORTS)) {
      it(`${distance} at ${name}: up to 15 %, straight or bending, the rear wheel is drawn where it is on the flat, over the strip`, () => {
        for (const [heading, bendDeg] of [
          [0.4, 0],
          [-2.6, 20],
          [1.9, -30],
        ]) {
          const flat = cams(distance, heading, bendDeg, 0);
          for (const grade of GRADES) {
            const climb = cams(distance, heading, bendDeg, grade);
            for (const r of ['photoreal', 'world'] as const) {
              const at = `${r} ${(grade * 100).toFixed(0)} % bend ${bendDeg}°`;
              expect(yOf(rearContact(heading, grade), climb[r], vp), at).toBeLessThan(HUD_STRIP_TOP[name]);
              // The wheel's lowest pixel: no lower than on the flat (within 0.5 px)…
              const wheel = boxOf(posed(rearWheel, heading, grade), climb[r], vp)[3];
              const flatWheel = boxOf(posed(rearWheel, heading, 0), flat[r], vp)[3];
              expect(wheel, at).toBeLessThan(flatWheel + 0.5);
              // …and not lifted either: the climb doesn't reframe the rider.
              expect(wheel, at).toBeGreaterThan(flatWheel - 2);
            }
          }
        }
      });
    }
  }

  it('the look point never rises over the rider’s + 1 m on a climb, and the rule is continuous at the crest', () => {
    for (const distance of ['close', 'standard', 'far', 'overview'] as CameraDistance[]) {
      const f = CHASE_FRAMING[distance];
      expect(chaseLookHeight(f, 0)).toBe(AIM_HEIGHT_M);
      expect(chaseLookHeight(f, 1e-6)).toBeCloseTo(AIM_HEIGHT_M, 6);
      let prev = AIM_HEIGHT_M;
      for (let rise = 0.1; rise <= 0.2 * f.lookAheadM; rise += 0.1) {
        const h = chaseLookHeight(f, rise);
        expect(h).toBeLessThan(prev);
        prev = h;
      }
    }
  });

  it('downhill the camera still tips down to the road ahead: the rider rides higher and more road shows', () => {
    for (const distance of DISTANCES) {
      for (const [name, vp] of Object.entries(VIEWPORTS)) {
        const flat = cams(distance, 3.0, 0, 0);
        const down = cams(distance, 3.0, 0, -0.06);
        for (const r of ['photoreal', 'world'] as const) {
          const y1 = (cam: Cam) => yOf([0, 0, 1], cam, vp);
          expect(y1(down[r]), `${distance} ${name} ${r}`).toBeLessThan(y1(flat[r]) - 10);
        }
        expect(chaseLookHeight(CHASE_FRAMING[distance], -0.06 * CHASE_FRAMING[distance].lookAheadM)).toBeCloseTo(
          AIM_HEIGHT_M - 0.06 * CHASE_FRAMING[distance].lookAheadM,
          9,
        );
      }
    }
  });
});
