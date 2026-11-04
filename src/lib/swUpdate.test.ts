import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createSwUpdater,
  isRidePath,
  RIDING_PROBE_MS,
  UPDATE_CHECK_GAP_MS,
  type ChannelLike,
  type ContainerLike,
  type RegistrationLike,
  type WorkerLike,
} from './swUpdate';

/** A waiting/installing worker that records what the page told it. */
function fakeWorker(state = 'installed') {
  const listeners: (() => void)[] = [];
  const messages: unknown[] = [];
  const w: WorkerLike & { messages: unknown[]; setState(s: string): void } = {
    state,
    messages,
    postMessage: (m) => messages.push(m),
    addEventListener: (_t, cb) => listeners.push(cb),
    setState(s) {
      w.state = s;
      listeners.forEach((cb) => cb());
    },
  };
  return w;
}

function fakeBrowser(opts: { controlled?: boolean; waiting?: WorkerLike | null; path?: string } = {}) {
  let path = opts.path ?? '/app';
  let reloads = 0;
  let updates = 0;
  const controllerListeners: (() => void)[] = [];
  const updateFound: (() => void)[] = [];
  const reg: RegistrationLike = {
    waiting: opts.waiting ?? null,
    installing: null,
    addEventListener: (_t, cb) => updateFound.push(cb),
    update: async () => {
      updates++;
    },
  };
  const container: ContainerLike = {
    controller: opts.controlled === false ? null : {},
    register: async () => reg,
    addEventListener: (_t, cb) => controllerListeners.push(cb),
  };
  let clock = 1_000_000;
  return {
    reg,
    container,
    env: {
      container,
      pathname: () => path,
      reload: () => {
        reloads++;
      },
      now: () => clock,
      wait: async () => {},
    },
    go: (p: string) => {
      path = p;
    },
    tick: (ms: number) => {
      clock += ms;
    },
    reloads: () => reloads,
    updates: () => updates,
    /** The browser switched this page to the new worker (after anyone's SKIP_WAITING). */
    controllerChange: () => controllerListeners.forEach((cb) => cb()),
    /** A deploy is found and installs; it ends up waiting. */
    deploy: (w: ReturnType<typeof fakeWorker>) => {
      reg.installing = w;
      updateFound.forEach((cb) => cb());
      reg.installing = null;
      reg.waiting = w;
      w.setState('installed');
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const SKIP = { type: 'SKIP_WAITING' };

describe('isRidePath', () => {
  it('protects the ride route only', () => {
    expect(isRidePath('/ride')).toBe(true);
    expect(isRidePath('/ride/anything')).toBe(true);
    expect(isRidePath('/app')).toBe(false);
    expect(isRidePath('/devices')).toBe(false);
    expect(isRidePath('/rides')).toBe(false);
  });
});

describe('service worker updates never reload a ride', () => {
  it('a deploy found mid-ride waits; leaving the ride activates it and reloads on Home', async () => {
    const b = fakeBrowser({ path: '/ride' });
    const sw = createSwUpdater(b.env);
    await sw.start();
    const w = fakeWorker('installing');
    b.deploy(w);
    await flush();
    expect(w.messages).toEqual([]);
    expect(b.reloads()).toBe(0);

    b.go('/app');
    sw.onRouteChange('/app');
    await flush();
    expect(w.messages).toEqual([SKIP]);
    expect(b.reloads()).toBe(0);
    b.controllerChange();
    expect(b.reloads()).toBe(1);
  });

  it('pausing or finishing on /ride is still the ride: no activation', async () => {
    const b = fakeBrowser({ path: '/ride', waiting: fakeWorker() });
    const sw = createSwUpdater(b.env);
    await sw.start();
    sw.onRouteChange('/ride');
    await flush();
    expect((b.reg.waiting as ReturnType<typeof fakeWorker>).messages).toEqual([]);
    expect(sw.state().activationSent).toBe(false);
  });

  it('another tab activating the deploy mid-ride does not reload; the next navigation off /ride does', async () => {
    const b = fakeBrowser({ path: '/ride' });
    const sw = createSwUpdater(b.env);
    await sw.start();
    b.controllerChange();
    expect(b.reloads()).toBe(0);
    expect(sw.state().reloadPending).toBe(true);
    sw.onRouteChange('/ride');
    expect(b.reloads()).toBe(0);
    b.go('/app');
    sw.onRouteChange('/app');
    expect(b.reloads()).toBe(1);
  });

  it('off the ride a waiting deploy activates at once and reloads (the old auto-update, minus the ride)', async () => {
    const w = fakeWorker();
    const b = fakeBrowser({ path: '/app', waiting: w });
    const sw = createSwUpdater(b.env);
    await sw.start();
    expect(w.messages).toEqual([SKIP]);
    b.controllerChange();
    expect(b.reloads()).toBe(1);
  });

  it('a deploy that finishes installing on Home activates without a navigation', async () => {
    const b = fakeBrowser({ path: '/app' });
    const sw = createSwUpdater(b.env);
    await sw.start();
    const w = fakeWorker('installing');
    b.deploy(w);
    await flush();
    expect(w.messages).toEqual([SKIP]);
  });

  it('a rider who starts a ride while the other-tab probe runs is not reloaded', async () => {
    const w = fakeWorker();
    const b = fakeBrowser({ path: '/app', waiting: w });
    b.env.wait = async () => {
      b.go('/ride');
    };
    const sw = createSwUpdater({ ...b.env, channel: { postMessage: () => {}, addEventListener: () => {} } });
    await sw.start();
    expect(w.messages).toEqual([]);
  });

  it('the first worker never reloads a page nothing controlled', async () => {
    const b = fakeBrowser({ path: '/app', controlled: false });
    const sw = createSwUpdater(b.env);
    await sw.start();
    b.controllerChange();
    expect(b.reloads()).toBe(0);
  });

  it('does not activate while another open tab answers that it is riding', async () => {
    const w = fakeWorker();
    const b = fakeBrowser({ path: '/app', waiting: w });
    const listeners: ((e: { data: unknown }) => void)[] = [];
    let probes = 0;
    // The other tab: on /ride, it answers every probe.
    const channel: ChannelLike = {
      postMessage: (m) => {
        const msg = m as { type: string; id: string };
        if (msg.type === 'ride?') {
          probes++;
          listeners.forEach((cb) => cb({ data: { type: 'riding', id: msg.id } }));
        }
      },
      addEventListener: (_t, cb) => listeners.push(cb),
    };
    const sw = createSwUpdater({ ...b.env, channel });
    await sw.start();
    expect(probes).toBe(1);
    expect(w.messages).toEqual([]);
  });

  it('answers other tabs only while riding', async () => {
    const b = fakeBrowser({ path: '/ride' });
    const sent: unknown[] = [];
    let deliver: (e: { data: unknown }) => void = () => {};
    const channel: ChannelLike = {
      postMessage: (m) => sent.push(m),
      addEventListener: (_t, cb) => {
        deliver = cb;
      },
    };
    createSwUpdater({ ...b.env, channel });
    deliver({ data: { type: 'ride?', id: 'x' } });
    expect(sent).toEqual([{ type: 'riding', id: 'x' }]);
    b.go('/app');
    deliver({ data: { type: 'ride?', id: 'y' } });
    expect(sent).toHaveLength(1);
  });

  it('checks for a new deploy on navigation, at most every 15 minutes, never on /ride', async () => {
    const b = fakeBrowser({ path: '/app' });
    const sw = createSwUpdater(b.env);
    await sw.start();
    sw.onRouteChange('/devices');
    expect(b.updates()).toBe(0);
    b.tick(UPDATE_CHECK_GAP_MS);
    sw.onRouteChange('/ride');
    expect(b.updates()).toBe(0);
    sw.onRouteChange('/app');
    expect(b.updates()).toBe(1);
    sw.onRouteChange('/devices');
    expect(b.updates()).toBe(1);
  });

  it('probes other tabs for a bounded time', () => {
    expect(RIDING_PROBE_MS).toBeLessThanOrEqual(500);
  });
});

describe('PWA build config', () => {
  const root = resolve(__dirname, '../..');
  const vite = readFileSync(resolve(root, 'vite.config.ts'), 'utf8');
  const main = readFileSync(resolve(root, 'src/main.tsx'), 'utf8');

  it('builds a worker that waits for the page (no autoUpdate skipWaiting)', () => {
    expect(vite).toMatch(/registerType:\s*'prompt'/);
    expect(vite).not.toMatch(/registerType:\s*'autoUpdate'/);
    expect(vite).not.toMatch(/skipWaiting:\s*true/);
    expect(vite).not.toMatch(/clientsClaim:\s*true/);
  });

  it("does not inject or import vite-plugin-pwa's register helper (it reloads on activation)", () => {
    expect(vite).toMatch(/injectRegister:\s*false/);
    expect(main).not.toMatch(/virtual:pwa-register/);
    expect(main).toMatch(/startServiceWorker\(\)/);
  });

  it('calls the product Velo in the install manifest', () => {
    expect(vite).toMatch(/name:\s*'Velo'/);
    expect(vite).not.toMatch(/GlobeRide/);
  });
});
