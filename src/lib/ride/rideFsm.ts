/**
 * The ride's state machine: the single authority on what a ride may do next.
 *
 * Three orthogonal dimensions:
 *   phase    idle → ready → riding ⇄ paused → finished
 *   source   what feeds the ride: trainer | demo | workout | replay | outdoor
 *   trainer  the FTMS link: disconnected | connecting | connected | lost
 *
 * Transitions live in tables (one per dimension). An event that has no cell
 * in the table for the current state is illegal: `transition()` throws in
 * development (so the bug surfaces at its source) and returns the state
 * unchanged in production (so a rider is never thrown out of a ride).
 *
 * The derived policies below (`driveOf`, `resistanceOf`, `autoPauseDue`,
 * `createResistanceGate`) are what the ride loop consumes, so "a paired
 * trainer at a standstill", "pause holds resistance" and "trainer lost
 * mid-ride" are each decided in exactly one place.
 *
 * Renderer-agnostic: no Cesium (or any renderer) import under src/lib/ride/.
 */

import type { ConnectionState, RideMode, RideState } from '@/types';

// ─── State ───────────────────────────────────────────────────────────────────

export type RidePhase = 'idle' | 'ready' | 'riding' | 'paused' | 'finished';
export type RideSource = 'trainer' | 'demo' | 'workout' | 'replay' | 'outdoor';
export type TrainerLink = 'disconnected' | 'connecting' | 'connected' | 'lost';

export interface RideFsmState {
  phase: RidePhase;
  source: RideSource;
  trainer: TrainerLink;
}

export const RIDE_PHASES: readonly RidePhase[] = ['idle', 'ready', 'riding', 'paused', 'finished'];
export const RIDE_SOURCES: readonly RideSource[] = ['trainer', 'demo', 'workout', 'replay', 'outdoor'];
export const TRAINER_LINKS: readonly TrainerLink[] = ['disconnected', 'connecting', 'connected', 'lost'];

export const INITIAL_RIDE_FSM: RideFsmState = { phase: 'idle', source: 'trainer', trainer: 'disconnected' };

// ─── Events ──────────────────────────────────────────────────────────────────

export type PhaseEvent =
  | { type: 'ROUTE_LOADED' }
  | { type: 'ROUTE_CLEARED' }
  | { type: 'START' }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'FINISH' }
  | { type: 'RESET'; hasRoute: boolean };

export type TrainerEvent =
  | { type: 'TRAINER_CONNECTING' }
  | { type: 'TRAINER_CONNECTED' }
  | { type: 'TRAINER_LOST' }
  | { type: 'TRAINER_DISCONNECTED' };

export type SourceEvent =
  | { type: 'SET_SOURCE'; source: RideSource }
  /** A recorded ride replaces the session: ready, source replay. */
  | { type: 'LOAD_REPLAY' }
  /** Leave replay for the live source; ready when a route remains. */
  | { type: 'CLEAR_REPLAY'; source: RideSource; hasRoute: boolean };

export type RideEvent = PhaseEvent | TrainerEvent | SourceEvent;
export type RideEventType = RideEvent['type'];

export const PHASE_EVENT_TYPES = [
  'ROUTE_LOADED', 'ROUTE_CLEARED', 'START', 'PAUSE', 'RESUME', 'FINISH', 'RESET',
] as const satisfies readonly PhaseEvent['type'][];
export const TRAINER_EVENT_TYPES = [
  'TRAINER_CONNECTING', 'TRAINER_CONNECTED', 'TRAINER_LOST', 'TRAINER_DISCONNECTED',
] as const satisfies readonly TrainerEvent['type'][];

// ─── Tables ──────────────────────────────────────────────────────────────────

type PhaseCell = RidePhase | ((e: PhaseEvent) => RidePhase);
const afterReset = (e: PhaseEvent): RidePhase =>
  e.type === 'RESET' && e.hasRoute ? 'ready' : 'idle';

/**
 * phase × event → next phase. A missing cell is an illegal transition.
 * Loading or clearing a route is always allowed: it abandons whatever ride
 * was in progress, exactly like the store's setRoute always has.
 */
export const PHASE_TABLE: Readonly<Record<RidePhase, Partial<Record<PhaseEvent['type'], PhaseCell>>>> = {
  idle:     { ROUTE_LOADED: 'ready', ROUTE_CLEARED: 'idle', RESET: afterReset, START: 'riding' },
  ready:    { ROUTE_LOADED: 'ready', ROUTE_CLEARED: 'idle', RESET: afterReset, START: 'riding' },
  riding:   { ROUTE_LOADED: 'ready', ROUTE_CLEARED: 'idle', RESET: afterReset, PAUSE: 'paused', FINISH: 'finished' },
  paused:   { ROUTE_LOADED: 'ready', ROUTE_CLEARED: 'idle', RESET: afterReset, RESUME: 'riding', FINISH: 'finished' },
  // FINISH is idempotent: the route end, the workout engine and the replay
  // loop can each report the finish in the same frame.
  finished: { ROUTE_LOADED: 'ready', ROUTE_CLEARED: 'idle', RESET: afterReset, FINISH: 'finished' },
};

/**
 * trainer link × event → next link. Trainer events are hardware facts, so
 * every pair is defined; the table documents where each one lands. A drop
 * (`TRAINER_LOST`) never ends the ride: the phase dimension is untouched.
 */
export const TRAINER_TABLE: Readonly<Record<TrainerLink, Record<TrainerEvent['type'], TrainerLink>>> = {
  disconnected: { TRAINER_CONNECTING: 'connecting', TRAINER_CONNECTED: 'connected', TRAINER_LOST: 'lost', TRAINER_DISCONNECTED: 'disconnected' },
  connecting:   { TRAINER_CONNECTING: 'connecting', TRAINER_CONNECTED: 'connected', TRAINER_LOST: 'lost', TRAINER_DISCONNECTED: 'disconnected' },
  connected:    { TRAINER_CONNECTING: 'connecting', TRAINER_CONNECTED: 'connected', TRAINER_LOST: 'lost', TRAINER_DISCONNECTED: 'disconnected' },
  lost:         { TRAINER_CONNECTING: 'connecting', TRAINER_CONNECTED: 'connected', TRAINER_LOST: 'lost', TRAINER_DISCONNECTED: 'disconnected' },
};

/** Sources a ride may switch between while it is in progress (riding/paused). */
const LIVE_SWAPPABLE: ReadonlySet<RideSource> = new Set(['trainer', 'demo', 'workout']);

/**
 * May `from` become `to` during `phase`? Replay is entered only via
 * LOAD_REPLAY. Mid-ride, only trainer/demo/workout swap (the Demo toggle,
 * the reconnect-failed fallback, the workout engine taking over); an
 * outdoor GPS ride or a replay can't turn into a trainer ride half way.
 */
export function sourceSwapAllowed(phase: RidePhase, from: RideSource, to: RideSource): boolean {
  if (to === 'replay') return false;
  if (phase !== 'riding' && phase !== 'paused') return true;
  return LIVE_SWAPPABLE.has(from) && LIVE_SWAPPABLE.has(to);
}

// ─── Transition ──────────────────────────────────────────────────────────────

export class IllegalRideTransition extends Error {
  constructor(readonly state: RideFsmState, readonly event: RideEvent) {
    super(`Illegal ride transition: ${event.type} in ${describeFsm(state)}`);
    this.name = 'IllegalRideTransition';
  }
}

export interface TransitionOptions {
  /** Throw on an illegal transition. Defaults to development builds only. */
  strict?: boolean;
}

/** Development builds (and vitest) throw on illegal transitions; production no-ops. */
function strictByDefault(): boolean {
  return import.meta.env?.DEV ?? false;
}

/** The next state, or null when the event is illegal in `s`. */
export function nextState(s: RideFsmState, e: RideEvent): RideFsmState | null {
  switch (e.type) {
    case 'TRAINER_CONNECTING':
    case 'TRAINER_CONNECTED':
    case 'TRAINER_LOST':
    case 'TRAINER_DISCONNECTED':
      return { ...s, trainer: TRAINER_TABLE[s.trainer][e.type] };
    case 'SET_SOURCE':
      if (!sourceSwapAllowed(s.phase, s.source, e.source)) return null;
      return { ...s, source: e.source };
    case 'LOAD_REPLAY':
      return { ...s, phase: 'ready', source: 'replay' };
    case 'CLEAR_REPLAY':
      if (s.source !== 'replay' || e.source === 'replay') return null;
      return { ...s, phase: e.hasRoute ? 'ready' : 'idle', source: e.source };
    default: {
      const cell = PHASE_TABLE[s.phase][e.type];
      if (cell === undefined) return null;
      return { ...s, phase: typeof cell === 'function' ? cell(e) : cell };
    }
  }
}

/** True when `e` is legal in `s`. */
export function can(s: RideFsmState, e: RideEvent): boolean {
  return nextState(s, e) !== null;
}

/**
 * Apply `e` to `s`. Illegal: throws `IllegalRideTransition` when strict
 * (development default), otherwise returns `s` unchanged (production).
 */
export function transition(s: RideFsmState, e: RideEvent, opts: TransitionOptions = {}): RideFsmState {
  const next = nextState(s, e);
  if (next) return next;
  if (opts.strict ?? strictByDefault()) throw new IllegalRideTransition(s, e);
  return s;
}

export function describeFsm(s: RideFsmState): string {
  return `${s.phase}/${s.source}/trainer:${s.trainer}`;
}

// ─── Mapping to the store's public strings (unchanged for HUD consumers) ────

const PHASE_TO_RIDE_STATE: Record<RidePhase, RideState> = {
  idle: 'idle', ready: 'ready', riding: 'running', paused: 'paused', finished: 'finished',
};
const RIDE_STATE_TO_PHASE: Record<RideState, RidePhase> = {
  idle: 'idle', ready: 'ready', running: 'riding', paused: 'paused', finished: 'finished',
};

/** FSM phase → the `rideState` string the HUD has always read ('riding' → 'running'). */
export function toRideState(phase: RidePhase): RideState {
  return PHASE_TO_RIDE_STATE[phase];
}

export function phaseOf(rideState: RideState): RidePhase {
  return RIDE_STATE_TO_PHASE[rideState];
}

/** The store's connection string → trainer link. 'reconnecting' is a lost link. */
export function trainerLinkOf(connection: ConnectionState): TrainerLink {
  switch (connection) {
    case 'connected':    return 'connected';
    case 'connecting':   return 'connecting';
    case 'reconnecting': return 'lost';
    case 'disconnected':
    case 'error':        return 'disconnected';
  }
}

/** The event a connection-string change represents. */
export function trainerEventFor(connection: ConnectionState): TrainerEvent {
  switch (trainerLinkOf(connection)) {
    case 'connected':  return { type: 'TRAINER_CONNECTED' };
    case 'connecting': return { type: 'TRAINER_CONNECTING' };
    case 'lost':       return { type: 'TRAINER_LOST' };
    default:           return { type: 'TRAINER_DISCONNECTED' };
  }
}

export interface SourceFields {
  mode: RideMode;
  rideMode: RideMode;
  replayData: unknown;
  workoutRunning: boolean;
}

/** The ride source the store's fields describe. Precedence: replay > outdoor > workout > demo > trainer. */
export function sourceOf(f: SourceFields): RideSource {
  if (f.replayData) return 'replay';
  if (f.rideMode === 'outdoor') return 'outdoor';
  if (f.workoutRunning) return 'workout';
  // `rideMode` is the indoor/outdoor axis; Demo Mode is `mode`.
  if (f.mode === 'demo') return 'demo';
  return 'trainer';
}

// ─── Policies the ride loop consumes ─────────────────────────────────────────

/**
 * What moves the rider this frame.
 *   trainer  the paired trainer's own speed and power, even at 0 km/h
 *   held     the link is lost mid-ride: physics on the trainer's last power
 *            (a rider who had stopped stays stopped; never 190 W demo power)
 *   demo     Demo Mode physics at the configured demo power
 *   gps      outdoor GPS
 *   replay   the recorded file
 *   workout  the workout engine owns the frame
 */
export type RideDriveKind = 'trainer' | 'held' | 'demo' | 'gps' | 'replay' | 'workout';

export function driveOf(s: Pick<RideFsmState, 'source' | 'trainer'>): RideDriveKind {
  switch (s.source) {
    case 'outdoor': return 'gps';
    case 'replay':  return 'replay';
    case 'workout': return 'workout';
    case 'demo':    return 'demo';
    case 'trainer':
      if (s.trainer === 'connected') return 'trainer';
      if (s.trainer === 'lost') return 'held';
      return 'demo';
  }
}

/**
 * What the trainer's resistance should do.
 *   track  follow the road (SIM grade / ERG target), riding with a live link
 *   hold   paused: keep the last command, send nothing new
 *   off    no live trainer to command (or not riding)
 */
export type ResistanceMode = 'track' | 'hold' | 'off';

export function resistanceOf(s: RideFsmState): ResistanceMode {
  if (s.trainer !== 'connected') return 'off';
  if (s.source !== 'trainer' && s.source !== 'workout') return 'off';
  if (s.phase === 'riding') return 'track';
  if (s.phase === 'paused') return 'hold';
  return 'off';
}

/**
 * Throttle + restore for trainer commands. `step()` once per frame: it
 * answers whether to send a command now. While held nothing is sent, so
 * the trainer keeps its resistance; the first tracking frame after a hold
 * (resume) or after the link returns (reconnect) sends immediately, so the
 * trainer gets the road back without waiting for the throttle window.
 */
export interface ResistanceGate {
  step(mode: ResistanceMode, nowMs: number, changed: boolean): boolean;
  readonly last: ResistanceMode;
}

export const RESISTANCE_MIN_INTERVAL_MS = 850;

export function createResistanceGate(minIntervalMs = RESISTANCE_MIN_INTERVAL_MS): ResistanceGate {
  let last: ResistanceMode = 'off';
  let lastSentMs = Number.NEGATIVE_INFINITY;
  return {
    get last() { return last; },
    step(mode, nowMs, changed) {
      const restoring = mode === 'track' && last !== 'track';
      last = mode;
      if (mode !== 'track') return false;
      if (restoring || changed || nowMs - lastSentMs > minIntervalMs) {
        lastSentMs = nowMs;
        return true;
      }
      return false;
    },
  };
}

/** Seconds of standstill before an (opt-in) indoor auto-pause. */
export const STANDSTILL_AUTOPAUSE_S = 5;
/** Below these the rider counts as stopped. */
export const STANDSTILL_SPEED_MS = 0.3;
export const STANDSTILL_POWER_W = 10;
/** Power that auto-resumes an auto-paused ride. */
export const AUTO_RESUME_POWER_W = 30;

export function isStandstill(speedMs: number, powerW: number): boolean {
  return speedMs < STANDSTILL_SPEED_MS && powerW < STANDSTILL_POWER_W;
}

/** Accumulated standstill time after one frame of `dtSec`. */
export function nextStandstillSec(prevSec: number, dtSec: number, speedMs: number, powerW: number): number {
  return isStandstill(speedMs, powerW) ? prevSec + dtSec : 0;
}

/**
 * Indoor auto-pause is opt-in (settings.indoorAutoPause). With it off a
 * stopped rider keeps `riding` forever (speed decays to 0, distance stops);
 * with it on a trainer ride pauses after STANDSTILL_AUTOPAUSE_S. Outdoor
 * rides have their own GPS rule; demo power never stops; replays and
 * workouts run their own clocks.
 */
export function autoPauseDue(args: {
  state: RideFsmState;
  standstillSec: number;
  enabled: boolean;
}): boolean {
  const { state, standstillSec, enabled } = args;
  if (!enabled || state.phase !== 'riding' || state.source !== 'trainer') return false;
  return standstillSec >= STANDSTILL_AUTOPAUSE_S;
}

/** An auto-paused ride resumes once a live trainer reads real power again. */
export function autoResumeDue(args: { state: RideFsmState; autoPaused: boolean; powerW: number }): boolean {
  const { state, autoPaused, powerW } = args;
  return autoPaused && state.phase === 'paused' && state.trainer === 'connected' && powerW >= AUTO_RESUME_POWER_W;
}
