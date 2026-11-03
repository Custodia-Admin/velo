/**
 * cesiumCameras.ts: Multi-camera mode positioning utilities.
 *
 * Pure functions: no side effects, no imports from Cesium so the math is
 * testable in the node vitest environment. The CesiumViewer preRender handler
 * converts the returned poses into Cesium camera calls.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CameraMode =
  | 'chase'
  | 'firstPerson'
  | 'overhead'
  | 'sideTracking'
  | 'cinematic'
  | 'drone';

/** Runtime set used to validate persisted values from localStorage. */
export const CAMERA_MODES: ReadonlyArray<CameraMode> = [
  'chase',
  'firstPerson',
  'overhead',
  'sideTracking',
  'cinematic',
  'drone',
];

/** Type-guard for narrowing untrusted input (e.g. rehydrated localStorage). */
export function isCameraMode(value: unknown): value is CameraMode {
  return typeof value === 'string' && (CAMERA_MODES as ReadonlyArray<string>).includes(value);
}

/** A rider snapshot fed to the camera each frame. */
export interface RiderPose {
  lat: number;      // degrees
  lon: number;      // degrees
  ele: number;      // metres above ellipsoid
  /** Bearing, radians, 0 = north, clockwise. */
  heading: number;
  /** Cadence in RPM. */
  cadence: number;
  /** Speed in m/s. */
  speed: number;
}

/**
 * Target camera transform in local ENU (East-North-Up) offsets from the rider.
 * The CesiumViewer converts this to a world Cartesian3 + orientation.
 */
export interface CameraPose {
  /**
   * Camera offset from the rider position in ENU metres:
   *   x = east offset
   *   y = north offset
   *   z = up offset
   */
  offsetENU: { x: number; y: number; z: number };
  /** Camera heading, radians (0 = north, clockwise). */
  heading: number;
  /** Camera pitch, radians (negative = looking down). */
  pitch: number;
  /** Camera roll, radians. */
  roll: number;
}

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

/** easeOutCubic: t in [0,1] → eased progress in [0,1]. */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// ---------------------------------------------------------------------------
// computeCameraPose — pure mode → target pose
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Camera distance — the rider's "how close is the camera" setting
// ---------------------------------------------------------------------------

// Camera distance + chase framing are shared by every renderer: defined in
// lib/world/cameraFraming (engine-free), re-exported here for the Cesium side.
import {
  AIM_HEIGHT_M,
  CHASE_FRAMING,
  DEFAULT_CAMERA_DISTANCE,
  isCameraDistance,
  type CameraDistance,
  type ChaseFraming,
} from '@/lib/world/cameraFraming';

export {
  AIM_HEIGHT_M,
  CAMERA_DISTANCES,
  CAMERA_DISTANCE_LABELS,
  CHASE_FRAMING,
  DEFAULT_CAMERA_DISTANCE,
  isCameraDistance,
  type CameraDistance,
  type ChaseFraming,
} from '@/lib/world/cameraFraming';

/**
 * Pitch (radians, negative = down) that aims a camera at the rider's bars.
 *
 * @param camHeightM  Camera height above the rider's ground, metres.
 * @param horizOffsetM  Horizontal distance from the camera to the rider, metres.
 *
 * Single source for every camera that looks at the rider (side-tracking,
 * cinematic, chase): a camera lifted above its nominal height — e.g. by the
 * terrain/building clearance lift — must re-aim through this, or the rider
 * leaves the frame and the view ends up in roadside geometry at roof height.
 */
export function riderAimPitchRad(camHeightM: number, horizOffsetM: number): number {
  return -Math.atan2(camHeightM - AIM_HEIGHT_M, horizOffsetM);
}

/** Pitch (radians, negative = down) aiming from the chase camera at the look-ahead point. */
export function chasePitchRad(f: ChaseFraming, upM: number = f.upM): number {
  return -Math.atan2(upM - AIM_HEIGHT_M, f.backM + f.lookAheadM);
}

/** Scale applied to the other orbiting / tracking modes per distance. */
export const MODE_SCALE: Record<CameraDistance, number> = {
  close: 0.7,
  standard: 1,
  far: 1.8,
  overview: 3.2,
};

/** Constants (exported for testing) — `standard` distance. */
export const CHASE_BACK_M      = CHASE_FRAMING.standard.backM;
export const CHASE_UP_M        = CHASE_FRAMING.standard.upM;
export const CHASE_PITCH_RAD   = chasePitchRad(CHASE_FRAMING.standard);

/** Eye height on the bike and how far forward of the hip origin the eyes sit. */
export const FIRST_PERSON_EYE_HEIGHT_M = 1.25;
/** Just in front of the face (head centre 0.30 m + radius 0.12 m), so the rider's own head never fills the view. */
export const FIRST_PERSON_EYE_FORWARD_M = 0.45;
export const FIRST_PERSON_HEAD_BOB_AMP = 0.04;  // metres
/** Slight downward look so the bars and the road just ahead are in view. */
export const FIRST_PERSON_PITCH_RAD = -6 * (Math.PI / 180);

export const OVERHEAD_HEIGHT_M  = 30;
export const SIDE_TRACK_OFFSET_M = 9;
export const SIDE_TRACK_UP_M     = 3.2;

// ---------------------------------------------------------------------------
// Side-tracking corridor avoidance
// ---------------------------------------------------------------------------

/**
 * Half-width of the asphalt road corridor, metres. Mirrors the default in
 * `routeSurface.createRoadEntity` (7 m wide corridor → 3.5 m half-width).
 * The corridor is a CLAMP_TO_GROUND GroundPrimitive: a camera inside its
 * shadow volume renders a full-frame grey faceted view, so the side-tracking
 * camera must stay outside it horizontally.
 */
export const CORRIDOR_HALF_WIDTH_M = 3.5;
/** Extra margin beyond the corridor half-width (task spec: half-width + 1 m). */
export const CORRIDOR_CLEARANCE_M = 1;
/** Route distance either side of the rider to consider, metres. */
export const CORRIDOR_WINDOW_M = 60;
/** How far beyond the base offset the camera may be pushed to clear the corridor. */
export const CORRIDOR_PUSH_LIMIT_M = 10;
/** Push-out search step, metres. */
export const CORRIDOR_PUSH_STEP_M = 0.5;

/** Minimal route-polyline point for corridor math (RoutePoint is compatible). */
export interface CorridorRoutePoint {
  lat: number;
  lon: number;
  /** Cumulative distance from route start, metres. */
  distance: number;
}

/** Route context letting the side-tracking camera dodge the road corridor. */
export interface SideTrackCorridor {
  /** Route polyline, sorted by cumulative distance. */
  points: ReadonlyArray<CorridorRoutePoint>;
  /** Rider's distance along the route, metres. */
  riderDistanceM: number;
  /** Corridor half-width override (default {@link CORRIDOR_HALF_WIDTH_M}). */
  halfWidthM?: number;
  /**
   * Side used on the previous frame (+1 = right of heading, default). Passing
   * the last applied side gives hysteresis: the camera only switches sides
   * when the preferred side cannot clear the corridor at any offset.
   */
  preferredSide?: 1 | -1;
}

/** Corridor-aware side-tracking camera placement. */
export interface SideTrackPlacement {
  /** +1 = right of heading, -1 = left. */
  side: 1 | -1;
  /** Horizontal distance from the rider to the camera, metres. */
  offsetM: number;
  /** Horizontal distance from the camera to the nearest route segment, metres. */
  clearanceM: number;
}

/**
 * Choose the side and offset for the side-tracking camera so it stays out of
 * the ground-clamped road corridor volume.
 *
 * Measures the candidate camera position against the route polyline within
 * ±{@link CORRIDOR_WINDOW_M} of the rider. The preferred side is kept when it
 * clears (half-width + {@link CORRIDOR_CLEARANCE_M}) at the base offset or can
 * be pushed out within {@link CORRIDOR_PUSH_LIMIT_M}; the camera only switches
 * sides when the preferred side is infeasible and the other side clears. If
 * neither side clears, the candidate with the most room wins (ties stay on the
 * preferred side). Pure math, no Cesium: local equirectangular ENU projection
 * (sub-centimetre error over a 120 m window).
 */
export function resolveSideTrackPlacement(
  riderLat: number,
  riderLon: number,
  headingRad: number,
  baseOffsetM: number,
  corridor: SideTrackCorridor,
): SideTrackPlacement {
  const preferred: 1 | -1 = corridor.preferredSide === -1 ? -1 : 1;
  const pts = corridor.points;
  if (pts.length < 2 || !Number.isFinite(baseOffsetM) || baseOffsetM <= 0) {
    return { side: preferred, offsetM: baseOffsetM, clearanceM: Number.POSITIVE_INFINITY };
  }
  const required = (corridor.halfWidthM ?? CORRIDOR_HALF_WIDTH_M) + CORRIDOR_CLEARANCE_M;

  // Window the polyline to ±CORRIDOR_WINDOW_M along-route around the rider
  // (binary search: points are sorted by cumulative distance). One point is
  // kept beyond each edge so the entry/exit segments stay measurable.
  const lo = corridor.riderDistanceM - CORRIDOR_WINDOW_M;
  const hi = corridor.riderDistanceM + CORRIDOR_WINDOW_M;
  let first = 0;
  let last = pts.length;
  while (first < last) {
    const mid = (first + last) >> 1;
    if (pts[mid].distance < lo) first = mid + 1;
    else last = mid;
  }
  if (first >= pts.length) {
    // Rider is more than CORRIDOR_WINDOW_M past the route end — nothing nearby.
    return { side: preferred, offsetM: baseOffsetM, clearanceM: Number.POSITIVE_INFINITY };
  }
  const startIdx = Math.max(0, first - 1);
  let endIdx = first;
  while (endIdx < pts.length - 1 && pts[endIdx].distance <= hi) endIdx++;

  const n = endIdx - startIdx + 1;
  if (n < 2) {
    return { side: preferred, offsetM: baseOffsetM, clearanceM: Number.POSITIVE_INFINITY };
  }

  // Project the window into local ENU metres with the rider at the origin.
  const mPerDegLat = 110_574;
  const mPerDegLon = 111_320 * Math.cos((riderLat * Math.PI) / 180);
  const wx = new Float64Array(n);
  const wy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = pts[startIdx + i];
    wx[i] = (p.lon - riderLon) * mPerDegLon;
    wy[i] = (p.lat - riderLat) * mPerDegLat;
  }

  // Right-of-heading unit vector (cos h, -sin h) — the same perpendicular as
  // sideTracking's `heading + π/2` offset.
  const perpX = Math.cos(headingRad);
  const perpY = -Math.sin(headingRad);
  const clearanceAt = (side: number, offsetM: number): number => {
    const cx = perpX * side * offsetM;
    const cy = perpY * side * offsetM;
    let min = Number.POSITIVE_INFINITY;
    for (let i = 0; i + 1 < n; i++) {
      const ax = wx[i];
      const ay = wy[i];
      const dx = wx[i + 1] - ax;
      const dy = wy[i + 1] - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : ((cx - ax) * dx + (cy - ay) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(cx - (ax + t * dx), cy - (ay + t * dy));
      if (d < min) min = d;
      if (min === 0) break;
    }
    return min;
  };

  // Sweep one side outward: the first offset that clears wins; otherwise
  // return the best-effort candidate (max clearance found within the cap).
  const cap = baseOffsetM + CORRIDOR_PUSH_LIMIT_M;
  const sweep = (side: 1 | -1): SideTrackPlacement => {
    let best: SideTrackPlacement = { side, offsetM: baseOffsetM, clearanceM: -1 };
    for (let off = baseOffsetM; off <= cap + 1e-9; off += CORRIDOR_PUSH_STEP_M) {
      const c = clearanceAt(side, off);
      if (c >= required) return { side, offsetM: off, clearanceM: c };
      if (c > best.clearanceM) best = { side, offsetM: off, clearanceM: c };
    }
    return best;
  };

  const pref = sweep(preferred);
  if (pref.clearanceM >= required) return pref;
  const other = (preferred === 1 ? -1 : 1) as 1 | -1;
  const alt = sweep(other);
  if (alt.clearanceM >= required) return alt;
  // Neither side reaches the required clearance within the push limit —
  // keep the candidate with the most room (ties stay on the preferred side).
  return alt.clearanceM > pref.clearanceM ? alt : pref;
}

/** Which side of the rider a sideTracking pose places the camera on. */
export function sideTrackSideFromPose(pose: CameraPose, headingRad: number): 1 | -1 {
  // Component of the offset along the right-perpendicular (cos h, -sin h).
  const along =
    pose.offsetENU.x * Math.cos(headingRad) - pose.offsetENU.y * Math.sin(headingRad);
  return along < 0 ? -1 : 1;
}

export const CINEMATIC_RADIUS_M      = 10;
export const CINEMATIC_ELEV_OFFSET_M = 3.5;
export const CINEMATIC_DEG_PER_SEC   = 6;

/** Drone: high and well behind, drifting side to side, framing the road ahead. */
export const DRONE_BACK_M         = 120;
export const DRONE_UP_M           = 60;
export const DRONE_SWAY_M         = 35;
export const DRONE_SWAY_PERIOD_S  = 40;
export const DRONE_LOOK_AHEAD_M   = 40;

/**
 * Compute the target camera pose for a given mode.
 *
 * @param mode        Active camera mode.
 * @param riderPose   Current rider state.
 * @param timeMs      performance.now() value — used for head-bob and cinematic orbit.
 * @param distance    Camera distance setting (chase framing; scales overhead,
 *                    side-tracking and cinematic). Drone ignores it.
 * @returns           ENU offset + orientation that the caller should apply.
 */
/** Safe fallback pose used when riderPose has NaN/non-finite components. */
const ZERO_POSE: CameraPose = {
  offsetENU: { x: 0, y: 0, z: CHASE_UP_M },
  heading: 0,
  pitch: CHASE_PITCH_RAD,
  roll: 0,
};

export function computeCameraPose(
  mode: CameraMode,
  riderPose: RiderPose,
  timeMs: number,
  distance: CameraDistance = DEFAULT_CAMERA_DISTANCE,
  corridor?: SideTrackCorridor,
): CameraPose {
  // NaN/infinity guard — initial frames before GPS or BLE arrive can pass through
  // unset values. Falling through into sin/cos would propagate NaN into the
  // viewer.camera.setView call, freezing the renderer on some platforms.
  if (
    !Number.isFinite(riderPose.heading) ||
    !Number.isFinite(riderPose.cadence) ||
    !Number.isFinite(riderPose.speed)
  ) {
    return ZERO_POSE;
  }

  const h = riderPose.heading; // radians, ENU bearing
  const scale = MODE_SCALE[isCameraDistance(distance) ? distance : DEFAULT_CAMERA_DISTANCE];

  switch (mode) {
    // ------------------------------------------------------------------
    case 'chase': {
      // Trail behind and above, aimed down the road (applyFollowCam eases it).
      const f = CHASE_FRAMING[isCameraDistance(distance) ? distance : DEFAULT_CAMERA_DISTANCE];
      const x = -Math.sin(h) * f.backM;
      const y = -Math.cos(h) * f.backM;
      return {
        offsetENU: { x, y, z: f.upM },
        heading: h,
        pitch: chasePitchRad(f),
        roll: 0,
      };
    }

    // ------------------------------------------------------------------
    case 'firstPerson': {
      // Camera at the rider's eye position; subtle head-bob from cadence.
      const timeS = timeMs / 1000;
      const cadRpm = riderPose.cadence;
      const bob = FIRST_PERSON_HEAD_BOB_AMP * Math.sin((cadRpm * timeS * Math.PI) / 30);
      return {
        offsetENU: {
          x: Math.sin(h) * FIRST_PERSON_EYE_FORWARD_M,
          y: Math.cos(h) * FIRST_PERSON_EYE_FORWARD_M,
          z: FIRST_PERSON_EYE_HEIGHT_M + bob,
        },
        heading: h,
        pitch: FIRST_PERSON_PITCH_RAD,
        roll: 0,
      };
    }

    // ------------------------------------------------------------------
    case 'overhead': {
      // Directly above the rider, looking straight down.
      // heading matches rider so "up" = direction of travel.
      return {
        offsetENU: { x: 0, y: 0, z: OVERHEAD_HEIGHT_M * scale },
        heading: h,
        pitch: -Math.PI / 2,  // straight down
        roll: 0,
      };
    }

    // ------------------------------------------------------------------
    case 'sideTracking': {
      // Perpendicular offset (right side by default), same elevation — TV
      // broadcast framing. On curves the naive perpendicular can land on the
      // ground-clamped road corridor (a GroundPrimitive shadow volume renders
      // a full-frame grey faceted view from inside); with a corridor context
      // the placement pushes out or switches sides to stay clear of it.
      const baseSide = SIDE_TRACK_OFFSET_M * scale;
      const up = SIDE_TRACK_UP_M * Math.sqrt(scale);
      let sideSign: 1 | -1 = 1;
      let sideDist = baseSide;
      if (corridor) {
        const placement = resolveSideTrackPlacement(
          riderPose.lat,
          riderPose.lon,
          h,
          baseSide,
          corridor,
        );
        sideSign = placement.side;
        sideDist = placement.offsetM;
      }
      // Perpendicular to heading = heading + 90° (right of travel); a
      // negative side distance mirrors the offset to the left.
      const perpHeading = h + Math.PI / 2;
      const side = sideDist * sideSign;
      const x = Math.sin(perpHeading) * side;
      const y = Math.cos(perpHeading) * side;
      // Camera looks back toward the rider (heading ∓ 90°), aimed at the bars.
      const lookback = h - (sideSign * Math.PI) / 2;
      return {
        offsetENU: { x, y, z: up },
        heading: lookback,
        pitch: riderAimPitchRad(up, sideDist),
        roll: 0,
      };
    }

    // ------------------------------------------------------------------
    case 'drone': {
      const sway =
        Math.sin((2 * Math.PI * (timeMs / 1000)) / DRONE_SWAY_PERIOD_S) * DRONE_SWAY_M;
      // Forward and right unit vectors in ENU (heading is clockwise from north).
      const fx = Math.sin(h);
      const fy = Math.cos(h);
      const rx = Math.cos(h);
      const ry = -Math.sin(h);
      const x = -fx * DRONE_BACK_M + rx * sway;
      const y = -fy * DRONE_BACK_M + ry * sway;
      const z = DRONE_UP_M;
      // Aim a little ahead of the rider so the road and view fill the frame.
      const dx = fx * DRONE_LOOK_AHEAD_M - x;
      const dy = fy * DRONE_LOOK_AHEAD_M - y;
      return {
        offsetENU: { x, y, z },
        heading: Math.atan2(dx, dy),
        pitch: -Math.atan2(z, Math.hypot(dx, dy)),
        roll: 0,
      };
    }

    // ------------------------------------------------------------------
    case 'cinematic': {
      const yaw = shouldRotateForCinematicOrbit(timeMs, CINEMATIC_DEG_PER_SEC);
      const yawRad = yaw * (Math.PI / 180);
      const radius = CINEMATIC_RADIUS_M * scale;
      const up = CINEMATIC_ELEV_OFFSET_M * scale;
      const orbitX = Math.cos(yawRad) * radius;
      const orbitY = Math.sin(yawRad) * radius;
      // Camera looks at the rider: the bearing of the inward vector. (The old
      // `yaw + π` mixed the math angle with a compass bearing, so the orbit
      // camera only faced the rider twice per lap.)
      const camHeading = Math.atan2(-orbitX, -orbitY);
      const pitchRad = riderAimPitchRad(up, radius);
      return {
        offsetENU: { x: orbitX, y: orbitY, z: up },
        heading: camHeading,
        pitch: pitchRad,
        roll: 0,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// easedCameraTransition
// ---------------------------------------------------------------------------

/**
 * Interpolate between two CameraPoses using easeOutCubic.
 *
 * @param from  Starting pose (t=0).
 * @param to    Target pose (t=1).
 * @param t     Progress 0..1 (raw, not yet eased).
 */
export function easedCameraTransition(
  from: CameraPose,
  to: CameraPose,
  t: number,
): CameraPose {
  const e = easeOutCubic(Math.max(0, Math.min(1, t)));

  const lerp = (a: number, b: number) => a + (b - a) * e;

  // Shortest-path angular interpolation.
  const lerpAngle = (a: number, b: number) => {
    const d = ((b - a) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    return a + d * e;
  };

  return {
    offsetENU: {
      x: lerp(from.offsetENU.x, to.offsetENU.x),
      y: lerp(from.offsetENU.y, to.offsetENU.y),
      z: lerp(from.offsetENU.z, to.offsetENU.z),
    },
    heading: lerpAngle(from.heading, to.heading),
    pitch:   lerp(from.pitch, to.pitch),
    roll:    lerp(from.roll, to.roll),
  };
}

// ---------------------------------------------------------------------------
// shouldRotateForCinematicOrbit
// ---------------------------------------------------------------------------

/**
 * Returns the current yaw angle (degrees) for the cinematic orbit camera.
 *
 * @param elapsedMs     Absolute timestamp from performance.now().
 * @param orbitDegPerSec  Rotation speed.
 */
export function shouldRotateForCinematicOrbit(
  elapsedMs: number,
  orbitDegPerSec: number,
): number {
  return ((elapsedMs / 1000) * orbitDegPerSec) % 360;
}
