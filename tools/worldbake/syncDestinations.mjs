#!/usr/bin/env node
// Copy the world-derived fields of every destination manifest from its baked
// world: `node tools/worldbake/syncDestinations.mjs [--check] [--worlds <dir>]`.
//
// A destination (src/lib/world/destinations/<id>.json, docs/worlds/DESTINATIONS.md)
// links at most one world. Its `world.bbox`, `world.routes`, `moods`,
// `defaultMood`, `pois` (the world's towns) and `credits` come from that
// world's manifest.json, so Home and the ride agree with the bundle without
// a download. bake.mjs runs this after writing a bundle; `--check` exits 1
// when a manifest is out of step (destinations.test.ts checks the same).
// Destinations without a world are left as they are.
//
// A world shipped in public/worlds/<id>/ gets `dir` "<id>/". A remote world
// (tools/worldbake/remote/<id>/, published off-repo by publish.mjs) gets
// `host` "remote" and `dir` "<id>/<hash>/" (worldBundles.mjs bundleHash), the
// content-hashed directory it is served from. To link a new world, set the
// destination's `world` to `{ "id": "<world id>" }` and run this.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createProjection } from '../../src/lib/world/projection.ts';
import { here } from './util.mjs';
import { BUNDLED_WORLDS_DIR, REMOTE_WORLDS_DIR, remoteDir, worldBundle } from './worldBundles.mjs';

const ROOT = resolve(here(import.meta.url), '../..');
export const DESTINATIONS_DIR = join(ROOT, 'src/lib/world/destinations');

/** Headline places: the world's towns (POI rank 3), by name, at most this many. */
export const HEADLINE_POIS = 8;

const round5 = (v) => Math.round(v * 1e5) / 1e5;

/**
 * The destination with its world-derived fields taken from `world` (a
 * velo-world manifest). `remote`, for a world published off-repo, is
 * `{ dir }`: its content-hashed "<id>/<hash>/" directory.
 */
export function destinationFromWorld(dest, world, remote = null) {
  if (!dest.world || dest.world.id !== world.id) throw new Error(`destination ${dest.id} does not link world ${world.id}`);
  const projection = createProjection(world.projection);
  const pois = world.pois
    .filter((p) => (p.rank ?? (p.kind === 'town' ? 3 : 1)) >= 3)
    .map((p) => {
      const [lat, lon] = projection.inverse(p.x, p.y);
      return { name: p.name, kind: p.kind, lat: round5(lat), lon: round5(lon) };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.lat - b.lat)
    .slice(0, HEADLINE_POIS);
  const worldRoutes = world.routes.map((r) => r.id);
  // Routes the world draws lead (in bake order); the rest keep their authored order.
  const routes = [...worldRoutes, ...dest.routes.filter((r) => !worldRoutes.includes(r))];
  return {
    format: dest.format,
    version: dest.version,
    id: dest.id,
    name: dest.name,
    role: dest.role,
    order: dest.order,
    place: dest.place,
    detail: dest.detail,
    world: remote
      ? { id: world.id, dir: remote.dir, host: 'remote', bbox: world.bbox, routes: worldRoutes }
      : { id: world.id, dir: `${world.id}/`, bbox: world.bbox, routes: worldRoutes },
    routes,
    moods: world.moods,
    defaultMood: world.defaultMood,
    pois,
    credits: world.credits,
  };
}

export const serialize = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

/**
 * The destination as synced from its world's bundle on disk (public/worlds
 * or tools/worldbake/remote), or the destination unchanged without a world.
 */
export function syncedDestination(dest, { worldsDir = BUNDLED_WORLDS_DIR, remoteDir: remoteRoot = REMOTE_WORLDS_DIR } = {}) {
  if (!dest.world) return dest;
  const bundle = worldBundle(dest.world.id, { bundled: worldsDir, remote: remoteRoot });
  if (!bundle) throw new Error(`destination ${dest.id}: world ${dest.world.id} has no manifest.json in ${worldsDir} or ${remoteRoot}`);
  const bytes = readFileSync(bundle.manifestPath);
  const remote = bundle.host === 'remote' ? { dir: remoteDir(dest.world.id, bytes) } : null;
  return destinationFromWorld(dest, JSON.parse(bytes.toString('utf8')), remote);
}

/** Sync every destination that links a world (public/worlds or tools/worldbake/remote). Returns the changed file names. */
export function syncDestinations({ worldsDir = BUNDLED_WORLDS_DIR, remoteDir: remoteRoot = REMOTE_WORLDS_DIR, check = false, log = () => {} } = {}) {
  const changed = [];
  for (const file of readdirSync(DESTINATIONS_DIR).filter((f) => f.endsWith('.json')).sort()) {
    const path = join(DESTINATIONS_DIR, file);
    const before = readFileSync(path, 'utf8');
    const dest = JSON.parse(before);
    if (!dest.world) continue;
    const after = serialize(syncedDestination(dest, { worldsDir, remoteDir: remoteRoot }));
    if (after !== before) {
      changed.push(file);
      if (!check) writeFileSync(path, after);
      log(`destinations: ${file} ${check ? 'is out of step with' : 'synced from'} world ${dest.world.id}'s manifest.json`);
    }
  }
  return changed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const wi = args.indexOf('--worlds');
  const changed = syncDestinations({ check, worldsDir: wi >= 0 ? resolve(args[wi + 1]) : undefined, log: console.log });
  if (check && changed.length) process.exit(1);
  if (!changed.length) console.log('destinations: all in step');
}
