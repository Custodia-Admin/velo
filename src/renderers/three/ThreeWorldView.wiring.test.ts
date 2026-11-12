/**
 * ThreeWorldView's wiring of the one drawn ground and the start hold, without
 * a WebGL context: WorldScene and RideDriver are called as plain functions
 * (React's hooks run once, r3f's useFrame callbacks are captured) and the
 * returned element tree is walked. Pins that the rider, the chase camera, the
 * pace bots and the ghosts all get the same drawn ground the terrain draws,
 * and that the start holds until the chunk under the rider shows its near LOD.
 */
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RiderPose } from '@/lib/world/renderer';
import type { Route } from '@/types';

const h = vi.hoisted(() => ({
  frames: [] as Array<(state: { clock: { elapsedTime: number } }, delta: number) => void>,
  cleanups: [] as Array<() => void>,
}));

vi.mock('react', async (orig) => {
  const react = await orig<typeof import('react')>();
  return {
    ...react,
    useMemo: <T,>(f: () => T) => f(),
    useCallback: <T,>(f: T) => f,
    useRef: <T,>(v: T) => ({ current: v }),
    useState: <T,>(v: T) => [v, () => undefined],
    useEffect: (fn: () => void | (() => void)) => {
      const c = fn();
      if (typeof c === 'function') h.cleanups.push(c);
    },
  };
});

vi.mock('@react-three/fiber', async (orig) => ({
  ...(await orig<typeof import('@react-three/fiber')>()),
  useFrame: (cb: (typeof h.frames)[number]) => {
    h.frames.push(cb);
  },
  useThree: () => ({}),
}));

// The rider model is a GLB the node test env can't fetch; the bots only need to be found in the tree.
vi.mock('./Rider', () => ({
  LiveRider: function LiveRider() {
    return null;
  },
  PaceBots: function PaceBots() {
    return null;
  },
  preloadRider: () => undefined,
}));

import { rideLineFor } from '@/lib/ride/rideLine';
import { useRideStore } from '@/stores/rideStore';
import { ChaseCamera } from './ChaseCamera';
import { CoupleGhost } from './CoupleGhost';
import { Ghosts } from './Ghosts';
import { Landmarks } from './Landmarks';
import { PlayLayer, type PostcardPins } from './PlayLayer';
import { threeQuality } from './quality';
import { PaceBots } from './Rider';
import { syntheticSceneWorld } from './syntheticWorld';
import { Terrain } from './Terrain';
import { lodHeightAt } from './terrainMesh';
import { RideDriver, WorldScene } from './ThreeWorldView';
import { worldRideLine } from './rideLineRoads';
import { createRideFrame, type ChunkVisibility, type RideFrame } from './worldScene';

const sw = syntheticSceneWorld();
const quality = threeQuality('medium');

function routeThrough(): Route {
  const [lat0, lon0] = sw.projection.inverse(-300, 0);
  const [lat1, lon1] = sw.projection.inverse(300, 0);
  return {
    id: 'synthetic',
    name: 'synthetic',
    points: [
      { lat: lat0, lon: lon0, ele: 0, distance: 0 },
      { lat: lat1, lon: lon1, ele: 0, distance: 600 },
    ],
    totalDistance: 600,
    ascent: 0,
    descent: 0,
    minElevation: 0,
    maxElevation: 0,
    loadedAt: 0,
  };
}

function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) for (const n of node) walk(n, out);
  else if (isValidElement(node)) {
    out.push(node);
    walk((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}

function scene() {
  const groundReady = { current: () => true };
  const els = walk(
    WorldScene({
      sceneWorld: sw,
      route: routeThrough(),
      quality,
      tier: 'medium',
      lightInput: { mood: 'clear-afternoon', live: null, liveWeather: false } as never,
      override: { current: null as RiderPose | null },
      groundReady,
      onReady: () => undefined,
      onDpr: () => undefined,
    }),
  );
  const one = (type: unknown) => {
    const found = els.filter((e) => e.type === type);
    expect(found).toHaveLength(1);
    return found[0].props as Record<string, unknown>;
  };
  return { els, one, groundReady };
}

afterEach(() => {
  for (const c of h.cleanups.splice(0)) c();
  h.frames.length = 0;
});

describe('ThreeWorldView: one drawn ground for everything that stands on it', () => {
  it('rider, chase camera, pace bots and ghosts all get the ground the terrain draws, at the LOD it shows', () => {
    const { one } = scene();
    const ground = one(RideDriver).ground as (x: number, y: number) => number;
    expect(typeof ground).toBe('function');
    expect(one(ChaseCamera).ground).toBe(ground);
    expect(one(PaceBots).ground).toBe(ground);
    expect(one(Ghosts).ground).toBe(ground);
    // The couple ghost stands on the same ground and fades against the same rider frame.
    expect(one(CoupleGhost).ground).toBe(ground);
    expect(one(CoupleGhost).frame).toBe(one(RideDriver).frame);

    // It is the terrain's own visibility: flip a chunk's LOD and the ground follows it.
    const visibility = one(Terrain).visibility as ChunkVisibility;
    const hf = sw.heightfield;
    let probe: [number, number] | null = null;
    for (let x = -350; x <= 350 && !probe; x += 7) {
      for (let y = -150; y <= 150 && !probe; y += 7) {
        const i = sw.locate(x, y);
        if (i >= 0 && Math.abs(lodHeightAt(hf, sw.chunks[i], quality.farStep, x, y) - hf.sampleHeight(x, y)) > 0.25) probe = [x, y];
      }
    }
    expect(probe).not.toBeNull();
    const [x, y] = probe!;
    const i = sw.locate(x, y);
    visibility.near[i] = 0;
    expect(ground(x, y)).toBeCloseTo(lodHeightAt(hf, sw.chunks[i], quality.farStep, x, y), 6);
    expect(Math.abs(ground(x, y) - hf.sampleHeight(x, y))).toBeGreaterThan(0.25);
    visibility.near[i] = 1;
    expect(ground(x, y)).toBeCloseTo(lodHeightAt(hf, sw.chunks[i], quality.nearStep, x, y), 6);
  });

  it('RideDriver places the rider and its look-ahead on the ground it is given', () => {
    const route = routeThrough();
    useRideStore.setState({ route, distance: 300, rideState: 'running', speed: 8 });
    const frame: RideFrame = createRideFrame();
    const ground = (_x: number, wy: number) => 500 + wy * 0.01;
    RideDriver({ sceneWorld: sw, frame, override: { current: null }, ground });
    expect(h.frames).toHaveLength(1);
    h.frames[0]({ clock: { elapsedTime: 1 } }, 1 / 60);
    expect(frame.valid).toBe(true);
    const p = frame.placement!;
    expect(p.position.y).toBeCloseTo(ground(p.worldX, p.worldY), 6);
    expect(frame.ahead.y).toBeCloseTo(ground(frame.ahead.x, -frame.ahead.z), 6);
    useRideStore.setState({ route: null, distance: 0, rideState: 'idle', speed: 0 });
  });
});

describe('ThreeWorldView: Play mode postcards are the places\' own pins', () => {
  it('the play layer and the pins share one postcard state, on the scene\'s route', () => {
    const { one } = scene();
    const pins = one(PlayLayer).pins as PostcardPins;
    expect(one(Landmarks).postcards).toBe(pins);
    expect((one(PlayLayer).route as Route).id).toBe('synthetic');
    expect(pins.pending(0)).toBe(false);
  });
});

describe('ThreeWorldView: the start holds until the chunk under the rider draws full detail', () => {
  it('groundReady follows the near LOD of the chunk under the rider', () => {
    const { one, groundReady } = scene();
    const frame = one(RideDriver).frame as RideFrame;
    const visibility = one(Terrain).visibility as ChunkVisibility;
    // No rider placed yet: hold.
    expect(groundReady.current()).toBe(false);
    frame.valid = true;
    frame.placement = { position: { x: 10, y: 0, z: -5 }, worldX: 10, worldY: 5, heading: 0, pitch: 0 };
    const i = sw.locate(10, 5);
    expect(i).toBeGreaterThanOrEqual(0);
    visibility.near[i] = 0;
    expect(groundReady.current()).toBe(false);
    visibility.near[i] = 1;
    expect(groundReady.current()).toBe(true);
    // Off the baked grid there is nothing to stream.
    frame.placement = { position: { x: 5000, y: 0, z: -5000 }, worldX: 5000, worldY: 5000, heading: 0, pitch: 0 };
    expect(groundReady.current()).toBe(true);
    // Leaving the scene never leaves a start held.
    frame.placement = { position: { x: 10, y: 0, z: -5 }, worldX: 10, worldY: 5, heading: 0, pitch: 0 };
    visibility.near[i] = 0;
    for (const c of h.cleanups.splice(0)) c();
    expect(groundReady.current()).toBe(true);
  });
});

describe("ThreeWorldView: the riders' line keeps to the roads the world paints", () => {
  it('the scene builds the drawn line with its ribbons before the first ride frame (rideLineRoads)', () => {
    const { one } = scene();
    const route = one(PlayLayer).route as Route;
    // RideDriver is only an element here (no frame has run): the line every rider reads
    // (rideLineFor, cached) was built by the scene itself, for this world's roads.
    expect(rideLineFor(route)).toBe(worldRideLine(route, sw));
  });
});
