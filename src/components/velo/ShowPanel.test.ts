/**
 * Show mode's panel as components (ShowPanel.tsx): the corner, the chooser
 * and the player, called as plain functions on a tiny hooks runtime (state
 * slots, effects with deps, refs) with zustand's React binding reading
 * getState(). The real show store and the real resume/last-watched storage;
 * Chrome's pickers and the remembered-library lookup are fakes.
 *
 * What this pins (review of PR #36 @bbe04db):
 * - capability first (P2, P3): "Watch another tab" only where Document
 *   Picture-in-Picture exists, in the corner and in the chooser;
 * - next episode (C2, C3, C6): the player records what is being watched and
 *   that it finished; Continue asks Chrome with the click it was given;
 * - honest Continue copy (D4): each reason it can't carry on gets its own
 *   true sentence and one action.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

interface EffectSlot {
  deps?: readonly unknown[];
  cleanup?: () => void;
}

const h = vi.hoisted(() => ({
  slots: new Map<number, unknown>(),
  effects: new Set<number>(),
  i: 0,
  pipWindow: null as Window | null,
  library: null as unknown,
  canFolder: true,
  continueResult: null as unknown,
  continueLastShow: vi.fn(),
  pickVideos: vi.fn(async () => [] as File[]),
  pickVideoFolderFiles: vi.fn(async () => null as File[] | null),
  openRideWindow: vi.fn(async () => true),
}));

vi.mock('react', async (orig) => {
  const react = await orig<typeof import('react')>();
  const hooks = {
    useState: <T,>(init: T | (() => T)) => {
      const i = h.i++;
      if (!h.slots.has(i)) h.slots.set(i, typeof init === 'function' ? (init as () => T)() : init);
      const set = (v: T | ((prev: T) => T)) => {
        h.slots.set(i, typeof v === 'function' ? (v as (prev: T) => T)(h.slots.get(i) as T) : v);
      };
      return [h.slots.get(i) as T, set] as const;
    },
    useRef: <T,>(init: T) => {
      const i = h.i++;
      if (!h.slots.has(i)) h.slots.set(i, { current: init });
      return h.slots.get(i) as { current: T };
    },
    useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
      const i = h.i++;
      h.effects.add(i);
      const prev = h.slots.get(i) as EffectSlot | undefined;
      const same =
        prev?.deps !== undefined &&
        deps !== undefined &&
        prev.deps.length === deps.length &&
        deps.every((d, k) => Object.is(d, prev.deps![k]));
      if (same) return;
      prev?.cleanup?.();
      const c = fn();
      h.slots.set(i, { deps, cleanup: typeof c === 'function' ? c : undefined } satisfies EffectSlot);
    },
    useId: () => `id-${h.i++}`,
    useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
    useMemo: <T,>(fn: () => T) => fn(),
    useCallback: <T,>(fn: T) => fn,
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

// The floating window itself (RideView, the world) is not under test here.
vi.mock('./ShowSurface', () => ({
  useRidePipWindow: () => h.pipWindow,
  openRideWindow: h.openRideWindow,
}));
vi.mock('@/lib/show/pickVideos', () => ({
  pickVideos: h.pickVideos,
  pickVideoFolderFiles: h.pickVideoFolderFiles,
}));
vi.mock('@/lib/show/continueShow', async (orig) => ({
  ...(await orig<typeof import('@/lib/show/continueShow')>()),
  continueLastShow: h.continueLastShow,
}));
vi.mock('@/lib/show/showLibrary', async (orig) => ({
  ...(await orig<typeof import('@/lib/show/showLibrary')>()),
  canUseFilePicker: () => true,
  canPickFolder: () => h.canFolder,
  recallLibrary: async () => h.library,
}));

// A browser page: localStorage (resume + last watched) and, per test, Document PiP.
const mem = new Map<string, string>();
const storage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  get length() {
    return mem.size;
  },
};
vi.stubGlobal('localStorage', storage);
vi.stubGlobal('window', globalThis);
(globalThis as { top?: unknown }).top = globalThis;

const { isValidElement } = await import('react');
const { ShowCorner, ShowPanel, continueFailureText } = await import('./ShowPanel');
const { useShowStore } = await import('@/stores/showStore');
const { fileKey, lastWatched, LAST_WATCHED_KEY } = await import('@/lib/show/showLibrary');

type El = ReactElement<Record<string, unknown>>;

function withPip(on: boolean) {
  const g = globalThis as { documentPictureInPicture?: unknown };
  if (on) g.documentPictureInPicture = { requestWindow: async () => ({}), window: null };
  else delete g.documentPictureInPicture;
}

/** Every element in a tree (props included). */
function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) for (const n of node) elements(n, out);
  else if (isValidElement(node)) {
    out.push(node as El);
    for (const v of Object.values((node as El).props)) elements(v, out);
  }
  return out;
}
/** A component's name: function name, or displayName (forwardRef components such as Button). */
const typeName = (e: El) => {
  const t = e.type as unknown as { name?: string; displayName?: string } | string;
  if (typeof t === 'string') return t;
  return t.displayName ?? t.name ?? '';
};
const byType = (tree: unknown, name: string) => elements(tree).filter((e) => typeName(e) === name);
/** The text of an element tree. */
function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement(node)) return text((node as El).props.children);
  return '';
}
const buttonWith = (tree: unknown, label: string) => elements(tree).find((e) => typeName(e) === 'Button' && text(e.props.children).includes(label));

/** Render a component function (or re-render it) on the hooks runtime. */
function render<P>(component: (props: P) => unknown, props: P): unknown {
  h.i = 0;
  return component(props);
}
function unmount(): void {
  for (const i of h.effects) (h.slots.get(i) as EffectSlot | undefined)?.cleanup?.();
  h.slots.clear();
  h.effects.clear();
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** ShowPanel's inner component (the chooser or the player) as a function. */
function inner(): { fn: (p: Record<string, unknown>) => unknown; props: Record<string, unknown> } {
  h.i = 0;
  const section = ShowPanel({ dimmed: false }) as El | null;
  if (!section) throw new Error('ShowPanel rendered nothing');
  const child = section.props.children as El;
  return { fn: child.type as (p: Record<string, unknown>) => unknown, props: { ...child.props } };
}

const video = (name: string, size: number) => new File([new Uint8Array(size)], name, { type: 'video/mp4' });
const folder = { kind: 'folder', dir: { name: 'Show S01', kind: 'directory' } };
const files = { kind: 'files', handles: [{ name: 'Show S01E01.mp4', kind: 'file' }] };

beforeEach(() => {
  mem.clear();
  h.slots.clear();
  h.effects.clear();
  h.pipWindow = null;
  h.library = null;
  h.canFolder = true;
  h.continueLastShow.mockReset();
  h.continueLastShow.mockImplementation(async () => h.continueResult);
  h.openRideWindow.mockClear();
  vi.stubGlobal('URL', { createObjectURL: (f: File) => `blob:${f.name}`, revokeObjectURL: () => undefined });
  useShowStore.getState().endShow();
  useShowStore.getState().startShow(1);
});

afterEach(() => {
  unmount();
  withPip(false);
  useShowStore.getState().endShow();
});

describe('capability first: no Document Picture-in-Picture, no "Watch another tab"', () => {
  it('the corner offers "Watch another tab" only where the browser can float the ride', () => {
    withPip(true);
    let tree = render(ShowCorner, {});
    expect(byType(tree, 'WatchAnotherTabButton')).toHaveLength(1);
    expect(byType(tree, 'CameraButton')).toHaveLength(0);
    unmount();
    withPip(false);
    tree = render(ShowCorner, {});
    expect(byType(tree, 'WatchAnotherTabButton')).toHaveLength(0);
    // The camera choice takes the slot instead.
    expect(byType(tree, 'CameraButton')).toHaveLength(1);
  });

  it('the chooser explains Chrome’s own picture-in-picture where it can’t float the ride', () => {
    withPip(false);
    let { fn, props } = inner();
    let tree = render(fn, props);
    expect(byType(tree, 'WatchAnotherTabButton')).toHaveLength(0);
    expect(buttonWith(tree, 'Use picture-in-picture')).toBeTruthy();
    unmount();
    withPip(true);
    ({ fn, props } = inner());
    tree = render(fn, props);
    expect(byType(tree, 'WatchAnotherTabButton')).toHaveLength(1);
    expect(buttonWith(tree, 'Use picture-in-picture')).toBeUndefined();
  });
});

describe('Continue in the chooser', () => {
  async function chooser(lib: unknown) {
    h.library = lib;
    const { fn, props } = inner();
    render(fn, props); // mounts: the remembered library is looked up
    await flush();
    return { fn, props, tree: render(fn, props) };
  }

  it("asks Chrome with the rider's click and starts at the planned episode", async () => {
    const a = video('Show S01E01.mp4', 11);
    const b = video('Show S01E02.mp4', 12);
    h.continueResult = { ok: true, plan: { files: [a, b], startKey: fileKey(b), next: { index: 1, positionS: 0, reason: 'next' } } };
    const { tree } = await chooser(folder);
    const go = elements(tree).find((e) => e.props['data-testid'] === 'show-continue');
    expect(text(go?.props.children)).toContain('Play Show S01');
    (go!.props.onClick as () => void)();
    await flush();
    expect(h.continueLastShow).toHaveBeenCalledWith({ ask: true });
    const s = useShowStore.getState();
    expect(s.items.map((it) => it.title)).toEqual(['Show S01E01', 'Show S01E02']);
    expect(s.items[s.index].key).toBe(fileKey(b));
  });

  const reasons = [
    ['none', files, 'Velo can’t reopen last time’s videos on this device.', 'Choose videos'],
    ['denied', folder, 'Chrome didn’t allow Velo to open the folder “Show S01”.', 'Choose a folder'],
    ['denied', files, 'Chrome didn’t allow Velo to open last time’s videos.', 'Choose videos'],
    ['missing', folder, 'The folder “Show S01” has moved, or has no videos Chrome can play now.', 'Choose a folder'],
    ['missing', files, 'Last time’s videos have moved or been deleted.', 'Choose videos'],
    ['done', folder, 'You have watched everything from last time.', 'Choose a folder'],
  ] as const;

  for (const [reason, lib, sentence, action] of reasons) {
    it(`${reason} (${lib.kind}): one true sentence, and choosing again as the one action`, async () => {
      h.continueResult = { ok: false, reason, library: lib };
      // Last time's video, so a remembered set of files has a Continue label too.
      mem.set(LAST_WATCHED_KEY, JSON.stringify({ key: 'Show S01E01.mp4::11', name: 'Show S01E01', finished: false, savedAt: 1 }));
      const c = await chooser(lib);
      const go = elements(c.tree).find((e) => e.props['data-testid'] === 'show-continue');
      (go!.props.onClick as () => void)();
      await flush();
      const tree = render(c.fn, c.props);
      const note = elements(tree).find((e) => e.props['data-testid'] === 'show-continue-failure');
      expect(note?.props['data-reason']).toBe(reason);
      expect(text(note?.props.children)).toContain(sentence);
      expect(text(note?.props.children)).toBe(continueFailureText(reason, lib as never));
      // Only "done" says everything was watched.
      expect(text(note?.props.children).includes('watched everything')).toBe(reason === 'done');
      expect(note?.props.role).toBe(reason === 'done' ? 'status' : 'alert');
      // Continue is gone; the matching pick is the one filled button.
      expect(elements(tree).some((e) => e.props['data-testid'] === 'show-continue')).toBe(false);
      const filled = elements(tree).filter((e) => typeName(e) === 'Button' && e.props.variant === 'primary');
      expect(filled.map((e) => text(e.props.children).trim())).toEqual([action]);
    });
  }
});

describe('the player records what is being watched (next episode)', () => {
  function player(over: Partial<{ duration: number; currentTime: number }> = {}) {
    const a = video('Show S01E01.mp4', 11);
    const b = video('Show S01E02.mp4', 12);
    useShowStore.getState().loadFiles([a, b]);
    const { fn, props } = inner();
    const tree = render(fn, props);
    const el = elements(tree).find((e) => e.type === 'video')!;
    const v = {
      currentTime: over.currentTime ?? 600,
      duration: over.duration ?? 1500,
      ended: false,
      paused: false,
      play: () => Promise.resolve(),
      pause: () => undefined,
    };
    (el.props.ref as { current: unknown }).current = v;
    return { a, b, v, video: el.props as Record<string, () => void> };
  }

  it('pausing remembers the video part-way, so Continue carries on with it', () => {
    const { a, video: p } = player({ currentTime: 600, duration: 1500 });
    p.onPause();
    expect(lastWatched(storage as unknown as Storage)).toMatchObject({ key: fileKey(a), finished: false });
  });

  it('the end of a video marks it finished (even when Chrome reports no duration) and plays the next', () => {
    // A WebM recorded without a duration header reports Infinity.
    const { a, v, video: p } = player({ currentTime: 1234, duration: Number.POSITIVE_INFINITY });
    v.ended = true;
    p.onEnded();
    expect(JSON.parse(mem.get(LAST_WATCHED_KEY)!)).toMatchObject({ key: fileKey(a), finished: true });
    expect(useShowStore.getState().index).toBe(1);
  });
});
