/**
 * Carry out a navigation intent from the handlebars (P3.3 TV mode; the
 * mapping is src/lib/tv/handlebarNav.ts). Keys and the TV remote reach the
 * same moves through src/hooks/useRemoteNavigation.ts.
 */

import { useRideHudStore } from '@/stores/rideHudStore';
import { useRideStore } from '@/stores/rideStore';
import type { NavIntent } from './handlebarNav';
import {
  activateFocused,
  dialogOpen,
  focusedControl,
  focusPrimary,
  markRemoteInput,
  moveFocus,
  remoteInput,
  sendBack,
} from './remoteNav';

export interface NavIntentOptions {
  /** The Ride page is open. */
  inRide: boolean;
  /** Off the ride, when Back finds nothing open to close (e.g. Devices → Home). */
  backPage?: () => void;
}

/**
 * The ring was on screen before this press: remote input was already on, or
 * the browser draws it (:focus-visible). A button keeps focus after a mouse
 * or touchpad click with no ring; that focus is not where A points.
 */
function ringShowing(): boolean {
  if (remoteInput()) return true;
  const el = focusedControl();
  if (!el) return false;
  try {
    return el.matches(':focus-visible');
  } catch {
    return false;
  }
}

export function runNavIntent(intent: NavIntent, { inRide, backPage }: NavIntentOptions): void {
  const ringed = ringShowing();
  markRemoteInput();
  switch (intent) {
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      moveFocus(intent);
      return;
    case 'select': {
      if (ringed && activateFocused()) return;
      // Nothing ringed (focus a click left counts as nothing): a paused ride
      // carries on (A has always done that);
      // elsewhere the first press rings the view's primary control.
      const ride = useRideStore.getState();
      if (inRide && ride.rideState === 'paused') ride.resume();
      else focusPrimary();
      return;
    }
    case 'back': {
      // A dialog takes Back and the page stays, also when its Escape
      // handler (the pairing guide's, on the window) lets the event through.
      // Read before the Escape closes it.
      const dialog = dialogOpen();
      if (sendBack() || dialog) return;
      if (inRide) {
        const hud = useRideHudStore.getState();
        if (hud.expanded) hud.setExpanded(false);
        return;
      }
      backPage?.();
      return;
    }
    case 'details':
      useRideHudStore.getState().toggleExpanded();
      return;
  }
}
