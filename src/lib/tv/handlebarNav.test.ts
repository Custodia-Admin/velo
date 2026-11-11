import { describe, expect, it } from 'vitest';
import { actionFor } from '@/lib/controllers/controllerActions';
import { BUTTON_MASKS, type RideButton } from '@/lib/controllers/rideProtocol';
import { handlebarIntent, type HandlebarNavContext } from './handlebarNav';

const BUTTONS: RideButton[] = BUTTON_MASKS.map(([b]) => b);
const ctx = (rideState: string, extra: Partial<HandlebarNavContext> = {}): HandlebarNavContext => ({
  inRide: true,
  rideState,
  show: false,
  ...extra,
});

describe('handlebars as a remote (P3.3)', () => {
  it('off the ride: the D-pad moves the ring, A presses, B goes back, nothing else', () => {
    const off = { inRide: false, rideState: 'idle', show: false };
    expect(handlebarIntent('up', off)).toBe('up');
    expect(handlebarIntent('down', off)).toBe('down');
    expect(handlebarIntent('left', off)).toBe('left');
    expect(handlebarIntent('right', off)).toBe('right');
    expect(handlebarIntent('a', off)).toBe('select');
    expect(handlebarIntent('b', off)).toBe('back');
    for (const b of ['y', 'z', 'shiftUpL', 'shiftDownR', 'hoodL', 'powerL'] as RideButton[]) {
      expect(handlebarIntent(b, off), b).toBeNull();
    }
  });

  it('while riding the ride map keeps every button it maps (P2.5 unchanged)', () => {
    for (const b of BUTTONS) {
      if (actionFor(b, { show: false })) expect(handlebarIntent(b, ctx('running')), b).toBeNull();
    }
    for (const b of BUTTONS) {
      if (actionFor(b, { show: true })) expect(handlebarIntent(b, ctx('running', { show: true })), `show ${b}`).toBeNull();
    }
  });

  it('while riding, the free buttons: Y opens the ride details, B closes what is open', () => {
    expect(handlebarIntent('y', ctx('running'))).toBe('details');
    expect(handlebarIntent('b', ctx('running'))).toBe('back');
    expect(handlebarIntent('z', ctx('running'))).toBeNull();
  });

  it('paused (and ready): the D-pad and A are the menu; shifting and the hoods stay with the ride map', () => {
    for (const state of ['paused', 'ready']) {
      expect(handlebarIntent('left', ctx(state))).toBe('left');
      expect(handlebarIntent('up', ctx(state))).toBe('up');
      expect(handlebarIntent('a', ctx(state))).toBe('select');
      expect(handlebarIntent('b', ctx(state))).toBe('back');
      expect(handlebarIntent('y', ctx(state))).toBe('details');
      expect(handlebarIntent('shiftUpL', ctx(state))).toBeNull();
      expect(handlebarIntent('hoodR', ctx(state))).toBeNull();
    }
  });

  it('finished: the finish page is a menu and nothing acts behind it', () => {
    expect(handlebarIntent('right', ctx('finished'))).toBe('right');
    expect(handlebarIntent('a', ctx('finished'))).toBe('select');
    expect(handlebarIntent('b', ctx('finished'))).toBe('back');
    for (const b of ['shiftUpL', 'shiftDownR', 'hoodL', 'hoodR', 'y', 'z'] as RideButton[]) {
      expect(handlebarIntent(b, ctx('finished')), b).toBe('swallow');
    }
  });

  it('show mode: Y, Z and B stay with the video player, paused too', () => {
    for (const state of ['running', 'paused']) {
      expect(handlebarIntent('y', ctx(state, { show: true }))).toBeNull();
      expect(handlebarIntent('z', ctx(state, { show: true }))).toBeNull();
      expect(handlebarIntent('b', ctx(state, { show: true }))).toBeNull();
    }
    expect(handlebarIntent('a', ctx('paused', { show: true }))).toBe('select');
  });
});
