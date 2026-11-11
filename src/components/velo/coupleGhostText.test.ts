/** Words for the couple ghost and the postcards (coupleGhostText.ts). */
import { describe, expect, it } from 'vitest';

import type { CoupleGhostOptions, GhostVerdict } from '@/lib/play/coupleGhost';
import type { RideRecord } from '@/lib/rideHistory';
import { ghostTiles, pickedTile, postcardsLine, rideWithSubtitle, verdictLine } from './coupleGhostText';

const ride = (id: string, startedAt: number, durationSec: number) => ({ id, startedAt, durationSec }) as RideRecord;
const NOV3 = Date.UTC(2026, 10, 3, 17);
const OCT28 = Date.UTC(2026, 9, 28, 17);

describe('ghost tiles on the setup step', () => {
  it('offers the last ride, the best when it is another ride, and no ghost', () => {
    const o: CoupleGhostOptions = { last: ride('a', NOV3, 2200), best: ride('b', OCT28, 2052) };
    expect(ghostTiles(o, 'Anna')).toEqual([
      { choice: 'last', title: 'Last ride', meta: '3 Nov · 36:40' },
      { choice: 'best', title: 'Best ride', meta: '28 Oct · 34:12' },
      { choice: 'off', title: 'No ghost', meta: 'Ride without Anna' },
    ]);
  });

  it('one tile for a last ride that is also the best, none without a ride', () => {
    const same = ride('a', NOV3, 2200);
    expect(ghostTiles({ last: same, best: same }, 'Anna').map((t) => t.choice)).toEqual(['last', 'off']);
    expect(ghostTiles({ last: same, best: null }, 'Anna').map((t) => t.choice)).toEqual(['last', 'off']);
    expect(ghostTiles({ last: null, best: null }, 'Anna')).toEqual([]);
  });

  it('a "best" pick shows on the last ride when that is the only one', () => {
    const tiles = ghostTiles({ last: ride('a', NOV3, 2200), best: null }, 'Anna');
    expect(pickedTile(tiles, 'best')).toBe('last');
    expect(pickedTile(tiles, 'off')).toBe('off');
  });

  it("step 3's collapsed line names who rides with you", () => {
    expect(rideWithSubtitle(null, '')).toBe('Riding alone');
    expect(rideWithSubtitle('Anna', '')).toBe("Anna's ghost");
    expect(rideWithSubtitle(null, 'Niki')).toBe('With Niki');
    expect(rideWithSubtitle('Anna', 'Niki, Yuki')).toBe("Anna's ghost · with Niki, Yuki");
  });
});

describe('the Finish comparison line', () => {
  const ghost = { riderName: 'Anna', kind: 'last' as const, startedAt: NOV3 };
  const v = (over: Partial<GhostVerdict>): GhostVerdict => ({ kind: 'ahead', seconds: 72, atM: 10_900, finished: true, ...over });
  const line = (over: Partial<GhostVerdict>, units: 'metric' | 'imperial' = 'metric') => {
    const l = verdictLine(v(over), ghost, units);
    return `${l.lead}[${l.strong}]${l.rest}`;
  };

  it('says by how much, and against which ride', () => {
    expect(line({})).toBe("[1:12 ahead] of Anna's last ride (3 Nov)");
    expect(line({ kind: 'behind', seconds: 45 })).toBe("[0:45 behind] Anna's last ride (3 Nov)");
    expect(line({ kind: 'level', seconds: 0 })).toBe("[Level] with Anna's last ride (3 Nov)");
    expect(line({ kind: 'further', seconds: 0, finished: false })).toBe("[Further] than Anna's last ride (3 Nov)");
    expect(verdictLine(v({}), { ...ghost, kind: 'best' }, 'metric').rest).toBe(" of Anna's best ride (3 Nov)");
  });

  it('says where, for a ride finished before the end of the route', () => {
    expect(line({ finished: false, atM: 5400 })).toBe("At 5.4 km: [1:12 ahead] of Anna's last ride (3 Nov)");
    expect(line({ finished: false, atM: 5400 }, 'imperial')).toBe("At 3.4 mi: [1:12 ahead] of Anna's last ride (3 Nov)");
  });
});

describe('the Finish postcards line', () => {
  const names = ['Ponte San Giovanni', 'Ponte di legno e vista del Tevere', 'Valtiera', 'Ponte Valleceppi', 'Pretola'];

  it('counts them, and names the places collected', () => {
    expect(postcardsLine(0, 5, names)).toEqual({ count: '0 of 5 postcards found', places: '' });
    expect(postcardsLine(1, 5, names)).toEqual({ count: '1 of 5 postcards found', places: 'Ponte San Giovanni' });
  });

  it('keeps the line short: names that would run long (in route order) as "and N more"', () => {
    const l = postcardsLine(5, 5, names);
    expect(l.places).toBe('Ponte San Giovanni, Valtiera, Ponte Valleceppi and 2 more');
    expect(postcardsLine(3, 3, ['Lugano', 'Paradiso', 'Bissone']).places).toBe('Lugano, Paradiso, Bissone');
  });

  it('photoreal postcards have no place names: the count alone', () => {
    expect(postcardsLine(2, 4, [])).toEqual({ count: '2 of 4 postcards found', places: '' });
  });
});
