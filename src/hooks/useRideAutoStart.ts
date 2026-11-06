import { useEffect, useRef } from 'react';

import { holdStart, START_DELAY_MS, START_HOLD_POLL_MS } from '@/lib/ride/startHold';
import type { WorldRenderer } from '@/lib/world/renderer';
import { useRideStore } from '@/stores/rideStore';
import type { RideMode, RideState, Route } from '@/types';

export interface RideAutoStartInput {
  /** The ride was opened with `{ state: { autoStart: true } }` (Home, the setup wizard). */
  wantsAutoStart: boolean;
  /** Set once the world view has painted its first frame. */
  worldRenderer: WorldRenderer | null;
  route: Route | null;
  rideMode: RideMode;
  rideState: RideState;
}

/**
 * Starts the ride by itself when it was opened with autoStart, once the
 * world is up: the renderer has painted (so the camera doesn't jump from the
 * fly-in to the chase pose mid-transition), START_DELAY_MS have passed (the
 * rider sees the route and the chase angle for a beat), and the renderer's
 * ground under the rider is ready or the start hold ran out
 * (lib/ride/startHold). Fires once per ride view, from 'ready' (or 'idle');
 * the hold's clock starts with the first renderer and survives the re-runs
 * state changes cause.
 */
export function useRideAutoStart({ wantsAutoStart, worldRenderer, route, rideMode, rideState }: RideAutoStartInput): void {
  const consumedRef = useRef(false);
  const heldSinceRef = useRef<number | null>(null);
  useEffect(() => {
    if (consumedRef.current) return;
    if (!wantsAutoStart) return;
    if (!worldRenderer) return;
    if (!route && rideMode !== 'outdoor') return;
    if (rideState === 'running' || rideState === 'paused' || rideState === 'finished') return;
    heldSinceRef.current ??= Date.now();
    const heldSince = heldSinceRef.current;
    let t: ReturnType<typeof setTimeout>;
    const tryStart = () => {
      if (holdStart(worldRenderer, Date.now() - heldSince)) {
        t = setTimeout(tryStart, START_HOLD_POLL_MS);
        return;
      }
      consumedRef.current = true;
      const st = useRideStore.getState();
      // A loaded route should already be 'ready': setRoute, reset and
      // prepare all end there, and no store action leaves a route in 'idle'.
      // If a store ever is 'idle' with a route, re-set it (same route ref →
      // 'ready', clean slate) before starting.
      if (st.route && st.rideState !== 'ready' && st.rideState !== 'running') {
        st.setRoute(st.route);
      }
      useRideStore.getState().start();
    };
    t = setTimeout(tryStart, START_DELAY_MS);
    return () => clearTimeout(t);
  }, [wantsAutoStart, worldRenderer, route, rideMode, rideState]);
}
