#!/usr/bin/env node
// Velo world bake: `node tools/worldbake/bake.mjs <world> [options]`
//
//   --clean            delete this world's cached downloads first (clean-cache bake)
//   --no-validate      skip the P1.3 heightfield check (Open-Meteo); the report's
//                      `validation` is then null, and the recipe keeps its
//                      previous `validation` block untouched
//   --out <dir>        bundle dir (default public/worlds/<world>, or
//                      tools/worldbake/remote/<world> for a recipe with
//                      "host": "remote"); see below
//   --cache <dir>      download cache (default tools/worldbake/cache, env WORLDBAKE_CACHE)
//   --no-docs          don't rewrite this world's block in docs/worlds/CREDITS.md
//
// `--out` only moves the bundle. In the tree it runs from, the bake still
// rewrites tools/worldbake/reports/<world>.json, the recipe's `validation`
// block (tools/worldbake/worlds/<world>.json, unless --no-validate) and the
// world's block in docs/worlds/CREDITS.md (unless --no-docs). To bake for
// comparison without touching a working tree, bake from a `git archive` copy.
//
// The heightfield comes from the recipe's `dem.source`: AWS Terrain Tiles by
// default (`dem.zoom`), or Copernicus GLO-30 COGs with "copernicus-glo30"
// (demSource.mjs, fetchGlo30.mjs).
//
// A recipe with "host": "remote" bakes a world that is published off-repo
// (publish.mjs uploads it to `worlds/<id>/<hash>/` in the public R2 bucket;
// worldBundles.mjs, docs/worlds/ADDING-A-WORLD.md). Its manifest.json is
// committed, its layer files are not. "routeCredits": true adds one credit
// per route with the OSM relation or OSRM query that reproduces it.
//
// Same recipe + same cached inputs → byte-identical bundle (sha256 per file in
// manifest.json). OSM queries are pinned to the recipe's osmDate, so a clean
// cache re-downloads the same data. Runs on a bake host with room to spare, not a
// laptop: see docs/worlds/WORLD-FORMAT.md "Baking".
//
// The P1.3 check (validateDem.mjs, blueprint §P1.3 v2) writes its block back
// into the recipe's `validation` and into the report. `validation` never
// shapes the bundle, so it is left out of `generator.recipeSha256`: writing
// the block back doesn't change the next bake's bytes.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createProjection } from '../../src/lib/world/projection.ts';
import { decodeHeightDeltas } from '../../src/lib/world/heightfield.ts';
import { validateManifest, WORLD_FORMAT, WORLD_FORMAT_VERSION } from '../../src/lib/world/manifest.ts';
import { fetchDem, DEM_SOURCE } from './fetchDem.mjs';
import { fetchGlo30, GLO30_CREDIT, GLO30_URL_TEMPLATE } from './fetchGlo30.mjs';
import { demSourceOf, GLO30_DEM_SOURCE } from './demSource.mjs';
import { fetchOsm, osmLayersFor, OVERPASS_URL } from './fetchOsm.mjs';
import { sampleGrid, buildHeightfield } from './buildHeightfield.mjs';
import { flattenLakes, relevelLakes, routeCoreNodes } from './flatLakes.mjs';
import { BEACH_KIND, buildSea, flattenSea, relevelSea, slopeBeaches } from './coast.mjs';
import { buildRoads, buildWater, buildLandcover, buildBuildings, buildVegetation, buildPois, buildTreeRows, routeClearances, routeWaterDrops, waterOnBeach, BUILDING_SIMPLIFY_M, ROAD_FLAGS, ROUTE_CLEAR_MAX_M, ROUTE_CLEAR_MIN_M } from './buildVectors.mjs';
import { carveRoutes, finishRoutes, loadScenicGeometry, loadScenicNames, sampleFloatGrid } from './snapRoutes.mjs';
import { DECK_HEADROOM_M, abutmentBlocks, anchorPins, approachHeights, bridgeNetworks, capUnderDecks, DECK_END_ZONE_CELLS, deckHeights, deckKinks, deckThickness, densifyPiece, footprintConflicts, headroomFailures, pieceXY, placePiers, planApproaches, quantiseZ, ridePins, riddenGroundRoads, riddenSpans, rideSurface, solveNetwork } from './bridges.mjs';
import { easeRoadsOntoRoutes, routeFitReport, routePaintCoverage, routeRoadCoverage, sampleAppRoute } from './routeCoverage.mjs';
import { describeValidation, validateHeightfield, writeValidation } from './validateDem.mjs';
import { P13_SAMPLE_COUNT, validationInputs } from './p13Criterion.mjs';
import { syncDestinations } from './syncDestinations.mjs';
import { BUNDLED_WORLDS_DIR, REMOTE_WORLDS_DIR } from './worldBundles.mjs';
import { routeSourceCredit } from '../../scripts/scenicRouteSources.mjs';
import { brotliSize, ensureDir, gzip, here, sha256, stableJson, writeFileAtomic } from './util.mjs';

const TOOL_VERSION = 1;
const ROOT = resolve(here(import.meta.url), '../..');
/** Bundle budget (blueprint P1.3): all files, brotli quality 11. */
export const MAX_BUNDLE_BROTLI_BYTES = 8e6;

function parseArgs(argv) {
  const args = { world: null, clean: false, validate: true, docs: true, out: null, cache: process.env.WORLDBAKE_CACHE ?? null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--clean') args.clean = true;
    else if (a === '--no-validate') args.validate = false;
    else if (a === '--no-docs') args.docs = false;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--cache') args.cache = argv[++i];
    else if (!a.startsWith('-') && !args.world) args.world = a;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.world) throw new Error('usage: node tools/worldbake/bake.mjs <world> [--clean] [--no-validate] [--out dir] [--cache dir]');
  return args;
}

export const CREDITS = [
  {
    id: 'osm',
    name: 'OpenStreetMap',
    licence: 'ODbL-1.0',
    url: 'https://www.openstreetmap.org/copyright',
    attribution: '© OpenStreetMap contributors',
  },
  {
    id: 'terrain-tiles',
    name: 'Terrain Tiles (Tilezen/Mapzen terrarium) on the AWS Open Data Registry',
    licence: 'Mixed open sources, attribution required',
    url: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md',
    attribution:
      'Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers; ' +
      'SRTM and GMTED2010 terrain data courtesy of the U.S. Geological Survey; ' +
      'Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration',
  },
  {
    id: 'copernicus-glo90',
    name: 'Copernicus DEM GLO-90 via Open-Meteo (route profiles, validation)',
    licence: 'Copernicus DEM licence (free, attribution); Open-Meteo API data CC-BY-4.0',
    url: 'https://open-meteo.com/en/docs/elevation-api',
    attribution:
      'Copernicus DEM GLO-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; elevation API by Open-Meteo.com (CC BY 4.0)',
  },
  {
    id: 'osrm-fossgis',
    name: 'OSRM bike routing, routing.openstreetmap.de (FOSSGIS), bake-time only',
    licence: 'Route geometry derived from OpenStreetMap (ODbL-1.0)',
    url: 'https://routing.openstreetmap.de/about.html',
    attribution: 'Routes computed with OSRM on routing.openstreetmap.de (FOSSGIS e.V.) from © OpenStreetMap contributors',
  },
];

/**
 * Credits for a bundle baked from `demSource`. The default source keeps the
 * list above exactly (same bytes in the manifest); GLO-30 swaps the Terrain
 * Tiles entry for the Copernicus DEM GLO-30 one.
 */
export function creditsFor(demSource) {
  if (demSource !== GLO30_DEM_SOURCE) return CREDITS;
  return CREDITS.map((c) => (c.id === 'terrain-tiles' ? GLO30_CREDIT : c));
}

/**
 * The manifest credits of a bake: `creditsFor(demSource)`, then with the
 * recipe's `routeCredits` one credit per route (in recipe order) linking
 * the OSM relation or OSRM query its geometry came from
 * (scripts/scenicRouteSources.mjs). Recipes without the flag keep exactly
 * `creditsFor` (same bytes).
 */
export function bundleCredits(recipe, demSource, names) {
  const base = creditsFor(demSource);
  if (!recipe.routeCredits) return base;
  return [...base, ...recipe.routes.map((id) => routeSourceCredit(id, names[id] ?? id))];
}

/** Where a recipe's bundle goes without --out: public/worlds/<id>, or tools/worldbake/remote/<id> when remote. */
export function defaultOutDir(recipe) {
  return join(recipe.host === 'remote' ? REMOTE_WORLDS_DIR : BUNDLED_WORLDS_DIR, recipe.id);
}

/**
 * The recipe bytes `generator.recipeSha256` hashes: the parsed recipe without
 * its `validation` block (the P1.3 check's seed and results never touch the
 * bundle, and the bake writes its results back into the recipe) and without
 * `host` (where the bundle is served from doesn't shape it either).
 */
export function recipeBundleBytes(recipe) {
  const { validation: _validation, host: _host, ...rest } = recipe;
  return stableJson(rest);
}

/**
 * `manifest.generator` for a bake from `demSource`. The key order is part of
 * the manifest's bytes: the default source keeps `demSource` + `demZoom`
 * where they always were, GLO-30 names its source and has no zoom.
 * `recipeSha256` hashes `recipeBundleBytes(recipe)`, computed here so no
 * caller can hash the raw recipe file (which carries `validation`).
 */
export function generatorFor(demSource, recipe, dem) {
  return {
    tool: 'velo-worldbake',
    version: TOOL_VERSION,
    recipeSha256: sha256(recipeBundleBytes(recipe)),
    osmDate: recipe.osmDate,
    ...(demSource === GLO30_DEM_SOURCE ? { demSource: dem.source } : { demSource: DEM_SOURCE, demZoom: recipe.dem.zoom }),
    demTiles: dem.tiles.length,
    ...(recipe.flatLakes ? { flatLakes: true } : {}),
    ...(recipe.bridges ? { bridges: true } : {}),
  };
}

/** Stop the bake when the bundle (every file, brotli 11) is over the budget. */
export function checkBundleBudget(totals) {
  if (totals.brotli > MAX_BUNDLE_BROTLI_BYTES) throw new Error(`bundle is ${(totals.brotli / 1e6).toFixed(2)} MB brotli, over the ${MAX_BUNDLE_BROTLI_BYTES / 1e6} MB budget`);
}

/**
 * Read a recipe and check what would stop the bake late: its DEM source and
 * its P1.3 `validation` inputs. A bad block (a v1 field, a missing seed, an
 * override down to standard) throws here, before any download or output.
 */
export function readRecipe(recipePath) {
  const recipe = JSON.parse(readFileSync(recipePath, 'utf8'));
  const demSource = demSourceOf(recipe);
  validationInputs(recipe.validation); // a bad P1.3 block stops the bake before any download
  return { recipe, demSource };
}

/**
 * The bake's last step, after the bundle is on disk (blueprint §P1.3.9).
 * With `validate`, run the P1.3 check (`check` = validateHeightfield's
 * arguments) and log its verdict; a FAIL is logged and recorded, it never
 * stops the bake. Then write the report to `reportPath` with `validation` =
 * the check's report, or null without the check, and write the check's block
 * into the recipe at `recipePath`; without the check the recipe keeps its
 * previous block. `report` is the report without `validation`; `timings`
 * (its `timingsS`) gains `validate` and `total` (since `t0`). Returns the
 * written report.
 */
export async function finishBake({ validate, check, report, timings, t0, reportPath, recipePath, log }) {
  let validation = null;
  if (validate) {
    const t = Date.now();
    validation = await validateHeightfield(check);
    timings.validate = round((Date.now() - t) / 1000, 1);
    log(describeValidation(validation));
    if (validation.block.terrain_class === 'mountain' && check.demSource !== GLO30_DEM_SOURCE) {
      log(`validate: mountain worlds default to dem.source "${GLO30_DEM_SOURCE}" (blueprint §P1.3.8); this one bakes from ${check.demSource}`);
    }
  }
  timings.total = round((Date.now() - t0) / 1000, 1);
  const written = { ...report, validation: validation?.report ?? null };
  ensureDir(dirname(reportPath));
  writeFileSync(reportPath, `${JSON.stringify(written, null, 2)}\n`);
  // P1.3.9: the block also goes into the recipe (outputs overwritten every bake).
  if (validation) writeValidation({ recipePath, block: validation.block });
  return written;
}

/** Lat/lon bbox of the extent (edges walked every 100 m), rounded outward to 1e-5°. */
function extentBbox(projection, ext) {
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  const visit = (x, y) => {
    const [lat, lon] = projection.inverse(x, y);
    south = Math.min(south, lat); north = Math.max(north, lat);
    west = Math.min(west, lon); east = Math.max(east, lon);
  };
  for (let x = ext.xMin; x <= ext.xMax; x += 100) { visit(x, ext.yMin); visit(x, ext.yMax); }
  for (let y = ext.yMin; y <= ext.yMax; y += 100) { visit(ext.xMin, y); visit(ext.xMax, y); }
  visit(ext.xMax, ext.yMax);
  const r = 1e5;
  return {
    south: Math.floor(south * r) / r,
    west: Math.floor(west * r) / r,
    north: Math.ceil(north * r) / r,
    east: Math.ceil(east * r) / r,
  };
}

function round(v, d = 2) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

export async function bake(opts) {
  const t0 = Date.now();
  const timings = {};
  const lap = (name, since) => (timings[name] = round((Date.now() - since) / 1000, 1));
  const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s] ${msg}`);

  const recipePath = join(ROOT, 'tools/worldbake/worlds', `${opts.world}.json`);
  const { recipe, demSource } = readRecipe(recipePath);
  const glo30 = demSource === GLO30_DEM_SOURCE;
  const outDir = resolve(opts.out ?? defaultOutDir(recipe));
  const cacheDir = resolve(opts.cache ?? join(ROOT, 'tools/worldbake/cache'), recipe.id);
  if (opts.clean && existsSync(cacheDir)) {
    rmSync(cacheDir, { recursive: true, force: true });
    log(`cache: cleared ${cacheDir}`);
  }
  ensureDir(cacheDir);

  const projection = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: recipe.origin.lat, lon0: recipe.origin.lon, k0: 1 });
  const g = recipe.grid;
  if (g.cols > 2048 || g.rows > 2048) throw new Error('heightfield is capped at 2048² nodes');
  const extent = {
    xMin: g.xMin,
    xMax: g.xMin + (g.cols - 1) * g.cellSize,
    yMin: g.yMax - (g.rows - 1) * g.cellSize,
    yMax: g.yMax,
  };
  const bbox = extentBbox(projection, extent);
  log(`world ${recipe.id}: ${(extent.xMax - extent.xMin) / 1000} × ${(extent.yMax - extent.yMin) / 1000} km, ${g.cols}×${g.rows} @ ${g.cellSize} m, bbox ${JSON.stringify(bbox)}`);

  // 1. Elevation. DEM bbox gets a ~500 m margin so edge nodes interpolate inside data.
  let t = Date.now();
  const m = 0.005;
  const demBbox = { south: bbox.south - m, west: bbox.west - m, north: bbox.north + m, east: bbox.east + m };
  const dem = glo30
    ? await fetchGlo30({ bbox: demBbox, cacheDir, log })
    : await fetchDem({ bbox: demBbox, zoom: recipe.dem.zoom, cacheDir, log });
  const heights = sampleGrid({ grid: g, projection, dem });
  lap('dem', t);

  // OSM first: the water areas shape the terrain under them (flatLakes).
  t = Date.now();
  const osm = await fetchOsm({ bbox, osmDate: recipe.osmDate, cacheDir, log, layers: osmLayersFor(recipe) });
  // A coast world's sea: the water side of the coastline ways (coast.mjs).
  const sea = recipe.coast ? buildSea(osm.elements.coast, projection, extent) : null;
  const water = buildWater(osm.elements.water, projection, extent, { sea });
  lap('osm', t);
  let lakes = null;
  if (recipe.flatLakes) {
    const flat = flattenLakes({ grid: g, heights, water });
    lakes = flat.lakes;
    const cut = lakes.reduce((mx, l) => Math.max(mx, l.maxCutM), 0);
    log(`flatLakes: ${lakes.length} lakes and ponds levelled (${lakes.reduce((n, l) => n + l.inNodes, 0)} nodes under water, ${flat.changedNodes} changed, max cut ${cut.toFixed(1)} m)`);
  }
  // Landcover needs nothing but OSM; a coast world's beaches shape the terrain.
  const landcover = buildLandcover(osm.elements.landcover, projection, extent, { beach: recipe.coast ? osm.elements.coast : null });
  let seaFlat = null;
  let beachSlope = null;
  if (sea) {
    seaFlat = flattenSea({ grid: g, heights, water });
    const b = seaFlat.before;
    log(`coast: ${sea.length} sea polygon${sea.length === 1 ? '' : 's'} (${sea.reduce((n, p) => n + p.length - 1, 0)} islands), ${seaFlat.inNodes} nodes at sea level${b ? ` (DEM ${b.min.toFixed(1)}…${b.max.toFixed(1)} m)` : ''}, ${seaFlat.stripNodes} shore nodes lowered to it`);
    beachSlope = slopeBeaches({ grid: g, heights, sea: seaFlat.mask, beaches: landcover.polys.filter((p) => p.kind === BEACH_KIND && p.tags.natural === 'beach').map((p) => p.rings) });
    log(`coast: beaches sloped to the sea, ${beachSlope.changed} nodes lowered (max ${beachSlope.maxCutM.toFixed(1)} m)`);
  }

  // 2. Roads and the route fit. Neither reads the terrain, so they come first:
  // the bridges step needs the final road lines before the carve.
  t = Date.now();
  const geometry = loadScenicGeometry(join(ROOT, 'src/lib/scenicRouteData.ts'));
  const names = loadScenicNames(join(ROOT, 'src/lib/scenicRoutes.ts'));
  const routesIn = recipe.routes.map((id) => {
    if (!geometry[id]) throw new Error(`route ${id} not in src/lib/scenicRouteData.ts`);
    return { id, name: names[id] ?? id, points: geometry[id].points };
  });
  const roads = buildRoads(osm.elements.roads, projection, extent);
  // The route's painted guide must sit on ONE drawn road, never on grass and
  // never on a second surface laid beside the road: bend the road the route
  // runs along where the paint leaves it, add the way the snapshot lacks
  // where no road runs along it (routeCoverage.mjs).
  const routeSamples = routesIn.map((r) => ({ id: r.id, ...sampleAppRoute(r.points, projection) }));
  const mappedCoverage = routeRoadCoverage(routeSamples, roads);
  const paintBefore = routePaintCoverage(routeSamples, roads);
  const fit = easeRoadsOntoRoutes(routeSamples, roads);
  const paintAfter = routePaintCoverage(routeSamples, roads);
  const roadCoverage = Object.fromEntries(
    routeSamples.map((r, i) => [
      r.id,
      {
        mappedPct: mappedCoverage[i].pct,
        paintPctBefore: paintBefore[i].pct,
        paintPct: paintAfter[i].pct,
        easedM: fit.easedM[r.id],
        joinedM: fit.joinedM[r.id],
        tunnelM: paintAfter[i].tunnelM,
      },
    ]),
  );
  for (const [id, c] of Object.entries(roadCoverage)) {
    log(`route ${id}: ${c.mappedPct}% within 1 m of mapped roads; guide on drawn roads ${c.paintPctBefore}% → ${c.paintPct}% (${c.easedM} m eased, ${c.joinedM} m joined${c.tunnelM ? `, ${c.tunnelM} m in tunnels` : ''})`);
  }
  log(`route fit: ${fit.roadsEased} roads bent (up to ${fit.maxShiftM} m), ${fit.joins} join pieces`);

  // Bridges (recipe `bridges`): which decks each route rides. The carve
  // leaves the middle of a ridden deck alone (bridges.mjs).
  const nets = recipe.bridges ? bridgeNetworks(roads) : null;
  // Heights are per vertex: give every deck a vertex every few metres.
  if (nets) for (const net of nets) for (const ri of net.pieces) densifyPiece(roads.roads[ri]);
  const spans = nets ? riddenSpans(routeSamples, roads, nets) : null;
  const endZone = DECK_END_ZONE_CELLS * g.cellSize;
  const skip = spans
    ? (ri, s0, s1) => spans[ri].some((sp) => s0 >= sp.s0 + endZone && s1 <= sp.s1 - endZone)
    : undefined;

  // 3. Routes: carve corridors into the float grid, then quantise.
  const carve = carveRoutes({ grid: g, heights, projection, routes: routesIn, snap: recipe.snap, skip });
  if (lakes || seaFlat) {
    const keep = routeCoreNodes(g, carve.prepared, recipe.snap.coreCells * g.cellSize);
    if (lakes) log(`flatLakes: ${relevelLakes({ heights, lakes, keep: (i) => keep.has(i) })} lake nodes re-levelled after the route carve (route core kept)`);
    if (seaFlat) log(`coast: ${relevelSea({ heights, nodes: seaFlat.nodes, keep: (i) => keep.has(i) })} sea nodes re-levelled after the route carve (route core kept)`);
  }
  const solveAll = (pins, abutZ, groundAt) => {
    const z = new Map();
    for (const net of nets) {
      const mine = pins.filter((p) => net.pieces.includes(p.ri));
      for (const [ri, zs] of solveNetwork(net, roads, groundAt, mine, abutZ)) z.set(ri, zs);
    }
    return { z };
  };
  let decks = null;
  if (nets) {
    const prepared = carve.prepared.map((p, i) => ({ ...p, spans: spans[i] }));
    const floatGround = (x, y) => sampleFloatGrid(g, heights, x, y);
    // Headroom pins over every route passing under a deck; abutments they
    // lift stand on approach ramps; then the decks again on those.
    const pinned = deckHeights({ roads, nets, groundAt: floatGround, routes: prepared });
    const plan = planApproaches({ roads, nets, pins: pinned.pins, groundAt: floatGround, ridden: riddenGroundRoads(routeSamples, roads) });
    anchorPins(roads, pinned.pins);
    const first = { pins: pinned.pins, ...solveAll(pinned.pins, plan.abutZ, floatGround), plan };
    // The carved core of every route on the ground stays as carved.
    const groundRuns = carve.prepared.flatMap((p, i) => {
      const runs = [];
      let cur = null;
      for (let k = 0; k + 1 < p.x.length; k++) {
        if (skip(i, p.s[k], p.s[k + 1])) {
          cur = null;
          continue;
        }
        if (!cur) runs.push((cur = { x: [p.x[k]], y: [p.y[k]] }));
        cur.x.push(p.x[k + 1]);
        cur.y.push(p.y[k + 1]);
      }
      return runs;
    });
    const keep = routeCoreNodes(g, groundRuns, recipe.snap.coreCells * g.cellSize);
    const cap = capUnderDecks({ grid: g, heights, roads, nets, z: first.z, keep: (i) => keep.has(i) });
    decks = { first, cap, prepared };
  }
  const height = buildHeightfield({ grid: g, heights });
  let surface;
  let bridgesLayer = null;
  if (decks) {
    // Final deck heights stand on the quantised ground; headroom pins keep
    // theirs, and a ridden deck is the carved ground wherever the carve ran.
    const hfGround = (x, y) => height.hf.sampleHeight(x, y);
    const pinsRide = ridePins({ roads, routes: decks.prepared, skip, groundAt: hfGround }).map((p) => {
      const [x, y] = pieceXY(roads.roads[p.ri], p.s);
      return { ...p, x, y };
    });
    anchorPins(roads, pinsRide);
    const zdm = new Map();
    for (const [ri, zs] of solveAll([...decks.first.pins, ...pinsRide], decks.first.plan.abutZ, hfGround).z) zdm.set(ri, quantiseZ(zs));
    for (const [ri, zs] of approachHeights(roads, decks.first.plan.approaches, hfGround)) zdm.set(ri, quantiseZ(zs));
    const approachSet = new Set(decks.first.plan.approaches.keys());
    const rideRoads = spans.map((list) => [...new Set(list.flatMap((sp) => sp.pieces))].sort((a, b) => a - b));
    const rides = rideRoads.map((list) => rideSurface(roads, list, zdm, hfGround));
    // What the app does: the deck wherever the route's ridden decks are under it.
    surface = (ri, x, y) => rides[ri](x, y);
    // Walked every metre of the app's own line, not only at the route samples.
    const conflicts = footprintConflicts({
      routes: routeSamples.map((r, i) => ({ ...r, spans: spans[i] })),
      surfaces: rides,
      own: spans.map((list) => list.map((sp) => rideSurface(roads, sp.pieces, zdm, hfGround))),
      groundAt: hfGround,
    });
    if (conflicts.length) {
      throw new Error(`bridges: a route passes through the footprint of a deck it rides elsewhere, off that deck there (the app would lift the rider onto it): ${JSON.stringify(conflicts.slice(0, 8))}`);
    }
    const kinks = deckKinks({ roads, zdm, groundAt: hfGround });
    if (kinks.length) throw new Error(`bridges: pins fight on a deck (its ribbon changes more than 2 m within 6 m, standing over 1 m above the ground): ${JSON.stringify(kinks.slice(0, 8))}`);
    const failures = headroomFailures({ roads, routes: decks.prepared, zdm, surfaces: rides, groundAt: hfGround, rides: rideRoads, approaches: approachSet });
    if (failures.length) throw new Error(`bridges: a route passes under a deck without ${DECK_HEADROOM_M} m headroom: ${JSON.stringify(failures.slice(0, 8))}`);
    const piers = [
      ...placePiers({ roads, pieces: [...zdm.keys()].sort((a, b) => a - b), zdm, groundAt: hfGround, routeLines: routeSamples, cellSize: g.cellSize }),
      ...abutmentBlocks(decks.first.plan.lifts, hfGround, routeSamples),
    ];
    const ridden = new Set(spans.flat().flatMap((sp) => sp.pieces));
    bridgesLayer = {
      version: 1,
      units: 'dm',
      decks: [...zdm.keys()].sort((a, b) => a - b).map((ri) => ({ r: ri, t: Math.round(deckThickness(roads, roads.roads[ri]) * 10), ...(approachSet.has(ri) ? { a: 1 } : {}), z: zdm.get(ri) })),
      piers,
      rides: Object.fromEntries(routesIn.map((r, i) => [r.id, spans[i].map((sp) => ({ s0: round(sp.s0), s1: round(sp.s1), r: sp.pieces }))])),
    };
    log(`bridges: ${nets.length} decks (${zdm.size - approachSet.size} pieces, ${ridden.size} ridden), ${decks.first.pins.length} headroom pins (lift up to ${round(Math.max(0, ...decks.first.pins.map((p) => p.liftM)))} m), ${decks.first.plan.lifts.length} abutments on approach ramps (${approachSet.size} pieces, lift up to ${round(Math.max(0, ...decks.first.plan.lifts.map((l) => l.liftM)))} m), ${decks.cap.moved} nodes lowered under decks (max ${round(decks.cap.maxCutM)} m), ${piers.length} piers`);
    for (const [i, list] of spans.entries()) {
      if (list.length) log(`bridges: route ${routesIn[i].id} rides ${list.length} decks: ${list.map((sp) => `${round(sp.s0, 0)}–${round(sp.s1, 0)} m`).join(', ')}`);
    }
  }
  const snapped = finishRoutes({ prepared: carve.prepared, hf: height.hf, snap: recipe.snap, surface });
  for (const r of snapped.info) {
    log(`route ${r.id}: ${(r.lengthM / 1000).toFixed(2)} km, max gap ${r.maxGapM} m, grade Δ ${r.gradeMeanAbsDiffPct} pp mean (raw DEM ${r.report.rawDemGradeMeanAbsDiffPct} pp)`);
  }
  log(`heightfield: ${height.info.minHeight.toFixed(1)}–${height.info.maxHeight.toFixed(1)} m, step ${height.info.heightScale} m, ${carve.carvedNodes} nodes carved (max ${carve.maxCutM.toFixed(1)} m)`);
  lap('heightfield+routes', t);

  // 4. Vectors.
  t = Date.now();
  // What the rider follows must never run through a building: every scenic
  // route at full resolution (the app's own polyline), plus every drawn road.
  const routeLines = routesIn.map((r) => r.points.flatMap(([lat, lon]) => projection.forward(lat, lon)));
  const stepsClass = roads.classes.indexOf('steps');
  const roadLines = roads.roads
    .filter((r) => !(r.f && r.f & ROAD_FLAGS.tunnel) && r.c !== stepsClass)
    .map((r) => r.p.map((v) => v / 10));
  const routeClear = routeClearances(routeLines, roads);
  // Nor through a small pond or lagoon drawn as a flat sheet across it.
  const dryWater = routeWaterDrops(water, { routeLines: routeClear.lines, routeClear: routeClear.clear });
  let dryBeach = 0;
  if (dryWater.length) {
    // flatLakes has already levelled these; dropping one would leave a dry pit.
    if (lakes) throw new Error(`route runs through ${dryWater.length} small water area(s) a flatLakes world has levelled; move the route or the lake`);
    const drop = new Set(dryWater);
    // A coast world's sand runs on where OSM had cut a lagoon out of the beach.
    const beachK = landcover.layer.kinds.indexOf(BEACH_KIND);
    if (beachK >= 0) {
      for (const a of waterOnBeach(dryWater.map((i) => water.areas[i]), landcover.layer.areas.filter((b) => b.k === beachK))) {
        landcover.layer.areas.push({ k: beachK, r: a.r });
        landcover.polys.push({ kind: BEACH_KIND, tags: {}, rings: a.r.map((r) => r.map((v) => v / 10)) });
        dryBeach++;
      }
    }
    water.areas = water.areas.filter((_, i) => !drop.has(i));
  }
  const buildings = buildBuildings(osm.elements.buildings, projection, extent, landcover.polys, {
    routeLines: routeClear.lines,
    routeClear: routeClear.clear,
    roadLines,
  }, recipe.buildingSimplifyM ?? BUILDING_SIMPLIFY_M);
  const vegetation = buildVegetation({
    polys: landcover.polys,
    ext: extent,
    recipe: recipe.vegetation,
    roads,
    water,
    footprints: buildings.footprints,
    treeRows: buildTreeRows(osm.elements.treerows, projection, extent),
    routeLines,
  });
  const pois = buildPois([...osm.elements.pois, ...osm.elements.landmarks], projection, extent).map((p) => ({ ...p, h: round(height.hf.sampleHeight(p.x, p.y)) }));
  lap('vectors', t);
  log(`vectors: ${roads.roads.length} road pieces, ${water.areas.length} water areas${dryWater.length ? ` (dropped ${dryWater.length} on routes${dryBeach ? `, ${dryBeach} now beach` : ''})` : ''} + ${water.lines.length} lines, ${landcover.layer.areas.length} landcover, ${buildings.count} buildings ${JSON.stringify(buildings.districts)} (dropped ${buildings.dropped.route} on routes, ${buildings.dropped.road} astride roads), ${vegetation.count} trees (woodland lattice ${vegetation.lattice}, character ${vegetation.character}${vegetation.corridor ? `, route corridor ${vegetation.corridor.kept} of ${vegetation.corridor.lattice}, elsewhere ${vegetation.corridor.farKept} of ${vegetation.corridor.farLattice}` : ''}) ${JSON.stringify(vegetation.byKind)}, ${pois.length} POIs`);

  // 4. Write the bundle.
  t = Date.now();
  const payloads = [
    ['height.bin.gz', Buffer.from(height.bytes)],
    ['roads.json.gz', stableJson(roads)],
    ['water.json.gz', stableJson(water)],
    ['landcover.json.gz', stableJson(landcover.layer)],
    ['buildings.bin.gz', buildings.bytes],
    ['vegetation.bin.gz', vegetation.bytes],
    ['routes.json.gz', stableJson({ version: 1, routes: snapped.routes })],
    ...(bridgesLayer ? [['bridges.json.gz', stableJson(bridgesLayer)]] : []),
  ];
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);
  const files = [];
  const sizes = {};
  for (const [path, content] of payloads) {
    const stored = gzip(content);
    writeFileAtomic(join(outDir, path), stored);
    files.push({
      path,
      bytes: stored.length,
      sha256: sha256(stored),
      compression: 'gzip',
      contentBytes: content.length,
      contentSha256: sha256(content),
    });
    sizes[path] = { stored: stored.length, content: content.length, brotli: brotliSize(content) };
  }
  // Self-check: the stored heightfield decodes to the grid the routes were snapped on.
  const back = decodeHeightDeltas(new Uint8Array(gunzipSync(readFileSync(join(outDir, 'height.bin.gz')))), g.cols, g.rows);
  for (let i = 0; i < back.length; i++) if (back[i] !== height.hf.data[i]) throw new Error('height.bin round-trip mismatch');

  const manifest = {
    format: WORLD_FORMAT,
    version: WORLD_FORMAT_VERSION,
    id: recipe.id,
    name: recipe.name,
    origin: { lat: recipe.origin.lat, lon: recipe.origin.lon },
    projection: projection.params,
    extent,
    bbox,
    heightfield: { file: 'height.bin.gz', ...height.info },
    layers: {
      roads: 'roads.json.gz',
      water: 'water.json.gz',
      landcover: 'landcover.json.gz',
      buildings: 'buildings.bin.gz',
      vegetation: 'vegetation.bin.gz',
      routes: 'routes.json.gz',
      ...(bridgesLayer ? { bridges: 'bridges.json.gz' } : {}),
    },
    files,
    moods: recipe.moods,
    defaultMood: recipe.defaultMood,
    pois,
    routes: snapped.info.map(({ report: _report, ...r }) => r),
    stats: {
      roads: roads.roads.length,
      waterAreas: water.areas.length,
      waterLines: water.lines.length,
      landcoverAreas: landcover.layer.areas.length,
      buildings: buildings.count,
      buildingVertices: buildings.totalVerts,
      ...Object.fromEntries(Object.entries(buildings.districts).map(([k, v]) => [`buildings:${k}`, v])),
      trees: vegetation.count,
      ...Object.fromEntries(Object.entries(vegetation.byKind).map(([k, v]) => [`trees:${k}`, v])),
      pois: pois.length,
      carvedNodes: carve.carvedNodes,
      ...(bridgesLayer ? { bridgeDecks: bridgesLayer.decks.length, bridgePiers: bridgesLayer.piers.length } : {}),
    },
    credits: bundleCredits(recipe, demSource, names),
    generator: generatorFor(demSource, recipe, dem),
  };
  validateManifest(JSON.parse(JSON.stringify(manifest)));
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileAtomic(join(outDir, 'manifest.json'), manifestBytes);
  sizes['manifest.json'] = { stored: manifestBytes.length, content: manifestBytes.length, brotli: brotliSize(manifestBytes) };
  lap('write', t);

  const totals = Object.values(sizes).reduce(
    (a, s) => ({ stored: a.stored + s.stored, content: a.content + s.content, brotli: a.brotli + s.brotli }),
    { stored: 0, content: 0, brotli: 0 },
  );
  log(`bundle: ${(totals.stored / 1e6).toFixed(2)} MB gzip as shipped, ${(totals.brotli / 1e6).toFixed(2)} MB brotli, ${(totals.content / 1e6).toFixed(2)} MB raw`);
  checkBundleBudget(totals);

  // 5. P1.3 check against an independent DEM (not part of the bundle), then
  // the report and the recipe's `validation` (finishBake).
  const core = recipe.snap.coreCells * g.cellSize + recipe.snap.falloffM;
  const routeMask = (x, y) => snapped.routes.some((r) => r.x.some((rx, i) => Math.hypot(rx - x, r.y[i] - y) < core));
  const report = {
    world: recipe.id,
    bakedWith: `node ${process.version}`,
    timingsS: timings,
    sizes,
    totals,
    hashes: Object.fromEntries([...files.map((f) => [f.path, f.sha256]), ['manifest.json', sha256(manifestBytes)]]),
    routes: snapped.info.map((r) => ({ ...r, roadCoverage: roadCoverage[r.id] })),
    routeFit: routeFitReport(fit),
    heightfield: { ...height.info, carvedNodes: carve.carvedNodes, maxCutM: round(carve.maxCutM) },
    ...(seaFlat ? { coast: { seaPolygons: sea.length, islands: sea.reduce((n, p) => n + p.length - 1, 0), seaNodes: seaFlat.inNodes, shoreNodesLowered: seaFlat.stripNodes, beachNodesSloped: beachSlope.changed, beachMaxCutM: round(beachSlope.maxCutM), demUnderSea: seaFlat.before && { min: round(seaFlat.before.min), max: round(seaFlat.before.max) }, beachAreas: landcover.layer.areas.filter((a) => landcover.layer.kinds[a.k] === 'beach').length } } : {}),
    ...(decks
      ? {
          bridges: {
            networks: nets.length,
            pieces: bridgesLayer.decks.length,
            piers: bridgesLayer.piers.length,
            underDeckNodes: decks.cap.moved,
            underDeckMaxCutM: round(decks.cap.maxCutM),
            headroomPins: decks.first.pins.map((p) => ({ road: p.ri, name: roads.roads[p.ri].n !== undefined ? roads.names[roads.roads[p.ri].n] : null, route: p.route, routeS: round(p.routeS), liftM: round(p.liftM) })),
            approaches: decks.first.plan.lifts.map((l) => ({ bridge: l.bridge, route: l.route, routeS: round(l.routeS), liftM: round(l.liftM), rampM: round(l.rampM), ...(l.block ? { abutmentBlock: true } : {}) })),
            rides: bridgesLayer.rides,
          },
        }
      : {}),
    ...(lakes ? { flatLakes: lakes.map(({ nodes: _nodes, ...l }) => ({ ...l, level: round(l.level), before: { min: round(l.before.min), max: round(l.before.max) }, maxCutM: round(l.maxCutM) })) } : {}),
    buildingsDropped: { ...buildings.dropped, routeClearMinM: ROUTE_CLEAR_MIN_M, routeClearMaxM: ROUTE_CLEAR_MAX_M },
    ...(dryWater.length ? { waterDroppedOnRoutes: dryWater.length, waterDroppedToBeach: dryBeach } : {}),
    ...(glo30 ? { demSource: dem.source } : {}),
    demTiles: dem.tiles,
    ...(glo30 ? { demMissingTiles: dem.missing } : {}),
    overpass: { url: OVERPASS_URL, osmDate: recipe.osmDate, queries: osm.queries },
  };
  const written = await finishBake({
    validate: opts.validate,
    check: { hf: height.hf, projection, extent, recipe, demSource, cacheDir, routeMask },
    report,
    timings,
    t0,
    reportPath: join(ROOT, 'tools/worldbake/reports', `${recipe.id}.json`),
    recipePath,
    log,
  });
  if (opts.docs) writeCreditsBlock({ recipe, extent, bbox, dem, osm, manifest, glo30 });
  // The destination that links this world mirrors its bbox, routes, moods,
  // towns and credits (src/lib/world/destinations/*.json).
  if (!opts.out) syncDestinations({ log });
  log(`done in ${timings.total} s → ${outDir}`);
  return written;
}

/** Rewrite this world's generated block in docs/worlds/CREDITS.md. */
function writeCreditsBlock({ recipe, extent, bbox, dem, osm, manifest, glo30 }) {
  const path = join(ROOT, 'docs/worlds/CREDITS.md');
  const start = `<!-- world:${recipe.id}:start (generated by tools/worldbake/bake.mjs) -->`;
  const end = `<!-- world:${recipe.id}:end -->`;
  const tiles = dem.tiles.map((id) => `\`${id}\``).join(', ');
  const block = [
    start,
    recipe.host === 'remote'
      ? `### ${recipe.name} (\`worlds/${recipe.id}/<hash>/\` in the public R2 bucket; manifest \`tools/worldbake/remote/${recipe.id}/manifest.json\`)`
      : `### ${recipe.name} (\`public/worlds/${recipe.id}/\`)`,
    '',
    `- Bounding box (WGS84): south ${bbox.south}, west ${bbox.west}, north ${bbox.north}, east ${bbox.east}.`,
    `- World extent: x ${extent.xMin}…${extent.xMax} m, y ${extent.yMin}…${extent.yMax} m, local transverse Mercator at ${recipe.origin.lat}, ${recipe.origin.lon}.`,
    glo30
      ? `- Elevation: ${dem.tiles.length} Copernicus DEM GLO-30 tile${dem.tiles.length === 1 ? '' : 's'} (1″ COG), \`${GLO30_URL_TEMPLATE}\`: ${tiles}${dem.missing.length ? ` (${dem.missing.map((id) => `\`${id}\``).join(', ')} absent from the bucket: open ocean, read as 0 m)` : ''}. Required notice and liability disclaimer: "Copernicus DEM GLO-30 Public" above.`
      : `- Elevation: ${dem.tiles.length} Terrain Tiles (terrarium) at zoom ${dem.zoom}, \`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png\`: ${tiles}.`,
    `- OpenStreetMap: Overpass API (\`${OVERPASS_URL}\`), data as of ${recipe.osmDate} (attic query), layers ${Object.keys(osm.queries).join(', ')} over the bounding box above. Queries are recorded in \`tools/worldbake/reports/${recipe.id}.json\`.`,
    ...(recipe.routeCredits
      ? [
          `- Routes from \`src/lib/scenicRouteData.ts\` (profiles: Copernicus GLO-90 via Open-Meteo), geometry sources:`,
          ...manifest.routes.map((r) => {
            const c = manifest.credits.find((x) => x.id === `route-${r.id}`);
            return `  - \`${r.id}\`: ${c.name}, <${c.url}>.`;
          }),
        ]
      : [
          `- Routes: ${manifest.routes.map((r) => `\`${r.id}\``).join(', ')} from \`src/lib/scenicRouteData.ts\` (OSRM bike geometry + Copernicus GLO-90 profile via Open-Meteo).`,
        ]),
    `- Validation: ${P13_SAMPLE_COUNT} seeded Open-Meteo elevation samples (Copernicus GLO-90), not shipped.`,
    end,
  ].join('\n');
  let doc = readFileSync(path, 'utf8');
  const a = doc.indexOf(start.slice(0, start.indexOf(' (generated')));
  const b = doc.indexOf(end);
  if (a >= 0 && b > a) doc = doc.slice(0, a) + block + doc.slice(b + end.length);
  else {
    const marker = '<!-- worlds:end -->';
    if (!doc.includes(marker)) throw new Error('docs/worlds/CREDITS.md has no <!-- worlds:end --> marker');
    doc = doc.replace(marker, `${block}\n\n${marker}`);
  }
  writeFileSync(path, doc);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  bake(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
