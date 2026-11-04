/**
 * Follow camera for the world renderer. Mode comes from the rider's camera
 * setting, or, in show mode with the auto camera on, from the cinematic
 * director (lib/show/showDirector → lib/world/director): chase, side dolly,
 * drone orbit at a landmark, front and POV, cut every 20–40 s with an eased
 * blend, held while the rider steers or brakes. Framing from the
 * camera-distance setting (default 'standard': close and low, road 10–20 m
 * ahead). Motion is smoothed frame-rate independently (chaseRig) and never
 * dips under the ground. Where a HUD covers the bottom of the view
 * (data-hud-bottom on an ancestor: the floating ride window), a lens shift
 * centres the picture in the part left clear.
 */

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';

import { showDirectorFrame } from '@/lib/show/showDirector';
import { chaseFraming } from '@/lib/world/cameraFraming';
import type { DirectorShot } from '@/lib/world/director';
import type { WorldCameraMode } from '@/lib/world/renderer';
import { activeSteer } from '@/stores/controllerStore';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useShowStore } from '@/stores/showStore';
import { CameraRig, cameraTarget, type RigInput } from './chaseRig';
import {
  applyHudLensShift,
  bearingXZ,
  blendTargets,
  hudCoveredPx,
  SHOT_RIG_MODE,
  shotTarget,
  type SceneLandmark,
  type ShotContext,
} from './directorCamera';
import { groundAtThree, type RideFrame } from './worldScene';
import type { Heightfield } from '@/lib/world/heightfield';

interface ShotState {
  cutAt: number;
  shot: DirectorShot;
  ctx: ShotContext;
}

export function ChaseCamera({
  frame,
  heightfield,
  landmarks = [],
  rig: rigProp,
}: {
  frame: RideFrame;
  heightfield: Heightfield;
  /** Named places along the route, for the director's landmark orbits. */
  landmarks?: readonly SceneLandmark[];
  /** Tests pass their own rig to inspect it. */
  rig?: CameraRig;
}) {
  const rig = useMemo(() => rigProp ?? new CameraRig(), [rigProp]);
  // The director's current shot and the one it is blending away from.
  const shotRef = useRef<ShotState | null>(null);
  const fromRef = useRef<ShotState | null>(null);
  useFrame(({ camera, gl, size }) => {
    if (!frame.valid || !frame.placement || !frame.pose) return;
    // A HUD over the bottom of the view (the floating ride window's bar): frame above it.
    if ('setViewOffset' in camera) applyHudLensShift(camera as never, size.width, size.height, hudCoveredPx(gl.domElement));
    const settings = useSettingsStore.getState();
    const input: RigInput = {
      rider: frame.placement.position,
      heading: frame.pose.heading,
      ahead: frame.ahead,
      speed: frame.speed,
      cadence: frame.cadence,
      timeS: frame.timeS,
    };
    const framing = chaseFraming(settings.cameraDistance);
    const ground = (x: number, z: number) => groundAtThree(heightfield, x, z);
    const anchor = frame.placement.position;

    const directed = showDirectorFrame(
      useShowStore.getState(),
      {
        routeId: useRideStore.getState().route?.id ?? null,
        distance: frame.pose.distance,
        speed: frame.speed,
        steer: activeSteer(),
      },
      performance.now(),
      landmarks,
    );

    if (directed) {
      const prev = shotRef.current;
      let state: ShotState;
      if (prev && prev.cutAt === directed.cutAt) {
        state = { ...prev, ctx: { ...prev.ctx, framing, distance: settings.cameraDistance, shotT: directed.shotT } };
      } else {
        // A cut: the outgoing shot (as last framed) is what the blend leaves.
        fromRef.current = prev;
        const lm = directed.landmark;
        const poi = lm ? landmarks.find((l) => l.name === lm.name && l.distance === lm.distance)?.position ?? null : null;
        state = {
          cutAt: directed.cutAt,
          shot: directed.shot,
          ctx: {
            framing,
            distance: settings.cameraDistance,
            shotT: directed.shotT,
            poi,
            poiBearing: poi ? bearingXZ(anchor, poi) : null,
          },
        };
      }
      shotRef.current = state;
      let target = shotTarget(state.shot, input, state.ctx);
      const from = fromRef.current;
      if (directed.blend < 1 && from && from.shot !== state.shot) {
        // The outgoing shot keeps moving (its clock runs on) while it fades.
        const out = shotTarget(from.shot, input, { ...from.ctx, framing, shotT: from.ctx.shotT + directed.shotT });
        target = blendTargets(out, target, directed.blend);
      }
      rig.update(SHOT_RIG_MODE[state.shot], target, frame.dt, ground, anchor, { blended: true });
    } else {
      shotRef.current = null;
      fromRef.current = null;
      const mode = settings.cameraMode as WorldCameraMode;
      const target = cameraTarget(mode, input, framing, settings.cameraDistance);
      rig.update(mode, target, frame.dt, ground, anchor);
    }
    camera.position.set(rig.position.x, rig.position.y, rig.position.z);
    camera.lookAt(rig.look.x, rig.look.y, rig.look.z);
  });
  return null;
}
