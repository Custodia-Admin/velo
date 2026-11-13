// Bare ground under the routes (recipe `bareGround`).
//
// Copernicus GLO-30 is a surface model: over a forest it reports the top of
// the canopy, over a town the roofs. The route fit (snapRoutes.mjs) takes its
// slow offset from that surface, so in a forested valley the route rides on
// the treetops: the Ohio & Erie towpath sat 10–21 m over the ground through
// the Cuyahoga Valley woods, and where it came out of them at Peninsula it
// still stood 6–11 m over the open ground, so the bridges step lifted Main
// Street 14.9 m onto a 298 m viaduct to clear it.
//
// Where an open bare-earth model (a DTM) covers a world, the bake swaps it in
// along the routes BEFORE the route fit: every grid node within `corridorM`
// of a route takes the DTM height, and the next `blendM` blend back to the
// surface model with a smoothstep. The fit and the carve then work on the
// ground, so the route keeps the profile's shape at ground level, and the
// trees, buildings and decks the bake places along the routes stand on the
// ground too. Further out the world stays on GLO-30: the P1.3 v2 gate checks
// the heightfield against Copernicus GLO-90, itself a surface model, and a
// world-wide swap would fail it in any forested world (Cuyahoga Valley:
// 60 % woodland, canopy 15–25 m).
//
// The DTM sits on its own vertical datum (NAVD 88 for 3DEP, LN02 for
// swissALTI3D), not GLO-30's EGM2008. `biasM` = the median of GLO-30 − DTM
// over flat, open corridor nodes (no woodland polygon within 30 m, DTM slope
// under 5 %) is added to the DTM, so open ground keeps GLO-30's level and the
// blend has no step there.
//
// Sources (recipe `bareGround.source`):
// - "usgs-3dep-13": USGS 3D Elevation Program 1/3 arc-second DEM (United
//   States), 1° × 1° Cloud Optimized GeoTIFFs on the prd-tnm S3 bucket, LZW +
//   floating-point predictor, float32, PixelIsArea, NAD83 geographic, a
//   6-pixel overlap round each tile, nodata −999999. Tile `n42w082` covers
//   41–42° N, 81–82° W. The recipe pins each tile's dated release
//   (`tiles: { "n42w082": "20230911" }`, the `historical/` copy, which never
//   changes), so a clean-cache bake downloads the same bytes. Read bilinear
//   at the node (pixels ≈ 8 × 10 m at 41° N, under the 12 m grid).
//   NAD83(2011) and WGS84 differ by about 1 m horizontally; not corrected.
// - "swissalti3d": swisstopo swissALTI3D 2 m (Switzerland), 1 km × 1 km
//   GeoTIFFs in LV95 (EPSG:2056) from data.geo.admin.ch, LZW, float32,
//   PixelIsArea, nodata −9999. The recipe pins the release year (`year`);
//   only the tiles the corridor touches are fetched. Grid nodes are put into
//   LV95 with swisstopo's approximate formulas (about 1 m), and each node takes
//   the mean of the k × k pixels round it (k = the odd number nearest half
//   the cell size in metres), so the 2 m model is averaged down to the grid
//   instead of point-sampled. Tiles outside Switzerland 404: no DTM there
//   (checked against the STAC catalogue: a tile that has releases, only not
//   the pinned year, stops the bake).
// - "lombardia-dtm5": Regione Lombardia DTM 5×5 (edition 2015), from the
//   region's ArcGIS ImageServer (cartografia.servizirl.it, CC BY 4.0). WGS84 /
//   UTM 32N (EPSG:32632), 5 m pixels on a fixed grid from the service
//   extent's corner, orthometric. The bake asks the ImageServer for 2 km tiles
//   snapped to that grid (nearest neighbour, so no resampling: each tile is
//   the stored pixels), LZW float32 GeoTIFFs, PixelIsArea, nodata −9999. The
//   service sets no release; its metadata (grid, pixel, CRS) is checked
//   against these constants before a tile is read. Outside the LiDAR
//   surveys the model is built from the regional topographic database (DBT:
//   10 m contours, spot heights and 3D road and water edges); along roads it
//   reads the road. Each node takes the mean of the k × k pixels round it.
// - "mase-pst-lidar": the Italian Ministry of the Environment's LiDAR DTM
//   1 m (Piano Straordinario di Telerilevamento Ambientale, flown 2008–2010,
//   CC BY 4.0), 0.01° × 0.01° tiles of 1000 × 1000 pixels in WGS84
//   geographic, PixelIsPoint, float32, uncompressed, nodata −9999 (water and
//   gaps), orthometric. A tile is ordered from the PST download service
//   (sim.mase.gov.it): the tile index names it, a POST asks for a zip of
//   the tiles, the session is polled until the zip is ready. The tiles are
//   cached; the survey is closed, so they never change. Each node takes the
//   mean of the pixels within half a cell round it.
// - "inegi-mdt-10k": INEGI's 1:10 000 Modelo Digital de Elevación tipo
//   terreno, 5 m (Mexico), one zip per sheet and edition: an ESRI BIL in UTM
//   (inegiMdt.mjs). The recipe pins every sheet the corridor touches to its
//   product UPC (`sheets: { "F13C69A4": "702825005109" }`; null = INEGI has
//   no product there, the open sea). Each node takes the mean of the k × k
//   pixels round it (k = 3 at 12 m), read from the sheet whose cell holds it.
// - "ign-rge-alti": IGN's RGE ALTI (France, Licence Ouverte 2.0) from the
//   Géoplateforme raster WMS (data.geopf.fr/wms-r, layer
//   ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES, "Modèle Numérique de Terrain issu
//   du RGEALTI"), asked for 1 km × 1 km Lambert-93 tiles (EPSG:2154) at 2 m,
//   float32 GeoTIFF, PixelIsArea, nodata −99999, orthometric (NGF-IGN69). The
//   WMS serves the model nearest-neighbour from a coarser grid: at Annecy a
//   2 m tile repeats each value over 1.7 pixels east–west and 2.4 north–south
//   on average (3.4 × 4.9 m, about 0.15″), so a node's k × k box averages
//   several model cells, not one pixel. The service sets no release. Each
//   node takes the box mean.
// - "veneto-lidar5": the Regione del Veneto's harmonised DTM from its LiDAR
//   surveys, 5 m (IODL 2.0, the region's geoportal), 2 km × 2 km ESRI ASCII
//   grids in RDN2008 / Fuso 12 (EPSG:7795: transverse Mercator on 12° E, scale
//   1, false easting 3,000,000 m), 400 × 400 pixel centres on the 2 km grid,
//   nodata −9999 (lakes), orthometric. Tiles are numbered, not gridded: the
//   geoportal's WFS tile index names them and gives each its download id. The
//   index polygons are drawn on Monte Mario (EPSG:3003) and land about 80 m
//   off, so a tile is placed by its own grid header, never by the index.
//   Each node takes the mean of the k × k pixels round it.
//
// The Italian models, RGE ALTI and the Veneto DTM read a node from the
// pixels that have a value when at least half of the box does: a node on a
// lake shore reads the land beside it, one out on the water none.
//
// A node without a DTM value (nodata, a 404 tile, a sheet without a product)
// keeps its GLO-30 height.

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { cachedFetch, ensureDir, sha256, sleep, USER_AGENT, writeFileAtomic } from './util.mjs';
import { geoKey, geoKeyAny, geoReference, openRaster, parseTiff } from './geotiff.mjs';
import { appRoutePoints } from './snapRoutes.mjs';
import { INEGI_MDT_BASE, INEGI_MDT_CATALOGUE, readZip, checkInegiCoverage, inegiBoxSize, inegiSampler, inegiSheetName, inegiSheetUrl, openInegiSheet } from './inegiMdt.mjs';
import { createProjection } from '../../src/lib/world/projection.ts';

export const BARE_GROUND_SOURCES = ['usgs-3dep-13', 'swissalti3d', 'inegi-mdt-10k', 'lombardia-dtm5', 'mase-pst-lidar', 'ign-rge-alti', 'veneto-lidar5'];
/** Full DTM within this many metres of a route (default). */
export const BARE_GROUND_CORRIDOR_M = 150;
/** Then a smoothstep back to the surface model over this many metres (default). */
export const BARE_GROUND_BLEND_M = 300;
/** Open ground for the datum bias: no woodland polygon within this distance... */
export const BIAS_WOODLAND_CLEAR_M = 30;
/** ...and a DTM slope under this. */
export const BIAS_MAX_SLOPE = 0.05;
/** Landcover kinds that carry a canopy (buildVectors LANDCOVER_KINDS). */
export const WOODLAND_KINDS = ['forest', 'scrub', 'orchard'];
/**
 * Where the datum bias is measured (recipe `bareGround.biasFrom`): "open" =
 * flat corridor nodes with no woodland within 30 m (default); "beach" = flat
 * corridor nodes on a coast world's beaches and sand, for a corridor through
 * a town, where GLO-30 reads the roofs and street trees on the "open" nodes
 * (Puerto Vallarta: GLO-30 − DTM is +3.35 m over residential land, +0.04 m on
 * the beaches).
 */
export const BIAS_FROM = ['open', 'beach'];

export const USGS_3DEP_BASE = 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF';
export const SWISSALTI3D_BASE = 'https://data.geo.admin.ch/ch.swisstopo.swissalti3d';

export const BARE_GROUND_CREDITS = {
  'usgs-3dep-13': {
    id: 'usgs-3dep',
    name: 'USGS 3D Elevation Program (3DEP) 1/3 arc-second DEM, bare earth, along the routes',
    licence: 'Public domain (U.S. Geological Survey); credit requested',
    url: 'https://www.usgs.gov/3d-elevation-program',
    attribution: 'U.S. Geological Survey, 3D Elevation Program 1/3 arc-second Digital Elevation Model',
  },
  swissalti3d: {
    id: 'swissalti3d',
    name: 'swissALTI3D 2 m, bare earth, along the routes',
    licence: 'Open Government Data of the Swiss Confederation, free use with source attribution (swisstopo terms of use)',
    url: 'https://www.swisstopo.admin.ch/en/height-model-swissalti3d',
    attribution: 'Source: Federal Office of Topography swisstopo',
  },
  'inegi-mdt-10k': {
    id: 'inegi-mdt',
    name: 'INEGI Modelo Digital de Elevación tipo terreno 1:10 000, 5 m, bare earth, along the routes',
    licence: 'Términos de Libre Uso de la Información del INEGI (free use, commercial included, with attribution)',
    url: 'https://www.inegi.org.mx/inegi/terminos.html',
    attribution:
      'Fuente: INEGI, Modelo Digital de Elevación tipo terreno con resolución de 5 m, escala 1:10 000. Transformed by Velo, not by INEGI: averaged onto the world grid, shifted to the Copernicus DEM height level and blended into it beside the routes.',
  },
  'lombardia-dtm5': {
    id: 'lombardia-dtm5',
    name: 'DTM 5×5 Regione Lombardia (edition 2015), bare earth, along the routes',
    licence: 'CC BY 4.0 (Regione Lombardia open data); averaged to the world grid',
    url: 'https://www.geoportale.regione.lombardia.it/',
    attribution: 'DTM 5x5 – Modello digitale del terreno (ed. 2015) © Regione Lombardia',
  },
  'mase-pst-lidar': {
    id: 'mase-pst-lidar',
    name: 'LiDAR DTM 1 m of the Piano Straordinario di Telerilevamento Ambientale, bare earth, along the routes',
    licence: 'CC BY 4.0 (MASE Geoportale Nazionale); averaged to the world grid',
    url: 'https://gn.mase.gov.it/portale/distribuzione-dati-pst',
    attribution: "Contains LiDAR DTM 1 m data from the Piano Straordinario di Telerilevamento Ambientale, © Ministero dell'Ambiente e della Sicurezza Energetica (MASE) – Geoportale Nazionale",
  },
  'ign-rge-alti': {
    id: 'ign-rge-alti',
    name: 'RGE ALTI®, IGN digital terrain model, bare earth, along the routes',
    licence: 'Licence Ouverte / Open Licence 2.0 (Etalab); averaged to the world grid',
    url: 'https://cartes.gouv.fr/rechercher-une-donnee/dataset/IGNF_RGE-ALTI',
    attribution: 'Contains RGE ALTI® data © IGN (Institut national de l’information géographique et forestière), as served by the Géoplateforme',
  },
  'veneto-lidar5': {
    id: 'veneto-lidar5',
    name: 'DTM LiDAR 5 m of the Regione del Veneto, bare earth, along the routes',
    licence: 'Italian Open Data Licence 2.0 (IODL 2.0, as the geoportal\'s metadata for the DTM states); averaged to the world grid',
    url: 'https://idt2.regione.veneto.it/nuovo-dtm-derivato-da-dati-lidar/',
    attribution: 'DTM armonizzato derivato da dati LiDAR, celle 5 m © Regione del Veneto – IDT-RV 2.0',
  },
};

/** The DTM's line in docs/worlds/CREDITS.md (after "Bare ground along the routes (…): "), for `recipe.bareGround`. */
export function bareGroundCreditLine(recipe) {
  const b = recipe.bareGround;
  switch (b.source) {
    case 'usgs-3dep-13':
      return `USGS 3DEP 1/3 arc-second DEM, \`${USGS_3DEP_BASE}/historical/{tile}/USGS_13_{tile}_{release}.tif\`: ${Object.entries(b.tiles).map(([k, v]) => `\`${k}\` (${v})`).join(', ')}. Public domain.`;
    case 'swissalti3d':
      return `swissALTI3D 2 m, release ${b.year}, 1 km tiles from \`${SWISSALTI3D_BASE}/\`. Source: Federal Office of Topography swisstopo.`;
    case 'inegi-mdt-10k': {
      const k = inegiBoxSize(recipe.grid.cellSize, 5);
      return `INEGI Modelo Digital de Elevación tipo terreno 1:10 000 (5 m), \`${INEGI_MDT_BASE}/{upc}_b.zip\`, sheets ${Object.entries(b.sheets).map(([k, v]) => `\`${k}\` (${v ?? 'no product'})`).join(', ')}. Fuente: INEGI, Modelo Digital de Elevación tipo terreno con resolución de 5 m, escala 1:10 000 (Términos de Libre Uso de la Información del INEGI). Transformed by the bake, not by INEGI: each grid node is the mean of the ${k} × ${k} pixels round it, shifted by the datum bias to GLO-30's level (measured over ${bareGroundOptions(recipe).biasFrom === 'beach' ? 'the beaches' : 'flat open ground'}) and blended into GLO-30 beside the routes.`;
    }
    case 'lombardia-dtm5':
      return `Regione Lombardia DTM 5x5 (ed. 2015), 2 km tiles of its stored 5 m grid from \`${LOMBARDIA_DTM5.service}/exportImage\`, averaged to the world grid. CC BY 4.0, © Regione Lombardia.`;
    case 'mase-pst-lidar':
      return `LiDAR DTM 1 m of the Piano Straordinario di Telerilevamento Ambientale (2008–2010), 0.01° tiles ordered from \`${MASE_PST.api}\`, averaged to the world grid. CC BY 4.0, © Ministero dell'Ambiente e della Sicurezza Energetica (MASE) – Geoportale Nazionale.`;
    case 'ign-rge-alti':
      return `IGN RGE ALTI® (layer \`${IGN_RGE_ALTI.layer}\`, "Modèle Numérique de Terrain issu du RGEALTI"), 1 km Lambert-93 tiles at 2 m from the Géoplateforme WMS \`${IGN_RGE_ALTI.service}\`, averaged to the world grid. Licence Ouverte / Open Licence 2.0 (Etalab), © IGN.`;
    case 'veneto-lidar5':
      return `Regione del Veneto DTM LiDAR 5 m (harmonised from the region's LiDAR surveys, RDN2008 / Fuso 12), 2 km tiles from \`${VENETO_LIDAR5.download}\`, named by the geoportal's tile index (\`${VENETO_LIDAR5.layer}\`), averaged to the world grid. Italian Open Data Licence 2.0 (IODL 2.0), © Regione del Veneto.`;
    default:
      throw new Error(`no credit line for bareGround ${b.source}`);
  }
}

/** The recipe's `bareGround` with defaults, checked. Null when the recipe has none. */
export function bareGroundOptions(recipe) {
  const b = recipe.bareGround;
  if (b === undefined) return null;
  if (!b || typeof b !== 'object') throw new Error('recipe bareGround must be an object');
  if (!BARE_GROUND_SOURCES.includes(b.source)) throw new Error(`recipe bareGround.source must be one of ${BARE_GROUND_SOURCES.join(', ')}`);
  const corridorM = b.corridorM ?? BARE_GROUND_CORRIDOR_M;
  const blendM = b.blendM ?? BARE_GROUND_BLEND_M;
  if (!(corridorM >= 0) || !(blendM > 0)) throw new Error('recipe bareGround: corridorM must be ≥ 0 and blendM > 0');
  if (b.source === 'usgs-3dep-13') {
    if (!b.tiles || typeof b.tiles !== 'object') throw new Error('recipe bareGround "usgs-3dep-13" needs tiles: { "<n42w082>": "<yyyymmdd release>" }');
    for (const [k, v] of Object.entries(b.tiles)) {
      if (!/^[ns]\d{2}[ew]\d{3}$/.test(k) || !/^\d{8}$/.test(v)) throw new Error(`recipe bareGround.tiles: bad entry ${k}: ${v}`);
    }
  }
  if (b.source === 'swissalti3d' && !Number.isInteger(b.year)) throw new Error('recipe bareGround "swissalti3d" needs year (the swissALTI3D release, e.g. 2022)');
  if (b.source === 'inegi-mdt-10k') {
    if (!b.sheets || typeof b.sheets !== 'object') throw new Error('recipe bareGround "inegi-mdt-10k" needs sheets: { "<F13C69A4>": "<product UPC>" | null }');
    for (const [k, v] of Object.entries(b.sheets)) {
      if (!/^[A-Z]\d{1,2}[A-D][1-8][1-9][A-F][1-4]$/.test(k) || !(v === null || (typeof v === 'string' && /^\d{12}$/.test(v)))) throw new Error(`recipe bareGround.sheets: bad entry ${k}: ${v}`);
    }
  }
  const biasFrom = b.biasFrom ?? 'open';
  if (!BIAS_FROM.includes(biasFrom)) throw new Error(`recipe bareGround.biasFrom must be one of ${BIAS_FROM.join(', ')}`);
  if (biasFrom === 'beach' && !recipe.coast) throw new Error('recipe bareGround.biasFrom "beach" needs coast: true (the beaches come from the coast layer)');
  return { ...b, corridorM, blendM, biasFrom };
}

// --- USGS 3DEP 1/3″ -----------------------------------------------------

const pad = (n, w) => String(n).padStart(w, '0');

/** 3DEP tile name for the 1° cell holding (lat, lon): n42w082 = 41–42° N, 82–81° W (NW corner). */
export function usgsTileName(lat, lon) {
  const top = Math.floor(lat) + 1;
  const west = Math.floor(lon);
  if (top <= 0) throw new Error('USGS 3DEP tiles south of the equator are not supported');
  return `n${pad(top, 2)}${west < 0 ? 'w' : 'e'}${pad(Math.abs(west), 3)}`;
}

export const usgsTileUrl = (name, release) => `${USGS_3DEP_BASE}/historical/${name}/USGS_13_${name}_${release}.tif`;

/** Check a decoded 3DEP tile against the cell it should cover; returns its georeference. */
export function checkUsgsTile(name, tiff, raster) {
  const geo = geoReference(tiff);
  const where = `USGS 3DEP ${name}`;
  if (geo.modelType !== 2) throw new Error(`${where}: GTModelType ${geo.modelType}, expected geographic (2)`);
  if (geo.geographicType !== 4269 && geo.geographicType !== 4326) throw new Error(`${where}: GeographicType ${geo.geographicType}, expected NAD83 (4269)`);
  const top = Number(name.slice(1, 3));
  const west = (name[3] === 'w' ? -1 : 1) * Number(name.slice(4, 7));
  // The tile's own 1° cell must lie inside its pixel centres with a pixel to spare (the overlap).
  const x1 = geo.x0 + (raster.width - 1) * geo.scaleX;
  const y1 = geo.y0 - (raster.height - 1) * geo.scaleY;
  if (!(geo.x0 < west - geo.scaleX && x1 > west + 1 + geo.scaleX && geo.y0 > top + geo.scaleY && y1 < top - 1 - geo.scaleY)) {
    throw new Error(`${where}: pixel centres ${geo.x0}…${x1}° E, ${y1}…${geo.y0}° N don't cover the tile's cell with its overlap`);
  }
  return geo;
}

/**
 * Bilinear reader over a set of decoded 3DEP tiles. Each read uses the tile
 * whose own 1° cell holds the point; the tiles' 6-pixel overlap holds the
 * 2 × 2 neighbourhood. NaN where a neighbour is nodata or no tile was loaded.
 */
export function usgsSampler(tiles) {
  return (lat, lon) => {
    const t = tiles.get(usgsTileName(lat, lon));
    if (!t) return NaN;
    const { raster, geo, noData } = t;
    const fi = (lon - geo.x0) / geo.scaleX;
    const fj = (geo.y0 - lat) / geo.scaleY;
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const a = raster.value(i, j), b = raster.value(i + 1, j), c = raster.value(i, j + 1), d = raster.value(i + 1, j + 1);
    if (a === noData || b === noData || c === noData || d === noData) return NaN;
    const tx = fi - i, ty = fj - j;
    const top = a + (b - a) * tx;
    return top + (c + (d - c) * tx - top) * ty;
  };
}

async function fetchUsgs({ opts, points, cacheDir, log }) {
  const dir = join(cacheDir, 'usgs-3dep-13');
  ensureDir(dir);
  const names = [...new Set(points.map(([lat, lon]) => usgsTileName(lat, lon)))].sort();
  const tiles = new Map();
  let fetched = 0;
  for (const name of names) {
    const release = opts.tiles[name];
    if (!release) {
      throw new Error(
        `bareGround: the corridor needs USGS 3DEP tile ${name}; pin its release in the recipe (bareGround.tiles.${name} = the date of the ${USGS_3DEP_BASE}/historical/${name}/USGS_13_${name}_<yyyymmdd>.tif whose ETag equals current/${name}/USGS_13_${name}.tif's; the <pubdate> in current/${name}/USGS_13_${name}.xml can be a day later)`,
      );
    }
    const res = await cachedFetch(dir, `USGS_13_${name}_${release}.tif`, usgsTileUrl(name, release), {}, { label: `USGS 3DEP ${name}` });
    if (!res.cached) fetched++;
    const tiff = parseTiff(res.body);
    const raster = openRaster(tiff);
    const geo = checkUsgsTile(name, tiff, raster);
    tiles.set(name, { raster, geo, noData: geo.noData === undefined ? NaN : Number(geo.noData) });
  }
  log(`bareGround: ${names.length} USGS 3DEP 1/3″ tile${names.length === 1 ? '' : 's'} (${fetched} downloaded): ${names.join(', ')}`);
  return { tiles: names.map((n) => `${n}@${opts.tiles[n]}`), sample: usgsSampler(tiles) };
}

// --- swissALTI3D --------------------------------------------------------

/**
 * WGS84 → LV95 (E, N), swisstopo's approximate formulas ("Approximate
 * formulas for the transformation between Swiss projection coordinates and
 * WGS84"), accurate to about 1 m.
 */
export function wgs84ToLv95(lat, lon) {
  const p = (lat * 3600 - 169028.66) / 10000;
  const l = (lon * 3600 - 26782.5) / 10000;
  const E = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l * l * l;
  const N = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p * p * p;
  return [E, N];
}

/** LV95 (E, N) → WGS84 [lat, lon], the same approximate formulas the other way (about 1 m). */
export function lv95ToWgs84(E, N) {
  const y = (E - 2600000) / 1e6;
  const x = (N - 1200000) / 1e6;
  const l = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
  const p = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x * x * x;
  return [(p * 100) / 36, (l * 100) / 36];
}

export const SWISSALTI3D_STAC = 'https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.swissalti3d/items';

/**
 * The swissALTI3D releases of 1 km tile `id` the STAC catalogue lists
 * (years, ascending). A tile 404s either outside the model's coverage (no
 * release at all) or because it has no release of the pinned year; only the
 * first may be read as "no DTM here".
 */
export async function swissTileYears(id, fetchJson = defaultFetchJson) {
  const [e, n] = id.split('-').map(Number);
  const [lat, lon] = lv95ToWgs84(e * 1000 + 500, n * 1000 + 500);
  const body = await fetchJson(`${SWISSALTI3D_STAC}?bbox=${lon},${lat},${lon},${lat}`);
  const years = [];
  for (const f of body.features ?? []) {
    const m = /^swissalti3d_(\d{4})_(\d+-\d+)$/.exec(f.id);
    if (m && m[2] === id) years.push(Number(m[1]));
  }
  return years.sort((a, b) => a - b);
}

async function defaultFetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export const swissTileId = (E, N) => `${Math.floor(E / 1000)}-${Math.floor(N / 1000)}`;
export const swissTileUrl = (id, year) => `${SWISSALTI3D_BASE}/swissalti3d_${year}_${id}/swissalti3d_${year}_${id}_2_2056_5728.tif`;

/** Box mean of k × k pixels round (E, N) over 1 km swissALTI3D tiles; NaN when any pixel is missing. */
export function swissSampler(tiles, k) {
  const half = (k - 1) / 2;
  const px = (E, N) => {
    const t = tiles.get(swissTileId(E, N));
    if (!t) return NaN;
    const i = Math.floor((E - t.e0) / 2);
    const j = Math.floor((t.n0 - N) / 2);
    const v = t.raster.value(Math.min(t.raster.width - 1, Math.max(0, i)), Math.min(t.raster.height - 1, Math.max(0, j)));
    return v === t.noData ? NaN : v;
  };
  return (lat, lon) => {
    const [E, N] = wgs84ToLv95(lat, lon);
    // Centre on the pixel holding the point (pixels are 2 m, centres on odd metres).
    const cE = Math.floor(E / 2) * 2 + 1;
    const cN = Math.floor(N / 2) * 2 + 1;
    let sum = 0;
    for (let a = -half; a <= half; a++) {
      for (let b = -half; b <= half; b++) {
        const v = px(cE + 2 * a, cN + 2 * b);
        if (Number.isNaN(v)) return NaN;
        sum += v;
      }
    }
    return sum / (k * k);
  };
}

async function fetchSwiss({ opts, points, cellSize, cacheDir, log }) {
  const dir = join(cacheDir, `swissalti3d-${opts.year}`);
  ensureDir(dir);
  const k = 2 * Math.floor(cellSize / 4) + 1;
  const reach = (k + 1) * 2;
  const ids = new Set();
  for (const [lat, lon] of points) {
    const [E, N] = wgs84ToLv95(lat, lon);
    for (const dE of [-reach, 0, reach]) for (const dN of [-reach, 0, reach]) ids.add(swissTileId(E + dE, N + dN));
  }
  const sorted = [...ids].sort();
  const tiles = new Map();
  const missing = [];
  let fetched = 0;
  for (const id of sorted) {
    const marker = join(dir, `${id}.404`);
    if (existsSync(marker)) {
      missing.push(id);
      continue;
    }
    let res;
    try {
      res = await cachedFetch(dir, `${id}.tif`, swissTileUrl(id, opts.year), {}, { label: `swissALTI3D ${opts.year} ${id}` });
    } catch (err) {
      if (err.status !== 404) throw err;
      const years = await swissTileYears(id);
      if (years.length) throw new Error(`bareGround: swissALTI3D tile ${id} has no ${opts.year} release (the catalogue lists ${years.join(', ')}); pin a year every corridor tile has`);
      writeFileAtomic(marker, `HTTP 404 ${swissTileUrl(id, opts.year)}, no release in ${SWISSALTI3D_STAC}\n`);
      missing.push(id);
      continue;
    }
    if (!res.cached) fetched++;
    const tiff = parseTiff(res.body);
    const raster = openRaster(tiff);
    const geo = geoReference(tiff);
    const [e, n] = id.split('-').map(Number);
    if (geo.scaleX !== 2 || geo.scaleY !== 2 || raster.width !== 500 || raster.height !== 500 || geo.x0 !== e * 1000 + 1 || geo.y0 !== n * 1000 + 999) {
      throw new Error(`swissALTI3D ${id}: unexpected grid (${raster.width}×${raster.height}, ${geo.scaleX} m, first centre ${geo.x0}, ${geo.y0})`);
    }
    tiles.set(id, { raster, e0: e * 1000, n0: n * 1000 + 1000, noData: geo.noData === undefined ? NaN : Number(geo.noData) });
  }
  log(`bareGround: ${sorted.length} swissALTI3D ${opts.year} tiles (${fetched} downloaded, ${missing.length} absent: outside Switzerland), ${k}×${k} px mean per node`);
  return { tiles: sorted.filter((id) => !missing.includes(id)).map((id) => `${id}@${opts.year}`), missing, sample: swissSampler(tiles, k) };
}

// --- shared by the Italian models ----------------------------------------

/** Share of a box's pixels that must have a value for the node to read the DTM. */
export const BOX_MIN_SHARE = 0.5;

/**
 * Mean of the kx × ky pixels centred on pixel (ci, cj) of a pixel reader
 * `px(i, j)` (NaN = no value), over the pixels that have one; NaN when fewer
 * than `minShare` of the box do.
 */
export function boxMean(px, ci, cj, kx, ky, minShare = BOX_MIN_SHARE) {
  const hx = (kx - 1) / 2;
  const hy = (ky - 1) / 2;
  let sum = 0;
  let n = 0;
  for (let b = -hy; b <= hy; b++) {
    for (let a = -hx; a <= hx; a++) {
      const v = px(ci + a, cj + b);
      if (Number.isNaN(v)) continue;
      sum += v;
      n++;
    }
  }
  return n > 0 && n >= minShare * kx * ky ? sum / n : NaN;
}

/** The odd pixel count nearest a cell's width: the box a node averages. */
export const boxPixels = (cellSize, pixelM) => 2 * Math.floor(cellSize / (2 * pixelM)) + 1;

const isTiff = (buf) => buf.length > 8 && ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 42) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[3] === 42));

// --- Regione Lombardia DTM 5×5 -------------------------------------------

/** The ImageServer and its fixed grid (from the service's own metadata, checked by the bake). */
export const LOMBARDIA_DTM5 = {
  service: 'https://www.cartografia.servizirl.it/arcgis2/rest/services/BaseMap/DTM5_RL_img/ImageServer',
  wkid: 32632,
  pixelM: 5,
  /** The service extent's west and north edges: pixel corners. */
  xMin: 460001.8694,
  yMax: 5166901.2481,
  /** The bake's tiles: 2 km × 2 km (400 × 400 pixels) from (xMin, yMax). */
  tileM: 2000,
};

const UTM32N = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 0, lon0: 9, k0: 0.9996 });

/** WGS84 → UTM zone 32N (E, N), the Krüger series of the world projection (sub-millimetre). */
export function wgs84ToUtm32(lat, lon) {
  const [x, y] = UTM32N.forward(lat, lon);
  return [500000 + x, y];
}

/** "<column>-<row>" of the 2 km tile holding (E, N), counted from the service extent's north-west corner. */
export function lombardiaTileId(E, N) {
  const { xMin, yMax, tileM } = LOMBARDIA_DTM5;
  return `${Math.floor((E - xMin) / tileM)}-${Math.floor((yMax - N) / tileM)}`;
}

/** The tile's exportImage request: its 400 × 400 stored pixels, nearest neighbour, LZW float32 GeoTIFF. */
export function lombardiaTileUrl(id) {
  const { service, wkid, xMin, yMax, tileM, pixelM } = LOMBARDIA_DTM5;
  const [c, r] = id.split('-').map(Number);
  const x0 = (xMin + c * tileM).toFixed(4);
  const y1 = (yMax - r * tileM).toFixed(4);
  const x1 = (xMin + (c + 1) * tileM).toFixed(4);
  const y0 = (yMax - (r + 1) * tileM).toFixed(4);
  const px = tileM / pixelM;
  return (
    `${service}/exportImage?bbox=${x0},${y0},${x1},${y1}&bboxSR=${wkid}&imageSR=${wkid}&size=${px},${px}` +
    '&format=tiff&pixelType=F32&noData=-9999&interpolation=RSP_NearestNeighbor&compression=LZW&f=image'
  );
}

/** Check the ImageServer still describes the grid the tiles are cut from. */
export function checkLombardiaService(meta) {
  const { wkid, pixelM, xMin, yMax } = LOMBARDIA_DTM5;
  const sr = meta.spatialReference ?? meta.extent?.spatialReference ?? {};
  const ok =
    meta.pixelSizeX === pixelM &&
    meta.pixelSizeY === pixelM &&
    (sr.wkid === wkid || sr.latestWkid === wkid) &&
    Math.abs(meta.extent?.xmin - xMin) < 1e-3 &&
    Math.abs(meta.extent?.ymax - yMax) < 1e-3;
  if (!ok) {
    throw new Error(`bareGround: the Lombardia DTM5 ImageServer no longer serves a ${pixelM} m EPSG:${wkid} grid from ${xMin}, ${yMax} (pixel ${meta.pixelSizeX}, extent ${JSON.stringify(meta.extent)})`);
  }
}

/** Check a decoded tile is the 400 × 400 stored pixels of tile `id`; returns its georeference. */
export function checkLombardiaTile(id, tiff, raster) {
  const geo = geoReference(tiff);
  const { xMin, yMax, tileM, pixelM, wkid } = LOMBARDIA_DTM5;
  const [c, r] = id.split('-').map(Number);
  const px = tileM / pixelM;
  const cs = geoKey(tiff, 0, 3072);
  const x0 = xMin + c * tileM + pixelM / 2;
  const y0 = yMax - r * tileM - pixelM / 2;
  if (cs !== wkid || geo.scaleX !== pixelM || geo.scaleY !== pixelM || raster.width !== px || raster.height !== px || Math.abs(geo.x0 - x0) > 1e-3 || Math.abs(geo.y0 - y0) > 1e-3) {
    throw new Error(`Lombardia DTM5 tile ${id}: unexpected grid (EPSG ${cs}, ${raster.width}×${raster.height}, ${geo.scaleX} m, first centre ${geo.x0}, ${geo.y0}; expected ${x0}, ${y0})`);
  }
  return geo;
}

/** Box mean of k × k pixels round a point over the decoded tiles; NaN under half covered. */
export function lombardiaSampler(tiles, k) {
  const { xMin, yMax, pixelM, tileM } = LOMBARDIA_DTM5;
  const per = tileM / pixelM;
  const px = (I, J) => {
    const t = tiles.get(`${Math.floor(I / per)}-${Math.floor(J / per)}`);
    if (!t) return NaN;
    const v = t.raster.value(I - Math.floor(I / per) * per, J - Math.floor(J / per) * per);
    return v === t.noData || !(v > -1000) ? NaN : v;
  };
  return (lat, lon) => {
    const [E, N] = wgs84ToUtm32(lat, lon);
    return boxMean(px, Math.floor((E - xMin) / pixelM), Math.floor((yMax - N) / pixelM), k, k);
  };
}

async function fetchLombardia({ points, cellSize, cacheDir, log }) {
  const dir = join(cacheDir, 'lombardia-dtm5');
  ensureDir(dir);
  const meta = await cachedFetch(dir, 'service.json', `${LOMBARDIA_DTM5.service}?f=json`, {}, { label: 'Lombardia DTM5 service' });
  checkLombardiaService(JSON.parse(meta.body.toString('utf8')));
  const k = boxPixels(cellSize, LOMBARDIA_DTM5.pixelM);
  const reach = (k + 1) * LOMBARDIA_DTM5.pixelM;
  const ids = new Set();
  for (const [lat, lon] of points) {
    const [E, N] = wgs84ToUtm32(lat, lon);
    for (const dE of [-reach, 0, reach]) for (const dN of [-reach, 0, reach]) ids.add(lombardiaTileId(E + dE, N + dN));
  }
  const sorted = [...ids].sort();
  const tiles = new Map();
  let fetched = 0;
  for (const id of sorted) {
    const file = `${id}.tif`;
    const res = await cachedFetch(dir, file, lombardiaTileUrl(id), {}, { label: `Lombardia DTM5 ${id}` });
    if (!isTiff(res.body)) {
      // The ImageServer answers errors with HTTP 200 and a JSON body.
      unlinkSync(join(dir, file));
      throw new Error(`Lombardia DTM5 tile ${id}: not a GeoTIFF (${res.body.subarray(0, 200).toString('utf8')})`);
    }
    if (!res.cached) fetched++;
    const tiff = parseTiff(res.body);
    const raster = openRaster(tiff);
    const geo = checkLombardiaTile(id, tiff, raster);
    tiles.set(id, { raster, noData: geo.noData === undefined ? NaN : Number(geo.noData) });
  }
  log(`bareGround: ${sorted.length} Lombardia DTM5 2 km tiles (${fetched} downloaded), ${k}×${k} px mean per node`);
  return { tiles: sorted, sample: lombardiaSampler(tiles, k) };
}

// --- MASE PST LiDAR DTM 1 m ----------------------------------------------

export const MASE_PST = {
  /** The tile index (0.01° cells; a blank `contratto` = no data there). */
  index: 'https://gis.platform.sim.mase.gov.it/portalgis/rest/services/Hosted/Grigliato_lidar/FeatureServer/2/query',
  /** The download service: POST an order, poll it, fetch the zip. */
  api: 'https://sim.mase.gov.it/core/api/esri/api/v1/downloads',
  /** The service hands back zip URLs on its internal gateway; they are served under `external`. */
  internal: 'http://mase-api-gateway.apps.dxap-prod.ocp.mase.priv',
  external: 'https://sim.mase.gov.it/core/api/esri',
  order: { canale: 'PST2', prodotto: 'LIDAR_2014', layer: 'dtm_1x1' },
  /** Pixels per tile side; a pixel is 1e-5°. */
  per: 1000,
  /** Tiles per order (the web app's cart holds 20). */
  batch: 20,
};

/** "<lat cell>-<lon cell>" of the 0.01° cell holding (lat, lon): 4313-1205 = 43.13–43.14° N, 12.05–12.06° E. */
export function maseCellId(lat, lon) {
  return `${Math.floor(lat * 100 + 1e-9)}-${Math.floor(lon * 100 + 1e-9)}`;
}

/** The cell of a tile-index feature, from its polygon's south-west corner. */
export function maseFeatureCell(feature) {
  const ring = feature.geometry?.rings?.[0];
  if (!ring?.length) throw new Error(`MASE PST tile index: feature ${feature.attributes?.tavola} has no polygon`);
  const lat = Math.min(...ring.map((p) => p[1]));
  const lon = Math.min(...ring.map((p) => p[0]));
  return `${Math.round(lat * 100)}-${Math.round(lon * 100)}`;
}

/** Check a decoded tile is cell `cell`'s 1000 × 1000 pixel centres (PixelIsPoint, 1e-5°). */
export function checkMaseTile(cell, tiff, raster) {
  const geo = geoReference(tiff);
  const [la, lo] = cell.split('-').map(Number);
  const x0 = lo / 100 + 5e-6;
  const y0 = (la + 1) / 100 - 5e-6;
  const ok =
    geo.modelType === 2 && geo.geographicType === 4326 && geo.rasterType === 'point' &&
    Math.abs(geo.scaleX - 1e-5) < 1e-12 && Math.abs(geo.scaleY - 1e-5) < 1e-12 &&
    raster.width === MASE_PST.per && raster.height === MASE_PST.per &&
    Math.abs(geo.x0 - x0) < 1e-9 && Math.abs(geo.y0 - y0) < 1e-9;
  if (!ok) {
    throw new Error(`MASE PST tile ${cell}: unexpected grid (type ${geo.modelType}/${geo.geographicType}/${geo.rasterType}, ${raster.width}×${raster.height}, ${geo.scaleX}°, first centre ${geo.x0}, ${geo.y0}; expected ${x0}, ${y0})`);
  }
  return geo;
}

/**
 * Mean of the pixels within half a cell round a point over the decoded
 * tiles (a box of the odd pixel counts nearest the cell east–west and
 * north–south); NaN under half covered (the lake, a gap).
 */
export function maseSampler(tiles, cellSize) {
  const per = MASE_PST.per;
  // Global pixel indices: column I has its centre at (I + 0.5)·1e-5° E, row J at (J + 0.5)·1e-5° N.
  const px = (I, J) => {
    const cLat = Math.floor(J / per);
    const cLon = Math.floor(I / per);
    const t = tiles.get(`${cLat}-${cLon}`);
    if (!t) return NaN;
    const v = t.raster.value(I - cLon * per, cLat * per + per - 1 - J);
    return v === t.noData || !(v > -1000) ? NaN : v;
  };
  return (lat, lon) => {
    const kx = boxPixels(cellSize, 1e-5 * 111320 * Math.cos((lat * Math.PI) / 180));
    const ky = boxPixels(cellSize, 1e-5 * 110574);
    return boxMean(px, Math.floor(lon * 1e5), Math.floor(lat * 1e5), kx, ky);
  };
}

async function fetchJsonRetry(url, init = {}, label = url, retries = 5) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(init.headers ?? {}) } });
      if (res.ok) return await res.json();
      last = new Error(`${label}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      if (res.status < 500 && res.status !== 429) throw Object.assign(last, { fatal: true });
    } catch (err) {
      if (err.fatal) throw err;
      last = err;
    }
    await sleep(Math.min(30_000, 2000 * 2 ** attempt));
  }
  throw last;
}

/** Order `tiles` (index attributes) from the PST download service; returns the zip archives' bytes. */
async function orderMaseTiles(tiles, log) {
  const body = JSON.stringify({
    ...MASE_PST.order,
    tileList: tiles.map((t) => ({ fid: String(t.fid), tavola: t.tavola, regione: t.regione, contratto: t.contratto })),
    metadataList: [],
  });
  const order = await fetchJsonRetry(MASE_PST.api, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }, 'MASE PST order');
  if (!order.idSessione) throw new Error(`MASE PST order: no session (${JSON.stringify(order).slice(0, 200)})`);
  const t0 = Date.now();
  let st;
  for (;;) {
    st = await fetchJsonRetry(`${MASE_PST.api}/${order.idSessione}`, {}, 'MASE PST order status');
    if (st.status === 'ready' && (st.urls?.length ?? 0) >= (st.expected ?? 1)) break;
    if (st.status === 'error' || st.status === 'failed') throw new Error(`MASE PST order ${order.idSessione}: ${JSON.stringify(st).slice(0, 300)}`);
    if (Date.now() - t0 > 15 * 60_000) throw new Error(`MASE PST order ${order.idSessione}: not ready after 15 min (${JSON.stringify(st).slice(0, 300)})`);
    await sleep(3000);
  }
  log(`bareGround: MASE PST order of ${tiles.length} tiles ready after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const zips = [];
  for (const u of st.urls) {
    const url = u.replace(MASE_PST.internal, MASE_PST.external);
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`MASE PST download ${url}: HTTP ${res.status}`);
    zips.push(Buffer.from(await res.arrayBuffer()));
  }
  return zips;
}

async function fetchMase({ points, cellSize, cacheDir, log }) {
  const dir = join(cacheDir, 'mase-pst-lidar');
  ensureDir(dir);
  // Every 0.01° cell a node's box can reach (the box is under a cell wide).
  const reachDeg = cellSize / 110000;
  const cells = new Set();
  let s = 90, n = -90, w = 180, e = -180;
  for (const [lat, lon] of points) {
    for (const dLat of [-reachDeg, 0, reachDeg]) for (const dLon of [-reachDeg, 0, reachDeg]) cells.add(maseCellId(lat + dLat, lon + dLon));
    s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon);
  }
  const q = new URLSearchParams({
    geometry: `${(w - 0.01).toFixed(2)},${(s - 0.01).toFixed(2)},${(e + 0.01).toFixed(2)},${(n + 0.01).toFixed(2)}`,
    geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    outFields: 'fid,tavola,regione,contratto,data', returnGeometry: 'true', f: 'json',
  });
  const indexUrl = `${MASE_PST.index}?${q}`;
  const idx = await cachedFetch(dir, `index-${sha256(Buffer.from(indexUrl)).slice(0, 12)}.json`, indexUrl, {}, { label: 'MASE PST tile index' });
  const index = JSON.parse(idx.body.toString('utf8'));
  if (!Array.isArray(index.features)) throw new Error(`MASE PST tile index: ${idx.body.subarray(0, 200).toString('utf8')}`);
  const byCell = new Map();
  for (const f of index.features) {
    if (!String(f.attributes?.contratto ?? '').trim()) continue;
    byCell.set(maseFeatureCell(f), f.attributes);
  }
  const wanted = [...cells].filter((c) => byCell.has(c)).sort();
  const missing = wanted.filter((c) => !existsSync(join(dir, `${byCell.get(c).tavola}.tif`)));
  for (let i = 0; i < missing.length; i += MASE_PST.batch) {
    const batch = missing.slice(i, i + MASE_PST.batch).map((c) => byCell.get(c));
    const files = new Map();
    for (const zip of await orderMaseTiles(batch, log)) for (const [name, data] of readZip(zip)) files.set(name, data);
    for (const t of batch) {
      const name = [...files.keys()].find((f) => f.includes(t.tavola) && /_DTM\.tiff?$/i.test(f));
      if (!name) throw new Error(`MASE PST order: tile ${t.tavola} is missing from the zip (${[...files.keys()].join(', ')})`);
      writeFileAtomic(join(dir, `${t.tavola}.tif`), files.get(name));
    }
  }
  const tiles = new Map();
  for (const c of wanted) {
    const t = byCell.get(c);
    const tiff = parseTiff(readFileSync(join(dir, `${t.tavola}.tif`)));
    const raster = openRaster(tiff);
    const geo = checkMaseTile(c, tiff, raster);
    tiles.set(c, { raster, noData: geo.noData === undefined ? NaN : Number(geo.noData) });
  }
  const without = [...cells].filter((c) => !byCell.has(c)).length;
  log(`bareGround: ${wanted.length} MASE PST LiDAR 1 m tiles (${missing.length} downloaded, ${without} cells the survey left out)`);
  return { tiles: wanted.map((c) => byCell.get(c).tavola), sample: maseSampler(tiles, cellSize) };
}

// --- INEGI MDT 1:10 000 (Mexico) -----------------------------------------

async function fetchInegi({ opts, points, cellSize, cacheDir, log }) {
  const dir = join(cacheDir, 'inegi-mdt-10k');
  ensureDir(dir);
  const names = [...new Set(points.map(([lat, lon]) => inegiSheetName(lat, lon)))].sort();
  const sheets = new Map();
  const missing = [];
  const ks = new Set();
  let fetched = 0;
  for (const name of names) {
    if (!(name in opts.sheets)) {
      throw new Error(
        `bareGround: the corridor needs INEGI MDT sheet ${name}; pin its product in the recipe (bareGround.sheets.${name} = the "upc" of the _b.zip entry ${INEGI_MDT_CATALOGUE} returns for res=5&mod=T&cve=${name}, or null when it returns none: no product there)`,
      );
    }
    const upc = opts.sheets[name];
    if (upc === null) {
      missing.push(name);
      continue;
    }
    const res = await cachedFetch(dir, `${upc}_b.zip`, inegiSheetUrl(upc), {}, { label: `INEGI MDT ${name} (${upc})` });
    if (!res.cached) fetched++;
    const raster = openInegiSheet(res.body, name);
    checkInegiCoverage(name, raster);
    const k = inegiBoxSize(cellSize, raster.dx);
    ks.add(`${k}×${k} px of ${raster.dx} m`);
    sheets.set(name, { ...raster, k });
  }
  log(`bareGround: ${names.length} INEGI MDT 1:10 000 sheets (${fetched} downloaded${missing.length ? `, ${missing.length} without a product: ${missing.join(', ')}` : ''}): ${names.filter((n) => !missing.includes(n)).map((n) => `${n}@${opts.sheets[n]}`).join(', ')}; ${[...ks].join(', ')} mean per node`);
  return { tiles: names.filter((n) => !missing.includes(n)).map((n) => `${n}@${opts.sheets[n]}`), missing, sample: inegiSampler(sheets) };
}

// --- IGN RGE ALTI (France) ------------------------------------------------

/** The Géoplateforme raster WMS and the bake's tile grid on it. */
export const IGN_RGE_ALTI = {
  service: 'https://data.geopf.fr/wms-r/wms',
  /** "Modèle Numérique de Terrain issu du RGEALTI": IGN's RGE ALTI DTM as the WMS serves it. */
  layer: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES',
  epsg: 2154,
  /** 1 km × 1 km tiles of Lambert-93 at 2 m (500 × 500 pixels, pixel centres on odd metres). */
  tileM: 1000,
  pixelM: 2,
};

/**
 * WGS84 → Lambert-93 (EPSG:2154, RGF93 on GRS80; RGF93 and WGS84 agree to
 * about a metre): IGN's secant Lambert conformal conic with its published
 * constants (n, C, Xs, Ys for parallels 44° and 49°, origin 46.5° N 3° E).
 */
export function wgs84ToLambert93(lat, lon) {
  const e = 0.0818191910428158;
  const n = 0.725607765053267;
  const C = 11754255.426096;
  const phi = (lat * Math.PI) / 180;
  const s = e * Math.sin(phi);
  const L = Math.log(Math.tan(Math.PI / 4 + phi / 2) * ((1 - s) / (1 + s)) ** (e / 2));
  const R = C * Math.exp(-n * L);
  const g = n * (((lon - 3) * Math.PI) / 180);
  return [700000 + R * Math.sin(g), 12655612.049876 - R * Math.cos(g)];
}

/** "<E km>-<N km>" of the 1 km Lambert-93 tile holding (E, N). */
export const rgeAltiTileId = (E, N) => `${Math.floor(E / 1000)}-${Math.floor(N / 1000)}`;

/** The tile's GetMap: its 1 km at 2 m pixels, float32 GeoTIFF of the heights. */
export function rgeAltiTileUrl(id) {
  const { service, layer, epsg, tileM, pixelM } = IGN_RGE_ALTI;
  const [e, n] = id.split('-').map(Number);
  const px = tileM / pixelM;
  return (
    `${service}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${layer}&STYLES=&CRS=EPSG:${epsg}` +
    `&BBOX=${e * tileM},${n * tileM},${(e + 1) * tileM},${(n + 1) * tileM}&WIDTH=${px}&HEIGHT=${px}&FORMAT=image/geotiff`
  );
}

/** Lambert-93's defining parameters as GeoTIFF keys: standard parallels, false origin (long, lat), false easting, northing. */
const LAMBERT93_KEYS = { 3078: 49, 3079: 44, 3084: 3, 3085: 46.5, 3086: 700000, 3087: 6600000 };

/**
 * Whether a GeoTIFF is in Lambert-93: ProjectedCSType 2154, or (as the
 * Géoplateforme WMS writes it) a user-defined Lambert conic 2SP (CT 8) with
 * Lambert-93's parameters and the citation "EPSG:2154". Returns the EPSG code
 * it reads as, 0 otherwise.
 */
export function lambert93Code(tiff) {
  const cs = geoKey(tiff, 0, 3072);
  if (cs === 2154) return 2154;
  if (cs !== 32767 || geoKey(tiff, 0, 3075) !== 8) return 0;
  const citation = String(geoKeyAny(tiff, 0, 1026) ?? geoKeyAny(tiff, 0, 3073) ?? '');
  if (!/^EPSG:2154\b/.test(citation)) return 0;
  for (const [k, v] of Object.entries(LAMBERT93_KEYS)) if (geoKeyAny(tiff, 0, Number(k)) !== v) return 0;
  return 2154;
}

/** Check a decoded tile is tile `id`'s 500 × 500 pixels of 2 m in Lambert-93; returns its georeference. */
export function checkRgeAltiTile(id, tiff, raster) {
  const geo = geoReference(tiff);
  const { epsg, tileM, pixelM } = IGN_RGE_ALTI;
  const [e, n] = id.split('-').map(Number);
  const px = tileM / pixelM;
  const cs = lambert93Code(tiff) || geoKey(tiff, 0, 3072);
  const x0 = e * tileM + pixelM / 2;
  const y0 = (n + 1) * tileM - pixelM / 2;
  if (geo.modelType !== 1 || cs !== epsg || geo.scaleX !== pixelM || geo.scaleY !== pixelM || raster.width !== px || raster.height !== px || Math.abs(geo.x0 - x0) > 1e-6 || Math.abs(geo.y0 - y0) > 1e-6) {
    throw new Error(`IGN RGE ALTI tile ${id}: unexpected grid (model ${geo.modelType}, EPSG ${cs}, ${raster.width}×${raster.height}, ${geo.scaleX} m, first centre ${geo.x0}, ${geo.y0}; expected ${x0}, ${y0})`);
  }
  return geo;
}

/** Box mean of k × k pixels round a point over the decoded 1 km tiles; NaN under half covered. */
export function rgeAltiSampler(tiles, k) {
  const { tileM, pixelM } = IGN_RGE_ALTI;
  const per = tileM / pixelM;
  // Global pixel (I, J): east from E = 0, north from N = 0; centre at (pixelM·I + 1, pixelM·J + 1).
  const px = (I, J) => {
    const tE = Math.floor(I / per);
    const tN = Math.floor(J / per);
    const t = tiles.get(`${tE}-${tN}`);
    if (!t) return NaN;
    const v = t.raster.value(I - tE * per, tN * per + per - 1 - J);
    return v === t.noData || !(v > -1000) ? NaN : v;
  };
  return (lat, lon) => {
    const [E, N] = wgs84ToLambert93(lat, lon);
    return boxMean(px, Math.floor(E / pixelM), Math.floor(N / pixelM), k, k);
  };
}

async function fetchRgeAlti({ points, cellSize, cacheDir, log }) {
  const dir = join(cacheDir, 'ign-rge-alti');
  ensureDir(dir);
  const k = boxPixels(cellSize, IGN_RGE_ALTI.pixelM);
  const reach = (k + 1) * IGN_RGE_ALTI.pixelM;
  const ids = new Set();
  for (const [lat, lon] of points) {
    const [E, N] = wgs84ToLambert93(lat, lon);
    for (const dE of [-reach, 0, reach]) for (const dN of [-reach, 0, reach]) ids.add(rgeAltiTileId(E + dE, N + dN));
  }
  const sorted = [...ids].sort();
  const tiles = new Map();
  let fetched = 0;
  for (const id of sorted) {
    const file = `${id}.tif`;
    const res = await cachedFetch(dir, file, rgeAltiTileUrl(id), {}, { label: `IGN RGE ALTI ${id}` });
    if (!isTiff(res.body)) {
      // A WMS answers errors (an exception report) with HTTP 200.
      unlinkSync(join(dir, file));
      throw new Error(`IGN RGE ALTI tile ${id}: not a GeoTIFF (${res.body.subarray(0, 200).toString('utf8')})`);
    }
    if (!res.cached) fetched++;
    const tiff = parseTiff(res.body);
    const raster = openRaster(tiff);
    const geo = checkRgeAltiTile(id, tiff, raster);
    tiles.set(id, { raster, noData: geo.noData === undefined ? NaN : Number(geo.noData) });
  }
  log(`bareGround: ${sorted.length} IGN RGE ALTI 1 km tiles (${fetched} downloaded), ${k}×${k} px mean per node`);
  return { tiles: sorted, sample: rgeAltiSampler(tiles, k) };
}

// --- Regione del Veneto DTM LiDAR 5 m ----------------------------------

/** The geoportal's tile index (WFS), the download service, and the tiles' grid. */
export const VENETO_LIDAR5 = {
  index: 'https://idt2-geoserver.regione.veneto.it/geoserver/ows',
  layer: 'rv:c0101071_lidar5m',
  download: 'https://idt2.regione.veneto.it/idt/download/layerDownload/downloadDtmLidar5',
  /** 2 km × 2 km tiles of 400 × 400 pixels of 5 m, on the 2 km grid of "Fuso 12" (EPSG:6876 / 7795). */
  tileM: 2000,
  pixelM: 5,
  /** How far an index polygon may sit from its tile: the index is drawn on Monte Mario (EPSG:3003) and lands about 80 m off. */
  indexSlackM: 150,
};

const ZONE12 = createProjection({ type: 'tmerc', ellipsoid: 'WGS84', lat0: 0, lon0: 12, k0: 1 });

/**
 * WGS84 → "Fuso 12" (E, N): RDN2008 / Zone 12, the region's grid (EPSG:7795,
 * transverse Mercator on 12° E, scale 1, false easting 3,000,000 m). GRS80 and
 * the WGS84 ellipsoid differ by under a millimetre here; RDN2008 and WGS84 by
 * about a metre.
 */
export function wgs84ToVenetoZone12(lat, lon) {
  const [x, y] = ZONE12.forward(lat, lon);
  return [3000000 + x, y];
}

/** "<E / 2 km>-<N / 2 km>" of the 2 km tile holding (E, N) in Fuso 12. */
export const venetoTileCell = (E, N) => `${Math.floor(E / 2000)}-${Math.floor(N / 2000)}`;

/** The index query: the tiles whose polygons meet the WGS84 box (s, w, n, e). */
export function venetoIndexUrl(s, w, n, e) {
  const q = new URLSearchParams({
    service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: VENETO_LIDAR5.layer,
    outputFormat: 'application/json', srsName: 'EPSG:4326',
    bbox: `${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)},urn:ogc:def:crs:EPSG::4326`,
  });
  return `${VENETO_LIDAR5.index}?${q}`;
}

/**
 * An ESRI ASCII grid as the region ships it: header (ncols, nrows,
 * xllcenter, yllcenter, cellsize, nodata_value), then rows north to south.
 * Returns `{ width, height, x0, y0, dx, noData, value(i, j) }`, (x0, y0) =
 * the centre of the north-west pixel.
 */
export function parseAsciiGrid(text) {
  const lines = text.split(/\r?\n/);
  const head = {};
  let at = 0;
  while (at < lines.length && /^[a-z_]+\s/i.test(lines[at].trim())) {
    const [k, v] = lines[at].trim().split(/\s+/);
    head[k.toLowerCase()] = Number(v);
    at++;
  }
  const width = head.ncols, height = head.nrows, dx = head.cellsize;
  if (!(width > 0 && height > 0 && dx > 0)) throw new Error(`ASCII grid: bad header ${JSON.stringify(head)}`);
  const x0 = 'xllcenter' in head ? head.xllcenter : head.xllcorner + dx / 2;
  const yll = 'yllcenter' in head ? head.yllcenter : head.yllcorner + dx / 2;
  const values = new Float32Array(width * height);
  let n = 0;
  for (; at < lines.length && n < values.length; at++) {
    for (const t of lines[at].trim().split(/\s+/)) {
      if (t === '') continue;
      values[n++] = Number(t);
    }
  }
  if (n !== values.length) throw new Error(`ASCII grid: ${n} values for ${width}×${height}`);
  return { width, height, x0, y0: yll + (height - 1) * dx, dx, noData: head.nodata_value, value: (i, j) => values[j * width + i] };
}

/** Check a parsed tile is the 400 × 400 pixels of 5 m of 2 km cell `cell`. */
export function checkVenetoTile(name, cell, grid) {
  const { tileM, pixelM } = VENETO_LIDAR5;
  const [cE, cN] = cell.split('-').map(Number);
  const x0 = cE * tileM + pixelM / 2;
  const y0 = (cN + 1) * tileM - pixelM / 2;
  if (grid.width !== tileM / pixelM || grid.height !== tileM / pixelM || grid.dx !== pixelM || Math.abs(grid.x0 - x0) > 1e-6 || Math.abs(grid.y0 - y0) > 1e-6) {
    throw new Error(`Veneto DTM LiDAR 5 m tile ${name}: unexpected grid (${grid.width}×${grid.height}, ${grid.dx} m, first centre ${grid.x0}, ${grid.y0}; expected ${x0}, ${y0} for cell ${cell})`);
  }
}

/** The 2 km cell a tile's own ASCII grid covers (from its south-west pixel centre). */
export function venetoGridCell(grid) {
  const { tileM, pixelM } = VENETO_LIDAR5;
  return venetoTileCell(grid.x0 - pixelM / 2 + 1, grid.y0 + pixelM / 2 - tileM + 1);
}

/** Box mean of k × k pixels round a point over the parsed tiles (keyed by cell); NaN under half covered. */
export function venetoSampler(tiles, k) {
  const { tileM, pixelM } = VENETO_LIDAR5;
  const per = tileM / pixelM;
  const px = (I, J) => {
    const tE = Math.floor(I / per);
    const tN = Math.floor(J / per);
    const t = tiles.get(`${tE}-${tN}`);
    if (!t) return NaN;
    const v = t.value(I - tE * per, tN * per + per - 1 - J);
    return v === t.noData || !(v > -1000) ? NaN : v;
  };
  return (lat, lon) => {
    const [E, N] = wgs84ToVenetoZone12(lat, lon);
    return boxMean(px, Math.floor(E / pixelM), Math.floor(N / pixelM), k, k);
  };
}

async function fetchVeneto({ points, cellSize, cacheDir, log }) {
  const dir = join(cacheDir, 'veneto-lidar5');
  ensureDir(dir);
  const { tileM, pixelM, indexSlackM } = VENETO_LIDAR5;
  const k = boxPixels(cellSize, pixelM);
  const reach = (k + 1) * pixelM;
  const cells = new Set();
  let s = 90, n = -90, w = 180, e = -180;
  for (const [lat, lon] of points) {
    const [E, N] = wgs84ToVenetoZone12(lat, lon);
    for (const dE of [-reach, 0, reach]) for (const dN of [-reach, 0, reach]) cells.add(venetoTileCell(E + dE, N + dN));
    s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon);
  }
  const indexUrl = venetoIndexUrl(s - 0.03, w - 0.03, n + 0.03, e + 0.03);
  const idx = await cachedFetch(dir, `index-${sha256(Buffer.from(indexUrl)).slice(0, 12)}.json`, indexUrl, {}, { label: 'Veneto DTM LiDAR 5 m tile index' });
  let index;
  try {
    index = JSON.parse(idx.body.toString('utf8'));
  } catch {
    index = null;
  }
  if (!Array.isArray(index?.features)) {
    unlinkSync(join(dir, `index-${sha256(Buffer.from(indexUrl)).slice(0, 12)}.json`));
    throw new Error(`Veneto DTM LiDAR 5 m tile index: ${idx.body.subarray(0, 200).toString('utf8')}`);
  }
  // Candidates: every tile whose index polygon, give or take its slack, meets a wanted cell.
  const candidates = new Map();
  for (const f of index.features) {
    const { id_pol: id, nome: name } = f.properties ?? {};
    if (!id || !/^12_2K_\d+$/.test(name ?? '')) throw new Error(`Veneto DTM LiDAR 5 m tile index: bad feature ${JSON.stringify(f.properties)}`);
    const rings = f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates.flat() : (f.geometry?.coordinates ?? []);
    let E0 = Infinity, E1 = -Infinity, N0 = Infinity, N1 = -Infinity;
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        const [E, N] = wgs84ToVenetoZone12(lat, lon);
        E0 = Math.min(E0, E); E1 = Math.max(E1, E); N0 = Math.min(N0, N); N1 = Math.max(N1, N);
      }
    }
    for (let cE = Math.floor((E0 - indexSlackM) / tileM); cE <= Math.floor((E1 + indexSlackM) / tileM); cE++) {
      for (let cN = Math.floor((N0 - indexSlackM) / tileM); cN <= Math.floor((N1 + indexSlackM) / tileM); cN++) {
        if (cells.has(`${cE}-${cN}`)) candidates.set(name, String(id));
      }
    }
  }
  const tiles = new Map();
  let fetched = 0;
  for (const [name, id] of [...candidates].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const file = `${name}.asc.zip`;
    const res = await cachedFetch(dir, file, `${VENETO_LIDAR5.download}?dataDtmLidarId=${id}`, {}, { label: `Veneto DTM LiDAR 5 m ${name}` });
    if (res.body.readUInt32LE(0) !== 0x04034b50) {
      unlinkSync(join(dir, file));
      throw new Error(`Veneto DTM LiDAR 5 m ${name}: not a zip (${res.body.subarray(0, 200).toString('utf8')})`);
    }
    if (!res.cached) fetched++;
    const files = readZip(res.body);
    const asc = files.get(`${name}.asc`);
    if (!asc) throw new Error(`Veneto DTM LiDAR 5 m ${name}: the zip holds ${[...files.keys()].join(', ')}, not ${name}.asc`);
    const grid = parseAsciiGrid(asc.toString('latin1'));
    const cell = venetoGridCell(grid);
    checkVenetoTile(name, cell, grid);
    if (tiles.has(cell)) throw new Error(`Veneto DTM LiDAR 5 m: ${name} and ${tiles.get(cell).name} both cover cell ${cell}`);
    tiles.set(cell, { ...grid, name });
  }
  const used = [...cells].filter((c) => tiles.has(c)).sort();
  log(`bareGround: ${used.length} Veneto DTM LiDAR 5 m tiles of ${cells.size} cells (${tiles.size} read, ${fetched} downloaded), ${k}×${k} px mean per node`);
  return { tiles: used.map((c) => tiles.get(c).name), sample: venetoSampler(tiles, k) };
}

// --- corridor -----------------------------------------------------------

/**
 * Distance from every grid node to the nearest route line, for nodes within
 * `reach` (Infinity beyond). `lines` = flat [x0, y0, x1, y1, …] polylines in
 * world metres.
 */
export function routeDistances(grid, lines, reach) {
  const { cols, rows, cellSize, xMin, yMax } = grid;
  const dist = new Float64Array(cols * rows).fill(Infinity);
  for (const p of lines) {
    for (let k = 0; k + 3 < p.length; k += 2) {
      const ax = p[k], ay = p[k + 1], bx = p[k + 2], by = p[k + 3];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - xMin) / cellSize));
      const c1 = Math.min(cols - 1, Math.ceil((Math.max(ax, bx) + reach - xMin) / cellSize));
      const r0 = Math.max(0, Math.floor((yMax - Math.max(ay, by) - reach) / cellSize));
      const r1 = Math.min(rows - 1, Math.ceil((yMax - Math.min(ay, by) + reach) / cellSize));
      for (let r = r0; r <= r1; r++) {
        const ny = yMax - r * cellSize;
        for (let c = c0; c <= c1; c++) {
          const nx = xMin + c * cellSize;
          let t = len2 > 0 ? ((nx - ax) * dx + (ny - ay) * dy) / len2 : 0;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          const d = Math.hypot(ax + dx * t - nx, ay + dy * t - ny);
          const i = r * cols + c;
          if (d < dist[i] && d < reach) dist[i] = d;
        }
      }
    }
  }
  return dist;
}

/** Corridor weight: 1 within `corridorM`, smoothstep down to 0 at corridorM + blendM. */
export function corridorWeight(d, corridorM, blendM) {
  if (d <= corridorM) return 1;
  if (d >= corridorM + blendM) return 0;
  const u = 1 - (d - corridorM) / blendM;
  return u * u * (3 - 2 * u);
}

/** Rasterise polygons (rings in metres, even-odd) onto the grid as a 0/1 mask. */
export function polygonMask(grid, polys) {
  const { cols, rows, cellSize, xMin, yMax } = grid;
  const mask = new Uint8Array(cols * rows);
  for (const rings of polys) {
    const edges = [];
    let yLo = Infinity, yHi = -Infinity;
    for (const ring of rings) {
      const n = ring.length / 2;
      for (let k = 0; k < n; k++) {
        const x1 = ring[2 * k], y1 = ring[2 * k + 1];
        const x2 = ring[2 * ((k + 1) % n)], y2 = ring[2 * ((k + 1) % n) + 1];
        edges.push(x1, y1, x2, y2);
        if (y1 < yLo) yLo = y1;
        if (y1 > yHi) yHi = y1;
      }
    }
    const r0 = Math.max(0, Math.ceil((yMax - yHi) / cellSize));
    const r1 = Math.min(rows - 1, Math.floor((yMax - yLo) / cellSize));
    const xs = [];
    for (let r = r0; r <= r1; r++) {
      const y = yMax - r * cellSize;
      xs.length = 0;
      for (let e = 0; e < edges.length; e += 4) {
        const y1 = edges[e + 1], y2 = edges[e + 3];
        if (y1 <= y !== y2 <= y) xs.push(edges[e] + ((y - y1) / (y2 - y1)) * (edges[e + 2] - edges[e]));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - xMin) / cellSize));
        const c1 = Math.min(cols - 1, Math.floor((xs[k + 1] - xMin) / cellSize));
        for (let c = c0; c <= c1; c++) mask[r * cols + c] = 1;
      }
    }
  }
  return mask;
}

/** Grow a 0/1 mask by `radiusM` (disc). */
export function dilateMask(grid, mask, radiusM) {
  const { cols, rows, cellSize } = grid;
  const k = Math.floor(radiusM / cellSize);
  if (k <= 0) return mask;
  const out = new Uint8Array(mask.length);
  const offs = [];
  for (let dr = -k; dr <= k; dr++) for (let dc = -k; dc <= k; dc++) if (Math.hypot(dr, dc) * cellSize <= radiusM + 1e-9) offs.push([dr, dc]);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!mask[r * cols + c]) continue;
      for (const [dr, dc] of offs) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && cc >= 0 && rr < rows && cc < cols) out[rr * cols + cc] = 1;
      }
    }
  }
  return out;
}

const median = (values) => {
  const s = Float64Array.from(values).sort();
  if (s.length === 0) return NaN;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Swap the DTM in along the routes, in place. `dtm[i]` = the DTM at node i
 * (NaN = none), `dist` from routeDistances, `woodland` a 0/1 node mask of
 * canopy landcover. The datum bias is measured over flat corridor nodes clear
 * of woodland, or, with `biasMask` (a 0/1 node mask: a coast world's
 * beaches), over the flat corridor nodes it marks. Returns the step's figures.
 */
export function applyBareGround({ grid, heights, dtm, dist, woodland, corridorM, blendM, biasMask = null }) {
  const { cols, rows, cellSize } = grid;
  const n = cols * rows;
  const reach = corridorM + blendM;
  const clear = dilateMask(grid, woodland, BIAS_WOODLAND_CLEAR_M);
  // Datum bias over flat, open (or beach) corridor nodes.
  const open = [];
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const i = r * cols + c;
      if (!(dist[i] < reach) || (biasMask ? !biasMask[i] : clear[i]) || Number.isNaN(dtm[i])) continue;
      const gx = (dtm[i + 1] - dtm[i - 1]) / (2 * cellSize);
      const gy = (dtm[i + cols] - dtm[i - cols]) / (2 * cellSize);
      if (!(Math.hypot(gx, gy) < BIAS_MAX_SLOPE)) continue; // NaN neighbours fail too
      open.push(heights[i] - dtm[i]);
    }
  }
  if (open.length < 100) throw new Error(`bareGround: only ${open.length} flat ${biasMask ? 'beach' : 'open'} corridor nodes to tie the DTM's datum to GLO-30`);
  const biasM = median(open);
  let nodes = 0, nodata = 0, maxLower = 0, maxRaise = 0, sumLower = 0, lowered = 0, maxLowerAt = null, maxRaiseAt = null;
  const at = (i) => [grid.xMin + (i % cols) * cellSize, grid.yMax - Math.floor(i / cols) * cellSize];
  for (let i = 0; i < n; i++) {
    if (!(dist[i] < reach)) continue;
    if (Number.isNaN(dtm[i])) {
      nodata++;
      continue;
    }
    const w = corridorWeight(dist[i], corridorM, blendM);
    if (w <= 0) continue;
    const delta = (dtm[i] + biasM - heights[i]) * w;
    heights[i] += delta;
    nodes++;
    if (delta < 0) {
      lowered++;
      sumLower -= delta;
      if (-delta > maxLower) {
        maxLower = -delta;
        maxLowerAt = at(i);
      }
    } else if (delta > maxRaise) {
      maxRaise = delta;
      maxRaiseAt = at(i);
    }
  }
  return { biasM, openNodes: open.length, nodes, nodata, lowered, maxLowerM: maxLower, maxLowerAt, meanLowerM: lowered ? sumLower / lowered : 0, maxRaiseM: maxRaise, maxRaiseAt };
}

/** Route polylines (world metres) from the scenic geometry, the app's ≤ 50 m points. */
export function routeLines(routes, projection) {
  return routes.map((r) => {
    const app = appRoutePoints(r.points);
    const out = [];
    for (let i = 0; i < app.lat.length; i++) out.push(...projection.forward(app.lat[i], app.lon[i]));
    return out;
  });
}

/**
 * The whole step for bake.mjs: corridor, DTM fetch and sampling, the swap.
 * `woodlandPolys` = rings (metres) of the canopy landcover, `beachPolys` of
 * the beaches and sand (read with `biasFrom: "beach"`). Returns
 * `{ report, bare(x, y), woodlandAt(x, y) }`: bare = DTM + bias at a world
 * point (NaN = none), for the route-lift figures after the carve.
 */
export async function bareGroundStep({ recipe, grid, heights, projection, routes, woodlandPolys, beachPolys = null, cacheDir, log }) {
  const opts = bareGroundOptions(recipe);
  const reach = opts.corridorM + opts.blendM;
  const dist = routeDistances(grid, routeLines(routes, projection), reach);
  const { cols, rows, cellSize, xMin, yMax } = grid;
  const idx = [];
  const points = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (dist[r * cols + c] < reach) {
        idx.push(r * cols + c);
        points.push(projection.inverse(xMin + c * cellSize, yMax - r * cellSize));
      }
    }
  }
  const fetchers = { 'usgs-3dep-13': fetchUsgs, swissalti3d: fetchSwiss, 'inegi-mdt-10k': fetchInegi, 'lombardia-dtm5': fetchLombardia, 'mase-pst-lidar': fetchMase, 'ign-rge-alti': fetchRgeAlti, 'veneto-lidar5': fetchVeneto };
  const src = await fetchers[opts.source]({ opts, points, cellSize, cacheDir, log });
  const dtm = new Float64Array(cols * rows).fill(NaN);
  for (let k = 0; k < idx.length; k++) dtm[idx[k]] = src.sample(points[k][0], points[k][1]);
  const woodland = polygonMask(grid, woodlandPolys);
  const biasMask = opts.biasFrom === 'beach' ? polygonMask(grid, beachPolys ?? []) : null;
  const res = applyBareGround({ grid, heights, dtm, dist, woodland, corridorM: opts.corridorM, blendM: opts.blendM, biasMask });
  log(
    `bareGround: ${opts.source}, ${res.nodes} nodes within ${opts.corridorM} + ${opts.blendM} m of the routes on the DTM ` +
      `(datum bias ${res.biasM.toFixed(2)} m over ${res.openNodes} flat ${biasMask ? 'beach' : 'open'} nodes; lowered up to ${res.maxLowerM.toFixed(1)} m at ${res.maxLowerAt?.map((v) => v.toFixed(0)).join(', ')}, mean ${res.meanLowerM.toFixed(1)} m; raised up to ${res.maxRaiseM.toFixed(1)} m at ${res.maxRaiseAt?.map((v) => v.toFixed(0)).join(', ')}; ${res.nodata} without DTM)`,
  );
  const bare = (x, y) => {
    const [lat, lon] = projection.inverse(x, y);
    return src.sample(lat, lon) + res.biasM;
  };
  const woodlandAt = (x, y) => {
    const c = Math.round((x - xMin) / cellSize);
    const r = Math.round((yMax - y) / cellSize);
    return c >= 0 && r >= 0 && c < cols && r < rows && woodland[r * cols + c] === 1;
  };
  return {
    bare,
    woodlandAt,
    report: {
      source: opts.source,
      tiles: src.tiles,
      ...(src.missing?.length ? { absentTiles: src.missing } : {}),
      corridorM: opts.corridorM,
      blendM: opts.blendM,
      ...(biasMask ? { biasFrom: opts.biasFrom } : {}),
      biasM: res.biasM,
      openNodes: res.openNodes,
      nodes: res.nodes,
      nodata: res.nodata,
      maxLowerM: res.maxLowerM,
      maxLowerAt: res.maxLowerAt,
      meanLowerM: res.meanLowerM,
      maxRaiseM: res.maxRaiseM,
      maxRaiseAt: res.maxRaiseAt,
    },
  };
}

/**
 * How far each route stands over the bare ground: render height minus
 * `bare(x, y)` at every route sample, leaving out the stretches it rides on
 * a deck (`onDeck(routeIndex, s)`) and samples without a DTM.
 * `surface(routeIndex, i)` gives the height to judge (the render h).
 */
export function routeLift({ routes, bare, onDeck = () => false, woodlandAt = () => false }) {
  return routes.map((r, ri) => {
    const lift = [];
    const wood = [];
    let worst = -Infinity, worstS = null;
    for (let i = 0; i < r.s.length; i++) {
      if (onDeck(ri, r.s[i])) continue;
      const g = bare(r.x[i], r.y[i]);
      if (Number.isNaN(g)) continue;
      const v = r.h[i] - g;
      lift.push(v);
      if (woodlandAt(r.x[i], r.y[i])) wood.push(v);
      if (v > worst) {
        worst = v;
        worstS = r.s[i];
      }
    }
    const sorted = Float64Array.from(lift).sort();
    const q = (p) => (sorted.length ? sorted[Math.floor(p * (sorted.length - 1))] : null);
    const woodSorted = Float64Array.from(wood).sort();
    return {
      id: r.id,
      samples: lift.length,
      medianM: q(0.5),
      p95M: q(0.95),
      maxM: sorted.length ? sorted[sorted.length - 1] : null,
      maxAtS: worstS,
      minM: sorted.length ? sorted[0] : null,
      over3M: lift.filter((v) => v > 3).length,
      woodland: { samples: wood.length, p95M: woodSorted.length ? woodSorted[Math.floor(0.95 * (woodSorted.length - 1))] : null, maxM: woodSorted.length ? woodSorted[woodSorted.length - 1] : null },
    };
  });
}
