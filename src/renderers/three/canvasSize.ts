/**
 * The world canvas's CSS size, for a canvas that lives in another window.
 *
 * r3f 9 sets the canvas's CSS size only when `gl.domElement instanceof
 * HTMLCanvasElement`. A canvas created in the floating ride window
 * (lib/show/pip.ts, ShowSurface) is an instance of THAT window's
 * HTMLCanvasElement, so the check fails and the canvas keeps its drawing
 * buffer size as its CSS size. At a device pixel ratio of 2 (r3f dpr 1.5) a
 * 320×180 window got a 480×270 canvas: the window showed the top-left two
 * thirds of the frame and the rider slid under the bar. At DPR 1 the buffer
 * and the window match, which is why it only showed on HiDPI screens.
 *
 * Sizing the canvas from its container (r3f's wrapper, the size r3f measures
 * and renders at) gives the same result as r3f's own px sizes in the tab.
 */
export function fillContainer(canvas: { style: { width: string; height: string } }): void {
  canvas.style.width = '100%';
  canvas.style.height = '100%';
}
