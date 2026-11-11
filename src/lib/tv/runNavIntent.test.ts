/**
 * Handlebar intents (lib/tv/runNavIntent) on top of a mocked focus layer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({
  input: false,
  focused: null as { matches: (sel: string) => boolean } | null,
  activateFocused: vi.fn(() => true),
  focusPrimary: vi.fn(() => true),
  moveFocus: vi.fn(() => true),
  sendBack: vi.fn(() => false),
}));

vi.mock('./remoteNav', () => ({
  remoteInput: () => nav.input,
  markRemoteInput: () => {
    nav.input = true;
  },
  focusedControl: () => nav.focused,
  activateFocused: () => nav.activateFocused(),
  focusPrimary: () => nav.focusPrimary(),
  moveFocus: (d: string) => nav.moveFocus(d),
  sendBack: () => nav.sendBack(),
}));

import { runNavIntent } from './runNavIntent';
import { useRideStore } from '@/stores/rideStore';

/** A control with DOM focus; `ring` = it matches :focus-visible (the browser draws the ring). */
const control = (ring: boolean) => ({ matches: (sel: string) => ring && sel === ':focus-visible' });

describe('runNavIntent select on a paused ride', () => {
  const resume = vi.fn();
  beforeEach(() => {
    nav.input = false;
    nav.focused = null;
    nav.activateFocused.mockClear();
    nav.focusPrimary.mockClear();
    resume.mockClear();
    useRideStore.setState({ rideState: 'paused', resume });
  });

  it('a control a mouse click focused (no ring showing) is not pressed: A carries on', () => {
    nav.focused = control(false);
    runNavIntent('select', { inRide: true });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(nav.activateFocused).not.toHaveBeenCalled();
  });

  it('with the ring showing (remote input, or :focus-visible) A presses the ringed control', () => {
    nav.input = true;
    nav.focused = control(false);
    runNavIntent('select', { inRide: true });
    expect(nav.activateFocused).toHaveBeenCalledTimes(1);

    nav.input = false;
    nav.focused = control(true);
    runNavIntent('select', { inRide: true });
    expect(nav.activateFocused).toHaveBeenCalledTimes(2);
    expect(resume).not.toHaveBeenCalled();
  });
});
