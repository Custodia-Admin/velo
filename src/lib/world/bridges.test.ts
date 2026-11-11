/**
 * tools/worldbake/bridges.mjs: deck heights from the abutments, headroom
 * pins that survive the per-vertex output, abutments lifted onto approach
 * ramps at the class grade, and the bake's own headroom check.
 */
import { describe, expect, it } from 'vitest';

import {
  DECK_HEADROOM_M,
  anchorPins,
  approachHeights,
  bridgeNetworks,
  deckGrade,
  deckHeights,
  deckThickness,
  headroomFailures,
  piecePath,
  planApproaches,
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
