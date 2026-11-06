/**
 * WebGL context loss on the world canvas (card t_14ea510a; the state lives in
 * stores/worldViewStore, the rider sees it in the ride's status chip).
 *
 * A browser can take the context away at any time: a GPU reset, a driver
 * update, Chrome's GPU watchdog, or its cap on live contexts. The canvas then
 * stays frozen while the ride, its HUD and the recording carry on. The view
 * remounts its <Canvas> under a new key when the browser restores the context
 * or the rider taps the chip, so react-three-fiber rebuilds the scene on a
 * fresh context (ThreeWorldView). The listener itself is shared with the
 * photoreal renderer (renderers/contextLoss.ts).
 */

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';

import { useWorldViewStore } from '@/stores/worldViewStore';

import { watchContextLoss } from '@/renderers/contextLoss';

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
