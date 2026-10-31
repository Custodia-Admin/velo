import { describe, expect, it, beforeEach } from 'vitest';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import { useThree } from '@react-three/fiber';
import type * as THREE from 'three';

import { useSettingsStore } from '@/stores/settingsStore';
import { useShowStore } from '@/stores/showStore';
import { chaseFraming } from '@/lib/world/cameraFraming';
import { ChaseCamera } from './ChaseCamera';
import { CameraRig } from './chaseRig';
import { syntheticSceneWorld } from './syntheticWorld';
import { createRideFrame, type RideFrame } from './worldScene';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sw = syntheticSceneWorld();

function frameAt(x: number, z: number, heading = 0): RideFrame {
  const f = createRideFrame();
  const y = sw.heightfield.sampleHeight(x, -z);
  f.valid = true;
  f.pose = { lat: 0, lon: 0, ele: y, heading, grade: 0, speed: 8, distance: 0, laneOffsetM: 0 };
  f.placement = { position: { x, y, z }, worldX: x, worldY: -z, heading, pitch: 0 };
  f.ahead = { x: x + Math.sin(heading) * 14, y, z: z - Math.cos(heading) * 14 };
  f.dt = 1 / 60;
  f.speed = 8;
  return f;
}

let camera: THREE.Camera | null = null;
function GrabCamera() {
  camera = useThree((s) => s.camera);
  return null;
}

beforeEach(() => {
  useSettingsStore.setState({ cameraMode: 'chase', cameraDistance: 'standard' });
  useShowStore.setState({ active: false });
});

describe('<ChaseCamera> (r3f test renderer)', () => {
  it('puts the camera behind and above the rider and aims it down the road', async () => {
    const frame = frameAt(0, 0);
    const r = await ReactThreeTestRenderer.create(
      <>
        <GrabCamera />
        <ChaseCamera frame={frame} heightfield={sw.heightfield} />
      </>,
    );
    await r.advanceFrames(1, 1 / 60);
    const f = chaseFraming('standard');
    const cam = camera!;
    expect(cam.position.z).toBeCloseTo(f.backM, 3);
    expect(cam.position.y).toBeGreaterThan(frame.placement!.position.y + 1);
    const dir = cam.getWorldDirection(cam.position.clone());
    // Looking north (−z) and slightly down.
    expect(dir.z).toBeLessThan(-0.9);
    expect(dir.y).toBeLessThan(0);
    await r.unmount();
  });

  it('follows a moving rider smoothly: lags, then settles at the framing', async () => {
    const frame = frameAt(0, 0);
    const rig = new CameraRig();
    const r = await ReactThreeTestRenderer.create(
      <>
        <GrabCamera />
        <ChaseCamera frame={frame} heightfield={sw.heightfield} rig={rig} />
      </>,
    );
    await r.advanceFrames(1, 1 / 60);
    // Rider moves 10 m north in one step; the camera eases instead of jumping.
    Object.assign(frame, frameAt(0, -10));
    await r.advanceFrames(1, 1 / 60);
    const f = chaseFraming('standard');
    const settledZ = -10 + f.backM;
    expect(camera!.position.z).toBeGreaterThan(settledZ + 5);
    await r.advanceFrames(120, 1 / 60);
    expect(camera!.position.z).toBeCloseTo(settledZ, 1);
    await r.unmount();
  });

  it("uses the rider's camera-distance setting", async () => {
    useSettingsStore.setState({ cameraDistance: 'far' });
    const frame = frameAt(0, 0);
    const r = await ReactThreeTestRenderer.create(
      <>
        <GrabCamera />
        <ChaseCamera frame={frame} heightfield={sw.heightfield} />
      </>,
    );
    await r.advanceFrames(1, 1 / 60);
    expect(camera!.position.z).toBeCloseTo(chaseFraming('far').backM, 3);
    await r.unmount();
  });

  it('holds still until the ride frame is valid', async () => {
    const frame = createRideFrame();
    const r = await ReactThreeTestRenderer.create(
      <>
        <GrabCamera />
        <ChaseCamera frame={frame} heightfield={sw.heightfield} />
      </>,
    );
    const before = camera!.position.clone();
    await r.advanceFrames(3, 1 / 60);
    expect(camera!.position.equals(before)).toBe(true);
    await r.unmount();
  });
});
