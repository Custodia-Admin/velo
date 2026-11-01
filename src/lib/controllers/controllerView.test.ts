import { describe, it, expect } from 'vitest';
import {
  chipView,
  controllerPhase,
  panelStatusLine,
  PAIR_OTHER_LABEL,
  RIGHT_SIDE_TEXT,
  UNLOCK_STEPS,
  UNLOCK_ONE_LINE,
  type ControllerViewState,
} from './controllerView';

const base: ControllerViewState = { status: 'connected', silent: false, side: 'left', inputSeen: false };

describe('controllerPhase', () => {
  it('maps every non-connected status straight through', () => {
    expect(controllerPhase({ ...base, status: 'idle' })).toBe('none');
    expect(controllerPhase({ ...base, status: 'connecting' })).toBe('pairing');
    expect(controllerPhase({ ...base, status: 'reconnecting' })).toBe('reconnecting');
    expect(controllerPhase({ ...base, status: 'asleep' })).toBe('asleep');
    expect(controllerPhase({ ...base, status: 'locked' })).toBe('locked');
    expect(controllerPhase({ ...base, status: 'error' })).toBe('error');
  });

  it('connected: input beats right side beats silent beats waiting', () => {
    expect(controllerPhase(base)).toBe('waiting');
    expect(controllerPhase({ ...base, silent: true })).toBe('silent');
    expect(controllerPhase({ ...base, silent: true, side: 'right' })).toBe('rightSide');
    expect(controllerPhase({ ...base, silent: true, side: 'right', inputSeen: true })).toBe('live');
    expect(controllerPhase({ ...base, side: 'unsupported', silent: true })).toBe('silent');
  });
});

describe('chipView', () => {
  it('live shows battery and gear figures, no action', () => {
    expect(chipView('live', 85)).toMatchObject({ label: 'Controls · 85 %', tone: 'ok', figures: true, action: null });
    expect(chipView('live', null).label).toBe('Controls');
    expect(chipView('live', 15).note).toMatch(/Battery low/);
  });

  it('right side says so and offers the other controller', () => {
    const v = chipView('rightSide', 60);
    expect(v).toMatchObject({
      label: 'Right side · 60 %',
      tone: 'warn',
      figures: false,
      action: 'pairOther',
      actionLabel: PAIR_OTHER_LABEL,
    });
    expect(v.note).toBe(RIGHT_SIDE_TEXT);
  });

  it('silent and locked show the unlock recipe with Reconnect', () => {
    for (const p of ['silent', 'locked'] as const) {
      expect(chipView(p, null)).toMatchObject({ label: 'Locked', tone: 'warn', unlock: true, figures: false, action: 'reconnect' });
    }
  });

  it('asleep, none and error have their own labels', () => {
    expect(chipView('asleep', null)).toMatchObject({ label: 'Asleep', action: 'reconnect' });
    expect(chipView('none', null)).toMatchObject({ label: 'No controls', action: 'pair', figures: false });
    expect(chipView('error', null)).toMatchObject({ label: 'No controls', tone: 'warn', action: 'pair' });
    expect(chipView('waiting', 85)).toMatchObject({ label: 'Controls on · 85 %', tone: 'busy' });
  });

  it('every phase yields a label', () => {
    const phases = ['none', 'pairing', 'waiting', 'live', 'rightSide', 'silent', 'reconnecting', 'asleep', 'locked', 'error'] as const;
    for (const p of phases) expect(chipView(p, 50).label.length).toBeGreaterThan(0);
  });
});

describe('panelStatusLine', () => {
  it('names the side and the buzz once connected (battery is its own reading)', () => {
    expect(panelStatusLine('live', 'left', 'ok')).toBe('Left controller · connected · buzzed');
    expect(panelStatusLine('waiting', 'unsupported', 'ok')).toBe('Connected · buzzed');
    expect(panelStatusLine('rightSide', 'right', 'failed')).toBe('Right controller · connected');
    expect(panelStatusLine('locked', 'left', null)).toBe('Locked');
  });
});

describe('unlock recipe', () => {
  it('follows the documented order and never names the brand', () => {
    const text = UNLOCK_STEPS.join(' ');
    expect(text).toMatch(/pair them.*30 s.*one button.*Quit that app fully/);
    expect(text.toLowerCase()).not.toContain('zwift');
    expect(UNLOCK_ONE_LINE).toMatch(/24 h.*own app.*30 s.*one button.*quit that app fully.*Reconnect/);
    expect(UNLOCK_ONE_LINE.toLowerCase()).not.toContain('zwift');
  });
});
