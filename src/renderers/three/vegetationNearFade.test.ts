import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createAtmosphere } from './materials/atmosphere';
import { CHASE_FRAMING } from '@/lib/world/cameraFraming';
import { TREE_NEAR_FADE, createTreeMaterial, treeNearFadeKeep } from './Vegetation';

function compiled(mat: THREE.Material) {
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  } as THREE.WebGLProgramParametersWithUniforms;
  mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

describe('trees fade out of the chase camera near volume', () => {
  it('clears crowns at the camera and keeps the ones beside the rider', () => {
    expect(treeNearFadeKeep(0)).toBe(0);
    expect(treeNearFadeKeep(TREE_NEAR_FADE.clearM)).toBe(0);
    expect(treeNearFadeKeep(TREE_NEAR_FADE.solidM)).toBe(1);
    expect(treeNearFadeKeep((TREE_NEAR_FADE.clearM + TREE_NEAR_FADE.solidM) / 2)).toBeCloseTo(0.5, 5);
    // A crown 3-4 m from the camera (Tiber avenue) is mostly gone…
    expect(treeNearFadeKeep(3.5)).toBeLessThan(0.1);
    // …while the rider, a chase framing back, rides past fully drawn trees.
    expect(TREE_NEAR_FADE.solidM).toBeLessThanOrEqual(CHASE_FRAMING.standard.backM + 0.5);
  });

  it.each([false, true])('is in the tree shader (leafy %s), with the same distances', (leafy) => {
    const shader = compiled(createTreeMaterial(createAtmosphere(), 0, leafy));
    expect(shader.fragmentShader).toContain('uniform vec2 uNearFade;');
    expect(shader.fragmentShader).toContain('smoothstep(uNearFade.x, uNearFade.y, distance(vWPos, cameraPosition))');
    // Before the leaf cut and colour work, right after clipping.
    expect(shader.fragmentShader.indexOf('keepNear')).toBeGreaterThan(shader.fragmentShader.indexOf('#include <clipping_planes_fragment>'));
    const u = shader.uniforms.uNearFade.value as THREE.Vector2;
    expect([u.x, u.y]).toEqual([TREE_NEAR_FADE.clearM, TREE_NEAR_FADE.solidM]);
  });
});
