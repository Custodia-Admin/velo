/**
 * useLayoutMode (P3.3 TV mode): when `<html data-layout="tv">` is on.
 *
 * The rule itself (src/lib/tvLayout.ts) is pure; the hook is driven here with
 * a stubbed window whose matchMedia evaluates TV_MEDIA_QUERY with the same
 * numbers a browser would use (width, any fine pointer), and a react mock
 * that runs effects at once (no DOM in this suite). The real browser's media
 * query is checked by e2e/tv-remote.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useEffect: (fn: () => void | (() => void)) => {
      fn();
    },
    useSyncExternalStore: <T,>(subscribe: (cb: () => void) => () => void, get: () => T) => {
      subscribe(() => {});
      return get();
    },
  };
});

const settings = { layoutMode: 'auto' as 'auto' | 'tv' | 'default' };
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: <T,>(sel: (s: typeof settings) => T) => sel(settings),
}));

import { useLayoutMode } from './useLayoutMode';
import { isTvScreen, resolveLayout, TV_MEDIA_QUERY } from '@/lib/tvLayout';

interface Screen {
  width: number;
  anyFinePointer: boolean;
}

/** A window stub: one screen, a URL, sessionStorage, and <html>'s attributes. */
function stubWindow(screen: Screen, search = '') {
  const attrs = new Map<string, string>();
  const session = new Map<string, string>();
  const listeners = new Set<() => void>();
  const mq = {
    get matches() {
      return isTvScreen(screen);
    },
    media: TV_MEDIA_QUERY,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  const root = {
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    removeAttribute: (k: string) => attrs.delete(k),
    getAttribute: (k: string) => attrs.get(k) ?? null,
  };
  const win = {
    location: { search },
    sessionStorage: {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => session.set(k, v),
    },
    matchMedia: (q: string) => {
      if (q !== TV_MEDIA_QUERY) throw new Error(`unexpected media query ${q}`);
      return mq;
    },
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', { documentElement: root });
  return {
    layout: () => attrs.get('data-layout') ?? null,
    listeners,
    setScreen: (s: Screen) => Object.assign(screen, s),
    navigate: (to: string) => (win.location.search = to),
  };
}

const TV: Screen = { width: 1920, anyFinePointer: false };
const LAPTOP_1920: Screen = { width: 1920, anyFinePointer: true };
const LAPTOP_1280: Screen = { width: 1280, anyFinePointer: true };
const TABLET_1280: Screen = { width: 1280, anyFinePointer: false };
const TABLET_1706: Screen = { width: 1706, anyFinePointer: false };

beforeEach(() => {
  settings.layoutMode = 'auto';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the TV rule (lib/tvLayout)', () => {
  it('a TV screen is at least 1600 px wide with no fine pointer anywhere', () => {
    expect(isTvScreen(TV)).toBe(true);
    expect(isTvScreen({ width: 1600, anyFinePointer: false })).toBe(true);
    expect(isTvScreen({ width: 1599, anyFinePointer: false })).toBe(false);
    expect(isTvScreen(LAPTOP_1920)).toBe(false);
  });

  it("the owner's Android tablet (coarse pointer) is not a TV below 1600 px", () => {
    expect(isTvScreen(TABLET_1280)).toBe(false);
    expect(isTvScreen({ width: 1366, anyFinePointer: false })).toBe(false);
    expect(isTvScreen(TABLET_1706)).toBe(true);
  });

  it('the media query says the same thing', () => {
    expect(TV_MEDIA_QUERY).toBe('(min-width: 1600px) and (not (any-pointer: fine))');
  });

  it('?layout= beats the Settings choice, which beats the session memory and the screen', () => {
    expect(resolveLayout({ query: 'default', stored: null, preference: 'tv', tvScreen: true })).toBe('default');
    expect(resolveLayout({ query: null, stored: 'tv', preference: 'default', tvScreen: true })).toBe('default');
    expect(resolveLayout({ query: null, stored: 'default', preference: 'tv', tvScreen: false })).toBe('tv');
    expect(resolveLayout({ query: null, stored: 'tv', preference: 'auto', tvScreen: false })).toBe('tv');
    expect(resolveLayout({ query: null, stored: null, preference: 'auto', tvScreen: true })).toBe('tv');
    expect(resolveLayout({ query: null, stored: null, preference: 'auto', tvScreen: false })).toBe('default');
  });
});

describe('useLayoutMode', () => {
  it('Auto on a TV: the TV layout, on <html>', () => {
    const w = stubWindow({ ...TV });
    expect(useLayoutMode()).toBe('tv');
    expect(w.layout()).toBe('tv');
  });

  it('Auto on a 1920 px laptop with a mouse or touchpad: the standard layout', () => {
    const w = stubWindow({ ...LAPTOP_1920 });
    expect(useLayoutMode()).toBe('default');
    expect(w.layout()).toBeNull();
  });

  it('Auto on the Android tablet: standard below 1600 px, TV from 1600 px', () => {
    const w = stubWindow({ ...TABLET_1280 });
    expect(useLayoutMode()).toBe('default');
    expect(w.layout()).toBeNull();
    w.setScreen({ ...TABLET_1706 });
    expect(useLayoutMode()).toBe('tv');
    expect(w.layout()).toBe('tv');
  });

  it('Settings → TV turns it on anywhere; Settings → Standard turns it off on a TV', () => {
    settings.layoutMode = 'tv';
    const laptop = stubWindow({ ...LAPTOP_1280 });
    expect(useLayoutMode()).toBe('tv');
    expect(laptop.layout()).toBe('tv');

    settings.layoutMode = 'default';
    const tv = stubWindow({ ...TV });
    expect(useLayoutMode()).toBe('default');
    expect(tv.layout()).toBeNull();
  });

  it('follows the screen: it listens to the media query and re-reads it', () => {
    const w = stubWindow({ ...LAPTOP_1920 });
    expect(useLayoutMode()).toBe('default');
    expect(w.listeners.size).toBeGreaterThan(0);
    // The mouse is unplugged from the TV box.
    w.setScreen({ ...TV });
    expect(useLayoutMode()).toBe('tv');
    expect(w.layout()).toBe('tv');
  });

  it('?layout=tv applies on a laptop and is remembered after the router drops the query', () => {
    const w = stubWindow({ ...LAPTOP_1920 }, '?layout=tv');
    expect(useLayoutMode()).toBe('tv');
    w.navigate('');
    expect(useLayoutMode()).toBe('tv');
    // A Settings choice still wins over the remembered query.
    settings.layoutMode = 'default';
    expect(useLayoutMode()).toBe('default');
    expect(w.layout()).toBeNull();
  });
});
