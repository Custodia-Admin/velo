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
 * Window sizes are pinned in pip.test.ts instead: under xvfb, with no
 * window manager, Chrome ignores the requested size.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';

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

test('the ride floats in a picture-in-picture window and keeps riding and recording in a hidden tab', async ({ baseURL }) => {
  // ---- A real headed Chrome on Chrome's own defaults (background throttling on) ----
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
      '--window-size=1440,1000',
      // Two windows composited by software GL crawl; composite on the CPU (WebGL stays on GL).
      '--disable-gpu-compositing',
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
  await page.cdp.send('Page.navigate', { url: `${baseURL}/app` });
  await poll(() => page.eval<string>('document.readyState'), (s) => s === 'complete', 30_000, 'Home to load');

  expect(await page.eval<boolean>(`'documentPictureInPicture' in window`), 'Document Picture-in-Picture (Chrome/Edge 116+)').toBe(true);

  // ---- Perugia (the baked world renderer, no token) ----
  await page.click(
    `(${visible('[data-scenic-route="scenic-perugia-tiber-park"]')}) || (${button('Ride Tiber river park')})`,
    'the Perugia route',
  );
  await poll(() => page.probe(), (p) => (p?.distance ?? 0) > 5, 90_000, 'the ride to move');

  // Software GL (SwiftShader on a CI runner, no GPU) needs up to seconds per
  // frame of the world. That stalls the page (a click's user activation can
  // expire before its handler runs) and the frame pipeline whatever the tab
  // state, which says nothing about throttling. So the scene is switched off
  // around the clicks and the measurement (window.__veloThree, the
  // renderer's debug handle): the window, the renderer's frame loop, the ride
  // loop and recording all still run, with an empty frame to draw. On a real
  // GPU none of this is needed.
  const sceneOff = () => page.eval(`(() => { if (window.__veloThree) window.__veloThree.scene.visible = false; return !!window.__veloThree; })()`);
  await poll(sceneOff, (v) => v, 30_000, 'the renderer handle');

  // ---- Show mode, then float the ride over "another tab" ----
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

  // ---- Bring the ride back to the tab ----
  await foreground(other);
  await page.click(button('Bring the ride back'), 'Bring the ride back');
  await poll(() => page.eval<{ open: boolean }>(PIP_STATE), (s) => !s.open, 15_000, 'the window to close');
  await poll(
    () => page.eval<boolean>(`!!document.querySelector('[data-renderer] canvas')`),
    (v) => v,
    60_000,
    'the world back in the tab',
  );

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
  await page.click(button('Download FIT'), 'Download FIT');
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
