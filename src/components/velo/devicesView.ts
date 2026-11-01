/**
 * What each row of the Devices page says, as pure data: name, state line,
 * help sentence and the one action, for the trainer, the handlebar controls
 * and the heart-rate strap. The row components only render this and wire
 * the action ids to the existing lib calls (lib/ftms, lib/trainerReconnect,
 * lib/controllers/rideController, lib/bleSensors). No React, so it is
 * unit-tested in node.
 */

import type { BluetoothSupportReport } from '@/lib/bluetoothSupport';
import type { ReconnectPhase } from '@/lib/trainerReconnect';
import type { SensorConnectionStatus } from '@/lib/bleSensors';
import type { BuzzResult, ControllerSideCheck, ControllerStatus } from '@/stores/controllerStore';
import type { ConnectionState } from '@/types';
import {
  LOCKED_INTRO,
  MAYBE_RIGHT_TEXT,
  PAIR_OTHER_LABEL,
  RIGHT_SIDE_TEXT,
  UNLOCK_INTRO,
  controllerPhase,
  panelStatusLine,
  type ControllerPhase,
} from '@/lib/controllers/controllerView';

/** ok: connected (primary dot); busy: in flight (pulsing dot); warn: linked but not working; error: failed; idle: nothing yet. */
export type RowTone = 'ok' | 'busy' | 'warn' | 'error' | 'idle';

export interface RowAction<A extends string> {
  id: A;
  label: string;
  /** Spinner + disabled (an attempt is in flight). */
  busy?: boolean;
  disabled?: boolean;
  /** Accessible name when the visible label is short. */
  ariaLabel?: string;
}

export interface RowView<A extends string> {
  name: string;
  tone: RowTone;
  /** State line. With tone 'error' it renders bold, destructive, with an alert icon. */
  state: string;
  /** One plain sentence under the state, or null. */
  help: string | null;
  /** The row's one action (right column; under the text below sm). */
  action: RowAction<A> | null;
  /** Lesser actions as text links under the text. */
  extras: RowAction<A>[];
}

export const COULDNT_FIND = "Couldn't find it";

// ---- Trainer -----------------------------------------------------------------

export type TrainerActionId = 'pair' | 'pairAll' | 'reconnect' | 'disconnect' | 'guide';

export interface TrainerRowInput {
  connection: ConnectionState;
  deviceName: string | null;
  error: string | null;
  errorCode: string | null;
  report: Pick<BluetoothSupportReport, 'apiPresent' | 'secureContext' | 'usable' | 'reason'>;
  reconnectPhase: ReconnectPhase;
  reconnectName: string | null;
  controlMode: 'sim' | 'erg';
  targetPowerW: number | null;
}

/** Chooser closed or came up empty: worth a retry, or a look at every device. */
export function isEmptyChooserError(code: string | null): boolean {
  return code === 'no-device-selected' || code === 'no-device-found';
}

/** Headline for a failed trainer connection (same wording as TrainerConnect). */
export function trainerErrorTitle(code: string | null): string {
  switch (code) {
    case 'unsupported':              return "Browser doesn't support Web Bluetooth";
    case 'insecure-context':         return 'Bluetooth blocked: not a secure context';
    case 'permission-denied':        return 'Bluetooth permission was denied';
    case 'no-device-selected':
    case 'no-device-found':          return COULDNT_FIND;
    case 'gatt-connect-failed':      return "Couldn't open a GATT connection";
    case 'service-not-found':        return 'FTMS service unavailable on this trainer';
    case 'control-point-failed':     return 'Trainer refused the control handshake';
    case 'already-paired-elsewhere': return 'Trainer is paired with another app';
    case 'reconnect-failed':         return "Couldn't auto-reconnect to the trainer";
    default:                         return 'Bluetooth connection error';
  }
}

export type TroubleshootStep = 'browser' | 'https' | 'permission' | 'empty' | 'wake' | 'others' | 'chooser';

/** Which troubleshooter step opens for a support report (TrainerConnect's mapping). */
export function stepForReport(reasonCode: BluetoothSupportReport['reasonCode']): TroubleshootStep {
  switch (reasonCode) {
    case 'ios-unsupported':
    case 'safari-unsupported':
    case 'firefox-unsupported':
    case 'linux-flag-off':
    case 'api-missing':      return 'browser';
    case 'insecure-context': return 'https';
    default:                 return 'wake';
  }
}

/** Which troubleshooter step opens for a connect error (TrainerConnect's mapping). */
export function stepForErrorCode(code: string | null): TroubleshootStep {
  switch (code) {
    case 'unsupported':              return 'browser';
    case 'insecure-context':         return 'https';
    case 'permission-denied':        return 'permission';
    case 'no-device-selected':
    case 'no-device-found':          return 'empty';
    case 'gatt-connect-failed':      return 'wake';
    case 'service-not-found':
    case 'control-point-failed':
    case 'already-paired-elsewhere': return 'others';
    default:                         return 'chooser';
  }
}

export const TRAINER_NO_BLUETOOTH_HELP = 'You can still ride with the demo rider.';
export const TRAINER_EMPTY_HELP =
  'Pedal once to wake it, then try again. Or show every device and pick the name starting with KICKR.';

export function trainerRow(s: TrainerRowInput): RowView<TrainerActionId> {
  const guide = (label: string): RowAction<TrainerActionId> => ({ id: 'guide', label });
  // The browser can't pair at all: a plain sentence, no pairing button.
  if (!s.report.apiPresent || !s.report.secureContext) {
    return {
      name: 'Trainer',
      tone: 'idle',
      state: s.report.reason ?? "This browser can't use Bluetooth.",
      help: TRAINER_NO_BLUETOOTH_HELP,
      action: null,
      extras: [guide('Why not?')],
    };
  }
  switch (s.connection) {
    case 'connected': {
      const state =
        s.controlMode === 'erg'
          ? s.targetPowerW !== null
            ? `Connected · ERG holds ${s.targetPowerW} W`
            : 'Connected · ERG, waiting for a target'
          : 'Connected · the road sets the resistance';
      return {
        name: `Trainer · ${s.deviceName ?? 'smart trainer'}`,
        tone: 'ok',
        state,
        help: null,
        action: { id: 'disconnect', label: 'Disconnect', ariaLabel: 'Disconnect trainer' },
        extras: [],
      };
    }
    case 'connecting':
    case 'reconnecting': {
      const label = s.connection === 'connecting' ? 'Connecting…' : 'Reconnecting…';
      return {
        name: s.deviceName ? `Trainer · ${s.deviceName}` : 'Trainer',
        tone: 'busy',
        state: label,
        help: null,
        action: { id: 'pair', label, busy: true, ariaLabel: `${label.slice(0, -1)} to trainer…` },
        extras: [],
      };
    }
    case 'error': {
      const empty = isEmptyChooserError(s.errorCode);
      return {
        name: 'Trainer',
        tone: 'error',
        state: trainerErrorTitle(s.errorCode),
        help: empty ? TRAINER_EMPTY_HELP : s.error,
        action: { id: 'pair', label: 'Try again', ariaLabel: 'Try pairing the trainer again' },
        extras: [
          ...(empty ? [{ id: 'pairAll' as const, label: 'Show all devices' }] : []),
          guide('Show me how to fix this'),
        ],
      };
    }
    default: {
      const offerReconnect = s.reconnectPhase === 'available' || s.reconnectPhase === 'failed';
      if (offerReconnect) {
        const failed = s.reconnectPhase === 'failed';
        return {
          name: `Trainer · ${s.reconnectName ?? 'smart trainer'}`,
          tone: 'idle',
          state: failed ? 'Not connected' : 'Paired before · not connected',
          help: failed ? 'Could not reach it. Pedal once to wake it, then tap Pair trainer.' : s.report.usable ? null : s.report.reason,
          action: { id: 'reconnect', label: 'Reconnect', ariaLabel: `Reconnect ${s.reconnectName ?? 'trainer'}` },
          extras: [{ id: 'pair', label: 'Pair trainer' }],
        };
      }
      return {
        name: 'Trainer',
        tone: 'idle',
        state: 'Not paired',
        // A stale "Bluetooth off" reading never blocks an attempt; it only explains.
        help: s.report.usable ? 'Smart trainers that speak FTMS, like a KICKR, set the resistance from the road.' : s.report.reason,
        action: { id: 'pair', label: 'Pair', ariaLabel: 'Pair smart trainer via Bluetooth' },
        extras: [guide('How do I pair a KICKR?')],
      };
    }
  }
}

// ---- Handlebar controls ------------------------------------------------------

export type HandlebarActionId = 'pair' | 'pairAll' | 'pairOther' | 'reconnect' | 'buzz' | 'disconnect' | 'forget';

export interface HandlebarRowInput {
  status: ControllerStatus;
  silent: boolean;
  side: ControllerSideCheck | null;
  inputSeen: boolean;
  buzz: BuzzResult | null;
  deviceName: string | null;
  errorMessage: string | null;
  /** A pairing attempt from this page didn't connect (chooser empty or closed). */
  tried: boolean;
}

export interface HandlebarRowView extends RowView<HandlebarActionId> {
  phase: ControllerPhase;
  /** Intro for the unlock recipe, or null when the recipe isn't needed. */
  unlockIntro: string | null;
  /** Live link: show the steering switch and "What the buttons do". */
  settings: boolean;
  /** Show the battery reading when the store has one. */
  showBattery: boolean;
}

export const ASLEEP_TEXT = 'The controls went to sleep. Press any button on the bars, then reconnect.';
export const WAITING_TEXT = 'Press a shift paddle: the gear in the ride view should change.';
export const HANDLEBAR_IDLE_HELP = 'Shift gears, set how hard the hills feel and steer from the bars.';

/** "Left handlebar · Zwift Ride" when the side is known, else "Handlebar controls". */
export function handlebarName(side: ControllerSideCheck | null, deviceName: string | null): string {
  const dev = deviceName ?? 'Zwift Ride';
  if (side === 'left') return `Left handlebar · ${dev}`;
  if (side === 'right') return `Right handlebar · ${dev}`;
  return 'Handlebar controls';
}

export function handlebarRow(s: HandlebarRowInput): HandlebarRowView {
  const phase = controllerPhase(s);
  const linked = s.status === 'connected' || s.status === 'reconnecting' || s.status === 'locked' || s.status === 'asleep';
  const base = {
    phase,
    name: linked ? handlebarName(s.side, s.deviceName) : 'Handlebar controls',
    unlockIntro: null as string | null,
    settings: s.status === 'connected' || s.status === 'reconnecting',
    showBattery: linked,
    help: null as string | null,
    extras: [] as RowAction<HandlebarActionId>[],
  };
  const disconnect: RowAction<HandlebarActionId> = { id: 'disconnect', label: 'Disconnect' };
  const forget: RowAction<HandlebarActionId> = { id: 'forget', label: 'Forget' };
  const pairOther: RowAction<HandlebarActionId> = { id: 'pairOther', label: PAIR_OTHER_LABEL };
  const buzz: RowAction<HandlebarActionId> = { id: 'buzz', label: 'Test buzz', disabled: s.status !== 'connected' };
  const status = (p: ControllerPhase) => panelStatusLine(p, null, s.buzz, null);

  switch (phase) {
    case 'none':
      return {
        ...base,
        tone: 'idle',
        state: 'Optional · not paired',
        help: HANDLEBAR_IDLE_HELP,
        action: s.tried
          ? { id: 'pair', label: 'Try again', ariaLabel: 'Try pairing the handlebar controls again' }
          : { id: 'pair', label: 'Pair', ariaLabel: 'Pair handlebar controls' },
        extras: s.tried ? [{ id: 'pairAll', label: 'Show all devices' }] : [],
      };
    case 'error':
      return {
        ...base,
        tone: 'error',
        state: "Couldn't connect",
        help: s.errorMessage,
        action: { id: 'pair', label: 'Try again', ariaLabel: 'Try pairing the handlebar controls again' },
        extras: s.tried ? [{ id: 'pairAll', label: 'Show all devices' }] : [],
      };
    case 'pairing':
      return { ...base, tone: 'busy', state: 'Pairing…', action: { id: 'pair', label: 'Pairing…', busy: true } };
    case 'waiting':
      return { ...base, tone: 'busy', state: status(phase), help: WAITING_TEXT, action: buzz, extras: [disconnect] };
    case 'live':
      return {
        ...base,
        tone: 'ok',
        state: 'Connected · gears and buttons',
        action: buzz,
        extras: [disconnect],
      };
    case 'reconnecting':
      return { ...base, tone: 'busy', state: status(phase), action: buzz, extras: [disconnect] };
    case 'rightSide':
      return { ...base, tone: 'warn', state: status(phase), help: RIGHT_SIDE_TEXT, action: pairOther, extras: [disconnect] };
    case 'silent':
      return {
        ...base,
        tone: 'warn',
        state: status(phase),
        unlockIntro: UNLOCK_INTRO,
        help: s.side !== 'left' ? MAYBE_RIGHT_TEXT : null,
        action: { id: 'reconnect', label: 'Reconnect' },
        extras: s.side !== 'left' ? [pairOther, disconnect] : [disconnect],
      };
    case 'locked':
      return {
        ...base,
        tone: 'error',
        state: 'Locked',
        unlockIntro: LOCKED_INTRO,
        action: { id: 'reconnect', label: 'Try again', ariaLabel: 'Try the handlebar controls again' },
        extras: [forget],
      };
    case 'asleep':
      return {
        ...base,
        tone: 'error',
        state: 'Asleep',
        help: ASLEEP_TEXT,
        action: { id: 'reconnect', label: 'Reconnect' },
        extras: [forget],
      };
  }
}

// ---- Heart rate --------------------------------------------------------------

export type HeartRateActionId = 'pair' | 'disconnect';

export interface HeartRateRowInput {
  status: SensorConnectionStatus;
  deviceName: string | null;
  bpm: number | null;
  error: string | null;
  errorCode: string | null;
}

export const HR_EMPTY_HELP = 'Put the strap on (it wakes on skin contact), then try again.';

export function heartRateRow(s: HeartRateRowInput): RowView<HeartRateActionId> {
  switch (s.status) {
    case 'connected':
      return {
        name: s.deviceName ? `Heart rate · ${s.deviceName}` : 'Heart rate',
        tone: 'ok',
        state: s.bpm !== null ? `Connected · ${Math.round(s.bpm)} bpm` : 'Connected',
        help: null,
        action: { id: 'disconnect', label: 'Disconnect', ariaLabel: 'Disconnect heart rate monitor' },
        extras: [],
      };
    case 'connecting':
    case 'reconnecting': {
      const label = s.status === 'connecting' ? 'Connecting…' : 'Reconnecting…';
      return { name: 'Heart rate', tone: 'busy', state: label, help: null, action: { id: 'pair', label, busy: true }, extras: [] };
    }
    case 'error': {
      const empty = isEmptyChooserError(s.errorCode);
      return {
        name: 'Heart rate',
        tone: 'error',
        state: empty ? COULDNT_FIND : "Couldn't connect",
        help: empty ? HR_EMPTY_HELP : s.error,
        action: { id: 'pair', label: 'Try again', ariaLabel: 'Try pairing the heart rate monitor again' },
        extras: [],
      };
    }
    default:
      return {
        name: 'Heart rate',
        tone: 'idle',
        state: 'Optional · not paired',
        help: null,
        action: { id: 'pair', label: 'Pair', ariaLabel: 'Pair heart rate monitor via Bluetooth' },
        extras: [],
      };
  }
}

// ---- Ride line ---------------------------------------------------------------

/**
 * "Tiber river park · 10.9 km · about 35 min." plus, only when it is true,
 * that the handlebar controls can still be paired from the ride view.
 */
export function rideLine(opts: {
  name: string;
  distanceM: number;
  minutes: number;
  units: 'metric' | 'imperial';
  handlebarsCanJoin: boolean;
}): string {
  const dist =
    opts.units === 'imperial'
      ? `${(opts.distanceM / 1609.344).toFixed(1)} mi`
      : `${(opts.distanceM / 1000).toFixed(1)} km`;
  const line = `${opts.name} · ${dist} · about ${opts.minutes} min.`;
  return opts.handlebarsCanJoin ? `${line} The handlebar controls can join later.` : line;
}
