/**
 * Embankments (recipe `snap.embankment`, tools/worldbake/snapRoutes.mjs).
 * Where the route profile misses relief the bare-ground DTM has, the route
 * fit stood the route on an embankment (Cleveland lakefront 1.2 km 8.2 m,
 * Locarno–Brissago 2.8 km 19 m over the DTM). These pins check which samples
 * count, how far the target comes down, and that slopes, bridges and tunnels
 * are left alone.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createProjection } from './projection';
import {
  EMBANKMENT_ACROSS_STEP_M,
  EMBANKMENT_STRUCTURE_MARGIN_M,
  carveRoutes,
  embankmentLowering,
  embankmentOptions,
  finishRoutes,
  nearStructures,
  spanStructureDiff,
  spanStructuresOption,
  structureLookup,
} from '../../../tools/worldbake/snapRoutes.mjs';
import { readRecipe } from '../../../tools/worldbake/bake.mjs';
import { quantize } from '../../../tools/worldbake/buildHeightfield.mjs';
import { readableWorldBundles } from '../../../tools/worldbake/worldBundles.mjs';
import { Heightfield } from './heightfield';

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

/** A straight eastward route every 10 m over a 9 m deep, 300 m wide trough running across it (deepest at s = 500). */
function trough({ sideWall = 0 } = {}) {
  const s = Array.from({ length: 101 }, (_, i) => i * 10);
  const x = s.map((v) => v - 500);
  const y = s.map(() => 0);
  const dip = (px: number) => 9 * Math.max(0, 1 - Math.abs(px) / 150);
  const raw = x.map((px) => 100 - dip(px));
  // The ground across: the trough runs north–south, so it is as low either side.
  // With `sideWall` 1 (−1) the ground north (south) of the route rises 20 m from 15 m out: a road cut into a slope.
  const groundAt = (px: number, py: number) => 100 - dip(px) + (sideWall && py * sideWall > 15 ? 20 : 0);
  return { s, x, y, raw, groundAt, target: s.map(() => 100) };
}

describe('embankments: which samples count and how far the route comes down', () => {
  it('lowers a route bridging a hollow to maxM over the ground, easing back over rampM', () => {
    const t = trough();
    const { lower, runs } = embankmentLowering({ ...t, maxM: 3, acrossM: 40, rampM: 150 });
    // Samples stand over 3 m where the trough is deeper than 3 m: |s − 500| < 100.
    expect(runs).toEqual([{ s0: 410, s1: 590, lowerM: 6 }]);
    for (let i = 0; i < t.s.length; i++) {
      const after = t.target[i] - lower[i];
      if (Math.abs(t.s[i] - 500) < 100) expect(after - t.raw[i]).toBeLessThanOrEqual(3 + 1e-9);
      // Never lower than needed at the deepest point, and only ever down.
      expect(lower[i]).toBeGreaterThanOrEqual(0);
      expect(lower[i]).toBeLessThanOrEqual(6 + 1e-9);
    }
    expect(t.target[50] - lower[50]).toBeCloseTo(94, 9);
    // The ramp ends rampM past the last sample that counted (410 → 260, 590 → 740).
    expect(lower[t.s.indexOf(260)]).toBe(0);
    expect(lower[t.s.indexOf(270)]).toBeGreaterThan(0);
    expect(lower[t.s.indexOf(740)]).toBe(0);
    expect(lower[t.s.indexOf(730)]).toBeGreaterThan(0);
    // A smooth ramp: no 10 m step changes the lowering by more than the smoothstep's steepest slope allows,
    // and it eases in (smoothstep, flat at its end): the ramp's first 10 m lowers the route by under 1 cm.
    for (let i = 1; i < t.s.length; i++) expect(Math.abs(lower[i] - lower[i - 1])).toBeLessThan(0.6);
    expect(lower[t.s.indexOf(270)]).toBeLessThan(0.01);
    expect(lower[t.s.indexOf(730)]).toBeLessThan(0.01);
  });

  it('leaves a road cut into a slope alone: the ground reaches the route height on one side within acrossM', () => {
    for (const side of [1, -1]) {
      const t = trough({ sideWall: side });
      const { lower, runs } = embankmentLowering({ ...t, maxM: 3, acrossM: 40, rampM: 150 });
      expect(runs, `wall on side ${side}`).toEqual([]);
      expect(Math.max(...lower)).toBe(0);
      // ...but a wall beyond acrossM does not count.
      const narrow = embankmentLowering({ ...t, maxM: 3, acrossM: 10, rampM: 150 });
      expect(narrow.runs).toEqual([{ s0: 410, s1: 590, lowerM: 6 }]);
    }
  });

  it('never counts samples on or within the margin of a mapped bridge or tunnel', () => {
    const t = trough();
    const structure = (px: number) => Math.abs(px) < 5; // a 10 m bridge over the bottom of the trough
    const { runs } = embankmentLowering({ ...t, structure, maxM: 3, acrossM: 40, rampM: 150 });
    expect(EMBANKMENT_STRUCTURE_MARGIN_M).toBe(20);
    expect(runs.map((r: { s0: number; s1: number }) => [r.s0, r.s1])).toEqual([[410, 470], [530, 590]]);
  });

  it('does nothing where the route stands at most maxM over the ground', () => {
    const t = trough();
    const { lower, runs } = embankmentLowering({ ...t, maxM: 9, acrossM: 40, rampM: 150 });
    expect(runs).toEqual([]);
    expect(Math.max(...lower)).toBe(0);
  });

  it('reads the ground across every 10 m out to acrossM', () => {
    const t = trough();
    const seen = new Set<number>();
    embankmentLowering({ ...t, groundAt: (px: number, py: number) => (seen.add(Math.round(Math.abs(py))), t.groundAt(px, py)), maxM: 3, acrossM: 40, rampM: 150 });
    expect(EMBANKMENT_ACROSS_STEP_M).toBe(10);
    expect([...seen].sort((a, b) => a - b)).toEqual([10, 20, 30, 40]);
  });
});

describe('embankments: the recipe block', () => {
  it('is off without the block, fills defaults, and refuses bad values', () => {
    expect(embankmentOptions({})).toBeNull();
    expect(embankmentOptions({ embankment: { maxM: 3 } })).toEqual({ maxM: 3, acrossM: 40, rampM: 150 });
    expect(embankmentOptions({ embankment: { maxM: 7, acrossM: 30, rampM: 100 } })).toEqual({ maxM: 7, acrossM: 30, rampM: 100 });
    expect(() => embankmentOptions({ embankment: null })).toThrow(/must be an object/);
    expect(() => embankmentOptions({ embankment: {} })).toThrow(/maxM must be/);
    expect(() => embankmentOptions({ embankment: { maxM: -1 } })).toThrow(/maxM must be/);
    expect(() => embankmentOptions({ embankment: { maxM: 3, acrossM: 5 } })).toThrow(/acrossM/);
    expect(() => embankmentOptions({ embankment: { maxM: 3, rampM: 0 } })).toThrow(/rampM/);
  });

  it('is documented with the same defaults in tools/worldbake/recipe.schema.json', () => {
    const schema = JSON.parse(readFileSync(repo('tools/worldbake/recipe.schema.json'), 'utf8')).properties.snap.properties.embankment;
    expect(schema.required).toEqual(['maxM']);
    expect(schema.properties.acrossM.default).toBe(40);
    expect(schema.properties.rampM.default).toBe(150);
    expect(schema.properties.acrossM.minimum).toBe(EMBANKMENT_ACROSS_STEP_M);
    expect(schema.description).toContain(`within ${EMBANKMENT_STRUCTURE_MARGIN_M} m of a mapped bridge or tunnel`);
  });

  it('needs bareGround: on a surface model the ground across is canopy and roofs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'embank-'));
    try {
      const recipe = JSON.parse(readFileSync(repo('tools/worldbake/worlds/cleveland-lakefront.json'), 'utf8'));
      const at = (r: object) => {
        const path = join(dir, 'w.json');
        writeFileSync(path, JSON.stringify(r));
        return () => readRecipe(path);
      };
      const snap = { ...recipe.snap, embankment: { maxM: 3 } };
      expect(at({ ...recipe, snap })()).toMatchObject({ recipe: { snap: { embankment: { maxM: 3 } } } });
      const { bareGround: _b, ...noBare } = recipe;
      expect(at({ ...noBare, snap })).toThrow(/snap.embankment needs bareGround/);
      expect(at({ ...recipe, snap: { ...recipe.snap, embankment: { maxM: 3, acrossM: 1 } } })).toThrow(/acrossM/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('embankments: mapped bridges and tunnels (structureLookup)', () => {
  it('marks points within half-width + 1 m of a bridge or tunnel, nothing else', () => {
    const look = structureLookup({
      widths: [12, 6],
      roads: [
        { c: 1, f: 1, p: [0, 0, 1000, 0] }, // bridge, 6 m class width: 4 m reach, x 0–100 m at y 0
        { c: 1, p: [0, 500, 1000, 500] }, // plain road at y 50 m
        { c: 0, f: 2 | 8, w: 4, p: [0, 1000, 600, 1000, 1000, 1000] }, // oneway tunnel, 4 m wide: 3 m reach, y 100 m
        { c: 1, f: 4, p: [0, 1500, 1000, 1500] }, // unpaved only
      ],
    });
    expect(look(50, 3.9)).toBe(true);
    expect(look(50, -3.9)).toBe(true);
    expect(look(50, 4.1)).toBe(false);
    expect(look(103.9, 0)).toBe(true);
    expect(look(104.1, 0)).toBe(false);
    expect(look(50, 50)).toBe(false);
    expect(look(80, 102.9)).toBe(true);
    expect(look(80, 103.1)).toBe(false);
    expect(look(50, 150)).toBe(false);
  });
});

describe('shipped worlds: embankments the bake lowered', () => {
  const recipeOf = (id: string) => JSON.parse(readFileSync(repo(`tools/worldbake/worlds/${id}.json`), 'utf8'));
  const worlds = (readableWorldBundles() as { id: string; dir: string }[]).filter((b) => existsSync(repo(`tools/worldbake/worlds/${b.id}.json`)) && recipeOf(b.id).snap.embankment);
  const gz = (dir: string, file: string) => JSON.parse(gunzipSync(readFileSync(join(dir, file))).toString('utf8'));

  it('finds the worlds baked with snap.embankment', () => {
    const ids = worlds.map((b) => b.id);
    expect(ids).toContain('lugano');
    if (process.env.VELO_REQUIRE_REMOTE_WORLDS === '1') expect(ids).toContain('cleveland-lakefront');
  });

  for (const { id, dir } of worlds) {
    it(`${id}: every route reports its runs, and no run lies on a mapped bridge or tunnel`, () => {
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      const report = JSON.parse(readFileSync(repo(`tools/worldbake/reports/${id}.json`), 'utf8'));
      expect(report.hashes['manifest.json']).toBe(createHash('sha256').update(readFileSync(join(dir, 'manifest.json'))).digest('hex'));
      const look = structureLookup(gz(dir, manifest.layers.roads));
      const routes = gz(dir, manifest.layers.routes).routes as { id: string; s: number[]; x: number[]; y: number[] }[];
      const onStructure: string[] = [];
      for (const r of routes) {
        const runs = report.routes.find((x: { id: string }) => x.id === r.id).report.embankments as { s0: number; s1: number }[];
        expect(Array.isArray(runs), r.id).toBe(true);
        for (const run of runs) {
          for (let i = 0; i < r.s.length; i++) if (r.s[i] >= run.s0 && r.s[i] <= run.s1 && look(r.x[i], r.y[i])) onStructure.push(`${r.id} ${r.s[i]}`);
        }
      }
      // Without the bridge/tunnel exclusion the Cleveland bake lowered the Detroit–Superior deck (3.2–3.7 km) by 7.1 m.
      expect(onStructure).toEqual([]);
    });
  }

  it('lowered the two embankments the profile built (Cleveland lakefront 1.2 km, Locarno–Brissago 2.8 km)', () => {
    const runsOf = (world: string, route: string) =>
      JSON.parse(readFileSync(repo(`tools/worldbake/reports/${world}.json`), 'utf8')).routes.find((r: { id: string }) => r.id === route).report.embankments as { s0: number; s1: number; lowerM: number }[];
    const covering = (runs: { s0: number; s1: number; lowerM: number }[], s: number) => runs.find((r) => r.s0 <= s && r.s1 >= s);
    expect(covering(runsOf('cleveland-lakefront', 'scenic-cleveland-lakefront'), 1200)?.lowerM).toBeGreaterThan(5);
    expect(covering(runsOf('lugano', 'scenic-locarno-brissago'), 2800)?.lowerM).toBeGreaterThan(10);
  });
});

describe('embankments: in the route fit (carveRoutes)', () => {
  const proj = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 41.5, lon0: -81.7, k0: 1 });
  const grid = { cols: 161, rows: 41, cellSize: 10, xMin: -800, yMax: 200 };
  const dip = (x: number) => 9 * Math.max(0, 1 - Math.abs(x) / 120);
  /** A valley running north–south across a flat plain at 190 m, and an 1.2 km eastward route with a flat profile. */
  function world() {
    const heights = new Float64Array(grid.cols * grid.rows);
    for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) heights[r * grid.cols + c] = 190 - dip(grid.xMin + c * grid.cellSize);
    const [la0, lo0] = proj.inverse(-600, 0);
    const [la1, lo1] = proj.inverse(600, 0);
    return { heights, route: { id: 'r', name: 'R', points: [[la0, lo0, 180], [la1, lo1, 180]] } };
  }
  const snap = { stepM: 10, offsetMedianM: 200, offsetMeanM: 800, coreCells: 1.5, falloffM: 30 };
  const bottom = (p: { x: number[]; target: number[]; raw: number[] }) => {
    const i = p.x.reduce((best, v, k) => (Math.abs(v) < Math.abs(p.x[best]) ? k : best), 0);
    return p.target[i] - p.raw[i];
  };

  it('without the block the fit bridges the valley; with it the route comes down to maxM over the bottom', () => {
    const a = world();
    const plain = carveRoutes({ grid, heights: a.heights, projection: proj, routes: [a.route], snap }).prepared[0];
    expect(bottom(plain)).toBeGreaterThan(5);
    expect(plain.embankments).toBeUndefined();

    const b = world();
    const carved = carveRoutes({ grid, heights: b.heights, projection: proj, routes: [b.route], snap: { ...snap, embankment: { maxM: 2 } } });
    const p = carved.prepared[0];
    expect(bottom(p)).toBeLessThanOrEqual(2 + 1e-9);
    expect(p.embankments).toHaveLength(1);
    expect(p.embankments[0].lowerM).toBeCloseTo(bottom(plain) - 2, 1);
    // Far from the valley the target is the plain fit's.
    expect(p.target[0]).toBe(plain.target[0]);
    expect(p.target[p.target.length - 1]).toBe(plain.target[plain.target.length - 1]);
    // The report carries the runs; the bundle's route keeps a zero gap.
    const { q, heightOffset, heightScale } = quantize(b.heights);
    const hf = new Heightfield({ ...grid, heightOffset, heightScale }, q);
    const { info } = finishRoutes({ prepared: carved.prepared, hf, snap });
    expect(info[0].maxGapM).toBe(0);
    expect(info[0].report.embankments).toEqual(p.embankments);
  });

  it('leaves the valley bridged where a mapped bridge crosses it', () => {
    const a = world();
    const p = carveRoutes({ grid, heights: a.heights, projection: proj, routes: [a.route], snap: { ...snap, embankment: { maxM: 2 } }, structure: (x: number) => Math.abs(x) < 60 }).prepared[0];
    expect(bottom(p)).toBeGreaterThan(2.5);
  });

  it('reads the ground, at the route and across it, from fitHeights and carves heights (a coast world: carveRoutes)', () => {
    // The valley only in fitHeights; the grid the carve writes is the flat plain.
    const valley = world().heights;
    const fitHeights = valley.slice();
    const heights = new Float64Array(valley.length).fill(190);
    const p = carveRoutes({ grid, heights, projection: proj, routes: [world().route], snap: { ...snap, embankment: { maxM: 2 } }, fitHeights }).prepared[0];
    // As in the valley world: raw is the valley's bottom and the embankment comes down to maxM over it.
    expect(Math.min(...p.raw)).toBeCloseTo(181, 0);
    expect(bottom(p)).toBeLessThanOrEqual(2 + 1e-9);
    expect(p.embankments).toHaveLength(1);
    // The carve wrote the plain at the route (x = 0) and never touched fitHeights.
    const mid = Math.round(grid.yMax / grid.cellSize) * grid.cols + Math.round(-grid.xMin / grid.cellSize);
    const i = p.x.reduce((best, v, k) => (Math.abs(v) < Math.abs(p.x[best]) ? k : best), 0);
    expect(heights[mid]).toBeCloseTo(p.target[i], 1);
    expect(heights[mid]).toBeLessThan(184);
    expect(fitHeights).toEqual(valley);
  });
});

describe('spanStructures: the offset spans mapped bridges and tunnels (snap.spanStructures)', () => {
  it('interpolates raw − profile across each run near a structure, holds the one side at a route end', () => {
    const s = [0, 10, 20, 30, 40, 50];
    const { diff, runs } = spanStructureDiff(s, [1, 2, 9, 9, 5, 6], Uint8Array.from([0, 0, 1, 1, 0, 0]));
    expect(Array.from(diff)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(runs).toEqual([{ s0: 20, s1: 30 }]);
    expect(Array.from(spanStructureDiff(s, [7, 8, 1, 2, 3, 9], Uint8Array.from([1, 1, 0, 0, 0, 1])).diff)).toEqual([1, 1, 1, 2, 3, 3]);
    const all = spanStructureDiff(s, [1, 2, 3, 4, 5, 6], new Uint8Array(6).fill(1));
    expect(Array.from(all.diff)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(all.runs).toEqual([]);
  });

  it('counts the samples on a structure and within the 20 m margin along the route', () => {
    const s = [0, 10, 20, 30, 40, 50, 60, 70, 80];
    const near = nearStructures(s, s, new Array(9).fill(0), (x: number) => x === 40);
    expect(Array.from(near)).toEqual([0, 0, 1, 1, 1, 1, 1, 0, 0]);
    expect(EMBANKMENT_STRUCTURE_MARGIN_M).toBe(20);
  });

  it('is off by default, must be a boolean, and is documented in tools/worldbake/recipe.schema.json', () => {
    expect(spanStructuresOption({})).toBe(false);
    expect(spanStructuresOption(undefined)).toBe(false);
    expect(spanStructuresOption({ spanStructures: true })).toBe(true);
    expect(() => spanStructuresOption({ spanStructures: 'yes' })).toThrow(/must be true or false/);
    const schema = JSON.parse(readFileSync(repo('tools/worldbake/recipe.schema.json'), 'utf8')).properties.snap.properties.spanStructures;
    expect(schema).toMatchObject({ type: 'boolean', default: false });
    expect(schema.description).toContain(`within ${EMBANKMENT_STRUCTURE_MARGIN_M} m of a mapped bridge or tunnel`);
  });

  describe('in the route fit', () => {
    const proj = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 20.6, lon0: -105.2, k0: 1 });
    const grid = { cols: 161, rows: 41, cellSize: 10, xMin: -800, yMax: 200 };
    /** A 120 m river channel 6 m deep across a flat plain at 3 m, bridged; a 1.2 km route with a flat profile at 2 m. */
    function world() {
      const heights = new Float64Array(grid.cols * grid.rows);
      for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) heights[r * grid.cols + c] = Math.abs(grid.xMin + c * grid.cellSize) < 60 ? -3 : 3;
      const [la0, lo0] = proj.inverse(-600, 0);
      const [la1, lo1] = proj.inverse(600, 0);
      return { heights, route: { id: 'r', name: 'R', points: [[la0, lo0, 2], [la1, lo1, 2]] } };
    }
    const snap = { stepM: 10, offsetMedianM: 100, offsetMeanM: 400, coreCells: 1.5, falloffM: 30 };
    const bridge = (x: number) => Math.abs(x) < 65;
    const centre = (p: { x: number[]; target: number[] }) => p.target[p.x.reduce((best, v, k) => (Math.abs(v) < Math.abs(p.x[best]) ? k : best), 0)];

    it('without it the channel pulls the route down onto the river; with it the deck stays at the banks', () => {
      const a = world();
      const plain = carveRoutes({ grid, heights: a.heights, projection: proj, routes: [a.route], snap, structure: bridge }).prepared[0];
      expect(centre(plain)).toBeLessThan(2);
      expect(plain.structureSpans).toBeUndefined();
      const b = world();
      const carved = carveRoutes({ grid, heights: b.heights, projection: proj, routes: [b.route], snap: { ...snap, spanStructures: true }, structure: bridge });
      const p = carved.prepared[0];
      expect(centre(p)).toBeCloseTo(3, 6);
      expect(p.structureSpans).toEqual([{ s0: 520, s1: 680 }]);
      // Away from the bridge the fit is the plain one.
      expect(p.target[0]).toBe(plain.target[0]);
      const { q, heightOffset, heightScale } = quantize(b.heights);
      const hf = new Heightfield({ ...grid, heightOffset, heightScale }, q);
      const { info } = finishRoutes({ prepared: carved.prepared, hf, snap });
      expect(info[0].report.structureSpans).toEqual(p.structureSpans);
    });

    it('needs the structures', () => {
      const a = world();
      expect(() => carveRoutes({ grid, heights: a.heights, projection: proj, routes: [a.route], snap: { ...snap, spanStructures: true } })).toThrow(/spanStructures needs the mapped bridges and tunnels/);
    });
  });
});
