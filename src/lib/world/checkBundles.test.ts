/**
 * tools/worldbake/checkBundles.mjs: the offline bundle check CI's
 * bake-validate workflow runs. Every shipped bundle passes, and each kind of
 * damage it exists to catch is caught.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import { checkBundleFiles, checkWorld, recipeIds } from '../../../tools/worldbake/checkBundles.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'velo-checkbundles-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A two-file bundle (one gzip layer, one plain) whose manifest is right. */
function tinyBundle() {
  const dir = scratch();
  const content = Buffer.from(JSON.stringify({ roads: [] }));
  const gz = gzipSync(content);
  const plain = Buffer.from('plain layer');
  writeFileSync(join(dir, 'roads.json.gz'), gz);
  writeFileSync(join(dir, 'extra.bin'), plain);
  const files = [
    { path: 'roads.json.gz', bytes: gz.length, sha256: sha(gz), compression: 'gzip', contentBytes: content.length, contentSha256: sha(content) },
    { path: 'extra.bin', bytes: plain.length, sha256: sha(plain) },
  ];
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ files }));
  return dir;
}

describe('checkBundles', () => {
  it('passes a sound bundle', () => {
    expect(checkBundleFiles(tinyBundle())).toEqual([]);
  });

  it('catches a changed byte, a missing file, a stray file and bad gzip content', () => {
    const changed = tinyBundle();
    const b = readFileSync(join(changed, 'extra.bin'));
    b[0] ^= 1;
    writeFileSync(join(changed, 'extra.bin'), b);
    expect(checkBundleFiles(changed)).toEqual(['extra.bin: SHA-256 differs from the manifest']);

    const missing = tinyBundle();
    rmSync(join(missing, 'roads.json.gz'));
    expect(checkBundleFiles(missing)).toEqual(['roads.json.gz: missing']);

    const stray = tinyBundle();
    writeFileSync(join(stray, 'notes.txt'), 'x');
    expect(checkBundleFiles(stray)).toEqual(['notes.txt: not listed in the manifest']);

    // Same compressed size and hash recorded, but the inflated content was recorded wrong.
    const content = tinyBundle();
    const m = JSON.parse(readFileSync(join(content, 'manifest.json'), 'utf8'));
    m.files[0].contentSha256 = '0'.repeat(64);
    writeFileSync(join(content, 'manifest.json'), JSON.stringify(m));
    expect(checkBundleFiles(content)).toEqual(['roads.json.gz: inflated SHA-256 differs from the manifest']);
  });

  it('passes every shipped world bundled with the app', () => {
    expect(recipeIds()).toEqual(expect.arrayContaining(['lugano', 'perugia']));
    for (const id of ['perugia', 'lugano']) expect(checkWorld(id), id).toEqual([]);
  });

  it('fails a bundle whose recipe changed since the bake', () => {
    const root = scratch();
    mkdirSync(join(root, 'tools/worldbake/worlds'), { recursive: true });
    mkdirSync(join(root, 'public/worlds'), { recursive: true });
    const recipe = JSON.parse(readFileSync(join(ROOT, 'tools/worldbake/worlds/perugia.json'), 'utf8'));
    symlinkSync(join(ROOT, 'public/worlds/perugia'), join(root, 'public/worlds/perugia'));
    cpSync(join(ROOT, 'tools/worldbake/worlds/perugia.json'), join(root, 'tools/worldbake/worlds/perugia.json'));
    expect(checkWorld('perugia', { root })).toEqual([]);
    writeFileSync(join(root, 'tools/worldbake/worlds/perugia.json'), JSON.stringify({ ...recipe, osmDate: '2020-01-01T00:00:00Z' }));
    const problems = checkWorld('perugia', { root });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/baked from another recipe .*re-bake/);
  });
});
