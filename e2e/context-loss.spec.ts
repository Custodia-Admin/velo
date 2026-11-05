/**
 * A lost WebGL context mid-ride (card t_14ea510a), token-free, production build.
 *
 * Home → Perugia scenic route → riding in the three.js world. Then the world
 * canvas loses its context for real (WEBGL_lose_context.loseContext(), what a
 * GPU reset, a driver update or Chrome's context cap do):
 *   - the one status chip says "3D view stopped · tap to reload" (no error box),
 *   - the dead canvas is hidden, the ride clock, the distance and the
 *     recording keep going the whole time;
 * the browser gives the context back (restoreContext()) → the world view
 * remounts on a new canvas that draws again (pixel variety, frames). Then a
 * second loss with no restore → the rider taps the chip → the same recovery.
 */
import { expect, test, type Page } from '@playwright/test';

const INIT = `
  localStorage.removeItem('globeride.cesiumIonToken');
  // window.__veloThree = the live renderer: its canvas and its own context
  // (calling getContext on a canvas three has not set up yet would create one).
  localStorage.setItem('velo.debug.three', '1');
  // The world is rebuilt twice on software GL: the low tier (no shadows, fewer
  // trees, no MSAA) keeps each rebuild and frame affordable on a CI runner.
  // The recovery path is the same on every tier.
  localStorage.setItem('globeride.settings.v1', JSON.stringify({ state: { graphicsQuality: 'low', graphicsQualityAuto: false }, version: 1 }));
  // A canvas-only view for the pixel check: the HUD hidden, the world shown.
  document.addEventListener('DOMContentLoaded', () => {
    const s = document.createElement('style');
    s.textContent = 'html.canvas-only body *{visibility:hidden!important} html.canvas-only [data-renderer] canvas{visibility:visible!important}';
    document.head.appendChild(s);
  });
`;

const CHIP = '3D view stopped · tap to reload';

interface RideProbe {
  rideState: string;
  elapsedMs: number;
  distance: number;
  samples: number;
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

type Three = {
  gl: { domElement: HTMLCanvasElement; getContext: () => WebGL2RenderingContext; info: { render: { frame: number } } };
};

/** The world canvas now: how many, whether three draws into it, its context, frames rendered since it mounted. */
const canvasState = (page: Page) =>
  page.evaluate(() => {
    const canvases = [...document.querySelectorAll('[data-renderer] canvas')] as HTMLCanvasElement[];
    const three = (window as unknown as { __veloThree?: Three }).__veloThree;
    const c = canvases[0];
    return {
      count: canvases.length,
      current: !!three && three.gl.domElement === c,
      lost: three ? three.gl.getContext().isContextLost() : null,
      frames: three ? three.gl.info.render.frame : 0,
      tagged: c ? (c.dataset.e2eCanvas ?? null) : null,
    };
  });

/** Lose the world canvas's context; keep the extension to restore it later. Tags the canvas. */
const loseContext = (page: Page, tag: string) =>
  page.evaluate((t) => {
    const three = (window as unknown as { __veloThree: Three }).__veloThree;
    three.gl.domElement.dataset.e2eCanvas = t;
    const ext = three.gl.getContext().getExtension('WEBGL_lose_context')!;
    (window as unknown as { __e2eLoseContext: WEBGL_lose_context }).__e2eLoseContext = ext;
    ext.loseContext();
  }, tag);

/** Wait until the ride clock has run `ms` further. */
async function rideOn(page: Page, ms: number) {
  const from = (await ride(page)).elapsedMs;
  await expect.poll(async () => (await ride(page)).elapsedMs, { timeout: 60_000 }).toBeGreaterThan(from + ms);
}

/** Distinct colours in a canvas-only screenshot (every 7th pixel): a drawn world has thousands, a dead canvas a handful. */
async function worldVariety(page: Page): Promise<number> {
  await page.evaluate(() => document.documentElement.classList.add('canvas-only'));
  const png = await page.screenshot();
  await page.evaluate(() => document.documentElement.classList.remove('canvas-only'));
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const img = await createImageBitmap(blob);
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < d.length; i += 4 * 7) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return seen.size;
  }, png.toString('base64'));
}

// Fewer pixels for SwiftShader to fill; the HUD keeps its desktop layout.
test.use({ viewport: { width: 960, height: 540 } });

test('a lost WebGL context: the chip says so, the ride never stops, and the world draws again (restore, then tap)', async ({ page }) => {
  // Two world rebuilds on software GL.
  test.setTimeout(420_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.addInitScript(INIT);

  await page.goto('/app');
  await rideScenicRoute(page, 'scenic-perugia-tiber-park', 'Tiber river park');
  const view = page.locator('[data-renderer]');
  await expect(view).toHaveAttribute('data-renderer', 'world');
  const world = page.locator('[data-world-context]');
  const chip = page.getByTestId('ride-status-chip');

  // Riding, and the world drawing.
  await expect.poll(async () => (await ride(page)).rideState, { timeout: 90_000 }).toBe('running');
  await expect.poll(async () => (await canvasState(page)).frames, { timeout: 60_000 }).toBeGreaterThan(2);
  expect(await canvasState(page)).toMatchObject({ count: 1, current: true, lost: false });
  expect(await page.evaluate(() => (window as unknown as { __veloRideDebug: () => { quality: string } }).__veloRideDebug().quality)).toBe('low');
  const drawn = await worldVariety(page);
  expect(drawn, 'the world draws before the loss').toBeGreaterThan(500);
  const clock: RideProbe[] = [await ride(page)];

  // ---- 1. The context is lost, and the browser restores it ----
  await loseContext(page, 'first');
  await expect(chip).toHaveText(CHIP);
  await expect(chip).toBeVisible();
  await expect(world).toHaveAttribute('data-world-context', 'lost');
  expect((await canvasState(page)).lost).toBe(true);
  // The ride carries on while the world is dead: clock, distance and the recording.
  clock.push(await ride(page));
  await rideOn(page, 2_000);
  clock.push(await ride(page));

  await page.evaluate(() => (window as unknown as { __e2eLoseContext: WEBGL_lose_context }).__e2eLoseContext.restoreContext());
  await expect(world).toHaveAttribute('data-world-context', 'live');
  await expect(chip).not.toHaveText(CHIP);
  // A new canvas (the old one is gone), on a live context, drawing frames.
  await expect.poll(async () => canvasState(page), { timeout: 60_000 }).toMatchObject({ count: 1, current: true, lost: false, tagged: null });
  await expect.poll(async () => (await canvasState(page)).frames, { timeout: 120_000 }).toBeGreaterThan(2);
  expect(await worldVariety(page), 'the world draws again after the restore').toBeGreaterThan(500);
  clock.push(await ride(page));

  // ---- 2. Lost again, no restore: the rider taps the chip ----
  await loseContext(page, 'second');
  await expect(chip).toHaveText(CHIP);
  await expect(world).toHaveAttribute('data-world-context', 'lost');
  clock.push(await ride(page));
  await rideOn(page, 2_000);
  clock.push(await ride(page));
  await chip.click();
  await expect(world).toHaveAttribute('data-world-context', 'live');
  await expect(chip).not.toHaveText(CHIP);
  await expect.poll(async () => canvasState(page), { timeout: 60_000 }).toMatchObject({ count: 1, current: true, lost: false, tagged: null });
  await expect.poll(async () => (await canvasState(page)).frames, { timeout: 120_000 }).toBeGreaterThan(2);
  expect(await worldVariety(page), 'the world draws again after the tap').toBeGreaterThan(500);
  clock.push(await ride(page));

  // The ride clock never stopped: running at every sample; time, distance and
  // the recorded samples never went back, and moved on across each dead window.
  for (const [i, s] of clock.entries()) {
    expect(s.rideState, `sample ${i}`).toBe('running');
    if (i === 0) continue;
    expect(s.elapsedMs, `elapsed at sample ${i}`).toBeGreaterThanOrEqual(clock[i - 1].elapsedMs);
    expect(s.distance, `distance at sample ${i}`).toBeGreaterThanOrEqual(clock[i - 1].distance);
    expect(s.samples, `recorded samples at sample ${i}`).toBeGreaterThanOrEqual(clock[i - 1].samples);
  }
  // Samples 1-2 and 4-5 bracket the two dead windows.
  for (const [a, b] of [[1, 2], [4, 5]] as const) {
    expect(clock[b].elapsedMs - clock[a].elapsedMs, `ride time while dead (${a}-${b})`).toBeGreaterThan(2_000);
    expect(clock[b].distance, `distance while dead (${a}-${b})`).toBeGreaterThan(clock[a].distance);
  }
  expect(clock[clock.length - 1].samples).toBeGreaterThan(clock[0].samples);
  expect(pageErrors).toEqual([]);
});
