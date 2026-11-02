/**
 * v2 ride strip (docs/design/mockups/v2-ride-hud.html): the six figures of
 * the mockup — speed, time, distance, grade, power and the virtual gear.
 * Static markup (node env; zustand renders the stores' initial state).
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NEUTRAL_GEAR } from '@/lib/virtualGears';
import { RideStrip, shownGear } from './RideStrip';

describe('RideStrip', () => {
  it('shows the six mockup figures, gear at neutral 6 / 11 without handlebar controls', () => {
    const out = renderToStaticMarkup(createElement(RideStrip));
    for (const label of ['Speed', 'Time', 'Distance', 'Grade', 'Power', 'Gear']) expect(out).toContain(`>${label}<`);
    expect(out).toContain('aria-label="Gear 6 of 11"');
  });

  it('shows the gear the trainer uses: live while the controls are connected, else neutral, none in ERG', () => {
    expect(shownGear('connected', 9, false)).toBe(9);
    expect(shownGear('reconnecting', 9, false)).toBe(9);
    expect(shownGear('idle', 9, false)).toBe(NEUTRAL_GEAR);
    expect(shownGear('connected', 9, true)).toBeNull();
  });
});
