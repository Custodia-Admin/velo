import { describe, expect, it } from 'vitest';
import {
  BLEND_S,
  ORBIT_EXIT_LEAD_S,
  BRAKE_DECEL_MS2,
  createDirector,
  DIRECTOR_SHOTS,
  easeInOutCubic,
  INPUT_SETTLE_S,
  landmarkDistanceBound,
  MAX_ACCEL_MS2,
  MIN_CUT_GAP_S,
  ORBIT_RADIUS_M,
  orbitRoadLeft,
  orbitRoadNeeded,
  seededRandom,
  seedFromString,
  SHOT_MAX_S,
  SHOT_MIN_S,
  STEER_EPS,
  type DirectorFrame,
  type DirectorInput,
  type DirectorLandmark,
} from './director';

// ---------------------------------------------------------------------------
// A synthetic ride: a winding road in local metres, named places beside it,
// a speed that changes no faster than MAX_ACCEL_MS2, optional steering bursts.
// ---------------------------------------------------------------------------

interface Pt {
  x: number;
  y: number;
  d: number;
}

/** A winding road, ~`lengthM` long, sampled every 10 m. */
function windingRoad(rand: () => number, lengthM: number): Pt[] {
  const pts: Pt[] = [{ x: 0, y: 0, d: 0 }];
  let heading = 0;
  let turn = 0;
  for (let d = 10; d <= lengthM; d += 10) {
    turn += (rand() - 0.5) * 0.08;
    turn = Math.max(-0.12, Math.min(0.12, turn));
    heading += turn;
    const p = pts[pts.length - 1];
    pts.push({ x: p.x + Math.sin(heading) * 10, y: p.y + Math.cos(heading) * 10, d });
  }
  return pts;
}

function at(road: Pt[], d: number): { x: number; y: number } {
  const i = Math.max(0, Math.min(road.length - 2, Math.floor(d / 10)));
  const a = road[i];
  const b = road[i + 1];
  const t = Math.max(0, Math.min(1, (d - a.d) / 10));
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

interface Poi {
  name: string;
  x: number;
  y: number;
}

/** Closest approach of the road to each POI, as routeLandmarks computes it. */
function landmarksFor(road: Pt[], pois: Poi[], maxOffset = 400): DirectorLandmark[] {
  const out: DirectorLandmark[] = [];
  for (const p of pois) {
    let best = Infinity;
    let atD = 0;
    for (let i = 0; i < road.length - 1; i++) {
      const a = road[i];
      const b = road[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
      const dd = Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
      if (dd < best) {
        best = dd;
        atD = a.d + t * (b.d - a.d);
      }
    }
    if (best <= maxOffset) out.push({ name: p.name, distance: atD, offset: best });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

function poisBeside(rand: () => number, road: Pt[], n: number): Poi[] {
  const pois: Poi[] = [];
  const len = road[road.length - 1].d;
  for (let i = 0; i < n; i++) {
    const d = rand() * len;
    const p = at(road, d);
    const side = rand() < 0.5 ? -1 : 1;
    const off = rand() * 260;
    // Perpendicular-ish: offset east/west of the road point.
    pois.push({ name: `Place ${i}`, x: p.x + side * off, y: p.y + (rand() - 0.5) * 60 });
  }
  return pois;
}

interface Sample {
  input: DirectorInput;
  frame: DirectorFrame;
  /** True straight-line distance from the rider to the orbited POI, metres (orbit frames only). */
  orbitTrueM: number | null;
  /** The director cut on this frame. */
  cut: boolean;
}

interface RideOptions {
  seed: number;
  durationS: number;
  steering?: boolean;
  braking?: boolean;
  pois?: number;
  /** Fixed frame step (default: a jittery 15–30 fps). */
  dt?: number;
  startSpeed?: number;
}

const simCache = new Map<string, { samples: Sample[]; road: Pt[]; pois: Poi[] }>();

/** Runs (or reuses) one synthetic ride; several rules check the same rides. */
function simulate(opts: RideOptions): { samples: Sample[]; road: Pt[]; pois: Poi[] } {
  const key = JSON.stringify(opts);
  const hit = simCache.get(key);
  if (hit) return hit;
  const out = runRide(opts);
  simCache.set(key, out);
  return out;
}

function runRide(opts: RideOptions): { samples: Sample[]; road: Pt[]; pois: Poi[] } {
  const world = seededRandom(opts.seed * 7919 + 1);
  const road = windingRoad(world, 24_000);
  const pois = poisBeside(world, road, opts.pois ?? 30);
  const landmarks = landmarksFor(road, pois);
  const byName = new Map(pois.map((p) => [p.name, p]));

  const director = createDirector({ seed: opts.seed });
  const samples: Sample[] = [];
  let t = 0;
  let distance = 0;
  let speed = opts.startSpeed ?? 8;
  let targetSpeed = speed;
  let steerLeft = 0;
  let steerValue = 0;
  let brakeLeft = 0;
  let prevCuts = 0;

  while (t < opts.durationS) {
    const dt = opts.dt ?? 1 / (15 + world() * 15);
    t += dt;
    // Speed: wander toward a target, never faster than MAX_ACCEL_MS2.
    if (world() < dt / 8) targetSpeed = 2 + world() * 14;
    if (opts.braking && brakeLeft <= 0 && world() < dt / 25) brakeLeft = 1 + world() * 2;
    if (brakeLeft > 0) {
      brakeLeft -= dt;
      speed = Math.max(0, speed - 2.5 * dt);
      targetSpeed = speed;
    } else {
      const dv = Math.max(-MAX_ACCEL_MS2 * dt, Math.min(MAX_ACCEL_MS2 * dt, targetSpeed - speed));
      speed += dv;
    }
    distance += speed * dt;
    if (opts.steering) {
      if (steerLeft <= 0 && world() < dt / 6) {
        steerLeft = 0.3 + world() * 4;
        steerValue = (world() < 0.5 ? -1 : 1) * (0.1 + world() * 0.9);
      }
      if (steerLeft > 0) steerLeft -= dt;
    }
    const steer = steerLeft > 0 ? steerValue : 0;
    const input: DirectorInput = { t, distance, speed, steer, landmarks };
    const frame = director.update(input);
    let orbitTrueM: number | null = null;
    if (frame.shot === 'orbit' && frame.landmark) {
      const poi = byName.get(frame.landmark.name)!;
      const p = at(road, distance);
      orbitTrueM = Math.hypot(p.x - poi.x, p.y - poi.y);
    }
    samples.push({ input, frame, orbitTrueM, cut: frame.cuts > prevCuts });
    prevCuts = frame.cuts;
  }
  return { samples, road, pois };
}

const SEEDS = Array.from({ length: 12 }, (_, i) => 1000 + i * 37);

// ---------------------------------------------------------------------------

describe('director: the blueprint rules (§P2.3)', () => {
  it('never cuts twice within 15 s (and not in the first 15 s of the ride)', () => {
    let totalCuts = 0;
    for (const seed of SEEDS) {
      for (const steering of [false, true]) {
        const { samples } = simulate({ seed, durationS: 1500, steering, braking: true, pois: 40 });
        const cutTimes = samples.filter((s) => s.cut).map((s) => s.input.t);
        totalCuts += cutTimes.length;
        expect(cutTimes[0]).toBeGreaterThanOrEqual(samples[0].input.t + MIN_CUT_GAP_S);
        for (let i = 1; i < cutTimes.length; i++) {
          expect(cutTimes[i] - cutTimes[i - 1]).toBeGreaterThanOrEqual(MIN_CUT_GAP_S);
        }
      }
    }
    // The rule was exercised, not dodged by never cutting.
    expect(totalCuts).toBeGreaterThan(SEEDS.length * 2 * 25);
  });

  it('never cuts during steering input, nor until it has settled', () => {
    let cutsSeen = 0;
    let steeringFrames = 0;
    const violations: string[] = [];
    for (const seed of SEEDS) {
      const { samples } = simulate({ seed, durationS: 1500, steering: true, braking: true, pois: 40 });
      let lastSteerT = -Infinity;
      for (const s of samples) {
        const steering = Math.abs(s.input.steer) > STEER_EPS;
        if (steering) {
          lastSteerT = s.input.t;
          steeringFrames++;
          if (!s.frame.suspended) violations.push(`seed ${seed}: not suspended while steering at ${s.input.t}`);
        }
        if (s.cut) {
          cutsSeen++;
          if (steering) violations.push(`seed ${seed}: cut while steering at ${s.input.t}`);
          if (s.input.t - lastSteerT < INPUT_SETTLE_S) violations.push(`seed ${seed}: cut ${s.input.t - lastSteerT} s after steering`);
        }
      }
    }
    expect(violations).toEqual([]);
    expect(steeringFrames).toBeGreaterThan(5_000);
    expect(cutsSeen).toBeGreaterThan(SEEDS.length * 20);
  });

  it('flies an orbit only within 300 m of a landmark (true distance, winding roads, changing speed)', () => {
    let orbitFrames = 0;
    let orbits = 0;
    const violations: string[] = [];
    for (const seed of SEEDS) {
      const { samples } = simulate({ seed, durationS: 1500, steering: false, braking: true, pois: 40 });
      for (const s of samples) {
        if (s.frame.shot !== 'orbit') continue;
        orbitFrames++;
        if (s.cut) orbits++;
        if (!s.frame.landmark) violations.push(`seed ${seed}: orbit without a landmark at ${s.input.t}`);
        else if (s.orbitTrueM! > ORBIT_RADIUS_M || landmarkDistanceBound(s.frame.landmark, s.input.distance) > ORBIT_RADIUS_M) {
          violations.push(`seed ${seed}: orbit ${s.orbitTrueM!.toFixed(1)} m from ${s.frame.landmark.name} at ${s.input.t}`);
        }
      }
    }
    expect(violations).toEqual([]);
    expect(orbits).toBeGreaterThan(SEEDS.length * 3);
    expect(orbitFrames).toBeGreaterThan(10_000);
  });

  it('with steering, an orbit outlives the radius only while the input holds the shot', () => {
    const violations: string[] = [];
    let heldOutside = 0;
    for (const seed of SEEDS) {
      const { samples } = simulate({ seed, durationS: 1500, steering: true, braking: true, pois: 40 });
      for (const s of samples) {
        if (s.frame.shot !== 'orbit') continue;
        if (landmarkDistanceBound(s.frame.landmark!, s.input.distance) > ORBIT_RADIUS_M) {
          heldOutside++;
          if (!s.frame.suspended) violations.push(`seed ${seed}: orbit outside the radius at ${s.input.t} with no input`);
        }
      }
    }
    expect(violations).toEqual([]);
    // The precedence case is exercised by these rides, not just allowed.
    expect(heldOutside).toBeGreaterThan(0);
  });

  it('is deterministic: same seed and inputs → the same edit; another seed → another edit', () => {
    const a = simulate({ seed: 42, durationS: 900, steering: true, braking: true, dt: 1 / 50 });
    const b = simulate({ seed: 42, durationS: 900, steering: true, braking: true, dt: 1 / 50 });
    expect(b.samples.map((s) => s.frame)).toEqual(a.samples.map((s) => s.frame));

    // Same inputs, different director seed.
    const inputs = a.samples.map((s) => s.input);
    const edit = (seed: number) => {
      const d = createDirector({ seed });
      return inputs.map((i) => d.update(i)).filter((f, i, all) => i === 0 || f.cuts !== all[i - 1].cuts).map((f) => `${f.shot}@${f.cutAt.toFixed(2)}`);
    };
    expect(edit(7)).toEqual(edit(7));
    expect(edit(8)).not.toEqual(edit(7));
  });
});

describe('director: pacing and shots', () => {
  it('cuts every 20–40 s when nothing interrupts it, through every non-orbit shot', () => {
    const director = createDirector({ seed: 3 });
    const seen = new Set<string>();
    const cuts: number[] = [];
    let prev = 0;
    for (let t = 0; t < 3600; t += 1 / 30) {
      const f = director.update({ t, distance: t * 8, speed: 8, steer: 0, landmarks: [] });
      seen.add(f.shot);
      if (f.cuts > prev) cuts.push(t);
      prev = f.cuts;
    }
    expect(cuts[0]).toBeGreaterThanOrEqual(SHOT_MIN_S);
    expect(cuts[0]).toBeLessThanOrEqual(SHOT_MAX_S + 0.05);
    for (let i = 1; i < cuts.length; i++) {
      const gap = cuts[i] - cuts[i - 1];
      expect(gap).toBeGreaterThanOrEqual(SHOT_MIN_S - 0.05);
      expect(gap).toBeLessThanOrEqual(SHOT_MAX_S + 0.05);
    }
    expect(cuts.length).toBeGreaterThan(3600 / SHOT_MAX_S - 1);
    expect([...seen].sort()).toEqual(['chase', 'front', 'pov', 'side']);
  });

  it('never orbits without a landmark, and never repeats a shot across a cut', () => {
    const director = createDirector({ seed: 11 });
    let last = director.update({ t: 0, distance: 0, speed: 8, steer: 0, landmarks: [] });
    const bad: string[] = [];
    for (let t = 0; t < 3600; t += 0.1) {
      const f = director.update({ t, distance: t * 8, speed: 8, steer: 0, landmarks: [] });
      if (f.shot === 'orbit') bad.push(`orbit at ${t}`);
      if (f.cuts > last.cuts && f.shot === last.shot) bad.push(`${f.shot} again at ${t}`);
      last = f;
    }
    expect(bad).toEqual([]);
    expect(last.cuts).toBeGreaterThan(80);
  });

  it('turns to a landmark as the road reaches it: an orbit, once, at the first legal moment', () => {
    const landmark: DirectorLandmark = { name: 'Rivotorto', distance: 1200, offset: 80 };
    const windowStart = landmark.distance - (ORBIT_RADIUS_M - landmark.offset);
    const step = 0.05;
    for (const seed of [5, 6, 7, 8, 9, 10]) {
      const director = createDirector({ seed });
      const orbitStarts: number[] = [];
      let lastCutT = 0;
      let expectedT = Infinity;
      let prev = 0;
      for (let t = 0; t < 400; t += step) {
        const distance = t * 8;
        const f = director.update({ t, distance, speed: 8, steer: 0, landmarks: [landmark] });
        if (f.cuts > prev) {
          if (f.shot === 'orbit') {
            orbitStarts.push(t);
            expect(f.landmark).toEqual(landmark);
            expectedT = Math.max(windowStart / 8, lastCutT + MIN_CUT_GAP_S);
          }
          lastCutT = t;
        }
        prev = f.cuts;
      }
      expect(orbitStarts).toHaveLength(1);
      // As soon as the road is inside the radius, or 15 s after the previous cut.
      expect(orbitStarts[0]).toBeGreaterThanOrEqual(expectedT - 1e-9);
      expect(orbitStarts[0]).toBeLessThan(expectedT + step * 1.5);
    }
  });

  it('leaves an orbit before the edge of the radius, and orbits each landmark once', () => {
    // Slow rider, big window: the orbit ends on its own clock while the road
    // is still inside the radius; the same place is not orbited again.
    const slow: DirectorLandmark = { name: 'Santa Maria', distance: 600, offset: 0 };
    const d1 = createDirector({ seed: 21 });
    let orbits = 0;
    let prev = 0;
    for (let t = 0; t < 600; t += 0.05) {
      const f = d1.update({ t, distance: t * 2, speed: 2, steer: 0, landmarks: [slow] });
      if (f.cuts > prev && f.shot === 'orbit') orbits++;
      prev = f.cuts;
    }
    expect(orbits).toBe(1);

    // Fast rider: the orbit is left ORBIT_EXIT_LEAD_S before the radius, not at it.
    const fast: DirectorLandmark = { name: 'Rivotorto', distance: 1500, offset: 0 };
    for (const seed of [31, 32, 33, 34]) {
      const d2 = createDirector({ seed });
      let inOrbit = false;
      let exitLeft: number | null = null;
      for (let t = 0; t < 300 && exitLeft === null; t += 0.05) {
        const f = d2.update({ t, distance: t * 12, speed: 12, steer: 0, landmarks: [fast] });
        if (f.shot === 'orbit') inOrbit = true;
        else if (inOrbit) exitLeft = orbitRoadLeft(fast, t * 12);
      }
      expect(exitLeft).not.toBeNull();
      expect(exitLeft!).toBeGreaterThan(12 * (ORBIT_EXIT_LEAD_S - 0.2));
    }
  });

  it('skips a landmark it cannot orbit safely at this speed', () => {
    // Offset 250 m leaves 100 m of road inside the radius: not enough at 8 m/s.
    const landmark: DirectorLandmark = { name: 'Far tower', distance: 1200, offset: 250 };
    expect(orbitRoadNeeded(8)).toBeGreaterThan(2 * (ORBIT_RADIUS_M - landmark.offset));
    const director = createDirector({ seed: 5 });
    for (let t = 0; t < 400; t += 0.05) {
      const f = director.update({ t, distance: t * 8, speed: 8, steer: 0, landmarks: [landmark] });
      expect(f.shot).not.toBe('orbit');
    }
  });

  it('holds while the rider brakes, then cuts once the input has settled', () => {
    const step = 0.05;
    // When this seed's first cut falls on a steady ride.
    const twin = createDirector({ seed: 9 });
    let firstCut = 0;
    for (let t = 0; !firstCut; t += step) {
      if (twin.update({ t, distance: t * 14, speed: 14, steer: 0, landmarks: [] }).cuts > 0) firstCut = t;
    }
    // Same ride, but braking at 1.6 m/s² from 3 s before that cut, for 8 s.
    const director = createDirector({ seed: 9 });
    const brakeFrom = firstCut - 3;
    const brakeTo = brakeFrom + 8;
    let speed = 14;
    let distance = 0;
    let cutT = 0;
    for (let t = 0; t < brakeTo + 30 && !cutT; t += step) {
      if (t >= brakeFrom && t < brakeTo) speed -= 1.6 * step;
      distance += speed * step;
      const f = director.update({ t, distance, speed, steer: 0, landmarks: [] });
      if (t > brakeFrom + 1 && t < brakeTo) expect(f.suspended).toBe(true);
      if (f.cuts > 0) cutT = t;
    }
    expect(BRAKE_DECEL_MS2).toBeLessThan(1.6);
    // The overdue cut waits for the brake to end and the input to settle.
    expect(cutT).toBeGreaterThanOrEqual(brakeTo + INPUT_SETTLE_S - step);
    expect(cutT).toBeLessThan(brakeTo + INPUT_SETTLE_S + 1);
  });

  it('a gentle slow-down is not braking', () => {
    const director = createDirector({ seed: 1 });
    let speed = 10;
    for (let t = 0; t < 10; t += 0.05) {
      speed -= (BRAKE_DECEL_MS2 * 0.5) * 0.05;
      const f = director.update({ t, distance: t * 9, speed, steer: 0, landmarks: [] });
      expect(f.suspended).toBe(false);
    }
  });

  it('blends with an ease-in-out over BLEND_S, from the previous shot', () => {
    const director = createDirector({ seed: 2 });
    let prev = director.update({ t: 0, distance: 0, speed: 8, steer: 0, landmarks: [] });
    expect(prev.blend).toBe(1);
    let t = 0;
    let cut: DirectorFrame | null = null;
    while (!cut) {
      t += 1 / 60;
      const f = director.update({ t, distance: t * 8, speed: 8, steer: 0, landmarks: [] });
      if (f.cuts > prev.cuts) cut = f;
      prev = f;
    }
    expect(cut.blend).toBe(0);
    expect(cut.from).toBe('chase');
    // Eased, not linear: slow out of the old shot and into the new one.
    let quarter: DirectorFrame | null = null;
    let lastBlend = 0;
    const startT = t;
    while (t < startT + BLEND_S + 0.5) {
      t += 1 / 60;
      const f = director.update({ t, distance: t * 8, speed: 8, steer: 0, landmarks: [] });
      if (!quarter && f.shotT >= BLEND_S / 4) quarter = f;
      expect(f.blend).toBeGreaterThanOrEqual(lastBlend);
      if (f.blend < 1) expect(f.from).toBe('chase');
      else expect(f.from).toBe(f.shot);
      lastBlend = f.blend;
    }
    expect(lastBlend).toBe(1);
    expect(quarter!.blend).toBeCloseTo(easeInOutCubic(quarter!.shotT / BLEND_S), 10);
    expect(quarter!.blend).toBeLessThan(quarter!.shotT / BLEND_S);
  });

  it('is robust to bad input (NaN, a long frame gap)', () => {
    const director = createDirector({ seed: 4 });
    director.update({ t: 0, distance: 0, speed: 8, steer: 0, landmarks: [] });
    const f = director.update({ t: Number.NaN, distance: Number.NaN, speed: Number.NaN, steer: Number.NaN, landmarks: [] });
    expect(DIRECTOR_SHOTS).toContain(f.shot);
    // 30 s with no frames (a hidden tab) must not read as hard braking.
    const g = director.update({ t: 30, distance: 0, speed: 0, steer: 0, landmarks: [] });
    expect(g.suspended).toBe(false);
  });
});

describe('director helpers', () => {
  it('easeInOutCubic: clamped, 0→0, ½→½, 1→1, slow at both ends', () => {
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(2)).toBe(1);
    expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
    expect(easeInOutCubic(0.9)).toBeGreaterThan(0.9);
    expect(easeInOutCubic(0.3) + easeInOutCubic(0.7)).toBeCloseTo(1, 10);
  });

  it('seeds: stable per string, spread across strings; the PRNG repeats per seed', () => {
    expect(seedFromString('assisi-valley')).toBe(seedFromString('assisi-valley'));
    expect(seedFromString('assisi-valley')).not.toBe(seedFromString('tiber-park'));
    const a = seededRandom(123);
    const b = seededRandom(123);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('orbit window: road left inside the radius, bound on the distance', () => {
    const l: DirectorLandmark = { name: 'X', distance: 1000, offset: 100 };
    expect(orbitRoadLeft(l, 700)).toBe(0); // before the window
    expect(orbitRoadLeft(l, 800)).toBe(400);
    expect(orbitRoadLeft(l, 1100)).toBe(100);
    expect(orbitRoadLeft(l, 1300)).toBeLessThan(0);
    expect(orbitRoadLeft({ ...l, offset: 320 }, 1000)).toBe(0);
    expect(landmarkDistanceBound(l, 900)).toBe(200);
    expect(landmarkDistanceBound(l, 1200)).toBe(300);
    expect(orbitRoadNeeded(0)).toBeGreaterThan(0);
    expect(orbitRoadNeeded(12)).toBeGreaterThan(orbitRoadNeeded(6));
  });
});
