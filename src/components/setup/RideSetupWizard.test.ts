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
 *
 * And the route step's own wiring (review of PR #65 @7101401, N1), with the
 * effects running (state slots, effects with deps and cleanups): city search
 * → the places found → the generator for the picked place → Generate →
 * the preview → Use this route; the router-failure branch; a scenic tile
 * tap. The geocoder and the route generator are stubs (no network); the
 * scenic catalog and the ride store are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

interface EffectSlot {
  deps?: readonly unknown[];
  cleanup?: () => void;
}

const h = vi.hoisted(() => ({
  slots: new Map<number, unknown>(),
  effects: new Set<number>(),
  i: 0,
  navigate: vi.fn(),
  geocode: vi.fn(),
  generate: vi.fn(),
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
    useMemo: <T,>(fn: () => T) => fn(),
    useCallback: <T,>(fn: T) => fn,
  };
  return { ...react, ...hooks, default: { ...react, ...hooks } };
});

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => h.navigate,
}));

// No network: the places found and the generated routes are the test's.
vi.mock('@/lib/geocoder', async (orig) => ({
  ...(await orig<typeof import('@/lib/geocoder')>()),
  geocode: h.geocode,
}));
vi.mock('@/lib/routeGenerator', async (orig) => ({
  ...(await orig<typeof import('@/lib/routeGenerator')>()),
  generateRoute: h.generate,
}));
// Generate asks Cesium for a terrain provider on demand: none here (no token).
vi.mock('@/lib/cesiumUtils', () => ({ getTerrainProvider: async () => null }));

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
import {
  GenerateActions,
  RideSetupWizard,
  compassPoint,
  generateErrorText,
  generatedRouteName,
  placeRegion,
  resultRegion,
} from './RideSetupWizard';
import { RoutePreview } from './RoutePreview';
import { Button } from '@/components/ui/button';
import { TrainerRow } from '@/components/velo/TrainerPanel';
import { PARTNERS, togglePartner } from '@/components/velo/pacePartners';
import type { GeocodeResult } from '@/lib/geocoder';
import { RouteGenerationError } from '@/lib/routeGenerator';
import { SCENIC_ROUTES, homeFirstScenicRoutes } from '@/lib/scenicRoutes';
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
  h.effects.clear();
  h.navigate.mockReset();
  h.geocode.mockReset();
  h.generate.mockReset();
});

/** Unmount: run every effect cleanup (debounce timers, aborts) and drop the state. */
afterEach(() => {
  for (const i of h.effects) (h.slots.get(i) as EffectSlot | undefined)?.cleanup?.();
  h.slots.clear();
  h.effects.clear();
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

describe('RideSetupWizard — search results and the generator\'s actions', () => {
  it('two results that read the same say what each place is; a lone result does not', () => {
    // Nominatim's real answer for "Perugia": the county and the city, one display name.
    const county = { shortName: 'Perugia', displayName: 'Perugia, Umbria, Italy', kind: 'county' };
    const city = { shortName: 'Perugia', displayName: 'Perugia, Umbria, Italy', kind: 'city' };
    const kyoto = { shortName: 'Kyoto', displayName: 'Kyoto, Japan', kind: 'city' };
    expect(resultRegion(county, [county, city, kyoto])).toBe('Umbria, Italy · county');
    expect(resultRegion(city, [county, city, kyoto])).toBe('Umbria, Italy · city');
    expect(resultRegion(kyoto, [county, city, kyoto])).toBe('Japan');
    expect(resultRegion({ ...city, kind: undefined }, [county, city])).toBe('Umbria, Italy');
  });

  it('router failures read in plain words (no "synthetic routing"); other errors pass through', () => {
    const noRoute = generateErrorText('osrm_no_route', 'Perugia', 'raw');
    const network = generateErrorText('osrm_network', 'Perugia', 'Could not reach the cycling router. Try again or use synthetic routing.');
    expect(noRoute).toBe('No bike roads near Perugia. Try another place, or draw the route without roads.');
    expect(network).toBe("Couldn't reach the bike router. Try again, or draw the route without roads.");
    for (const t of [noRoute, network]) expect(t).not.toMatch(/synthetic/i);
    expect(generateErrorText('unknown', 'Perugia', 'Elevation service down')).toBe('Elevation service down');
  });

  function actions(over: Partial<Parameters<typeof GenerateActions>[0]> = {}) {
    const onGenerate = vi.fn();
    const onRoadFree = vi.fn();
    const tree = elements(
      GenerateActions({ generating: false, phaseLabel: null, offerRoadFree: false, onGenerate, onRoadFree, ...over }),
    );
    const buttons = tree
      .filter((e) => typeof e.props.onClick === 'function')
      .map((e) => ({ ...e.props, text: textOf(e.props.children).trim() }) as { text: string; variant?: string; disabled?: boolean; onClick: () => void });
    return { buttons, onGenerate, onRoadFree };
  }

  it('normally one filled Generate route; while it runs it says the phase and waits', () => {
    const idle = actions();
    expect(idle.buttons.map((b) => [b.text, b.variant])).toEqual([['Generate route', 'primary']]);
    idle.buttons[0].onClick();
    expect(idle.onGenerate).toHaveBeenCalledOnce();
    const busy = actions({ generating: true, phaseLabel: 'Snapping to bike roads…' });
    expect(busy.buttons).toHaveLength(1);
    expect(busy.buttons[0].text).toBe('Snapping to bike roads…');
    expect(busy.buttons[0].disabled).toBe(true);
  });

  it('after a router failure the filled action is the one that still works; Try again is the outline beside it', () => {
    const a = actions({ offerRoadFree: true });
    expect(a.buttons.map((b) => [b.text, b.variant])).toEqual([
      ['Draw it without roads', 'primary'],
      ['Try again', 'outline'],
    ]);
    expect(a.buttons.filter((b) => b.variant === 'primary')).toHaveLength(1);
    a.buttons[0].onClick();
    expect(a.onRoadFree).toHaveBeenCalledOnce();
    expect(a.onGenerate).not.toHaveBeenCalled();
    a.buttons[1].onClick();
    expect(a.onGenerate).toHaveBeenCalledOnce();
  });
});

describe('RideSetupWizard — the route step (search, generate, scenic pick)', () => {
  /** RouteStep's hooks take the slots past the wizard's own. */
  const ROUTE_STEP_SLOTS = 1000;
  /** The step's own pieces are rendered through (no hooks); every other component stays a leaf. */
  const RENDER_THROUGH = new Set(['GenerateActions', 'RoutePreview', 'ErrorLine', 'ShapeButton', 'RangeRow']);

  function tree(node: ReactNode): ReactElement<AnyProps>[] {
    if (Array.isArray(node)) return node.flatMap(tree);
    if (!isValidElement<AnyProps>(node)) return [];
    if (typeof node.type === 'function' && RENDER_THROUGH.has(node.type.name)) {
      return [node, ...tree((node.type as (p: AnyProps) => ReactNode)(node.props))];
    }
    return [node, ...tree(node.props.children)];
  }

  /** The text each element holds directly, in tree order. */
  function words(els: ReactElement<AnyProps>[]): string[] {
    return els.flatMap((e) => {
      const c = e.props.children;
      return (Array.isArray(c) ? c : [c])
        .filter((x): x is string | number => typeof x === 'string' || typeof x === 'number')
        .map((x) => String(x).trim())
        .filter(Boolean);
    });
  }

  interface Btn {
    text: string;
    variant?: string;
    disabled?: boolean;
    pressed?: boolean;
    onClick: () => void;
  }
  const btn = (e: ReactElement<AnyProps>): Btn => ({
    text: textOf(e.props.children).trim(),
    variant: e.props.variant as string | undefined,
    disabled: e.props.disabled as boolean | undefined,
    pressed: e.props['aria-pressed'] as boolean | undefined,
    onClick: e.props.onClick as () => void,
  });

  type InputProps = AnyProps & { value: string; onChange: (e: unknown) => void };
  type RangeProps = AnyProps & { 'aria-label': string; 'aria-valuetext': string; onChange: (e: unknown) => void };

  /** Mount step 1's RouteStep (the wizard's own element and props) and return its renderer. */
  function mount() {
    const el = render().child('RouteStep');
    return () => {
      h.i = ROUTE_STEP_SLOTS;
      const all = tree(el.type(el.props));
      const gen = all.find((e) => 'data-route-generator' in e.props);
      const genTree = gen ? tree(gen.props.children) : [];
      const list = all.find((e) => 'data-search-results' in e.props);
      const clear = all.find((e) => e.props['aria-label'] === 'Clear search');
      return {
        search: all.find((e) => e.type === 'input' && e.props.type === 'search')!.props as InputProps,
        results: list
          ? tree(list.props.children)
              .filter((e) => e.type === 'button')
              .map((b) => ({ ...btn(b), lines: words(tree(b.props.children)) }))
          : [],
        clear: clear ? btn(clear) : null,
        listClass: list ? (list.props.className as string) : null,
        generator: gen
          ? {
              words: words(genTree),
              /** The visible actions (ui Button), with their variants. */
              buttons: genTree.filter((e) => e.type === Button).map(btn),
              shapes: genTree.filter((e) => e.type === 'button' && 'aria-pressed' in e.props).map(btn),
              ranges: genTree.filter((e) => e.type === 'input' && e.props.type === 'range').map((e) => e.props as RangeProps),
            }
          : null,
        alerts: all.filter((e) => e.props.role === 'alert').map((e) => textOf(e.props.children).trim()),
        preview: all.find((e) => e.type === RoutePreview)?.props.route as Route | undefined,
        tiles: all
          .filter((e) => 'data-featured-route' in e.props)
          .map((e) => ({ id: e.props['data-featured-route'] as string, className: e.props.className as string, ...btn(e) })),
      };
    };
  }
  type View = ReturnType<typeof mount>;

  // Nominatim's real answer for "Perugia": the county and the city, one display name.
  const COUNTY: GeocodeResult = { placeId: 1, displayName: 'Perugia, Umbria, Italy', shortName: 'Perugia', lat: 43.05, lon: 12.45, kind: 'county' };
  const CITY: GeocodeResult = {
    placeId: 2,
    displayName: 'Perugia, Umbria, Italy',
    shortName: 'Perugia',
    lat: 43.1122,
    lon: 12.3888,
    kind: 'city',
    boundingBox: [43.0, 43.2, 12.3, 12.5],
  };
  const KYOTO: GeocodeResult = { placeId: 3, displayName: 'Kyoto, Japan', shortName: 'Kyoto', lat: 35.0116, lon: 135.7681, kind: 'city' };

  /** What the generator hands back: named by the place, as long as it came out. */
  function generated(place: string, totalDistance: number): Route {
    return {
      id: `generated-${place}-${totalDistance}`,
      name: place,
      points: [
        { lat: CITY.lat, lon: CITY.lon, ele: 400, distance: 0 },
        { lat: CITY.lat + 0.1, lon: CITY.lon, ele: 520, distance: totalDistance },
      ],
      totalDistance,
      ascent: 120,
      descent: 0,
      minElevation: 400,
      maxElevation: 520,
      loadedAt: 0,
    };
  }

  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  /** Type a query, wait out the debounce, pick a result. */
  async function searchAndPick(view: View, query = 'Perugia', places = [COUNTY, CITY, KYOTO], pickAt = 1) {
    h.geocode.mockResolvedValue(places);
    view().search.onChange({ target: { value: query } });
    await vi.waitFor(() => expect(view().results).toHaveLength(places.length));
    view().results[pickAt].onClick();
  }

  it('search: one debounced lookup; twin results say what each place is; the pick heads the generator with its region', async () => {
    const view = mount();
    expect(view().generator).toBeNull();
    h.geocode.mockResolvedValue([COUNTY, CITY, KYOTO]);
    view().search.onChange({ target: { value: 'Perugia' } });
    expect(view().search.value).toBe('Perugia');
    await vi.waitFor(() => expect(view().results).toHaveLength(3));
    expect(h.geocode).toHaveBeenCalledTimes(1);
    expect(h.geocode).toHaveBeenCalledWith('Perugia', { signal: expect.any(AbortSignal) });
    expect(view().results.map((r) => r.lines)).toEqual([
      ['Perugia', 'Umbria, Italy · county'],
      ['Perugia', 'Umbria, Italy · city'],
      ['Kyoto', 'Japan'],
    ]);

    // The list floats over the scenic tiles: a shadow, and at night a surface of its own
    // (the tiles are bg-card, and a shadow barely shows on the night page).
    await vi.waitFor(() => expect(view().tiles.length).toBeGreaterThan(0));
    const classes = (c: string | null) => (c ?? '').split(/\s+/);
    expect(classes(view().listClass)).toEqual(expect.arrayContaining(['absolute', 'shadow-lg', 'dark:bg-muted']));
    expect(classes(view().tiles[0].className)).toContain('bg-card');

    view().results[1].onClick();
    const v = view();
    expect(v.results).toEqual([]);
    expect(v.listClass).toBeNull();
    expect(v.generator!.words.slice(0, 2)).toEqual(['Perugia', 'Umbria, Italy']);
    expect(v.generator!.words).not.toContain(CITY.displayName);
    expect(v.generator!.buttons.map((b) => [b.text, b.variant])).toEqual([['Generate route', 'primary']]);
    expect(useRideStore.getState().flyToTarget).toMatchObject({ lat: CITY.lat, lon: CITY.lon, label: 'Perugia' });
    expect(useRideStore.getState().route).toBeNull();
  });

  it('Generate → a preview named by the length it came out at; Use this route commits it and opens step 2', async () => {
    const view = mount();
    await searchAndPick(view);
    let v = view();
    // The sliders and the shape decide what is generated.
    expect(v.generator!.ranges.map((r) => r['aria-label'])).toEqual(['Route distance in km', 'Route heading in degrees']);
    v.generator!.ranges[0].onChange({ target: { value: '42' } });
    view().generator!.ranges[1].onChange({ target: { value: '100' } });
    v = view();
    expect(v.generator!.ranges.map((r) => r['aria-valuetext'])).toEqual(['42 km', '100° E']);
    expect(v.generator!.words).toEqual(expect.arrayContaining(['42 km', '100° E']));
    expect(v.generator!.shapes.map((s) => [s.text, s.pressed])).toEqual([['Out & back', true], ['Loop', false]]);

    const run = deferred<Route>();
    h.generate.mockReturnValueOnce(run.promise);
    v.generator!.buttons[0].onClick();
    await vi.waitFor(() => expect(h.generate).toHaveBeenCalledTimes(1));
    expect(h.generate).toHaveBeenCalledWith(
      { lat: CITY.lat, lon: CITY.lon },
      expect.objectContaining({ shape: 'out-and-back', lengthKm: 42, headingDeg: 100, useSynthetic: false, name: 'Perugia' }),
    );
    // While it runs, the one button waits and says the phase.
    expect(view().generator!.buttons.map((b) => [b.text, b.variant, b.disabled])).toEqual([['Routing real roads…', 'primary', true]]);

    run.resolve(generated('Perugia', 36_300));
    await vi.waitFor(() => expect(view().preview).toBeDefined());
    v = view();
    expect(v.preview!.name).toBe('Perugia · 36 km out-and-back');
    expect(v.generator!.words).toContain('Perugia · 36 km out-and-back');
    // One filled action: Use this route takes Generate route's place.
    expect(v.generator!.buttons.map((b) => [b.text, b.variant])).toEqual([
      ['Use this route', 'primary'],
      ['Try again', 'outline'],
    ]);
    // The preview is held until the rider commits it.
    expect(useRideStore.getState().route).toBeNull();

    v.generator!.buttons[0].onClick();
    expect(useRideStore.getState().route).toMatchObject({ name: 'Perugia · 36 km out-and-back', totalDistance: 36_300 });
    const wizard = render();
    expect(wizard.header(2).active).toBe(true);
    expect(wizard.header(1)).toMatchObject({ done: true, subtitle: 'Perugia · 36 km out-and-back' });
  });

  it('Loop: its toggle presses, the heading goes (a loop has none), and the loop is named so', async () => {
    const view = mount();
    await searchAndPick(view);
    view().generator!.shapes[1].onClick();
    const v = view();
    expect(v.generator!.shapes.map((s) => [s.text, s.pressed])).toEqual([['Out & back', false], ['Loop', true]]);
    expect(v.generator!.ranges.map((r) => r['aria-label'])).toEqual(['Route distance in km']);
    h.generate.mockResolvedValueOnce(generated('Perugia', 29_499));
    v.generator!.buttons[0].onClick();
    await vi.waitFor(() => expect(view().preview?.name).toBe('Perugia · 29 km loop'));
    expect(h.generate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ shape: 'loop', lengthKm: 30 }));
  });

  it('a router failure: the plain-words error, Draw it without roads filled with Try again beside it; drawing it previews', async () => {
    const view = mount();
    await searchAndPick(view);
    h.generate.mockRejectedValueOnce(new RouteGenerationError('Could not reach the cycling router.', 'osrm_no_route'));
    view().generator!.buttons[0].onClick();
    await vi.waitFor(() =>
      expect(view().alerts).toEqual(['No bike roads near Perugia. Try another place, or draw the route without roads.']),
    );
    let v = view();
    expect(v.generator!.buttons.map((b) => [b.text, b.variant])).toEqual([
      ['Draw it without roads', 'primary'],
      ['Try again', 'outline'],
    ]);
    expect(v.preview).toBeUndefined();

    h.generate.mockResolvedValueOnce(generated('Perugia', 30_000));
    v.generator!.buttons[0].onClick();
    await vi.waitFor(() => expect(view().preview?.name).toBe('Perugia · 30 km out-and-back'));
    expect(h.generate).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ useSynthetic: true }));
    v = view();
    expect(v.alerts).toEqual([]);
    expect(v.generator!.buttons.map((b) => [b.text, b.variant])).toEqual([
      ['Use this route', 'primary'],
      ['Try again', 'outline'],
    ]);
  });

  it('when drawing without roads fails too, nothing it cannot do is offered: the error and one Generate route', async () => {
    const view = mount();
    await searchAndPick(view);
    h.generate.mockRejectedValueOnce(new RouteGenerationError('raw', 'osrm_network'));
    view().generator!.buttons[0].onClick();
    await vi.waitFor(() => expect(view().generator!.buttons[0]?.text).toBe('Draw it without roads'));
    h.generate.mockRejectedValueOnce(new Error('Elevation service down'));
    view().generator!.buttons[0].onClick();
    await vi.waitFor(() => expect(view().alerts).toEqual(['Elevation service down']));
    expect(view().generator!.buttons.map((b) => [b.text, b.variant])).toEqual([['Generate route', 'primary']]);
  });

  it('Clear search drops the query, the place, its error and its preview', async () => {
    const view = mount();
    await searchAndPick(view);
    h.generate.mockRejectedValueOnce(new RouteGenerationError('raw', 'osrm_no_route'));
    view().generator!.buttons[0].onClick();
    await vi.waitFor(() => expect(view().alerts).toHaveLength(1));

    view().clear!.onClick();
    const v = view();
    expect(v.search.value).toBe('');
    expect(v.results).toEqual([]);
    expect(v.generator).toBeNull();
    expect(v.alerts).toEqual([]);
    expect(v.clear).toBeNull();

    // Picking a place again starts clean: no old error, Generate route.
    await searchAndPick(view, 'Kyoto', [KYOTO], 0);
    expect(view().alerts).toEqual([]);
    expect(view().generator!.words.slice(0, 2)).toEqual(['Kyoto', 'Japan']);
    expect(view().generator!.buttons.map((b) => [b.text, b.variant])).toEqual([['Generate route', 'primary']]);
  });

  it('another place picked while a route generates drops that route: no old preview under the new name', async () => {
    const view = mount();
    await searchAndPick(view);
    const perugia = deferred<Route>();
    h.generate.mockReturnValueOnce(perugia.promise);
    view().generator!.buttons[0].onClick();
    await vi.waitFor(() => expect(h.generate).toHaveBeenCalledTimes(1));
    const signal = (h.generate.mock.calls[0][1] as { signal: AbortSignal }).signal;

    await searchAndPick(view, 'Kyoto', [KYOTO], 0);
    expect(signal.aborted).toBe(true);
    expect(view().generator!.buttons.map((b) => [b.text, b.variant, b.disabled])).toEqual([['Generate route', 'primary', false]]);

    perugia.resolve(generated('Perugia', 36_300));
    await new Promise((r) => setTimeout(r, 20));
    const v = view();
    expect(v.generator!.words.slice(0, 2)).toEqual(['Kyoto', 'Japan']);
    expect(v.preview).toBeUndefined();
    expect(v.generator!.buttons.map((b) => b.text)).toEqual(['Generate route']);
  });

  it('Clear search while a route generates drops it too', async () => {
    const view = mount();
    await searchAndPick(view);
    const run = deferred<Route>();
    h.generate.mockReturnValueOnce(run.promise);
    view().generator!.buttons[0].onClick();
    await vi.waitFor(() => expect(h.generate).toHaveBeenCalledTimes(1));
    view().clear!.onClick();
    expect((h.generate.mock.calls[0][1] as { signal: AbortSignal }).signal.aborted).toBe(true);
    run.resolve(generated('Perugia', 36_300));
    await new Promise((r) => setTimeout(r, 20));

    await searchAndPick(view, 'Kyoto', [KYOTO], 0);
    expect(view().preview).toBeUndefined();
    expect(view().generator!.buttons.map((b) => [b.text, b.disabled])).toEqual([['Generate route', false]]);
  });

  it('scenic tiles: the closest six, none pressed; a tap sets that route, presses its tile and opens step 2', async () => {
    const view = mount();
    const want = homeFirstScenicRoutes().slice(0, 6).map((s) => s.route.id);
    expect(want).toHaveLength(6);
    await vi.waitFor(() => expect(view().tiles.map((t) => t.id)).toEqual(want));
    expect(view().tiles.map((t) => t.pressed)).toEqual(want.map(() => false));

    view().tiles[1].onClick();
    expect(useRideStore.getState().route?.id).toBe(want[1]);
    expect(view().tiles.map((t) => t.pressed)).toEqual(want.map((_, i) => i === 1));
    expect(render().header(2).active).toBe(true);
  });
});
