/**
 * Road ribbons over the near terrain, plus the ridden route's line.
 *
 * A chunk's road bucket is built when its near-LOD terrain is showing and
 * dropped when it goes back to far (far terrain is too coarse to drape on;
 * the landcover map draws the distant network instead). The route line is
 * the app route itself (what the rider follows), densified to 2 m.
 */

import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import type { Route } from '@/types';
import { createRoadMaterial } from './materials/road';
import type { ThreeQuality } from './quality';
import { buildRibbons, type RibbonGeometryData, type RibbonLine } from './roadRibbons';
import { ROAD_MAX_SEG_M, type ChunkVisibility, type SceneWorld } from './worldScene';

/** Road surface lift above the heightfield, metres (the rider stays within 5 cm of it). */
export const ROAD_LIFT_M = 0.03;
export const ROUTE_LIFT_M = 0.045;
export const ROUTE_WIDTH_M = 0.6;

export function ribbonGeometry(data: RibbonGeometryData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  g.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  g.setAttribute('marking', new THREE.BufferAttribute(data.markings, 1));
  g.setIndex(new THREE.BufferAttribute(data.indices, 1));
  g.computeBoundingSphere();
  return g;
}

/** Ribbons of one chunk's bucket, positions relative to the chunk centre. */
export function buildBucket(sw: SceneWorld, i: number): RibbonGeometryData {
  const chunk = sw.chunks[i];
  return buildRibbons(sw.heightfield, sw.roadBuckets[i], {
    maxSegM: ROAD_MAX_SEG_M,
    lift: ROAD_LIFT_M,
    originX: chunk.centerX,
    originZ: chunk.centerZ,
    keepSegment: (mx, my) => sw.locate(mx, my) === i,
  });
}

export interface RoadsHandle {
  group: THREE.Group;
  meshes: (THREE.Mesh | null)[];
  material: THREE.MeshStandardMaterial;
}

export function createRoads(sw: SceneWorld): RoadsHandle {
  const group = new THREE.Group();
  group.name = 'roads';
  return { group, meshes: sw.chunks.map(() => null), material: createRoadMaterial() };
}

/** Follow the terrain's near set; build at most `budget` buckets. Exported for tests. */
export function updateRoads(
  handle: RoadsHandle,
  sw: SceneWorld,
  visibility: ChunkVisibility,
  budget: number,
  receiveShadow: boolean,
): void {
  let left = budget;
  for (let i = 0; i < handle.meshes.length; i++) {
    const near = visibility.near[i] === 1;
    const mesh = handle.meshes[i];
    if (near && !mesh && left > 0 && sw.roadBuckets[i].length > 0) {
      left--;
      const m = new THREE.Mesh(ribbonGeometry(buildBucket(sw, i)), handle.material);
      m.name = `roads-${i}`;
      m.position.set(sw.chunks[i].centerX, 0, sw.chunks[i].centerZ);
      m.receiveShadow = receiveShadow;
      handle.group.add(m);
      handle.meshes[i] = m;
    } else if (!near && mesh) {
      handle.group.remove(mesh);
      mesh.geometry.dispose();
      handle.meshes[i] = null;
    }
  }
}

export function disposeRoads(handle: RoadsHandle) {
  for (const m of handle.meshes) m?.geometry.dispose();
  handle.material.dispose();
}

export function Roads({
  sceneWorld,
  visibility,
  quality,
}: {
  sceneWorld: SceneWorld;
  visibility: ChunkVisibility;
  quality: ThreeQuality;
}) {
  const handle = useMemo(() => createRoads(sceneWorld), [sceneWorld]);
  useEffect(() => () => disposeRoads(handle), [handle]);
  useFrame(() => updateRoads(handle, sceneWorld, visibility, quality.buildsPerFrame, quality.shadows));
  return <primitive object={handle.group} />;
}

/** The route as world-metre points (projected from the app route's lat/lon). */
export function routeLine(sw: SceneWorld, route: Route, color: readonly [number, number, number]): RibbonLine {
  const pts = new Float64Array(route.points.length * 2);
  route.points.forEach((p, i) => {
    const [x, y] = sw.projection.forward(p.lat, p.lon);
    pts[i * 2] = x;
    pts[i * 2 + 1] = y;
  });
  return { points: pts, width: ROUTE_WIDTH_M, color, marking: 0 };
}

/** Theme primary colour (the `--primary` HSL token), linear rgb. */
function primaryColor(): THREE.Color {
  const fallback = new THREE.Color().setHSL(200 / 360, 0.92, 0.56);
  if (typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
  const m = raw.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (!m) return fallback;
  return new THREE.Color().setHSL(Number(m[1]) / 360, Number(m[2]) / 100, Number(m[3]) / 100);
}

export function RouteLine({ sceneWorld, route }: { sceneWorld: SceneWorld; route: Route }) {
  const mesh = useMemo(() => {
    const c = primaryColor();
    const data = buildRibbons(sceneWorld.heightfield, [routeLine(sceneWorld, route, [c.r, c.g, c.b])], {
      maxSegM: 2,
      lift: ROUTE_LIFT_M,
      originX: 0,
      originZ: 0,
    });
    const m = new THREE.Mesh(
      ribbonGeometry(data),
      createRoadMaterial({ bias: 0.12, biasPerM: 0.0025, opacity: 0.4, emissive: c.clone().multiplyScalar(0.12), plain: true }),
    );
    m.name = 'route-line';
    m.renderOrder = 2;
    return m;
  }, [sceneWorld, route]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    },
    [mesh],
  );
  return <primitive object={mesh} />;
}
