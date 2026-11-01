/**
 * World light: what the sky, sun, haze and weather look like for a ride at a
 * place and moment (pure data + math, engine-free; the three.js world
 * renderer turns it into uniforms).
 *
 * - **Time of day follows the clock.** The real sun at the route start, day
 *   and night included. A route whose mood is a golden hour pins the light to
 *   this evening's golden hour instead; a caller may also pin a preset
 *   (dawn, noon, golden, night, …) for previews and reference shots.
 * - **Live weather** (Open-Meteo, p2c) drives cloud cover, overcast, rain,
 *   snow, fog, visibility and wind; without it the route's canned mood
 *   stands in (overcast, valley fog, rain, storm).
 *
 * Clear-sky light is a set of keyframes over sun altitude, calibrated against
 * the offline stills of scripts/v2-world-thumbs (the signed-off "warm atlas"
 * look). Weather then blends toward overcast/rain/fog looks.
 *
 * Colours are sRGB triples in 0–1. Haze/fog values are per metre.
 */

import { conditionFor, type WeatherCondition } from '../meteo/sceneWeather';
import type { LiveWeather } from '../meteo/openMeteo';
import { sunAzimuthAndAltitude } from '../sunPosition';

export type Rgb = readonly [number, number, number];

export type TimePreset = 'dawn' | 'morning' | 'noon' | 'afternoon' | 'golden' | 'dusk' | 'night';
export const TIME_PRESETS: readonly TimePreset[] = ['dawn', 'morning', 'noon', 'afternoon', 'golden', 'dusk', 'night'];

export type DayPhase = 'night' | 'twilight' | 'sunrise' | 'golden' | 'day';

export interface WorldLightInput {
  /** The clock (wall time). */
  date: Date;
  lat: number;
  lon: number;
  /** The route's canned mood (scenic route, else the world default). */
  mood: string;
  /** Live reading for the route, or null. */
  live: LiveWeather | null;
  /** Rider setting: use live weather when available. */
  liveEnabled: boolean;
  /** Pin the time of day (previews, reference shots). */
  time?: TimePreset | null;
  /** Pin the weather (previews, reference shots); wins over live and canned. */
  weather?: WeatherCondition | null;
  /** Lowest ground in the world, metres: valley fog pools just above it. */
  groundMinM?: number;
}

export interface WorldLight {
  /** The instant the sun was computed for, and why. */
  at: Date;
  timeSource: 'clock' | 'mood' | 'override';
  phase: DayPhase;
  /** The real sun, degrees (azimuth clockwise from north; altitude may be negative). */
  sun: { azimuthDeg: number; altitudeDeg: number };
  /** The directional light actually used: the sun by day, the moon by night. */
  key: { azimuthDeg: number; altitudeDeg: number; color: Rgb; intensity: number; castsShadow: boolean };
  hemi: { sky: Rgb; ground: Rgb; intensity: number };
  /** Environment (sky reflection) strength. */
  env: number;
  exposure: number;
  /** Sky scattering (three.js Sky model) plus clouds. */
  sky: {
    turbidity: number;
    rayleigh: number;
    mie: number;
    mieG: number;
    /** Cloud coverage 0–1 of the sky layer. */
    clouds: number;
    /** 1 = a closed grey deck. */
    overcast: number;
    cloudHeightM: number;
  };
  /** Aerial perspective + height fog. */
  atmosphere: {
    /** Uniform extinction, 1/m. */
    haze: number;
    /** Height-fog density at `fogBaseM`, 1/m, falling off by `fogFalloff` per metre above. */
    fogDensity: number;
    fogFalloff: number;
    fogBaseM: number;
    fogTint: Rgb;
    fogTintMix: number;
    /** Sun glow in the haze (Mie forward scatter). */
    sunHaze: number;
    hazeTint: Rgb;
    hazeG: number;
  };
  weather: {
    condition: WeatherCondition;
    source: 'live' | 'canned' | 'override';
    /** Rain streak density 0–1. */
    rain: number;
    snow: number;
    /** Road/ground wetness 0–1. */
    wet: number;
    /** Strength of moving cloud shadows on the ground 0–1. */
    cloudShadow: number;
    windMs: number;
    windFromDeg: number;
  };
  /** 0 by day … 1 at night: lit windows, street lights, night sky. */
  night: number;
}

// ---------------------------------------------------------------------------
// Clear-sky keyframes over sun altitude
// ---------------------------------------------------------------------------

interface Key {
  alt: number;
  sunColor: Rgb;
  sun: number;
  hemiSky: Rgb;
  hemiGround: Rgb;
  hemi: number;
  env: number;
  exposure: number;
  turbidity: number;
  rayleigh: number;
  mie: number;
  mieG: number;
  haze: number;
  fogDensity: number;
  fogFalloff: number;
  fogTint: Rgb;
  fogTintMix: number;
  sunHaze: number;
  hazeTint: Rgb;
  hazeG: number;
  clouds: number;
  night: number;
}

const hex = (h: number): Rgb => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

/** Ascending altitude. Values from the warm-atlas stills (golden/late-afternoon/afternoon/noon/blue hour). */
export const CLEAR_KEYS: readonly Key[] = [
  {
    alt: -18,
    sunColor: hex(0x9fb2e0),
    sun: 1.0,
    hemiSky: hex(0x34487a),
    hemiGround: hex(0x141416),
    hemi: 0.42,
    env: 2.2,
    exposure: 1.35,
    turbidity: 3,
    rayleigh: 1,
    mie: 0.004,
    mieG: 0.8,
    haze: 1 / 14000,
    fogDensity: 1 / 9000,
    fogFalloff: 1 / 150,
    fogTint: hex(0x1d2742),
    fogTintMix: 0.3,
    sunHaze: 0,
    hazeTint: hex(0xb7c4ff),
    hazeG: 0.7,
    clouds: 0.15,
    night: 1,
  },
  {
    alt: -4,
    sunColor: hex(0xff9a60),
    sun: 0,
    hemiSky: hex(0x3e5486),
    hemiGround: hex(0x1e1c1c),
    hemi: 0.42,
    env: 1.7,
    exposure: 0.95,
    turbidity: 4,
    rayleigh: 2.5,
    mie: 0.005,
    mieG: 0.8,
    haze: 1 / 12000,
    fogDensity: 1 / 6000,
    fogFalloff: 1 / 150,
    fogTint: hex(0x2c3a5c),
    fogTintMix: 0.2,
    sunHaze: 0,
    hazeTint: hex(0xc9d4ff),
    hazeG: 0.7,
    clouds: 0.18,
    night: 1,
  },
  {
    alt: 0.5,
    sunColor: hex(0xff8644),
    sun: 2.6,
    hemiSky: hex(0x6d7ca6),
    hemiGround: hex(0x4a3a2a),
    hemi: 0.5,
    env: 1.35,
    exposure: 0.64,
    turbidity: 8.5,
    rayleigh: 3,
    mie: 0.01,
    mieG: 0.9,
    haze: 1 / 10000,
    fogDensity: 1 / 4800,
    fogFalloff: 1 / 150,
    fogTint: hex(0xffb98a),
    fogTintMix: 0.2,
    sunHaze: 0.65,
    hazeTint: hex(0xffd6b0),
    hazeG: 0.8,
    clouds: 0.22,
    night: 0.45,
  },
  {
    alt: 4.5,
    sunColor: hex(0xffa45a),
    sun: 4.6,
    hemiSky: hex(0x7b8fb4),
    hemiGround: hex(0x5a4630),
    hemi: 0.58,
    env: 1.4,
    exposure: 0.6,
    turbidity: 7.5,
    rayleigh: 2.6,
    mie: 0.008,
    mieG: 0.88,
    haze: 1 / 11000,
    fogDensity: 1 / 5200,
    fogFalloff: 1 / 150,
    fogTint: hex(0xffc98e),
    fogTintMix: 0.18,
    sunHaze: 0.55,
    hazeTint: hex(0xffe2c0),
    hazeG: 0.78,
    clouds: 0.22,
    night: 0,
  },
  {
    alt: 12,
    sunColor: hex(0xffc788),
    sun: 4.4,
    hemiSky: hex(0x8ea3c8),
    hemiGround: hex(0x6a5638),
    hemi: 0.55,
    env: 1.1,
    exposure: 0.5,
    turbidity: 5.5,
    rayleigh: 2,
    mie: 0.006,
    mieG: 0.85,
    haze: 1 / 13000,
    fogDensity: 1 / 7000,
    fogFalloff: 1 / 200,
    fogTint: hex(0xf6dcb4),
    fogTintMix: 0.14,
    sunHaze: 0.32,
    hazeTint: hex(0xf8e6cf),
    hazeG: 0.72,
    clouds: 0.28,
    night: 0,
  },
  {
    alt: 34,
    sunColor: hex(0xfff1dc),
    sun: 3.4,
    hemiSky: hex(0xb8cbe6),
    hemiGround: hex(0x7a6a4c),
    hemi: 0.48,
    env: 0.8,
    exposure: 0.42,
    turbidity: 3.2,
    rayleigh: 1.4,
    mie: 0.004,
    mieG: 0.8,
    haze: 1 / 21000,
    fogDensity: 1 / 9000,
    fogFalloff: 1 / 250,
    fogTint: hex(0xd8e2ee),
    fogTintMix: 0.15,
    sunHaze: 0.12,
    hazeTint: hex(0xf2efe8),
    hazeG: 0.7,
    clouds: 0.3,
    night: 0,
  },
  {
    alt: 55,
    sunColor: hex(0xfff6ea),
    sun: 3.4,
    hemiSky: hex(0xb8cbe6),
    hemiGround: hex(0x7a6a4c),
    hemi: 0.48,
    env: 0.75,
    exposure: 0.4,
    turbidity: 3,
    rayleigh: 1.3,
    mie: 0.004,
    mieG: 0.8,
    haze: 1 / 20000,
    fogDensity: 1 / 9000,
    fogFalloff: 1 / 250,
    fogTint: hex(0xd8e2ee),
    fogTintMix: 0.15,
    sunHaze: 0.1,
    hazeTint: hex(0xf2efe8),
    hazeG: 0.7,
    clouds: 0.25,
    night: 0,
  },
];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpRgb = (a: Rgb, b: Rgb, t: number): Rgb => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
/** Per-metre extinctions blend in log space (a 1/4000 → 1/20000 fade looks even). */
const lerpLog = (a: number, b: number, t: number) => Math.exp(lerp(Math.log(Math.max(a, 1e-9)), Math.log(Math.max(b, 1e-9)), t));
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

function blendKeys(a: Key, b: Key, t: number): Key {
  return {
    alt: lerp(a.alt, b.alt, t),
    sunColor: lerpRgb(a.sunColor, b.sunColor, t),
    sun: lerp(a.sun, b.sun, t),
    hemiSky: lerpRgb(a.hemiSky, b.hemiSky, t),
    hemiGround: lerpRgb(a.hemiGround, b.hemiGround, t),
    hemi: lerp(a.hemi, b.hemi, t),
    env: lerp(a.env, b.env, t),
    exposure: lerp(a.exposure, b.exposure, t),
    turbidity: lerp(a.turbidity, b.turbidity, t),
    rayleigh: lerp(a.rayleigh, b.rayleigh, t),
    mie: lerp(a.mie, b.mie, t),
    mieG: lerp(a.mieG, b.mieG, t),
    haze: lerpLog(a.haze, b.haze, t),
    fogDensity: lerpLog(a.fogDensity, b.fogDensity, t),
    fogFalloff: lerp(a.fogFalloff, b.fogFalloff, t),
    fogTint: lerpRgb(a.fogTint, b.fogTint, t),
    fogTintMix: lerp(a.fogTintMix, b.fogTintMix, t),
    sunHaze: lerp(a.sunHaze, b.sunHaze, t),
    hazeTint: lerpRgb(a.hazeTint, b.hazeTint, t),
    hazeG: lerp(a.hazeG, b.hazeG, t),
    clouds: lerp(a.clouds, b.clouds, t),
    night: lerp(a.night, b.night, t),
  };
}

/** Clear-sky light for a sun altitude (clamped to the key range, smooth in between). */
export function clearSkyAt(altitudeDeg: number): Key {
  const keys = CLEAR_KEYS;
  if (!(altitudeDeg > keys[0].alt)) return keys[0];
  for (let i = 1; i < keys.length; i++) {
    if (altitudeDeg <= keys[i].alt) {
      const t = (altitudeDeg - keys[i - 1].alt) / (keys[i].alt - keys[i - 1].alt);
      return blendKeys(keys[i - 1], keys[i], t * t * (3 - 2 * t));
    }
  }
  return keys[keys.length - 1];
}

// ---------------------------------------------------------------------------
// Time of day
// ---------------------------------------------------------------------------

/** Canned moods that pin this evening's golden hour (route mood override). */
export const GOLDEN_MOODS: ReadonlySet<string> = new Set(['golden-hour', 'dusk-cool']);

const MIN = 60_000;

/** Samples of the sun over the local solar day around `date` (5-minute steps). */
function solarDay(date: Date, lat: number, lon: number): { t: number; alt: number; az: number }[] {
  const dayMs = 86_400_000;
  // Approximate local solar midnight before the solar noon nearest `date`.
  const noonUtc = Math.floor(date.getTime() / dayMs) * dayMs + (12 - lon / 15) * 3_600_000;
  const noon = noonUtc + Math.round((date.getTime() - noonUtc) / dayMs) * dayMs;
  const out: { t: number; alt: number; az: number }[] = [];
  for (let t = noon - 12 * 60 * MIN; t <= noon + 12 * 60 * MIN; t += 5 * MIN) {
    const s = sunAzimuthAndAltitude(new Date(t), lat, lon);
    out.push({ t, alt: s.altitude, az: s.azimuth });
  }
  return out;
}

/** First instant (after the peak when `evening`) the sun crosses `alt`, linear between samples. */
function crossing(day: { t: number; alt: number }[], alt: number, evening: boolean): number | null {
  let peak = 0;
  for (let i = 1; i < day.length; i++) if (day[i].alt > day[peak].alt) peak = i;
  if (day[peak].alt < alt) return null;
  if (evening) {
    for (let i = peak; i + 1 < day.length; i++) {
      if (day[i].alt >= alt && day[i + 1].alt < alt) {
        const f = (day[i].alt - alt) / (day[i].alt - day[i + 1].alt);
        return day[i].t + f * (day[i + 1].t - day[i].t);
      }
    }
  } else {
    for (let i = peak; i > 0; i--) {
      if (day[i].alt >= alt && day[i - 1].alt < alt) {
        const f = (day[i].alt - alt) / (day[i].alt - day[i - 1].alt);
        return day[i].t - f * (day[i].t - day[i - 1].t);
      }
    }
  }
  return null;
}

/** Sun altitude each preset aims for (morning side for dawn/morning). */
export const PRESET_ALTITUDE: Readonly<Record<TimePreset, number>> = {
  dawn: 3,
  morning: 18,
  noon: 90,
  afternoon: 30,
  golden: 6,
  dusk: -3,
  night: -30,
};

/**
 * The instant of a preset on the solar day around `date`: dawn/morning on
 * the rising side, golden/dusk/afternoon on the setting side, noon at the
 * peak, night at solar midnight. Falls back to the nearest reachable
 * altitude in polar summer/winter.
 */
export function presetInstant(preset: TimePreset, date: Date, lat: number, lon: number): Date {
  const day = solarDay(date, lat, lon);
  let peak = 0;
  for (let i = 1; i < day.length; i++) if (day[i].alt > day[peak].alt) peak = i;
  if (preset === 'noon') return new Date(day[peak].t);
  if (preset === 'night') {
    // Deepest point on the evening side (solar midnight).
    let low = peak;
    for (let i = peak; i < day.length; i++) if (day[i].alt < day[low].alt) low = i;
    return new Date(day[low].t);
  }
  const evening = preset !== 'dawn' && preset !== 'morning';
  const target = Math.min(PRESET_ALTITUDE[preset], day[peak].alt - 1);
  const t = crossing(day, target, evening);
  return new Date(t ?? day[peak].t);
}

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

/** What a canned mood implies when live weather isn't driving the scene. */
export function cannedCondition(mood: string): WeatherCondition {
  switch (mood) {
    case 'overcast':
      return 'overcast';
    case 'valley-fog':
      return 'fog';
    case 'fjord-rain':
      return 'rain';
    case 'alpine-storm':
      return 'storm';
    default:
      return 'clear';
  }
}

interface WeatherLook {
  condition: WeatherCondition;
  source: 'live' | 'canned' | 'override';
  cover: number;
  overcast: number;
  rain: number;
  snow: number;
  fog: number;
  visibilityM: number | null;
  windMs: number;
  windFromDeg: number;
}

export function weatherLook(input: WorldLightInput): WeatherLook {
  const calm = { windMs: 2, windFromDeg: 270, visibilityM: null as number | null };
  let condition: WeatherCondition;
  let source: WeatherLook['source'];
  let cover: number | null = null;
  let live = calm;
  if (input.weather) {
    condition = input.weather;
    source = 'override';
  } else if (input.liveEnabled && input.live) {
    condition = conditionFor(input.live);
    source = 'live';
    cover = clamp01((Number.isFinite(input.live.cloudCoverPct) ? input.live.cloudCoverPct : 0) / 100);
    live = {
      windMs: Number.isFinite(input.live.windSpeedMs) ? input.live.windSpeedMs : 2,
      windFromDeg: Number.isFinite(input.live.windFromDeg) ? input.live.windFromDeg : 270,
      visibilityM: input.live.visibilityM,
    };
  } else {
    condition = cannedCondition(input.mood);
    source = 'canned';
  }
  const wet = condition === 'rain' || condition === 'drizzle' || condition === 'storm';
  const grey = wet || condition === 'overcast' || condition === 'snow' || condition === 'fog';
  const defaultCover = condition === 'clear' ? 0.15 : condition === 'partly-cloudy' ? 0.45 : 1;
  return {
    condition,
    source,
    cover: cover ?? defaultCover,
    overcast: grey ? 1 : smooth(0.75, 1, cover ?? defaultCover),
    rain: condition === 'storm' || condition === 'rain' ? 1 : condition === 'drizzle' ? 0.4 : 0,
    snow: condition === 'snow' ? 1 : 0,
    fog: condition === 'fog' ? 1 : 0,
    visibilityM: live.visibilityM,
    windMs: condition === 'storm' && source !== 'live' ? 9 : live.windMs,
    windFromDeg: live.windFromDeg,
  };
}

// ---------------------------------------------------------------------------
// Moon (night key light): opposite the sun, high enough to model the hills
// ---------------------------------------------------------------------------

function moonFor(sunAz: number): { azimuthDeg: number; altitudeDeg: number } {
  return { azimuthDeg: (sunAz + 180) % 360, altitudeDeg: 38 };
}

// ---------------------------------------------------------------------------
// The light
// ---------------------------------------------------------------------------

export function phaseFor(altitudeDeg: number): DayPhase {
  if (altitudeDeg < -8) return 'night';
  if (altitudeDeg < -0.5) return 'twilight';
  if (altitudeDeg < 3) return 'sunrise';
  if (altitudeDeg < 14) return 'golden';
  return 'day';
}

/** Which instant the light is for, and why. */
export function lightInstant(input: Pick<WorldLightInput, 'date' | 'lat' | 'lon' | 'mood' | 'time'>): {
  at: Date;
  source: WorldLight['timeSource'];
} {
  if (input.time) return { at: presetInstant(input.time, input.date, input.lat, input.lon), source: 'override' };
  if (GOLDEN_MOODS.has(input.mood)) return { at: presetInstant('golden', input.date, input.lat, input.lon), source: 'mood' };
  return { at: input.date, source: 'clock' };
}

export function worldLight(input: WorldLightInput): WorldLight {
  const { at, source } = lightInstant(input);
  const s = sunAzimuthAndAltitude(at, input.lat, input.lon);
  const alt = Number.isFinite(s.altitude) ? s.altitude : 30;
  const az = Number.isFinite(s.azimuth) ? s.azimuth : 200;
  const k = clearSkyAt(alt);
  const w = weatherLook(input);
  const ground = input.groundMinM ?? 170;
  const morning = az < 180;

  // Clear-sky starting point, with a cooler, mistier dawn on the rising side.
  let sunColor = k.sunColor;
  let hazeTint = k.hazeTint;
  let fogDensity = k.fogDensity;
  let fogFalloff = k.fogFalloff;
  let fogTint = k.fogTint;
  let fogTintMix = k.fogTintMix;
  if (morning && alt > -6 && alt < 14) {
    const m = 1 - smooth(6, 14, alt);
    sunColor = lerpRgb(sunColor, hex(0xffb49a), 0.25 * m);
    hazeTint = lerpRgb(hazeTint, hex(0xe8e4f0), 0.4 * m);
    fogDensity = lerpLog(fogDensity, 1 / 900, 0.7 * m);
    fogFalloff = lerp(fogFalloff, 1 / 45, 0.7 * m);
    fogTint = lerpRgb(fogTint, hex(0xf3d9c6), 0.5 * m);
    fogTintMix = lerp(fogTintMix, 0.45, 0.6 * m);
  }

  const night = k.night;
  const isNight = alt < -4;
  const moon = moonFor(az);
  const key = isNight
    ? { azimuthDeg: moon.azimuthDeg, altitudeDeg: moon.altitudeDeg }
    : { azimuthDeg: az, altitudeDeg: Math.max(alt, 0.8) };
  // Twilight: the sun is gone and the moon not yet the key light; blend the intensity through zero.
  const keyIntensity = isNight ? CLEAR_KEYS[0].sun * smooth(-4, -12, alt) : k.sun * smooth(-1, 3, alt);

  let light: WorldLight = {
    at,
    timeSource: source,
    phase: phaseFor(alt),
    sun: { azimuthDeg: az, altitudeDeg: alt },
    key: {
      ...key,
      color: isNight ? CLEAR_KEYS[0].sunColor : sunColor,
      intensity: keyIntensity,
      castsShadow: keyIntensity > 0.25,
    },
    hemi: { sky: k.hemiSky, ground: k.hemiGround, intensity: k.hemi },
    env: k.env,
    exposure: k.exposure,
    sky: {
      turbidity: k.turbidity,
      rayleigh: k.rayleigh,
      mie: k.mie,
      mieG: k.mieG,
      clouds: Math.max(k.clouds * 0.5, w.cover * 0.85),
      overcast: 0,
      cloudHeightM: 2400,
    },
    atmosphere: {
      haze: k.haze,
      fogDensity,
      fogFalloff,
      fogBaseM: ground + 8,
      fogTint,
      fogTintMix,
      sunHaze: k.sunHaze,
      hazeTint,
      hazeG: k.hazeG,
    },
    weather: {
      condition: w.condition,
      source: w.source,
      rain: w.rain,
      snow: w.snow,
      wet: w.rain > 0 ? 0.55 + 0.45 * w.rain : 0,
      cloudShadow: w.overcast > 0.5 ? 0 : smooth(0.1, 0.6, w.cover),
      windMs: w.windMs,
      windFromDeg: w.windFromDeg,
    },
    night,
  };

  // Partial cloud dims the sun a little; the moving cloud shadows do the rest.
  light.key.intensity *= 1 - 0.35 * smooth(0.4, 0.95, w.cover);

  if (w.overcast > 0) light = applyOvercast(light, w);
  if (w.fog > 0) light = applyFog(light, ground);
  if (w.visibilityM !== null && Number.isFinite(w.visibilityM) && w.visibilityM > 0) {
    // ~5 % contrast left at the reported visibility.
    light.atmosphere.haze = Math.max(light.atmosphere.haze, 3 / Math.max(300, w.visibilityM));
  }
  return light;
}

/** Overcast, drizzle, rain, storm and snow: a closed deck, flat bright-grey light, more haze. */
function applyOvercast(l: WorldLight, w: WeatherLook): WorldLight {
  const o = w.overcast;
  const day = 1 - l.night;
  const dark = w.condition === 'storm' ? 0.6 : w.rain > 0 ? 0.8 : 1;
  const rainy = w.rain > 0 || w.condition === 'storm';
  return {
    ...l,
    key: {
      ...l.key,
      color: lerpRgb(l.key.color, hex(0xe8e8e4), o),
      intensity: lerp(l.key.intensity, (rainy ? 0.25 : 0.55) * day + 0.06 * l.night, o),
      castsShadow: l.key.castsShadow && o < 0.5,
    },
    hemi: {
      sky: lerpRgb(l.hemi.sky, rainy ? hex(0xaab1b8) : hex(0xc9ced3), o * day),
      ground: lerpRgb(l.hemi.ground, hex(0x5f5a4d), o * day),
      intensity: lerp(l.hemi.intensity, (1.15 * dark) * day + 0.16 * l.night, o),
    },
    env: lerp(l.env, 1.35 * day + 1.6 * l.night, o),
    exposure: lerp(l.exposure, 0.62 * day + 0.95 * l.night, o),
    sky: { ...l.sky, turbidity: lerp(l.sky.turbidity, 10, o), clouds: 1, overcast: o, cloudHeightM: rainy ? 1100 : 1500 },
    atmosphere: {
      ...l.atmosphere,
      haze: lerpLog(l.atmosphere.haze, w.condition === 'storm' ? 1 / 2600 : rainy ? 1 / 4200 : 1 / 9000, o),
      fogDensity: lerpLog(l.atmosphere.fogDensity, rainy ? 1 / 2500 : 1 / 5000, o),
      fogFalloff: lerp(l.atmosphere.fogFalloff, 1 / 300, o),
      fogTint: lerpRgb(l.atmosphere.fogTint, rainy ? hex(0x9ea5ab) : hex(0xb9bec2), o * day),
      fogTintMix: lerp(l.atmosphere.fogTintMix, 0.65, o * day),
      sunHaze: lerp(l.atmosphere.sunHaze, 0, o),
      hazeTint: lerpRgb(l.atmosphere.hazeTint, hex(0xffffff), o * day),
    },
    weather: { ...l.weather, cloudShadow: l.weather.cloudShadow * (1 - o) },
  };
}

/** Fog: a dense, lit layer pooled in the valleys, low visibility. */
function applyFog(l: WorldLight, ground: number): WorldLight {
  return {
    ...l,
    atmosphere: {
      ...l.atmosphere,
      haze: Math.max(l.atmosphere.haze, 1 / 2600),
      fogDensity: 1 / 45,
      fogFalloff: 1 / 16,
      fogBaseM: ground + 55,
      fogTint: lerpRgb(l.atmosphere.fogTint, hex(0xe9e4dc), 1 - l.night),
      fogTintMix: 0.7,
    },
  };
}

/** Stable key: inputs that change the light (rounded to the minute). */
export function worldLightKey(input: WorldLightInput): string {
  const { at } = lightInstant(input);
  const l = input.live;
  return [
    // The sun moves ~1° in 4 minutes: relight (sky capture, terrain shadows) no more often.
    Math.floor(at.getTime() / (4 * MIN)),
    input.mood,
    input.time ?? '-',
    input.weather ?? '-',
    input.liveEnabled && l ? `${l.weatherCode}:${l.cloudCoverPct}:${l.precipitationMm}:${l.visibilityM}:${l.windSpeedMs}` : 'off',
  ].join('|');
}
