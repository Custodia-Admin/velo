/**
 * Service-worker updates that never reload a ride.
 *
 * The PWA used vite-plugin-pwa's `autoUpdate` mode: the new worker skipped
 * waiting as soon as it had precached a deploy, and the plugin's register
 * helper reloaded the page on activation. A deploy landing while the rider
 * was on /ride (or another tab picking the deploy up) reloaded the ride.
 *
 * Now the worker is built in `prompt` mode (it waits) and this module decides
 * when it may take over:
 *
 * - A waiting worker is activated (SKIP_WAITING) only while this tab is NOT
 *   on /ride and no other open Velo tab answers that it is riding.
 * - On /ride (riding, paused, the finish screen, show mode) nothing happens;
 *   the next navigation off /ride (Home, Devices) activates it.
 * - If another tab activates it anyway, a tab that is riding does not reload:
 *   the reload waits for its next navigation off /ride.
 * - Activation reloads the page so the new bundle runs; the first install
 *   (nothing controlled the page before) never reloads.
 *
 * `createSwUpdater` is pure over an injected environment so the policy is
 * unit-tested (swUpdate.test.ts); `startServiceWorker` wires the browser.
 */

export const SW_URL = '/sw.js';
export const SW_CHANNEL = 'velo-sw';
/** How long a tab waits for "I'm riding" answers from other tabs. */
export const RIDING_PROBE_MS = 300;
/** Minimum gap between update checks made on navigation. */
export const UPDATE_CHECK_GAP_MS = 15 * 60 * 1000;

/** True for the ride route: riding, paused, the finish screen, show mode. */
export function isRidePath(pathname: string): boolean {
  return pathname === '/ride' || pathname.startsWith('/ride/');
}

/** The parts of a ServiceWorker this module uses. */
export interface WorkerLike {
  state: string;
  postMessage(message: unknown): void;
  addEventListener(type: 'statechange', cb: () => void): void;
}

/** The parts of a ServiceWorkerRegistration this module uses. */
export interface RegistrationLike {
  waiting: WorkerLike | null;
  installing: WorkerLike | null;
  addEventListener(type: 'updatefound', cb: () => void): void;
  update(): Promise<unknown>;
}

/** The parts of navigator.serviceWorker this module uses. */
export interface ContainerLike {
  controller: unknown;
  register(url: string, options: { scope: string }): Promise<RegistrationLike>;
  addEventListener(type: 'controllerchange', cb: () => void): void;
}

/** The parts of a BroadcastChannel this module uses. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', cb: (e: { data: unknown }) => void): void;
}

export interface SwEnv {
  container: ContainerLike;
  pathname: () => string;
  reload: () => void;
  /** Cross-tab "is anyone riding?" channel; omitted where BroadcastChannel is missing. */
  channel?: ChannelLike;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

export interface SwUpdater {
  /** Register the worker and start watching for updates. */
  start(): Promise<void>;
  /** Call on every in-app navigation (react-router location change). */
  onRouteChange(pathname: string): void;
  /** For tests and diagnostics. */
  state(): { reloadPending: boolean; activationSent: boolean; registered: boolean };
}

type ChannelMessage = { type: 'ride?'; id: string } | { type: 'riding'; id: string };

function isChannelMessage(v: unknown): v is ChannelMessage {
  return !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string' &&
    typeof (v as { id?: unknown }).id === 'string';
}

export function createSwUpdater(env: SwEnv): SwUpdater {
  const now = env.now ?? (() => Date.now());
  const wait = env.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let registration: RegistrationLike | null = null;
  // A page nothing controlled yet gets its first worker without a reload.
  let hadController = !!env.container.controller;
  let reloadPending = false;
  let activationSent = false;
  let activating = false;
  let lastUpdateCheck = now();
  const ridingAnswers = new Map<string, number>();

  const riding = () => isRidePath(env.pathname());

  env.channel?.addEventListener('message', (e) => {
    if (!isChannelMessage(e.data)) return;
    if (e.data.type === 'ride?' && riding()) env.channel?.postMessage({ type: 'riding', id: e.data.id });
    if (e.data.type === 'riding') ridingAnswers.set(e.data.id, (ridingAnswers.get(e.data.id) ?? 0) + 1);
  });

  async function anotherTabRiding(): Promise<boolean> {
    if (!env.channel) return false;
    const id = `${now()}-${Math.random().toString(36).slice(2)}`;
    ridingAnswers.set(id, 0);
    env.channel.postMessage({ type: 'ride?', id });
    await wait(RIDING_PROBE_MS);
    const n = ridingAnswers.get(id) ?? 0;
    ridingAnswers.delete(id);
    return n > 0;
  }

  async function maybeActivate(): Promise<void> {
    const waiting = registration?.waiting;
    if (!waiting || activationSent || activating || riding()) return;
    activating = true;
    try {
      if (await anotherTabRiding()) return;
      // Re-check: the rider may have started a ride during the probe.
      if (riding() || registration?.waiting !== waiting) return;
      activationSent = true;
      waiting.postMessage({ type: 'SKIP_WAITING' });
    } finally {
      activating = false;
    }
  }

  env.container.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    if (riding()) {
      reloadPending = true;
      return;
    }
    env.reload();
  });

  function watch(reg: RegistrationLike): void {
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed') void maybeActivate();
      });
    });
  }

  return {
    async start() {
      registration = await env.container.register(SW_URL, { scope: '/' });
      watch(registration);
      await maybeActivate();
    },
    onRouteChange(pathname) {
      if (isRidePath(pathname)) return;
      if (reloadPending) {
        env.reload();
        return;
      }
      void maybeActivate();
      if (registration && now() - lastUpdateCheck >= UPDATE_CHECK_GAP_MS) {
        lastUpdateCheck = now();
        registration.update().catch(() => {});
      }
    },
    state() {
      return { reloadPending, activationSent, registered: !!registration };
    },
  };
}

let current: SwUpdater | null = null;

/**
 * Register the production service worker. No-op without service-worker
 * support (and in dev, where vite-plugin-pwa builds no worker).
 */
export function startServiceWorker(): SwUpdater | null {
  if (current) return current;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(SW_CHANNEL);
  current = createSwUpdater({
    container: navigator.serviceWorker as unknown as ContainerLike,
    pathname: () => window.location.pathname,
    reload: () => window.location.reload(),
    channel: channel as unknown as ChannelLike | undefined,
  });
  current.start().catch(() => {
    // Registration failed (private mode, blocked): the app works without it.
  });
  return current;
}

/** Forward an in-app navigation to the running updater (if any). */
export function notifyRouteChange(pathname: string): void {
  current?.onRouteChange(pathname);
}
