/**
 * Smoke ride, token-free (blueprint §P1.2/§P1.4 + invariant 4).
 *
 * Home → Perugia scenic route → /ride: Velo's own three.js world renderer
 * draws (no Cesium code is even downloaded), the rider moves on the baked
 * terrain, the HUD moves, no photoreal notice shows (a world ride needs no
 * token), nothing blocks the top bar, nothing talks to cesium.com, and no
 * page error is thrown. Runs against
 * the production build with no VITE_CESIUM_ION_TOKEN.
 */
import { expect, test, type Page } from '@playwright/test';

const INIT = `
  localStorage.removeItem('globeride.cesiumIonToken');
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

/**
 * Ride a route outside every baked world: Home → Build your own ride → Demo
 * route (a synthetic loop at Lauterbrunnen, pinned off every world by
 * src/lib/world/catalog.test.ts) → Start ride. Every scenic route rides a
 * baked world, so this is the photoreal path (OSM on the ellipsoid with no token).
 */
async function rideOffWorld(page: Page) {
  const build = page.locator('[data-build-your-own]');
  await build.locator('summary').click();
  await build.getByRole('button', { name: 'Demo route', exact: true }).click();
  await build.getByRole('button', { name: 'Start ride', exact: true }).click();
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
  // Frames on screen: the meter counts drawn frames. The ride runs at the rAF
  // rate whether or not the GPU has room for a frame (renderers/three/frameGate.ts),
  // and a CI runner's SwiftShader can take 6 s or more per frame, so poll.
  await expect.poll(async () => (await worldDebug(page))?.frames ?? 0, { message: 'drawn frames', timeout: 90_000 }).toBeGreaterThan(0);
  expect(b!.distance!).toBeGreaterThan(a!.distance!);
  expect(b!.riderXZ).not.toEqual(a!.riderXZ);
  expect(Math.abs(b!.riderGroundGap!)).toBeLessThan(0.05);
  expect(b!.cameraClearance).toBeGreaterThan(0.5);

  // A world ride needs no token: no photoreal notice.
  await expect(page.getByTestId('photoreal-notice')).toHaveCount(0);

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

test('a hometown route rides the Lugano world (P2.2), no cesium.com traffic', async ({ page }) => {
  const cesiumRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on('request', (req) => {
    if (/(^|\.)cesium\.com$/.test(new URL(req.url()).hostname)) cesiumRequests.push(req.url());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.addInitScript(INIT);

  await page.goto('/app');
  await expect(page.locator('[data-destination-section="lugano"]')).toBeVisible();
  await rideScenicRoute(page, 'scenic-locarno-brissago', 'Locarno to Brissago');

  const view = page.locator('[data-renderer]');
  await expect(view).toHaveAttribute('data-renderer', 'world');
  await expect.poll(async () => (await worldDebug(page))?.world ?? null, { timeout: 60_000 }).toBe('lugano');
  const a = await worldDebug(page);
  await expect.poll(async () => (await worldDebug(page))?.distance ?? 0, { timeout: 60_000 }).toBeGreaterThan(a!.distance!);
  const b = await worldDebug(page);
  expect(Math.abs(b!.riderGroundGap!)).toBeLessThan(0.05);
  expect(b!.cameraClearance).toBeGreaterThan(0.5);
  await expect(page.getByTestId('photoreal-notice')).toHaveCount(0);

  expect(cesiumRequests).toEqual([]);
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
  // The demo loop is outside every baked world: a map ride.
  await rideOffWorld(page);

  const view = page.locator('[data-renderer]');
  await expect(view).toHaveAttribute('data-renderer-preferred', 'world');
  await expect(view).toHaveAttribute('data-renderer', 'photoreal');
  // The photoreal ride still offers the token upgrade.
  await expect(page.getByText('Free token for photoreal Earth').first()).toBeVisible();
  await expect
    .poll(async () => Number(((await hudNumbers(page)).speed ?? '').match(/[\d.]+/)?.[0] ?? 0), { timeout: 60_000 })
    .toBeGreaterThan(5);

  // The photoreal notice (card t_375b203d) is one h-10 line in the chip lane:
  // at 1440 at the band's right end (the chip holds the left end), at 390
  // alone at the lane's start. Never over the rider; at 390 the ride UI
  // stays within the owner's 15 % (the old floating banner wrapped into a
  // 204x134 column over the rider: 19.2 %).
  const layout = () =>
    page.evaluate(() => {
      const rect = (el: Element | null) => {
        if (!el || !el.getClientRects().length || getComputedStyle(el).display === 'none') return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      const notice = document.querySelector('[data-testid=photoreal-notice]');
      const text = notice?.querySelector('[data-notice-text]');
      const range = document.createRange();
      if (text) range.selectNodeContents(text);
      const lines = text ? new Set([...range.getClientRects()].map((q) => Math.round(q.top))).size : 0;
      const d = (window as unknown as { __veloRideDebug?: () => { riderScreen?: [number, number]; riderHeightPx?: number } })
        .__veloRideDebug?.();
      const hpx = d?.riderHeightPx ?? 0;
      const rider = d?.riderScreen
        ? { x: d.riderScreen[0] - 0.3 * hpx, y: d.riderScreen[1] + hpx / 1.7 - hpx, w: 0.6 * hpx, h: hpx }
        : null;
      return {
        vw: innerWidth,
        vh: innerHeight,
        notice: rect(notice),
        lines,
        chip: rect(document.querySelector('[data-testid=ride-status-chip]')),
        strip: rect(document.querySelector('[data-testid=ride-strip]')),
        rider,
      };
    });
  type Box = { x: number; y: number; w: number; h: number };
  const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  const wide = await layout();
  expect(wide.notice).not.toBeNull();
  expect(wide.notice!.h).toBe(40);
  expect(wide.lines).toBe(1);
  expect(Math.abs(wide.notice!.x + wide.notice!.w - (wide.strip!.x + wide.strip!.w))).toBeLessThanOrEqual(1);
  expect(wide.notice!.y).toBe(wide.chip!.y);
  expect(wide.rider).not.toBeNull();
  expect(overlaps(wide.notice!, wide.rider!), JSON.stringify({ notice: wide.notice, rider: wide.rider })).toBe(false);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await layout()).strip?.w ?? 0).toBeLessThan(390);
  // The rider box is projected through Cesium's camera, and the camera takes
  // the new box only at the next rendering update: viewer.resize() (from the
  // render loop or the view's ResizeObserver) sizes the drawing buffer and
  // the frustum, then the next frame sets the lens and the chase camera.
  // Under SwiftShader that update can land a second after the DOM has
  // reflowed. Until then the 1440x900 frustum is projected into the 390x844
  // box and the stretched rider reads ~275 px tall down to y ~759, over the
  // notice, instead of ~172 px down to y ~632 (card t_dad0597d). A steady
  // riderScreen proves nothing (no frame, no change). So measure once the
  // canvas has the reflowed box's aspect and a frame has been drawn at it.
  const resizedToBox = () =>
    page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('[data-renderer] .cesium-widget canvas');
      if (!c || !c.height || !c.clientHeight) return false;
      const box = c.clientWidth / c.clientHeight;
      return Math.abs(c.width / c.height - box) <= 0.02 * box;
    });
  await expect.poll(resizedToBox, { timeout: 60_000 }).toBe(true);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const phone = await layout();
  expect(phone.notice!.h).toBe(40);
  expect(phone.lines).toBe(1);
  expect(phone.notice!.x).toBe(phone.strip!.x);
  expect(phone.notice!.y + phone.notice!.h).toBeLessThanOrEqual(phone.strip!.y);
  expect(phone.chip).toBeNull(); // calm: the chip hides on phones, the notice has the lane
  expect(phone.rider).not.toBeNull();
  expect(overlaps(phone.notice!, phone.rider!), JSON.stringify({ notice: phone.notice, rider: phone.rider })).toBe(false);
  const area = (b: Box | null) => (b ? b.w * b.h : 0);
  expect((area(phone.notice) + area(phone.strip)) / (phone.vw * phone.vh)).toBeLessThanOrEqual(0.15);

  // Settings stays one tap away with the HUD collapsed (on main the link
  // opened nothing), on the Visual tab; Escape closes it without pausing.
  await page.getByRole('button', { name: 'Add a free Cesium ion token for photoreal Earth. Opens Settings.' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('tab', { selected: true })).toHaveText(/visual/i);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __veloRideState: () => { rideState: string } }).__veloRideState().rideState)).toBe('running');
  // × hides it for the session.
  await page.getByRole('button', { name: 'Dismiss photoreal upgrade banner' }).click();
  await expect(page.getByTestId('photoreal-notice')).toHaveCount(0);

  expect(cesiumRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
