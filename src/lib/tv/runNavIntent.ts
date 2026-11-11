/**
 * Carry out a navigation intent from the handlebars (P3.3 TV mode; the
 * mapping is src/lib/tv/handlebarNav.ts). Keys and the TV remote reach the
 * same moves through src/hooks/useRemoteNavigation.ts.
 */

import { useRideHudStore } from '@/stores/rideHudStore';
import { useRideStore } from '@/stores/rideStore';
import type { NavIntent } from './handlebarNav';
import { activateFocused, focusPrimary, markRemoteInput, moveFocus, sendBack } from './remoteNav';

export interface NavIntentOptions {
  /** The Ride page is open. */
  inRide: boolean;
  /** Off the ride, when Back finds nothing open to close (e.g. Devices → Home). */
  backPage?: () => void;
}

export function runNavIntent(intent: NavIntent, { inRide, backPage }: NavIntentOptions): void {
  markRemoteInput();
  switch (intent) {
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      moveFocus(intent);
      return;
    case 'select': {
      if (activateFocused()) return;
      // Nothing ringed: a paused ride carries on (A has always done that);
      // elsewhere the first press rings the view's primary control.
      const ride = useRideStore.getState();
      if (inRide && ride.rideState === 'paused') ride.resume();
      else focusPrimary();
      return;
    }
    case 'back': {
      if (sendBack()) return;
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
