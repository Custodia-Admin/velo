/**
 * Pace partners on the photoreal globe (botAvatars: placeBotAvatars when a
 * route loads, updateBotAvatars every frame, both called by
 * CesiumWorldView). A fake avatar records its calls, so this runs without
 * Cesium.
 *
 * What this pins:
 * - review of PR #37 @282329f, nit 3: every bot avatar is placed with an
 *   update() as soon as it is created, at the bot's distance along the route
 *   (the start line after a load), and coloured in roster order;
 * - review of PR #45 @4ea2ff0: each partner stands and rides in its lateral
 *   slot (lib/ride/partnerSlots) across its heading, never on the line the
 *   rider stands on;
 * - card t_ffc99d86: they give way to the steering rider (the photoreal
 *   rider steers off the line too), by the shared solver;
 * - the view builds and moves them through these two functions.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Avatar, AvatarUpdate } from '@/lib/avatar';
import type { AvatarColors } from '@/lib/avatarConfig';
import { BOT_COLORWAYS, BOT_PRESETS, createPaceBot, type PaceBot } from '@/lib/paceBots';
import type { Route } from '@/types';
import { headingAt, sampleRouteAtDistance } from '@/lib/gpxParser';
import { CORNER_LEAN_MAX_RAD } from '@/lib/ride/cornerLean';
import { offsetLatLon, PARTNER_SLOT_FLOOR_M, PARTNER_SLOT_MAX_RATE_MPS, type PartnerYieldState } from '@/lib/ride/partnerSlots';
import { lineAt, offsetFacing } from '@/lib/ride/rideLine';
import { botSlotLatLon, CORRIDOR_SPAN, placeBotAvatars, updateBotAvatars, type BotGiveWay } from './botAvatars';

const route: Route = {
  id: 'assisi',
  name: 'Assisi',
  points: [
    { lat: 43.07, lon: 12.6, ele: 220, distance: 0 },
    { lat: 43.07, lon: 12.61, ele: 230, distance: 800 },
  ],
  totalDistance: 800,
  ascent: 10,
  descent: 0,
  minElevation: 220,
  maxElevation: 230,
  loadedAt: 0,
};

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;
/** Local (east, north) metres from (lat0, lon0) to an update's position. */
function enu(lat0: number, lon0: number, u: { lat: number; lon: number }): [number, number] {
  return [rad(u.lon - lon0) * R * Math.cos(rad(lat0)), rad(u.lat - lat0) * R];
}

function fakeAvatar(log: string[]) {
  const updates: AvatarUpdate[] = [];
  const colors: AvatarColors[] = [];
  const avatar = {
    update: (u: AvatarUpdate) => {
      log.push('update');
      updates.push(u);
    },
    setColors: (c: AvatarColors) => {
      log.push('colors');
      colors.push(c);
    },
  } as unknown as Avatar;
  return { avatar, updates, colors };
}

function placeAll(bots: PaceBot[]) {
  const made: ReturnType<typeof fakeAvatar>[] = [];
  placeBotAvatars(bots, route, () => {
    const f = fakeAvatar([]);
    made.push(f);
    return f.avatar;
  });
  return made;
}

const seated = () => BOT_PRESETS.slice(0, 3).map((p, i) => createPaceBot(`b${i}`, p, route));

describe('placeBotAvatars', () => {
  it('places each bot avatar on the start line at creation, in roster colours', () => {
    const bots = [createPaceBot('pace-steady', BOT_PRESETS[0], route), createPaceBot('pace-climber', BOT_PRESETS[1], route)];
    const made: ReturnType<typeof fakeAvatar>[] = [];
    const log: string[] = [];
    const out = placeBotAvatars(bots, route, () => {
      log.push('make');
      const f = fakeAvatar(log);
      made.push(f);
      return f.avatar;
    });

    expect(out).toEqual(made.map((f) => f.avatar));
    // Each avatar is updated before the next one is made (never left unplaced).
    expect(log).toEqual(['make', 'colors', 'update', 'make', 'colors', 'update']);
    made.forEach((f, i) => {
      expect(f.colors).toEqual([BOT_COLORWAYS[i]]);
      expect(f.updates).toHaveLength(1);
      expect(f.updates[0]).toMatchObject({ ele: 220, speed: 0, dt: 0 });
      expect(f.updates[0].heading).toBeCloseTo(Math.PI / 2, 6);
      // On the start line: no distance along the route.
      expect(enu(43.07, 12.6, f.updates[0])[0]).toBeCloseTo(0, 3);
    });
  });

  it('stands each partner in its slot across the start heading: 1.2 m right, 1.2 m left, 2.4 m right', () => {
    // The route runs east, so right of travel is south.
    const made = placeAll(seated());
    const at = made.map((f) => enu(43.07, 12.6, f.updates[0]));
    expect(at.map(([e]) => Math.abs(e) < 1e-3)).toEqual([true, true, true]);
    expect(at[0][1]).toBeCloseTo(-1.2, 3);
    expect(at[1][1]).toBeCloseTo(1.2, 3);
    expect(at[2][1]).toBeCloseTo(-2.4, 3);
  });

  it('keeps every partner clear of the rider on the line and of each other', () => {
    const at = placeAll(seated()).map((f) => enu(43.07, 12.6, f.updates[0]));
    // The rider stands on the route line at the start: (0, 0).
    for (const [e, n] of at) expect(Math.hypot(e, n)).toBeGreaterThanOrEqual(0.9);
    for (let i = 0; i < at.length; i++) {
      for (let j = i + 1; j < at.length; j++) {
        expect(Math.hypot(at[i][0] - at[j][0], at[i][1] - at[j][1])).toBeGreaterThanOrEqual(0.9);
      }
    }
  });

  it("uses the bot's distance along the route, even when its state was never seated", () => {
    const unseated = createPaceBot('pace-sprinter', BOT_PRESETS[2]);
    const midway = { ...createPaceBot('pace-attacker', BOT_PRESETS[3]) };
    midway.state = { ...midway.state, distance: 400 };
    const made = placeAll([unseated, midway]);
    expect(made[0].updates[0].lon).toBeCloseTo(12.6, 9);
    expect(enu(43.07, 12.6, made[0].updates[0])[1]).toBeCloseTo(-1.2, 3);
    expect(made[1].updates[0].lon).toBeCloseTo(12.605, 9);
    expect(enu(43.07, 12.605, made[1].updates[0])[1]).toBeCloseTo(1.2, 3);
    expect(made[1].updates[0].ele).toBeCloseTo(225, 9);
  });

  it('is how the photoreal view builds its bot avatars', () => {
    const src = readFileSync(join(__dirname, 'CesiumWorldView.tsx'), 'utf8');
    expect(src).toMatch(/botAvatarsRef\.current = placeBotAvatars\(useRideStore\.getState\(\)\.paceBots, route, \(\) => createAvatar\(viewer\)\);/);
    // No other place creates bot avatars.
    expect(src).not.toMatch(/BOT_COLORWAYS/);
  });
});

describe('updateBotAvatars', () => {
  /** A bot riding at (lat, lon) with `heading`, as tickPaceBot leaves it. */
  function riding(i: number, lat: number, lon: number, heading: number, speed = 8): PaceBot {
    const b = createPaceBot(`b${i}`, BOT_PRESETS[i]);
    b.state = { ...b.state, distance: 500, lat, lon, ele: 300, heading, speed };
    return b;
  }

  it("moves each partner to its live state in its slot across the bot's own heading", () => {
    // North-facing: right of travel is east.
    const bots = [0, 1, 2].map((i) => riding(i, 43.1, 12.4, 0));
    const made = bots.map(() => fakeAvatar([]));
    expect(updateBotAvatars(bots, made.map((f) => f.avatar), 0.016)).toBe(true);
    const at = made.map((f) => enu(43.1, 12.4, f.updates[0]));
    expect(at[0][0]).toBeCloseTo(1.2, 3);
    expect(at[1][0]).toBeCloseTo(-1.2, 3);
    expect(at[2][0]).toBeCloseTo(2.4, 3);
    for (const [, n] of at) expect(n).toBeCloseTo(0, 4);
    made.forEach((f) => expect(f.updates[0]).toMatchObject({ ele: 300, heading: 0, speed: 8, dt: 0.016, cadence: 0, riderPosition: 'hoods' }));
  });

  it('turns the slot with the heading: east-facing partners shift south (right) and north (left)', () => {
    const bots = [0, 1].map((i) => riding(i, 43.1, 12.4, Math.PI / 2));
    const made = bots.map(() => fakeAvatar([]));
    updateBotAvatars(bots, made.map((f) => f.avatar), 0.016);
    const [r, l] = made.map((f) => enu(43.1, 12.4, f.updates[0]));
    // The avatar faces the bot's heading (east), not just stands where it should.
    for (const f of made) expect(f.updates[0].heading).toBeCloseTo(Math.PI / 2, 9);
    expect(r[0]).toBeCloseTo(0, 4);
    expect(r[1]).toBeCloseTo(-1.2, 3);
    expect(l[0]).toBeCloseTo(0, 4);
    expect(l[1]).toBeCloseTo(1.2, 3);
  });

  it('keeps level partners clear of a rider level with them on the line', () => {
    const bots = [0, 1, 2].map((i) => riding(i, 43.1, 12.4, 0.7));
    const made = bots.map(() => fakeAvatar([]));
    updateBotAvatars(bots, made.map((f) => f.avatar), 0.016);
    for (const f of made) expect(Math.hypot(...enu(43.1, 12.4, f.updates[0]))).toBeGreaterThanOrEqual(0.9);
  });

  it('leaves the avatars alone when the roster and the avatars disagree', () => {
    const made = [fakeAvatar([])];
    expect(updateBotAvatars([riding(0, 43.1, 12.4, 0), riding(1, 43.1, 12.4, 0)], [made[0].avatar], 0.016)).toBe(false);
    expect(updateBotAvatars([], [], 0.016)).toBe(false);
    expect(made[0].updates).toHaveLength(0);
  });

  it('clamps to the corridor the view draws (3.5 m either side); the roster slots all fit in it', () => {
    expect(CORRIDOR_SPAN).toEqual({ leftM: -3.5, rightM: 3.5 });
    // A fifth partner's 3.6 m slot would leave it: it stops 0.1 m inside the edge.
    const p = botSlotLatLon(4, 43.1, 12.4, 0);
    expect(enu(43.1, 12.4, p)[0]).toBeCloseTo(3.4, 3);
  });

  describe('giving way to the steering rider', () => {
    const DT = 1 / 60;
    const LAT = 43.1;
    const LON = 12.4;
    /** A road running north through (LAT, LON), 500 m along it. */
    const north: Route = {
      ...route,
      id: 'north',
      points: [
        { lat: LAT - 500 / 111_195, lon: LON, ele: 300, distance: 0 },
        { lat: LAT + 300 / 111_195, lon: LON, ele: 300, distance: 800 },
      ],
    };
    /** The rider level with the partners, `laneM` right of the line (north-facing: right is east). */
    function giveWay(states: PartnerYieldState[], laneM: number, reach: [number, number] = [laneM, laneM]): BotGiveWay {
      const at = offsetLatLon(LAT, LON, 0, laneM);
      return {
        states,
        route: north,
        rider: { distance: 500, speed: 8, laneOffsetM: laneM, leftM: reach[0], rightM: reach[1] },
        riderLat: at.lat,
        riderLon: at.lon,
        riderHeading: 0,
      };
    }

    it('moves the partner on the rider’s side out, keeps 0.9 m from the rider, and never swaps sides', () => {
      const bots = [0, 1, 2].map((i) => riding(i, LAT, LON, 0));
      const made = bots.map(() => fakeAvatar([]));
      const states: PartnerYieldState[] = [];
      for (let f = 0; f < 120; f++) updateBotAvatars(bots, made.map((m) => m.avatar), DT, giveWay(states, 1.6));
      const at = made.map((m) => enu(LAT, LON, m.updates[m.updates.length - 1]));
      expect(at[0][0]).toBeCloseTo(1.6 + PARTNER_SLOT_FLOOR_M, 3);
      expect(at[1][0]).toBeCloseTo(-1.2, 3);
      expect(at[2][0]).toBeCloseTo(1.6 + 2 * PARTNER_SLOT_FLOOR_M, 3);
      // Every frame: 0.9 m from the rider (to the projection's 0.5 %), each on its own side, eased.
      made.forEach((m, i) => {
        let prev = NaN;
        for (const u of m.updates) {
          const [e] = enu(LAT, LON, u);
          expect(Math.abs(e - 1.6)).toBeGreaterThanOrEqual(PARTNER_SLOT_FLOOR_M - 0.005);
          expect(Math.sign(e)).toBe(i % 2 === 0 ? 1 : -1);
          if (Number.isFinite(prev)) expect(Math.abs(e - prev)).toBeLessThanOrEqual(PARTNER_SLOT_MAX_RATE_MPS * DT * 1.005);
          prev = e;
        }
      });
    });

    it('keeps the base slots for a rider on the line, and with no give-way at all', () => {
      const bots = [0, 1, 2].map((i) => riding(i, LAT, LON, 0));
      const a = bots.map(() => fakeAvatar([]));
      const b = bots.map(() => fakeAvatar([]));
      updateBotAvatars(bots, a.map((m) => m.avatar), DT, giveWay([], 0));
      updateBotAvatars(bots, b.map((m) => m.avatar), DT);
      a.forEach((m, i) => {
        const [ae, an] = enu(LAT, LON, m.updates[0]);
        const [be, bn] = enu(LAT, LON, b[i].updates[0]);
        expect(Math.hypot(ae - be, an - bn)).toBeLessThan(1e-3);
        expect(m.updates[0].heading).toBeCloseTo(b[i].updates[0].heading, 6);
        expect(m.updates[0]).toMatchObject({ ele: 300, speed: 8, lean: 0 });
      });
    });
  });

  describe('on the drawn line through a corner (card t_84d635ff)', () => {
    // 100 m north, then 100 m east: a right-hand corner at 100 m.
    const K = 111_195;
    const COS = Math.cos((43.1 * Math.PI) / 180);
    const corner: Route = {
      ...route,
      id: 'corner',
      points: [
        { lat: 43.1, lon: 12.4, ele: 300, distance: 0 },
        { lat: 43.1 + 100 / K, lon: 12.4, ele: 300, distance: 100 },
        { lat: 43.1 + 100 / K, lon: 12.4 + 100 / (K * COS), ele: 300, distance: 200 },
      ],
      totalDistance: 200,
    };
    /** Bot 0 riding at `distance` m, as tickPaceBot leaves it (on the raw route, at its ±4 m chord heading). */
    function at(distance: number): PaceBot {
      const b = createPaceBot('b0', BOT_PRESETS[0]);
      const p = sampleRouteAtDistance(corner, distance);
      b.state = { ...b.state, distance, lat: p.lat, lon: p.lon, ele: 300, heading: headingAt(corner, distance), speed: 8 };
      return b;
    }
    const level = (states: PartnerYieldState[], leans: number[], d: number): BotGiveWay => {
      const p = lineAt(corner, d);
      return { states, leans, route: corner, rider: { distance: d, speed: 8, laneOffsetM: 0, leftM: 0, rightM: 0 }, riderLat: p.lat, riderLon: p.lon, riderHeading: p.frameHeading };
    };

    it("stands in its slot across the line's sideways frame, facing the way it moves, leaning right through a right-hand bend", () => {
      const made = fakeAvatar([]);
      const states: PartnerYieldState[] = [];
      const leans: number[] = [];
      let leanMax = 0;
      for (let d = 80; d <= 120; d += 8 / 60) {
        updateBotAvatars([at(d)], [made.avatar], 1 / 60, level(states, leans, d));
        const u = made.updates[made.updates.length - 1];
        const p = lineAt(corner, d);
        const slot = offsetLatLon(p.lat, p.lon, p.frameHeading, 1.2);
        expect(Math.abs(u.lat - slot.lat) * K).toBeLessThan(1e-3);
        expect(Math.abs(u.lon - slot.lon) * K * COS).toBeLessThan(1e-3);
        expect(u.heading).toBeCloseTo(offsetFacing(p, 1.2), 9);
        leanMax = Math.max(leanMax, u.lean ?? 0);
      }
      // Into the bend (right), capped; upright again on the straight after it.
      expect(leanMax).toBeGreaterThan(0.1);
      expect(leanMax).toBeLessThanOrEqual(CORNER_LEAN_MAX_RAD + 1e-9);
      expect(Math.abs(made.updates[made.updates.length - 1].lean ?? 0)).toBeLessThan(0.02);
    });

    it('faces the way it moves round the corner; at its raw point and chord heading it slid sideways', () => {
      const made = fakeAvatar([]);
      const states: PartnerYieldState[] = [];
      const ang = (a: number) => Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
      const travel = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => Math.atan2((b.lon - a.lon) * COS, b.lat - a.lat);
      let crab = 0;
      let rawCrab = 0;
      let prev: AvatarUpdate | null = null;
      let prevRaw: PaceBot | null = null;
      for (let d = 90; d <= 110; d += 8 / 60) {
        const bot = at(d);
        updateBotAvatars([bot], [made.avatar], 1 / 60, level(states, [], d));
        const u = made.updates[made.updates.length - 1];
        // Against the heading midway through the frame's step.
        if (prev) crab = Math.max(crab, ang(prev.heading + Math.atan2(Math.sin(u.heading - prev.heading), Math.cos(u.heading - prev.heading)) / 2 - travel(prev, u)));
        if (prevRaw) rawCrab = Math.max(rawCrab, ang(bot.state.heading - travel(prevRaw.state, bot.state)));
        prev = u;
        prevRaw = bot;
      }
      expect((rawCrab * 180) / Math.PI).toBeGreaterThan(40);
      expect((crab * 180) / Math.PI).toBeLessThan(5);
    });
  });

  it('is how the photoreal view moves its bot avatars every frame', () => {
    const src = readFileSync(join(__dirname, 'CesiumWorldView.tsx'), 'utf8');
    expect(src).toMatch(/updateBotAvatars\(useRideStore\.getState\(\)\.paceBots, botAvatarsRef\.current, dt, \{\s*states: botGiveWayRef\.current,/);
    // The partners give way to the rider's reach through the shared solver.
    expect(src).toContain('laneReach(laneRef.current, steer, rider);');
    // Nothing else moves a bot avatar (an unshifted update would put it back on the line).
    expect(src).not.toMatch(/botAvatars(Ref\.current)?\[i\]\.update\(/);
    expect(src.match(/updateBotAvatars\(/g)).toHaveLength(1);
  });
});
