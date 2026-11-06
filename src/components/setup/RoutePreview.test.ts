import { describe, it, expect, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { RoutePreview, estimateRideTime } from '@/components/setup/RoutePreview';
import { MapPlate } from '@/components/velo/MapPlate';
import type { Route } from '@/types';

type AnyProps = Record<string, unknown> & { children?: ReactNode };

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

function makeRoute(points: { lat: number; lon: number }[]): Route {
  return {
    id: 'r',
    name: 'r',
    points: points.map((p, i) => ({
      lat: p.lat,
      lon: p.lon,
      ele: 0,
      distance: i * 100,
    })),
    totalDistance: (points.length - 1) * 100,
    ascent: 0,
    descent: 0,
    minElevation: 0,
    maxElevation: 0,
    loadedAt: 0,
  };
}

describe('estimateRideTime', () => {
  it('returns dash for non-positive distance', () => {
    expect(estimateRideTime(0)).toBe('—');
    expect(estimateRideTime(-100)).toBe('—');
  });

  it('formats minutes when under an hour at 25 km/h', () => {
    // 5 km → 12 min
    expect(estimateRideTime(5000)).toBe('12 min');
  });

  it('formats hours and minutes when above an hour', () => {
    // 50 km → 2 h
    expect(estimateRideTime(50000)).toBe('2 h');
    // 45 km @ 25 km/h ≈ 108 min → "1 h 48 min"
    expect(estimateRideTime(45000)).toBe('1 h 48 min');
  });
});

/**
 * The preview as built (RoutePreview has no hooks, so it runs as a plain
 * function): the real polyline on Home's map plate, ONE figures line that
 * agrees with the route, and the two actions wired to their handlers.
 */
describe('RoutePreview', () => {
  const route: Route = {
    ...makeRoute([{ lat: 43.1, lon: 12.4 }, { lat: 43.2, lon: 12.5 }, { lat: 43.1, lon: 12.6 }]),
    name: 'Perugia · 36 km out-and-back',
    totalDistance: 36_300,
    ascent: 412.4,
  };

  function view(over: Partial<Parameters<typeof RoutePreview>[0]> = {}) {
    const onCommit = vi.fn();
    const onRegenerate = vi.fn();
    const tree = elements(RoutePreview({ route, onCommit, onRegenerate, ...over }));
    const button = (label: string) => {
      const el = tree.find((e) => typeof e.props.onClick === 'function' && textOf(e.props.children).includes(label));
      if (!el) throw new Error(`no ${label} button`);
      return el.props as AnyProps & { onClick: () => void; disabled?: boolean; variant?: string };
    };
    return { tree, onCommit, onRegenerate, button, text: tree.map((e) => textOf(e)).join('|') };
  }

  it('draws the route on the map plate and names it', () => {
    const v = view();
    const plate = v.tree.find((e) => e.type === MapPlate);
    expect(plate?.props.route).toBe(route);
    expect(v.text).toContain('Perugia · 36 km out-and-back');
  });

  it('one figures line: real distance, climbing, easy-pace time', () => {
    expect(view().text).toContain('36.3 km · 412 m climbing · about 1 h 27 min');
    // A flat route (or no elevation without a token) drops the climbing, never shows "0 m".
    const flat = elements(RoutePreview({ route: { ...route, ascent: 0 }, onCommit: () => {}, onRegenerate: () => {} }))
      .map((e) => textOf(e)).join('|');
    expect(flat).toContain('36.3 km · about 1 h 27 min');
    expect(flat).not.toContain('0 m climbing');
    // No length to time (a 0 m route): no "about —" either.
    const empty = elements(RoutePreview({ route: { ...route, totalDistance: 0 }, onCommit: () => {}, onRegenerate: () => {} }))
      .map((e) => textOf(e)).join('|');
    expect(empty).toContain('0.0 km · 412 m climbing');
    expect(empty).not.toContain('about');
    expect(empty).not.toContain('—');
  });

  it('Use this route commits (the one filled action); Try again regenerates and waits while it runs', () => {
    const v = view();
    expect(v.button('Use this route').variant).toBe('primary');
    v.button('Use this route').onClick();
    expect(v.onCommit).toHaveBeenCalledTimes(1);
    expect(v.button('Try again').variant).toBe('outline');
    v.button('Try again').onClick();
    expect(v.onRegenerate).toHaveBeenCalledTimes(1);
    expect(view({ regenerating: true }).button('Try again').disabled).toBe(true);
  });
});
