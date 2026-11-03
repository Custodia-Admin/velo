/**
 * Smoke ride, token-free (blueprint §P1.2/§P1.4 + invariant 4).
 *
 * Home → Perugia scenic route → /ride: Velo's own three.js world renderer
 * draws (no Cesium code is even downloaded), the rider moves on the baked
 * terrain, the HUD moves, no token-upgrade banner shows (a world ride needs
 * no token), nothing blocks the top bar, nothing talks to cesium.com, and no
 * page error is thrown. Runs against
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

interface WorldDebug {
  renderer: string;
  world: string;
  distance: number | null;
  riderXZ: [number, number] | null;
  riderGroundGap: number | null;
  cameraClearance: number;
  frames: number;
}

/**
 * Start a scenic route from Home, wherever Home shows it today.
 *
 * Home features "Today's ride" (`todaysScenicRoute`, rotates daily through
 * the near-home routes) in its own card and drops that route from the
 * `[data-scenic-route]` grid. So a near-home route is a grid card on most
 * days and the featured card's Ride button on the day it is featured; the
 * spec must accept both or it fails on that one day (1 Nov 2026: Tiber park).
 */
async function rideScenicRoute(page: Page, id: string, name: string) {
  const card = page.locator(`[data-scenic-route="${id}"]`);
  const featured = page
    .getByTestId('featured-scenic-ride')
    .getByRole('button', { name: `Ride ${name}`, exact: true });
  const target = card.or(featured).first();
  await expect(target).toBeVisible();
  await target.click();
  await page.waitForURL('**/ride**');
}

const worldDebug = (page: Page) =>
  page.evaluate(() => {
    const fn = (window as unknown as { __veloRideDebug?: () => unknown }).__veloRideDebug;
    return (fn ? fn() : null) as WorldDebug | null;
  });

test('token-free smoke ride: Home → Perugia route → riding in the world renderer, no cesium.com traffic', async ({ page }) => {
  const cesiumRequests: string[] = [];
  const cesiumCode: string[] = [];
  const pageErrors: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (/(^|\.)cesium\.com$/.test(url.hostname)) cesiumRequests.push(req.url());
    // Cesium engine code (the lazy chunks, /cesium/ workers and assets). The
    // widgets.css <link> in index.html is page-wide and not engine code.
    if (/\/assets\/Cesium(WorldView)?-[^/]*\.js$|\/cesium\/(?!Widgets\/widgets\.css$)/.test(url.pathname)) {
      cesiumCode.push(url.pathname);
    }
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.addInitScript(INIT);

  await page.goto('/app');
  await rideScenicRoute(page, 'scenic-perugia-tiber-park', 'Tiber river park');

  // RideView picked the world renderer: the default, and Perugia is baked.
  const view = page.locator('[data-renderer]');
  await expect(view).toHaveAttribute('data-renderer-preferred', 'world');
  await expect(view).toHaveAttribute('data-renderer', 'world');
  await expect(view.locator('canvas')).toBeVisible();

  // The ride moves on demo physics.
  await expect
    .poll(async () => {
      const label = (await hudNumbers(page)).speed ?? '';
      const kmh = Number(label.match(/[\d.]+/)?.[0] ?? 0);
      return kmh;
    }, { timeout: 60_000 })
    .toBeGreaterThan(5);
  // The distance label moves on. SwiftShader on a CI runner can drop to a few
  // fps (the sim clamps each step to 0.1 s), so poll instead of a fixed wait.
  const before = await hudNumbers(page);
  expect(before.dist).not.toBeNull();
  await expect.poll(async () => (await hudNumbers(page)).dist, { timeout: 30_000 }).not.toBe(before.dist);

  // The rider moves through the Perugia world, on the ground, camera above it.
  // Poll rather than a fixed wait: a richer world on SwiftShader can take
  // more than a second per frame on a CI runner.
  const a = await worldDebug(page);
  await expect.poll(async () => (await worldDebug(page))?.distance ?? 0, { timeout: 30_000 }).toBeGreaterThan(a!.distance!);
  const b = await worldDebug(page);
  expect(a?.renderer).toBe('world');
  expect(a?.world).toBe('perugia');
  expect(b!.frames).toBeGreaterThan(0);
  expect(b!.distance!).toBeGreaterThan(a!.distance!);
  expect(b!.riderXZ).not.toEqual(a!.riderXZ);
  expect(Math.abs(b!.riderGroundGap!)).toBeLessThan(0.05);
  expect(b!.cameraClearance).toBeGreaterThan(0.5);

  // A world ride needs no token: no photoreal upgrade banner.
  await expect(page.getByText('Add a free Cesium ion token')).toHaveCount(0);

  // Nothing blocks the top bar.
  const exitHit = await page.evaluate(() => {
    const btn = document.querySelector('[aria-label="Exit ride and return to setup"]');
    if (!btn) return false;
    const b = btn.getBoundingClientRect();
    const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return !!el && (el === btn || btn.contains(el));
  });
  expect(exitHit).toBe(true);

  expect(cesiumRequests, 'token-free ride must not call cesium.com').toEqual([]);
  expect(cesiumCode, 'a world ride must not download the Cesium engine').toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('a route outside every baked world rides photoreal (OSM fallback with no token)', async ({ page }) => {
  const cesiumRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on('request', (req) => {
    if (/(^|\.)cesium\.com$/.test(new URL(req.url()).hostname)) cesiumRequests.push(req.url());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.addInitScript(INIT);

  await page.goto('/app');
  // Lugano is area 'hometown', never Today's ride, but go through the same path.
  await rideScenicRoute(page, 'scenic-lugano-melide', 'Lugano lakefront to Melide');

  const view = page.locator('[data-renderer]');
  await expect(view).toHaveAttribute('data-renderer-preferred', 'world');
  await expect(view).toHaveAttribute('data-renderer', 'photoreal');
  // The photoreal ride still offers the token upgrade.
  await expect(page.getByText('Add a free Cesium ion token').first()).toBeVisible();
  await expect
    .poll(async () => Number(((await hudNumbers(page)).speed ?? '').match(/[\d.]+/)?.[0] ?? 0), { timeout: 60_000 })
    .toBeGreaterThan(5);

  expect(cesiumRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
