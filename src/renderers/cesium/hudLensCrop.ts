/**
 * Photoreal's lens shift for the floating ride window (lib/world/hudLens; the
 * three.js renderer sets a view offset). Cesium draws into a canvas taller
 * than the window by twice the shift, reaching above the window's top edge,
 * and the window shows its lower part. That is an off-centre frustum: the
 * picture's centre sits `shift` px above the window's centre, at the scale of
 * the uncropped view, so the rider lands in the clear band between the top
 * controls and the bar. The hidden strip is drawn too (sky and distant
 * hills), a quarter to a half more pixels in a window a fraction of the
 * screen's size.
 *
 * Not `PerspectiveFrustum.yOffset`: in Cesium 1.141 the scene draws from a
 * clone of the camera's frustum and `clone()` drops x/yOffset, and the offset
 * is in near-plane units while the scene sets its own near for every frustum
 * it draws (hudLensCrop.test.ts pins both, so a fixed Cesium shows up there).
 */

import { hudCoveredPx, hudLensShiftPx } from '@/lib/world/hudLens';

/** How to crop a `width`×`height` CSS px view for a HUD over its bottom `coveredPx`. */
export interface LensCrop {
  /** CSS px the canvas reaches above the view's top edge (twice the lens shift). */
  extendPx: number;
  /** The camera's fov over the taller canvas (Cesium's fov spans the canvas's longer side). */
  fov: number;
}

export function hudLensCrop(width: number, height: number, coveredPx: number, baseFov: number): LensCrop {
  const shift = hudLensShiftPx(height, coveredPx);
  if (shift <= 0 || !(width > 0)) return { extendPx: 0, fov: baseFov };
  const extendPx = 2 * shift;
  // Keep the uncropped view's pixels per radian. The fov spans the longer
  // side: the width in any landscape window (no change), the height once the
  // taller canvas is portrait.
  const k = Math.max(width, height + extendPx) / Math.max(width, height);
  return { extendPx, fov: k === 1 ? baseFov : 2 * Math.atan(Math.tan(baseFov / 2) * k) };
}

/** The parts of a Cesium viewer the crop touches (structural, so tests need no WebGL). */
export interface LensCropView {
  /** The viewer's container: Cesium's canvas fills it; it fills its frame (`absolute inset-0 h-full`). */
  container: {
    style: { top: string; height: string };
    clientWidth: number;
    clientHeight: number;
    closest?: (sel: string) => Element | null;
  };
  /** Perspective frustums have a fov; the crop leaves any other kind alone. */
  camera: { frustum: object };
  /** Viewer.resize: the canvas and the frustum's aspect follow the container now, not next frame. */
  resize(): void;
}

/** One per viewer: the crop applied and the fov it started with. */
export interface LensCropState {
  extendPx: number;
  fov: number;
  readonly baseFov: number;
}

function hasFov(frustum: object): frustum is { fov: number } {
  return 'fov' in frustum && typeof frustum.fov === 'number';
}

export function lensCropState(view: LensCropView): LensCropState {
  const { frustum } = view.camera;
  const baseFov = hasFov(frustum) ? frustum.fov : Math.PI / 3;
  return { extendPx: 0, fov: baseFov, baseFov };
}

/**
 * Bring the crop up to date with the HUD over the view; run before each frame
 * (Scene.preUpdate, ahead of the frame's camera and canvas size). With no HUD
 * and no crop applied (the tab) it reads one attribute and touches nothing.
 * Returns whether it changed the view.
 */
export function applyHudLensCrop(view: LensCropView, state: LensCropState): boolean {
  const covered = hudCoveredPx(view.container);
  if (covered <= 0 && state.extendPx === 0) return false;
  const { container } = view;
  // The frame the container fills: the container less the strip it reaches above it.
  const crop = hudLensCrop(container.clientWidth, container.clientHeight - state.extendPx, covered, state.baseFov);
  if (crop.extendPx === state.extendPx && crop.fov === state.fov) return false;
  state.extendPx = crop.extendPx;
  state.fov = crop.fov;
  // Taller by the strip, its bottom edge still on the frame's.
  container.style.top = crop.extendPx > 0 ? `-${crop.extendPx}px` : '';
  container.style.height = crop.extendPx > 0 ? `calc(100% + ${crop.extendPx}px)` : '';
  const { frustum } = view.camera;
  if (hasFov(frustum)) frustum.fov = crop.fov;
  view.resize();
  return true;
}
