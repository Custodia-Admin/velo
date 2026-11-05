/**
 * The compact ride HUD (owner-directed revision, 2 Nov 2026): collapsed by
 * default to the ride band and one status chip; the details toggle opens
 * the route card, map and ride tools; the chip's devices sheet takes the
 * details' place. Static markup (node env). Server rendering reads a
 * zustand store's initial state, so the states are rendered through
 * RideHudLayout (RideHud = the store + this layout).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useRideHudStore } from '@/stores/rideHudStore';
import { RideHud, RideHudLayout } from './RideHud';

const props = {
  onExit: () => undefined,
  onInvite: () => undefined,
  onShortcuts: () => undefined,
  voice: { isListening: false, onToggle: () => undefined },
};

let state = { expanded: false, devicesOpen: false };
const render = () =>
  state.expanded || state.devicesOpen
    ? renderToStaticMarkup(createElement(RideHudLayout, { ...props, ...state }))
    : renderToStaticMarkup(createElement(RideHud, props));

function withHud(s: { expanded?: boolean; devicesOpen?: boolean }) {
  state = { ...state, ...s };
}

afterEach(() => {
  state = { expanded: false, devicesOpen: false };
  useRideHudStore.setState({ expanded: false, devicesOpen: false });
});

describe('RideHud', () => {
  it('collapsed (the default): the band and the chip only, no details, one details toggle', () => {
    expect(useRideHudStore.getState().expanded).toBe(false);
    const html = render();
    expect(html).toContain('data-testid="ride-strip"');
    expect(html).toContain('data-testid="ride-status-chip"');
    expect(html).not.toContain('data-testid="ride-details"');
    expect(html).not.toContain('aria-label="Ride tools"');
    expect(html.match(/data-testid="ride-details-toggle"/g)?.length).toBe(1);
    expect(html).toContain('aria-expanded="false" aria-controls="ride-details"');
    // Exit stays one tap away on the band (sm+).
    expect(html).toContain('aria-label="Exit ride and return to setup"');
  });

  it('expanded: route card, map slot and the ride tools appear above the band', () => {
    withHud({ expanded: true });
    const html = render();
    expect(html).toContain('data-testid="ride-details"');
    expect(html).toContain('data-testid="ride-map"');
    expect(html).toContain('aria-label="Ride tools"');
    expect(html).toContain('data-testid="show-toggle"');
    expect(html).toContain('aria-label="Ride settings"');
    expect(html.indexOf('data-testid="ride-details"')).toBeLessThan(html.indexOf('data-testid="ride-strip"'));
  });

  it('the devices sheet takes the details place while open (never both)', () => {
    withHud({ expanded: true, devicesOpen: true });
    const html = render();
    expect(html).toContain('data-testid="ride-devices-sheet"');
    expect(html).not.toContain('data-testid="ride-details"');
    expect(html).toContain('aria-label="Close devices"');
  });

  it('a tall devices sheet stays on screen: the column reaches the top inset, the sheet scrolls, the band and chip keep their size', () => {
    const closed = renderToStaticMarkup(createElement(RideHudLayout, { ...props, expanded: true, devicesOpen: false }));
    expect(closed).not.toContain('hud-inset-t justify-end');
    withHud({ devicesOpen: true });
    const html = render();
    expect(html).toContain('hud-inset-t justify-end');
    expect(html).toMatch(/data-testid="ride-hud"><div class="flex min-h-0 flex-col/);
    const tag = (id: string) => html.match(new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? '';
    const sheet = tag('ride-devices-sheet');
    expect(sheet).toContain('min-h-0 overflow-y-auto');
    expect(tag('ride-status-chip')).toContain('shrink-0');
    expect(tag('ride-strip')).toContain('shrink-0');
  });

  it('nothing in the HUD asks for a backdrop blur', () => {
    withHud({ expanded: true });
    expect(render()).not.toMatch(/backdrop-/);
  });

  it('the details toggle flips the stored state', () => {
    useRideHudStore.getState().toggleExpanded();
    expect(useRideHudStore.getState().expanded).toBe(true);
    useRideHudStore.getState().toggleExpanded();
    expect(useRideHudStore.getState().expanded).toBe(false);
  });

  it('the photoreal notice rides in the chip lane: chip at the band\'s left end, notice at its right end, one h-10 row above the band', () => {
    const notice = { kind: 'upgrade' as const, onOpenSettings: () => undefined, onDismiss: () => undefined };
    const html = renderToStaticMarkup(createElement(RideHudLayout, { ...props, expanded: false, devicesOpen: false, notice }));
    const tag = (id: string) => html.match(new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? '';
    const lane = tag('ride-chip-lane');
    expect(lane).toContain('flex max-w-full flex-wrap items-center justify-between gap-2');
    // The lane spans the band (the chip alone sits at its start).
    expect(lane).toContain('shrink-0 self-stretch');
    // Order: lane (chip, then notice), then the band; one column, no float.
    const at = (s: string) => html.indexOf(s);
    expect(at('data-testid="ride-chip-lane"')).toBeGreaterThan(-1);
    expect(at('data-testid="ride-chip-lane"')).toBeLessThan(at('data-testid="ride-status-chip"'));
    expect(at('data-testid="ride-status-chip"')).toBeLessThan(at('data-testid="photoreal-notice"'));
    expect(at('data-testid="photoreal-notice"')).toBeLessThan(at('data-testid="ride-strip"'));
    const pill = tag('photoreal-notice');
    expect(pill).toContain('h-10');
    expect(pill).toContain('hud-surface');
    expect(pill).not.toMatch(/\b(absolute|fixed)\b/);
    expect(html).toContain('Free token for photoreal Earth');
    expect(html).toContain('aria-label="Dismiss photoreal upgrade banner"');
    expect(html).not.toContain('ride-banner-float');
  });

  it('the notice steps aside while the ride details or the devices sheet are open; no notice, no lane', () => {
    const notice = { kind: 'upgrade' as const, onOpenSettings: () => undefined, onDismiss: () => undefined };
    for (const s of [{ expanded: true, devicesOpen: false }, { expanded: false, devicesOpen: true }]) {
      const html = renderToStaticMarkup(createElement(RideHudLayout, { ...props, ...s, notice }));
      expect(html, JSON.stringify(s)).not.toContain('data-testid="photoreal-notice"');
      expect(html, JSON.stringify(s)).not.toContain('data-testid="ride-chip-lane"');
    }
    const bare = renderToStaticMarkup(createElement(RideHudLayout, { ...props, expanded: false, devicesOpen: false, notice: null }));
    expect(bare).not.toContain('data-testid="ride-chip-lane"');
    expect(bare).toMatch(/<button[^>]*data-testid="ride-status-chip"[^>]*class="[^"]*shrink-0 self-start/);
  });

  it('notice hosting is counted and released once', () => {
    const release = useRideHudStore.getState().hostNotices();
    expect(useRideHudStore.getState().noticeHosts).toBe(1);
    release();
    release();
    expect(useRideHudStore.getState().noticeHosts).toBe(0);
  });
});
