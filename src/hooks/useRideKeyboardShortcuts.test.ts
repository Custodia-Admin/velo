/**
 * Gears must never get stuck (12 Nov 2026: the owner ended a ride in gear
 * 11 / 11 with no way down). The keyboard and the on-screen gear buttons
 * always shift, with or without handlebar controls, and the whole range is
 * reachable both ways through the same store path the handlebars use.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GEAR_KEYS, rideKeyHandler, shiftFromScreen } from './useRideKeyboardShortcuts';
import { storeActionTarget } from './useRideControllerActions';
import { runControllerAction } from '@/lib/controllers/controllerActions';
import { activeGear, gearInUse, useControllerStore } from '@/stores/controllerStore';
import { useRideStore } from '@/stores/rideStore';
import { GEAR_COUNT, NEUTRAL_GEAR, clampGear, gearFactor } from '@/lib/virtualGears';
import { GearButton, tapGear } from '@/components/velo/RideStrip';
import { RideShortcutsHelp } from '@/components/ride/RideShortcutsHelp';

vi.mock('@/lib/controllers/rideController', () => ({
  onControllerButton: () => () => undefined,
  buzzRideController: vi.fn(),
}));

function key(k: string, extra: Partial<KeyboardEvent> = {}) {
  const e = { key: k, ctrlKey: false, metaKey: false, altKey: false, target: null, preventDefault: vi.fn(), ...extra };
  rideKeyHandler()(e as unknown as KeyboardEvent);
  return e;
}

const ctl = () => useControllerStore.getState();

beforeEach(() => {
  useRideStore.setState({ rideState: 'running', trainerControlMode: 'sim' });
  useControllerStore.setState({ status: 'connected', gear: NEUTRAL_GEAR, manualGear: false });
});

describe('virtual gears: order and clamping', () => {
  it('11 gears, 1 easiest to 11 hardest, each one harder than the last; clamps at both ends', () => {
    for (let g = 2; g <= GEAR_COUNT; g++) expect(gearFactor(g)).toBeGreaterThan(gearFactor(g - 1));
    expect(clampGear(0)).toBe(1);
    expect(clampGear(12)).toBe(GEAR_COUNT);
    useControllerStore.setState({ gear: GEAR_COUNT });
    expect(ctl().shift(1)).toBe(false);
    expect(ctl().gear).toBe(GEAR_COUNT);
  });

  it('gearEasier through the store (the handlebar path) walks 11 → 1, then stops without a buzz', () => {
    useControllerStore.setState({ gear: GEAR_COUNT });
    const buzz = vi.spyOn(storeActionTarget, 'buzzGear').mockImplementation(() => undefined);
    for (let i = 0; i < GEAR_COUNT - 1; i++) runControllerAction('gearEasier', storeActionTarget);
    expect(ctl().gear).toBe(1);
    expect(buzz).toHaveBeenCalledTimes(GEAR_COUNT - 1);
    runControllerAction('gearEasier', storeActionTarget);
    expect(ctl().gear).toBe(1);
    expect(buzz).toHaveBeenCalledTimes(GEAR_COUNT - 1);
    for (let i = 0; i < GEAR_COUNT - 1; i++) runControllerAction('gearHarder', storeActionTarget);
    expect(ctl().gear).toBe(GEAR_COUNT);
    buzz.mockRestore();
  });
});

describe('keyboard gear keys', () => {
  it('- _ [ are easier, = + ] harder', () => {
    expect(GEAR_KEYS).toEqual({ '-': -1, _: -1, '[': -1, '=': 1, '+': 1, ']': 1 });
  });

  it('- from gear 11 reaches gear 1 (and [ / ] / = work too)', () => {
    useControllerStore.setState({ gear: GEAR_COUNT });
    for (let i = 0; i < 12; i++) expect(key('-').preventDefault).toHaveBeenCalled();
    expect(ctl().gear).toBe(1);
    key(']');
    key('=');
    expect(ctl().gear).toBe(3);
    key('[');
    expect(ctl().gear).toBe(2);
    expect(activeGear()).toBe(2);
  });

  it('works without handlebar controls: the shift starts from the gear in use (neutral) and then applies', () => {
    useControllerStore.setState({ status: 'idle', gear: 9 }); // stale gear from an earlier link
    expect(activeGear()).toBe(NEUTRAL_GEAR);
    key('=');
    expect(ctl().gear).toBe(NEUTRAL_GEAR + 1);
    expect(activeGear()).toBe(NEUTRAL_GEAR + 1);
    useControllerStore.setState({ status: 'asleep' });
    expect(activeGear()).toBe(NEUTRAL_GEAR + 1);
  });

  it('works while paused and before the start; not in ERG, not on the finish page; never with Ctrl or in a text field', () => {
    useRideStore.setState({ rideState: 'paused' });
    key('=');
    useRideStore.setState({ rideState: 'ready' });
    key('=');
    expect(ctl().gear).toBe(NEUTRAL_GEAR + 2);
    useRideStore.setState({ rideState: 'running', trainerControlMode: 'erg' });
    expect(key('=').preventDefault).not.toHaveBeenCalled();
    useRideStore.setState({ rideState: 'finished', trainerControlMode: 'sim' });
    key('=');
    useRideStore.setState({ rideState: 'running' });
    key('=', { ctrlKey: true });
    key('=', { target: { tagName: 'INPUT' } as unknown as EventTarget });
    expect(ctl().gear).toBe(NEUTRAL_GEAR + 2);
  });

  it('Space still pauses (the gear keys took nothing from the other shortcuts)', () => {
    key(' ');
    expect(useRideStore.getState().rideState).toBe('paused');
  });

  it('the shortcut overlay lists the gear keys', () => {
    const out = renderToStaticMarkup(createElement(RideShortcutsHelp, { open: true, onClose: () => undefined }));
    expect(out).toContain('One gear easier');
    expect(out).toContain('One gear harder');
  });
});

describe('on-screen gear buttons', () => {
  /** Copy the props out of the (frozen) element GearButton returns. */
  const props = (delta: 1 | -1, gear: number) => ({ ...(GearButton({ delta, gear }).props as Record<string, unknown>) });

  it('easier / harder, labelled, disabled only at the end of the range', () => {
    expect(props(-1, 6)).toMatchObject({ 'aria-label': 'Easier gear', disabled: false });
    expect(props(1, 6)).toMatchObject({ 'aria-label': 'Harder gear', disabled: false });
    expect(props(-1, 1).disabled).toBe(true);
    expect(props(1, GEAR_COUNT).disabled).toBe(true);
    expect(props(-1, GEAR_COUNT).disabled).toBe(false);
  });

  it('tapping easier from 11 reaches 1 (pointer and touch both end in click)', () => {
    useControllerStore.setState({ gear: GEAR_COUNT });
    let gear = GEAR_COUNT;
    while (!props(-1, gear).disabled) {
      (props(-1, gear).onClick as () => void)();
      gear = ctl().gear;
    }
    expect(gear).toBe(1);
    tapGear(1);
    expect(ctl().gear).toBe(2);
  });

  it('gear rule: live controls or a keyboard / screen shift this ride, else neutral', () => {
    expect(gearInUse('connected', 9, false)).toBe(9);
    expect(gearInUse('asleep', 9, false)).toBe(NEUTRAL_GEAR);
    expect(gearInUse('asleep', 9, true)).toBe(9);
    expect(gearInUse('idle', 3, true)).toBe(3);
    ctl().resetGear();
    expect(ctl()).toMatchObject({ gear: NEUTRAL_GEAR, manualGear: false });
  });

  it('shiftFromScreen refuses in ERG (gears do nothing there)', () => {
    useRideStore.setState({ trainerControlMode: 'erg' });
    expect(shiftFromScreen(1)).toBe(false);
    expect(ctl().gear).toBe(NEUTRAL_GEAR);
  });
});
