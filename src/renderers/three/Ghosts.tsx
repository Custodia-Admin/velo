/**
 * Ghost riders (your past rides on this route) as simple translucent
 * capsules, timed against the live ride clock like the Cesium ghosts.
 */

import { useEffect, useMemo, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { loadGhosts, type GhostRide } from '@/lib/ghosts';
import { ridePose } from '@/lib/ride/rideSim';
import { useGhostStore } from '@/stores/ghostStore';
import { useRideStore } from '@/stores/rideStore';
import type { Route } from '@/types';
import { placeRider } from './riderRig';
import type { SceneWorld } from './worldScene';

export const GHOST_RADIUS_M = 0.32;
export const GHOST_HEIGHT_M = 1.75;

export function Ghosts({ sceneWorld, route }: { sceneWorld: SceneWorld; route: Route }) {
  const enabled = useGhostStore((s) => s.ghostsEnabled);
  const [ghosts, setGhosts] = useState<GhostRide[]>([]);

  useEffect(() => {
    let cancelled = false;
    setGhosts([]);
    loadGhosts(route)
      .then((g) => {
        if (cancelled || useRideStore.getState().route !== route) return;
        setGhosts(g);
        useGhostStore.getState().setGhostCount(useGhostStore.getState().ghostsEnabled ? g.length : 0);
      })
      // Ghost loading failure is non-fatal: the ride goes on without them.
      .catch(() => undefined);
    return () => {
      cancelled = true;
      useGhostStore.getState().setGhostCount(0);
    };
  }, [route]);

  const { geometry, material } = useMemo(() => {
    const g = new THREE.CapsuleGeometry(GHOST_RADIUS_M, GHOST_HEIGHT_M - 2 * GHOST_RADIUS_M, 4, 12);
    const m = new THREE.MeshStandardMaterial({
      color: '#bfdbfe',
      emissive: '#3b82f6',
      emissiveIntensity: 0.25,
      roughness: 0.6,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });
    return { geometry: g, material: m };
  }, []);
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  const meshes = useMemo(
    () =>
      ghosts.map((_, i) => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = `ghost-${i}`;
        mesh.visible = false;
        return mesh;
      }),
    [ghosts, geometry, material],
  );

  useFrame(() => {
    const elapsedSec = useRideStore.getState().elapsedMs / 1000;
    meshes.forEach((mesh, i) => {
      const d = enabled ? ghosts[i].distanceAt(elapsedSec) : null;
      if (d === null) {
        mesh.visible = false;
        return;
      }
      const pose = ridePose(route, Math.max(0, Math.min(route.totalDistance, d)));
      const p = placeRider(sceneWorld, pose).position;
      mesh.position.set(p.x, p.y + GHOST_HEIGHT_M / 2, p.z);
      mesh.visible = true;
    });
  });

  return (
    <>
      {meshes.map((m) => (
        <primitive key={m.uuid} object={m} />
      ))}
    </>
  );
}
