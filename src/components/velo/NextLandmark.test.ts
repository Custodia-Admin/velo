/**
 * The next-landmark line never cuts a word off at its edge: the place name
 * shortens, then goes, then the flag goes, then the line shows nothing; the
 * distance is whole whenever it shows (review of PR #48 @dfd7071, N3; before
 * that PR #36 @61defbb, F2: "Bastia Umbra in 6…" in the 640 px window).
 *
 * Components are called as plain functions; the elements they return are
 * read, not rendered. These tests pin the structure that makes the fit work
 * in CSS (NextLandmark's header explains it); the e2e show-mode spec
 * (`landmarkLineAtWidth`) measures the real layout in Chrome at every width.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isValidElement, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { Flag, Pause } from 'lucide-react';
import { NextLandmark } from './NextLandmark';
import { landmarkLine, type NextLandmarkParts } from './rideHudText';
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
const has = (e: El, c: string) => cls(e).split(/\s+/).includes(c);
const kids = (e: El) => (Array.isArray(e.props.children) ? e.props.children : [e.props.children]).filter(isValidElement) as El[];
const byTestId = (tree: unknown, id: string) => walk(tree).filter(({ el }) => el.props['data-testid'] === id);
/** The one element with `id` in a walked tree (walk once: NextLandmark is called afresh on every walk). */
const one = (all: ReturnType<typeof walk>, id: string) => {
  const found = all.filter(({ el }) => el.props['data-testid'] === id);
  expect(found, id).toHaveLength(1);
  return found[0];
};

/** Classes that clip or hide what overflows. */
const CLIPS = /\b(truncate|text-ellipsis|overflow-hidden|overflow-x-hidden|overflow-clip|overflow-x-clip|line-clamp-\d)\b/;
/** A fit row: one line high, wrapping, so it hides whole lines only (never part of one). */
const FIT = ['flex', 'flex-wrap', 'flex-row-reverse', 'h-lh', 'overflow-hidden', 'justify-end', 'items-center'];
const isFitRow = (e: El) => FIT.every((c) => has(e, c));

/** Flex `order` from the classes (CSS sorts by it, then by DOM order; the line breaks in that order). */
const order = (e: El) => (has(e, 'order-first') ? -9999 : has(e, 'order-last') ? 9999 : 0);
const layoutOrder = (row: El) =>
  kids(row)
    .map((k, i) => [k, i] as const)
    .sort((a, b) => order(a[0]) - order(b[0]) || a[1] - b[1])
    .map(([k]) => k);
/** The zero-width, full-height first item of a fit row. */
const isSentinel = (e: El) => e.type === 'span' && has(e, 'h-lh') && e.props.children === undefined && e.props['aria-hidden'] === 'true';

const bastia: NextLandmarkParts = { name: 'Bastia Umbra', distance: 'in 6.5 km', inClimb: false };
const climb: NextLandmarkParts = { name: 'Climb 1', distance: '300 m to the top', inClimb: true };

/** Every string in the tree, in DOM order. */
const text = (tree: unknown) =>
  walk(tree)
    .flatMap(({ el }) => (typeof el.props.children === 'string' ? [el.props.children] : []))
    .join('');

function expectLadder(tree: unknown, next: NextLandmarkParts) {
  const all = walk(tree);
  const fit = one(all, 'landmark-fit').el;
  const group = one(all, 'landmark-group').el;
  const flag = one(all, 'landmark-flag').el;
  const name = one(all, 'landmark-name');
  const joiner = one(all, 'landmark-joiner');
  const dist = one(all, 'landmark-distance');

  // Both rows are fit rows; the outer one may shrink to nothing inside the line.
  expect(isFitRow(fit), cls(fit)).toBe(true);
  expect(isFitRow(group), cls(group)).toBe(true);
  expect(has(fit, 'min-w-0')).toBe(true);

  // Outer row, in the order the line is filled: sentinel, then the name +
  // distance group, then the flag (so the flag goes before the distance does).
  const outer = layoutOrder(fit);
  expect(outer).toHaveLength(3);
  expect(isSentinel(outer[0])).toBe(true);
  expect(outer[1]).toBe(group);
  expect(outer[2].type).toBe(Flag);
  expect(outer[2]).toBe(flag);
  expect(flag.props['aria-hidden']).toBe('true');
  expect(has(flag, 'shrink-0')).toBe(true);
  // The group keeps the line when the distance alone fits, and takes the rest of it.
  expect(has(group, 'min-w-min')).toBe(true);
  expect(has(group, 'flex-1')).toBe(true);

  // Group, in the order it is filled: sentinel, the distance, then the name.
  const inner = layoutOrder(group);
  expect(inner).toHaveLength(3);
  expect(isSentinel(inner[0])).toBe(true);
  expect(inner[1]).toBe(dist.el);
  const nameBox = inner[2];
  expect(name.ancestors.at(-1)).toBe(nameBox);
  expect(joiner.ancestors.at(-1)).toBe(nameBox);
  // The name keeps at least two characters ("Ba…") or goes, and grows no wider than its text.
  for (const c of ['flex', 'min-w-10', 'max-w-max', 'flex-1']) expect(has(nameBox, c), `${c} in ${cls(nameBox)}`).toBe(true);
  // It shortens with an ellipsis; break-all keeps its narrowest out of the group's.
  expect(has(name.el, 'line-clamp-1')).toBe(true);
  expect(has(name.el, 'break-all')).toBe(true);
  expect(name.el.props.children).toBe(next.name);
  // The separator leaves with the name ("300 m to the top" on its own).
  expect(joiner.el.props.children).toBe(next.inClimb ? ' · ' : ' ');
  expect(has(joiner.el, 'whitespace-pre')).toBe(true);
  expect(has(joiner.el, 'shrink-0')).toBe(true);

  // The distance: whole, one line, never inside the name; only fit rows around it clip.
  expect(dist.el.props.children).toBe(next.distance);
  expect(has(dist.el, 'shrink-0')).toBe(true);
  expect(has(dist.el, 'whitespace-pre')).toBe(true);
  expect(cls(dist.el)).not.toMatch(CLIPS);
  for (const a of dist.ancestors) if (CLIPS.test(cls(a))) expect(isFitRow(a), `${String(a.type)} ${cls(a)}`).toBe(true);
  expect(dist.ancestors.includes(nameBox)).toBe(false);
  // Same type as the name, as the mockups' one-span line: no figure styling. tabular-nums made
  // "in 6.5 km" 8 px wider in headed Chrome (less room for the name), and `.num` is what the
  // floating-window probes read as the bar's figures.
  expect(cls(dist.el)).not.toMatch(/\b(num|tabular-nums|font-\S+|text-\S+)\b/);

  // Reads as one sentence, in DOM order (screen readers get all of it, even what is out of sight).
  expect(text(fit)).toBe(landmarkLine(next));
}

describe('NextLandmark', () => {
  it('reads as one line ("Bastia Umbra in 6.5 km", "Climb 1 · 300 m to the top")', () => {
    const tree = NextLandmark({ next: bastia, testId: 'journey-next', className: 'flex' });
    expect(tree.props['data-testid']).toBe('journey-next');
    expect(text(tree)).toBe('Bastia Umbra in 6.5 km');
    expect(text(NextLandmark({ next: climb }))).toBe('Climb 1 · 300 m to the top');
  });

  it('gives up the name, then the flag, then everything, and never cuts the distance', () => {
    expectLadder(NextLandmark({ next: bastia }), bastia);
    expectLadder(NextLandmark({ next: climb }), climb);
  });

  it('the line itself clips nothing: the fit rows inside decide what shows', () => {
    const tree = NextLandmark({ next: bastia, className: 'flex min-w-0 flex-1' });
    expect(cls(tree)).not.toMatch(CLIPS);
    expect(kids(tree)).toEqual([one(walk(tree), 'landmark-fit').el]);
  });
});

describe('the show strip (ShowRideStrip)', () => {
  const numbers: ShowRideNumbers = {
    time: '1:18:05',
    distanceValue: '42.2',
    distanceUnit: 'km',
    distanceAria: 'Distance: 42.2 km',
    gradeText: '-12.5',
    next: { name: 'Chiesa di Santa Maria', distance: 'in 3.9 km', inClimb: false },
    progress: 0.4,
    action: { label: 'Pause ride', icon: Pause, run: () => undefined },
  };

  it('shortens the place name only, never the distance', () => {
    const tree = ShowRideStripView({ numbers, dimmed: false });
    expectLadder(tree, numbers.next!);
    const line = walk(tree).find(({ el }) => el.type === NextLandmark)!.el;
    expect(line.props.testId).toBe('show-next');
  });

  it('no landmark ahead: no line', () => {
    expect(byTestId(ShowRideStripView({ numbers: { ...numbers, next: null }, dimmed: false }), 'landmark-distance')).toHaveLength(0);
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
