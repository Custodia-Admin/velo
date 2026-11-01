/**
 * Terrain material: a lit PBR surface coloured from the world's landcover
 * map (each field its own crop colour) and an aux map (crop-row direction,
 * row kind, woodland class), broken up with world-space detail at many
 * scales that fades out before it can alias: crop rows and furrows, grass
 * clumps, dry patches and bare soil, canopy mottling over woods, limestone on
 * steep faces, darker wet ground in rain. Lighting goes through the shared
 * world atmosphere (terrain/cloud shadows, aerial perspective). Real light
 * and texture, not flat toon bands (owner: the world must not read
 * "cartoony"); the file name follows the blueprint's file map.
 */

import * as THREE from 'three';

import { createAtmosphere, patchWorldMaterial, type WorldAtmosphere } from './atmosphere';
import { worldNoiseTexture } from './noiseTexture';

export interface TerrainMaterialOptions {
  /** Landcover colour map (north at row 0), or null for a plain meadow tint. */
  landcover: THREE.Texture | null;
  /** Aux map: r = crop-row angle / π, g = row kind, b = woodland class. */
  aux?: THREE.Texture | null;
  /** World extent in metres (x east, y north). */
  extent: { xMin: number; xMax: number; yMin: number; yMax: number };
  atmo?: WorldAtmosphere;
}

/** GLSL: hash + value noise robust at world-metre coordinates (no sin hash). */
export const NOISE_GLSL = /* glsl */ `
float vHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(vHash12(i), vHash12(i + vec2(1.0, 0.0)), u.x),
             mix(vHash12(i + vec2(0.0, 1.0)), vHash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float vFbm3(vec2 p) {
  return vNoise(p) * 0.55 + vNoise(p * 2.07 + 3.1) * 0.3 + vNoise(p * 4.3 + 7.7) * 0.15;
}
// Fade a detail octave of wavelength w metres as pixels grow toward it (anti-alias).
float octF(float w, float pxM) { return 1.0 - smoothstep(w * 0.25, w * 0.7, pxM); }
`;

export function createTerrainMaterial(opts: TerrainMaterialOptions): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#8b9a5b'),
    roughness: 0.95,
    metalness: 0,
  });
  const { xMin, xMax, yMin, yMax } = opts.extent;
  const uniforms = {
    uLandcover: { value: opts.landcover },
    uAux: { value: opts.aux ?? null },
    uHasLandcover: { value: opts.landcover ? 1 : 0 },
    uHasAux: { value: opts.aux ? 1 : 0 },
    uExtent: { value: new THREE.Vector4(xMin, yMin, 1 / (xMax - xMin), 1 / (yMax - yMin)) },
    uNoise: { value: worldNoiseTexture() },
  };
  mat.userData.uniforms = uniforms;
  patchWorldMaterial(mat, opts.atmo ?? createAtmosphere(), {
    key: 'terrain-v3',
    uniforms,
    vertexPars: 'varying vec3 vTerrainNormal;',
    vertexMain: 'vTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);',
    fragmentPars: `
uniform sampler2D uLandcover;
uniform sampler2D uAux;
uniform float uHasLandcover;
uniform float uHasAux;
uniform vec4 uExtent;
varying vec3 vTerrainNormal;
float gWater = 0.0;
float gForest = 0.0;
float gWetGround = 0.0;
vec2 gWp;
vec4 gNC = vec4(0.5);
uniform sampler2D uNoise;
${NOISE_GLSL}`,
    fragmentReplace: [
      [
        '#include <color_fragment>',
        `#include <color_fragment>
  {
    vec2 wp = vec2(vWPos.x, -vWPos.z);
    gWp = wp;
    float pxM = max(length(fwidth(wp)), 1e-3);
    // Four fetches of the shared noise tile = 16 octaves from 512 m to 0.37 m;
    // the mip chain fades each one out before it can alias.
    vec4 nA = texture2D(uNoise, wp * (1.0 / 4096.0));
    vec4 nB = texture2D(uNoise, wp * (1.0 / 320.0) + 0.37);
    vec4 nC = texture2D(uNoise, wp * (1.0 / 24.0) + 0.61);
    gNC = nC;
    vec3 col = diffuseColor.rgb;
    vec3 aux = vec3(0.0);
    if (uHasLandcover > 0.5) {
      // Warp the lookup a few metres so field edges wander like hedges and
      // ditches instead of showing the map's texel staircase up close.
      vec2 warp = (nB.ba - 0.5) * 7.0 + (nC.rg - 0.5) * 1.6;
      vec2 lp = wp + warp;
      vec2 luv = vec2((lp.x - uExtent.x) * uExtent.z, 1.0 - (lp.y - uExtent.y) * uExtent.w);
      col = texture2D(uLandcover, luv).rgb;
      if (uHasAux > 0.5) aux = texture2D(uAux, luv).rgb;
    }
    gWater = smoothstep(0.02, 0.07, col.b - max(col.r, col.g));
    gForest = smoothstep(0.8, 0.97, aux.b);
    float scrub = smoothstep(0.6, 0.75, aux.b) * (1.0 - gForest);
    float open_ = (1.0 - gWater) * (1.0 - gForest);
    // Broad tone across the valley and the hills.
    col *= 0.84 + 0.32 * (nA.r * 0.5 + nA.g * 0.3 + nA.b * 0.2);
    // Woods: crown mottling (~5 m crowns) so far forest reads as canopy, not felt.
    float can = nB.a * 0.65 + nC.r * 0.35;
    col *= mix(1.0, (0.45 + 0.95 * can * can) * 0.92, gForest);
    col *= mix(1.0, 0.8 + 0.4 * nB.b, scrub);
    // Crop rows / furrows / orchard rows: direction per field from the aux map.
    if (aux.g > 0.02) {
      float kind = aux.g;
      float ang = aux.r * 3.14159265;
      vec2 dir = vec2(cos(ang), sin(ang));
      float sp = kind > 0.75 ? 2.2 : kind > 0.4 ? 6.0 : 1.6;
      float u = dot(wp, vec2(-dir.y, dir.x)) / sp + nB.r * 0.8;
      float row = 0.5 + 0.5 * cos(u * 6.2831853);
      float str = (kind > 0.75 ? 0.3 : kind > 0.4 ? 0.22 : 0.16) * octF(sp, pxM);
      col *= mix(1.0, 0.8 + 0.4 * row, str * open_);
    }
    // Field grain at 40 m … 0.4 m.
    col *= mix(1.0, 0.84 + 0.32 * (nB.g * 0.6 + nB.b * 0.4), open_);
    float g1 = nC.r * 0.6 + nC.g * 0.4;
    col *= mix(1.0, 0.82 + 0.36 * g1, (1.0 - gWater) * (1.0 - gForest * 0.5));
    col *= mix(1.0, 0.8 + 0.4 * (nC.b * 0.6 + nC.a * 0.4), open_ * 0.8);
    // Sun-bleached patches, bare soil, greener tufts.
    float dry = smoothstep(0.58, 0.8, nB.g * 0.6 + nA.a * 0.4);
    col = mix(col, col * vec3(1.18, 1.08, 0.86), dry * 0.5 * open_);
    float soil = smoothstep(0.64, 0.84, nB.b * 0.7 + nC.r * 0.3);
    col = mix(col, vec3(0.21, 0.135, 0.075) * (0.8 + 0.4 * g1), soil * 0.3 * open_);
    col = mix(col, col * vec3(0.84, 0.97, 0.74), smoothstep(0.6, 0.85, nB.a) * 0.4 * open_);
    // Limestone and bare earth on steep faces.
    float slope = 1.0 - clamp(vTerrainNormal.y, 0.0, 1.0);
    vec3 rock = mix(vec3(0.33, 0.27, 0.2), vec3(0.36, 0.32, 0.26), nA.a);
    col = mix(col, rock * (0.85 + 0.3 * g1), smoothstep(0.32, 0.6, slope) * 0.75 * (1.0 - gWater));
    // Riverbed under the water surface: dark silt.
    col = mix(col, vec3(0.05, 0.06, 0.04), gWater);
    // Rain darkens soil and grass.
    gWetGround = uWet * (1.0 - gWater);
    col *= 1.0 - 0.32 * gWetGround;
    diffuseColor.rgb = col;
  }`,
      ],
      [
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, 0.12, gWater);
  roughnessFactor = mix(roughnessFactor, 0.62, gWetGround * 0.6);`,
      ],
      [
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
  {
    // Canopy relief on woods, lumpy grass and soil on open ground: bump from
    // screen-space derivatives of a height built from the fetched noise (no extra fetches).
    float h = gNC.r * 0.9 + gNC.g * 0.5 * (1.0 - gForest) + gNC.b * 0.25 * (1.0 - gForest);
    h *= 1.0 - gWater;
    vec3 vp = -vViewPosition;
    vec3 dpdx = dFdx(vp);
    vec3 dpdy = dFdy(vp);
    vec3 r1 = cross(dpdy, normal);
    vec3 r2 = cross(normal, dpdx);
    float det = dot(dpdx, r1);
    vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
    normal = normalize(abs(det) * normal - grad * (0.9 + 1.4 * gForest));
  }`,
      ],
    ],
  });
  return mat;
}
