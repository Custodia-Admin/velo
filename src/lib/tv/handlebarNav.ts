/**
 * What a handlebar button does outside the ride map (P3.3 TV mode). On a TV
 * the Zwift Ride handlebars are the remote, so menus (Home, Devices, a paused
 * ride, the finish page) take the D-pad, A and B, and Y opens the ride
 * details at any time in a ride.
 *
 * The ride map (src/lib/controllers/controllerActions.ts, P2.5) is unchanged
 * and keeps everything it maps while riding: gears, hills, camera, A to pause.
 * This layer only claims buttons the ride map leaves free in that state, or
 * states where the ride map has nothing to do:
 *
 *   - off the ride (Home, Devices): D-pad moves the focus ring, A presses the
 *     ringed button, B goes back;
 *   - riding: Y toggles the ride details, B closes what is open (devices
 *     sheet, tools menu, Settings, the details); the rest is the ride map;
 *   - ready or paused: the D-pad and A become the menu too (A with nothing
 *     ringed still carries on, as before); shifting and the hood buttons stay
 *     with the ride map;
 *   - finished: the finish page is a menu; nothing else acts behind it;
 *   - show mode: Y, Z and B belong to the video player, as before.
 */

import type { RideButton } from '@/lib/controllers/rideProtocol';
import { SHOW_BUTTON_ACTIONS, type LegendRow } from '@/lib/controllers/controllerActions';
import type { Direction } from './spatialNav';

export type NavIntent = Direction | 'select' | 'back' | 'details';

export interface HandlebarNavContext {
  /** The Ride page is open (the ride session). */
  inRide: boolean;
  /** rideStore.rideState. */
  rideState: string;
  /** Show mode (watching your own videos) is on. */
  show: boolean;
}

const MENU: Readonly<Partial<Record<RideButton, NavIntent>>> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  a: 'select',
  b: 'back',
};

/**
 * The navigation intent for a button press, 'swallow' when the press must do
 * nothing at all, or null when the ride map (actionFor) should have it.
 */
export function handlebarIntent(button: RideButton, ctx: HandlebarNavContext): NavIntent | 'swallow' | null {
  if (!ctx.inRide) return MENU[button] ?? null;
  if (ctx.show && SHOW_BUTTON_ACTIONS[button]) return null;
  switch (ctx.rideState) {
    case 'finished':
      return MENU[button] ?? 'swallow';
    case 'ready':
    case 'paused':
      if (button === 'y') return 'details';
      return MENU[button] ?? null;
    default:
      if (button === 'y') return 'details';
      if (button === 'b') return 'back';
      return null;
  }
}

/** Legend rows for the handlebar row's "What the buttons do". */
export const MENU_LEGEND: ReadonlyArray<LegendRow> = [
  { controls: 'D-pad', action: 'Move the ring between buttons' },
  { controls: 'A', action: 'Press the ringed button' },
  { controls: 'B', action: 'Back: close what is open' },
  { controls: 'Y', action: 'Ride details, open or closed (while riding too)' },
];
