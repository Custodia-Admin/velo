/**
 * The ride status chip as a component (RideChip.tsx): real ride, reconnect,
 * controller and HUD stores, the real rideChip() / chipTap(), and the
 * element RideChip returns, clicked through its own onClick. React's
 * scheduling is stubbed (effects run at once, memos compute) and zustand's
 * React binding reads getState(), so the component runs as a plain function
 * in the node test env. No Bluetooth: reconnectGrantedTrainer is a spy.
 *
 * What this pins (review of PR #27 @4fdc728, D1/D2): the trainer-lost chip
 * is visible on phones and never the calm demo chip; its tap reconnects
 * when a grant is usable and opens the devices sheet when not; a notice's
 * action runs and dismisses its toast; anything else toggles the sheet;
 * show mode (alertsOnly) draws the chip only when it has something to say.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const h = vi.hoisted(() => ({
  cleanups: [] as Array<() => void>,
  reconnect: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('react', async (orig) => {
  const react = await orig<typeof import('react')>();
  const hooks = {
    useEffect: (fn: () => void | (() => void)) => {
      const c = fn();
      if (typeof c === 'function') h.cleanups.push(c);
    },
    useMemo: <T,>(fn: () => T) => fn(),
    useCallback: <T,>(fn: T) => fn,
  };
  return { ...react, ...hooks, default: { ...react, ...hooks } };
});

// zustand's React binding is a node_modules dependency (not transformed, so
// the react mock above can't reach it): bind the hooks to getState().
vi.mock('zustand', async (orig) => {
  const z = await orig<typeof import('zustand')>();
  const { createStore } = await import('zustand/vanilla');
  type Init = import('zustand/vanilla').StateCreator<unknown>;
  const bind = (init: Init) => {
    const api = createStore(init);
    const hook = (selector: (s: unknown) => unknown = (s) => s) => selector(api.getState());
    return Object.assign(hook, api);
  };
  return { ...z, create: (init?: Init) => (init ? bind(init) : bind) };
});

vi.mock('@/lib/trainerReconnect', async (orig) => ({
  ...(await orig<typeof import('@/lib/trainerReconnect')>()),
  reconnectGrantedTrainer: h.reconnect,
}));

import { RideChip } from './RideChip';
import { useRideStore } from '@/stores/rideStore';
import { useRideHudStore } from '@/stores/rideHudStore';
import { useTrainerReconnectStore } from '@/lib/trainerReconnect';
import { canvasKeyFor, useWorldViewStore } from '@/stores/worldViewStore';

type ChipProps = { onClick: () => void; className: string; 'aria-label': string; 'data-tone': string };

const initialRide = useRideStore.getState();
const initialReconnect = useTrainerReconnectStore.getState();

/** The text a rider sees in an element tree. */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  const el = node as ReactElement<{ children?: unknown }>;
  return textOf(el.props?.children);
}

interface RenderedChip {
  props: ChipProps;
  /** The visible label. */
  text: string;
  /** The screen-reader sentence. */
  label: string;
}

/** Render the chip once (then unmount it); null when it draws nothing. */
function chip(props: { alertsOnly?: boolean } = {}): RenderedChip | null {
  const el = RideChip(props) as ReactElement<ChipProps> | null;
  for (const c of h.cleanups.splice(0)) c(); // unmount: release the notice host, clear timers
  if (!el) return null;
  return { props: el.props, text: textOf(el), label: el.props['aria-label'] };
}

/** Visible on phones: the chip is `hidden` below sm unless it is an alert. */
function visibleOnPhones(el: RenderedChip): boolean {
  return el.props.className.split(/\s+/).includes('inline-flex');
}

/** A trainer that was riding and dropped (TrainerEventBridge on ftms 'failed'). */
function trainerLostMidRide(): void {
  const st = useRideStore.getState();
  st.setConnection('connecting');
  st.setConnection('connected', { deviceName: 'KICKR CORE 78C1' });
  st.setMode('trainer');
  st.setConnection('reconnecting', { error: 'Trainer dropped' });
  st.setConnection('disconnected', { deviceName: null, error: 'Auto-reconnect failed', code: 'reconnect-failed' });
  useRideStore.getState().setMode('demo');
}

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  h.reconnect.mockClear();
});

afterEach(() => {
  for (const c of h.cleanups.splice(0)) c();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useRideStore.setState(initialRide, true);
  useTrainerReconnectStore.setState(initialReconnect, true);
  useRideHudStore.setState({ devicesOpen: false, noticeHosts: 0 });
  useWorldViewStore.setState({ view: null });
});

/** The world view's canvas lost its WebGL context (ContextLossWatch reported it). */
function worldViewStopped(): number {
  const id = useWorldViewStore.getState().attach();
  useWorldViewStore.getState().contextLost(id, 0);
  return id;
}

describe('RideChip: a lost trainer', () => {
  it('with a usable grant: "Trainer lost · tap to reconnect", on phones too, and the tap reconnects (not the sheet)', () => {
    trainerLostMidRide();
    useTrainerReconnectStore.setState({ phase: 'available', name: 'KICKR CORE 78C1' });
    const el = chip()!;
    expect(el.text).toBe('Trainer lost · tap to reconnect');
    expect(visibleOnPhones(el)).toBe(true);
    el.props.onClick();
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(useRideHudStore.getState().devicesOpen).toBe(false);
  });

  it('after a reconnect tap that failed (grant phase "failed"): still "tap to reconnect", and the next tap tries again', () => {
    trainerLostMidRide();
    useTrainerReconnectStore.setState({ phase: 'failed', name: 'KICKR CORE 78C1' });
    const el = chip()!;
    expect(el.text).toBe('Trainer lost · tap to reconnect');
    expect(visibleOnPhones(el)).toBe(true);
    el.props.onClick();
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(useRideHudStore.getState().devicesOpen).toBe(false);
  });

  it('without one (#27 alone after a real drop: phase stays connected): an alert chip, never the calm demo chip, that opens devices', () => {
    trainerLostMidRide();
    expect(useTrainerReconnectStore.getState().phase).not.toBe('available');
    const el = chip()!;
    expect(el.props['data-tone']).toBe('warn');
    expect(el.text).toBe('Trainer lost · tap for devices');
    expect(el.text).not.toContain('Demo ride');
    expect(visibleOnPhones(el)).toBe(true);
    el.props.onClick();
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(useRideHudStore.getState().devicesOpen).toBe(true);
  });

  it('stays an alert after its own "Couldn\'t reconnect" toast has had its turn', () => {
    trainerLostMidRide();
    useRideStore.getState().pushToast({ id: 'trainer-connection', kind: 'error', title: "Couldn't reconnect after several attempts", durationMs: 10_000 });
    expect(chip()!.text).toBe('Trainer lost · tap for devices');
    vi.advanceTimersByTime(30_000);
    const el = chip()!;
    expect(el.text).toBe('Trainer lost · tap for devices');
    expect(visibleOnPhones(el)).toBe(true);
  });
});

describe('RideChip: the other taps', () => {
  it('a notice with an action: the tap runs it and dismisses that toast', () => {
    useRideStore.getState().setMode('demo');
    const onClick = vi.fn();
    useRideStore.getState().pushToast({ id: 'ftp', kind: 'info', title: 'FTP test suggested', action: { label: 'Start', onClick }, durationMs: 4_000 });
    const el = chip()!;
    expect(el.text).toBe('FTP test suggested · Start');
    el.props.onClick();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(useRideStore.getState().toasts.map((t) => t.id)).not.toContain('ftp');
    expect(useRideHudStore.getState().devicesOpen).toBe(false);
    expect(h.reconnect).not.toHaveBeenCalled();
  });

  it('a calm chip toggles the devices sheet open and closed', () => {
    useRideStore.getState().setMode('demo');
    chip()!.props.onClick();
    expect(useRideHudStore.getState().devicesOpen).toBe(true);
    chip()!.props.onClick();
    expect(useRideHudStore.getState().devicesOpen).toBe(false);
    expect(h.reconnect).not.toHaveBeenCalled();
  });

  it('hosts the notices while mounted (the Toaster draws nothing), and releases them on unmount', () => {
    useRideStore.getState().setMode('demo');
    RideChip({});
    expect(useRideHudStore.getState().noticeHosts).toBe(1);
    for (const c of h.cleanups.splice(0)) c();
    expect(useRideHudStore.getState().noticeHosts).toBe(0);
  });

  it('the newest notice speaks: older toasts are dismissed, not queued for the finish page', () => {
    useRideStore.getState().setMode('demo');
    useRideStore.getState().pushToast({ id: 'old-1', kind: 'info', title: 'Climb ahead', durationMs: 4_000 });
    useRideStore.getState().pushToast({ id: 'old-2', kind: 'info', title: 'Halfway there', durationMs: 4_000 });
    useRideStore.getState().pushToast({ id: 'new', kind: 'info', title: 'New personal best', durationMs: 4_000 });
    expect(chip()!.text).toBe('New personal best');
    expect(useRideStore.getState().toasts.map((t) => t.id)).toEqual(['new']);
  });
});

describe('RideChip: the 3D view stopped (WebGL context lost)', () => {
  it('"3D view stopped · tap to reload", on phones too; the tap remounts the view (new canvas key), not the sheet', () => {
    useRideStore.getState().setMode('demo');
    const id = worldViewStopped();
    const el = chip()!;
    expect(el.text).toBe('3D view stopped · tap to reload');
    expect(el.label).toContain('Your ride keeps going');
    expect(el.props['data-tone']).toBe('warn');
    expect(visibleOnPhones(el)).toBe(true);
    el.props.onClick();
    expect(canvasKeyFor(useWorldViewStore.getState(), id)).toBe(1);
    expect(useWorldViewStore.getState().view?.stopped).toBe(false);
    expect(useRideHudStore.getState().devicesOpen).toBe(false);
    expect(h.reconnect).not.toHaveBeenCalled();
    // Back to the calm chip once the view is remounted.
    expect(chip()!.text).toBe('Demo ride · no trainer');
  });

  it('a lost trainer still speaks first; the stopped view shows once the trainer is back', () => {
    trainerLostMidRide();
    useTrainerReconnectStore.setState({ phase: 'available', name: 'KICKR CORE 78C1' });
    worldViewStopped();
    expect(chip()!.text).toBe('Trainer lost · tap to reconnect');
    useRideStore.getState().setConnection('connected', { deviceName: 'KICKR CORE 78C1' });
    useRideStore.getState().setMode('trainer');
    expect(chip()!.text).toBe('3D view stopped · tap to reload');
  });

  it('in the floating window and show mode (alertsOnly) it shows too, and the tap reloads there', () => {
    useRideStore.getState().setMode('demo');
    const id = worldViewStopped();
    const el = chip({ alertsOnly: true })!;
    expect(el.text).toBe('3D view stopped · tap to reload');
    el.props.onClick();
    expect(canvasKeyFor(useWorldViewStore.getState(), id)).toBe(1);
    expect(chip({ alertsOnly: true })).toBeNull();
  });
});

describe('RideChip in show mode (alertsOnly)', () => {
  it('draws nothing while calm, but still hosts the notices', () => {
    useRideStore.getState().setMode('demo');
    expect(RideChip({ alertsOnly: true })).toBeNull();
    expect(useRideHudStore.getState().noticeHosts).toBe(1);
  });

  it('a lost trainer or a notice shows as the chip, never as a toast card', () => {
    trainerLostMidRide();
    expect(chip({ alertsOnly: true })?.text).toBe('Trainer lost · tap for devices');
    useRideStore.setState(initialRide, true);
    useRideStore.getState().setMode('demo');
    useRideStore.getState().pushToast({ kind: 'error', title: 'Trainer rejected a command', durationMs: 6_000 });
    expect(chip({ alertsOnly: true })?.text).toBe('Trainer rejected a command');
  });
});
