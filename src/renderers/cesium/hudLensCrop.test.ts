import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import * as Cesium from 'cesium';

import { applyHudLensCrop, hudLensCrop, lensCropState, type LensCropView } from './hudLensCrop';

const FOV = Math.PI / 3; // Cesium's default, the ride view's fov

/** Window CSS px (x right, y down) of a camera-space point under a Cesium frustum over a w×h canvas. */
function project(frustum: Cesium.PerspectiveFrustum, w: number, h: number, p: [number, number, number]): [number, number] {
  const clip = Cesium.Matrix4.multiplyByVector(frustum.projectionMatrix, new Cesium.Cartesian4(p[0], p[1], p[2], 1), new Cesium.Cartesian4());
  return [((clip.x / clip.w + 1) / 2) * w, ((1 - clip.y / clip.w) / 2) * h];
}

function frustumFor(w: number, h: number, fov: number, near = 0.1): Cesium.PerspectiveFrustum {
  return new Cesium.PerspectiveFrustum({ fov, aspectRatio: w / h, near, far: 1e7 });
}

// Camera-space points (Cesium's camera looks down -z): on the axis, off it in
// every direction, near and far.
const POINTS: Array<[number, number, number]> = [
  [0, 0, -10],
  [1.5, 0.8, -10],
  [-2, -1.1, -12],
  [0.4, -2.2, -8],
  [30, 12, -400],
  [-0.2, 0.3, -1.5],
];

/**
 * The cropped view as the window shows it (its canvas reaches extendPx above
 * the window) against the uncropped view: every point the same, moved up by
 * the lens shift. That is the three.js renderer's view offset (lib/world/hudLens).
 */
function expectLensShift(w: number, h: number, covered: number, shift: number) {
  const crop = hudLensCrop(w, h, covered, FOV);
  expect(crop.extendPx).toBe(2 * shift);
  const plain = frustumFor(w, h, FOV);
  const tall = frustumFor(w, h + crop.extendPx, crop.fov);
  for (const p of POINTS) {
    const [x0, y0] = project(plain, w, h, p);
    const [x1, y1Canvas] = project(tall, w, h + crop.extendPx, p);
    expect(x1).toBeCloseTo(x0, 6);
    expect(y1Canvas - crop.extendPx).toBeCloseTo(y0 - shift, 6);
  }
}

describe('hudLensCrop: photoreal frames the rider above the floating window bar', () => {
  it('reaches twice the lens shift above the window; landscape keeps its fov', () => {
    expect(hudLensCrop(427, 240, 78, FOV)).toEqual({ extendPx: 78, fov: FOV });
    expect(hudLensCrop(480, 270, 78, FOV)).toEqual({ extendPx: 78, fov: FOV });
    expect(hudLensCrop(640, 360, 86, FOV)).toEqual({ extendPx: 86, fov: FOV });
    // At most a quarter of the view.
    expect(hudLensCrop(480, 270, 400, FOV).extendPx).toBe(2 * Math.round(270 / 4));
  });

  it('no crop without a HUD (the tab) or a view', () => {
    expect(hudLensCrop(1440, 900, 0, FOV)).toEqual({ extendPx: 0, fov: FOV });
    expect(hudLensCrop(0, 240, 78, FOV)).toEqual({ extendPx: 0, fov: FOV });
    expect(hudLensCrop(427, 0, 78, FOV)).toEqual({ extendPx: 0, fov: FOV });
  });

  it('is the lens shift under Cesium\'s own projection: same scale, picture moved up', () => {
    // The floating window's sizes on the owner's laptop (S/M/L) and on a 1920 screen.
    expectLensShift(448, 252, 78, 39);
    expectLensShift(512, 288, 78, 39);
    expectLensShift(640, 360, 86, 43);
    expectLensShift(960, 540, 90, 45);
    expectLensShift(480, 270, 400, 68);
  });

  it('a portrait window (or one the taller canvas turns portrait) widens the fov to keep the scale', () => {
    expect(hudLensCrop(200, 300, 78, FOV).fov).toBeGreaterThan(FOV);
    expectLensShift(200, 300, 78, 39);
    // Landscape until the crop: 300×280 drawn as 300×420.
    expect(hudLensCrop(300, 280, 140, FOV).fov).toBeGreaterThan(FOV);
    expectLensShift(300, 280, 140, 70);
  });
});

describe('why not PerspectiveFrustum.yOffset (Cesium 1.141)', () => {
  it('the scene draws from a clone of the camera frustum, and clone() drops the offset', () => {
    const f = frustumFor(427, 240, FOV);
    f.yOffset = -0.02;
    const offCentre = f.projectionMatrix[9];
    expect(offCentre).not.toBe(0);
    // Scene's createWorkingFrustum: camera.frustum.clone(scratch).
    expect(f.clone(new Cesium.PerspectiveFrustum()).projectionMatrix[9]).toBe(0);
  });

  it('the offset is in near-plane units: the per-frustum near the scene sets changes the shift', () => {
    const f = frustumFor(427, 240, FOV, 1);
    f.yOffset = -0.1;
    const atNear1 = f.projectionMatrix[9];
    f.near = 5;
    expect(f.projectionMatrix[9]).toBeCloseTo(atNear1 / 5, 9);
  });
});

/**
 * A viewer container in a frame `w`×`h`, as CesiumWorldView's (`absolute
 * inset-0 h-full w-full`): `top` moves it, only `height` makes it taller.
 */
function fakeView(w: number, h: number, covered?: string) {
  const resizes: number[] = [];
  const container = {
    frame: { w, h },
    covered,
    style: { top: '', height: '' },
    get clientWidth() {
      return this.frame.w;
    },
    get clientHeight() {
      if (!this.style.height) return this.frame.h;
      const m = /^calc\(100% \+ (\d+)px\)$/.exec(this.style.height);
      if (!m) throw new Error(`unexpected height ${this.style.height}`);
      return this.frame.h + Number(m[1]);
    },
    /** Where the canvas spans in the frame: [top, bottom]. */
    get span() {
      const top = Number.parseFloat(this.style.top) || 0;
      return [top, top + this.clientHeight];
    },
    closest(sel: string) {
      expect(sel).toBe('[data-hud-bottom]');
      return this.covered === undefined ? null : ({ dataset: { hudBottom: this.covered } } as unknown as Element);
    },
  };
  const view = {
    container,
    camera: { frustum: { fov: FOV } },
    resize: () => {
      resizes.push(container.clientHeight);
    },
  } satisfies LensCropView;
  return { view, container, resizes };
}

describe('applyHudLensCrop (before every frame)', () => {
  it('the tab: nothing changes, frame after frame', () => {
    const { view, container, resizes } = fakeView(1440, 900);
    const state = lensCropState(view);
    for (let i = 0; i < 3; i++) expect(applyHudLensCrop(view, state)).toBe(false);
    expect(container.style).toEqual({ top: '', height: '' });
    expect(view.camera.frustum.fov).toBe(FOV);
    expect(resizes).toEqual([]);
  });

  it('the floating window: crops once, resizes the canvas in the same frame, then holds', () => {
    const { view, container, resizes } = fakeView(427, 240, '78');
    const state = lensCropState(view);
    expect(applyHudLensCrop(view, state)).toBe(true);
    // The canvas reaches 78 px above the window and still ends at its bottom edge.
    expect(container.span).toEqual([-78, 240]);
    expect(resizes).toEqual([318]);
    expect(view.camera.frustum.fov).toBe(FOV);
    expect(applyHudLensCrop(view, state)).toBe(false);
    expect(applyHudLensCrop(view, state)).toBe(false);
    expect(resizes).toHaveLength(1);
  });

  it('follows the window size and the bar, and undoes itself when the bar goes', () => {
    const { view, container, resizes } = fakeView(427, 240, '78');
    const state = lensCropState(view);
    applyHudLensCrop(view, state);
    // A smaller window: the shift is capped at a quarter of it.
    container.frame = { w: 320, h: 140 };
    expect(applyHudLensCrop(view, state)).toBe(true);
    expect(container.span).toEqual([-2 * Math.round(140 / 4), 140]);
    // The bar grows (a chip above it).
    container.frame = { w: 640, h: 360 };
    container.covered = '120';
    applyHudLensCrop(view, state);
    expect(container.span).toEqual([-120, 360]);
    // Back to the tab's framing.
    container.covered = undefined;
    expect(applyHudLensCrop(view, state)).toBe(true);
    expect(container.style).toEqual({ top: '', height: '' });
    expect(view.camera.frustum.fov).toBe(FOV);
    expect(resizes.at(-1)).toBe(360);
    expect(applyHudLensCrop(view, state)).toBe(false);
  });

  it('a portrait window gets the wider fov, and its own fov back after', () => {
    const { view, container } = fakeView(200, 300, '78');
    const state = lensCropState(view);
    applyHudLensCrop(view, state);
    expect(view.camera.frustum.fov).toBeCloseTo(hudLensCrop(200, 300, 78, FOV).fov, 12);
    expect(view.camera.frustum.fov).toBeGreaterThan(FOV);
    container.frame = { w: 640, h: 360 };
    applyHudLensCrop(view, state);
    expect(view.camera.frustum.fov).toBe(FOV);
  });
});

describe('CesiumWorldView wiring', () => {
  const src = readFileSync(join(__dirname, 'CesiumWorldView.tsx'), 'utf8');

  it('crops before every frame, on the viewer\'s container (the classes fakeView models)', () => {
    expect(src).toMatch(/<div ref=\{containerRef\} className="absolute inset-0 h-full w-full" \/>/);
    expect(src).toMatch(/const lensView = \{ container, camera: viewer\.camera, resize: \(\) => viewer\.resize\(\) \};/);
    expect(src).toMatch(/viewer\.scene\.preUpdate\.addEventListener\(\(\) => \{\s*applyHudLensCrop\(lensView, lensCrop\);/);
  });

  it('reports the rider\'s screen point in the window, not the taller canvas', () => {
    expect(src).toMatch(/riderScreen: px \? \[Math\.round\(px\.x\), Math\.round\(px\.y - cropTop\)\] : null/);
    expect(src).toMatch(/const cropTop = lensCropRef\.current\?\.extendPx \?\? 0;/);
  });
});
