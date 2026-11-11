/**
 * Rivers, ponds and streams: the water geometry of the bundle (waterMesh.ts)
 * as one mesh with a glassy surface that reflects the live sky (the scene's
 * image-based light), wind ripples that drift downstream, a sun glint from
 * the key light, a fresnel toward the banks' far side, and rain rings when
 * it rains. Murky Tiber green-brown when you look down into it.
 *
 * The sea (coast worlds) is deep blue-green, lighter over the shallows, with
 * surf along the coast: a white band at the water's edge that swells and
 * ebbs, and a broken wave line just beyond it. A second mesh carries the sea
 * past the world's edge (`seaApron`), so the horizon is water.
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

import { createAtmosphere, patchWorldMaterial, type WorldAtmosphere } from './materials/atmosphere';
import { NOISE_GLSL } from './materials/toonTerrain';
import { buildWaterGeometry, levelLakes, seaApron, WATER_EDGE_M, type WaterGeometryData } from './waterMesh';
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
    key: 'water-v2',
    vertexPars: 'attribute float aKind;\nattribute float aShore;\nvarying float vKind;\nvarying float vShore;',
    vertexMain: 'vKind = aKind;\nvShore = aShore;',
    fragmentPars: `varying float vKind;\nvarying float vShore;\nfloat gFoam = 0.0;\n${NOISE_GLSL}`,
    fragmentReplace: [
      [
        '#include <color_fragment>',
        `#include <color_fragment>
  {
    // Murkier and greener in the river, a touch of silt where it's shallow (streams).
    vec2 wp = vec2(vWPos.x, -vWPos.z);
    diffuseColor.rgb *= 0.85 + 0.3 * vNoise(wp * 0.02);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.1, 0.09, 0.06), clamp(1.0 - vKind, 0.0, 1.0) * 0.8);
    if (vKind > 1.5) {
      // The sea: deep blue-green, lighter over the shallows near the coast.
      float pxM = max(length(fwidth(wp)), 1e-3);
      vec3 deep = vec3(0.012, 0.045, 0.075);
      vec3 shallow = vec3(0.035, 0.13, 0.14);
      vec3 sea = mix(deep, shallow, (1.0 - smoothstep(3.0, 70.0, vShore)) * 0.85);
      diffuseColor.rgb = sea * (0.88 + 0.24 * vNoise(wp * 0.008));
      // Surf: white water at the edge that swells and ebbs with the waves,
      // and a broken wave line just offshore. Fades out before it aliases.
      float swell = 0.5 + 0.5 * sin(uTime * 0.7 + vNoise(wp * 0.02) * 6.0);
      float edge = 1.0 - smoothstep(1.5 + 3.5 * swell, 4.0 + 5.0 * swell, vShore);
      float lace = 0.45 + 0.55 * vNoise(wp * 0.7 + vec2(uTime * 0.15, 0.0));
      float crest = 0.5 + 0.5 * sin(vShore * 0.45 - uTime * 1.1 + vNoise(wp * 0.05) * 3.0);
      float wave = smoothstep(0.82, 0.97, crest) * (1.0 - smoothstep(8.0, 24.0, vShore)) * vNoise(wp * 0.3 - uTime * 0.1);
      gFoam = clamp(edge * lace + wave * 0.7, 0.0, 1.0) * octF(1.5, pxM);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72, 0.76, 0.75), gFoam);
    }
  }`,
      ],
      [
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, 0.85, gFoam);`,
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

/** How far the sea runs on past the world's edge, metres: past every tier's far plane. */
export const SEA_APRON_M = 14_000;

function waterGeometry(data: WaterGeometryData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  g.setAttribute('aKind', new THREE.BufferAttribute(data.kinds, 1));
  g.setAttribute('aShore', new THREE.BufferAttribute(data.shore, 1));
  const n = new Float32Array(data.positions.length);
  for (let i = 1; i < n.length; i += 3) n[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  g.computeBoundingSphere();
  return g;
}

export function Water({ sceneWorld, atmo }: { sceneWorld: SceneWorld; atmo?: WorldAtmosphere }) {
  const shared = useMemo(() => atmo ?? createAtmosphere(), [atmo]);
  const group = useMemo(() => {
    const data = buildWaterGeometry(sceneWorld.world.water, sceneWorld.heightfield, WATER_EDGE_M, {
      levelLakes: levelLakes(sceneWorld.world),
      dryRoutes: sceneWorld.world.routes,
    });
    const material = createWaterMaterial(shared);
    const m = new THREE.Mesh(waterGeometry(data), material);
    m.name = 'water';
    m.receiveShadow = true;
    const apron = seaApron(sceneWorld.world.water, sceneWorld.heightfield, SEA_APRON_M);
    if (!apron.positions.length) return m;
    const g = new THREE.Group();
    g.name = 'water';
    m.name = 'water-surface';
    const a = new THREE.Mesh(waterGeometry(apron), material);
    a.name = 'sea-apron';
    g.add(m, a);
    return g;
  }, [sceneWorld, shared]);
  useEffect(
    () => () => {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      const first = group instanceof THREE.Mesh ? group : (group.children[0] as THREE.Mesh);
      (first.material as THREE.Material).dispose();
    },
    [group],
  );
  return <primitive object={group} />;
}
