/**
 * CesiumWorldView wires the side / orbit camera's sight (t_1ec01b75):
 * - the pose for sideTracking / cinematic goes through placeSideCam before
 *   the mode transition and before the side is remembered for next frame;
 * - the corridor rule only applies while the painted road is drawn;
 * - placeSideCam gets the drawn ground under the rider and the route ele;
 * - a mode change starts the sight state over;
 * - a cut across the road drops the lift the camera had on the old side;
 * - a top over the camera is not lifted over while the sight's casts see the rider (a canopy);
 * - probes can read it (__veloRideDebug().sideCam).
 * placeSideCam itself is tested against a synthetic world in sideCam.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(resolve(__dirname, 'CesiumWorldView.tsx'), 'utf-8');

describe('CesiumWorldView places the side camera with sight of the rider', () => {
  it('keeps the corridor rule for while the painted road is drawn', () => {
    expect(SRC).toContain('const roadPainted = globeShown && roadEntityRef.current !== null;');
    expect(SRC).toContain('points: roadPainted ? r.points : [],');
  });

  it('runs the pose through placeSideCam, then remembers its side and eases from it', () => {
    const place = SRC.indexOf('targetPose = placeSideCam({');
    const pose = SRC.indexOf('let targetPose = computeCameraPose(currentMode, riderPose, nowMs, cameraDistance, corridor);');
    const remember = SRC.indexOf('sideTrackSideRef.current = sideTrackSideFromPose(targetPose, heading);');
    const transition = SRC.indexOf('effectivePose = easedCameraTransition(transition.fromPose, targetPose, t);');
    expect(pose).toBeGreaterThan(0);
    expect(place).toBeGreaterThan(pose);
    expect(remember).toBeGreaterThan(place);
    expect(transition).toBeGreaterThan(place);
  });

  it('hands placeSideCam the drawn ground, the route ele, the mode, speed and the painted road', () => {
    const call = SRC.slice(SRC.indexOf('targetPose = placeSideCam({'), SRC.indexOf('if (corridor) {\n          sideTrackSideRef'));
    for (const arg of [
      'scene: viewer.scene,',
      'sight: sideCamSightRef.current,',
      'mode: currentMode,',
      'pose: targetPose,',
      'heading,',
      'lon: sampled.lon,',
      'lat: sampled.lat,',
      'routeEle: sampled.ele,',
      'groundEle,',
      'speed: state.speed,',
      'distanceM: pose.distance,',
      'nowMs,',
      'dt,',
      'roadPainted,',
    ]) {
      expect(call).toContain(arg);
    }
  });

  it('does not lift the camera over a top above it while the sight\'s casts see the rider (a canopy)', () => {
    const needed = SRC.slice(SRC.indexOf('const needed ='), SRC.indexOf('const lift = Math.max(needed'));
    expect(needed).toContain('ground === undefined || (ground > camCarto.height && sideCamSightRef.current.castClear())');
    expect(needed).toMatch(/\?\s*0\s*:\s*Math\.max\(0, ground \+ CHASE_MIN_CLEARANCE_M - camCarto\.height\);/);
  });

  it('drops the lift on a cut across the road, before this frame\'s lift is worked out', () => {
    expect(SRC).toMatch(
      /const cuts = sideCamSightRef\.current\.cuts\(\);\s*if \(cuts !== sideCamCutsRef\.current\) \{\s*sideCamCutsRef\.current = cuts;\s*cameraLiftRef\.current = 0;\s*\}\s*const needed/,
    );
    expect(SRC).toContain('const lift = Math.max(needed, cameraLiftRef.current * Math.exp(-1.5 * Math.min(dt, 0.1)));');
  });

  it("drops the sight's tile geometry copies when the view is destroyed", () => {
    expect(SRC).toMatch(/viewer\.destroy\(\);\s*\/\/[^\n]*\n\s*clearMeshTopReads\(\);/);
  });

  it('builds one sight per view, not one per render', () => {
    expect(SRC).toContain('const [sideCamSight] = useState(createSideCamSight);');
    expect(SRC).toContain('const sideCamSightRef = useRef(sideCamSight);');
    expect(SRC.match(/createSideCamSight\(/g)).toBeNull();
  });

  it('starts the sight state over on a mode change, and shows it to probes', () => {
    expect(SRC).toMatch(/lastCamModeRef\.current = currentMode;\s*sideCamSightRef\.current\.reset\(\);/);
    expect(SRC).toContain('sideCam: sideCamSightRef.current.debug(),');
    expect(SRC).toContain('sideCamTileReads: meshTopReadStats(),');
  });
});
