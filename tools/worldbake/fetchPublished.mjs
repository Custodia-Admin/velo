#!/usr/bin/env node
// Download the published remote world bundles next to their committed
// manifests, so the bundle tests (routeFit, routeSurface, water budget…) and
// local rides can read them:
//
//   node tools/worldbake/fetchPublished.mjs [world…] [--base <url>]
//
// For every tools/worldbake/remote/<id>/manifest.json (or only the worlds
// named), each file the manifest lists that is missing or the wrong size is
// fetched from `<base><id>/<hash>/<file>` (base: the public R2 URL,
// worldBundles.mjs) and kept only if its SHA-256 matches the committed
// manifest. The served manifest.json must be byte-identical to the committed
// one. CI runs this before the unit tests (VELO_REQUIRE_REMOTE_WORLDS=1 then
// makes the tests fail on any remote world that is not complete).

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, writeFileAtomic } from './util.mjs';
import { DEFAULT_REMOTE_WORLDS_URL, bundleHash, worldBundles } from './worldBundles.mjs';

async function get(url) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      if (attempt >= 3) throw err;
    }
    if (res?.ok) return Buffer.from(await res.arrayBuffer());
    if (res && (res.status < 500 || attempt >= 3)) throw new Error(`${url}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}

export async function fetchPublished({ worlds = [], base = DEFAULT_REMOTE_WORLDS_URL, log = console.log } = {}) {
  const root = base.endsWith('/') ? base : `${base}/`;
  const remote = worldBundles().filter((w) => w.host === 'remote' && (worlds.length === 0 || worlds.includes(w.id)));
  for (const name of worlds) if (!remote.some((w) => w.id === name)) throw new Error(`no remote world ${name} (tools/worldbake/remote/${name}/manifest.json)`);
  let downloaded = 0;
  for (const w of remote) {
    const manifestBytes = readFileSync(w.manifestPath);
    const hash = bundleHash(manifestBytes);
    const at = `${root}${w.id}/${hash}/`;
    const served = await get(`${at}manifest.json`);
    if (!served.equals(manifestBytes)) throw new Error(`${at}manifest.json differs from ${w.manifestPath}`);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    for (const f of manifest.files) {
      const local = join(w.dir, f.path);
      if (existsSync(local) && statSync(local).size === f.bytes && sha256(readFileSync(local)) === f.sha256) continue;
      const bytes = await get(at + f.path);
      const got = sha256(bytes);
      if (got !== f.sha256) throw new Error(`${at}${f.path}: sha256 ${got}, the manifest says ${f.sha256}`);
      writeFileAtomic(local, bytes);
      downloaded += bytes.length;
      log(`fetched ${w.id}/${f.path} (${(bytes.length / 1e6).toFixed(2)} MB)`);
    }
    log(`${w.id}: complete (${at})`);
  }
  return { worlds: remote.map((w) => w.id), downloaded };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const bi = args.indexOf('--base');
  const base = bi >= 0 ? args.splice(bi, 2)[1] : undefined;
  fetchPublished({ worlds: args, base }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
