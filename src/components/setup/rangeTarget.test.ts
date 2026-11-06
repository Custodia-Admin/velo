/**
 * Sliders are 40 px touch targets (UI-RULES §5), and stay so.
 *
 * The base style in src/index.css draws every range input's track at
 * 0.375rem. Two things keep the on-system sliders (Build your own ride's
 * distance and heading, Home's "Hills feel") at 40 px: the base rule sits
 * at zero specificity (`:where(...)`), so it loses to a height utility; and
 * each slider carries one (`h-10`). Drop either and the slider silently
 * goes back to a 6 px target: `input[type='range']` (0,1,1) beats `.h-10`
 * (0,1,0) whatever the order, and a slider without `h-10` takes the base
 * height. Review of PR #65 @7101401, N2 (mutants X7, X17, X8).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Innermost CSS rules (selector + body), comments stripped. */
function cssRules(css: string): { selector: string; body: string }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}

/** A selector with every `:where(...)` group (zero specificity) taken out. */
function withoutWhere(selector: string): string {
  let out = '';
  for (let i = 0; i < selector.length; i++) {
    if (selector.startsWith(':where(', i)) {
      let depth = 0;
      for (i += ':where'.length; i < selector.length; i++) {
        if (selector[i] === '(') depth++;
        else if (selector[i] === ')' && --depth === 0) break;
      }
      continue;
    }
    out += selector[i];
  }
  return out;
}

const RANGE = /input\[type=['"]?range['"]?\]/;

/** Every `<input … type="range" …/>` in a TSX source, as its JSX text. */
function rangeInputs(src: string): string[] {
  return [...src.matchAll(/<input\b[\s\S]*?\/>/g)].map((m) => m[0]).filter((jsx) => /type="range"/.test(jsx));
}

const ON_SYSTEM_DIRS = ['src/components/setup', 'src/components/velo'];

describe('sliders are 40 px touch targets', () => {
  const rules = cssRules(read('src/index.css'));

  it('the base range style sits at zero specificity, so a height utility on the slider wins', () => {
    const range = rules.filter((r) => RANGE.test(r.selector));
    const sized = range.filter((r) => /(^|[;\s])(min-)?height\s*:/.test(r.body));
    expect(sized.length).toBeGreaterThan(0);
    for (const r of sized) {
      expect(withoutWhere(r.selector), `"${r.selector}" sets a height above zero specificity`).not.toMatch(RANGE);
    }
    expect(sized.map((r) => r.selector)).toContain(":where(input[type='range'])");
  });

  it('every on-system slider is h-10 (Build your own ride\'s distance and heading, Home\'s "Hills feel")', () => {
    const found: Record<string, number> = {};
    for (const dir of ON_SYSTEM_DIRS) {
      for (const f of readdirSync(join(ROOT, dir)).filter((n) => n.endsWith('.tsx'))) {
        for (const jsx of rangeInputs(read(`${dir}/${f}`))) {
          found[f] = (found[f] ?? 0) + 1;
          const cls = /className="([^"]*)"/.exec(jsx)?.[1] ?? '';
          expect(cls.split(/\s+/), `${dir}/${f}: a range input without h-10`).toContain('h-10');
        }
      }
    }
    // RangeRow (distance + heading share it) and the comfort slider: a slider moved elsewhere fails here.
    expect(found).toMatchObject({ 'RideSetupWizard.tsx': 1, 'RiderPanel.tsx': 1 });
  });

  it('search fields draw no second, tiny native clear button beside their own h-10 one', () => {
    const cancel = rules.find((r) => /input\[type=['"]?search['"]?\]::-webkit-search-cancel-button/.test(r.selector));
    expect(cancel?.body).toMatch(/(^|[;\s])appearance\s*:\s*none/);
    expect(cancel?.body).toMatch(/-webkit-appearance\s*:\s*none/);
  });
});
