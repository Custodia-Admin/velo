import { describe, expect, it } from 'vitest';
import {
  SHOW_DIRECTOR_SHOTS,
  directorShotAt,
  effectiveCameraMode,
} from '@/lib/show/showDirector';
import { computeCameraPose, DRONE_UP_M, CAMERA_MODES } from '@/lib/cesiumCameras';

const total = SHOW_DIRECTOR_SHOTS.reduce((s, x) => s + x.durationMs, 0);

describe('directorShotAt', () => {
  it('opens on the chase camera', () => {
    expect(directorShotAt(0)).toBe('chase');
  });

  it('walks the schedule shot by shot', () => {
    let t = 0;
    for (const shot of SHOW_DIRECTOR_SHOTS) {
      expect(directorShotAt(t)).toBe(shot.mode);
      expect(directorShotAt(t + shot.durationMs - 1)).toBe(shot.mode);
      t += shot.durationMs;
    }
  });

  it('loops after the last shot', () => {
    expect(directorShotAt(total)).toBe(SHOW_DIRECTOR_SHOTS[0].mode);
    expect(directorShotAt(total + SHOW_DIRECTOR_SHOTS[0].durationMs)).toBe(
      SHOW_DIRECTOR_SHOTS[1].mode,
    );
  });

  it('falls back safely on bad input', () => {
    expect(directorShotAt(-5)).toBe('chase');
    expect(directorShotAt(Number.NaN)).toBe('chase');
    expect(directorShotAt(1000, [])).toBe('chase');
  });

  it('holds every shot long enough to be calm (>= 20 s) and avoids road-height cameras', () => {
    for (const shot of SHOW_DIRECTOR_SHOTS) {
      expect(shot.durationMs).toBeGreaterThanOrEqual(20_000);
      expect(['firstPerson', 'sideTracking']).not.toContain(shot.mode);
    }
  });
});

describe('effectiveCameraMode', () => {
  const on = { active: true, autoCamera: true, startedAtMs: 1_000 };

  it("uses the rider's camera outside show mode", () => {
    expect(effectiveCameraMode('overhead', { ...on, active: false }, 50_000)).toBe('overhead');
  });

  it("uses the rider's camera once they take over", () => {
    expect(effectiveCameraMode('overhead', { ...on, autoCamera: false }, 50_000)).toBe('overhead');
  });

  it('directs from when show mode started', () => {
    const second = SHOW_DIRECTOR_SHOTS[1];
    const at = 1_000 + SHOW_DIRECTOR_SHOTS[0].durationMs + 10;
    expect(effectiveCameraMode('overhead', on, at)).toBe(second.mode);
  });

  it('ignores a missing start time', () => {
    expect(effectiveCameraMode('firstPerson', { ...on, startedAtMs: null }, 9_000)).toBe('firstPerson');
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
