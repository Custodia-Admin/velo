/**
 * Ride-time keyboard shortcuts.
 *
 *  Space      pause / resume       (running ↔ paused)
 *  Escape     two-step finish      (running → paused → finished)
 *  ? / Shift+/ toggle help overlay (caller-controlled via onToggleHelp)
 *  h          toggle help overlay  (alias for `?` without Shift)
 *  - or [     one gear easier      (also _ and numpad -)
 *  = or ]     one gear harder      (also + and numpad +)
 *
 * The gear keys always work, with or without handlebar controls (the
 * on-screen gear buttons do the same), so a rider is never stuck in a gear.
 *
 * Skips when the focus is in a form input or contentEditable so the
 * shortcuts never hijack typing — keeps the Settings panel and the
 * workout-builder name field usable while a ride is paused.
 */

import { useEffect } from 'react';
import { useRideStore } from '@/stores/rideStore';
import { useControllerStore } from '@/stores/controllerStore';
import { isNavBack } from '@/lib/tv/remoteNav';

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

/** Gear keys: -1 one gear easier, +1 one gear harder. */
export const GEAR_KEYS: Readonly<Record<string, 1 | -1>> = {
  '-': -1,
  _: -1,
  '[': -1,
  '=': 1,
  '+': 1,
  ']': 1,
};

/**
 * One keyboard / on-screen shift. False when gears do nothing right now (ERG
 * holds the power; before the ride or after it). True when it was handled,
 * even at the end of the range.
 */
export function shiftFromScreen(delta: 1 | -1): boolean {
  const ride = useRideStore.getState();
  if (ride.trainerControlMode === 'erg') return false;
  if (ride.rideState === 'finished' || ride.rideState === 'idle') return false;
  useControllerStore.getState().shiftManual(delta);
  return true;
}

/**
 * The ride's window keydown handler (pure apart from the stores, so tests can
 * hand it events without a DOM).
 */
export function rideKeyHandler(onToggleHelp?: () => void): (e: KeyboardEvent) => void {
  return function onKey(e: KeyboardEvent) {
    // Let the browser handle Cmd/Ctrl/Alt-stacked combos (copy/paste/etc).
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // A handlebar Back press (B) closes what is open; it never pauses or
    // finishes the ride.
    if (isNavBack(e)) return;
    if (isTypingTarget(e.target)) return;

    const ride = useRideStore.getState();
    const state = ride.rideState;

    // Space — toggle pause/resume.
    if (e.key === ' ' || e.key === 'Spacebar') {
      if (state === 'running') {
        e.preventDefault();
        ride.pause();
      } else if (state === 'paused') {
        e.preventDefault();
        ride.resume();
      }
      return;
    }

    // Escape — two-step finish: running → pause first, then paused → finish.
    if (e.key === 'Escape') {
      if (state === 'running') {
        e.preventDefault();
        ride.pause();
      } else if (state === 'paused') {
        e.preventDefault();
        ride.finish();
      }
      return;
    }

    // - [ easier gear, = ] harder (the shortcut overlay lists them).
    const gear = GEAR_KEYS[e.key];
    if (gear) {
      if (shiftFromScreen(gear)) e.preventDefault();
      return;
    }

    // `?` (Shift+/) or plain `h` — toggle the help overlay.
    if (onToggleHelp && (e.key === '?' || e.key === 'h' || e.key === 'H')) {
      e.preventDefault();
      onToggleHelp();
    }
  };
}

export function useRideKeyboardShortcuts({
  onToggleHelp,
}: { onToggleHelp?: () => void } = {}): void {
  useEffect(() => {
    const onKey = rideKeyHandler(onToggleHelp);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onToggleHelp]);
}
