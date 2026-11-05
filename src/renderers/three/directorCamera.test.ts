import { describe, expect, it } from 'vitest';
import { chaseFraming } from '@/lib/world/cameraFraming';
import { createProjection, type ProjectionParams } from '@/lib/world/projection';
import type { Route, RoutePoint } from '@/types';
import type { RigInput } from './chaseRig';
import {
  applyHudLensShift,
  bearingXZ,
  blendTargets,
  hudCoveredPx,
  ORBIT_SHOT,
  SIDE_DOLLY,
  sceneLandmarks,
  shotTarget,
  type ShotContext,
  type ViewOffsetCamera,
} from './directorCamera';
import { syntheticSceneWorld } from './syntheticWorld';

// Rider at the origin heading north (three.js: -z), the route straight on.
const input: RigInput = {
  rider: { x: 0, y: 100, z: 0 },
  heading: 0,
  ahead: { x: 0, y: 100, z: -14 },
  speed: 8,
  cadence: 85,
  timeS: 10,
};
const ctx = (over: Partial<ShotContext> = {}): ShotContext => ({
  framing: chaseFraming('standard'),
  distance: 'standard',
  shotT: 0,
  poi: null,
  poiBearing: null,
  ...over,
});
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

describe('director shots in the world renderer', () => {
  it('side dolly: beside the road, sliding from behind the rider to ahead of them', () => {
    const start = shotTarget('side', input, ctx({ shotT: 0 }));
    const end = shotTarget('side', input, ctx({ shotT: SIDE_DOLLY.overS }));
    // Beside: SIDE_DOLLY.outM to the right of travel (east, +x, when heading north).
    expect(start.position.x).toBeCloseTo(SIDE_DOLLY.outM, 5);
    expect(start.position.z).toBeGreaterThan(0); // behind (south)
    expect(end.position.z).toBeLessThan(0); // ahead (north)
    expect(start.position.y).toBeCloseTo(100 + SIDE_DOLLY.upM, 5);
  });

  it('front: on the route ahead, looking back at the rider', () => {
    const t = shotTarget('front', input, ctx());
    expect(t.position.z).toBeLessThan(-10);
    expect(t.look.z).toBeCloseTo(0, 5);
  });

  it('orbit: a constant radius round the rider, the landmark behind them mid-shot', () => {
    const poi = { x: 0, y: 100, z: -300 }; // due north
    const c = ctx({ poi, poiBearing: bearingXZ(input.rider, poi) });
    for (const t of [0, 6, 12, 20, 30]) {
      const s = shotTarget('orbit', input, { ...c, shotT: t });
      expect(dist(s.position, input.rider)).toBeCloseTo(ORBIT_SHOT.radiusM, 5);
      expect(s.position.y).toBeCloseTo(100 + ORBIT_SHOT.upM, 5);
    }
    // Mid-shot the camera is on the far side from the landmark (south), so the place is in view behind the rider.
    const mid = shotTarget('orbit', input, { ...c, shotT: ORBIT_SHOT.midS });
    expect(mid.position.z).toBeGreaterThan(ORBIT_SHOT.radiusM * 0.99);
    // It moves: a true orbit, not a still.
    const later = shotTarget('orbit', input, { ...c, shotT: ORBIT_SHOT.midS + 10 });
    expect(dist(mid.position, later.position)).toBeGreaterThan(5);
  });

  it('bearingXZ is a compass bearing (north 0, east π/2)', () => {
    expect(bearingXZ({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -10 })).toBeCloseTo(0, 6);
    expect(bearingXZ({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 })).toBeCloseTo(Math.PI / 2, 6);
  });

  it('blends position and aim linearly by the (already eased) factor', () => {
    const a = { position: { x: 0, y: 0, z: 0 }, look: { x: 0, y: 0, z: -1 } };
    const b = { position: { x: 10, y: 20, z: 30 }, look: { x: 1, y: 1, z: 1 } };
    expect(blendTargets(a, b, 0)).toEqual(a);
    expect(blendTargets(a, b, 1)).toEqual(b);
    expect(blendTargets(a, b, 0.5).position).toEqual({ x: 5, y: 10, z: 15 });
    expect(blendTargets(a, b, 2)).toEqual(b);
  });
});

class FakeCamera implements ViewOffsetCamera {
  view: ViewOffsetCamera['view'] = null;
  sets = 0;
  setViewOffset(fullWidth: number, fullHeight: number, x: number, y: number, width: number, height: number) {
    this.sets += 1;
    this.view = { enabled: true, fullWidth, fullHeight, offsetX: x, offsetY: y, width, height };
  }
  clearViewOffset() {
    if (this.view) this.view.enabled = false;
  }
}

describe('HUD lens shift (the floating window frames the rider above its bar)', () => {
  it('shifts the lens by half the covered height, once per size', () => {
    const cam = new FakeCamera();
    applyHudLensShift(cam, 480, 270, 78);
    expect(cam.view).toMatchObject({ enabled: true, fullWidth: 480, fullHeight: 270, offsetX: 0, offsetY: 39, width: 480, height: 270 });
    applyHudLensShift(cam, 480, 270, 78);
    expect(cam.sets).toBe(1);
    applyHudLensShift(cam, 640, 360, 86);
    expect(cam.view).toMatchObject({ fullWidth: 640, fullHeight: 360, offsetY: 43 });
  });

  it('never shifts more than a quarter of the view, and clears with no HUD', () => {
    const cam = new FakeCamera();
    applyHudLensShift(cam, 480, 270, 400);
    expect(cam.view?.offsetY).toBe(Math.round(270 / 4));
    applyHudLensShift(cam, 480, 270, 0);
    expect(cam.view?.enabled).toBe(false);
  });

  it('reads the covered height from the nearest data-hud-bottom ancestor', () => {
    const at = (v: string | undefined) => ({ closest: () => (v === undefined ? null : ({ dataset: { hudBottom: v } } as unknown as Element)) });
    expect(hudCoveredPx(at('78'))).toBe(78);
    expect(hudCoveredPx(at(undefined))).toBe(0);
    expect(hudCoveredPx(at('junk'))).toBe(0);
    expect(hudCoveredPx(at('-4'))).toBe(0);
    expect(hudCoveredPx({})).toBe(0);
  });
});

describe('sceneLandmarks: what the director can orbit', () => {
  // Review of PR #36 @bbe04db, I4: sceneLandmarks returning [] left every test green.
  const params: ProjectionParams = { type: 'tmerc', ellipsoid: 'WGS84', lat0: 43.1107, lon0: 12.3908, k0: 1 };
  const proj = createProjection(params);
  const sw = syntheticSceneWorld();
  const manifest = sw.world.manifest as unknown as Record<string, unknown>;
  manifest.projection = params;
  manifest.pois = [
    { name: 'Rivotorto', kind: 'village', x: 0, y: 60, h: 0, osm: 'node/1' },
    { name: 'Same stop, further off', kind: 'village', x: 20, y: 190, h: 0, osm: 'node/2' },
  ];
  // A straight route west to east along y = 0, a point every 10 m.
  const points: RoutePoint[] = Array.from({ length: 61 }, (_, i) => {
    const [lat, lon] = proj.inverse(-300 + i * 10, 0);
    return { lat, lon, ele: 0, distance: i * 10 } as RoutePoint;
  });
  const route = { id: 'synthetic-line', name: 'Line', points, totalDistance: 600 } as Route;

  it('places the manifest POIs the route passes, 10 m above the ground, in three.js coordinates', () => {
    const lms = sceneLandmarks(route, sw);
    expect(lms.map((l) => l.name)).toEqual(['Rivotorto']);
    const [l] = lms;
    expect(l.distance).toBeCloseTo(300, 0);
    expect(l.offset).toBeCloseTo(60, 0);
    expect(l.position.x).toBeCloseTo(0, 6);
    expect(l.position.z).toBeCloseTo(-60, 6);
    expect(l.position.y).toBeCloseTo(sw.heightfield.sampleHeight(0, 60) + 10, 6);
  });

  it('none for a live route or no route', () => {
    expect(sceneLandmarks({ ...route, isLive: true }, sw)).toEqual([]);
    expect(sceneLandmarks(null, sw)).toEqual([]);
  });
});
