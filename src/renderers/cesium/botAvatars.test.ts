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
 * - the view builds and moves them through these two functions.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Avatar, AvatarUpdate } from '@/lib/avatar';
import type { AvatarColors } from '@/lib/avatarConfig';
import { BOT_COLORWAYS, BOT_PRESETS, createPaceBot, type PaceBot } from '@/lib/paceBots';
import type { Route } from '@/types';
import { botSlotLatLon, CORRIDOR_SPAN, placeBotAvatars, updateBotAvatars } from './botAvatars';

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

  it('is how the photoreal view moves its bot avatars every frame', () => {
    const src = readFileSync(join(__dirname, 'CesiumWorldView.tsx'), 'utf8');
    expect(src).toContain('if (r) updateBotAvatars(useRideStore.getState().paceBots, botAvatarsRef.current, dt);');
    // Nothing else moves a bot avatar (an unshifted update would put it back on the line).
    expect(src).not.toMatch(/botAvatars(Ref\.current)?\[i\]\.update\(/);
    expect(src.match(/updateBotAvatars\(/g)).toHaveLength(1);
  });
});
