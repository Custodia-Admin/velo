#!/usr/bin/env node
// Check every baked world bundle against its manifest and against the recipe
// that baked it. Offline: no download, no API call.
//
//   node tools/worldbake/checkBundles.mjs [world…]
//
// For each recipe in tools/worldbake/worlds/ (or only the worlds named):
//   - its bundle is on disk (public/worlds/<id>/, or tools/worldbake/remote/<id>/
//     for a "host": "remote" recipe; run fetchPublished.mjs first for those);
//   - every file the manifest lists has its stored size and SHA-256, and a
//     gzip file inflates to its stored contentBytes and contentSha256;
//   - the bundle directory holds nothing the manifest doesn't list;
//   - the bundle was baked from this recipe: id, grid, origin, DEM source and
//     generator.recipeSha256 (loadBakedWorld, the check validate.mjs runs
//     before it re-validates a world).
// With no world named it also fails on a bundle that has no recipe.
//
// CI's bake-validate workflow runs it whenever the bake changes. Exits 1 and
// lists every problem when anything is off.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readRecipe } from './bake.mjs';
import { loadBakedWorld } from './validate.mjs';
import { here, sha256 } from './util.mjs';
import { worldBundles } from './worldBundles.mjs';

const ROOT = resolve(here(import.meta.url), '../..');

/** Problems with one bundle directory against its manifest's `files` (empty = sound). */
export function checkBundleFiles(dir) {
  const problems = [];
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return [`${dir}: no manifest.json`];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const listed = new Set(['manifest.json']);
  for (const f of manifest.files ?? []) {
    listed.add(f.path);
    const p = join(dir, f.path);
    if (!existsSync(p)) {
      problems.push(`${f.path}: missing`);
      continue;
    }
    const bytes = readFileSync(p);
    if (bytes.length !== f.bytes) problems.push(`${f.path}: ${bytes.length} bytes, manifest says ${f.bytes}`);
    if (sha256(bytes) !== f.sha256) problems.push(`${f.path}: SHA-256 differs from the manifest`);
    if (f.compression === 'gzip') {
      let content;
      try {
        content = gunzipSync(bytes);
      } catch (err) {
        problems.push(`${f.path}: not valid gzip (${err.message})`);
        continue;
      }
      if (content.length !== f.contentBytes) problems.push(`${f.path}: inflates to ${content.length} bytes, manifest says ${f.contentBytes}`);
      if (sha256(content) !== f.contentSha256) problems.push(`${f.path}: inflated SHA-256 differs from the manifest`);
    } else if (f.compression !== undefined && f.compression !== 'none') {
      problems.push(`${f.path}: unknown compression ${f.compression}`);
    }
  }
  for (const name of readdirSync(dir)) {
    if (!listed.has(name) && statSync(join(dir, name)).isFile()) problems.push(`${name}: not listed in the manifest`);
  }
  return problems;
}

/** Problems with world `id`: its recipe, its bundle's files and the recipe → bundle link. */
export function checkWorld(id, { root = ROOT } = {}) {
  const recipePath = join(root, 'tools/worldbake/worlds', `${id}.json`);
  if (!existsSync(recipePath)) return [`no recipe tools/worldbake/worlds/${id}.json`];
  let recipe;
  try {
    ({ recipe } = readRecipe(recipePath));
  } catch (err) {
    return [`recipe: ${err.message}`];
  }
  const dir = join(root, recipe.host === 'remote' ? 'tools/worldbake/remote' : 'public/worlds', recipe.id);
  if (!existsSync(join(dir, 'manifest.json'))) return [`no bundle at ${dir}`];
  const problems = checkBundleFiles(dir);
  if (problems.length === 0) {
    try {
      loadBakedWorld(dir, recipe);
    } catch (err) {
      problems.push(err.message);
    }
  }
  return problems;
}

/** Every world id with a recipe. */
export function recipeIds(root = ROOT) {
  return readdirSync(join(root, 'tools/worldbake/worlds'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const named = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const ids = named.length ? named : recipeIds();
  let failed = 0;
  for (const id of ids) {
    const problems = checkWorld(id);
    if (problems.length) {
      failed++;
      console.log(`${id}: FAIL`);
      for (const p of problems) console.log(`  - ${p}`);
    } else {
      console.log(`${id}: ok`);
    }
  }
  if (!named.length) {
    const known = new Set(ids);
    for (const w of worldBundles()) {
      if (!known.has(w.id)) {
        failed++;
        console.log(`${w.id}: FAIL\n  - bundle at ${w.dir} has no recipe in tools/worldbake/worlds/`);
      }
    }
  }
  if (failed) process.exit(1);
}
