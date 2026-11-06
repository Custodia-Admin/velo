/**
 * segmentTriangleHit / segmentMeetsSphere: the side camera's segment casts
 * (t_ee2165b8). Triangles are wound counter-clockwise seen from where they
 * face, as glTF and Cesium's backface culling have them.
 */
import { describe, expect, it } from 'vitest';

import { NO_HIT, segmentMeetsSphere, segmentTriangleHit } from '@/lib/segmentHit';

/** A 2 x 2 m square wall in the plane x = `x`, facing -x (towards the origin), as two triangles. */
function wallFacingOrigin(x: number) {
  // Seen from -x looking +x, with z up and y to the left: (y, z) corners
  // (1,-1) (-1,-1) (-1,1) (1,1) run counter-clockwise.
  const positions = [x, 1, -1, x, -1, -1, x, -1, 1, x, 1, 1];
  const indices = [0, 1, 2, 0, 2, 3];
  return { positions, indices };
}

const hit = (
  m: { positions: number[]; indices: number[] },
  a: [number, number, number],
  b: [number, number, number],
  cull = true,
  flip = false,
) => segmentTriangleHit(m.positions, 3, m.indices, ...a, ...b, cull, flip);

describe('segmentTriangleHit', () => {
  it('a wall facing the start, half way: hit at 0.5', () => {
    expect(hit(wallFacingOrigin(5), [0, 0, 0], [10, 0, 0])).toBeCloseTo(0.5, 12);
  });

  it('the same wall seen from behind is not a hit (backface culling), unless culling is off', () => {
    expect(hit(wallFacingOrigin(5), [10, 0, 0], [0, 0, 0])).toBe(NO_HIT);
    expect(hit(wallFacingOrigin(5), [10, 0, 0], [0, 0, 0], false)).toBeCloseTo(0.5, 12);
  });

  it('a mirrored frame turns the winding round', () => {
    expect(hit(wallFacingOrigin(5), [0, 0, 0], [10, 0, 0], true, true)).toBe(NO_HIT);
    expect(hit(wallFacingOrigin(5), [10, 0, 0], [0, 0, 0], true, true)).toBeCloseTo(0.5, 12);
  });

  it('only the segment counts: a wall past its end or behind its start is not a hit', () => {
    expect(hit(wallFacingOrigin(5), [0, 0, 0], [4.99, 0, 0])).toBe(NO_HIT);
    expect(hit(wallFacingOrigin(5), [5.01, 0, 0], [10, 0, 0])).toBe(NO_HIT);
    // Ending exactly on it is a hit at 1.
    expect(hit(wallFacingOrigin(5), [0, 0, 0], [5, 0, 0])).toBeCloseTo(1, 12);
  });

  it('a big slanted face the endless line meets past the end, or behind the start: not a hit', () => {
    // The plane x - y = 6 (vertical), corners all round the segments' boxes:
    // the x axis meets it at x = 6.
    const slab = { positions: [-4, -10, -5, 16, 10, -5, 6, 0, 5], indices: [0, 1, 2] };
    expect(hit(slab, [0, 0, 0], [8, 0, 0], false)).toBeCloseTo(0.75, 12);
    expect(hit(slab, [0, 0, 0], [4, 0, 0], false)).toBe(NO_HIT);
    expect(hit(slab, [8, 0, 0], [12, 0, 0], false)).toBe(NO_HIT);
  });

  it('passing beside or over the wall is not a hit; just inside its edge is', () => {
    expect(hit(wallFacingOrigin(5), [0, 1.01, 0], [10, 1.01, 0])).toBe(NO_HIT);
    expect(hit(wallFacingOrigin(5), [0, 0, 1.01], [10, 0, 1.01])).toBe(NO_HIT);
    expect(hit(wallFacingOrigin(5), [0, 0.99, 0.99], [10, 0.99, 0.99])).toBeCloseTo(0.5, 12);
    expect(hit(wallFacingOrigin(5), [0, -0.99, -0.99], [10, -0.99, -0.99])).toBeCloseTo(0.5, 12);
  });

  it('the nearest of several walls wins, whatever order they are listed in', () => {
    const far = wallFacingOrigin(8);
    const near = wallFacingOrigin(3);
    const both = {
      positions: [...far.positions, ...near.positions],
      indices: [...far.indices, ...near.indices.map((i) => i + 4)],
    };
    expect(hit(both, [0, 0, 0], [10, 0, 0])).toBeCloseTo(0.3, 12);
  });

  it('a slanted line through the wall: the fraction along it', () => {
    // From (0, 0, -0.5) to (10, 0, 0.5): crosses x = 5 at z = 0.
    expect(hit(wallFacingOrigin(5), [0, 0, -0.5], [10, 0, 0.5])).toBeCloseTo(0.5, 12);
    // Rising more steeply it passes over the 1 m top.
    expect(hit(wallFacingOrigin(5), [0, 0, 0], [10, 0, 2.2])).toBe(NO_HIT);
  });

  it('a ground facing up: hit going down onto it, not going up from under it', () => {
    // 4 x 4 m square at z = 0, counter-clockwise seen from above.
    const ground = { positions: [-2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0], indices: [0, 1, 2, 0, 2, 3] };
    expect(hit(ground, [0.3, 0.2, 3.2], [0.3, 0.2, 2.0])).toBe(NO_HIT); // 1.2 m of air: clear
    expect(hit(ground, [0.3, 0.2, 1], [0.3, 0.2, -0.2])).toBeCloseTo(1 / 1.2, 12);
    expect(hit(ground, [0.3, 0.2, -1], [0.3, 0.2, 1])).toBe(NO_HIT);
  });

  it('reads vertices with a stride over 3 and ignores a dangling index', () => {
    const w = wallFacingOrigin(5);
    const strided: number[] = [];
    for (let v = 0; v < 4; v++) strided.push(...w.positions.slice(v * 3, v * 3 + 3), 7, -7);
    expect(segmentTriangleHit(strided, 5, [...w.indices, 0], 0, 0, 0, 10, 0, 0)).toBeCloseTo(0.5, 12);
    // Near each corner of the wall, and just past it.
    // (Each triangle's corners listed from every starting corner: same winding.)
    const turned = [1, 2, 0, 2, 3, 0];
    for (const [y, z] of [[0.9, 0.9], [-0.9, 0.9], [-0.9, -0.9], [0.9, -0.9]]) {
      for (const idx of [w.indices, turned]) {
        expect(segmentTriangleHit(strided, 5, idx, 0, y, z, 10, y, z)).toBeCloseTo(0.5, 12);
        expect(segmentTriangleHit(strided, 5, idx, 0, y * 1.2, z * 1.2, 10, y * 1.2, z * 1.2)).toBe(NO_HIT);
      }
    }
  });

  it('a degenerate (zero area) triangle is never a hit', () => {
    const line = { positions: [5, -1, 0, 5, 0, 0, 5, 1, 0], indices: [0, 1, 2] };
    expect(hit(line, [0, 0, 0], [10, 0, 0])).toBe(NO_HIT);
    expect(hit(line, [0, 0, 0], [10, 0, 0], false)).toBe(NO_HIT);
  });

  it('box rejection keeps triangles that straddle the segment box on each axis', () => {
    // A big wall whose corners all lie outside the segment's box but which it crosses.
    const big = { positions: [5, 50, -50, 5, -50, -50, 5, -50, 50, 5, 50, 50], indices: [0, 1, 2, 0, 2, 3] };
    expect(hit(big, [4, 0, 0], [6, 0, 0])).toBeCloseTo(0.5, 12);
    // On each axis in turn, all three corners past one face of the box: dropped.
    expect(hit(wallFacingOrigin(5), [0, 2, 0], [10, 3, 0])).toBe(NO_HIT);
    expect(hit(wallFacingOrigin(5), [0, -3, 0], [10, -2, 0])).toBe(NO_HIT);
    expect(hit(wallFacingOrigin(5), [0, 0, 2], [10, 0, 3])).toBe(NO_HIT);
    expect(hit(wallFacingOrigin(5), [0, 0, -3], [10, 0, -2])).toBe(NO_HIT);
  });
});

describe('segmentMeetsSphere', () => {
  it('passes through, beside, short of and past a sphere', () => {
    expect(segmentMeetsSphere(0, 0, 0, 10, 0, 0, 5, 1, 0, 1.5)).toBe(true);
    expect(segmentMeetsSphere(0, 0, 0, 10, 0, 0, 5, 2, 0, 1.5)).toBe(false);
    // The nearest point is an end, not the endless line's foot.
    expect(segmentMeetsSphere(0, 0, 0, 10, 0, 0, 12, 0, 0, 1.5)).toBe(false);
    expect(segmentMeetsSphere(0, 0, 0, 10, 0, 0, 11, 0, 0, 1.5)).toBe(true);
    expect(segmentMeetsSphere(0, 0, 0, 10, 0, 0, -2, 0, 0, 1.5)).toBe(false);
    expect(segmentMeetsSphere(0, 0, 0, 10, 0, 0, -1, 0, 0, 1.5)).toBe(true);
    // Inside the sphere altogether.
    expect(segmentMeetsSphere(0, 0, 0, 1, 0, 0, 0, 0, 0, 100)).toBe(true);
    // A point segment.
    expect(segmentMeetsSphere(3, 0, 0, 3, 0, 0, 0, 0, 0, 2.9)).toBe(false);
    expect(segmentMeetsSphere(3, 0, 0, 3, 0, 0, 0, 0, 0, 3)).toBe(true);
  });
});
