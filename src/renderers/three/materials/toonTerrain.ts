/**
 * Terrain material: a lit PBR surface (MeshStandardMaterial) coloured from
 * the world's landcover map, broken up with world-space noise at three
 * scales, earth/rock on steep slopes and glossier water. Real light and
 * soft variation, not flat toon bands (owner: the world must not read
 * "cartoony"); the file name follows the blueprint's file map.
 */

import * as THREE from 'three';

export interface TerrainMaterialOptions {
  /** Landcover colour map (north at row 0), or null for a plain meadow tint. */
  landcover: THREE.Texture | null;
  /** World extent in metres (x east, y north). */
  extent: { xMin: number; xMax: number; yMin: number; yMax: number };
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
`;

export function createTerrainMaterial(opts: TerrainMaterialOptions): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#8b9a5b'),
    roughness: 0.93,
    metalness: 0,
  });
  const { xMin, xMax, yMin, yMax } = opts.extent;
  const uniforms = {
    uLandcover: { value: opts.landcover },
    uHasLandcover: { value: opts.landcover ? 1 : 0 },
    uExtent: { value: new THREE.Vector4(xMin, yMin, 1 / (xMax - xMin), 1 / (yMax - yMin)) },
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vTerrainWorld;\nvarying vec3 vTerrainNormal;',
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
  vTerrainWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uLandcover;
uniform float uHasLandcover;
uniform vec4 uExtent;
varying vec3 vTerrainWorld;
varying vec3 vTerrainNormal;
float vTerrainWater = 0.0;
${NOISE_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  {
    vec2 wxy = vec2(vTerrainWorld.x, -vTerrainWorld.z);
    vec3 base = diffuseColor.rgb;
    if (uHasLandcover > 0.5) {
      vec2 luv = vec2((wxy.x - uExtent.x) * uExtent.z, 1.0 - (wxy.y - uExtent.y) * uExtent.w);
      base = texture2D(uLandcover, luv).rgb;
    }
    float water = smoothstep(0.02, 0.07, base.b - max(base.r, base.g));
    vTerrainWater = water;
    // Fade fine noise where it would alias (far away / grazing).
    float fineAA = clamp(1.0 - fwidth(wxy.x * 0.37) * 1.6, 0.0, 1.0);
    float midAA = clamp(1.0 - fwidth(wxy.x * 0.031) * 1.6, 0.0, 1.0);
    float n1 = vNoise(wxy * 0.0045);
    float n2 = mix(0.5, vNoise(wxy * 0.031 + 17.0), midAA);
    float n3 = mix(0.5, vNoise(wxy * 0.37 + 5.0), fineAA);
    vec3 col = base * (0.86 + 0.2 * n1 + 0.16 * (n2 - 0.5));
    col *= mix(1.0, 0.92 + 0.16 * n3, 1.0 - water);
    col = mix(col, col * vec3(1.07, 1.0, 0.86), (n2 - 0.35) * 0.6 * (1.0 - water));
    float slope = 1.0 - clamp(vTerrainNormal.y, 0.0, 1.0);
    vec3 earth = vec3(0.29, 0.205, 0.12);
    vec3 rock = vec3(0.34, 0.31, 0.27);
    col = mix(col, mix(earth, rock, n2), smoothstep(0.3, 0.62, slope) * (1.0 - water));
    diffuseColor.rgb = col;
  }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, 0.16, vTerrainWater);`,
      );
  };
  // One program for every terrain chunk.
  mat.customProgramCacheKey = () => 'velo-terrain-v1';
  return mat;
}
