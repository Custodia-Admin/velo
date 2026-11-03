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

  it('the desktop (sm+) left column still shows both, always-on', () => {
    expect(rideSrc).toContain('<Minimap />');
    expect(rideSrc).toContain('<ElevationProfile />');
    expect(rideSrc).toContain('hidden sm:block');
  });

  it('the dock hides in show mode and after the finish', () => {
    expect(rideSrc).toContain("!showActive && rideState !== 'finished'");
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

describe('transport bar stays one row at 390 (t_19e8b32f)', () => {
  it('the left-1/2 wrapper sizes to max-content, capped to the viewport', () => {
    // An absolutely-positioned left-1/2 wrapper shrink-fits to the width
    // available from its left edge (~195 px at 390), so RideControls' inner
    // flex-wrap stacked Pause/Finish into a 195×110 two-story block. w-max
    // keeps the running state on one ~62 px row; max-w lets the 4-button
    // finished state wrap gracefully inside the viewport instead of
    // overflowing it.
    expect(rideSrc).toContain('-translate-x-1/2 w-max max-w-[calc(100vw-1.5rem)]');
  });

  it('the dock offset follows the one-row transport (7.75rem → 4.75rem)', () => {
    expect(rideSrc).toContain('1.25rem) + 4.75rem');
    expect(rideSrc).not.toContain('1.25rem) + 7.75rem');
  });
});
