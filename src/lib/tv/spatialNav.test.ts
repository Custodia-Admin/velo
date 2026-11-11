import { describe, expect, it } from 'vitest';
import { navScore, nextInDirection, type Box } from './spatialNav';

const b = (x: number, y: number, w = 70, h = 70): Box => ({ x, y, w, h });

/** The TV ride band (1920×1080, details open), measured from the build. */
const BAND = {
  exit: b(238, 919),
  pause: b(1257, 919, 165),
  finish: b(1429, 919, 164),
  toggle: b(1600, 919),
  chip: b(224, 814, 340, 68),
  settings: b(643, 729),
  ghost: b(727, 645),
  camera: b(643, 645),
  show: b(559, 645),
  voice: b(559, 729),
};
const all = Object.entries(BAND).map(([item, box]) => ({ item, box }));
const from = (k: keyof typeof BAND, dir: Parameters<typeof nextInDirection>[2]) =>
  nextInDirection(BAND[k], all.filter((c) => c.item !== k), dir);

describe('spatial navigation', () => {
  it('walks a row of buttons left and right, and stops at its ends', () => {
    expect(from('pause', 'right')).toBe('finish');
    expect(from('finish', 'right')).toBe('toggle');
    expect(from('toggle', 'right')).toBeNull();
    expect(from('finish', 'left')).toBe('pause');
  });

  it('nothing below the band: down stops there', () => {
    expect(from('pause', 'down')).toBeNull();
    expect(from('toggle', 'down')).toBeNull();
  });

  it('up from the band reaches the details above it, the nearest first', () => {
    // From the details toggle (far right), the nearest control up and across.
    expect(from('toggle', 'up')).toBe('settings');
    // From Exit (far left), the chip straight above it.
    expect(from('exit', 'up')).toBe('chip');
    expect(from('chip', 'up')).toBe('voice');
  });

  it('left / right stay in the row: a control in the beam beats a nearer one off it', () => {
    const origin = b(0, 0, 100, 40);
    const inRow = b(600, 0, 100, 40); // 500 right, same row
    const below = b(150, 60, 100, 40); // 50 right, a row down
    const cands = [{ box: below, item: 'below' }, { box: inRow, item: 'row' }];
    expect(nextInDirection(origin, cands, 'right')).toBe('row');
  });

  it('up / down: the beam wins unless another control lies wholly nearer', () => {
    const origin = b(0, 0, 100, 40);
    const ahead = b(0, 300, 100, 40); // 260 down, in the beam
    const near = b(400, 60, 100, 40); // wholly within 60 px, off to the side
    const far = b(400, 400, 100, 40); // farther than the beam one
    expect(nextInDirection(origin, [{ box: near, item: 'near' }, { box: ahead, item: 'ahead' }], 'down')).toBe('near');
    expect(nextInDirection(origin, [{ box: far, item: 'far' }, { box: ahead, item: 'ahead' }], 'down')).toBe('ahead');
  });

  it('only counts controls beyond the edge in that direction', () => {
    const origin = b(100, 100);
    expect(navScore(origin, b(100, 140), 'down')).toBeNull(); // overlaps, not beyond
    expect(navScore(origin, b(100, 170), 'down')).toBe(0); // shares the edge
    expect(navScore(origin, b(100, 0), 'down')).toBeNull(); // above
    expect(navScore(origin, b(0, 0, 0, 0), 'up')).toBeNull(); // empty box
  });
});
