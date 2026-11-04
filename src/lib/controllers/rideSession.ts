/**
 * The ride session: from the moment the rider opens a ride until they leave
 * it. Devices may act on their own (auto-reconnect, wake reconnect, gear
 * buzz) only inside it; outside it every Bluetooth write comes from a tap
 * (Pair, Reconnect, Test buzz).
 *
 * The Ride page retains the session while it is mounted. A counter, not a
 * flag, so a StrictMode mount → unmount → mount replay never closes it.
 */

let views = 0;
const listeners = new Set<(active: boolean) => void>();

function emit(): void {
  const active = views > 0;
  for (const fn of [...listeners]) fn(active);
}

/** Call when a ride view mounts; returns the matching release. */
export function retainRideSession(): () => void {
  views += 1;
  if (views === 1) emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    views -= 1;
    if (views === 0) emit();
  };
}

/** True while the rider is in a ride (the Ride page is mounted). */
export function rideSessionActive(): boolean {
  return views > 0;
}

/** Called with true when a ride opens and false when the last one closes. */
export function onRideSession(listener: (active: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests only: close the session. Module-level subscribers stay subscribed. */
export function __resetRideSessionForTests(): void {
  const wasActive = views > 0;
  views = 0;
  if (wasActive) emit();
}
