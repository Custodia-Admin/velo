/**
 * Road surface material: vertex-coloured asphalt/gravel with soft worn
 * edges, grain, and painted lines (edge lines + 4.5/7.5 m centre dashes) on
 * marked classes. Ribbons sit a few centimetres above the heightfield; the
 * vertex shader pulls them toward the camera in depth (a decal bias that
 * grows with distance) so they never z-fight or dip under the terrain mesh.
 */

import * as THREE from 'three';
import { NOISE_GLSL } from './toonTerrain';

export interface RoadMaterialOptions {
  /** Depth pull at the camera, metres. */
  bias?: number;
  /** Extra pull per metre of distance. */
  biasPerM?: number;
  opacity?: number;
  /** Self-lit share (route line reads at distance). */
  emissive?: THREE.ColorRepresentation;
  /** Skip markings/grain (route line). */
  plain?: boolean;
}

export function createRoadMaterial(opts: RoadMaterialOptions = {}): THREE.MeshStandardMaterial {
  const transparent = (opts.opacity ?? 1) < 1;
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
    transparent,
    opacity: opts.opacity ?? 1,
    depthWrite: !transparent,
    emissive: new THREE.Color(opts.emissive ?? 0x000000),
  });
  const uniforms = {
    uBias: { value: opts.bias ?? 0.08 },
    uBiasPerM: { value: opts.biasPerM ?? 0.0016 },
  };
  const plain = opts.plain ? 1 : 0;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uBias;
uniform float uBiasPerM;
attribute float marking;
varying vec2 vRoadUv;
varying float vRoadMark;`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
  vRoadUv = uv;
  vRoadMark = marking;
  {
    float d = length(mvPosition.xyz);
    float pull = min(d * 0.5, uBias + d * uBiasPerM);
    mvPosition.xyz *= (d - pull) / max(d, 1e-4);
    gl_Position = projectionMatrix * mvPosition;
  }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec2 vRoadUv;
varying float vRoadMark;
${NOISE_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  if (${plain} == 0) {
    float u = vRoadUv.x;
    float v = vRoadUv.y;
    float edge = min(u, 1.0 - u);
    diffuseColor.rgb *= mix(0.8, 1.0, smoothstep(0.0, 0.14, edge));
    float grainAA = clamp(1.0 - fwidth(v * 2.3) * 1.5, 0.0, 1.0);
    diffuseColor.rgb *= 1.0 + (vNoise(vec2(v * 2.3, u * 6.0)) - 0.5) * 0.14 * grainAA;
    if (vRoadMark > 0.5) {
      float w = vRoadMark;
      float across = u * w;
      float fw = max(fwidth(across), 1e-4);
      float edgeDist = min(across, w - across);
      float edgeLine = 1.0 - smoothstep(0.06, 0.06 + fw * 1.5, abs(edgeDist - 0.3));
      float dash = 1.0 - step(4.5, mod(v, 12.0));
      float centre = (1.0 - smoothstep(0.06, 0.06 + fw * 1.5, abs(across - w * 0.5))) * dash * step(5.5, w);
      float paint = max(edgeLine, centre) * clamp(1.4 - fw * 4.0, 0.0, 1.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.78, 0.74), paint * 0.85);
    }
  }`,
      );
  };
  mat.customProgramCacheKey = () => `velo-road-v1-${plain}-${transparent ? 't' : 'o'}`;
  return mat;
}
