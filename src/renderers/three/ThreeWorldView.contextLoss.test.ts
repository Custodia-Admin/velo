/**
 * ThreeWorldView's context-loss wiring (card t_14ea510a), without a WebGL
 * context: the view runs as a plain function on a tiny hooks runtime (state
 * slots by call order, effects that re-run when their deps change, memos),
 * zustand's React binding reads getState(), and the world bundle "loads" as
 * the synthetic test world. The returned element tree is walked, not
 * rendered.
 *
 * Pins: the view owns the world-view slot while mounted; its <Canvas> key
 * carries the slot's canvas key, so a restore or the rider's tap remounts the
 * canvas (a loss alone does not); the canvas watch gets the view id and the
 * current key; leaving clears the slot.
 *
 * Also here (card t_c4842aa7, same harness): covered by the finish screen, the
 * canvas's frame loop stops ('never') on the same canvas and scene, and runs
 * again when uncovered; the steady clock sits in every canvas.
 */
import { isValidElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const rt = vi.hoisted(() => ({
  slots: [] as unknown[],
  i: 0,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: void | (() => void) } | undefined>,
  e: 0,
  queue: [] as Array<() => void>,
}));

const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
  !!a && !!b && a.length === b.length && a.every((v, k) => Object.is(v, b[k]));

vi.mock('react', async (orig) => {
  const react = await orig<typeof import('react')>();
  const hooks = {
    useState: <T,>(init: T | (() => T)) => {
      const k = rt.i++;
      if (!(k in rt.slots)) rt.slots[k] = typeof init === 'function' ? (init as () => T)() : init;
      const set = (v: T | ((p: T) => T)) => {
        rt.slots[k] = typeof v === 'function' ? (v as (p: T) => T)(rt.slots[k] as T) : v;
      };
      return [rt.slots[k] as T, set] as const;
    },
    useRef: <T,>(current: T) => {
      const k = rt.i++;
      if (!(k in rt.slots)) rt.slots[k] = { current };
      return rt.slots[k] as { current: T };
    },
    useMemo: <T,>(fn: () => T, deps?: readonly unknown[]) => {
      const k = rt.i++;
      const prev = rt.slots[k] as { deps?: readonly unknown[]; value: T } | undefined;
      if (prev && same(prev.deps, deps)) return prev.value;
      const value = fn();
      rt.slots[k] = { deps, value };
      return value;
    },
    useCallback: <T,>(fn: T, deps?: readonly unknown[]) => hooks.useMemo(() => fn, deps),
    useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
      const k = rt.e++;
      const prev = rt.effects[k];
      if (prev && same(prev.deps, deps)) return;
      rt.queue.push(() => {
        if (typeof prev?.cleanup === 'function') prev.cleanup();
        rt.effects[k] = { deps, cleanup: fn() };
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

// The world bundle: the synthetic test world instead of a fetch (its manifest
// gains the heightfield block the light reads).
vi.mock('@/lib/world/loadWorld', async (orig) => ({
  ...(await orig<typeof import('@/lib/world/loadWorld')>()),
  loadWorld: async () => {
    const w = (await import('./syntheticWorld')).syntheticSceneWorld().world;
    return { ...w, manifest: { ...w.manifest, heightfield: { minHeight: 0 } } };
  },
}));
vi.mock('@/hooks/useLiveWeather', () => ({ useRouteWeather: () => undefined }));
// The rider model is a GLB the node test env can't fetch.
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

import { Canvas } from '@react-three/fiber';
import type { Route } from '@/types';
import { useRideStore } from '@/stores/rideStore';
import { canvasKeyFor, selectWorldStopped, useWorldViewStore } from '@/stores/worldViewStore';
import type { WorldViewProps } from '@/lib/world/renderer';
import { ContextLossWatch } from './contextLoss';
import { SteadyClock, ThreeWorldView, WorldScene } from './ThreeWorldView';

type El = ReactElement<Record<string, unknown>>;
function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) for (const n of node) elements(n, out);
  else if (isValidElement(node)) {
    out.push(node as El);
    for (const v of Object.values((node as El).props)) elements(v, out);
  }
  return out;
}

const initialRide = useRideStore.getState();
const route = {
  id: 'scenic-perugia-tiber-park',
  name: 'Tiber river park',
  points: [
    { lat: 43.11, lon: 12.39, ele: 200 },
    { lat: 43.111, lon: 12.391, ele: 201 },
  ],
} as unknown as Route;

/** One render pass, then its effects (as React commits them). */
function render(props: Partial<WorldViewProps> = {}) {
  rt.i = 0;
  rt.e = 0;
  const el = ThreeWorldView({ ionToken: null, ...props });
  while (rt.queue.length) rt.queue.shift()!();
  const all = elements(el);
  const canvas = all.find((x) => x.type === Canvas) ?? null;
  const watch = all.find((x) => x.type === ContextLossWatch) ?? null;
  const clocks = canvas ? elements(canvas.props.children).filter((x) => x.type === SteadyClock) : [];
  return { root: el as El, canvas, watch, clocks, scene: all.find((x) => x.type === WorldScene) ?? null };
}

function unmount() {
  for (const fx of rt.effects) if (typeof fx?.cleanup === 'function') fx.cleanup();
}

afterEach(() => {
  unmount();
  rt.slots = [];
  rt.effects = [];
  rt.queue = [];
  useRideStore.setState(initialRide, true);
  useWorldViewStore.setState({ view: null });
});

/** Mount the view and let the (synthetic) world load. */
async function mounted(props: Partial<WorldViewProps> = {}) {
  useRideStore.setState({ route });
  const first = render(props);
  expect(first.canvas).toBeNull(); // the world is still loading
  let view = first;
  for (let tick = 0; tick < 50 && !view.canvas; tick++) {
    await new Promise((r) => setTimeout(r, 0));
    view = render(props);
  }
  expect(view.canvas, 'the canvas once the world is in').not.toBeNull();
  return view;
}

describe('ThreeWorldView: a lost WebGL context', () => {
  it('owns the world-view slot while mounted, and its canvas watch reports for this view and canvas', async () => {
    const { watch } = await mounted();
    const id = useWorldViewStore.getState().view?.id;
    expect(id).toBeGreaterThan(0);
    expect(watch?.props).toEqual({ viewId: id, canvasKey: 0 });
  });

  it('a loss alone keeps the canvas; a restore remounts it under a new key', async () => {
    const before = await mounted();
    const id = useWorldViewStore.getState().view!.id;
    useWorldViewStore.getState().contextLost(id, 0);
    const lost = render();
    expect(selectWorldStopped(useWorldViewStore.getState())).toBe(true);
    expect(lost.canvas!.key).toBe(before.canvas!.key);
    // The dead canvas is hidden (Chrome paints it white with a broken-image glyph).
    expect(String(before.canvas!.props.className).split(' ')).not.toContain('invisible');
    expect(String(lost.canvas!.props.className).split(' ')).toContain('invisible');
    expect(lost.root.props['data-world-context']).toBe('lost');

    useWorldViewStore.getState().contextRestored(id, 0);
    const back = render();
    expect(back.canvas!.key).not.toBe(before.canvas!.key);
    expect(back.canvas!.key).toContain(':1');
    expect(back.watch?.props).toEqual({ viewId: id, canvasKey: 1 });
    expect(String(back.canvas!.props.className).split(' ')).not.toContain('invisible');
    expect(back.root.props['data-world-context']).toBe('live');
    // The scene goes in the new canvas (r3f rebuilds it there).
    expect(back.scene).not.toBeNull();
  });

  it("the rider's tap (store.reload) remounts the canvas the same way", async () => {
    const before = await mounted();
    const id = useWorldViewStore.getState().view!.id;
    useWorldViewStore.getState().contextLost(id, 0);
    useWorldViewStore.getState().reload();
    const back = render();
    expect(back.canvas!.key).not.toBe(before.canvas!.key);
    expect(canvasKeyFor(useWorldViewStore.getState(), id)).toBe(1);
    expect(back.watch?.props).toEqual({ viewId: id, canvasKey: 1 });
  });

  it('leaving the ride (unmount) clears the slot, so no stale chip outlives the view', async () => {
    await mounted();
    const id = useWorldViewStore.getState().view!.id;
    useWorldViewStore.getState().contextLost(id, 0);
    unmount();
    expect(useWorldViewStore.getState().view).toBeNull();
    expect(selectWorldStopped(useWorldViewStore.getState())).toBe(false);
  });
});

describe('ThreeWorldView: covered by the finish screen', () => {
  it('draws every frame while riding', async () => {
    const view = await mounted();
    expect(view.canvas!.props.frameloop).toBe('always');
  });

  it("covered: the canvas's frame loop stops on the same canvas, scene and context; uncovered: it runs again", async () => {
    const riding = await mounted();
    const covered = render({ covered: true });
    expect(covered.canvas!.props.frameloop).toBe('never');
    // No remount: the same canvas (key) and the same scene, so nothing is rebuilt or re-fetched.
    expect(covered.canvas!.key).toBe(riding.canvas!.key);
    expect(covered.scene).not.toBeNull();
    expect(covered.scene!.key).toBe(riding.scene!.key);
    expect(covered.scene!.props.sceneWorld).toBe(riding.scene!.props.sceneWorld);
    expect(covered.root.props['data-world-context']).toBe('live');
    // Ride again.
    const again = render({ covered: false });
    expect(again.canvas!.props.frameloop).toBe('always');
    expect(again.canvas!.key).toBe(riding.canvas!.key);
    expect(again.scene!.props.sceneWorld).toBe(riding.scene!.props.sceneWorld);
  });

  it('a view mounted under the finish screen (the floating window closed at the finish) starts with no frames', async () => {
    const view = await mounted({ covered: true });
    expect(view.canvas!.props.frameloop).toBe('never');
  });

  it("every canvas carries one steady clock (r3f restarts its clock when the loop's mode changes)", async () => {
    const view = await mounted();
    expect(view.clocks).toHaveLength(1);
    const id = useWorldViewStore.getState().view!.id;
    useWorldViewStore.getState().contextLost(id, 0);
    useWorldViewStore.getState().contextRestored(id, 0);
    expect(render().clocks).toHaveLength(1);
  });
});
