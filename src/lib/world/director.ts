/**
 * Cinematic director for show and journey mode: picks the camera shot while
 * the rider watches something else, so the world in the corner of the eye
 * (or in the floating picture-in-picture window) looks filmed, not
 * surveilled.
 *
 * Shot list: chase, side dolly, drone orbit at landmarks, front, POV. The
 * director cuts every 20–40 s with an eased blend, holds still while the
 * rider steers or brakes, and turns towards a landmark (an orbit) when the
 * road passes one of the world's named places (manifest POIs).
 *
 * Rules (tested in director.test.ts):
 * - Never two cuts within MIN_CUT_GAP_S (15 s). The ride's first shot counts
 *   as a cut, so nothing changes in the first 15 s either.
 * - No cut while the rider steers or brakes, nor for INPUT_SETTLE_S after.
 * - An orbit is only flown within ORBIT_RADIUS_M (300 m) of a landmark. The
 *   director only starts one when the rider has enough road left inside the
 *   radius to reach the next legal cut even while speeding up
 *   (MAX_ACCEL_MS2), and leaves it ORBIT_EXIT_LEAD_S before the edge. Input
 *   wins over the radius: an orbit the rider is steering through is left at
 *   the first legal moment after the input settles.
 * - Deterministic: the same seed and the same inputs give the same shots.
 *
 * Velo has no brake sensor. "Braking" is the rider slowing hard: speed
 * falling faster than BRAKE_DECEL_MS2 (a smoothed rate), e.g. stopping
 * pedalling into a steep ramp.
 *
 * Distances to a landmark are bounded along the route: a rider at route
 * distance s is at most |s − L.distance| + L.offset metres from landmark L
 * (the road from the closest-approach point, then the POI's offset from the
 * road), so keeping that bound ≤ 300 m keeps the true distance ≤ 300 m.
 *
 * Engine-free (src/lib/world rule): no three.js, Cesium or React.
 */

export type DirectorShot = 'chase' | 'side' | 'orbit' | 'front' | 'pov';

export const DIRECTOR_SHOTS: readonly DirectorShot[] = ['chase', 'side', 'orbit', 'front', 'pov'];

/** Shortest time between two cuts, seconds. */
export const MIN_CUT_GAP_S = 15;
/** A shot lasts this long when nothing interrupts it, seconds. */
export const SHOT_MIN_S = 20;
export const SHOT_MAX_S = 40;
/** Length of the eased blend between two shots, seconds. */
export const BLEND_S = 2;
/** Quiet time after steering or braking before the director may cut again, seconds. */
export const INPUT_SETTLE_S = 2;
/** Shaped steering input (controllerStore.activeSteer) above this counts as steering. */
export const STEER_EPS = 0.02;
/** Smoothed deceleration (m/s²) that counts as braking. */
export const BRAKE_DECEL_MS2 = 1.2;
/** Time constant of the deceleration smoothing, seconds. */
export const BRAKE_TAU_S = 0.5;
/** An orbit is only flown this close to a landmark, metres. */
export const ORBIT_RADIUS_M = 300;
/**
 * Planning bound on how fast the rider speeds up during an orbit, m/s². A
 * hard sprint on a trainer or freewheeling down 6 % is about 0.5 sustained.
 */
export const MAX_ACCEL_MS2 = 0.5;
/** Leave an orbit this long before the rider would cross the radius, seconds. */
export const ORBIT_EXIT_LEAD_S = 3;
/** Extra road the orbit plan keeps in hand, metres. */
export const ORBIT_MARGIN_M = 20;

/** How likely each non-orbit shot is when a scheduled cut picks one. */
const SHOT_WEIGHTS: ReadonlyArray<[DirectorShot, number]> = [
  ['chase', 4],
  ['side', 2],
  ['front', 1.5],
  ['pov', 1],
];

/** A named place along the route (routeLandmarks): where the road passes it, and how far off the road it sits. */
export interface DirectorLandmark {
  name: string;
  /** Route distance of the road's closest approach, metres. */
  distance: number;
  /** POI's distance from the road there, metres. */
  offset: number;
}

export interface DirectorInput {
  /** Seconds, monotonic. */
  t: number;
  /** Rider's distance along the route, metres. */
  distance: number;
  /** Rider's speed, m/s. */
  speed: number;
  /** Shaped steering input, -1..1 (0 = none). */
  steer: number;
  /** Named places along the route, sorted or not. */
  landmarks: readonly DirectorLandmark[];
}

export interface DirectorFrame {
  shot: DirectorShot;
  /** The shot being blended away from; equals `shot` once the blend is done. */
  from: DirectorShot;
  /** Eased blend progress, 0 at the cut → 1 when the new shot holds alone. */
  blend: number;
  /** Seconds since the current shot started. */
  shotT: number;
  /** `t` of the last cut (or of the first frame). */
  cutAt: number;
  /** Number of cuts so far (the opening shot is not counted). */
  cuts: number;
  /** The landmark an orbit is framing; null for every other shot. */
  landmark: DirectorLandmark | null;
  /** Steering or braking (or just after): the director holds the shot. */
  suspended: boolean;
}

export interface DirectorOptions {
  seed: number;
  /** First shot (default chase). */
  opening?: DirectorShot;
}

/** Smooth start and end; 0→0, 1→1, symmetric. */
export function easeInOutCubic(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Small, fast, seeded PRNG (mulberry32): a float in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 32-bit seed for a string (FNV-1a), e.g. the route id. */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Upper bound on the rider's distance to a landmark at route distance `s`,
 * metres (see the header).
 */
export function landmarkDistanceBound(l: DirectorLandmark, s: number): number {
  return Math.abs(s - l.distance) + Math.max(0, l.offset);
}

/** Road left before the rider passes out of the landmark's orbit radius, metres (≤ 0 = outside or past it). */
export function orbitRoadLeft(l: DirectorLandmark, s: number, radius = ORBIT_RADIUS_M): number {
  const half = radius - Math.max(0, l.offset);
  if (!(half > 0)) return 0;
  if (s < l.distance - half) return 0;
  return l.distance + half - s;
}

/**
 * Road an orbit needs in hand when it starts at `speed`: enough to reach the
 * next legal cut (MIN_CUT_GAP_S, plus a second for frame timing) while
 * speeding up at MAX_ACCEL_MS2, plus a margin. After that the orbit is left
 * ORBIT_EXIT_LEAD_S before the edge.
 */
export function orbitRoadNeeded(speed: number): number {
  const v = Math.max(0, speed);
  const g = MIN_CUT_GAP_S + 1;
  return v * g + 0.5 * MAX_ACCEL_MS2 * g * g + ORBIT_MARGIN_M;
}

const landmarkKey = (l: DirectorLandmark) => `${l.name}@${Math.round(l.distance)}`;

export class Director {
  private readonly rand: () => number;
  private started = false;
  private shot: DirectorShot;
  private from: DirectorShot;
  private cutAt = 0;
  private nextCutAt = 0;
  private cuts = 0;
  private landmark: DirectorLandmark | null = null;
  private readonly visited = new Set<string>();
  private lastInputAt = -Infinity;
  private prevT = 0;
  private prevSpeed = 0;
  private prevDistance = 0;
  private decel = 0;

  constructor(opts: DirectorOptions) {
    this.rand = seededRandom(opts.seed);
    this.shot = opts.opening ?? 'chase';
    this.from = this.shot;
  }

  private shotLength(): number {
    return SHOT_MIN_S + this.rand() * (SHOT_MAX_S - SHOT_MIN_S);
  }

  private pickShot(): DirectorShot {
    const options = SHOT_WEIGHTS.filter(([s]) => s !== this.shot);
    const total = options.reduce((sum, [, w]) => sum + w, 0);
    let r = this.rand() * total;
    for (const [s, w] of options) {
      r -= w;
      if (r < 0) return s;
    }
    return options[options.length - 1][0];
  }

  private cut(t: number, to: DirectorShot, landmark: DirectorLandmark | null): void {
    this.from = this.shot;
    this.shot = to;
    this.landmark = landmark;
    this.cutAt = t;
    this.nextCutAt = t + this.shotLength();
    this.cuts += 1;
  }

  /** A landmark the rider could orbit now: inside its radius with enough road in hand. */
  private orbitCandidate(input: DirectorInput): DirectorLandmark | null {
    const need = orbitRoadNeeded(input.speed);
    let best: DirectorLandmark | null = null;
    let bestBound = Infinity;
    for (const l of input.landmarks) {
      if (this.visited.has(landmarkKey(l))) continue;
      if (orbitRoadLeft(l, input.distance) < need) continue;
      const bound = landmarkDistanceBound(l, input.distance);
      if (bound < bestBound) {
        best = l;
        bestBound = bound;
      }
    }
    return best;
  }

  /** Advance to time `input.t` and return the shot to film. */
  update(input: DirectorInput): DirectorFrame {
    const t = Number.isFinite(input.t) ? input.t : this.prevT;
    const speed = Number.isFinite(input.speed) ? Math.max(0, input.speed) : 0;
    const distance = Number.isFinite(input.distance) ? input.distance : this.prevDistance;

    if (!this.started) {
      this.started = true;
      this.cutAt = t;
      this.nextCutAt = t + this.shotLength();
      this.prevT = t;
      this.prevSpeed = speed;
      this.prevDistance = distance;
    }

    // A new lap or a restarted ride: every landmark is new again.
    if (distance < this.prevDistance - 50) this.visited.clear();

    // Braking: a smoothed rate of slowing down.
    const dt = t - this.prevT;
    if (dt > 0 && dt <= 1) {
      const decelNow = (this.prevSpeed - speed) / dt;
      const k = 1 - Math.exp(-dt / BRAKE_TAU_S);
      this.decel += (decelNow - this.decel) * k;
    } else if (dt > 1) {
      // A long gap (a backgrounded tab): start fresh rather than invent a rate.
      this.decel = 0;
    }
    if (dt > 0) {
      this.prevT = t;
      this.prevSpeed = speed;
    }
    this.prevDistance = distance;

    const steering = Math.abs(Number.isFinite(input.steer) ? input.steer : 0) > STEER_EPS;
    const braking = this.decel > BRAKE_DECEL_MS2;
    if (steering || braking) this.lastInputAt = t;
    // Held while the input lasts (lastInputAt = t) and for INPUT_SETTLE_S after.
    const suspended = t - this.lastInputAt < INPUT_SETTLE_S;
    const canCut = !suspended && t - this.cutAt >= MIN_CUT_GAP_S;

    if (canCut) {
      if (this.shot === 'orbit' && this.landmark) {
        // Leave ORBIT_EXIT_LEAD_S before the edge of the radius (or at the shot's end).
        const left = orbitRoadLeft(this.landmark, distance);
        const leaving = left < Math.max(speed, 0.1) * ORBIT_EXIT_LEAD_S || t >= this.nextCutAt;
        if (leaving) this.cut(t, this.pickShot(), null);
      } else {
        const l = this.orbitCandidate({ ...input, distance, speed });
        if (l) {
          this.visited.add(landmarkKey(l));
          this.cut(t, 'orbit', l);
        } else if (t >= this.nextCutAt) {
          this.cut(t, this.pickShot(), null);
        }
      }
    }

    const shotT = Math.max(0, t - this.cutAt);
    const blend = this.cuts === 0 ? 1 : easeInOutCubic(shotT / BLEND_S);
    return {
      shot: this.shot,
      from: blend >= 1 ? this.shot : this.from,
      blend,
      shotT,
      cutAt: this.cutAt,
      cuts: this.cuts,
      landmark: this.shot === 'orbit' ? this.landmark : null,
      suspended,
    };
  }
}

export function createDirector(opts: DirectorOptions): Director {
  return new Director(opts);
}
