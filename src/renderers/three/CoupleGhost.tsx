/**
 * The couple ghost on the world renderer: the other rider's ride on this
 * route (lib/play/coupleGhost: their last, their best, or none, as picked on
 * the setup step), drawn as the stylized GLB rider in their colours,
 * translucent, on the line they rode (coupleGhostDriver).
 *
 * Reads the ride clock from rideStore; writes only coupleGhostStore (the
 * loaded ghost, for the Finish screen). The in-ride "Ghost riders" toggle
 * hides it with the other ghosts.
 */

import { useEffect, useMemo, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';

import { loadCoupleGhost, type CoupleGhost as CoupleGhostRide } from '@/lib/play/coupleGhost';
import { otherRider } from '@/lib/play/otherRider';
import { useCoupleGhostStore } from '@/stores/coupleGhostStore';
import { useGhostStore } from '@/stores/ghostStore';
import { useRideStore } from '@/stores/rideStore';
import type { Route } from '@/types';
import { createCoupleGhostMemo, driveCoupleGhost } from './coupleGhostDriver';
import { applyColors, cloneRider, poseRider, RIDER_MODEL_URL } from './Rider';
import type { RideFrame, SceneWorld } from './worldScene';

export function CoupleGhost({
  sceneWorld,
  route,
  ground,
  frame,
}: {
  sceneWorld: SceneWorld;
  route: Route;
  ground?: (x: number, y: number) => number;
  frame: RideFrame;
}) {
  const choice = useCoupleGhostStore((s) => s.choice);
  const [ghost, setGhost] = useState<CoupleGhostRide | null>(null);

  useEffect(() => {
    let cancelled = false;
    setGhost(null);
    useCoupleGhostStore.getState().setGhost(null);
    loadCoupleGhost(route, choice, otherRider())
      .then((g) => {
        if (cancelled || useRideStore.getState().route !== route) return;
        setGhost(g);
        useCoupleGhostStore.getState().setGhost(g);
      })
      // No history, no ghost: the ride goes on.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [route, choice]);

  return ghost ? <GhostRider sceneWorld={sceneWorld} route={route} ground={ground} frame={frame} ghost={ghost} /> : null;
}

function GhostRider({
  sceneWorld,
  route,
  ground,
  frame,
  ghost,
}: {
  sceneWorld: SceneWorld;
  route: Route;
  ground?: (x: number, y: number) => number;
  frame: RideFrame;
  ghost: CoupleGhostRide;
}) {
  const gltf = useGLTF(RIDER_MODEL_URL, false, false);
  const parts = useMemo(() => {
    const p = cloneRider(gltf.scene, false);
    p.root.name = 'couple-ghost';
    for (const m of p.materials.values()) {
      m.transparent = true;
      m.depthWrite = true;
    }
    return p;
  }, [gltf]);
  const anim = useMemo(() => ({ wheel: 0, crank: 0 }), []);
  const memo = useMemo(() => createCoupleGhostMemo(), []);
  useEffect(() => applyColors(parts, ghost.colors), [parts, ghost.colors]);
  useEffect(
    () => () => {
      for (const m of parts.materials.values()) m.dispose();
    },
    [parts],
  );

  useFrame((_, delta) => {
    const dt = Math.min(0.1, Math.max(0, delta));
    const s = useRideStore.getState();
    const enabled = useGhostStore.getState().ghostsEnabled;
    const riderM = frame.valid && frame.pose ? frame.pose.distance : null;
    const d = enabled ? driveCoupleGhost(sceneWorld, route, ghost.replay, s.elapsedMs / 1000, riderM, memo, dt, ground) : null;
    parts.root.visible = d !== null && d.opacity > 0.01;
    if (!d) return;
    for (const m of parts.materials.values()) m.opacity = d.opacity;
    poseRider(parts, { placement: d.placement, speed: d.speed, cadence: d.cadence, lean: d.lean }, anim, dt);
  });

  return <primitive object={parts.root} />;
}
