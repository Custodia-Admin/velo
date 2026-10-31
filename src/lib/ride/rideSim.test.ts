import { describe, expect, it } from 'vitest';
import { buildRoute, headingAt, sampleRouteAtDistance } from '@/lib/gpxParser';
import { EmaSmoother, gradientAt } from '@/lib/gradientCalculator';
import { DEFAULT_RIDER, solveVelocity } from '@/lib/physics';
import { rideDrive } from '@/lib/rideDrive';
import { haversine } from '@/lib/utils';
import { useRideStore } from '@/stores/rideStore';
import type { Route } from '@/types';
import {
  GRADE_EMA_ALPHA,
  MAX_STEP_S,
  initialRideSimState,
  ridePose,
  step,
  type RideSimInputs,
  type RideSimState,
} from './rideSim';

/** ~2 km heading north-east: flat, then a 6 % climb, then a descent. */
function hillRoute(): Route {
  const raw: { lat: number; lon: number; ele: number }[] = [];
  for (let i = 0; i <= 200; i++) {
    const d = i * 10; // metres along
    const ele = d < 600 ? 100 : d < 1400 ? 100 + (d - 600) * 0.06 : 148 - (d - 1400) * 0.05;
    raw.push({ lat: 43.1 + (d * 0.7) / 111_320, lon: 12.39 + (d * 0.7) / (111_320 * Math.cos((43.1 * Math.PI) / 180)), ele });
  }
  return buildRoute('hill', raw);
}

const route = hillRoute();

const demo: RideSimInputs = {
  dt: 1 / 60,
  drive: {
    mode: 'trainer',
    connection: 'disconnected',
    storeSpeed: 0,
    trainerSpeed: 0,
    power: 0,
    gearFactor: 1,
    demoPowerW: 190,
    rider: DEFAULT_RIDER,
  },
};

function running(over: Partial<RideSimState> = {}): RideSimState {
  return { ...initialRideSimState('running'), ...over };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

describe('rideSim.step — purity', () => {
  it('never mutates its inputs and returns the same result for the same inputs', () => {
    const r = deepFreeze(hillRoute());
    const s = deepFreeze(running({ distance: 700, gradeEma: 3 }));
    const i = deepFreeze({ ...demo, laneOffsetM: 0.8 });
    const a = step(s, i, r);
    const b = step(s, i, r);
    expect(a).toEqual(b);
    expect(s.distance).toBe(700);
    expect(a.state).not.toBe(s);
  });

  it('does not read the clock or any store', () => {
    const s = running({ distance: 100 });
    const before = useRideStore.getState();
    const a = step(s, demo, route);
    expect(useRideStore.getState()).toBe(before);
    // Same inputs one tick later on the wall clock: identical output.
    const b = step(s, demo, route);
    expect(b).toEqual(a);
  });
});

describe('rideSim.step — states that do not move', () => {
  for (const rideState of ['idle', 'ready', 'paused', 'finished'] as const) {
    it(`${rideState}: same state back, rider stands at their distance`, () => {
      const s = { ...initialRideSimState(rideState), distance: 420, speed: 7 };
      const out = step(s, demo, route);
      expect(out.state).toBe(s);
      expect(out.finished).toBe(false);
      expect(out.pose.distance).toBe(420);
      expect(out.pose.speed).toBe(0);
      const p = sampleRouteAtDistance(route, 420);
      expect(out.pose.lat).toBeCloseTo(p.lat, 12);
      expect(out.pose.lon).toBeCloseTo(p.lon, 12);
    });
  }

  it('a zero or non-finite dt does not move a running ride', () => {
    const s = running({ distance: 50, speed: 6 });
    expect(step(s, { ...demo, dt: 0 }, route).state).toBe(s);
    expect(step(s, { ...demo, dt: Number.NaN }, route).state).toBe(s);
  });
});

describe('rideSim.step — physics and grade', () => {
  it('Demo Mode on the flat: solveVelocity at demo power, distance += v·dt', () => {
    const out = step(running({ distance: 100 }), demo, route);
    const v = solveVelocity(190, gradientAt(route, 100), DEFAULT_RIDER);
    expect(out.state.speed).toBeCloseTo(v, 9);
    expect(out.state.distance).toBeCloseTo(100 + v * demo.dt, 9);
    expect(out.power).toBe(190);
    expect(out.state.elapsedMs).toBeCloseTo(1000 / 60, 9);
  });

  it('smooths the grade with the loop EMA (alpha 0.18)', () => {
    const raw = gradientAt(route, 1000);
    const out = step(running({ distance: 1000, gradeEma: 0 }), demo, route);
    expect(out.state.gradeEma).toBeCloseTo(GRADE_EMA_ALPHA * raw, 12);
    expect(out.pose.grade).toBe(out.state.gradeEma);
    // First running step seeds the EMA with the raw grade.
    expect(step(running({ distance: 1000 }), demo, route).state.gradeEma).toBeCloseTo(raw, 12);
  });

  it('climbing is slower than the flat at the same power', () => {
    const flat = step(running({ distance: 300, gradeEma: 0 }), demo, route).state.speed;
    const climb = step(running({ distance: 1000, gradeEma: 6 }), demo, route).state.speed;
    expect(climb).toBeLessThan(flat * 0.6);
  });

  it('a paired trainer drives the rider, even at a standstill', () => {
    const trainer: RideSimInputs = {
      ...demo,
      drive: { ...demo.drive, connection: 'connected', storeSpeed: 0, trainerSpeed: 0, power: 0 },
    };
    const out = step(running({ distance: 200 }), trainer, route);
    expect(out.state.speed).toBe(0);
    expect(out.state.distance).toBe(200);
    expect(out.power).toBe(0);
  });

  it('virtual gears scale the trainer speed and report a display speed', () => {
    const geared: RideSimInputs = {
      ...demo,
      drive: { ...demo.drive, connection: 'connected', storeSpeed: 8, trainerSpeed: 8, power: 210, gearFactor: 1.21 },
    };
    const out = step(running({ distance: 200 }), geared, route);
    expect(out.state.speed).toBeCloseTo(9.68, 6);
    expect(out.displaySpeed).toBeCloseTo(9.68, 6);
  });

  it('clamps long frames to MAX_STEP_S like the ride loop', () => {
    const v = step(running({ distance: 100 }), demo, route).state.speed;
    const out = step(running({ distance: 100 }), { ...demo, dt: 5 }, route);
    expect(out.state.distance).toBeCloseTo(100 + v * MAX_STEP_S, 6);
  });
});

describe('rideSim.step — route end', () => {
  it('finishes exactly at the end of the route', () => {
    const out = step(running({ distance: route.totalDistance - 0.01 }), demo, route);
    expect(out.finished).toBe(true);
    expect(out.state.rideState).toBe('finished');
    expect(out.state.distance).toBe(route.totalDistance);
  });

  it('loops instead when asked (workouts outlast the map)', () => {
    const out = step(running({ distance: route.totalDistance - 0.01 }), { ...demo, loop: true }, route);
    expect(out.finished).toBe(false);
    expect(out.state.rideState).toBe('running');
    expect(out.state.distance).toBeLessThan(1);
  });
});

describe('ridePose', () => {
  it('sits on the route line with the route heading and elevation', () => {
    const d = 1234;
    const p = ridePose(route, d);
    const s = sampleRouteAtDistance(route, d);
    expect(p).toMatchObject({ lat: s.lat, lon: s.lon, ele: s.ele, heading: headingAt(route, d), distance: d });
    expect(p.grade).toBeCloseTo(gradientAt(route, d), 12);
  });

  it('lane offset moves the rider sideways by that many metres, not along', () => {
    const on = ridePose(route, 500);
    const off = ridePose(route, 500, { laneOffsetM: 1.5 });
    expect(haversine(on.lat, on.lon, off.lat, off.lon)).toBeCloseTo(1.5, 2);
    expect(off.ele).toBe(on.ele);
    expect(off.laneOffsetM).toBe(1.5);
  });

  it('clamps the reported distance to the route', () => {
    expect(ridePose(route, -5).distance).toBe(0);
    expect(ridePose(route, route.totalDistance + 50).distance).toBe(route.totalDistance);
  });
});

describe('rideSim.step matches the live ride loop (useRideLoop + rideStore.tick)', () => {
  it('600 Demo Mode frames over the climb: same distance, speed and grade', () => {
    // The loop: EMA grade → rideDrive → rideStore.tick advances distance.
    useRideStore.setState({
      route,
      rideState: 'running',
      distance: 500,
      speed: 0,
      samples: [],
      replayData: null,
      workoutRunning: false,
      mode: 'trainer',
      connection: 'disconnected',
    });
    const smoother = new EmaSmoother(0.18);
    let sim = running({ distance: 500 });
    for (let f = 0; f < 600; f++) {
      const dt = f % 7 === 0 ? 1 / 30 : 1 / 60; // uneven frames
      const st = useRideStore.getState();
      const grade = smoother.push(gradientAt(route, st.distance));
      const drive = rideDrive({ ...demo.drive, storeSpeed: st.speed, gradePct: grade });
      st.tick({
        now: f,
        dt,
        gradeNow: grade,
        elevationNow: 0,
        speedNow: drive.speed,
        positionNow: { lat: 0, lon: 0 },
        recordSample: false,
        cadenceNow: 78,
        powerNow: drive.power,
        heartRateNow: null,
      });

      sim = step(sim, { ...demo, dt }, route).state;
      const after = useRideStore.getState();
      expect(sim.distance).toBeCloseTo(after.distance, 9);
      expect(sim.gradeEma).toBeCloseTo(grade, 12);
    }
    expect(sim.distance).toBeGreaterThan(530);
    expect(sim.speed).toBeCloseTo(useRideStore.getState().speed, 9);
  });

  it('reaches the finish on the same frame as rideStore.tick', () => {
    const start = route.totalDistance - 3;
    useRideStore.setState({ route, rideState: 'running', distance: start, speed: 0, samples: [], workoutRunning: false, mode: 'demo' });
    let sim = running({ distance: start });
    for (let f = 0; f < 120 && sim.rideState === 'running'; f++) {
      const st = useRideStore.getState();
      const out = step(sim, { ...demo, drive: { ...demo.drive, mode: 'demo' } }, route);
      st.tick({
        now: f, dt: demo.dt, gradeNow: 0, elevationNow: 0, speedNow: out.state.speed,
        positionNow: { lat: 0, lon: 0 }, recordSample: false, cadenceNow: 78, powerNow: 190, heartRateNow: null,
      });
      sim = out.state;
      expect(useRideStore.getState().rideState).toBe(sim.rideState);
    }
    expect(sim.rideState).toBe('finished');
    expect(useRideStore.getState().distance).toBe(route.totalDistance);
  });
});
