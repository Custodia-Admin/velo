/**
 * Remote navigation, app-wide (P3.3 TV mode). Mounted once by App.
 *
 * - Arrow keys (a TV remote's D-pad sends them) move the focus ring to the
 *   nearest control that way (src/lib/tv/spatialNav.ts). In the TV layout
 *   always; elsewhere only once a control has the keyboard focus, so arrows
 *   still scroll a page nobody has tabbed into. Enter presses the ringed
 *   button (the browser does that).
 * - Back: a remote's Back key acts as Escape. Off the ride, an Escape that no
 *   open panel took goes back a page (Devices → Home).
 * - Handlebar buttons off the ride (Home, Devices) move the ring, press, go
 *   back. On the Ride page useRideControllerActions owns every press.
 * - Keys, the remote and the handlebars set "remote input" so index.css draws
 *   the ring on whatever has focus; a pointer clears it.
 */

import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { rideSessionActive } from '@/lib/controllers/rideSession';
import { handlebarIntent } from '@/lib/tv/handlebarNav';
import {
  clearRemoteInput,
  dialogOpen,
  focusedControl,
  isNavBack,
  markRemoteInput,
  moveFocus,
  usesArrowKeys,
} from '@/lib/tv/remoteNav';
import { runNavIntent } from '@/lib/tv/runNavIntent';
import type { Direction } from '@/lib/tv/spatialNav';

const ARROWS: Readonly<Record<string, Direction>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

/** keyCodes of TV-browser Back keys that carry no standard `key` (webOS 461, Tizen 10009). */
const BACK_KEY_CODES = new Set([461, 10009]);

export function isRemoteBackKey(e: Pick<KeyboardEvent, 'key' | 'keyCode'>): boolean {
  return e.key === 'GoBack' || e.key === 'BrowserBack' || BACK_KEY_CODES.has(e.keyCode);
}

const NAV_KEYS = new Set(['Tab', 'Enter', 'Escape', ' ', ...Object.keys(ARROWS)]);

/** Where Back goes from a page when nothing is open to close; null to stay. */
export function backPageFor(pathname: string): string | null {
  return pathname === '/devices' ? '/app' : null;
}

export function useRemoteNavigation(): void {
  const navigate = useNavigate();
  const location = useLocation();
  // Read at press time (the listeners are installed once).
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;

  useEffect(() => {
    const goBackPage = () => {
      const to = backPageFor(pathRef.current);
      if (to) navigate(to);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isNavBack(e)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (isRemoteBackKey(e)) {
        markRemoteInput();
        e.preventDefault();
        // The same as Escape for everything that listens (panels, the ride).
        const esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
        const target = (document.activeElement as HTMLElement | null) ?? document.body;
        target.dispatchEvent(esc);
        return;
      }

      if (NAV_KEYS.has(e.key)) markRemoteInput();

      if (e.key === 'Escape') {
        // An open panel stops Escape before it gets here; the ride has its own.
        // A dialog that lets it through (the pairing guide listens on the
        // window too, after this) still keeps the page: this Escape is its.
        if (e.defaultPrevented || rideSessionActive() || dialogOpen()) return;
        goBackPage();
        return;
      }

      const dir = ARROWS[e.key];
      if (!dir || e.defaultPrevented || e.shiftKey) return;
      if (usesArrowKeys(e.target as Element | null)) return;
      const tv = document.documentElement.getAttribute('data-layout') === 'tv';
      const focused = focusedControl();
      if (!tv && !(focused && focused.matches(':focus-visible'))) return;
      e.preventDefault();
      moveFocus(dir);
    };

    const onPointerDown = () => clearRemoteInput();

    // The Bluetooth controller module loads on demand (off the app shell).
    let offButtons: (() => void) | null = null;
    let disposed = false;
    void import('@/lib/controllers/rideController').then(({ onControllerButton }) => {
      if (disposed) return;
      offButtons = onControllerButton((button) => {
        if (rideSessionActive()) return;
        const intent = handlebarIntent(button, { inRide: false, rideState: 'idle', show: false });
        if (intent && intent !== 'swallow') runNavIntent(intent, { inRide: false, backPage: goBackPage });
      });
    });

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
      disposed = true;
      offButtons?.();
    };
  }, [navigate]);
}

/** Mounts {@link useRemoteNavigation} (App renders it once, inside the router). */
export function RemoteNavigationHost(): null {
  useRemoteNavigation();
  return null;
}
