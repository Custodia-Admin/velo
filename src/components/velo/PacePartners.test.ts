/**
 * The Pace partners picker as a component (PacePartners.tsx), clicked through
 * its own onClick handlers against the real ride store. zustand's React
 * binding reads getState(), so the component runs as a plain function in the
 * node test env (RideChip.test.ts pattern).
 *
 * What this pins (review of PR #37 @6f72910, D2): a partner picked on Home is
 * a real PaceBot (with live state) in the store; it survives the wizard's
 * route pick, the auto-pick and the ride start; the tiles show what the store
 * holds; the cap disables the rest; "Remove partners" clears them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isValidElement, type ReactElement, type ReactNode } from 'react';

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

import { PacePartners } from './PacePartners';
import { PARTNERS, MAX_PARTNERS } from './pacePartners';
import { useRideStore } from '@/stores/rideStore';
import type { Route } from '@/types';

type AnyProps = Record<string, unknown> & { children?: ReactNode };

const lakeRoute = (id: string): Route => ({
  id,
  name: id,
  points: [
    { lat: 43.1, lon: 12.0, ele: 260, distance: 0 },
    { lat: 43.19, lon: 12.0, ele: 260, distance: 10_000 },
  ],
  totalDistance: 10_000,
  ascent: 0,
  descent: 0,
  minElevation: 260,
  maxElevation: 260,
  loadedAt: 0,
});

const initialRide = useRideStore.getState();

/** Every element in a rendered tree (function components are not expanded). */
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
  const tree = elements(PacePartners({}));
  const tile = (id: string) => {
    const el = tree.find((e) => e.props['data-partner'] === id);
    if (!el) throw new Error(`no tile ${id}`);
    return { ...el.props } as AnyProps & { onClick: () => void; disabled: boolean; 'aria-pressed': boolean };
  };
  const status = tree.find((e) => 'data-partners-status' in e.props);
  const remove = tree.find((e) => textOf(e.props.children) === 'Remove partners' && typeof e.props.onClick === 'function');
  return {
    tile,
    status: textOf(status?.props.children),
    remove: remove ? ({ ...remove.props } as AnyProps & { onClick: () => void }) : null,
    group: tree.find((e) => e.props['aria-label'] === 'Pace partner selection'),
  };
}

beforeEach(() => {
  useRideStore.setState(initialRide, true);
});

describe('PacePartners', () => {
  it('a partner picked, then a route, then the auto-pick and Start: a real bot rides', () => {
    const steady = PARTNERS[0];
    expect(render().tile(steady.id)['aria-pressed']).toBe(false);
    expect(render().status).toBe('None picked, up to 3');

    render().tile(steady.id).onClick();
    const picked = useRideStore.getState().paceBots;
    expect(picked).toHaveLength(1);
    expect(picked[0]).toMatchObject({ id: steady.id, name: steady.name, personality: steady.personality });
    expect(picked[0].state.distance).toBe(0);

    // Re-rendered from the store.
    const view = render();
    expect(view.tile(steady.id)['aria-pressed']).toBe(true);
    expect(view.status).toBe(`1 of ${MAX_PARTNERS} riding with you`);

    // The wizard's route tile (setRoute) and its auto-pick (another setRoute).
    useRideStore.getState().setRoute(lakeRoute('trasimeno'));
    useRideStore.getState().setRoute(lakeRoute('auto-pick'));
    expect(useRideStore.getState().paceBots.map((b) => b.id)).toEqual([steady.id]);
    expect(render().tile(steady.id)['aria-pressed']).toBe(true);

    // useRideAutoStart re-sets the route before start() when the ride is idle.
    useRideStore.getState().setRoute(useRideStore.getState().route);
    useRideStore.getState().start();
    useRideStore.getState().tickBots(1);
    useRideStore.getState().tickBots(1);
    const bot = useRideStore.getState().paceBots[0];
    expect(bot.id).toBe(steady.id);
    expect(bot.state.distance).toBeGreaterThan(5);
    expect(bot.state.lat).toBeGreaterThan(43);
  });

  it('a partner picked after the route stands on that route\'s start line', () => {
    useRideStore.getState().setRoute(lakeRoute('trasimeno'));
    render().tile(PARTNERS[1].id).onClick();
    const [bot] = useRideStore.getState().paceBots;
    expect(bot.id).toBe(PARTNERS[1].id);
    expect(bot.state).toMatchObject({ distance: 0, lat: 43.1, lon: 12.0, ele: 260 });
  });

  it(`disables the other tiles at ${MAX_PARTNERS} and says why; removing one frees them`, () => {
    for (const p of PARTNERS.slice(0, MAX_PARTNERS)) render().tile(p.id).onClick();
    const full = render();
    const last = PARTNERS[MAX_PARTNERS];
    expect(full.tile(last.id).disabled).toBe(true);
    expect(full.tile(PARTNERS[0].id).disabled).toBe(false);
    expect(full.status).toMatch(/Remove one to pick another/);

    full.tile(PARTNERS[0].id).onClick();
    expect(render().tile(last.id).disabled).toBe(false);
    expect(useRideStore.getState().paceBots).toHaveLength(MAX_PARTNERS - 1);
  });

  it('"Remove partners" shows only with partners picked, and clears them', () => {
    expect(render().remove).toBeNull();
    render().tile(PARTNERS[1].id).onClick();
    render().tile(PARTNERS[2].id).onClick();
    const view = render();
    expect(view.remove).not.toBeNull();
    view.remove!.onClick();
    expect(useRideStore.getState().paceBots).toEqual([]);
    expect(render().status).toBe('None picked, up to 3');
  });

  it('shows every partner as a toggle in one labelled group', () => {
    const view = render();
    expect(view.group).toBeDefined();
    for (const p of PARTNERS) {
      const t = view.tile(p.id);
      expect(t.type).toBe('button');
      expect(textOf(t.children as ReactNode)).toContain(p.name);
    }
  });

  it("is what Home's Build your own ride shows as step 3", () => {
    const src = readFileSync(join(resolve(__dirname, '../../..'), 'src/components/setup/RideSetupWizard.tsx'), 'utf8');
    // Step 3 "Who rides with you": the other rider's ghost, then the pace partners.
    const step = src.slice(src.indexOf('function RideWithStep('));
    expect(step.slice(0, step.indexOf('\n}\n'))).toMatch(/<CoupleGhostPicker offer=\{offer\} \/>[\s\S]*<PacePartners \/>/);
    const step3 = src.slice(src.indexOf('data-wizard-step={3}'));
    expect(step3).toMatch(/openStep === 3 && \(\s*<div[^>]*>\s*<RideWithStep offer=\{ghostOffer\} \/>/);
    expect(src).not.toMatch(/PaceBotsPanel|globalThis/);
  });
});
