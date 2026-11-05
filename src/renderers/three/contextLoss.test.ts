/**
 * The world canvas's context-loss watch (renderers/three/contextLoss.ts,
 * card t_14ea510a): the loss is cancelled so the browser may restore it, the
 * store hears about it, and a restore remounts the canvas. The in-canvas
 * component is called as a plain function (useEffect runs at once, its
 * cleanup is kept; useThree hands it a fake renderer whose canvas is a plain
 * EventTarget), so no WebGL context is needed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  cleanups: [] as Array<() => void>,
  gl: { domElement: null as unknown as EventTarget },
}));

vi.mock('react', async (orig) => {
  const react = await orig<typeof import('react')>();
  const hooks = {
    useEffect: (fn: () => void | (() => void)) => {
      const c = fn();
      if (typeof c === 'function') h.cleanups.push(c);
    },
  };
  return { ...react, ...hooks, default: { ...react, ...hooks } };
});

vi.mock('@react-three/fiber', async (orig) => ({
  ...(await orig<typeof import('@react-three/fiber')>()),
  useThree: <T,>(selector: (s: { gl: typeof h.gl }) => T) => selector({ gl: h.gl }),
}));

import { ContextLossWatch, watchContextLoss } from './contextLoss';
import { canvasKeyFor, selectWorldStopped, useWorldViewStore } from '@/stores/worldViewStore';

const lose = (canvas: EventTarget) => {
  const e = new Event('webglcontextlost', { cancelable: true });
  canvas.dispatchEvent(e);
  return e;
};
const restore = (canvas: EventTarget) => canvas.dispatchEvent(new Event('webglcontextrestored'));
const store = () => useWorldViewStore.getState();

/** Mount the watch on a fresh canvas; returns the canvas and the unmount. */
function mountWatch(viewId: number, canvasKey: number) {
  const canvas = new EventTarget();
  h.gl = { domElement: canvas };
  const before = h.cleanups.length;
  expect(ContextLossWatch({ viewId, canvasKey })).toBeNull();
  const own = h.cleanups.splice(before);
  return { canvas, unmount: () => own.forEach((c) => c()) };
}

afterEach(() => {
  for (const c of h.cleanups.splice(0)) c();
  useWorldViewStore.setState({ view: null });
});

describe('watchContextLoss', () => {
  it('cancels the loss (so the browser may restore it) and reports it; reports the restore', () => {
    const canvas = new EventTarget();
    const on = { lost: vi.fn(), restored: vi.fn() };
    watchContextLoss(canvas, on);
    const e = lose(canvas);
    expect(e.defaultPrevented).toBe(true);
    expect(on.lost).toHaveBeenCalledTimes(1);
    expect(on.restored).not.toHaveBeenCalled();
    restore(canvas);
    expect(on.restored).toHaveBeenCalledTimes(1);
  });

  it('says nothing once stopped: the loss r3f forces on a canvas it unmounts is not reported', () => {
    const canvas = new EventTarget();
    const on = { lost: vi.fn(), restored: vi.fn() };
    const stop = watchContextLoss(canvas, on);
    stop();
    expect(lose(canvas).defaultPrevented).toBe(false);
    restore(canvas);
    expect(on.lost).not.toHaveBeenCalled();
    expect(on.restored).not.toHaveBeenCalled();
  });
});

describe('ContextLossWatch (inside <Canvas>)', () => {
  it('lost -> the view reads stopped; restored -> the canvas key moves on, so <Canvas> remounts', () => {
    const id = store().attach();
    const { canvas } = mountWatch(id, 0);
    const e = lose(canvas);
    expect(e.defaultPrevented).toBe(true);
    expect(selectWorldStopped(store())).toBe(true);
    restore(canvas);
    expect(selectWorldStopped(store())).toBe(false);
    expect(canvasKeyFor(store(), id)).toBe(1);
  });

  it('the remount: the old canvas is unwatched before r3f forces its loss; the new canvas is watched under the new key', () => {
    const id = store().attach();
    const first = mountWatch(id, 0);
    lose(first.canvas);
    store().reload(); // the rider's tap
    expect(canvasKeyFor(store(), id)).toBe(1);

    first.unmount();
    // r3f teardown: forceContextLoss() on the old canvas. Nobody listens any more.
    expect(lose(first.canvas).defaultPrevented).toBe(false);
    expect(selectWorldStopped(store())).toBe(false);

    const second = mountWatch(id, 1);
    lose(second.canvas);
    expect(selectWorldStopped(store())).toBe(true);
    restore(second.canvas);
    expect(canvasKeyFor(store(), id)).toBe(2);
    expect(selectWorldStopped(store())).toBe(false);
  });

  it('a canvas of a view that no longer owns the slot (the closed floating window) is ignored', () => {
    const pip = store().attach();
    const { canvas } = mountWatch(pip, 0);
    const tab = store().attach();
    lose(canvas);
    expect(selectWorldStopped(store())).toBe(false);
    expect(canvasKeyFor(store(), tab)).toBe(0);
  });

  it('before the view has attached (id 0) nothing is watched', () => {
    const { canvas } = mountWatch(0, 0);
    const e = lose(canvas);
    expect(e.defaultPrevented).toBe(false);
    expect(store().view).toBeNull();
  });
});
