import type * as Cesium from 'cesium';

/**
 * Graphics quality tiers — each maps to a concrete set of Cesium scene params.
 *
 * low    — fastest: no MSAA, no shadows, high tile SSE, light fog.
 *           Best for integrated GPUs, older machines, or battery-saver mode.
 * medium — balanced: MSAA×2, shadows off (big cost), moderate SSE, fog on.
 *           Good for mid-range GPUs without sacrificing tile detail too much.
 * high   — maximum fidelity (the original look): MSAA×4, soft shadows,
 *           low SSE (more tile detail), full fog. For discrete GPUs.
 */
export type GraphicsQuality = 'low' | 'medium' | 'high';

export interface QualityParams {
  /** MSAA sample count. 1 = off. */
  msaaSamples: number;
  /** FXAA post-process enabled. */
  fxaa: boolean;
  /** Shadow map enabled on the viewer. */
  shadows: boolean;
  /** Shadow map soft-shadows. Only relevant when shadows = true. */
  softShadows: boolean;
  /** Shadow map texel size (power of 2). Only relevant when shadows = true. */
  shadowMapSize: number;
  /** Maximum shadow draw distance in metres. */
  shadowMaxDistance: number;
  /** Tileset maximumScreenSpaceError — lower = more detail, higher = faster. */
  maximumScreenSpaceError: number;
  /**
   * Globe terrain/imagery screen-space error (Cesium default 2). A chase
   * camera a few metres off the road looks across kilometres of terrain;
   * each step up roughly halves the tiles streamed and drawn.
   */
  globeMaximumScreenSpaceError: number;
  /** Fog density (scene.fog.density). */
  fogDensity: number;
  /**
   * Cinematic bloom post-process (glow on bright surfaces).
   * Enabled on medium and high — disabled on low for performance.
   */
  bloom: boolean;
  /**
   * Ambient occlusion post-process (contact shadows in crevices).
   * Enabled on high only — GPU-intensive, skip on low/medium.
   */
  ambientOcclusion: boolean;
  /**
   * Vignette + filmic colour-grade post-process.
   * A single cheap GLSL stage: corner darkening + filmic s-curve + shadow warmth.
   * Enabled on medium and high.
   */
  vignetteGrade: boolean;
  /**
   * Weather particle systems (rain, snow, fog).
   * Enabled on medium and high; skipped on low for integrated-GPU performance.
   * Particle counts are further scaled within weatherParticles.ts per tier.
   */
  particles: boolean;
  /**
   * Render resolution as a fraction of the canvas' CSS size (Cesium renders
   * at CSS pixels; devicePixelRatio is ignored). Capped by {@link maxRenderPixels}.
   */
  resolutionScale: number;
  /**
   * Upper bound on rendered pixels per frame. A 2560×1600 laptop panel at
   * 175 % is ~1.3 MP of CSS pixels, an external 4K at 100 % is 8.3 MP — the
   * cap keeps fill cost roughly constant whatever the display.
   */
  maxRenderPixels: number;
}

export const QUALITY_PARAMS: Record<GraphicsQuality, QualityParams> = {
  low: {
    msaaSamples: 1,
    fxaa: false,
    shadows: false,
    softShadows: false,
    shadowMapSize: 512,
    shadowMaxDistance: 1000,
    maximumScreenSpaceError: 32,
    globeMaximumScreenSpaceError: 4,
    fogDensity: 0.0002,
    // Cinematic effects off on low — integrated GPUs, battery saver.
    bloom: false,
    ambientOcclusion: false,
    vignetteGrade: false,
    particles: false,
    resolutionScale: 0.75,
    maxRenderPixels: 1280 * 720,
  },
  medium: {
    msaaSamples: 2,
    fxaa: true,
    shadows: false,
    softShadows: false,
    shadowMapSize: 1024,
    shadowMaxDistance: 1500,
    maximumScreenSpaceError: 24,
    globeMaximumScreenSpaceError: 3,
    fogDensity: 0.00015,
    // Bloom + vignette/grade on medium — cheap enough for mid-range GPUs.
    bloom: true,
    ambientOcclusion: false,
    vignetteGrade: true,
    particles: true,
    resolutionScale: 0.85,
    maxRenderPixels: 1920 * 1080,
  },
  high: {
    msaaSamples: 4,
    fxaa: true,
    shadows: true,
    softShadows: true,
    shadowMapSize: 2048,
    shadowMaxDistance: 2500,
    maximumScreenSpaceError: 16,
    globeMaximumScreenSpaceError: 2,
    fogDensity: 0.00012,
    // Full cinematic suite on high — bloom, AO, vignette/grade, and particles.
    bloom: true,
    ambientOcclusion: true,
    vignetteGrade: true,
    particles: true,
    resolutionScale: 1,
    maxRenderPixels: 2560 * 1440,
  },
};

export const QUALITY_LABELS: Record<GraphicsQuality, { label: string; sub: string }> = {
  low: { label: 'Low', sub: 'fastest' },
  medium: { label: 'Medium', sub: 'balanced' },
  high: { label: 'High', sub: 'best quality' },
};

/**
 * Render scale for a tier on a canvas of `cssWidth × cssHeight` CSS pixels:
 * the tier's scale, lowered so the frame stays within its pixel budget.
 */
export function resolutionScaleFor(quality: GraphicsQuality, cssWidth: number, cssHeight: number): number {
  const p = QUALITY_PARAMS[quality] ?? QUALITY_PARAMS.medium;
  const area = Math.max(1, cssWidth) * Math.max(1, cssHeight);
  const capped = Math.sqrt(p.maxRenderPixels / area);
  const scale = Math.min(p.resolutionScale, capped);
  // Two decimals: avoids re-allocating framebuffers for sub-pixel changes.
  return Math.max(0.4, Math.round(scale * 100) / 100);
}

/** Software rasterisers: everything is CPU-bound, use the cheapest tier. */
const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|software|microsoft basic render/i;
/** Discrete desktop GPUs that can carry the full tier. */
const DISCRETE_GPU = /nvidia|geforce|quadro|rtx|radeon rx|radeon pro|arc\(tm\) a\d{3}|arc a\d{3}/i;

/**
 * Recommended default tier for a WebGL renderer string (from
 * WEBGL_debug_renderer_info). Integrated GPUs (Intel Iris / Arc iGPU, Apple,
 * phone GPUs, AMD APUs) and unknown renderers get the balanced tier; discrete
 * GPUs get high; software rendering gets low.
 */
export function recommendedGraphicsQuality(renderer: string | null | undefined, isMobile = false): GraphicsQuality {
  const r = renderer ?? '';
  if (SOFTWARE_GPU.test(r)) return 'low';
  if (isMobile) return 'medium';
  if (DISCRETE_GPU.test(r)) return 'high';
  return 'medium';
}

/** The unmasked WebGL renderer string for the viewer's context, if exposed. */
export function webglRenderer(gl: WebGLRenderingContext | WebGL2RenderingContext | null | undefined): string | null {
  if (!gl) return null;
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const value = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Apply a quality tier to a live Cesium Viewer + optional 3D-tileset.
 * Safe to call after mount (viewer must not be destroyed).
 */
export function applyGraphicsQuality(
  viewer: Cesium.Viewer,
  quality: GraphicsQuality,
  tileset?: Cesium.Cesium3DTileset | null,
): void {
  if (viewer.isDestroyed()) return;

  const p = QUALITY_PARAMS[quality];
  const scene = viewer.scene;

  // Anti-aliasing
  scene.postProcessStages.fxaa.enabled = p.fxaa;
  if (scene.msaaSupported) scene.msaaSamples = p.msaaSamples;

  // Shadows
  viewer.shadows = p.shadows;
  scene.shadowMap.enabled = p.shadows;
  if (p.shadows) {
    scene.shadowMap.softShadows = p.softShadows;
    scene.shadowMap.size = p.shadowMapSize;
    scene.shadowMap.maximumDistance = p.shadowMaxDistance;
  }

  // Render resolution
  viewer.resolutionScale = resolutionScaleFor(quality, viewer.canvas.clientWidth, viewer.canvas.clientHeight);

  // Fog
  scene.fog.density = p.fogDensity;

  // Globe detail
  scene.globe.maximumScreenSpaceError = p.globeMaximumScreenSpaceError;

  // Tileset detail
  if (tileset && !tileset.isDestroyed()) {
    tileset.maximumScreenSpaceError = p.maximumScreenSpaceError;
  }
}
