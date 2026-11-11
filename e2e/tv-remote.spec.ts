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
 * Graphics on medium, as riders have it. The world draws nothing behind the
 * finish page (finish-cover.spec.ts), so on software GL at 1920×1080 the way
 * back Home no longer waits behind hidden 3D frames (CI run 43026470671 hit
 * that and ran on low until it was fixed).
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

const W = 1920;
const H = 1080;

const init = (layoutMode: 'auto' | 'tv' | 'default') => `
  localStorage.removeItem('globeride.cesiumIonToken');
  localStorage.setItem('globeride.onboarding.v2', JSON.stringify({ state: { hasSeenOnboarding: true }, version: 2 }));
  localStorage.setItem('globeride.settings.v1', JSON.stringify({ state: { layoutMode: '${layoutMode}', graphicsQuality: 'medium', graphicsQualityAuto: false }, version: 1 }));
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
  /** Spread of the box-shadow: the paper gap + halo around the ink ring. */
  haloSpread: number;
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
      haloSpread: parseFloat(s.boxShadow.match(/-?[\d.]+px/g)?.[3] ?? '0'),
      inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    };
  });

/** The ring is on the control named `label` (exact, or a pattern), drawn as the TV ring, on screen. */
async function ringOn(page: Page, label: string | RegExp, what: string) {
  await expect
    .poll(async () => (await focused(page))?.label ?? '(nothing focused)', { message: `${what}: focus`, timeout: 15_000 })
    .toMatch(typeof label === 'string' ? new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : label);
  // The 7 px ink ring (0.25rem at 1080p), at once: the TV ring does not ease in.
  // Paper around it (0.625rem = 17.5 px spread: the 3.5 px gap inside, a 7 px
  // halo outside the ring's outer edge at 10.5 px), as in the mockup.
  await expect
    .poll(async () => {
      const f = await focused(page);
      return f
        ? `${f.outlineStyle} ${Math.round(f.outlineWidth)} halo ${f.haloSpread} ${f.inViewport ? 'on screen' : 'off screen'}`
        : 'nothing';
    }, { message: `${what}: a visible 7 px ring in its paper halo, on screen`, timeout: 5_000 })
    .toBe('solid 7 halo 17.5 on screen');
}

test('Devices: Escape closes the pairing guide and stays on Devices; a second Escape goes Home', async ({ page }) => {
  await page.addInitScript(init('auto'));
  await page.goto('/devices');
  // The trainer row's guide link ("Why not?" in a browser without Web Bluetooth, as here).
  await page.getByTestId('device-trainer').getByRole('button', { name: /^(How do I pair a KICKR\?|Why not\?)$/ }).click();
  const guide = page.getByRole('dialog', { name: 'Pair a smart trainer' });
  await expect(guide).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(guide).toHaveCount(0);
  await expect(page).toHaveURL(/\/devices$/);
  await expect(page.getByTestId('device-trainer')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.waitForURL('**/app');
});

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
    await expect(page.locator('#home-title')).toBeVisible({ timeout: 60_000 });
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
