/**
 * 10-foot layout switch (UI-RULES §5 TV addendum, docs/design/v2-identity.md §4).
 *
 * Sets `html[data-layout="tv"]`, which scales the root font (1rem = 28 px on a
 * 1920×1080 TV, 56 px on a browser that reports 3840×2160) so every rem token
 * scales together, keeps the HUD and pages inside the TV's overscan frame, and
 * enables the `tv:` Tailwind variant for the rare layout-only tweak.
 *
 * When (P3.3, `useLayoutMode`):
 *   1. `?layout=tv|default` on this page load (screenshots, a one-off check);
 *   2. the rider's choice in Settings → Visual → Layout, unless it is Auto;
 *   3. a `?layout=` from earlier in this tab (the router drops the query);
 *   4. Auto: the screen is at least 1600 CSS px wide AND nothing on the device
 *      is a fine pointer (a TV browser, not a laptop with a mouse or touchpad).
 *      An Android tablet is a coarse-pointer device too, so it gets the TV
 *      layout only from 1600 px up.
 */

export type LayoutMode = 'tv' | 'default';
/** The Settings choice: Auto follows the screen. */
export type LayoutPreference = 'auto' | LayoutMode;

export const LAYOUT_PREFERENCES: readonly LayoutPreference[] = ['auto', 'tv', 'default'];
export const DEFAULT_LAYOUT_PREFERENCE: LayoutPreference = 'auto';

export function isLayoutPreference(v: unknown): v is LayoutPreference {
  return v === 'auto' || v === 'tv' || v === 'default';
}

const SESSION_KEY = 'velo.layout';
/** The narrowest viewport (CSS px) the Auto rule treats as a TV. */
export const TV_MIN_WIDTH = 1600;
export const TV_MEDIA_QUERY = `(min-width: ${TV_MIN_WIDTH}px) and (not (any-pointer: fine))`;

/**
 * The Auto rule on plain numbers, the same rule as {@link TV_MEDIA_QUERY}:
 * wide enough and no fine pointer anywhere on the device.
 */
export function isTvScreen(screen: { width: number; anyFinePointer: boolean }): boolean {
  return screen.width >= TV_MIN_WIDTH && !screen.anyFinePointer;
}

export interface LayoutInputs {
  /** Value of the `layout` query parameter, if any. */
  query: string | null;
  /** Value remembered for this session, if any. */
  stored: string | null;
  /** The rider's Settings choice (Auto when unset). */
  preference?: LayoutPreference;
  /** The TV media query matches (wide screen, no fine pointer). */
  tvScreen: boolean;
}

/** Pure decision, so the rule is testable without a DOM. */
export function resolveLayout({ query, stored, preference = 'auto', tvScreen }: LayoutInputs): LayoutMode {
  if (query === 'tv' || query === 'default') return query;
  if (preference === 'tv' || preference === 'default') return preference;
  if (stored === 'tv' || stored === 'default') return stored;
  return tvScreen ? 'tv' : 'default';
}

function readSession(win: Window): string | null {
  try {
    return win.sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function writeSession(win: Window, value: string): void {
  try {
    win.sessionStorage.setItem(SESSION_KEY, value);
  } catch {
    // Private mode etc.: the query still applies for this page load.
  }
}

/** This page's `?layout=`, remembered for the tab (the router drops the query). */
export function readLayoutQuery(win: Window): string | null {
  const query = new URLSearchParams(win.location.search).get('layout');
  if (query === 'tv' || query === 'default') writeSession(win, query);
  return query;
}

export function tvMediaQuery(win: Window): MediaQueryList | null {
  return typeof win.matchMedia === 'function' ? win.matchMedia(TV_MEDIA_QUERY) : null;
}

/** The mode for this window and Settings choice, right now. */
export function currentLayout(win: Window, preference: LayoutPreference, tvScreen?: boolean): LayoutMode {
  return resolveLayout({
    query: readLayoutQuery(win),
    stored: readSession(win),
    preference,
    tvScreen: tvScreen ?? tvMediaQuery(win)?.matches ?? false,
  });
}

/** Put the mode on `<html>`. */
export function applyLayout(root: HTMLElement, mode: LayoutMode): void {
  if (mode === 'tv') root.setAttribute('data-layout', 'tv');
  else root.removeAttribute('data-layout');
}

/**
 * Apply the layout before React renders (main.tsx), so a TV never paints the
 * desktop layout first. `useLayoutMode` (mounted by App) keeps it in step.
 */
export function installTvLayout(preference: LayoutPreference, win: Window = window): void {
  applyLayout(win.document.documentElement, currentLayout(win, preference));
}
