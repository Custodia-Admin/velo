import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ROUTE_GUIDE, ROUTE_PAINT_HSL, createRouteGuideMaterial, routePaintColor } from './routeGuide';
import { ROUTE_WIDTH_M } from '../Roads';

const css = readFileSync(fileURLToPath(new URL('../../../index.css', import.meta.url)), 'utf8');

describe('route guide paint', () => {
  it('is the warm-atlas terracotta: the paper theme --primary token', () => {
    // The first --primary in index.css is the paper (light) theme's.
    const m = css.match(/--primary:\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%;/);
    expect(m).not.toBeNull();
    expect([Number(m![1]), Number(m![2]), Number(m![3])]).toEqual([ROUTE_PAINT_HSL.h, ROUTE_PAINT_HSL.s, ROUTE_PAINT_HSL.l]);
    // Read as sRGB, like CSS: hsl(14 64% 42%) is #b04727, not the pale pink
    // (#d88f6c) a linear reading of the same numbers gives.
    expect(routePaintColor().getHexString()).toBe('b04727');
  });

  it('fits inside the ribbon it is painted on, thin enough to read as paint', () => {
    expect(ROUTE_GUIDE.chevronHalfM + ROUTE_GUIDE.chevronStrokeM).toBeLessThanOrEqual(ROUTE_WIDTH_M / 2);
    expect(ROUTE_GUIDE.lineHalfM * 2).toBeLessThanOrEqual(0.15);
    // Chevrons are faint cues, never solid bars: well spaced along the route.
    expect(ROUTE_GUIDE.chevronEveryM).toBeGreaterThanOrEqual(5);
  });

  it('builds a transparent, depth-pulled material that discards off the paint', () => {
    const mat = createRouteGuideMaterial({ widthM: ROUTE_WIDTH_M, maxPull: 2.5 });
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as THREE.WebGLProgramParametersWithUniforms;
    mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('vGuideUv = uv;');
    expect(shader.vertexShader).toContain('uMaxPull');
    expect(shader.fragmentShader).toContain('if (paint < 0.01) discard;');
    expect(shader.uniforms.uGuideWidth.value).toBe(ROUTE_WIDTH_M);
    expect(shader.uniforms.uMaxPull.value).toBe(2.5);
  });
});
