/**
 * WebGL context loss on a world view's canvas, for every renderer (cards
 * t_14ea510a and t_771036a6; the state lives in stores/worldViewStore, the
 * rider sees it in the ride's status chip).
 *
 * A browser can take the context away at any time: a GPU reset, a driver
 * update, Chrome's GPU watchdog, or its cap on live contexts. The canvas then
 * stays frozen while the ride, its HUD and the recording carry on. Each
 * renderer remounts its canvas under a new key when the browser restores the
 * context or the rider taps the chip: the world renderer remounts its r3f
 * <Canvas> (renderers/three/ThreeWorldView), the photoreal renderer builds a
 * new Cesium Viewer (renderers/cesium/CesiumWorldView).
 *
 * Renderer-neutral: no engine imports here, so both renderers can share it.
 */

export interface ContextLossHandlers {
  /** The context is gone: the canvas is frozen. */
  lost: () => void;
  /** The browser gave the context back (only after a cancelled loss). */
  restored: () => void;
}

/**
 * Listens for `webglcontextlost` / `webglcontextrestored` on a canvas.
 *
 * The loss is cancelled (preventDefault) so the browser may restore the
 * context later: without that, Chrome never fires `webglcontextrestored`.
 * three.js cancels it too, Cesium does not, and the recovery must depend on
 * neither.
 *
 * Neither handler fires once the returned stop function has run: a renderer
 * that tears its canvas down (react-three-fiber forces the context loss of a
 * canvas it unmounts) is not the rider's problem.
 */
export function watchContextLoss(canvas: EventTarget, on: ContextLossHandlers): () => void {
  const lost = (e: Event) => {
    e.preventDefault();
    on.lost();
  };
  const restored = () => on.restored();
  canvas.addEventListener('webglcontextlost', lost, false);
  canvas.addEventListener('webglcontextrestored', restored, false);
  return () => {
    canvas.removeEventListener('webglcontextlost', lost, false);
    canvas.removeEventListener('webglcontextrestored', restored, false);
  };
}
