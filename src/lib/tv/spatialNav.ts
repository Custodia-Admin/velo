/**
 * Spatial navigation: which control an arrow press (TV remote, keyboard, the
 * handlebar D-pad in menus) moves the focus to. Pure geometry on boxes, so it
 * is testable without a DOM (P3.3 TV mode).
 *
 * The rule (Android's FocusFinder, simplified): only controls that lie beyond
 * the focused one's edge in that direction count. A control in the focused
 * one's "beam" (overlapping it across the direction) wins: left / right
 * always (stay in the row), up / down unless another control lies wholly
 * nearer. Otherwise the lowest 13 × (gap along)² + (gap across)² wins.
 */

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Half a pixel of slack, so controls that share an edge count as beyond it. */
const EDGE_SLACK = 0.5;
const MAJOR_WEIGHT = 13;

/** Gap from `from`'s edge to `c` along `dir`; null when `c` is not beyond that edge. */
function majorGap(from: Box, c: Box, dir: Direction): number | null {
  switch (dir) {
    case 'down': {
      const g = c.y - (from.y + from.h);
      return g >= -EDGE_SLACK ? Math.max(0, g) : null;
    }
    case 'up': {
      const g = from.y - (c.y + c.h);
      return g >= -EDGE_SLACK ? Math.max(0, g) : null;
    }
    case 'right': {
      const g = c.x - (from.x + from.w);
      return g >= -EDGE_SLACK ? Math.max(0, g) : null;
    }
    case 'left': {
      const g = from.x - (c.x + c.w);
      return g >= -EDGE_SLACK ? Math.max(0, g) : null;
    }
  }
}

/** Distance between the two boxes' spans across `dir` (0 when they overlap). */
function minorGap(from: Box, c: Box, dir: Direction): number {
  const [a0, a1, b0, b1] =
    dir === 'up' || dir === 'down' ? [from.x, from.x + from.w, c.x, c.x + c.w] : [from.y, from.y + from.h, c.y, c.y + c.h];
  if (b1 < a0) return a0 - b1;
  if (b0 > a1) return b0 - a1;
  return 0;
}

/** Score of `c` as the next stop from `from` in `dir`; null when it is not a candidate. */
export function navScore(from: Box, c: Box, dir: Direction): number | null {
  if (c.w <= 0 || c.h <= 0) return null;
  const major = majorGap(from, c, dir);
  if (major === null) return null;
  const minor = minorGap(from, c, dir);
  return MAJOR_WEIGHT * major * major + minor * minor;
}

/** Gap from `from`'s edge to the FAR edge of `c` along `dir`. */
function farGap(from: Box, c: Box, dir: Direction): number {
  switch (dir) {
    case 'down':
      return c.y + c.h - (from.y + from.h);
    case 'up':
      return from.y - c.y;
    case 'right':
      return c.x + c.w - (from.x + from.w);
    case 'left':
      return from.x - c.x;
  }
}

/** The best next stop in `dir`, or null at the edge of the screen. */
export function nextInDirection<T>(from: Box, candidates: ReadonlyArray<{ box: Box; item: T }>, dir: Direction): T | null {
  let best: { box: Box; item: T } | null = null;
  let bestScore = Infinity;
  let beam: { box: Box; item: T } | null = null;
  let beamMajor = Infinity;
  for (const c of candidates) {
    const s = navScore(from, c.box, dir);
    if (s === null) continue;
    if (s < bestScore) {
      bestScore = s;
      best = c;
    }
    if (minorGap(from, c.box, dir) === 0) {
      const major = majorGap(from, c.box, dir)!;
      if (major < beamMajor) {
        beamMajor = major;
        beam = c;
      }
    }
  }
  if (beam && best && beam !== best) {
    const horizontal = dir === 'left' || dir === 'right';
    if (horizontal || beamMajor < farGap(from, best.box, dir)) return beam.item;
  }
  return best?.item ?? null;
}
