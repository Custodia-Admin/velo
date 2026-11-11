/**
 * Buildings: every footprint of the bundle extruded with its district's
 * palette (buildingMesh.ts), merged per terrain chunk (one draw call each,
 * frustum-culled by chunk). The wall shader adds plaster stains and rain
 * streaks, damp plinths, stone coursing, windows with wooden shutters (lit
 * at night) and roof-tile mottling, all fading out before they alias.
 * Chunks are built nearest first, a few per frame, out to the tier's
 * `buildingM`: as surveyed within `buildingDetailM`, as boxes beyond (a
 * house a kilometre off is a few pixels; its box is 4 walls and a roof), and
 * up to `buildingTris` in all, so a dense metro world stops short of the view
 * distance. Chunks the camera rides away from hide or turn to boxes again.
 */

import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { bucketBuildings, buildBuildingGeometry } from './buildingMesh';
import { createAtmosphere, patchWorldMaterial, type WorldAtmosphere } from './materials/atmosphere';
import type { ThreeQuality } from './quality';
import type { SceneWorld } from './worldScene';

export function createBuildingMaterial(atmo: WorldAtmosphere): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  return patchWorldMaterial(mat, atmo, {
    key: 'buildings-v1',
    vertexPars: 'attribute vec4 aWall;\nvarying vec4 vWall;',
    vertexMain: 'vWall = aWall;',
    fragmentPars: `varying vec4 vWall;
float gWin = 0.0;
float gLit = 0.0;
float bh(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }`,
    fragmentReplace: [
      [
        '#include <color_fragment>',
        `#include <color_fragment>
  if (vWall.z > 0.0) {
    float u = vWall.x;
    float v = vWall.y;
    float pxW = length(fwidth(vec2(u, v)));
    float sw = abs(vWall.w);
    // Plaster stains, rain streaks under the eaves, darker damp plinth.
    diffuseColor.rgb *= 0.9 + 0.12 * bh(floor(vec2(u * 0.4, v * 0.5)) + sw);
    float streak = bh(vec2(floor(u * 1.7), sw * 31.0));
    diffuseColor.rgb *= 1.0 - 0.12 * smoothstep(0.55, 1.0, streak) * (0.5 + 0.5 * sin(u * 0.9 + sw * 40.0));
    diffuseColor.rgb *= mix(0.66, 1.0, smoothstep(0.0, 1.6, v));
    if (vWall.w < 0.0 && pxW < 0.6) {
      // Stone: irregular coursing.
      float course = floor(v / 0.42);
      float blk = bh(vec2(floor(u / (0.6 + 0.5 * bh(vec2(course, sw)))), course) + sw);
      diffuseColor.rgb *= 0.86 + 0.22 * blk;
      float joint = smoothstep(0.06, 0.0, fract(v / 0.42));
      diffuseColor.rgb *= 1.0 - 0.18 * joint * (1.0 - smoothstep(0.2, 0.6, pxW));
    }
    if (vWall.z > 0.75 && pxW < 0.9) {
      float fl = floor((v - 0.9) / 3.1);
      vec2 cellUv = vec2(fract(u / 3.4), fract((v - 0.9) / 3.1));
      float win = step(0.32, cellUv.x) * step(cellUv.x, 0.68) * step(0.18, cellUv.y) * step(cellUv.y, 0.72) * step(0.0, fl);
      win *= 1.0 - smoothstep(0.4, 0.9, pxW);
      float id = bh(vec2(floor(u / 3.4), fl) + vWall.w * 17.0);
      gWin = win;
      gLit = step(0.55, id) * win;
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.025, 0.028, 0.032) + vec3(0.04, 0.03, 0.02) * id, win * 0.85);
      // Green or brown wooden shutters on some windows.
      float sh = step(0.45, id) * step(id, 0.8) * win * step(abs(cellUv.x - 0.5), 0.2);
      diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.12, 0.16, 0.10), vec3(0.22, 0.13, 0.07), step(0.62, id)), sh * 0.9 * (1.0 - uNight));
    }
    // Rain darkens walls from the top down.
    diffuseColor.rgb *= 1.0 - 0.18 * uWet;
  } else {
    // Roof: coppi tile rows and weathering.
    vec2 rp = vec2(vWPos.x, -vWPos.z);
    float pxR = length(fwidth(rp));
    float tiles = bh(floor(rp * vec2(3.0, 1.2)));
    float age = bh(floor(rp * 0.35) + abs(vWall.w) * 9.0);
    diffuseColor.rgb *= mix(1.0, 0.86 + 0.24 * tiles, 1.0 - smoothstep(0.15, 0.5, pxR));
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.78, 0.76, 0.72), smoothstep(0.6, 1.0, age) * 0.6);
    diffuseColor.rgb *= 1.0 - 0.25 * uWet;
  }`,
      ],
      [
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, 0.25, gWin);
  roughnessFactor = mix(roughnessFactor, 0.45, uWet * (1.0 - step(0.01, vWall.z)));`,
      ],
      [
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
  totalEmissiveRadiance += vec3(1.0, 0.62, 0.28) * gLit * uNight * 2.2;`,
      ],
    ],
  });
}

function toGeometry(d: ReturnType<typeof buildBuildingGeometry>): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(d.normals, 3));
  g.setAttribute('color', new THREE.BufferAttribute(d.colors, 3));
  g.setAttribute('aWall', new THREE.BufferAttribute(d.walls, 4));
  g.computeBoundingSphere();
  return g;
}

export interface BuildingsHandle {
  group: THREE.Group;
  buckets: number[][];
  /** Per chunk: the detailed mesh (footprints as surveyed), built once the camera comes within `detailM`. */
  meshes: (THREE.Mesh | null)[];
  /** Per chunk: the far mesh (every footprint as its box, `footprintBox`). */
  boxes: (THREE.Mesh | null)[];
  /** Triangles per chunk, detailed / boxes: estimated until built, then exact. */
  tris: number[];
  boxTris: number[];
  material: THREE.MeshStandardMaterial;
  /** Frames to skip before looking again (nothing was left to build). */
  pendingCheck: number;
}

/**
 * Triangles a footprint of `n` vertices extrudes to, at most: two per wall
 * and up to two per edge of roof (a hipped four-corner roof is 6).
 */
export function buildingTriangles(n: number): number {
  return 4 * n;
}

export function createBuildings(sw: SceneWorld, atmo: WorldAtmosphere): BuildingsHandle {
  const layer = sw.world.buildings;
  const buckets = bucketBuildings(layer, sw.locate, sw.chunks.length);
  const tris = buckets.map((b) => b.reduce((s, i) => s + buildingTriangles(layer.start[i + 1] - layer.start[i]), 0));
  const boxTris = buckets.map((b) => b.length * buildingTriangles(4));
  const group = new THREE.Group();
  group.name = 'buildings';
  const none = () => sw.chunks.map(() => null);
  return { group, buckets, meshes: none(), boxes: none(), tris, boxTris, material: createBuildingMaterial(atmo), pendingCheck: 0 };
}

/**
 * Chunks within `radius` of the camera, nearest first: detailed within
 * `detailM`, boxes beyond, and none past `maxTris` triangles counted from the
 * camera out. Builds what's missing, at most `budget` per call and none after
 * `timeBudgetMs` (one is always allowed); until a chunk's wanted mesh is
 * built it keeps showing the other one if it has it. Exported for tests.
 */
export function updateBuildings(
  handle: BuildingsHandle,
  sw: SceneWorld,
  camX: number,
  camZ: number,
  radius: number,
  budget: number,
  shadows: boolean,
  timeBudgetMs = Infinity,
  maxTris = Infinity,
  detailM = Infinity,
): number {
  if (handle.pendingCheck > 0) {
    handle.pendingCheck--;
    return 0;
  }
  const t0 = performance.now();
  let left = budget;
  const near = sw.chunks
    .map((c, i) => ({ i, d: Math.hypot(Math.max(c.minX - camX, 0, camX - c.maxX), Math.max(c.minZ - camZ, 0, camZ - c.maxZ)) }))
    .filter((o) => o.d <= radius && handle.buckets[o.i].length > 0)
    .sort((a, b) => a.d - b.d);
  /** Chunk → wants its detailed mesh (true) or its boxes (false); absent = hidden. */
  const want = new Map<number, boolean>();
  let total = 0;
  for (const { i, d } of near) {
    const detailed = d <= detailM;
    const t = detailed ? handle.tris[i] : handle.boxTris[i];
    if (total > 0 && total + t > maxTris) break;
    total += t;
    want.set(i, detailed);
  }
  const show = () => {
    for (let i = 0; i < handle.meshes.length; i++) {
      const m = handle.meshes[i];
      const b = handle.boxes[i];
      if (!m && !b) continue;
      const w = want.get(i);
      // The wanted one, else the other while the wanted one is being built.
      const pick = w === undefined ? null : ((w ? m : b) ?? m ?? b);
      if (m) m.visible = m === pick;
      if (b) b.visible = b === pick;
    }
  };
  const order = near.filter((o) => want.has(o.i) && !(want.get(o.i) ? handle.meshes[o.i] : handle.boxes[o.i]));
  // Nothing left to build: look again in 30 frames (the camera will have moved).
  if (order.length === 0) handle.pendingCheck = 30;
  for (const { i } of order) {
    if (left <= 0 || (left < budget && performance.now() - t0 > timeBudgetMs)) break;
    left--;
    const detailed = want.get(i)!;
    const chunk = sw.chunks[i];
    const data = buildBuildingGeometry(sw.world.buildings, handle.buckets[i], sw.heightfield, chunk.centerX, chunk.centerZ, !detailed);
    const mesh = new THREE.Mesh(toGeometry(data), handle.material);
    mesh.name = `buildings-${i}${detailed ? '' : '-boxes'}`;
    mesh.position.set(chunk.centerX, 0, chunk.centerZ);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    handle.group.add(mesh);
    if (detailed) {
      handle.meshes[i] = mesh;
      handle.tris[i] = data.positions.length / 9;
    } else {
      handle.boxes[i] = mesh;
      handle.boxTris[i] = data.positions.length / 9;
    }
  }
  show();
  return budget - left;
}

export function disposeBuildings(handle: BuildingsHandle) {
  for (const m of handle.meshes) m?.geometry.dispose();
  for (const m of handle.boxes) m?.geometry.dispose();
  handle.material.dispose();
}

export function Buildings({ sceneWorld, quality, atmo }: { sceneWorld: SceneWorld; quality: ThreeQuality; atmo?: WorldAtmosphere }) {
  const shared = useMemo(() => atmo ?? createAtmosphere(), [atmo]);
  const handle = useMemo(() => createBuildings(sceneWorld, shared), [sceneWorld, shared]);
  useEffect(() => () => disposeBuildings(handle), [handle]);
  useFrame(({ camera }) => {
    updateBuildings(handle, sceneWorld, camera.position.x, camera.position.z, quality.buildingM, 3, quality.shadows, 4, quality.buildingTris, quality.buildingDetailM);
  });
  return <primitive object={handle.group} />;
}

/** Road classes lit at night (index into the bundle's road classes). */
const LIT_ROADS = new Set(['primary', 'secondary', 'tertiary', 'residential', 'living_street', 'pedestrian', 'unclassified']);

/**
 * Street-lamp positions (three.js) every ~28 m along built-up roads: a lamp
 * stands only where a building is within 45 m. Exported for tests.
 */
export function streetLampPositions(sw: SceneWorld, spacingM = 28): Float32Array {
  const b = sw.world.buildings;
  const cell = 45;
  const occupied = new Set<string>();
  for (let i = 0; i < b.count; i++) {
    const k = b.start[i];
    occupied.add(`${Math.floor(b.xy[k * 2] / cell)},${Math.floor(b.xy[k * 2 + 1] / cell)}`);
  }
  const near = (x: number, y: number) => {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (occupied.has(`${cx + dx},${cy + dy}`)) return true;
    return false;
  };
  const out: number[] = [];
  const classes = sw.world.roads.classes;
  for (const road of sw.world.roads.roads) {
    if (!LIT_ROADS.has(classes[road.cls])) continue;
    const p = road.points;
    let carry = 0;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const len = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
      if (len < 1e-3) continue;
      const ux = (p[i + 2] - p[i]) / len;
      const uy = (p[i + 3] - p[i + 1]) / len;
      let d = carry;
      for (; d < len; d += spacingM) {
        // Lamps stand at the kerb, alternating sides.
        const side = (out.length / 3) % 2 === 0 ? 1 : -1;
        const off = road.width / 2 + 0.6;
        const x = p[i] + ux * d - uy * off * side;
        const y = p[i + 1] + uy * d + ux * off * side;
        if (!near(x, y)) continue;
        out.push(x, sw.heightfield.sampleHeight(x, y) + 6.5, -y);
      }
      carry = d - len;
    }
  }
  return new Float32Array(out);
}

function lampSprite(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (!g) return null;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,240,215,1)');
  grd.addColorStop(0.15, 'rgba(255,200,140,0.75)');
  grd.addColorStop(1, 'rgba(255,150,80,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Warm street lights in towns at night (one draw call; hidden by day). */
export function StreetLights({ sceneWorld, atmo }: { sceneWorld: SceneWorld; atmo: WorldAtmosphere }) {
  const points = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(streetLampPositions(sceneWorld), 3));
    g.computeBoundingSphere();
    const mat = new THREE.PointsMaterial({
      map: lampSprite(),
      color: new THREE.Color(3.2, 2.1, 1.2),
      size: 7,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const p = new THREE.Points(g, mat);
    p.name = 'street-lights';
    p.visible = false;
    return p;
  }, [sceneWorld]);
  useEffect(
    () => () => {
      points.geometry.dispose();
      const m = points.material as THREE.PointsMaterial;
      m.map?.dispose();
      m.dispose();
    },
    [points],
  );
  useFrame(() => {
    const night = atmo.uniforms.uNight.value;
    points.visible = night > 0.3;
    (points.material as THREE.PointsMaterial).opacity = Math.min(1, (night - 0.3) / 0.4);
  });
  return <primitive object={points} />;
}
