/**
 * Review findings on PR #16, as regression tests over the real Perugia world
 * and the same per-frame code the renderer runs (driveRideFrame → cameraTarget
 * → CameraRig, anchored on the rider):
 *
 * 1. The rider stays in frame through sharp corners (raw route heading turns
 *    114° within ~6 m at Tiber park d≈144 m and makes a 163° U-turn on the
 *    Assisi valley route at 3,744 m; the rider used to leave the frame).
 *    The drawn heading never turns faster than the YawFilter cap, and an
 *    ordinary corner (Tiber) is spread by the wide chord well under the cap:
 *    with the heading smoothing removed it turns at up to 335°/s there.
 * 2. Chase framing holds at any speed (a world-space lag used to put the
 *    camera ~10 m back at 39 km/h instead of the 7 m 'standard' framing).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';

import { routeFromGeometry } from '@/lib/scenicRoutes';
import { SCENIC_ROUTE_GEOMETRY } from '@/lib/scenicRouteData';
import { CHASE_FRAMING, chaseFraming, type CameraDistance } from '@/lib/world/cameraFraming';
import { loadWorld } from '@/lib/world/loadWorld';
import type { Route } from '@/types';
import { MAX_YAW_RATE, headingDelta } from '@/lib/ride/rideHeading';
import { CameraRig, cameraTarget } from './chaseRig';
import { createRideDriverMemo, driveRideFrame } from './rideDriver';
import { createRideFrame, createSceneWorld, groundAtThree, type SceneWorld } from './worldScene';

const DIR = fileURLToPath(new URL('../../../public/worlds/perugia', import.meta.url));
const diskFetch = async (url: string) => {
  try {
    return new Response(readFileSync(join(DIR, url.replace(/^.*\//, ''))), { status: 200 });
  } catch {
    return new Response(null, { status: 404 });
  }
};

const VIEWPORTS = [
  [1920, 1080],
  [390, 844],
] as const;
/** Rider body height used for the on-screen size, metres. */
const RIDER_TOP_M = 1.6;
const DEG = 180 / Math.PI;

interface Sample {
  d: number;
  /** Rider hips on screen, px. */
  x: number;
  y: number;
  /** Rider wheels-to-head height on screen, px. */
  heightPx: number;
  /** Horizontal camera → rider distance, metres. */
  backM: number;
  /** Drawn rider heading, radians. */
  heading: number;
}

/** Ride `route` from `from` to `to` metres at `speed` m/s, 60 fps, chase camera. */
function ride(sw: SceneWorld, route: Route, from: number, to: number, speed: number, [w, h]: readonly [number, number], distance: CameraDistance = 'standard') {
  const framing = chaseFraming(distance);
  const frame = createRideFrame();
  const memo = createRideDriverMemo();
  const rig = new CameraRig();
  const cam = new THREE.PerspectiveCamera(60, w / h, 0.4, 5000);
  const v = new THREE.Vector3();
  const dt = 1 / 60;
  const out: Sample[] = [];
  for (let d = from, t = 0; d <= to; d += speed * dt, t += dt) {
    driveRideFrame(frame, memo, sw, {
      route,
      distance: d,
      speed,
      grade: 0,
      cadence: 85,
      power: 200,
      rideState: 'running',
      steer: 0,
      override: null,
      lookAheadM: framing.lookAheadM,
      dt,
      timeS: t,
    });
    const p = frame.placement!.position;
    const target = cameraTarget(
      'chase',
      { rider: p, heading: frame.pose!.heading, ahead: frame.ahead, speed, cadence: 85, timeS: t },
      framing,
      distance,
    );
    rig.update('chase', target, dt, (x, z) => groundAtThree(sw.heightfield, x, z), p);
    cam.position.set(rig.position.x, rig.position.y, rig.position.z);
    cam.lookAt(rig.look.x, rig.look.y, rig.look.z);
    cam.updateMatrixWorld();
    const screen = (y: number) => {
      v.set(p.x, p.y + y, p.z).project(cam);
      return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h] as const;
    };
    const hips = screen(1);
    const top = screen(RIDER_TOP_M);
    const bottom = screen(0);
    out.push({ d, x: hips[0], y: hips[1], heightPx: bottom[1] - top[1], backM: Math.hypot(rig.position.x - p.x, rig.position.z - p.z), heading: frame.pose!.heading });
  }
  return out;
}

describe('chase framing on the Perugia world', () => {
  let sw: SceneWorld;
  const routes: Record<string, Route> = {};
  beforeAll(async () => {
    const world = await loadWorld('/worlds/perugia/', { fetch: diskFetch, verifyHashes: false });
    sw = createSceneWorld(world);
    for (const id of ['scenic-perugia-tiber-park', 'scenic-assisi-valley']) {
      routes[id] = routeFromGeometry(id, id, SCENIC_ROUTE_GEOMETRY[id]);
    }
  }, 60_000);

  // `maxYawRate`: fastest the drawn rider may turn. Only a fold-back (U-turn)
  // may reach the YawFilter cap; the chord alone spreads an ordinary corner.
  const CORNERS = [
    { id: 'scenic-perugia-tiber-park', from: 80, to: 240, what: '114° vertex at d≈144 m', maxYawRate: 0.9 * MAX_YAW_RATE },
    { id: 'scenic-assisi-valley', from: 3660, to: 3840, what: '163° U-turn at 3,744 m', maxYawRate: MAX_YAW_RATE },
  ];
  for (const c of CORNERS) {
    for (const vp of VIEWPORTS) {
      it(`${c.id}: rider stays in frame through the ${c.what} at ${vp[0]}×${vp[1]}`, () => {
        for (const speed of [4, 8, 11, 15]) {
          const s = ride(sw, routes[c.id], c.from, c.to, speed, vp);
          const margin = 0.04;
          const worst = s.reduce((a, b) => (Math.abs(b.x - vp[0] / 2) > Math.abs(a.x - vp[0] / 2) ? b : a));
          for (const p of s) {
            expect(p.x, `${speed} m/s d=${p.d.toFixed(0)} x`).toBeGreaterThan(vp[0] * margin);
            expect(p.x, `${speed} m/s d=${p.d.toFixed(0)} x`).toBeLessThan(vp[0] * (1 - margin));
            expect(p.y, `${speed} m/s d=${p.d.toFixed(0)} y`).toBeGreaterThan(vp[1] * margin);
            expect(p.y, `${speed} m/s d=${p.d.toFixed(0)} y`).toBeLessThan(vp[1] * (1 - margin));
          }
          expect(worst.x).toBeGreaterThan(0);
          let rate = 0;
          for (let i = 1; i < s.length; i++) rate = Math.max(rate, Math.abs(headingDelta(s[i].heading, s[i - 1].heading)) * 60);
          expect(rate * DEG, `${speed} m/s drawn yaw rate, °/s`).toBeLessThanOrEqual(c.maxYawRate * DEG + 1e-6);
        }
      });
    }
  }

  it("holds the 'standard' 7 m framing at every speed: the rider is as big at 54 km/h as at a walk", () => {
    // A straight-ish stretch of Tiber park, settled for 2 s before measuring.
    const route = routes['scenic-perugia-tiber-park'];
    const sizes: number[] = [];
    for (const speed of [1, 5, 11, 15]) {
      const s = ride(sw, route, 400, 400 + speed * 6, speed, VIEWPORTS[0]).slice(120);
      const back = s.map((p) => p.backM);
      // Horizontal distance stays on the framing (it shrinks a little only while turning).
      expect(Math.max(...back), `${speed} m/s`).toBeLessThanOrEqual(CHASE_FRAMING.standard.backM + 0.05);
      expect(Math.min(...back), `${speed} m/s`).toBeGreaterThan(CHASE_FRAMING.standard.backM - 0.5);
      sizes.push(Math.min(...s.map((p) => p.heightPx)));
    }
    const walk = sizes[0];
    for (const px of sizes) expect(px).toBeGreaterThan(walk * 0.95);
    // Prominent: the rider is well over a sixth of a 1080p frame tall.
    expect(walk).toBeGreaterThan(1080 / 6);
  });
});
