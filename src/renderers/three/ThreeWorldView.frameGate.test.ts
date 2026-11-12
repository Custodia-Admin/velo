/**
 * ThreeWorldView draws every frame through the frame gate (card t_946833f0),
 * without a WebGL context: the draw components run as plain functions (React's
 * hooks once, r3f's useFrame callbacks captured with their priority, useThree
 * reading a fake root state) against a fake GPU whose fences signal only when
 * it finishes a frame. WorldScene's element tree is walked, not rendered.
 *
 * Pins: r3f's own render is off (priority 1) and the one draw goes through the
 * gate, plain or post-processed; a frame the GPU has no room for draws nothing;
 * the perf meter counts drawn frames; the ready signal waits for drawn frames.
 */
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  frames: [] as Array<{ cb: (state: unknown, delta: number) => void; priority: number }>,
  cleanups: [] as Array<() => void>,
  root: null as unknown,
  composerRender: [] as number[],
  onComposerRender: () => undefined as void,
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
  useFrame: (cb: (state: unknown, delta: number) => void, priority = 0) => {
    h.frames.push({ cb, priority });
  },
  useThree: (sel?: (s: unknown) => unknown) => (sel ? sel(h.root) : h.root),
}));

// The composer needs a real WebGL renderer; only what PostFx calls on it is under test.
vi.mock('postprocessing', () => {
  class Inert {}
  class EffectComposer {
    addPass() {}
    setSize() {}
    dispose() {}
    render(delta: number) {
      h.composerRender.push(delta);
      // The composer's passes are this frame's GPU work.
      h.onComposerRender();
    }
  }
  return {
    EffectComposer,
    BloomEffect: Inert,
    EffectPass: Inert,
    RenderPass: Inert,
    SMAAEffect: Inert,
    ToneMappingEffect: Inert,
    VignetteEffect: Inert,
    ToneMappingMode: { ACES_FILMIC: 1 },
  };
});

vi.mock('./Rider', () => ({
  LiveRider: function LiveRider() {
    return null;
  },
  PaceBots: function PaceBots() {
    return null;
  },
  preloadRider: () => undefined,
}));
vi.mock('./landcoverTexture', () => ({ buildLandcoverCanvas: () => null }));

import type { RiderPose } from '@/lib/world/renderer';
import { IDLE_GAP_MS } from '@/lib/perf/scenePerf';
import type { Route } from '@/types';
import { FrameGate, type FenceGL } from './frameGate';
import { threeQuality } from './quality';
import { syntheticSceneWorld } from './syntheticWorld';
import { PostFx, ReadySignal, SceneDraw, WorldScene } from './ThreeWorldView';

const TIMEOUT_EXPIRED = 0x911b;

/** A WebGL 2 context whose GPU finishes frames only when told to. */
function fakeGpu() {
  let queued = 0;
  let finished = 0;
  const gl: FenceGL = {
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    TIMEOUT_EXPIRED,
    fenceSync: () => ({ frame: queued - 1 }) as unknown as WebGLSync,
    clientWaitSync: (s) => ((s as unknown as { frame: number }).frame < finished ? 0x911a : TIMEOUT_EXPIRED),
    deleteSync: () => undefined,
  };
  return {
    gl,
    queued: () => queued,
    drew: () => {
      queued++;
    },
    finishAll: () => {
      finished = queued;
    },
  };
}

/** The r3f root state the draw components read: a renderer on the fake GPU. */
function root(gpu: ReturnType<typeof fakeGpu>) {
  const renders: Array<[unknown, unknown]> = [];
  const state = {
    scene: { isScene: true },
    camera: { isCamera: true },
    size: { width: 1920, height: 1080 },
    gl: {
      toneMapping: 0,
      getContext: () => gpu.gl,
      render: (scene: unknown, camera: unknown) => {
        renders.push([scene, camera]);
        gpu.drew();
      },
    },
  };
  h.root = state;
  return { state, renders };
}

const meterSpy = () => ({ push: vi.fn<(ms: number) => void>() });

/** Runs the captured useFrame callbacks in r3f's order (lowest priority first). */
function frame(state: unknown, deltaS: number) {
  for (const f of [...h.frames].sort((a, b) => a.priority - b.priority)) f.cb(state, deltaS);
}

afterEach(() => {
  for (const c of h.cleanups.splice(0)) c();
  h.frames.length = 0;
  h.composerRender.length = 0;
});

describe('SceneDraw: the one place a frame is drawn', () => {
  it("takes over r3f's render (priority 1) and draws every frame while the GPU keeps up", () => {
    const gpu = fakeGpu();
    const { state, renders } = root(gpu);
    const gate = new FrameGate();
    const meter = meterSpy();
    SceneDraw({ gate, meter: meter as never });
    expect(h.frames.map((f) => f.priority)).toEqual([1]);
    for (let i = 0; i < 30; i++) {
      frame(state, 1 / 60);
      gpu.finishAll();
    }
    expect(renders).toHaveLength(30);
    expect(renders[0]).toEqual([state.scene, state.camera]);
    expect([gate.drawn, gate.held]).toEqual([30, 0]);
  });

  it('draws nothing while two frames are still queued on the GPU, then the latest frame', () => {
    const gpu = fakeGpu();
    const { state, renders } = root(gpu);
    const gate = new FrameGate();
    SceneDraw({ gate, meter: meterSpy() as never });
    for (let i = 0; i < 60; i++) frame(state, 1 / 60);
    // A GPU that never caught up: two frames went in, 58 were held back.
    expect(renders).toHaveLength(2);
    expect(gpu.queued()).toBe(2);
    expect(gate.held).toBe(58);
    gpu.finishAll();
    frame(state, 1 / 60);
    expect(renders).toHaveLength(3);
  });

  it('feeds the meter the time between DRAWN frames, and leaves a stalled loop out', () => {
    const gpu = fakeGpu();
    const { state } = root(gpu);
    const gate = new FrameGate();
    const meter = meterSpy();
    SceneDraw({ gate, meter: meter as never });
    frame(state, 0.016); // drawn: 16 ms
    frame(state, 0.016); // drawn: 16 ms (2 in flight now)
    frame(state, 0.016); // held
    frame(state, 0.016); // held
    gpu.finishAll();
    frame(state, 0.016); // drawn: 48 ms since the last drawn frame
    expect(meter.push.mock.calls.map(([ms]) => Math.round(ms))).toEqual([16, 16, 48]);
    // A hidden tab: one long gap is not frame time.
    gpu.finishAll();
    frame(state, (IDLE_GAP_MS + 100) / 1000);
    gpu.finishAll();
    frame(state, 0.02);
    expect(meter.push.mock.calls.slice(3).map(([ms]) => Math.round(ms))).toEqual([0, 20]);
  });

  it('PostFx draws through the same gate: the composer renders only when the GPU has room', () => {
    const gpu = fakeGpu();
    const { state } = root(gpu);
    const gate = new FrameGate();
    h.onComposerRender = gpu.drew;
    PostFx({ gate, meter: meterSpy() as never });
    expect(h.frames.map((f) => f.priority)).toEqual([1]);
    for (let i = 0; i < 10; i++) frame(state, 1 / 60);
    expect(h.composerRender).toHaveLength(2);
    expect(gate.held).toBe(8);
    gpu.finishAll();
    frame(state, 1 / 60);
    expect(h.composerRender).toHaveLength(3);
    // It gets the time since the last frame it drew (9 rAFs).
    expect(h.composerRender[2]).toBeCloseTo(9 / 60, 6);
  });
});

describe('ReadySignal waits for drawn frames', () => {
  it('fires after two frames drawn since it mounted, not after two held ones', () => {
    const gpu = fakeGpu();
    const { state } = root(gpu);
    const gate = new FrameGate();
    SceneDraw({ gate, meter: meterSpy() as never });
    // The GPU is already two frames behind when the rider model comes in.
    frame(state, 1 / 60);
    frame(state, 1 / 60);
    const onReady = vi.fn();
    ReadySignal({ onReady, gate });
    for (let i = 0; i < 10; i++) frame(state, 1 / 60);
    expect(onReady).not.toHaveBeenCalled();
    gpu.finishAll();
    frame(state, 1 / 60); // one drawn
    gpu.finishAll();
    frame(state, 1 / 60); // two drawn
    expect(onReady).not.toHaveBeenCalled();
    frame(state, 1 / 60); // seen at the start of the next frame
    expect(onReady).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) frame(state, 1 / 60);
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});

describe('WorldScene: one gate per canvas', () => {
  const sw = syntheticSceneWorld();
  const route = (): Route => {
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
    } as Route;
  };
  const walk = (node: ReactNode, out: ReactElement<Record<string, unknown>>[] = []) => {
    if (Array.isArray(node)) for (const n of node) walk(n, out);
    else if (isValidElement(node)) {
      out.push(node as ReactElement<Record<string, unknown>>);
      walk((node.props as { children?: ReactNode }).children, out);
    }
    return out;
  };
  const scene = (tier: 'medium' | 'high') =>
    walk(
      WorldScene({
        sceneWorld: sw,
        route: route(),
        quality: { ...threeQuality(tier), occlusionScale: 0 },
        tier,
        lightInput: { mood: 'clear-afternoon', live: null, liveWeather: false } as never,
        override: { current: null as RiderPose | null },
        groundReady: { current: () => true },
        onReady: () => undefined,
        onDpr: () => undefined,
      }),
    );

  it.each([
    ['medium', SceneDraw, PostFx],
    ['high', PostFx, SceneDraw],
  ] as const)('%s: one draw component, and every part that reads frames shares its gate and meter', (tier, drawer, other) => {
    const els = scene(tier);
    const draws = els.filter((e) => e.type === drawer);
    expect(draws).toHaveLength(1);
    expect(els.filter((e) => e.type === other)).toHaveLength(0);
    const gate = draws[0].props.gate;
    expect(gate).toBeInstanceOf(FrameGate);
    const withGate = els.filter((e) => 'gate' in e.props);
    // The draw, the ready signal and the debug hook (frameGate counters in __veloRideDebug).
    expect(withGate).toHaveLength(3);
    expect(withGate.some((e) => e.type === ReadySignal)).toBe(true);
    for (const e of withGate) expect(e.props.gate).toBe(gate);
    const withMeter = els.filter((e) => 'meter' in e.props);
    expect(withMeter).toHaveLength(2);
    expect(withMeter[0].props.meter).toBe(withMeter[1].props.meter);
  });
});
