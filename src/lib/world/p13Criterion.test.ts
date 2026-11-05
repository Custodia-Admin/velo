/**
 * Blueprint §P1.3 v2 terrain accuracy criterion (tools/worldbake/p13Criterion.mjs):
 * the GLO-90 node rule, the terrain class, the bound, the pass rule, the
 * recipe/report `validation` block, and every committed world against it.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Heightfield } from './heightfield';
import { createProjection } from './projection';
import {
  BOUND_M,
  MOUNTAIN_FLOOR_RMS_M,
  MOUNTAIN_FLOOR_SOURCE,
  OWN_ERROR_ALLOWANCE_M,
  P13_CRITERION,
  P13_REFERENCE,
  P13_REGISTRATION,
  P13_SAMPLE_COUNT,
  SLOPE_THRESHOLD_DEG,
  STEEP_FRACTION_THRESHOLD,
  TERRAIN_CLASSES,
  VALIDATION_INPUT_KEYS,
  VALIDATION_OUTPUT_KEYS,
  boundForFloor,
  glo90Node,
  passes,
  roundHalfUp,
  steepFraction,
  terrainClassFor,
  validationBlock,
  validationBlockProblems,
  validationInputs,
  withValidationBlock,
} from '../../../tools/worldbake/p13Criterion.mjs';
import { DEM_SOURCES, demSourceOf } from '../../../tools/worldbake/demSource.mjs';
import { nodeQueryPoints, openMeteoCacheKey, openMeteoUrl, samplePoints, validateHeightfield } from '../../../tools/worldbake/validateDem.mjs';

const repo = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const readJson = (rel: string) => JSON.parse(readFileSync(repo(rel), 'utf8'));
const WORLDS = readdirSync(repo('tools/worldbake/worlds'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5));

type Block = Record<string, unknown>;
const NO_OVERRIDE = { sampleSeed: 1, override: null, overrideReason: null };
const figures = { registeredRmsM: 5, pointRmsM: 7, maxAbsRegisteredErrM: 12 };

describe('P1.3 v2: bound', () => {
  it('derives 6.00 m standard and 6.24 m mountain from √(floor² + 6²)', () => {
    expect(OWN_ERROR_ALLOWANCE_M).toBe(6);
    expect(TERRAIN_CLASSES.standard).toEqual({ floorRmsM: 0, floorSource: 'none' });
    expect(TERRAIN_CLASSES.mountain).toEqual({ floorRmsM: 1.71, floorSource: 'copernicus-glo30-cog/lugano-t_045a5081' });
    expect(MOUNTAIN_FLOOR_RMS_M).toBe(1.71);
    expect(MOUNTAIN_FLOOR_SOURCE).toBe('copernicus-glo30-cog/lugano-t_045a5081');
    expect(BOUND_M).toEqual({ standard: 6, mountain: 6.24 });
    expect(boundForFloor(1.71)).toBe(6.24); // √38.9241 = 6.2389
    // The formula is the ruling's: its (since corrected) 6.53 m floor gave 8.87 m.
    expect(boundForFloor(6.53)).toBe(8.87);
    expect(boundForFloor(0)).toBe(6);
  });

  it('rounds half up to the stated decimals, through binary noise', () => {
    expect(roundHalfUp(6.235, 2)).toBe(6.24); // 6.235 · 100 = 623.4999… in binary
    expect(roundHalfUp(6.2349, 2)).toBe(6.23);
    expect(roundHalfUp(1.005, 2)).toBe(1.01);
    expect(roundHalfUp(0.19995, 4)).toBe(0.2);
    expect(roundHalfUp(0.199949, 4)).toBe(0.1999);
    expect(() => roundHalfUp(Number.NaN, 2)).toThrow(RangeError);
  });

  it('passes at exactly the bound and fails a hundredth above, on 2-decimal figures', () => {
    expect(passes(6.24, BOUND_M.mountain)).toBe(true);
    expect(passes(6.25, BOUND_M.mountain)).toBe(false);
    expect(passes(6.2449, BOUND_M.mountain)).toBe(true); // rounds to 6.24
    expect(passes(6.245, BOUND_M.mountain)).toBe(false); // rounds half up to 6.25
    expect(passes(6, BOUND_M.standard)).toBe(true);
    expect(passes(6.005, BOUND_M.standard)).toBe(false);
    expect(passes(6.0049, BOUND_M.standard)).toBe(true);
  });
});

describe('P1.3 v2: terrain class', () => {
  it('is mountain from a 0.2000 steep fraction, standard at 0.1999', () => {
    expect(STEEP_FRACTION_THRESHOLD).toBe(0.2);
    expect(terrainClassFor(0.1999)).toEqual({ terrainClass: 'standard', terrainClassSource: 'auto' });
    expect(terrainClassFor(0.2)).toEqual({ terrainClass: 'mountain', terrainClassSource: 'auto' });
    // The class follows the recorded 4-decimal fraction.
    const at = (s: number) => validationBlock({ inputs: NO_OVERRIDE, demSource: 'aws-terrain-tiles', steepFraction: s, ...figures });
    expect(at(0.19995)).toMatchObject({ steep_fraction: 0.2, terrain_class: 'mountain', bound_m: 6.24 });
    expect(at(0.199949)).toMatchObject({ steep_fraction: 0.1999, terrain_class: 'standard', bound_m: 6 });
  });

  it('takes an override up to mountain and records where the class came from', () => {
    expect(terrainClassFor(0.05, 'mountain')).toEqual({ terrainClass: 'mountain', terrainClassSource: 'override' });
    expect(terrainClassFor(0.35, 'mountain')).toEqual({ terrainClass: 'mountain', terrainClassSource: 'auto' });
    const inputs = validationInputs({ sample_seed: 7, terrain_class_override: 'mountain', terrain_class_override_reason: 'Gorge walls under the 15 m grid' });
    expect(inputs).toEqual({ sampleSeed: 7, override: 'mountain', overrideReason: 'Gorge walls under the 15 m grid' });
    const block = validationBlock({ inputs, demSource: 'copernicus-glo30', steepFraction: 0.05, ...figures });
    expect(block).toMatchObject({
      terrain_class_override: 'mountain',
      terrain_class_override_reason: 'Gorge walls under the 15 m grid',
      terrain_class: 'mountain',
      terrain_class_source: 'override',
      steep_fraction: 0.05,
      floor_rms_m: 1.71,
      bound_m: 6.24,
    });
  });

  it('rejects an override down to standard, an override without a reason and a reason without an override', () => {
    expect(() => validationInputs({ sample_seed: 7, terrain_class_override: 'standard', terrain_class_override_reason: 'flat' })).toThrow(/never down to "standard"/);
    expect(() => validationInputs({ sample_seed: 7, terrain_class_override: 'Mountain', terrain_class_override_reason: 'x' })).toThrow(/must be "mountain"/);
    expect(() => validationInputs({ sample_seed: 7, terrain_class_override: 'mountain' })).toThrow(/non-empty terrain_class_override_reason/);
    expect(() => validationInputs({ sample_seed: 7, terrain_class_override: 'mountain', terrain_class_override_reason: '  ' })).toThrow(/non-empty/);
    expect(() => validationInputs({ sample_seed: 7, terrain_class_override_reason: 'x' })).toThrow(/without terrain_class_override/);
  });

  it('needs an integer sample_seed and refuses v1 and unknown fields', () => {
    expect(() => validationInputs(undefined)).toThrow(/needs a "validation" object/);
    expect(() => validationInputs({})).toThrow(/sample_seed/);
    expect(() => validationInputs({ sample_seed: 1.5 })).toThrow(/sample_seed/);
    expect(() => validationInputs({ seed: 46059, samples: 50, maxRmsM: 6 })).toThrow(/v1 field: renamed to "sample_seed"/);
    expect(() => validationInputs({ sample_seed: 1, samples: 50 })).toThrow(/v1 field: fixed at 50/);
    expect(() => validationInputs({ sample_seed: 1, maxRmsM: 9 })).toThrow(/v1 field: the bound comes from/);
    expect(() => validationInputs({ sample_seed: 1, bound: 9 })).toThrow(/not a P1.3 v2 field/);
  });

  it('never reads a bound, floor or verdict from the recipe', () => {
    const stale = { sample_seed: 1, bound_m: 99, floor_rms_m: 50, pass: true, terrain_class: 'standard', steep_fraction: 0 };
    const block = validationBlock({ inputs: validationInputs(stale), demSource: 'aws-terrain-tiles', steepFraction: 0.5, ...figures, registeredRmsM: 7 });
    expect(block).toMatchObject({ terrain_class: 'mountain', floor_rms_m: 1.71, bound_m: 6.24, registered_rms_m: 7, pass: false });
  });
});

describe('P1.3 v2: steep fraction (Horn 3×3)', () => {
  const DEG = Math.PI / 180;
  /** A heightfield from metres (node (c, r) at x = c·cellSize, y = −r·cellSize), quantised at 1/128 m. */
  function hf(cols: number, rows: number, cellSize: number, z: (x: number, y: number) => number) {
    const heightScale = 1 / 128;
    const data = new Uint16Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) data[r * cols + c] = Math.round(z(c * cellSize, -r * cellSize) / heightScale);
    return new Heightfield({ cols, rows, cellSize, xMin: 0, yMax: 0, heightOffset: 0, heightScale }, data);
  }
  /** A plane rising at `deg` towards bearing `bearingDeg` (from north, clockwise). */
  const plane = (deg: number, bearingDeg: number) => {
    const g = Math.tan(deg * DEG);
    const [ax, ay] = [Math.sin(bearingDeg * DEG) * g, Math.cos(bearingDeg * DEG) * g];
    return (x: number, y: number) => 200 + ax * x + ay * y;
  };

  it('counts a 15.5° slope as steep and a 14.5° slope as not, in any direction', () => {
    expect(SLOPE_THRESHOLD_DEG).toBe(15);
    for (const bearing of [0, 90, 35, 200, 300]) {
      expect(steepFraction(hf(12, 9, 10, plane(15.5, bearing))), `${bearing}°`).toBe(1);
      expect(steepFraction(hf(12, 9, 10, plane(14.5, bearing))), `${bearing}°`).toBe(0);
    }
  });

  it('uses the cell size in metres', () => {
    // Same node heights: 3 m rise per node is 16.7° at 10 m spacing and 5.7° at 30 m.
    const steep = hf(8, 8, 10, (x) => 0.3 * x);
    const spread = new Heightfield({ ...steep.spec, cellSize: 30 }, steep.data);
    expect(steepFraction(steep)).toBe(1);
    expect(steepFraction(spread)).toBe(0);
  });

  it('weighs the window the Horn way and counts every node but the outer ring', () => {
    // 30° ramp over columns 0…10, flat from 10 on: 22 × 7 nodes, 20 × 5 inner nodes.
    // Inner columns 1…9 sit on the ramp; column 10's window (9, 10, 11) still sees
    // half of it, (tan 30°)/2 → 16.1°; columns 11…20 are flat. So 10 of 20 columns.
    const t = Math.tan(30 * DEG);
    const field = hf(22, 7, 10, (x) => 5 + t * Math.min(x, 100));
    expect(steepFraction(field)).toBe(0.5);
    // A single 1 m spike: its own slope is 0 (the centre isn't in Horn's sums); its
    // 8 neighbours tilt by 1/(8·h)·(2 or 1), under 15° at h = 1 m only for the corners.
    const spike = hf(5, 5, 1, (x, y) => (x === 2 && y === -2 ? 1 : 0));
    // Edge neighbours: |g| = 2/8 = 0.25 → 14.04° (not steep); corners: hypot(1/8, 1/8) = 0.177 → 10° (not steep).
    expect(steepFraction(spike)).toBe(0);
    const tall = hf(5, 5, 1, (x, y) => (x === 2 && y === -2 ? 2 : 0));
    // Doubled: edges 0.5 → 26.6° steep, corners 0.354 → 19.5° steep, centre 0 → 8 of 9.
    expect(steepFraction(tall)).toBeCloseTo(8 / 9, 12);
  });

  it('needs a 3×3 grid', () => {
    expect(() => steepFraction(hf(2, 5, 10, () => 0))).toThrow(RangeError);
  });
});

describe('P1.3 v2: glo90-nw-node', () => {
  const D = 1 / 1200;
  const inCell = (lat: number, lon: number) => {
    const n = glo90Node(lat, lon);
    // The node is the cell's north-west corner: at or north of the sample by
    // less than a cell, at or west of it by less than a cell.
    expect(n.lat).toBeGreaterThan(lat - 1e-12);
    expect(n.lat - lat).toBeLessThan(D + 1e-12);
    expect(lon - n.lon).toBeGreaterThan(-1e-12);
    expect(lon - n.lon).toBeLessThan(D);
    return n;
  };

  it('picks the north-west corner for positive and negative latitudes and longitudes', () => {
    expect(inCell(46.17213, 8.97123)).toEqual({ lat: 55407 * D, lon: 10765 * D }); // Lugano, N/E
    expect(inCell(-33.86882, 151.2093)).toEqual({ lat: -40642 * D, lon: 181451 * D }); // Sydney, S/E
    expect(inCell(40.7128, -74.006)).toEqual({ lat: 48856 * D, lon: -88808 * D }); // New York, N/W
    expect(inCell(-22.95192, -43.21049)).toEqual({ lat: -27542 * D, lon: -51853 * D }); // Rio, S/W
  });

  it('takes the next node north on a node row and the node itself on a node column', () => {
    // Lugano sample 45.9675 sits on row 55161; Open-Meteo answered with row 55162
    // (507 m; the cell south of the row answers 493 m), and so does the rule.
    expect(glo90Node(45.9675, 8.8405)).toEqual({ lat: 55162 * D, lon: 10608 * D });
    expect(glo90Node(-12.5, 8.8375)).toEqual({ lat: -14999 * D, lon: 10605 * D });
  });

  it('matches ⌈lat/Δ⌉·Δ, ⌊lon/Δ⌋·Δ off the node rows, on every committed sample point', () => {
    let checked = 0;
    for (const id of WORLDS) {
      for (const p of readJson(`tools/worldbake/reports/${id}.json`).validation.points as { lat: number; lon: number; nodeLat: number; nodeLon: number }[]) {
        const onLine = (v: number) => (Math.round(v * 1e5) * 12) % 1000 === 0;
        const n = glo90Node(p.lat, p.lon);
        if (!onLine(p.lat) && !onLine(p.lon)) expect(n).toEqual({ lat: Math.ceil(p.lat / D) * D, lon: Math.floor(p.lon / D) * D });
        expect([+n.lat.toFixed(8), +n.lon.toFixed(8)]).toEqual([p.nodeLat, p.nodeLon]);
        checked++;
      }
    }
    expect(checked).toBe(WORLDS.length * P13_SAMPLE_COUNT);
  });

  it('refuses latitudes from 50° poleward, where GLO-90 longitude spacing widens', () => {
    expect(() => glo90Node(50, 8)).toThrow(/outside \|lat\| < 50°/);
    expect(() => glo90Node(-51.2, 8)).toThrow(RangeError);
    expect(() => glo90Node(Number.NaN, 8)).toThrow(RangeError);
    expect(glo90Node(49.99999, 8).lat).toBeCloseTo(60000 * D, 12);
  });
});

describe('P1.3 v2: validation block', () => {
  it('holds the author inputs, then every output field in schema order', () => {
    const block = validationBlock({ inputs: NO_OVERRIDE, demSource: 'aws-terrain-tiles', steepFraction: 0.1, ...figures });
    expect(Object.keys(block)).toEqual(['sample_seed', ...VALIDATION_OUTPUT_KEYS]);
    expect(block).toEqual({
      sample_seed: 1,
      criterion: 'p1.3-v2-registered-rms',
      reference: 'open-meteo-elevation/copernicus-glo90',
      registration: 'glo90-nw-node',
      sample_count: 50,
      dem_source: 'aws-terrain-tiles',
      terrain_class: 'standard',
      terrain_class_source: 'auto',
      slope_threshold_deg: 15,
      steep_fraction_threshold: 0.2,
      steep_fraction: 0.1,
      floor_source: 'none',
      floor_rms_m: 0,
      own_error_allowance_m: 6,
      bound_m: 6,
      registered_rms_m: 5,
      point_rms_m: 7,
      max_abs_registered_err_m: 12,
      pass: true,
    });
    const over = validationBlock({ inputs: { sampleSeed: 1, override: 'mountain', overrideReason: 'r' }, demSource: 'copernicus-glo30', steepFraction: 0.1, ...figures });
    expect(Object.keys(over)).toEqual([...VALIDATION_INPUT_KEYS, ...VALIDATION_OUTPUT_KEYS]);
  });

  it('gates on the registered figure only: a point RMS far above the bound still passes', () => {
    const block = validationBlock({ inputs: NO_OVERRIDE, demSource: 'copernicus-glo30', steepFraction: 0.5, registeredRmsM: 2.1, pointRmsM: 20.63, maxAbsRegisteredErrM: 40 });
    expect(block).toMatchObject({ terrain_class: 'mountain', bound_m: 6.24, registered_rms_m: 2.1, point_rms_m: 20.63, pass: true });
  });

  it('finds missing fields and figures that disagree with the rule', () => {
    const good = validationBlock({ inputs: NO_OVERRIDE, demSource: 'aws-terrain-tiles', steepFraction: 0.3, ...figures });
    expect(validationBlockProblems(good)).toEqual([]);
    const { bound_m: _b, ...missing } = good;
    expect(validationBlockProblems(missing)).toEqual(['missing bound_m']);
    expect(validationBlockProblems({ ...good, bound_m: 8.87 })).toEqual(['bound_m is 8.87, expected 6.24']);
    expect(validationBlockProblems({ ...good, registered_rms_m: 6.3 })).toEqual(['pass is true, expected false']);
    expect(validationBlockProblems({ ...good, terrain_class: 'standard' })).toContain('terrain_class is "standard", expected "mountain"');
    expect(validationBlockProblems({ ...good, criterion: 'p1.3-v1' })).toEqual(['criterion is "p1.3-v1", expected "p1.3-v2-registered-rms"']);
    expect(validationBlockProblems(good, { demSource: 'copernicus-glo30' })).toEqual(['dem_source is "aws-terrain-tiles", expected "copernicus-glo30"']);
  });

  it('rewrites only the recipe\'s validation member, idempotently', () => {
    const text = '{\n  "id": "x",\n  "note": "validation {not this}",\n  "grid": { "cols": 3 },\n  "validation": { "sample_seed": 4, "x": "}" },\n  "after": [1, {"validation": 2}]\n}\n';
    const block = validationBlock({ inputs: { sampleSeed: 4, override: null, overrideReason: null }, demSource: 'aws-terrain-tiles', steepFraction: 0, ...figures });
    const once = withValidationBlock(text, block);
    expect(JSON.parse(once).validation).toEqual(block);
    expect(once.startsWith('{\n  "id": "x",\n  "note": "validation {not this}",\n  "grid": { "cols": 3 },\n  "validation": {\n    "sample_seed": 4,\n')).toBe(true);
    expect(once.endsWith('    "pass": true\n  },\n  "after": [1, {"validation": 2}]\n}\n')).toBe(true);
    expect(withValidationBlock(once, block)).toBe(once);
    expect(() => withValidationBlock('{"id": "x"}', block)).toThrow(/no top-level "validation"/);
  });
});

describe('P1.3 v2: validateHeightfield on a synthetic world (cached answers, no network)', () => {
  const projection = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 46, lon0: 9, k0: 1 });
  const grid = { cols: 201, rows: 201, cellSize: 15, xMin: -1500, yMax: 1500 };
  const extent = { xMin: -1500, xMax: 1500, yMin: -1500, yMax: 1500 };
  /** A heightfield of z(x, y) metres, quantised at 1/32 m. */
  function field(z: (x: number, y: number) => number) {
    const data = new Uint16Array(grid.cols * grid.rows);
    for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) data[r * grid.cols + c] = Math.round(z(grid.xMin + c * 15, grid.yMax - r * 15) * 32);
    return new Heightfield({ ...grid, heightOffset: 0, heightScale: 1 / 32 }, data);
  }
  /**
   * Run the check with Open-Meteo "answering" the heightfield at each
   * sample's GLO-90 node plus `err(i)`; the diagnostic node query answers
   * `nodeShift` metres off that, to prove it never gates.
   */
  async function run(hf: Heightfield, err: (i: number) => number, nodeShift = 0) {
    const dir = mkdtempSync(join(tmpdir(), 'p13-'));
    try {
      const recipe = { validation: { sample_seed: 4242 } };
      const pts = samplePoints({ projection, extent, sampleSeed: 4242 });
      const nodes = pts.map((p: { lat: number; lon: number }) => glo90Node(p.lat, p.lon));
      const atNode = nodes.map((n: { lat: number; lon: number }) => hf.sampleHeight(...projection.forward(n.lat, n.lon)));
      const answers = atNode.map((h: number, i: number) => h + err(i));
      mkdirSync(join(dir, 'open-meteo'));
      const put = (q: { lat: number; lon: number }[], elevation: number[]) => writeFileSync(join(dir, 'open-meteo', openMeteoCacheKey(openMeteoUrl(q))), JSON.stringify({ elevation }));
      put(pts, answers);
      put(nodeQueryPoints(nodes), answers.map((a: number) => a + nodeShift));
      return await validateHeightfield({ hf, projection, extent, recipe, demSource: 'copernicus-glo30', cacheDir: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const alternating = (m: number) => (i: number) => (i % 2 ? -m : m);

  it('gates a steep world on the node reading against the sample\'s answer, with the mountain bound', async () => {
    const steep = field((x) => 1000 + 0.4 * x); // 21.8°, every inner node steep
    const { block, report } = await run(steep, alternating(3), 100);
    expect(block).toMatchObject({ sample_seed: 4242, sample_count: 50, terrain_class: 'mountain', steep_fraction: 1, bound_m: 6.24, registered_rms_m: 3, max_abs_registered_err_m: 3, pass: true });
    // At the sample itself the slope adds the in-cell offset: reported, never gating.
    expect(block.point_rms_m).toBeGreaterThan(5);
    expect(report.diagnostics.node_answer_mismatches).toBe(50);
    expect(report.points).toHaveLength(50);
    expect(report.points[0].nodeOpenMeteo - report.points[0].openMeteo).toBeCloseTo(100, 9);
    expect((await run(steep, alternating(6.25))).block).toMatchObject({ registered_rms_m: 6.25, pass: false });
  });

  it('gives a flat world the standard 6.00 m bound, inclusive', async () => {
    const flat = field(() => 300);
    expect((await run(flat, alternating(6))).block).toMatchObject({ terrain_class: 'standard', steep_fraction: 0, bound_m: 6, registered_rms_m: 6, point_rms_m: 6, pass: true });
    expect((await run(flat, alternating(6.01))).block).toMatchObject({ registered_rms_m: 6.01, pass: false });
  });

  it('is deterministic and keeps the v1 sampling protocol', async () => {
    const steep = field((x, y) => 1000 + 0.2 * x - 0.3 * y);
    expect(await run(steep, alternating(2))).toEqual(await run(steep, alternating(2)));
    // v1's Lugano report began at (46.17213, 8.97123): same seed, same draws.
    const lugano = readJson('tools/worldbake/worlds/lugano.json');
    const g = lugano.grid;
    const pts = samplePoints({
      projection: createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: lugano.origin.lat, lon0: lugano.origin.lon, k0: 1 }),
      extent: { xMin: g.xMin, xMax: g.xMin + (g.cols - 1) * g.cellSize, yMin: g.yMax - (g.rows - 1) * g.cellSize, yMax: g.yMax },
      sampleSeed: lugano.validation.sample_seed,
    });
    expect(pts[0]).toEqual({ lat: 46.17213, lon: 8.97123 });
    expect(pts.map((p: { lat: number; lon: number }) => [p.lat, p.lon])).toEqual(
      readJson('tools/worldbake/reports/lugano.json').validation.points.map((p: { lat: number; lon: number }) => [p.lat, p.lon]),
    );
  });
});

describe('P1.3 v2: committed worlds', () => {
  // Shipped worlds that fail the gate, each with the card that fixes it. Remove
  // the entry with the fix: the test fails while a listed world passes.
  const KNOWN_FAILURES: Record<string, string> = {
    lugano: 't_49b58e90: re-bake from copernicus-glo30 (EU-DEM measures 8.88 m registered against the 6.24 m mountain bound)',
  };

  it('every recipe and report carries a complete, consistent block, the same in both', () => {
    for (const id of WORLDS) {
      const recipe = readJson(`tools/worldbake/worlds/${id}.json`);
      const report = readJson(`tools/worldbake/reports/${id}.json`);
      const demSource = demSourceOf(recipe);
      expect(validationBlockProblems(recipe.validation, { demSource }), `${id} recipe`).toEqual([]);
      expect(validationBlockProblems(report.validation, { demSource }), `${id} report`).toEqual([]);
      const keys = Object.keys(recipe.validation);
      expect(keys.filter((k) => !VALIDATION_INPUT_KEYS.includes(k))).toEqual([...VALIDATION_OUTPUT_KEYS]);
      const fromReport: Block = Object.fromEntries(keys.map((k) => [k, report.validation[k]]));
      expect(fromReport, id).toEqual(recipe.validation);
      expect(report.validation.points).toHaveLength(P13_SAMPLE_COUNT);
    }
  });

  it('every shipped world passes the gate, except the listed ones, which fail it', () => {
    for (const id of WORLDS) {
      const { validation } = readJson(`tools/worldbake/reports/${id}.json`);
      expect(validation.pass, `${id}: ${KNOWN_FAILURES[id] ?? 'must pass'}`).toBe(!(id in KNOWN_FAILURES));
    }
  });

  it('keeps Perugia, a standard world, passing as it did under v1', () => {
    const { validation } = readJson('tools/worldbake/reports/perugia.json');
    expect(validation).toMatchObject({ terrain_class: 'standard', terrain_class_source: 'auto', floor_rms_m: 0, bound_m: 6, pass: true });
    expect(validation.steep_fraction).toBeLessThan(STEEP_FRACTION_THRESHOLD);
  });

  it('classes Lugano as mountain from its own slopes', () => {
    const { validation } = readJson('tools/worldbake/reports/lugano.json');
    expect(validation).toMatchObject({ terrain_class: 'mountain', terrain_class_source: 'auto', floor_rms_m: 1.71, bound_m: 6.24 });
    expect(validation.steep_fraction).toBeGreaterThan(0.4);
    expect(validation.diagnostics.node_answer_mismatches).toBe(0);
  });

  it('documents the same fields and constants in tools/worldbake/recipe.schema.json', () => {
    const v = readJson('tools/worldbake/recipe.schema.json').properties.validation;
    expect(Object.keys(v.properties)).toEqual([...VALIDATION_INPUT_KEYS, ...VALIDATION_OUTPUT_KEYS]);
    expect(v.required).toEqual(['sample_seed']);
    expect(v.additionalProperties).toBe(false);
    const p = v.properties;
    expect(p.terrain_class_override.const).toBe('mountain');
    expect(p.criterion.const).toBe(P13_CRITERION);
    expect(p.reference.const).toBe(P13_REFERENCE);
    expect(p.registration.const).toBe(P13_REGISTRATION);
    expect(p.sample_count.const).toBe(P13_SAMPLE_COUNT);
    expect(p.dem_source.enum).toEqual(DEM_SOURCES);
    expect(p.slope_threshold_deg.const).toBe(SLOPE_THRESHOLD_DEG);
    expect(p.steep_fraction_threshold.const).toBe(STEEP_FRACTION_THRESHOLD);
    expect(p.own_error_allowance_m.const).toBe(OWN_ERROR_ALLOWANCE_M);
    expect(p.floor_source.enum).toEqual([TERRAIN_CLASSES.standard.floorSource, TERRAIN_CLASSES.mountain.floorSource]);
    expect(p.floor_rms_m.enum).toEqual([TERRAIN_CLASSES.standard.floorRmsM, TERRAIN_CLASSES.mountain.floorRmsM]);
    expect(p.bound_m.enum).toEqual([BOUND_M.standard, BOUND_M.mountain]);
  });
});
