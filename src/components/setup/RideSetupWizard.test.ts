/**
 * Home's "Build your own ride" (RideSetupWizard) as a component: the element
 * tree it returns, read against the real ride store, and its own Start
 * handler called the way the Start button calls it. React's hooks run on a
 * tiny in-test runtime (HandlebarRow.test.ts pattern) and zustand's React
 * binding reads getState(), so the wizard runs as a plain function in the
 * node test env. Child components are not expanded.
 *
 * What this pins (review of PR #37 @282329f, nits 1 and 2): the collapsed
 * step 3 header names the partners picked in the store, and the "Auto-pick
 * a route & start" path keeps them: after the auto-pick the roster is the
 * picked partners, standing on the new route's start line, before the ride
 * route opens.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

const h = vi.hoisted(() => ({
  slots: new Map<number, unknown>(),
  i: 0,
  navigate: vi.fn(),
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
    useRef: <T,>(init: T) => {
      const i = h.i++;
      if (!h.slots.has(i)) h.slots.set(i, { current: init });
      return h.slots.get(i) as { current: T };
    },
    useEffect: () => {
      h.i++;
    },
    useMemo: <T,>(fn: () => T) => fn(),
    useCallback: <T,>(fn: T) => fn,
  };
  return { ...react, ...hooks, default: { ...react, ...hooks } };
});

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => h.navigate,
}));

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

import { isValidElement } from 'react';
import { RideSetupWizard, compassPoint, generatedRouteName, placeRegion } from './RideSetupWizard';
import { TrainerRow } from '@/components/velo/TrainerPanel';
import { PARTNERS, togglePartner } from '@/components/velo/pacePartners';
import { SCENIC_ROUTES } from '@/lib/scenicRoutes';
import { useRideStore } from '@/stores/rideStore';
import type { Route } from '@/types';

type AnyProps = Record<string, unknown> & { children?: ReactNode };

const initialRide = useRideStore.getState();

function elements(node: ReactNode): ReactElement<AnyProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<AnyProps>(node)) return [];
  return [node, ...elements(node.props.children)];
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<AnyProps>(node)) return textOf(node.props.children);
  return '';
}

/** Render (or re-render) the mounted wizard. */
function render() {
  h.i = 0;
  const tree = elements(RideSetupWizard());
  const header = (n: number) => {
    const el = tree.find((e) => e.props.n === n && typeof e.props.onClick === 'function');
    if (!el) throw new Error(`no step ${n} header`);
    return { ...el.props } as AnyProps & { title: string; subtitle?: string; done: boolean; active: boolean; onClick: () => void };
  };
  const startEl = tree.find((e) => e.props.variant === 'primary' && /start/i.test(textOf(e.props.children)));
  if (!startEl) throw new Error('no Start button');
  const start = { ...startEl.props, label: textOf(startEl.props.children) } as AnyProps & {
    label: string;
    onClick: () => Promise<void>;
  };
  /** The open step's own component (not expanded by render()), by name. */
  const child = (name: string) => {
    const el = tree.find((e) => typeof e.type === 'function' && e.type.name === name);
    if (!el) throw new Error(`no ${name}`);
    return el as ReactElement<AnyProps> & { type: (p: AnyProps) => ReactNode };
  };
  return { header, start, child };
}

function pick(...ids: string[]): void {
  for (const id of ids) {
    const st = useRideStore.getState();
    st.setPaceBots(togglePartner(st.paceBots, id, st.route));
  }
}

const picked = [PARTNERS[0], PARTNERS[2]];

beforeEach(() => {
  useRideStore.setState(initialRide, true);
  h.slots.clear();
  h.navigate.mockReset();
});

describe('RideSetupWizard — pace partners', () => {
  it('the collapsed step 3 header names the partners picked in the store', () => {
    expect(render().header(3)).toMatchObject({ title: 'Pace partners', subtitle: 'Riding alone', done: false });

    pick(...picked.map((p) => p.id));
    expect(render().header(3)).toMatchObject({
      subtitle: `With ${picked[0].name}, ${picked[1].name}`,
      done: true,
    });

    // Open, the step shows the picker instead of a subtitle.
    render().header(3).onClick();
    expect(render().header(3).subtitle).toBeUndefined();
  });

  it('"Auto-pick a route & start" keeps the picked partners, on the new route\'s start line', async () => {
    pick(...picked.map((p) => p.id));
    const view = render();
    expect(view.start.label).toBe('Auto-pick a route & start');

    let atNavigate: { route: Route | null; ids: string[] } | null = null;
    h.navigate.mockImplementation(() => {
      const st = useRideStore.getState();
      atNavigate = { route: st.route, ids: st.paceBots.map((b) => b.id) };
    });
    await view.start.onClick();

    expect(h.navigate).toHaveBeenCalledTimes(1);
    expect(h.navigate).toHaveBeenCalledWith('/ride', { state: { autoStart: true } });
    const st = useRideStore.getState();
    const route = st.route!;
    expect(SCENIC_ROUTES.map((s) => s.route)).toContain(route);
    // The route and the roster are in place before /ride opens.
    expect(atNavigate).toEqual({ route, ids: picked.map((p) => p.id) });
    expect(st.paceBots.map((b) => b.name)).toEqual(picked.map((p) => p.name));
    for (const b of st.paceBots) {
      expect(b.state).toMatchObject({ distance: 0, speed: 0, lat: route.points[0].lat, lon: route.points[0].lon });
    }
  });

  it('Start with a route already picked rides that route, partners and all', async () => {
    // A route of the rider's own (GPX / city search), never one the auto-pick could draw.
    const chosen: Route = {
      id: 'my-gpx',
      name: 'My loop',
      points: [
        { lat: 43.05, lon: 12.5, ele: 240, distance: 0 },
        { lat: 43.05, lon: 12.51, ele: 250, distance: 800 },
      ],
      totalDistance: 800,
      ascent: 10,
      descent: 0,
      minElevation: 240,
      maxElevation: 250,
      loadedAt: 0,
    };
    useRideStore.getState().setRoute(chosen);
    pick(picked[1].id);
    const view = render();
    expect(view.start.label).toBe('Start ride');
    expect(view.header(1).done).toBe(true);

    await view.start.onClick();
    const st = useRideStore.getState();
    expect(st.route).toBe(chosen);
    expect(st.paceBots.map((b) => b.id)).toEqual([picked[1].id]);
    expect(st.paceBots[0].state).toMatchObject({ distance: 0, lat: chosen.points[0].lat, lon: chosen.points[0].lon });
    expect(h.navigate).toHaveBeenCalledWith('/ride', { state: { autoStart: true } });
  });
});

describe('RideSetupWizard — step 2 is the Devices trainer row', () => {
  function trainerStep() {
    const step2 = render().header(2);
    if (!step2.active) step2.onClick();
    const el = render().child('TrainerStep');
    h.i = 0;
    return elements(el.type(el.props));
  }

  it('renders the /devices TrainerRow (the legacy TrainerConnect is gone) and a way to /devices', () => {
    const tree = trainerStep();
    expect(tree.filter((e) => e.type === TrainerRow)).toHaveLength(1);
    const open = tree.find((e) => textOf(e.props.children) === 'Open Devices' && typeof e.props.onClick === 'function');
    expect(open).toBeDefined();
    (open!.props.onClick as () => void)();
    expect(h.navigate).toHaveBeenCalledWith('/devices');
  });

  it('the footer line follows the trainer link: what else pairs there, plus ERG once connected', () => {
    const text = () => trainerStep().map((e) => textOf(e)).join('|');
    expect(text()).toContain('Handlebar controls and heart rate pair on Devices.');
    expect(text()).not.toContain('ERG');
    useRideStore.getState().setConnection('connected', { deviceName: 'KICKR CORE 78C1' });
    expect(text()).toContain('Handlebar controls, heart rate and ERG are on Devices.');
  });
});

describe('RideSetupWizard — route step helpers', () => {
  it('a generated route is named by the length it came out at, not the slider target', () => {
    expect(generatedRouteName('Perugia', 'out-and-back', 36_300)).toBe('Perugia · 36 km out-and-back');
    expect(generatedRouteName('Kyoto', 'loop', 29_499)).toBe('Kyoto · 29 km loop');
    expect(generatedRouteName('Kyoto', 'loop', 200)).toBe('Kyoto · 1 km loop');
  });

  it('heading in degrees reads as an 8-wind compass point', () => {
    expect([0, 22, 23, 90, 135, 180, 225, 270, 315, 337, 338, 359].map(compassPoint))
      .toEqual(['N', 'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'NW', 'N', 'N']);
    expect(compassPoint(-90)).toBe('W');
  });

  it('a place\'s region drops the name its heading already shows', () => {
    expect(placeRegion({ shortName: 'Perugia', displayName: 'Perugia, Umbria, Italy' })).toBe('Umbria, Italy');
    expect(placeRegion({ shortName: 'Kyoto', displayName: 'Kyoto' })).toBe('Kyoto');
  });
});
