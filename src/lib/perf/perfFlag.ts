/**
 * The ?perf=1 switch for the ride view's performance overlay.
 *
 * The ride is reached by clicking a route on Home (the query string does not
 * follow) and a reload of /ride returns to Home, so the flag is remembered in
 * sessionStorage: ?perf=1 on any page turns the overlay on for the rest of
 * the browser session, ?perf=0 turns it off. main.tsx records the flag at
 * boot, before the router can drop the query.
 */

const PERF_FLAG_KEY = 'velo.perfOverlay';

type FlagStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function perfOverlayRequested(search: string, storage: FlagStorage | null): boolean {
  const flag = new URLSearchParams(search).get('perf');
  try {
    if (flag === '1') storage?.setItem(PERF_FLAG_KEY, '1');
    if (flag === '0') storage?.removeItem(PERF_FLAG_KEY);
    return flag === '1' || (flag !== '0' && storage?.getItem(PERF_FLAG_KEY) === '1');
  } catch {
    return flag === '1';
  }
}

function sessionStore(): FlagStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Whether the overlay is on for this page (reads and records the flag). */
export function perfOverlayEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return perfOverlayRequested(window.location.search, sessionStore());
}
