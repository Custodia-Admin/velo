/**
 * Wishlist worlds that are not shipped with the app (blueprint §P3.1,
 * docs/worlds/ADDING-A-WORLD.md "Hosting").
 *
 * Chengdu Luxe Lakes and the coast worlds (Berkeley, Santa Monica, Puerto
 * Vallarta) are published to the R2 bucket under content-hashed
 * directories. Each first ride downloads its world (≤ 8 MB), the loader keeps every
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
const MB = 1024 * 1024;

/** One route per remote world, ridden from its Home card in "Places we want to go". */
const WORLDS = [
  { world: 'chengdu-luxelakes', route: 'scenic-chengdu-xinglong-lake', label: /^Ride Xinglong Lake loop in Chengdu, (?!.*map view)/ },
  { world: 'berkeley', route: 'scenic-richmond-marina-bay', label: /^Ride Richmond Marina Bay in Berkeley, (?!.*map view)/ },
  { world: 'santa-monica-venice', route: 'scenic-will-rogers-venice', label: /^Ride Will Rogers to Venice in Santa Monica, (?!.*map view)/ },
  { world: 'puerto-vallarta', route: 'scenic-nuevo-vallarta-bucerias', label: /^Ride Nuevo Vallarta to Bucerías in Puerto Vallarta, (?!.*map view)/ },
];
type RemoteWorld = (typeof WORLDS)[number];
const worldFile = (w: RemoteWorld) => new RegExp(`/worlds/${w.world}/[0-9a-f]{16}/([^/?#]+)$`);

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

/** Home → the route's card in "Places we want to go" → riding its world. */
async function rideWorld(page: Page, w: RemoteWorld) {
  await page.goto('/app');
  const wishlist = page.locator('[data-destination-section="wishlist"]');
  await expect(wishlist).toBeVisible();
  const card = wishlist.locator(`[data-scenic-route="${w.route}"]`);
  // A world ride: the tile carries no "map view" badge.
  await expect(card).toHaveAttribute('aria-label', w.label);
  await card.click();
  await page.waitForURL('**/ride**');

  const view = page.locator('[data-renderer]');
  await expect(view).toHaveAttribute('data-renderer-preferred', 'world');
  await expect(view).toHaveAttribute('data-renderer', 'world');
  await expect.poll(async () => (await worldDebug(page))?.world ?? null, { timeout: 90_000 }).toBe(w.world);
  const a = await worldDebug(page);
  await expect.poll(async () => (await worldDebug(page))?.distance ?? 0, { timeout: 60_000 }).toBeGreaterThan(a!.distance!);
  const b = await worldDebug(page);
  expect(Math.abs(b!.riderGroundGap!)).toBeLessThan(0.05);
  expect(b!.cameraClearance).toBeGreaterThan(0.5);
  await expect(page.getByTestId('photoreal-notice')).toHaveCount(0);
}

for (const w of WORLDS) test(`the ${w.world} world downloads once (≤ 8 MB) and the next ride starts offline`, async ({ page, context }) => {
  const WORLD_FILE = worldFile(w);
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
  await rideWorld(page, w);
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
  console.info(`first ride downloaded ${(bytes / MB).toFixed(2)} MB of the ${w.world} world`);
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
  await rideWorld(page, w);
  expect(failed, 'no world file request may need the network offline').toEqual([]);
  expect(fromNetwork, 'no world file may come from the network offline').toEqual([]);

  expect(cesium).toEqual([]);
  expect(pageErrors).toEqual([]);
});
