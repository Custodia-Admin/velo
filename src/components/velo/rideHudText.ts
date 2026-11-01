/**
 * Plain-words copy for the v2 ride HUD (docs/design/mockups/v2-ride-hud.html):
 * the route panel's "6.7 km to go · about 20 min" line, the next-landmark
 * line, and the status chip ("KICKR CORE · hills 35 %"). Pure, so the HUD
 * components stay thin and the wording is pinned by tests.
 */

import type { ConnectionState, RideMode } from '@/types';
import { ridesOnDemoPower } from '@/lib/rideDrive';

export type Units = 'metric' | 'imperial';

const M_PER_MI = 1609.344;

/** "6.7 km" / "650 m" (metric), "4.2 mi" / "0.3 mi" (imperial). */
export function formatLeft(meters: number, units: Units): string {
  const m = Math.max(0, meters);
  if (units === 'imperial') return `${(m / M_PER_MI).toFixed(1)} mi`;
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/** "about 20 min" / "about 1 h 10 min" (UI-RULES §6: durations as "about 30 min"). */
export function aboutMinutes(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `about ${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `about ${h} h` : `about ${h} h ${rest} min`;
}

/** Below this much riding the average speed is too noisy to project from. */
export const MIN_ELAPSED_S = 60;
export const MIN_RIDDEN_M = 200;

export interface RemainingInput {
  distanceM: number;
  totalM: number;
  elapsedS: number;
  /** The route's own easy-pace estimate (scenic routes), if any. */
  estMinutes?: number | null;
  units: Units;
}

/**
 * Minutes left: from the rider's own average speed once there is enough of
 * the ride to trust it, else the route's estimate pro rata, else unknown.
 */
export function remainingMinutes({ distanceM, totalM, elapsedS, estMinutes }: RemainingInput): number | null {
  const left = Math.max(0, totalM - distanceM);
  if (elapsedS >= MIN_ELAPSED_S && distanceM >= MIN_RIDDEN_M) {
    const avg = distanceM / elapsedS;
    if (avg > 0.5) return left / avg / 60;
  }
  if (estMinutes && estMinutes > 0 && totalM > 0) return (estMinutes * left) / totalM;
  return null;
}

/** "6.7 km to go · about 20 min"; null for routes with no fixed length (live GPS). */
export function remainingText(input: RemainingInput): string | null {
  const { distanceM, totalM, units } = input;
  if (!(totalM > 0)) return null;
  const left = totalM - distanceM;
  if (left <= 5) return 'At the finish';
  const mins = remainingMinutes(input);
  const base = `${formatLeft(left, units)} to go`;
  return mins === null ? base : `${base} · ${aboutMinutes(mins)}`;
}

export interface Landmark {
  name: string;
  startDistance: number;
  endDistance: number;
}

/**
 * The next named thing on the road, from real route data only (detected
 * climbs). Inside a climb: how far to its top. Null when nothing is ahead.
 */
export function nextLandmarkText(landmarks: readonly Landmark[], distanceM: number, units: Units): string | null {
  for (const l of landmarks) {
    if (distanceM < l.startDistance) return `${l.name} in ${formatLeft(l.startDistance - distanceM, units)}`;
    if (distanceM < l.endDistance) return `${l.name} · ${formatLeft(l.endDistance - distanceM, units)} to the top`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Status chip
// ---------------------------------------------------------------------------

/** ok = trainer connected; demo/outdoor = calm; warn = something is wrong. */
export type ChipTone = 'ok' | 'calm' | 'warn';

export interface ChipView {
  label: string;
  /** Full sentence for screen readers. */
  aria: string;
  tone: ChipTone;
  /** The dot pulses (reconnecting, lost, connecting). */
  pulse: boolean;
  /** Something needs the rider's attention: phones show the chip only then. */
  alert: boolean;
}

export interface ChipInput {
  connection: ConnectionState;
  mode: RideMode;
  deviceName: string | null;
  /** settings.trainerDifficulty, 0..1. */
  difficulty: number;
  erg: boolean;
  targetPowerW: number | null;
  battery: number | null;
  reconnectAttempt: number;
  reconnectMaxAttempts: number;
  replay: boolean;
}

export const LOW_BATTERY = 20;

export function statusChip(i: ChipInput): ChipView {
  if (i.replay) {
    return { label: 'Replay', aria: 'Replaying a recorded ride', tone: 'calm', pulse: false, alert: false };
  }
  if (i.mode === 'outdoor') {
    return { label: 'Outdoor · GPS', aria: 'Outdoor ride on phone GPS', tone: 'calm', pulse: false, alert: false };
  }
  const name = i.deviceName?.trim() || 'Trainer';
  switch (i.connection) {
    case 'connected': {
      const hills = Math.round(i.difficulty * 100);
      const feel = i.erg
        ? i.targetPowerW !== null ? `ERG ${i.targetPowerW} W` : 'ERG'
        : `hills ${hills} %`;
      const lowBattery = i.battery !== null && i.battery <= LOW_BATTERY;
      const label = lowBattery ? `${name} · ${feel} · battery ${i.battery} %` : `${name} · ${feel}`;
      const aria = i.erg
        ? `Trainer connected: ${name}, ERG mode${i.targetPowerW !== null ? ` at ${i.targetPowerW} watts` : ''}`
        : `Trainer connected: ${name}, hills feel ${hills} percent`;
      return {
        label,
        aria: lowBattery ? `${aria}, battery low at ${i.battery} percent` : aria,
        tone: lowBattery ? 'warn' : 'ok',
        pulse: false,
        alert: lowBattery,
      };
    }
    case 'reconnecting': {
      const of = i.reconnectMaxAttempts > 0 ? ` ${i.reconnectAttempt} of ${i.reconnectMaxAttempts}` : '';
      return {
        label: `${name} lost · reconnecting${of}`,
        aria: `Trainer connection lost, reconnecting${of ? `, attempt${of}` : ''}. The ride keeps going on your last power.`,
        tone: 'warn',
        pulse: true,
        alert: true,
      };
    }
    case 'connecting':
      return { label: `Connecting to ${name}…`, aria: `Connecting to ${name}`, tone: 'calm', pulse: true, alert: true };
    case 'error':
      if (i.mode === 'trainer') {
        return {
          label: 'Trainer lost · demo power',
          aria: 'Trainer connection failed. The ride continues on simulated power.',
          tone: 'warn',
          pulse: true,
          alert: true,
        };
      }
      break;
    default:
      break;
  }
  if (ridesOnDemoPower(i.mode, i.connection)) {
    return {
      label: 'Demo ride · no trainer',
      aria: 'Demo ride: no trainer paired, the rider moves on simulated power',
      tone: 'calm',
      pulse: false,
      alert: false,
    };
  }
  return { label: 'No trainer', aria: 'No trainer paired', tone: 'calm', pulse: false, alert: false };
}
