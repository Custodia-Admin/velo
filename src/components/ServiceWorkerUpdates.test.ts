import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The service-worker updater only learns about in-app navigation through
 * <ServiceWorkerUpdates />: without it a deploy that waited out a ride is
 * never activated on "Exit to Home", and a tab with a pending reload keeps
 * running the old bundle under the new worker. Nothing else fails when the
 * wiring goes, so these tests pin both ends of it.
 */

const location = vi.hoisted(() => ({ pathname: '/app' }));
const notifyRouteChange = vi.hoisted(() => vi.fn());

// useEffect that runs at once and re-runs only when its deps change, like
// React's (the component under test has a single effect).
const effect = vi.hoisted(() => ({ deps: undefined as unknown[] | undefined }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const useEffect = (fn: () => void, deps?: unknown[]) => {
    const prev = effect.deps;
    const changed = !prev || !deps || deps.length !== prev.length || deps.some((d, i) => !Object.is(d, prev[i]));
    effect.deps = deps;
    if (changed) fn();
  };
  return { ...actual, default: { ...actual, useEffect }, useEffect };
});
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useLocation: () => ({ ...location }),
}));
vi.mock('@/lib/swUpdate', () => ({ notifyRouteChange }));

// App's pages are irrelevant to the wiring; keep the import light.
vi.mock('@/routes/Home', () => ({ Home: () => null }));
vi.mock('@/components/setup/Toaster', () => ({ Toaster: () => null }));
vi.mock('@/components/trainer/TrainerEventBridge', () => ({ TrainerEventBridge: () => null }));

const { ServiceWorkerUpdates } = await import('./ServiceWorkerUpdates');
const { default: App } = await import('@/App');
const { BrowserRouter, Navigate, Route, Routes } = await import('react-router-dom');

type El = ReactElement<{ children?: ReactNode; path?: string; element?: ReactNode; to?: string }>;

/** Every element under `node`, with the chain of element types above it. */
function walk(node: ReactNode, above: unknown[] = [], out: { el: El; above: unknown[] }[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, above, out);
  } else if (isValidElement(node)) {
    const el = node as El;
    out.push({ el, above });
    walk(el.props.children, [...above, el.type], out);
  }
  return out;
}

describe('App mounts <ServiceWorkerUpdates /> inside the router', () => {
  const tree = App() as El;
  const all = walk(tree);

  it('renders it exactly once, under BrowserRouter and outside <Routes>, so every route reports', () => {
    expect(tree.type).toBe(BrowserRouter);
    const mounts = all.filter(({ el }) => el.type === ServiceWorkerUpdates);
    expect(mounts).toHaveLength(1);
    expect(mounts[0].above[0]).toBe(BrowserRouter);
    expect(mounts[0].above).not.toContain(Routes);
  });

  it('the installed PWA opens on Home: the manifest start_url is /app or redirects there', () => {
    const vite = readFileSync(resolve(__dirname, '../../vite.config.ts'), 'utf8');
    const startUrl = vite.match(/start_url:\s*'([^']+)'/)?.[1];
    expect(startUrl).toBeDefined();
    if (startUrl === '/app') return;
    const route = all.find(({ el }) => el.type === Route && el.props.path === startUrl)?.el;
    expect(route, `no <Route path="${startUrl}">`).toBeDefined();
    const target = route!.props.element as El;
    expect(target.type).toBe(Navigate);
    expect(target.props.to).toBe('/app');
  });
});

describe('<ServiceWorkerUpdates /> forwards every pathname to notifyRouteChange', () => {
  beforeEach(() => {
    notifyRouteChange.mockReset();
    effect.deps = undefined;
  });

  it('reports the first route, then each navigation once', () => {
    location.pathname = '/ride';
    expect(ServiceWorkerUpdates()).toBeNull();
    expect(notifyRouteChange).toHaveBeenLastCalledWith('/ride');

    ServiceWorkerUpdates(); // re-render on the same route: no new report
    expect(notifyRouteChange).toHaveBeenCalledTimes(1);

    location.pathname = '/app'; // Exit to Home: the waiting deploy may activate now
    ServiceWorkerUpdates();
    expect(notifyRouteChange).toHaveBeenCalledTimes(2);
    expect(notifyRouteChange).toHaveBeenLastCalledWith('/app');
  });
});
