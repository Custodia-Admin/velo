#!/usr/bin/env node
// Re-run the blueprint §P1.3 v2 terrain accuracy check on a world that is
// already baked, without re-baking it:
//
//   node tools/worldbake/validate.mjs <world> [--bundle dir] [--cache dir] [--no-write]
//
//   --bundle <dir>   the baked bundle (default public/worlds/<world>, or
//                    tools/worldbake/remote/<world> for a "host": "remote" recipe)
//   --cache <dir>    download cache (default tools/worldbake/cache, env WORLDBAKE_CACHE);
//                    Open-Meteo answers are cached under <cache>/<world>/open-meteo
//   --no-write       print the result only; leave the recipe and the report alone
//
// Reads the shipped heightfield and routes, runs the same check as the bake
// (validateDem.mjs), and writes the `validation` block into
// tools/worldbake/worlds/<world>.json and tools/worldbake/reports/<world>.json.
// Same bundle + same cached answers → the same block, to the byte. Exits 0
// on PASS and FAIL alike (the verdict is the block's `pass`); 1 on an error.
//
// Refuses (exit 1, "re-bake") a bundle the recipe didn't bake: another id,
// grid, origin or DEM source, or a `generator.recipeSha256` that isn't the
// hash of the recipe without its `validation` (recipeBundleBytes in
// bake.mjs). Editing the recipe's `validation` keeps the bundle valid; any
// other edit (routes, snap, osmDate…) needs a re-bake first.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createProjection } from '../../src/lib/world/projection.ts';
import { Heightfield, decodeHeightDeltas } from '../../src/lib/world/heightfield.ts';
import { DEM_SOURCE } from './fetchDem.mjs';
import { GLO30_SOURCE } from './fetchGlo30.mjs';
import { demSourceOf, GLO30_DEM_SOURCE } from './demSource.mjs';
import { describeValidation, validateHeightfield, writeValidation } from './validateDem.mjs';
import { readRecipe, recipeBundleBytes } from './bake.mjs';
import { here, sha256 } from './util.mjs';

const ROOT = resolve(here(import.meta.url), '../..');

function parseArgs(argv) {
  const args = { world: null, bundle: null, cache: process.env.WORLDBAKE_CACHE ?? null, write: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bundle') args.bundle = argv[++i];
    else if (a === '--cache') args.cache = argv[++i];
    else if (a === '--no-write') args.write = false;
    else if (!a.startsWith('-') && !args.world) args.world = a;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.world) throw new Error('usage: node tools/worldbake/validate.mjs <world> [--bundle dir] [--cache dir] [--no-write]');
  return args;
}

/** The bundle's heightfield, projection, extent and routes, checked against the recipe that baked it. */
export function loadBakedWorld(bundleDir, recipe) {
  const read = (file) => readFileSync(join(bundleDir, file));
  const manifest = JSON.parse(read('manifest.json').toString('utf8'));
  const demSource = demSourceOf(recipe);
  const bakedFrom = manifest.generator?.demSource;
  const expected = demSource === GLO30_DEM_SOURCE ? GLO30_SOURCE : DEM_SOURCE;
  if (bakedFrom !== expected) throw new Error(`${bundleDir} was baked from ${bakedFrom}, but the recipe's dem.source is ${demSource} (${expected}): re-bake`);
  const g = recipe.grid;
  const h = manifest.heightfield;
  const o = manifest.projection;
  if (manifest.id !== recipe.id || h.cols !== g.cols || h.rows !== g.rows || h.cellSize !== g.cellSize || manifest.extent.xMin !== g.xMin || manifest.extent.yMax !== g.yMax || o.lat0 !== recipe.origin.lat || o.lon0 !== recipe.origin.lon) {
    throw new Error(`${bundleDir} doesn't match the recipe's id, grid or origin: re-bake`);
  }
  // Every other recipe field that shapes the bundle (routes, snap, osmDate…).
  const recipeSha256 = sha256(recipeBundleBytes(recipe));
  const bakedSha256 = manifest.generator?.recipeSha256;
  if (bakedSha256 !== recipeSha256) {
    throw new Error(`${bundleDir} was baked from another recipe (generator.recipeSha256 ${String(bakedSha256).slice(0, 12)}…, the recipe without its validation block hashes to ${recipeSha256.slice(0, 12)}…): re-bake`);
  }
  const q = decodeHeightDeltas(new Uint8Array(gunzipSync(read(h.file))), h.cols, h.rows);
  const hf = new Heightfield({ cols: h.cols, rows: h.rows, cellSize: h.cellSize, xMin: g.xMin, yMax: g.yMax, heightOffset: h.heightOffset, heightScale: h.heightScale }, q);
  // Exactly the bake's projection and extent (bake.mjs), so the samples land on the same points.
  const projection = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: recipe.origin.lat, lon0: recipe.origin.lon, k0: 1 });
  const extent = { xMin: g.xMin, xMax: g.xMin + (g.cols - 1) * g.cellSize, yMin: g.yMax - (g.rows - 1) * g.cellSize, yMax: g.yMax };
  const routes = JSON.parse(gunzipSync(read(manifest.layers.routes)).toString('utf8')).routes;
  return { manifest, demSource, hf, projection, extent, routes };
}

/**
 * Check a baked world and (unless `write` is false) write the block. `root`
 * is the tree holding the recipe, the report and the default bundle (the
 * repo by default). Returns the result; a FAIL returns like a PASS.
 */
export async function validateBaked(opts) {
  const root = opts.root ?? ROOT;
  const recipePath = join(root, 'tools/worldbake/worlds', `${opts.world}.json`);
  const { recipe } = readRecipe(recipePath);
  const bundleDir = resolve(opts.bundle ?? join(root, recipe.host === 'remote' ? 'tools/worldbake/remote' : 'public/worlds', recipe.id));
  const cacheDir = resolve(opts.cache ?? join(root, 'tools/worldbake/cache'), recipe.id);
  const { demSource, hf, projection, extent, routes } = loadBakedWorld(bundleDir, recipe);
  const core = recipe.snap.coreCells * recipe.grid.cellSize + recipe.snap.falloffM;
  const mask = (x, y) => routes.some((r) => r.x.some((rx, i) => Math.hypot(rx - x, r.y[i] - y) < core));
  const result = await validateHeightfield({ hf, projection, extent, recipe, demSource, cacheDir, routeMask: mask });
  console.log(`${recipe.id} (${bundleDir}): ${describeValidation(result)}`);
  if (opts.write) {
    const reportPath = join(root, 'tools/worldbake/reports', `${recipe.id}.json`);
    writeValidation({ recipePath, reportPath: existsSync(reportPath) ? reportPath : null, block: result.block, report: result.report });
    console.log(`wrote the validation block to ${recipePath}${existsSync(reportPath) ? ` and ${reportPath}` : ''}`);
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  validateBaked(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
