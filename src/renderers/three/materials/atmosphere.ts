/**
 * Shared light and air for every world material: aerial perspective (haze
 * that warms toward the sun), a pooled height fog, terrain shadows from the
 * heightfield (a precomputed "sun clearance" map, see sunOcclusion.ts),
 * moving cloud shadows, and night. Materials are three.js built-ins patched
 * through `patchWorldMaterial`, so lighting, shadows and IBL stay stock.
 *
 * One `WorldAtmosphere` per scene: its uniform objects are shared by
 * reference, so the sky updates them once and every material follows.
 */

import * as THREE from 'three';

import { worldNoiseTexture } from './noiseTexture';

export interface WorldAtmosphere {
  uniforms: {
    uSkyCube: { value: THREE.Texture | null };
    uSunDir: { value: THREE.Vector3 };
    uSunCol: { value: THREE.Color };
    uHaze: { value: number };
    uFogDensity: { value: number };
    uFogFalloff: { value: number };
    uFogBase: { value: number };
    uFogTint: { value: THREE.Color };
    uFogTintMix: { value: number };
    uSunHaze: { value: number };
    uHazeTint: { value: THREE.Color };
    uHazeG: { value: number };
    uNight: { value: number };
    uWet: { value: number };
    uTime: { value: number };
    /** Sun clearance map: metres above ground a point must be to see the sun (≤ 0 = lit). */
    uOcc: { value: THREE.Texture | null };
    /** Ground height (relative to uHeightBase) on the same grid. */
    uHeight: { value: THREE.Texture | null };
    uHeightBase: { value: number };
    /** xMin, yMax (world metres), 1/width, 1/height of the occlusion/height maps' extent. */
    uOccBox: { value: THREE.Vector4 };
    uOccOn: { value: number };
    /** x = shadow strength 0–1, y = coverage 0–1, z/w = drift (metres). */
    uCloud: { value: THREE.Vector4 };
    uCloudH: { value: number };
    uAtmoNoise: { value: THREE.Texture };
    /** Wind sway: x = strength (m/s scaled), y/z = direction (three x/z). */
    uWind: { value: THREE.Vector3 };
  };
}

export function createAtmosphere(): WorldAtmosphere {
  return {
    uniforms: {
      uSkyCube: { value: null },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Color(1, 1, 1) },
      uHaze: { value: 1 / 20000 },
      uFogDensity: { value: 0 },
      uFogFalloff: { value: 1 / 200 },
      uFogBase: { value: 170 },
      uFogTint: { value: new THREE.Color(1, 1, 1) },
      uFogTintMix: { value: 0 },
      uSunHaze: { value: 0 },
      uHazeTint: { value: new THREE.Color(1, 1, 1) },
      uHazeG: { value: 0.75 },
      uNight: { value: 0 },
      uWet: { value: 0 },
      uTime: { value: 0 },
      uOcc: { value: null },
      uHeight: { value: null },
      uHeightBase: { value: 0 },
      uOccBox: { value: new THREE.Vector4(0, 0, 1, 1) },
      uOccOn: { value: 0 },
      uCloud: { value: new THREE.Vector4(0, 0, 0, 0) },
      uCloudH: { value: 2400 },
      uAtmoNoise: { value: worldNoiseTexture() },
      uWind: { value: new THREE.Vector3(0, 1, 0) },
    },
  };
}

/** GLSL shared by every patched world material (fragment side). */
export const ATMO_GLSL = /* glsl */ `
uniform samplerCube uSkyCube;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform float uHaze, uFogDensity, uFogFalloff, uFogBase, uFogTintMix, uSunHaze, uHazeG, uNight, uWet, uTime;
uniform vec3 uFogTint, uHazeTint;
uniform sampler2D uOcc;
uniform sampler2D uHeight;
uniform float uHeightBase;
uniform vec4 uOccBox;
uniform float uOccOn;
uniform vec4 uCloud;
uniform float uCloudH;
uniform vec3 uWind;
uniform sampler2D uAtmoNoise;
varying vec3 vWPos;
vec3 gSunLit = vec3(0.0);

vec2 occUv(vec3 wp) {
  return vec2((wp.x - uOccBox.x) * uOccBox.z, (wp.z + uOccBox.y) * uOccBox.w);
}

/** Terrain shadow + cloud shadow on the key light at a world point (1 = full sun). */
float sunVisibility(vec3 wp) {
  float vis = 1.0;
  if (uOccOn > 0.5) {
    vec2 uv = occUv(wp);
    if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) {
      float clearance = texture2D(uOcc, uv).r;
      float above = wp.y - (texture2D(uHeight, uv).r + uHeightBase);
      float soft = 2.5 + 0.04 * max(clearance, 0.0);
      vis = smoothstep(clearance - soft, clearance + soft, above);
    }
  }
  if (uCloud.x > 0.0) {
    // Cloud deck uCloudH above the point, projected along the sun.
    vec2 p = (wp.xz + uSunDir.xz / max(uSunDir.y, 0.12) * max(uCloudH - wp.y, 0.0) + uCloud.zw) * 0.00042;
    vec4 cn = texture2D(uAtmoNoise, p * 0.125);
    float n = cn.r * 0.6 + cn.g * 0.3 + cn.b * 0.1;
    float cov = mix(0.75, 0.2, uCloud.y);
    vis *= 1.0 - uCloud.x * smoothstep(cov, cov + 0.16, n);
  }
  return vis;
}

/** Aerial perspective + lit height fog (Quilez' exponential height fog). */
vec3 applyAtmo(vec3 col, vec3 wp) {
  vec3 ro = cameraPosition;
  vec3 d = wp - ro;
  float dist = length(d);
  vec3 rd = d / max(dist, 1e-3);
  float b = uFogFalloff;
  float k = b * rd.y * dist;
  float fogAmt = uFogDensity * exp(-b * (ro.y - uFogBase)) * (abs(k) > 1e-4 ? (1.0 - exp(-k)) / (b * rd.y) : dist);
  fogAmt = min(fogAmt, 60.0);
  float trans = exp(-fogAmt - uHaze * dist);
  vec3 sdir = normalize(vec3(rd.x, max(rd.y, 0.0) * 0.35 + 0.025, rd.z));
  vec3 fogCol = textureCube(uSkyCube, sdir).rgb;
  float mu = max(dot(rd, uSunDir), 0.0);
  vec3 tint = uFogTint * (0.75 + 0.6 * pow(mu, 6.0));
  float layer = 1.0 - exp(-fogAmt);
  fogCol = mix(fogCol, tint * max(dot(fogCol, vec3(0.333)) * 1.6, 0.05), uFogTintMix * clamp(layer * 1.4, 0.0, 1.0) + uFogTintMix * 0.25);
  float g = uHazeG;
  float cmu = dot(rd, uSunDir);
  float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cmu, 1.5) * 0.0796;
  fogCol = fogCol * uHazeTint + uSunCol * uSunHaze * (hg + 0.06) * (0.6 + 0.4 * layer);
  return col * trans + fogCol * (1.0 - trans);
}
`;

export interface PatchExtra {
  /** Program cache key suffix (one compiled program per distinct patch). */
  key: string;
  uniforms?: Record<string, { value: unknown }>;
  vertexPars?: string;
  /** Runs after <begin_vertex> (edit `transformed` / `objectNormal`). */
  vertexBegin?: string;
  /** Runs after <project_vertex> (vWPos is set). */
  vertexMain?: string;
  /** [search, replace] pairs applied to the vertex shader after the standard patch. */
  vertexReplace?: [string, string][];
  fragmentPars?: string;
  /** [search, replace] pairs applied to the fragment shader after the standard patch. */
  fragmentReplace?: [string, string][];
  /** Runs right before the atmosphere is applied (gl_FragColor holds the lit colour). */
  beforeAtmo?: string;
  /** A material's own shader edits, applied before the world patch. */
  onShader?: (shader: THREE.WebGLProgramParametersWithUniforms) => void;
}

const DIR_SHADOW_END = 'directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;\n\t\t#endif';

/**
 * Patch a built-in lit material (Standard/Lambert): world position varying,
 * terrain + cloud shadow on the directional light, `gSunLit` (shadowed sun
 * radiance at the fragment, for translucency), and the atmosphere applied
 * before tone mapping. Turns three's own fog off (the atmosphere replaces it).
 */
export function patchWorldMaterial<M extends THREE.Material>(mat: M, atmo: WorldAtmosphere, extra: PatchExtra): M {
  (mat as unknown as { fog: boolean }).fog = false;
  mat.onBeforeCompile = (shader) => {
    extra.onShader?.(shader);
    Object.assign(shader.uniforms, atmo.uniforms, extra.uniforms ?? {});
    let vs = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
varying vec3 vWPos;
uniform float uTime;
uniform vec3 uWind;
${extra.vertexPars ?? ''}`,
    );
    if (extra.vertexBegin) vs = vs.replace('#include <begin_vertex>', `#include <begin_vertex>\n${extra.vertexBegin}`);
    vs = vs.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
  {
    vec4 wpos = vec4(transformed, 1.0);
    #ifdef USE_BATCHING
      wpos = batchingMatrix * wpos;
    #endif
    #ifdef USE_INSTANCING
      wpos = instanceMatrix * wpos;
    #endif
    vWPos = (modelMatrix * wpos).xyz;
  }
  ${extra.vertexMain ?? ''}`,
    );
    for (const [a, b] of extra.vertexReplace ?? []) vs = vs.replace(a, b);
    shader.vertexShader = vs;
    let fs = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ATMO_GLSL}\n${extra.fragmentPars ?? ''}`)
      .replace('#include <fog_fragment>', '')
      .replace(
        '#include <lights_fragment_begin>',
        `float gSunVis = sunVisibility(vWPos);
${THREE.ShaderChunk.lights_fragment_begin
  .replace(
    'getDirectionalLightInfo( directionalLight, directLight );',
    'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= gSunVis;\n\t\tgSunLit = directLight.color;',
  )
  .replace(DIR_SHADOW_END, `${DIR_SHADOW_END}\n\t\tgSunLit = directLight.color;`)}`,
      )
      .replace(
        '#include <tonemapping_fragment>',
        `${extra.beforeAtmo ?? ''}
  gl_FragColor.rgb = applyAtmo(gl_FragColor.rgb, vWPos);
  #include <tonemapping_fragment>`,
      );
    for (const [a, b] of extra.fragmentReplace ?? []) fs = fs.replace(a, b);
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => `velo-world-${extra.key}`;
  return mat;
}
