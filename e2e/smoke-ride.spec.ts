/**
 * Smoke ride, token-free (blueprint §P1.2 + invariant 4).
 *
 * Home → first scenic route → /ride: the ride starts on demo physics through
 * RideView, the HUD moves, the no-token banner shows without blocking the top
 * bar, nothing talks to cesium.com, and no page error is thrown. Runs against
 * the production build with no VITE_CESIUM_ION_TOKEN.
 */
import { expect, test, type Page } from '@playwright/test';

const INIT = `
  localStorage.removeItem('globeride.cesiumIonToken');
  localStorage.setItem('globeride.onboarding.v2', JSON.stringify({ state: { hasSeenOnboarding: true }, version: 2 }));
`;

async function hudNumbers(page: Page) {
  return page.evaluate(() => {
    const speed = document.querySelector('[aria-label^="Speed:"]')?.getAttribute('aria-label') ?? null;
    const dist =
      document.querySelector('[aria-label$="km"]')?.getAttribute('aria-label') ??
      document.querySelector('[aria-label*=" of "]')?.getAttribute('aria-label') ??
      null;
    return { speed, dist };
  });
}

test('token-free smoke ride: Home → scenic route → riding, no cesium.com traffic', async ({ page }) => {
  const cesiumRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on('request', (req) => {
    const host = new URL(req.url()).hostname;
    if (/(^|\.)cesium\.com$/.test(host)) cesiumRequests.push(req.url());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.addInitScript(INIT);

  await page.goto('/app');
  const firstRoute = page.locator('[data-scenic-route]').first();
  await expect(firstRoute).toBeVisible();

  await firstRoute.click();
  await page.waitForURL('**/ride**');

  // RideView picked a renderer: 'world' preferred (default), photoreal draws until P1.4.
  const view = page.locator('[data-renderer]');
  await expect(view).toHaveAttribute('data-renderer-preferred', 'world');
  await expect(view).toHaveAttribute('data-renderer', /^(world|photoreal)$/);

  // The no-token banner (upgrade variant) shows…
  await expect(page.getByText('Add a free Cesium ion token').first()).toBeVisible();

  // …and the ride moves on demo physics.
  await expect
    .poll(async () => {
      const label = (await hudNumbers(page)).speed ?? '';
      const kmh = Number(label.match(/[\d.]+/)?.[0] ?? 0);
      return kmh;
    }, { timeout: 60_000 })
    .toBeGreaterThan(5);
  const before = await hudNumbers(page);
  await page.waitForTimeout(4_000);
  const after = await hudNumbers(page);
  expect(after.dist).not.toBeNull();
  expect(after.dist).not.toBe(before.dist);

  // The banner never blocks the top bar.
  const exitHit = await page.evaluate(() => {
    const btn = document.querySelector('[aria-label="Exit ride and return to setup"]');
    if (!btn) return false;
    const b = btn.getBoundingClientRect();
    const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return !!el && (el === btn || btn.contains(el));
  });
  expect(exitHit).toBe(true);

  expect(cesiumRequests, 'token-free ride must not call cesium.com').toEqual([]);
  expect(pageErrors).toEqual([]);
});
