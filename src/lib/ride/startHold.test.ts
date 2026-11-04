import { describe, expect, it, vi } from 'vitest';

import { holdStart, START_HOLD_MAX_MS } from './startHold';

describe('ride start hold (the ground under the rider is drawn at full detail first)', () => {
  it('holds while the renderer reports its ground still loading', () => {
    const groundReady = vi.fn(() => false);
    expect(holdStart({ groundReady }, 0)).toBe(true);
    expect(holdStart({ groundReady }, START_HOLD_MAX_MS - 1)).toBe(true);
    expect(groundReady).toHaveBeenCalledTimes(2);
  });

  it('starts once the ground is ready', () => {
    expect(holdStart({ groundReady: () => true }, 300)).toBe(false);
  });

  it('never holds forever (offline, stalled tiles)', () => {
    expect(holdStart({ groundReady: () => false }, START_HOLD_MAX_MS)).toBe(false);
  });

  it('renderers that stream nothing never hold', () => {
    expect(holdStart({}, 0)).toBe(false);
    expect(holdStart(null, 0)).toBe(false);
  });
});
