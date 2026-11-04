/**
 * Follow camera for the world renderer. Mode comes from the rider's camera
 * setting (or the show-mode director); framing from the camera-distance
 * setting (default 'standard': close and low, road 10–20 m ahead). Motion is
 * smoothed frame-rate independently (chaseRig) and never dips under the
 * ground.
 */

import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';

import { effectiveCameraMode } from '@/lib/show/showDirector';
import { chaseFraming } from '@/lib/world/cameraFraming';
import type { WorldCameraMode } from '@/lib/world/renderer';
import { useSettingsStore } from '@/stores/settingsStore';
import { useShowStore } from '@/stores/showStore';
import { CameraRig, cameraTarget } from './chaseRig';
import { groundAtThree, type RideFrame } from './worldScene';
import type { Heightfield } from '@/lib/world/heightfield';

export function ChaseCamera({
  frame,
  heightfield,
  ground,
  rig: rigProp,
}: {
  frame: RideFrame;
  heightfield: Heightfield;
  /** The drawn ground at world (x, y) (worldScene.drawnGround); the heightfield when absent. */
  ground?: (x: number, y: number) => number;
  /** Tests pass their own rig to inspect it. */
  rig?: CameraRig;
}) {
  const rig = useMemo(() => rigProp ?? new CameraRig(), [rigProp]);
  useFrame(({ camera }) => {
    if (!frame.valid || !frame.placement || !frame.pose) return;
    const settings = useSettingsStore.getState();
    const mode = effectiveCameraMode(settings.cameraMode, useShowStore.getState(), performance.now()) as WorldCameraMode;
    const target = cameraTarget(
      mode,
      {
        rider: frame.placement.position,
        heading: frame.pose.heading,
        ahead: frame.ahead,
        speed: frame.speed,
        cadence: frame.cadence,
        timeS: frame.timeS,
      },
      chaseFraming(settings.cameraDistance),
      settings.cameraDistance,
    );
    const groundAt = ground ? (x: number, z: number) => ground(x, -z) : (x: number, z: number) => groundAtThree(heightfield, x, z);
    rig.update(mode, target, frame.dt, groundAt, frame.placement.position);
    camera.position.set(rig.position.x, rig.position.y, rig.position.z);
    camera.lookAt(rig.look.x, rig.look.y, rig.look.z);
  });
  return null;
}
