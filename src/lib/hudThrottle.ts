/**
 * Quantise the rider's distance for route-wide HUD widgets (elevation
 * profile, minimap). The ride loop writes `distance` every frame; a chart
 * spanning the whole route can't show a move smaller than one of ~`buckets`
 * steps, so subscribing to the quantised value re-renders (Recharts / SVG
 * path rebuild) a few times a second instead of 60 times.
 */
export function quantizedDistance(distance: number, totalDistance: number | undefined, buckets = 600): number {
  if (!Number.isFinite(distance)) return 0;
  const step = totalDistance && totalDistance > 0 ? Math.max(1, totalDistance / buckets) : 10;
  return Math.round(distance / step) * step;
}

/**
 * Quantise a distance into fixed metre buckets for HUD readouts and progress
 * bars (ride HUD, segment HUD, climb banner). The store ticks every frame;
 * these widgets display at most a few updates per second, so subscribing to
 * the bucket keeps React off the 60 Hz render loop the Cesium scene shares.
 */
export function quantizedMeters(distance: number, stepM: number): number {
  if (!Number.isFinite(distance)) return 0;
  return Math.floor(distance / stepM) * stepM;
}
