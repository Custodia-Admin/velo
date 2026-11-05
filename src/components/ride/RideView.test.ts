/**
 * RideView hands the ride the renderer that draws (card t_771036a6): a view
 * may hand over a new one while it stays mounted (the photoreal view builds a
 * new Cesium Viewer after a lost WebGL context), and the one it replaces is
 * disposed. RideView runs as a plain function on a tiny hooks runtime; the
 * view element's `onReady` is called directly, nothing is rendered.
 */
import { isValidElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const rt = vi.hoisted(() => ({
  slots: [] as unknown[],
  i: 0,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: void | (() => void) } | undefined>,
  e: 0,
}));

const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
  !!a && !!b && a.length === b.length && a.every((v, k) => Object.is(v, b[k]));

vi.mock('react', async (orig) => {
  const react = await orig<typeof import('react')>();
  const hooks = {
    useState: <T,>(init: T | (() => T)) => {
      const k = rt.i++;
      if (!(k in rt.slots)) rt.slots[k] = typeof init === 'function' ? (init as () => T)() : init;
      return [rt.slots[k] as T, (v: T) => void (rt.slots[k] = v)] as const;
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
      if (typeof prev?.cleanup === 'function') prev.cleanup();
      rt.effects[k] = { deps, cleanup: fn() };
    },
  };
  return { ...react, ...hooks, default: { ...react, ...hooks } };
});

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

import type { WorldRenderer } from '@/lib/world/renderer';
import { RideView } from './RideView';

type El = ReactElement<Record<string, unknown>>;
function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) for (const n of node) elements(n, out);
  else if (isValidElement(node)) {
    out.push(node as El);
    for (const v of Object.values((node as El).props)) elements(v, out);
  }
  return out;
}

function render(onRendererReady: (r: WorldRenderer | null) => void) {
  rt.i = 0;
  rt.e = 0;
  const el = RideView({ ionToken: null, onRendererReady });
  const view = elements(el).find((x) => typeof x.props.onReady === 'function');
  expect(view, 'the renderer view element').toBeDefined();
  return view!.props.onReady as (r: WorldRenderer) => void;
}

const fakeRenderer = (): WorldRenderer =>
  ({ kind: 'photoreal', setRider: vi.fn(), setCamera: vi.fn(), setMood: vi.fn(), dispose: vi.fn() }) as unknown as WorldRenderer;

afterEach(() => {
  for (const fx of rt.effects) if (typeof fx?.cleanup === 'function') fx.cleanup();
  rt.slots = [];
  rt.effects = [];
});

describe('RideView: a view hands over a new renderer while it stays mounted', () => {
  it('passes each renderer on and disposes the one it replaces (a rebuilt Cesium Viewer)', () => {
    const got: Array<WorldRenderer | null> = [];
    const onReady = render((r) => got.push(r));
    const first = fakeRenderer();
    const second = fakeRenderer();
    onReady(first);
    expect(got).toEqual([first]);
    expect(first.dispose).not.toHaveBeenCalled();
    onReady(second);
    expect(got).toEqual([first, second]);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).not.toHaveBeenCalled();
  });

  it('the same renderer handed over again is not disposed', () => {
    const onReady = render(() => undefined);
    const r = fakeRenderer();
    onReady(r);
    onReady(r);
    expect(r.dispose).not.toHaveBeenCalled();
  });

  it('leaving disposes the last renderer and hands the ride null', () => {
    const got: Array<WorldRenderer | null> = [];
    const onReady = render((r) => got.push(r));
    const first = fakeRenderer();
    const second = fakeRenderer();
    onReady(first);
    onReady(second);
    for (const fx of rt.effects) if (typeof fx?.cleanup === 'function') fx.cleanup();
    rt.effects = [];
    expect(second.dispose).toHaveBeenCalledTimes(1);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(got[got.length - 1]).toBeNull();
  });
});
