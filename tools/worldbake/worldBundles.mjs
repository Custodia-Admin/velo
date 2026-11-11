// Where baked world bundles live on disk, and the content hash a remote one
// is published under. Node-only (bake, sync, publish, fetch tools and the
// bundle tests share it).
//
//   public/worlds/<id>/            shipped with the app (Perugia, Lugano)
//   tools/worldbake/remote/<id>/   published off-repo (recipe "host": "remote"):
//                                  manifest.json is committed, the layer files
//                                  are git-ignored (publish.mjs uploads them,
//                                  fetchPublished.mjs downloads them again)
//
// A remote bundle is served from `<remote base>/<id>/<hash>/`, hash = the
// first 16 hex digits of sha256(manifest.json bytes). The manifest pins every
// file's sha256, so the hash names the whole bundle: a re-bake that changes
// one byte anywhere lands under a new directory, and nothing published ever
// changes in place (clients cache it forever).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { here, sha256 } from './util.mjs';

const ROOT = resolve(here(import.meta.url), '../..');
export const BUNDLED_WORLDS_DIR = join(ROOT, 'public/worlds');
export const REMOTE_WORLDS_DIR = join(ROOT, 'tools/worldbake/remote');
export const REMOTE_HASH_DIGITS = 16;
/** Public base URL of the remote bundles (the R2 bucket's r2.dev URL); equals catalog.ts DEFAULT_REMOTE_WORLDS_URL (a test pins it). */
export const DEFAULT_REMOTE_WORLDS_URL = 'https://pub-26367e714cf944b59b97a34ecb76922b.r2.dev/worlds/';

/** The directory hash of a remote bundle: sha256(manifest.json bytes), first 16 hex digits. */
export function bundleHash(manifestBytes) {
  return sha256(manifestBytes).slice(0, REMOTE_HASH_DIGITS);
}

/** `<id>/<hash>/`, the bundle's directory under the remote worlds base URL. */
export function remoteDir(id, manifestBytes) {
  return `${id}/${bundleHash(manifestBytes)}/`;
}

/**
 * True when every file the manifest lists is on disk at its stored size
 * (a remote bundle's layer files are absent until baked or fetched).
 */
export function bundleComplete(dir) {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) return false;
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  return manifest.files.every((f) => {
    const p = join(dir, f.path);
    return existsSync(p) && statSync(p).size === f.bytes;
  });
}

/**
 * Every baked world on disk: `{ id, host, dir, manifestPath, complete }`,
 * host 'app' (public/worlds) or 'remote' (tools/worldbake/remote), by id.
 */
export function worldBundles({ bundled = BUNDLED_WORLDS_DIR, remote = REMOTE_WORLDS_DIR } = {}) {
  const list = (root, host) =>
    existsSync(root)
      ? readdirSync(root)
          .filter((id) => existsSync(join(root, id, 'manifest.json')))
          .map((id) => {
            const dir = join(root, id);
            return { id, host, dir, manifestPath: join(dir, 'manifest.json'), complete: bundleComplete(dir) };
          })
      : [];
  const all = [...list(bundled, 'app'), ...list(remote, 'remote')].sort((a, b) => a.id.localeCompare(b.id));
  for (let i = 1; i < all.length; i++) {
    if (all[i].id === all[i - 1].id) throw new Error(`world ${all[i].id} is both in ${bundled} and ${remote}`);
  }
  return all;
}

/** The bundle of world `id`, or null. */
export function worldBundle(id, opts) {
  return worldBundles(opts).find((w) => w.id === id) ?? null;
}

/**
 * The bundles a test can read in full: every public/worlds one, and every
 * remote one whose layer files are on disk (baked here, or downloaded by
 * fetchPublished.mjs). With VELO_REQUIRE_REMOTE_WORLDS=1 (CI runs
 * fetchPublished.mjs first) a remote world without its files throws, so no
 * shipped world goes untested.
 */
export function readableWorldBundles(opts, env = process.env) {
  const all = worldBundles(opts);
  const missing = all.filter((w) => !w.complete).map((w) => w.id);
  if (missing.length && env.VELO_REQUIRE_REMOTE_WORLDS === '1') {
    throw new Error(`world files missing for ${missing.join(', ')}: run node tools/worldbake/fetchPublished.mjs`);
  }
  return all.filter((w) => w.complete);
}
