/**
 * Side / orbit camera placement over the photoreal mesh (t_1ec01b75).
 *
 * The sideTracking and cinematic cameras stand 3-4 m up beside the road,
 * where the hillside, house fronts and palms are. Here the view's pose for
 * them is handed to lib/sideCamSight with a reader for what is drawn, and
 * comes back moved in to where the camera sees the rider, or across the road.
 *
 * The reader casts segments through the mesh drawn this frame (t_ee2165b8):
 * from the rider's bars to the camera spot, and from the spot down through the
 * air the camera keeps under it. A thin hedge or post anywhere on the line is
 * seen, and a canopy over the line is told from a solid on it. The globe,
 * where it draws over the mesh, is read as tops. Without the model reader the
 * casts walk the tiles with, the reader falls back to the top of what is drawn
 * (photoreal mesh, plus the globe) at a few spots on the line (t_1ec01b75).
 */
import * as Cesium from 'cesium';

import type { CameraMode, CameraPose } from '@/lib/cesiumCameras';
import { CORRIDOR_CLEARANCE_M, CORRIDOR_HALF_WIDTH_M, sideTrackSideFromPose } from '@/lib/cesiumCameras';
import {
  drawnTopHeight,
  meshSegmentHit,
  meshTopHeight,
  sceneEle,
  sightRaysReadable,
  sightReadable,
} from '@/lib/cesiumUtils';
import {
  createSideCamSight,
  poseLookingAtRider,
  seenOverTops,
  SIGHT_CAMERA_CLEAR_M,
  SIGHT_MIN_OFFSET_M,
  sightLeadM,
  type SightSpot,
} from '@/lib/sideCamSight';
import { AIM_HEIGHT_M } from '@/lib/world/cameraFraming';

export type SideCamSight = ReturnType<typeof createSideCamSight>;

export interface SideCamInput {
  scene: Cesium.Scene;
  sight: SideCamSight;
  mode: CameraMode;
  /** The mode's pose (offset from the rider's ground point). */
  pose: CameraPose;
  /** Rider heading (radians, compass bearing). */
  heading: number;
  lon: number;
  lat: number;
  /** Route elevation at the rider (plausibility bound for coarse tiles). */
  routeEle: number;
  /** Drawn ground under the rider: the pose's offsets are relative to it. */
  groundEle: number;
  /** Ride speed (m/s): the spots are read where the rider will be. */
  speed: number;
  distanceM: number;
  nowMs: number;
  dt: number;
  /** The painted road (corridor: a ground classification volume) is drawn. */
  roadPainted: boolean;
}

const M_PER_DEG_LAT = 110_574;

/**
 * The pose to fly for a side / orbit shot: unchanged (and the sight state
 * reset) for other modes, off the mesh, or on WebGL 1.
 */
export function placeSideCam(i: SideCamInput): CameraPose {
  const off = i.pose.offsetENU;
  const baseM = Math.hypot(off.x, off.y);
  const sideShot = i.mode === 'sideTracking' || i.mode === 'cinematic';
  if (!sideShot || !(baseM > 0.5) || !sightReadable(i.scene)) {
    i.sight.reset();
    return i.pose;
  }
  const poseSide = i.mode === 'sideTracking' ? sideTrackSideFromPose(i.pose, i.heading) : 1;
  const ux = off.x / baseM;
  const uy = off.y / baseM;
  const lead = sightLeadM(i.speed);
  const mLon = 111_320 * Math.cos((i.lat * Math.PI) / 180);
  const fx = Math.sin(i.heading);
  const fy = Math.cos(i.heading);
  const expect = sceneEle(i.routeEle);
  /** East / north metres from the rider of the spot `offsetM` out on a side, `aheadM` along the heading. */
  const spotEN = (side: 1 | -1, offsetM: number, aheadM: number) => {
    const k = side === poseSide ? offsetM : -offsetM;
    return { e: fx * aheadM + ux * k, n: fy * aheadM + uy * k };
  };
  /** Top drawn at a spot (m over the rider's ground): the mesh read there (`withMesh`) and the globe where it draws over it. */
  const topAt = (side: 1 | -1, offsetM: number, aheadM: number, withMesh: boolean) => {
    const p = spotEN(side, offsetM, aheadM);
    const lon = i.lon + p.e / mLon;
    const lat = i.lat + p.n / M_PER_DEG_LAT;
    const mesh = withMesh ? meshTopHeight(i.scene, lon, lat) : undefined;
    const top = drawnTopHeight(i.scene, lon, lat, mesh, expect);
    return top === undefined ? undefined : top - i.groundEle;
  };
  // Segment casts: east-north-up metres from the rider's ground point to world space.
  let enu: Cesium.Matrix4 | undefined;
  const world = (e: number, n: number, u: number) => {
    enu ??= Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(i.lon, i.lat, i.groundEle));
    return Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(e, n, u), new Cesium.Cartesian3());
  };
  const seenAt = (s: SightSpot): boolean => {
    const bars = spotEN(s.side, 0, s.aheadM);
    const cam = spotEN(s.side, s.offsetM, s.aheadM);
    const camAt = world(cam.e, cam.n, s.upM);
    // The line from the bars to the camera, then the air under the camera.
    if (meshSegmentHit(i.scene, world(bars.e, bars.n, AIM_HEIGHT_M), camAt) !== undefined) return false;
    if (meshSegmentHit(i.scene, camAt, world(cam.e, cam.n, s.upM - SIGHT_CAMERA_CLEAR_M)) !== undefined) return false;
    // The globe, where it draws over the mesh: a height field, read as tops.
    return seenOverTops((x) => topAt(s.side, x, s.aheadM, false), s.offsetM, s.baseM, s.upM);
  };
  const placed = i.sight.update({
    nowMs: i.nowMs,
    dt: i.dt,
    distanceM: i.distanceM,
    leadM: lead,
    side: poseSide,
    baseM,
    upM: off.z,
    // With the painted road drawn the camera stays out of its corridor.
    minM: i.roadPainted ? CORRIDOR_HALF_WIDTH_M + CORRIDOR_CLEARANCE_M : SIGHT_MIN_OFFSET_M,
    allowSwitch: i.mode === 'sideTracking' && !i.roadPainted,
    topAt: (side, offsetM, aheadM) => topAt(side, offsetM, aheadM, true),
    seenAt: sightRaysReadable(i.scene) ? seenAt : undefined,
  });
  const k = (placed.side === poseSide ? 1 : -1) * placed.offsetM;
  return poseLookingAtRider(ux * k, uy * k, off.z, i.pose.roll);
}
