/**
 * What the rider sees about the handlebar controls, as pure data: one phase
 * per moment of the connection, and the in-ride chip's label, tone and
 * action for it. Shared by ControllerPanel (Home → Trainer) and
 * ControllerChip (ride view) so both always tell the same story. No React,
 * so it is unit-tested in node.
 */

import type { BuzzResult, ControllerSideCheck, ControllerStatus } from '@/stores/controllerStore';
import { LOW_BATTERY_PCT, formatBattery } from '@/lib/controllers/battery';

export type ControllerPhase =
  | 'none' // nothing paired this session
  | 'pairing'
  | 'waiting' // connected, no press seen yet, still within the silent window
  | 'live' // presses arrive
  | 'rightSide' // the right unit is paired and no press has come through it
  | 'silent' // connected, but not one message since the handshake
  | 'reconnecting'
  | 'asleep'
  | 'locked'
  | 'error';

export interface ControllerViewState {
  status: ControllerStatus;
  silent: boolean;
  side: ControllerSideCheck | null;
  inputSeen: boolean;
}

export function controllerPhase(s: ControllerViewState): ControllerPhase {
  switch (s.status) {
    case 'idle':
      return 'none';
    case 'connecting':
      return 'pairing';
    case 'reconnecting':
      return 'reconnecting';
    case 'asleep':
      return 'asleep';
    case 'locked':
      return 'locked';
    case 'error':
      return 'error';
    case 'connected':
      // A press that made it through beats every guess about why it might not.
      if (s.inputSeen) return 'live';
      if (s.side === 'right') return 'rightSide';
      if (s.silent) return 'silent';
      return 'waiting';
  }
}

// ---- copy -----------------------------------------------------------------

export const RIGHT_SIDE_TEXT = 'Right controller paired — buttons need the left one.';
export const PAIR_OTHER_LABEL = 'Pair the other controller';

/** The documented daily unlock (docs/devices/zwift-ride-v2.md), shortest form. */
export const UNLOCK_STEPS: readonly string[] = [
  "Open the controls' own app and pair them.",
  'Keep them connected 30 s.',
  'Press one button.',
  'Quit that app fully.',
  'Tap Reconnect here.',
];
/** The same recipe on one line, for the in-ride chip (fits a phone HUD). */
export const UNLOCK_ONE_LINE =
  "Unlock (lasts 24 h): pair them in their own app → 30 s → press one button → quit that app fully → Reconnect.";
export const UNLOCK_INTRO = 'No signal from the controls: they are probably locked. Unlock lasts 24 h.';
export const LOCKED_INTRO = 'The controls are locked. Unlock lasts 24 h.';
/** Extra line when we could not tell which side is paired. */
export const MAYBE_RIGHT_TEXT = 'Two entries with the same name? Only the left one sends presses: pair the other.';

/** Asleep controls wake on a button press; during a ride they reconnect on their own. */
export const ASLEEP_NOTE = 'Press a button on the bars to wake them.';
export const ASLEEP_TEXT =
  'The controls went to sleep. Press any button on the bars: during a ride they reconnect by themselves, or tap Reconnect.';

export type ChipTone = 'ok' | 'busy' | 'warn' | 'off';
export type ChipAction = 'pair' | 'pairOther' | 'reconnect' | null;

export interface ChipView {
  /** Short status, e.g. "Controls · 85 %", "Right side", "Locked". */
  label: string;
  tone: ChipTone;
  /** Show the GEAR / HILLS figures. */
  figures: boolean;
  /** One action the rider can take from the ride view. */
  action: ChipAction;
  actionLabel: string | null;
  /** Show the unlock recipe. */
  unlock: boolean;
  /** One short sentence under the label, or null. */
  note: string | null;
}

const ACTION_LABEL: Record<Exclude<ChipAction, null>, string> = {
  pair: 'Pair controls',
  pairOther: PAIR_OTHER_LABEL,
  reconnect: 'Reconnect',
};

function withBattery(label: string, battery: number | null): string {
  return battery === null ? label : `${label} · ${formatBattery(battery)}`;
}

export function chipView(phase: ControllerPhase, battery: number | null): ChipView {
  const v = (
    label: string,
    tone: ChipTone,
    figures: boolean,
    action: ChipAction = null,
    extra: Partial<Pick<ChipView, 'unlock' | 'note'>> = {},
  ): ChipView => ({
    label,
    tone,
    figures,
    action,
    actionLabel: action ? ACTION_LABEL[action] : null,
    unlock: extra.unlock ?? false,
    note: extra.note ?? null,
  });
  switch (phase) {
    case 'none':
      return v('No controls', 'off', false, 'pair');
    case 'error':
      return v('No controls', 'warn', false, 'pair');
    case 'pairing':
      return v('Pairing controls…', 'busy', false);
    case 'waiting':
      return v(withBattery('Controls on', battery), 'busy', true, null, { note: 'Press a paddle to check.' });
    case 'live':
      return v(withBattery('Controls', battery), 'ok', true, null, {
        note: battery !== null && battery <= LOW_BATTERY_PCT ? 'Battery low: charge after this ride.' : null,
      });
    case 'rightSide':
      // No gear figures while presses cannot arrive: a frozen gear only confuses.
      return v(withBattery('Right side', battery), 'warn', false, 'pairOther', { note: RIGHT_SIDE_TEXT });
    case 'silent':
      return v(withBattery('Locked', battery), 'warn', false, 'reconnect', { unlock: true });
    case 'locked':
      return v('Locked', 'warn', false, 'reconnect', { unlock: true });
    case 'reconnecting':
      return v('Reconnecting controls…', 'busy', true);
    case 'asleep':
      return v('Asleep', 'warn', false, 'reconnect', { note: ASLEEP_NOTE });
  }
}

/**
 * Status line in the Trainer panel, e.g. "Left controller · connected · buzzed".
 * The battery follows it as its own reading (BatteryReading).
 */
export function panelStatusLine(
  phase: ControllerPhase,
  side: ControllerSideCheck | null,
  buzz: BuzzResult | null,
): string {
  const base: Record<ControllerPhase, string> = {
    none: 'Not paired',
    pairing: 'Pairing…',
    waiting: 'Connected',
    live: 'Connected',
    rightSide: 'Connected',
    silent: 'Connected, no signal',
    reconnecting: 'Reconnecting…',
    asleep: 'Asleep',
    locked: 'Locked',
    error: 'Not connected',
  };
  const connected = phase === 'waiting' || phase === 'live' || phase === 'rightSide' || phase === 'silent';
  const parts: string[] = [];
  if (connected && side === 'left') parts.push('Left controller');
  if (connected && side === 'right') parts.push('Right controller');
  parts.push(parts.length ? base[phase].toLowerCase() : base[phase]);
  if (connected && buzz === 'ok') parts.push('buzzed');
  return parts.join(' · ');
}
