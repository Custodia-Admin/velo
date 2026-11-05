/**
 * sideCamSight.ts: keeps the low side cameras (sideTracking, the cinematic
 * orbit) out of the photoreal mesh and in sight of the rider.
 *
 * Those cameras sit 3-4 m up and 9-10 m beside the rider, which is where the
 * hillside, the house fronts and the palms are. Inside the mesh the camera
 * films one flat colour (t_1ec01b75: every flat window on the Lugano shore had
 * a wall or slope 4-15 m tall at the camera spot, and the far side of the road
 * was open in most of them). Lifting the camera over the top of what is drawn
 * puts it on a roof looking into the roof (409 grey frames, reverted in
 * PR #40). So the camera does what a game camera's spring arm does: it reads
 * the top of what is drawn at a few spots on the line to the rider, moves in
 * to the farthest spot from which it sees the rider's bars over everything in
 * between, and crosses the road when its own side is closed (or it had to
 * move in close) and the other side is wide open.
 *
 * Pure and engine-free: the Cesium view passes a `topAt` callback that reads
 * the drawn top (photoreal mesh, plus the globe where it draws over it).
 */

import { AIM_HEIGHT_M } from '@/lib/world/cameraFraming';
import type { CameraPose } from '@/lib/cesiumCameras';

/**
 * Where the camera may stand and where the line to the rider is checked, as
 * fractions of the pose's offset (largest first). Three spots (plus the closest
 * offset allowed) keep the cost at three or four CPU tile reads per side and
 * refresh.
 */
export const SIGHT_FRACTIONS: readonly number[] = [1, 0.75, 0.5];
/** The camera keeps this much air over the top drawn under it (the chase clearance). */
export const SIGHT_CAMERA_CLEAR_M = 1.2;
/** The line from the camera to the rider's bars passes this far over what is drawn in between. */
export const SIGHT_LINE_CLEAR_M = 0.3;
/** Closest the camera comes to the rider (about 40 % of the frame height at 1440x900). */
export const SIGHT_MIN_OFFSET_M = 3.5;
/** A top further than this over or under the rider's ground is a coarse tile's chord, not something in the way. */
export const SIGHT_TOP_MAX_M = 60;
/** Re-read the spots at most this often (ms)... */
export const SIGHT_SAMPLE_MS = 400;
/** ...or once the rider has ridden this far (m) since the last read. */
export const SIGHT_SAMPLE_MOVE_M = 3;
/** ...or once the pose's offset has changed this much (m; the painted road's corridor rule pushes it out on bends). */
export const SIGHT_BASE_MOVE_M = 1.5;
/**
 * Spots are read where the rider will be this far ahead (s at ride speed), so
 * the camera moves in before it gets there. The lead must beat the read
 * spacing plus the time to move in: with 0.4 s (3.3 m at 30 km/h) against 3 m
 * between reads, a house corner was first read 0.3 m before the camera got
 * to it (Lugano 433 m, one flat frame).
 */
export const SIGHT_LEAD_S = 0.7;
/** Longest lead (m). */
export const SIGHT_LEAD_MAX_M = 8;
/** A read stops counting this long (ms) after it was taken (standing still, nothing newer passed). */
export const SIGHT_READ_TTL_MS = 2000;
/** Moving in eases with this time constant (s): quick, it must beat the wall. */
export const SIGHT_PULL_TAU_S = 0.1;
/** Moving back out eases with this one (s): a slow dolly. */
export const SIGHT_RELEASE_TAU_S = 1;
/** The camera crosses to a wide-open other side once it has had to move in to this fraction of its offset or closer. */
export const SIGHT_SWITCH_CLOSE = 0.5;
/** After crossing the road the camera stays on its new side this long (ms) unless that side closes completely. */
export const SIGHT_SWITCH_HOLD_MS = 8000;
/**
 * Tile reads a refresh may take in one frame. Each read is a CPU ray pick that
 * copies the hit tiles' vertex and index buffers back from the GPU
 * (Cesium3DTileset.getHeight, about 7 ms each on an iGPU). Taken all in one
 * frame, a refresh's 3-12 reads made 2-6 times as many frames over 50 ms on
 * the Lugano shore (PR #47 review), so a refresh is spread over frames.
 */
export const SIGHT_READS_PER_FRAME = 1;

const EPS = 1e-6;

/** Height (m over the rider's ground) of what is drawn at a horizontal offset; undefined = nothing drawn / unknown. */
export type SideTop = (offsetM: number) => number | undefined;

function usableTop(t: number | undefined): number | undefined {
  if (t === undefined || !Number.isFinite(t) || Math.abs(t) > SIGHT_TOP_MAX_M) return undefined;
  return t;
}

/**
 * The farthest candidate offset ({@link SIGHT_FRACTIONS} of `baseM`, not under
 * `minM`) from which a camera `upM` over the rider's ground stands clear of
 * what is drawn under it and sees the rider's bars over everything drawn at
 * the closer spots. Undefined when none does. `topAt` is called lazily, at
 * most once per spot.
 */
export function clearSightOffset(
  topAt: SideTop,
  baseM: number,
  upM: number,
  minM: number = SIGHT_MIN_OFFSET_M,
): number | undefined {
  if (!(baseM > 0) || !Number.isFinite(upM)) return undefined;
  const spots = sightSpots(baseM, minM);
  const memo = new Map<number, number | undefined>();
  const top = (x: number) => {
    if (!memo.has(x)) memo.set(x, usableTop(topAt(x)));
    return memo.get(x);
  };
  // The line to the bars is checked at the fraction spots only: the last
  // resort spot is read when the camera gets there, never on the way.
  const along = SIGHT_FRACTIONS.map((f) => f * baseM);
  for (const d of spots) {
    const under = top(d);
    if (under !== undefined && under > upM - SIGHT_CAMERA_CLEAR_M) continue;
    let seen = true;
    for (const x of along) {
      if (x >= d - EPS) continue;
      const t = top(x);
      const line = AIM_HEIGHT_M + ((upM - AIM_HEIGHT_M) * x) / d;
      if (t !== undefined && t > line - SIGHT_LINE_CLEAR_M) {
        seen = false;
        break;
      }
    }
    if (seen) return d;
  }
  return undefined;
}

/**
 * Candidate camera offsets, farthest first: {@link SIGHT_FRACTIONS} of the
 * pose's offset not under `minM`, then `minM` itself as the last resort (on
 * the Lugano shore at 202 m a 3.5-4 m wall stood 4-10 m out on one side and a
 * slope from 5 m on the other: only the road edge was clear).
 */
export function sightSpots(baseM: number, minM: number = SIGHT_MIN_OFFSET_M): number[] {
  const spots = SIGHT_FRACTIONS.map((f) => f * baseM).filter((d) => d >= minM - EPS);
  if (minM > 0 && minM <= baseM + EPS && (spots.length === 0 || spots[spots.length - 1] > minM + EPS)) spots.push(minM);
  return spots;
}

/** How far ahead (m) the spots are read at a ride speed (m/s). */
export function sightLeadM(speedMps: number): number {
  if (!Number.isFinite(speedMps) || speedMps <= 0) return 0;
  return Math.min(SIGHT_LEAD_MAX_M, speedMps * SIGHT_LEAD_S);
}

/** A camera pose at a horizontal offset (east, north) from the rider, `upM` over its ground, looking at the bars. */
export function poseLookingAtRider(x: number, y: number, upM: number, roll = 0): CameraPose {
  const horiz = Math.hypot(x, y);
  return {
    offsetENU: { x, y, z: upM },
    heading: Math.atan2(-x, -y),
    pitch: -Math.atan2(upM - AIM_HEIGHT_M, Math.max(horiz, EPS)),
    roll,
  };
}

export interface SightRequest {
  nowMs: number;
  /** Frame time (s). */
  dt: number;
  /** Rider's distance along the route (m): the spots are re-read after {@link SIGHT_SAMPLE_MOVE_M}. */
  distanceM: number;
  /** How far ahead along the route the spots are read (m, {@link sightLeadM}). */
  leadM?: number;
  /** Side the pose put the camera on (+1 right of heading, -1 left). */
  side: 1 | -1;
  /** The pose's horizontal offset from the rider (m). */
  baseM: number;
  /** Camera height over the rider's ground (m). */
  upM: number;
  /** Closest offset allowed (m, default {@link SIGHT_MIN_OFFSET_M}). */
  minM?: number;
  /** May the camera cross to the other side? (sideTracking with no painted road to keep out of.) */
  allowSwitch: boolean;
  /**
   * Top drawn at an offset on a side, `aheadM` along the rider's heading (the
   * lead, or 0 beside the rider), m over the rider's ground (undefined:
   * nothing drawn there).
   */
  topAt: (side: 1 | -1, offsetM: number, aheadM: number) => number | undefined;
}

export interface SightPlacement {
  side: 1 | -1;
  /** Horizontal offset from the rider (m), eased. */
  offsetM: number;
  /** A spot with a clear view of the rider was found on that side at the last read. */
  clear: boolean;
}

interface SightRead {
  /** Route distance the spots were read at (m). */
  at: number;
  ms: number;
  /** Offset to stand at, as a fraction of the pose offset. */
  frac: number;
}

/**
 * A refresh in progress. Its spots stay where they were when it started (the
 * route distance, the lead, the pose's offset and height), however far the
 * rider rides while the reads are spread over frames.
 */
interface SightJob {
  /** Route distance the refresh started at (m). */
  at: number;
  lead: number;
  side: 1 | -1;
  baseM: number;
  upM: number;
  minM: number;
  allowSwitch: boolean;
  /** Spots read so far, keyed by side, ahead / beside and offset. */
  tops: Map<string, number | undefined>;
  /** Route distance the other side was first read beside the rider at (m). */
  besideAt: number | undefined;
  /** The camera's own side has been read (and its read put in the history). */
  hereDone: boolean;
  here: number | undefined;
  /** The other side is being read for a cut across the road. */
  cross: boolean;
}

/** Thrown by a refresh's reader once this frame's reads are spent (caught in update). */
const READS_SPENT = Symbol('sight reads spent');

/**
 * Per-view state: refresh throttle, eased offset, the side it crossed to.
 * Each read stands for the stretch of road from where it was taken to the
 * next read; the camera stands at the nearest offset asked for over the
 * stretch from where it is now up to the lead, so a wall read ahead holds it
 * in until it has ridden past.
 *
 * A refresh takes 3 reads on open ground and up to 12 when it has to move in
 * and look across the road; it takes at most {@link SIGHT_READS_PER_FRAME} of
 * them per frame and finishes over the next frames.
 */
export function createSideCamSight() {
  let lastMs = -Infinity;
  let lastDist = NaN;
  let lastBase = NaN;
  let lastPoseSide: 1 | -1 | null = null;
  let side: 1 | -1 | null = null;
  let history: SightRead[] = [];
  let targetFrac = 1;
  let frac: number | null = null;
  let clear = true;
  let switchedAt = -Infinity;
  let switches = 0;
  let reads = 0;
  let job: SightJob | null = null;

  /**
   * Carry the refresh on with this frame's reads. True once it is done;
   * false when the reads ran out first (it goes on next frame). `cut` is
   * set when it crossed the road.
   */
  function work(j: SightJob, req: SightRequest): { done: boolean; cut: boolean } {
    let budget = SIGHT_READS_PER_FRAME;
    // Spots at the lead stay where the refresh started them; the ones beside
    // the rider (for a cut) are where the rider was when they were first read.
    const read = (s: 1 | -1, beside: boolean) =>
      clearSightOffset(
        (x) => {
          const key = `${s} ${beside ? 'beside' : 'lead'} ${x}`;
          if (j.tops.has(key)) return j.tops.get(key);
          if (budget <= 0) throw READS_SPENT;
          budget--;
          reads++;
          if (beside) j.besideAt ??= req.distanceM;
          const at = beside ? (j.besideAt ?? req.distanceM) : j.at + j.lead;
          const top = req.topAt(s, x, at - req.distanceM);
          j.tops.set(key, top);
          return top;
        },
        j.baseM,
        j.upM,
        j.minM,
      );
    try {
      const full = j.baseM - EPS;
      if (!j.hereDone) {
        j.here = read(j.side, false);
        j.hereDone = true;
        clear = j.here !== undefined;
        // Nothing clear: stand at the closest spot allowed (the road edge;
        // walls and slopes rise away from the road), the lift does the rest.
        const spots = sightSpots(j.baseM, j.minM);
        const closest = spots.length ? spots[spots.length - 1] : j.baseM;
        history.push({ at: j.at + j.lead, ms: req.nowMs, frac: (j.here ?? closest) / j.baseM });
        // Crossing the road is a cut: do it when this side is closed, or when
        // the camera had to move in close and the other side is wide open
        // (on the Lugano shore that gave 19 cuts in 300 s, against 39 when any
        // move-in crossed and 13 when only a closed side did, with twice the
        // time spent close in).
        const close = SIGHT_SWITCH_CLOSE * j.baseM + EPS;
        const held = req.nowMs - switchedAt < SIGHT_SWITCH_HOLD_MS;
        j.cross = j.allowSwitch && (j.here === undefined || (j.here <= close && !held));
      }
      if (!j.cross) return { done: true, cut: false };
      const other = (j.side === 1 ? -1 : 1) as 1 | -1;
      const there = read(other, false);
      // The cut puts the camera across the road now, beside the rider,
      // where the other side was never read: it must be open there too
      // (Lugano 479 m: open ahead, a 3.5 m hedge beside, 4 flat frames).
      const beside = there !== undefined && (j.here === undefined || there >= full) ? read(other, true) : undefined;
      if (there === undefined || beside === undefined || (j.here !== undefined && beside < full)) {
        return { done: true, cut: false };
      }
      side = other;
      switchedAt = req.nowMs;
      switches++;
      clear = true;
      history = [
        { at: j.besideAt ?? j.at, ms: req.nowMs, frac: beside / j.baseM },
        { at: j.at + j.lead, ms: req.nowMs, frac: there / j.baseM },
      ];
      return { done: true, cut: true };
    } catch (e) {
      if (e === READS_SPENT) return { done: false, cut: false };
      throw e;
    }
  }

  return {
    update(req: SightRequest): SightPlacement {
      const minM = req.minM ?? SIGHT_MIN_OFFSET_M;
      const poseSideMoved = req.side !== lastPoseSide;
      lastPoseSide = req.side;
      // Without crossing, or when the pose itself moved sides (the painted
      // road's corridor rule), the pose decides the side.
      if (side === null || !req.allowSwitch || poseSideMoved) {
        if (side !== null && side !== req.side) {
          // A new side: its spots were never read. Read them now and stand at
          // the pose's offset until they are in.
          history = [];
          frac = null;
          job = null;
          lastMs = -Infinity;
        }
        side = req.side;
      }
      // No crossing any more (the painted road is drawn now): the far side's reads are moot.
      if (job !== null && job.cross && !req.allowSwitch) job = null;
      const due =
        req.nowMs - lastMs >= SIGHT_SAMPLE_MS ||
        !(Math.abs(req.distanceM - lastDist) < SIGHT_SAMPLE_MOVE_M) ||
        !(Math.abs(req.baseM - lastBase) < SIGHT_BASE_MOVE_M);
      if (job === null && due) {
        lastMs = req.nowMs;
        lastDist = req.distanceM;
        lastBase = req.baseM;
        job = {
          at: req.distanceM,
          lead: Math.max(0, req.leadM ?? 0),
          side,
          baseM: req.baseM,
          upM: req.upM,
          minM,
          allowSwitch: req.allowSwitch,
          tops: new Map(),
          besideAt: undefined,
          hereDone: false,
          here: undefined,
          cross: false,
        };
      }
      let cut = false;
      if (job !== null) {
        const r = work(job, req);
        cut = r.cut;
        if (r.done) job = null;
      }
      // A read stands for the stretch from where it was taken to the next
      // one: drop it once the camera has passed the next read too.
      history = history.filter((r) => req.nowMs - r.ms <= SIGHT_READ_TTL_MS);
      while (history.length > 1 && history[1].at <= req.distanceM) history.shift();
      if (history.length) targetFrac = Math.min(...history.map((r) => r.frac));
      // While the other side is being read for a cut the camera holds still:
      // a dolly in cut short by a cut a few frames later only shakes the shot.
      const crossing = job !== null && job.cross;
      const dt = Math.max(0, Math.min(req.dt, 0.25));
      if (cut || (frac === null && history.length && !crossing)) {
        frac = targetFrac;
      } else if (frac !== null && !crossing) {
        const tau = targetFrac < frac ? SIGHT_PULL_TAU_S : SIGHT_RELEASE_TAU_S;
        frac += (targetFrac - frac) * (1 - Math.exp(-dt / tau));
      }
      // Until the first read is in, the pose's own offset.
      return { side, offsetM: (frac ?? 1) * req.baseM, clear };
    },
    reset() {
      lastMs = -Infinity;
      lastDist = NaN;
      lastBase = NaN;
      lastPoseSide = null;
      side = null;
      history = [];
      targetFrac = 1;
      frac = null;
      clear = true;
      switchedAt = -Infinity;
      job = null;
    },
    /** Times the camera has cut across the road: the view drops the old side's lift on a new one. */
    cuts(): number {
      return switches;
    },
    /** Read-only numbers for probes (__veloRideDebug().sideCam). */
    debug() {
      return { side, frac, targetFrac, clear, switches, reads, ahead: history.length, pending: job !== null };
    },
  };
}
