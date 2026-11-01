/**
 * The sideways shift that puts the rider at a lane offset. How the lane
 * offset itself moves (deadzone, expo, centring spring) lives in
 * src/lib/controllers/steerFeel.ts.
 */

export { MAX_LANE_OFFSET_M } from '@/lib/controllers/steerFeel';

const EARTH_RADIUS_M = 6_371_000;

/**
 * Shift a point sideways relative to a travel heading.
 * `headingRad`: 0 = north, clockwise. `rightM`: + = to the right of travel.
 */
export function offsetSideways(
  lat: number,
  lon: number,
  headingRad: number,
  rightM: number,
): { lat: number; lon: number } {
  if (!rightM) return { lat, lon };
  // Right of travel, in (east, north): (cos h, -sin h).
  const east = Math.cos(headingRad) * rightM;
  const north = -Math.sin(headingRad) * rightM;
  const latRad = (lat * Math.PI) / 180;
  const dLat = (north / EARTH_RADIUS_M) * (180 / Math.PI);
  const cosLat = Math.max(1e-6, Math.cos(latRad));
  const dLon = (east / (EARTH_RADIUS_M * cosLat)) * (180 / Math.PI);
  return { lat: lat + dLat, lon: lon + dLon };
}
