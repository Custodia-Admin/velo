/**
 * The floating ride window as components (ShowSurface.tsx), called as plain
 * functions: ShowSurface portals FloatingRide into the open window, and
 * FloatingRide's element tree is walked through `isValidElement` props.
 * React's effects are skipped (they measure the window's layout and sync
 * its theme), refs are plain objects, the open window is a fake, the world
 * view is a stub.
 *
 * What this pins (review of PR #50 @3c14049, X10): the window draws the one
 * status chip, problems only (`alertsOnly`), in its bottom bar beside the
 * JourneyBar. Without it a trainer drop or a frozen 3D view ("3D view
 * stopped · tap to reload") in the window would have nothing to tap: the
 * Velo tab behind it shows only "Bring the ride back".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';

const h = vi.hoisted(() => ({
  win: null as Window | null,
}));

vi.mock('react', async (orig) => {
  const react = await orig<typeof import('react')>();
  const hooks = {
    useEffect: () => undefined,
    useRef: <T,>(init: T) => ({ current: init }),
    useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  };
  return { ...react, ...hooks, default: { ...react, ...hooks } };
});

vi.mock('react-dom', async (orig) => {
  const dom = await orig<typeof import('react-dom')>();
  return { ...dom, createPortal: (children: ReactNode, container: unknown) => ({ portal: true, children, container }) };
});

vi.mock('@/lib/show/pip', async (orig) => ({
  ...(await orig<typeof import('@/lib/show/pip')>()),
  currentRidePip: () => h.win,
  subscribeRidePip: () => () => undefined,
}));

// The world view (either renderer) is not what this test is about.
vi.mock('@/components/ride/RideView', () => ({ RideView: function RideView() { return null; } }));

import { ShowSurface } from './ShowSurface';
import { RideChip } from './RideChip';
import { JourneyBar } from './JourneyBar';

interface Portal {
  portal: true;
  children: ReactElement;
  container: unknown;
}

/** Every element in a tree, each with its parent element (null at the root). */
function elements(node: unknown, parent: ReactElement | null = null, out: Array<{ el: ReactElement; parent: ReactElement | null }> = []) {
  if (Array.isArray(node)) {
    for (const n of node) elements(n, parent, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push({ el: node, parent });
  const props = node.props as { children?: unknown };
  elements(props.children, node, out);
  return out;
}

/** What FloatingRide (the portal's child) renders. */
function floatingRide(): ReactElement {
  const portal = ShowSurface({ ionToken: null }) as unknown as Portal | null;
  expect(portal).not.toBeNull();
  expect(portal!.portal).toBe(true);
  expect(portal!.container).toBe(h.win!.document.body);
  const el = portal!.children;
  const render = el.type as (props: unknown) => ReactElement;
  return render(el.props);
}

beforeEach(() => {
  h.win = { document: { body: { id: 'pip-body' } } } as unknown as Window;
});

afterEach(() => {
  h.win = null;
});

describe('the floating ride window (ShowSurface)', () => {
  it('draws nothing while no window is open', () => {
    h.win = null;
    expect(ShowSurface({ ionToken: null })).toBeNull();
  });

  it('draws the status chip, problems only, in the bottom bar beside the JourneyBar', () => {
    const tree = elements(floatingRide());
    const chips = tree.filter(({ el }) => el.type === RideChip);
    expect(chips).toHaveLength(1);
    const [{ el: chip, parent }] = chips;
    expect((chip.props as { alertsOnly?: boolean }).alertsOnly).toBe(true);
    // Its bar also holds the JourneyBar: the bottom of the window, not a corner of the world.
    const bar = elements((parent!.props as { children?: unknown }).children, parent);
    expect(bar.some(({ el }) => el.type === JourneyBar)).toBe(true);
  });
});
