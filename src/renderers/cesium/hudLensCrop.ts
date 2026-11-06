/**
 * Photoreal's lens: the camera's field of view, and its shift in the floating
 * ride window. This module owns `camera.frustum.fov` for the ride view.
 *
 * Field of view. Both renderers draw the ride with the same vertical field
 * (lib/world/cameraFraming RIDE_FOV_Y_DEG) and the same chase framing, so the
 * rider is the same size in the same place whichever renderer draws. Cesium's
 * `PerspectiveFrustum.fov` spans the canvas's LONGER side (three's is
 * vertical): its default 60° is 60° across a landscape view, ~36° vertical at
 * 16:9, which zoomed photoreal in ~1.7x. The fov is set again whenever the
 * canvas's shape changes.
 *
 * Lens shift (lib/world/hudLens; the three.js renderer sets a view offset).
 * Cesium draws into a canvas taller than the window by twice the shift,
 * reaching above the window's top edge, and the window shows its lower part.
 * That is an off-centre frustum: the picture's centre sits `shift` px above
 * the window's centre, at the scale of the uncropped view, so the rider lands
 * in the clear band between the top controls and the bar. The hidden strip is
 * drawn too (sky and distant hills), a quarter to a half more pixels in a
 * window a fraction of the screen's size.
 *
 * Not `PerspectiveFrustum.yOffset`: in Cesium 1.141 the scene draws from a
 * clone of the camera's frustum and `clone()` drops x/yOffset, and the offset
 * is in near-plane units while the scene sets its own near for every frustum
 * it draws (hudLensCrop.test.ts pins both, so a fixed Cesium shows up there).
 */

import { hudCoveredPx, hudLensShiftPx } from '@/lib/world/hudLens';

/**
 * Cesium's `PerspectiveFrustum.fov` for a vertical field `fovY` (radians) on a
 * canvas `aspect` (width / height) wide. Cesium reads `fov` across the longer
 * side: the width in landscape, the height in portrait.
 */
export function cesiumFov(fovY: number, aspect: number): number {
  if (!(aspect > 1)) return fovY;
  return 2 * Math.atan(Math.tan(fovY / 2) * aspect);
}

/** How to crop a `width`×`height` CSS px view for a HUD over its bottom `coveredPx`. */
export interface LensCrop {
  /** CSS px the canvas reaches above the view's top edge (twice the lens shift). */
  extendPx: number;
  /**
   * Vertical field over the whole (taller) canvas, radians: the view's `fovY`
   * at the view's scale, so the window shows the uncropped picture moved up.
   */
  canvasFovY: number;
}

export function hudLensCrop(width: number, height: number, coveredPx: number, fovY: number): LensCrop {
  const shift = hudLensShiftPx(height, coveredPx);
  if (shift <= 0 || !(width > 0)) return { extendPx: 0, canvasFovY: fovY };
  const extendPx = 2 * shift;
  // Same pixels per radian as the uncropped view: the canvas is taller by
  // extendPx, so its tangent grows by the same ratio.
  return { extendPx, canvasFovY: 2 * Math.atan((Math.tan(fovY / 2) * (height + extendPx)) / height) };
}

/** The parts of a Cesium viewer the lens touches (structural, so tests need no WebGL). */
export interface LensCropView {
  /** The viewer's container: Cesium's canvas fills it; it fills its frame (`absolute inset-0 h-full`). */
  container: {
    style: { top: string; height: string };
    clientWidth: number;
    clientHeight: number;
    closest?: (sel: string) => Element | null;
  };
  /**
   * Perspective frustums have a fov and the canvas's aspect (Cesium keeps it
   * current: Viewer.resize, and its render loop before each frame); the lens
   * leaves any other kind alone.
   */
  camera: { frustum: object };
  /** Viewer.resize: the canvas and the frustum's aspect follow the container now, not next frame. */
  resize(): void;
  /**
   * False while something else drives the frustum: a WebXR session sets each
   * eye's projection itself (lib/webxr, off Cesium's default render loop).
   */
  ownsFrustum?(): boolean;
}

/** One per viewer: the crop applied, and the vertical field the view keeps. */
export interface LensCropState {
  extendPx: number;
  /** The view's vertical field of view, radians. */
  readonly fovY: number;
}

export function lensCropState(fovY: number): LensCropState {
  return { extendPx: 0, fovY };
}

function perspective(frustum: object): frustum is { fov: number; aspectRatio: number } {
  return 'fov' in frustum && typeof frustum.fov === 'number' && 'aspectRatio' in frustum && typeof frustum.aspectRatio === 'number';
}

/**
 * The vertical field (degrees, one decimal) a view shows: the frustum's over a
 * canvas `canvasHeight` CSS px tall, less the `cropTopPx` above the view. For
 * the ride debug probe; null for a frustum without a fov.
 */
export function viewFovYDeg(frustum: object, canvasHeight: number, cropTopPx: number): number | null {
  if (!perspective(frustum) || !(canvasHeight > cropTopPx)) return null;
  const { fov, aspectRatio } = frustum;
  const canvasFovY = aspectRatio > 1 ? 2 * Math.atan(Math.tan(fov / 2) / aspectRatio) : fov;
  const viewFovY = 2 * Math.atan((Math.tan(canvasFovY / 2) * (canvasHeight - cropTopPx)) / canvasHeight);
  return Math.round(((viewFovY * 180) / Math.PI) * 10) / 10;
}

/**
 * Bring the lens up to date with the canvas's shape and the HUD over the view;
 * run before each frame (Scene.preUpdate, ahead of the frame's camera and
 * canvas size). In the tab (no HUD, no crop) it reads one attribute and the
 * frustum, and writes the fov only when the canvas's shape changed.
 * Returns whether it changed the view.
 */
export function applyHudLensCrop(view: LensCropView, state: LensCropState): boolean {
  if (view.ownsFrustum && !view.ownsFrustum()) return false;
  const covered = hudCoveredPx(view.container);
  let changed = false;
  let canvasFovY = state.fovY;
  if (covered > 0 || state.extendPx !== 0) {
    const { container } = view;
    // The frame the container fills: the container less the strip it reaches above it.
    const crop = hudLensCrop(container.clientWidth, container.clientHeight - state.extendPx, covered, state.fovY);
    canvasFovY = crop.canvasFovY;
    if (crop.extendPx !== state.extendPx) {
      state.extendPx = crop.extendPx;
      // Taller by the strip, its bottom edge still on the frame's.
      container.style.top = crop.extendPx > 0 ? `-${crop.extendPx}px` : '';
      container.style.height = crop.extendPx > 0 ? `calc(100% + ${crop.extendPx}px)` : '';
      // The canvas and the frustum's aspect follow in this frame.
      view.resize();
      changed = true;
    }
  }
  const { frustum } = view.camera;
  if (perspective(frustum) && frustum.aspectRatio > 0) {
    const fov = cesiumFov(canvasFovY, frustum.aspectRatio);
    if (Math.abs(frustum.fov - fov) > 1e-9) {
      frustum.fov = fov;
      changed = true;
    }
  }
  return changed;
}
