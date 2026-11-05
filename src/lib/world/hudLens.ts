/**
 * Framing under a HUD, shared by both world renderers. The floating ride
 * window's bar covers the bottom of the picture; the window's root says how
 * much (`data-hud-bottom`, CSS px, components/velo/ShowSurface). Each renderer
 * then shifts its lens so the rider and the horizon sit in the middle of the
 * part left clear: the picture moves up by half the covered height, at most a
 * quarter of the view. A lens shift, not a camera move, so the framing,
 * smoothing and ground clearance are untouched. The three.js renderer applies
 * it as a view offset (renderers/three/directorCamera), photoreal as a taller
 * canvas cropped by the window (renderers/cesium/hudLensCrop). In the tab the
 * HUD sits over the world without one, and nothing changes there.
 */

/** CSS px a HUD covers at the bottom of the view hosting `el` (an ancestor's data-hud-bottom), else 0. */
export function hudCoveredPx(el: { closest?: (sel: string) => Element | null }): number {
  // (The r3f test renderer's canvas is not a DOM element.)
  if (typeof el.closest !== 'function') return 0;
  const host = el.closest('[data-hud-bottom]') as { dataset?: Record<string, string | undefined> } | null;
  const n = Number(host?.dataset?.hudBottom);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** How far up (CSS px) to move the picture of a `viewHeight` px view whose bottom `coveredPx` are under a HUD. */
export function hudLensShiftPx(viewHeight: number, coveredPx: number): number {
  if (!(viewHeight > 0) || !(coveredPx > 0)) return 0;
  return Math.round(Math.min(coveredPx, viewHeight * 0.5) / 2);
}
