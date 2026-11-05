/**
 * One drawn ground on photoreal: the globe hides once the mesh is the road
 * under the rider and comes back where it isn't. Each flip moves the rider
 * (the globe sat up to 26 m over the mesh on the Lugano shore), so both
 * directions wait out a short dropout, and a hidden tileset brings the globe
 * back at once.
 */
import { describe, expect, it } from 'vitest';

import { rideAgain } from '@/components/velo/FinishCard';
import { ridePose } from '@/lib/ride/rideSim';
import { scenicRouteById } from '@/lib/scenicRoutes';
import { GLOBE_HIDE_AFTER_MS, GLOBE_JUMP_M, GLOBE_SHOW_AFTER_MS, GlobeGate } from '@/renderers/cesium/globeGate';
import { useRideStore } from '@/stores/rideStore';

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

  // Spots `m` metres north of a point on the Lugano shore.
  const at = (m: number) => ({ lon: 8.95, lat: 45.98 + m / 110_540 });

  it('a rider that jumps (Ride again) gets the globe back at once, then the mesh there hides it again', () => {
    const g = new GlobeGate();
    g.update(0, true, true, at(0));
    expect(g.update(GLOBE_HIDE_AFTER_MS, true, true, at(5))).toBe(false);
    // 2.9 km on in one frame: the mesh status is still the old spot's.
    expect(g.update(GLOBE_HIDE_AFTER_MS + 16, true, true, at(2_900))).toBe(true);
    // No mesh road there yet: the globe stays.
    expect(g.update(GLOBE_HIDE_AFTER_MS + 32, true, false, at(2_900))).toBe(true);
    // The mesh road there holds: hidden again after the usual wait.
    const t = GLOBE_HIDE_AFTER_MS + 48;
    expect(g.update(t, true, true, at(2_901))).toBe(true);
    expect(g.update(t + GLOBE_HIDE_AFTER_MS - 1, true, true, at(2_902))).toBe(true);
    expect(g.update(t + GLOBE_HIDE_AFTER_MS, true, true, at(2_903))).toBe(false);
  });

  it('riding on is never a jump; a frame-to-frame step of GLOBE_JUMP_M is', () => {
    const g = new GlobeGate();
    g.update(0, true, true, at(0));
    g.update(GLOBE_HIDE_AFTER_MS, true, true, at(0));
    // 90 km/h at 4 fps is 6 m a frame; even 99 m doesn't count.
    let m = 0;
    for (let i = 1; i <= 50; i++) expect(g.update(GLOBE_HIDE_AFTER_MS + i * 250, true, true, at((m += 6)))).toBe(false);
    expect(g.update(20_000, true, true, at((m += GLOBE_JUMP_M - 1)))).toBe(false);
    expect(g.update(20_016, true, true, at(m + GLOBE_JUMP_M))).toBe(true);
    expect(GLOBE_JUMP_M).toBe(100);
  });
});

describe('Ride again on photoreal: the globe comes back for the new start', () => {
  it("the finish line's hidden globe is drawn again the frame the rider is back on the start line", () => {
    // The ride view's frame, as in CesiumWorldView: the pose from the store,
    // then the gate (the call itself is pinned by globeGate.wiring.test.ts).
    const route = scenicRouteById('scenic-lugano-melide')!.route;
    const g = new GlobeGate();
    const frame = (nowMs: number, meshGround: boolean) =>
      g.update(nowMs, true, meshGround, ridePose(route, useRideStore.getState().distance));
    useRideStore.getState().setRoute(route);
    useRideStore.getState().start();
    useRideStore.setState({ distance: 2_940 });
    let t = 0;
    for (; t <= GLOBE_HIDE_AFTER_MS + 16; t += 16) frame(t, true);
    expect(g.shown).toBe(false);
    useRideStore.getState().finish();
    rideAgain();
    expect(useRideStore.getState().distance).toBe(0);
    // The avatar's mesh status is still the finish line's on this frame.
    expect(frame(t, true)).toBe(true);
    expect(frame(t + 16, false)).toBe(true);
    useRideStore.getState().reset();
  });
});

