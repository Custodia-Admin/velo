// Blueprint §P1.3 terrain accuracy criterion, v2 ("p1.3-v2-registered-rms").
// Ruling: card t_f639e915 (P1.3-decision.md), floor corrected by the
// coordinator ruling of 2026-11-04 23:40 CEST on card t_549dba84; root card
// t_20471c47. The normative text is docs/architecture/VELO-V2-BLUEPRINT.md
// § "P1.3 terrain accuracy criterion (v2)"; docs/worlds/WORLD-FORMAT.md
// § "Terrain accuracy check" describes the fields.
//
// Pure helpers only (no I/O): the constants, the GLO-90 node rule, the
// terrain class, the bound, the pass rule and the recipe/report `validation`
// block. validateDem.mjs does the sampling and the Open-Meteo calls.

/** Fixed identifier of the ruling, written into every validation block. */
export const P13_CRITERION = 'p1.3-v2-registered-rms';
/** The independent reference: Open-Meteo's elevation API, which serves Copernicus GLO-90 node values. */
export const P13_REFERENCE = 'open-meteo-elevation/copernicus-glo90';
/** The node rule (P1.3.3). Paired with the floor below: change one, re-measure the other. */
export const P13_REGISTRATION = 'glo90-nw-node';
/** Samples per world (P1.3.2). The v1 recipes all used 50; v2 fixes it. */
export const P13_SAMPLE_COUNT = 50;

/** P1.3.5: a node is steep at or above this slope (Horn 3×3, degrees). */
export const SLOPE_THRESHOLD_DEG = 15;
/** P1.3.5: a world is `mountain` when at least this share of its nodes is steep. */
export const STEEP_FRACTION_THRESHOLD = 0.2;
/** P1.3.7: the heightfield's own permitted error against its source terrain (the v1 intent). */
export const OWN_ERROR_ALLOWANCE_M = 6.0;

/**
 * P1.3.6 mountain floor: the best a 30 m-class DEM scores under this
 * procedure on mountain terrain. Copernicus GLO-30, read from the official
 * COGs as PixelIsPoint (their GTRasterTypeGeoKey), at the GLO-90 node of each
 * of Lugano's 50 validation samples (seed 46059), against Open-Meteo's
 * answer for the sample: 1.71 m RMS (bias −0.02 m, max 3.9 m).
 *
 * Measured on card t_045a5081 (PR #38). Cross-checked
 * with a Node decoder vs tifffile + numpy (bit-identical tiles, samples
 * within 3e-10 m); the check scripts are kept outside the repo.
 *
 * The ruling (t_f639e915) wrote 6.53 m here: the t_5a07c68a prototype
 * (a throwaway glo30.py on the bake host) read the PixelIsPoint tiles as PixelIsArea,
 * half a pixel north-west. The coordinator kept the ruling's formula and
 * replaced only this input. Never re-measured per world inside the gate
 * (P1.3.6): changing it takes a card with the measurement and a blueprint
 * amendment.
 */
export const MOUNTAIN_FLOOR_RMS_M = 1.71;
export const MOUNTAIN_FLOOR_SOURCE = 'copernicus-glo30-cog/lugano-t_045a5081';

/** P1.3.6 floor per terrain class. Standard terrain gets no credit. */
export const TERRAIN_CLASSES = Object.freeze({
  standard: Object.freeze({ floorRmsM: 0, floorSource: 'none' }),
  mountain: Object.freeze({ floorRmsM: MOUNTAIN_FLOOR_RMS_M, floorSource: MOUNTAIN_FLOOR_SOURCE }),
});

/** Round half up (towards +∞ at the half) to `dp` decimals, immune to binary noise such as 6.235 → 623.4999…. */
export function roundHalfUp(v, dp) {
  if (!Number.isFinite(v)) throw new RangeError(`cannot round ${v}`);
  const f = 10 ** dp;
  return Math.floor(Number((v * f).toPrecision(12)) + 0.5) / f;
}

/** P1.3.7: bound_m = √(floor² + own_error_allowance²), rounded half-up to 2 decimals. */
export function boundForFloor(floorRmsM) {
  return roundHalfUp(Math.hypot(floorRmsM, OWN_ERROR_ALLOWANCE_M), 2);
}

/** Computed bounds, never read from a recipe: standard 6.00 m, mountain √(1.71² + 6²) = 6.24 m. */
export const BOUND_M = Object.freeze({
  standard: boundForFloor(TERRAIN_CLASSES.standard.floorRmsM),
  mountain: boundForFloor(TERRAIN_CLASSES.mountain.floorRmsM),
});

/** GLO-90 node spacing in degrees: 3″, in latitude and, below 50°, in longitude. */
const NODE_DEG = 1 / 1200;

/**
 * P1.3.3 `glo90-nw-node`: the GLO-90 node Open-Meteo answers with for a
 * sample, the north-west corner of the 3″ cell holding it. Cells are
 * half-open, lat [S, N) × lon [W, E):
 *
 *   lon_node = ⌊lon / Δ⌋ · Δ,   lat_node = (⌊lat / Δ⌋ + 1) · Δ,   Δ = 3″.
 *
 * That is the ruling's ⌈lat / Δ⌉ · Δ for every latitude off a node row. On a
 * row it takes the next node north, which is what Open-Meteo answers there
 * (Lugano sample 45.9675, 8.8405: 507 m at the point, 493 m inside the cell
 * to its south) and the rule the floor was measured with (xcheck.py).
 *
 * Samples sit on the protocol's 1e-5° grid (P1.3.2), so the arithmetic runs
 * on integers: lat · 1200 = lat_1e5 · 12 / 1000, exact on a row.
 */
export function glo90Node(lat, lon) {
  if (!(Math.abs(lat) < 50) || !(Math.abs(lon) <= 180)) {
    // Poleward of 50° GLO-90 widens its longitude spacing (Copernicus DEM
    // Product Handbook). No world needs it yet: add the bands with a check
    // against Open-Meteo before baking one.
    throw new RangeError(`glo90-nw-node: (${lat}, ${lon}) is outside |lat| < 50°, where the 3″ × 3″ rule holds`);
  }
  const row = Math.floor((Math.round(lat * 1e5) * 12) / 1000) + 1;
  const col = Math.floor((Math.round(lon * 1e5) * 12) / 1000);
  // index · Δ, not index / 1200: the same doubles as v1's nodes, so the
  // diagnostic node queries (rounded to 1e-5° in the URL) hit the same cache.
  return { lat: row * NODE_DEG, lon: col * NODE_DEG };
}

/**
 * P1.3.5 steep fraction of a baked heightfield ({spec, data} as in
 * src/lib/world/heightfield.ts): the share of nodes whose Horn 3×3 slope,
 * on the native grid with the cell size in metres, is ≥ 15°. Every node with
 * a full 3×3 window counts (all but the outer ring); the u16 grid has no
 * no-data value (open ocean reads 0 m and counts as flat). Unrounded.
 */
export function steepFraction(hf) {
  const { cols, rows, cellSize, heightScale } = hf.spec;
  const d = hf.data;
  if (cols < 3 || rows < 3) throw new RangeError('steep fraction needs at least 3×3 nodes');
  // Horn: dz/dx = ((c + 2f + i) − (a + 2d + g)) / 8h, dz/dy = ((g + 2h + i) − (a + 2b + c)) / 8h,
  // heights in metres = offset + q · scale (the offset cancels).
  const k = heightScale / (8 * cellSize);
  let steep = 0;
  for (let r = 1; r < rows - 1; r++) {
    const n = (r - 1) * cols;
    const m = r * cols;
    const s = (r + 1) * cols;
    for (let c = 1; c < cols - 1; c++) {
      const gx = (d[n + c + 1] + 2 * d[m + c + 1] + d[s + c + 1] - (d[n + c - 1] + 2 * d[m + c - 1] + d[s + c - 1])) * k;
      const gy = (d[s + c - 1] + 2 * d[s + c] + d[s + c + 1] - (d[n + c - 1] + 2 * d[n + c] + d[n + c + 1])) * k;
      if ((Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI >= SLOPE_THRESHOLD_DEG) steep++;
    }
  }
  return steep / ((cols - 2) * (rows - 2));
}

/** Author inputs a recipe's `validation` may set. */
export const VALIDATION_INPUT_KEYS = Object.freeze(['sample_seed', 'terrain_class_override', 'terrain_class_override_reason']);
/** Bake outputs, in schema order; every one is mandatory in the recipe and the report after a bake. */
export const VALIDATION_OUTPUT_KEYS = Object.freeze([
  'criterion',
  'reference',
  'registration',
  'sample_count',
  'dem_source',
  'terrain_class',
  'terrain_class_source',
  'slope_threshold_deg',
  'steep_fraction_threshold',
  'steep_fraction',
  'floor_source',
  'floor_rms_m',
  'own_error_allowance_m',
  'bound_m',
  'registered_rms_m',
  'point_rms_m',
  'max_abs_registered_err_m',
  'pass',
]);
const V1_KEYS = {
  seed: 'renamed to "sample_seed" (same value)',
  samples: `fixed at ${P13_SAMPLE_COUNT} by P1.3.2; drop it`,
  maxRmsM: 'the bound comes from the terrain class in code (P1.3.7); drop it',
};

/** Read and check a recipe's `validation` author inputs; bake outputs already in it are ignored (overwritten). */
export function validationInputs(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('recipe needs a "validation" object (blueprint §P1.3)');
  for (const key of Object.keys(v)) {
    if (key in V1_KEYS) throw new Error(`recipe validation.${key} is a P1.3 v1 field: ${V1_KEYS[key]}`);
    if (!VALIDATION_INPUT_KEYS.includes(key) && !VALIDATION_OUTPUT_KEYS.includes(key)) {
      throw new Error(`recipe validation.${key} is not a P1.3 v2 field (inputs: ${VALIDATION_INPUT_KEYS.join(', ')})`);
    }
  }
  if (!Number.isInteger(v.sample_seed)) throw new Error('recipe validation.sample_seed (an integer) is required');
  const hasOverride = Object.hasOwn(v, 'terrain_class_override');
  const hasReason = Object.hasOwn(v, 'terrain_class_override_reason');
  if (hasOverride && v.terrain_class_override !== 'mountain') {
    throw new Error(`recipe validation.terrain_class_override must be "mountain" (got ${JSON.stringify(v.terrain_class_override)}): a recipe may force the class up, never down to "standard"`);
  }
  if (hasOverride && (typeof v.terrain_class_override_reason !== 'string' || !v.terrain_class_override_reason.trim())) {
    throw new Error('recipe validation.terrain_class_override needs a non-empty terrain_class_override_reason');
  }
  if (!hasOverride && hasReason) throw new Error('recipe validation.terrain_class_override_reason is set without terrain_class_override');
  return {
    sampleSeed: v.sample_seed,
    override: hasOverride ? 'mountain' : null,
    overrideReason: hasOverride ? v.terrain_class_override_reason : null,
  };
}

/**
 * P1.3.5 class from the recorded (4 dp) steep fraction and the recipe's
 * override. `terrain_class_source` is "override" only when the override is
 * what made the world mountain; with an override on terrain that is
 * mountain anyway it stays "auto".
 */
export function terrainClassFor(steepFraction4dp, override = null) {
  const auto = steepFraction4dp >= STEEP_FRACTION_THRESHOLD ? 'mountain' : 'standard';
  if (override === 'mountain' && auto === 'standard') return { terrainClass: 'mountain', terrainClassSource: 'override' };
  return { terrainClass: auto, terrainClassSource: 'auto' };
}

/** P1.3.7: PASS iff registered_rms_m ≤ bound_m, both at 2 decimals. Nothing else gates. */
export function passes(registeredRmsM, boundM) {
  return roundHalfUp(registeredRmsM, 2) <= roundHalfUp(boundM, 2);
}

/**
 * The P1.3.10 `validation` block: the author inputs, then every bake output
 * in schema order. Figures arrive unrounded; the block holds them rounded
 * half-up (steep fraction to 4 dp, metres to 2 dp).
 */
export function validationBlock({ inputs, demSource, steepFraction: steepRaw, registeredRmsM, pointRmsM, maxAbsRegisteredErrM }) {
  const steep = roundHalfUp(steepRaw, 4);
  const { terrainClass, terrainClassSource } = terrainClassFor(steep, inputs.override);
  const floor = TERRAIN_CLASSES[terrainClass];
  const boundM = BOUND_M[terrainClass];
  const registered = roundHalfUp(registeredRmsM, 2);
  return {
    sample_seed: inputs.sampleSeed,
    ...(inputs.override ? { terrain_class_override: inputs.override, terrain_class_override_reason: inputs.overrideReason } : {}),
    criterion: P13_CRITERION,
    reference: P13_REFERENCE,
    registration: P13_REGISTRATION,
    sample_count: P13_SAMPLE_COUNT,
    dem_source: demSource,
    terrain_class: terrainClass,
    terrain_class_source: terrainClassSource,
    slope_threshold_deg: SLOPE_THRESHOLD_DEG,
    steep_fraction_threshold: STEEP_FRACTION_THRESHOLD,
    steep_fraction: steep,
    floor_source: floor.floorSource,
    floor_rms_m: floor.floorRmsM,
    own_error_allowance_m: OWN_ERROR_ALLOWANCE_M,
    bound_m: boundM,
    registered_rms_m: registered,
    point_rms_m: roundHalfUp(pointRmsM, 2),
    max_abs_registered_err_m: roundHalfUp(maxAbsRegisteredErrM, 2),
    pass: passes(registered, boundM),
  };
}

/**
 * Check a written block (a committed recipe's or report's `validation`):
 * every output field present, constants equal to the code's, the class, the
 * floor, the bound and the verdict consistent with the figures. Returns the
 * list of problems (empty when the block is sound).
 */
export function validationBlockProblems(block, { demSource } = {}) {
  const problems = [];
  if (!block || typeof block !== 'object') return ['no validation block'];
  for (const key of VALIDATION_OUTPUT_KEYS) if (!Object.hasOwn(block, key)) problems.push(`missing ${key}`);
  if (problems.length) return problems;
  let inputs;
  try {
    inputs = validationInputs(Object.fromEntries(Object.entries(block).filter(([k]) => VALIDATION_INPUT_KEYS.includes(k) || VALIDATION_OUTPUT_KEYS.includes(k))));
  } catch (err) {
    return [err.message];
  }
  const expected = validationBlock({
    inputs,
    demSource: demSource ?? block.dem_source,
    steepFraction: block.steep_fraction,
    registeredRmsM: block.registered_rms_m,
    pointRmsM: block.point_rms_m,
    maxAbsRegisteredErrM: block.max_abs_registered_err_m,
  });
  for (const [key, value] of Object.entries(expected)) {
    if (!Object.is(block[key], value)) problems.push(`${key} is ${JSON.stringify(block[key])}, expected ${JSON.stringify(value)}`);
  }
  return problems;
}

/**
 * Replace the top-level `"validation": {…}` value in a recipe's JSON text with
 * `block`, leaving every other byte of the hand-formatted recipe alone.
 */
export function withValidationBlock(recipeText, block) {
  const span = topLevelValueSpan(recipeText, 'validation');
  if (!span) throw new Error('recipe has no top-level "validation" object');
  const body = JSON.stringify(block, null, 2).replace(/\n/g, '\n  ');
  return recipeText.slice(0, span.start) + body + recipeText.slice(span.end);
}

/** [start, end) of a top-level object member's value in JSON text, or null. */
function topLevelValueSpan(text, key) {
  let depth = 0;
  let i = 0;
  const skipString = (from) => {
    let j = from + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
    return j + 1;
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = skipString(i);
      if (depth === 1 && text.slice(i + 1, end - 1) === key) {
        let j = end;
        while (/\s/.test(text[j])) j++;
        if (text[j] === ':') {
          j++;
          while (/\s/.test(text[j])) j++;
          if (text[j] !== '{') return null;
          const start = j;
          let d = 0;
          while (j < text.length) {
            if (text[j] === '"') {
              j = skipString(j);
              continue;
            }
            if (text[j] === '{' || text[j] === '[') d++;
            else if (text[j] === '}' || text[j] === ']') {
              d--;
              if (d === 0) return { start, end: j + 1 };
            }
            j++;
          }
          return null;
        }
      }
      i = end;
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    i++;
  }
  return null;
}
