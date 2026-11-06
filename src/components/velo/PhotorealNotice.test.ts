/**
 * The photoreal notice (PhotorealNotice.tsx, card t_375b203d): which notice
 * a ride shows, its session dismissal, the imagery-fallback event, the
 * Settings hand-off, and the pill itself (one h-10 line, 40 px targets, a
 * flow item: never positioned over the scene).
 *
 * usePhotorealNotice runs on a tiny in-test hooks runtime (state slots by
 * call order, effects with deps and cleanups); window is an EventTarget and
 * sessionStorage a Map, so it runs as a plain function in the node env.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';

interface EffectSlot {
  deps?: readonly unknown[];
  cleanup?: () => void;
}

const h = vi.hoisted(() => ({ slots: new Map<number, unknown>(), i: 0 }));

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
    useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
      const i = h.i++;
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
    useMemo: <T,>(fn: () => T) => fn(),
  };
  return { ...react, ...hooks, default: { ...react, ...hooks } };
});

import {
  FALLBACK_DISMISS_KEY,
  NOTICE_COPY,
  PhotorealNoticeView,
  UPGRADE_DISMISS_KEY,
  photorealNotice,
  usePhotorealNotice,
  type PhotorealNoticeState,
} from './PhotorealNotice';
import { IMAGERY_FALLBACK_EVENT } from '@/lib/imageryFallback';
import { RideSettingsHost } from './RideTools';

let win: EventTarget;
let store: Map<string, string>;

/** Render the hook once (state carries over between calls, like re-renders). */
function useRender(hasToken: boolean) {
  h.i = 0;
  return usePhotorealNotice(hasToken);
}
const render = useRender;

/** Unmount: run every effect cleanup and forget the state (a fresh mount next). */
function unmount(): void {
  for (const v of h.slots.values()) (v as EffectSlot | undefined)?.cleanup?.();
  h.slots.clear();
}

beforeEach(() => {
  win = new EventTarget();
  store = new Map();
  vi.stubGlobal('window', win);
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
});

describe('photorealNotice(): which notice shows', () => {
  const base = { hasToken: false, fallbackSeen: false, upgradeDismissed: false, fallbackDismissed: false };

  it('no token: the upgrade pitch, until dismissed', () => {
    expect(photorealNotice(base)).toBe('upgrade');
    expect(photorealNotice({ ...base, upgradeDismissed: true })).toBeNull();
  });

  it('no token: an imagery fallback has nothing to fall back from, the pitch stays', () => {
    expect(photorealNotice({ ...base, fallbackSeen: true })).toBe('upgrade');
    expect(photorealNotice({ ...base, fallbackSeen: true, upgradeDismissed: true })).toBeNull();
  });

  it('a token: nothing, unless the imagery fell back (then the outage notice, until dismissed)', () => {
    expect(photorealNotice({ ...base, hasToken: true })).toBeNull();
    expect(photorealNotice({ ...base, hasToken: true, fallbackSeen: true })).toBe('fallback');
    expect(photorealNotice({ ...base, hasToken: true, fallbackSeen: true, fallbackDismissed: true })).toBeNull();
    // Dismissing the pitch never hides the outage notice.
    expect(photorealNotice({ ...base, hasToken: true, fallbackSeen: true, upgradeDismissed: true })).toBe('fallback');
  });
});

describe('usePhotorealNotice', () => {
  it('no token: the pitch; × hides it for the rest of the session (a new mount stays hidden)', () => {
    const n = render(false);
    expect(n?.kind).toBe('upgrade');
    n!.onDismiss();
    expect(store.has(UPGRADE_DISMISS_KEY)).toBe(true);
    expect(store.has(FALLBACK_DISMISS_KEY)).toBe(false);
    expect(render(false)).toBeNull();
    unmount();
    expect(render(false)).toBeNull();
  });

  it('a token: the fallback notice appears on the imagery-fallback event, and × hides only it', () => {
    expect(render(true)).toBeNull();
    win.dispatchEvent(new Event(IMAGERY_FALLBACK_EVENT));
    const n = render(true);
    expect(n?.kind).toBe('fallback');
    n!.onDismiss();
    expect(store.has(FALLBACK_DISMISS_KEY)).toBe(true);
    expect(store.has(UPGRADE_DISMISS_KEY)).toBe(false);
    expect(render(true)).toBeNull();
  });

  it('listens once per mount and stops listening when the ride unmounts', () => {
    const add = vi.spyOn(win, 'addEventListener');
    const remove = vi.spyOn(win, 'removeEventListener');
    render(true);
    render(true);
    expect(add).toHaveBeenCalledTimes(1);
    const [type, handler] = add.mock.calls[0];
    expect(type).toBe(IMAGERY_FALLBACK_EVENT);
    unmount();
    expect(remove).toHaveBeenCalledWith(IMAGERY_FALLBACK_EVENT, handler);
  });

  it('the pitch opens Settings on the Visual tab (where the ion token goes)', () => {
    const seen: unknown[] = [];
    win.addEventListener('globeride:open-settings', (e) => seen.push((e as CustomEvent).detail));
    render(false)!.onOpenSettings();
    expect(seen).toEqual([{ tab: 'visual' }]);
  });
});

describe('RideSettingsHost: the sheet the notice opens, with the HUD collapsed', () => {
  // On main the only ride listener sat in the ride tools' menu, mounted only
  // with the details open, so the banner's Settings link opened nothing
  // while the banner showed (collapsed HUD): 0 dialogs after a real click.
  type Sheet = ReactElement<{ open: boolean; initialTab: string; onClose: () => void }>;
  const host = (): Sheet => {
    h.i = 0;
    return RideSettingsHost() as Sheet;
  };

  it('closed until the notice asks; then open on the Visual tab; closing it closes it', () => {
    expect(host().props.open).toBe(false);
    render(false)!.onOpenSettings();
    const open = host();
    expect(open.props.open).toBe(true);
    expect(open.props.initialTab).toBe('visual');
    open.props.onClose();
    expect(host().props.open).toBe(false);
  });

  it('an event without a tab opens the rider tab; the listener goes with the HUD', () => {
    const remove = vi.spyOn(win, 'removeEventListener');
    host();
    win.dispatchEvent(new CustomEvent('globeride:open-settings'));
    expect(host().props.initialTab).toBe('rider');
    unmount();
    expect(remove).toHaveBeenCalledWith('globeride:open-settings', expect.any(Function));
  });
});

/** Every element in a tree (props.children walked). */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [el, ...elements(el.props.children as ReactNode)];
}

const classes = (el: ReactElement<Record<string, unknown>>) => String(el.props.className ?? '').split(/\s+/);

function pill(kind: PhotorealNoticeState['kind']) {
  const fx = { onOpenSettings: vi.fn(), onDismiss: vi.fn() };
  const root = PhotorealNoticeView({ kind, ...fx }) as ReactElement<Record<string, unknown>>;
  const all = elements(root);
  const buttons = all.filter((e) => e.type === 'button');
  return { root, all, buttons, fx };
}

describe('PhotorealNoticeView: one h-10 line in the chip lane', () => {
  it('the pitch: an h-10 HUD pill whose text opens Settings; × dismisses (both 40 px targets)', () => {
    const { root, buttons, fx } = pill('upgrade');
    expect(root.props['data-testid']).toBe('photoreal-notice');
    expect(root.props.role).toBe('status');
    expect(classes(root)).toEqual(expect.arrayContaining(['hud-surface', 'h-10', 'inline-flex', 'pointer-events-auto', 'text-sm']));
    expect(buttons).toHaveLength(2);
    const [go, x] = buttons;
    expect(go.props['aria-label']).toBe(NOTICE_COPY.upgrade.aria);
    // h-10 like the chip (h-full would be 38 px inside the pill's border).
    expect(classes(go)).toContain('h-10');
    (go.props.onClick as () => void)();
    expect(fx.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(fx.onDismiss).not.toHaveBeenCalled();
    expect(x.props['aria-label']).toBe('Dismiss photoreal upgrade banner');
    expect(classes(x)).toEqual(expect.arrayContaining(['h-10', 'w-10']));
    (x.props.onClick as () => void)();
    expect(fx.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('the fallback: a status line and × only (no Settings action)', () => {
    const { root, buttons, all } = pill('fallback');
    expect(root.props['data-kind']).toBe('fallback');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].props['aria-label']).toBe('Dismiss photoreal-unavailable notice');
    expect(all.some((e) => e.props.children === NOTICE_COPY.fallback.line)).toBe(true);
  });

  it('one line: the text never wraps (truncate = nowrap + ellipsis), one copy on every viewport', () => {
    for (const kind of ['upgrade', 'fallback'] as const) {
      const { all } = pill(kind);
      const text = all.filter((e) => e.props['data-notice-text'] !== undefined);
      expect(text).toHaveLength(1);
      expect(classes(text[0])).toContain('truncate');
      expect(text[0].props.children).toBe(NOTICE_COPY[kind].line);
      // No responsive copy swap: a longer sm+ line reached the rider at 1440.
      expect(all.some((e) => /\bsm:(hidden|inline)\b/.test(String(e.props.className ?? '')))).toBe(false);
    }
  });

  it('the copy stays short: about 300 px at 390 keeps band + pill within the 15 % budget', () => {
    // Band 366x98 = 10.9 % of 390x844; the pill is 40 px tall, so it may be
    // ~337 px wide at most. 30 characters of text-sm semibold measure 294 px.
    expect(NOTICE_COPY.upgrade.line.length).toBeLessThanOrEqual(30);
    expect(NOTICE_COPY.fallback.line.length).toBeLessThanOrEqual(30);
  });

  it('a flow item: never positioned over the scene, no blur over the live canvas', () => {
    for (const kind of ['upgrade', 'fallback'] as const) {
      const cls = pill(kind).all.flatMap(classes);
      for (const banned of ['absolute', 'fixed', 'left-1/2', 'ride-banner-float', 'backdrop-blur-md', 'glass']) {
        expect(cls, banned).not.toContain(banned);
      }
    }
  });
});
