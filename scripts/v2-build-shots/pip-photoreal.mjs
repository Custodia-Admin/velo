#!/usr/bin/env node
/**
 * Photoreal in the floating ride window: where the rider sits against the
 * JourneyBar. On a route outside a baked world the ride renders with Cesium,
 * which frames the rider above the bar with a cropped, taller canvas
 * (src/renderers/cesium/hudLensCrop.ts; the world renderer shifts its lens the
 * same way, lib/world/hudLens). The first Home tile outside every baked world
 * (its label ends "map view"; ROUTE=<scenic id> picks one), token-free (start
 * the dev server with an empty token: `VITE_CESIUM_ION_TOKEN= npx vite ...`).
 *
 * Headed Chrome under xvfb over the raw DevTools protocol, as pip.mjs
 * (Playwright pauses the picture-in-picture target). One screen per run, the
 * window at the sizes Velo asks for there (src/lib/show/pip.ts):
 *
 *   BASE=http://127.0.0.1:5196 LAYOUT=laptop xvfb-run -a -s "-screen 0 2560x1600x24" \
 *     node scripts/v2-build-shots/pip-photoreal.mjs <out>     # 1280x648 tab, DPR 2
 *   LAYOUT=1440 ... -s "-screen 0 1440x900x24"                 # DPR 1
 *   LAYOUT=tv   ... -s "-screen 0 1920x1080x24"                # DPR 1, ?layout=tv
 *
 * The rider is held at one spot (`__veloCesium.place`, DIST metres, default
 * 1200), rider and bike all magenta, so its pixels are found in the shot, apart
 * from the renderer's own projection: the rider box (magenta pixels) and the
 * renderer's 1 m point (`__veloRideDebug().riderScreen`) against the bar's top
 * edge, both in the window's CSS px. Writes <out>/pipcesium-<layout>-<size>.jpg
 * and <out>/pipcesium-<layout>.json. THEMES=day,night. TAG names a build
 * (before/after) in the file names.
 *
 * The check (exit 1 when it fails): at every size the whole rider, wheels
 * included, sits above the bar: the magenta box's bottom, shot once more with
 * the bar hidden (behind the bar the box would stop at its top edge), above
 * the bar's top edge. Both renderers draw the ride with one vertical field
 * (lib/world/cameraFraming RIDE_FOV_Y_DEG), so the shared lens shift clears
 * the bar in both. CHECK=0 only reports.
 *
 * Also: the tab before floating (<out>/pipcesium-<layout>-tab.jpg, the same
 * box and point); SIZES_JSON='{"wide":[760,240]}' replaces the window sizes
 * (drag-resized windows); RENDERER=world draws the same route with the world
 * renderer instead (ROUTE must be inside a baked world, e.g. lugano-melide),
 * so both renderers can be compared at one spot.
 */
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] ?? join(tmpdir(), 'velo-pip-photoreal');
mkdirSync(OUT, { recursive: true });
const BASE = (process.env.BASE ?? 'http://127.0.0.1:5196').replace(/\/$/, '');
const LAYOUT = process.env.LAYOUT ?? 'laptop';
const TAG = process.env.TAG ? `-${process.env.TAG}` : '';
const THEMES = (process.env.THEMES ?? 'day').split(',');
const DIST = Number(process.env.DIST ?? 1200);
const CHROME = process.env.PW_CHROMIUM ?? '/usr/sbin/chromium';
const GL_ARGS = (process.env.GL ?? '--use-angle=swiftshader --enable-unsafe-swiftshader').split(/\s+/).filter(Boolean);
const PINNED_MS = 1793547000000 + 86_400_000;
const LAYOUTS = {
  laptop: { dsf: 2, window: [1280, 760], tab: [1280, 648], sizes: { corner: [448, 252], third: [512, 288], half: [640, 360] } },
  1440: { dsf: 1, window: [1440, 900], tab: null, sizes: { corner: [448, 252], third: [512, 288], half: [720, 405] } },
  tv: { dsf: 1, window: [1920, 1080], tab: null, query: '?layout=tv', sizes: { corner: [480, 270], third: [640, 360], half: [960, 540] } },
};
const L = LAYOUTS[LAYOUT];
if (!L) throw new Error(`LAYOUT must be one of ${Object.keys(LAYOUTS).join(', ')}`);
if (process.env.SIZES_JSON) L.sizes = JSON.parse(process.env.SIZES_JSON);
const RENDERER = process.env.RENDERER ?? 'photoreal';
if (!['photoreal', 'world'].includes(RENDERER)) throw new Error('RENDERER must be photoreal or world');
const CHECK = process.env.CHECK !== '0';
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  static async open(url) {
    const c = new Cdp();
    c.ws = new WebSocket(url);
    c.id = 0;
    c.pending = new Map();
    c.ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.id === undefined) return;
      const p = c.pending.get(d.id);
      c.pending.delete(d.id);
      if (d.error) p?.fail(new Error(d.error.message));
      else p?.ok(d.result);
    };
    await new Promise((ok, fail) => {
      c.ws.onopen = ok;
      c.ws.onerror = () => fail(new Error(`cannot open ${url}`));
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, fail) => this.pending.set(id, { ok, fail }));
  }
  close() {
    this.ws.close();
  }
}

async function poll(read, ok, timeout, what) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await read();
      if (ok(last)) return last;
    } catch {
      /* not there yet */
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
    await sleep(300);
  }
}

const evalIn = async (cdp, expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text}: ${r.exceptionDetails.exception?.description ?? ''}`);
  return r.result.value;
};

const shown = `((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.checkVisibility({ visibilityProperty: true }); })`;
const button = (name) => `[...document.querySelectorAll('button, [role=button], a')].find((b) => {
  const n = b.getAttribute('aria-label') || b.textContent.trim();
  return ${shown}(b) && ${typeof name === 'string' ? `n === ${JSON.stringify(name)}` : `${name}.test(n)`};
})`;
const visible = (css) => `[...document.querySelectorAll(${JSON.stringify(css)})].find(${shown})`;

async function click(cdp, find, what) {
  const at = await poll(
    () => evalIn(cdp, `(() => { const el = (${find}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`),
    (v) => v !== null,
    60_000,
    what,
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1] });
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: at[0], y: at[1], button: 'left', clickCount: 1 });
  }
}

async function jsClick(cdp, find, what) {
  await poll(() => evalIn(cdp, `(() => { const el = (${find}); if (!el) return false; el.click(); return true; })()`), (v) => v, 60_000, what);
}

/**
 * The magenta rider in a PNG: box and centre in CSS px (device px / dpr), and
 * the distinct colours in the window's middle band (a drawn world has hundreds).
 */
function riderPixels(png, dpr) {
  const py = `
import json, sys
from PIL import Image
im = Image.open(${JSON.stringify(png)}).convert('RGB')
w, h = im.size
px = im.load()
xs, ys = [], []
for y in range(h):
    for x in range(w):
        r, g, b = px[x, y]
        if r > 150 and b > 150 and g < 0.55 * min(r, b):
            xs.append(x); ys.append(y)
band = len(im.crop((0, int(h * 0.3), w, int(h * 0.7))).getcolors(1 << 24))
d = ${dpr}
if xs:
    print(json.dumps({'n': len(xs), 'box': [round(min(xs) / d, 1), round(min(ys) / d, 1), round(max(xs) / d, 1), round(max(ys) / d, 1)],
      'centre': [round(sum(xs) / len(xs) / d, 1), round(sum(ys) / len(ys) / d, 1)], 'band': band}))
else:
    print(json.dumps({'n': 0, 'band': band}))
`;
  return JSON.parse(execFileSync('uv', ['run', '--quiet', '--with', 'pillow', 'python', '-c', py]).toString());
}

function toJpeg(png, jpg) {
  execFileSync('uv', ['run', '--quiet', '--with', 'pillow', 'python', '-c',
    `from PIL import Image; Image.open(${JSON.stringify(png)}).convert('RGB').save(${JSON.stringify(jpg)}, 'JPEG', quality=86, optimize=True, progressive=True)`]);
}

function init(theme) {
  return `
(() => {
  const shift = ${PINNED_MS} - Date.now();
  const RealDate = Date;
  class PinnedDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + shift); else super(...a); }
    static now() { return RealDate.now() + shift; }
  }
  globalThis.Date = PinnedDate;
})();
localStorage.setItem('velo.debug.cesium', '1');
localStorage.setItem('velo.debug.three', '1');
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({ state: { hasSeenOnboarding: true }, version: 2 }));
localStorage.setItem('globeride.theme', ${JSON.stringify(theme === 'night' ? 'dark' : 'light')});
localStorage.removeItem('globeride.cesiumIonToken');
(() => {
  let cur = {};
  try { cur = JSON.parse(localStorage.getItem('globeride.settings.v1') || '{}'); } catch {}
  cur.state = Object.assign(cur.state || {}, { renderer: ${JSON.stringify(RENDERER)} });
  cur.version = cur.version ?? 1;
  localStorage.setItem('globeride.settings.v1', JSON.stringify(cur));
})();
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));
(() => {
  const RealWS = window.WebSocket;
  const isHmr = (p) => p === 'vite-hmr' || (Array.isArray(p) && p.includes('vite-hmr'));
  const Fake = function (url, protocols) {
    if (!isHmr(protocols)) return new RealWS(url, protocols);
    return { readyState: 0, url: String(url), protocol: 'vite-hmr', send() {}, close() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } };
  };
  Fake.prototype = RealWS.prototype;
  Object.assign(Fake, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Fake;
})();
`;
}

// Chase camera, the director off, a magenta kit, the rider held at DIST.
const STAGE = `(async () => {
  const { useSettingsStore } = await import('/src/stores/settingsStore.ts');
  const { useShowStore } = await import('/src/stores/showStore.ts');
  useShowStore.getState().setAutoCamera(false);
  const s = useSettingsStore.getState();
  s.setCameraMode('chase');
  const M = '#ff00ff';
  if (s.avatar.wheel !== M) s.setSettings({ avatar: { frame: M, wheel: M, kit: M, skin: M, helmet: M, accent: M } });
  window.__veloCesium?.place(${DIST});
  window.__veloWorldLight?.place(${DIST});
  window.__veloWorldLight?.set({ time: 'noon', weather: 'clear' });
  return { cesium: !!window.__veloCesium, world: !!window.__veloWorldLight, mode: useSettingsStore.getState().cameraMode };
})()`;

const DEBUG = `(() => { const want = ${JSON.stringify(RENDERER)}; if (!document.querySelector('[data-renderer=' + want + ']') && !documentPictureInPicture.window?.document.querySelector('[data-renderer=' + want + ']')) return { notRenderer: want }; const d = window.__veloRideDebug && window.__veloRideDebug(); return d && !d.destroyed ? { rider: d.riderScreen, viewport: d.viewportPx ?? d.canvas ?? null, lensShiftPx: d.lensShiftPx ?? null, riderHeightPx: d.riderHeightPx ?? null, fovYDeg: d.fovYDeg ?? null, dist: Math.round(d.dist ?? d.distance ?? 0) } : null; })()`;

async function settle(page, h) {
  let last = null;
  const until = Date.now() + 150_000;
  while (Date.now() < until) {
    await sleep(3000);
    const now = await evalIn(page, DEBUG).catch(() => null);
    const r = now?.rider;
    if (r && last?.rider && r[1] > 0 && Math.hypot(r[0] - last.rider[0], r[1] - last.rider[1]) <= h * 0.01) return now;
    last = now;
  }
  console.log('  camera still moving after 150 s, measuring anyway', JSON.stringify(last));
  return last;
}

const GEOMETRY = `(() => {
  const w = documentPictureInPicture.window; const d = w.document;
  const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10, Math.round(b.width * 10) / 10, Math.round(b.height * 10) / 10]; };
  const root = d.querySelector('[data-testid=pip-ride]');
  const canvas = d.querySelector('[data-testid=pip-ride] canvas');
  const container = canvas?.closest('.cesium-viewer')?.parentElement ?? null;
  return { window: [w.innerWidth, w.innerHeight, w.devicePixelRatio], renderer: d.querySelector('[data-renderer]')?.getAttribute('data-renderer') ?? null,
    hudBottom: root?.dataset.hudBottom ?? null, bar: r(d.querySelector('[data-testid=journey-bar]')), canvas: r(canvas), buffer: canvas ? [canvas.width, canvas.height] : null,
    container: r(container), containerTop: container?.style.top ?? null, topControls: r(d.querySelector('[aria-label="Back to the Velo tab"]')) };
})()`;

async function run(theme) {
  const profile = mkdtempSync(join(tmpdir(), 'velo-pipcesium-'));
  const proc = spawn(CHROME, [
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--password-store=basic', '--window-position=0,0', '--disable-gpu-compositing',
    '--disable-backgrounding-occluded-windows', '--disable-gpu-watchdog',
    `--force-device-scale-factor=${L.dsf}`, `--window-size=${L.window.join(',')}`,
    ...GL_ARGS, 'about:blank',
  ], { stdio: 'ignore' });
  const sockets = [];
  const report = { layout: LAYOUT, theme, base: BASE, dist: DIST, sizes: {} };
  const suffix = `${TAG}${theme === 'night' ? '-night' : ''}`;
  try {
    const port = await poll(async () => readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0], (p) => !!p, 20_000, 'Chrome');
    const devtools = `http://127.0.0.1:${port}`;
    const browser = await Cdp.open((await (await fetch(`${devtools}/json/version`)).json()).webSocketDebuggerUrl);
    sockets.push(browser);
    const first = (await (await fetch(`${devtools}/json/list`)).json()).find((t) => t.type === 'page');
    const page = await Cdp.open(first.webSocketDebuggerUrl);
    sockets.push(page);
    await page.send('Page.enable');
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: init(theme) });
    if (L.tab) {
      const { windowId: tabWindow } = await browser.send('Browser.getWindowForTarget', { targetId: first.id });
      const vp = () => evalIn(page, '[innerWidth, innerHeight]');
      const [iw, ih] = await poll(vp, (v) => Array.isArray(v), 10_000, 'the tab');
      await browser.send('Browser.setWindowBounds', { windowId: tabWindow, bounds: { left: 0, top: 0, width: L.window[0] + (L.tab[0] - iw), height: L.window[1] + (L.tab[1] - ih) } });
      await poll(vp, ([w, h]) => w === L.tab[0] && h === L.tab[1], 10_000, 'the tab size').catch(() => {});
    }
    report.screen = await evalIn(page, '[screen.availWidth, screen.availHeight, devicePixelRatio, innerWidth, innerHeight]');
    console.log('  screen [availW, availH, dpr, tabW, tabH]', JSON.stringify(report.screen));
    await page.send('Page.navigate', { url: `${BASE}/app${L.query ?? ''}` });
    await poll(() => evalIn(page, 'document.readyState'), (s) => s === 'complete', 60_000, 'Home');
    // A route outside every baked world (its tile says "map view"), or ROUTE.
    report.route = await poll(() => evalIn(page, `(() => { const want = ${JSON.stringify(process.env.ROUTE ?? '')};
      const tiles = [...document.querySelectorAll('[data-scenic-route]')];
      const el = want ? tiles.find((t) => t.dataset.scenicRoute === want) : tiles.find((t) => / map view$/.test(t.getAttribute('aria-label') || ''));
      if (!el) return null; el.click(); return el.dataset.scenicRoute; })()`), (v) => !!v, 60_000, 'a photoreal route tile');
    console.log('  route', report.route);
    report.tabRenderer = await poll(() => evalIn(page, `document.querySelector('[data-renderer]')?.getAttribute('data-renderer') ?? null`), (v) => !!v, 120_000, 'renderer');
    if (report.tabRenderer !== RENDERER) throw new Error(`${report.route} renders with ${report.tabRenderer}, not ${RENDERER}`);
    await poll(() => evalIn(page, `(() => { const f = window.__veloRideState; return f ? f().distance : 0; })()`), (d) => d > 3, 240_000, 'the ride to move');
    // The tab's own ride view, before floating: no crop there.
    await evalIn(page, STAGE);
    const [tabW, tabH] = await evalIn(page, '[innerWidth, innerHeight]');
    await settle(page, tabH);
    report.tab = { debug: await evalIn(page, DEBUG), container: await evalIn(page, `(() => { const c = document.querySelector('canvas')?.closest('.cesium-viewer')?.parentElement; if (!c) return null; const b = c.getBoundingClientRect(); return { rect: [b.x, b.y, b.width, b.height], top: c.style.top, inner: [innerWidth, innerHeight] }; })()`) };
    {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      const png = join(OUT, `pipcesium-${LAYOUT}-tab${suffix}.png`);
      writeFileSync(png, Buffer.from(data, 'base64'));
      report.tab.pixels = riderPixels(png, report.screen[2]);
      report.tab.size = [tabW, tabH];
      toJpeg(png, png.replace(/\.png$/, '.jpg'));
      rmSync(png);
    }
    console.log('  tab', JSON.stringify(report.tab));
    await poll(async () => {
      if (!(await evalIn(page, `!!(${button('Watch a show while you ride')})`))) await jsClick(page, button(/^Show ride details/), 'ride details');
      await sleep(1500);
      return evalIn(page, `!!(${button('Watch a show while you ride')})`);
    }, (v) => v, 90_000, 'the ride tools');
    await jsClick(page, button('Watch a show while you ride'), 'show mode');
    await poll(() => evalIn(page, `!!(${visible('[data-testid="watch-another-tab"]')})`), (v) => v, 60_000, 'Watch another tab');
    await poll(async () => {
      if (await evalIn(page, '!!(documentPictureInPicture.window)')) return true;
      await click(page, visible('[data-testid="watch-another-tab"]'), 'Watch another tab');
      await sleep(3000);
      return evalIn(page, '!!(documentPictureInPicture.window)');
    }, (v) => v, 120_000, 'the floating window');
    const pipT = (await browser.send('Target.getTargets')).targetInfos.find((t) => t.openerId === first.id);
    const { windowId } = await browser.send('Browser.getWindowForTarget', { targetId: pipT.targetId });
    const pip = await Cdp.open((await (await fetch(`${devtools}/json/list`)).json()).find((t) => t.id === pipT.targetId).webSocketDebuggerUrl);
    sockets.push(pip);
    await poll(() => evalIn(page, `documentPictureInPicture.window.document.querySelector('[data-testid=pip-ride] canvas') ? 1 : 0`), (v) => v === 1, 180_000, 'the world in the window');
    const [screenW, screenH] = await evalIn(page, '[screen.width, screen.height]');
    for (const [size, [w, h]] of Object.entries(L.sizes).filter(([k]) => !process.env.ONLY_SIZES || process.env.ONLY_SIZES.split(',').includes(k))) {
      if (['corner', 'third', 'half'].includes(size)) await jsClick(pip, `document.querySelector('[data-pip-size=${size}]')`, `size ${size}`).catch(() => {});
      await sleep(2000);
      await browser.send('Browser.setWindowBounds', { windowId, bounds: { left: screenW - w - 40, top: screenH - h - 80 } });
      const inner = () => evalIn(page, '[documentPictureInPicture.window.innerWidth, documentPictureInPicture.window.innerHeight]');
      for (let i = 0; i < 6; i++) {
        const a = await inner();
        await sleep(1000);
        const b = await inner();
        if (a[0] === b[0] && a[1] === b[1] && ((a[0] === w && a[1] === h) || i >= 3)) break;
        if (a[0] !== b[0] || a[1] !== b[1]) continue;
        const [ow, oh] = await evalIn(page, '[documentPictureInPicture.window.outerWidth, documentPictureInPicture.window.outerHeight]');
        await browser.send('Browser.setWindowBounds', { windowId, bounds: { width: ow + (w - b[0]), height: oh + (h - b[1]) } });
        await sleep(1500);
      }
      await evalIn(page, STAGE);
      const debug = await settle(page, h);
      const geometry = await evalIn(page, GEOMETRY);
      const { data } = await pip.send('Page.captureScreenshot', { format: 'png' });
      const png = join(OUT, `pipcesium-${LAYOUT}-${size}${suffix}.png`);
      writeFileSync(png, Buffer.from(data, 'base64'));
      const pixels = riderPixels(png, geometry.window[2]);
      toJpeg(png, png.replace(/\.png$/, '.jpg'));
      rmSync(png);
      // The whole rider: the bar hidden for one shot (it stays in the layout,
      // so the crop holds), else a rider behind the bar ends at its top edge.
      const barShown = (v) => evalIn(page, `(() => { const b = documentPictureInPicture.window.document.querySelector('[data-testid=journey-bar]'); if (b) b.style.visibility = ${JSON.stringify(v ? '' : 'hidden')}; return !!b; })()`);
      await barShown(false);
      await sleep(1500);
      const whole = await (async () => {
        const shot = await pip.send('Page.captureScreenshot', { format: 'png' });
        const p = join(OUT, `pipcesium-${LAYOUT}-${size}${suffix}-nobar.png`);
        writeFileSync(p, Buffer.from(shot.data, 'base64'));
        const px = riderPixels(p, geometry.window[2]);
        rmSync(p);
        return px;
      })();
      await barShown(true);
      const barTop = geometry.bar ? geometry.bar[1] : null;
      const verdict = {
        barTop,
        riderPointY: debug?.rider?.[1] ?? null,
        riderBoxBottom: pixels.box ? pixels.box[3] : null,
        // The rider's wheels with the bar hidden.
        wheelsY: whole.box ? whole.box[3] : null,
        pointAboveBar: debug?.rider && barTop !== null ? debug.rider[1] < barTop : null,
        boxAboveBar: whole.box && barTop !== null ? whole.box[3] < barTop : null,
        // Wheels to bar top, CSS px (> 0: clear of the bar; < 0: that much behind it).
        wheelGap: whole.box && barTop !== null ? Math.round((barTop - whole.box[3]) * 10) / 10 : null,
        clearBand: geometry.topControls && barTop !== null ? [geometry.topControls[1] + geometry.topControls[3], barTop] : null,
      };
      // The check: a drawn rider, wheels and all, above the bar.
      if (!(whole.n > 0 && verdict.boxAboveBar === true && verdict.pointAboveBar === true)) {
        failures.push(`${LAYOUT} ${size}${suffix}: wheels at ${verdict.wheelsY} / 1 m point ${verdict.riderPointY} vs bar top ${barTop} (gap ${verdict.wheelGap}, magenta px ${whole.n})`);
      }
      report.sizes[size] = { asked: [w, h], debug, geometry, pixels, whole, verdict };
      console.log(`  ${size} ${w}x${h}`, JSON.stringify({ window: geometry.window, renderer: geometry.renderer, hudBottom: geometry.hudBottom, containerTop: geometry.containerTop, canvas: geometry.canvas, buffer: geometry.buffer, debug, pixels, verdict }));
    }
    report.errors = await evalIn(page, 'window.__errors.slice(0, 10)');
    // Back to the tab: the crop must not follow the view home.
    await jsClick(pip, `document.querySelector('[aria-label="Back to the Velo tab"]')`, 'Back to the Velo tab').catch((e) => console.log('  back failed', e.message));
    await poll(() => evalIn(page, '!documentPictureInPicture.window'), (v) => v, 30_000, 'window closed');
    await poll(() => evalIn(page, `document.querySelectorAll('[data-renderer]').length`), (n) => n === 1, 120_000, 'the ride back in the tab');
    await evalIn(page, STAGE);
    await sleep(8000);
    report.back = { debug: await evalIn(page, DEBUG), container: await evalIn(page, `(() => { const c = document.querySelector('canvas')?.closest('.cesium-viewer')?.parentElement; if (!c) return null; const b = c.getBoundingClientRect(); return { rect: [b.x, b.y, b.width, b.height], top: c.style.top, inner: [innerWidth, innerHeight] }; })()`), errors: await evalIn(page, 'window.__errors.slice(0, 10)') };
    console.log('  back in tab', JSON.stringify(report.back));
  } finally {
    writeFileSync(join(OUT, `pipcesium-${LAYOUT}${suffix}.json`), JSON.stringify(report, null, 1));
    for (const s of sockets) s.close();
    proc.kill();
    await once(proc, 'exit').catch(() => {});
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}

for (const theme of THEMES) {
  console.log(`== ${LAYOUT} ${theme} ${RENDERER} ${BASE}`);
  await run(theme);
}
if (failures.length) {
  console.log(`FAIL: the rider is not clear of the bar at ${failures.length} size(s):\n  ${failures.join('\n  ')}`);
  if (CHECK) process.exitCode = 1;
} else {
  console.log('PASS: the rider, wheels included, is above the bar at every size');
}
