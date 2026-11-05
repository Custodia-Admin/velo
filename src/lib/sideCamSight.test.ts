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
    const p = r.run(20);
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
    expect(cross.run(20)).toEqual({ side: -1, offsetM: BASE, clear: true });
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
    expect(r.run(20).side).toBe(-1);
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
    expect(r.run(SIGHT_SAMPLE_MS + 20).side).toBe(-1);
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
    const p = r.run(100);
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
    expect(r.run(100).side).toBe(1);
    expect(r.sight.cuts()).toBe(0);
  });

  it('a cut holds the camera at what it read beside the rider until it passes the lead', () => {
    // Closed on its own side; across the road open ahead, half open beside the rider.
    const world: World = {
      right: profile(LUGANO.d2032.cam),
      left: (x, at) => (at < 1 && x > 6 ? 9 : 0),
    };
    const r = rig(world, { leadM: 5.6 });
    const p = r.run(16);
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
    r.run(100);
    expect(r.sight.cuts()).toBe(1);
    world.left = profile(LUGANO.d2032.cam);
    world.right = flat;
    r.run(SIGHT_SAMPLE_MS + 20);
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
    expect(r.run(20)).toEqual({ side: -1, offsetM: BASE, clear: true });
  });
});
