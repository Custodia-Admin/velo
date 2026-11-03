import { describe, expect, it } from 'vitest';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import { useFrame } from '@react-three/fiber';
import type * as THREE from 'three';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { THREE_QUALITY } from './quality';
import { syntheticSceneWorld } from './syntheticWorld';
import { Terrain } from './Terrain';
import { ChunkVisibility } from './worldScene';

/** Puts the default camera at (x, 300, z) before the terrain's own frame callback. */
function CameraAt({ x, z }: { x: number; z: number }) {
  useFrame(({ camera }) => camera.position.set(x, 300, z), -1);
  return null;
}

const quality = { ...THREE_QUALITY.medium, nearRadiusM: 60, buildsPerFrame: 2 };

function chunkGroups(root: THREE.Object3D) {
  const terrain = root.getObjectByName('terrain')!;
  return terrain.children as THREE.Group[];
}
const nearShown = (g: THREE.Group) => g.children.some((m) => m.name === 'near' && m.visible);

describe('<Terrain> (r3f test renderer)', () => {
  it('mounts 8×8 chunk groups, each with a far-LOD mesh, positioned at the chunk centre', async () => {
    const sw = syntheticSceneWorld();
    const vis = new ChunkVisibility(sw.chunks.length);
    const r = await ReactThreeTestRenderer.create(
      <Terrain sceneWorld={sw} quality={quality} landcover={null} visibility={vis} />,
    );
    const groups = chunkGroups(r.scene.instance);
    expect(groups).toHaveLength(64);
    groups.forEach((g, i) => {
      expect(g.position.x).toBeCloseTo(sw.chunks[i].centerX);
      expect(g.position.z).toBeCloseTo(sw.chunks[i].centerZ);
      expect(g.children.find((m) => m.name === 'far')).toBeDefined();
    });
    await r.unmount();
  });

  it('builds the near LOD under the camera within the frame budget and swaps it in', async () => {
    const sw = syntheticSceneWorld();
    const vis = new ChunkVisibility(sw.chunks.length);
    const target = sw.chunks[27];
    const r = await ReactThreeTestRenderer.create(
      <>
        <CameraAt x={target.centerX} z={target.centerZ} />
        <Terrain sceneWorld={sw} quality={quality} landcover={null} visibility={vis} />
      </>,
    );
    await r.advanceFrames(1, 1 / 60);
    const groups = chunkGroups(r.scene.instance);
    const built = groups.filter((g) => g.children.some((m) => m.name === 'near')).length;
    expect(built).toBeGreaterThan(0);
    expect(built).toBeLessThanOrEqual(quality.buildsPerFrame);
    await r.advanceFrames(20, 1 / 60);
    expect(nearShown(groups[27])).toBe(true);
    expect(groups[27].children.find((m) => m.name === 'far')!.visible).toBe(false);
    expect(vis.near[27]).toBe(1);
    // Far corner chunk stays far.
    expect(nearShown(groups[0])).toBe(false);
    expect(vis.near[0]).toBe(0);
    await r.unmount();
  });

  it('drops near meshes once the camera has moved away', async () => {
    const sw = syntheticSceneWorld();
    const vis = new ChunkVisibility(sw.chunks.length);
    const a = sw.chunks[0];
    const b = sw.chunks[63];
    const r = await ReactThreeTestRenderer.create(
      <>
        <CameraAt x={a.centerX} z={a.centerZ} />
        <Terrain sceneWorld={sw} quality={quality} landcover={null} visibility={vis} />
      </>,
    );
    await r.advanceFrames(10, 1 / 60);
    expect(nearShown(chunkGroups(r.scene.instance)[0])).toBe(true);
    await r.update(
      <>
        <CameraAt x={b.centerX} z={b.centerZ} />
        <Terrain sceneWorld={sw} quality={quality} landcover={null} visibility={vis} />
      </>,
    );
    await r.advanceFrames(10, 1 / 60);
    const groups = chunkGroups(r.scene.instance);
    expect(groups[0].children.some((m) => m.name === 'near')).toBe(false);
    expect(nearShown(groups[63])).toBe(true);
    await r.unmount();
  });
});
