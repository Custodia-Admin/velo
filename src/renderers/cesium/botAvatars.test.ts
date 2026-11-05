/**
 * Pace partners on the photoreal globe (botAvatars.placeBotAvatars, called by
 * CesiumWorldView when a route loads). A fake avatar records its calls, so
 * this runs without Cesium.
 *
 * What this pins (review of PR #37 @282329f, nit 3): every bot avatar is
 * placed with an update() as soon as it is created, on the route at the
 * bot's distance (the start line after a load), and coloured in roster
 * order. The view builds them through this function.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Avatar, AvatarUpdate } from '@/lib/avatar';
import type { AvatarColors } from '@/lib/avatarConfig';
import { BOT_COLORWAYS, BOT_PRESETS, createPaceBot } from '@/lib/paceBots';
import type { Route } from '@/types';
import { placeBotAvatars } from './botAvatars';

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
      expect(f.updates[0]).toMatchObject({ lat: 43.07, lon: 12.6, ele: 220, speed: 0, dt: 0 });
      expect(f.updates[0].heading).toBeCloseTo(Math.PI / 2, 6);
    });
  });

  it("uses the bot's distance along the route, even when its state was never seated", () => {
    const unseated = createPaceBot('pace-sprinter', BOT_PRESETS[2]);
    const midway = { ...createPaceBot('pace-attacker', BOT_PRESETS[3]) };
    midway.state = { ...midway.state, distance: 400 };
    const made: ReturnType<typeof fakeAvatar>[] = [];
    placeBotAvatars([unseated, midway], route, () => {
      const f = fakeAvatar([]);
      made.push(f);
      return f.avatar;
    });
    expect(made[0].updates[0]).toMatchObject({ lat: 43.07, lon: 12.6 });
    expect(made[1].updates[0].lon).toBeCloseTo(12.605, 9);
    expect(made[1].updates[0].ele).toBeCloseTo(225, 9);
  });

  it('is how the photoreal view builds its bot avatars', () => {
    const src = readFileSync(join(__dirname, 'CesiumWorldView.tsx'), 'utf8');
    expect(src).toMatch(/botAvatarsRef\.current = placeBotAvatars\(useRideStore\.getState\(\)\.paceBots, route, \(\) => createAvatar\(viewer\)\);/);
    // No other place creates bot avatars.
    expect(src).not.toMatch(/BOT_COLORWAYS/);
  });
});
