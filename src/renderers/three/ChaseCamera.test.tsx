import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import { useThree } from '@react-three/fiber';
import type * as THREE from 'three';

import { activeSteer, useControllerStore } from '@/stores/controllerStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useShowStore } from '@/stores/showStore';
import { resetShowDirector, showDirectorFrame } from '@/lib/show/showDirector';
import { chaseFraming } from '@/lib/world/cameraFraming';
import type { DirectorFrame } from '@/lib/world/director';
import type { SceneLandmark } from './directorCamera';
import { ChaseCamera } from './ChaseCamera';
import { CameraRig, MIN_CLEARANCE_M } from './chaseRig';
import { syntheticSceneWorld } from './syntheticWorld';
import { createRideFrame, type RideFrame } from './worldScene';

// The real director, watched: what the camera feeds it and what it answers.
vi.mock('@/lib/show/showDirector', async (orig) => {
  const m = await orig<typeof import('@/lib/show/showDirector')>();
  return { ...m, showDirectorFrame: vi.fn(m.showDirectorFrame) };
});

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

  it('moves with the rider (no speed lag) and smooths only a change of heading', async () => {
    const frame = frameAt(0, 0);
    const rig = new CameraRig();
    const r = await ReactThreeTestRenderer.create(
      <>
        <GrabCamera />
        <ChaseCamera frame={frame} heightfield={sw.heightfield} rig={rig} />
      </>,
    );
    await r.advanceFrames(1, 1 / 60);
    const f = chaseFraming('standard');
    // Rider moves 10 m north in one step: the framing holds exactly.
    Object.assign(frame, frameAt(0, -10));
    await r.advanceFrames(1, 1 / 60);
    expect(camera!.position.z).toBeCloseTo(-10 + f.backM, 3);
    expect(camera!.position.x).toBeCloseTo(0, 3);
    // Rider turns east: the camera swings round behind it smoothly, then settles.
    Object.assign(frame, frameAt(0, -10, Math.PI / 2));
    await r.advanceFrames(1, 1 / 60);
    expect(camera!.position.x).toBeGreaterThan(-1);
    expect(camera!.position.z).toBeGreaterThan(-10 + 1);
    await r.advanceFrames(120, 1 / 60);
    expect(camera!.position.x).toBeCloseTo(-f.backM, 1);
    expect(camera!.position.z).toBeCloseTo(-10, 1);
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

  it('keeps clear of the drawn ground it is given (world y north = three.js −z), not of the heightfield', async () => {
    const frame = frameAt(0, 0);
    const riderY = frame.placement!.position.y;
    // A drawn bank behind the rider only (south: world y < 0, three.js z > 0), 40 m over the rider.
    const ground = (_x: number, y: number) => (y < -1 ? riderY + 40 : riderY);
    const r = await ReactThreeTestRenderer.create(
      <>
        <GrabCamera />
        <ChaseCamera frame={frame} heightfield={sw.heightfield} ground={ground} />
      </>,
    );
    await r.advanceFrames(1, 1 / 60);
    expect(camera!.position.z).toBeGreaterThan(1);
    expect(camera!.position.y).toBeGreaterThanOrEqual(riderY + 40 + MIN_CLEARANCE_M - 1e-6);
    await r.unmount();
    // The same bank ahead of the rider (north) leaves the camera at its usual height behind.
    const ahead = (_x: number, y: number) => (y > 1 ? riderY + 40 : riderY);
    const r2 = await ReactThreeTestRenderer.create(
      <>
        <GrabCamera />
        <ChaseCamera frame={frameAt(0, 0)} heightfield={sw.heightfield} ground={ahead} />
      </>,
    );
    await r2.advanceFrames(1, 1 / 60);
    expect(camera!.position.y).toBeLessThan(riderY + 10);
    await r2.unmount();
  });
});

describe('<ChaseCamera> feeds the show director the ride it films', () => {
  // Review of PR #36 @bbe04db, I1/I3: the director's steering hold and its
  // landmark orbits were pinned only on the pure Director; the camera could
  // have fed it no steering and no landmarks and every test stayed green.
  const landmarks: SceneLandmark[] = [{ name: 'Rivotorto', distance: 150, offset: 40, position: { x: 40, y: 20, z: -150 } }];
  const director = vi.mocked(showDirectorFrame);

  afterEach(() => {
    vi.restoreAllMocks();
    director.mockClear();
    resetShowDirector();
    useShowStore.setState({ active: false, autoCamera: true, startedAtMs: null });
    useControllerStore.setState({ status: 'idle', steer: 0 });
  });

  it("passes the route's landmarks and the rider's steering; steering holds the shot", async () => {
    let now = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    useShowStore.setState({ active: true, autoCamera: true, startedAtMs: now });
    useControllerStore.setState({ status: 'connected', steeringEnabled: true, steer: 0.8 });
    expect(activeSteer()).toBeGreaterThan(0.1);

    director.mockClear();
    const frame = frameAt(0, 0);
    const r = await ReactThreeTestRenderer.create(<ChaseCamera frame={frame} heightfield={sw.heightfield} landmarks={landmarks} />);
    /** Ride `seconds` north at 8 m/s, 20 frames a second. */
    const ride = async (seconds: number) => {
      for (let i = 0; i < seconds * 20; i++) {
        now += 50;
        frame.pose!.distance += 0.4;
        await r.advanceFrames(1, 0.05);
      }
    };
    const cutsSince = (from: number) =>
      new Set(director.mock.results.slice(from).map((x) => (x.value as DirectorFrame | null)?.cutAt ?? null)).size;

    // A minute of steering: the director is told, and holds the opening shot (no cut).
    await ride(60);
    const [, fed, , lms] = director.mock.calls.at(-1)!;
    expect(fed.steer).toBe(activeSteer());
    expect(lms).toBe(landmarks);
    expect(cutsSince(0)).toBe(1);

    // Hands off the bars: the director cuts again (every 20-40 s, after the settle).
    useControllerStore.setState({ steer: 0 });
    const from = director.mock.results.length;
    await ride(60);
    expect(director.mock.calls.at(-1)![1].steer).toBe(0);
    expect(cutsSince(from)).toBeGreaterThan(1);
    await r.unmount();
  });
});

describe('<ChaseCamera> keeps above the drawn ground (PR #34) with and without the director', () => {
  // A drawn surface 30 m above the heightfield under the camera (a viaduct, a
  // photoreal-style mesh): the camera must clear it in the rider's own camera
  // AND in every director shot. Merging #34 into #36 touched both branches.
  const RAISE_M = 30;
  const ground = (x: number, y: number) => sw.heightfield.sampleHeight(x, y) + RAISE_M;

  afterEach(() => {
    vi.restoreAllMocks();
    resetShowDirector();
    useShowStore.setState({ active: false, autoCamera: true, startedAtMs: null });
    camera = null;
  });

  for (const directed of [false, true]) {
    it(directed ? "the director's shots clear the drawn ground" : "the rider's own camera clears the drawn ground", async () => {
      let now = 10_000;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      if (directed) useShowStore.setState({ active: true, autoCamera: true, startedAtMs: now });
      const frame = frameAt(0, 0);
      const r = await ReactThreeTestRenderer.create(
        <>
          <GrabCamera />
          <ChaseCamera frame={frame} heightfield={sw.heightfield} ground={ground} />
        </>,
      );
      for (let i = 0; i < 120; i++) {
        now += 50;
        frame.pose!.distance += 0.4;
        await r.advanceFrames(1, 0.05);
      }
      if (directed) expect(vi.mocked(showDirectorFrame).mock.results.at(-1)?.value).not.toBeNull();
      const p = camera!.position;
      // three.js z is world -y: the drawn ground is sampled at (x, -z).
      expect(p.y).toBeGreaterThanOrEqual(ground(p.x, -p.z));
      await r.unmount();
    });
  }
});
