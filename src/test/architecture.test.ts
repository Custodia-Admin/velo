/**
 * Architecture guard for the renderer seam (docs/architecture/VELO-V2-BLUEPRINT.md
 * §P1.2 and invariant 3): the ride domain (src/lib/ride) and world data
 * (src/lib/world) never touch a rendering engine; the app shell and the ride
 * route reach Cesium only through a dynamic import() of the photoreal
 * renderer; ride features use RideView / WorldRenderer, never a renderer
 * module directly.
 *
 * Works on source text (no bundler): it walks `@/` and relative imports.
 */
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import fs from 'node:fs';
import path from 'node:path';

import { CAMERA_MODES } from '@/lib/cesiumCameras';
import { WORLD_CAMERA_MODES } from '@/lib/world/renderer';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const rel = (f: string) => path.relative(ROOT, f);

const ENGINE = /^(cesium|three|postprocessing|@react-three\/)/;

interface ImportRef {
  spec: string;
  /** `import type …` / `import { type A }` only — erased at build time. */
  typeOnly: boolean;
  /** `import('…')` — a lazy chunk boundary. */
  dynamic: boolean;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function importsOf(file: string): ImportRef[] {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const out: ImportRef[] = [];
  const staticRe =
    /(?:^|[;\n}])\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]|(?:^|[;\n])\s*import\s+['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(staticRe)) {
    if (m[5]) {
      out.push({ spec: m[5], typeOnly: false, dynamic: false });
      continue;
    }
    const clause = (m[3] ?? '').trim();
    const braces = clause.match(/^\{([\s\S]*)\}$/);
    const allTypeNames =
      !!braces &&
      braces[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .every((s) => s.startsWith('type '));
    out.push({ spec: m[4], typeOnly: !!m[2] || allTypeNames, dynamic: false });
  }
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.push({ spec: m[1], typeOnly: false, dynamic: true });
  }
  return out;
}

function resolveLocal(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/**
 * Walk the import graph from `entries`; return every engine import found,
 * with the chain that reaches it. `follow` decides which edges count.
 */
function engineImportsReachable(
  entries: string[],
  follow: (ref: ImportRef) => boolean,
): string[] {
  const parent = new Map<string, string | null>(entries.map((e) => [e, null]));
  const queue = [...entries];
  const hits: string[] = [];
  const chain = (f: string) => {
    const c: string[] = [];
    for (let x: string | null | undefined = f; x; x = parent.get(x)) c.unshift(rel(x));
    return c.join(' → ');
  };
  while (queue.length) {
    const file = queue.shift()!;
    for (const ref of importsOf(file)) {
      if (!follow(ref)) continue;
      if (ENGINE.test(ref.spec)) {
        hits.push(`${chain(file)} imports '${ref.spec}'`);
        continue;
      }
      const next = resolveLocal(file, ref.spec);
      if (next && !parent.has(next)) {
        parent.set(next, file);
        queue.push(next);
      }
    }
  }
  return hits;
}

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return filesUnder(p);
    return /\.(ts|tsx)$/.test(d.name) ? [p] : [];
  });
}

const isTest = (f: string) => /\.test\.tsx?$/.test(f);
const AGNOSTIC_DIRS = [path.join(SRC, 'lib/ride'), path.join(SRC, 'lib/world')];
const agnosticFiles = AGNOSTIC_DIRS.flatMap(filesUnder);

describe('renderer seam: lib/ride and lib/world are engine-free', () => {
  it('the seam files exist', () => {
    expect(agnosticFiles.map(rel)).toEqual(
      expect.arrayContaining(['src/lib/ride/rideSim.ts', 'src/lib/world/renderer.ts']),
    );
  });

  it('no file there imports Cesium or three.js in any form (static, type, dynamic)', () => {
    const direct = agnosticFiles.flatMap((f) =>
      importsOf(f)
        .filter((r) => ENGINE.test(r.spec) || /(^|\/)renderers\//.test(r.spec))
        .map((r) => `${rel(f)} imports '${r.spec}'`),
    );
    expect(direct).toEqual([]);
  });

  it('nothing they depend on (transitively, any import kind) reaches an engine', () => {
    const hits = engineImportsReachable(agnosticFiles.filter((f) => !isTest(f)), () => true);
    expect(hits).toEqual([]);
  });

  it('eslint no-restricted-imports enforces it in both directories (and only there)', async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const probe = "import * as Cesium from 'cesium';\nexport const x = Cesium;\n";
    const ruleHits = async (filePath: string) => {
      const [res] = await eslint.lintText(probe, { filePath: path.join(ROOT, filePath) });
      return res.messages.filter((m) => m.ruleId === 'no-restricted-imports').length;
    };
    expect(await ruleHits('src/lib/ride/__probe.ts')).toBe(1);
    expect(await ruleHits('src/lib/world/__probe.ts')).toBe(1);
    expect(await ruleHits('src/renderers/cesium/__probe.ts')).toBe(0);

    const three = "import * as THREE from 'three';\nexport const y = THREE;\n";
    const [res] = await eslint.lintText(three, { filePath: path.join(ROOT, 'src/lib/world/__probe.ts') });
    expect(res.messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true);
  }, 30_000);
});

describe('renderer seam: Cesium loads lazily', () => {
  // What ends up in a chunk: value imports, static only.
  const staticValue = (r: ImportRef) => !r.typeOnly && !r.dynamic;

  it('the app shell (/app initial bundle) has no static path to Cesium', () => {
    expect(engineImportsReachable([path.join(SRC, 'main.tsx')], staticValue)).toEqual([]);
  });

  it('the ride and replay routes reach Cesium only through import()', () => {
    for (const route of ['routes/Ride.tsx', 'routes/Replay.tsx']) {
      expect(engineImportsReachable([path.join(SRC, route)], staticValue)).toEqual([]);
    }
  });

  it('the photoreal renderer is the Cesium path (sanity: the walker sees Cesium there)', () => {
    const view = path.join(SRC, 'renderers/cesium/CesiumWorldView.tsx');
    expect(engineImportsReachable([view], staticValue).length).toBeGreaterThan(0);
  });
});

describe('renderer seam: ride features go through RideView / WorldRenderer', () => {
  const appFiles = filesUnder(SRC).filter((f) => !isTest(f));

  it('only the renderer registry (and the legacy shim) import a renderer module', () => {
    const allowed = new Set(
      ['src/renderers/registry.ts', 'src/components/ride/CesiumViewer.tsx'].map((f) =>
        path.join(ROOT, f),
      ),
    );
    const offenders = appFiles
      .filter((f) => !f.startsWith(path.join(SRC, 'renderers') + path.sep) && !allowed.has(f))
      .flatMap((f) =>
        importsOf(f)
          .filter((r) => /^@\/renderers\/(cesium|three)\b/.test(r.spec))
          .map((r) => `${rel(f)} imports '${r.spec}'`),
      );
    expect(offenders).toEqual([]);
  });

  it('nothing in the app imports the old CesiumViewer path any more', () => {
    const offenders = appFiles.flatMap((f) =>
      importsOf(f)
        .filter((r) => r.spec === '@/components/ride/CesiumViewer')
        .map(() => rel(f)),
    );
    expect(offenders).toEqual([]);
  });

  it('the old path still re-exports the moved view (back-compat shim)', async () => {
    const shim = fs.readFileSync(path.join(SRC, 'components/ride/CesiumViewer.tsx'), 'utf8');
    expect(shim).toMatch(/CesiumWorldView as CesiumViewer/);
    expect(shim).toContain("'@/renderers/cesium/CesiumWorldView'");
  });

  it('renderer camera modes match the persisted camera setting', () => {
    expect([...WORLD_CAMERA_MODES]).toEqual([...CAMERA_MODES]);
  });
});
