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

/**
 * How far the follow cameras sit from the rider. `standard` is the default:
 * the rider fills the lower-middle of the frame and the road is readable
 * 10–20 m ahead. `overview` is the original GlobeRide framing (45 m back,
 * 9 m up), kept for riders who liked the map-like view.
 */
export type CameraDistance = 'close' | 'standard' | 'far' | 'overview';

export const CAMERA_DISTANCES: ReadonlyArray<CameraDistance> = ['close', 'standard', 'far', 'overview'];

export const DEFAULT_CAMERA_DISTANCE: CameraDistance = 'standard';

export const CAMERA_DISTANCE_LABELS: Record<CameraDistance, string> = {
  close: 'Close',
  standard: 'Standard',
  far: 'Far',
  overview: 'Overview',
};

export function isCameraDistance(value: unknown): value is CameraDistance {
  return typeof value === 'string' && (CAMERA_DISTANCES as ReadonlyArray<string>).includes(value);
}

/** Chase framing: metres behind, metres up, and the aim point ahead. */
export interface ChaseFraming {
  backM: number;
  upM: number;
  /** The camera aims at a point this far ahead of the rider, at {@link AIM_HEIGHT_M}. */
  lookAheadM: number;
}

/** Height of the aim point: roughly the rider's hips/bars. */
export const AIM_HEIGHT_M = 1.0;

export const CHASE_FRAMING: Record<CameraDistance, ChaseFraming> = {
  close: { backM: 4.5, upM: 1.9, lookAheadM: 10 },
  standard: { backM: 7, upM: 2.6, lookAheadM: 14 },
  far: { backM: 14, upM: 4.5, lookAheadM: 20 },
  // The original framing: 45 m back, 9 m up, -7° pitch.
  overview: { backM: 45, upM: 9, lookAheadM: 20.2 },
};

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
      // Perpendicular offset (right side), same elevation — TV broadcast.
      // Perpendicular to heading = heading + 90° (east relative to travel).
      const perpHeading = h + Math.PI / 2;
      const side = SIDE_TRACK_OFFSET_M * scale;
      const up = SIDE_TRACK_UP_M * Math.sqrt(scale);
      const x = Math.sin(perpHeading) * side;
      const y = Math.cos(perpHeading) * side;
      // Camera looks back toward the rider (heading - 90°), aimed at the bars.
      const lookback = h - Math.PI / 2;
      return {
        offsetENU: { x, y, z: up },
        heading: lookback,
        pitch: -Math.atan2(up - AIM_HEIGHT_M, side),
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
      const pitchRad = -Math.atan2(up - AIM_HEIGHT_M, radius);
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
