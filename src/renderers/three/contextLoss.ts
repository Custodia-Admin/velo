/**
 * WebGL context loss on the world canvas (card t_14ea510a; the state lives in
 * stores/worldViewStore, the rider sees it in the ride's status chip).
 *
 * A browser can take the context away at any time: a GPU reset, a driver
 * update, Chrome's GPU watchdog, or its cap on live contexts. The canvas then
 * stays frozen while the ride, its HUD and the recording carry on. The view
 * remounts its <Canvas> under a new key when the browser restores the context
 * or the rider taps the chip, so react-three-fiber rebuilds the scene on a
 * fresh context (ThreeWorldView).
 */

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';

import { useWorldViewStore } from '@/stores/worldViewStore';

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
 * three.js cancels it too, but the recovery must not depend on that.
 *
 * Neither handler fires once the returned stop function has run:
 * react-three-fiber forces the context loss of a canvas it unmounts, and
 * that loss is not the rider's problem.
 */
export function watchContextLoss(canvas: EventTarget, on: ContextLossHandlers): () => void {
  let live = true;
  const lost = (e: Event) => {
    e.preventDefault();
    if (live) on.lost();
  };
  const restored = () => {
    if (live) on.restored();
  };
  canvas.addEventListener('webglcontextlost', lost, false);
  canvas.addEventListener('webglcontextrestored', restored, false);
  return () => {
    live = false;
    canvas.removeEventListener('webglcontextlost', lost, false);
    canvas.removeEventListener('webglcontextrestored', restored, false);
  };
}

/**
 * Inside <Canvas>: reports this canvas (`canvasKey` of world view `viewId`)
 * losing and getting back its context. A restore, or the rider's tap on the
 * chip, bumps the view's canvas key in the store, and ThreeWorldView remounts
 * <Canvas> under it. The watch is detached by react-three-fiber's effect
 * cleanup, before its teardown forces the old canvas's context loss.
 */
export function ContextLossWatch({ viewId, canvasKey }: { viewId: number; canvasKey: number }): null {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    if (!viewId) return undefined;
    return watchContextLoss(gl.domElement, {
      lost: () => useWorldViewStore.getState().contextLost(viewId, canvasKey),
      restored: () => useWorldViewStore.getState().contextRestored(viewId, canvasKey),
    });
  }, [gl, viewId, canvasKey]);
  return null;
}
