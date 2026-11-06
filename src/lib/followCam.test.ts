/**
 * applyFollowCam puts Cesium's camera where the world renderer's chase rig
 * would (lib/cesiumCameras chaseCamTarget): behind the rider along the drawn
 * heading it is given, looking half the bend toward the route point ahead at
 * that point's height + 1 m, eased relative to the rider. Real Cesium maths,
 * a stub viewer (camera.setView spy, globe heights for the clearance lift).
 *
 * Before t_215ac171 it turned toward the bearing of the point ahead (the whole
 * bend), trailed along that at a fixed, flat-road pitch, and only bent the
 * pitch by atan(lift / back) when lifted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Cesium from 'cesium';
import { applyFollowCam, resetFollowCam, seedFollowCam } from '@/lib/cesiumUtils';
import { chaseCamTarget, lookAtHeadingPitch, type ENU } from '@/lib/cesiumCameras';
import { CHASE_FRAMING } from '@/lib/world/cameraFraming';

const RIDER = { lat: 45.99, lon: 8.95, ele: 280 };
const D2R = Math.PI / 180;

interface View {
  destination: Cesium.Cartesian3;
  orientation: { heading: number; pitch: number; roll: number };
}

function stubViewer(groundUnderCamera: () => number | undefined = () => undefined) {
  const views: View[] = [];
  const viewer = {
    scene: {
      globe: { getHeight: () => groundUnderCamera() },
      primitives: { length: 0, get: () => null },
    },
    camera: { setView: vi.fn((v: View) => views.push(v)) },
  } as unknown as Cesium.Viewer;
  return { viewer, views };
}

/** A geodetic point `e`/`n`/`u` metres from `at` in its ENU frame. */
function offsetDeg(at: { lat: number; lon: number; ele: number }, p: ENU) {
  const origin = Cesium.Cartesian3.fromDegrees(at.lon, at.lat, at.ele);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  const c = Cesium.Cartographic.fromCartesian(Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(p.x, p.y, p.z), new Cesium.Cartesian3()));
  return { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude), ele: c.height };
}

/** A world position in `at`'s ENU frame. */
function localOf(at: { lat: number; lon: number; ele: number }, world: Cesium.Cartesian3): ENU {
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(at.lon, at.lat, at.ele));
  const p = Cesium.Matrix4.multiplyByPoint(Cesium.Matrix4.inverseTransformation(enu, new Cesium.Matrix4()), world, new Cesium.Cartesian3());
  return { x: p.x, y: p.y, z: p.z };
}

const aheadENU = (heading: number, bendDeg: number, grade: number, L: number): ENU => ({
  x: Math.sin(heading + bendDeg * D2R) * L,
  y: Math.cos(heading + bendDeg * D2R) * L,
  z: grade * L,
});

describe('applyFollowCam: the photoreal chase camera follows the world rig', () => {
  beforeEach(() => resetFollowCam());
  afterEach(() => resetFollowCam());

  for (const c of [
    { what: 'a right bend on a 7 % climb at standard', heading: 0.3, bendDeg: 26, grade: 0.07, distance: 'standard' as const },
    { what: 'a left bend on a 5 % descent at close', heading: -2.0, bendDeg: -12, grade: -0.05, distance: 'close' as const },
  ]) {
    it(`frames ${c.what}: camera square behind the drawn heading, looking half the bend toward the point ahead + 1 m`, () => {
      const framing = CHASE_FRAMING[c.distance];
      const ahead = aheadENU(c.heading, c.bendDeg, c.grade, framing.lookAheadM);
      const { viewer, views } = stubViewer();
      applyFollowCam(viewer, RIDER, offsetDeg(RIDER, ahead), { heading: c.heading, framing, minClearanceMeters: 1.2 }, 1 / 60);
      const want = chaseCamTarget(c.heading, ahead, framing);
      const got = localOf(RIDER, views[0].destination);
      expect(Math.hypot(got.x - want.position.x, got.y - want.position.y, got.z - want.position.z)).toBeLessThan(0.005);
      const o = lookAtHeadingPitch(want.position, want.look);
      expect(views[0].orientation.heading).toBeCloseTo(o.heading, 4);
      expect(views[0].orientation.pitch).toBeCloseTo(o.pitch, 4);
      expect(views[0].orientation.roll).toBe(0);
      // Not the old rule: turned toward the point ahead by the whole bend, flat-road pitch.
      expect(Math.abs(views[0].orientation.heading - Math.atan2(ahead.x, ahead.y))).toBeGreaterThan(2 * D2R);
    });
  }

  it('a camera lifted over the slope behind still looks at the same point (the rider stays framed)', () => {
    const framing = CHASE_FRAMING.standard;
    const ahead = aheadENU(0, 0, -0.06, framing.lookAheadM);
    // Descending: the ground under the camera, 7 m back, is 3 m over the rider's.
    const { viewer, views } = stubViewer(() => RIDER.ele + 3);
    const pose = applyFollowCam(viewer, RIDER, offsetDeg(RIDER, ahead), { heading: 0, framing, minClearanceMeters: 1.2 }, 1 / 60);
    const got = localOf(RIDER, views[0].destination);
    expect(got.z).toBeCloseTo(3 + 1.2, 2);
    const want = chaseCamTarget(0, ahead, framing);
    const o = lookAtHeadingPitch({ ...want.position, z: got.z }, want.look);
    expect(views[0].orientation.pitch).toBeCloseTo(o.pitch, 4);
    // The returned pose is what was applied (a mode change starts from it).
    expect(pose.offsetENU.z).toBeCloseTo(got.z, 2);
    expect(pose.pitch).toBe(views[0].orientation.pitch);
    expect(pose.heading).toBe(views[0].orientation.heading);
  });

  it('holds the framing at riding speed: the camera moves with the rider, no lag behind it', () => {
    const framing = CHASE_FRAMING.close;
    const { viewer, views } = stubViewer();
    const heading = 0.9;
    let at = RIDER;
    for (let i = 0; i < 90; i++) {
      // 15 m/s along the heading, 60 fps.
      at = offsetDeg(at, { x: Math.sin(heading) * 0.25, y: Math.cos(heading) * 0.25, z: 0 });
      applyFollowCam(viewer, at, offsetDeg(at, aheadENU(heading, 0, 0, framing.lookAheadM)), { heading, framing }, 1 / 60);
    }
    const got = localOf(at, views[views.length - 1].destination);
    expect(Math.hypot(got.x + Math.sin(heading) * framing.backM, got.y + Math.cos(heading) * framing.backM)).toBeLessThan(0.01);
  });

  it('eases a heading change instead of snapping (τ 0.12 s), from where the camera was', () => {
    const framing = CHASE_FRAMING.standard;
    const { viewer, views } = stubViewer();
    const step = (heading: number) =>
      applyFollowCam(viewer, RIDER, offsetDeg(RIDER, aheadENU(heading, 0, 0, framing.lookAheadM)), { heading, framing }, 1 / 60);
    step(0);
    step(40 * D2R);
    const h = views[1].orientation.heading;
    expect(h).toBeGreaterThan(0);
    expect(h).toBeLessThan(10 * D2R);
    for (let i = 0; i < 120; i++) step(40 * D2R);
    expect(views[views.length - 1].orientation.heading).toBeCloseTo(40 * D2R, 3);
  });

  it('a hand-back from another camera mode starts from that camera', () => {
    const framing = CHASE_FRAMING.standard;
    const { viewer, views } = stubViewer();
    const side = offsetDeg(RIDER, { x: 9, y: 0, z: 3.2 });
    seedFollowCam(Cesium.Cartesian3.fromDegrees(side.lon, side.lat, side.ele), -Math.PI / 2, -0.3);
    applyFollowCam(viewer, RIDER, offsetDeg(RIDER, aheadENU(0, 0, 0, framing.lookAheadM)), { heading: 0, framing }, 1 / 60);
    const got = localOf(RIDER, views[0].destination);
    expect(Math.hypot(got.x - 9, got.y, got.z - 3.2)).toBeLessThan(0.005);
    expect(views[0].orientation.heading).toBeCloseTo(-Math.PI / 2, 4);
    expect(views[0].orientation.pitch).toBeCloseTo(-0.3, 4);
  });
});
