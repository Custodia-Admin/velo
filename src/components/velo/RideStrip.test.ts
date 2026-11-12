/**
 * v2 ride strip (docs/design/mockups/v2-ride-hud.html): the six figures of
 * the mockup — speed, time, distance, grade, power and the virtual gear.
 * Static markup (node env; zustand renders the stores' initial state).
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NEUTRAL_GEAR } from '@/lib/virtualGears';
import { RideStrip, shownGear } from './RideStrip';

describe('RideStrip', () => {
  it('shows the six mockup figures, gear at neutral 6 / 11 without handlebar controls', () => {
    const out = renderToStaticMarkup(createElement(RideStrip));
    for (const label of ['Speed', 'Time', 'Distance', 'Grade', 'Power', 'Gear']) expect(out).toContain(`>${label}<`);
    expect(out).toContain('aria-label="Gear 6 of 11"');
  });

  it('phones: grade, power and gear under the big three at figure size (UI-RULES §5: text-2xl)', () => {
    const out = renderToStaticMarkup(createElement(RideStrip));
    const m = out.match(/<div class="([^"]*)" data-testid="ride-strip-compact">(.*?)<\/div>/);
    expect(m).not.toBeNull();
    const [, cls, row] = m!;
    expect(cls.split(' ')).toContain('sm:hidden');
    expect(row.match(/<span class="text-2xl font-bold">/g)?.length).toBe(3);
    expect(row).toContain('>gear</small><span class="text-2xl font-bold">6</span>');
    expect(row).toContain('<span class="text-2xl font-bold">0</span><small class="ml-1 text-sm font-semibold text-muted-foreground">W</small>');
  });

  it('shows the gear the trainer uses: live while the controls are connected, else neutral, none in ERG', () => {
    expect(shownGear('connected', 9, false)).toBe(9);
    expect(shownGear('reconnecting', 9, false)).toBe(9);
    expect(shownGear('idle', 9, false)).toBe(NEUTRAL_GEAR);
    expect(shownGear('connected', 9, true)).toBeNull();
    expect(shownGear('idle', 9, false, true)).toBe(9); // shifted by keyboard / screen
  });

  it('the gear always has easier / harder buttons beside it, on desktop and on phones', () => {
    const out = renderToStaticMarkup(createElement(RideStrip));
    const desk = out.match(/<div class="([^"]*)" data-testid="ride-gear">(.*?)<\/div><\/div>/);
    expect(desk).not.toBeNull();
    expect(desk![1].split(' ')).toEqual(expect.arrayContaining(['hidden', 'sm:flex']));
    expect(out.match(/aria-label="Easier gear"/g)?.length).toBe(2);
    expect(out.match(/aria-label="Harder gear"/g)?.length).toBe(2);
    const phone = out.match(/data-testid="ride-gear-compact">(.*?)<\/span><\/span><button/);
    expect(out).toContain('data-testid="ride-gear-compact"');
    expect(phone === null || phone[1].includes('gear')).toBe(true);
    // Both buttons are h-10 targets (UI-RULES §5) and keep the gear figure between them.
    expect(out).toMatch(/aria-label="Easier gear"[^>]*>.*?aria-label="Gear 6 of 11".*?aria-label="Harder gear"/);
    for (const m of out.matchAll(/<button class="([^"]*)"[^>]*aria-label="(Easier|Harder) gear"/g)) {
      expect(m[1].split(' ')).toEqual(expect.arrayContaining(['h-10', 'w-10']));
    }
  });
});
