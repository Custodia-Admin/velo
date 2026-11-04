#!/usr/bin/env node
/**
 * P2.3 build shots: journey mode, the ride floating in a Document
 * Picture-in-Picture window (docs/design/mockups/v2-pip.html,
 * v2-pip-window.html).
 *
 * Headed Chrome under xvfb, driven over the raw DevTools protocol (Playwright
 * pauses the PiP window's target and forces its viewport onto it; see
 * e2e/show-mode.spec.ts). Staged as mocked: Assisi valley at 6.1 km, 18:05,
 * golden light, day and night themes. Needs a DEV server (staging imports the
 * stores):
 *
 *   BASE=http://localhost:5193 xvfb-run -a -s "-screen 0 1920x1080x24" \
 *     node scripts/v2-build-shots/pip.mjs
 *
 * The owner's laptop (a 1280 CSS px wide screen at device pixel ratio 2, a
 * 1280x648 tab), with Chrome's real scale factor rather than emulation (an
 * emulated DPR hid the window's cropped canvas, review of PR #36 @bbe04db):
 *
 *   BASE=... LAYOUTS=laptop xvfb-run -a -s "-screen 0 2560x1600x24" \
 *     node scripts/v2-build-shots/pip.mjs
 *
 * ONLY_SIZES=corner,third,half picks window sizes; THEMES=day,night the themes.
 * GL overrides the WebGL flags (default software GL), e.g. the Arc GPU:
 *   GL="--use-angle=vulkan --enable-features=Vulkan --enable-gpu --ignore-gpu-blocklist"
 *
 * Writes, in docs/design/screenshots/v2/build/ (OUT overrides):
 *   pipwin-{corner,third,half}[-night].jpg  the window itself at 480x270,
 *                                           640x360, 960x540 (a 1920 screen)
 *   pip-tab-{1440,390,tv}[-night].jpg       the Velo tab while the ride floats
 *                                           (tv: 1920x1080, html[data-layout=tv])
 * and with LAYOUTS=laptop:
 *   pipwin-{corner,third,half}-1280[-night].jpg  the window at 448x252, 512x288,
 *                                           640x360 asked (Chrome caps L), DPR 2
 *   pip-tab-1280[-night].jpg                the Velo tab at 1280x648, DPR 2
 * and the mockup's window at the same sizes in ../mockup/pipwin-*.jpg, so
 * compare.py pairs them. Software GL (no GPU in xvfb): the world is drawn,
 * slowly; the shots wait for it.
 */
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.OUT ?? join(REPO, 'docs/design/screenshots/v2/build');
const MOCK_OUT = join(REPO, 'docs/design/screenshots/v2/mockup');
const BASE = (process.env.BASE ?? 'http://localhost:5193').replace(/\/$/, '');
const THEMES = (process.env.THEMES ?? 'day,night').split(',');
const CHROME = process.env.PW_CHROMIUM ?? '/usr/sbin/chromium';
const SIZES = { corner: [480, 270], third: [640, 360], half: [960, 540] };
// pipWindowSize on a 1280x648 screen (pinned in src/lib/show/pip.test.ts).
const LAPTOP_SIZES = { corner: [448, 252], third: [512, 288], half: [640, 360] };
const GL_ARGS = (process.env.GL ?? '--use-angle=swiftshader --enable-unsafe-swiftshader').split(/\s+/).filter(Boolean);
const PINNED_MS = 1793547000000 + 86_400_000; // 2 Nov 2026 16:30 Rome: Today's ride is Assisi valley.

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
    () =>
      evalIn(
        cdp,
        `(() => { const el = (${find}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`,
      ),
    (v) => v !== null,
    60_000,
    what,
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1] });
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: at[0], y: at[1], button: 'left', clickCount: 1 });
  }
}

/**
 * el.click() for clicks that need no user activation: a busy page can shift between reading a
 * rect and the mouse event, and a pointer click then lands on another route card or on Finish.
 */
async function jsClick(cdp, find, what) {
  await poll(() => evalIn(cdp, `(() => { const el = (${find}); if (!el) return false; el.click(); return true; })()`), (v) => v, 60_000, what);
}

/** Click until `done` (a JS expression) holds: software GL can leave the page too busy for a first click. */
async function clickUntil(cdp, find, done, what, timeout = 90_000) {
  await poll(async () => {
    if (await evalIn(cdp, `!!(${done})`)) return true;
    await click(cdp, find, what);
    await sleep(2500);
    return evalIn(cdp, `!!(${done})`);
  }, (v) => v, timeout, what).catch(async (e) => {
    const btns = await evalIn(cdp, `[...document.querySelectorAll('button')].filter(${shown}).map((b) => b.getAttribute('aria-label') || b.textContent.trim()).join(' | ')`).catch(() => '?');
    throw new Error(`${e.message}; visible buttons: ${btns}`);
  });
}

async function saveJpeg(cdp, path, clip) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  const png = join(tmpdir(), `velo-shot-${process.pid}.png`);
  writeFileSync(png, Buffer.from(data, 'base64'));
  execFileSync('uv', ['run', '--quiet', '--with', 'pillow', 'python', '-c',
    `from PIL import Image; Image.open(${JSON.stringify(png)}).convert('RGB').save(${JSON.stringify(path)}, 'JPEG', quality=84, optimize=True, progressive=True)`]);
  rmSync(png, { force: true });
  console.log('  wrote', path.replace(REPO + '/', ''));
}

/**
 * Wait until the chase camera has caught up with the staged jump: the rider's screen point holds
 * still (within 1 % of the window height over 3 s). Software GL on a loaded machine draws a few
 * frames a second, and a fixed wait shot the camera mid-way (a side view, or close behind with
 * the bike under the bar).
 */
async function settleCamera(page, height) {
  const at = () => evalIn(page, `window.__veloRideDebug?.()?.riderScreen ?? null`);
  let last = await at();
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    await sleep(3000);
    const now = await at();
    if (last && now && Math.hypot(now[0] - last[0], now[1] - last[1]) <= height * 0.01) return now;
    last = now;
  }
  console.log('  camera still moving after 120 s, shooting anyway', JSON.stringify(last));
  return last;
}

/** Distinct colours in the middle 40 % of a shot's height (the clear band): a world has thousands. */
function bandColours(path) {
  return Number(execFileSync('uv', ['run', '--quiet', '--with', 'pillow', 'python', '-c',
    `from PIL import Image; im = Image.open(${JSON.stringify(path)}).convert('RGB'); w, h = im.size; print(len(im.crop((0, int(h * 0.3), w, int(h * 0.7))).getcolors(1 << 24)))`]).toString().trim());
}

/**
 * The window's world as drawn, checked by its pixels rather than the DOM. Software GL in a loaded
 * xvfb once lost the window's WebGL context (white window, a broken-image glyph at its corner;
 * `--disable-gpu-watchdog` below is the fix); a lost context never comes back, so say so and stop.
 * A capture taken mid-frame is retried.
 */
async function savePipJpeg(cdp, path, page) {
  for (let attempt = 1; ; attempt++) {
    await saveJpeg(cdp, path);
    const uniq = bandColours(path);
    if (uniq >= 2000) return;
    const lost = await evalIn(page, `window.__veloThree ? window.__veloThree.gl.getContext().isContextLost() : null`);
    if (lost || attempt >= 4) throw new Error(`${path}: the world is not drawn in the window (${uniq} colours, WebGL context lost: ${lost})`);
    console.log(`  ${path.replace(REPO + '/', '')}: world not drawn in the capture (${uniq} colours), again`);
    await sleep(4000);
  }
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
localStorage.setItem('velo.debug.three', '1');
localStorage.setItem('globeride.onboarding.v2', JSON.stringify({ state: { hasSeenOnboarding: true }, version: 2 }));
localStorage.setItem('globeride.theme', ${JSON.stringify(theme === 'night' ? 'dark' : 'light')});
localStorage.removeItem('globeride.cesiumIonToken');
localStorage.setItem('globeride.velo.riders.v1', JSON.stringify({ state: { activeRiderId: 'rider-1', riders: [
  { id: 'rider-1', name: 'Federico', settings: null, profile: null }, { id: 'rider-2', name: 'Rider 2', settings: null, profile: null }] }, version: 1 }));
// Shared dev server: no HMR reloads mid-shot.
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

// The mockup's still: 18:05 and 6.1 km in, golden light.
// Chase camera as in the still (the director's edit is pinned by its tests).
const STAGE = `(async () => {
  const { useRideStore } = await import('/src/stores/rideStore.ts');
  const { useSettingsStore } = await import('/src/stores/settingsStore.ts');
  const { useShowStore } = await import('/src/stores/showStore.ts');
  useShowStore.getState().setAutoCamera(false);
  useSettingsStore.getState().setCameraMode('chase');
  useRideStore.setState({ distance: 6100, elapsedMs: 1085 * 1000 });
  // Paused at the still's spot so the chase camera settles there (software GL draws a few frames a
  // second: a moving rider on a winding road keeps the camera swinging). FIGURES resumes it.
  if (useRideStore.getState().rideState === 'running') useRideStore.getState().pause();
  window.__veloWorldLight?.set({ time: 'golden', weather: 'clear' });
  return useRideStore.getState().route?.id ?? null;
})()`;

/** Right before a shot: riding again (the bar shows Pause), at the still's numbers (18:05, 6.1 km). */
const FIGURES = `(async () => {
  const { useRideStore } = await import('/src/stores/rideStore.ts');
  if (useRideStore.getState().rideState === 'paused') useRideStore.getState().resume();
  useRideStore.setState({ distance: 6100, elapsedMs: 1085 * 1000 });
  return useRideStore.getState().rideState;
})()`;

/** The mockup's window document at the build's sizes (served over http, as the mockup script does). */
async function mockupWindows(browser, devtools, sizes = SIZES, dpr = 1, tag = '') {
  const root = join(REPO, 'docs/design');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
  const srv = createServer((q, r) => {
    const p = join(root, decodeURIComponent(new URL(q.url, 'http://x').pathname));
    if (!p.startsWith(root) || !existsSync(p)) return r.writeHead(404).end();
    r.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
    r.end(readFileSync(p));
  }).listen(0);
  await once(srv, 'listening');
  const port = srv.address().port;
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', newWindow: false });
  const t = (await (await fetch(`${devtools}/json/list`)).json()).find((x) => x.id === targetId);
  const cdp = await Cdp.open(t.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  for (const theme of THEMES) {
    for (const [size, [w, h]] of Object.entries(sizes)) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: false });
      const q = new URLSearchParams({ size });
      if (theme === 'night') q.set('theme', 'night');
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/mockups/v2-pip-window.html?${q}` });
      await poll(() => evalIn(cdp, 'window.__mockReady === true'), (v) => v, 20_000, 'mockup ready');
      await sleep(300);
      await saveJpeg(cdp, join(MOCK_OUT, `pipwin-${size}${tag}${theme === 'night' ? '-night' : ''}.jpg`));
    }
  }
  cdp.close();
  await browser.send('Target.closeTarget', { targetId });
  srv.close();
}

async function run(theme, layout) {
  const laptop = layout === 'laptop';
  const profile = mkdtempSync(join(tmpdir(), 'velo-pip-shots-'));
  const proc = spawn(CHROME, [
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--password-store=basic', '--window-position=0,0',
    '--disable-gpu-compositing',
    // xvfb has no window manager to keep the picture-in-picture window on top.
    '--disable-backgrounding-occluded-windows',
    // Software GL on a loaded machine can take longer per frame than the GPU watchdog allows; the
    // watchdog then kills the GPU process and the window's WebGL context is lost for good.
    '--disable-gpu-watchdog',
    ...(laptop ? ['--force-device-scale-factor=2', '--window-size=1280,760'] : ['--window-size=1920,1080']),
    ...GL_ARGS, 'about:blank',
  ], { stdio: 'ignore' });
  const sockets = [];
  try {
    const port = await poll(async () => readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0], (p) => !!p, 20_000, 'Chrome');
    const devtools = `http://127.0.0.1:${port}`;
    const browser = await Cdp.open((await (await fetch(`${devtools}/json/version`)).json()).webSocketDebuggerUrl);
    sockets.push(browser);
    if (theme === THEMES[0] && layout === '1440' && process.env.MOCKUPS !== '0') await mockupWindows(browser, devtools);
    if (theme === THEMES[0] && laptop && process.env.MOCKUPS !== '0') await mockupWindows(browser, devtools, LAPTOP_SIZES, 2, '-1280');
    const first = (await (await fetch(`${devtools}/json/list`)).json()).find((t) => t.type === 'page');
    await browser.send('Target.activateTarget', { targetId: first.id });
    const page = await Cdp.open(first.webSocketDebuggerUrl);
    sockets.push(page);
    await page.send('Page.enable');
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: init(theme) });
    const metrics = layout === 'tv' ? { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false } : { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
    if (laptop) {
      // Chrome's own scale factor (no emulation): size the window so the tab is 1280x648.
      const { windowId: tabWindow } = await browser.send('Browser.getWindowForTarget', { targetId: first.id });
      const vp = () => evalIn(page, '[innerWidth, innerHeight, devicePixelRatio, screen.availWidth, screen.availHeight]');
      const [iw, ih] = await poll(vp, (v) => Array.isArray(v), 10_000, 'the tab');
      await browser.send('Browser.setWindowBounds', { windowId: tabWindow, bounds: { left: 0, top: 0, width: 1280 + (1280 - iw), height: 760 + (648 - ih) } });
      const got = await poll(vp, ([w, h]) => w === 1280 && h === 648, 10_000, 'a 1280x648 tab').catch(vp);
      console.log('  laptop tab [w, h, dpr, availW, availH]', JSON.stringify(got));
    } else await page.send('Emulation.setDeviceMetricsOverride', metrics);
    await page.send('Page.navigate', { url: `${BASE}/app${layout === 'tv' ? '?layout=tv' : ''}` });
    await poll(() => evalIn(page, 'document.readyState'), (s) => s === 'complete', 60_000, 'Home');
    await jsClick(page, `(${visible('[data-scenic-route="scenic-assisi-valley"]')}) || (${button(/^Ride Assisi/)})`, 'the Assisi route');
    await poll(() => evalIn(page, `!!document.querySelector('[data-world-status=ready]')`), (v) => v, 180_000, 'the world');
    // The tab's own world is not shot (it goes when the ride floats). Off, so
    // software GL leaves the page responsive and the click keeps its user activation.
    await poll(() => evalIn(page, `(() => { if (window.__veloThree) window.__veloThree.scene.visible = false; return !!window.__veloThree; })()`), (v) => v, 60_000, 'the renderer handle');
    await poll(async () => {
      if (!(await evalIn(page, `!!(${button('Watch a show while you ride')})`))) await jsClick(page, button(/^Show ride details/), 'ride details');
      await sleep(1500);
      return evalIn(page, `!!(${button('Watch a show while you ride')})`);
    }, (v) => v, 90_000, 'the ride tools');
    await jsClick(page, button('Watch a show while you ride'), 'show mode');
    await poll(() => evalIn(page, `!!(${visible('[data-testid="watch-another-tab"]')})`), (v) => v, 60_000, 'Watch another tab');
    // The click must reach the page while it is responsive (user activation): retry.
    await poll(async () => {
      if (await evalIn(page, '!!(documentPictureInPicture.window)')) return true;
      await click(page, visible('[data-testid="watch-another-tab"]'), 'Watch another tab');
      await sleep(3000);
      return evalIn(page, '!!(documentPictureInPicture.window)');
    }, (v) => v, 90_000, 'the floating window').catch(async (e) => {
      const btns = await evalIn(page, `[...document.querySelectorAll('button')].filter(${shown}).map((b) => b.getAttribute('aria-label') || b.textContent.trim()).join(' | ')`);
      throw new Error(`${e.message}; visible buttons: ${btns}; visibility ${await evalIn(page, 'document.visibilityState')}`);
    });
    const pipT = (await browser.send('Target.getTargets')).targetInfos.find((t) => t.openerId === first.id);
    const { windowId } = await browser.send('Browser.getWindowForTarget', { targetId: pipT.targetId });
    const pipWs = (await (await fetch(`${devtools}/json/list`)).json()).find((t) => t.id === pipT.targetId).webSocketDebuggerUrl;
    const pip = await Cdp.open(pipWs);
    sockets.push(pip);
    await poll(() => evalIn(page, `documentPictureInPicture.window.document.querySelector('[data-world-status]')?.getAttribute('data-world-status')`), (v) => v === 'ready', 180_000, 'the world in the window');
    const suffix = theme === 'night' ? '-night' : '';
    // Stage once and let the camera settle at the still's spot (software GL: few frames a second).
    console.log('  staged', await evalIn(page, STAGE));
    await sleep(Number(process.env.FIRST_SETTLE_S ?? 25) * 1000);

    if (layout === '1440' || laptop) {
      const [screenW, screenH] = await evalIn(page, '[screen.width, screen.height]');
      for (const [size, [w, h]] of Object.entries(laptop ? LAPTOP_SIZES : SIZES).filter(([k]) => !process.env.ONLY_SIZES || process.env.ONLY_SIZES.split(',').includes(k))) {
        // The app's own size control first (it resizes the window and highlights the size), then
        // size the window so the document is w x h: the frame (title bar) is outside the document,
        // and a busy Chrome applies resizes late, so re-size from the current outer bounds until
        // the document holds still at w x h (or Chrome's cap stops it).
        await click(pip, `document.querySelector('[data-pip-size=${size}]')`, `size ${size}`).catch(() => {});
        await sleep(2500);
        await browser.send('Browser.setWindowBounds', { windowId, bounds: { left: screenW - w - 40, top: screenH - h - 80 } });
        const inner = () => evalIn(page, '[documentPictureInPicture.window.innerWidth, documentPictureInPicture.window.innerHeight]');
        const close = ([a, b]) => Math.abs(a - w) <= w * 0.05 && Math.abs(b - h) <= h * 0.05;
        // Chrome caps a picture-in-picture window's size (half came out 923x518 on a 1920x1080
        // screen, L 637x358 on the laptop): shoot what it gives there.
        for (let i = 0; i < 6; i++) {
          const a = await inner();
          await sleep(1000);
          const b = await inner();
          if (a[0] === b[0] && a[1] === b[1] && (close(b) || i >= 3)) break;
          if (a[0] !== b[0] || a[1] !== b[1]) continue;
          const [ow, oh] = await evalIn(page, '[documentPictureInPicture.window.outerWidth, documentPictureInPicture.window.outerHeight]');
          await browser.send('Browser.setWindowBounds', { windowId, bounds: { width: ow + (w - b[0]), height: oh + (h - b[1]) } });
          await sleep(1500);
        }
        const got = await poll(inner, close, 15_000, `window ${w}x${h}`).catch((e) => (laptop ? inner() : Promise.reject(e)));
        if (got[0] !== w) console.log(`  window ${size}: asked ${w}x${h}, Chrome gave ${got[0]}x${got[1]}`);
        console.log('  staged', await evalIn(page, STAGE));
        await sleep(Number(process.env.SETTLE_S ?? 12) * 1000);
        await settleCamera(page, h);
        await evalIn(page, FIGURES);
        await sleep(1500);
        await savePipJpeg(pip, join(OUT, `pipwin-${size}${laptop ? '-1280' : ''}${suffix}.jpg`), page);
        const m = await evalIn(page, `(() => { const w = documentPictureInPicture.window; const d = w.document; const r = (s) => { const e = d.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
          const bar = d.querySelector('[data-testid=journey-bar]');
          // Width the bar's one row needs (padding + shown children + gaps), against its clientWidth: the slack.
          const cs = w.getComputedStyle(bar); const kids = [...bar.children].filter((e) => e.tagName !== 'svg' && e.checkVisibility());
          const need = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + kids.reduce((a, e) => a + e.getBoundingClientRect().width, 0) + parseFloat(cs.columnGap) * (kids.length - 1);
          return { window: [w.innerWidth, w.innerHeight, w.devicePixelRatio], canvas: r('[data-testid=pip-ride] canvas'), barScroll: [bar.scrollWidth, bar.clientWidth], barNeed: Math.round(need), pause: r('[data-testid=journey-bar] button'),
            root: getComputedStyle(d.documentElement).fontSize, bar: r('[data-testid=journey-bar]'), next: [...d.querySelectorAll('[data-testid=journey-next]')].filter((e) => e.checkVisibility()).map((e) => e.textContent),
            fig: getComputedStyle(d.querySelector('[data-testid=journey-bar] .num')).fontSize, label: getComputedStyle(d.querySelector('[data-testid=journey-bar] .num').nextElementSibling).fontSize,
            world: d.querySelector('[data-world-status]')?.getAttribute('data-world-status') ?? null, renderer: d.querySelector('[data-renderer]')?.getAttribute('data-renderer') ?? null,
            rider: window.__veloRideDebug?.()?.riderScreen ?? null,
          }; })()`);
        console.log(`  pipwin-${size}${suffix}`, JSON.stringify(m));
      }
    }
    // The tab while the ride floats (1440 / tv; 390 as a phone-width tab).
    // TV: the same tab at 1920x1080 with the TV layout on (html[data-layout=tv], as ?layout=tv sets it).
    const tabShots = laptop
      ? [['1280', null]]
      : [['1440', metrics], ['390', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }], ['tv', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }]];
    for (const [vp, mt] of tabShots) {
      if (mt) await page.send('Emulation.setDeviceMetricsOverride', mt);
      await evalIn(page, `(() => { if (${JSON.stringify(vp)} === 'tv') document.documentElement.dataset.layout = 'tv'; else delete document.documentElement.dataset.layout; })()`);
      await sleep(1500);
      await evalIn(page, STAGE);
      await evalIn(page, FIGURES);
      await sleep(1500);
      await saveJpeg(page, join(OUT, `pip-tab-${vp}${suffix}.jpg`));
      const tm = await evalIn(page, `(() => { const r = (s) => [...document.querySelectorAll(s)].filter(${shown}).map((e) => { const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; });
        return { viewport: [innerWidth, innerHeight, devicePixelRatio], scroll: [document.documentElement.scrollWidth, document.documentElement.clientWidth, document.documentElement.scrollHeight, document.documentElement.clientHeight],
          notice: r('[data-testid=ride-floating-notice] h2'), action: r('[data-testid=ride-floating-notice] button'), strip: r('[data-testid=show-strip]'), close: r('[aria-label="Close show mode"]') }; })()`);
      console.log(`  pip-tab-${vp}${suffix}`, JSON.stringify(tm));
    }
  } finally {
    for (const s of sockets) s.close();
    proc.kill();
    await once(proc, 'exit').catch(() => {});
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}

for (const layout of (process.env.LAYOUTS ?? '1440').split(',')) {
  for (const theme of THEMES) {
    console.log(`== ${layout} ${theme}`);
    await run(theme, layout);
  }
}
