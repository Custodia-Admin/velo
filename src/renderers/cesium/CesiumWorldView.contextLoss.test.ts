/**
 * The photoreal view after a lost WebGL context (card t_771036a6), without a
 * WebGL context or a real Cesium Viewer.
 *
 * Both components run as plain functions on a tiny hooks runtime (state, ref
 * and memo slots by call order; effects that re-run when their deps change,
 * cleanup first), zustand's React binding reads getState(), and the returned
 * element tree is walked, not rendered. `cesium` is the real module except
 * for `Viewer`, a fake whose canvas is a plain EventTarget; the helpers that
 * would touch a real scene are stubbed.
 *
 * Pins:
 * - CesiumWorldView owns the world-view slot while mounted. Its CesiumScene
 *   is keyed on the slot's canvas key, so a restore or the rider's tap
 *   remounts it on a new Viewer (a loss alone does not); the lost view is
 *   hidden; reports reach the slot even before the re-render that delivers
 *   the view id; leaving clears the slot.
 * - CesiumScene watches its viewer's canvas: the loss is cancelled (so the
 *   browser may restore it) and reported for this scene's canvas key, and so
 *   is the restore; the watch stops before the viewer is destroyed. Every
 *   mount hands a new WorldRenderer over `onReady`. A Viewer that can't be
 *   built leaves the view stopped, so the chip stays up for another tap.
 * - Cesium's own error panel is off (`showRenderLoopErrors: false`): it added
 *   a window 'resize' listener that only its OK button removed, which kept
 *   every dead viewer alive. A frame that throws (`scene.renderError`, the
 *   render loop stops) reads stopped like a lost context, so the chip shows
 *   and a tap builds a new Viewer; that watch stops before destroy too.
 */
import { isValidElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Fx = { deps?: readonly unknown[]; cleanup?: void | (() => void) };
interface Instance {
  slots: unknown[];
  effects: Array<Fx | undefined>;
  i: number;
  e: number;
  queue: Array<() => void>;
}

const rt = vi.hoisted(() => ({
  cur: null as unknown as Instance,
}));

/** A fake Cesium Viewer: what CesiumScene's bootstrap and cleanup touch. */
const fake = vi.hoisted(() => {
  /** Cesium's Event: addEventListener returns the remover; raise() calls every listener. */
  class FakeEvent {
    listeners: Array<(...args: unknown[]) => void> = [];
    addEventListener(fn: (...args: unknown[]) => void) {
      this.listeners.push(fn);
      return () => this.removeEventListener(fn);
    }
    removeEventListener(fn: (...args: unknown[]) => void) {
      const k = this.listeners.indexOf(fn);
      if (k >= 0) this.listeners.splice(k, 1);
      return k >= 0;
    }
    raise(...args: unknown[]) {
      for (const fn of [...this.listeners]) fn(...args);
    }
  }
  class FakeViewer {
    static built: FakeViewer[] = [];
    /** The options of every construction, including the ones that threw. */
    static optionsSeen: unknown[] = [];
    static failWith: Error | null = null;
    /** Called inside destroy(), before the viewer reads destroyed. */
    static onDestroy: ((v: FakeViewer) => void) | null = null;
    destroyed = false;
    destroyCalls = 0;
    canvas = { clientWidth: 960, clientHeight: 540 };
    camera = {};
    clock = {};
    terrainProvider = {};
    resolutionScale = 1;
    entities = { add: () => ({}), remove: () => true, contains: () => false };
    scene: Record<string, unknown> & { canvas: EventTarget; renderError: FakeEvent };
    constructor(
      public container: unknown,
      public options: unknown,
    ) {
      FakeViewer.optionsSeen.push(options);
      if (FakeViewer.failWith) throw FakeViewer.failWith;
      const event = () => ({ addEventListener: () => undefined, removeEventListener: () => undefined });
      this.scene = {
        canvas: new EventTarget(),
        preUpdate: event(),
        preRender: event(),
        postRender: event(),
        renderError: new FakeEvent(),
        globe: { show: true },
        skyAtmosphere: { show: false },
        fog: {},
        primitives: { add: () => undefined, remove: () => true },
        requestRender: () => undefined,
        context: {},
      };
      FakeViewer.built.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyCalls++;
      FakeViewer.onDestroy?.(this);
      this.destroyed = true;
    }
    resize() {}
  }
  return { FakeViewer };
});

const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
  !!a && !!b && a.length === b.length && a.every((v, k) => Object.is(v, b[k]));

vi.mock('react', async (orig) => {
  const react = await orig<typeof import('react')>();
  const hooks = {
    useState: <T,>(init: T | (() => T)) => {
      const r = rt.cur;
      const k = r.i++;
      if (!(k in r.slots)) r.slots[k] = typeof init === 'function' ? (init as () => T)() : init;
      const set = (v: T | ((p: T) => T)) => {
        r.slots[k] = typeof v === 'function' ? (v as (p: T) => T)(r.slots[k] as T) : v;
      };
      return [r.slots[k] as T, set] as const;
    },
    useRef: <T,>(current: T) => {
      const r = rt.cur;
      const k = r.i++;
      if (!(k in r.slots)) r.slots[k] = { current };
      return r.slots[k] as { current: T };
    },
    useMemo: <T,>(fn: () => T, deps?: readonly unknown[]) => {
      const r = rt.cur;
      const k = r.i++;
      const prev = r.slots[k] as { deps?: readonly unknown[]; value: T } | undefined;
      if (prev && same(prev.deps, deps)) return prev.value;
      const value = fn();
      r.slots[k] = { deps, value };
      return value;
    },
    useCallback: <T,>(fn: T, deps?: readonly unknown[]) => hooks.useMemo(() => fn, deps),
    useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
      const r = rt.cur;
      const k = r.e++;
      const prev = r.effects[k];
      if (prev && same(prev.deps, deps)) return;
      r.queue.push(() => {
        if (typeof prev?.cleanup === 'function') prev.cleanup();
        r.effects[k] = { deps, cleanup: fn() };
      });
    },
  };
  return { ...react, ...hooks, default: { ...react, ...hooks } };
});

// zustand's React binding is a node_modules dependency (the react mock can't
// reach it): bind the hooks to getState().
vi.mock('zustand', async (orig) => {
  const z = await orig<typeof import('zustand')>();
  const { createStore } = await import('zustand/vanilla');
  type Init = import('zustand/vanilla').StateCreator<unknown>;
  const bind = (init: Init) => {
    const api = createStore(init);
    const hook = (selector: (s: unknown) => unknown = (s) => s) => selector(api.getState());
    return Object.assign(hook, api);
  };
  return { ...z, create: (init?: Init) => (init ? bind(init) : bind) };
});

vi.mock('cesium', async (orig) => ({ ...(await orig<typeof import('cesium')>()), Viewer: fake.FakeViewer }));
vi.mock('@/lib/waitForContainerSize', () => ({ waitForContainerSize: async () => ({ width: 960, height: 540 }) }));
vi.mock('@/lib/cesiumUtils', async (orig) => ({
  ...(await orig<typeof import('@/lib/cesiumUtils')>()),
  setIonToken: () => undefined,
  // World Terrain never lands: the flat globe stays (nothing here reads it).
  getTerrainProvider: () => new Promise(() => undefined),
  setupBaseImagery: async () => undefined,
  hasIonToken: () => false,
  resetFollowCam: () => undefined,
  clearMeshTopReads: () => undefined,
}));
vi.mock('@/renderers/cesium/hudLensCrop', async (orig) => ({
  ...(await orig<typeof import('@/renderers/cesium/hudLensCrop')>()),
  lensCropState: () => ({ extendPx: 0 }),
  applyHudLensCrop: () => false,
}));
vi.mock('@/lib/perf/scenePerf', async (orig) => ({
  ...(await orig<typeof import('@/lib/perf/scenePerf')>()),
  attachScenePerf: () => () => undefined,
}));
vi.mock('@/lib/perf/perfGovernor', async (orig) => ({
  ...(await orig<typeof import('@/lib/perf/perfGovernor')>()),
  createPerfGovernor: () => ({ dispose: () => undefined, frame: () => undefined, state: () => ({}) }),
}));
vi.mock('@/lib/dynamicShadow', async (orig) => ({
  ...(await orig<typeof import('@/lib/dynamicShadow')>()),
  createShadowEntity: () => ({ destroy: () => undefined }),
}));
vi.mock('@/lib/graphicsQuality', async (orig) => ({
  ...(await orig<typeof import('@/lib/graphicsQuality')>()),
  applyGraphicsQuality: () => undefined,
}));
vi.mock('@/lib/cinematicEffects', () => ({ applyCinematicEffects: () => undefined, destroyCinematicEffects: () => undefined }));
vi.mock('@/lib/cesiumHDR', () => ({ tryEnableHDR: () => undefined }));
vi.mock('@/hooks/usePlayLayer', () => ({ usePlayLayer: () => undefined }));
vi.mock('@/hooks/useLiveWeather', () => ({ useRouteWeather: () => undefined }));

import type { WorldRenderer } from '@/lib/world/renderer';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { canvasKeyFor, selectWorldStopped, useWorldViewStore, type WorldViewSlot } from '@/stores/worldViewStore';
import { CesiumScene, CesiumWorldView, type ViewerContextReport } from './CesiumWorldView';

type El = ReactElement<Record<string, unknown>>;
function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) for (const n of node) elements(n, out);
  else if (isValidElement(node)) {
    out.push(node as El);
    for (const v of Object.values((node as El).props)) elements(v, out);
  }
  return out;
}

const instance = (): Instance => ({ slots: [], effects: [], i: 0, e: 0, queue: [] });
let mounted: Instance[] = [];

/** One render pass of `inst`, then its effects (as React commits them). */
function renderIn<P>(inst: Instance, component: (props: P) => unknown, props: P): El {
  rt.cur = inst;
  inst.i = 0;
  inst.e = 0;
  const el = component(props) as El;
  return el;
}
function commit(inst: Instance) {
  while (inst.queue.length) inst.queue.shift()!();
}
function unmountIn(inst: Instance) {
  for (const fx of inst.effects) if (typeof fx?.cleanup === 'function') fx.cleanup();
  inst.effects = [];
  mounted = mounted.filter((m) => m !== inst);
}
const flush = async () => {
  for (let k = 0; k < 5; k++) await new Promise((r) => setTimeout(r, 0));
};
const store = () => useWorldViewStore.getState();
const lose = (canvas: EventTarget) => {
  const e = new Event('webglcontextlost', { cancelable: true });
  canvas.dispatchEvent(e);
  return e;
};
const restore = (canvas: EventTarget) => canvas.dispatchEvent(new Event('webglcontextrestored'));

const initialRide = useRideStore.getState();
const initialSettings = useSettingsStore.getState();

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  // The tier is chosen already (the auto pick reads the GPU name off a real context).
  useSettingsStore.setState({ graphicsQualityAuto: false });
  fake.FakeViewer.built = [];
  fake.FakeViewer.optionsSeen = [];
  fake.FakeViewer.failWith = null;
  fake.FakeViewer.onDestroy = null;
});

afterEach(() => {
  for (const m of [...mounted]) unmountIn(m);
  useWorldViewStore.setState({ view: null });
  useRideStore.setState(initialRide, true);
  useSettingsStore.setState(initialSettings, true);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The slot wrapper
// ---------------------------------------------------------------------------

/** Render CesiumWorldView (its effects committed); returns the root and its scene element. */
function renderView(inst: Instance) {
  const root = renderIn(inst, CesiumWorldView, { ionToken: null });
  commit(inst);
  const scene = elements(root).find((x) => x.type === CesiumScene) ?? null;
  return { root, scene, report: scene?.props.context as ViewerContextReport };
}
function mountView() {
  const inst = instance();
  mounted.push(inst);
  renderView(inst);
  // The attach effect set the view id: React renders again.
  return { inst, ...renderView(inst) };
}
const hidden = (root: El) => String(root.props.className).split(' ').includes('invisible');

describe('CesiumWorldView: the world-view slot', () => {
  it('owns the slot while mounted; its scene is keyed on the canvas key and reports for it', () => {
    const { root, scene, report } = mountView();
    const id = store().view?.id;
    expect(id).toBeGreaterThan(0);
    expect(scene?.key).toBe('0');
    expect(scene?.props.canvasKey).toBe(0);
    expect(typeof report.lost).toBe('function');
    expect(typeof report.restored).toBe('function');
    expect(root.props['data-world-context']).toBe('live');
    expect(hidden(root)).toBe(false);
  });

  it('a loss hides the view and keeps the scene; a restore remounts the scene under a new key', () => {
    const { inst, scene, report } = mountView();
    const id = store().view!.id;
    report.lost(0);
    expect(selectWorldStopped(store())).toBe(true);
    const lost = renderView(inst);
    expect(lost.scene?.key).toBe(scene?.key);
    expect(hidden(lost.root)).toBe(true);
    expect(lost.root.props['data-world-context']).toBe('lost');

    report.restored(0);
    const back = renderView(inst);
    expect(canvasKeyFor(store(), id)).toBe(1);
    expect(back.scene?.key).toBe('1');
    expect(back.scene?.props.canvasKey).toBe(1);
    expect(hidden(back.root)).toBe(false);
    expect(back.root.props['data-world-context']).toBe('live');
  });

  it("the rider's tap (store.reload) remounts the scene the same way", () => {
    const { inst, report } = mountView();
    report.lost(0);
    store().reload();
    const back = renderView(inst);
    expect(back.scene?.key).toBe('1');
    expect(hidden(back.root)).toBe(false);
    // The old viewer's late events carry the old key and change nothing.
    back.report.lost(0);
    expect(selectWorldStopped(store())).toBe(false);
    back.report.lost(1);
    expect(selectWorldStopped(store())).toBe(true);
  });

  it('reports reach the slot before the re-render that delivers the view id (a viewer that fails at once)', () => {
    const inst = instance();
    mounted.push(inst);
    const { report } = renderView(inst); // first render + effects only
    expect(store().view).not.toBeNull();
    report.lost(0);
    expect(selectWorldStopped(store())).toBe(true);
  });

  it('a view that lost the slot (the tab after the floating window opened) is ignored, and stays shown', () => {
    const tab = mountView();
    const pip = mountView();
    tab.report.lost(0);
    expect(selectWorldStopped(store())).toBe(false);
    pip.report.lost(0);
    expect(selectWorldStopped(store())).toBe(true);
    // Only the window's view is hidden: the slot's stop is not the tab's.
    expect(hidden(renderView(pip.inst).root)).toBe(true);
    const tabNow = renderView(tab.inst).root;
    expect(hidden(tabNow)).toBe(false);
    expect(tabNow.props['data-world-context']).toBe('live');
  });

  it('leaving the ride (unmount) clears the slot, and late reports change nothing', () => {
    const { inst, report } = mountView();
    report.lost(0);
    unmountIn(inst);
    expect(store().view).toBeNull();
    report.lost(0);
    report.restored(0);
    expect(store().view).toBeNull();
    expect(selectWorldStopped(store())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The scene: one Viewer, its canvas watch, its renderer
// ---------------------------------------------------------------------------

interface SceneMount {
  inst: Instance;
  report: { lost: ReturnType<typeof vi.fn>; restored: ReturnType<typeof vi.fn> };
  onReady: ReturnType<typeof vi.fn>;
}

/** Mount CesiumScene under `canvasKey`, give its container a node, let the async bootstrap run. */
async function mountScene(canvasKey: number): Promise<SceneMount> {
  const inst = instance();
  mounted.push(inst);
  const report = { lost: vi.fn(), restored: vi.fn() };
  const onReady = vi.fn<(r: WorldRenderer) => void>();
  const props = { ionToken: null, onReady, canvasKey, context: report as unknown as ViewerContextReport };
  const el = renderIn(inst, CesiumScene, props);
  // React attaches the container <div ref> before the effects run.
  const container = elements(el).find((x) => x.props.ref && typeof x.props.ref === 'object');
  expect(container, 'the viewer container').toBeDefined();
  (container!.props.ref as { current: unknown }).current = { clientWidth: 960, clientHeight: 540 };
  commit(inst);
  await flush();
  // viewerReady moved on: React renders again and the viewer-bound effects run.
  renderIn(inst, CesiumScene, props);
  commit(inst);
  await flush();
  return { inst, report, onReady };
}

describe('CesiumScene: the viewer canvas and its WebGL context', () => {
  it('watches the viewer canvas: a loss is cancelled and reported for this canvas key, then the restore', async () => {
    const { report } = await mountScene(3);
    expect(fake.FakeViewer.built).toHaveLength(1);
    const canvas = fake.FakeViewer.built[0].scene.canvas;
    const e = lose(canvas);
    expect(e.defaultPrevented, 'cancelled, so the browser may restore it').toBe(true);
    expect(report.lost).toHaveBeenCalledTimes(1);
    expect(report.lost).toHaveBeenCalledWith(3);
    expect(report.restored).not.toHaveBeenCalled();
    restore(canvas);
    expect(report.restored).toHaveBeenCalledTimes(1);
    expect(report.restored).toHaveBeenCalledWith(3);
  });

  it('hands its WorldRenderer (over this viewer) to the ride view once the viewer is up', async () => {
    const { onReady } = await mountScene(0);
    expect(onReady).toHaveBeenCalledTimes(1);
    const renderer = onReady.mock.calls[0][0] as WorldRenderer;
    expect(renderer.kind).toBe('photoreal');
    expect(renderer.native).toBe(fake.FakeViewer.built[0]);
  });

  it('a remount builds a new viewer and hands a new renderer over again', async () => {
    const first = await mountScene(0);
    unmountIn(first.inst);
    const second = await mountScene(1);
    expect(fake.FakeViewer.built).toHaveLength(2);
    const renderer = second.onReady.mock.calls[0][0] as WorldRenderer;
    expect(renderer.native).toBe(fake.FakeViewer.built[1]);
    expect(renderer.native).not.toBe(first.onReady.mock.calls[0][0].native);
    // The new canvas reports under the new key.
    lose(fake.FakeViewer.built[1].scene.canvas);
    expect(second.report.lost).toHaveBeenCalledWith(1);
    expect(first.report.lost).not.toHaveBeenCalled();
  });

  it('unmounting stops the watch before the viewer is destroyed: a teardown loss is not reported', async () => {
    const { inst, report } = await mountScene(2);
    const viewer = fake.FakeViewer.built[0];
    const duringDestroy: boolean[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fake.FakeViewer.onDestroy = (v) => {
      duringDestroy.push(lose(v.scene.canvas).defaultPrevented);
      v.scene.renderError.raise(v.scene, new Error('a frame during teardown'));
    };
    unmountIn(inst);
    expect(viewer.destroyCalls).toBe(1);
    expect(duringDestroy).toEqual([false]);
    expect(viewer.scene.renderError.listeners, 'the renderError watch is gone').toHaveLength(0);
    expect(lose(viewer.scene.canvas).defaultPrevented).toBe(false);
    restore(viewer.scene.canvas);
    viewer.scene.renderError.raise(viewer.scene, new Error('a late frame'));
    expect(report.lost).not.toHaveBeenCalled();
    expect(report.restored).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((c) => /stopped rendering/.test(String(c[0])))).toEqual([]);
  });

  it("builds the Viewer with Cesium's own error panel off (the chip says it; the panel's resize listener kept dead viewers alive)", async () => {
    await mountScene(0);
    expect(fake.FakeViewer.built).toHaveLength(1);
    const options = fake.FakeViewer.built[0].options as Record<string, unknown>;
    expect(options.showRenderLoopErrors).toBe(false);
  });

  it('a frame that throws (scene.renderError: the render loop stopped) reads stopped for this key, warned once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { report, onReady } = await mountScene(5);
    const stopWarnings = () => warn.mock.calls.filter((c) => /stopped rendering/.test(String(c[0]))).length;
    expect(onReady).toHaveBeenCalledTimes(1);
    const viewer = fake.FakeViewer.built[0];
    expect(viewer.scene.renderError.listeners).toHaveLength(1);
    expect(report.lost).not.toHaveBeenCalled();
    expect(stopWarnings()).toBe(0);
    viewer.scene.renderError.raise(viewer.scene, new Error('Expected width to be greater than 0'));
    expect(report.lost).toHaveBeenCalledTimes(1);
    expect(report.lost).toHaveBeenCalledWith(5);
    expect(report.restored).not.toHaveBeenCalled();
    expect(stopWarnings()).toBe(1);
    // XR keeps calling scene.render(): every throw still reports, the log stays one line.
    viewer.scene.renderError.raise(viewer.scene, new Error('again'));
    expect(report.lost).toHaveBeenCalledTimes(2);
    expect(report.lost).toHaveBeenLastCalledWith(5);
    expect(stopWarnings()).toBe(1);
  });

  it('no viewer can be built (no WebGL right now): the view reads stopped for this key, no renderer is handed over', async () => {
    fake.FakeViewer.failWith = new Error('Error constructing CesiumWidget: WebGL unavailable');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { report, onReady } = await mountScene(4);
    expect(report.lost).toHaveBeenCalledTimes(1);
    expect(report.lost).toHaveBeenCalledWith(4);
    expect(onReady).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    // Nor does Cesium draw its "Error constructing CesiumWidget" panel into the container.
    expect(fake.FakeViewer.optionsSeen).toHaveLength(1);
    expect((fake.FakeViewer.optionsSeen[0] as Record<string, unknown>).showRenderLoopErrors).toBe(false);
  });
});

describe('CesiumWorldView + CesiumScene + the store: lose, tap, a new viewer', () => {
  /** Mount a CesiumScene under the view's report, as the wrapper's element would. */
  async function mountSceneUnder(report: ViewerContextReport, canvasKey: number) {
    const inst = instance();
    mounted.push(inst);
    const props = { ionToken: null, canvasKey, context: report };
    const el = renderIn(inst, CesiumScene, props);
    (elements(el).find((x) => x.props.ref && typeof x.props.ref === 'object')!.props.ref as { current: unknown }).current = {};
    commit(inst);
    await flush();
    return inst;
  }

  it('a render-loop stop (renderError, no context loss) shows the chip state, and the tap remounts on a new key', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const view = mountView();
    const id = store().view!.id;
    await mountSceneUnder(view.report, 0);
    const viewer = fake.FakeViewer.built[0];
    expect(selectWorldStopped(store())).toBe(false);
    viewer.scene.renderError.raise(viewer.scene, new Error('a shader failed to link'));
    expect(store().view).toEqual<WorldViewSlot>({ id, canvasKey: 0, stopped: true });
    const lost = renderView(view.inst);
    expect(hidden(lost.root)).toBe(true);
    expect(lost.root.props['data-world-context']).toBe('lost');
    store().reload();
    expect(store().view).toEqual<WorldViewSlot>({ id, canvasKey: 1, stopped: false });
    expect(renderView(view.inst).scene?.key).toBe('1');
  });

  it('the scene a key bump mounts reports to the same slot, and the chip state follows it', async () => {
    const view = mountView();
    const id = store().view!.id;
    // The scene element carries the wrapper's report: mount it as React would.
    const report = view.report;
    const reportSpy = { lost: vi.fn((k: number) => report.lost(k)), restored: vi.fn((k: number) => report.restored(k)) };
    const inst = instance();
    mounted.push(inst);
    const props = { ionToken: null, canvasKey: 0, context: reportSpy as unknown as ViewerContextReport };
    const el = renderIn(inst, CesiumScene, props);
    (elements(el).find((x) => x.props.ref && typeof x.props.ref === 'object')!.props.ref as { current: unknown }).current = {};
    commit(inst);
    await flush();
    lose(fake.FakeViewer.built[0].scene.canvas);
    expect(store().view).toEqual<WorldViewSlot>({ id, canvasKey: 0, stopped: true });
    store().reload();
    expect(store().view).toEqual<WorldViewSlot>({ id, canvasKey: 1, stopped: false });
    expect(renderView(view.inst).scene?.key).toBe('1');
  });
});
