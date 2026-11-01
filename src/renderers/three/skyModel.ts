/**
 * Sky, sun and fog per scene mood for the world renderer (pure data + math).
 *
 * Mood ids are the scene moods the ride already uses (lib/meteo/sceneWeather,
 * world manifests). Clear moods follow the real sun at the route (wall
 * clock, held at least 15° up so the ride never goes dark, like the Cesium
 * sky); weather moods pin their light.
 */

import { sunAzimuthAndAltitude } from '@/lib/sunPosition';

export type Rgb = readonly [number, number, number];

export interface MoodLook {
  zenith: Rgb;
  horizon: Rgb;
  /** Hemisphere light ground bounce colour. */
  ground: Rgb;
  sun: Rgb;
  /** Directional sun intensity (three.js physically based units, roughly lux/1000). */
  sunIntensity: number;
  /** Hemisphere (sky) light intensity. */
  skyIntensity: number;
  /** Unused by the exponential haze; kept for linear-fog tiers. */
  fogNear: number;
  /** Haze is ~opaque at this share of the view distance. */
  fogFar: number;
  exposure: number;
  /** Follow the real sun when it is up; otherwise use `fixedSun`. */
  realSun: boolean;
  /** Azimuth (° clockwise from north) and altitude (°) when pinned. */
  fixedSun: readonly [number, number];
}

const hex = (h: number): Rgb => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

export const MOOD_LOOKS: Readonly<Record<string, MoodLook>> = {
  'clear-noon': {
    zenith: hex(0x3f73b8),
    horizon: hex(0xc5d6e4),
    ground: hex(0x6b6247),
    sun: hex(0xfff4e2),
    sunIntensity: 3.2,
    skyIntensity: 0.9,
    fogNear: 0.25,
    fogFar: 1,
    exposure: 1,
    realSun: true,
    fixedSun: [180, 58],
  },
  'clear-afternoon': {
    zenith: hex(0x4a7cbd),
    horizon: hex(0xd5dde0),
    ground: hex(0x6f6246),
    sun: hex(0xffe7c4),
    sunIntensity: 3,
    skyIntensity: 0.85,
    fogNear: 0.22,
    fogFar: 1,
    exposure: 1,
    realSun: true,
    fixedSun: [240, 32],
  },
  'golden-hour': {
    zenith: hex(0x55719f),
    horizon: hex(0xf0c18e),
    ground: hex(0x6b5338),
    sun: hex(0xffc27a),
    sunIntensity: 2.6,
    skyIntensity: 0.7,
    fogNear: 0.18,
    fogFar: 0.95,
    exposure: 1.05,
    realSun: false,
    fixedSun: [262, 9],
  },
  'dusk-cool': {
    zenith: hex(0x3c4f7a),
    horizon: hex(0xc9a7a0),
    ground: hex(0x4d4538),
    sun: hex(0xffb88a),
    sunIntensity: 1.8,
    skyIntensity: 0.7,
    fogNear: 0.16,
    fogFar: 0.9,
    exposure: 1.1,
    realSun: false,
    fixedSun: [275, 6],
  },
  overcast: {
    zenith: hex(0x8d97a1),
    horizon: hex(0xc4c8cb),
    ground: hex(0x5e5a4e),
    sun: hex(0xe9ecef),
    sunIntensity: 0.9,
    skyIntensity: 1.5,
    fogNear: 0.12,
    fogFar: 0.75,
    exposure: 1.05,
    realSun: false,
    fixedSun: [200, 50],
  },
  'valley-fog': {
    zenith: hex(0xa7b0b6),
    horizon: hex(0xd3d6d6),
    ground: hex(0x63604f),
    sun: hex(0xf3ede0),
    sunIntensity: 1.1,
    skyIntensity: 1.35,
    fogNear: 0.02,
    fogFar: 0.3,
    exposure: 1.05,
    realSun: false,
    fixedSun: [150, 25],
  },
  'mediterranean-mist': {
    zenith: hex(0x7fa1c4),
    horizon: hex(0xdfe2de),
    ground: hex(0x6d6650),
    sun: hex(0xfff0d8),
    sunIntensity: 2.2,
    skyIntensity: 1.1,
    fogNear: 0.06,
    fogFar: 0.55,
    exposure: 1,
    realSun: true,
    fixedSun: [200, 40],
  },
  'fjord-rain': {
    zenith: hex(0x6b7580),
    horizon: hex(0xa3aab0),
    ground: hex(0x4b4a42),
    sun: hex(0xd9dde2),
    sunIntensity: 0.6,
    skyIntensity: 1.4,
    fogNear: 0.05,
    fogFar: 0.5,
    exposure: 1.1,
    realSun: false,
    fixedSun: [200, 40],
  },
  'alpine-storm': {
    zenith: hex(0x4c545e),
    horizon: hex(0x8a9096),
    ground: hex(0x403f39),
    sun: hex(0xc9ced4),
    sunIntensity: 0.45,
    skyIntensity: 1.3,
    fogNear: 0.04,
    fogFar: 0.45,
    exposure: 1.15,
    realSun: false,
    fixedSun: [200, 35],
  },
};

export const DEFAULT_MOOD = 'clear-afternoon';

export function moodLook(mood: string | null | undefined): MoodLook {
  return (mood && MOOD_LOOKS[mood]) || MOOD_LOOKS[DEFAULT_MOOD];
}

export function isWorldMood(mood: unknown): mood is string {
  return typeof mood === 'string' && Object.prototype.hasOwnProperty.call(MOOD_LOOKS, mood);
}

export const MIN_REAL_SUN_ALTITUDE_DEG = 15;

/** Sun azimuth/altitude (degrees) for a mood at a place and time. */
export function sunFor(look: MoodLook, date: Date, lat: number, lon: number): { azimuth: number; altitude: number } {
  if (look.realSun) {
    const s = sunAzimuthAndAltitude(date, lat, lon);
    if (Number.isFinite(s.altitude) && s.altitude >= MIN_REAL_SUN_ALTITUDE_DEG) {
      return { azimuth: s.azimuth, altitude: Math.min(s.altitude, 72) };
    }
  }
  return { azimuth: look.fixedSun[0], altitude: look.fixedSun[1] };
}

/** Unit vector toward the sun in three.js coordinates (x east, y up, z south). */
export function sunDirection(azimuthDeg: number, altitudeDeg: number): [number, number, number] {
  const az = (azimuthDeg * Math.PI) / 180;
  const alt = (altitudeDeg * Math.PI) / 180;
  const east = Math.sin(az) * Math.cos(alt);
  const north = Math.cos(az) * Math.cos(alt);
  return [east, Math.sin(alt), -north];
}

/**
 * Low sun warms the light and the horizon: 0 at ≥ 35°, 1 at the horizon.
 * The sky shader and the sun light both use it.
 */
export function lowSunWarmth(altitudeDeg: number): number {
  const t = 1 - Math.min(1, Math.max(0, altitudeDeg / 35));
  return t * t;
}

/**
 * Exponential-squared haze: the far end of the view (viewDistance × the
 * mood's fogFar share) is ~98 % fog, 1 km out stays clear on fair days.
 */
export function fogDensity(viewDistanceM: number, fogFar: number): number {
  return 2 / Math.max(100, viewDistanceM * fogFar);
}
