/**
 * 10-foot layout switch (UI-RULES §5 TV addendum, docs/design/v2-identity.md §4).
 *
 * Sets `html[data-layout="tv"]`, which makes the root font 175 % (1rem = 28 px
 * on a 1920×1080 TV) so every rem token scales together, and enables the
 * `tv:` Tailwind variant for the rare layout-only tweak.
 *
 * Interim rule until P3.3 (`useLayoutMode`): TV when the viewport is at least
 * 1600 px wide AND the device has no fine pointer (a TV browser, not a laptop
 * with a mouse), or when the page was opened with `?layout=tv`. The query is
 * remembered for the session; `?layout=default` clears it.
 */

export type LayoutMode = 'tv' | 'default';

const SESSION_KEY = 'velo.layout';
export const TV_MEDIA_QUERY = '(min-width: 1600px) and (not (any-pointer: fine))';

export interface LayoutInputs {
  /** Value of the `layout` query parameter, if any. */
  query: string | null;
  /** Value remembered for this session, if any. */
  stored: string | null;
  /** The TV media query matches (wide screen, no fine pointer). */
  tvScreen: boolean;
}

/** Pure decision, so the rule is testable without a DOM. */
export function resolveLayout({ query, stored, tvScreen }: LayoutInputs): LayoutMode {
  if (query === 'tv' || query === 'default') return query;
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

/**
 * Apply the layout now and keep it in step with the media query.
 * Returns a cleanup function (used by tests).
 */
export function installTvLayout(win: Window = window): () => void {
  const query = new URLSearchParams(win.location.search).get('layout');
  if (query === 'tv' || query === 'default') writeSession(win, query);
  const mq = typeof win.matchMedia === 'function' ? win.matchMedia(TV_MEDIA_QUERY) : null;

  const apply = () => {
    const mode = resolveLayout({ query, stored: readSession(win), tvScreen: mq?.matches ?? false });
    const root = win.document.documentElement;
    if (mode === 'tv') root.setAttribute('data-layout', 'tv');
    else root.removeAttribute('data-layout');
  };

  apply();
  mq?.addEventListener?.('change', apply);
  return () => mq?.removeEventListener?.('change', apply);
}
