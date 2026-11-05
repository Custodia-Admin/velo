// Blueprint §P1.3 v2 terrain accuracy check (criterion and constants in
// p13Criterion.mjs): the baked heightfield against an independent reference,
// Copernicus GLO-90 via the Open-Meteo elevation API (key-free, CC-BY 4.0).
// Sample points come from a seeded RNG, so the same recipe always checks the
// same places. Not part of the bundle: the block lands in the recipe's
// `validation` and in tools/worldbake/reports/<id>.json.
//
// Open-Meteo answers with one stored GLO-90 node, not an interpolation: on
// the Ticino slopes the answer jumps 70 m between neighbouring 3″ cells
// (45.95159 → 450 m, 45.95168 → 380 m at 8.91634), so on steep ground a
// comparison at the sample mostly measures where in its 90 m cell the sample
// fell. The gate reads the heightfield at the node instead (`glo90-nw-node`,
// the north-west corner of the sample's cell) and compares it with the
// sample's answer: `registered_rms_m` gates; `point_rms_m` (heightfield at
// the sample itself) and `max_abs_registered_err_m` are reported only.
//
// Protocol (unchanged from v1): 50 points uniform over the extent from
// mulberry32(sample_seed), x then y per point, inverse-projected and rounded
// to 1e-5°, one batched Open-Meteo query. A second batched query asks a
// quarter cell inside each node's cell: the report's per-point
// `nodeOpenMeteo`, a diagnostic showing whether Open-Meteo answered with the
// node the rule picked (`diagnostics.node_answer_mismatches`).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { P13_SAMPLE_COUNT, glo90Node, roundHalfUp, steepFraction, validationBlock, validationInputs, withValidationBlock } from './p13Criterion.mjs';
import { cachedFetch, ensureDir, rng, sha256 } from './util.mjs';

/** Copernicus GLO-90 node spacing below 50° latitude: 3 arc-seconds. */
const NODE_DEG = 1 / 1200;

/** The Open-Meteo elevation URL for a batch of points (coordinates at 1e-5°). */
export function openMeteoUrl(pts) {
  return (
    'https://api.open-meteo.com/v1/elevation?latitude=' +
    pts.map((p) => p.lat.toFixed(5)).join(',') +
    '&longitude=' +
    pts.map((p) => p.lon.toFixed(5)).join(',')
  );
}

/** Its cache file name under <cache>/<world>/open-meteo/. */
export const openMeteoCacheKey = (url) => `${sha256(url).slice(0, 16)}.json`;

/** Where the diagnostic second query asks for each node: a quarter cell inside the node's own cell. */
export const nodeQueryPoints = (nodes) => nodes.map((n) => ({ lat: n.lat - NODE_DEG / 4, lon: n.lon + NODE_DEG / 4 }));

async function openMeteo(pts, cacheDir) {
  const url = openMeteoUrl(pts);
  const dir = join(cacheDir, 'open-meteo');
  ensureDir(dir);
  const { body } = await cachedFetch(dir, openMeteoCacheKey(url), url, {}, { label: 'open-meteo elevation' });
  const ref = JSON.parse(body.toString('utf8')).elevation;
  if (!Array.isArray(ref) || ref.length !== pts.length) throw new Error('open-meteo: unexpected elevation response');
  return ref;
}

const rms = (diffs) => Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length);
const mean = (diffs) => diffs.reduce((s, d) => s + d, 0) / diffs.length;
const maxAbs = (diffs) => diffs.reduce((m, d) => Math.max(m, Math.abs(d)), 0);

/** The P1.3.2 sample points: P13_SAMPLE_COUNT uniform draws over the extent, rounded to 1e-5°. */
export function samplePoints({ projection, extent, sampleSeed }) {
  const rand = rng(sampleSeed);
  const pts = [];
  for (let i = 0; i < P13_SAMPLE_COUNT; i++) {
    const x = extent.xMin + rand() * (extent.xMax - extent.xMin);
    const y = extent.yMin + rand() * (extent.yMax - extent.yMin);
    const [lat, lon] = projection.inverse(x, y);
    pts.push({ lat: +lat.toFixed(5), lon: +lon.toFixed(5) });
  }
  return pts;
}

/**
 * Run the check. `demSource` is the recipe's `dem.source` id (demSourceOf).
 * Returns `block`, the P1.3.10 validation block for the recipe, and
 * `report`, the same block plus non-gating diagnostics and the per-point rows.
 */
export async function validateHeightfield({ hf, projection, extent, recipe, demSource, cacheDir, routeMask }) {
  const inputs = validationInputs(recipe.validation);
  const pts = samplePoints({ projection, extent, sampleSeed: inputs.sampleSeed });
  const ref = await openMeteo(pts, cacheDir);
  const nodes = pts.map((p) => glo90Node(p.lat, p.lon));
  const refNode = await openMeteo(nodeQueryPoints(nodes), cacheDir);

  const rows = [];
  const diffsPoint = [];
  const diffsReg = [];
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = projection.forward(pts[i].lat, pts[i].lon);
    const h = hf.sampleHeight(x, y);
    const [nx, ny] = projection.forward(nodes[i].lat, nodes[i].lon);
    const hn = hf.sampleHeight(nx, ny);
    diffsPoint.push(h - ref[i]);
    diffsReg.push(hn - ref[i]);
    rows.push({
      lat: pts[i].lat,
      lon: pts[i].lon,
      openMeteo: ref[i],
      heightfield: roundHalfUp(h, 2),
      nodeLat: +nodes[i].lat.toFixed(8),
      nodeLon: +nodes[i].lon.toFixed(8),
      nodeHeightfield: roundHalfUp(hn, 2),
      nodeOpenMeteo: refNode[i],
      onRouteCorridor: routeMask?.(x, y) ?? false,
    });
  }
  const block = validationBlock({
    inputs,
    demSource,
    steepFraction: steepFraction(hf),
    registeredRmsM: rms(diffsReg),
    pointRmsM: rms(diffsPoint),
    maxAbsRegisteredErrM: maxAbs(diffsReg),
  });
  return {
    block,
    report: {
      ...block,
      diagnostics: {
        note: 'not gating (blueprint §P1.3.4)',
        registered_mean_bias_m: roundHalfUp(mean(diffsReg), 2),
        point_mean_bias_m: roundHalfUp(mean(diffsPoint), 2),
        point_max_abs_err_m: roundHalfUp(maxAbs(diffsPoint), 2),
        node_answer_mismatches: rows.filter((r) => r.openMeteo !== r.nodeOpenMeteo).length,
      },
      points: rows,
    },
  };
}

/** One log line for a validation result. */
export function describeValidation({ block, report }) {
  const cls = `${block.terrain_class} (steep ${block.steep_fraction}${block.terrain_class_source === 'override' ? ', override' : ''})`;
  return (
    `validate (P1.3 v2): ${cls}, registered RMS ${block.registered_rms_m} m vs bound ${block.bound_m} m → ${block.pass ? 'PASS' : 'FAIL'}; ` +
    `point RMS ${block.point_rms_m} m and max |registered| ${block.max_abs_registered_err_m} m reported; ` +
    `Open-Meteo answered ${report.diagnostics.node_answer_mismatches}/${block.sample_count} samples from another node`
  );
}

/** Write the block into the recipe's `validation` (in place, rest of the file untouched) and the full result into the report's. */
export function writeValidation({ recipePath, reportPath, block, report }) {
  writeFileSync(recipePath, withValidationBlock(readFileSync(recipePath, 'utf8'), block));
  if (reportPath) {
    const doc = JSON.parse(readFileSync(reportPath, 'utf8'));
    doc.validation = report;
    writeFileSync(reportPath, `${JSON.stringify(doc, null, 2)}\n`);
  }
}
