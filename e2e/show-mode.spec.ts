/**
 * Journey mode — "ride over anything" (blueprint §P2.3). Headed Chrome only
 * (Document Picture-in-Picture has no headless window): CI job 'show-mode'
 * runs this under xvfb as the Playwright project of the same name.
 *
 * Home → Perugia route → show mode → "Watch another tab": the ride view
 * opens in a Document PiP window. Then another tab comes to the front and
 * the Velo tab is really hidden. While the window floats, the hidden tab
 * keeps the ride loop running at frame rate and records a sample a second,
 * and the downloaded FIT holds records for every second it was hidden.
 *
 * Control: with the window closed and the tab hidden again, the loop stops
 * (requestAnimationFrame pauses in hidden tabs). That proves the test really
 * backgrounds the tab, so the first half is not passing by accident.
 *
 * Driven over the raw DevTools protocol, not Playwright's page API, for
 * three reasons: Playwright pauses every new target (the PiP window shares
 * the tab's event loop, so the tab hangs until it is released), forces its
 * viewport onto the PiP window, and turns off Chrome's background
 * throttling and focus handling, which is the behaviour under test.
 * Under xvfb, with no window manager, Chrome ignores the requested window
 * size, so the spec sets the window's bounds itself as a window manager would.
 *
 * The second test is the owner's laptop: a 1280 CSS px wide screen at device
 * pixel ratio 2 (Chrome on a 2560x1600 panel at scale 2; CI's xvfb screen is
 * 2560x1600). At every size Velo asks for there, the world fills the window
 * (r3f left a canvas from another window at its buffer size: 1.5x the window
 * at DPR 2), the rider sits above the bar, and the bar's figures and Pause fit
 * even with the widest figures (review of PR #36 @bbe04db, D1/D2).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { PIP_SIZES, pipWindowSize } from '../src/lib/show/pip';

// velo.debug.three: the renderer's scene handle (window.__veloThree), see below.
const INIT = `
  localStorage.setItem('velo.debug.three', '1');
  localStorage.removeItem('globeride.cesiumIonToken');
  localStorage.setItem('globeride.onboarding.v2', JSON.stringify({ state: { hasSeenOnboarding: true }, version: 2 }));
`;

const GL_ARGS = (process.env.PW_GL_ARGS ?? '--use-angle=swiftshader --enable-unsafe-swiftshader').split(' ').filter(Boolean);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RideProbe {
  rideState: string;
  elapsedMs: number;
  distance: number;
  samples: number;
  visibility: DocumentVisibilityState;
}

/** One DevTools websocket, request/response. */
class Cdp {
  private id = 0;
  private pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  private listeners = new Map<string, ((params: Record<string, unknown>) => void)[]>();
  private constructor(private ws: WebSocket) {
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: { message: string };
      };
      if (d.method) for (const fn of this.listeners.get(d.method) ?? []) fn(d.params ?? {});
      if (d.id === undefined) return;
      const p = this.pending.get(d.id);
      this.pending.delete(d.id);
      if (d.error) p?.fail(new Error(d.error.message));
      else p?.ok(d.result);
    };
  }
  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => {
      ws.onopen = ok;
      ws.onerror = () => fail(new Error(`cannot open ${url}`));
    });
    return new Cdp(ws);
  }
  on(method: string, fn: (params: Record<string, unknown>) => void) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), fn]);
  }
  send<T = Record<string, unknown>>(method: string, params: object = {}): Promise<T> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, fail) => this.pending.set(id, { ok: ok as (v: unknown) => void, fail }));
  }
  close() {
    this.ws.close();
  }
}

async function poll<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeout: number, what: string): Promise<T> {
  const end = Date.now() + timeout;
  let last: T | undefined;
  for (;;) {
    try {
      last = await read();
      if (ok(last)) return last;
    } catch {
      // Navigation in flight, or not there yet: try again.
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
    await sleep(250);
  }
}

class Tab {
  constructor(
    readonly cdp: Cdp,
    readonly targetId: string,
  ) {}

  async eval<T>(expression: string): Promise<T> {
    const r = await this.cdp.send<{ result: { value?: T }; exceptionDetails?: { text: string } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.text} in ${expression.slice(0, 80)}`);
    return r.result.value as T;
  }

  /** Waits for a visible element (`find` is a JS expression returning it), then clicks it like a person. */
  async click(find: string, what: string, timeout = 30_000): Promise<void> {
    const at = await poll(
      () =>
        this.eval<[number, number] | null>(`(() => {
          const el = (${find});
          if (!el) return null;
          el.scrollIntoView({ block: 'center' });
          const b = el.getBoundingClientRect();
          return [b.x + b.width / 2, b.y + b.height / 2];
        })()`),
      (v) => v !== null,
      timeout,
      what,
    );
    // The element must be the one on top at that point (not covered by something else).
    const hit = await this.eval<string | null>(`(() => {
      const el = (${find});
      const t = document.elementFromPoint(${at![0]}, ${at![1]});
      if (el && t && (el === t || el.contains(t))) return null;
      const chain = (x) => { const out = []; for (let n = x; n && n !== document.body; n = n.parentElement) { const cs = getComputedStyle(n); out.push(n.tagName + '[' + cs.position + ' z=' + cs.zIndex + ' op=' + cs.opacity + ' pe=' + cs.pointerEvents + ']'); } return out.join(' < '); };
      const r = el.getBoundingClientRect();
      return 'top ' + chain(t) + ' || el ' + JSON.stringify([r.x, r.y, r.width, r.height]) + ' ' + chain(el);
    })()`);
    if (hit) throw new Error(`${what} is covered by ${hit}`);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at![0], y: at![1] });
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.cdp.send('Input.dispatchMouseEvent', { type, x: at![0], y: at![1], button: 'left', clickCount: 1 });
    }
  }

  probe = () => this.eval<RideProbe | null>(`(() => { const f = window.__veloRideState; return f ? f() : null; })()`);
}

// checkVisibility: a closed <details> keeps its content's boxes (content-visibility), unpainted.
const shown = `((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.checkVisibility({ visibilityProperty: true }); })`;
/** A visible button by accessible name (aria-label, else its text). */
const button = (name: string | RegExp) => `[...document.querySelectorAll('button, [role=button], a')].find((b) => {
  const n = b.getAttribute('aria-label') || b.textContent.trim();
  return ${shown}(b) && ${typeof name === 'string' ? `n === ${JSON.stringify(name)}` : `${name}.test(n)`};
})`;
const visible = (css: string) => `[...document.querySelectorAll(${JSON.stringify(css)})].find(${shown})`;

const PIP_STATE = `(() => {
  const w = window.documentPictureInPicture && window.documentPictureInPicture.window;
  return {
    open: !!w && !w.closed,
    ride: !!(w && w.document.querySelector('[data-testid="pip-ride"] canvas')),
    bar: !!(w && w.document.querySelector('[data-testid="journey-bar"]')),
    surface: w ? w.document.documentElement.getAttribute('data-surface') : null,
  };
})()`;

/** Record timestamps (FIT seconds) from a FIT file: global message 20, field 253. */
function fitRecordTimes(buf: Buffer): number[] {
  const headerSize = buf[0];
  const end = headerSize + buf.readUInt32LE(4);
  const defs = new Map<number, { global: number; little: boolean; fields: { num: number; size: number }[]; dev: number }>();
  const times: number[] = [];
  let i = headerSize;
  while (i < end) {
    const h = buf[i++];
    if (h & 0x80) throw new Error('compressed timestamp headers are not expected');
    const local = h & 0x0f;
    if (h & 0x40) {
      const little = buf[i + 1] === 0;
      const global = little ? buf.readUInt16LE(i + 2) : buf.readUInt16BE(i + 2);
      const n = buf[i + 4];
      i += 5;
      const fields = [];
      for (let f = 0; f < n; f++, i += 3) fields.push({ num: buf[i], size: buf[i + 1] });
      let dev = 0;
      if (h & 0x20) {
        const nd = buf[i++];
        for (let f = 0; f < nd; f++, i += 3) dev += buf[i + 1];
      }
      defs.set(local, { global, little, fields, dev });
    } else {
      const d = defs.get(local);
      if (!d) throw new Error(`data message for undefined local type ${local}`);
      let at = i;
      for (const f of d.fields) {
        if (d.global === 20 && f.num === 253) times.push(d.little ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
        at += f.size;
      }
      i = at + d.dev;
    }
  }
  return times;
}
const FIT_EPOCH_S = 631065600;

let proc: ChildProcess | null = null;
let profile: string | null = null;
const sockets: Cdp[] = [];

test.afterEach(async () => {
  for (const s of sockets) s.close();
  if (proc && proc.exitCode === null) {
    const exited = once(proc, 'exit');
    proc.kill();
    await exited;
  }
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
});

/**
 * A real headed Chrome on Chrome's own defaults (background throttling on),
 * driven over the DevTools protocol; its first tab, with the init script and
 * an error log.
 */
async function startChrome(extraArgs: string[]) {
  profile = mkdtempSync(join(tmpdir(), 'velo-show-mode-'));
  proc = spawn(
    process.env.PW_CHROMIUM || chromium.executablePath(),
    [
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--password-store=basic',
      // Two windows composited by software GL crawl; composite on the CPU (WebGL stays on GL).
      '--disable-gpu-compositing',
      ...extraArgs,
      ...GL_ARGS,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const port = await poll(
    async () => readFileSync(join(profile!, 'DevToolsActivePort'), 'utf8').split('\n')[0],
    (p) => !!p,
    20_000,
    'Chrome to start',
  );
  const devtools = `http://127.0.0.1:${port}`;
  const version = (await (await fetch(`${devtools}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const browser = await Cdp.open(version.webSocketDebuggerUrl);
  sockets.push(browser);
  const targets = (await (await fetch(`${devtools}/json/list`)).json()) as {
    id: string;
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const first = targets.find((t) => t.type === 'page')!;
  const pageCdp = await Cdp.open(first.webSocketDebuggerUrl);
  sockets.push(pageCdp);
  const page = new Tab(pageCdp, first.id);
  // The page's console, for the report when something fails.
  const consoleLines: string[] = [];
  page.cdp.on('Runtime.consoleAPICalled', (p) => {
    const args = (p.args as { value?: unknown; description?: string }[]) ?? [];
    consoleLines.push(`${String(p.type)}: ${args.map((x) => String(x.value ?? x.description ?? '')).join(' ')}`.slice(0, 300));
  });
  await page.cdp.send('Runtime.enable');
  await page.cdp.send('Page.enable');
  await page.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `${INIT}
      window.__errors = [];
      window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
      window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));`,
  });
  return { browser, page, consoleLines };
}

/**
 * Software GL (SwiftShader on a CI runner, no GPU) needs up to seconds per
 * frame of the world. That stalls the page (a click's user activation can
 * expire before its handler runs) and the frame pipeline whatever the tab
 * state, which says nothing about throttling or layout. So the scene is
 * switched off around the clicks and the measurements (window.__veloThree,
 * the renderer's debug handle): the window, the renderer's frame loop, the
 * camera, the ride loop and recording all still run, with an empty frame to
 * draw. On a real GPU none of this is needed.
 */
const sceneOffIn = (page: Tab) => () =>
  page.eval<boolean>(`(() => { if (window.__veloThree) window.__veloThree.scene.visible = false; return !!window.__veloThree; })()`);

/** Home → Perugia (the baked world renderer, no token) → riding, scene off. */
async function ridePerugia(page: Tab) {
  await page.click(
    `(${visible('[data-scenic-route="scenic-perugia-tiber-park"]')}) || (${button('Ride Tiber river park')})`,
    'the Perugia route',
  );
  // Scene off first: at DPR 2 software GL draws a 2560 px wide frame in seconds.
  await poll(sceneOffIn(page), (v) => v, 90_000, 'the renderer handle');
  await poll(() => page.probe(), (p) => (p?.distance ?? 0) > 5, 90_000, 'the ride to move');
}

/** Show mode, then "Watch another tab": the ride in its floating window, its world loaded. */
async function floatTheRide(page: Tab, consoleLines: string[]) {
  await page.click(button(/^Show ride details/), 'ride details');
  await page.click(button('Watch a show while you ride'), 'show mode');
  // A click opens the window (Chrome needs the user activation). Under xvfb
  // the first synthetic click can land before the window has focus: retry.
  try {
    await poll(
      async () => {
        if ((await page.eval<{ open: boolean }>(PIP_STATE)).open) return true;
        await page.click(visible('[data-testid="watch-another-tab"]'), 'Watch another tab');
        await sleep(2_000);
        return (await page.eval<{ open: boolean }>(PIP_STATE)).open;
      },
      (open) => open,
      20_000,
      'the floating window',
    );
    await poll(() => page.eval<{ ride: boolean }>(PIP_STATE), (s) => s.ride, 90_000, 'the ride in the floating window');
  } catch (err) {
    throw new Error(`${err}\npage console:\n${consoleLines.filter((l) => !l.includes('THREE.')).join('\n')}`);
  }
}

test('the ride floats in a picture-in-picture window and keeps riding and recording in a hidden tab', async ({ baseURL }) => {
  // The world loads twice (tab, then window) and back on software GL.
  test.setTimeout(480_000);
  const { browser, page, consoleLines } = await startChrome(['--window-size=1440,1000']);
  await page.cdp.send('Page.navigate', { url: `${baseURL}/app` });
  await poll(() => page.eval<string>('document.readyState'), (s) => s === 'complete', 30_000, 'Home to load');

  expect(await page.eval<boolean>(`'documentPictureInPicture' in window`), 'Document Picture-in-Picture (Chrome/Edge 116+)').toBe(true);

  // ---- Perugia, then show mode and the ride floating over "another tab" ----
  await ridePerugia(page);
  const sceneOff = sceneOffIn(page);
  await floatTheRide(page, consoleLines);
  // Corner size. Under xvfb (no window manager) Chrome opens the window at
  // nearly full size whatever was asked; set its bounds as a window manager would.
  const { targetInfos } = await browser.send<{ targetInfos: { targetId: string; openerId?: string }[] }>('Target.getTargets');
  const pipTarget = targetInfos.find((t) => t.openerId === page.targetId);
  expect(pipTarget, 'the floating window is a window of its own').toBeTruthy();
  const { windowId } = await browser.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: pipTarget!.targetId });
  await browser.send('Browser.setWindowBounds', { windowId, bounds: { left: 1400, top: 760, width: 480, height: 300 } });
  const size = await poll(
    () => page.eval<[number, number]>(`[documentPictureInPicture.window.innerWidth, documentPictureInPicture.window.innerHeight]`),
    ([w]) => w <= 500,
    10_000,
    'the window at corner size',
  );
  // The window's type scales with its width (16 px at the corner size).
  expect(await page.eval<string>(`getComputedStyle(documentPictureInPicture.window.document.documentElement).fontSize`), `at ${size}`).toBe('16px');
  const pip = await page.eval<{ bar: boolean; surface: string | null }>(PIP_STATE);
  expect(pip.bar).toBe(true);
  expect(pip.surface).toBe('pip');
  // The tab says where the ride went; one world view at a time.
  expect(await page.eval<boolean>(`!!document.querySelector('[data-testid="ride-floating-notice"]')`)).toBe(true);
  expect(await page.eval<number>(`document.querySelectorAll('[data-renderer]').length`)).toBe(0);

  // ---- Another tab in front: the Velo tab is hidden, the window floats on ----
  const background = async () => {
    const t = await browser.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', newWindow: false });
    await browser.send('Target.activateTarget', { targetId: t.targetId });
    await poll(() => page.probe(), (p) => p?.visibility === 'hidden', 15_000, 'the Velo tab to be hidden');
    return t.targetId;
  };
  const foreground = async (other: string) => {
    await browser.send('Target.activateTarget', { targetId: page.targetId });
    await browser.send('Target.closeTarget', { targetId: other });
    await poll(() => page.probe(), (p) => p?.visibility === 'visible', 15_000, 'the Velo tab to be visible');
  };

  // Frame counter in the tab (its own requestAnimationFrame, which drives the ride loop).
  await page.eval(
    `(() => { window.__rafCount = 0; const tick = () => { window.__rafCount++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`,
  );
  /** Frames, ride seconds and samples over `ms` of wall time. */
  const measure = async (ms: number) => {
    const f0 = await page.eval<number>('window.__rafCount');
    const p0 = (await page.probe())!;
    const t0 = Date.now();
    await sleep(ms);
    const f1 = await page.eval<number>('window.__rafCount');
    const p1 = (await page.probe())!;
    return {
      frames: f1 - f0,
      rideS: (p1.elapsedMs - p0.elapsedMs) / 1000,
      samples: p1.samples - p0.samples,
      metres: p1.distance - p0.distance,
      from: t0,
      to: Date.now(),
      end: p1,
    };
  };
  // The world loads afresh in the window; let it settle and the ride carry on there.
  await poll(
    () =>
      page.eval<string | null>(
        `documentPictureInPicture.window.document.querySelector('[data-world-status]')?.getAttribute('data-world-status') ?? null`,
      ),
    (v) => v === 'ready',
    90_000,
    'the world in the window',
  );
  const settled = (await page.probe())!.samples;
  await poll(() => page.probe(), (p) => (p?.samples ?? 0) >= settled + 2, 90_000, 'the ride to carry on in the window');

  // The window's world is a new scene: off as well (see above).
  await poll(sceneOff, (v) => v, 30_000, 'the renderer handle in the window');
  await sleep(1_000);
  const seen = await measure(3_000);

  const other = await background();
  const hidden = await measure(10_000);
  const report = `visible ${JSON.stringify(seen)} hidden ${JSON.stringify(hidden)}`;
  console.info(`show-mode: tab in front ${seen.frames} frames / 3 s; hidden behind another tab ${hidden.frames} frames, ${hidden.rideS.toFixed(1)} ride s, ${hidden.samples} samples / 10 s`);
  expect(hidden.end.visibility).toBe('hidden');
  expect((await page.eval<{ open: boolean }>(PIP_STATE)).open).toBe(true);
  expect(hidden.end.rideState).toBe('running');
  // The hidden tab kept its frame rate (a throttled tab gets none)...
  expect(hidden.frames / 10, report).toBeGreaterThan(Math.min(20, (seen.frames / 3) * 0.5));
  // ...so the ride clock kept real time, the ride moved on, and it recorded a sample a second.
  expect(hidden.rideS, report).toBeGreaterThan(8);
  expect(hidden.metres, report).toBeGreaterThan(10);
  expect(hidden.samples, report).toBeGreaterThanOrEqual(9);
  const hiddenFrom = hidden.from;
  const hiddenTo = hidden.to;

  // ---- The next landmark keeps its distance whole (review of PR #36 @61defbb, F2) ----
  await foreground(other);
  await landmarkLineAtWidth(browser, page, windowId, 640, 360);

  // ---- Bring the ride back to the tab ----
  await page.click(button('Bring the ride back'), 'Bring the ride back');
  await poll(() => page.eval<{ open: boolean }>(PIP_STATE), (s) => !s.open, 15_000, 'the window to close');
  await poll(
    () => page.eval<boolean>(`!!document.querySelector('[data-renderer] canvas')`),
    (v) => v,
    60_000,
    'the world back in the tab',
  );
  await poll(sceneOff, (v) => v, 30_000, 'the renderer handle back in the tab');

  // ---- Control: hidden again with no window, the loop stops ----
  const other2 = await background();
  const control = await measure(5_000);
  expect(control.frames, `a hidden tab with no window gets no frames, else this test proves nothing: ${JSON.stringify(control)}`).toBe(0);
  expect(control.samples).toBe(0);
  console.info(`show-mode: control (hidden, no window) ${control.frames} frames, ${control.samples} samples / 5 s`);
  await foreground(other2);

  // ---- Finish and export the FIT: the hidden seconds are in it ----
  await page.eval(`(() => {
    const orig = URL.createObjectURL.bind(URL);
    window.__blobs = [];
    URL.createObjectURL = (o) => { window.__blobs.push(o); return orig(o); };
  })()`);
  await page.click(button('Close show mode'), 'Close show mode');
  await page.click(button('Finish ride'), 'Finish ride');
  await page.click(button('Save .FIT'), 'Save .FIT');
  const b64 = await poll(
    () =>
      page.eval<string | null>(`(async () => {
        const blob = window.__blobs.find((x) => x && x.type === 'application/vnd.ant.fit');
        if (!blob) return null;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (const x of bytes) s += String.fromCharCode(x);
        return btoa(s);
      })()`),
    (v) => !!v,
    15_000,
    'the FIT file',
  );
  const times = fitRecordTimes(Buffer.from(b64!, 'base64')).map((t) => (t + FIT_EPOCH_S) * 1000);
  // FIT timestamps are whole seconds: widen the window by one each side.
  const whileHidden = times.filter((t) => t >= hiddenFrom - 1000 && t <= hiddenTo + 1000);
  expect(whileHidden.length, 'FIT records while the tab was hidden').toBeGreaterThanOrEqual(hidden.samples);

  expect(await page.eval<string[]>('window.__errors')).toEqual([]);
});

/**
 * The bar's next-landmark line with the widest figures (1:18:05 · 42.2 km ·
 * -12.5 %) and a long place name staged, read from the tab. The name is the
 * part that shortens; the distance stays whole, on one line, inside the bar
 * and clear of Pause. The 640 px window used to show "Bastia Umbra in 6…".
 */
const LANDMARK_LINE = `(() => {
  const w = documentPictureInPicture.window;
  const d = w.document;
  const bar = d.querySelector('[data-testid="journey-bar"]');
  const line = [...bar.querySelectorAll('[data-testid="journey-next"]')].find((e) => e.checkVisibility());
  if (!line) return null;
  const name = line.querySelector('[data-testid="landmark-name"]');
  const dist = line.querySelector('[data-testid="landmark-distance"]');
  const pause = bar.querySelector('button');
  const box = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, r: b.right, h: b.height }; };
  const real = line.textContent;
  const nums = [...bar.querySelectorAll('.num')];
  const swap = [...nums, ...(name ? [name] : [])].map((e) => [...e.childNodes].find((n) => n.nodeType === 3));
  const was = swap.map((n) => n && n.nodeValue);
  ['1:18:05', '42.2', '-12.5'].forEach((t, i) => { if (swap[i]) swap[i].nodeValue = t; });
  if (name && swap[nums.length]) swap[nums.length].nodeValue = 'Basilica di Santa Maria degli Angeli';
  // The space between name and distance is drawn (it leads the distance part, so it must not collapse).
  const lead = dist && [...dist.childNodes].find((n) => n.nodeType === 3);
  let spaceW = 0;
  if (lead && lead.nodeValue.startsWith(' ')) { const rg = d.createRange(); rg.setStart(lead, 0); rg.setEnd(lead, 1); spaceW = rg.getBoundingClientRect().width; }
  const out = {
    inner: [w.innerWidth, w.innerHeight],
    real,
    text: line.textContent,
    spaceW,
    dist: dist ? { text: dist.textContent, scrollW: dist.scrollWidth, clientW: dist.clientWidth, ...box(dist) } : null,
    name: name ? { scrollW: name.scrollWidth, clientW: name.clientWidth, ...box(name) } : null,
    line: box(line),
    bar: { scrollW: bar.scrollWidth, clientW: bar.clientWidth, ...box(bar) },
    pause: pause ? box(pause) : null,
  };
  swap.forEach((n, i) => { if (n) n.nodeValue = was[i]; });
  return out;
})()`;

interface LandmarkLine {
  inner: [number, number];
  real: string;
  text: string;
  spaceW: number;
  dist: { text: string; scrollW: number; clientW: number; x: number; r: number; h: number } | null;
  name: { scrollW: number; clientW: number; x: number; r: number; h: number } | null;
  line: { x: number; r: number; h: number };
  bar: { scrollW: number; clientW: number; x: number; r: number };
  pause: { x: number; r: number } | null;
}

/** Size the floating window (as a window manager would) and check the bar's landmark line there. */
async function landmarkLineAtWidth(browser: Cdp, page: Tab, windowId: number, width: number, height: number) {
  const inner = () => page.eval<[number, number]>('[documentPictureInPicture.window.innerWidth, documentPictureInPicture.window.innerHeight]');
  await browser.send('Browser.setWindowBounds', { windowId, bounds: { width, height } });
  await sleep(300);
  const [iw, ih] = await inner();
  await browser.send('Browser.setWindowBounds', { windowId, bounds: { width: width + (width - iw), height: height + (height - ih) } });
  await poll(inner, ([w]) => w >= width, 5_000, `the window at ${width} px`);
  // From sm (640 px) the line sits in the bar; it needs a named place ahead on the route.
  const g = await poll(() => page.eval<LandmarkLine | null>(LANDMARK_LINE), (v) => !!v, 30_000, 'the next landmark in the bar');
  const at = `window ${g!.inner.join('x')}: ${JSON.stringify(g)}`;
  expect(g!.dist, at).not.toBeNull();
  expect(g!.name, at).not.toBeNull();
  const { dist, name, line, bar, pause } = g as LandmarkLine & { dist: NonNullable<LandmarkLine['dist']>; name: NonNullable<LandmarkLine['name']> };
  expect(dist.text, at).toMatch(/^ (in [\d.]+ (m|km|mi|ft)|· [\d.]+ (m|km|mi|ft) to the top)$/);
  // The distance is whole: not clipped in itself, on one line, inside the line, the bar and left of Pause.
  expect(dist.scrollW, at).toBeLessThanOrEqual(dist.clientW);
  expect(dist.h, at).toBeLessThanOrEqual(name.h + 1);
  expect(dist.r, at).toBeLessThanOrEqual(line.r + 0.5);
  expect(dist.r, at).toBeLessThanOrEqual(bar.r);
  if (pause) expect(dist.r, at).toBeLessThanOrEqual(pause.x);
  expect(g!.spaceW, at).toBeGreaterThan(1);
  // The long name is what shortens, and the bar still fits.
  expect(name.scrollW, at).toBeGreaterThan(name.clientW);
  expect(bar.scrollW, at).toBeLessThanOrEqual(bar.clientW);
  console.info(`show-mode landmark: window ${g!.inner.join('x')}: "${g!.real}"; staged "${g!.text}": name ${name.clientW}/${name.scrollW} px, distance "${dist.text.trim()}" ${dist.clientW} px whole`);
}

/** The floating window's geometry, read from the tab (the window shares its event loop). */
const PIP_GEOMETRY = `(() => {
  const w = documentPictureInPicture.window;
  const d = w.document;
  const box = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
  const root = d.querySelector('[data-testid="pip-ride"]');
  const canvas = root.querySelector('canvas');
  const bar = d.querySelector('[data-testid="journey-bar"]');
  const pause = bar.querySelector('button');
  const shown = (e) => e.getBoundingClientRect().width > 0 && e.checkVisibility();
  const top = [...root.querySelectorAll('[role=radiogroup], [aria-label="Back to the Velo tab"], [data-testid=journey-next]')].filter(shown);
  const bottom = [...bar.parentElement.children].filter(shown);
  // need: padding + shown children + gaps, the row's own width whether or not it fits (the slack).
  const need = () => {
    const cs = w.getComputedStyle(bar);
    const kids = [...bar.children].filter((e) => e.tagName.toLowerCase() !== 'svg' && e.checkVisibility());
    return Math.round(parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.columnGap) * (kids.length - 1) + kids.reduce((a, e) => a + e.getBoundingClientRect().width, 0));
  };
  const fits = () => ({ scrollW: bar.scrollWidth, clientW: bar.clientWidth, need: need(), pause: box(pause), bar: box(bar) });
  const out = {
    inner: [w.innerWidth, w.innerHeight],
    canvas: canvas ? box(canvas) : null,
    topBottom: Math.max(0, ...top.map((e) => e.getBoundingClientRect().bottom)),
    barTop: Math.min(...bottom.map((e) => e.getBoundingClientRect().top)),
    figures: [...bar.querySelectorAll('.num')].map((e) => parseFloat(w.getComputedStyle(e).fontSize)),
    now: fits(),
  };
  // The widest figures a ride gets to: over an hour, a two-digit km, a steep descent.
  const nums = [...bar.querySelectorAll('.num')];
  const was = nums.map((e) => [...e.childNodes].find((n) => n.nodeType === 3));
  const texts = was.map((n) => n && n.nodeValue);
  ['1:18:05', '42.2', '-12.5'].forEach((t, i) => { if (was[i]) was[i].nodeValue = t; });
  out.widest = fits();
  was.forEach((n, i) => { if (n) n.nodeValue = texts[i]; });
  return out;
})()`;

test("at DPR 2 on a 1280-wide laptop screen the world fills the floating window and the bar fits at every size", async ({ baseURL }) => {
  test.setTimeout(480_000);
  const { browser, page, consoleLines } = await startChrome(['--force-device-scale-factor=2', '--window-size=1280,720']);
  await page.cdp.send('Page.navigate', { url: `${baseURL}/app` });
  await poll(() => page.eval<string>('document.readyState'), (s) => s === 'complete', 30_000, 'Home to load');
  const [availWidth, availHeight, dpr] = await page.eval<[number, number, number]>('[screen.availWidth, screen.availHeight, devicePixelRatio]');
  // The owner's laptop: 1280 CSS px wide at DPR 2 (needs an xvfb screen 2560 px wide).
  expect(dpr, 'device pixel ratio').toBe(2);
  expect(availWidth, 'screen width in CSS px (xvfb -screen 0 2560x1600x24)').toBe(1280);
  expect(await page.eval<boolean>(`'documentPictureInPicture' in window`)).toBe(true);

  await ridePerugia(page);
  await floatTheRide(page, consoleLines);
  await poll(
    () => page.eval<string | null>(`documentPictureInPicture.window.document.querySelector('[data-world-status]')?.getAttribute('data-world-status') ?? null`),
    (v) => v === 'ready',
    90_000,
    'the world in the window',
  );
  await poll(sceneOffIn(page), (v) => v, 30_000, 'the renderer handle in the window');

  const { targetInfos } = await browser.send<{ targetInfos: { targetId: string; openerId?: string }[] }>('Target.getTargets');
  const pipTarget = targetInfos.find((t) => t.openerId === page.targetId)!;
  const { windowId } = await browser.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: pipTarget.targetId });
  const inner = () => page.eval<[number, number]>('[documentPictureInPicture.window.innerWidth, documentPictureInPicture.window.innerHeight]');

  for (const size of PIP_SIZES) {
    const asked = pipWindowSize(size, { availWidth, availHeight });
    // No window manager under xvfb: size the window as one would (outer = inner + frame).
    await browser.send('Browser.setWindowBounds', { windowId, bounds: { left: 40, top: 40, width: asked.width, height: asked.height } });
    await sleep(300);
    const [iw, ih] = await inner();
    await browser.send('Browser.setWindowBounds', {
      windowId,
      bounds: { width: asked.width + (asked.width - iw), height: asked.height + (asked.height - ih) },
    });
    // Chrome caps a picture-in-picture window's size; measure what it gave.
    const got = await poll(inner, ([w, h]) => Math.abs(w - asked.width) <= 2 && Math.abs(h - asked.height) <= 2, 5_000, `${size} ${asked.width}x${asked.height}`).catch(inner);
    // A few frames for r3f to resize and the camera to frame above the bar.
    await sleep(1_500);
    const g = await page.eval<{
      inner: [number, number];
      canvas: { w: number; h: number; x: number; y: number } | null;
      topBottom: number;
      barTop: number;
      figures: number[];
      now: { scrollW: number; clientW: number; pause: { x: number; y: number; r: number; b: number }; bar: { r: number } };
      widest: { scrollW: number; clientW: number; need: number; pause: { r: number }; bar: { r: number } };
    }>(PIP_GEOMETRY);
    // Show mode's director films the ride. Its POV shot is from the rider's
    // head (no rider in frame): wait for another shot (each lasts 20-40 s).
    const rider = await poll(
      () =>
        page.eval<{ canvas: [number, number]; riderScreen: [number, number] | null; cameraFromRider: number } | null>(`(() => {
          const d = window.__veloRideDebug && window.__veloRideDebug();
          const t = window.__veloThree;
          if (!d || !t || !d.riderXZ) return null;
          const c = t.camera.position;
          return { canvas: d.canvas, riderScreen: d.riderScreen, cameraFromRider: Math.hypot(c.x - d.riderXZ[0], c.z - d.riderXZ[1]) };
        })()`),
      (d) => !!d?.riderScreen && d.canvas[0] === g.inner[0] && d.canvas[1] === g.inner[1] && d.cameraFromRider > 3,
      50_000,
      `the rider on the ${size} window's canvas`,
    );
    const at = `${size}: asked ${asked.width}x${asked.height}, window ${got.join('x')}, ${JSON.stringify({ ...g, rider })}`;
    // D1: the world fills the window, at its CSS size (not its 1.5x buffer size).
    expect(g.canvas, at).not.toBeNull();
    expect(Math.abs(g.canvas!.w - g.inner[0]), at).toBeLessThanOrEqual(1);
    expect(Math.abs(g.canvas!.h - g.inner[1]), at).toBeLessThanOrEqual(1);
    expect(g.canvas!.x === 0 && g.canvas!.y === 0, at).toBe(true);
    // ...so the rider the camera frames above the bar is where it is drawn.
    expect(rider.canvas, at).toEqual(g.inner);
    expect(rider.riderScreen![1], at).toBeGreaterThan(g.topBottom);
    expect(rider.riderScreen![1], at).toBeLessThan(g.barTop);
    // A clear band for the world between the top controls and the bar.
    expect(g.barTop - g.topBottom, at).toBeGreaterThanOrEqual(g.inner[1] * 0.45);
    // D2: the bar fits, Pause inside it and the window, figures at least text-2xl.
    for (const fit of [g.now, g.widest]) {
      expect(fit.scrollW, at).toBeLessThanOrEqual(fit.clientW);
      expect(fit.pause.r, at).toBeLessThanOrEqual(fit.bar.r);
    }
    expect(g.now.pause.x >= 0 && g.now.pause.y >= 0 && g.now.pause.r <= g.inner[0] && g.now.pause.b <= g.inner[1], at).toBe(true);
    for (const px of g.figures) expect(px, at).toBeGreaterThanOrEqual(24);
    console.info(`show-mode DPR 2: ${size} window ${got.join('x')}: canvas ${g.canvas!.w}x${g.canvas!.h}, rider y ${rider.riderScreen![1]} above bar ${Math.round(g.barTop)}, bar row ${g.widest.need} of ${g.widest.clientW} px at the widest`);
  }
  expect(await page.eval<string[]>('window.__errors')).toEqual([]);
});
