/**
 * The couple ghost picker on the setup step (CoupleGhostPicker.tsx): what it
 * offers for a route (ghostOffer, pure), and its radio tiles as a component
 * (called as a function, zustand bound to getState: RideChip.test.ts
 * pattern), writing the pick the world renderer reads.
 */
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', async (orig) => {
  const react = await orig<typeof import('react')>();
  const hooks = { useId: () => 'id', useState: <T,>(v: T) => [v, () => undefined] as const, useEffect: () => undefined };
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

import type { RideRecord } from '@/lib/rideHistory';
import { useCoupleGhostStore } from '@/stores/coupleGhostStore';
import { CoupleGhostPicker, ghostOffer } from './CoupleGhostPicker';

type AnyProps = Record<string, unknown> & { children?: ReactNode };
const ride = (id: string, startedAt: number, durationSec: number) => ({ id, startedAt, durationSec }) as RideRecord;
const options = { last: ride('a', Date.UTC(2026, 10, 3), 2200), best: ride('b', Date.UTC(2026, 9, 28), 2052) };
const route = { name: 'Tiber river park' };

function elements(node: ReactNode): ReactElement<AnyProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<AnyProps>(node)) return [];
  return [node, ...elements(node.props.children)];
}
const textOf = (node: ReactNode): string =>
  node === null || node === undefined || typeof node === 'boolean'
    ? ''
    : typeof node === 'string' || typeof node === 'number'
      ? String(node)
      : Array.isArray(node)
        ? node.map(textOf).join('')
        : isValidElement<AnyProps>(node)
          ? textOf(node.props.children)
          : '';

beforeEach(() => useCoupleGhostStore.setState({ choice: 'last', ghost: null }));

describe('what the setup step offers', () => {
  it('nothing without another rider, before the world is known, or for a route the world renderer does not draw', () => {
    expect(ghostOffer(route, true, null, options, 'last').status).toBe('alone');
    expect(ghostOffer(route, false, 'Anna', options, 'last').status).toBe('not-world');
    expect(ghostOffer(route, true, 'Anna', null, 'last').status).toBe('loading');
  });

  it('a hint before a route is picked, and when the other rider has no ride on it', () => {
    expect(ghostOffer(null, false, 'Anna', null, 'last').status).toBe('no-route');
    const none = ghostOffer(route, true, 'Anna', { last: null, best: null }, 'last');
    expect(none).toMatchObject({ status: 'no-rides', riding: null });
  });

  it('their rides, with the pick; the ghost rides unless "No ghost" is picked', () => {
    expect(ghostOffer(route, true, 'Anna', options, 'best')).toMatchObject({ status: 'ready', picked: 'best', riding: 'Anna' });
    expect(ghostOffer(route, true, 'Anna', options, 'off')).toMatchObject({ picked: 'off', riding: null });
    expect(ghostOffer(route, true, 'Anna', options, 'last').tiles.map((t) => t.choice)).toEqual(['last', 'best', 'off']);
  });
});

describe('the ghost tiles', () => {
  const tree = (choice: 'last' | 'best' | 'off') =>
    elements(CoupleGhostPicker({ offer: ghostOffer(route, true, 'Anna', options, choice) }));
  const radios = (choice: 'last' | 'best' | 'off') => tree(choice).filter((e) => e.props.role === 'radio');

  it('are one radio group, the pick checked and the only one in the tab order', () => {
    const t = tree('last');
    expect(t.filter((e) => e.props.role === 'radiogroup')).toHaveLength(1);
    const r = radios('last');
    expect(r.map((e) => [e.props['data-ghost-choice'], e.props['aria-checked'], e.props.tabIndex])).toEqual([
      ['last', true, 0],
      ['best', false, -1],
      ['off', false, -1],
    ]);
    expect(textOf(r[1].props.children)).toContain('Best ride');
    expect(textOf(r[1].props.children)).toContain('34:12');
  });

  it('a tap picks that ride (what the world renderer loads)', () => {
    const off = radios('last').find((e) => e.props['data-ghost-choice'] === 'off')!;
    (off.props.onClick as () => void)();
    expect(useCoupleGhostStore.getState().choice).toBe('off');
  });

  it('arrow keys move the pick round the group', () => {
    const r = radios('last');
    const key = (el: ReactElement<AnyProps>, k: string) =>
      (el.props.onKeyDown as (e: unknown) => void)({ key: k, preventDefault: () => undefined, currentTarget: { parentElement: null } });
    key(r[0], 'ArrowRight');
    expect(useCoupleGhostStore.getState().choice).toBe('best');
    key(r[0], 'ArrowLeft');
    expect(useCoupleGhostStore.getState().choice).toBe('off');
    key(r[0], 'Enter');
    expect(useCoupleGhostStore.getState().choice).toBe('off');
  });

  it('says why there is nothing to pick', () => {
    const none = elements(CoupleGhostPicker({ offer: ghostOffer(route, true, 'Anna', { last: null, best: null }, 'last') }));
    expect(none.some((e) => e.props.role === 'radio')).toBe(false);
    expect(textOf(none)).toContain('No ride by Anna on Tiber river park yet');
    expect(CoupleGhostPicker({ offer: ghostOffer(route, false, 'Anna', null, 'last') })).toBeNull();
  });
});
