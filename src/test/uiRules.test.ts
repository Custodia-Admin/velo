/**
 * Enforces docs/design/UI-RULES.md §2 on on-system UI: tokens only.
 *
 * Checked: everything under src/components/velo/ plus CHECKED_FILES.
 * CHECKED_FILES may grow as legacy files are migrated; it must never shrink.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const CHECKED_DIRS = ['src/components/velo'];
const CHECKED_FILES: string[] = [];

const PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';

const RULES: { name: string; re: RegExp }[] = [
  { name: 'arbitrary value (e.g. text-[11px], h-[3px], shadow-[...])', re: /\b[a-z-]+-\[[^\]]+\]/ },
  { name: 'hex colour literal', re: /#[0-9a-fA-F]{3,8}\b/ },
  { name: 'rgb()/hsl() literal', re: /\b(?:rgba?|hsla?)\(/ },
  {
    name: 'Tailwind palette colour (use semantic tokens)',
    re: new RegExp(`\\b(?:bg|text|border|ring|from|via|to|fill|stroke|outline|divide|shadow)-(?:${PALETTE})-\\d{2,3}\\b`),
  },
  { name: 'off-scale radius (rounded-xl / rounded-2xl / rounded-3xl)', re: /\brounded-(?:xl|2xl|3xl)\b/ },
  { name: 'inline style prop', re: /\bstyle=\{\{/ },
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

const files = [
  ...CHECKED_DIRS.flatMap((d) => walk(join(ROOT, d))),
  ...CHECKED_FILES.map((f) => join(ROOT, f)),
];

describe('UI rules: tokens only in on-system UI', () => {
  it('checks at least the Velo component folder', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [relative(ROOT, f), f] as const))('%s', (_rel, file) => {
    const problems: string[] = [];
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        // Comments may mention forbidden patterns when explaining them.
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
        if (/^\s*\*/.test(code)) return;
        for (const rule of RULES) {
          if (rule.re.test(code)) problems.push(`${i + 1}: ${rule.name}: ${line.trim()}`);
        }
      });
    expect(problems).toEqual([]);
  });
});
