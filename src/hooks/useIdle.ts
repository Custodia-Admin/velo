import { useEffect, useState } from 'react';

const WAKE_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * True after `idleMs` without pointer, touch or key input while `enabled`.
 * Any input wakes it straight away. Used by show mode to fade the HUD.
 */
export function useIdle(enabled: boolean, idleMs = 4000): boolean {
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setIdle(false);
      return;
    }
    let timer = window.setTimeout(() => setIdle(true), idleMs);
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), idleMs);
    };
    for (const e of WAKE_EVENTS) window.addEventListener(e, wake, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const e of WAKE_EVENTS) window.removeEventListener(e, wake);
    };
  }, [enabled, idleMs]);

  return enabled && idle;
}
