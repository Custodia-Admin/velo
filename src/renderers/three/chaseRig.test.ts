import { describe, expect, it } from 'vitest';

import { CHASE_FRAMING, chaseFraming } from '@/lib/world/cameraFraming';
import {
  CameraRig,
  MIN_CLEARANCE_M,
  SNAP_DISTANCE_M,
  cameraTarget,
  dampFactor,
  forwardXZ,
  type CameraTarget,
  type RigInput,
} from './chaseRig';

const input = (over: Partial<RigInput> = {}): RigInput => ({
  rider: { x: 100, y: 200, z: -50 },
  heading: 0,
  ahead: { x: 100, y: 200, z: -64 },
  speed: 8,
  cadence: 85,
  timeS: 3,
  ...over,
});

const target = (x: number, y = 10, z = 0): CameraTarget => ({
  position: { x, y, z },
  look: { x: x + 10, y: 0, z },
});

describe('chase camera smoothing', () => {
  it('damping is frame-rate independent: 60 fps and 30 fps land in the same place after 1 s', () => {
    const run = (fps: number) => {
      const rig = new CameraRig();
      rig.update('chase', target(0), 1 / fps);
      for (let i = 0; i < fps; i++) rig.update('chase', target(10), 1 / fps);
      return rig.position.x;
    };
    expect(run(60)).toBeCloseTo(run(30), 6);
    expect(run(60)).toBeCloseTo(run(144), 6);
  });

  it('eases toward a moving target without overshoot and converges', () => {
    const rig = new CameraRig();
    rig.update('chase', target(0), 1 / 60);
    let prev = 0;
    for (let i = 0; i < 120; i++) {
      rig.update('chase', target(5), 1 / 60);
      expect(rig.position.x).toBeGreaterThanOrEqual(prev);
      expect(rig.position.x).toBeLessThanOrEqual(5);
      prev = rig.position.x;
    }
    expect(rig.position.x).toBeGreaterThan(4.99);
    // After one 1/60 s frame it has moved only part of the way (smooth, not snapped).
    const fresh = new CameraRig();
    fresh.update('chase', target(0), 1 / 60);
    fresh.update('chase', target(5), 1 / 60);
    expect(fresh.position.x).toBeGreaterThan(0);
    expect(fresh.position.x).toBeLessThan(1);
  });

  it('cuts straight to the target on the first frame and on a teleport', () => {
    const rig = new CameraRig();
    rig.update('chase', target(42), 1 / 60);
    expect(rig.position.x).toBe(42);
    rig.update('chase', target(42 + SNAP_DISTANCE_M + 5), 1 / 60);
    expect(rig.position.x).toBe(42 + SNAP_DISTANCE_M + 5);
  });

  it('glides (no cut) when the camera mode changes, even across a long distance', () => {
    const rig = new CameraRig();
    rig.update('chase', target(0), 1 / 60);
    rig.update('drone', target(150), 1 / 60);
    expect(rig.position.x).toBeGreaterThan(0);
    expect(rig.position.x).toBeLessThan(10);
  });

  it('never goes under the ground plus clearance', () => {
    const rig = new CameraRig();
    rig.update('chase', target(0, -5), 1 / 60, () => 3);
    expect(rig.position.y).toBe(3 + MIN_CLEARANCE_M);
  });

  it('dampFactor: 0 for no time, 1 for no lag', () => {
    expect(dampFactor(0.3, 0)).toBe(0);
    expect(dampFactor(0, 1 / 60)).toBe(1);
    expect(dampFactor(0.3, 0.3)).toBeCloseTo(1 - Math.exp(-1));
  });
});

describe('camera targets per mode', () => {
  it('chase sits back and up from the rider per the distance setting, aimed ahead', () => {
    const f = chaseFraming('standard');
    const t = cameraTarget('chase', input(), f, 'standard');
    // Heading 0 = north = −z: behind is +z.
    expect(t.position.x).toBeCloseTo(100);
    expect(t.position.z).toBeCloseTo(-50 + f.backM);
    expect(t.position.y).toBeCloseTo(200 + f.upM);
    expect(t.look.z).toBeCloseTo(-64);
    expect(t.look.y).toBeCloseTo(201);
  });

  it("'standard' is close and low (owner): rider prominent, road 10–20 m ahead", () => {
    const s = CHASE_FRAMING.standard;
    expect(s.backM).toBeLessThanOrEqual(8);
    expect(s.upM).toBeLessThanOrEqual(3);
    expect(s.lookAheadM).toBeGreaterThanOrEqual(10);
    expect(s.lookAheadM).toBeLessThanOrEqual(20);
    expect(chaseFraming(undefined)).toBe(s);
  });

  it('follows the heading: east-bound rider gets the camera to the west', () => {
    const t = cameraTarget('chase', input({ heading: Math.PI / 2 }), chaseFraming('standard'), 'standard');
    expect(t.position.x).toBeLessThan(100);
    expect(t.position.z).toBeCloseTo(-50);
    const [fx, fz] = forwardXZ(Math.PI / 2);
    expect(fx).toBeCloseTo(1);
    expect(fz).toBeCloseTo(0);
  });

  it('first person sits at eye height just ahead of the hips; drone is high and far', () => {
    const fp = cameraTarget('firstPerson', input(), chaseFraming('standard'), 'standard');
    expect(fp.position.y - 200).toBeGreaterThan(1.1);
    expect(fp.position.y - 200).toBeLessThan(1.4);
    const drone = cameraTarget('drone', input(), chaseFraming('standard'), 'standard');
    expect(drone.position.y - 200).toBe(60);
  });
});
