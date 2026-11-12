#!/usr/bin/env node
// Readies a `npm run build` output for the public Cloudflare Pages site
// (DEPLOY.md). Run it right after the build, in the same shell:
//
//   node scripts/pages-dist.mjs [distDir]
//
// 1. Refuses a build that isn't the public one: an env file other than the
//    examples in the repo root (Vite reads them), a VITE_ token/key/secret or
//    household labels in the environment, or household labels in the bundle.
// 2. Writes <dist>/_headers from vercel.json's headers, so Pages sends the same
//    CSP and caching as Vercel, plus noindex on preview deployments.
// Pages serves index.html for unknown paths by itself while dist has no
// 404.html, so the SPA needs no _redirects file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET_VAR = /^VITE_[A-Z0-9_]*(TOKEN|KEY|SECRET)[A-Z0-9_]*$/;
const ENV_FILE = /^\.env($|\.)/;
const HOUSEHOLD_IN_BUNDLE = /VITE_HOUSEHOLD_LABELS:"\s*(1|true)\s*"/i;

const truthy = (v) => ['1', 'true'].includes(String(v ?? '').trim().toLowerCase());

/** Why this build environment isn't the public one ([] when it is). */
export function publicEnvProblems(env, rootFiles) {
  const problems = [];
  for (const f of rootFiles) {
    if (ENV_FILE.test(f) && !f.endsWith('.example')) problems.push(`env file in the repo root: ${f}`);
  }
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_VAR.test(k) && String(v ?? '').trim()) problems.push(`${k} is set`);
  }
  if (truthy(env.VITE_HOUSEHOLD_LABELS)) problems.push('VITE_HOUSEHOLD_LABELS is on');
  return problems;
}

/** Bundle files (relative paths) that carry the household labels flag. */
export function householdBundleFiles(dist) {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && HOUSEHOLD_IN_BUNDLE.test(fs.readFileSync(p, 'utf8'))) {
        hits.push(path.relative(dist, p));
      }
    }
  };
  walk(dist);
  return hits;
}

/** vercel.json `source` → a Pages `_headers` URL pattern. */
export function pagesPattern(source) {
  if (source === '/(.*)') return '/*';
  const m = /^(\/[^()*]*?)\(\.\*\)$/.exec(source);
  if (m) return `${m[1]}*`;
  if (/[()*]/.test(source)) throw new Error(`no _headers pattern for vercel.json source ${source}`);
  return source;
}

/** The `_headers` file for vercel.json's `headers` list. */
export function pagesHeaders(vercel) {
  const blocks = (vercel.headers ?? []).map(({ source, headers }) =>
    [pagesPattern(source), ...headers.map(({ key, value }) => `  ${key}: ${value}`)].join('\n'),
  );
  // Preview deployments (<hash>.<project>.pages.dev) stay out of search engines.
  blocks.push(['https://:version.:project.pages.dev/*', '  X-Robots-Tag: noindex'].join('\n'));
  return `${blocks.join('\n\n')}\n`;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dist = path.resolve(process.argv[2] ?? path.join(root, 'dist'));
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    console.error(`pages-dist: no build in ${dist}; run npm run build first`);
    process.exit(1);
  }
  const problems = [
    ...publicEnvProblems(process.env, fs.readdirSync(root)),
    ...householdBundleFiles(dist).map((f) => `household labels in ${f}`),
  ];
  if (fs.existsSync(path.join(dist, '404.html'))) problems.push('dist/404.html would turn off the SPA fallback on Pages');
  if (problems.length) {
    console.error('pages-dist: not a public build:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  fs.writeFileSync(path.join(dist, '_headers'), pagesHeaders(vercel));
  console.log(`pages-dist: public build OK; wrote ${path.relative(root, path.join(dist, '_headers')) || '_headers'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
