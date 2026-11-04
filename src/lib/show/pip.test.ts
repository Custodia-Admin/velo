import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetRidePipForTests,
  canRideOverAnything,
  closeRidePip,
  copyPageStyles,
  currentRidePip,
  isPipSize,
  nextPipSize,
  openRidePip,
  PIP_MIN_WIDTH,
  PIP_SIZES,
  pipWindowSize,
  resizeRidePip,
  ridePipVersion,
  subscribeRidePip,
} from './pip';

// ---------------------------------------------------------------------------
// Minimal DOM fakes (the unit-test env is node, no jsdom)
// ---------------------------------------------------------------------------

class FakeEl {
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  className = '';
  constructor(
    public tag: string,
    public text = '',
  ) {}
  getAttribute(n: string) {
    return this.attrs.has(n) ? this.attrs.get(n)! : null;
  }
  setAttribute(n: string, v: string) {
    this.attrs.set(n, v);
  }
  removeAttribute(n: string) {
    this.attrs.delete(n);
  }
  appendChild(c: FakeEl) {
    this.children.push(c);
    return c;
  }
  querySelectorAll(sel: string) {
    expect(sel).toBe('link[rel="stylesheet"], style');
    return this.children.filter((c) => c.tag === 'style' || (c.tag === 'link' && c.getAttribute('rel') === 'stylesheet'));
  }
}

class FakeDoc {
  head = new FakeEl('head');
  body = new FakeEl('body');
  documentElement = new FakeEl('html');
  title = '';
  importNode(node: FakeEl) {
    const copy = new FakeEl(node.tag, node.text);
    node.attrs.forEach((v, k) => copy.attrs.set(k, v));
    return copy;
  }
}

class FakeWin extends EventTarget {
  document = new FakeDoc() as unknown as Document;
  closed = false;
  resizeTo = vi.fn();
  constructor(public screen: { availWidth: number; availHeight: number }) {
    super();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(new Event('pagehide'));
  }
}

function link(href: string, rel = 'stylesheet') {
  const l = new FakeEl('link');
  l.setAttribute('rel', rel);
  l.setAttribute('href', href);
  return l;
}

function pageDoc(): FakeDoc {
  const d = new FakeDoc();
  d.head.appendChild(link('/assets/index-abc.css'));
  d.head.appendChild(new FakeEl('style', '.hud-surface{opacity:1}'));
  d.head.appendChild(link('/manifest.webmanifest', 'manifest'));
  d.head.appendChild(new FakeEl('meta'));
  d.documentElement.setAttribute('class', 'dark');
  d.documentElement.setAttribute('lang', 'en');
  d.documentElement.setAttribute('data-layout', 'tv');
  d.body.className = 'antialiased';
  return d;
}

interface Host {
  win: Window;
  requestWindow: ReturnType<typeof vi.fn>;
  opened: FakeWin[];
}

function host(opts: { api?: boolean; top?: 'self' | 'other'; secure?: boolean; reject?: boolean } = {}): Host {
  const opened: FakeWin[] = [];
  const requestWindow = vi.fn(async () => {
    if (opts.reject) throw new DOMException('no activation', 'NotAllowedError');
    const w = new FakeWin({ availWidth: 1920, availHeight: 1080 });
    opened.push(w);
    return w as unknown as Window;
  });
  const win: Record<string, unknown> = {
    document: pageDoc(),
    screen: { availWidth: 1920, availHeight: 1080 },
    isSecureContext: opts.secure ?? true,
  };
  win.top = opts.top === 'other' ? {} : win;
  if (opts.api !== false) win.documentPictureInPicture = { requestWindow, window: null };
  return { win: win as unknown as Window, requestWindow, opened };
}

afterEach(() => {
  __resetRidePipForTests();
});

// ---------------------------------------------------------------------------

describe('capability', () => {
  it('needs the Document Picture-in-Picture API in a secure, top-level page', () => {
    expect(canRideOverAnything(host().win)).toBe(true);
    expect(canRideOverAnything(host({ api: false }).win)).toBe(false);
    expect(canRideOverAnything(host({ top: 'other' }).win)).toBe(false);
    expect(canRideOverAnything(host({ secure: false }).win)).toBe(false);
    expect(canRideOverAnything(undefined)).toBe(false);
    // An API object without requestWindow (a stub, an old build) doesn't count.
    const half = host();
    (half.win as unknown as { documentPictureInPicture: object }).documentPictureInPicture = {};
    expect(canRideOverAnything(half.win)).toBe(false);
  });
});

describe('sizes', () => {
  it('corner, third and half of the screen width, 16:9', () => {
    const tv = { availWidth: 1920, availHeight: 1080 };
    expect(pipWindowSize('corner', tv)).toEqual({ width: 480, height: 270 });
    expect(pipWindowSize('third', tv)).toEqual({ width: 640, height: 360 });
    expect(pipWindowSize('half', tv)).toEqual({ width: 960, height: 540 });
  });

  it('never narrower than the condensed HUD needs, never taller than 90 % of the screen', () => {
    expect(pipWindowSize('corner', { availWidth: 1280, availHeight: 800 })).toEqual({ width: PIP_MIN_WIDTH, height: 180 });
    // A short, wide screen: the height cap wins and the width follows (16:9).
    const short = pipWindowSize('half', { availWidth: 2400, availHeight: 600 });
    expect(short.height).toBe(540);
    expect(short.width).toBe(960);
    // A screen narrower than the minimum: the window fits the screen.
    expect(pipWindowSize('corner', { availWidth: 300, availHeight: 600 }).width).toBe(300);
    // Garbage in: sensible defaults.
    expect(pipWindowSize('third', { availWidth: Number.NaN, availHeight: 0 })).toEqual({ width: 427, height: 240 });
  });

  it('cycles corner → third → half → corner; validates stored values', () => {
    expect(nextPipSize('corner')).toBe('third');
    expect(nextPipSize('third')).toBe('half');
    expect(nextPipSize('half')).toBe('corner');
    for (const s of PIP_SIZES) expect(isPipSize(s)).toBe(true);
    expect(isPipSize('huge')).toBe(false);
    expect(isPipSize(undefined)).toBe(false);
  });
});

describe('copyPageStyles', () => {
  it('copies stylesheet links and style tags in order, the theme, and marks the surface', () => {
    const from = pageDoc();
    const to = new FakeDoc();
    copyPageStyles(from as unknown as Document, to as unknown as Document);
    expect(to.head.children.map((c) => `${c.tag}:${c.getAttribute('href') ?? c.text}`)).toEqual([
      'link:/assets/index-abc.css',
      'style:.hud-surface{opacity:1}',
    ]);
    // Copies, not the page's own nodes.
    expect(to.head.children[0]).not.toBe(from.head.children[0]);
    expect(to.documentElement.getAttribute('class')).toBe('dark');
    expect(to.documentElement.getAttribute('lang')).toBe('en');
    expect(to.documentElement.getAttribute('data-surface')).toBe('pip');
    // The TV layout scales the page; the window scales itself.
    expect(to.documentElement.getAttribute('data-layout')).toBeNull();
    expect(to.body.className).toBe('antialiased');
  });
});

describe('the ride window', () => {
  it('opens at the chosen size with the page styles, and tells subscribers', async () => {
    const h = host();
    const seen: number[] = [];
    subscribeRidePip(() => seen.push(ridePipVersion()));
    const win = await openRidePip('third', { host: h.win, title: 'Velo · Assisi valley' });
    expect(h.requestWindow).toHaveBeenCalledWith({ width: 640, height: 360 });
    expect(win).toBe(h.opened[0]);
    expect(currentRidePip()).toBe(win);
    const doc = h.opened[0].document as unknown as FakeDoc;
    expect(doc.title).toBe('Velo · Assisi valley');
    expect(doc.documentElement.getAttribute('data-surface')).toBe('pip');
    expect(doc.head.children).toHaveLength(2);
    expect(seen).toEqual([1]);
  });

  it('one window at a time: opening again resizes the open one', async () => {
    const h = host();
    const a = await openRidePip('corner', { host: h.win });
    const b = await openRidePip('half', { host: h.win });
    expect(b).toBe(a);
    expect(h.requestWindow).toHaveBeenCalledTimes(1);
    expect(h.opened[0].resizeTo).toHaveBeenCalledWith(960, 540);
  });

  it('closing (by the rider or by Velo) clears it, calls onClose once and tells subscribers', async () => {
    const h = host();
    const onClose = vi.fn();
    const changes = vi.fn();
    subscribeRidePip(changes);
    await openRidePip('corner', { host: h.win, onClose });
    closeRidePip();
    expect(h.opened[0].closed).toBe(true);
    expect(currentRidePip()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledTimes(2);
    closeRidePip(); // nothing open: no-op
    expect(onClose).toHaveBeenCalledTimes(1);

    // The rider closes it from the window's own close button.
    await openRidePip('corner', { host: h.win, onClose });
    h.opened[1].close();
    expect(currentRidePip()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('a window that closed without pagehide is not reported as open', async () => {
    const h = host();
    await openRidePip('corner', { host: h.win });
    h.opened[0].closed = true;
    expect(currentRidePip()).toBeNull();
  });

  it('resolves null without the API, or when Chrome refuses (no click)', async () => {
    expect(await openRidePip('corner', { host: host({ api: false }).win })).toBeNull();
    const refused = host({ reject: true });
    expect(await openRidePip('corner', { host: refused.win })).toBeNull();
    expect(currentRidePip()).toBeNull();
  });

  it('resize: the open window to the new size; false when nothing is open or Chrome refuses', async () => {
    expect(resizeRidePip('half')).toBe(false);
    const h = host();
    await openRidePip('corner', { host: h.win });
    expect(resizeRidePip('third')).toBe(true);
    expect(h.opened[0].resizeTo).toHaveBeenLastCalledWith(640, 360);
    h.opened[0].resizeTo.mockImplementation(() => {
      throw new DOMException('needs activation', 'NotAllowedError');
    });
    expect(resizeRidePip('half')).toBe(false);
  });
});
