import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import * as Cesium from 'cesium';
import * as THREE from 'three';

import { CHASE_FRAMING, AIM_HEIGHT_M, RIDE_FOV_Y_DEG } from '@/lib/world/cameraFraming';

import { applyHudLensCrop, cesiumFov, hudLensCrop, lensCropState, viewFovYDeg, type LensCropView } from './hudLensCrop';

const FOV_Y = (RIDE_FOV_Y_DEG * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Window CSS px (x right, y down) of a camera-space point under a Cesium frustum over a w×h canvas. */
function project(frustum: Cesium.PerspectiveFrustum, w: number, h: number, p: [number, number, number]): [number, number] {
  const clip = Cesium.Matrix4.multiplyByVector(frustum.projectionMatrix, new Cesium.Cartesian4(p[0], p[1], p[2], 1), new Cesium.Cartesian4());
  return [((clip.x / clip.w + 1) / 2) * w, ((1 - clip.y / clip.w) / 2) * h];
}

function frustumFor(w: number, h: number, fov: number, near = 0.1): Cesium.PerspectiveFrustum {
  return new Cesium.PerspectiveFrustum({ fov, aspectRatio: w / h, near, far: 1e7 });
}

/** Photoreal's frustum for a w×h view: the ride's vertical field through Cesium's longer-side fov. */
const rideFrustum = (w: number, h: number) => frustumFor(w, h, cesiumFov(FOV_Y, w / h));

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

// The gate viewports (UI-RULES §0), the owner's laptop tab, phones, a square.
const VIEWS: Array<[number, number]> = [
  [1440, 900],
  [1280, 648],
  [1920, 1080],
  [390, 844],
  [844, 390],
  [600, 600],
  [760, 240],
];

/** The standard chase camera (lib/world/cameraFraming) in three.js, rider at the origin heading -z. */
function threeChase(w: number, h: number): THREE.PerspectiveCamera {
  const f = CHASE_FRAMING.standard;
  const cam = new THREE.PerspectiveCamera(RIDE_FOV_Y_DEG, w / h, 0.4, 5000);
  cam.position.set(0, f.upM, f.backM);
  cam.lookAt(0, AIM_HEIGHT_M, -f.lookAheadM);
  cam.updateMatrixWorld();
  return cam;
}

/** A world point (three.js axes) on screen: three's own projection, and Cesium's frustum from the same camera. */
function bothRenderers(w: number, h: number, world: [number, number, number], cesiumFrustum: Cesium.PerspectiveFrustum) {
  const cam = threeChase(w, h);
  const v = new THREE.Vector3(...world).project(cam);
  const three: [number, number] = [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h];
  const c = new THREE.Vector3(...world).applyMatrix4(cam.matrixWorldInverse);
  return { three, cesium: project(cesiumFrustum, w, h, [c.x, c.y, c.z]) };
}

describe('photoreal and the world renderer share one vertical field of view', () => {
  it("Cesium's fov spans the longer side: the ride's vertical field converts in landscape only", () => {
    // 60° vertical is ~91.5° across a 16:9 view, ~97.5° across the 1280×648 tab.
    expect(deg(cesiumFov(FOV_Y, 1920 / 1080))).toBeCloseTo(91.49, 2);
    expect(deg(cesiumFov(FOV_Y, 1280 / 648))).toBeCloseTo(97.51, 2);
    expect(cesiumFov(FOV_Y, 390 / 844)).toBe(FOV_Y);
    expect(cesiumFov(FOV_Y, 1)).toBe(FOV_Y);
    // No canvas yet: leave the field as it is.
    expect(cesiumFov(FOV_Y, Number.NaN)).toBe(FOV_Y);
    expect(cesiumFov(FOV_Y, 0)).toBe(FOV_Y);
  });

  it("Cesium's own frustum draws the vertical field asked for, in every view shape", () => {
    for (const [w, h] of VIEWS) {
      const f = rideFrustum(w, h);
      void f.projectionMatrix; // runs the frustum's update
      expect(deg(f.fovy as number)).toBeCloseTo(RIDE_FOV_Y_DEG, 9);
    }
    // Cesium's default (60° across the width) was ~36° vertical at 16:9.
    const old = frustumFor(1920, 1080, Math.PI / 3);
    void old.projectionMatrix;
    expect(deg(old.fovy as number)).toBeCloseTo(35.98, 2);
  });

  it('the chase rider lands on the same pixels in both renderers (gate viewports, tab, phones)', () => {
    // Ground contact, the 1 m point riderScreen reports, the head, and a
    // point on the road ahead and to the side.
    const points: Array<[number, number, number]> = [
      [0, 0, 0],
      [0, 1, 0],
      [0, 1.7, 0],
      [3, 0, -20],
      [-1.5, 0.4, 0.3],
    ];
    for (const [w, h] of VIEWS) {
      for (const p of points) {
        const { three, cesium } = bothRenderers(w, h, p, rideFrustum(w, h));
        expect(cesium[0]).toBeCloseTo(three[0], 6);
        expect(cesium[1]).toBeCloseTo(three[1], 6);
      }
    }
  });

  it("before: Cesium's default fov drew the landscape rider ~1.8–2x larger and lower than the world renderer", () => {
    const tall = (w: number, h: number) => {
      const old = frustumFor(w, h, Math.PI / 3);
      const ground = bothRenderers(w, h, [0, 0, 0], old);
      const head = bothRenderers(w, h, [0, 1.7, 0], old);
      return {
        ratio: (ground.cesium[1] - head.cesium[1]) / (ground.three[1] - head.three[1]),
        lower: ground.cesium[1] - ground.three[1],
      };
    };
    // 16:9 (1440×810 and TV): 1.78x; the owner's 1280×648 tab: 1.98x.
    expect(tall(1920, 1080).ratio).toBeCloseTo(1.78, 2);
    expect(tall(1280, 648).ratio).toBeCloseTo(1.98, 2);
    expect(tall(1280, 648).lower).toBeGreaterThan(60);
    // Portrait phones were already the same (Cesium's fov spans the height there).
    expect(tall(390, 844).ratio).toBeCloseTo(1, 9);
  });
});

/**
 * The cropped view as the window shows it (its canvas reaches extendPx above
 * the window) against the uncropped view: every point the same, moved up by
 * the lens shift. That is the three.js renderer's view offset (lib/world/hudLens).
 */
function expectLensShift(w: number, h: number, covered: number, shift: number) {
  const crop = hudLensCrop(w, h, covered, FOV_Y);
  expect(crop.extendPx).toBe(2 * shift);
  const plain = rideFrustum(w, h);
  const tall = frustumFor(w, h + crop.extendPx, cesiumFov(crop.canvasFovY, w / (h + crop.extendPx)));
  for (const p of POINTS) {
    const [x0, y0] = project(plain, w, h, p);
    const [x1, y1Canvas] = project(tall, w, h + crop.extendPx, p);
    expect(x1).toBeCloseTo(x0, 6);
    expect(y1Canvas - crop.extendPx).toBeCloseTo(y0 - shift, 6);
  }
}

describe('hudLensCrop: photoreal frames the rider above the floating window bar', () => {
  it('reaches twice the lens shift above the window; the taller canvas spans more field at the same scale', () => {
    expect(hudLensCrop(427, 240, 78, FOV_Y).extendPx).toBe(78);
    expect(hudLensCrop(480, 270, 78, FOV_Y).extendPx).toBe(78);
    expect(hudLensCrop(640, 360, 86, FOV_Y).extendPx).toBe(86);
    // tan(field / 2) grows with the canvas: 240 → 318 px.
    expect(Math.tan(hudLensCrop(427, 240, 78, FOV_Y).canvasFovY / 2)).toBeCloseTo((Math.tan(FOV_Y / 2) * 318) / 240, 12);
    // At most a quarter of the view.
    expect(hudLensCrop(480, 270, 400, FOV_Y).extendPx).toBe(2 * Math.round(270 / 4));
  });

  it('no crop without a HUD (the tab) or a view', () => {
    expect(hudLensCrop(1440, 900, 0, FOV_Y)).toEqual({ extendPx: 0, canvasFovY: FOV_Y });
    expect(hudLensCrop(0, 240, 78, FOV_Y)).toEqual({ extendPx: 0, canvasFovY: FOV_Y });
    expect(hudLensCrop(427, 0, 78, FOV_Y)).toEqual({ extendPx: 0, canvasFovY: FOV_Y });
  });

  it("is the lens shift under Cesium's own projection: same scale, picture moved up", () => {
    // The floating window's sizes on the owner's laptop (S/M/L), on a 1920
    // screen, and a short wide drag-resized one.
    expectLensShift(448, 252, 78, 39);
    expectLensShift(512, 288, 78, 39);
    expectLensShift(640, 360, 86, 43);
    expectLensShift(960, 540, 90, 45);
    expectLensShift(760, 240, 95, 48);
    expectLensShift(480, 270, 400, 68);
  });

  it('a portrait window, or one the taller canvas turns portrait, keeps the scale too', () => {
    expectLensShift(200, 300, 78, 39);
    // Landscape until the crop: 300×280 drawn as 300×420.
    expectLensShift(300, 280, 140, 70);
  });
});

describe('why not PerspectiveFrustum.yOffset (Cesium 1.141)', () => {
  it('the scene draws from a clone of the camera frustum, and clone() drops the offset', () => {
    const f = rideFrustum(427, 240);
    f.yOffset = -0.02;
    const offCentre = f.projectionMatrix[9];
    expect(offCentre).not.toBe(0);
    // Scene's createWorkingFrustum: camera.frustum.clone(scratch).
    expect(f.clone(new Cesium.PerspectiveFrustum()).projectionMatrix[9]).toBe(0);
  });

  it('the offset is in near-plane units: the per-frustum near the scene sets changes the shift', () => {
    const f = frustumFor(427, 240, cesiumFov(FOV_Y, 427 / 240), 1);
    f.yOffset = -0.1;
    const atNear1 = f.projectionMatrix[9];
    f.near = 5;
    expect(f.projectionMatrix[9]).toBeCloseTo(atNear1 / 5, 9);
  });
});

/**
 * A viewer in a frame `w`×`h`, as CesiumWorldView's: the container is
 * `absolute inset-0 h-full w-full` (`top` moves it, only `height` makes it
 * taller), and like Cesium, a resize sets the frustum's aspect to the canvas's.
 * The frustum starts as Cesium's default (60° across the longer side).
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
  const frustum = { fov: Math.PI / 3, aspectRatio: w / h };
  const view = {
    container,
    camera: { frustum },
    resize: () => {
      frustum.aspectRatio = container.clientWidth / container.clientHeight;
      resizes.push(container.clientHeight);
    },
    xr: false as boolean,
    ownsFrustum() {
      return !this.xr;
    },
  } satisfies LensCropView & { xr: boolean };
  /** The window resized: Cesium's render loop resizes the canvas before the next frame. */
  const reshape = (nw: number, nh: number) => {
    container.frame = { w: nw, h: nh };
    frustum.aspectRatio = container.clientWidth / container.clientHeight;
  };
  /** The vertical field the frame shows (CSS px of the frame, not the taller canvas). */
  const frameFovY = () => {
    const canvasFovY = frustum.aspectRatio > 1 ? 2 * Math.atan(Math.tan(frustum.fov / 2) / frustum.aspectRatio) : frustum.fov;
    return 2 * Math.atan((Math.tan(canvasFovY / 2) * container.frame.h) / container.clientHeight);
  };
  return { view, container, frustum, resizes, reshape, frameFovY };
}

describe('applyHudLensCrop (before every frame)', () => {
  it('the tab: the ride field from the first frame, then nothing changes, frame after frame', () => {
    const { view, container, frustum, resizes, frameFovY } = fakeView(1440, 900);
    const state = lensCropState(FOV_Y);
    expect(applyHudLensCrop(view, state)).toBe(true);
    expect(frustum.fov).toBeCloseTo(cesiumFov(FOV_Y, 1440 / 900), 12);
    expect(deg(frameFovY())).toBeCloseTo(RIDE_FOV_Y_DEG, 9);
    for (let i = 0; i < 3; i++) expect(applyHudLensCrop(view, state)).toBe(false);
    expect(container.style).toEqual({ top: '', height: '' });
    expect(resizes).toEqual([]);
  });

  it('the tab follows the window shape: landscape, portrait, back', () => {
    const { view, frustum, reshape, frameFovY } = fakeView(1280, 648);
    const state = lensCropState(FOV_Y);
    applyHudLensCrop(view, state);
    expect(deg(frameFovY())).toBeCloseTo(RIDE_FOV_Y_DEG, 9);
    reshape(390, 844);
    expect(applyHudLensCrop(view, state)).toBe(true);
    expect(frustum.fov).toBe(FOV_Y);
    reshape(1920, 1080);
    expect(applyHudLensCrop(view, state)).toBe(true);
    expect(deg(frameFovY())).toBeCloseTo(RIDE_FOV_Y_DEG, 9);
    expect(applyHudLensCrop(view, state)).toBe(false);
    // A few px off (the window dragged): still exact.
    reshape(1920, 1072);
    expect(applyHudLensCrop(view, state)).toBe(true);
    expect(deg(frameFovY())).toBeCloseTo(RIDE_FOV_Y_DEG, 9);
  });

  it('the floating window: crops once, resizes the canvas in the same frame, then holds', () => {
    const { view, container, resizes, frameFovY } = fakeView(427, 240, '78');
    const state = lensCropState(FOV_Y);
    expect(applyHudLensCrop(view, state)).toBe(true);
    // The canvas reaches 78 px above the window and still ends at its bottom edge.
    expect(container.span).toEqual([-78, 240]);
    expect(resizes).toEqual([318]);
    // The window itself shows the ride's field (the strip above it is extra).
    expect(deg(frameFovY())).toBeCloseTo(RIDE_FOV_Y_DEG, 9);
    expect(applyHudLensCrop(view, state)).toBe(false);
    expect(applyHudLensCrop(view, state)).toBe(false);
    expect(resizes).toHaveLength(1);
  });

  it('follows the window size and the bar, and undoes itself when the bar goes', () => {
    const { view, container, frustum, resizes, reshape, frameFovY } = fakeView(427, 240, '78');
    const state = lensCropState(FOV_Y);
    applyHudLensCrop(view, state);
    // A smaller window: the shift is capped at a quarter of it.
    reshape(320, 140);
    expect(applyHudLensCrop(view, state)).toBe(true);
    expect(container.span).toEqual([-2 * Math.round(140 / 4), 140]);
    expect(deg(frameFovY())).toBeCloseTo(RIDE_FOV_Y_DEG, 9);
    // The bar grows (a chip above it).
    reshape(640, 360);
    container.covered = '120';
    applyHudLensCrop(view, state);
    expect(container.span).toEqual([-120, 360]);
    expect(deg(frameFovY())).toBeCloseTo(RIDE_FOV_Y_DEG, 9);
    // Back to the tab's framing.
    container.covered = undefined;
    expect(applyHudLensCrop(view, state)).toBe(true);
    expect(container.style).toEqual({ top: '', height: '' });
    expect(frustum.fov).toBeCloseTo(cesiumFov(FOV_Y, 640 / 360), 12);
    expect(resizes.at(-1)).toBe(360);
    expect(applyHudLensCrop(view, state)).toBe(false);
  });

  it('a portrait window keeps the field over the window, and its own after', () => {
    const { view, frustum, reshape, frameFovY } = fakeView(200, 300, '78');
    const state = lensCropState(FOV_Y);
    applyHudLensCrop(view, state);
    expect(frustum.fov).toBeCloseTo(hudLensCrop(200, 300, 78, FOV_Y).canvasFovY, 12);
    expect(deg(frameFovY())).toBeCloseTo(RIDE_FOV_Y_DEG, 9);
    reshape(640, 360);
    applyHudLensCrop(view, state);
    expect(deg(frameFovY())).toBeCloseTo(RIDE_FOV_Y_DEG, 9);
  });

  it('a WebXR session drives the frustum itself: hands off until it ends', () => {
    const { view, container, frustum, resizes } = fakeView(427, 240, '78');
    const state = lensCropState(FOV_Y);
    view.xr = true;
    frustum.fov = 1.234;
    expect(applyHudLensCrop(view, state)).toBe(false);
    expect(frustum.fov).toBe(1.234);
    expect(container.style).toEqual({ top: '', height: '' });
    expect(resizes).toEqual([]);
    view.xr = false;
    expect(applyHudLensCrop(view, state)).toBe(true);
    expect(container.span).toEqual([-78, 240]);
  });

  it('leaving VR/AR resets the fov to 60° at the same window shape: the next frame puts the ride field back', () => {
    // lib/webxr exitVR/exitAR (restoreLoop) reset the frustum to Cesium's
    // 60° when the session ends; the window keeps its shape. The lens reads
    // the live frustum, not the fov it wrote last, so it undoes that write.
    const { view, frustum, resizes } = fakeView(1440, 900);
    const state = lensCropState(FOV_Y);
    const ride = cesiumFov(FOV_Y, 1440 / 900);
    expect(applyHudLensCrop(view, state)).toBe(true);
    expect(frustum.fov).toBeCloseTo(ride, 12);
    view.xr = true;
    expect(applyHudLensCrop(view, state)).toBe(false);
    frustum.fov = Math.PI / 3;
    view.xr = false;
    expect(applyHudLensCrop(view, state)).toBe(true);
    expect(frustum.fov).toBeCloseTo(ride, 12);
    expect(applyHudLensCrop(view, state)).toBe(false);
    expect(resizes).toEqual([]);
  });

  it('the same in the floating window, where restoreLoop swaps in a new 60° frustum over the taller canvas', () => {
    const { view, container, resizes } = fakeView(427, 240, '78');
    const state = lensCropState(FOV_Y);
    applyHudLensCrop(view, state);
    expect(container.span).toEqual([-78, 240]);
    view.xr = true;
    expect(applyHudLensCrop(view, state)).toBe(false);
    // As restoreLoop does: a fresh frustum, its aspect from the drawing buffer (the canvas, 318 px tall).
    const reset = new Cesium.PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 427 / 318, near: 0.1, far: 1e7 });
    (view.camera as { frustum: object }).frustum = reset;
    view.xr = false;
    expect(applyHudLensCrop(view, state)).toBe(true);
    expect(reset.fov).toBeCloseTo(cesiumFov(hudLensCrop(427, 240, 78, FOV_Y).canvasFovY, 427 / 318), 12);
    expect(viewFovYDeg(reset, 318, 78)).toBe(RIDE_FOV_Y_DEG);
    expect(container.span).toEqual([-78, 240]);
    expect(resizes).toEqual([318]);
    expect(applyHudLensCrop(view, state)).toBe(false);
  });

  it('leaves a frustum without a fov alone (orthographic)', () => {
    const { view } = fakeView(1440, 900);
    const ortho = { width: 100, aspectRatio: 1.6 };
    (view.camera as { frustum: object }).frustum = ortho;
    expect(applyHudLensCrop(view, lensCropState(FOV_Y))).toBe(false);
    expect(ortho).toEqual({ width: 100, aspectRatio: 1.6 });
  });

  it('the debug probe reads the field the view shows', () => {
    const tab = fakeView(1280, 648);
    applyHudLensCrop(tab.view, lensCropState(FOV_Y));
    expect(viewFovYDeg(tab.frustum, 648, 0)).toBe(RIDE_FOV_Y_DEG);
    const win = fakeView(448, 252, '78');
    applyHudLensCrop(win.view, lensCropState(FOV_Y));
    expect(viewFovYDeg(win.frustum, win.container.clientHeight, 78)).toBe(RIDE_FOV_Y_DEG);
    // Before: Cesium's default fov on the 1280×648 tab.
    expect(viewFovYDeg({ fov: Math.PI / 3, aspectRatio: 1280 / 648 }, 648, 0)).toBe(32.6);
    expect(viewFovYDeg({ width: 1 }, 648, 0)).toBeNull();
  });
});

describe('CesiumWorldView wiring', () => {
  const src = readFileSync(join(__dirname, 'CesiumWorldView.tsx'), 'utf8');

  it("sets the lens before every frame, on the viewer's container (the classes fakeView models)", () => {
    expect(src).toMatch(/<div ref=\{containerRef\} className="absolute inset-0 h-full w-full" \/>/);
    expect(src).toMatch(
      /const lensView = \{\s*container,\s*camera: viewer\.camera,\s*resize: \(\) => viewer\.resize\(\),\s*ownsFrustum: \(\) => viewer\.useDefaultRenderLoop,\s*\};/,
    );
    expect(src).toMatch(/const lensCrop = lensCropState\(Cesium\.Math\.toRadians\(RIDE_FOV_Y_DEG\)\);/);
    expect(src).toMatch(/viewer\.scene\.preUpdate\.addEventListener\(\(\) => \{\s*applyHudLensCrop\(lensView, lensCrop\);/);
  });

  it('both renderers take the one vertical field', () => {
    const three = readFileSync(join(__dirname, '../three/ThreeWorldView.tsx'), 'utf8');
    expect(three).toMatch(/camera=\{\{ fov: RIDE_FOV_Y_DEG, /);
    expect(three).toMatch(/import \{[^}]*\bRIDE_FOV_Y_DEG\b[^}]*\} from '@\/lib\/world\/cameraFraming';/);
    expect(src).toMatch(/import \{[^}]*\bRIDE_FOV_Y_DEG\b[^}]*\} from '@\/lib\/world\/cameraFraming';/);
    expect(RIDE_FOV_Y_DEG).toBe(60);
  });

  it("reports the rider's screen point and the view in the window, not the taller canvas (the floating-window probe reads these)", () => {
    expect(src).toMatch(/lensCropRef\.current = lensCrop;/);
    expect(src).toMatch(/const cropTop = lensCropRef\.current\?\.extendPx \?\? 0;/);
    expect(src).toMatch(/riderScreen: px \? \[Math\.round\(px\.x\), Math\.round\(px\.y - cropTop\)\] : null/);
    expect(src).toMatch(/viewportPx: \[viewer\.canvas\.clientWidth, viewer\.canvas\.clientHeight - cropTop\]/);
    expect(src).toMatch(/lensShiftPx: cropTop \/ 2/);
    expect(src).toMatch(/fovYDeg: viewFovYDeg\(viewer\.camera\.frustum, viewer\.canvas\.clientHeight, cropTop\)/);
  });
});
