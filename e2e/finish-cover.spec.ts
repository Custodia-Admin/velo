/**
 * The finish screen covers the world: nothing draws behind it (card t_c4842aa7).
 *
 * The finish page is opaque over the whole screen. The world under it used to
 * draw every frame anyway. On software GL at 1920×1080 (a CI runner, a slow
 * TV) each of those hidden frames held the main thread, and the way back Home
 * waited behind them for 15 s or more. Now the renderer draws nothing while
 * the finish page shows (three.js: r3f's frame loop stops; Cesium: its
 * default render loop goes off), and draws again for Ride again on the same
 * scene.
 *
 * Counted at the source: every WebGL draw call in the page (both renderers,
 * every context), from an init script. Runs against the token-free
 * production build (playwright.config.ts) on the medium tier, as riders do.
 */
import { expect, test, type Page } from '@playwright/test';

const W = 1920;
const H = 1080;

const INIT = `
  localStorage.removeItem('globeride.cesiumIonToken');
  localStorage.setItem('globeride.onboarding.v2', JSON.stringify({ state: { hasSeenOnboarding: true }, version: 2 }));
  localStorage.setItem('globeride.settings.v1', JSON.stringify({ state: { graphicsQuality: 'medium', graphicsQualityAuto: false }, version: 1 }));
  // Every draw call into any WebGL context in the page.
  window.__e2eDraws = 0;
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const own = C.prototype[m];
      if (typeof own !== 'function') continue;
      C.prototype[m] = function (...args) {
        window.__e2eDraws++;
        return own.apply(this, args);
      };
    }
  }
`;

interface RideProbe {
  rideState: string;
  elapsedMs: number;
  distance: number;
}

/** Start a scenic route from Home, as a grid card or as Today's ride (smoke-ride.spec.ts). */
async function rideScenicRoute(page: Page, id: string, name: string) {
  const card = page.locator(`[data-scenic-route="${id}"]`);
  const featured = page.getByTestId('featured-scenic-ride').getByRole('button', { name: `Ride ${name}`, exact: true });
  const target = card.or(featured).first();
  await expect(target).toBeVisible();
  await target.click();
  await page.waitForURL('**/ride**');
}

const ride = (page: Page) =>
  page.evaluate(() => (window as unknown as { __veloRideState: () => RideProbe }).__veloRideState());
const draws = (page: Page) => page.evaluate(() => (window as unknown as { __e2eDraws: number }).__e2eDraws);
/** A click from page JS: Playwright's stability wait stalls on the live ride strip under software GL. */
const press = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true }).evaluate((el) => (el as HTMLButtonElement).click());

/** Draw calls in `ms` of wall time. */
async function drawsIn(page: Page, ms: number) {
  const before = await draws(page);
  await page.waitForTimeout(ms);
  return (await draws(page)) - before;
}

async function finish(page: Page) {
  await press(page, 'Finish ride');
  await expect(page.getByTestId('finish-screen')).toBeVisible();
  // A frame already under way when the page went up may still land.
  await page.waitForTimeout(1_000);
}

/** Riding, the world drawing, the ride clock moving. */
async function riding(page: Page, what: string) {
  await expect.poll(async () => (await ride(page)).rideState, { message: `${what}: riding`, timeout: 120_000 }).toBe('running');
  await expect.poll(() => drawsIn(page, 1_000), { message: `${what}: the world draws`, timeout: 60_000 }).toBeGreaterThan(0);
  const t0 = (await ride(page)).elapsedMs;
  await expect.poll(async () => (await ride(page)).elapsedMs, { message: `${what}: the ride clock runs`, timeout: 60_000 }).toBeGreaterThan(t0);
}

test.describe('the finish screen at 1920×1080', () => {
  test.use({ viewport: { width: W, height: H } });

  test('the world (three.js) draws nothing behind the finish page, draws again for Ride again, and Home comes at once', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.addInitScript(INIT);
    await page.goto('/app');
    await rideScenicRoute(page, 'scenic-perugia-tiber-park', 'Tiber river park');
    await expect(page.locator('[data-renderer]')).toHaveAttribute('data-renderer', 'world');
    await riding(page, 'first ride');

    await finish(page);
    expect(await drawsIn(page, 4_000), 'draw calls in 4 s behind the finish page').toBe(0);

    // Ride again: the same scene draws again and the ride runs.
    await press(page, 'Ride again');
    await expect(page.getByTestId('finish-screen')).toHaveCount(0);
    await riding(page, 'Ride again');

    await finish(page);
    expect(await drawsIn(page, 2_000), 'draw calls behind the second finish page').toBe(0);
    const t0 = Date.now();
    await press(page, 'Home');
    await page.waitForURL('**/app');
    await expect(page.locator('#home-title')).toBeVisible();
    const homeMs = Date.now() - t0;
    console.info(`[finish-cover] world: Finish → Home ${homeMs} ms`);
    // The route change used to wait 15 s and more behind the hidden frames.
    expect(homeMs, 'Finish → Home').toBeLessThan(8_000);
    expect(pageErrors).toEqual([]);
  });

  test('the photoreal view (Cesium) draws nothing behind the finish page and draws again for Ride again', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.addInitScript(INIT);
    await page.goto('/app');
    // Bellinzona–Locarno is outside every baked world: photoreal, OSM with no token.
    await rideScenicRoute(page, 'scenic-magadino-plain', 'Bellinzona to Locarno');
    await expect(page.locator('[data-renderer]')).toHaveAttribute('data-renderer', 'photoreal');
    await riding(page, 'first ride');

    await finish(page);
    expect(await drawsIn(page, 4_000), 'draw calls in 4 s behind the finish page').toBe(0);

    await press(page, 'Ride again');
    await expect(page.getByTestId('finish-screen')).toHaveCount(0);
    await riding(page, 'Ride again');

    await finish(page);
    await press(page, 'Home');
    await page.waitForURL('**/app');
    await expect(page.locator('#home-title')).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
});
