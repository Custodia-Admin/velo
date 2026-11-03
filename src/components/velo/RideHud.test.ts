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

  it('notice hosting is counted and released once', () => {
    const release = useRideHudStore.getState().hostNotices();
    expect(useRideHudStore.getState().noticeHosts).toBe(1);
    release();
    release();
    expect(useRideHudStore.getState().noticeHosts).toBe(0);
  });
});
