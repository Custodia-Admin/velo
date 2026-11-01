/**
 * Regression (t_8ffebbd3): the mobile ride layout must keep the rider and
 * the road ahead visible at 390×844.
 *
 * The `sm:hidden` mobile HUD stack used to carry the minimap and the
 * elevation profile inline, covering y≈300–690 of the canvas — right over
 * the standard chase camera's rider (y≈360–532, measured via
 * `window.__veloRideDebug().riderScreen`). Both widgets now live in the
 * on-demand MobileDetailDock; the desktop (≥sm) left column keeps the
 * always-on minimap + profile.
 *
 * Same card: the Settings sheet was painted over by later same-z HUD
 * siblings because it rendered inside the top bar's stacking context; it now
 * portals to document.body. The no-token banner moved its raw positioning
 * calc into the `ride-banner-float` utility (index.css) which clears the
 * dock row below sm.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const rideSrc = readFileSync(join(ROOT, 'src/routes/Ride.tsx'), 'utf8');
const minimapSrc = readFileSync(join(ROOT, 'src/components/ride/Minimap.tsx'), 'utf8');
const bannerSrc = readFileSync(join(ROOT, 'src/components/ride/NoTokenBanner.tsx'), 'utf8');
const cssSrc = readFileSync(join(ROOT, 'src/index.css'), 'utf8');
const settingsSrc = readFileSync(join(ROOT, 'src/components/profile/SettingsPanel.tsx'), 'utf8');
const hudSrc = readFileSync(join(ROOT, 'src/components/velo/RideHud.tsx'), 'utf8');
const routePanelSrc = readFileSync(join(ROOT, 'src/components/velo/RideRoutePanel.tsx'), 'utf8');

/** The `sm:hidden` mobile HUD stack section of Ride.tsx. */
function mobileStackSection(): string {
  const start = rideSrc.indexOf('-- Mobile HUD');
  const end = rideSrc.indexOf('-- Transport controls');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return rideSrc.slice(start, end);
}

describe('mobile ride stack keeps the scene band clear', () => {
  it('the sm:hidden stack no longer contains the minimap or the elevation profile', () => {
    const section = mobileStackSection();
    expect(section).not.toContain('<Minimap');
    expect(section).not.toContain('<ElevationProfile');
  });

  it('sm+ carries the profile in the route panel and the map on demand (v2 HUD)', () => {
    // The always-on glass minimap + elevation panels went away in the v2
    // HUD (docs/design/mockups/v2-ride-hud.html): the route panel draws the
    // profile from sm, and the map opens from the HUD's "More" menu.
    expect(routePanelSrc).toContain('<RouteProfile');
    expect(routePanelSrc).toContain('hidden h-8 sm:block');
    expect(hudSrc).toContain('{mapOpen && (');
    expect(hudSrc).toContain('<Minimap />');
    expect(rideSrc).not.toContain('<ElevationProfile');
  });

  it('the dock hides in show mode and after the finish', () => {
    expect(rideSrc).toContain("const rideHudOn = !showActive && rideState !== 'finished'");
    expect(rideSrc).toContain('<MobileDetailDock className="sm:hidden" />');
  });
});

describe('Minimap sizes from classes so the dock can render it compact', () => {
  it('root size is the w-44/h-44 default (176 px), no inline px style', () => {
    expect(minimapSrc).toContain('h-44 w-44');
    expect(minimapSrc).not.toContain('style={{ width: SIZE');
  });

  it('the svg scales with its container (viewBox preserved)', () => {
    expect(minimapSrc).toContain('width="100%"');
    expect(minimapSrc).toContain('height="100%"');
    expect(minimapSrc).toContain('viewBox={`0 0 ${SIZE} ${SIZE}`}');
  });
});

describe('no-token banner clears the dock on mobile via ride-banner-float', () => {
  it('NoTokenBanner positions with the utility class, no inline calc', () => {
    expect(bannerSrc).toContain('ride-banner-float');
    expect(bannerSrc).not.toContain("bottom: 'calc(");
  });

  it('index.css defines the utility with the below-sm dock clearance', () => {
    expect(cssSrc).toContain('.ride-banner-float');
    expect(cssSrc).toContain('@media (max-width: 639.98px)');
    expect(cssSrc).toContain('7.75rem');
  });

  it('the v2 ride root lifts the banner above the ride strip (and the phone dock)', () => {
    expect(rideSrc).toContain('ride-hud-v2');
    expect(cssSrc).toContain('.ride-hud-v2 .ride-banner-float');
  });
});

describe('Settings sheet renders above every ride HUD layer', () => {
  it('SettingsPanel portals the dialog to document.body', () => {
    expect(settingsSrc).toContain('createPortal(');
    expect(settingsSrc).toContain('document.body');
  });

  it('keeps the SSR/none-DOM guard before portalling', () => {
    expect(settingsSrc).toContain("typeof document === 'undefined'");
  });
});

describe('ride strip stays one piece and the dock sits above it (t_19e8b32f)', () => {
  it('the sm+ left-1/2 wrapper sizes to max-content, capped to the viewport', () => {
    // An absolutely-positioned left-1/2 wrapper shrink-fits to the width
    // available from its left edge (~half the screen), which wrapped the old
    // transport bar into a two-story block. w-max keeps the ride strip on one
    // row; max-w-hud-strip keeps it inside the viewport.
    expect(rideSrc).toContain('sm:left-1/2 sm:right-auto sm:w-max sm:max-w-hud-strip sm:-translate-x-1/2');
  });

  it('phones: the dock and the strip share one bottom column, dock first (no offset to drift)', () => {
    const start = rideSrc.indexOf('-- Transport controls');
    const section = rideSrc.slice(start, rideSrc.indexOf('-- Show mode', start));
    expect(section).toContain('flex flex-col items-stretch gap-2 pointer-events-none');
    expect(section.indexOf('<MobileDetailDock')).toBeGreaterThan(-1);
    expect(section.indexOf('<MobileDetailDock')).toBeLessThan(section.indexOf('<RideStrip'));
    // The old hand-tuned offsets above the transport bar are gone.
    expect(rideSrc).not.toContain('1.25rem) + 4.75rem');
    expect(rideSrc).not.toContain('1.25rem) + 7.75rem');
  });
});
