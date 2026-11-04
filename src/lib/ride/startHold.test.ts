import { describe, expect, it, vi } from 'vitest';

import { holdStart, START_HOLD_MAX_MS, START_PENDING_MAX_MS } from './startHold';

describe('ride start hold (a short wait for a plausible ground under the rider)', () => {
  it('holds while the renderer reports its ground still coarse', () => {
    const groundReady = vi.fn(() => false);
    expect(holdStart({ groundReady }, 0)).toBe(true);
    expect(holdStart({ groundReady }, START_HOLD_MAX_MS - 1)).toBe(true);
    expect(groundReady).toHaveBeenCalledTimes(2);
  });

  it('starts once the ground is ready', () => {
    expect(holdStart({ groundReady: () => true }, 300)).toBe(false);
    expect(holdStart({ groundReady: () => true, groundPending: () => false }, 300)).toBe(false);
  });

  it('the cap is short: the owner\'s laptop takes 10-25 s to refine, and the auto-start must not become "tap Start"', () => {
    expect(START_HOLD_MAX_MS).toBeLessThanOrEqual(3_000);
    expect(holdStart({ groundReady: () => false }, START_HOLD_MAX_MS)).toBe(false);
    expect(holdStart({ groundReady: () => false, groundPending: () => false }, START_HOLD_MAX_MS)).toBe(false);
  });

  it('waits longer while nothing real is drawn yet (flat globe before World Terrain), but never forever', () => {
    const r = { groundReady: () => false, groundPending: () => true };
    expect(holdStart(r, START_HOLD_MAX_MS)).toBe(true);
    expect(holdStart(r, START_PENDING_MAX_MS - 1)).toBe(true);
    expect(holdStart(r, START_PENDING_MAX_MS)).toBe(false);
    expect(START_PENDING_MAX_MS).toBeLessThanOrEqual(8_000);
  });

  it('renderers that stream nothing never hold', () => {
    expect(holdStart({}, 0)).toBe(false);
    expect(holdStart({ groundPending: () => true }, 0)).toBe(false);
    expect(holdStart(null, 0)).toBe(false);
  });
});
