#!/usr/bin/env node
// Publish a remote world bundle to the public R2 bucket:
//
//   node tools/worldbake/publish.mjs <world> [--bucket velo-worlds] [--public-url <base>] [--dry-run]
//
// Uploads tools/worldbake/remote/<world>/ (a bake of a recipe with
// "host": "remote") to `worlds/<world>/<hash>/` in the bucket, hash =
// worldBundles.mjs bundleHash(manifest.json). Every object gets
// `Cache-Control: public, max-age=31536000, immutable`: nothing under a hash
// ever changes, a re-bake publishes a new directory. Layer files go first and
// manifest.json last, so a manifest is never visible before its files. Files
// already published at the same size are skipped, and every file is read
// back from the public URL and checked against the manifest's SHA-256.
//
// Needs `wrangler` logged in to the Cloudflare account that owns the bucket
// (`npx wrangler whoami`; free tier: 10 GB storage, no egress fees). The
// bucket is public through its r2.dev URL with CORS GET/HEAD from any
// origin (docs/worlds/ADDING-A-WORLD.md "Hosting"). WRANGLER overrides the
// command (default `npx --yes wrangler@4`).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './util.mjs';
import { DEFAULT_REMOTE_WORLDS_URL, REMOTE_WORLDS_DIR, bundleComplete, bundleHash } from './worldBundles.mjs';

export const DEFAULT_BUCKET = 'velo-worlds';
export const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Object key prefix of a bundle in the bucket (the public base URL ends in `worlds/`). */
export const objectPrefix = (id, hash) => `worlds/${id}/${hash}/`;

export const contentTypeOf = (file) => (file.endsWith('.json') ? 'application/json' : file.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream');

/**
 * The upload plan for the bundle in `dir`: `{ id, hash, prefix, files }`,
 * files = `[{ path, local, bytes, sha256, contentType }]` with manifest.json
 * last. Throws when the bundle is incomplete or a file doesn't match the
 * manifest (never publish what the loader would reject).
 */
export function publishPlan(dir) {
  if (!bundleComplete(dir)) throw new Error(`${dir} is not a complete bundle (bake it, or run fetchPublished.mjs)`);
  const manifestBytes = readFileSync(join(dir, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const hash = bundleHash(manifestBytes);
  const files = manifest.files.map((f) => {
    const local = join(dir, f.path);
    const got = sha256(readFileSync(local));
    if (got !== f.sha256) throw new Error(`${f.path}: sha256 ${got} is not the manifest's ${f.sha256} (re-bake)`);
    return { path: f.path, local, bytes: f.bytes, sha256: f.sha256, contentType: contentTypeOf(f.path) };
  });
  files.push({
    path: 'manifest.json',
    local: join(dir, 'manifest.json'),
    bytes: manifestBytes.length,
    sha256: sha256(manifestBytes),
    contentType: contentTypeOf('manifest.json'),
  });
  return { id: manifest.id, hash, prefix: objectPrefix(manifest.id, hash), files };
}

async function publishedSize(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok ? Number(res.headers.get('content-length')) : null;
  } catch {
    return null;
  }
}

function wrangler(args) {
  const cmd = (process.env.WRANGLER ?? 'npx --yes wrangler@4').split(' ');
  execFileSync(cmd[0], [...cmd.slice(1), ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
}

export async function publish({ world, bucket = DEFAULT_BUCKET, publicUrl = DEFAULT_REMOTE_WORLDS_URL, dryRun = false, log = console.log }) {
  const plan = publishPlan(join(REMOTE_WORLDS_DIR, world));
  const base = publicUrl.endsWith('/') ? publicUrl : `${publicUrl}/`;
  const url = (f) => `${base}${plan.id}/${plan.hash}/${f.path}`;
  log(`publish: ${plan.id} → ${bucket}/${plan.prefix} (${plan.files.length} files, ${(plan.files.reduce((a, f) => a + f.bytes, 0) / 1e6).toFixed(2)} MB)`);
  for (const f of plan.files) {
    if ((await publishedSize(url(f))) === f.bytes) {
      log(`  ${f.path}: already published`);
      continue;
    }
    log(`  ${f.path}: ${dryRun ? 'would upload' : 'uploading'} ${(f.bytes / 1e6).toFixed(2)} MB (${f.contentType})`);
    if (!dryRun) {
      wrangler(['r2', 'object', 'put', `${bucket}/${plan.prefix}${f.path}`, '--file', f.local, '--content-type', f.contentType, '--cache-control', IMMUTABLE, '--remote']);
    }
  }
  if (dryRun) return plan;
  for (const f of plan.files) {
    const res = await fetch(url(f));
    if (!res.ok) throw new Error(`${url(f)}: HTTP ${res.status} after upload`);
    const got = sha256(Buffer.from(await res.arrayBuffer()));
    if (got !== f.sha256) throw new Error(`${url(f)}: served sha256 ${got} is not ${f.sha256}`);
  }
  log(`publish: verified ${plan.files.length} files at ${base}${plan.id}/${plan.hash}/`);
  return plan;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const bucket = opt('--bucket');
  const publicUrl = opt('--public-url');
  const dryRun = args.includes('--dry-run');
  const world = args.find((a) => !a.startsWith('-'));
  if (!world) {
    console.error('usage: node tools/worldbake/publish.mjs <world> [--bucket name] [--public-url base] [--dry-run]');
    process.exit(2);
  }
  publish({ world, bucket, publicUrl, dryRun }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
