/**
 * TV mode (P3.3): the 10-foot layout and a keyboard / TV-remote-only ride.
 *
 * 1. The auto rule in a real browser: a 1920×1080 screen with no fine pointer
 *    gets `html[data-layout="tv"]`; a 1920 px laptop (mouse) and the Android
 *    tablet at 1280 px (touch) do not; Settings → Layout → TV turns it on.
 * 2. Keys only, never the mouse, at 1920×1080: Home → ride → expand the
 *    details → pause → finish → Home. At every step the focus ring is on the
 *    control the next key acts on, and it is the TV ring (0.25rem of ink,
 *    7 px at 1080p). A TV remote's D-pad sends these arrow keys and its OK
 *    sends Enter.
 *
 * Runs against the token-free production build (playwright.config.ts).
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

const W = 1920;
const H = 1080;

const init = (layoutMode: 'auto' | 'tv' | 'default') => `
  localStorage.removeItem('globeride.cesiumIonToken');
  localStorage.setItem('globeride.onboarding.v2', JSON.stringify({ state: { hasSeenOnboarding: true }, version: 2 }));
  localStorage.setItem('globeride.settings.v1', JSON.stringify({ state: { layoutMode: '${layoutMode}' }, version: 1 }));
`;

async function layoutOf(browser: Browser, opts: Parameters<Browser['newContext']>[0], layoutMode: 'auto' | 'tv' = 'auto') {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(init(layoutMode));
  const page = await ctx.newPage();
  await page.goto('/app');
  await expect(page.locator('#home-title')).toBeVisible();
  const layout = await page.evaluate(() => document.documentElement.getAttribute('data-layout'));
  await ctx.close();
  return layout;
}

test('the TV layout turns on by itself on a TV-sized screen with no fine pointer, and from Settings', async ({ browser }) => {
  // A TV browser: wide, no mouse or touchpad (Chromium emulates "no fine pointer" with touch on).
  expect(await layoutOf(browser, { viewport: { width: W, height: H }, hasTouch: true })).toBe('tv');
  // A laptop with a mouse at the same width: standard.
  expect(await layoutOf(browser, { viewport: { width: W, height: H } })).toBeNull();
  // The owner's Android tablet: coarse pointer, but under 1600 px wide: standard.
  expect(await layoutOf(browser, { viewport: { width: 1280, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })).toBeNull();
  // Settings → Layout → TV on the laptop.
  expect(await layoutOf(browser, { viewport: { width: W, height: H } }, 'tv')).toBe('tv');
});

interface Focused {
  label: string;
  testid: string | null;
  outlineStyle: string;
  outlineWidth: number;
  inViewport: boolean;
}

const focused = (page: Page) =>
  page.evaluate((): Focused | null => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      label: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '',
      testid: el.getAttribute('data-testid'),
      outlineStyle: s.outlineStyle,
      outlineWidth: parseFloat(s.outlineWidth),
      inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    };
  });

/** The ring is on the control named `label` (exact, or a pattern), drawn as the TV ring, on screen. */
async function ringOn(page: Page, label: string | RegExp, what: string) {
  await expect
    .poll(async () => (await focused(page))?.label ?? '(nothing focused)', { message: `${what}: focus`, timeout: 15_000 })
    .toMatch(typeof label === 'string' ? new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : label);
  // The 7 px ink ring (0.25rem at 1080p), at once: the TV ring does not ease in.
  await expect
    .poll(async () => {
      const f = await focused(page);
      return f ? `${f.outlineStyle} ${Math.round(f.outlineWidth)} ${f.inViewport ? 'on screen' : 'off screen'}` : 'nothing';
    }, { message: `${what}: a visible 7 px ring, on screen`, timeout: 5_000 })
    .toBe('solid 7 on screen');
}

test.describe('keys only at 1920×1080', () => {
  test.use({ viewport: { width: W, height: H } });

  test('Home → ride → details → pause → finish → Home with the arrow keys, Enter and Escape', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.addInitScript(init('tv'));
    await page.goto('/app');
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'tv');

    // Home: the ring is already on Today's ride → Ride (the one primary action).
    await expect(page.getByTestId('featured-scenic-ride')).toBeVisible();
    await ringOn(page, /^Ride (?!.*and watch)/, 'Home');
    const routeName = ((await focused(page))!.label).replace(/^Ride /, '');
    await page.keyboard.press('Enter');

    // The ride starts by itself; nothing is ringed until the first arrow press.
    await page.waitForURL('**/ride**');
    const pause = page.getByRole('button', { name: 'Pause ride' });
    await expect(pause).toBeVisible({ timeout: 90_000 });
    await page.keyboard.press('ArrowDown');
    await ringOn(page, 'Pause ride', 'first arrow press rings the HUD primary');

    // Along the band to the details toggle, and open the details.
    await page.keyboard.press('ArrowRight');
    await ringOn(page, 'Finish ride', 'band →');
    await page.keyboard.press('ArrowRight');
    await ringOn(page, 'Show ride details: route, map and ride tools', 'band → →');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('ride-details')).toBeVisible();
    await ringOn(page, 'Hide ride details', 'details open, the ring stays on the toggle');

    // Up into the details; Escape (a remote's Back) closes them, ring back on the toggle, ride still on.
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('#ride-details'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ride-details')).toHaveCount(0);
    await ringOn(page, 'Show ride details: route, map and ride tools', 'Escape in the details');
    await expect(pause).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('ride-details')).toBeVisible();

    // Pause: the same button turns into Resume and keeps the ring.
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await ringOn(page, 'Pause ride', 'band ← ←');
    await page.keyboard.press('Enter');
    await ringOn(page, 'Resume ride', 'paused');

    // Finish: the finish page rings Home, its one filled button.
    await page.keyboard.press('ArrowRight');
    await ringOn(page, 'Finish ride', 'paused →');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('finish-screen')).toBeVisible();
    await expect(page.locator('#finish-title')).toHaveText(routeName);
    await ringOn(page, 'Home', 'finish page');

    // Home again, ring back on Ride.
    await page.keyboard.press('Enter');
    await page.waitForURL('**/app');
    await ringOn(page, /^Ride (?!.*and watch)/, 'Home again');

    expect(pageErrors).toEqual([]);
  });

  test('the ride HUD keeps inside the TV overscan frame (5 % of each edge)', async ({ page }) => {
    await page.addInitScript(init('tv'));
    await page.goto('/app');
    await expect(page.getByTestId('featured-scenic-ride')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Pause ride' })).toBeVisible({ timeout: 90_000 });
    const boxes = await page.evaluate(() =>
      ['ride-strip', 'ride-hud'].flatMap((id) =>
        Array.from(document.querySelectorAll(`[data-testid="${id}"] button, [data-testid="ride-strip"]`)).map((el) => {
          const r = el.getBoundingClientRect();
          return { what: el.getAttribute('aria-label') ?? id, l: r.left, t: r.top, r: r.right, b: r.bottom };
        }),
      ),
    );
    expect(boxes.length).toBeGreaterThan(3);
    for (const b of boxes) {
      expect(b.l, `${b.what}: left`).toBeGreaterThanOrEqual(W * 0.05);
      expect(b.r, `${b.what}: right`).toBeLessThanOrEqual(W * 0.95);
      expect(b.t, `${b.what}: top`).toBeGreaterThanOrEqual(H * 0.05);
      expect(b.b, `${b.what}: bottom`).toBeLessThanOrEqual(H * 0.95);
    }
  });
});
