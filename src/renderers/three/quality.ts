/**
 * Graphics tiers for the world renderer: maps the rider's `graphicsQuality`
 * setting (lib/graphicsQuality; 'medium' is the "balanced" tier) to render
 * resolution, terrain detail, view distance, shadows and post-processing.
 *
 * Budget (blueprint §P1.4): 60 fps at 1920×1080 on the laptop iGPU (Intel Arc,
 * Meteor Lake) at 'medium'; ≥ 30 fps at 'low' on the tablet.
 */

import type { GraphicsQuality } from '@/lib/graphicsQuality';

export interface ThreeQuality {
  /** Upper bound on devicePixelRatio. */
  maxDpr: number;
  /** Upper bound on rendered pixels per frame (keeps fill cost flat on big screens). */
  maxRenderPixels: number;
  /** MSAA on the default framebuffer. */
  antialias: boolean;
  /** Sun shadow map around the rider (rider casts, terrain and roads receive). */
  shadows: boolean;
  shadowMapSize: number;
  /** Heightfield node step of near terrain chunks (1 = every 13 m node). */
  nearStep: number;
  /** Heightfield node step of far chunks. */
  farStep: number;
  /** Chunks closer than this (camera to chunk bounds, metres) draw at `nearStep`, with roads. */
  nearRadiusM: number;
  /** Linear fog end and camera far plane, metres. */
  viewDistanceM: number;
  /** Landcover colour map width, texels (height follows the world aspect). */
  landcoverTexels: number;
  /** Post-processing (SMAA + vignette + bloom). */
  postFx: boolean;
  /** Most near-terrain chunk geometries built per frame (spreads the cost). */
  buildsPerFrame: number;
  /** Half-size of the sun shadow box around the rider, metres (rider, near trees and houses cast). */
  shadowBoxM: number;
  /** Trees: detailed meshes out to `treeNearM`, low-poly out to `treeFarM`, at most `maxTrees` instances. */
  treeNearM: number;
  treeFarM: number;
  maxTrees: number;
  /** Trees within this distance cast sun shadows (0 = none). */
  treeShadowM: number;
  /** Extruded buildings out to this distance, metres (chunks beyond are not built). */
  buildingM: number;
  /** Rain/snow particles around the camera. */
  rainDrops: number;
  /** Terrain-shadow map resolution, texels per heightfield node (0 = off). */
  occlusionScale: number;
  /** Landmark labels shown at once. */
  maxLabels: number;
}

export const THREE_QUALITY: Readonly<Record<GraphicsQuality, ThreeQuality>> = {
  low: {
    maxDpr: 1,
    maxRenderPixels: 1280 * 720,
    antialias: false,
    shadows: false,
    shadowMapSize: 512,
    nearStep: 2,
    farStep: 8,
    nearRadiusM: 1200,
    viewDistanceM: 4500,
    landcoverTexels: 1024,
    postFx: false,
    buildsPerFrame: 1,
    shadowBoxM: 0,
    treeNearM: 110,
    treeFarM: 1600,
    maxTrees: 40_000,
    treeShadowM: 0,
    buildingM: 3500,
    rainDrops: 2500,
    occlusionScale: 0.25,
    maxLabels: 5,
  },
  medium: {
    maxDpr: 1.5,
    maxRenderPixels: 1920 * 1080,
    antialias: true,
    shadows: true,
    shadowMapSize: 1024,
    nearStep: 1,
    farStep: 4,
    nearRadiusM: 1800,
    viewDistanceM: 8000,
    landcoverTexels: 3072,
    postFx: false,
    buildsPerFrame: 1,
    shadowBoxM: 40,
    treeNearM: 200,
    treeFarM: 2600,
    maxTrees: 150_000,
    treeShadowM: 70,
    buildingM: 8000,
    rainDrops: 6000,
    occlusionScale: 0.5,
    maxLabels: 8,
  },
  high: {
    maxDpr: 2,
    maxRenderPixels: 2560 * 1440,
    antialias: true,
    shadows: true,
    shadowMapSize: 2048,
    nearStep: 1,
    farStep: 4,
    nearRadiusM: 2600,
    viewDistanceM: 11000,
    landcoverTexels: 4096,
    postFx: true,
    buildsPerFrame: 2,
    shadowBoxM: 60,
    treeNearM: 320,
    treeFarM: 5500,
    maxTrees: 260_000,
    treeShadowM: 110,
    buildingM: 11000,
    rainDrops: 10000,
    occlusionScale: 1,
    maxLabels: 10,
  },
};

export function threeQuality(q: GraphicsQuality | undefined): ThreeQuality {
  return THREE_QUALITY[q ?? 'medium'] ?? THREE_QUALITY.medium;
}

/**
 * Device pixel ratio for a canvas of `cssWidth × cssHeight` CSS pixels: the
 * screen's own ratio, capped by the tier and by its pixel budget.
 */
export function renderDpr(
  q: ThreeQuality,
  cssWidth: number,
  cssHeight: number,
  deviceDpr: number,
): number {
  const area = Math.max(1, cssWidth) * Math.max(1, cssHeight);
  const budget = Math.sqrt(q.maxRenderPixels / area);
  const dpr = Math.min(q.maxDpr, Number.isFinite(deviceDpr) && deviceDpr > 0 ? deviceDpr : 1, budget);
  // Two decimals so tiny resizes don't reallocate the framebuffer.
  return Math.max(0.5, Math.round(dpr * 100) / 100);
}
