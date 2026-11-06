/**
 * The photoreal chase camera's look height doesn't nod with the stored route
 * profile (t_e1563c34, PR #86 review R1). Before, the camera looked at the
 * point ahead at the raw profile's rise to it: on whole-metre profiles and
 * GPX altitude that bobbed the view by tens of pixels on roads that don't
 * bob. CesiumWorldView feeds applyFollowCam `chaseLookRise` (lib/ride/
 * lookRise; wiring pinned in renderers/cesium/chaseCam.wiring.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { buildRoute, sampleRouteAtDistance } from '@/lib/gpxParser';
import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { ChaseCamSmoother, chaseCamTarget, lookAtHeadingPitch } from '@/lib/cesiumCameras';
import { chaseLookRise } from '@/lib/ride/lookRise';
import { CHASE_FRAMING, RIDE_FOV_Y_DEG, type CameraDistance } from '@/lib/world/cameraFraming';
import type { Route } from '@/types';

/**
 * The nod: ride at 8 m/s, 60 fps, through the helper + chaseCamTarget +
 * ChaseCamSmoother (as applyFollowCam does), and follow where the point 1 m
 * over the rider's ground lands on screen. On a road whose real grade holds,
 * it must hold too: ≤ 10 px of swing in any 2 s.
 */
describe('the photoreal chase camera does not nod with the stored profile', () => {
  const SPEED = 8;
  const FPS = 60;
  const VIEWS: Array<[CameraDistance, number, string]> = [
    ['standard', 900, '1440×900 standard'],
    ['close', 844, '390×844 close'],
  ];
  type Rise = (r: Route, from: number, to: number) => number;
  const smoothed: Rise = (r, from, to) => chaseLookRise(r, from, to);
  /** The rule before this fix: the raw stored profile's difference. */
  const raw: Rise = (r, from, to) => sampleRouteAtDistance(r, to).ele - sampleRouteAtDistance(r, from).ele;

  /** Screen y (px) of the point 1 m over the rider's ground, frame by frame. */
  function ride(r: Route, from: number, to: number, distance: CameraDistance, heightPx: number, rise: Rise): number[] {
    const f = CHASE_FRAMING[distance];
    const focal = heightPx / 2 / Math.tan(((RIDE_FOV_Y_DEG / 2) * Math.PI) / 180);
    const cam = new ChaseCamSmoother();
    const ys: number[] = [];
    for (let d = from; d <= to; d += SPEED / FPS) {
      const ahead = Math.min(r.totalDistance, d + f.lookAheadM);
      cam.step(chaseCamTarget(0, { x: 0, y: f.lookAheadM, z: rise(r, d, ahead) }, f), 1 / FPS);
      const { pitch } = lookAtHeadingPitch(cam.position, cam.look);
      const below = Math.atan2(1 - cam.position.z, -cam.position.y) - pitch;
      ys.push(heightPx / 2 - focal * Math.tan(below));
    }
    return ys;
  }

  /** Largest max − min of `ys` over any 2 s. */
  function worstSwing(ys: number[]): number {
    const w = 2 * FPS;
    let worst = 0;
    for (let i = 0; i + w <= ys.length; i++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = i; j < i + w; j++) {
        lo = Math.min(lo, ys[j]);
        hi = Math.max(hi, ys[j]);
      }
      worst = Math.max(worst, hi - lo);
    }
    return worst;
  }

  it('Valle Maggia 8.1–8.4 km, a descent easing from ~6 % to ~2 % stored in whole-metre steps', () => {
    const r = routeFromGeometry('scenic-valle-maggia', 'Valle Maggia', SCENIC_ROUTE_GEOMETRY['scenic-valle-maggia']);
    // The fixture: whole metres, alternating 0 % and 11–17 % segments.
    const pts = r.points.filter((p) => p.distance >= 8093 && p.distance <= 8395);
    expect(pts.length).toBeGreaterThan(8);
    expect(pts.every((p) => Number.isInteger(p.ele))).toBe(true);
    for (const [distance, h, name] of VIEWS) {
      expect(worstSwing(ride(r, 8093, 8395, distance, h, smoothed)), name).toBeLessThanOrEqual(10);
      // The raw profile nodded the camera here (54 px live at 1440×900 standard).
      expect(worstSwing(ride(r, 8093, 8395, distance, h, raw)), `${name} raw`).toBeGreaterThan(30);
    }
  });

  it('an uploaded phone GPX track on a flat road: AR(1) altitude error σ 2 m, 8 m spacing, 1 m steps', () => {
    // 1 Hz at 8 m/s, due north from 46° N, a flat 300 m road; error AR(1) φ 0.95 (≈ 20 s
    // correlation, as phone GPS altitude wanders), rounded to whole metres. Seeded.
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const PHI = 0.95;
    const SIGMA = 2;
    let err = 0;
    const raws: Array<{ lat: number; lon: number; ele: number }> = [];
    for (let i = 0; i < 1500; i++) {
      err = PHI * err + Math.sqrt(1 - PHI * PHI) * SIGMA * gauss();
      raws.push({ lat: 46 + (i * 8) / 111_320, lon: 9, ele: Math.round(300 + err) });
    }
    const r = buildRoute('phone track', raws);
    expect(r.totalDistance).toBeGreaterThan(11_000);
    const span = r.totalDistance - CHASE_FRAMING.standard.lookAheadM;
    for (const [distance, h, name] of VIEWS) {
      expect(worstSwing(ride(r, 0, span, distance, h, smoothed)), name).toBeLessThanOrEqual(10);
      // The raw profile: 170–210 px here (110–150 px with climbs held at flat pitch).
      expect(worstSwing(ride(r, 0, span, distance, h, raw)), `${name} raw`).toBeGreaterThan(50);
    }
  });
});
