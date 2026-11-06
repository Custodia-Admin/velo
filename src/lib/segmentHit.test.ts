/**
 * segmentTriangleHit / segmentMeetsSphere: the side camera's segment casts
 * (t_ee2165b8). rayTriangleHit: the rider's ground, read straight down
 * (t_5b716f96; checked against Cesium's own pick in groundCast.test.ts).
 * Triangles are wound counter-clockwise seen from where they face, as glTF
 * and Cesium's backface culling have them.
 */
import { describe, expect, it } from 'vitest';

import { NO_HIT, RAY_DET_EPSILON, rayTriangleHit, segmentMeetsSphere, segmentTriangleHit } from '@/lib/segmentHit';

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

/** A 100 x 100 m ground in the plane z = `z`, facing up (+z), as two triangles. */
function groundUp(z: number) {
  const positions = [-50, -50, z, 50, -50, z, 50, 50, z, -50, 50, z];
  return { positions, indices: [0, 1, 2, 0, 2, 3] };
}

const rayHit = (
  m: { positions: number[]; indices: number[] },
  o: [number, number, number],
  d: [number, number, number],
  cull = true,
  detScale = 1,
) => rayTriangleHit(m.positions, 3, m.indices, ...o, ...d, cull, detScale);

/** Moller-Trumbore on every triangle, no quick reject: what rayTriangleHit must agree with. */
function bruteRay(m: { positions: number[]; indices: number[] }, o: number[], d: number[], cull: boolean): number {
  let best = NO_HIT;
  const P = m.positions;
  for (let i = 0; i + 2 < m.indices.length; i += 3) {
    const [a, b, c] = [m.indices[i] * 3, m.indices[i + 1] * 3, m.indices[i + 2] * 3];
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
    if (cull ? det < RAY_DET_EPSILON : Math.abs(det) < RAY_DET_EPSILON) continue;
    const tv = [o[0] - P[a], o[1] - P[a + 1], o[2] - P[a + 2]];
    const u = (tv[0] * h[0] + tv[1] * h[1] + tv[2] * h[2]) / det;
    if (u < 0 || u > 1) continue;
    const q = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
    if (v < 0 || u + v > 1) continue;
    const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    if (t >= 0 && t < best) best = t;
  }
  return best;
}

/** A small deterministic generator (tests must not depend on Math.random). */
function lcg(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

describe('rayTriangleHit: the endless ray down onto the ground', () => {
  it('a ground facing up read from 100 m above: t = 100; from under it, culled unless culling is off', () => {
    expect(rayHit(groundUp(0), [0.3, 0.2, 100], [0, 0, -1])).toBeCloseTo(100, 9);
    expect(rayHit(groundUp(0), [0.3, 0.2, -100], [0, 0, 1])).toBe(NO_HIT);
    expect(rayHit(groundUp(0), [0.3, 0.2, -100], [0, 0, 1], false)).toBeCloseTo(100, 9);
    // t counts lengths of d.
    expect(rayHit(groundUp(0), [0.3, 0.2, 100], [0, 0, -2])).toBeCloseTo(50, 9);
  });

  it('only ahead of the origin: a ground behind it, or beside the ray, is not a hit', () => {
    expect(rayHit(groundUp(0), [0.3, 0.2, 100], [0, 0, 1], false)).toBe(NO_HIT);
    expect(rayHit(groundUp(0), [60, 0.2, 100], [0, 0, -1])).toBe(NO_HIT);
    expect(rayHit(groundUp(0), [0.3, -51, 100], [0, 0, -1])).toBe(NO_HIT);
  });

  it('the nearest of stacked grounds wins in any order; one behind the origin does not count', () => {
    const a = groundUp(0);
    const b = groundUp(5);
    const both = { positions: [...a.positions, ...b.positions], indices: [...a.indices, ...b.indices.map((i) => i + 4)] };
    const flipped = { positions: [...b.positions, ...a.positions], indices: [...a.indices, ...b.indices.map((i) => i + 4)] };
    expect(rayHit(both, [1, 1, 10], [0, 0, -1])).toBeCloseTo(5, 9);
    expect(rayHit(flipped, [1, 1, 10], [0, 0, -1])).toBeCloseTo(5, 9);
    expect(rayHit(both, [1, 1, 3], [0, 0, -1])).toBeCloseTo(3, 9);
  });

  it("from 12 742 km up (getHeight's start), the ground to a micrometre on a slanted ray", () => {
    const len = Math.hypot(0.3, -0.5, -0.81);
    const d: [number, number, number] = [0.3 / len, -0.5 / len, -0.81 / len];
    const far = 12_742_000;
    const at = [7.25, -3.5, 0];
    const o: [number, number, number] = [at[0] - d[0] * far, at[1] - d[1] * far, at[2] - d[2] * far];
    const t = rayHit(groundUp(0), o, d);
    expect(Math.abs(t - far)).toBeLessThan(1e-6);
    expect(Math.abs(o[0] + t * d[0] - at[0])).toBeLessThan(1e-6);
    expect(Math.abs(o[1] + t * d[1] - at[1])).toBeLessThan(1e-6);
  });

  it("Cesium's determinant epsilon applies in world units: detScale scales the frame's determinant", () => {
    // A right triangle with legs a in the plane z = 0, facing up: down a unit ray its determinant is a^2.
    const tiny = (a: number) => ({ positions: [0, 0, 0, a, 0, 0, 0, a, 0], indices: [0, 1, 2] });
    const small = tiny(0.0009); // 8.1e-7
    const fine = tiny(0.0011); // 1.21e-6
    const o = (a: number): [number, number, number] => [a / 4, a / 4, 10];
    expect(rayHit(small, o(0.0009), [0, 0, -1])).toBe(NO_HIT);
    expect(rayHit(small, o(0.0009), [0, 0, -1], true, 2)).toBeCloseTo(10, 9);
    expect(rayHit(small, o(0.0009), [0, 0, -1], false)).toBe(NO_HIT);
    expect(rayHit(small, o(0.0009), [0, 0, -1], false, -2)).toBeCloseTo(10, 9);
    expect(rayHit(fine, o(0.0011), [0, 0, -1])).toBeCloseTo(10, 9);
    expect(rayHit(fine, o(0.0011), [0, 0, -1], true, 0.5)).toBe(NO_HIT);
    expect(rayHit(fine, o(0.0011), [0, 0, -1], false, -0.5)).toBe(NO_HIT);
    expect(RAY_DET_EPSILON).toBe(1e-6);
  });

  it('a mirroring frame (negative detScale) turns the facing round', () => {
    expect(rayHit(groundUp(0), [0.3, 0.2, 100], [0, 0, -1], true, -1)).toBe(NO_HIT);
    expect(rayHit(groundUp(0), [0.3, 0.2, -100], [0, 0, 1], true, -1)).toBeCloseTo(100, 9);
  });

  it('through an edge or a corner is a hit; just outside is not', () => {
    // The diagonal x = y is the shared edge; (50, -50) a corner of the first triangle only.
    expect(rayHit(groundUp(0), [10, 10, 5], [0, 0, -1])).toBeCloseTo(5, 9);
    expect(rayHit(groundUp(0), [50, -50, 5], [0, 0, -1])).toBeCloseTo(5, 9);
    expect(rayHit(groundUp(0), [50.001, -50, 5], [0, 0, -1])).toBe(NO_HIT);
    const one = { positions: groundUp(0).positions, indices: [0, 1, 2] };
    expect(rayHit(one, [10, 10.001, 5], [0, 0, -1])).toBe(NO_HIT);
    expect(rayHit(one, [10.001, 10, 5], [0, 0, -1])).toBeCloseTo(5, 9);
  });

  it('the quick reject never drops a triangle the ray crosses (random triangles and rays vs every triangle tested)', () => {
    const rnd = lcg(5_165);
    let hits = 0;
    for (let k = 0; k < 400; k++) {
      const positions: number[] = [];
      const indices: number[] = [];
      for (let i = 0; i < 12; i++) {
        for (let j = 0; j < 3; j++) positions.push((rnd() - 0.5) * 8, (rnd() - 0.5) * 8, (rnd() - 0.5) * 8);
        indices.push(i * 3, i * 3 + 1, i * 3 + 2);
      }
      // From somewhere around the triangles, aimed through the middle of them.
      const o = [(rnd() - 0.5) * 20, (rnd() - 0.5) * 20, (rnd() - 0.5) * 20];
      const aim = [(rnd() - 0.5) * 3, (rnd() - 0.5) * 3, (rnd() - 0.5) * 3];
      const d = [aim[0] - o[0], aim[1] - o[1], aim[2] - o[2]];
      const m = { positions, indices };
      for (const cull of [true, false]) {
        const want = bruteRay(m, o, d, cull);
        const got = rayTriangleHit(positions, 3, indices, o[0], o[1], o[2], d[0], d[1], d[2], cull);
        if (want === NO_HIT) expect(got).toBe(NO_HIT);
        else {
          hits++;
          expect(Math.abs(got - want)).toBeLessThan(1e-9 * Math.max(1, want));
        }
      }
    }
    expect(hits).toBeGreaterThan(300);
  });

  it('keeps a triangle with a corner on a plane through the ray, and one around it with every corner off both planes', () => {
    // Vertical ray down x = y = 0 (planes y = 0 and x = 0 through it).
    const onPlane = { positions: [0, -1, 0, 2, 1, 0, -2, 1, 0], indices: [0, 1, 2] };
    expect(rayHit(onPlane, [0, 0, 5], [0, 0, -1])).toBeCloseTo(5, 9);
    const around = { positions: [-1, -1, 0, 1, -1, 0, 0, 1, 0], indices: [0, 1, 2] };
    expect(rayHit(around, [0, 0, 5], [0, 0, -1])).toBeCloseTo(5, 9);
    // A corner on the ray itself, the other two off to one side of both planes.
    const corner = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };
    expect(rayHit(corner, [0, 0, 5], [0, 0, -1])).toBeCloseTo(5, 9);
    const corner2 = { positions: [0, 0, 0, -1, 0, 0, 0, -1, 0], indices: [0, 1, 2] };
    expect(rayHit(corner2, [0, 0, 5], [0, 0, -1])).toBeCloseTo(5, 9);
    // Every corner beyond one plane: out (each of the four sides).
    for (const [x, y] of [
      [3, 0],
      [-3, 0],
      [0, 3],
      [0, -3],
    ]) {
      expect(rayHit(around, [x, y, 5], [0, 0, -1])).toBe(NO_HIT);
    }
  });

  it('reads vertices with a stride over 3 and ignores a dangling index', () => {
    const g = groundUp(2);
    const strided: number[] = [];
    for (let i = 0; i < 4; i++) strided.push(g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2], 99, 99);
    expect(rayTriangleHit(strided, 5, [...g.indices, 0], 1, 1, 10, 0, 0, -1)).toBeCloseTo(8, 9);
  });

  it('a zero or non-finite direction is never a hit', () => {
    expect(rayHit(groundUp(0), [0, 0, 10], [0, 0, 0])).toBe(NO_HIT);
    expect(rayHit(groundUp(0), [0, 0, 10], [0, 0, Number.NaN])).toBe(NO_HIT);
    expect(rayHit(groundUp(0), [0, 0, 10], [0, Number.POSITIVE_INFINITY, -1])).toBe(NO_HIT);
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
