/**
 * Steering from the handlebar levers: move across the lane, then drift back.
 *
 * The bike always follows the route (auto-steer). Lever input only shifts the
 * rider sideways within a narrow lane, and letting go eases back to the line.
 * Pure math, used by the Cesium per-frame handler.
 */

/** Furthest the rider moves off the route line, metres. */
export const MAX_LANE_OFFSET_M = 1.6;
/** Time constant while steering, seconds. */
const STEER_TAU_S = 0.5;
/** Time constant when the levers are released (drift back), seconds. */
const RETURN_TAU_S = 2.2;

const EARTH_RADIUS_M = 6_371_000;

/**
 * Next lane offset (metres, + = right of travel) after `dtS` seconds with
 * steering input `steer` in -1..1.
 */
export function stepLaneOffset(currentM: number, steer: number, dtS: number): number {
  const s = Number.isFinite(steer) ? Math.max(-1, Math.min(1, steer)) : 0;
  const cur = Number.isFinite(currentM) ? currentM : 0;
  const dt = Math.max(0, Math.min(0.25, Number.isFinite(dtS) ? dtS : 0));
  const target = s * MAX_LANE_OFFSET_M;
  const tau = s === 0 ? RETURN_TAU_S : STEER_TAU_S;
  const next = cur + (target - cur) * (1 - Math.exp(-dt / tau));
  // Snap tiny residuals so the rider sits exactly on the line at rest.
  return Math.abs(next) < 0.005 && s === 0 ? 0 : next;
}

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
