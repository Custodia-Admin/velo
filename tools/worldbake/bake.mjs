#!/usr/bin/env node
// Velo world bake: `node tools/worldbake/bake.mjs <world> [options]`
//
//   --clean            delete this world's cached downloads first (clean-cache bake)
//   --no-validate      skip the Open-Meteo heightfield check
//   --out <dir>        output dir (default public/worlds/<world>)
//   --cache <dir>      download cache (default tools/worldbake/cache, env WORLDBAKE_CACHE)
//   --no-docs          don't rewrite this world's block in docs/worlds/CREDITS.md
//
// Same recipe + same cached inputs → byte-identical bundle (sha256 per file in
// manifest.json). OSM queries are pinned to the recipe's osmDate, so a clean
// cache re-downloads the same data. Runs on the bake host (cat-bed), not the
// laptop: see docs/worlds/WORLD-FORMAT.md "Baking".

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createProjection } from '../../src/lib/world/projection.ts';
import { decodeHeightDeltas } from '../../src/lib/world/heightfield.ts';
import { validateManifest, WORLD_FORMAT, WORLD_FORMAT_VERSION } from '../../src/lib/world/manifest.ts';
import { fetchDem, DEM_SOURCE } from './fetchDem.mjs';
import { fetchOsm, OVERPASS_URL } from './fetchOsm.mjs';
import { sampleGrid, buildHeightfield } from './buildHeightfield.mjs';
import { buildRoads, buildWater, buildLandcover, buildBuildings, buildVegetation, buildPois, buildTreeRows } from './buildVectors.mjs';
import { carveRoutes, finishRoutes, loadScenicGeometry, loadScenicNames } from './snapRoutes.mjs';
import { validateHeightfield } from './validateDem.mjs';
import { brotliSize, ensureDir, gzip, here, sha256, stableJson, writeFileAtomic } from './util.mjs';

const TOOL_VERSION = 1;
const ROOT = resolve(here(import.meta.url), '../..');

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
  const recipeBytes = readFileSync(recipePath);
  const recipe = JSON.parse(recipeBytes.toString('utf8'));
  const outDir = resolve(opts.out ?? join(ROOT, 'public/worlds', recipe.id));
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
  const dem = await fetchDem({ bbox: demBbox, zoom: recipe.dem.zoom, cacheDir, log });
  const heights = sampleGrid({ grid: g, projection, dem });
  lap('dem', t);

  // 2. Routes: carve corridors into the float grid, then quantise.
  t = Date.now();
  const geometry = loadScenicGeometry(join(ROOT, 'src/lib/scenicRouteData.ts'));
  const names = loadScenicNames(join(ROOT, 'src/lib/scenicRoutes.ts'));
  const routesIn = recipe.routes.map((id) => {
    if (!geometry[id]) throw new Error(`route ${id} not in src/lib/scenicRouteData.ts`);
    return { id, name: names[id] ?? id, points: geometry[id].points };
  });
  const carve = carveRoutes({ grid: g, heights, projection, routes: routesIn, snap: recipe.snap });
  const height = buildHeightfield({ grid: g, heights });
  const snapped = finishRoutes({ prepared: carve.prepared, hf: height.hf, snap: recipe.snap });
  for (const r of snapped.info) {
    log(`route ${r.id}: ${(r.lengthM / 1000).toFixed(2)} km, max gap ${r.maxGapM} m, grade Δ ${r.gradeMeanAbsDiffPct} pp mean (raw DEM ${r.report.rawDemGradeMeanAbsDiffPct} pp)`);
  }
  log(`heightfield: ${height.info.minHeight.toFixed(1)}–${height.info.maxHeight.toFixed(1)} m, step ${height.info.heightScale} m, ${carve.carvedNodes} nodes carved (max ${carve.maxCutM.toFixed(1)} m)`);
  lap('heightfield+routes', t);

  // 3. Vectors.
  t = Date.now();
  const osm = await fetchOsm({ bbox, osmDate: recipe.osmDate, cacheDir, log });
  lap('osm', t);
  t = Date.now();
  const roads = buildRoads(osm.elements.roads, projection, extent);
  const water = buildWater(osm.elements.water, projection, extent);
  const landcover = buildLandcover(osm.elements.landcover, projection, extent);
  const buildings = buildBuildings(osm.elements.buildings, projection, extent, landcover.polys);
  const vegetation = buildVegetation({
    polys: landcover.polys,
    ext: extent,
    recipe: recipe.vegetation,
    roads,
    water,
    footprints: buildings.footprints,
    treeRows: buildTreeRows(osm.elements.treerows, projection, extent),
  });
  const pois = buildPois([...osm.elements.pois, ...osm.elements.landmarks], projection, extent).map((p) => ({ ...p, h: round(height.hf.sampleHeight(p.x, p.y)) }));
  lap('vectors', t);
  log(`vectors: ${roads.roads.length} road pieces, ${water.areas.length} water areas + ${water.lines.length} lines, ${landcover.layer.areas.length} landcover, ${buildings.count} buildings ${JSON.stringify(buildings.districts)}, ${vegetation.count} trees (woodland lattice ${vegetation.lattice}, character ${vegetation.character}) ${JSON.stringify(vegetation.byKind)}, ${pois.length} POIs`);

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
    },
    credits: CREDITS,
    generator: {
      tool: 'velo-worldbake',
      version: TOOL_VERSION,
      recipeSha256: sha256(recipeBytes),
      osmDate: recipe.osmDate,
      demSource: DEM_SOURCE,
      demZoom: recipe.dem.zoom,
      demTiles: dem.tiles.length,
    },
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

  // 5. Validation against an independent DEM (not part of the bundle).
  let validation = null;
  if (opts.validate) {
    t = Date.now();
    const core = recipe.snap.coreCells * g.cellSize + recipe.snap.falloffM;
    const mask = (x, y) => snapped.routes.some((r) => r.x.some((rx, i) => Math.hypot(rx - x, r.y[i] - y) < core));
    validation = await validateHeightfield({ hf: height.hf, projection, extent, recipe, cacheDir, routeMask: mask });
    lap('validate', t);
    log(`validate: RMS ${validation.rmsM} m vs Open-Meteo over ${validation.samples} points (bias ${validation.meanBiasM} m, max ${validation.maxAbsM} m) → ${validation.pass ? 'PASS' : 'FAIL'}`);
  }
  timings.total = round((Date.now() - t0) / 1000, 1);

  const report = {
    world: recipe.id,
    bakedWith: `node ${process.version}`,
    timingsS: timings,
    sizes,
    totals,
    hashes: Object.fromEntries([...files.map((f) => [f.path, f.sha256]), ['manifest.json', sha256(manifestBytes)]]),
    routes: snapped.info,
    heightfield: { ...height.info, carvedNodes: carve.carvedNodes, maxCutM: round(carve.maxCutM) },
    demTiles: dem.tiles,
    overpass: { url: OVERPASS_URL, osmDate: recipe.osmDate, queries: osm.queries },
    validation,
  };
  const reportDir = join(ROOT, 'tools/worldbake/reports');
  ensureDir(reportDir);
  writeFileSync(join(reportDir, `${recipe.id}.json`), `${JSON.stringify(report, null, 2)}\n`);
  if (opts.docs) writeCreditsBlock({ recipe, extent, bbox, dem, osm, manifest });
  log(`done in ${timings.total} s → ${outDir}`);
  return report;
}

/** Rewrite this world's generated block in docs/worlds/CREDITS.md. */
function writeCreditsBlock({ recipe, extent, bbox, dem, osm, manifest }) {
  const path = join(ROOT, 'docs/worlds/CREDITS.md');
  const start = `<!-- world:${recipe.id}:start (generated by tools/worldbake/bake.mjs) -->`;
  const end = `<!-- world:${recipe.id}:end -->`;
  const tiles = dem.tiles.map((id) => `\`${id}\``).join(', ');
  const block = [
    start,
    `### ${recipe.name} (\`public/worlds/${recipe.id}/\`)`,
    '',
    `- Bounding box (WGS84): south ${bbox.south}, west ${bbox.west}, north ${bbox.north}, east ${bbox.east}.`,
    `- World extent: x ${extent.xMin}…${extent.xMax} m, y ${extent.yMin}…${extent.yMax} m, local transverse Mercator at ${recipe.origin.lat}, ${recipe.origin.lon}.`,
    `- Elevation: ${dem.tiles.length} Terrain Tiles (terrarium) at zoom ${dem.zoom}, \`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png\`: ${tiles}.`,
    `- OpenStreetMap: Overpass API (\`${OVERPASS_URL}\`), data as of ${recipe.osmDate} (attic query), layers ${Object.keys(osm.queries).join(', ')} over the bounding box above. Queries are recorded in \`tools/worldbake/reports/${recipe.id}.json\`.`,
    `- Routes: ${manifest.routes.map((r) => `\`${r.id}\``).join(', ')} from \`src/lib/scenicRouteData.ts\` (OSRM bike geometry + Copernicus GLO-90 profile via Open-Meteo).`,
    `- Validation: ${recipe.validation.samples} seeded Open-Meteo elevation samples (Copernicus GLO-90), not shipped.`,
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
