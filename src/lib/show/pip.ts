/**
 * Ride over anything: the ride view in a Document Picture-in-Picture window
 * (Chrome and Edge 116+ on desktop) that floats over whatever else is on the
 * screen: a streaming site in another tab, a film in another app. Streaming
 * services can't be embedded in a web app (DRM, frame blocking), so Velo goes
 * on top of them instead.
 *
 * - The window is the size of a corner (a quarter of the screen width), a
 *   third or a half, always 16:9, and never narrower than the condensed HUD
 *   needs (PIP_MIN_WIDTH). Velo opens one window at a time.
 * - The page's stylesheets and theme are copied in, so React can render
 *   on-system UI into the window (a portal; see ShowSurface).
 * - While the window is open Chrome keeps the Velo tab running at full rate
 *   even when it is hidden behind the other tab (measured on Chromium 153:
 *   requestAnimationFrame 60 Hz, timers unthrottled; without the window the
 *   hidden tab's frames stop). The ride loop, recording and FIT export need
 *   nothing extra. e2e/show-mode.spec.ts pins it.
 * - Capability first (CLAUDE.md polish rule): no API, no button.
 *
 * Chrome's own rules: requestWindow needs a click (user activation), and
 * resizeTo inside the window needs a click in that window.
 */

export type PipSize = 'corner' | 'third' | 'half';

export const PIP_SIZES: readonly PipSize[] = ['corner', 'third', 'half'];

/** Window width as a share of the screen's width. */
export const PIP_FRACTION: Readonly<Record<PipSize, number>> = {
  corner: 0.25,
  third: 1 / 3,
  half: 0.5,
};

/**
 * Narrowest window Velo asks for at each size, CSS px. The JourneyBar needs
 * 448 px for its three figures at text-3xl (h:mm:ss, a two-digit km and a
 * negative grade included) and Pause; the larger sizes stay a step apart on a
 * small screen. A 1280-wide laptop gets 448, 512 and 640 (a quarter, a third
 * and a half of it would be 320, 427 and 640: at 320 the bar cut Pause off).
 */
export const PIP_MIN_WIDTH: Readonly<Record<PipSize, number>> = {
  corner: 448,
  third: 512,
  half: 640,
};
/** Tallest share of the screen a window may take. */
export const PIP_MAX_HEIGHT_FRACTION = 0.9;

export function isPipSize(v: unknown): v is PipSize {
  return typeof v === 'string' && (PIP_SIZES as readonly string[]).includes(v);
}

/** The next size when the rider taps the size button: corner → third → half → corner. */
export function nextPipSize(size: PipSize): PipSize {
  const i = PIP_SIZES.indexOf(size);
  return PIP_SIZES[(i + 1) % PIP_SIZES.length];
}

interface PipRequestOptions {
  width?: number;
  height?: number;
  disallowReturnToOpener?: boolean;
  preferInitialWindowPlacement?: boolean;
}

interface DocumentPictureInPicture extends EventTarget {
  requestWindow(options?: PipRequestOptions): Promise<Window>;
  readonly window: Window | null;
}

type PipHost = Window & { documentPictureInPicture?: DocumentPictureInPicture };

export function documentPipApi(win: Window | undefined = globalWindow()): DocumentPictureInPicture | null {
  const api = (win as PipHost | undefined)?.documentPictureInPicture;
  return api && typeof api.requestWindow === 'function' ? api : null;
}

function globalWindow(): Window | undefined {
  return typeof window === 'undefined' ? undefined : window;
}

/**
 * Can this browser float the ride over other tabs? Needs the Document
 * Picture-in-Picture API in a top-level, secure page (the API is absent in
 * iframes, on Android and on iOS).
 */
export function canRideOverAnything(win: Window | undefined = globalWindow()): boolean {
  if (!win || !documentPipApi(win)) return false;
  if (win.isSecureContext === false) return false;
  try {
    if (win.top !== win) return false;
  } catch {
    return false;
  }
  return true;
}

export interface ScreenArea {
  availWidth: number;
  availHeight: number;
}

/** Window size (CSS px) for a size choice on this screen: 16:9, at least PIP_MIN_WIDTH[size] wide. */
export function pipWindowSize(size: PipSize, screen: ScreenArea): { width: number; height: number } {
  const sw = Number.isFinite(screen.availWidth) && screen.availWidth > 0 ? screen.availWidth : 1280;
  const sh = Number.isFinite(screen.availHeight) && screen.availHeight > 0 ? screen.availHeight : 720;
  const min = PIP_MIN_WIDTH[size] ?? PIP_MIN_WIDTH.corner;
  let width = Math.max(min, Math.round(sw * (PIP_FRACTION[size] ?? PIP_FRACTION.corner)));
  width = Math.min(width, sw);
  let height = Math.round((width * 9) / 16);
  const maxH = Math.floor(sh * PIP_MAX_HEIGHT_FRACTION);
  if (height > maxH) {
    height = maxH;
    width = Math.round((height * 16) / 9);
  }
  return { width, height };
}

/** Root attributes that carry the theme and layout (copied onto the window's <html>). */
const ROOT_ATTRIBUTES = ['class', 'lang', 'dir', 'style', 'data-theme'];

/**
 * Copy the page's styles into the picture-in-picture document: every
 * stylesheet <link> and <style> in <head> (Vite injects <style> tags in dev,
 * the build ships <link>s), the theme attributes on <html>, and a marker
 * (`data-surface="pip"`) that index.css uses to scale type with the window.
 */
export function copyPageStyles(from: Document, to: Document): void {
  for (const node of Array.from(from.head.querySelectorAll('link[rel="stylesheet"], style'))) {
    to.head.appendChild(to.importNode(node, true));
  }
  const src = from.documentElement;
  const dst = to.documentElement;
  for (const name of ROOT_ATTRIBUTES) {
    const v = src.getAttribute(name);
    if (v !== null) dst.setAttribute(name, v);
  }
  // The TV layout scales the main page; the floating window scales itself.
  dst.removeAttribute('data-layout');
  dst.setAttribute('data-surface', 'pip');
  to.body.className = from.body.className;
}

// ---------------------------------------------------------------------------
// The one open window
// ---------------------------------------------------------------------------

let current: Window | null = null;
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const fn of [...listeners]) fn();
}

/** Subscribe to the window opening or closing (useSyncExternalStore-shaped). */
export function subscribeRidePip(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The open ride window, or null. */
export function currentRidePip(): Window | null {
  if (current && current.closed) current = null;
  return current;
}

/** Bumps on every open/close; a stable snapshot for useSyncExternalStore. */
export function ridePipVersion(): number {
  return version;
}

export interface OpenRidePipOptions {
  /** Defaults to the global window (tests pass a fake). */
  host?: Window;
  title?: string;
  /** Called once when the window goes away (closed by the rider or by Velo). */
  onClose?: () => void;
}

/**
 * Open the ride window at `size`, or resize the one already open. Must run in
 * a click handler. Resolves to the window, or null when the browser can't
 * (no API, no click, the rider dismissed it).
 */
export async function openRidePip(size: PipSize, opts: OpenRidePipOptions = {}): Promise<Window | null> {
  const host = opts.host ?? globalWindow();
  const api = host ? documentPipApi(host) : null;
  if (!host || !api) return null;
  const open = currentRidePip();
  if (open) {
    resizeRidePip(size, open);
    return open;
  }
  const { width, height } = pipWindowSize(size, host.screen);
  let win: Window;
  try {
    win = await api.requestWindow({ width, height });
  } catch (err) {
    // No click behind the request, or the browser refused: no window.
    console.warn('Velo: the floating ride window did not open', err);
    return null;
  }
  copyPageStyles(host.document, win.document);
  win.document.title = opts.title ?? 'Velo ride';
  current = win;
  win.addEventListener(
    'pagehide',
    () => {
      if (current === win) current = null;
      opts.onClose?.();
      emit();
    },
    { once: true },
  );
  emit();
  return win;
}

/** Resize the open window. Chrome allows it only during a click in that window. */
export function resizeRidePip(size: PipSize, win: Window | null = currentRidePip()): boolean {
  if (!win) return false;
  const { width, height } = pipWindowSize(size, win.screen);
  try {
    win.resizeTo(width, height);
    return true;
  } catch {
    return false;
  }
}

/** Close the ride window (no-op when none is open). */
export function closeRidePip(): void {
  const win = currentRidePip();
  if (!win) return;
  win.close();
}

/** Test hook: forget the window without closing it. */
export function __resetRidePipForTests(): void {
  current = null;
  listeners.clear();
  version = 0;
}
