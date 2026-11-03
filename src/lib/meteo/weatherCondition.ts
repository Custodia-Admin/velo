/**
 * Live reading → weather condition. Engine-free (no renderer imports) so the
 * world light (lib/world/moods) and the Cesium scene weather share it.
 */

import type { LiveWeather } from '@/lib/meteo/openMeteo';

export type WeatherCondition =
  | 'clear'
  | 'partly-cloudy'
  | 'overcast'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'snow'
  | 'storm';

/** Visibility below this reads as fog whatever the code says, m. */
export const FOG_VISIBILITY_M = 1000;
/** Precipitation above this in the last interval counts as rain, mm. */
export const RAIN_MM = 0.2;

/**
 * WMO weather interpretation code → condition.
 * https://open-meteo.com/en/docs (WMO Weather interpretation codes).
 */
export function conditionFromWmo(code: number): WeatherCondition {
  if (code === 0 || code === 1) return 'clear';
  if (code === 2) return 'partly-cloudy';
  if (code === 3) return 'overcast';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95 && code <= 99) return 'storm';
  return 'partly-cloudy';
}

/**
 * Condition for a reading. The code wins, but measured precipitation and very
 * low visibility upgrade a dry-looking code (models often lag showers and
 * report radiation fog as "overcast").
 */
export function conditionFor(w: LiveWeather): WeatherCondition {
  const fromCode = conditionFromWmo(w.weatherCode);
  const dry = fromCode === 'clear' || fromCode === 'partly-cloudy' || fromCode === 'overcast';
  if (dry && w.snowfallCm > 0) return 'snow';
  if (dry && w.precipitationMm >= RAIN_MM) return 'rain';
  if (dry && w.visibilityM !== null && w.visibilityM < FOG_VISIBILITY_M) return 'fog';
  return fromCode;
}
