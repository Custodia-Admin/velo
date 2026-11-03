import { describe, expect, it } from 'vitest';
import { DEFAULT_RIDER, solveVelocity } from '@/lib/physics';
import { rideDrive } from '@/lib/rideDrive';
import type { ConnectionState, RideState } from '@/types';
import {
  AUTO_RESUME_POWER_W,
  INITIAL_RIDE_FSM,
  IllegalRideTransition,
  PHASE_EVENT_TYPES,
  RESISTANCE_MIN_INTERVAL_MS,
  RIDE_PHASES,
  RIDE_SOURCES,
  STANDSTILL_AUTOPAUSE_S,
  TRAINER_EVENT_TYPES,
  TRAINER_LINKS,
  autoPauseDue,
  autoResumeDue,
  can,
  createResistanceGate,
  describeFsm,
  driveOf,
  isStandstill,
  nextStandstillSec,
  nextState,
  phaseOf,
  resistanceOf,
  sourceOf,
  sourceSwapAllowed,
  toRideState,
  trainerEventFor,
  trainerLinkOf,
  transition,
  type PhaseEvent,
  type RideFsmState,
  type RidePhase,
  type RideSource,
  type TrainerLink,
} from './rideFsm';

const at = (phase: RidePhase, over: Partial<RideFsmState> = {}): RideFsmState => ({
  phase,
  source: 'trainer',
  trainer: 'connected',
  ...over,
});

function phaseEvent(type: PhaseEvent['type'], hasRoute = true): PhaseEvent {
  return type === 'RESET' ? { type, hasRoute } : ({ type } as PhaseEvent);
}

// The spec, written out by hand (not read from PHASE_TABLE): every
// (phase, event) pair, '—' = illegal.
type Cell = RidePhase | '—';
const PHASE_SPEC: Record<RidePhase, Record<PhaseEvent['type'], Cell>> = {
  //          ROUTE_LOADED ROUTE_CLEARED START     PAUSE     RESUME    FINISH      RESET
  idle:     { ROUTE_LOADED: 'ready', ROUTE_CLEARED: 'idle', START: 'riding', PAUSE: '—',      RESUME: '—',      FINISH: '—',        RESET: 'ready' },
  ready:    { ROUTE_LOADED: 'ready', ROUTE_CLEARED: 'idle', START: 'riding', PAUSE: '—',      RESUME: '—',      FINISH: '—',        RESET: 'ready' },
  riding:   { ROUTE_LOADED: 'ready', ROUTE_CLEARED: 'idle', START: '—',      PAUSE: 'paused', RESUME: '—',      FINISH: 'finished', RESET: 'ready' },
  paused:   { ROUTE_LOADED: 'ready', ROUTE_CLEARED: 'idle', START: '—',      PAUSE: '—',      RESUME: 'riding', FINISH: 'finished', RESET: 'ready' },
  finished: { ROUTE_LOADED: 'ready', ROUTE_CLEARED: 'idle', START: '—',      PAUSE: '—',      RESUME: '—',      FINISH: 'finished', RESET: 'ready' },
};

const TRAINER_SPEC: Record<TrainerLink, Record<(typeof TRAINER_EVENT_TYPES)[number], TrainerLink>> = {
  disconnected: { TRAINER_CONNECTING: 'connecting', TRAINER_CONNECTED: 'connected', TRAINER_LOST: 'lost', TRAINER_DISCONNECTED: 'disconnected' },
  connecting:   { TRAINER_CONNECTING: 'connecting', TRAINER_CONNECTED: 'connected', TRAINER_LOST: 'lost', TRAINER_DISCONNECTED: 'disconnected' },
  connected:    { TRAINER_CONNECTING: 'connecting', TRAINER_CONNECTED: 'connected', TRAINER_LOST: 'lost', TRAINER_DISCONNECTED: 'disconnected' },
  lost:         { TRAINER_CONNECTING: 'connecting', TRAINER_CONNECTED: 'connected', TRAINER_LOST: 'lost', TRAINER_DISCONNECTED: 'disconnected' },
};

describe('rideFsm — phase table: every (state, event) pair', () => {
  const pairs = RIDE_PHASES.flatMap((p) => PHASE_EVENT_TYPES.map((e) => [p, e] as const));

  it('covers all 35 pairs', () => {
    expect(pairs).toHaveLength(RIDE_PHASES.length * PHASE_EVENT_TYPES.length);
    expect(pairs).toHaveLength(35);
  });

  it.each(pairs)('%s + %s', (phase, type) => {
    const s = at(phase);
    const e = phaseEvent(type);
    const want = PHASE_SPEC[phase][type];
    if (want === '—') {
      expect(can(s, e)).toBe(false);
      expect(nextState(s, e)).toBeNull();
      expect(() => transition(s, e, { strict: true })).toThrow(IllegalRideTransition);
      // Production: a no-op that returns the very same state.
      expect(transition(s, e, { strict: false })).toBe(s);
    } else {
      expect(can(s, e)).toBe(true);
      const next = transition(s, e, { strict: true });
      expect(next.phase).toBe(want);
      // Phase events never touch the orthogonal dimensions.
      expect(next.source).toBe(s.source);
      expect(next.trainer).toBe(s.trainer);
    }
  });

  it.each(RIDE_PHASES)('RESET from %s without a route lands in idle', (phase) => {
    expect(transition(at(phase), { type: 'RESET', hasRoute: false }).phase).toBe('idle');
  });

  it('defaults to strict (throws) under vitest, which runs as a dev build', () => {
    expect(() => transition(at('idle'), { type: 'PAUSE' })).toThrow(/Illegal ride transition: PAUSE in idle\/trainer\/trainer:connected/);
  });

  it('the error carries the state and event', () => {
    try {
      transition(at('ready'), { type: 'FINISH' }, { strict: true });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalRideTransition);
      const e = err as IllegalRideTransition;
      expect(e.name).toBe('IllegalRideTransition');
      expect(e.state.phase).toBe('ready');
      expect(e.event.type).toBe('FINISH');
    }
  });
});

describe('rideFsm — trainer table: every (link, event) pair', () => {
  const pairs = TRAINER_LINKS.flatMap((l) => TRAINER_EVENT_TYPES.map((e) => [l, e] as const));

  it('covers all 16 pairs', () => expect(pairs).toHaveLength(16));

  it.each(pairs)('%s + %s', (link, type) => {
    for (const phase of RIDE_PHASES) {
      const s = at(phase, { trainer: link });
      const next = transition(s, { type }, { strict: true });
      expect(next.trainer).toBe(TRAINER_SPEC[link][type]);
      // A trainer event never moves the ride phase or the source.
      expect(next.phase).toBe(phase);
      expect(next.source).toBe('trainer');
    }
  });
});

describe('rideFsm — source swaps: every (phase, from, to) triple', () => {
  const live = new Set<RideSource>(['trainer', 'demo', 'workout']);
  const triples = RIDE_PHASES.flatMap((p) =>
    RIDE_SOURCES.flatMap((from) => RIDE_SOURCES.map((to) => [p, from, to] as const)),
  );

  it.each(triples)('%s: %s → %s', (phase, from, to) => {
    const inProgress = phase === 'riding' || phase === 'paused';
    const want = to !== 'replay' && (!inProgress || (live.has(from) && live.has(to)));
    expect(sourceSwapAllowed(phase, from, to)).toBe(want);
    const s = at(phase, { source: from });
    const e = { type: 'SET_SOURCE', source: to } as const;
    if (want) {
      expect(transition(s, e, { strict: true })).toEqual({ ...s, source: to });
    } else {
      expect(() => transition(s, e, { strict: true })).toThrow(IllegalRideTransition);
      expect(transition(s, e, { strict: false })).toBe(s);
    }
  });

  it.each(RIDE_PHASES)('LOAD_REPLAY from %s → ready/replay', (phase) => {
    expect(transition(at(phase), { type: 'LOAD_REPLAY' }, { strict: true })).toEqual(
      at('ready', { source: 'replay' }),
    );
  });

  it.each(RIDE_PHASES)('CLEAR_REPLAY from %s/replay → ready (route) or idle', (phase) => {
    const s = at(phase, { source: 'replay' });
    expect(transition(s, { type: 'CLEAR_REPLAY', source: 'demo', hasRoute: true }, { strict: true }))
      .toEqual(at('ready', { source: 'demo' }));
    expect(transition(s, { type: 'CLEAR_REPLAY', source: 'trainer', hasRoute: false }, { strict: true }))
      .toEqual(at('idle', { source: 'trainer' }));
  });

  it('CLEAR_REPLAY is illegal outside a replay or back into replay', () => {
    expect(can(at('ready'), { type: 'CLEAR_REPLAY', source: 'demo', hasRoute: true })).toBe(false);
    expect(can(at('ready', { source: 'replay' }), { type: 'CLEAR_REPLAY', source: 'replay', hasRoute: true }))
      .toBe(false);
  });
});

describe('rideFsm — mapping to the store strings', () => {
  it('rideState strings are unchanged for HUD consumers (riding ↔ "running")', () => {
    const expected: Record<RidePhase, RideState> = {
      idle: 'idle', ready: 'ready', riding: 'running', paused: 'paused', finished: 'finished',
    };
    for (const p of RIDE_PHASES) {
      expect(toRideState(p)).toBe(expected[p]);
      expect(phaseOf(toRideState(p))).toBe(p);
    }
  });

  it('connection strings → trainer link and event', () => {
    const cases: [ConnectionState, TrainerLink, string][] = [
      ['connected', 'connected', 'TRAINER_CONNECTED'],
      ['connecting', 'connecting', 'TRAINER_CONNECTING'],
      ['reconnecting', 'lost', 'TRAINER_LOST'],
      ['disconnected', 'disconnected', 'TRAINER_DISCONNECTED'],
      ['error', 'disconnected', 'TRAINER_DISCONNECTED'],
    ];
    for (const [c, link, ev] of cases) {
      expect(trainerLinkOf(c)).toBe(link);
      expect(trainerEventFor(c).type).toBe(ev);
    }
  });

  it('sourceOf precedence: replay > outdoor > workout > demo > trainer', () => {
    const base = { mode: 'trainer' as const, rideMode: 'trainer' as const, replayData: null, workoutRunning: false };
    expect(sourceOf(base)).toBe('trainer');
    expect(sourceOf({ ...base, mode: 'demo' })).toBe('demo');
    expect(sourceOf({ ...base, mode: 'demo', workoutRunning: true })).toBe('workout');
    expect(sourceOf({ ...base, workoutRunning: true, rideMode: 'outdoor' })).toBe('outdoor');
    expect(sourceOf({ ...base, rideMode: 'outdoor', replayData: {} })).toBe('replay');
  });

  it('describes a state compactly', () => {
    expect(describeFsm(INITIAL_RIDE_FSM)).toBe('idle/trainer/trainer:disconnected');
  });
});

describe('rideFsm — driveOf: every (source, link) pair', () => {
  const want: Record<RideSource, Record<TrainerLink, string>> = {
    trainer: { disconnected: 'demo', connecting: 'demo', connected: 'trainer', lost: 'held' },
    demo:    { disconnected: 'demo', connecting: 'demo', connected: 'demo', lost: 'demo' },
    workout: { disconnected: 'workout', connecting: 'workout', connected: 'workout', lost: 'workout' },
    replay:  { disconnected: 'replay', connecting: 'replay', connected: 'replay', lost: 'replay' },
    outdoor: { disconnected: 'gps', connecting: 'gps', connected: 'gps', lost: 'gps' },
  };
  for (const source of RIDE_SOURCES) {
    for (const trainer of TRAINER_LINKS) {
      it(`${source} + ${trainer} → ${want[source][trainer]}`, () => {
        expect(driveOf({ source, trainer })).toBe(want[source][trainer]);
      });
    }
  }
});

describe('rideFsm — resistanceOf: every (phase, source, link) triple', () => {
  for (const phase of RIDE_PHASES) {
    for (const source of RIDE_SOURCES) {
      for (const trainer of TRAINER_LINKS) {
        const commands = trainer === 'connected' && (source === 'trainer' || source === 'workout');
        const want = !commands ? 'off' : phase === 'riding' ? 'track' : phase === 'paused' ? 'hold' : 'off';
        it(`${phase}/${source}/${trainer} → ${want}`, () => {
          expect(resistanceOf({ phase, source, trainer })).toBe(want);
        });
      }
    }
  }
});

describe('rideFsm — resistance gate', () => {
  it('throttles tracking to one command per interval unless the road changed', () => {
    const g = createResistanceGate(850);
    expect(g.last).toBe('off');
    expect(g.step('track', 0, false)).toBe(true); // off → track: send at once
    expect(g.last).toBe('track');
    expect(g.step('track', 400, false)).toBe(false);
    expect(g.step('track', 500, true)).toBe(true); // grade/gear changed
    expect(g.step('track', 1000, false)).toBe(false);
    expect(g.step('track', 1351, false)).toBe(true);
  });

  it('never sends while off', () => {
    const g = createResistanceGate();
    for (let t = 0; t < 5000; t += 100) expect(g.step('off', t, true)).toBe(false);
    expect(g.last).toBe('off');
  });

  it('uses the default interval', () => {
    const g = createResistanceGate();
    g.step('track', 0, false);
    expect(g.step('track', RESISTANCE_MIN_INTERVAL_MS, false)).toBe(false);
    expect(g.step('track', RESISTANCE_MIN_INTERVAL_MS + 1, false)).toBe(true);
  });
});

describe('rideFsm — standstill and auto-pause policy', () => {
  it('standstill = slow and no power', () => {
    expect(isStandstill(0, 0)).toBe(true);
    expect(isStandstill(0.29, 9)).toBe(true);
    expect(isStandstill(0.3, 0)).toBe(false);
    expect(isStandstill(0, 10)).toBe(false);
    expect(nextStandstillSec(2, 0.1, 0, 0)).toBeCloseTo(2.1, 9);
    expect(nextStandstillSec(2, 0.1, 5, 200)).toBe(0);
  });

  it('auto-pause only when enabled, riding a trainer ride, after 5 s', () => {
    const riding = at('riding');
    expect(autoPauseDue({ state: riding, standstillSec: 60, enabled: false })).toBe(false);
    expect(autoPauseDue({ state: riding, standstillSec: STANDSTILL_AUTOPAUSE_S - 0.01, enabled: true })).toBe(false);
    expect(autoPauseDue({ state: riding, standstillSec: STANDSTILL_AUTOPAUSE_S, enabled: true })).toBe(true);
    expect(autoPauseDue({ state: at('paused'), standstillSec: 60, enabled: true })).toBe(false);
    for (const source of ['demo', 'workout', 'replay', 'outdoor'] as const) {
      expect(autoPauseDue({ state: at('riding', { source }), standstillSec: 60, enabled: true })).toBe(false);
    }
  });

  it('auto-resume only for an auto-paused ride with a live trainer reading power', () => {
    const paused = at('paused');
    expect(autoResumeDue({ state: paused, autoPaused: true, powerW: AUTO_RESUME_POWER_W })).toBe(true);
    expect(autoResumeDue({ state: paused, autoPaused: true, powerW: AUTO_RESUME_POWER_W - 1 })).toBe(false);
    expect(autoResumeDue({ state: paused, autoPaused: false, powerW: 300 })).toBe(false);
    expect(autoResumeDue({ state: at('paused', { trainer: 'lost' }), autoPaused: true, powerW: 300 })).toBe(false);
    expect(autoResumeDue({ state: at('riding'), autoPaused: true, powerW: 300 })).toBe(false);
  });
});

// ─── Named regressions for the 30 Oct ride (pure FSM level) ───────────────────
// The store/loop-level versions live in src/stores/rideStore.fsm.test.ts and
// src/hooks/useRideLoop.fsm.test.ts.

describe('regression (30 Oct): paired trainer at a standstill', () => {
  it('standstill: power 0 for 5 s keeps riding on the trainer, speed decays to 0, no 190 W demo', () => {
    let s = transition(at('ready'), { type: 'START' });
    let standstill = 0;
    let speed = 8;
    // 4 s of spin-down, then more than 5 s stopped.
    for (let t = 0; t < 10; t += 0.1) {
      speed = Math.max(0, speed - 2 * 0.1); // the flywheel spins down
      const d = rideDrive({
        mode: 'trainer', connection: 'connected', storeSpeed: speed, trainerSpeed: speed,
        power: 0, gearFactor: 1, demoPowerW: 190, gradePct: 0, rider: DEFAULT_RIDER,
      });
      expect(d.demo).toBe(false);
      expect(d.power).toBe(0);
      standstill = nextStandstillSec(standstill, 0.1, d.speed, d.power);
      if (autoPauseDue({ state: s, standstillSec: standstill, enabled: false })) {
        s = transition(s, { type: 'PAUSE' });
      }
      speed = d.speed;
    }
    expect(s.phase).toBe('riding');
    expect(speed).toBe(0);
    expect(driveOf(s)).toBe('trainer');
    // With the setting on the same 5 s auto-pauses.
    expect(autoPauseDue({ state: s, standstillSec: standstill, enabled: true })).toBe(true);
  });
});

describe('regression (30 Oct): pause/resume holds and restores FTMS resistance', () => {
  it('pause/resume: no command while paused, the first riding frame re-sends at once', () => {
    const g = createResistanceGate(850);
    let s = transition(at('ready'), { type: 'START' });
    const sent: number[] = [];
    const frame = (t: number, changed = false) => {
      if (g.step(resistanceOf(s), t, changed)) sent.push(t);
    };
    frame(0);
    frame(100);
    expect(sent).toEqual([0]);
    s = transition(s, { type: 'PAUSE' });
    expect(resistanceOf(s)).toBe('hold');
    for (let t = 200; t < 700; t += 100) frame(t, true); // grade "changes" under a parked rider
    expect(sent).toEqual([0]); // held: nothing sent, the trainer keeps its resistance
    s = transition(s, { type: 'RESUME' });
    frame(700); // inside the 850 ms throttle window
    expect(sent).toEqual([0, 700]); // restored immediately, not after the throttle
    frame(800);
    expect(sent).toEqual([0, 700]); // and the throttle applies again afterwards
  });
});

describe('regression (30 Oct): trainer disconnect mid-ride', () => {
  it('trainer disconnect → trainer:lost, keeps riding on physics; reconnect restores without START', () => {
    const g = createResistanceGate(850);
    let s = transition(at('ready'), { type: 'START' });
    expect(g.step(resistanceOf(s), 0, false)).toBe(true);

    s = transition(s, trainerEventFor('reconnecting'));
    expect(s).toEqual({ phase: 'riding', source: 'trainer', trainer: 'lost' });
    expect(driveOf(s)).toBe('held');
    expect(resistanceOf(s)).toBe('off');
    expect(g.step(resistanceOf(s), 2000, true)).toBe(false); // nothing to talk to
    const d = rideDrive({
      mode: 'trainer', connection: 'reconnecting', storeSpeed: 8, trainerSpeed: 8,
      power: 200, gearFactor: 1, demoPowerW: 190, gradePct: 3, rider: DEFAULT_RIDER,
    });
    expect(d).toMatchObject({ demo: false, held: true, power: 200 });
    expect(d.speed).toBeCloseTo(solveVelocity(200, 3, DEFAULT_RIDER), 9);

    s = transition(s, trainerEventFor('connected'));
    expect(s).toEqual({ phase: 'riding', source: 'trainer', trainer: 'connected' });
    expect(can(s, { type: 'START' })).toBe(false); // a second start would be illegal…
    expect(g.step(resistanceOf(s), 2100, false)).toBe(true); // …and isn't needed: resistance restored
  });
});

describe('regression (30 Oct): demo → trainer swap while ready', () => {
  it('demo→trainer while ready stays ready and drives from the trainer', () => {
    let s: RideFsmState = { phase: 'ready', source: 'demo', trainer: 'disconnected' };
    expect(driveOf(s)).toBe('demo');
    s = transition(s, { type: 'TRAINER_CONNECTING' });
    s = transition(s, { type: 'TRAINER_CONNECTED' });
    s = transition(s, { type: 'SET_SOURCE', source: 'trainer' });
    expect(s).toEqual({ phase: 'ready', source: 'trainer', trainer: 'connected' });
    expect(driveOf(s)).toBe('trainer');
    expect(transition(s, { type: 'START' }).phase).toBe('riding');
  });
});
