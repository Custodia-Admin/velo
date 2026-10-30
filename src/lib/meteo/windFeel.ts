/**
 * Live wind → how hard the trainer pushes back.
 *
 * FTMS Set Indoor Bike Simulation (0x11) carries a wind-resistance coefficient
 * Cw (kg/m). The trainer applies air drag as Cw · v², where v is its own
 * flywheel speed. Real headwind makes drag Cw · (v + h)², so we send
 *
 *     Cw' = Cw · (v + h)·|v + h| / v²
 *
 * which is exact at the current speed and is refreshed every ~1 s. When live
 * wind drives Cw, the separate FTMS wind-speed field stays 0 so trainers that
 * honour both don't count the wind twice.
 *
 * Velo riders want comfort, so the default feel is "subtle": a third of the
 * real effect, capped at +25 % / −20 % drag. "Real" is physical, with wide
 * safety caps. "Off" leaves Cw alone.
 */

import type { LiveWeather } from '@/lib/meteo/openMeteo';

export type WindFeel = 'off' | 'subtle' | 'real';

export const WIND_FEELS: readonly WindFeel[] = ['off', 'subtle', 'real'] as const;
export const DEFAULT_WIND_FEEL: WindFeel = 'subtle';

/**
 * Open-Meteo reports wind at 10 m. A rider's body sits at ~1 m where the wind
 * is slower: log profile ln(1/z0)/ln(10/z0) with open-country roughness
 * z0 ≈ 0.03 m gives ≈ 0.6.
 */
export const RIDER_HEIGHT_WIND_FACTOR = 0.6;

/** Below this speed the v² ratio blows up; treat the rider as doing 18 km/h. */
export const MIN_REFERENCE_SPEED_MS = 5;

interface FeelProfile {
  /** Share of the physical drag change applied. */
  share: number;
  /** Share of the gust excess (gust − mean) layered on top of the mean wind. */
  gustShare: number;
  /** Multiplier bounds on Cw. */
  min: number;
  max: number;
}

export const FEEL_PROFILES: Record<Exclude<WindFeel, 'off'>, FeelProfile> = {
  subtle: { share: 0.35, gustShare: 0.5, min: 0.8, max: 1.25 },
  real: { share: 1, gustShare: 1, min: 0.3, max: 2.5 },
};

export function isWindFeel(v: unknown): v is WindFeel {
  return v === 'off' || v === 'subtle' || v === 'real';
}

const DEG = Math.PI / 180;

/**
 * Wind component along the direction of travel, m/s. Positive = headwind.
 * @param windFromDeg   meteorological direction the wind comes FROM.
 * @param travelBearingDeg direction the rider is heading, clockwise from north.
 */
export function headwindComponent(windSpeedMs: number, windFromDeg: number, travelBearingDeg: number): number {
  if (!Number.isFinite(windSpeedMs) || windSpeedMs <= 0) return 0;
  const h = windSpeedMs * Math.cos((windFromDeg - travelBearingDeg) * DEG);
  return Math.abs(h) < 1e-9 ? 0 : h;
}

/**
 * Where the wind comes from relative to the rider, degrees: 0 = in the face,
 * 90 = from the right, 180 = from behind, 270 = from the left. Same
 * convention as settings.windDirectionDeg and physics.ts.
 */
export function relativeWindDeg(windFromDeg: number, travelBearingDeg: number): number {
  return (((windFromDeg - travelBearingDeg) % 360) + 360) % 360;
}

/**
 * Smooth, repeatable gust envelope in [0, 1]: two slow incommensurate waves,
 * positive part only, so gusts come and go every half-minute or so.
 */
export function gustEnvelope(tSec: number): number {
  const a = Math.sin((2 * Math.PI * tSec) / 41);
  const b = Math.sin((2 * Math.PI * tSec) / 17 + 1.3);
  return Math.min(1, Math.max(0, 0.6 * a + 0.4 * b));
}

/** Wind speed at rider height right now, m/s, including the feel's share of gusts. */
export function riderLevelWindMs(w: Pick<LiveWeather, 'windSpeedMs' | 'windGustMs'>, tSec: number, feel: WindFeel): number {
  if (feel === 'off') return 0;
  const mean = Math.max(0, w.windSpeedMs);
  const excess = Math.max(0, w.windGustMs - mean);
  const gust = excess * FEEL_PROFILES[feel].gustShare * gustEnvelope(tSec);
  return (mean + gust) * RIDER_HEIGHT_WIND_FACTOR;
}

/**
 * Cw multiplier for a headwind at the rider's speed, after the feel's share
 * and caps. 1 = no change.
 */
export function cwMultiplier(headwindMs: number, riderSpeedMs: number, feel: WindFeel): number {
  if (feel === 'off' || !Number.isFinite(headwindMs) || headwindMs === 0) return 1;
  const p = FEEL_PROFILES[feel];
  const v = Math.max(MIN_REFERENCE_SPEED_MS, Number.isFinite(riderSpeedMs) ? riderSpeedMs : 0);
  const air = v + headwindMs;
  const physical = (air * Math.abs(air)) / (v * v);
  const felt = 1 + (physical - 1) * p.share;
  return Math.min(p.max, Math.max(p.min, felt));
}

/** Apply a multiplier to the FTMS Cw byte (Cw × 100), within the field's range. */
export function scaleCwByte(baseCwByte: number, multiplier: number): number {
  const base = Number.isFinite(baseCwByte) ? baseCwByte : 51;
  const m = Number.isFinite(multiplier) ? multiplier : 1;
  return Math.min(255, Math.max(1, Math.round(base * m)));
}

/**
 * Headwind that produces the same drag change as `multiplier` at speed v
 * (inverse of the v² ratio). Used so Demo Mode's physics feels the same
 * wind the trainer would. Negative = tailwind.
 */
export function equivalentHeadwindMs(multiplier: number, riderSpeedMs: number): number {
  const v = Math.max(MIN_REFERENCE_SPEED_MS, Number.isFinite(riderSpeedMs) ? riderSpeedMs : 0);
  const m = Math.max(0, multiplier);
  return v * (Math.sqrt(m) - 1);
}

export interface TrainerWind {
  /** Cw byte to send in 0x11. */
  cwByte: number;
  /** Wind-speed field to send in 0x11 (always 0 when live wind drives Cw). */
  windMs: number;
  /** Multiplier applied to the rider's base Cw. */
  multiplier: number;
  /** Physical headwind at rider height before the feel, m/s (+ = headwind). */
  headwindMs: number;
}

/**
 * Everything the ride loop needs for one SIM update from live wind.
 * @param travelBearingDeg rider heading, degrees clockwise from north.
 */
export function trainerWindFromWeather(
  w: Pick<LiveWeather, 'windSpeedMs' | 'windGustMs' | 'windFromDeg'>,
  travelBearingDeg: number,
  riderSpeedMs: number,
  baseCwByte: number,
  feel: WindFeel,
  tSec: number,
): TrainerWind {
  const atRider = riderLevelWindMs(w, tSec, feel === 'off' ? 'subtle' : feel);
  const headwindMs = headwindComponent(atRider, w.windFromDeg, travelBearingDeg);
  const multiplier = cwMultiplier(headwindMs, riderSpeedMs, feel);
  return { cwByte: scaleCwByte(baseCwByte, multiplier), windMs: 0, multiplier, headwindMs };
}

/**
 * Plain-language description of a relative wind for the HUD, from the
 * reported 10 m speed: calm < 1.5 m/s, light < 4 m/s, strong > 9 m/s.
 */
export function windLabel(windMs: number, relDeg: number): string {
  if (!(windMs >= 1.5)) return 'Calm';
  const strength = windMs < 4 ? 'Light ' : windMs > 9 ? 'Strong ' : '';
  const d = ((relDeg % 360) + 360) % 360;
  let kind: string;
  if (d <= 45 || d >= 315) kind = 'headwind';
  else if (d >= 135 && d <= 225) kind = 'tailwind';
  else kind = 'crosswind';
  const text = `${strength}${kind}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
