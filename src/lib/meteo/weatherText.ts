/**
 * Plain-language weather strings for cards and the ride HUD.
 * Pure functions so the copy is unit-tested, not eyeballed.
 */

import type { LiveWeather } from '@/lib/meteo/openMeteo';
import { conditionFor, conditionLabel } from '@/lib/meteo/sceneWeather';
import { windLabel } from '@/lib/meteo/windFeel';

export type Units = 'metric' | 'imperial';

/** Below this the card just says "calm", m/s (~5 km/h). */
export const CALM_MS = 1.5;

export function windSpeedText(ms: number, units: Units): string {
  const v = Math.max(0, ms);
  return units === 'imperial' ? `${Math.round(v * 2.236936)} mph` : `${Math.round(v * 3.6)} km/h`;
}

export function temperatureText(c: number, units: Units): string {
  const t = units === 'imperial' ? c * 1.8 + 32 : c;
  // Normalise -0 so "-0°" never shows.
  return `${Math.round(t) || 0}°`;
}

/** "Fog · 9° · calm" / "Sunny · 12° · wind 14 km/h". */
export function cardWeatherText(w: LiveWeather, units: Units): string {
  const label = conditionLabel(conditionFor(w), w.isDay);
  const wind = w.windSpeedMs < CALM_MS ? 'calm' : `wind ${windSpeedText(w.windSpeedMs, units)}`;
  return `${label} · ${temperatureText(w.temperatureC, units)} · ${wind}`;
}

/** "14:05" from Open-Meteo's local ISO time ("2026-10-30T14:05"); '' if unparseable. */
export function observedTimeText(observedAt: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(observedAt);
  return m ? `${m[1]}:${m[2]}` : '';
}

/** HUD condition part: "Fog · 9°". */
export function hudConditionText(w: LiveWeather, units: Units): string {
  return `${conditionLabel(conditionFor(w), w.isDay)} · ${temperatureText(w.temperatureC, units)}`;
}

/** HUD wind part: "Light headwind 11 km/h", or "Calm". Uses the reported (10 m) speed. */
export function hudWindText(windMs: number, relDeg: number, units: Units): string {
  const label = windLabel(windMs, relDeg);
  return label === 'Calm' ? label : `${label} ${windSpeedText(windMs, units)}`;
}
