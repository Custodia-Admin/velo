/**
 * cesiumCameras.test.ts — Wave 30.A unit tests.
 *
 * All tests run in the node vitest environment (no Cesium / browser APIs).
 * The camera utilities are pure-math functions — no Cesium imports needed.
 */

import { describe, it, expect } from 'vitest';
import {
  AIM_HEIGHT_M,
  CAMERA_DISTANCES,
  CHASE_FRAMING,
  DEFAULT_CAMERA_DISTANCE,
  FIRST_PERSON_EYE_FORWARD_M,
  FIRST_PERSON_PITCH_RAD,
  SIDE_TRACK_UP_M,
  isCameraDistance,
  type CameraDistance,
  computeCameraPose,
  easedCameraTransition,
  easeOutCubic,
  shouldRotateForCinematicOrbit,
  isCameraMode,
  CAMERA_MODES,
  CHASE_BACK_M,
  CHASE_UP_M,
  FIRST_PERSON_EYE_HEIGHT_M,
  OVERHEAD_HEIGHT_M,
  SIDE_TRACK_OFFSET_M,
  CINEMATIC_RADIUS_M,
  CINEMATIC_ELEV_OFFSET_M,
  CINEMATIC_DEG_PER_SEC,
  type CameraMode,
  type RiderPose,
  CORRIDOR_CLEARANCE_M,
  CORRIDOR_HALF_WIDTH_M,
  CORRIDOR_PUSH_LIMIT_M,
  CORRIDOR_WINDOW_M,
  resolveSideTrackPlacement,
  riderAimPitchRad,
  sideTrackSideFromPose,
  type CorridorRoutePoint,
  type SideTrackCorridor,
} from '@/lib/cesiumCameras';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkRider(overrides: Partial<RiderPose> = {}): RiderPose {
  return {
    lat: 45,
    lon: 7,
    ele: 1000,
    heading: 0,   // facing north
    cadence: 90,
    speed: 8,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeCameraPose — one test per mode (5 tests)
// ---------------------------------------------------------------------------

describe('computeCameraPose', () => {
  const rider = mkRider({ heading: 0 });
  const now = 10_000; // 10 s

  it('chase: trails behind and above rider along heading', () => {
    const pose = computeCameraPose('chase', rider, now);
    // heading=0 (north): offset should be south (negative y) and up.
    expect(pose.offsetENU.z).toBeCloseTo(CHASE_UP_M, 5);
    // For heading=0: sin(0)=0, cos(0)=1 → x≈0, y≈-CHASE_BACK_M.
    expect(pose.offsetENU.x).toBeCloseTo(0, 5);
    expect(pose.offsetENU.y).toBeCloseTo(-CHASE_BACK_M, 5);
    expect(pose.pitch).toBeLessThan(0); // looking slightly down
  });

  it('firstPerson: places camera at eye height with head bob', () => {
    const pose = computeCameraPose('firstPerson', rider, now);
    // z should be near FIRST_PERSON_EYE_HEIGHT_M ± head-bob amplitude (0.04m).
    expect(pose.offsetENU.z).toBeGreaterThan(FIRST_PERSON_EYE_HEIGHT_M - 0.05);
    expect(pose.offsetENU.z).toBeLessThan(FIRST_PERSON_EYE_HEIGHT_M + 0.05);
    // Eyes just in front of the face (heading 0 = north): no sideways offset.
    expect(pose.offsetENU.x).toBeCloseTo(0, 5);
    expect(pose.offsetENU.y).toBeCloseTo(FIRST_PERSON_EYE_FORWARD_M, 5);
    // Looking down the road, slightly below the horizon; heading matches rider.
    expect(pose.pitch).toBeCloseTo(FIRST_PERSON_PITCH_RAD, 5);
    expect(pose.pitch).toBeLessThan(0);
    expect(pose.heading).toBeCloseTo(rider.heading, 5);
  });

  it('overhead: 100m above rider looking straight down', () => {
    const pose = computeCameraPose('overhead', rider, now);
    expect(pose.offsetENU.z).toBeCloseTo(OVERHEAD_HEIGHT_M, 5);
    expect(pose.offsetENU.x).toBeCloseTo(0, 5);
    expect(pose.offsetENU.y).toBeCloseTo(0, 5);
    // Pitch = -π/2 (straight down).
    expect(pose.pitch).toBeCloseTo(-Math.PI / 2, 5);
    // Heading matches rider so "up" = forward.
    expect(pose.heading).toBeCloseTo(rider.heading, 5);
  });

  it('sideTracking: offset perpendicular to heading at shoulder height, aimed at the bars', () => {
    const pose = computeCameraPose('sideTracking', rider, now);
    // For heading=0 (north), perpendicular is east: x ≈ SIDE_TRACK_OFFSET_M, y ≈ 0.
    expect(pose.offsetENU.x).toBeCloseTo(SIDE_TRACK_OFFSET_M, 3);
    expect(pose.offsetENU.y).toBeCloseTo(0, 3);
    // Off the tarmac (a camera at 0 m sits inside the road surface), looking slightly down.
    expect(pose.offsetENU.z).toBeCloseTo(SIDE_TRACK_UP_M, 5);
    expect(pose.pitch).toBeLessThan(0);
  });

  it('cinematic: orbits at CINEMATIC_RADIUS_M elevation with upward offset', () => {
    const pose = computeCameraPose('cinematic', rider, now);
    // Camera must be offset at the orbit radius in x/y plane.
    const r = Math.sqrt(pose.offsetENU.x ** 2 + pose.offsetENU.y ** 2);
    expect(r).toBeCloseTo(CINEMATIC_RADIUS_M, 3);
    // Elevation offset must be positive.
    expect(pose.offsetENU.z).toBeCloseTo(CINEMATIC_ELEV_OFFSET_M, 5);
    // Pitch must be negative (looking slightly down).
    expect(pose.pitch).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// Camera distance setting
// ---------------------------------------------------------------------------

describe('camera distance', () => {
  const rider = mkRider({ heading: 0.3 });
  const back = (p: { offsetENU: { x: number; y: number } }) => Math.hypot(p.offsetENU.x, p.offsetENU.y);

  it('defaults to the standard framing: close and low, aimed 10–20 m down the road', () => {
    expect(DEFAULT_CAMERA_DISTANCE).toBe('standard');
    const pose = computeCameraPose('chase', rider, 0);
    const f = CHASE_FRAMING.standard;
    expect(back(pose)).toBeCloseTo(f.backM, 5);
    expect(pose.offsetENU.z).toBeCloseTo(f.upM, 5);
    expect(f.backM).toBeLessThanOrEqual(10);
    expect(f.upM).toBeLessThanOrEqual(3.5);
    expect(f.lookAheadM).toBeGreaterThanOrEqual(10);
    expect(f.lookAheadM).toBeLessThanOrEqual(20);
    // The pitch line passes through the aim point lookAheadM past the rider.
    const aimDrop = Math.tan(-pose.pitch) * (f.backM + f.lookAheadM);
    expect(pose.offsetENU.z - aimDrop).toBeCloseTo(AIM_HEIGHT_M, 5);
  });

  it('orders the chase framings from close to overview', () => {
    const backs = CAMERA_DISTANCES.map((d) => back(computeCameraPose('chase', rider, 0, d)));
    for (let i = 1; i < backs.length; i++) expect(backs[i]).toBeGreaterThan(backs[i - 1]);
  });

  it('keeps the original GlobeRide framing as "overview" (45 m back, 9 m up, about -7°)', () => {
    const pose = computeCameraPose('chase', rider, 0, 'overview');
    expect(back(pose)).toBeCloseTo(45, 5);
    expect(pose.offsetENU.z).toBeCloseTo(9, 5);
    expect((pose.pitch * 180) / Math.PI).toBeCloseTo(-7, 0);
  });

  it('scales the side, orbit and overhead shots with distance; first person is unaffected', () => {
    for (const mode of ['sideTracking', 'cinematic', 'overhead'] as const) {
      const near = computeCameraPose(mode, rider, 1000, 'close');
      const far = computeCameraPose(mode, rider, 1000, 'far');
      expect(Math.hypot(far.offsetENU.x, far.offsetENU.y, far.offsetENU.z)).toBeGreaterThan(
        Math.hypot(near.offsetENU.x, near.offsetENU.y, near.offsetENU.z),
      );
    }
    expect(computeCameraPose('firstPerson', rider, 1000, 'far')).toEqual(
      computeCameraPose('firstPerson', rider, 1000, 'close'),
    );
  });

  it('cinematic: always faces the rider around the whole orbit', () => {
    for (let t = 0; t < 60_000; t += 3_000) {
      const pose = computeCameraPose('cinematic', rider, t);
      // Bearing from camera to rider (at the origin).
      const toRider = Math.atan2(-pose.offsetENU.x, -pose.offsetENU.y);
      const d = Math.atan2(Math.sin(toRider - pose.heading), Math.cos(toRider - pose.heading));
      expect(Math.abs(d)).toBeLessThan(1e-6);
    }
  });

  it('falls back to standard for an unknown persisted value', () => {
    expect(isCameraDistance('standard')).toBe(true);
    expect(isCameraDistance('huge')).toBe(false);
    const pose = computeCameraPose('chase', rider, 0, 'huge' as CameraDistance);
    expect(back(pose)).toBeCloseTo(CHASE_FRAMING.standard.backM, 5);
  });
});

// ---------------------------------------------------------------------------
// easedCameraTransition — t=0, t=0.5, t=1 (3 tests)
// ---------------------------------------------------------------------------

describe('easedCameraTransition', () => {
  const from: ReturnType<typeof computeCameraPose> = {
    offsetENU: { x: 0, y: 0, z: 0 },
    heading: 0,
    pitch: 0,
    roll: 0,
  };
  const to: ReturnType<typeof computeCameraPose> = {
    offsetENU: { x: 10, y: 20, z: 5 },
    heading: 1,
    pitch: -0.5,
    roll: 0.1,
  };

  it('t=0 returns the from pose', () => {
    const r = easedCameraTransition(from, to, 0);
    expect(r.offsetENU.x).toBeCloseTo(0, 6);
    expect(r.offsetENU.y).toBeCloseTo(0, 6);
    expect(r.offsetENU.z).toBeCloseTo(0, 6);
    expect(r.heading).toBeCloseTo(0, 6);
  });

  it('t=1 returns the to pose', () => {
    const r = easedCameraTransition(from, to, 1);
    expect(r.offsetENU.x).toBeCloseTo(10, 5);
    expect(r.offsetENU.y).toBeCloseTo(20, 5);
    expect(r.offsetENU.z).toBeCloseTo(5, 5);
    expect(r.pitch).toBeCloseTo(-0.5, 5);
  });

  it('t=0.5 interpolates between from and to (eased, not linear midpoint)', () => {
    const r = easedCameraTransition(from, to, 0.5);
    // easeOutCubic(0.5) = 1 - (0.5)^3 = 0.875 → x ≈ 8.75
    const e = easeOutCubic(0.5);
    expect(r.offsetENU.x).toBeCloseTo(10 * e, 5);
    expect(r.offsetENU.z).toBeCloseTo(5 * e, 5);
    // Must be strictly between from and to.
    expect(r.offsetENU.x).toBeGreaterThan(0);
    expect(r.offsetENU.x).toBeLessThan(10);
  });
});

// ---------------------------------------------------------------------------
// shouldRotateForCinematicOrbit (2 tests)
// ---------------------------------------------------------------------------

describe('shouldRotateForCinematicOrbit', () => {
  it('returns 0 at time 0', () => {
    expect(shouldRotateForCinematicOrbit(0, CINEMATIC_DEG_PER_SEC)).toBeCloseTo(0, 5);
  });

  it('cycles back toward 0 after a full rotation', () => {
    // Time for one full orbit: 360 / 6 = 60 s → 60_000 ms.
    const period = (360 / CINEMATIC_DEG_PER_SEC) * 1000;
    expect(shouldRotateForCinematicOrbit(period, CINEMATIC_DEG_PER_SEC)).toBeCloseTo(0, 3);
    // 180° is at half period.
    expect(shouldRotateForCinematicOrbit(period / 2, CINEMATIC_DEG_PER_SEC)).toBeCloseTo(180, 3);
  });
});

// ---------------------------------------------------------------------------
// easeOutCubic boundary tests (2 bonus tests)
// ---------------------------------------------------------------------------

describe('easeOutCubic', () => {
  it('returns 0 at t=0 and 1 at t=1', () => {
    expect(easeOutCubic(0)).toBeCloseTo(0, 10);
    expect(easeOutCubic(1)).toBeCloseTo(1, 10);
  });

  it('is monotonically increasing from 0 to 1', () => {
    const samples = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
    for (let i = 1; i < samples.length; i++) {
      expect(easeOutCubic(samples[i])).toBeGreaterThan(easeOutCubic(samples[i - 1]));
    }
  });
});

// ---------------------------------------------------------------------------
// Head-bob: varies with time and cadence (1 bonus test)
// ---------------------------------------------------------------------------

describe('firstPerson head-bob', () => {
  it('produces different z offsets at different timestamps', () => {
    const rider = mkRider({ cadence: 90 });
    const t1 = computeCameraPose('firstPerson', rider, 0);
    // At t=0: cadence=90, sin(90*0*π/30)=sin(0)=0 → z=1.2 exactly.
    expect(t1.offsetENU.z).toBeCloseTo(FIRST_PERSON_EYE_HEIGHT_M, 5);
    // At t=250ms: arg = 90 * 0.25 * π/30 = 0.75π → sin(0.75π)=sin(135°)≈0.707 ≠ 0.
    const t2 = computeCameraPose('firstPerson', rider, 250);
    expect(t2.offsetENU.z).not.toBeCloseTo(FIRST_PERSON_EYE_HEIGHT_M, 5);
  });
});

// ---------------------------------------------------------------------------
// All 5 modes return finite numbers (guard for NaN) (1 bonus test)
// ---------------------------------------------------------------------------

describe('computeCameraPose numeric validity', () => {
  const modes: CameraMode[] = ['chase', 'firstPerson', 'overhead', 'sideTracking', 'cinematic'];
  it('all modes return finite heading/pitch/roll/offsets', () => {
    const rider = mkRider({ heading: Math.PI / 4, cadence: 60, speed: 5 });
    for (const mode of modes) {
      const p = computeCameraPose(mode, rider, 12_345);
      expect(Number.isFinite(p.offsetENU.x)).toBe(true);
      expect(Number.isFinite(p.offsetENU.y)).toBe(true);
      expect(Number.isFinite(p.offsetENU.z)).toBe(true);
      expect(Number.isFinite(p.heading)).toBe(true);
      expect(Number.isFinite(p.pitch)).toBe(true);
      expect(Number.isFinite(p.roll)).toBe(true);
    }
  });

  it('returns a finite fallback when riderPose has NaN inputs (polish guard)', () => {
    const nanRider: RiderPose = { lat: 0, lon: 0, ele: 0, heading: NaN, cadence: NaN, speed: NaN };
    for (const mode of modes) {
      const p = computeCameraPose(mode, nanRider, 0);
      expect(Number.isFinite(p.offsetENU.x)).toBe(true);
      expect(Number.isFinite(p.heading)).toBe(true);
      expect(Number.isFinite(p.pitch)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// isCameraMode — runtime validator for persisted localStorage values
// ---------------------------------------------------------------------------

describe('isCameraMode', () => {
  it('accepts every member of CAMERA_MODES', () => {
    for (const m of CAMERA_MODES) {
      expect(isCameraMode(m)).toBe(true);
    }
  });

  it('rejects unknown strings, null, undefined, and non-strings', () => {
    expect(isCameraMode('hacked')).toBe(false);
    expect(isCameraMode('')).toBe(false);
    expect(isCameraMode(null)).toBe(false);
    expect(isCameraMode(undefined)).toBe(false);
    expect(isCameraMode(42)).toBe(false);
    expect(isCameraMode({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Side-tracking corridor avoidance — the camera must stay out of the
// ground-clamped road corridor volume (t_5a41d468)
// ---------------------------------------------------------------------------

describe('resolveSideTrackPlacement', () => {
  const LAT = 45;
  const LON = 7;
  // Mirrors cesiumCameras' local equirectangular projection.
  const M_PER_DEG_LAT = 110_574;
  const M_PER_DEG_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);
  const BASE = SIDE_TRACK_OFFSET_M; // 9
  const REQUIRED = CORRIDOR_HALF_WIDTH_M + CORRIDOR_CLEARANCE_M; // 4.5

  /** Corridor from ENU metre offsets relative to the rider; distances are cumulative lengths. */
  function corridorFromENU(
    enu: Array<[number, number]>,
    riderDistanceM: number,
    preferredSide?: 1 | -1,
  ): SideTrackCorridor {
    const points: CorridorRoutePoint[] = [];
    let d = 0;
    for (let i = 0; i < enu.length; i++) {
      if (i > 0) d += Math.hypot(enu[i][0] - enu[i - 1][0], enu[i][1] - enu[i - 1][1]);
      points.push({
        lat: LAT + enu[i][1] / M_PER_DEG_LAT,
        lon: LON + enu[i][0] / M_PER_DEG_LON,
        distance: d,
      });
    }
    return { points, riderDistanceM, preferredSide };
  }

  const resolve = (c: SideTrackCorridor, headingRad = 0, base = BASE) =>
    resolveSideTrackPlacement(LAT, LON, headingRad, base, c);

  /** Straight route north, points every 5 m; rider at (0,0) = 30 m along. */
  const straightRoute = (): Array<[number, number]> => {
    const pts: Array<[number, number]> = [];
    for (let y = -30; y <= 90; y += 5) pts.push([0, y]);
    return pts;
  };

  /** Sharp right bend: north, then east — the inside of the bend is the right side. */
  const sharpRight = (): Array<[number, number]> => [
    [0, -20], [0, -10], [0, -5], [0, 0], [0, 4],
    [3, 5.5], [6, 5], [9, 2], [12, 0], [15, -1], [20, -1.5], [26, -2], [32, -2],
  ];

  /** Wide right curve (~20 m radius): the right side is blocked at base but clears pushed out. */
  const wideRight = (): Array<[number, number]> => {
    const pts: Array<[number, number]> = [[0, -20], [0, -10], [0, -5], [0, 0]];
    for (let deg = 5; deg <= 75; deg += 5) {
      const t = (deg * Math.PI) / 180;
      pts.push([20 * Math.sin(t), 20 * (1 - Math.cos(t))]);
    }
    return pts;
  };

  it('straight route: keeps the right side at the base offset', () => {
    const p = resolve(corridorFromENU(straightRoute(), 30));
    expect(p.side).toBe(1);
    expect(p.offsetM).toBeCloseTo(BASE, 6);
    expect(p.clearanceM).toBeGreaterThanOrEqual(REQUIRED);
    expect(p.clearanceM).toBeCloseTo(BASE, 1);
  });

  it('sharp right bend: the right-side camera would sit in the corridor → switches to the left', () => {
    const p = resolve(corridorFromENU(sharpRight(), 20));
    expect(p.side).toBe(-1);
    expect(p.offsetM).toBeCloseTo(BASE, 6);
    expect(p.clearanceM).toBeGreaterThanOrEqual(REQUIRED);
  });

  it('wide right curve: pushes the right side outward within the limit instead of switching', () => {
    const p = resolve(corridorFromENU(wideRight(), 20));
    expect(p.side).toBe(1);
    expect(p.offsetM).toBeGreaterThan(BASE);
    expect(p.offsetM).toBeLessThanOrEqual(BASE + CORRIDOR_PUSH_LIMIT_M);
    expect(p.clearanceM).toBeGreaterThanOrEqual(REQUIRED);
  });

  it('hysteresis: the preferred side stays when it can clear (wide curve, left preferred)', () => {
    const p = resolve(corridorFromENU(wideRight(), 20, -1));
    expect(p.side).toBe(-1);
    expect(p.offsetM).toBeCloseTo(BASE, 6); // left clears at the base offset — no push-out
    expect(p.clearanceM).toBeGreaterThanOrEqual(REQUIRED);
  });

  it('hysteresis: preferredSide=-1 is kept through the sharp bend too', () => {
    const p = resolve(corridorFromENU(sharpRight(), 20, -1));
    expect(p.side).toBe(-1);
    expect(p.offsetM).toBeCloseTo(BASE, 6);
  });

  it('honours heading: the rotated sharp bend switches sides the same way', () => {
    // Rotate sharpRight by -90° so the route heads east (heading π/2).
    const rotated = sharpRight().map(([x, y]) => [y, -x] as [number, number]);
    const p = resolve(corridorFromENU(rotated, 20), Math.PI / 2);
    expect(p.side).toBe(-1);
    expect(p.offsetM).toBeCloseTo(BASE, 6);
    expect(p.clearanceM).toBeGreaterThanOrEqual(REQUIRED);
  });

  it('ignores route geometry beyond ±CORRIDOR_WINDOW_M along the route', () => {
    // Out-and-back loop: the return leg passes through the right-side camera
    // position, but only after ~99 m of route distance (window is ±60 m).
    const loop: Array<[number, number]> = [];
    for (let y = -10; y <= 40; y += 5) loop.push([0, y]);
    loop.push([5, 40], [9, 40]);
    for (let y = 35; y >= -5; y -= 5) loop.push([9, y]);
    const p = resolve(corridorFromENU(loop, 10));
    expect(p.side).toBe(1);
    expect(p.offsetM).toBeCloseTo(BASE, 6);
    expect(p.clearanceM).toBeGreaterThanOrEqual(REQUIRED);
    expect(CORRIDOR_WINDOW_M).toBe(60);
  });

  it('degenerate routes (<2 points) keep the default placement on the preferred side', () => {
    const c: SideTrackCorridor = {
      points: [{ lat: LAT, lon: LON, distance: 0 }],
      riderDistanceM: 0,
      preferredSide: -1,
    };
    const p = resolveSideTrackPlacement(LAT, LON, 0, BASE, c);
    expect(p.side).toBe(-1);
    expect(p.offsetM).toBeCloseTo(BASE, 6);
    expect(p.clearanceM).toBe(Number.POSITIVE_INFINITY);
  });

  it('riderAimPitchRad re-aims a lifted camera at the rider (t_5a41d468)', () => {
    // At the nominal side-tracking height the re-aim matches the pose pitch.
    expect(riderAimPitchRad(SIDE_TRACK_UP_M, BASE)).toBeCloseTo(
      computeCameraPose('sideTracking', mkRider({ lat: LAT, lon: LON, heading: 0 }), 0).pitch,
      10,
    );
    // A camera lifted to 18 m beside the rider looks steeply down, keeping the
    // rider framed instead of staring at roof height.
    const lifted = riderAimPitchRad(18, BASE);
    expect((lifted * 180) / Math.PI).toBeLessThan(-60);
    // Monotonic: higher camera → steeper down-pitch; farther camera → shallower.
    expect(riderAimPitchRad(10, BASE)).toBeLessThan(riderAimPitchRad(5, BASE));
    expect(riderAimPitchRad(5, 20)).toBeGreaterThan(riderAimPitchRad(5, 5));
    // Directly above (no horizontal offset) → straight down, never NaN.
    expect(riderAimPitchRad(5, 0)).toBeCloseTo(-Math.PI / 2, 10);
  });

  it('computeCameraPose mirrors the placement into the ENU offset and look-back heading', () => {
    const corridor = corridorFromENU(sharpRight(), 20);
    const riderPose = mkRider({ lat: LAT, lon: LON, heading: 0 });
    const pose = computeCameraPose('sideTracking', riderPose, 10_000, 'standard', corridor);
    // Switched to the left side: west of the rider, looking back east at them.
    expect(pose.offsetENU.x).toBeCloseTo(-BASE, 1);
    expect(pose.offsetENU.y).toBeCloseTo(0, 1);
    expect(pose.offsetENU.z).toBeCloseTo(SIDE_TRACK_UP_M, 5);
    expect(pose.heading).toBeCloseTo(Math.PI / 2, 5);
    expect(pose.pitch).toBeCloseTo(-Math.atan2(SIDE_TRACK_UP_M - AIM_HEIGHT_M, BASE), 5);
    expect(sideTrackSideFromPose(pose, 0)).toBe(-1);
  });

  it('computeCameraPose without a corridor keeps the legacy right-side framing', () => {
    const pose = computeCameraPose('sideTracking', mkRider({ lat: LAT, lon: LON, heading: 0 }), 10_000);
    expect(pose.offsetENU.x).toBeCloseTo(BASE, 5);
    expect(pose.offsetENU.y).toBeCloseTo(0, 5);
    expect(pose.heading).toBeCloseTo(-Math.PI / 2, 5);
    expect(sideTrackSideFromPose(pose, 0)).toBe(1);
  });

  it('sideTrackSideFromPose reads the side for rotated headings', () => {
    const riderPose = mkRider({ lat: LAT, lon: LON, heading: Math.PI / 2 });
    const corridor = corridorFromENU(
      sharpRight().map(([x, y]) => [y, -x] as [number, number]),
      20,
    );
    const pose = computeCameraPose('sideTracking', riderPose, 0, 'standard', corridor);
    expect(sideTrackSideFromPose(pose, Math.PI / 2)).toBe(-1);
    // Left of eastbound travel = north: the offset points north.
    expect(pose.offsetENU.y).toBeGreaterThan(0);
    expect(Math.abs(pose.offsetENU.x)).toBeLessThan(1e-9);
  });
});
