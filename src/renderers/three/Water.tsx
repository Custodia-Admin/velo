/**
 * Rivers, ponds and streams: the water geometry of the bundle (waterMesh.ts)
 * as one mesh with a glassy surface that reflects the live sky (the scene's
 * image-based light), wind ripples that drift downstream, a sun glint from
 * the key light, a fresnel toward the banks' far side, and rain rings when
 * it rains. Murky Tiber green-brown when you look down into it.
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

import { createAtmosphere, patchWorldMaterial, type WorldAtmosphere } from './materials/atmosphere';
import { NOISE_GLSL } from './materials/toonTerrain';
import { buildWaterGeometry } from './waterMesh';

/** Longest water triangle edge: enough to follow a river's fall, cheap on triangles. */
export const WATER_EDGE_M = 45;
import type { SceneWorld } from './worldScene';

export function createWaterMaterial(atmo: WorldAtmosphere): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#1d2a1e'),
    roughness: 0.1,
    metalness: 0,
    envMapIntensity: 0.85,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  return patchWorldMaterial(mat, atmo, {
    key: 'water-v1',
    vertexPars: 'attribute float aKind;\nvarying float vKind;',
    vertexMain: 'vKind = aKind;',
    fragmentPars: `varying float vKind;\n${NOISE_GLSL}`,
    fragmentReplace: [
      [
        '#include <color_fragment>',
        `#include <color_fragment>
  {
    // Murkier and greener in the river, a touch of silt where it's shallow (streams).
    vec2 wp = vec2(vWPos.x, -vWPos.z);
    diffuseColor.rgb *= 0.85 + 0.3 * vNoise(wp * 0.02);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.1, 0.09, 0.06), (1.0 - vKind) * 0.8);
  }`,
      ],
      [
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
  {
    vec2 wp = vec2(vWPos.x, -vWPos.z);
    float pxM = max(length(fwidth(wp)), 1e-3);
    vec2 drift = uWind.yz * uTime * 0.6;
    vec2 q1 = wp * vec2(0.35, 0.9) + drift;
    vec2 q2 = wp * vec2(1.3, 0.7) - drift.yx * 1.4;
    float e = 0.15;
    float h0 = vNoise(q1) + 0.5 * vNoise(q2);
    float hx = vNoise(q1 + vec2(e, 0.0)) + 0.5 * vNoise(q2 + vec2(e, 0.0));
    float hy = vNoise(q1 + vec2(0.0, e)) + 0.5 * vNoise(q2 + vec2(0.0, e));
    float amp = (0.18 + 0.25 * min(uWind.x, 1.0)) * octF(1.0, pxM);
    // Rain: dense small rings.
    vec2 rq = wp * 3.0 + vec2(uTime * 0.0, uTime * 0.0);
    float r0 = vNoise(rq + uTime * 3.0);
    float rx = vNoise(rq + vec2(e * 2.0, 0.0) + uTime * 3.0);
    float ry = vNoise(rq + vec2(0.0, e * 2.0) + uTime * 3.0);
    vec3 d = vec3(h0 - hx, 0.0, -(h0 - hy)) * amp + vec3(r0 - rx, 0.0, -(r0 - ry)) * 0.5 * uWet * octF(0.3, pxM);
    normal = normalize(normal + (viewMatrix * vec4(d, 0.0)).xyz);
  }`,
      ],
    ],
  });
}

export function Water({ sceneWorld, atmo }: { sceneWorld: SceneWorld; atmo?: WorldAtmosphere }) {
  const shared = useMemo(() => atmo ?? createAtmosphere(), [atmo]);
  const mesh = useMemo(() => {
    const data = buildWaterGeometry(sceneWorld.world.water, sceneWorld.heightfield, WATER_EDGE_M);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    g.setAttribute('aKind', new THREE.BufferAttribute(data.kinds, 1));
    const n = new Float32Array(data.positions.length);
    for (let i = 1; i < n.length; i += 3) n[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, createWaterMaterial(shared));
    m.name = 'water';
    m.receiveShadow = true;
    return m;
  }, [sceneWorld, shared]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    },
    [mesh],
  );
  return <primitive object={mesh} />;
}
