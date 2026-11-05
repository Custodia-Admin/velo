/**
 * The next-landmark line shortens the place name and keeps the distance whole
 * (review of PR #36 @61defbb, F2: the 640 px floating window read "Bastia
 * Umbra in 6…", the show strip "Chiesa di Santa Maria in 3.9 …"). Components
 * are called as plain functions; the elements they return are read, not
 * rendered (the e2e show-mode spec measures the real layout).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isValidElement, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { Pause } from 'lucide-react';
import { NextLandmark } from './NextLandmark';
import { ShowRideStripView, type ShowRideNumbers } from './ShowRideStrip';

type El = ReactElement<Record<string, unknown>>;

/** Every element under `node`, with its element ancestors; NextLandmark expanded. */
function walk(node: unknown, ancestors: El[] = [], out: { el: El; ancestors: El[] }[] = []) {
  if (Array.isArray(node)) for (const n of node) walk(n, ancestors, out);
  else if (isValidElement(node)) {
    const el = node as El;
    out.push({ el, ancestors });
    if (el.type === NextLandmark) walk(NextLandmark(el.props as Parameters<typeof NextLandmark>[0]), [...ancestors, el], out);
    for (const v of Object.values(el.props)) walk(v, [...ancestors, el], out);
  }
  return out;
}

const cls = (e: El) => String(e.props.className ?? '');
/** Classes that clip text with an ellipsis (or hide what overflows). */
const CLIPS = /\b(truncate|text-ellipsis|overflow-hidden|overflow-x-hidden|line-clamp-\d)\b/;

/** The name and distance parts of every landmark line in `tree`. */
function landmarkParts(tree: unknown) {
  const all = walk(tree);
  const names = all.filter(({ el }) => el.props['data-testid'] === 'landmark-name');
  const distances = all.filter(({ el }) => el.props['data-testid'] === 'landmark-distance');
  return { names, distances };
}

function expectDistanceWhole(tree: unknown, next: { name: string; distance: string }, lines = 1) {
  const { names, distances } = landmarkParts(tree);
  expect(names).toHaveLength(lines);
  expect(distances).toHaveLength(lines);
  for (const { el } of names) {
    expect(el.props.children).toBe(next.name);
    expect(cls(el)).toMatch(/\btruncate\b/);
  }
  for (const { el, ancestors } of distances) {
    // The distance sits outside the truncating element: neither it nor any
    // element around it clips; it never shrinks or wraps (one line, whole).
    expect(el.props.children).toBe(` ${next.distance}`);
    for (const a of [el, ...ancestors]) expect(cls(a), `${String(a.type)} ${cls(a)}`).not.toMatch(CLIPS);
    expect(cls(el)).toMatch(/\bshrink-0\b/);
    expect(cls(el)).toMatch(/\bwhitespace-(pre|nowrap)\b/);
    expect(ancestors.some((a) => a.props['data-testid'] === 'landmark-name')).toBe(false);
  }
}

const bastia = { name: 'Bastia Umbra', distance: 'in 6.5 km' };

describe('NextLandmark', () => {
  it('reads as one line ("Bastia Umbra in 6.5 km") with the name and distance in separate parts', () => {
    const tree = NextLandmark({ next: bastia, testId: 'journey-next', className: 'flex' });
    expect(tree.props['data-testid']).toBe('journey-next');
    const text = walk(tree)
      .flatMap(({ el }) => (typeof el.props.children === 'string' ? [el.props.children] : []))
      .join('');
    expect(text).toBe('Bastia Umbra in 6.5 km');
    expectDistanceWhole(tree, bastia);
  });

  it('the name can shrink inside its line (min-w-0 down the flex chain)', () => {
    const { names } = landmarkParts(NextLandmark({ next: bastia }));
    const parent = names[0].ancestors.at(-1)!;
    expect(cls(parent)).toMatch(/\bflex\b/);
    expect(cls(parent)).toMatch(/\bmin-w-0\b/);
  });
});

describe('the show strip (ShowRideStrip)', () => {
  const numbers: ShowRideNumbers = {
    time: '1:18:05',
    distanceValue: '42.2',
    distanceUnit: 'km',
    distanceAria: 'Distance: 42.2 km',
    gradeText: '-12.5',
    next: { name: 'Chiesa di Santa Maria', distance: 'in 3.9 km' },
    progress: 0.4,
    action: { label: 'Pause ride', icon: Pause, run: () => undefined },
  };

  it('shortens the place name only, never the distance', () => {
    const tree = ShowRideStripView({ numbers, dimmed: false });
    expectDistanceWhole(tree, numbers.next!);
    const line = walk(tree).find(({ el }) => el.type === NextLandmark)!.el;
    expect(line.props.testId).toBe('show-next');
  });

  it('no landmark ahead: no line', () => {
    expect(landmarkParts(ShowRideStripView({ numbers: { ...numbers, next: null }, dimmed: false })).distances).toHaveLength(0);
  });
});

describe('every next-landmark line goes through NextLandmark', () => {
  const dir = join(process.cwd(), 'src/components/velo');
  const users = readdirSync(dir)
    .filter((f) => f.endsWith('.tsx'))
    .filter((f) => /\buseNextLandmark\(|\bn(umbers)?\.next\b|\bnext=\{/.test(readFileSync(join(dir, f), 'utf8')));

  it('JourneyBar, ShowRideStrip and RideRoutePanel render it with <NextLandmark', () => {
    expect(users).toEqual(expect.arrayContaining(['JourneyBar.tsx', 'ShowRideStrip.tsx', 'RideRoutePanel.tsx']));
    for (const f of users) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).toMatch(/<NextLandmark\b/);
      // The old one-span line: the whole text in a truncating span.
      expect(src, f).not.toMatch(/className="truncate">\{(n\.)?(next|text)\}/);
    }
  });
});
