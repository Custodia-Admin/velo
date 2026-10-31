import { describe, it, expect } from 'vitest';
import {
  QUALITY_PARAMS,
  recommendedGraphicsQuality,
  resolutionScaleFor,
  webglRenderer,
} from '@/lib/graphicsQuality';
import { shouldRenderOnDemand } from '@/lib/perf/renderMode';

describe('resolutionScaleFor', () => {
  it('uses the tier scale when the canvas is within budget', () => {
    // 2560×1600 at 175 % → 1463×914 CSS px (~1.34 MP).
    expect(resolutionScaleFor('medium', 1463, 914)).toBe(QUALITY_PARAMS.medium.resolutionScale);
    expect(resolutionScaleFor('high', 1463, 914)).toBe(1);
  });

  it('caps the rendered pixels on large canvases', () => {
    const s = resolutionScaleFor('medium', 3840, 2160);
    expect(s).toBeLessThan(QUALITY_PARAMS.medium.resolutionScale);
    expect(3840 * s * 2160 * s).toBeLessThanOrEqual(QUALITY_PARAMS.medium.maxRenderPixels * 1.02);
  });

  it('never goes below 0.4 and orders tiers low < medium < high at 1080p', () => {
    expect(resolutionScaleFor('low', 10000, 10000)).toBe(0.4);
    const low = resolutionScaleFor('low', 1920, 1080);
    const med = resolutionScaleFor('medium', 1920, 1080);
    const high = resolutionScaleFor('high', 1920, 1080);
    expect(low).toBeLessThan(med);
    expect(med).toBeLessThan(high);
    expect(med).toBeLessThanOrEqual(1);
  });

  it('is safe for a zero-size canvas', () => {
    expect(Number.isFinite(resolutionScaleFor('medium', 0, 0))).toBe(true);
  });
});

describe('recommendedGraphicsQuality', () => {
  it('picks balanced on integrated GPUs (the owner laptop: Meteor Lake Arc iGPU)', () => {
    expect(
      recommendedGraphicsQuality('ANGLE (Intel, Vulkan 1.4.354 (Intel(R) Arc(tm) Graphics (MTL) (0x00007D55)), Intel open-source Mesa driver)'),
    ).toBe('medium');
    expect(recommendedGraphicsQuality('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0)')).toBe('medium');
    expect(recommendedGraphicsQuality('Apple M2')).toBe('medium');
    expect(recommendedGraphicsQuality('ANGLE (AMD, AMD Radeon(TM) Graphics, OpenGL 4.6)')).toBe('medium');
    expect(recommendedGraphicsQuality(null)).toBe('medium');
  });

  it('picks high on discrete GPUs', () => {
    expect(recommendedGraphicsQuality('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)')).toBe('high');
    expect(recommendedGraphicsQuality('ANGLE (AMD, AMD Radeon RX 7900 XTX)')).toBe('high');
    expect(recommendedGraphicsQuality('ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics)')).toBe('high');
  });

  it('picks low on software rendering and balanced on phones', () => {
    expect(recommendedGraphicsQuality('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))')).toBe('low');
    expect(recommendedGraphicsQuality('llvmpipe (LLVM 17.0.6, 256 bits)')).toBe('low');
    expect(recommendedGraphicsQuality('NVIDIA GeForce RTX 4090', true)).toBe('medium');
  });
});

describe('webglRenderer', () => {
  it('reads the unmasked renderer when exposed, else RENDERER, else null', () => {
    const withExt = {
      RENDERER: 1,
      getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 2 }),
      getParameter: (p: number) => (p === 2 ? 'Intel Arc' : 'WebKit WebGL'),
    } as unknown as WebGL2RenderingContext;
    expect(webglRenderer(withExt)).toBe('Intel Arc');
    const noExt = { RENDERER: 1, getExtension: () => null, getParameter: () => 'WebKit WebGL' } as unknown as WebGL2RenderingContext;
    expect(webglRenderer(noExt)).toBe('WebKit WebGL');
    const throws = { getExtension: () => { throw new Error('lost'); } } as unknown as WebGL2RenderingContext;
    expect(webglRenderer(throws)).toBeNull();
    expect(webglRenderer(null)).toBeNull();
  });
});

describe('shouldRenderOnDemand', () => {
  it('renders on demand only while nothing moves (paused / finished, solo)', () => {
    expect(shouldRenderOnDemand('riding', 0)).toBe(false);
    expect(shouldRenderOnDemand('idle', 0)).toBe(false);
    expect(shouldRenderOnDemand('paused', 0)).toBe(true);
    expect(shouldRenderOnDemand('finished', 0)).toBe(true);
    // Friends keep riding while we pause.
    expect(shouldRenderOnDemand('paused', 2)).toBe(false);
  });
});
