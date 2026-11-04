import { describe, it, expect } from 'vitest';
import {
  dropSpikes,
  haversineM,
  hairpins,
  removeRetraces,
  retracedStubs,
  type GeoPoint,
} from '@/lib/routeReversals';

/** Local metres (x east, y north) → [lat, lon] around Perugia. */
const LAT0 = 43.1;
const LON0 = 12.4;
const KY = 111_195;
const KX = KY * Math.cos((LAT0 * Math.PI) / 180);
const ll = (x: number, y: number): [number, number] => [LAT0 + y / KY, LON0 + x / KX];
/** A polyline through local-metre corners, densified to `step` m (OSRM-like nodes). */
function path(corners: [number, number][], step = 10): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < corners.length; i++) {
    const [x, y] = corners[i];
    if (i > 0) {
      const [px, py] = corners[i - 1];
      const k = Math.max(1, Math.round(Math.hypot(x - px, y - py) / step));
      for (let j = 1; j < k; j++) out.push(ll(px + ((x - px) * j) / k, py + ((y - py) * j) / k));
    }
    out.push(ll(x, y));
  }
  return out;
}
const lengthOf = (pts: readonly GeoPoint[]) =>
  pts.reduce((a, p, i) => (i ? a + haversineM(pts[i - 1][0], pts[i - 1][1], p[0], p[1]) : 0), 0);

describe('hairpins', () => {
  it('finds an on-the-spot reversal and ignores a right-angle corner', () => {
    expect(hairpins(path([[0, 0], [200, 0], [100, 0]]))).toHaveLength(1);
    expect(hairpins(path([[0, 0], [200, 0], [200, 200]]))).toHaveLength(0);
  });

  it('merges points within 2 m first, so GPS-style jitter is not a U-turn', () => {
    const jitter = [ll(0, 0), ll(50, 0), ll(50.5, 0.3), ll(50.2, -0.2), ll(100, 0)];
    expect(hairpins(jitter)).toHaveLength(0);
  });
});

describe('retracedStubs', () => {
  it('flags a spur ridden out and straight back', () => {
    const spur = path([[0, 0], [500, 0], [500, 150], [500, 0], [1000, 0]]);
    const stubs = retracedStubs(spur);
    expect(stubs).toHaveLength(1);
    expect(stubs[0].tipM).toBeGreaterThan(600);
    expect(stubs[0].tipM).toBeLessThan(700);
  });

  it('flags an out-and-back on a parallel way a few metres off (path out, road back)', () => {
    const parallel = path([[0, 0], [600, 0], [600, 8], [0, 8], [0, 300]]);
    expect(retracedStubs(parallel).length).toBeGreaterThan(0);
  });

  it('leaves a lollipop alone: a loop that comes home on the road it left by', () => {
    const lollipop = path([[0, 0], [400, 0], [400, 400], [800, 400], [800, 0], [400, 0], [0, 0]]);
    expect(retracedStubs(lollipop)).toHaveLength(0);
    expect(hairpins(lollipop)).toHaveLength(0);
  });

  it('leaves a sharp turn at an acute junction alone (a turn, not a turnaround)', () => {
    // 135° turn: the two roads part at 45°.
    expect(retracedStubs(path([[0, 0], [300, 0], [300 - 212, 212]]))).toHaveLength(0);
  });
});

describe('dropSpikes', () => {
  it('collapses an exact node-for-node retrace to its junction', () => {
    const line = [ll(0, 0), ll(100, 0), ll(100, 50), ll(100, 100), ll(100, 50), ll(100, 0), ll(200, 0)];
    const { points, cuts } = dropSpikes(line);
    expect(points).toEqual([ll(0, 0), ll(100, 0), ll(200, 0)]);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].toM - cuts[0].fromM).toBeCloseTo(200, 0);
  });

  it('keeps closely spaced nodes on a straight road', () => {
    const line = [ll(0, 0), ll(0.4, 0), ll(0.8, 0), ll(1.2, 0), ll(100, 0)];
    expect(dropSpikes(line).points).toHaveLength(5);
  });
});

describe('removeRetraces', () => {
  it('cuts a waypoint spur back to the junction and keeps the through road', () => {
    const spur = path([[0, 0], [500, 0], [500, 150], [500, 0], [1000, 0]]);
    const { points, cuts } = removeRetraces(spur);
    expect(hairpins(points)).toHaveLength(0);
    expect(retracedStubs(points)).toHaveLength(0);
    expect(lengthOf(points)).toBeCloseTo(1000, -1);
    expect(cuts.map((c) => c.kind)).toEqual(['stub']);
  });

  it('cuts a spur whose way back runs a few metres beside the way out', () => {
    // Out on a cycle path, back on the road 6 m to the side, then on.
    const line = path([[0, 0], [400, 0], [400, 6], [700, 6], [700, 200], [400, 200]], 5);
    const sidePath = path([[400, 0], [700, 0], [700, 6]], 5);
    const withSpur = [...line.slice(0, 81), ...sidePath.slice(1), ...line.slice(82)];
    const { points } = removeRetraces(withSpur);
    expect(hairpins(points)).toHaveLength(0);
    expect(retracedStubs(points)).toHaveLength(0);
  });

  it('ends the route at the turn when it turns back near the finish', () => {
    const tail = path([[0, 0], [1000, 0], [1000, 6], [880, 6]]);
    const { points, cuts } = removeRetraces(tail);
    expect(cuts.at(-1)?.kind).toBe('tail');
    expect(hairpins(points)).toHaveLength(0);
    expect(lengthOf(points)).toBeGreaterThan(990);
    expect(lengthOf(points)).toBeLessThan(1010);
  });

  it('refuses to cut a long out-and-back: that needs a better waypoint, not a cut', () => {
    const outAndBack = path([[0, 0], [1000, 0], [1000, 3000], [1000, 8], [2000, 8]]);
    expect(() => removeRetraces(outAndBack)).toThrow(/move a waypoint/);
    expect(() => removeRetraces(path([[0, 0], [3000, 0], [3000, 8], [0, 8]]))).toThrow(/move a waypoint/);
  });

  it('leaves a clean route untouched', () => {
    const clean = path([[0, 0], [500, 0], [500, 500], [1000, 500]]);
    const { points, cuts } = removeRetraces(clean);
    expect(cuts).toHaveLength(0);
    expect(lengthOf(points)).toBeCloseTo(lengthOf(clean), 0);
  });
});
