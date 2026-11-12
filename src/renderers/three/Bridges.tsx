/**
 * Bridge structures (bridgeDecks.ts): slab, parapets and piers under every
 * baked deck, one mesh per terrain chunk and LOD (the deck ends meet the
 * terrain that chunk draws), frustum-culled by chunk. Nothing in a world
 * baked without bridges. The road ribbon on top is Roads.tsx's.
 */

import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { buildBridgeGeometry, type BridgeGeometryData, type DeckPiece } from './bridgeDecks';
import { createAtmosphere, patchWorldMaterial, type WorldAtmosphere } from './materials/atmosphere';
import type { ThreeQuality } from './quality';
import { bucketLines, type RibbonLine } from './roadRibbons';
import { lodHeightAt } from './terrainMesh';
import { ROAD_MAX_SEG_M, type ChunkVisibility, type SceneWorld } from './worldScene';

/** Weathered concrete (sRGB #8f8b84). */
const CONCRETE = new THREE.Color(0x8f8b84);

export function createBridgeMaterial(atmo: WorldAtmosphere): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: CONCRETE, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  return patchWorldMaterial(mat, atmo, { key: 'bridges-v1' });
}

function toGeometry(data: BridgeGeometryData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  g.setIndex(new THREE.BufferAttribute(data.indices, 1));
  g.computeBoundingSphere();
  return g;
}

export interface BridgeChunk {
  chunk: number;
  near: BridgeGeometryData;
  far: BridgeGeometryData;
}

/** Per chunk with any deck segment or pier: the structure draped for its near and far LOD. */
export function buildBridgeChunks(sw: SceneWorld, steps: { near: number; far: number }): BridgeChunk[] {
  const decks = [...sw.decks.values()];
  const piers = sw.world.bridges?.piers ?? [];
  if (!decks.length && !piers.length) return [];
  const lineOf = new Map<RibbonLine, DeckPiece>();
  const lines = decks.map((d) => {
    const l: RibbonLine = { points: d.xy, width: d.halfWidth * 2, color: [0, 0, 0], marking: 0 };
    lineOf.set(l, d);
    return l;
  });
  const buckets = bucketLines(lines, sw.locate, sw.chunks.length, ROAD_MAX_SEG_M);
  const pierChunks = piers.map((p) => sw.locate(p.x, p.y));
  const out: BridgeChunk[] = [];
  const hf = sw.heightfield;
  for (let i = 0; i < sw.chunks.length; i++) {
    const mine = buckets[i].map((l) => lineOf.get(l) as DeckPiece);
    if (!mine.length && !pierChunks.includes(i)) continue;
    const chunk = sw.chunks[i];
    const build = (step: number) =>
      buildBridgeGeometry(hf, mine, piers, {
        maxSegM: ROAD_MAX_SEG_M,
        originX: chunk.centerX,
        originZ: chunk.centerZ,
        keepSegment: (mx, my) => sw.locate(mx, my) === i,
        keepPier: (x, y) => sw.locate(x, y) === i,
        groundAt: (x, y) => lodHeightAt(hf, chunk, step, x, y),
      });
    out.push({ chunk: i, near: build(steps.near), far: build(steps.far) });
  }
  return out;
}

export function Bridges({
  sceneWorld,
  visibility,
  quality,
  atmo,
}: {
  sceneWorld: SceneWorld;
  visibility: ChunkVisibility;
  quality: Pick<ThreeQuality, 'nearStep' | 'farStep' | 'shadows'>;
  atmo?: WorldAtmosphere;
}) {
  const shared = useMemo(() => atmo ?? createAtmosphere(), [atmo]);
  const handle = useMemo(() => {
    const material = createBridgeMaterial(shared);
    const group = new THREE.Group();
    group.name = 'bridges';
    const pieces = buildBridgeChunks(sceneWorld, { near: quality.nearStep, far: quality.farStep }).map((p) => {
      const make = (data: BridgeGeometryData, lod: 'near' | 'far') => {
        const m = new THREE.Mesh(toGeometry(data), material);
        m.name = `bridges-${p.chunk}-${lod}`;
        m.position.set(sceneWorld.chunks[p.chunk].centerX, 0, sceneWorld.chunks[p.chunk].centerZ);
        m.castShadow = quality.shadows;
        m.receiveShadow = quality.shadows;
        group.add(m);
        return m;
      };
      return { chunk: p.chunk, near: make(p.near, 'near'), far: make(p.far, 'far') };
    });
    return { group, material, pieces };
  }, [sceneWorld, shared, quality.nearStep, quality.farStep, quality.shadows]);
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
  useFrame(() => {
    for (const p of handle.pieces) {
      const near = visibility.near[p.chunk] === 1;
      p.near.visible = near;
      p.far.visible = !near;
    }
  });
  return <primitive object={handle.group} />;
}
