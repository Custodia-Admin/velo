/**
 * One drawn ground on photoreal: the globe hides once the mesh is the road
 * under the rider and comes back where it isn't. Each flip moves the rider
 * (the globe sat up to 26 m over the mesh on the Lugano shore), so both
 * directions wait out a short dropout, and a hidden tileset brings the globe
 * back at once.
 */
import { describe, expect, it } from 'vitest';

import { GLOBE_HIDE_AFTER_MS, GLOBE_SHOW_AFTER_MS, GlobeGate } from '@/renderers/cesium/globeGate';

describe('GlobeGate', () => {
  it('starts on the globe and hides it once the mesh road has held under the rider', () => {
    const g = new GlobeGate();
    expect(g.shown).toBe(true);
    expect(g.update(0, true, true)).toBe(true);
    expect(g.update(GLOBE_HIDE_AFTER_MS - 1, true, true)).toBe(true);
    expect(g.update(GLOBE_HIDE_AFTER_MS, true, true)).toBe(false);
    expect(g.shown).toBe(false);
  });

  it('a mesh road that drops out before the hide delay starts the wait again', () => {
    const g = new GlobeGate();
    g.update(0, true, true);
    g.update(GLOBE_HIDE_AFTER_MS - 100, true, false);
    expect(g.update(GLOBE_HIDE_AFTER_MS + 50, true, true)).toBe(true);
    expect(g.update(GLOBE_HIDE_AFTER_MS + 50 + GLOBE_HIDE_AFTER_MS - 1, true, true)).toBe(true);
    expect(g.update(2 * GLOBE_HIDE_AFTER_MS + 50, true, true)).toBe(false);
  });

  it('a short hole in the mesh keeps the globe hidden; a lasting one brings it back', () => {
    const g = new GlobeGate();
    g.update(0, true, true);
    g.update(GLOBE_HIDE_AFTER_MS, true, true);
    const t0 = 10_000;
    expect(g.update(t0, true, false)).toBe(false);
    expect(g.update(t0 + GLOBE_SHOW_AFTER_MS - 1, true, false)).toBe(false);
    // The mesh came back in time: the wait is over.
    expect(g.update(t0 + GLOBE_SHOW_AFTER_MS - 1, true, true)).toBe(false);
    expect(g.update(t0 + 2 * GLOBE_SHOW_AFTER_MS, true, false)).toBe(false);
    expect(g.update(t0 + 3 * GLOBE_SHOW_AFTER_MS, true, false)).toBe(true);
  });

  it('a hidden tileset (camera over 5 km, no token, mobile) brings the globe back at once', () => {
    const g = new GlobeGate();
    g.update(0, true, true);
    g.update(GLOBE_HIDE_AFTER_MS, true, true);
    expect(g.shown).toBe(false);
    expect(g.update(GLOBE_HIDE_AFTER_MS + 1, false, true)).toBe(true);
    // Back under 5 km: the hide waits again.
    expect(g.update(GLOBE_HIDE_AFTER_MS + 2, true, true)).toBe(true);
  });

  it('reset: back on the globe (route change, no rider)', () => {
    const g = new GlobeGate();
    g.update(0, true, true);
    g.update(GLOBE_HIDE_AFTER_MS, true, true);
    g.reset();
    expect(g.shown).toBe(true);
    expect(g.update(GLOBE_HIDE_AFTER_MS + 1, true, true)).toBe(true);
  });
});
