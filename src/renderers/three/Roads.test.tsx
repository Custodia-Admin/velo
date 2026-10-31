import { describe, expect, it } from 'vitest';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import type * as THREE from 'three';

import type { Route } from '@/types';
import { THREE_QUALITY } from './quality';
import { ROAD_LIFT_M, Roads, RouteLine, routeLine } from './Roads';
import { syntheticSceneWorld } from './syntheticWorld';
import { ChunkVisibility } from './worldScene';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('<Roads> / <RouteLine> (r3f test renderer)', () => {
  it('builds a chunk bucket only while its near terrain shows, then drops it', async () => {
    const sw = syntheticSceneWorld();
    const vis = new ChunkVisibility(sw.chunks.length);
    // A chunk the east–west road (y = 0) runs through.
    const i = sw.locate(5, 0);
    const r = await ReactThreeTestRenderer.create(
      <Roads sceneWorld={sw} visibility={vis} quality={THREE_QUALITY.medium} />,
    );
    const group = r.scene.instance.getObjectByName('roads')!;
    await r.advanceFrames(2, 1 / 60);
    expect(group.children).toHaveLength(0);

    vis.set(i, true);
    await r.advanceFrames(1, 1 / 60);
    const mesh = group.getObjectByName(`roads-${i}`) as THREE.Mesh;
    expect(mesh).toBeDefined();
    expect(mesh.position.x).toBeCloseTo(sw.chunks[i].centerX);
    const g = mesh.geometry;
    for (const a of ['position', 'normal', 'color', 'uv', 'marking']) expect(g.getAttribute(a)).toBeDefined();
    // Ribbon vertices sit ROAD_LIFT_M over the ground.
    const pos = g.getAttribute('position');
    for (let v = 0; v < pos.count; v += 7) {
      const x = pos.getX(v) + mesh.position.x;
      const y = -(pos.getZ(v) + mesh.position.z);
      expect(pos.getY(v)).toBeCloseTo(sw.heightfield.sampleHeight(x, y) + ROAD_LIFT_M, 3);
    }

    vis.set(i, false);
    await r.advanceFrames(1, 1 / 60);
    expect(group.getObjectByName(`roads-${i}`)).toBeUndefined();
    await r.unmount();
  });

  it('draws the ridden route as a ribbon along the app route', async () => {
    const sw = syntheticSceneWorld();
    const pts = [
      [-300, 50],
      [0, 60],
      [300, -40],
    ].map(([x, y], k) => {
      const [lat, lon] = sw.projection.inverse(x, y);
      return { lat, lon, ele: 0, distance: k * 300 };
    });
    const route = { id: 'r', name: 'r', points: pts, totalDistance: 600 } as unknown as Route;
    const line = routeLine(sw, route, [1, 0, 0]);
    expect(line.points[0]).toBeCloseTo(-300, 3);
    expect(line.points[5]).toBeCloseTo(-40, 3);

    const r = await ReactThreeTestRenderer.create(<RouteLine sceneWorld={sw} route={route} />);
    const mesh = r.scene.instance.getObjectByName('route-line') as THREE.Mesh;
    expect(mesh).toBeDefined();
    const pos = mesh.geometry.getAttribute('position');
    expect(pos.count).toBeGreaterThan(2 * (600 / 2));
    expect((mesh.material as THREE.Material).transparent).toBe(true);
    await r.unmount();
  });
});
