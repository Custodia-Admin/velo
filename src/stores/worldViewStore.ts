/**
 * The 3D world view's WebGL context (card t_14ea510a).
 *
 * A browser can take a page's WebGL context away at any time: a GPU reset, a
 * driver update, Chrome's GPU watchdog, or its cap on live contexts. The
 * canvas then stays frozen (white or black) while the ride, its HUD and the
 * recording carry on, because none of them depend on the canvas.
 *
 * The world view reports the loss here; the ride's status chip (RideChip)
 * reads `stopped` and says "3D view stopped · tap to reload". The view
 * remounts its canvas under a new `canvasKey` when the browser restores the
 * context or the rider taps the chip: the world renderer
 * (renderers/three/ThreeWorldView) remounts its <Canvas>, so
 * react-three-fiber rebuilds the scene on a fresh context; the photoreal
 * renderer (renderers/cesium/CesiumWorldView, card t_771036a6) builds a new
 * Cesium Viewer, which has no restore path of its own.
 *
 * One world view draws at a time (the tab, or the floating ride window), but
 * a view going away and the next one mounting can overlap, and a canvas that
 * is being torn down can still fire `webglcontextlost`. So the slot belongs
 * to the view that attached last, and a report counts only for that view's
 * current canvas.
 */

import { create } from 'zustand';

export interface WorldViewSlot {
  /** The mounted world view that owns the slot (attach order). */
  id: number;
  /** Key of its canvas: a new key remounts the canvas on a fresh WebGL context. */
  canvasKey: number;
  /** Its canvas lost the WebGL context; the world is frozen until it remounts. */
  stopped: boolean;
}

/** Canvas `canvasKey` of view `id` lost its context: the slot reads stopped. Pure. */
export function lostIn(view: WorldViewSlot | null, id: number, canvasKey: number): WorldViewSlot | null {
  if (!view || view.id !== id || view.canvasKey !== canvasKey || view.stopped) return view;
  return { ...view, stopped: true };
}

/** Remount a stopped view on a new canvas key; anything else is left alone. Pure. */
export function reloadIn(view: WorldViewSlot | null): WorldViewSlot | null {
  if (!view || !view.stopped) return view;
  return { ...view, stopped: false, canvasKey: view.canvasKey + 1 };
}

/** The browser restored the context of canvas `canvasKey` of view `id`: remount it. Pure. */
export function restoredIn(view: WorldViewSlot | null, id: number, canvasKey: number): WorldViewSlot | null {
  if (!view || view.id !== id || view.canvasKey !== canvasKey) return view;
  return reloadIn(view);
}

interface WorldViewState {
  view: WorldViewSlot | null;
  /** A world view mounted: it owns the slot from now on. Returns its id. */
  attach: () => number;
  /** That view unmounted (a later view may own the slot already). */
  detach: (id: number) => void;
  /** `webglcontextlost` on canvas `canvasKey` of view `id`. */
  contextLost: (id: number, canvasKey: number) => void;
  /** `webglcontextrestored` on canvas `canvasKey` of view `id`. */
  contextRestored: (id: number, canvasKey: number) => void;
  /** The rider tapped "tap to reload the view". */
  reload: () => void;
}

let nextId = 1;

export const useWorldViewStore = create<WorldViewState>()((set) => ({
  view: null,
  attach: () => {
    const id = nextId++;
    set({ view: { id, canvasKey: 0, stopped: false } });
    return id;
  },
  detach: (id) => set((s) => (s.view?.id === id ? { view: null } : s)),
  contextLost: (id, canvasKey) => set((s) => ({ view: lostIn(s.view, id, canvasKey) })),
  contextRestored: (id, canvasKey) => set((s) => ({ view: restoredIn(s.view, id, canvasKey) })),
  reload: () => set((s) => ({ view: reloadIn(s.view) })),
}));

/** The 3D view stopped (the status chip shows it on every viewport). */
export const selectWorldStopped = (s: WorldViewState): boolean => s.view?.stopped === true;

/** The canvas key for view `id` (0 until it attached). */
export function canvasKeyFor(s: WorldViewState, id: number): number {
  return s.view && s.view.id === id ? s.view.canvasKey : 0;
}
