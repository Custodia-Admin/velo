import { describe, expect, it } from 'vitest';

import { hudCoveredPx, hudLensShiftPx } from './hudLens';

describe('hudLensShiftPx (both renderers frame the rider above the floating window bar)', () => {
  it('moves the picture up by half the covered height', () => {
    expect(hudLensShiftPx(270, 78)).toBe(39);
    expect(hudLensShiftPx(240, 78)).toBe(39);
    expect(hudLensShiftPx(360, 86)).toBe(43);
  });

  it('never more than a quarter of the view', () => {
    expect(hudLensShiftPx(270, 400)).toBe(Math.round(270 / 4));
    expect(hudLensShiftPx(180, 120)).toBe(45);
  });

  it('no shift without a HUD or a view', () => {
    expect(hudLensShiftPx(270, 0)).toBe(0);
    expect(hudLensShiftPx(270, -4)).toBe(0);
    expect(hudLensShiftPx(0, 78)).toBe(0);
    expect(hudLensShiftPx(Number.NaN, 78)).toBe(0);
    expect(hudLensShiftPx(270, Number.NaN)).toBe(0);
  });

  it('reads the covered height from the nearest data-hud-bottom ancestor', () => {
    const at = (v: string | undefined) => ({ closest: () => (v === undefined ? null : ({ dataset: { hudBottom: v } } as unknown as Element)) });
    expect(hudCoveredPx(at('78'))).toBe(78);
    expect(hudCoveredPx(at(undefined))).toBe(0);
    expect(hudCoveredPx(at('junk'))).toBe(0);
    expect(hudCoveredPx({})).toBe(0);
  });
});
