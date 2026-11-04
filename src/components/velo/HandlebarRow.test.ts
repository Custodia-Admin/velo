/**
 * The handlebar row as a component (ControllerPanel.tsx HandlebarRow, the
 * row of /devices and of the in-ride devices sheet): the real controller
 * store and the real handlebarRow(), the element HandlebarRow returns, and
 * its onAction called the way DeviceRow's buttons call it. React's hooks
 * run on a tiny in-test runtime (state slots, effects with deps and
 * cleanups) and zustand's React binding reads getState(), so the component
 * runs as a plain function in the node test env. No Bluetooth: every
 * rideController call is a spy.
 *
 * What this pins (review of PR #27 @e675d78, R1/R2): #26's one-tap
 * "Reconnect <name>" for controls paired in an earlier session, Forget
 * really forgetting, the show legend and the gear-buzz switch inside the
 * live row's "What the buttons do", and the wake-watch state reaching the
 * asleep copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

interface EffectSlot {
  deps?: readonly unknown[];
  cleanup?: () => void;
}

const h = vi.hoisted(() => ({
  slots: new Map<number, unknown>(),
  effects: new Set<number>(),
  i: 0,
  findGranted: vi.fn<() => Promise<{ name?: string } | null>>(() => Promise.resolve(null)),
  reconnectGranted: vi.fn((_opts?: { silent?: boolean }) => Promise.resolve(true)),
  pair: vi.fn((_opts?: { showAllDevices?: boolean }) => Promise.resolve()),
  disconnect: vi.fn((_opts?: { forget?: boolean }) => Promise.resolve()),
  reconnect: vi.fn(() => Promise.resolve()),
  buzz: vi.fn((_reason?: string) => true),
}));

vi.mock('react', async (orig) => {
  const react = await orig<typeof import('react')>();
  const hooks = {
    useState: <T,>(init: T | (() => T)) => {
      const i = h.i++;
      if (!h.slots.has(i)) h.slots.set(i, typeof init === 'function' ? (init as () => T)() : init);
      const set = (v: T | ((prev: T) => T)) => {
        h.slots.set(i, typeof v === 'function' ? (v as (prev: T) => T)(h.slots.get(i) as T) : v);
      };
      return [h.slots.get(i) as T, set] as const;
    },
    useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
      const i = h.i++;
      h.effects.add(i);
      const prev = h.slots.get(i) as EffectSlot | undefined;
      const same =
        prev?.deps !== undefined &&
        deps !== undefined &&
        prev.deps.length === deps.length &&
        deps.every((d, k) => Object.is(d, prev.deps![k]));
      if (same) return;
      prev?.cleanup?.();
      const c = fn();
      h.slots.set(i, { deps, cleanup: typeof c === 'function' ? c : undefined } satisfies EffectSlot);
    },
    useId: () => `id-${h.i++}`,
    useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
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

vi.mock('@/lib/controllers/rideController', async (orig) => ({
  ...(await orig<typeof import('@/lib/controllers/rideController')>()),
  isRideControllerSupported: () => true,
  findGrantedController: h.findGranted,
  reconnectGrantedController: h.reconnectGranted,
  pairRideController: h.pair,
  disconnectRideController: h.disconnect,
  reconnectRideController: h.reconnect,
  buzzRideController: h.buzz,
}));

import { isValidElement } from 'react';
import { ButtonLegend, GearBuzzSwitch, HandlebarRow, ShowLegend, SteeringSwitch } from './ControllerPanel';
import type { DeviceRowProps } from './DeviceRow';
import type { HandlebarActionId, HandlebarRowView } from './devicesView';
import { useControllerStore } from '@/stores/controllerStore';
import { ASLEEP_TEXT, ASLEEP_TEXT_ARMED } from '@/lib/controllers/controllerView';

type RowProps = DeviceRowProps<HandlebarActionId> & { view: HandlebarRowView };

const initialControls = useControllerStore.getState();

/** Render (or re-render) the mounted row. */
function render(): RowProps {
  h.i = 0;
  const el = HandlebarRow() as ReactElement<RowProps> | null;
  if (!el) throw new Error('HandlebarRow rendered nothing');
  return { ...el.props };
}

/** Unmount: run every effect cleanup and drop the state. */
function unmount(): void {
  for (const i of h.effects) (h.slots.get(i) as EffectSlot | undefined)?.cleanup?.();
  h.slots.clear();
  h.effects.clear();
}

/** Let a resolved lookup's `.then` run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** Every component type in an element tree (props included, e.g. extrasLead). */
function typesIn(node: unknown, out = new Set<unknown>()): Set<unknown> {
  if (Array.isArray(node)) {
    for (const n of node) typesIn(n, out);
  } else if (isValidElement(node)) {
    out.add(node.type);
    for (const v of Object.values(node.props as Record<string, unknown>)) typesIn(v, out);
  }
  return out;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  for (const f of [h.findGranted, h.reconnectGranted, h.pair, h.disconnect, h.reconnect, h.buzz]) f.mockClear();
  h.findGranted.mockImplementation(() => Promise.resolve(null));
});

afterEach(() => {
  unmount();
  useControllerStore.setState(initialControls, true);
});

describe('HandlebarRow: controls paired in an earlier session (#26 granted reconnect)', () => {
  it('idle with a grant: the row offers "Reconnect Zwift Ride", and the tap reconnects without the chooser', async () => {
    h.findGranted.mockResolvedValue({ name: 'Zwift Ride' });
    render();
    expect(h.findGranted).toHaveBeenCalledTimes(1);
    await flush();
    const row = render();
    expect(row.view.action).toEqual({ id: 'reconnectGranted', label: 'Reconnect', ariaLabel: 'Reconnect Zwift Ride' });
    expect(row.view.state).toContain('Paired before');
    expect(row.view.extras.map((x) => x.id)).toEqual(['pair']);

    row.onAction(row.view.action!.id);
    expect(h.reconnectGranted).toHaveBeenCalledTimes(1);
    // A tap, not the ride page's silent start: no { silent: true }.
    expect(h.reconnectGranted.mock.calls[0]).toEqual([]);
    expect(h.pair).not.toHaveBeenCalled();
  });

  it('a grant without a name still reads as handlebar controls', async () => {
    h.findGranted.mockResolvedValue({});
    render();
    await flush();
    expect(render().view.action?.ariaLabel).toBe('Reconnect Handlebar controls');
  });

  it('the Pair link still opens the chooser; after it, the grant is no longer offered (Try again + Show all devices)', async () => {
    h.findGranted.mockResolvedValue({ name: 'Zwift Ride' });
    render();
    await flush();
    render().onAction('pair');
    expect(h.pair).toHaveBeenCalledTimes(1);
    expect(h.pair.mock.calls[0]).toEqual([]);
    const row = render();
    expect(row.view.action?.id).toBe('pair');
    expect(row.view.action?.label).toBe('Try again');
    expect(row.view.extras.map((x) => x.id)).toEqual(['pairAll']);
    row.onAction('pairAll');
    expect(h.pair).toHaveBeenLastCalledWith({ showAllDevices: true });
  });

  it('no grant: the plain Pair row', async () => {
    render();
    await flush();
    const row = render();
    expect(row.view.action).toEqual({ id: 'pair', label: 'Pair', ariaLabel: 'Pair handlebar controls' });
    expect(row.view.state).toBe('Optional · not paired');
  });

  it('looks for a grant only while the controls are idle', () => {
    useControllerStore.setState({ status: 'connected', side: 'left', inputSeen: true });
    render();
    expect(h.findGranted).not.toHaveBeenCalled();
  });

  it('a lookup that lands after the controls left idle is dropped (cancelled with its effect)', async () => {
    const first = deferred<{ name?: string } | null>();
    h.findGranted.mockReturnValueOnce(first.promise);
    render();
    // The rider starts pairing before the grant list comes back.
    useControllerStore.setState({ status: 'connecting' });
    render();
    first.resolve({ name: 'Zwift Ride' });
    await flush();
    // Pairing closed without a device: idle again, a new lookup in flight.
    h.findGranted.mockReturnValueOnce(new Promise(() => undefined));
    useControllerStore.setState({ status: 'idle' });
    const row = render();
    expect(h.findGranted).toHaveBeenCalledTimes(2);
    expect(row.view.action?.id).toBe('pair');
  });
});

describe('HandlebarRow: the #26 port (Forget, legend, switches, asleep copy)', () => {
  it('Forget drops the remembered unit ({ forget: true }); Disconnect keeps it', () => {
    useControllerStore.setState({ status: 'locked' });
    const locked = render();
    expect(locked.view.extras.map((x) => x.id)).toContain('forget');
    locked.onAction('forget');
    expect(h.disconnect).toHaveBeenCalledTimes(1);
    expect(h.disconnect).toHaveBeenLastCalledWith({ forget: true });

    unmount();
    useControllerStore.setState({ status: 'connected', side: 'left', inputSeen: true });
    render().onAction('disconnect');
    expect(h.disconnect).toHaveBeenCalledTimes(2);
    expect(h.disconnect.mock.calls[1]).toEqual([]);
  });

  it('asleep: Forget forgets there too', () => {
    useControllerStore.setState({ status: 'asleep' });
    render().onAction('forget');
    expect(h.disconnect).toHaveBeenLastCalledWith({ forget: true });
  });

  it('a live link: "What the buttons do" holds the show legend, the steering and the gear-buzz switches', () => {
    useControllerStore.setState({ status: 'connected', side: 'left', inputSeen: true });
    const row = render();
    expect(row.view.settings).toBe(true);
    const types = typesIn(row.extrasLead);
    expect(types.has(ButtonLegend)).toBe(true);
    expect(types.has(ShowLegend)).toBe(true);
    expect(types.has(SteeringSwitch)).toBe(true);
    expect(types.has(GearBuzzSwitch)).toBe(true);
  });

  it('no link: no settings in the row', () => {
    const row = render();
    expect(row.view.settings).toBe(false);
    const types = typesIn(row.extrasLead);
    expect(types.has(GearBuzzSwitch)).toBe(false);
    expect(types.has(ShowLegend)).toBe(false);
  });

  it('asleep: the help follows the store\'s wake watch', () => {
    useControllerStore.setState({ status: 'asleep', wakeArmed: false });
    expect(render().view.help).toBe(ASLEEP_TEXT);
    useControllerStore.setState({ status: 'asleep', wakeArmed: true });
    expect(render().view.help).toBe(ASLEEP_TEXT_ARMED);
  });

  it('the other actions reach their lib calls', () => {
    useControllerStore.setState({ status: 'connected', side: 'left', inputSeen: true });
    const row = render();
    row.onAction('buzz');
    expect(h.buzz).toHaveBeenCalledTimes(1);
    row.onAction('reconnect');
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    row.onAction('pairOther');
    expect(h.pair).toHaveBeenLastCalledWith();
    expect(h.reconnectGranted).not.toHaveBeenCalled();
  });
});
