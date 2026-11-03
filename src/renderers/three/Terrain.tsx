/**
 * Chunked terrain: the world heightfield split 8×8, every chunk always
 * present at the far LOD, swapped for the near LOD (full detail) when the
 * camera comes within the tier's radius. Near geometries are built a few
 * per frame and dropped again once the camera has left (memory stays flat
 * on a long ride). Skirts hide the seams between LODs.
 */

import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import type { WorldAtmosphere } from './materials/atmosphere';
import { createTerrainMaterial } from './materials/toonTerrain';
import type { ThreeQuality } from './quality';
import { buildChunkGeometry, chunkLod, type ChunkGeometryData, type ChunkLod } from './terrainMesh';
import type { ChunkVisibility, SceneWorld } from './worldScene';

export function toBufferGeometry(data: ChunkGeometryData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  g.setIndex(new THREE.BufferAttribute(data.indices, 1));
  g.computeBoundingSphere();
  return g;
}

interface ChunkSlot {
  group: THREE.Group;
  far: THREE.Mesh;
  near: THREE.Mesh | null;
  lod: ChunkLod;
}

export interface TerrainHandle {
  group: THREE.Group;
  slots: ChunkSlot[];
  material: THREE.MeshStandardMaterial;
}

export function createTerrain(
  sw: SceneWorld,
  quality: Pick<ThreeQuality, 'farStep' | 'shadows'>,
  landcover: THREE.Texture | null,
  aux: THREE.Texture | null = null,
  atmo?: WorldAtmosphere,
): TerrainHandle {
  const material = createTerrainMaterial({ landcover, aux, atmo, extent: sw.world.manifest.extent });
  const group = new THREE.Group();
  group.name = 'terrain';
  const slots = sw.chunks.map((chunk) => {
    const g = new THREE.Group();
    g.name = `chunk-${chunk.index}`;
    g.position.set(chunk.centerX, 0, chunk.centerZ);
    const far = new THREE.Mesh(toBufferGeometry(buildChunkGeometry(sw.heightfield, chunk, quality.farStep, undefined, sw.waterBed)), material);
    far.name = 'far';
    far.receiveShadow = quality.shadows;
    g.add(far);
    group.add(g);
    return { group: g, far, near: null, lod: 'far' as ChunkLod };
  });
  return { group, slots, material };
}

/**
 * One frame of LOD work: decide near/far per chunk from the camera position
 * (three.js x/z), build at most `buildsPerFrame` near meshes, drop the ones
 * no longer needed. Exported for tests.
 */
export function updateTerrainLod(
  handle: TerrainHandle,
  sw: SceneWorld,
  quality: Pick<ThreeQuality, 'nearStep' | 'nearRadiusM' | 'buildsPerFrame' | 'shadows'>,
  camX: number,
  camZ: number,
  visibility: ChunkVisibility,
): void {
  let budget = quality.buildsPerFrame;
  // Closest chunks first, so the one under the rider is always built first.
  const order = handle.slots
    .map((slot, i) => ({ i, d: Math.hypot(sw.chunks[i].centerX - camX, sw.chunks[i].centerZ - camZ) }))
    .sort((a, b) => a.d - b.d);
  for (const { i } of order) {
    const slot = handle.slots[i];
    const want = chunkLod(sw.chunks[i], camX, camZ, quality.nearRadiusM, slot.lod);
    slot.lod = want;
    if (want === 'near' && !slot.near && budget > 0) {
      budget--;
      const near = new THREE.Mesh(
        toBufferGeometry(buildChunkGeometry(sw.heightfield, sw.chunks[i], quality.nearStep, undefined, sw.waterBed)),
        handle.material,
      );
      near.name = 'near';
      near.receiveShadow = quality.shadows;
      slot.group.add(near);
      slot.near = near;
    }
    if (want === 'far' && slot.near) {
      slot.group.remove(slot.near);
      slot.near.geometry.dispose();
      slot.near = null;
    }
    const showNear = want === 'near' && slot.near !== null;
    if (slot.near) slot.near.visible = showNear;
    slot.far.visible = !showNear;
    visibility.set(i, showNear);
  }
}

export function disposeTerrain(handle: TerrainHandle) {
  for (const slot of handle.slots) {
    slot.far.geometry.dispose();
    slot.near?.geometry.dispose();
  }
  handle.material.dispose();
}

export function Terrain({
  sceneWorld,
  quality,
  landcover,
  aux = null,
  atmo,
  visibility,
}: {
  sceneWorld: SceneWorld;
  quality: ThreeQuality;
  landcover: THREE.Texture | null;
  aux?: THREE.Texture | null;
  atmo?: WorldAtmosphere;
  visibility: ChunkVisibility;
}) {
  const handle = useMemo(
    () => createTerrain(sceneWorld, quality, landcover, aux, atmo),
    // Rebuild only when what the far meshes depend on changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sceneWorld, quality.farStep, quality.shadows, landcover, aux, atmo],
  );
  useEffect(() => () => disposeTerrain(handle), [handle]);
  useFrame(({ camera }) => {
    updateTerrainLod(handle, sceneWorld, quality, camera.position.x, camera.position.z, visibility);
  });
  return <primitive object={handle.group} />;
}
