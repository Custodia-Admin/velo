/**
 * Side / orbit camera placement over the photoreal mesh (t_1ec01b75).
 *
 * The sideTracking and cinematic cameras stand 3-4 m up beside the road,
 * where the hillside, house fronts and palms are. Here the view's pose for
 * them is handed to lib/sideCamSight with a reader for the top of what is
 * drawn (photoreal mesh, plus the globe where it draws over the mesh), and
 * comes back moved in to where the camera sees the rider, or across the road.
 */
import type { Scene } from 'cesium';

import type { CameraMode, CameraPose } from '@/lib/cesiumCameras';
import { CORRIDOR_CLEARANCE_M, CORRIDOR_HALF_WIDTH_M, sideTrackSideFromPose } from '@/lib/cesiumCameras';
import { drawnTopHeight, meshTopHeight, sceneEle, sightReadable } from '@/lib/cesiumUtils';
import { createSideCamSight, poseLookingAtRider, SIGHT_MIN_OFFSET_M, sightLeadM } from '@/lib/sideCamSight';

export type SideCamSight = ReturnType<typeof createSideCamSight>;

export interface SideCamInput {
  scene: Scene;
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
    topAt: (side, offsetM, aheadM) => {
      const k = side === poseSide ? offsetM : -offsetM;
      const lon = i.lon + (fx * aheadM + ux * k) / mLon;
      const lat = i.lat + (fy * aheadM + uy * k) / M_PER_DEG_LAT;
      const top = drawnTopHeight(i.scene, lon, lat, meshTopHeight(i.scene, lon, lat), expect);
      return top === undefined ? undefined : top - i.groundEle;
    },
  });
  const k = (placed.side === poseSide ? 1 : -1) * placed.offsetM;
  return poseLookingAtRider(ux * k, uy * k, off.z, i.pose.roll);
}
