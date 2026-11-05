/**
 * The owner's laptop as a gate: 1280×648 CSS px at scale 2 (Chrome on a
 * 2560×1600 panel; docs/design/UI-RULES.md "Gate viewports"). Every screen he
 * can reach must fit: no horizontal overflow, no page scroll on full-screen
 * views, and the key controls of each screen inside the viewport and not
 * painted over by anything else.
 *
 * Screens: Home, Settings, Devices, the ride (collapsed and with the details
 * open) and the finish screen. Runs against the token-free production build
 * (playwright.config.ts).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

const W = 1280;
const H = 648;

test.use({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });

const INIT = `
  localStorage.removeItem('globeride.cesiumIonToken');
  localStorage.setItem('globeride.onboarding.v2', JSON.stringify({ state: { hasSeenOnboarding: true }, version: 2 }));
`;

async function noHorizontalOverflow(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, 'horizontal page overflow').toBeLessThanOrEqual(innerWidth);
}

async function noPageScroll(page: Page) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(h, 'page scroll on a full-screen view').toBeLessThanOrEqual(H);
}

/** Fully inside the viewport, and the element itself is what paints at its centre. */
async function inViewport(control: Locator, what: string) {
  await expect(control, what).toBeVisible();
  const box = await control.boundingBox();
  expect(box, what).not.toBeNull();
  const b = box!;
  expect(b.x, `${what}: left edge`).toBeGreaterThanOrEqual(0);
  expect(b.y, `${what}: top edge`).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width, `${what}: right edge`).toBeLessThanOrEqual(W);
  expect(b.y + b.height, `${what}: bottom edge`).toBeLessThanOrEqual(H);
  const onTop = await control.evaluate((el) => {
    // A disabled Button has pointer-events: none, which hit-testing skips.
    const h = el as HTMLElement;
    const prev = h.style.pointerEvents;
    h.style.pointerEvents = 'auto';
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    h.style.pointerEvents = prev;
    return !!hit && (hit === el || el.contains(hit));
  });
  expect(onTop, `${what}: covered by another element`).toBe(true);
}

/**
 * Home's two disclosures (Build your own ride, Map & terrain credits) keep
 * their chevrons on the column edge, at the H1's x, while each summary's hover
 * pill bleeds the same distance into the gutter (`-mx-2` out, `px-2` back in).
 * Left edges from getBoundingClientRect, ±0.5 px.
 */
async function chevronsOnColumnEdge(page: Page, what: string) {
  const selectors = {
    h1: '#home-title',
    buildChevron: '[data-build-your-own] > summary [aria-hidden]',
    creditsChevron: '[data-world-credits] > summary [aria-hidden]',
    buildSummary: '[data-build-your-own] > summary',
    creditsSummary: '[data-world-credits] > summary',
  };
  for (const [name, sel] of Object.entries(selectors)) await expect(page.locator(sel), `${what}: one ${name}`).toHaveCount(1);
  const x = await page.evaluate(
    (sel) => Object.fromEntries(Object.entries(sel).map(([k, s]) => [k, document.querySelector(s)!.getBoundingClientRect().left])),
    selectors,
  );
  const near = (a: number, b: number, label: string) => expect(Math.abs(a - b), `${what}: ${label} (${a} vs ${b})`).toBeLessThanOrEqual(0.5);
  near(x.buildChevron, x.h1, 'Build your own ride chevron x = H1 x');
  near(x.creditsChevron, x.h1, 'credits chevron x = H1 x');
  near(x.buildSummary, x.creditsSummary, 'both summaries start at the same x');
  expect(x.h1 - x.buildSummary, `${what}: Build your own ride pill bleeds into the gutter (${x.buildSummary} vs H1 ${x.h1})`).toBeGreaterThan(0.5);
}

/** Today's featured route or the Tiber grid card, whichever Home shows today. */
async function rideTiber(page: Page) {
  const card = page.locator('[data-scenic-route="scenic-perugia-tiber-park"]');
  const featured = page.getByTestId('featured-scenic-ride').getByRole('button', { name: 'Ride Tiber river park', exact: true });
  const target = card.or(featured).first();
  await expect(target).toBeAttached();
  await target.evaluate((el) => (el as HTMLElement).click());
  await page.waitForURL('**/ride**');
}

test('1280×648: Home, Settings and Devices fit, key controls in view', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(INIT);

  await page.goto('/app');
  const featured = page.getByTestId('featured-scenic-ride');
  await expect(featured).toBeVisible();
  await noHorizontalOverflow(page);
  await inViewport(page.getByRole('button', { name: /^Devices/ }), 'Home: Devices');
  await inViewport(page.getByRole('button', { name: 'Open settings' }), 'Home: Settings');
  await inViewport(featured.locator('button[aria-label^="Ride "]:not([data-testid])'), "Home: Ride today's route");
  await chevronsOnColumnEdge(page, 'Home 1280×648');
  await expect(page).toHaveTitle(/Velo/);
  await expect(page.getByText(/GlobeRide/)).toHaveCount(0);

  await page.getByRole('button', { name: 'Open settings' }).click();
  const close = page.getByRole('button', { name: 'Close settings' });
  await inViewport(close, 'Settings: Close');
  await noHorizontalOverflow(page);
  for (const tab of await page.getByRole('tab').all()) await inViewport(tab, `Settings tab ${await tab.textContent()}`);
  await close.click();

  await page.goto('/devices');
  await expect(page.getByTestId('device-trainer')).toBeVisible();
  await noHorizontalOverflow(page);
  await inViewport(page.getByTestId('devices-ride'), 'Devices: Ride');
  await inViewport(page.getByTestId('device-trainer').getByRole('button').first(), 'Devices: trainer action');

  // Home's column edge at the other gate viewports too. TV goes last: `?layout=tv` sticks for the session.
  for (const [w, h, q] of [[1440, 900, ''], [390, 844, ''], [1920, 1080, '?layout=tv']] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/app${q}`);
    await expect(page.getByTestId('featured-scenic-ride')).toBeVisible();
    if (q) await expect(page.locator('html')).toHaveAttribute('data-layout', 'tv');
    await chevronsOnColumnEdge(page, `Home ${w}×${h}${q ? ' TV' : ''}`);
  }

  expect(errors).toEqual([]);
});

test('1280×648: the ride (collapsed and open) and the finish screen fit with no page scroll', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(INIT);

  await page.goto('/app');
  await rideTiber(page);
  const pause = page.getByRole('button', { name: 'Pause ride' });
  await expect(pause).toBeAttached({ timeout: 90_000 });

  // Collapsed: the band, its transport and the details toggle.
  await noHorizontalOverflow(page);
  await noPageScroll(page);
  await inViewport(pause, 'Ride: Pause');
  await inViewport(page.getByRole('button', { name: 'Finish ride' }), 'Ride: Finish');
  const toggle = page.getByTestId('ride-details-toggle');
  await inViewport(toggle, 'Ride: details toggle');

  // Open: the details panel sits inside the screen, the toggle stays reachable.
  await toggle.evaluate((el) => (el as HTMLElement).click());
  const details = page.getByTestId('ride-details');
  await expect(details).toBeVisible();
  await noHorizontalOverflow(page);
  await noPageScroll(page);
  const box = (await details.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(W);
  await inViewport(toggle, 'Ride open: details toggle');
  await inViewport(page.getByRole('button', { name: 'Finish ride' }), 'Ride open: Finish');

  // Finish: its own screen, no page scroll, everything in view.
  await page.getByRole('button', { name: 'Finish ride' }).evaluate((el) => (el as HTMLElement).click());
  const finish = page.getByTestId('finish-screen');
  await expect(finish).toBeVisible();
  const fit = await finish.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(fit.scroll, 'finish screen scrolls').toBeLessThanOrEqual(fit.client);
  await noHorizontalOverflow(page);
  await inViewport(page.locator('#finish-title'), 'Finish: route name');
  await inViewport(page.getByTestId('finish-figures'), 'Finish: figures');
  await inViewport(page.getByRole('button', { name: 'Save .FIT' }), 'Finish: Save .FIT');
  await inViewport(page.getByRole('button', { name: 'Ride again' }), 'Finish: Ride again');
  await inViewport(page.getByRole('button', { name: 'Home', exact: true }), 'Finish: Home');
  // Nothing of the ride HUD is left on screen behind it.
  await expect(page.getByRole('button', { name: 'Pause ride' })).toHaveCount(0);
  await expect(finish.getByText(/GlobeRide|Strava/)).toHaveCount(0);

  expect(errors).toEqual([]);
});
