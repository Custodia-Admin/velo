/**
 * Road ribbons over the near terrain, plus the ridden route's line.
 *
 * A chunk's road bucket is built when its near-LOD terrain is showing and
 * dropped when it goes back to far (far terrain is too coarse to drape on;
 * the landcover map draws the distant network instead). The route line is
 * the app route itself (what the rider follows), densified to 2 m, split by
 * chunk and draped on whichever LOD each chunk draws: a decal on the ground
 * with a capped depth bias, so it never shows through a building. Roads,
 * route line and rider all stand on the drawn triangles (worldScene
 * lodGround / drawnGround), never on the bilinear heightfield between them,
 * or on the bridge deck the route rides (worldScene.routeSurface).
 */

import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import type { Route } from '@/types';
import type { WorldAtmosphere } from './materials/atmosphere';
import { createRoadMaterial } from './materials/road';
import { createRouteGuideMaterial, routePaintColor } from './materials/routeGuide';
import type { ThreeQuality } from './quality';
import { bucketLines, buildRibbons, type RibbonGeometryData, type RibbonLine } from './roadRibbons';
import { ROAD_MAX_SEG_M, lodGround, routeSurface, type ChunkVisibility, type SceneWorld } from './worldScene';

/** Road surface lift above the drawn terrain, metres (the rider stays within 5 cm of it). */
export const ROAD_LIFT_M = 0.03;
export const ROUTE_LIFT_M = 0.045;
/**
 * Width of the ribbon the route guide is painted on, metres. The paint itself
 * (materials/routeGuide.ts) is a thin centre line with chevrons inside it;
 * the rest of the ribbon is transparent.
 */
export const ROUTE_WIDTH_M = 0.6;
/**
 * Route ribbon vertex spacing, metres. At 2 m a mitred corner across a carve
 * fold left a triangle 10 cm under the drawn terrain (Assisi start); 1.5 m
 * keeps every drawn point within 6 cm of it.
 */
export const ROUTE_MAX_SEG_M = 1.5;
/**
 * Most the route line's depth bias ever pulls it toward the camera, metres.
 * The bake keeps every building at least ROUTE_CLEAR_MIN_M (3.5 m) from the
 * route centreline, so a pull under that minus the half-width can never drag
 * the line in front of a wall it is behind.
 */
export const ROUTE_MAX_PULL_M = 2.5;

export function ribbonGeometry(data: RibbonGeometryData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  g.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  g.setAttribute('marking', new THREE.BufferAttribute(data.markings, 1));
  g.setAttribute('pull', new THREE.BufferAttribute(data.pulls, 1));
  g.setIndex(new THREE.BufferAttribute(data.indices, 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * Ribbons of one chunk's bucket, positions relative to the chunk centre,
 * draped on the near-LOD triangles (`nearStep`), the terrain they are drawn
 * over. A vertex past the chunk edge (the far end of a segment that crosses
 * it) takes the neighbour chunk's triangles (`lodGround`), the same height
 * the neighbour's bucket gives it, so the two never crack apart.
 */
export function buildBucket(sw: SceneWorld, i: number, nearStep: number): RibbonGeometryData {
  const chunk = sw.chunks[i];
  return buildRibbons(sw.heightfield, sw.roadBuckets[i], {
    maxSegM: ROAD_MAX_SEG_M,
    lift: ROAD_LIFT_M,
    originX: chunk.centerX,
    originZ: chunk.centerZ,
    keepSegment: (mx, my) => sw.locate(mx, my) === i,
    groundAt: lodGround(sw, nearStep),
  });
}

export interface RoadsHandle {
  group: THREE.Group;
  meshes: (THREE.Mesh | null)[];
  material: THREE.MeshStandardMaterial;
}

export function createRoads(sw: SceneWorld, atmo?: WorldAtmosphere): RoadsHandle {
  const group = new THREE.Group();
  group.name = 'roads';
  return { group, meshes: sw.chunks.map(() => null), material: createRoadMaterial({ atmo }) };
}

/** Follow the terrain's near set; build at most `budget` buckets. Exported for tests. */
export function updateRoads(
  handle: RoadsHandle,
  sw: SceneWorld,
  visibility: ChunkVisibility,
  budget: number,
  receiveShadow: boolean,
  nearStep: number,
): void {
  let left = budget;
  for (let i = 0; i < handle.meshes.length; i++) {
    const near = visibility.near[i] === 1;
    const mesh = handle.meshes[i];
    if (near && !mesh && left > 0 && sw.roadBuckets[i].length > 0) {
      left--;
      const m = new THREE.Mesh(ribbonGeometry(buildBucket(sw, i, nearStep)), handle.material);
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
  atmo,
}: {
  sceneWorld: SceneWorld;
  visibility: ChunkVisibility;
  quality: ThreeQuality;
  atmo?: WorldAtmosphere;
}) {
  const handle = useMemo(() => createRoads(sceneWorld, atmo), [sceneWorld, atmo]);
  useEffect(() => () => disposeRoads(handle), [handle]);
  useFrame(() => updateRoads(handle, sceneWorld, visibility, quality.buildsPerFrame, quality.shadows, quality.nearStep));
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

export interface RouteChunkPiece {
  chunk: number;
  /** Draped on the chunk's near-LOD triangles. */
  near: RibbonGeometryData;
  /** Draped on its far-LOD triangles. */
  far: RibbonGeometryData;
}

/**
 * The route ribbon, one piece per terrain chunk it crosses, each draped on
 * the triangles that chunk draws at either LOD (`lodGround`), so the line
 * hugs the visible ground instead of the bilinear heightfield that a coarse
 * LOD can bury. A vertex a piece shares with the next chunk's piece gets the
 * same height in both (the triangles of the chunk it lies in). The rider
 * stands on the same triangles (drawnGround). Positions are relative to the
 * chunk centre.
 */
export function buildRouteChunks(
  sw: SceneWorld,
  line: RibbonLine,
  steps: { near: number; far: number },
  routeId?: string,
): RouteChunkPiece[] {
  const buckets = bucketLines([line], sw.locate, sw.chunks.length, ROUTE_MAX_SEG_M);
  const nearGround = routeSurface(sw, routeId, lodGround(sw, steps.near));
  const farGround = routeSurface(sw, routeId, lodGround(sw, steps.far));
  const out: RouteChunkPiece[] = [];
  buckets.forEach((b, i) => {
    if (!b.length) return;
    const chunk = sw.chunks[i];
    const piece = (groundAt: (x: number, y: number) => number) =>
      buildRibbons(sw.heightfield, b, {
        maxSegM: ROUTE_MAX_SEG_M,
        lift: ROUTE_LIFT_M,
        originX: chunk.centerX,
        originZ: chunk.centerZ,
        keepSegment: (mx, my) => sw.locate(mx, my) === i,
        // On the decks this route rides, the line is painted on the deck.
        groundAt,
      });
    out.push({ chunk: i, near: piece(nearGround), far: piece(farGround) });
  });
  return out;
}

export function RouteLine({
  sceneWorld,
  route,
  visibility,
  quality,
  atmo,
}: {
  sceneWorld: SceneWorld;
  route: Route;
  visibility: ChunkVisibility;
  quality: Pick<ThreeQuality, 'nearStep' | 'farStep'>;
  atmo?: WorldAtmosphere;
}) {
  const handle = useMemo(() => {
    const c = routePaintColor();
    const material = createRouteGuideMaterial({
      color: c,
      widthM: ROUTE_WIDTH_M,
      bias: 0.12,
      biasPerM: 0.0025,
      maxPull: ROUTE_MAX_PULL_M,
      atmo,
    });
    const group = new THREE.Group();
    group.name = 'route-line';
    const pieces = buildRouteChunks(
      sceneWorld,
      routeLine(sceneWorld, route, [c.r, c.g, c.b]),
      { near: quality.nearStep, far: quality.farStep },
      route.id,
    ).map((p) => {
      const make = (data: RibbonGeometryData, lod: 'near' | 'far') => {
        const m = new THREE.Mesh(ribbonGeometry(data), material);
        m.name = `route-line-${p.chunk}-${lod}`;
        m.position.set(sceneWorld.chunks[p.chunk].centerX, 0, sceneWorld.chunks[p.chunk].centerZ);
        m.renderOrder = 2;
        group.add(m);
        return m;
      };
      return { chunk: p.chunk, near: make(p.near, 'near'), far: make(p.far, 'far') };
    });
    return { group, material, pieces };
  }, [sceneWorld, route, atmo, quality.nearStep, quality.farStep]);
  useEffect(
    () => () => {
      for (const p of handle.pieces) {
        p.near.geometry.dispose();
        p.far.geometry.dispose();
      }
      handle.material.dispose();
    },
    [handle],
  );
  // Follow the terrain: each piece shows the variant draped on the LOD its chunk draws.
  useFrame(() => {
    for (const p of handle.pieces) {
      const near = visibility.near[p.chunk] === 1;
      p.near.visible = near;
      p.far.visible = !near;
    }
  });
  return <primitive object={handle.group} />;
}
