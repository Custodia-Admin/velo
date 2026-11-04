import { beforeEach, describe, expect, it } from 'vitest';
import {
  CESIUM_SHOT_MODE,
  effectiveCameraMode,
  resetShowDirector,
  showDirectorFrame,
} from '@/lib/show/showDirector';
import { computeCameraPose, DRONE_UP_M, CAMERA_MODES } from '@/lib/cesiumCameras';
import { DIRECTOR_SHOTS, MIN_CUT_GAP_S } from '@/lib/world/director';

const on = { active: true, autoCamera: true, startedAtMs: 1_000 };
const ride = { routeId: 'assisi', distance: 0, speed: 8, steer: 0 };

/** Ride `seconds` at 8 m/s on a straight road at 20 fps; the shots seen, in order. */
function ridePast(gate: typeof on, seconds: number, routeId = 'assisi'): string[] {
  const shots: string[] = [];
  for (let i = 0; i <= seconds * 20; i++) {
    const t = gate.startedAtMs + i * 50;
    const f = showDirectorFrame(gate, { ...ride, routeId, distance: i * 0.4 }, t);
    if (f && shots[shots.length - 1] !== f.shot) shots.push(f.shot);
  }
  return shots;
}

beforeEach(() => resetShowDirector());

describe('showDirectorFrame', () => {
  it("leaves the camera to the rider outside show mode or once they take over", () => {
    expect(showDirectorFrame({ ...on, active: false }, ride, 50_000)).toBeNull();
    expect(showDirectorFrame({ ...on, autoCamera: false }, ride, 50_000)).toBeNull();
    expect(showDirectorFrame({ ...on, startedAtMs: null }, ride, 50_000)).toBeNull();
  });

  it('opens on the chase camera and cuts from there', () => {
    expect(showDirectorFrame(on, ride, 1_000)?.shot).toBe('chase');
    const shots = ridePast(on, 300);
    expect(shots[0]).toBe('chase');
    expect(shots.length).toBeGreaterThan(5);
  });

  it('keeps one edit through a show session and starts afresh with a new one', () => {
    const a = ridePast(on, 200);
    // Same session again from scratch → same edit (seeded from the route).
    resetShowDirector();
    expect(ridePast(on, 200)).toEqual(a);
    // A new show (new start time) on the same route gets the same seed, hence the same edit.
    expect(ridePast({ ...on, startedAtMs: 900_000 }, 200)).toEqual(a);
    // Another route, another edit.
    expect(ridePast({ ...on, startedAtMs: 2_000_000 }, 200, 'gubbio')).not.toEqual(a);
  });

  it('holds the shot while the rider steers', () => {
    let f = showDirectorFrame(on, ride, 1_000);
    const shot = f?.shot;
    for (let t = 1_000; t < 1_000 + 4 * MIN_CUT_GAP_S * 1000; t += 50) {
      f = showDirectorFrame(on, { ...ride, steer: 0.5, distance: (t - 1_000) * 0.008 }, t);
      expect(f?.shot).toBe(shot);
      expect(f?.suspended).toBe(true);
    }
  });
});

describe('effectiveCameraMode (photoreal renderer)', () => {
  it("uses the rider's camera outside show mode", () => {
    expect(effectiveCameraMode('overhead', { ...on, active: false }, ride, 50_000)).toBe('overhead');
    expect(effectiveCameraMode('firstPerson', { ...on, autoCamera: false }, ride, 50_000)).toBe('firstPerson');
  });

  it('films every director shot with a calm camera (no road-height modes over streamed terrain)', () => {
    for (const shot of DIRECTOR_SHOTS) {
      expect(CAMERA_MODES).toContain(CESIUM_SHOT_MODE[shot]);
      expect(['firstPerson', 'sideTracking']).not.toContain(CESIUM_SHOT_MODE[shot]);
    }
    expect(effectiveCameraMode('overhead', on, ride, 1_000)).toBe('chase');
  });
});

describe('drone camera pose', () => {
  const rider = { lat: 46, lon: 9, ele: 300, heading: Math.PI / 4, cadence: 85, speed: 7 };

  it('is a known camera mode', () => {
    expect(CAMERA_MODES).toContain('drone');
  });

  it('sits high and behind the rider, looking down toward them', () => {
    for (const t of [0, 5_000, 10_000, 20_000]) {
      const pose = computeCameraPose('drone', rider, t);
      expect(pose.offsetENU.z).toBe(DRONE_UP_M);
      // Behind: offset has a negative component along the heading.
      const forward = pose.offsetENU.x * Math.sin(rider.heading) + pose.offsetENU.y * Math.cos(rider.heading);
      expect(forward).toBeLessThan(-100);
      expect(pose.pitch).toBeLessThan(0);
      expect(pose.pitch).toBeGreaterThan(-Math.PI / 4);
      // Camera faces roughly the direction of travel.
      const d = Math.abs(((pose.heading - rider.heading + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      expect(d).toBeLessThan(Math.PI / 6);
    }
  });

  it('drifts side to side over time', () => {
    const a = computeCameraPose('drone', rider, 0);
    const b = computeCameraPose('drone', rider, 10_000);
    expect(Math.hypot(a.offsetENU.x - b.offsetENU.x, a.offsetENU.y - b.offsetENU.y)).toBeGreaterThan(20);
  });
});
