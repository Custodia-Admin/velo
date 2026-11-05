/**
 * Pace partners as pure functions over rideStore.paceBots (pacePartners.ts):
 * every tile is a real lib/paceBots preset, a tap adds a real PaceBot (with
 * live state, at the start line) or removes it, and the cap holds.
 */
import { describe, expect, it } from 'vitest';
import { BOT_PRESETS, createPaceBot } from '@/lib/paceBots';
import { MAX_PARTNERS, PARTNERS, partnersStatus, pickedPartnerIds, togglePartner } from './pacePartners';

describe('pace partners', () => {
  it('offers every lib/paceBots preset once, with a stable id and plain copy', () => {
    expect(PARTNERS.map((p) => p.preset)).toEqual(BOT_PRESETS);
    expect(new Set(PARTNERS.map((p) => p.id)).size).toBe(BOT_PRESETS.length);
    for (const p of PARTNERS) {
      expect(p.id).toBe(`pace-${p.personality}`);
      expect(p.name).toBe(p.preset.name);
      expect(p.style).not.toBe('');
      expect(p.blurb).toMatch(/\.$/);
      // Home copy: no training jargon (UI-RULES §1).
      expect(`${p.style} ${p.blurb}`).not.toMatch(/FTP|watt|\bW\b|TSS/i);
    }
  });

  it('a tap adds a real PaceBot at the start line, a second tap removes it', () => {
    const steady = PARTNERS[0];
    const one = togglePartner([], steady.id);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ id: steady.id, name: steady.name, personality: steady.personality, ftpW: steady.preset.ftpW });
    // The ride loop reads bot.state.distance/heading every frame.
    expect(one[0].state).toMatchObject({ distance: 0, speed: 0 });
    expect(pickedPartnerIds(one).has(steady.id)).toBe(true);
    expect(togglePartner(one, steady.id)).toEqual([]);
  });

  it('keeps the partners already picked (order and live state) when another is added or removed', () => {
    const riding = { ...createPaceBot(PARTNERS[1].id, PARTNERS[1].preset) };
    riding.state = { ...riding.state, distance: 420 };
    const two = togglePartner([riding], PARTNERS[3].id);
    expect(two.map((b) => b.id)).toEqual([PARTNERS[1].id, PARTNERS[3].id]);
    expect(two[0]).toBe(riding);
    expect(togglePartner(two, PARTNERS[3].id)[0]).toBe(riding);
  });

  it(`holds at ${MAX_PARTNERS}: a fourth tap changes nothing, removing one frees a slot`, () => {
    let bots = togglePartner([], PARTNERS[0].id);
    bots = togglePartner(bots, PARTNERS[1].id);
    bots = togglePartner(bots, PARTNERS[2].id);
    expect(bots).toHaveLength(MAX_PARTNERS);
    expect(togglePartner(bots, PARTNERS[3].id).map((b) => b.id)).toEqual(bots.map((b) => b.id));
    const freed = togglePartner(bots, PARTNERS[0].id);
    expect(togglePartner(freed, PARTNERS[3].id).map((b) => b.id)).toContain(PARTNERS[3].id);
  });

  it('ignores an unknown id', () => {
    expect(togglePartner([], 'pace-nobody')).toEqual([]);
  });

  it('says how many ride along, and why the rest are off at the cap', () => {
    expect(partnersStatus(0)).toBe('Riding alone');
    expect(partnersStatus(1)).toBe(`1 of ${MAX_PARTNERS} riding with you`);
    expect(partnersStatus(MAX_PARTNERS)).toBe(`${MAX_PARTNERS} of ${MAX_PARTNERS} riding with you. Remove one to pick another.`);
  });
});
