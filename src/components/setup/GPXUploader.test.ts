/**
 * GPXUploader ("Or ride your own route", Home → Build your own ride, step 1)
 * as a component: React's hooks run on a tiny in-test runtime and zustand's
 * React binding reads getState() (RideSetupWizard.test.ts pattern), so the
 * element tree it returns is read against the real ride store.
 *
 * What this pins: the loaded-route tile shows the route THIS uploader loaded
 * (a GPX or the demo loop) and only while it is still the ride's route, never
 * a scenic pick or a generated route; it survives the step closing and
 * opening again; the file input loads a parsed GPX; Save saves that route.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

const h = vi.hoisted(() => ({
  slots: new Map<number, unknown>(),
  i: 0,
  saved: [] as unknown[],
  parsed: [] as [string, string][],
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
    useCallback: <T,>(fn: T) => fn,
  };
  return { ...react, ...hooks, default: { ...react, ...hooks } };
});

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

// No IndexedDB in the node env: the library is a recorder.
vi.mock('@/lib/routeLibrary', () => ({
  hasRoute: async () => false,
  saveRoute: async (route: unknown) => {
    h.saved.push(route);
    return route;
  },
}));

// No DOMParser in the node env: parse with buildRoute and record the call
// (the real GPX parse runs in the browser check of the PR).
vi.mock('@/lib/gpxParser', async (orig) => {
  const real = await orig<typeof import('@/lib/gpxParser')>();
  return {
    ...real,
    parseGpx: (xml: string, name: string) => {
      h.parsed.push([xml, name]);
      return real.buildRoute(name, [
        { lat: 43.1, lon: 12.0, ele: 250 },
        { lat: 43.105, lon: 12.005, ele: 262 },
        { lat: 43.11, lon: 12.01, ele: 255 },
      ]);
    },
  };
});

import { isValidElement } from 'react';
import { GPXUploader } from './GPXUploader';
import { SCENIC_ROUTES } from '@/lib/scenicRoutes';
import { useRideStore } from '@/stores/rideStore';

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

function render() {
  h.i = 0;
  const tree = elements(GPXUploader());
  const button = (label: string) => {
    const el = tree.find((e) => typeof e.props.onClick === 'function' && textOf(e.props.children).includes(label));
    if (!el) throw new Error(`no ${label} button`);
    return el.props as AnyProps & { onClick: () => void };
  };
  const tile = tree.find((e) => 'data-gpx-loaded' in e.props);
  const input = tree.find((e) => e.type === 'input' && e.props.type === 'file');
  return { button, tile: tile ? textOf(tile) : null, input: input!.props as AnyProps & { onChange: (e: unknown) => void } };
}

const GPX = `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Lakeside</name><trkseg>
<trkpt lat="43.1000" lon="12.0000"><ele>250</ele></trkpt>
<trkpt lat="43.1050" lon="12.0050"><ele>262</ele></trkpt>
<trkpt lat="43.1100" lon="12.0100"><ele>255</ele></trkpt>
</trkseg></trk></gpx>`;

beforeEach(() => {
  useRideStore.setState(initialRide, true);
  h.slots.clear();
  h.saved.length = 0;
  h.parsed.length = 0;
});

describe('GPXUploader — the loaded route', () => {
  it('shows only the route it loaded, while that is still the ride\'s route', () => {
    const scenic = SCENIC_ROUTES[0].route;
    useRideStore.getState().setRoute(scenic);
    expect(render().tile).toBeNull();

    render().button('Demo route').onClick();
    const demo = useRideStore.getState().route!;
    expect(demo.id).not.toBe(scenic.id);
    const tile = render().tile!;
    expect(tile).toContain(demo.name);
    expect(tile).toContain(`${(demo.totalDistance / 1000).toFixed(1)} km · ${Math.round(demo.ascent)} m up · ${Math.round(demo.descent)} m down`);

    // A scenic pick (or a generated route) replaces it: no stale "loaded" tile.
    useRideStore.getState().setRoute(scenic);
    expect(render().tile).toBeNull();

    // The step closing and opening again (a fresh mount) still knows its route.
    useRideStore.getState().setRoute(demo);
    h.slots.clear();
    expect(render().tile).toContain(demo.name);
  });

  it('the file input loads the parsed GPX (and clears itself so the same file can load again)', async () => {
    const target = { files: [{ name: 'Lakeside.gpx', text: async () => GPX }], value: 'C:\\fakepath\\Lakeside.gpx' };
    render().input.onChange({ target });
    expect(target.value).toBe('');
    await vi.waitFor(() => expect(useRideStore.getState().route?.name).toBe('Lakeside'));
    expect(h.parsed).toEqual([[GPX, 'Lakeside']]);
    expect(render().tile).toContain('Lakeside');
  });

  it('Save saves the loaded route', async () => {
    render().button('Demo route').onClick();
    const demo = useRideStore.getState().route;
    render().button('Save').onClick();
    await vi.waitFor(() => expect(h.saved).toEqual([demo]));
  });
});
