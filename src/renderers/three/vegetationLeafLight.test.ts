import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createAtmosphere } from './materials/atmosphere';
import {
  TREE_COLORS,
  TREE_LEAF_LUMA,
  TREE_LEAF_TRANSMIT,
  TREE_LEAF_TRANSMIT_FACING,
  TREE_LEAF_TRANSMIT_GLSL,
  TREE_LEAF_TRANSMIT_KNEE,
  createTreeMaterial,
  treeLeafTransmit,
  treeLeafTransmitWeight,
} from './Vegetation';

function compiled(mat: THREE.Material) {
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  } as THREE.WebGLProgramParametersWithUniforms;
  mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

const luma = (c: readonly number[]) => c[0] * TREE_LEAF_LUMA[0] + c[1] * TREE_LEAF_LUMA[1] + c[2] * TREE_LEAF_LUMA[2];
const linear = (hex: string): [number, number, number] => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

describe('skylight through the leaves lights a crown where the sky does not', () => {
  it('weights the underside and shaded sides of a crown, not its top', () => {
    expect(treeLeafTransmitWeight(-1)).toBe(1);
    expect(treeLeafTransmitWeight(TREE_LEAF_TRANSMIT_FACING.full)).toBe(1);
    expect(treeLeafTransmitWeight(TREE_LEAF_TRANSMIT_FACING.none)).toBe(0);
    expect(treeLeafTransmitWeight(1)).toBe(0);
    expect(treeLeafTransmitWeight((TREE_LEAF_TRANSMIT_FACING.full + TREE_LEAF_TRANSMIT_FACING.none) / 2)).toBeCloseTo(0.5, 5);
    // The whole underside, most of a side-on face (the near avenue crowns are seen side-on), none of the top.
    expect(TREE_LEAF_TRANSMIT_FACING.full).toBeGreaterThanOrEqual(-0.5);
    expect(TREE_LEAF_TRANSMIT_FACING.full).toBeLessThan(0);
    expect(treeLeafTransmitWeight(0)).toBeGreaterThan(0.6);
    expect(treeLeafTransmitWeight(0)).toBeLessThan(1);
    expect(treeLeafTransmitWeight(0.8)).toBe(0);
    let prev = Infinity;
    for (let y = -1; y <= 1; y += 0.05) {
      const w = treeLeafTransmitWeight(y);
      expect(w).toBeLessThanOrEqual(prev);
      prev = w;
    }
  });

  it('gives every species the same brightness, in its own hue', () => {
    const sky: [number, number, number] = [1, 1, 1];
    const want = TREE_LEAF_TRANSMIT / Math.PI;
    // Every palette colour, plus the darkest and lightest autumn tints the shader mixes in.
    const bases = [...Object.values(TREE_COLORS).map(linear), [0.22, 0.14, 0.05] as [number, number, number], [0.32, 0.25, 0.08] as [number, number, number]];
    for (const base of bases) {
      const t = treeLeafTransmit(base, base, sky, -1);
      expect(luma(t)).toBeCloseTo(want, 6);
      // Same hue as the leaf (channel ratios kept).
      expect(t[0] / t[1]).toBeCloseTo(base[0] / base[1], 6);
      expect(t[2] / t[1]).toBeCloseTo(base[2] / base[1], 6);
    }
    // The dark cypress gains as much as the pale olive: neither stays black nor glows.
    const cypress = linear(TREE_COLORS.cypress);
    const olive = linear(TREE_COLORS.olive);
    expect(luma(treeLeafTransmit(cypress, cypress, sky, -1))).toBeCloseTo(luma(treeLeafTransmit(olive, olive, sky, -1)), 9);
    // Leaf clumps keep their light and dark masses (the leaf colour, not the base, is scaled).
    const park = linear(TREE_COLORS.park);
    const dark = park.map((v) => v * 0.62) as [number, number, number];
    expect(luma(treeLeafTransmit(dark, park, sky, -1))).toBeCloseTo(0.62 * want, 6);
    // It follows the sky: half the skylight, half the term; none on a crown's top.
    expect(luma(treeLeafTransmit(park, park, [0.5, 0.5, 0.5], -1))).toBeCloseTo(want / 2, 6);
    expect(luma(treeLeafTransmit(park, park, sky, 1))).toBe(0);
  });

  it('only fills what the light leaves dark, and never flips the shading order', () => {
    const park = linear(TREE_COLORS.park);
    const sky: [number, number, number] = [0.8, 0.9, 1.1];
    const full = treeLeafTransmit(park, park, sky, -1);
    const fill = luma(full);
    expect(fill).toBeGreaterThan(0);
    // A black fragment (the near-black avenue crown) gets all of it…
    expect(luma(treeLeafTransmit(park, park, sky, -1, [0, 0, 0]))).toBeCloseTo(fill, 9);
    // …a crown the sun or the sky already lights (noon) none of it.
    const grey = (l: number): [number, number, number] => [l, l, l];
    expect(luma(treeLeafTransmit(park, park, sky, -1, grey(TREE_LEAF_TRANSMIT_KNEE * fill)))).toBeCloseTo(0, 9);
    expect(luma(treeLeafTransmit(park, park, sky, -1, grey(10 * fill)))).toBe(0);
    // In between it fades smoothly, and lit + term still rises with the lit colour.
    expect(luma(treeLeafTransmit(park, park, sky, -1, grey(0.5 * TREE_LEAF_TRANSMIT_KNEE * fill)))).toBeCloseTo(fill / 2, 6);
    expect(TREE_LEAF_TRANSMIT_KNEE).toBeGreaterThanOrEqual(1.5);
    let prev = -Infinity;
    for (let l = 0; l <= 4 * TREE_LEAF_TRANSMIT_KNEE * fill; l += fill / 50) {
      const out = l + luma(treeLeafTransmit(park, park, sky, -1, grey(l)));
      expect(out).toBeGreaterThan(prev);
      prev = out;
    }
  });

  it.each([false, true])('is in the tree shader (leafy %s), lit like the rest of the colour and before the haze', (leafy) => {
    const shader = compiled(createTreeMaterial(createAtmosphere(), 0, leafy));
    const fs = shader.fragmentShader;
    expect(fs).toContain('uniform float uLeafTransmit;');
    expect(shader.uniforms.uLeafTransmit.value).toBe(TREE_LEAF_TRANSMIT);
    expect(TREE_LEAF_TRANSMIT).toBeGreaterThan(0);
    // Leaf colour after the clump variation, normalised by its species base colour's luminance.
    expect(fs).toContain(`gLeafHue = col / max(dot(base, vec3(${TREE_LEAF_LUMA.join(', ')})), 1e-3);`);
    expect(fs.indexOf('gLeafHue = col')).toBeGreaterThan(fs.indexOf('vec3 col = base * mix('));
    expect(fs.indexOf('gLeafHue = col')).toBeLessThan(fs.indexOf('col *= vAo * vAo'));
    // The term, its sky (env from straight up + hemisphere) and the shader weight that mirrors treeLeafTransmitWeight.
    expect(fs).toContain(TREE_LEAF_TRANSMIT_GLSL);
    expect(TREE_LEAF_TRANSMIT_GLSL).toContain('skyUp += getIBLIrradiance(upV);');
    expect(TREE_LEAF_TRANSMIT_GLSL).toContain('skyUp += getHemisphereLightIrradiance(hemisphereLights[0], upV);');
    const { full, none } = TREE_LEAF_TRANSMIT_FACING;
    const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
    expect(TREE_LEAF_TRANSMIT_GLSL).toContain(`float away = 1.0 - smoothstep(${f(full)}, ${f(none)}, dot(normalize(vNormal), upV));`);
    expect(TREE_LEAF_TRANSMIT_GLSL).toContain('vec3 leafSky = gLeafHue * skyUp * RECIPROCAL_PI * uLeafTransmit * away * vCrown;');
    expect(TREE_LEAF_TRANSMIT_GLSL).toContain(`vec3 lumaW = vec3(${TREE_LEAF_LUMA.join(', ')});`);
    expect(TREE_LEAF_TRANSMIT_GLSL).toContain(`float knee = ${f(TREE_LEAF_TRANSMIT_KNEE)} * dot(leafSky, lumaW) + 1e-6;`);
    expect(TREE_LEAF_TRANSMIT_GLSL).toContain('gl_FragColor.rgb += leafSky * (1.0 - smoothstep(0.0, knee, dot(gl_FragColor.rgb, lumaW)));');
    // After three's lighting and the sun translucency, before the haze and tone mapping.
    const term = fs.indexOf('gl_FragColor.rgb += leafSky');
    expect(term).toBeGreaterThan(fs.indexOf('gSunLit * (back * 0.45 + 0.05)'));
    expect(term).toBeGreaterThan(fs.indexOf('#include <lights_fragment_end>'));
    expect(term).toBeLessThan(fs.indexOf('gl_FragColor.rgb = applyAtmo(gl_FragColor.rgb, vWPos);'));
  });
});
