/**
 * The side / orbit camera's sight over the photoreal mesh (t_1ec01b75).
 *
 * Profiles are real readings from a sideTracking ride on the Lugano shore
 * (main + PR #40, cat-bed): the top of what is drawn, metres over the rider's
 * ground, 1..14 m out on the camera's side and on the other side, at each
 * spot where the camera filmed a flat frame.
 */
import { describe, expect, it } from 'vitest';

import { computeCameraPose, riderAimPitchRad, SIDE_TRACK_OFFSET_M, SIDE_TRACK_UP_M } from '@/lib/cesiumCameras';
import {
  clearSightOffset,
  createSideCamSight,
  poseLookingAtRider,
  SIGHT_LEAD_MAX_M,
  SIGHT_MIN_OFFSET_M,
  SIGHT_PULL_TAU_S,
  SIGHT_RELEASE_TAU_S,
  SIGHT_SAMPLE_MOVE_M,
  SIGHT_SAMPLE_MS,
  SIGHT_SWITCH_HOLD_MS,
  sightLeadM,
  sightSpots,
  type SightRequest,
} from '@/lib/sideCamSight';

const BASE = SIDE_TRACK_OFFSET_M; // 9 m
const UP = SIDE_TRACK_UP_M; // 3.2 m

/** Lugano–Melide readings (m over the rider's ground at 1..14 m out). */
const LUGANO = {
  // 193 m: slope from 6 m on the camera's side; a 3.3-4.7 m wall 4-10 m out across the road.
  d193: {
    cam: [0.1, 0.1, 0.2, 0.2, 0.2, 9.5, 11.5, 13.1, 14.2, 14.5, 14.6, 14.9, 15.1, 15.2],
    other: [0, 0, -0.1, 4.4, 4.7, 4.6, 4.5, 3.9, 3.3, 3.2, 0, 0, 0, 0],
  },
  // 202 m (14 flat frames): slope from 5 m; the same wall across the road.
  d202: {
    cam: [0, 0, 0, 0, 10.3, 11.4, 12.7, 13.5, 13.8, 13.9, 14.3, 14.7, 14.9, 15],
    other: [-0.1, -0.1, -0.2, 3.5, 4, 3.8, 3.5, 3.4, 3.6, 3.4, 0.9, -0.2, -0.3, -0.4],
  },
  // 1398 m: a slope from 8 m on the camera's side, the lake side open.
  d1398: {
    cam: [0, 0, 0, 0, 0, 0, 0, 0.7, 6.8, 12, 11.1, 11.1, 30.3, 30.3],
    other: [0, 0, 0, 0, 0, -0.1, -0.1, -0.1, -0.1, -0.2, -0.2, -0.2, -0.2, -0.2],
  },
  // 2032 m: a house front 3 m from the rider; the other side open.
  d2032: {
    cam: [0, 0.1, 11.5, 13.7, 13.9, 13.7, 13.8, 13.4, 14.2, 12.8, 9.6, 10, 14.7, 14.2],
    other: [0, 0, 0, 0, 0, 1.2, 2, 0, 0.1, 0.1, 0.1, 0.1, 0.2, 0.3],
  },
  // 1888 m: a 6-8 m bank 4-9 m out, lower again past 10 m.
  d1888: {
    cam: [-0.1, 0, 0.4, 6.2, 8.3, 8.3, 8.2, 7.7, 6.7, 1.4, 1.4, 1.4, 1.4, 1.5],
    other: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.3, 0.4, 0.4, 1.1, 1.4, 0, 0, 0],
  },
};

/** Top at an offset from a 1 m profile, linear between readings. */
function profile(tops: readonly number[]) {
  return (x: number): number | undefined => {
    const k = Math.min(Math.max(x, 1), tops.length);
    const lo = Math.floor(k);
    const hi = Math.min(lo + 1, tops.length);
    const w = k - lo;
    return tops[lo - 1] * (1 - w) + tops[hi - 1] * w;
  };
}

const flat = () => 0;

describe('clearSightOffset: the farthest spot that sees the rider over what is drawn', () => {
  it('open ground: the camera stays at its full offset after reading three spots', () => {
    const read: number[] = [];
    expect(clearSightOffset((x) => (read.push(x), 0), BASE, UP)).toBe(BASE);
    expect(read).toEqual([9, 6.75, 4.5]);
  });

  it('a slope from 6 m (Lugano 193 m): moves in to half its offset', () => {
    expect(clearSightOffset(profile(LUGANO.d193.cam), BASE, UP)).toBe(4.5);
    // Across the road a 4 m wall stands 4-10 m out (rising from 3 m): closed.
    expect(clearSightOffset(profile(LUGANO.d193.other), BASE, UP)).toBeUndefined();
  });

  it('slope from 5 m and a wall across the road (Lugano 202 m): the road edge', () => {
    expect(clearSightOffset(profile(LUGANO.d202.cam), BASE, UP)).toBe(SIGHT_MIN_OFFSET_M);
    expect(clearSightOffset(profile(LUGANO.d202.other), BASE, UP)).toBe(SIGHT_MIN_OFFSET_M);
  });

  it('a house front 3 m out (Lugano 2032 m): nowhere on that side; the open side at full offset', () => {
    expect(clearSightOffset(profile(LUGANO.d2032.cam), BASE, UP)).toBeUndefined();
    expect(clearSightOffset(profile(LUGANO.d2032.other), BASE, UP)).toBe(BASE);
  });

  it('a camera spot clear of the top under it still needs the line to the bars', () => {
    // 2.5 m hedge 6.75 m out, open ground under the camera at 9 m.
    const hedge = (x: number) => (Math.abs(x - 6.75) < 0.01 ? 2.5 : 0);
    expect(clearSightOffset(hedge, BASE, UP)).toBe(4.5);
    // A 2 m wall half way is seen over (the line passes 2.1 m up there).
    const wall = (x: number) => (Math.abs(x - 4.5) < 0.01 ? 1.7 : 0);
    expect(clearSightOffset(wall, BASE, UP)).toBe(BASE);
    // A 2 m one hides the bars from 9 m; from 6.75 m the line passes 2.17 m up over it.
    const higher = (x: number) => (Math.abs(x - 4.5) < 0.01 ? 2 : 0);
    expect(clearSightOffset(higher, BASE, UP)).toBe(6.75);
  });

  it('the camera keeps 1.2 m of air over the top under it', () => {
    expect(clearSightOffset((x) => (x === BASE ? 2.0 : 0), BASE, UP)).toBe(BASE);
    expect(clearSightOffset((x) => (x === BASE ? 2.05 : 0), BASE, UP)).toBe(6.75);
  });

  it('nothing drawn (no tile) is clear; coarse chords far over or under the ground are ignored', () => {
    expect(clearSightOffset(() => undefined, BASE, UP)).toBe(BASE);
    expect(clearSightOffset(() => 505.7, BASE, UP)).toBe(BASE);
    expect(clearSightOffset(() => -27_979, BASE, UP)).toBe(BASE);
    expect(clearSightOffset(() => Number.NaN, BASE, UP)).toBe(BASE);
    expect(clearSightOffset(() => 59, BASE, UP)).toBeUndefined();
  });

  it('reads each spot once at most', () => {
    const read: number[] = [];
    clearSightOffset((x) => (read.push(x), profile(LUGANO.d2032.cam)(x)), BASE, UP);
    expect(new Set(read).size).toBe(read.length);
    expect(read.sort()).toEqual([3.5, 4.5, 6.75, 9].sort());
  });

  it('spots: fractions of the offset not under the minimum, then the minimum', () => {
    expect(sightSpots(9)).toEqual([9, 6.75, 4.5, 3.5]);
    expect(sightSpots(9 * 0.7)).toEqual([6.3, 4.725, 3.5].map((v) => expect.closeTo(v, 9)));
    // With the painted road drawn the camera stays outside its corridor (4.5 m).
    expect(sightSpots(9, 4.5)).toEqual([9, 6.75, 4.5]);
    expect(sightSpots(16.2, 4.5)).toEqual([16.2, 12.15, 8.1, 4.5].map((v) => expect.closeTo(v, 9)));
    expect(sightSpots(3)).toEqual([]);
  });
});

describe('poseLookingAtRider', () => {
  it('is the sideTracking pose on either side at full offset', () => {
    for (const heading of [0, 0.7, 2.4, -1.9]) {
      const rider = { lat: 46, lon: 8.95, ele: 300, heading, cadence: 85, speed: 8 };
      const p = computeCameraPose('sideTracking', rider, 0);
      const q = poseLookingAtRider(p.offsetENU.x, p.offsetENU.y, p.offsetENU.z);
      const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
      expect(wrap(q.heading - p.heading)).toBeCloseTo(0, 9);
      expect(q.pitch).toBeCloseTo(p.pitch, 9);
      const m = poseLookingAtRider(-p.offsetENU.x, -p.offsetENU.y, p.offsetENU.z);
      expect(wrap(m.heading - p.heading - Math.PI)).toBeCloseTo(0, 9);
    }
  });

  it('aims at the bars from closer in', () => {
    const p = poseLookingAtRider(4.5, 0, UP);
    expect(p.heading).toBeCloseTo(-Math.PI / 2, 9); // camera east of the rider looks west
    expect(p.pitch).toBeCloseTo(riderAimPitchRad(UP, 4.5), 9);
  });
});

describe('sightLeadM', () => {
  it('reads 0.7 s ahead, at most 8 m', () => {
    expect(sightLeadM(0)).toBe(0);
    expect(sightLeadM(-3)).toBe(0);
    expect(sightLeadM(Number.NaN)).toBe(0);
    expect(sightLeadM(8.3)).toBeCloseTo(5.81, 9);
    expect(sightLeadM(30)).toBe(8);
    expect(SIGHT_LEAD_MAX_M).toBe(8);
  });
});

/** Long enough (ms at 60 fps) for the longest refresh: twelve reads, one a frame. */
const REFRESH_MS = 220;

type Side = (x: number, at: number) => number | undefined;
type World = { right: Side; left: Side };

function rig(world: World, opts: Partial<SightRequest> = {}) {
  const sight = createSideCamSight();
  let reads = 0;
  let t = 0;
  let dist = 0;
  const req = (over: Partial<SightRequest> = {}): SightRequest => {
    const r: SightRequest = {
      nowMs: t,
      dt: 1 / 60,
      distanceM: dist,
      side: 1,
      baseM: BASE,
      upM: UP,
      allowSwitch: true,
      topAt: (side, x, ahead) => {
        reads++;
        // The world is read where the spots are: the rider's distance plus how far ahead.
        const at = r.distanceM + ahead;
        return side === 1 ? world.right(x, at) : world.left(x, at);
      },
      ...opts,
      ...over,
    };
    return r;
  };
  return {
    sight,
    reads: () => reads,
    dist: () => dist,
    /** Advance `ms` at 60 fps riding `mps`, returning the last placement. */
    run(ms: number, mps = 8, over: Partial<SightRequest> = {}) {
      let last = sight.update(req(over));
      for (let e = 0; e < ms; e += 1000 / 60) {
        t += 1000 / 60;
        dist += mps / 60;
        last = sight.update(req(over));
      }
      return last;
    },
  };
}

describe('createSideCamSight: moving in, crossing the road, easing', () => {
  it('open on both sides: full offset on the side the pose chose, three reads per refresh', () => {
    const r = rig({ right: flat, left: flat });
    const p = r.run(2050, 0);
    expect(p).toEqual({ side: 1, offsetM: BASE, clear: true });
    // Standing still: one refresh per SIGHT_SAMPLE_MS.
    expect(r.reads()).toBe(3 * (Math.floor(2050 / SIGHT_SAMPLE_MS) + 1));
  });

  it('refreshes after riding SIGHT_SAMPLE_MOVE_M', () => {
    const r = rig({ right: flat, left: flat });
    r.run(SIGHT_SAMPLE_MS - 50, 20); // 20 m/s: 7 m in 350 ms
    const refreshes = r.reads() / 3;
    expect(refreshes).toBeGreaterThanOrEqual(Math.floor(7 / SIGHT_SAMPLE_MOVE_M));
  });

  it('a slope on its side, a wall across the road: moves in fast, eases back out slowly', () => {
    const world: World = { right: flat, left: profile(LUGANO.d193.other) };
    const r = rig(world);
    expect(r.run(1000).offsetM).toBe(BASE);
    // The slope comes into the next read (at most 400 ms away); 300 ms later
    // the camera is within 6 % of the spot it moves to.
    world.right = profile(LUGANO.d193.cam);
    const inP = r.run(400 + 3 * SIGHT_PULL_TAU_S * 1000);
    expect(inP.side).toBe(1);
    expect(inP.offsetM).toBeLessThan(4.5 + 0.06 * (BASE - 4.5));
    world.right = flat;
    // Released once a clear read is passed, then a slow dolly out (tau 1 s).
    const early = r.run(SIGHT_SAMPLE_MS * 2 + 50);
    expect(early.offsetM).toBeLessThan(4.5 + 0.55 * (BASE - 4.5));
    const late = r.run(5 * SIGHT_RELEASE_TAU_S * 1000);
    expect(late.offsetM).toBeGreaterThan(BASE - 0.05);
  });

  it('crosses the road when its side is closed and the other is open (Lugano 2032 m): a cut', () => {
    const r = rig({ right: profile(LUGANO.d2032.cam), left: profile(LUGANO.d2032.other) });
    // Ten reads (four on its side, three across ahead, three across beside), one a frame.
    const p = r.run(REFRESH_MS);
    expect(p).toEqual({ side: -1, offsetM: BASE, clear: true });
    expect(r.sight.debug().switches).toBe(1);
  });

  it('crosses to a wide-open side once it had to move in to half its offset (Lugano 1398 m: no)', () => {
    // 1398 m: the slope starts at 8 m, so the camera only moves in to 6.75 m and stays.
    const keep = rig({ right: profile(LUGANO.d1398.cam), left: profile(LUGANO.d1398.other) });
    expect(keep.run(1000)).toMatchObject({ side: 1, clear: true });
    expect(keep.run(1000).offsetM).toBeCloseTo(6.75, 1);
    // 193 m with the far side open: crosses.
    const cross = rig({ right: profile(LUGANO.d193.cam), left: flat });
    expect(cross.run(REFRESH_MS)).toEqual({ side: -1, offsetM: BASE, clear: true });
  });

  it('crossing is a cut: the moved-in camera stands at full offset across the road at once', () => {
    // Moved in to 4.5 m with the far side walled; then the far side opens.
    const world: World = { right: profile(LUGANO.d193.cam), left: profile(LUGANO.d193.other) };
    const r = rig(world);
    expect(r.run(1500).offsetM).toBeCloseTo(4.5, 2);
    world.left = flat;
    const p = r.run(SIGHT_SAMPLE_MS + 20);
    expect(p.side).toBe(-1);
    expect(p.offsetM).toBe(BASE);
  });

  it('does not cut across to a side that is only partly open', () => {
    // Moved in to 4.5 m; the other side is clear only from 6.75 m in.
    const r = rig({ right: profile(LUGANO.d193.cam), left: profile(LUGANO.d1398.cam) });
    const p = r.run(2000);
    expect(p.side).toBe(1);
    expect(p.offsetM).toBeCloseTo(4.5, 2);
    expect(r.sight.debug().switches).toBe(0);
  });

  it('stays on its side without allowSwitch (orbit, or the painted road deciding)', () => {
    const r = rig({ right: profile(LUGANO.d2032.cam), left: flat }, { allowSwitch: false });
    const p = r.run(1000);
    expect(p.side).toBe(1);
    expect(p.clear).toBe(false);
    // Nothing clear: the closest spot allowed.
    expect(p.offsetM).toBeCloseTo(SIGHT_MIN_OFFSET_M, 2);
  });

  it('holds its new side for a while unless that side closes', () => {
    const world: World = { right: profile(LUGANO.d2032.cam), left: flat };
    const r = rig(world);
    expect(r.run(REFRESH_MS).side).toBe(-1);
    // The new side now needs moving in to half its offset; the old side is open.
    world.left = profile(LUGANO.d193.cam);
    world.right = flat;
    // Held 8 s (an absolute pin: 39 cuts in 300 s on the Lugano shore with no hold).
    expect(SIGHT_SWITCH_HOLD_MS).toBe(8000);
    expect(r.run(7400).side).toBe(-1);
    expect(r.run(1200).side).toBe(1);
    expect(r.sight.debug().switches).toBe(2);
    // Closed outright: crosses back at once.
    world.right = profile(LUGANO.d2032.cam);
    world.left = flat;
    expect(r.run(SIGHT_SAMPLE_MS + REFRESH_MS).side).toBe(-1);
  });

  it('a wall read ahead holds the camera in until it has ridden past it', () => {
    // A slope beside the road from 50 m to 60 m along it; the far side walled.
    const slope = profile(LUGANO.d193.cam);
    const world: World = {
      right: (x, at) => (at >= 50 && at <= 60 ? slope(x) : 0),
      left: profile(LUGANO.d202.other),
    };
    const r = rig(world, { leadM: 5.6, allowSwitch: false });
    const inner = 4.5 + 0.06 * (BASE - 4.5);
    r.run((44 / 8) * 1000);
    expect(r.dist()).toBeCloseTo(44, 0);
    expect(r.run(0).offsetM).toBe(BASE);
    // In by the time it reaches the slope...
    r.run((6 / 8) * 1000);
    expect(r.run(0).offsetM).toBeLessThan(inner);
    // ...and held in all along it, though the reads ahead are clear from 54.4 m on.
    for (let d = 51; d <= 60; d += 1) expect(r.run(125).offsetM).toBeLessThan(inner);
    // Past it (and one more read): back out.
    r.run((3 / 8) * 1000);
    expect(r.run(1500).offsetM).toBeGreaterThan(BASE - 0.15 * (BASE - 4.5));
  });

  it('does not cut to a side that is open ahead but closed beside the rider (Lugano 479 m)', () => {
    // Its own side walled from 4 m out (the 26 m house front); across the road
    // a 3.5 m hedge 5-7 m out that ends 2 m ahead of the rider.
    const hedge = (x: number) => (x >= 5 && x <= 7 ? 3.5 : 0);
    const world: World = {
      right: (x) => (x >= 4 ? 26 : 0),
      left: (x, at) => (at < 2 ? hedge(x) : 0),
    };
    const r = rig(world, { leadM: 5.6 });
    // A whole refresh (all eleven reads) with the rider still short of the hedge's end.
    const p = r.run(REFRESH_MS);
    expect(r.sight.debug().pending).toBe(false);
    expect(r.dist()).toBeLessThan(2);
    expect(p.side).toBe(1);
    expect(r.sight.cuts()).toBe(0);
    // Ridden past the hedge's end, the other side is open beside the rider too: cut.
    r.run(1000, 4);
    expect(r.run(0).side).toBe(-1);
    expect(r.run(0).offsetM).toBe(BASE);
  });

  it('moved in close, it does not cut to a side that is open beside the rider but only partly open ahead', () => {
    const world: World = {
      right: (x) => (x >= 4 ? 26 : 0),
      left: (x, at) => (at >= 3 && x > 8 ? 9 : 0),
    };
    const r = rig(world, { leadM: 5.6 });
    expect(r.run(REFRESH_MS).side).toBe(1);
    expect(r.sight.debug().pending).toBe(false);
    expect(r.sight.cuts()).toBe(0);
  });

  it('a cut holds the camera at what it read beside the rider until it passes the lead', () => {
    // Closed on its own side; across the road open ahead, half open beside the
    // rider (for the first 3 m: the spots beside it are read a few frames into
    // the refresh, where it has ridden to by then).
    const world: World = {
      right: profile(LUGANO.d2032.cam),
      left: (x, at) => (at < 3 && x > 6 ? 9 : 0),
    };
    const r = rig(world, { leadM: 5.6 });
    const p = r.run(REFRESH_MS);
    expect(p.side).toBe(-1);
    expect(p.offsetM).toBeCloseTo(0.5 * BASE, 9);
  });

  it('both sides closed (Lugano 202 m at 9 m out): the road edge on its own side', () => {
    const r = rig({ right: profile(LUGANO.d202.cam), left: profile(LUGANO.d202.other) });
    const p = r.run(1000);
    expect(p.side).toBe(1);
    expect(p.offsetM).toBeCloseTo(SIGHT_MIN_OFFSET_M, 2);
    expect(p.clear).toBe(true);
  });

  it("follows the pose when the pose moves sides (the painted road's corridor rule)", () => {
    const r = rig({ right: flat, left: flat }, { allowSwitch: false });
    expect(r.run(100).side).toBe(1);
    expect(r.run(100, 8, { side: -1 }).side).toBe(-1);
  });

  it('reads expire after 2 s (the route distance jumped back: Ride again)', () => {
    const world: World = { right: profile(LUGANO.d193.cam), left: profile(LUGANO.d193.other) };
    const r = rig(world, { leadM: 5.6, allowSwitch: false });
    r.run(3000);
    expect(r.run(0).offsetM).toBeCloseTo(4.5, 1);
    // Back to the start, standing, open ground: the old reads lie ahead of it.
    world.right = flat;
    const stuck = r.run(1500, 0, { distanceM: 0, leadM: 0 });
    expect(stuck.offsetM).toBeLessThan(6);
    expect(r.run(2500, 0, { distanceM: 0, leadM: 0 }).offsetM).toBeGreaterThan(8);
  });

  it('cuts() counts the cuts across the road', () => {
    const world: World = { right: profile(LUGANO.d2032.cam), left: flat };
    const r = rig(world);
    expect(r.sight.cuts()).toBe(0);
    r.run(REFRESH_MS);
    expect(r.sight.cuts()).toBe(1);
    world.left = profile(LUGANO.d2032.cam);
    world.right = flat;
    r.run(SIGHT_SAMPLE_MS + REFRESH_MS);
    expect(r.sight.cuts()).toBe(2);
  });

  it('reset starts over at full offset on the pose side', () => {
    const r = rig({ right: profile(LUGANO.d193.cam), left: profile(LUGANO.d193.other) });
    expect(r.run(500).offsetM).toBeLessThan(5);
    r.sight.reset();
    const d = r.sight.debug();
    expect(d.side).toBeNull();
    expect(d.frac).toBeNull();
  });

  it('a bank 4-9 m out (Lugano 1888 m): the road edge, or the open side', () => {
    const r = rig({ right: profile(LUGANO.d1888.cam), left: profile(LUGANO.d1888.other) });
    expect(r.run(REFRESH_MS)).toEqual({ side: -1, offsetM: BASE, clear: true });
  });
});

describe('createSideCamSight: one tile read a frame', () => {
  /** A sight driven at 60 fps riding `mps`, counting the tile reads each update() takes. */
  function counted(world: World, opts: Partial<SightRequest> = {}) {
    const sight = createSideCamSight();
    let t = 0;
    let dist = 0;
    let calls = 0;
    const perUpdate: number[] = [];
    const spots: Array<{ side: 1 | -1; x: number; at: number; frame: number }> = [];
    const step = (mps: number, over: Partial<SightRequest> = {}) => {
      calls = 0;
      const frame = perUpdate.length;
      const req: SightRequest = {
        nowMs: t,
        dt: 1 / 60,
        distanceM: dist,
        side: 1,
        baseM: BASE,
        upM: UP,
        allowSwitch: true,
        topAt: (side, x, ahead) => {
          calls++;
          const at = req.distanceM + ahead;
          spots.push({ side, x, at, frame });
          return side === 1 ? world.right(x, at) : world.left(x, at);
        },
        ...opts,
        ...over,
      };
      const p = sight.update(req);
      perUpdate.push(calls);
      t += 1000 / 60;
      dist += mps / 60;
      return p;
    };
    return { sight, step, perUpdate, spots, dist: () => dist };
  }

  it('a refresh that needs ten reads takes ten frames, never two reads in one', () => {
    // Its own side closed (4 reads), the far side open ahead (3) and beside the rider (3).
    const c = counted({ right: profile(LUGANO.d2032.cam), left: profile(LUGANO.d2032.other) });
    const placed = [];
    for (let f = 0; f < 10; f++) placed.push(c.step(8));
    expect(c.perUpdate).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    // Held on its side at full offset while its spots and the far side's are
    // read (closed from the fourth read on), then the cut on the tenth frame.
    for (const p of placed.slice(0, 9)) expect(p).toMatchObject({ side: 1, offsetM: BASE });
    expect(placed.slice(3, 9).map((p) => p.clear)).toEqual([false, false, false, false, false, false]);
    expect(placed[9]).toEqual({ side: -1, offsetM: BASE, clear: true });
    expect(c.sight.cuts()).toBe(1);
    expect(c.sight.debug().pending).toBe(false);
  });

  it('at 15 fps a ten-read refresh outlasts the refresh interval and still finishes (it is not restarted)', () => {
    const world: World = { right: profile(LUGANO.d2032.cam), left: profile(LUGANO.d2032.other) };
    const sight = createSideCamSight();
    let reads = 0;
    const sides: number[] = [];
    for (let f = 0; f < 12; f++) {
      const t = (f * 1000) / 15;
      const dist = (f * 8) / 15;
      const p = sight.update({
        nowMs: t,
        dt: 1 / 15,
        distanceM: dist,
        side: 1,
        baseM: BASE,
        upM: UP,
        allowSwitch: true,
        topAt: (side, x, ahead) => {
          reads++;
          return side === 1 ? world.right(x, dist + ahead) : world.left(x, dist + ahead);
        },
      });
      sides.push(p.side);
    }
    // 667 ms for the ten reads, past the 400 ms refresh interval: the cut on the tenth frame.
    expect(sides.indexOf(-1)).toBe(9);
    expect(reads).toBeGreaterThanOrEqual(10);
    expect(sight.cuts()).toBe(1);
  });

  it('riding past walls, hedges and open ground for 30 s: at most one read in any frame', () => {
    const slope = profile(LUGANO.d193.cam);
    const bank = profile(LUGANO.d1888.cam);
    const c = counted({
      right: (x, at) => (at % 60 < 15 ? slope(x) : at % 60 < 30 ? bank(x) : at % 60 < 40 ? (x >= 4 ? 26 : 0) : 0),
      left: (x, at) => (at % 45 < 20 ? profile(LUGANO.d202.other)(x) : 0),
    }, { leadM: 5.6 });
    for (let f = 0; f < 30 * 60; f++) c.step(8);
    expect(Math.max(...c.perUpdate)).toBe(1);
    // Busy: it read in more than one frame in six, and crossed the road.
    expect(c.perUpdate.filter((n) => n > 0).length).toBeGreaterThan(300);
    expect(c.sight.cuts()).toBeGreaterThan(1);
  });

  it("a refresh's spots stay where it started, however far the rider rides meanwhile", () => {
    // A 2.5 m hedge 4.5 m out across 20 cm of road, right where the refresh's
    // lead puts its spots (5.6 m on); the rider rides 13 cm a frame.
    const hedge = (x: number, at: number) => (at > 5.5 && at < 5.7 && Math.abs(x - 4.5) < 0.01 ? 2.5 : 0);
    const c = counted({ right: hedge, left: flat }, { leadM: 5.6, allowSwitch: false });
    let p = c.step(8);
    for (let f = 0; f < 30; f++) p = c.step(8);
    const first = c.spots.filter((s) => s.frame < 4);
    expect(first.map((s) => s.x)).toEqual([9, 6.75, 4.5, 3.5]);
    for (const s of first) expect(s.at).toBeCloseTo(5.6, 9);
    // The hedge hides the bars from 9 m and 6.75 m and stands under 4.5 m: the road edge.
    expect(p.offsetM).toBeCloseTo(SIGHT_MIN_OFFSET_M, 2);
  });

  it('the spots beside the rider for a cut are where it rides when they are read', () => {
    const c = counted({ right: profile(LUGANO.d2032.cam), left: flat }, { leadM: 5.6 });
    for (let f = 0; f < 12; f++) c.step(8);
    const beside = c.spots.filter((s) => s.side === -1 && s.at < 5);
    expect(beside.map((s) => s.x)).toEqual([9, 6.75, 4.5]);
    // First read on frame 7, 0.93 m on; all three there.
    expect(beside[0].frame).toBe(7);
    for (const s of beside) expect(s.at).toBeCloseTo((7 * 8) / 60, 9);
  });
});

describe('createSideCamSight: the first read, and crossing turned off', () => {
  it('the first read is a snap, not a dolly in', () => {
    // A slope from 6 m (Lugano 193 m): three reads say 4.5 m.
    const r = rig({ right: profile(LUGANO.d193.cam), left: flat }, { allowSwitch: false });
    const p = r.run(34);
    expect(r.reads()).toBe(3);
    expect(p.offsetM).toBeCloseTo(4.5, 9);
  });

  it('a long frame (the tab back from the background) dollies out a quarter second, not all the way', () => {
    const world: World = { right: profile(LUGANO.d193.cam), left: flat };
    const r = rig(world, { allowSwitch: false });
    expect(r.run(1500).offsetM).toBeCloseTo(4.5, 2);
    world.right = flat;
    // Ride on until the reads ask for the full offset again, the camera still in close.
    for (let k = 0; k < 120 && r.sight.debug().targetFrac < 1; k++) r.run(16);
    const before = r.sight.debug();
    expect(before.targetFrac).toBe(1);
    expect(before.frac!).toBeLessThan(0.7);
    const p = r.run(0, 8, { dt: 5 });
    const step = 1 - Math.exp(-0.25 / SIGHT_RELEASE_TAU_S);
    expect(p.offsetM / BASE).toBeCloseTo(before.frac! + (1 - before.frac!) * step, 9);
  });

  it('crossing turned off while the far side is read (the painted road drawn): no cut', () => {
    const world: World = { right: profile(LUGANO.d2032.cam), left: profile(LUGANO.d2032.other) };
    const r = rig(world);
    // Five frames: its side read closed, the far side being read.
    r.run(4 * (1000 / 60) - 1);
    expect(r.sight.debug().pending).toBe(true);
    const sides = [];
    for (let k = 0; k < 20; k++) sides.push(r.run(0, 8, { allowSwitch: false }).side);
    expect(sides.every((v) => v === 1)).toBe(true);
    expect(r.sight.cuts()).toBe(0);
  });
});

describe('createSideCamSight: starting over', () => {
  it('the pose moving to a closed side re-reads at once, not at the next refresh', () => {
    const world: World = { right: flat, left: profile(LUGANO.d2032.cam) };
    const r = rig(world, { allowSwitch: false });
    // Standing still: refreshes at 0, 400, 800, 1200 ms; this ends just after the last.
    r.run(1220, 0);
    expect(r.run(0, 0).offsetM).toBe(BASE);
    // The left is closed: the road edge within 100 ms (four reads and the snap).
    expect(r.run(100, 0, { side: -1 }).offsetM).toBeCloseTo(SIGHT_MIN_OFFSET_M, 6);
  });

  it('re-reads at once when the pose offset changes (the painted road pushes it out on a bend)', () => {
    const r = rig({ right: flat, left: flat });
    r.run(100, 0);
    const before = r.reads();
    // Standing still, 100 ms after the last refresh: only the offset change makes one due.
    r.run(17, 0, { baseM: 11 });
    expect(r.reads()).toBeGreaterThan(before);
  });

  it("the pose moving sides starts over on the new side's reads, at full offset at once", () => {
    const r = rig({ right: profile(LUGANO.d193.cam), left: flat }, { allowSwitch: false });
    expect(r.run(1500).offsetM).toBeCloseTo(4.5, 2);
    // Four frames: three reads on the open side, the snap to them.
    const p = r.run(60, 8, { side: -1 });
    expect(p.side).toBe(-1);
    expect(p.offsetM).toBeCloseTo(BASE, 6);
  });

  it('reset forgets the reads: open ground after it is full offset at once', () => {
    const world: World = { right: profile(LUGANO.d193.cam), left: profile(LUGANO.d193.other) };
    const r = rig(world, { allowSwitch: false });
    expect(r.run(1500).offsetM).toBeCloseTo(4.5, 2);
    r.sight.reset();
    world.right = flat;
    expect(r.run(60).offsetM).toBeCloseTo(BASE, 6);
  });

  it('reset forgets the hold after a cut: a moved-in camera crosses to an open side again', () => {
    const world: World = { right: profile(LUGANO.d2032.cam), left: flat };
    const r = rig(world);
    expect(r.run(REFRESH_MS).side).toBe(-1);
    r.sight.reset();
    // After the reset the pose's side (right) needs moving in to half its offset; the left is open.
    world.right = profile(LUGANO.d193.cam);
    expect(r.run(REFRESH_MS).side).toBe(-1);
    expect(r.sight.cuts()).toBe(2);
  });

  it('a camera height that is not a number reads nothing as clear', () => {
    expect(clearSightOffset(flat, BASE, Number.NaN)).toBeUndefined();
  });
});
