/**
 * A wishlist world that is not shipped with the app (blueprint §P3.1,
 * docs/worlds/ADDING-A-WORLD.md "Hosting").
 *
 * Chengdu Luxe Lakes is published to the R2 bucket under a content-hashed
 * directory. The first ride downloads it (≤ 8 MB), the loader keeps every
 * file it checked in the `velo-worlds-v1` Cache API store, and once the
 * service worker has precached the app shell the next ride starts with the
 * browser offline: page, world and all, with no request for a world file
 * reaching the network. Token-free throughout, no cesium.com traffic.
 *
 * Needs the network for the first ride (the public bucket), like the
 * fetchPublished.mjs step in CI.
 */
import { expect, test, type Page, type Request } from '@playwright/test';

const INIT = `
  localStorage.removeItem('globeride.cesiumIonToken');
`;
const WORLD_FILE = /\/worlds\/chengdu-luxelakes\/[0-9a-f]{16}\/([^/?#]+)$/;
const MB = 1024 * 1024;

interface WorldDebug {
  renderer: string;
  world: string;
  distance: number | null;
  riderGroundGap: number | null;
  cameraClearance: number;
}

const worldDebug = (page: Page) =>
  page.evaluate(() => {
    const fn = (window as unknown as { __veloRideDebug?: () => unknown }).__veloRideDebug;
    return (fn ? fn() : null) as WorldDebug | null;
  });

/** Home → the Xinglong Lake card in "Places we want to go" → riding the Chengdu world. */
async function rideXinglong(page: Page) {
  await page.goto('/app');
  const wishlist = page.locator('[data-destination-section="wishlist"]');
  await expect(wishlist).toBeVisible();
  const card = wishlist.locator('[data-scenic-route="scenic-chengdu-xinglong-lake"]');
  // A world ride: the tile carries no "map view" badge.
  await expect(card).toHaveAttribute('aria-label', /^Ride Xinglong Lake loop in Chengdu, (?!.*map view)/);
  await card.click();
  await page.waitForURL('**/ride**');

  const view = page.locator('[data-renderer]');
  await expect(view).toHaveAttribute('data-renderer-preferred', 'world');
  await expect(view).toHaveAttribute('data-renderer', 'world');
  await expect.poll(async () => (await worldDebug(page))?.world ?? null, { timeout: 90_000 }).toBe('chengdu-luxelakes');
  const a = await worldDebug(page);
  await expect.poll(async () => (await worldDebug(page))?.distance ?? 0, { timeout: 60_000 }).toBeGreaterThan(a!.distance!);
  const b = await worldDebug(page);
  expect(Math.abs(b!.riderGroundGap!)).toBeLessThan(0.05);
  expect(b!.cameraClearance).toBeGreaterThan(0.5);
  await expect(page.getByTestId('photoreal-notice')).toHaveCount(0);
}

test('the Chengdu world downloads once (≤ 8 MB) and the next ride starts offline', async ({ page, context }) => {
  const cesium: string[] = [];
  const pageErrors: string[] = [];
  const fetched = new Map<string, number>();
  const fromNetwork: string[] = [];
  page.on('request', (req) => {
    if (/(^|\.)cesium\.com$/.test(new URL(req.url()).hostname)) cesium.push(req.url());
  });
  page.on('requestfinished', async (req: Request) => {
    const file = req.url().match(WORLD_FILE)?.[1];
    if (!file) return;
    const res = await req.response();
    if (res && !res.fromServiceWorker()) fromNetwork.push(file);
    fetched.set(file, (await req.sizes()).responseBodySize);
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.addInitScript(INIT);

  // First ride: every file of the bundle comes from the bucket, once.
  await rideXinglong(page);
  const files = [...fetched.keys()].sort();
  expect(files).toEqual([
    'buildings.bin.gz',
    'height.bin.gz',
    'landcover.json.gz',
    'manifest.json',
    'roads.json.gz',
    'routes.json.gz',
    'vegetation.bin.gz',
    'water.json.gz',
  ]);
  const bytes = [...fetched.values()].reduce((s, n) => s + n, 0);
  console.info(`first ride downloaded ${(bytes / MB).toFixed(2)} MB of Chengdu world`);
  expect(bytes).toBeGreaterThan(0.5 * MB);
  expect(bytes).toBeLessThanOrEqual(8 * MB);

  // The loader kept each checked file.
  const cached = await page.evaluate(async () => {
    const cache = await caches.open('velo-worlds-v1');
    return (await cache.keys()).map((r) => r.url);
  });
  expect(cached.map((u) => u.match(WORLD_FILE)?.[1]).filter(Boolean).sort()).toEqual(files);

  // The app shell is precached once the worker is active.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });

  // Offline: the page, the world and the ride all start from the caches.
  await context.setOffline(true);
  fetched.clear();
  fromNetwork.length = 0;
  const failed: string[] = [];
  page.on('requestfailed', (req) => {
    if (WORLD_FILE.test(req.url())) failed.push(req.url());
  });
  await rideXinglong(page);
  expect(failed, 'no world file request may need the network offline').toEqual([]);
  expect(fromNetwork, 'no world file may come from the network offline').toEqual([]);

  expect(cesium).toEqual([]);
  expect(pageErrors).toEqual([]);
});
