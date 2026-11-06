/**
 * A lost WebGL context mid-ride, token-free, production build.
 *
 * Home → a scenic route → riding: the three.js world (Perugia, card
 * t_14ea510a), then the photoreal Cesium view (a route outside every baked
 * world on the token-free OSM fallback, card t_771036a6). Then the world
 * canvas loses its context for real (WEBGL_lose_context.loseContext(), what a
 * GPU reset, a driver update or Chrome's context cap do):
 *   - the one status chip says "3D view stopped · tap to reload" (no error box),
 *   - the dead canvas is hidden, the ride clock, the distance and the
 *     recording keep going the whole time;
 * the browser gives the context back (restoreContext()) → the world view
 * remounts on a new canvas that draws again (pixel variety, frames). Then a
 * second loss with no restore → the rider taps the chip → the same recovery.
 * On photoreal, a frame that throws with the context intact (Cesium's
 * scene.renderError stops its render loop for good) gets the same chip and
 * tap (card t_b2730be0), and Cesium's own error panel never exists, not even
 * hidden in the dead view. So does a throw from a scene.preRender listener,
 * where the ride's per-frame code runs: Cesium raises no renderError for it,
 * its render loop just stops (card t_0342cba8).
 */
import { expect, test, type Page } from '@playwright/test';

const INIT = `
  localStorage.removeItem('globeride.cesiumIonToken');
  // window.__veloThree = the live renderer: its canvas and its own context
  // (calling getContext on a canvas three has not set up yet would create one).
  localStorage.setItem('velo.debug.three', '1');
  // window.__veloCesium = the photoreal view's live Cesium viewer.
  localStorage.setItem('velo.debug.cesium', '1');
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

/**
 * The ride clock never stopped: running at every sample; time, distance and
 * the recorded samples never went back, and moved on across each dead window
 * (by default samples 1-2 and 4-5 bracket the two).
 */
function expectClockNeverStopped(clock: RideProbe[], deadWindows: ReadonlyArray<readonly [number, number]> = [[1, 2], [4, 5]]) {
  for (const [i, s] of clock.entries()) {
    expect(s.rideState, `sample ${i}`).toBe('running');
    if (i === 0) continue;
    expect(s.elapsedMs, `elapsed at sample ${i}`).toBeGreaterThanOrEqual(clock[i - 1].elapsedMs);
    expect(s.distance, `distance at sample ${i}`).toBeGreaterThanOrEqual(clock[i - 1].distance);
    expect(s.samples, `recorded samples at sample ${i}`).toBeGreaterThanOrEqual(clock[i - 1].samples);
  }
  for (const [a, b] of deadWindows) {
    expect(clock[b].elapsedMs - clock[a].elapsedMs, `ride time while dead (${a}-${b})`).toBeGreaterThan(2_000);
    expect(clock[b].distance, `distance while dead (${a}-${b})`).toBeGreaterThan(clock[a].distance);
  }
  expect(clock[clock.length - 1].samples).toBeGreaterThan(clock[0].samples);
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

  expectClockNeverStopped(clock);
  expect(pageErrors).toEqual([]);
});

type CesiumProbe = {
  viewer: {
    canvas: HTMLCanvasElement;
    isDestroyed: () => boolean;
    scene: {
      frameState: { frameNumber: number };
      primitives: { add: (p: object) => unknown };
      preRender: { addEventListener: (fn: () => void) => unknown };
    };
  };
};

/** The photoreal canvas now: how many, whether the live viewer draws into it, its context, frames since it was built. */
const viewerState = (page: Page) =>
  page.evaluate(() => {
    const canvases = [...document.querySelectorAll('[data-renderer] canvas')] as HTMLCanvasElement[];
    const v = (window as unknown as { __veloCesium?: CesiumProbe }).__veloCesium?.viewer;
    const live = !!v && !v.isDestroyed();
    const c = canvases[0];
    // getContext hands back the context the viewer created (same type); it never makes a new one here.
    const gl = live ? ((v.canvas.getContext('webgl2') ?? v.canvas.getContext('webgl')) as WebGLRenderingContext | null) : null;
    return {
      count: canvases.length,
      current: live && v.canvas === c,
      lost: gl ? gl.isContextLost() : null,
      frames: live ? v.scene.frameState.frameNumber : 0,
      tagged: c ? (c.dataset.e2eCanvas ?? null) : null,
      // Cesium's own "Rendering has stopped" panel: never in front of the rider.
      errorPanels: [...document.querySelectorAll('.cesium-widget-errorPanel')].filter((p) => {
        const r = p.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(p).visibility !== 'hidden';
      }).length,
      // ... nor anywhere in the DOM, hidden in the dead view included: it comes
      // with a window 'resize' listener that only its OK button removes, which
      // kept every torn-down viewer alive (card t_b2730be0).
      errorPanelsInDom: document.querySelectorAll('.cesium-widget-errorPanel').length,
    };
  });

/** Lose the viewer canvas's context; keep the extension to restore it later. Tags the canvas. */
const loseViewerContext = (page: Page, tag: string) =>
  page.evaluate((t) => {
    const v = (window as unknown as { __veloCesium: CesiumProbe }).__veloCesium.viewer;
    v.canvas.dataset.e2eCanvas = t;
    const gl = (v.canvas.getContext('webgl2') ?? v.canvas.getContext('webgl')) as WebGLRenderingContext;
    const ext = gl.getExtension('WEBGL_lose_context')!;
    (window as unknown as { __e2eLoseContext: WEBGL_lose_context }).__e2eLoseContext = ext;
    ext.loseContext();
  }, tag);

/** A primitive whose update() throws: Cesium raises scene.renderError and stops its render loop; the context stays. Tags the canvas. */
const throwInAFrame = (page: Page, tag: string) =>
  page.evaluate((t) => {
    const v = (window as unknown as { __veloCesium: CesiumProbe }).__veloCesium.viewer;
    v.canvas.dataset.e2eCanvas = t;
    v.scene.primitives.add({
      update: () => {
        throw new Error('e2e: a frame throws');
      },
      isDestroyed: () => false,
      destroy: () => undefined,
    });
  }, tag);

/**
 * A scene.preRender listener that throws, where the ride's own per-frame code
 * runs (the rider, the chase camera, partners, ghosts). Cesium raises it
 * outside its tryAndCatchError: no renderError, the throw escapes
 * scene.render() and the widget's default render loop catches it and stops
 * for good. Tags the canvas.
 */
const throwInPreRender = (page: Page, tag: string) =>
  page.evaluate((t) => {
    const v = (window as unknown as { __veloCesium: CesiumProbe }).__veloCesium.viewer;
    v.canvas.dataset.e2eCanvas = t;
    v.scene.preRender.addEventListener(() => {
      throw new Error('e2e: a preRender listener throws');
    });
  }, tag);

test('the photoreal view after a lost WebGL context: the chip, the ride carries on, a new viewer draws (restore, then tap; then a frame that throws, tap; then a preRender listener that throws, tap)', async ({ page }) => {
  // Four viewer rebuilds on software GL.
  test.setTimeout(660_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.addInitScript(INIT);

  await page.goto('/app');
  // Bellinzona–Locarno is outside every baked world: photoreal, OSM with no token.
  await rideScenicRoute(page, 'scenic-magadino-plain', 'Bellinzona to Locarno');
  const view = page.locator('[data-renderer]');
  await expect(view).toHaveAttribute('data-renderer', 'photoreal');
  const world = page.locator('[data-world-context]');
  const chip = page.getByTestId('ride-status-chip');

  // Riding, and the viewer drawing.
  await expect.poll(async () => (await ride(page)).rideState, { timeout: 90_000 }).toBe('running');
  await expect.poll(async () => (await viewerState(page)).frames, { timeout: 60_000 }).toBeGreaterThan(10);
  expect(await viewerState(page)).toMatchObject({ count: 1, current: true, lost: false, errorPanels: 0 });
  await expect(world).toHaveAttribute('data-world-context', 'live');
  // Imagery streams into a new viewer over a few frames.
  await expect.poll(() => worldVariety(page), { message: 'the world draws before the loss', timeout: 90_000 }).toBeGreaterThan(300);
  const clock: RideProbe[] = [await ride(page)];

  // ---- 1. The context is lost, and the browser restores it ----
  await loseViewerContext(page, 'first');
  await expect(chip).toHaveText(CHIP);
  await expect(chip).toBeVisible();
  await expect(world).toHaveAttribute('data-world-context', 'lost');
  await expect(world).toHaveCSS('visibility', 'hidden');
  expect(await viewerState(page)).toMatchObject({ lost: true, errorPanels: 0 });
  // The ride carries on while the world is dead: clock, distance and the recording.
  clock.push(await ride(page));
  await rideOn(page, 2_000);
  clock.push(await ride(page));
  expect(await viewerState(page), 'no error box over the ride, nor one hidden in the dead view').toMatchObject({ errorPanels: 0, errorPanelsInDom: 0 });

  await page.evaluate(() => (window as unknown as { __e2eLoseContext: WEBGL_lose_context }).__e2eLoseContext.restoreContext());
  await expect(world).toHaveAttribute('data-world-context', 'live');
  await expect(chip).not.toHaveText(CHIP);
  // A new viewer on a new canvas (the old one is gone), on a live context, drawing frames.
  await expect.poll(async () => viewerState(page), { timeout: 60_000 }).toMatchObject({ count: 1, current: true, lost: false, tagged: null });
  await expect.poll(async () => (await viewerState(page)).frames, { timeout: 120_000 }).toBeGreaterThan(10);
  // Imagery streams into a new viewer over a few frames.
  await expect.poll(() => worldVariety(page), { message: 'the world draws again after the restore', timeout: 90_000 }).toBeGreaterThan(300);
  clock.push(await ride(page));

  // ---- 2. Lost again, no restore: the rider taps the chip ----
  await loseViewerContext(page, 'second');
  await expect(chip).toHaveText(CHIP);
  await expect(world).toHaveAttribute('data-world-context', 'lost');
  clock.push(await ride(page));
  await rideOn(page, 2_000);
  clock.push(await ride(page));
  expect(await viewerState(page)).toMatchObject({ errorPanels: 0, errorPanelsInDom: 0 });
  await chip.click();
  await expect(world).toHaveAttribute('data-world-context', 'live');
  await expect(chip).not.toHaveText(CHIP);
  await expect.poll(async () => viewerState(page), { timeout: 60_000 }).toMatchObject({ count: 1, current: true, lost: false, tagged: null });
  await expect.poll(async () => (await viewerState(page)).frames, { timeout: 120_000 }).toBeGreaterThan(10);
  // Imagery streams into a new viewer over a few frames.
  await expect.poll(() => worldVariety(page), { message: 'the world draws again after the tap', timeout: 90_000 }).toBeGreaterThan(300);
  expect((await viewerState(page)).errorPanels).toBe(0);
  clock.push(await ride(page));

  // ---- 3. A frame throws, the context is fine: the render loop stopped, the same chip and tap ----
  await throwInAFrame(page, 'third');
  await expect(chip).toHaveText(CHIP);
  await expect(world).toHaveAttribute('data-world-context', 'lost');
  await expect(world).toHaveCSS('visibility', 'hidden');
  expect(await viewerState(page)).toMatchObject({ lost: false, tagged: 'third', errorPanels: 0, errorPanelsInDom: 0 });
  await chip.click();
  await expect(world).toHaveAttribute('data-world-context', 'live');
  await expect(chip).not.toHaveText(CHIP);
  await expect.poll(async () => viewerState(page), { timeout: 60_000 }).toMatchObject({ count: 1, current: true, lost: false, tagged: null });
  await expect.poll(async () => (await viewerState(page)).frames, { timeout: 120_000 }).toBeGreaterThan(10);
  await expect.poll(() => worldVariety(page), { message: 'the world draws again after a frame threw', timeout: 90_000 }).toBeGreaterThan(300);
  clock.push(await ride(page));

  // ---- 4. The ride's own per-frame code throws (a preRender listener): no
  // renderError, Cesium's render loop catches it and stops. The same chip and tap ----
  await throwInPreRender(page, 'fourth');
  await expect(chip).toHaveText(CHIP);
  await expect(chip).toBeVisible();
  await expect(world).toHaveAttribute('data-world-context', 'lost');
  await expect(world).toHaveCSS('visibility', 'hidden');
  expect(await viewerState(page)).toMatchObject({ lost: false, tagged: 'fourth', errorPanels: 0, errorPanelsInDom: 0 });
  // The ride carries on while the world is dead.
  clock.push(await ride(page));
  await rideOn(page, 2_000);
  clock.push(await ride(page));
  expect(await viewerState(page), 'still no error box, nor one hidden in the dead view').toMatchObject({ errorPanels: 0, errorPanelsInDom: 0 });
  await chip.click();
  await expect(world).toHaveAttribute('data-world-context', 'live');
  await expect(chip).not.toHaveText(CHIP);
  await expect.poll(async () => viewerState(page), { timeout: 60_000 }).toMatchObject({ count: 1, current: true, lost: false, tagged: null });
  await expect.poll(async () => (await viewerState(page)).frames, { timeout: 120_000 }).toBeGreaterThan(10);
  await expect.poll(() => worldVariety(page), { message: 'the world draws again after a preRender listener threw', timeout: 90_000 }).toBeGreaterThan(300);
  expect((await viewerState(page)).errorPanelsInDom).toBe(0);
  clock.push(await ride(page));

  // Samples 1-2, 4-5 and 8-9 bracket the three dead windows the ride rode through.
  expectClockNeverStopped(clock, [[1, 2], [4, 5], [8, 9]]);
  expect(pageErrors).toEqual([]);
});
