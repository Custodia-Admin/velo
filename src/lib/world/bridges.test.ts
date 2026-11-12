/**
 * tools/worldbake/bridges.mjs: deck heights from the abutments, headroom
 * pins that survive the per-vertex output, abutments lifted onto approach
 * ramps at the class grade, and the bake's own headroom check. Which decks
 * a route rides (never one beside or over it, never a motorway or trunk),
 * and the bake's metre-by-metre ride-surface and deck-kink checks.
 */
import { describe, expect, it } from 'vitest';

import {
  DECK_HEADROOM_M,
  END_GROW_MAX_M,
  NEVER_RIDDEN_CLASSES,
  RIDE_SLACK_M,
  anchorPins,
  approachHeights,
  bridgeNetworks,
  deckGrade,
  deckHeights,
  deckKinks,
  deckThickness,
  footprintConflicts,
  growDeckEnds,
  headroomFailures,
  piecePath,
  planApproaches,
  riddenSpans,
  rideSurface,
  solveNetwork,
  zAlong,
} from '../../../tools/worldbake/bridges.mjs';
import { ROAD_FLAGS } from '../../../tools/worldbake/buildVectors.mjs';

const dm = (pts: number[]) => pts.map((v) => Math.round(v * 10));
const CLASSES = ['secondary', 'cycleway'];
const roadsOf = (roads: { c: number; f?: number; p: number[] }[]) => ({
  classes: CLASSES,
  widths: [7, 3],
  names: [],
  flags: ROAD_FLAGS,
  roads: roads.map((r) => ({ c: r.c, ...(r.f ? { f: r.f } : {}), p: dm(r.p) })),
});

/**
 * A secondary road along y = 0 on the ground from x = −300, a 60 m bridge
 * from x = 0 to 60, ground again to x = 360. A cycleway route crosses
 * under the bridge at x = 10, 10 m from its west abutment.
 */
function scene() {
  const roads = roadsOf([
    { c: 0, p: [-300, 0, 0, 0] },
    { c: 0, f: ROAD_FLAGS.bridge, p: [0, 0, 6, 0, 12, 0, 18, 0, 24, 0, 30, 0, 36, 0, 42, 0, 48, 0, 54, 0, 60, 0] },
    { c: 0, p: [60, 0, 360, 0] },
  ]);
  const route = { id: 'r', x: [10, 10, 10], y: [-50, 0, 50], s: [0, 50, 100], spans: [] };
  return { roads, route, ground: () => 100 };
}

describe('bridges: decks as structures', () => {
  it('stands a deck on its abutments, a chain one straight line', () => {
    const { roads, ground } = scene();
    const [net] = bridgeNetworks(roads);
    expect(net.pieces).toEqual([1]);
    const z = solveNetwork(net, roads, ground).get(1)!;
    expect(z.every((v: number) => Math.abs(v - 100) < 1e-6)).toBe(true);
  });

  it('keeps a headroom pin between vertices once it has a vertex there', () => {
    const { roads, route, ground } = scene();
    const nets = bridgeNetworks(roads);
    const { pins } = deckHeights({ roads, nets, groundAt: ground, routes: [route] });
    expect(pins).toHaveLength(1);
    const need = 100 + DECK_HEADROOM_M + deckThickness(roads, roads.roads[1]);
    expect(pins[0].z).toBeCloseTo(need);
    // Pinned at x = 10, between the vertices at 6 and 12: lost without a vertex there.
    anchorPins(roads, pins);
    const z = solveNetwork(nets[0], roads, ground, pins).get(1)!;
    expect(zAlong(piecePath(roads.roads[1]), z, 10)).toBeCloseTo(need);
  });

  it('lifts the abutments onto approach ramps at the class grade, and then clears the route', () => {
    const { roads, route, ground } = scene();
    const nets = bridgeNetworks(roads);
    const { pins } = deckHeights({ roads, nets, groundAt: ground, routes: [route] });
    const plan = planApproaches({ roads, nets, pins, groundAt: ground, ridden: new Set() });
    anchorPins(roads, pins);
    const g = deckGrade(roads, roads.roads[1]);
    expect(g).toBe(0.05);
    const need = pins[0].z;
    // West abutment 10 m from the pin, east one 50 m.
    expect([...plan.abutZ.values()].sort()).toEqual([need - g * 50, need - g * 10].map((v) => expect.closeTo(v, 6)).sort());
    // The ramps run along the ground roads at the grade, landing (need − 100 − g·10) / g m out west.
    const west = approachHeights(roads, plan.approaches, ground).get(0)!;
    const westPath = piecePath(roads.roads[0]);
    const landM = (need - g * 10 - 100) / g;
    expect(zAlong(westPath, west, westPath.len - landM / 2)).toBeCloseTo(100 + (need - g * 10 - 100) / 2, 1);
    expect(zAlong(westPath, west, westPath.len - landM - 5)).toBeCloseTo(100);
    // With the abutments lifted, the deck clears the route by the headroom.
    const z = new Map(solveNetwork(nets[0], roads, ground, pins, plan.abutZ));
    for (const [ri, zs] of approachHeights(roads, plan.approaches, ground)) z.set(ri, zs);
    const zdm = new Map([...z].map(([ri, zs]) => [ri, zs.map((v: number) => Math.round(v * 10))]));
    expect(headroomFailures({ roads, routes: [route], zdm, surfaces: [() => null], groundAt: ground, rides: [[]] })).toEqual([]);
    // And the same deck left on its abutments fails the check.
    const flat = new Map([[1, roads.roads[1].p.filter((_: number, i: number) => i % 2 === 0).map(() => 1000)]]);
    expect(headroomFailures({ roads, routes: [route], zdm: flat, surfaces: [() => null], groundAt: ground, rides: [[]] })).toHaveLength(1);
  });

  it('refuses a ramp onto a road a route rides', () => {
    const { roads, route, ground } = scene();
    const nets = bridgeNetworks(roads);
    const { pins } = deckHeights({ roads, nets, groundAt: ground, routes: [route] });
    expect(() => planApproaches({ roads, nets, pins, groundAt: ground, ridden: new Set([0]) })).toThrow(/a road a route rides/);
  });
});

/** Roads with every class the ride rules care about (widths: motorway 12, trunk 10, secondary 7, cycleway 2.5). */
const RIDE_CLASSES = ['motorway', 'trunk', 'secondary', 'cycleway'];
const rideRoads = (roads: { c: number; f?: number; p: number[] }[]) => ({
  classes: RIDE_CLASSES,
  widths: [12, 10, 7, 2.5],
  names: [],
  flags: ROAD_FLAGS,
  roads: roads.map((r) => ({ c: r.c, ...(r.f ? { f: r.f } : {}), p: dm(r.p) })),
});
const B = ROAD_FLAGS.bridge;
/** A deck along y = 0 from x = 0 to x = 60, a vertex every 6 m. */
const deckLine = Array.from({ length: 11 }, (_, i) => [i * 6, 0]).flat();
/** Route samples every metre or less along a polyline [x, y, x, y, …]. */
const line = (pts: number[]) => {
  const x = [pts[0]], y = [pts[1]], s = [0];
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2], ay = pts[i - 1], bx = pts[i], by = pts[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.ceil(len);
    for (let k = 1; k <= n; k++) {
      x.push(ax + ((bx - ax) * k) / n);
      y.push(ay + ((by - ay) * k) / n);
      s.push(s[s.length - 1] + len / n);
    }
  }
  return { id: 'r', x, y, s };
};
/** Route samples every metre along y = `y` from x = −100 to 200 (s = x + 100). */
const along = (y: number) => line([-100, y, 200, y]);
const spansOf = (roads: ReturnType<typeof rideRoads>, route: ReturnType<typeof along>) => riddenSpans([route], roads, bridgeNetworks(roads))[0];

describe('bridges: which decks a route rides', () => {
  it('rides a deck it is on, and on past its ends where the ground road continues it', () => {
    const roads = rideRoads([
      { c: 2, p: [-100, 0, 0, 0] },
      { c: 2, f: B, p: deckLine },
      { c: 2, p: [60, 0, 200, 0] },
    ]);
    const [span, ...rest] = spansOf(roads, along(0.5));
    expect(rest).toEqual([]);
    expect(span.pieces).toEqual([1]);
    // Up to half-width + RIDE_SLACK_M (5 m) past both ends, as far as the app's
    // footprint reaches: 0.5 m off the line, the last metre samples in reach are x = −4 and 64.
    expect(3.5 + RIDE_SLACK_M).toBe(5);
    expect(span.s0).toBeCloseTo(96);
    expect(span.s1).toBeCloseTo(164);
  });

  it.each([
    ['motorway', 0],
    ['trunk', 1],
  ])('never rides a %s deck, even under its surface', (_, c) => {
    expect(NEVER_RIDDEN_CLASSES.has(RIDE_CLASSES[c])).toBe(true);
    // A cycleway running along under the deck, inside its half-width.
    const roads = rideRoads([
      { c, f: B, p: deckLine },
      { c: 3, p: [-100, 4, 200, 4] },
    ]);
    expect(spansOf(roads, along(4))).toEqual([]);
  });

  it('is on its own road, not on a deck beside it (off the deck, a ground road heading its way nearer)', () => {
    // The lakefront bikeway beside the Shoreway: 4.2 m off a secondary deck's centreline
    // (half-width 3.5, inside its reach of 5 m), on a cycleway of its own.
    const roads = rideRoads([
      { c: 2, f: B, p: deckLine },
      { c: 3, p: [-100, 4.2, 200, 4.2] },
    ]);
    expect(spansOf(roads, along(4.2))).toEqual([]);
    // Drifting off the deck onto that cycleway halfway along it: the ride ends
    // where the route leaves the deck's surface (y 3.5, x 46.7), not where its reach ends (x 64).
    const [span, ...rest] = spansOf(roads, line([-100, 0, 30, 0, 50, 4.2, 200, 4.2]));
    expect(rest).toEqual([]);
    expect(span.s1).toBeGreaterThan(145);
    expect(span.s1).toBeLessThan(148);
  });

  it('never takes a motorway for the road a route is on', () => {
    // A cycleway deck (half-width 1.25, reach 2.75) the route drifts 2.2 m off,
    // a motorway on the ground alongside nearer: the route is still on its deck.
    const roads = rideRoads([
      { c: 3, f: B, p: deckLine },
      { c: 0, p: [-100, 3, 200, 3] },
    ]);
    const [span, ...rest] = spansOf(roads, line([-100, 0, 20, 0, 30, 2.2, 200, 2.2]));
    expect(rest).toEqual([]);
    expect(span.s1).toBeGreaterThan(160);
  });

  it('stays on a deck it rides whatever runs under it', () => {
    // A street under the deck along the same line, nearer the route than the deck's centreline.
    const roads = rideRoads([
      { c: 2, p: [-100, 0, 0, 0] },
      { c: 2, f: B, p: deckLine },
      { c: 2, p: [60, 0, 200, 0] },
      { c: 2, p: [-100, 0.4, 200, 0.4] },
    ]);
    const spans = spansOf(roads, along(0.5));
    expect(spans.map((sp: { pieces: number[] }) => sp.pieces)).toEqual([[1]]);
  });

  it('needs the route on the deck somewhere, not only within its reach', () => {
    // 4.5 m off the centreline the whole way (reach 5 m), no road of its own drawn.
    const roads = rideRoads([{ c: 2, f: B, p: deckLine }]);
    expect(spansOf(roads, along(4.5))).toEqual([]);
    expect(spansOf(roads, along(3))).toHaveLength(1);
  });
});

describe('bridges: the bake checks the ride surface every metre', () => {
  /**
   * The route runs along y = 0 (samples every 10 m) and rides cycleway
   * deck 0 (x 60–90 along y = −1.2, at grade). Cycleway decks 1 and 2,
   * ridden elsewhere, stand 6 m up across the route: deck 1 at x = 25,
   * between two route samples, deck 2 over the ridden span at x = 75, where
   * it is nearer the route than deck 0 for 1.2 m either side.
   */
  function crossing() {
    const roads = rideRoads([
      { c: 3, f: B, p: [60, -1.2, 66, -1.2, 72, -1.2, 78, -1.2, 84, -1.2, 90, -1.2] },
      { c: 3, f: B, p: [25, -30, 25, -2, 25, 2, 25, 30] },
      { c: 3, f: B, p: [75, -30, 75, -2, 75, 2, 75, 30] },
    ]);
    const zdm = new Map([
      [0, [1000, 1000, 1000, 1000, 1000, 1000]],
      [1, [1000, 1060, 1060, 1000]],
      [2, [1000, 1060, 1060, 1000]],
    ]);
    const ground = () => 100;
    const x = Array.from({ length: 11 }, (_, i) => i * 10);
    const route = { id: 'r', x, y: x.map(() => 0), s: x, spans: [{ s0: 58, s1: 92, pieces: [0] }, { s0: 500, s1: 520, pieces: [1, 2] }] };
    const surfaces = [rideSurface(roads, [0, 1, 2], zdm, ground)];
    const own = [route.spans.map((sp) => rideSurface(roads, sp.pieces, zdm, ground))];
    return { roads, zdm, ground, route, surfaces, own };
  }

  it('finds a ridden deck between two route samples', () => {
    const { route, surfaces, own, ground } = crossing();
    const found = footprintConflicts({ routes: [route], surfaces, own, groundAt: ground });
    const off = found.filter((c: { span?: number }) => c.span === undefined);
    expect(off.length).toBeGreaterThan(0);
    expect(off.every((c: { s: number }) => c.s > 20 && c.s < 30)).toBe(true);
    // At the route samples alone (the old 10 m walk) it slips through.
    expect(footprintConflicts({ routes: [route], surfaces, own, groundAt: ground, stepM: 10 }).filter((c: { span?: number }) => c.span === undefined)).toEqual([]);
  });

  it('finds another ridden deck taking over on a ridden span', () => {
    const { route, surfaces, own, ground } = crossing();
    const onSpan = footprintConflicts({ routes: [route], surfaces, own, groundAt: ground }).filter((c: { span?: number }) => c.span === 0);
    expect(onSpan.length).toBeGreaterThan(0);
    expect(onSpan.map((c: { s: number }) => c.s)).toEqual([74, 75, 76]);
    expect(onSpan.every((c: { deckM: number }) => c.deckM > 5)).toBe(true);
  });

  it('flags pins that fight on a deck, never a straight deck', () => {
    const roads = rideRoads([{ c: 0, f: B, p: deckLine }]);
    const ground = () => 100;
    // Held up 7 m to x = 12, pinned down to the ground at x = 18 (the Shoreway kink).
    const kink = new Map([[0, [1070, 1070, 1070, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]]]);
    const [k] = deckKinks({ roads, zdm: kink, groundAt: ground });
    expect(k.road).toBe(0);
    expect(k.riseM).toBeCloseTo(7, 1);
    expect(k.aboveM).toBeCloseTo(7, 1);
    // A straight deck carries no pin, however steep (a footbridge up a hillside).
    const straight = new Map([[0, Array.from({ length: 11 }, (_, i) => 1000 + i * 24)]]);
    expect(deckKinks({ roads, zdm: straight, groundAt: ground })).toEqual([]);
    // A headroom pin with ramps at a road grade either side.
    const pinned = new Map([[0, [1000, 1003, 1006, 1009, 1012, 1015, 1012, 1009, 1006, 1003, 1000]]]);
    expect(deckKinks({ roads, zdm: pinned, groundAt: ground })).toEqual([]);
    // Never more than a metre above the ground: no deck standing there to kink.
    const low = new Map([[0, [1034, 1034, 1034, 1004, 1004, 1004, 1004, 1004, 1004, 1004, 1004]]]);
    expect(deckKinks({ roads, zdm: low, groundAt: () => 102.5 })).toEqual([]);
  });
});

describe('bridges: deck ends after the decimetre rounding', () => {
  // A cycleway deck from x = 0 to 40 whose rounded second vertex turned its
  // first segment, a second deck joined at x = 40, and the ground road the
  // route comes off at x = 0.
  const deckRoads = () =>
    roadsOf([
      { c: 1, f: ROAD_FLAGS.bridge, p: [0, 0, 2.6, 0.1, 20, 0, 40, 0] },
      { c: 1, f: ROAD_FLAGS.bridge, p: [40, 0, 60, 0] },
      { c: 1, p: [-30, 0, 0, 0] },
    ]);

  it('grows a free end near a miss along its own end segment until nothing is missed, keeping its vertex count', () => {
    const roads = deckRoads();
    const n = roads.roads[0].p.length;
    // The paint is missed at x = −0.3 until the deck's flat end reaches past it.
    const misses = () => (roads.roads[0].p[0] / 10 > -0.25 ? [{ x: -0.3, y: 0 }] : []);
    expect(growDeckEnds({ roads, pieces: [0, 1], misses })).toEqual([{ road: 0, end: 0, m: 0.3 }]);
    expect(roads.roads[0].p.length).toBe(n);
    expect(roads.roads[0].p.slice(0, 2)).toEqual([-3, 0]);
    expect(roads.roads[0].p.slice(2)).toEqual(dm([2.6, 0.1, 20, 0, 40, 0]));
    expect(roads.roads[1].p).toEqual(dm([40, 0, 60, 0]));
    expect(roads.roads[2].p).toEqual(dm([-30, 0, 0, 0]));
  });

  it('moves nothing when nothing is missed, and never a joint two decks share', () => {
    const roads = deckRoads();
    const before = JSON.stringify(roads);
    expect(growDeckEnds({ roads, pieces: [0, 1], misses: () => [] })).toEqual([]);
    expect(growDeckEnds({ roads, pieces: [0, 1], misses: () => [{ x: 40.3, y: 0 }] })).toEqual([]);
    expect(JSON.stringify(roads)).toBe(before);
  });

  it(`throws rather than grow an end past END_GROW_MAX_M (${END_GROW_MAX_M} m)`, () => {
    const roads = deckRoads();
    expect(() => growDeckEnds({ roads, pieces: [0, 1], misses: () => [{ x: -0.3, y: 0 }] })).toThrow(/grow past/);
  });
});
