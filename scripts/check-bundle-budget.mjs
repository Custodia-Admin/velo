#!/usr/bin/env node
// Bundle budget for the app shell (blueprint P1.2): the JS a browser must
// download before /app can run — the entry module from dist/index.html, its
// modulepreloads, and every chunk they import statically — must stay under
// the budget (gzip), and none of it may be Cesium. Run after `npm run build`.
//
//   node scripts/check-bundle-budget.mjs [distDir] [budgetKb]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dist = path.resolve(process.argv[2] ?? 'dist');
const budgetKb = Number(process.argv[3] ?? 600);

// Strings that only Cesium's own code contains.
const CESIUM_MARKERS = ['api.cesium.com', 'CesiumWidget'];

const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const entries = [
  ...html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g),
  ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g),
].map((m) => m[1]);
const classic = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((src) => !entries.includes(src));

const resolveAsset = (from, spec) =>
  spec.startsWith('/') ? path.join(dist, spec) : path.resolve(path.dirname(from), spec);

// Static imports in Rollup ES output: `import{a}from"./x.js"`, `import"./x.js"`,
// `export{a}from"./x.js"`. Dynamic `import("./x.js")` is deliberately excluded.
const staticRe = /(?:\bfrom\s*|\bimport\s*)["'](\.{1,2}\/[^"']+\.js)["']/g;

const seen = new Set();
const queue = [...entries, ...classic].map((e) => resolveAsset(path.join(dist, 'index.html'), e));
while (queue.length) {
  const file = queue.shift();
  if (seen.has(file) || !fs.existsSync(file)) continue;
  seen.add(file);
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(staticRe)) queue.push(resolveAsset(file, m[1]));
}

let total = 0;
const rows = [];
const cesiumInInitial = [];
for (const file of seen) {
  const buf = fs.readFileSync(file);
  const gz = zlib.gzipSync(buf, { level: 9 }).length;
  total += gz;
  rows.push([path.relative(dist, file), buf.length, gz]);
  const text = buf.toString('utf8');
  if (CESIUM_MARKERS.some((m) => text.includes(m))) cesiumInInitial.push(path.relative(dist, file));
}

// Sanity: the markers must exist somewhere in the build, or the check is vacuous.
const allJs = fs.readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.js'));
const cesiumChunks = allJs.filter((f) => {
  const t = fs.readFileSync(path.join(dist, 'assets', f), 'utf8');
  return CESIUM_MARKERS.some((m) => t.includes(m));
});

const kb = (n) => (n / 1024).toFixed(1).padStart(8);
console.log('Initial JS for /app (entry + modulepreload + static imports):');
for (const [f, raw, gz] of rows.sort((a, b) => b[2] - a[2])) {
  console.log(`  ${f.padEnd(48)} ${kb(raw)} kB  gzip ${kb(gz)} kB`);
}
console.log(`  ${'TOTAL'.padEnd(48)} ${' '.repeat(11)}  gzip ${kb(total)} kB  (budget ${budgetKb} kB)`);
console.log(`Cesium chunks (lazy): ${cesiumChunks.join(', ') || 'none found'}`);

let failed = false;
if (total / 1024 > budgetKb) {
  console.error(`FAIL: initial JS ${(total / 1024).toFixed(1)} kB gzip > ${budgetKb} kB`);
  failed = true;
}
if (cesiumInInitial.length) {
  console.error(`FAIL: Cesium code in the initial bundle: ${cesiumInInitial.join(', ')}`);
  failed = true;
}
if (classic.length) {
  console.error(`FAIL: classic <script src> in index.html (eager global): ${classic.join(', ')}`);
  failed = true;
}
if (!cesiumChunks.length) {
  console.error('FAIL: no Cesium chunk found in the build — marker check is vacuous');
  failed = true;
}
if (failed) process.exit(1);
console.log('OK');
