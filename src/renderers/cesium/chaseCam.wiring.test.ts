/**
 * CesiumWorldView aims the photoreal chase camera like the world renderer
 * (t_215ac171). A source pin, as globeGate.wiring / sideCam.wiring: the view is
 * a Cesium component with no frame harness. What each line buys:
 * - the rider is drawn as the world draws it (card t_84d635ff): on the drawn
 *   line (rideSim.drawnPose, lib/ride/rideLine), facing the way it moves, and
 *   leaning into the bend by the shared cornerLean, the calls three/rideDriver
 *   makes; the cameras aim by `stepCameraHeading` (the line's tangent through a
 *   YawFilter), so the chase camera sits square behind the rider in a bend;
 * - the route point the camera looks toward is `lookAheadM` ahead (10 m at
 *   close, 14 m standard), not a fixed 15 m, at the road's rise to it on the
 *   low-passed route profile (lib/ride/lookRise `chaseLookRise`), from the
 *   drawn ground under the rider; never the raw profile difference, whose
 *   whole-metre steps nodded the camera; 0 on the flat no-token globe;
 * - applyFollowCam gets that heading and framing (half-bend aim, look at the
 *   point ahead + 1 m, chaseCamTarget), and what it applied is the pose a
 *   mode change starts from;
 * - the heading filter and the lean start over with no rider and on a new route;
 * - the `place(m)` probe hook holds the rider in the world hook's pose
 *   (rideSim heldRiderPose): renderer comparisons frame the same pose.
 * The camera maths is pinned in lib/followCam.test.ts and riderFraming.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(resolve(__dirname, 'CesiumWorldView.tsx'), 'utf-8');
const DRIVER = readFileSync(resolve(__dirname, '../three/rideDriver.ts'), 'utf-8');
const THREE_VIEW = readFileSync(resolve(__dirname, '../three/ThreeWorldView.tsx'), 'utf-8');

describe('CesiumWorldView aims the chase camera like the world renderer', () => {
  it('draws the rider where, facing where and leaning as the world renderer draws it', () => {
    expect(SRC).toContain('const riderDistance = override ? override.distance : state.distance;');
    // The cameras aim by the same damped line tangent, read speed·τ ahead.
    expect(SRC).toContain('const heading = stepCameraHeading(yawRef.current, r, riderDistance, dt, riderSpeed, override?.heading);');
    expect(DRIVER).toContain('const cameraHeading = stepCameraHeading(memo.yaw, route, distance, dt, speed, raw?.heading);');
    // The rider stands on the drawn line, facing the way it moves (drawnPose), lane offset included.
    expect(SRC).toMatch(
      /const pose = override\s*\? \{ \.\.\.override, heading \}\s*: drawnPose\(\s*r,\s*riderDistance,\s*\{ laneOffsetM: laneRef\.current\.offsetM, grade: state\.grade, speed: state\.speed \},\s*linePoints\.rider,\s*\);/,
    );
    expect(DRIVER).toContain('drawnPose(route, distance, { laneOffsetM, grade: input.grade, speed: input.speed }, memo.point)');
    // …and leans by the shared corner lean, read LEAN_LEAD_S ahead.
    expect(SRC).toContain('cornerLeanTarget(pose.speed, lineAt(r, riderDistance + pose.speed * LEAN_LEAD_S, linePoints.lean))');
    expect(DRIVER).toContain('cornerLeanTarget(speed, lineAt(route, distance + speed * LEAN_LEAD_S, memo.leanPoint))');
    const avatar = SRC.slice(SRC.indexOf('avatarRef.current.update({'), SRC.indexOf('avatarRef.current.update({') + 400);
    expect(avatar).toMatch(/\n\s*heading: pose\.heading,\n/);
    expect(avatar).toMatch(/\n\s*lean: leanRef\.current,\n/);
  });

  it('looks toward the route point lookAheadM ahead', () => {
    expect(SRC).toContain('const framing = chaseFraming(useSettingsStore.getState().cameraDistance);');
    expect(SRC).toContain('const aheadDistance = Math.min(r.totalDistance, pose.distance + framing.lookAheadM);');
    expect(SRC).toMatch(/const aheadPose = drawnPose\(\s*r,\s*aheadDistance,\s*\{ laneOffsetM: pose\.laneOffsetM, grade: pose\.grade \},/);
    // …at the road's rise to it on the low-passed profile, from the drawn ground
    // under the rider (lib/ride/lookRise; the nod bounds are pinned in lib/chaseCamNod.test.ts),
    // on the scene surface (0 on the flat no-token globe).
    expect(SRC).toContain("import { chaseLookRise } from '@/lib/ride/lookRise';");
    expect(SRC).toContain(
      'const aheadAtGround = { ...ahead, ele: groundEle + sceneEle(chaseLookRise(r, pose.distance, aheadDistance)) };',
    );
    // The raw profile difference (whole-metre steps, GPS noise) never reaches the camera.
    expect(SRC).not.toMatch(/ahead\.ele\s*-\s*sampled\.ele/);
  });

  it('hands applyFollowCam the drawn heading and framing, and keeps the pose it applied', () => {
    expect(SRC).toMatch(
      /lastCamPoseRef\.current = applyFollowCam\(\s*viewer,\s*\{ lat: sampled\.lat, lon: sampled\.lon, ele: groundEle \},\s*aheadAtGround,\s*\{ heading, framing, minClearanceMeters: CHASE_MIN_CLEARANCE_M \},\s*dt,\s*\);/,
    );
  });

  it('starts the heading filter and the lean over with no rider and on a new route', () => {
    expect(SRC.split('yawRef.current.reset();').length - 1).toBe(2);
    expect(SRC).toMatch(/if \(!r \|\| !avatarRef\.current\) \{[^}]*yawRef\.current\.reset\(\);\s*leanRef\.current = 0;\s*return;/);
    expect(SRC).toMatch(/resetFollowCam\(\);\s*yawRef\.current\.reset\(\);\s*leanRef\.current = 0;/);
  });

  it('holds a placed rider in the pose the world renderer holds it in', () => {
    expect(SRC).toContain('riderOverrideRef.current = distanceM === null || !r ? null : heldRiderPose(r, distanceM);');
    expect(THREE_VIEW).toContain('override.current = heldRiderPose(r, distanceM);');
  });
});
