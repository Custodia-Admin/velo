/**
 * The ride HUD layout store persists the details state across rides and
 * reloads, and nothing else (the devices sheet and the notice host count
 * are per ride). Behaviour, not source: a fake localStorage, a fresh module
 * load per "page load", and zustand's own hydration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mem: Map<string, string>;

/** A fresh copy of the store module, as on a new page load. */
async function loadStore() {
  vi.resetModules();
  return import('./rideHudStore');
}

beforeEach(() => {
  mem = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rideHudStore persistence', () => {
  it('collapsed by default on a first visit', async () => {
    const { useRideHudStore } = await loadStore();
    expect(useRideHudStore.getState().expanded).toBe(false);
  });

  it('the details state comes back on the next page load; the devices sheet and hosts do not', async () => {
    const first = await loadStore();
    first.useRideHudStore.getState().setExpanded(true);
    first.useRideHudStore.getState().setDevicesOpen(true);
    first.useRideHudStore.getState().hostNotices();

    const saved = JSON.parse(mem.get(first.RIDE_HUD_STORAGE_KEY) ?? 'null');
    expect(saved?.state).toEqual({ expanded: true });

    const second = await loadStore();
    expect(second.useRideHudStore).not.toBe(first.useRideHudStore);
    await second.useRideHudStore.persist.rehydrate();
    const s = second.useRideHudStore.getState();
    expect(s.expanded).toBe(true);
    expect(s.devicesOpen).toBe(false);
    expect(s.noticeHosts).toBe(0);
  });

  it('closing the details is remembered too', async () => {
    const first = await loadStore();
    first.useRideHudStore.getState().setExpanded(true);
    first.useRideHudStore.getState().toggleExpanded();
    const second = await loadStore();
    await second.useRideHudStore.persist.rehydrate();
    expect(second.useRideHudStore.getState().expanded).toBe(false);
  });
});
