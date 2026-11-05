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
 * The next landmark line in parts, so a narrow line can shorten or drop the
 * place and keep the distance whole (`NextLandmark`): "Rivotorto" + "in 900 m",
 * or inside a climb "Climb 1" + "300 m to the top". Each part reads on its own
 * ("300 m to the top" when there is no room for the climb's name), so the
 * separator belongs to the name: read as one line with `landmarkLine`.
 */
export interface NextLandmarkParts {
  name: string;
  distance: string;
  /** Riding the climb `name`: the line reads "Climb 1 · 300 m to the top". */
  inClimb: boolean;
}

/** What goes between the name and the distance: "Rivotorto in 900 m", "Climb 1 · 300 m to the top". */
export function landmarkJoiner(next: NextLandmarkParts): string {
  return next.inClimb ? ' · ' : ' ';
}

/** The whole line as one sentence. */
export function landmarkLine(next: NextLandmarkParts): string {
  return `${next.name}${landmarkJoiner(next)}${next.distance}`;
}

/**
 * The next named thing on the road, from real route data only (detected
 * climbs). Inside a climb: how far to its top. Null when nothing is ahead.
 */
export function nextLandmark(landmarks: readonly Landmark[], distanceM: number, units: Units): NextLandmarkParts | null {
  for (const l of landmarks) {
    if (distanceM < l.startDistance) return { name: l.name, distance: `in ${formatLeft(l.startDistance - distanceM, units)}`, inClimb: false };
    if (distanceM < l.endDistance) return { name: l.name, distance: `${formatLeft(l.endDistance - distanceM, units)} to the top`, inClimb: true };
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

/**
 * The model name a rider recognises, without the unit's 4-hex BLE suffix:
 * "KICKR CORE 78C1" -> "KICKR CORE" (status chip, Home device pill; the
 * Devices page and screen-reader labels keep the full name).
 */
export function shortDeviceName(name: string): string {
  const t = name.trim();
  const short = t.replace(/\s+[0-9A-F]{4}$/i, '');
  return short || t;
}

export function statusChip(i: ChipInput): ChipView {
  if (i.replay) {
    return { label: 'Replay', aria: 'Replaying a recorded ride', tone: 'calm', pulse: false, alert: false };
  }
  if (i.mode === 'outdoor') {
    return { label: 'Outdoor · GPS', aria: 'Outdoor ride on phone GPS', tone: 'calm', pulse: false, alert: false };
  }
  const name = i.deviceName?.trim() || 'Trainer';
  const shown = shortDeviceName(name);
  switch (i.connection) {
    case 'connected': {
      const hills = Math.round(i.difficulty * 100);
      const feel = i.erg
        ? i.targetPowerW !== null ? `ERG ${i.targetPowerW} W` : 'ERG'
        : `hills ${hills} %`;
      const lowBattery = i.battery !== null && i.battery <= LOW_BATTERY;
      const label = lowBattery ? `${shown} · ${feel} · battery ${i.battery} %` : `${shown} · ${feel}`;
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
        label: `${shown} lost · reconnecting${of}`,
        aria: `Trainer connection lost, reconnecting${of ? `, attempt${of}` : ''}. The ride keeps going on your last power.`,
        tone: 'warn',
        pulse: true,
        alert: true,
      };
    }
    case 'connecting':
      return { label: `Connecting to ${shown}…`, aria: `Connecting to ${name}`, tone: 'calm', pulse: true, alert: true };
    case 'error':
      // A pairing attempt failed (chooser closed, GATT refused): the trainer
      // never connected, so it was not "lost". A mid-ride drop ends as
      // 'disconnected' + errorCode 'reconnect-failed' (rideChip).
      return {
        label: 'Trainer not connected · tap for devices',
        aria: 'Trainer not connected: pairing failed. The ride continues on simulated power. Tap for devices.',
        tone: 'warn',
        pulse: false,
        alert: true,
      };
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

// ---------------------------------------------------------------------------
// The one in-ride status chip (compact ride HUD, owner-directed revision
// 2 Nov 2026): trainer, handlebar controls, heart-rate strap and passing
// notices all speak through this chip, worst problem first. Details live on
// the devices sheet the chip opens; there is never a separate red box.
// ---------------------------------------------------------------------------

/** Handlebar controls phase (lib/controllers/controllerView ControllerPhase). */
export type ControlsPhase =
  | 'none'
  | 'pairing'
  | 'waiting'
  | 'live'
  | 'rightSide'
  | 'silent'
  | 'reconnecting'
  | 'asleep'
  | 'locked'
  | 'error';

export type SensorStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

/** A passing message (a toast) the chip shows for a few seconds. */
export interface ChipNotice {
  title: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  /** The toast's own action, run when the chip is tapped. */
  actionLabel?: string;
}

/** What tapping the chip does. */
export type RideChipAction = 'reconnectTrainer' | 'reloadWorld' | 'notice' | 'devices';

export interface RideChipView extends ChipView {
  action: RideChipAction;
}

export interface RideChipInput extends ChipInput {
  /** A trainer granted in an earlier session can come back with one tap. */
  trainerReconnectable: boolean;
  /** rideStore.errorCode ('reconnect-failed' after a mid-ride drop). */
  errorCode: string | null;
  controls: ControlsPhase;
  heartRate: SensorStatus;
  notice: ChipNotice | null;
  /** The 3D view lost its WebGL context and is frozen (stores/worldViewStore). */
  worldStopped: boolean;
}

/**
 * The 3D view stopped (WebGL context lost): one tap remounts it. The ride
 * itself never stopped. Short like "Trainer lost · tap to reconnect": the
 * card's longer "The 3D view stopped · tap to reload the view" took the
 * phone HUD past its 15 % budget (15.1 %) and would not fit the floating
 * window's corner size; the screen-reader sentence says it in full.
 */
export const WORLD_STOPPED_LABEL = '3D view stopped · tap to reload';

const CONTROLS_ALERT: Partial<Record<ControlsPhase, string>> = {
  rightSide: 'Controls: right unit paired',
  silent: 'Controls locked',
  locked: 'Controls locked',
  asleep: 'Controls asleep',
  error: 'Controls lost',
};

/**
 * The chip, worst problem first: a lost or failing trainer (lost,
 * reconnecting, connecting, a failed pairing), then a frozen 3D view (WebGL
 * context lost), then a low trainer battery, then handlebar
 * controls that cannot deliver presses, then a dropped heart-rate strap,
 * then a passing notice (a toast, a few seconds), else the calm status
 * ("KICKR CORE · hills 35 %", "Demo ride · no trainer").
 *
 * A trainer lost mid-ride (the automatic retries gave up: 'disconnected' +
 * errorCode 'reconnect-failed') is always an alert, on every viewport, until
 * it is back or paired again. One tap reconnects it only when the browser
 * still holds a grant the app can use (`trainerReconnectable`); otherwise
 * the chip says so and opens the devices sheet.
 */
export function rideChip(i: RideChipInput): RideChipView {
  const indoor = !i.replay && i.mode !== 'outdoor';
  const offline = i.connection === 'disconnected' || i.connection === 'error';
  const lost = i.connection === 'disconnected' && i.errorCode === 'reconnect-failed';
  if (indoor && offline && i.trainerReconnectable) {
    return {
      label: `${lost ? 'Trainer lost' : 'Trainer off'} · tap to reconnect`,
      aria: `${lost ? 'Trainer connection lost' : 'Trainer not connected'}. Tap to reconnect it.`,
      tone: 'warn',
      pulse: false,
      alert: true,
      action: 'reconnectTrainer',
    };
  }
  if (indoor && lost) {
    return {
      label: 'Trainer lost · tap for devices',
      aria: 'Trainer connection lost after several reconnect attempts. The ride continues on simulated power. Tap for devices.',
      tone: 'warn',
      pulse: false,
      alert: true,
      action: 'devices',
    };
  }

  const base = statusChip(i);
  // A low battery is the one trainer alert while the trainer still works
  // (statusChip: connected, battery <= LOW_BATTERY). Reconnecting,
  // connecting and a failed pairing come first; the battery waits below.
  const lowBattery = base.alert && i.connection === 'connected';
  if (base.alert && !lowBattery) return { ...base, action: 'devices' };

  // The world froze (GPU reset, driver update, the browser's context cap)
  // while the ride, the HUD and the recording carry on. Second only to a
  // trainer that is lost or not connected: the rider sees it at once and
  // the fix is one tap. A low trainer battery waits, or its note would hold
  // the chip for the whole ride and nothing would reload the view.
  if (i.worldStopped) {
    return {
      label: WORLD_STOPPED_LABEL,
      aria: 'The 3D view stopped. Tap to reload the view. Your ride keeps going and recording.',
      tone: 'warn',
      pulse: false,
      alert: true,
      action: 'reloadWorld',
    };
  }

  // The low trainer battery note ("KICKR CORE · hills 35 % · battery 15 %").
  if (lowBattery) return { ...base, action: 'devices' };

  const controls = CONTROLS_ALERT[i.controls];
  if (controls) {
    return {
      label: controls,
      aria: `${controls}. Tap for devices.`,
      tone: 'warn',
      pulse: false,
      alert: true,
      action: 'devices',
    };
  }

  if (i.heartRate === 'reconnecting' || i.heartRate === 'error') {
    const reconnecting = i.heartRate === 'reconnecting';
    return {
      label: reconnecting ? 'Heart rate lost · reconnecting' : 'Heart rate lost',
      aria: `Heart-rate strap lost${reconnecting ? ', reconnecting' : ''}. Tap for devices.`,
      tone: 'warn',
      pulse: reconnecting,
      alert: true,
      action: 'devices',
    };
  }

  if (i.notice) {
    const warn = i.notice.kind === 'warning' || i.notice.kind === 'error';
    return {
      label: i.notice.actionLabel ? `${i.notice.title} · ${i.notice.actionLabel}` : i.notice.title,
      aria: i.notice.title,
      tone: warn ? 'warn' : i.notice.kind === 'success' ? 'ok' : 'calm',
      pulse: false,
      alert: true,
      action: i.notice.actionLabel ? 'notice' : 'devices',
    };
  }

  return { ...base, aria: `${base.aria}. Tap for devices.`, action: 'devices' };
}

/** The notice the chip is showing, as far as a tap needs it. */
export interface TappableNotice {
  id: string;
  /** The toast's own action (its button's onClick). */
  run?: () => void;
}

/** What a chip tap can do to the app (RideChip passes the real ones). */
export interface ChipTapEffects {
  reconnectTrainer: () => void;
  /** Remount the world view's canvas on a fresh WebGL context. */
  reloadWorld: () => void;
  dismissNotice: (id: string) => void;
  toggleDevices: () => void;
}

/**
 * One tap on the chip: "Trainer lost · tap to reconnect" reconnects the
 * granted trainer; "The 3D view stopped · tap to reload the view" remounts
 * the world view; a notice with an action runs it and dismisses that
 * toast; anything else opens or closes the devices sheet. Returns what it did.
 */
export function chipTap(action: RideChipAction, notice: TappableNotice | null, fx: ChipTapEffects): RideChipAction {
  if (action === 'reconnectTrainer') {
    fx.reconnectTrainer();
    return 'reconnectTrainer';
  }
  if (action === 'reloadWorld') {
    fx.reloadWorld();
    return 'reloadWorld';
  }
  if (action === 'notice' && notice?.run) {
    notice.run();
    fx.dismissNotice(notice.id);
    return 'notice';
  }
  fx.toggleDevices();
  return 'devices';
}

/** How long a passing notice holds the chip: its own duration, at most 5 s. */
export const NOTICE_MAX_MS = 5_000;

export function noticeMs(durationMs: number | null): number {
  if (durationMs === null || !(durationMs > 0)) return NOTICE_MAX_MS;
  return Math.min(durationMs, NOTICE_MAX_MS);
}
