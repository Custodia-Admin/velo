/**
 * lib/ride/lookRise: the route profile under a triangle window, and the rise
 * the photoreal chase camera looks along. The camera's nod bounds (Valle
 * Maggia, a phone GPX track) are in lib/chaseCamNod.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { sampleRouteAtDistance } from '@/lib/gpxParser';
import type { Route } from '@/types';
import { chaseLookRise, smoothedProfileEle } from './lookRise';

/** A route due north from 46° N with these (distance, ele) knots; distances as given, not haversine. */
function profileRoute(knots: Array<[number, number]>): Route {
  const points = knots.map(([distance, ele]) => ({ lat: 46 + distance / 111_320, lon: 9, ele, distance }));
  const eles = knots.map(([, e]) => e);
  return {
    id: 'profile',
    name: 'profile',
    points,
    totalDistance: knots[knots.length - 1][0],
    ascent: 0,
    descent: 0,
    minElevation: Math.min(...eles),
    maxElevation: Math.max(...eles),
    loadedAt: 0,
  };
}

/** Triangle-weighted mean of the raw profile (flat beyond the ends) by brute-force quadrature. */
function bruteTriangle(r: Route, s: number, h: number): number {
  const ele = (d: number) => sampleRouteAtDistance(r, d).ele;
  const N = 20_000;
  let num = 0;
  let den = 0;
  for (let i = 0; i <= N; i++) {
    const u = -h + (2 * h * i) / N;
    const w = (h - Math.abs(u)) * (i === 0 || i === N ? 0.5 : 1);
    num += w * ele(s + u);
    den += w;
  }
  return num / den;
}

describe('smoothedProfileEle: the route profile under a triangle window', () => {
  // Irregular spacing, whole-metre steps, a zero-length segment (a jump) at 300 m.
  const r = profileRoute([
    [0, 300],
    [7, 301],
    [40, 301],
    [46, 303],
    [120, 299],
    [300, 305],
    [300, 306],
    [333, 306],
    [500, 290],
    [512, 291],
  ]);

  it('equals the brute-force triangle mean, inside, across a jump, over and beyond the ends', () => {
    for (const h of [3, 25, 120]) {
      for (const s of [-50, 0, 5, 43, 118, 300, 301.5, 420, 505, 512, 600]) {
        expect(smoothedProfileEle(r, s, h), `s ${s} h ${h}`).toBeCloseTo(bruteTriangle(r, s, h), 3);
      }
    }
  });

  it('keeps a straight grade exactly and holds the ends flat', () => {
    const climb = profileRoute([
      [0, 100],
      [13, 100.78],
      [50, 103],
      [51, 103.06],
      [400, 124],
      [1000, 160],
    ]);
    for (const s of [120, 250.5, 700, 880]) expect(smoothedProfileEle(climb, s, 120)).toBeCloseTo(100 + 0.06 * s, 9);
    // Far beyond the ends the window sees only the held end heights.
    expect(smoothedProfileEle(climb, -500, 120)).toBeCloseTo(100, 9);
    expect(smoothedProfileEle(climb, 1500, 120)).toBeCloseTo(160, 9);
  });

  it('reads the raw profile with no window, and NaN for a non-finite distance', () => {
    expect(smoothedProfileEle(r, 43, 0)).toBeCloseTo(sampleRouteAtDistance(r, 43).ele, 12);
    expect(smoothedProfileEle(r, NaN)).toBeNaN();
    expect(chaseLookRise(r, Infinity, 14)).toBeNaN();
    expect(chaseLookRise(profileRoute([[0, 412]]), 0, 14)).toBe(0);
  });
});

describe('chaseLookRise: the road rise the chase camera looks along', () => {
  it('a sustained grade tilts the view by exactly that grade', () => {
    const r = profileRoute([
      [0, 500],
      [2000, 380],
    ]);
    for (const d of [200, 977, 1600]) expect(chaseLookRise(r, d, d + 14)).toBeCloseTo(-0.06 * 14, 9);
    // At the ends the flat hold softens it but never flips it.
    for (const [a, b] of [
      [0, 14],
      [1990, 2000],
    ]) {
      const rise = chaseLookRise(r, a, b);
      expect(rise).toBeLessThan(0);
      expect(rise).toBeGreaterThan(-0.06 * (b - a));
    }
  });

  it('a crest is taken within 120 m + the look-ahead of it, without overshoot', () => {
    // +6 % for 1 km, then −6 %.
    const r = profileRoute([
      [0, 300],
      [1000, 360],
      [2000, 300],
    ]);
    const L = 14;
    expect(chaseLookRise(r, 1000 - 120 - L - 1, 1000 - 120 - 1)).toBeCloseTo(0.06 * L, 9);
    expect(chaseLookRise(r, 1000 + 121, 1000 + 121 + L)).toBeCloseTo(-0.06 * L, 9);
    let last = Infinity;
    for (let d = 800; d <= 1200; d += 2) {
      const rise = chaseLookRise(r, d, d + L);
      expect(rise).toBeLessThanOrEqual(last + 1e-12);
      expect(Math.abs(rise)).toBeLessThanOrEqual(0.06 * L + 1e-9);
      last = rise;
    }
  });
});
