/**
 * Regression: the compact ride HUD (owner-directed revision, 2 Nov 2026).
 *
 * The owner rode Assisi and found the HUD "fucking enormous", covering most
 * of the screen with information he did not need, all crammed to the top.
 * The HUD is now one bottom column (src/components/velo/RideHud.tsx): the
 * ride band (figures, Pause / Finish, one details toggle), one status chip
 * above it, and the ride details (route card, map, tools) collapsed behind
 * the toggle. These assertions fail if a panel creeps back to the top of
 * the ride screen, if the details stop being collapsed by default, or if
 * a second always-on device card or red toast box returns.
 *
 * Kept from the mobile-dock regression (t_8ffebbd3, t_19e8b32f): the minimap
 * sizes from classes and the Settings sheet portals to document.body. The
 * no-token banner is now the photoreal notice in the chip lane (t_375b203d).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const rideSrc = read('src/routes/Ride.tsx');
const hudSrc = read('src/components/velo/RideHud.tsx');
const stripSrc = read('src/components/velo/RideStrip.tsx');
const chipSrc = read('src/components/velo/RideChip.tsx');
const toasterSrc = read('src/components/setup/Toaster.tsx');
const storeSrc = read('src/stores/rideHudStore.ts');
const cssSrc = read('src/index.css');
const settingsSrc = read('src/components/profile/SettingsPanel.tsx');

/** The ride HUD section of Ride.tsx (up to the debug readouts). */
function hudSection(): string {
  const start = rideSrc.indexOf('-- Compact ride HUD');
  const end = rideSrc.indexOf('-- Debug readouts');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return rideSrc.slice(start, end);
}

describe('compact ride HUD: one bottom column', () => {
  it('RideHud is anchored to the bottom edge; only a phone with the details open puts route card + map at the top', () => {
    expect(hudSrc).toContain("'pointer-events-none absolute hud-inset-b hud-inset-x z-20 flex flex-col");
    // Phones: above the band there is no room clear of the rider's wheels.
    // The only other top inset bounds the column while the devices sheet is
    // open, so a tall sheet scrolls; its content stays bottom-anchored.
    expect(hudSrc.match(/hud-inset-t/g)?.length).toBe(2);
    expect(hudSrc).toContain("devicesOpen && 'hud-inset-t justify-end'");
    expect(hudSrc).toContain('fixed hud-inset-t hud-inset-x flex items-start gap-2 sm:contents');
    expect(rideSrc).not.toContain('top-ride-stack');
  });

  it('the details, the chip and the band share one flow column (no absolute offsets to collide)', () => {
    const details = hudSrc.indexOf('<RideDetails');
    const chip = hudSrc.indexOf('<RideChip');
    const band = hudSrc.indexOf('<RideStrip');
    expect(details).toBeGreaterThan(-1);
    expect(details).toBeLessThan(chip);
    expect(chip).toBeLessThan(band);
    // Nothing inside the column is absolutely positioned.
    const body = hudSrc.slice(hudSrc.indexOf('export function RideHud'));
    expect(body.match(/\babsolute\b/g)?.length).toBe(1);
  });

  it('the route card, the minimap and the ride tools live only in the collapsed details', () => {
    const section = hudSection();
    for (const tag of ['<RideRoutePanel', '<Minimap', '<RideTools', '<ElevationProfile', '<SensorStatusPills', '<ReplayBadge']) {
      expect(section, tag).not.toContain(tag);
    }
    expect(hudSrc).toContain('expanded && <RideDetails');
    expect(storeSrc).toContain('expanded: false');
  });

  it('the band carries the six figures, Pause / Finish and exactly one details toggle', () => {
    for (const label of ['"Speed"', '"Time"', '"Distance"', '"Grade"', '"Power"', '"Gear"']) {
      expect(stripSrc, label).toContain(`label=${label}`);
    }
    expect(stripSrc).toContain('<Transport />');
    expect(stripSrc.match(/<DetailsToggle \/>/g)?.length).toBe(1);
    // Modest transport: no lg (h-12) buttons in the band.
    expect(stripSrc).not.toContain('size="lg"');
  });

  it('handlebar controls have no always-on card: the chip speaks for them (debug view excepted)', () => {
    const section = hudSection();
    expect(section).not.toContain('<ControllerChip');
    expect(rideSrc).toMatch(/controllerDebugVisible && \(\s*<>\s*<ControllerChip \/>/);
  });

  it('the HUD hides in show mode and after the finish', () => {
    expect(rideSrc).toContain("const rideHudOn = !showActive && rideState !== 'finished'");
    expect(hudSection()).toContain('{rideHudOn && (');
  });

  it('show mode keeps one status chip (alerts and notices only) above the show strip, so no toast card covers the video', () => {
    const showHudSrc = read('src/components/velo/ShowHud.tsx');
    expect(rideSrc).toContain('<ShowHud dimmed={dimmed} />');
    expect(showHudSrc).toContain('<RideChip alertsOnly');
    expect(showHudSrc.indexOf('<RideChip')).toBeLessThan(showHudSrc.indexOf('<ShowRideStrip'));
    expect(showHudSrc).toContain('devicesOpen && <RideDevicesSheet');
    // A tall devices sheet scrolls inside the screen, chip and strip keep their size.
    expect(showHudSrc).toContain("devicesOpen && 'show-inset-t justify-end'");
    expect(showHudSrc).toContain('<RideChip alertsOnly className="shrink-0');
    expect(showHudSrc).toContain('<ShowRideStrip dimmed={dimmed} className="shrink-0" />');
  });
});

describe('device and error states: one small chip, never a red box', () => {
  it('the Toaster draws nothing while a ride status chip hosts the notices', () => {
    expect(toasterSrc).toContain('const deferred = useRideHudStore((s) => s.noticeHosts > 0);');
    expect(toasterSrc).toContain('if (deferred) return null;');
    expect(chipSrc).toContain('useEffect(() => hostNotices(), [hostNotices]);');
  });

  it('the chip dismisses each toast after its turn so none pile up for the finish page', () => {
    expect(chipSrc).toContain('noticeMs(latest.durationMs)');
    expect(chipSrc).toContain('dismiss(latest.id)');
  });

  it('the chip is one h-10 button', () => {
    expect(chipSrc).toContain('<button');
    expect(chipSrc).toContain('h-10');
    expect(chipSrc).toContain('data-testid="ride-status-chip"');
  });
});

describe('photoreal notice: one line in the chip lane, never a floating banner (card t_375b203d)', () => {
  const noticeSrc = read('src/components/velo/PhotorealNotice.tsx');

  it('the old floating banner is gone: no NoTokenBanner, no ride-banner-float anywhere', () => {
    // It floated centred above the band; at 390 it shrink-fitted to half the
    // screen and wrapped into a seven-line column over the rider (19.2 % of
    // the screen with the band, 22.3 % with a chip).
    expect(rideSrc).not.toContain('NoTokenBanner');
    expect(rideSrc).not.toContain('ride-banner-float');
    expect(cssSrc).not.toContain('ride-banner-float');
    expect(() => read('src/components/ride/NoTokenBanner.tsx')).toThrow();
  });

  it('Ride hands the notice to the HUD for photoreal rides only (world rides need no token)', () => {
    expect(rideSrc).toContain('const photorealNotice = usePhotorealNotice(token !== null && token.length > 0);');
    expect(hudSection()).toContain('notice={worldRide ? null : photorealNotice}');
  });

  it('RideHud puts it in the chip lane, collapsed only; the chip yields nothing to it while an alert speaks', () => {
    expect(hudSrc).toContain('const quiet = notice && !expanded && !devicesOpen ? <PhotorealNoticeView {...notice} /> : null;');
    expect(hudSrc).toContain('aside={quiet}');
    expect(chipSrc).toContain('{!view.alert && aside}');
  });

  it('it stays dismissible and Settings stays one tap away, with the HUD collapsed', () => {
    expect(noticeSrc).toContain('onClick={onDismiss}');
    expect(noticeSrc).toContain('onClick={onOpenSettings}');
    expect(noticeSrc).toContain("new CustomEvent('globeride:open-settings', { detail: { tab: 'visual' } })");
    // RideHud (always mounted while riding) hosts the sheet for that event;
    // the tools' menu, mounted only with the details open, no longer listens.
    const toolsSrc = read('src/components/velo/RideTools.tsx');
    expect(hudSrc).toContain('<RideSettingsHost />');
    expect(hudSrc.indexOf('<RideSettingsHost />')).toBeLessThan(hudSrc.indexOf('export function RideHudLayout'));
    expect(toolsSrc.match(/addEventListener\('globeride:open-settings'/g)?.length).toBe(1);
    expect(toolsSrc.indexOf("addEventListener('globeride:open-settings'")).toBeGreaterThan(toolsSrc.indexOf('export function RideSettingsHost'));
    expect(toolsSrc.indexOf("addEventListener('globeride:open-settings'")).toBeLessThan(toolsSrc.indexOf('function RideOptionsMenu'));
  });

  it('Escape closes Settings without pausing the ride (Escape is the ride shortcut on window)', () => {
    expect(settingsSrc).toMatch(/if \(e\.key === 'Escape'\) \{\s*e\.stopPropagation\(\);\s*onClose\(\);/);
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
