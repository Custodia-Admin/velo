/**
 * Live weather → what the rider sees.
 *
 * Real conditions pick the sky, fog, particles, cloud deck and wet road. A
 * fair day keeps the route's canned mood (its light, and the real-time sun
 * where that mood uses it) with clouds sized from the real cover; anything
 * greyer swaps in the matching weather mood, which has its own fixed, flat
 * daylight.
 */

import type { MoodId } from '@/lib/cesiumUtils';
import type { WeatherKind } from '@/lib/weatherParticles';
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

const LABELS: Record<WeatherCondition, string> = {
  clear: 'Sunny',
  'partly-cloudy': 'Some cloud',
  overcast: 'Overcast',
  fog: 'Fog',
  drizzle: 'Drizzle',
  rain: 'Rain',
  snow: 'Snow',
  storm: 'Thunderstorm',
};

/** Short plain-language label for cards and the HUD. "Clear" rather than "Sunny" at night. */
export function conditionLabel(c: WeatherCondition, isDay = true): string {
  if (c === 'clear' && !isDay) return 'Clear';
  return LABELS[c];
}

/** Canned moods that carry weather of their own; a live clear sky replaces them. */
const WEATHERY_MOODS = new Set<MoodId>(['overcast', 'fjord-rain', 'alpine-storm', 'valley-fog']);

export interface SceneWeather {
  /** `live` when real conditions drive the scene, `canned` for the route's own mood. */
  source: 'live' | 'canned';
  mood: MoodId;
  particles: WeatherKind;
  /** Apply the wet-road material. */
  wet: boolean;
  condition: WeatherCondition | null;
  /** Live cloud deck size; undefined = the mood's own count. */
  cloudCount?: number;
}

/** Clouds on fair days follow real cover: 0 % → 4, 100 % → 30 (mood scale). */
export function cloudCountForCover(cloudCoverPct: number): number {
  const c = Math.min(100, Math.max(0, Number.isFinite(cloudCoverPct) ? cloudCoverPct : 0));
  return Math.round(4 + c * 0.26);
}

/**
 * Particles implied by a canned mood's name. Kept for the canned path: the
 * mood catalogue has no explicit particle field.
 */
export function particlesForMood(mood: MoodId): WeatherKind {
  if (mood === 'fjord-rain' || mood === 'alpine-storm') return 'rain';
  if (mood === 'mediterranean-mist' || mood === 'valley-fog') return 'fog';
  return 'none';
}

/**
 * Canned moods that get the wet road. Mirrors RAIN_MOODS in wetRoadMaterial
 * (a test keeps them in sync) without pulling Cesium into the home bundle.
 */
const WET_MOODS = new Set<MoodId>(['fjord-rain', 'alpine-storm']);

/** The route's own look, used when live weather is off or unavailable. */
export function cannedScene(mood: MoodId): SceneWeather {
  return {
    source: 'canned',
    mood,
    particles: particlesForMood(mood),
    wet: WET_MOODS.has(mood),
    condition: null,
  };
}

/**
 * Scene for a live condition, keeping the route's mood (its light) on fair
 * days with a cloud deck sized from the real cloud cover when known.
 */
export function sceneForCondition(
  condition: WeatherCondition,
  cannedMood: MoodId,
  cloudCoverPct?: number,
): SceneWeather {
  const base = { source: 'live' as const, condition };
  switch (condition) {
    case 'clear':
    case 'partly-cloudy': {
      const mood = WEATHERY_MOODS.has(cannedMood) ? 'clear-afternoon' : cannedMood;
      const fair = { ...base, mood, particles: 'none' as const, wet: false };
      return cloudCoverPct === undefined ? fair : { ...fair, cloudCount: cloudCountForCover(cloudCoverPct) };
    }
    case 'overcast':
      return { ...base, mood: 'overcast', particles: 'none', wet: false };
    case 'fog':
      return { ...base, mood: 'valley-fog', particles: 'fog', wet: false };
    case 'drizzle':
      return { ...base, mood: 'overcast', particles: 'rain', wet: true };
    case 'rain':
      return { ...base, mood: 'fjord-rain', particles: 'rain', wet: true };
    case 'snow':
      return { ...base, mood: 'overcast', particles: 'snow', wet: false };
    case 'storm':
      return { ...base, mood: 'alpine-storm', particles: 'rain', wet: true };
  }
}

/**
 * Final scene for a ride: live conditions when enabled and available,
 * otherwise the canned mood.
 */
export function resolveSceneWeather(
  cannedMood: MoodId,
  weather: LiveWeather | null | undefined,
  liveEnabled: boolean,
): SceneWeather {
  if (!liveEnabled || !weather) return cannedScene(cannedMood);
  return sceneForCondition(conditionFor(weather), cannedMood, weather.cloudCoverPct);
}

/** Stable string for effect dependencies. */
export function sceneKey(s: SceneWeather): string {
  return `${s.source}:${s.mood}:${s.particles}:${s.wet ? 'wet' : 'dry'}:${s.cloudCount ?? '-'}`;
}
