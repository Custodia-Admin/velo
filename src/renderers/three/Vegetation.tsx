/**
 * Instanced trees from the bundle's vegetation seeds: oaks, olive groves,
 * cypress rows, poplars along the Tiber, stone pines in parks, field-edge
 * trees and garden trees, each with its own crown shape, size range and
 * colour (deciduous species turn with the season). Detailed meshes near the
 * rider, low-poly ones further out, nothing beyond the tier's tree distance
 * (the terrain's canopy texture carries the far woods). One draw call per
 * crown shape and ring; the instance buffers are refilled by copying whole
 * cells when the camera has moved far enough (treeField.ts).
 */

import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { createAtmosphere, patchWorldMaterial, type WorldAtmosphere } from './materials/atmosphere';
import { NOISE_GLSL } from './materials/toonTerrain';
import type { ThreeQuality } from './quality';
import { buildTreeField, gatherShape, selectTreeRings, TREE_PALETTE, TREE_SHAPES, TREE_STRIDE, type TreeField } from './treeField';
import { treeGeometry, type TreeLod } from './treeShapes';
import type { SceneWorld } from './worldScene';

/** Species colours (sRGB) in TREE_PALETTE order. */
export const TREE_COLORS: Readonly<Record<(typeof TREE_PALETTE)[number], string>> = {
  oak: '#3f4e26',
  conifer: '#28381f',
  scrub: '#4f5530',
  olive: '#6a755b',
  park: '#455829',
  cypress: '#212e1a',
  poplar: '#5a6a2e',
  hedgerow: '#415026',
  garden: '#48602d',
  willow: '#687651',
  'stone-pine': '#334623',
};

/** Palettes that turn in autumn (oak, park, poplar, hedgerow, garden, willow). */
const DECIDUOUS = new Set(['oak', 'park', 'poplar', 'hedgerow', 'garden', 'willow']);

/**
 * How far into autumn the deciduous trees are (0 summer green … 1 full
 * colour), by month. Umbrian oaks keep their dry brown leaves through winter.
 */
export function autumnFor(date: Date): number {
  return [0.3, 0.25, 0.1, 0, 0, 0, 0, 0, 0.03, 0.25, 0.45, 0.4][date.getMonth()];
}

/** Moving this far from the last gather triggers a new one, metres. */
export const TREE_REGATHER_M = 48;

/**
 * Trees fade out of the camera's near volume: fully gone closer than `clearM`
 * to the camera, fully there from `solidM` (a dithered fade in between). A
 * crown overhanging the path (Tiber's tree avenue, 8.9–9.4 km, where crowns
 * come within 3–4 m of the chase camera) otherwise fills a top corner of the
 * view with its shaded underside, near-black at golden hour.
 */
export const TREE_NEAR_FADE = { clearM: 3, solidM: 7 } as const;

/** Share of a tree fragment kept at `distM` from the camera (mirrors the shader). */
export function treeNearFadeKeep(distM: number): number {
  const t = Math.min(1, Math.max(0, (distM - TREE_NEAR_FADE.clearM) / (TREE_NEAR_FADE.solidM - TREE_NEAR_FADE.clearM)));
  return t * t * (3 - 2 * t);
}

/**
 * Skylight through the leaves. Leaves pass light: the sky reaches the eye
 * through a crown's outer leaf layers, so its shaded sides and underside
 * read deep green, not black. Without this term the dark palette × the crown
 * AO × the irradiance a fragment turned away from the sky gets left the
 * avenue crowns 6–11 m from the chase camera near-black at golden hour
 * (Tiber park 8.9–9.4 km, sRGB ≈ (8,9,6)); on distant crowns the haze hid it.
 *
 * The term is the leaf colour at unit luminance × the sky's irradiance from
 * straight up × this effective transmittance, on every side of the crown
 * but its sky-facing top (`treeLeafTransmitWeight`). Unit luminance: every
 * species gains the same brightness, so a pale autumn or olive crown doesn't
 * glow and a dark cypress doesn't stay black. It follows the light (night
 * stays dark) and goes in before the haze, like the rest of the lit colour.
 * It only fills what the light leaves dark (`TREE_LEAF_TRANSMIT_KNEE`): a
 * crown the sun or the sky already lights keeps its look. At noon the median
 * near crown moves about 3 levels of luminance, but its darkest shade
 * pockets still lift by about 9 (cat-bed numbers: vegetationLeafLight.test.ts).
 */
export const TREE_LEAF_TRANSMIT = 0.025;

/**
 * The skylight term fades out as the fragment's lit colour rises: all of it
 * on a black fragment, none once the lit luminance reaches this many times
 * the term's own. At ≥ 1.5 the result still rises with the lit colour, so no
 * shading order flips.
 */
export const TREE_LEAF_TRANSMIT_KNEE = 2;

/**
 * Where on the crown the skylight term applies, by the fragment normal's
 * world up component: all of it at or below `full` (underside, and most of
 * a side-on face), none at or above `none` (the top, lit by the sky itself).
 */
export const TREE_LEAF_TRANSMIT_FACING = { full: -0.3, none: 0.6 } as const;

/** Share of the skylight term a crown fragment gets by its normal's world up component (mirrors the shader). */
export function treeLeafTransmitWeight(normalUp: number): number {
  const { full, none } = TREE_LEAF_TRANSMIT_FACING;
  const t = Math.min(1, Math.max(0, (normalUp - full) / (none - full)));
  return 1 - t * t * (3 - 2 * t);
}

/** Luminance weights (linear Rec. 709) the skylight term normalises the leaf colour by. */
export const TREE_LEAF_LUMA = [0.2126, 0.7152, 0.0722] as const;

type Rgb = readonly [number, number, number];
const lumaOf = (c: Rgb) => c[0] * TREE_LEAF_LUMA[0] + c[1] * TREE_LEAF_LUMA[1] + c[2] * TREE_LEAF_LUMA[2];

/**
 * The linear radiance the skylight term adds to a crown fragment (mirrors
 * the shader): leaf colour `leaf` (after the clump variation), its species
 * base colour `base` (sets the luminance it is normalised by), the sky
 * irradiance from straight up `skyUp` (env + hemisphere, before three's ÷π),
 * and the fragment's lit colour so far `lit` (black by default).
 */
export function treeLeafTransmit(leaf: Rgb, base: Rgb, skyUp: Rgb, normalUp: number, lit: Rgb = [0, 0, 0]): [number, number, number] {
  const k = (TREE_LEAF_TRANSMIT * treeLeafTransmitWeight(normalUp)) / (Math.PI * Math.max(lumaOf(base), 1e-3));
  const t: [number, number, number] = [leaf[0] * skyUp[0] * k, leaf[1] * skyUp[1] * k, leaf[2] * skyUp[2] * k];
  const x = Math.min(1, Math.max(0, lumaOf(lit) / (TREE_LEAF_TRANSMIT_KNEE * lumaOf(t) + 1e-6)));
  const keep = 1 - x * x * (3 - 2 * x);
  return [t[0] * keep, t[1] * keep, t[2] * keep];
}

/** A GLSL float literal (always with a decimal point). */
const glslFloat = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/** Lit stage (before the haze): skylight through the leaves (TREE_LEAF_TRANSMIT). */
export const TREE_LEAF_TRANSMIT_GLSL = /* glsl */ `
  {
    vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    vec3 skyUp = vec3(0.0);
    #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
      skyUp += getIBLIrradiance(upV);
    #endif
    #if NUM_HEMI_LIGHTS > 0
      skyUp += getHemisphereLightIrradiance(hemisphereLights[0], upV);
    #endif
    float away = 1.0 - smoothstep(${glslFloat(TREE_LEAF_TRANSMIT_FACING.full)}, ${glslFloat(TREE_LEAF_TRANSMIT_FACING.none)}, dot(normalize(vNormal), upV));
    vec3 leafSky = gLeafHue * skyUp * RECIPROCAL_PI * uLeafTransmit * away * vCrown;
    vec3 lumaW = vec3(${TREE_LEAF_LUMA.join(', ')});
    float knee = ${glslFloat(TREE_LEAF_TRANSMIT_KNEE)} * dot(leafSky, lumaW) + 1e-6;
    gl_FragColor.rgb += leafSky * (1.0 - smoothstep(0.0, knee, dot(gl_FragColor.rgb, lumaW)));
  }`;

/** Fragment stage: dither-discard tree fragments in the camera's near volume. */
export const TREE_NEAR_FADE_GLSL = /* glsl */ `
  {
    float keepNear = smoothstep(uNearFade.x, uNearFade.y, distance(vWPos, cameraPosition));
    if (keepNear < 1.0) {
      float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      if (keepNear <= dither) discard;
    }
  }`;

const TREE_VERTEX_PARS = /* glsl */ `
attribute vec4 aInstA;
attribute vec4 aInstB;
attribute float aCrown;
attribute float aAo;
varying float vCrown;
varying float vAo;
varying float vPalette;
varying float vSeed;
varying vec3 vLeaf;
`;

/** Instance transform: unit tree → world (scale by crown radius/height, rotate, sway, place). */
const TREE_TRANSFORM = /* glsl */ `
  {
    float cr = cos(aInstA.w);
    float sr = sin(aInstA.w);
    // Per-tree proportions (squat or lanky, oval crowns) so no two read alike.
    vec3 shape = vec3(0.8 + 0.4 * fract(aInstB.w * 5.31), 0.88 + 0.24 * fract(aInstB.w * 3.73), 0.8 + 0.4 * fract(aInstB.w * 9.17));
    vec3 tp = vec3(position.x * aInstB.y, position.y * aInstB.x, position.z * aInstB.y) * shape;
    tp = vec3(cr * tp.x - sr * tp.z, tp.y, sr * tp.x + cr * tp.z);
    float sway = sin(uTime * (0.8 + aInstB.w * 0.6) + aInstB.w * 40.0 + aInstA.x * 0.03) * 0.7
      + sin(uTime * 2.3 + aInstB.w * 17.0) * 0.3;
    tp.xz += uWind.yz * uWind.x * sway * position.y * position.y * 0.02 * aInstB.x;
    transformed = aInstA.xyz + tp;
    vLeaf = tp + aInstB.w * 37.0;
    vCrown = aCrown;
    vAo = aAo;
    vPalette = aInstB.z;
    vSeed = aInstB.w;
  }`;

const TREE_NORMAL = /* glsl */ `
  vec3 objectNormal = vec3( normal );
  {
    float cr = cos(aInstA.w);
    float sr = sin(aInstA.w);
    vec3 shapeN = vec3(0.8 + 0.4 * fract(aInstB.w * 5.31), 0.88 + 0.24 * fract(aInstB.w * 3.73), 0.8 + 0.4 * fract(aInstB.w * 9.17));
    vec3 tn = vec3(normal.x / aInstB.y, normal.y / aInstB.x, normal.z / aInstB.y) / shapeN;
    objectNormal = normalize(vec3(cr * tn.x - sr * tn.z, tn.y, sr * tn.x + cr * tn.z));
  }
  #ifdef USE_TANGENT
    vec3 objectTangent = vec3( tangent.xyz );
  #endif`;

/**
 * Tree material. `leafy` (the near ring) breaks the crown into leaf clusters
 * at its silhouette: fragments whose view angle grazes the crown are cut by a
 * 3D cell pattern, so the outline reads as foliage instead of a smooth lump
 * while the interior stays solid (cheap: one hash noise, near trees only).
 */
export function createTreeMaterial(atmo: WorldAtmosphere, autumn: number, leafy = false): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0 });
  const palette = TREE_PALETTE.map((k) => new THREE.Color(TREE_COLORS[k]));
  const deciduous = TREE_PALETTE.map((k) => (DECIDUOUS.has(k) ? 1 : 0));
  const uniforms = {
    uPalette: { value: palette },
    uDeciduous: { value: deciduous },
    uAutumn: { value: autumn },
    uNearFade: { value: new THREE.Vector2(TREE_NEAR_FADE.clearM, TREE_NEAR_FADE.solidM) },
    uLeafTransmit: { value: TREE_LEAF_TRANSMIT },
  };
  mat.userData.uniforms = uniforms;
  return patchWorldMaterial(mat, atmo, {
    key: leafy ? 'trees-leafy-v4' : 'trees-v4',
    uniforms,
    vertexPars: TREE_VERTEX_PARS,
    vertexBegin: TREE_TRANSFORM,
    vertexReplace: [['#include <beginnormal_vertex>', TREE_NORMAL]],
    fragmentPars: `
uniform vec3 uPalette[${TREE_PALETTE.length}];
uniform float uDeciduous[${TREE_PALETTE.length}];
uniform float uAutumn;
uniform vec2 uNearFade;
uniform float uLeafTransmit;
varying float vCrown;
varying float vAo;
varying float vPalette;
varying float vSeed;
varying vec3 vLeaf;
// Leaf colour at unit luminance, for the skylight through the leaves (TREE_LEAF_TRANSMIT).
vec3 gLeafHue = vec3(0.0);
${NOISE_GLSL}
float leafHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float leafNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(leafHash(i), leafHash(i + vec3(1, 0, 0)), f.x), mix(leafHash(i + vec3(0, 1, 0)), leafHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(leafHash(i + vec3(0, 0, 1)), leafHash(i + vec3(1, 0, 1)), f.x), mix(leafHash(i + vec3(0, 1, 1)), leafHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}`,
    fragmentReplace: [
      [
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
${TREE_NEAR_FADE_GLSL}
  ${
    leafy
      ? `if (vCrown > 0.5) {
    // Leaf clusters at the silhouette (see createTreeMaterial).
    // Interpolated (foliage) normals: grazing only at the crown's true outline.
    float graze = 1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition)));
    // Fade out before a leaf cluster gets smaller than a few pixels (no sparkle).
    float px = length(fwidth(vLeaf));
    float cut = smoothstep(0.55, 0.95, graze) * 0.7 * (1.0 - smoothstep(0.12, 0.35, px));
    float leaves = leafNoise(vLeaf * 1.15) * 0.65 + leafNoise(vLeaf * 2.9) * 0.35;
    if (leaves < cut) discard;
  }`
      : ''
  }`,
      ],
      [
        '#include <color_fragment>',
        `#include <color_fragment>
  {
    int pi = int(vPalette + 0.5);
    vec3 base = uPalette[0];
    float dec = 0.0;
    for (int k = 0; k < ${TREE_PALETTE.length}; k++) {
      if (k == pi) { base = uPalette[k]; dec = uDeciduous[k]; }
    }
    // Autumn: muted ochre and brown on some trees, most still green.
    vec3 autumnCol = mix(vec3(0.22, 0.14, 0.05), vec3(0.32, 0.25, 0.08), fract(vSeed * 7.31));
    base = mix(base, autumnCol, uAutumn * dec * smoothstep(0.35, 0.75, fract(vSeed * 13.7)));
    base *= 0.8 + 0.4 * fract(vSeed * 3.17);
    float pxM = max(length(fwidth(vWPos)), 1e-3);
    // Leaf clumps: light and dark masses across the crown.
    float leaf = vNoise(vec2(vWPos.x * 1.6 + vWPos.y * 0.9, vWPos.z * 1.6 - vWPos.y * 0.7)) * 0.65
      + vNoise(vec2(vWPos.x * 4.1 - vWPos.y * 1.3, vWPos.z * 4.1 + vWPos.y * 1.1)) * 0.35;
    vec3 col = base * mix(1.0, 0.62 + 0.62 * leaf, vCrown * octF(0.8, pxM));
    gLeafHue = col / max(dot(base, vec3(${TREE_LEAF_LUMA.join(', ')})), 1e-3);
    col *= vAo * vAo * 1.1;
    vec3 bark = vec3(0.07, 0.058, 0.045) * (0.8 + 0.4 * vNoise(vWPos.xz * 3.0 + vWPos.y * 9.0));
    diffuseColor.rgb = mix(bark * vAo, col, step(0.5, vCrown));
  }`,
      ],
      [
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
  {
    // Clumpy relief on crowns so the canopy catches light in masses.
    vec2 q = vec2(vWPos.x * 1.2 + vWPos.y * 0.8, vWPos.z * 1.2 - vWPos.y * 0.6);
    float c0 = vNoise(q);
    float cx = vNoise(q + vec2(0.35, 0.0));
    float cy = vNoise(q + vec2(0.0, 0.35));
    vec3 d = vec3(c0 - cx, (c0 - cx + c0 - cy) * 0.3, c0 - cy) * 1.6 * vCrown;
    normal = normalize(normal + (viewMatrix * vec4(d, 0.0)).xyz);
  }`,
      ],
    ],
    beforeAtmo: `
  {
    // Light through the leaves when the sun is behind the tree (shadowed sun only).
    vec3 V = normalize(cameraPosition - vWPos);
    float back = pow(max(dot(-V, uSunDir), 0.0), 3.0);
    gl_FragColor.rgb += diffuseColor.rgb * gSunLit * (back * 0.45 + 0.05) * vCrown * vAo;
  }
${TREE_LEAF_TRANSMIT_GLSL}`,
  });
}

/** Depth material for tree shadows: same instance transform, no lighting. */
export function createTreeDepthMaterial(atmo: WorldAtmosphere): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = atmo.uniforms.uTime;
    shader.uniforms.uWind = atmo.uniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float uTime;\nuniform vec3 uWind;\n${TREE_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${TREE_TRANSFORM}`);
  };
  mat.customProgramCacheKey = () => 'velo-trees-depth-v1';
  return mat;
}

interface Slot {
  mesh: THREE.Mesh;
  geometry: THREE.InstancedBufferGeometry;
  buffer: THREE.InstancedInterleavedBuffer;
  shape: number;
  lod: TreeLod;
}

export interface VegetationHandle {
  group: THREE.Group;
  field: TreeField;
  slots: Slot[];
  material: THREE.MeshStandardMaterial;
  leafy: THREE.MeshStandardMaterial;
  depth: THREE.MeshDepthMaterial;
  base: THREE.BufferGeometry[];
  /** Camera position of the last gather (three x/z), NaN before the first. */
  lastX: number;
  lastZ: number;
  /** Instances drawn after the last gather. */
  drawn: number;
}

function makeSlot(base: THREE.BufferGeometry, material: THREE.Material, depth: THREE.Material, shape: number, lod: TreeLod, capacity: number, castShadow: boolean): Slot {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  for (const name of Object.keys(base.attributes)) geometry.setAttribute(name, base.getAttribute(name));
  const buffer = new THREE.InstancedInterleavedBuffer(new Float32Array(Math.max(1, capacity) * TREE_STRIDE), TREE_STRIDE, 1);
  buffer.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aInstA', new THREE.InterleavedBufferAttribute(buffer, 4, 0));
  geometry.setAttribute('aInstB', new THREE.InterleavedBufferAttribute(buffer, 4, 4));
  geometry.instanceCount = 0;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `trees-${TREE_SHAPES[shape]}-${lod}`;
  mesh.frustumCulled = false;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = lod === 'near';
  mesh.customDepthMaterial = depth;
  return { mesh, geometry, buffer, shape, lod };
}

export function createVegetation(sw: SceneWorld, quality: ThreeQuality, atmo: WorldAtmosphere, date = new Date()): VegetationHandle {
  const field = buildTreeField(sw.world.vegetation, sw.heightfield, sw.world.manifest.extent);
  const material = createTreeMaterial(atmo, autumnFor(date));
  const leafy = createTreeMaterial(atmo, autumnFor(date), true);
  const depth = createTreeDepthMaterial(atmo);
  const group = new THREE.Group();
  group.name = 'vegetation';
  const base: THREE.BufferGeometry[] = [];
  const slots: Slot[] = [];
  TREE_SHAPES.forEach((shape, s) => {
    if (field.perShape[s] === 0) return;
    for (const lod of ['near', 'far'] as const) {
      const g = treeGeometry(shape, lod);
      base.push(g);
      const slot = makeSlot(g, lod === 'near' ? leafy : material, depth, s, lod, Math.min(field.perShape[s], lod === 'near' ? 4000 : 20000), lod === 'near' && quality.treeShadowM > 0 && quality.shadows);
      slots.push(slot);
      group.add(slot.mesh);
    }
  });
  return { group, field, slots, material, leafy, depth, base, lastX: NaN, lastZ: NaN, drawn: 0 };
}

/** Regather the rings around the camera when it has moved far enough. Exported for tests. */
export function updateVegetation(handle: VegetationHandle, quality: ThreeQuality, camX: number, camZ: number, force = false): boolean {
  if (!force && Math.hypot(camX - handle.lastX, camZ - handle.lastZ) < TREE_REGATHER_M) return false;
  handle.lastX = camX;
  handle.lastZ = camZ;
  const sel = selectTreeRings(handle.field, camX, camZ, quality.treeNearM, quality.treeFarM, quality.maxTrees);
  let drawn = 0;
  for (const slot of handle.slots) {
    const want = sel.counts[slot.shape][slot.lod === 'near' ? 0 : 1];
    const cap = slot.buffer.array.length / TREE_STRIDE;
    if (want > cap) {
      // Grow with headroom; the old GPU buffer goes with the old attribute.
      const next = new THREE.InstancedInterleavedBuffer(new Float32Array(Math.ceil(want * 1.4) * TREE_STRIDE), TREE_STRIDE, 1);
      next.setUsage(THREE.DynamicDrawUsage);
      slot.geometry.setAttribute('aInstA', new THREE.InterleavedBufferAttribute(next, 4, 0));
      slot.geometry.setAttribute('aInstB', new THREE.InterleavedBufferAttribute(next, 4, 4));
      slot.buffer = next;
    }
    const cells = slot.lod === 'near' ? sel.near : sel.far;
    const n = gatherShape(handle.field, cells, slot.shape, slot.buffer.array as Float32Array);
    slot.geometry.instanceCount = n;
    slot.buffer.clearUpdateRanges();
    slot.buffer.addUpdateRange(0, Math.max(1, n) * TREE_STRIDE);
    slot.buffer.needsUpdate = true;
    slot.mesh.visible = n > 0;
    drawn += n;
  }
  handle.drawn = drawn;
  return true;
}

export function disposeVegetation(handle: VegetationHandle) {
  for (const s of handle.slots) s.geometry.dispose();
  for (const g of handle.base) g.dispose();
  handle.material.dispose();
  handle.leafy.dispose();
  handle.depth.dispose();
}

export function Vegetation({
  sceneWorld,
  quality,
  atmo,
  stats,
}: {
  sceneWorld: SceneWorld;
  quality: ThreeQuality;
  atmo?: WorldAtmosphere;
  /** Receives the instance count drawn (debug/perf). */
  stats?: { trees: number };
}) {
  const shared = useMemo(() => atmo ?? createAtmosphere(), [atmo]);
  const handle = useMemo(() => createVegetation(sceneWorld, quality, shared), [sceneWorld, quality, shared]);
  useEffect(() => () => disposeVegetation(handle), [handle]);
  useFrame(({ camera }) => {
    if (updateVegetation(handle, quality, camera.position.x, camera.position.z) && stats) stats.trees = handle.drawn;
  });
  return <primitive object={handle.group} />;
}
