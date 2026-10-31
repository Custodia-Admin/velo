import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST_KEYS, validateManifest, WorldLoadError } from './manifest';
import { BUILDING_KINDS, VEGETATION_KINDS } from './loadWorld';
// The bake's own tables; the binary layers store indices into them.
import * as bakeVectors from '../../../tools/worldbake/buildVectors.mjs';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const schema = JSON.parse(read('../../../tools/worldbake/manifest.schema.json'));
const shipped = JSON.parse(read('../../../public/worlds/perugia/manifest.json'));

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(WorldLoadError);
    return (e as WorldLoadError).code;
  }
}

describe('world manifest', () => {
  it('validates the shipped Perugia manifest', () => {
    const m = validateManifest(shipped);
    expect(m.id).toBe('perugia');
    expect(m.credits.map((c) => c.id)).toEqual(expect.arrayContaining(['osm', 'terrain-tiles', 'copernicus-glo90']));
  });

  it('agrees with tools/worldbake/manifest.schema.json on the required keys', () => {
    expect(schema.required).toEqual([...MANIFEST_KEYS]);
    expect(schema.properties.version.const).toBe(1);
    expect(schema.properties.format.const).toBe('velo-world');
    for (const k of Object.keys(shipped)) expect(schema.properties).toHaveProperty(k);
  });

  it('agrees with the bake on binary kind tables', () => {
    expect([...BUILDING_KINDS]).toEqual(bakeVectors.BUILDING_KINDS);
    expect([...VEGETATION_KINDS]).toEqual(bakeVectors.VEGETATION_KINDS);
  });

  it('rejects wrong format/version as "unsupported"', () => {
    expect(codeOf(() => validateManifest({ ...shipped, format: 'other' }))).toBe('unsupported');
    expect(codeOf(() => validateManifest({ ...shipped, version: 2 }))).toBe('unsupported');
    expect(codeOf(() => validateManifest({ ...shipped, heightfield: { ...shipped.heightfield, encoding: 'f32' } }))).toBe('unsupported');
  });

  it('rejects structural damage as "corrupt"', () => {
    const without = (k: string) => {
      const m = { ...shipped };
      delete m[k];
      return m;
    };
    expect(codeOf(() => validateManifest(null))).toBe('corrupt');
    expect(codeOf(() => validateManifest(without('credits')))).toBe('corrupt');
    expect(codeOf(() => validateManifest({ ...shipped, credits: [] }))).toBe('corrupt');
    expect(codeOf(() => validateManifest({ ...shipped, defaultMood: 'nope' }))).toBe('corrupt');
    expect(codeOf(() => validateManifest({ ...shipped, extent: { ...shipped.extent, xMax: shipped.extent.xMax + 1 } }))).toBe('corrupt');
    expect(
      codeOf(() => validateManifest({ ...shipped, files: [...shipped.files, { ...shipped.files[0] }] })),
    ).toBe('corrupt'); // duplicate path
    expect(
      codeOf(() => validateManifest({ ...shipped, files: [{ ...shipped.files[0], path: '../escape' }, ...shipped.files.slice(1)] })),
    ).toBe('corrupt');
    expect(codeOf(() => validateManifest({ ...shipped, files: [{ ...shipped.files[0], sha256: 'xyz' }, ...shipped.files.slice(1)] }))).toBe(
      'corrupt',
    );
    expect(codeOf(() => validateManifest({ ...shipped, pois: [{ ...shipped.pois[0], kind: 'castle' }] }))).toBe('corrupt');
  });
});
