import { describe, expect, it } from 'vitest';

import { assembleSea, BEACH_SLOPE, buildSea, clipCoast, edgePosition, flattenSea, joinCoastline, maskDistance, relevelSea, SEA_LEVEL_M, slopeBeaches } from '../../../tools/worldbake/coast.mjs';
import { buildLandcover, buildWater, LANDCOVER_KINDS, WATER_AREA_KINDS } from '../../../tools/worldbake/buildVectors.mjs';
import { osmLayersFor, OSM_LAYERS } from '../../../tools/worldbake/fetchOsm.mjs';

/** A 1 km square world round the origin. */
const ext = { xMin: -500, xMax: 500, yMin: -500, yMax: 500 };
const area = (ring: number[]) => {
  let a = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += ring[2 * j] * ring[2 * i + 1] - ring[2 * i] * ring[2 * j + 1];
  return a / 2;
};
const polyArea = (poly: number[][]) => Math.abs(area(poly[0])) - poly.slice(1).reduce((s, h) => s + Math.abs(area(h)), 0);
function inRing(x: number, y: number, ring: number[]) {
  let c = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i], yi = ring[2 * i + 1], xj = ring[2 * j], yj = ring[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const isSea = (polys: number[][][], x: number, y: number) => polys.some((p) => inRing(x, y, p[0]) && !p.slice(1).some((h) => inRing(x, y, h)));

describe('coast: the sea from coastline ways (land left, water right)', () => {
  it('measures edge positions clockwise from the north-west corner', () => {
    expect(edgePosition(-500, 500, ext)).toBe(0);
    expect(edgePosition(0, 500, ext)).toBe(500);
    expect(edgePosition(500, 0, ext)).toBe(1500);
    expect(edgePosition(0, -500, ext)).toBe(2500);
    expect(edgePosition(-500, 0, ext)).toBe(3500);
    expect(edgePosition(0, 0, ext)).toBeNull();
  });

  it('puts the sea on the right of a coast running north to south: the west half', () => {
    const polys = assembleSea([[0, 500, 20, 0, 0, -500]], ext);
    expect(polys).toHaveLength(1);
    expect(polyArea(polys[0])).toBeCloseTo(500_000 + 10_000, 6); // the coast bulges 20 m east
    expect(area(polys[0][0])).toBeLessThan(0); // clockwise
    expect(isSea(polys, -300, 0)).toBe(true);
    expect(isSea(polys, 300, 0)).toBe(false);
    // The same coast run the other way round puts the sea east.
    const east = assembleSea([[0, -500, 20, 0, 0, 500]], ext);
    expect(isSea(east, 300, 0)).toBe(true);
    expect(isSea(east, -300, 0)).toBe(false);
  });

  it('follows the edge round the corners the sea covers, and only those', () => {
    // From the west edge round to the south edge, water on the right (south-west): one corner.
    const sw = assembleSea([[-500, 100, -100, 100, -100, -500]], ext);
    expect(polyArea(sw[0])).toBeCloseTo(400 * 600, 6);
    expect(isSea(sw, -400, -400)).toBe(true);
    expect(isSea(sw, 400, 400)).toBe(false);
    // Reversed: everything but that corner, three corners.
    const rest = assembleSea([[-100, -500, -100, 100, -500, 100]], ext);
    expect(polyArea(rest[0])).toBeCloseTo(1_000_000 - 400 * 600, 6);
  });

  it('closes several runs into separate seas or one, by where they meet the edge', () => {
    // Two headlands from the south edge: two coves of sea between them and the edges? No: a cove
    // between two runs (the land is the strip in the middle).
    const runs = [
      [-200, -500, -200, 500], // north-going: sea east of it… wait, water right of north = east
      [200, 500, 200, -500], // south-going: water right of south = west
    ];
    // Water east of the first and west of the second: the strip between them is sea, the sides land.
    const strip = assembleSea(runs, ext);
    expect(strip).toHaveLength(1);
    expect(polyArea(strip[0])).toBeCloseTo(400 * 1000, 6);
    expect(isSea(strip, 0, 0)).toBe(true);
    expect(isSea(strip, -400, 0)).toBe(false);
    // Flipped: two seas at the sides, land in the middle.
    const sides = assembleSea([[-200, 500, -200, -500], [200, -500, 200, 500]], ext);
    expect(sides).toHaveLength(2);
    expect(sides.reduce((s, p) => s + polyArea(p), 0)).toBeCloseTo(2 * 300 * 1000, 6);
    expect(isSea(sides, 0, 0)).toBe(false);
  });

  it('makes islands holes and clockwise loops seas of their own; islands alone mean open sea', () => {
    const island = [100, 100, 200, 100, 200, 200, 100, 200, 100, 100]; // counter-clockwise
    const polys = assembleSea([[0, 500, 0, -500], island], ext);
    expect(polys).toHaveLength(1);
    expect(polys[0]).toHaveLength(1); // the island is on land (east of the coast): no hole
    const west = assembleSea([[0, 500, 0, -500], [-200, 100, -100, 100, -100, 200, -200, 200, -200, 100]], ext);
    expect(west[0]).toHaveLength(2);
    expect(isSea(west, -150, 150)).toBe(false);
    expect(isSea(west, -300, 150)).toBe(true);
    const bay = assembleSea([[100, 100, 100, 200, 200, 200, 200, 100, 100, 100]], ext); // clockwise
    expect(bay).toHaveLength(1);
    expect(polyArea(bay[0])).toBeCloseTo(10_000, 6);
    const open = assembleSea([island], ext);
    expect(polyArea(open[0])).toBeCloseTo(1_000_000 - 10_000, 6);
  });

  it('keeps a coast whole through the world: no cut at a vertex where x0 + dx·1 ≠ x1 in the last bit', () => {
    // Berkeley's coast at 3,660.9 m (OSM node 37.908983, −122.3280839 in its world frame).
    const line = [-39.77565780783127, 3663.7268850988585, -7.378241937722094, 3660.929724124572, 12.514005055634788, 3651.5839720491913];
    expect(-39.77565780783127 + (line[2] - line[0]) * 1).not.toBe(line[2]);
    expect(clipCoast(line, { xMin: -4900, xMax: 3272, yMin: -4924, yMax: 5000 })).toEqual([line]);
  });

  it('refuses a coastline that stops inside the world', () => {
    expect(() => assembleSea([[0, 500, 0, 0]], ext)).toThrow(/ends inside the world/);
  });

  it('joins coastline ways end to start and never reverses one', () => {
    const g = (pts: [number, number][]) => ({ geometry: pts.map(([lat, lon]) => ({ lat, lon })) });
    const chains = joinCoastline([g([[2, 0], [3, 0]]), g([[1, 0], [2, 0]]), g([[5, 5], [4, 4]]), g([[9, 9], [8, 8], [9, 8], [9, 9]])]);
    const show = chains.map((c) => c.map((p: { lat: number }) => p.lat).join(','));
    expect(show).toEqual(['1,2,3', '5,4', '9,8,9,9']);
  });

  it('builds the sea of a world from Overpass elements, loops crossing the edge included', () => {
    // An identity "projection": lat/lon are already metres.
    const projection = { forward: (lat: number, lon: number) => [lon, lat] as [number, number] };
    const way = (id: number, pts: [number, number][]) => ({ type: 'way', id, tags: { natural: 'coastline' }, geometry: pts.map(([x, y]) => ({ lat: y, lon: x })) });
    // A coast running south in two ways, the join inside the world; an island loop crossing the north edge.
    const els = [way(2, [[0, 0], [0, -900]]), way(1, [[0, 900], [0, 0]]), way(3, [[-300, 600], [-300, 400], [-200, 400], [-200, 600], [-300, 600]])];
    const polys = buildSea(els, projection, ext);
    expect(isSea(polys, -400, 0)).toBe(true);
    expect(isSea(polys, -250, 450)).toBe(false); // the island's tip
    expect(isSea(polys, 300, 0)).toBe(false);
    expect(polys.reduce((s, p) => s + polyArea(p), 0)).toBeCloseTo(500_000 - 100 * 100, 6);
  });
});

describe('coast: terrain and layers', () => {
  const grid = { cols: 11, rows: 11, cellSize: 100, xMin: -500, yMax: 500 };
  const seaLayer = { areaKinds: [...WATER_AREA_KINDS, 'sea'], areas: [{ k: 3, r: [[-5000, 5000, 500, 5000, 500, -5000, -5000, -5000]] }] };

  it('levels every node under the sea, lowers the shore strip to sea level, and leaves the land', () => {
    const h = new Float64Array(121).map((_, i) => 3 + (i % 11)); // rising east
    const { nodes, inNodes, stripNodes } = flattenSea({ grid, heights: h, water: seaLayer });
    // x = −500 … 0 (columns 0–5; the coast at x = 50 is not a node), every row, the edge rows included.
    expect(inNodes).toBe(6 * 11);
    for (let r = 0; r < 11; r++) {
      for (let c = 0; c < 11; c++) {
        const v = h[r * 11 + c];
        if (c <= 5) expect(v).toBe(SEA_LEVEL_M);
        else if (c === 6) expect(v).toBe(SEA_LEVEL_M);
        else expect(v).toBe(3 + c);
      }
    }
    expect(stripNodes).toBe(11);
    // After a carve: back to sea level except the route core.
    h[0] = 4;
    h[1] = 5;
    expect(relevelSea({ heights: h, nodes, keep: (i: number) => i === 1 })).toBe(1);
    expect([h[0], h[1]]).toEqual([SEA_LEVEL_M, 5]);
  });

  it('slopes a beach down to the sea at BEACH_SLOPE, lowering only, and leaves the land behind it', () => {
    // A 15 m shelf of sand right up to the water (GLO-30 over Santa Monica: 4–7 m), sea in columns 0–5.
    const h = new Float64Array(121).fill(15);
    const { mask } = flattenSea({ grid, heights: h, water: seaLayer });
    const d = maskDistance(grid, mask);
    expect([d[5], d[6], d[8], d[10]]).toEqual([0, 100, 300, 500]);
    expect(d[2 * 11 + 7]).toBeCloseTo(200, 6);
    // The beach: x 50…350 m (columns 6–8), every row.
    const beach = [[[50, 600, 350, 600, 350, -600, 50, -600]]];
    const res = slopeBeaches({ grid, heights: h, sea: mask, beaches: beach });
    for (let r = 0; r < 11; r++) {
      expect(h[r * 11 + 6]).toBe(SEA_LEVEL_M); // the shore strip, already at sea level
      expect(h[r * 11 + 7]).toBeCloseTo(BEACH_SLOPE * 200, 9);
      expect(h[r * 11 + 8]).toBeCloseTo(BEACH_SLOPE * 300, 9);
      expect(h[r * 11 + 9]).toBe(15); // behind the beach
    }
    expect(res.changed).toBe(22);
    expect(res.maxCutM).toBeCloseTo(15 - BEACH_SLOPE * 200, 9);
    // Never raises: a low beach stays.
    const low = new Float64Array(121).fill(0.5);
    flattenSea({ grid, heights: low, water: seaLayer });
    expect(slopeBeaches({ grid, heights: low, sea: mask, beaches: beach }).changed).toBe(0);
  });

  it('adds the sea and the beach kinds only to coast worlds', () => {
    const projection = { forward: (lat: number, lon: number) => [lon, lat] as [number, number] };
    expect(buildWater([], projection, ext).areaKinds).toEqual(WATER_AREA_KINDS);
    const sea = buildWater([], projection, ext, { sea: [[[-500, 500, 0, 500, 0, -500, -500, -500]]] });
    expect(sea.areaKinds).toEqual([...WATER_AREA_KINDS, 'sea']);
    expect(sea.areas).toEqual([{ k: 3, r: [[-5000, 5000, 0, 5000, 0, -5000, -5000, -5000]] }]);
    const beachEl = { type: 'way', tags: { natural: 'beach' }, geometry: [[10, 10], [60, 10], [60, 60], [10, 60], [10, 10]].map(([x, y]) => ({ lat: y, lon: x })) };
    expect(buildLandcover([], projection, ext).layer.kinds).toEqual(LANDCOVER_KINDS);
    const lc = buildLandcover([], projection, ext, { beach: [beachEl] });
    expect(lc.layer.kinds).toEqual([...LANDCOVER_KINDS, 'beach']);
    expect(lc.layer.areas).toHaveLength(1);
    expect(lc.polys[0].kind).toBe('beach');
    expect(osmLayersFor({})).toBe(OSM_LAYERS);
    expect(Object.keys(osmLayersFor({ coast: true }))).toEqual([...Object.keys(OSM_LAYERS), 'coast']);
  });
});
