/**
 * MobileDetailDock — the on-demand minimap / elevation dock for phones.
 *
 * Regression context (t_8ffebbd3): at 390×844 the always-on mobile HUD stack
 * covered y≈20–690 of the canvas; the standard chase camera puts the rider at
 * y≈360–532, right under the compact minimap. The dock keeps the scene band
 * clear by default and opens one panel at a time, on demand.
 *
 * Tests: pure toggle logic, static markup (nothing by default — the v2
 * mockup has no toggles above the strip; the panels open from the ride
 * Settings menu), and source-level guarantees (Escape closes, compact map
 * size, mount in Ride.tsx).
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

vi.mock('@/components/ride/Minimap', () => ({
  Minimap: ({ className }: { className?: string }) =>
    createElement('div', { 'data-mock': 'minimap', className }),
}));
vi.mock('@/components/ride/ElevationProfile', () => ({
  ElevationProfile: () => createElement('div', { 'data-mock': 'elevation' }),
}));

import { MobileDetailDock, toggleDockPanel } from './MobileDetailDock';

const ROOT = resolve(__dirname, '../../..');
const dockSrc = readFileSync(join(ROOT, 'src/components/velo/MobileDetailDock.tsx'), 'utf8');
const rideSrc = readFileSync(join(ROOT, 'src/routes/Ride.tsx'), 'utf8');
const toolsSrc = readFileSync(join(ROOT, 'src/components/velo/RideTools.tsx'), 'utf8');

describe('toggleDockPanel', () => {
  it('opens a panel from the closed state', () => {
    expect(toggleDockPanel(null, 'map')).toBe('map');
    expect(toggleDockPanel(null, 'profile')).toBe('profile');
  });

  it('closes when the open panel is tapped again', () => {
    expect(toggleDockPanel('map', 'map')).toBeNull();
    expect(toggleDockPanel('profile', 'profile')).toBeNull();
  });

  it('switches directly to the other panel (one at a time)', () => {
    expect(toggleDockPanel('map', 'profile')).toBe('profile');
    expect(toggleDockPanel('profile', 'map')).toBe('map');
  });
});

describe('MobileDetailDock markup', () => {
  const html = renderToStaticMarkup(createElement(MobileDetailDock));

  it('is collapsed by default — no minimap, no elevation profile', () => {
    expect(html).not.toContain('data-mock="minimap"');
    expect(html).not.toContain('data-mock="elevation"');
    expect(html).not.toContain('id="ride-detail-panel"');
  });

  it('paints nothing over the scene until asked (no toggles above the strip, as mocked)', () => {
    expect(html).toBe('');
  });

  it('opens from the ride Settings menu on phones', () => {
    expect(toolsSrc).toContain("toggleRideDetail('map')");
    expect(toolsSrc).toContain("toggleRideDetail('profile')");
    expect(dockSrc).toContain('TOGGLE_DOCK_EVENT');
  });
});

describe('MobileDetailDock source guarantees', () => {
  it('closes on Escape while a panel is open', () => {
    expect(dockSrc).toContain("e.key === 'Escape'");
    expect(dockSrc).toContain("document.addEventListener('keydown'");
  });

  it('keeps that Escape from reaching the window (the ride pause / finish shortcut)', () => {
    expect(dockSrc).toContain('e.stopPropagation()');
  });

  it('stays click-through except for the open panel', () => {
    // The root spans the phone width; an auto root would swallow canvas
    // gestures in its band (the e27214a overlay lesson).
    expect(dockSrc).toContain('gap-2 pointer-events-none');
    expect(dockSrc.match(/pointer-events-auto/g)?.length).toBe(1);
  });

  it('opens the minimap compact (128 px) so the rider band stays visible', () => {
    expect(dockSrc).toContain('<Minimap className="h-32 w-32" />');
  });

  it('is mounted by Ride.tsx, phones only, in the bottom column right above the ride strip', () => {
    expect(rideSrc).toContain('<MobileDetailDock className="sm:hidden" />');
    expect(rideSrc.indexOf('<MobileDetailDock')).toBeLessThan(rideSrc.indexOf('<RideStrip'));
  });

  it('the close button is a HUD button (no glass / blur over the live canvas)', () => {
    expect(dockSrc.match(/variant="hud"/g)?.length).toBe(1);
    expect(dockSrc).not.toContain('glass');
  });
});
